import type { ContentBlock } from "../engine/types.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LlmError } from "./errors.ts";
import type { StreamEvent, Timing, Usage } from "./types.ts";

export interface ReasoningCarrier {
  signature?: string;
  reasoning_details?: unknown[];
  reasoning_content?: string;
}

export interface ToolUseEvent {
  id: string;
  name: string;
  input: unknown;
  input_error?: string;
}

export interface StreamResult {
  content: string;
  model: string;
  finish_reason: string;
  usage: Usage;
  timing: Timing;
  tool_uses: ToolUseEvent[];
  content_blocks: ContentBlock[];
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

export function emptyTiming(): Timing {
  return { total_ms: 0, time_to_first_token_ms: 0 };
}

export type FrameSink = (message: ServerMessage) => void;

export class StreamAccumulator {
  #model = "";
  #started = false;
  #toolUses: ToolUseEvent[] = [];
  #contentBlocks: ContentBlock[] = [];
  #textBuf = "";
  #thinkingBuf = "";
  #pendingCarrier: ReasoningCarrier | undefined = undefined;

  flushText(): void {
    if (this.#textBuf !== "") {
      this.#contentBlocks.push({ type: "text", text: this.#textBuf });
      this.#textBuf = "";
    }
  }

  flushThinking(): void {
    if (this.#thinkingBuf !== "") {
      this.#contentBlocks.push({
        type: "thinking",
        thinking: this.#thinkingBuf,
        ...this.#pendingCarrier,
      });
      this.#thinkingBuf = "";
      this.#pendingCarrier = undefined;
    }
  }

  handle(event: StreamEvent, regen: boolean, sink: FrameSink, rid?: string): StreamStep {
    switch (event.type) {
      case "start": {
        this.#model = event.model;
        this.#started = true;
        sink({ type: "stream_start", subagent: null, rid: rid ?? null, regen });
        return { kind: "continue" };
      }

      case "text": {
        this.flushThinking();
        this.#textBuf += event.text;
        sink({
          type: "stream_chunk",
          subagent: null,
          rid: rid ?? null,
          text: event.text,
          content_type: "text",
        });
        return { kind: "continue" };
      }

      case "thinking": {
        this.flushText();
        this.#thinkingBuf += event.text;
        sink({
          type: "stream_chunk",
          subagent: null,
          rid: rid ?? null,
          text: event.text,
          content_type: "thinking",
        });
        return { kind: "continue" };
      }

      case "thinking_signature":
        this.#pendingCarrier = { signature: event.signature };
        return { kind: "continue" };

      case "reasoning_details":
        this.#pendingCarrier = { reasoning_details: event.details };
        return { kind: "continue" };

      case "reasoning_content":
        this.#pendingCarrier = { reasoning_content: event.reasoning };
        return { kind: "continue" };

      case "redacted_thinking": {
        this.flushText();
        this.flushThinking();
        this.#contentBlocks.push({ type: "redacted_thinking", data: event.data });
        return { kind: "continue" };
      }

      case "tool_use": {
        this.flushText();
        this.flushThinking();
        const carried =
          event.input_error === undefined ? {} : { input_error: event.input_error };
        this.#contentBlocks.push({
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.input,
          ...carried,
        });
        this.#toolUses.push({ id: event.id, name: event.name, input: event.input, ...carried });
        return { kind: "continue" };
      }

      case "done": {
        const result = this.finish(event.content, event.finish_reason, event.usage, event.timing);
        if (event.content_blocks !== undefined) {
          result.content_blocks = event.content_blocks as ContentBlock[];
        }
        return { kind: "done", result };
      }

      case "ping":
        return { kind: "continue" };

      case "call_complete":
        return { kind: "continue" };

      case "error":
        return {
          kind: "error",
          error:
            event.aborted === true
              ? { kind: "aborted", message: event.message }
              : {
                  kind: "stream_errored",
                  message: event.message,
                  usage: event.usage,
                  timing: event.timing,
                  ...(event.retry_after_ms === undefined
                    ? {}
                    : { retry_after_ms: event.retry_after_ms }),
                },
        };
    }
  }

  finish(content: string, finishReason: string, usage: Usage, timing: Timing): StreamResult {
    this.flushText();
    this.flushThinking();

    const result: StreamResult = {
      content,
      model: this.#started ? this.#model : "",
      finish_reason: finishReason,
      usage,
      timing,
      tool_uses: this.#toolUses,
      content_blocks: this.#contentBlocks,
    };
    this.#toolUses = [];
    this.#contentBlocks = [];
    return result;
  }
}

export type StreamStep =
  | { kind: "continue" }
  | { kind: "done"; result: StreamResult }
  | { kind: "error"; error: LlmError };

export type ConsumeOutcome = { ok: StreamResult } | { err: LlmError };

export async function consumeStream(
  events: AsyncIterable<StreamEvent>,
  options: { regen: boolean; sink: FrameSink; rid?: string },
): Promise<ConsumeOutcome> {
  const accumulator = new StreamAccumulator();
  for await (const event of events) {
    const step = accumulator.handle(event, options.regen, options.sink, options.rid);
    if (step.kind === "done") return { ok: step.result };
    if (step.kind === "error") return { err: step.error };
  }
  return { err: { kind: "incomplete_stream" } };
}

export function emitStreamEnd(
  sink: FrameSink,
  result: StreamResult,
  options: { isFinal: boolean; rid?: string; msgId?: string; revision?: number },
): void {
  const frame: ServerMessage = {
    type: "stream_end",
    subagent: null,
    rid: options.rid ?? null,
    msg_id: options.msgId ?? null,
    content: result.content,
    metadata: {
      tokens: {
        input: result.usage.input_tokens,
        output: result.usage.output_tokens,
        cache_read: result.usage.cache_read_tokens,
        cache_write: result.usage.cache_creation_tokens,
      },
      timing: {
        total_ms: result.timing.total_ms,
        ttft_ms: result.timing.time_to_first_token_ms,
      },
      model: result.model,
    },
    finish_reason: result.finish_reason,
    is_final: options.isFinal,
  };
  if (options.revision !== undefined) frame.revision = options.revision;
  sink(frame);
}
