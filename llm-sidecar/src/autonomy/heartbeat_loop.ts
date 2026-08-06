/**
 * The heartbeat's tool loop, and the two tools it answers itself.
 *
 * Ported from `run_heartbeat_tool_loop` and `dispatch_heartbeat_tools` in
 * `crates/daemon/src/autonomy/manager.rs`.
 *
 * A heartbeat is a private turn. The character gets real tools and up to half an
 * hour of wall clock, and everything it does — every thought, every tool result
 * — is thrown away when the tick ends. The only two things that survive are what
 * it wrote to disk with a workspace tool, and whatever it asked to say. So this
 * loop's real output is not the conversation it builds; it is
 * {@link HeartbeatLoopResult}.
 *
 * # Not `runToolLoop`
 *
 * The generic loop in `engine/tool_loop.ts` counts rounds and stops. This one
 * also watches a wall clock, and when either limit is reached it does not stop —
 * it spends a one-time nudge that buys the model a grace window to finish its
 * thought and write anything durable down. That is a different control flow, not
 * a configuration of the same one, and modelling it as `CapBehavior` would mean
 * teaching the generic loop about a deadline no other caller has.
 *
 * # Two undeclared tools
 *
 * `set_next_wake` and `sendMessage` are deliberately *not* in the tools array.
 * Declaring them would make the heartbeat's array differ from chat's, and the
 * two arrays being byte-identical is what lets a heartbeat run against the
 * prefix chat already paid to cache. So the prompt tells the model they exist
 * and this loop intercepts the calls by name, rather than letting them fall
 * through to `NotImplemented` and teaching the model they do not work.
 */

import {
  captureToolSendMessage,
  extractSendMessage,
  isSendMessageTool,
  type ImageRef,
  type ToolUse,
} from "./heartbeat_shape.ts";
import { budgetDecision, appendWrapUpNudge, generatedImageRef } from "./heartbeat_shape.ts";
import type { GenerateResponse, SidecarRequest } from "../llm/types.ts";
import type { ContentBlock } from "../engine/types.ts";
import { truncateSummary } from "../notifications.ts";

/** Half an hour. The Rust's `HEARTBEAT_LOOP_DEADLINE`. */
export const HEARTBEAT_LOOP_DEADLINE_MS = 30 * 60 * 1000;

/** What running one tool produced. */
export interface HeartbeatToolResult {
  /** What the model is shown. A tool's failure is text with a flag, not a throw. */
  output: string;
  isError: boolean;
  /** The tool's own value on success, read only to spot a generated image. */
  value?: unknown;
}

