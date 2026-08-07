/**
 * Running one tool the model asked for.
 *
 * Ported from `execute_tool_use`, `attach_generated_image`,
 * `record_tool_diagnostics`, `emit_tool_result`, `record_tool_result_message`
 * and `record_reported_message` in `crates/daemon/src/engine/tools.rs` — the
 * third of that module's three pieces, and the only one that was ever going to
 * be ported. The other two are the daemon-driven fallback loop and the
 * NDJSON server that fed the sidecar its tools; both are seam and both delete.
 *
 * `dispatch_within_deadline` came across earlier and lives in `dispatch.ts`
 * beside the routing table it wraps. What is here is everything *around* the
 * dispatch: the two frames the client sees, the cap on what the model reads,
 * the diagnostics row, and the generated-image side channel.
 *
 * Pinned by `tests/tools_fixtures/execute_parity.json`.
 *
 * # Frames, not a channel
 *
 * The Rust pushed onto a bounded `mpsc::Sender<ServerMessage>` and ignored the
 * send result — a closed channel means the client left, which is not this
 * layer's problem. Here that is a plain sink, the same {@link ToolExecution.sendDirect}
 * shape `turn.ts` and `command_dispatch.ts` already take, and
 * `SessionRouter` supplies it once `swp_server` is wired (#18, step 5). The
 * bounded channel's backpressure is gone with it; nothing downstream of a tool
 * result was relying on being throttled by one.
 *
 * `subagent` is deliberately never set. A nested `ask_<name>` loop runs its
 * frames through a forwarder that stamps the name on the way out, so tagging
 * here would double-write a field the forwarder owns.
 *
 * # What collapsed
 *
 * - `ToolDispatchOutcome`. It was a struct of one field by the time it was
 *   read — its second, a hand-built `tool_result` JSON value for the wire, had
 *   already been folded into the block. A one-field struct is a return value.
 * - `record_tool_result_message` and `record_reported_message` were the same
 *   function, one of them with `Role::User` written in rather than passed. They
 *   existed apart because one served the daemon-driven loop and the other the
 *   socket, and those are one caller now. {@link recordReportedMessage} is both.
 */

import { deriveContentFromBlocks } from "../engine/message_store.ts";
import type { ContentBlock, ImageRef, Message, Role } from "../engine/types.ts";
import { imageDataForPath } from "../engine/wire_images.ts";
import type { ToolUseEvent } from "../engine/tool_loop.ts";
import type { ToolCallEntry } from "../diagnostics.ts";
import { truncateSummary } from "../notifications.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import {
  dispatchWithinDeadline,
  resultCharsFor,
  timeoutFor,
  truncateToolResult,
  type ToolContext,
  type ToolLimitsView,
} from "./dispatch.ts";

/** How much of a tool's input and output a diagnostics row keeps. */
const SUMMARY_CHARS = 200;

/**
 * Everything running a tool needs that is not the tool call itself.
 *
 * The Rust threaded these as six positional arguments and carried a
 * `#[expect(clippy::too_many_arguments)]` to say so.
 */
export interface ToolExecution {
  /** The requesting session's channel. Must not throw and may drop. */
  sendDirect: (message: ServerMessage) => void;
  /** The wiring the handler itself runs against. */
  ctx: ToolContext;
  /** `[tools]` — the per-tool deadline and result cap. */
  limits: ToolLimitsView;
  /**
   * The tool-call ring. Narrower than `Diagnostics` on purpose: this path only
   * ever appends, so both a `RingBuffer` and a plain array satisfy it.
   */
  diagnostics: { push: (entry: ToolCallEntry) => void };
  /** Request id, echoed onto every frame so a client can correlate. */
  rid?: string;
  /** RFC 3339 with offset — `chrono::Local::now().to_rfc3339()`. Injected so a
   *  fixture can pin it. */
  now: () => string;
  /** Fresh message id. `format!("m_{}", Uuid::new_v4())` in the Rust. */
  newMessageId: () => string;
  /** Monotonic reading in milliseconds, for the dispatch duration. */
  monotonicMs?: () => number;
}

