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
import type { CapturedTool } from "../transcript_capture.ts";
export type { CapturedTool };

const HEARTBEAT_LOOP_DEADLINE_MS = 30 * 60 * 1000;

export interface HeartbeatToolResult {
  output: string;
  isError: boolean;
  value?: unknown;
}

export interface TranscriptRound {
  callType: string;
  iteration: number;
  response: GenerateResponse;
  captured: CapturedTool[];
}

export interface HeartbeatLoopDeps {
  character: string;
  generate: (
    request: SidecarRequest,
    iteration: number,
    callType: string,
  ) => Promise<GenerateResponse | undefined>;
  dispatch: (
    name: string,
    input: unknown,
    toolUseId?: string,
  ) => Promise<HeartbeatToolResult>;
  scheduleNextWake: (hoursFromNow: number, reason: string) => string;
  note: (text: string) => void;
  recordTranscript?: (round: TranscriptRound) => void;
  wrapUpGrace: number;
  maxToolIterations: number | undefined;
  deadlineMs?: number;
  monotonicMs?: () => number;
}

export interface HeartbeatLoopResult {
  sendMessageText: string | undefined;
  images: ImageRef[];
  failedRound?: number | undefined;
}

function toolUsesOf(blocks: readonly ContentBlock[]): ToolUse[] {
  return blocks.flatMap((b) =>
    b.type === "tool_use" ? [[b.id, b.name, b.input] as ToolUse] : [],
  );
}

function responseText(resp: GenerateResponse): string {
  if (resp.content_blocks.length === 0) return resp.content;
  return resp.content_blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

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
      const result = await deps.dispatch(name, input, id);
      output = result.output;
      isError = result.isError;
      if (!isError && name === "generate_image") {
        const ref = generatedImageRef(result.value);
        if (ref !== undefined) images.push(ref);
      }
    }

    results.push({ type: "tool_result", tool_use_id: id, content: output, is_error: isError });
    captured.push({ name, input, output, isError });

    if (name !== "set_next_wake") deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);
  }

  return { results, captured, images };
}

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
  let failedRound: number | undefined;
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
    if (resp === undefined) {
      failedRound = iteration;
      break;
    }

    const tagged = extractSendMessage(responseText(resp));
    if (tagged !== undefined) sendMessageText = tagged;

    request.messages.push({
      role: "assistant",
      content: resp.content_blocks,
      ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
      model: request.model,
    });

    const toolUses = toolUsesOf(resp.content_blocks);
    const hasTools = toolUses.length > 0 && resp.finish_reason === "tool_use";

    sendMessageText = captureToolSendMessage(toolUses) ?? sendMessageText;

    let captured: CapturedTool[] = [];
    if (hasTools) {
      const round = await dispatchHeartbeatTools(toolUses, deps);
      request.messages.push({ role: "user", content: round.results });
      images.push(...round.images);
      captured = round.captured;
    }

    deps.recordTranscript?.({ callType, iteration, response: resp, captured });

    if (!hasTools) break;
  }

  return { sendMessageText, images, failedRound };
}