/** One tool call, as the transcript records it. */
export interface CapturedTool {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

/** One round, as the curated `shore log --heartbeat` view records it. */
export interface TranscriptRound {
  callType: string;
  iteration: number;
  response: GenerateResponse;
  captured: CapturedTool[];
}

/** Everything the loop needs that is not control flow. */
export interface HeartbeatLoopDeps {
  character: string;
  /**
   * One model call. `undefined` ends the loop — the Rust logged the error and
   * broke, because a heartbeat that cannot reach its model has nothing to
   * retry against and the next tick is an hour away at worst.
   */
  generate: (
    request: SidecarRequest,
    iteration: number,
    callType: string,
  ) => Promise<GenerateResponse | undefined>;
  /** Run one declared tool. Never throws; a failure comes back with the flag. */
  dispatch: (name: string, input: unknown) => Promise<HeartbeatToolResult>;
  /**
   * `set_next_wake`, answered here rather than dispatched. Returns the string
   * the model is shown; the clamp, the clock and the log line are the runner's.
   */
  scheduleNextWake: (hoursFromNow: number, reason: string) => string;
  /** Append to the ring buffer `shore log --heartbeat` reads. */
  note: (text: string) => void;
  recordTranscript?: (round: TranscriptRound) => void;
  /** `[behavior.autonomy.heartbeat].wrap_up_grace_rounds`. */
  wrapUpGrace: number;
  /** Rounds before the nudge. `undefined` leaves the deadline as the only bound. */
  maxToolIterations: number | undefined;
  deadlineMs?: number;
  monotonicMs?: () => number;
}

/** What a tick is left holding when its loop ends. */
export interface HeartbeatLoopResult {
  /** The last `<sendMessage>` or `sendMessage` tool call, if any. */
  sendMessageText: string | undefined;
  /** Images this tick generated, to ride out on the message it persists. */
  images: ImageRef[];
}

/** The tool-use blocks of a response, in the order the model wrote them. */
function toolUsesOf(blocks: readonly ContentBlock[]): ToolUse[] {
  return blocks.flatMap((b) =>
    b.type === "tool_use" ? [[b.id, b.name, b.input] as ToolUse] : [],
  );
}

/** `GenerateResponse::extract_text` — the text blocks, or `content` if there are none. */
function responseText(resp: GenerateResponse): string {
  if (resp.content_blocks.length === 0) return resp.content;
  return resp.content_blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/**
 * Run every tool call from one round.
 *
 * Two names never reach the tool registry. `set_next_wake` is answered from the
 * clock, and its ring-buffer line is left to the scheduler that clamps the value
 * — pushing another one here would log the same call twice. `sendMessage` is
 * acknowledged as delivered even though nothing has been delivered yet: the text
 * was already taken into the send-message sink by the caller, and the tick will
 * persist it when it ends. Telling the model "not yet implemented" instead just
 * teaches it to retry a tool that worked.
 */
export async function dispatchHeartbeatTools(
  toolUses: readonly ToolUse[],
  deps: Pick<HeartbeatLoopDeps, "dispatch" | "scheduleNextWake" | "note">,
): Promise<{ results: ContentBlock[]; captured: CapturedTool[]; images: ImageRef[] }> {
  const results: ContentBlock[] = [];
  const captured: CapturedTool[] = [];
  const images: ImageRef[] = [];

  for (const [id, name, input] of toolUses) {
    let output: string;
    let isError: boolean;

    if (name === "set_next_wake") {
      const record = (typeof input === "object" && input !== null ? input : {}) as Record<
        string,
        unknown
      >;
      const hours = typeof record["hours_from_now"] === "number" ? record["hours_from_now"] : 1;
      const reason = typeof record["reason"] === "string" ? record["reason"] : "";
      output = deps.scheduleNextWake(hours, reason);
      isError = false;
    } else if (isSendMessageTool(name)) {
      output = JSON.stringify({
        status: "delivered",
        detail: "Message will be delivered to the user when this tick ends.",
      });
      isError = false;
    } else {
      const result = await deps.dispatch(name, input);
      output = result.output;
      isError = result.isError;
      if (!isError && name === "generate_image") {
        // A chat turn attaches a generated image to the turn that asked for it.
        // A heartbeat has no live client channel, so the image is held here and
        // rides out on the autonomous message the tick persists at the end.
        const ref = generatedImageRef(result.value);
        if (ref !== undefined) images.push(ref);
      }
    }

    results.push({ type: "tool_result", tool_use_id: id, content: output, is_error: isError });
    captured.push({ name, input, output, isError });

    // `set_next_wake` is the exception: the scheduler already wrote its line,
    // with the clamped value this side never sees.
    if (name !== "set_next_wake") deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);
  }

  return { results, captured, images };
}

/**
 * Drive the tick's rounds until the model stops, the budget runs out, or a call
 * fails.
 *
 * `request` is appended to as the loop runs and is thrown away afterwards —
 * every turn the model takes here is ephemeral. It must be the tick's own copy;
 * see `heartbeat_request.ts` for what appending to the cached one would cost.
 */
export async function runHeartbeatToolLoop(
  request: SidecarRequest,
  deps: HeartbeatLoopDeps,
): Promise<HeartbeatLoopResult> {
  const maxNormalIterations = deps.maxToolIterations ?? Number.POSITIVE_INFINITY;
  const totalIterations = maxNormalIterations + deps.wrapUpGrace;

  console.info(
    `shore: heartbeat tool loop for ${deps.character} ` +
      `(max_iterations=${maxNormalIterations}, wrap_up_grace=${deps.wrapUpGrace})`,
  );

  let sendMessageText: string | undefined;
  const images: ImageRef[] = [];

  const clock = deps.monotonicMs ?? Date.now;
  const deadline = clock() + (deps.deadlineMs ?? HEARTBEAT_LOOP_DEADLINE_MS);
  let wrapUpNudged = false;

  for (let iteration = 0; iteration < totalIterations; iteration += 1) {
    const action = budgetDecision(
      clock() >= deadline,
      iteration >= maxNormalIterations,
      deps.wrapUpGrace,
      wrapUpNudged,
    );
    if (action === "break") break;
    if (action === "nudge") {
      appendWrapUpNudge(request.messages as never);
      wrapUpNudged = true;
      deps.note("Wrap-up nudge: budget reached, model asked to summarize");
    }

    const callType = iteration === 0 ? "heartbeat" : "heartbeat_tool_loop";
    const resp = await deps.generate(request, iteration, callType);
    if (resp === undefined) break;

    const tagged = extractSendMessage(responseText(resp));
    if (tagged !== undefined) sendMessageText = tagged;

    request.messages.push({
      role: "assistant",
      content: resp.content_blocks,
      ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
      model: request.model,
    });

    // Read off every response, not only the ones that finish on `tool_use`. A
    // model that writes a `sendMessage` block and then stops has still asked to
    // speak, and gating this on `hasTools` would drop that message on the floor.
    const toolUses = toolUsesOf(resp.content_blocks);
    const hasTools = toolUses.length > 0 && resp.finish_reason === "tool_use";

    // The tool call wins over the tag when a round has both — it is the more
    // deliberate of the two, and the tag may be the model narrating what it is
    // about to do.
    sendMessageText = captureToolSendMessage(toolUses) ?? sendMessageText;

    let captured: CapturedTool[] = [];
    if (hasTools) {
      const round = await dispatchHeartbeatTools(toolUses, deps);
      request.messages.push({ role: "user", content: round.results });
      images.push(...round.images);
      captured = round.captured;
    }

    // After dispatch, so the row carries each tool's full output for this round.
    deps.recordTranscript?.({ callType, iteration, response: resp, captured });

    if (!hasTools) break;
  }

  return { sendMessageText, images };
}
