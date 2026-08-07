/**
 * The curated transcript a background tool loop leaves behind.
 *
 * Ported from `crates/daemon/src/transcript_capture.rs`.
 *
 * The `calls` rows already hold every LLM call's request and response, so this
 * looks redundant and is not. Tool *outputs* live in the *next* call's request,
 * in whatever wire shape that provider wanted — reconstructing them on read
 * means re-deriving one provider's dialect from another's. A background loop has
 * each result in normalized form at the moment it dispatched it, so it writes
 * one curated entry per call instead: the reasoning, the visible text, and each
 * tool call paired with its full output. `shore log --heartbeat` reads these.
 *
 * Best-effort throughout. A transcript is something a person reads afterwards,
 * and failing a heartbeat because its diary entry would not write is the wrong
 * trade every time.
 */

import type { CallStore, TranscriptRecord } from "./call_store.ts";
import type { ContentBlock } from "./engine/types.ts";
import type { GenerateResponse } from "./llm/types.ts";

/** One tool call captured during a background loop, with its full output. */
export interface CapturedTool {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

/** The curated entry, as it is stored. */
export interface TranscriptEntry {
  reasoning: string[];
  text: string;
  tool_calls: { name: string; input: unknown; output: string; is_error: boolean }[];
}

/**
 * Split a response into the three things a reader wants.
 *
 * Blank thinking is dropped and redacted thinking becomes a placeholder, so the
 * reasoning list says "the model thought here and you may not see it" rather
 * than going silently empty. Text blocks join with newlines because a provider
 * may split one paragraph across several, and `tool_use` blocks are skipped —
 * their content arrives via `tools`, with the output the response itself does
 * not carry.
 */
export function buildEntry(
  resp: Pick<GenerateResponse, "content_blocks">,
  tools: readonly CapturedTool[],
): TranscriptEntry {
  const reasoning: string[] = [];
  let text = "";
  for (const block of resp.content_blocks as ContentBlock[]) {
    if (block.type === "thinking") {
      if (block.thinking.trim() !== "") reasoning.push(block.thinking);
    } else if (block.type === "redacted_thinking") {
      reasoning.push("[redacted thinking]");
    } else if (block.type === "text") {
      if (block.text !== "") {
        if (text !== "") text += "\n";
        text += block.text;
      }
    }
  }
  return {
    reasoning,
    text,
    tool_calls: tools.map((tool) => ({
      name: tool.name,
      input: tool.input,
      output: tool.output,
      is_error: tool.isError,
    })),
  };
}

/** What one row needs beyond the response. */
export interface RecordTranscriptParams {
  source: string;
  character: string;
  callType: string;
  iteration: number;
  provider?: string | undefined;
  response: GenerateResponse;
  tools: readonly CapturedTool[];
  now?: () => Date;
}

/**
 * Write one curated entry, or warn and carry on.
 *
 * An empty model name is stored as absent rather than as an empty string: the
 * readers show it to a person, and a blank column is a clearer "not reported"
 * than an empty one that looks like a name nobody set.
 */
export function recordTranscript(
  store: Pick<CallStore, "recordTranscript">,
  params: RecordTranscriptParams,
): void {
  const record: TranscriptRecord = {
    ts: (params.now ?? (() => new Date()))(),
    source: params.source,
    character: params.character,
    call_type: params.callType,
    iteration: params.iteration,
    model: params.response.model === "" ? null : params.response.model,
    provider: params.provider ?? null,
    finish_reason: params.response.finish_reason,
    usage: {
      input_tokens: params.response.usage.input_tokens,
      output_tokens: params.response.usage.output_tokens,
      cache_read_tokens: params.response.usage.cache_read_tokens,
    },
    entry_json: JSON.stringify(buildEntry(params.response, params.tools)),
  };
  try {
    store.recordTranscript(record);
  } catch (e) {
    console.warn(`shore: failed to record a ${params.source} transcript entry: ${String(e)}`);
  }
}
