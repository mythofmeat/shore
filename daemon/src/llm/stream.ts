/**
 * Accumulate a provider stream into the turn that gets persisted.
 *
 * Port of the surviving half of `crates/daemon/src/llm/stream.rs`. That file
 * does two jobs: it reads newline-delimited JSON off the daemon↔sidecar socket,
 * and it folds the decoded events into a {@link StreamResult} while relaying
 * `stream_start` / `stream_chunk` frames to the SWP session. The first job is
 * the process boundary and goes away with it (#12) — there is no socket to read
 * once the two halves are one process, and `IncompleteStream` on EOF becomes an
 * iterator that ends without `done`. The second job is what a turn is made of,
 * and it moves here unchanged.
 *
 * So this consumes an `AsyncIterable<StreamEvent>` rather than a `BufReader`.
 * Everything downstream of the decode — buffer flushing, block ordering,
 * signature attachment, what `model` reports when no `start` arrived — is the
 * Rust's behaviour, pinned by fixture.
 */

import type { ContentBlock } from "../engine/types.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LlmError } from "./errors.ts";
import type { StreamEvent, Timing, Usage } from "./types.ts";

/**
 * Where a thinking block's replay payload rides.
 *
 * The Rust folds all three into one prefixed string (`orrd:…`, `zair:…`, or a
 * bare signature) because stored history has a single slot for them, and
 * projects that back out at send time. This side has no such slot: `ContentBlock`
 * is the one type both halves use and it names all three fields, so the carrier
 * arrives at the field its provider actually reads and stays there. Nothing here
 * ever writes a prefix — see `pushAssistantTurn` in `llm/request.ts`, which is
 * the projection the Rust needs and this side does not.
 */
export interface ReasoningCarrier {
  signature?: string;
  reasoning_details?: unknown[];
  reasoning_content?: string;
}

/** A tool_use event surfaced to the caller's tool loop. */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: unknown;
}

/** The accumulated result after a stream completes. */
export interface StreamResult {
  /** The final assembled content from the `done` event. */
  content: string;
  /** The model that produced this response. */
  model: string;
  /** Why the model stopped generating. */
  finish_reason: string;
  usage: Usage;
  timing: Timing;
  /** Tool invocations encountered during the stream. */
  tool_uses: ToolUseEvent[];
  /** Text, thinking and tool_use blocks in arrival order — what gets
   *  persisted. */
  content_blocks: ContentBlock[];
}

/** Zeroed usage, matching Rust's `Usage::default()`. */
export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

/** Zeroed timing, matching Rust's `Timing::default()`. */
export function emptyTiming(): Timing {
  return { total_ms: 0, time_to_first_token_ms: 0 };
}

/**
 * Where relayed frames go. The Rust holds an `mpsc::Sender<ServerMessage>` and
 * drops the send result on the floor (`let _ignored = …`) — a session that has
 * gone away must not fail the generation that was streaming to it. This is the
 * same contract: `send` may do nothing, and must not throw.
 */
export type FrameSink = (message: ServerMessage) => void;

/**
 * The mutable accumulator threaded through event handling.
 *
 * Exposed rather than hidden inside the consumer so a caller that already has
 * events in hand — a test, a replay, an in-process tool loop — can fold them
 * without inventing a stream.
 */
export class StreamAccumulator {
  #model = "";
  #started = false;
  #toolUses: ToolUseEvent[] = [];
  #contentBlocks: ContentBlock[] = [];
  #textBuf = "";
  #thinkingBuf = "";
  #pendingCarrier: ReasoningCarrier | undefined = undefined;

  /** Flush accumulated text into the block list. */
  flushText(): void {
    if (this.#textBuf !== "") {
      this.#contentBlocks.push({ type: "text", text: this.#textBuf });
      this.#textBuf = "";
    }
  }

  /**
   * Flush accumulated thinking, attaching any pending signature.
   *
   * A carrier with no thinking to attach to is *not* dropped — it stays
   * pending, so one that arrives before its text still lands on the block that
   * follows. Only a flush that actually emits a block clears it.
   */
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

