import type { CallStore, TranscriptRecord } from "./call_store.ts";
import type { ContentBlock } from "./engine/types.ts";
import type { GenerateResponse } from "./llm/types.ts";

export interface CapturedTool {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

export interface TranscriptEntry {
  reasoning: string[];
  text: string;
  tool_calls: { name: string; input: unknown; output: string; is_error: boolean }[];
}

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
      cache_write_tokens: params.response.usage.cache_creation_tokens,
    },
    entry_json: JSON.stringify(buildEntry(params.response, params.tools)),
  };
  try {
    store.recordTranscript(record);
  } catch (e) {
    console.warn(`shore: failed to record a ${params.source} transcript entry: ${String(e)}`);
  }
}