/**
 * Run one tool and return the block that carries its result.
 *
 * The order is observable and is the Rust's: announce the call, dispatch,
 * truncate, attach any generated image, record diagnostics, announce the
 * result. Truncation happens *before* the frame, persistence and the LLM
 * payload, so every replay path sees the same bounded string.
 *
 * `intermediateMessages` is read and mutated rather than appended to — the
 * generated-image path hangs an {@link ImageRef} off the assistant turn that
 * asked for the tool. It is `&mut [Message]` in the Rust for exactly that
 * reason: a slice can be edited and cannot be grown.
 */
export async function executeToolUse(
  toolUse: ToolUseEvent,
  exec: ToolExecution,
  intermediateMessages: Message[],
): Promise<ContentBlock> {
  exec.sendDirect({
    type: "tool_call",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    tool_id: toolUse.id,
    tool_name: toolUse.name,
    input: toolUse.input,
  });

  const clock = exec.monotonicMs ?? Date.now;
  const startedAt = clock();
  let rawOutput: string;
  let isError: boolean;
  let okValue: unknown;
  try {
    const value = await dispatchWithinDeadline(
      toolUse.name,
      toolUse.input,
      exec.ctx,
      timeoutFor(exec.limits, toolUse.name),
    );
    // A string result is the model's text as-is; anything else is serialized.
    // `unwrap_or_default()` in the Rust, which cannot fail on a `Value` — here
    // it can, for a value `JSON.stringify` returns nothing for, and empty is
    // the same answer.
    rawOutput = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    isError = false;
    okValue = value;
  } catch (e) {
    // `ToolError`'s `Display`, which the model reads as the failure: the
    // variant prefixes (`invalid args: `, `io: `) are part of the contract, so
    // it is the message and not the `Error: `-prefixed `String(e)`.
    rawOutput = e instanceof Error ? e.message : String(e);
    isError = true;
  }
  const dispatchMs = clock() - startedAt;

  const output = truncateToolResult(rawOutput, resultCharsFor(exec.limits, toolUse.name));

  if (!isError && toolUse.name === "generate_image") {
    attachGeneratedImage(okValue, intermediateMessages, exec);
  }

  recordToolDiagnostics(exec, toolUse, dispatchMs, output, isError);
  emitToolResult(exec, toolUse, output, isError);

  return { type: "tool_result", tool_use_id: toolUse.id, content: output, is_error: isError };
}

/**
 * Hang a freshly generated image off the turn that asked for it, and push it
 * to the client.
 *
 * The target is the last *assistant* message, not simply the last message.
 * Only assistant messages render their images, so an image parked on a
 * `tool_result` turn is dropped with no error — and a round's results are
 * stored as one user message, which makes the last message a user turn more
 * often than not.
 *
 * The stored ref carries no bytes and the frame does: the conversation on disk
 * keeps a path, and the client may be on another machine with no way to open
 * it.
 *
 * Exported for the fixture, which drives it directly: `generate_image` only
 * ever returns the well-formed shape, so the malformed ones — no `path`, a
 * numeric `path`, a value that is not an object at all — are unreachable
 * through the handler and are still what this has to survive.
 */