  /**
   * Fold one event in. Returns the terminal {@link StreamResult} when `done`
   * arrives, `undefined` otherwise.
   *
   * A mid-stream `error` event is returned as an `LlmError` rather than thrown,
   * so the caller decides — the Rust's `?` fails the call while still handing
   * the already-billed usage to the ledger, and a thrown value would lose that
   * distinction against a genuine bug in this function.
   */
  handle(event: StreamEvent, regen: boolean, sink: FrameSink, rid?: string): StreamStep {
    switch (event.type) {
      case "start": {
        this.#model = event.model;
        this.#started = true;
        sink({ type: "stream_start", subagent: null, rid: rid ?? null, regen });
        return { kind: "continue" };
      }

      case "text": {
        // Flush any pending thinking before accumulating text, so the blocks
        // stay in arrival order.
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

      // The three carriers land on the same slot — that is the storage shape —
      // but arrive as distinct events so nothing has to infer which one it got
      // by sniffing a string prefix.
      // Each replaces the pending carrier outright rather than merging into
      // it: the Rust's slot holds one payload, and a turn that somehow emitted
      // two must replay the later one, not a chimera of both.
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
        // A complete block: flush both buffers and push directly.
        this.flushText();
        this.flushThinking();
        this.#contentBlocks.push({ type: "redacted_thinking", data: event.data });
        return { kind: "continue" };
      }

      case "tool_use": {
        this.flushText();
        this.flushThinking();
        this.#contentBlocks.push({
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.input,
        });
        this.#toolUses.push({ id: event.id, name: event.name, input: event.input });
        return { kind: "continue" };
      }

      case "done": {
        // `stream_end` is the caller's to emit — see `emitStreamEnd`.
        const result = this.finish(event.content, event.finish_reason, event.usage, event.timing);
        // A tool loop driven by the provider side names its terminal turn's
        // blocks, because this accumulator has seen every turn of that loop in
        // one flat stream and cannot tell them apart. Applied *after* `finish`,
        // which flushes its own pending text and thinking — those are already
        // in the reported blocks, so overriding first would leave the trailing
        // text in twice.
        if (event.content_blocks !== undefined) {
          result.content_blocks = event.content_blocks as ContentBlock[];
        }
        return { kind: "done", result };
      }

      // Keepalive. Reading the event already reset the transport idle timer,
      // which is the whole point. Nothing to relay or accumulate.
      case "ping":
        return { kind: "continue" };

      // Ledger bookkeeping, addressed to nobody here: the row is written where
      // this is emitted. The variant exists on this side only so an
      // unrecognised `type` does not fail the parse and take the stream with it.
      case "call_complete":
        return { kind: "continue" };

      // A mid-stream provider failure that still carried partial usage (e.g.
      // the Anthropic cache write reported in `message_start`). Fails the call
      // so retry runs, but hands the usage over so the ledger records the
      // already-billed tokens instead of zeros.
      case "error":
        return {
          kind: "error",
          error: {
            kind: "stream_errored",
            message: event.message,
            usage: event.usage,
            timing: event.timing,
          },
        };
    }
  }

  /**
   * Flush pending buffers and assemble the terminal result, draining the
   * accumulated tool-uses and blocks.
   *
   * `model` reports the empty string when no `start` event was seen. The field
   * would already be empty in that case — nothing else writes it — but the Rust
   * reads it only on the `started` branch, so a future `start`-less path that
   * set `model` some other way would diverge here rather than silently.
   *
   * The array reassignments are not the Rust's `mem::take` in TypeScript
   * costume: without them the returned result would *alias* the accumulator's
   * arrays, and folding one more event would reach back into a result the
   * caller already has.
   */
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

/** What folding one event produced. */
export type StreamStep =
  | { kind: "continue" }
  | { kind: "done"; result: StreamResult }
  | { kind: "error"; error: LlmError };

/** Either a completed stream or the error that ended it. */
export type ConsumeOutcome = { ok: StreamResult } | { err: LlmError };

/**
 * Consume a provider stream, relaying frames to the session and returning the
 * accumulated result.
 *
 * Does **not** emit `stream_end` — that is the caller's job, so it can be
 * deferred until after persistence. Emitting it here would reopen the race
 * where a follow-up command snapshots engine state before the freshly-streamed
 * message has been appended. Use {@link emitStreamEnd} once the message is
 * durable.
 *
 * A stream that ends without `done` is `incomplete_stream`, the same as the
 * Rust's EOF case.
 */
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

/**
 * Emit a `stream_end` frame describing a completed stream.
 *
 * Call this after the message is durable — after persistence for the final
 * phase, or immediately for the intermediate `tool_use` boundaries that drive a
 * tool loop.
 *
 * `isFinal` distinguishes the terminal frame from those intermediate ones.
 * Aggregating clients use it to decide whether to keep reading, so a tool
 * loop's boundaries must set it false or the client stops at the first one.
 */
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
  // `revision` is `Option<u64>` behind `skip_serializing_if`, so an absent
  // revision must be an absent *key* — writing `0` would claim the message
  // landed in the pre-history revision.
  if (options.revision !== undefined) frame.revision = options.revision;
  sink(frame);
}