export function attachGeneratedImage(
  value: unknown,
  intermediateMessages: Message[],
  exec: Pick<ToolExecution, "sendDirect" | "rid">,
): void {
  if (typeof value !== "object" || value === null) return;
  const fields = value as Record<string, unknown>;
  const path = fields["path"];
  if (typeof path !== "string") return;
  const caption = typeof fields["caption"] === "string" ? fields["caption"] : undefined;

  const image: ImageRef = { path, ...(caption !== undefined ? { caption } : {}) };
  for (let i = intermediateMessages.length - 1; i >= 0; i -= 1) {
    const message = intermediateMessages[i];
    if (message?.role === "assistant") {
      message.images.push(image);
      break;
    }
  }

  const data = imageDataForPath(path);
  exec.sendDirect({
    type: "send_image",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    path,
    ...(caption !== undefined ? { caption } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

/** Append the observability row for one completed dispatch. */
function recordToolDiagnostics(
  exec: ToolExecution,
  toolUse: ToolUseEvent,
  durationMs: number,
  output: string,
  isError: boolean,
): void {
  exec.diagnostics.push({
    timestamp: exec.now(),
    tool_name: toolUse.name,
    tool_id: toolUse.id,
    success: !isError,
    duration_ms: durationMs,
    // The Rust serialized the input to JSON and defaulted a failure to the
    // empty string; the same `?? ""` as the result above, for the same reason.
    input_summary: truncateSummary(JSON.stringify(toolUse.input) ?? "", SUMMARY_CHARS),
    output_summary: truncateSummary(output, SUMMARY_CHARS),
  });
}

/** Announce a finished tool to the requesting session. */
function emitToolResult(
  exec: ToolExecution,
  toolUse: ToolUseEvent,
  output: string,
  isError: boolean,
): void {
  exec.sendDirect({
    type: "tool_result",
    ...(exec.rid !== undefined ? { rid: exec.rid } : {}),
    tool_id: toolUse.id,
    tool_name: toolUse.name,
    output,
    is_error: isError,
  });
}

/**
 * Record one turn of a tool round for persistence, exactly as the loop
 * reported it.
 *
 * The loop decides the grouping and the order — an assistant turn carrying the
 * `tool_use` blocks, then one user turn carrying the round's results together
 * in ask order. Inferring either from the tool calls is what this replaced:
 * a round's tools run concurrently, so recording each result as it landed
 * stored one message per tool in whatever order they finished.
 *
 * Provenance is left unset. The request the loop ran on carries it, and the
 * persistence layer stamps it there.
 */
export function recordReportedMessage(
  intermediateMessages: Message[],
  role: Role,
  blocks: ContentBlock[],
  exec: Pick<ToolExecution, "now" | "newMessageId">,
): void {
  intermediateMessages.push({
    msg_id: exec.newMessageId(),
    role,
    content: deriveContentFromBlocks(blocks, true),
    images: [],
    content_blocks: blocks,
    timestamp: exec.now(),
  });
}

/**
 * The tool half of one turn: run a tool, record a turn, keep the list.
 *
 * This is what a tool loop is handed instead of a socket. It exists because the
 * two calls above share the message list — the loop records the assistant turn
 * that asked for a tool, and running that tool may hang a generated image off
 * it — and because a loop should not have to hold a `ToolContext`, a
 * diagnostics ring and a frame sink to ask for one tool.
 *
 * # There is no failure this cannot express
 *
 * {@link runTool} does not reject. `executeToolUse` turns every way a tool can
 * fail into a `tool_result` with `is_error` set, which is the shape the model
 * can act on. That is the whole of what `tool_rpc.ts` needed a second failure
 * channel for: over a socket, "the tool failed" and "the call never arrived"
 * are different events, and reporting the second as the first would describe a
 * plumbing problem as something the model did. In one process the second cannot
 * happen.
 */
export interface ToolPhase {
  /** The turns this loop produced, in order, for the caller to persist. */
  readonly messages: Message[];
  /** Run one tool. Emits its frames and returns the `tool_result` block. */
  runTool: (toolUse: ToolUseEvent) => Promise<ContentBlock>;
  /** Record a turn the loop produced. Must precede the tools it asked for. */
  recordTurn: (role: Role, blocks: ContentBlock[]) => void;
}

/** Bind an execution context and a message list into a {@link ToolPhase}. */
export function toolPhase(exec: ToolExecution, messages: Message[] = []): ToolPhase {
  return {
    messages,
    runTool: (toolUse) => executeToolUse(toolUse, exec, messages),
    recordTurn: (role, blocks) => recordReportedMessage(messages, role, blocks, exec),
  };
}
