import type { ToolPhase } from "../tools/execute.ts";
import { ToolLoopStop } from "../llm/tool_loop_control.ts";

import {
  captureToolSendMessage,
  extractSendMessage,
  isSendMessageTool,
  type ImageRef,
  type ToolUse,
} from "./heartbeat_shape.ts";
import { budgetDecision, appendWrapUpNudge, generatedImageRef } from "./heartbeat_shape.ts";
import type { GenerateResponse, SidecarRequest, ToolDefinition } from "../llm/types.ts";
import type { ContentBlock } from "../engine/types.ts";
import { truncateSummary } from "../notifications.ts";
import type { CapturedTool } from "../transcript_capture.ts";
export type { CapturedTool };

const HEARTBEAT_LOOP_DEADLINE_MS = 30 * 60 * 1000;

export interface HeartbeatToolResult {
  output: string;
  isError: boolean;
  value?: unknown;
  block?: ContentBlock;
}

export interface TranscriptRound {
  callType: string;
  iteration: number;
  response: GenerateResponse;
  captured: CapturedTool[];
}

export interface HeartbeatLoopDeps {
  character: string;
  generate: (request: SidecarRequest, phase: ToolPhase, signal: AbortSignal) => Promise<GenerateResponse | undefined>;
  dispatch: (
    name: string,
    input: unknown,
    toolUseId?: string,
    tools?: readonly ToolDefinition[],
  ) => Promise<HeartbeatToolResult>;
  note: (text: string) => void;
  recordTranscript?: (round: TranscriptRound) => void;
  wrapUpGrace: number;
  maxToolIterations: number | undefined;
  deadlineMs?: number;
  monotonicMs?: () => number;
  checkPictures?: (text: string) => Promise<string[]>;
}

export interface HeartbeatLoopResult {
  sendMessageText: string | undefined;
  images: ImageRef[];
  thinking?: ContentBlock[];
  failedRound?: number | undefined;
  failure?: unknown;
}

export function pictureRetryText(problems: readonly string[]): string {
  return `[Your message has not been sent yet. These pictures in it could not be sent:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
    "Send the message again the same way, with the names fixed. If you do not send it again, it will be delivered " +
    "as it is, with only the names of those pictures shown.]";
}

function thinkingOf(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
}

export async function dispatchHeartbeatTools(
  toolUses: readonly ToolUse[],
  deps: Pick<HeartbeatLoopDeps, "dispatch" | "note">,
  tools?: readonly ToolDefinition[],
): Promise<{ results: ContentBlock[]; captured: CapturedTool[]; images: ImageRef[] }> {
  const results: ContentBlock[] = [];
  const captured: CapturedTool[] = [];
  const images: ImageRef[] = [];

  for (const [id, name, input] of toolUses) {
    let output: string;
    let isError: boolean;
    let block: ContentBlock | undefined;

    if (isSendMessageTool(name)) {
      output = JSON.stringify({
        status: "delivered",
        detail: "Message will be delivered to the user when this tick ends.",
      });
      isError = false;
    } else {
      const result = await deps.dispatch(name, input, id, tools);
      output = result.output;
      isError = result.isError;
      block = result.block;
      if (!isError && name === "generate_image") {
        const ref = generatedImageRef(result.value);
        if (ref !== undefined) images.push(ref);
      }
    }

    results.push(
      block ?? { type: "tool_result", tool_use_id: id, content: output, is_error: isError },
    );
    captured.push({ name, input, output, isError });

    if (name !== "set_next_wake" || isError) deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);
  }

  return { results, captured, images };
}

async function retryPictures(
  request: SidecarRequest,
  result: HeartbeatLoopResult,
  deps: HeartbeatLoopDeps,
  run: () => Promise<GenerateResponse | undefined>,
  inTime: () => boolean,
): Promise<void> {
  const sent = result.sendMessageText;
  if (sent === undefined || deps.checkPictures === undefined || !inTime()) return;
  let problems: string[];
  try {
    problems = await deps.checkPictures(sent);
  } catch (error) {
    deps.note(`Pictures could not be checked before sending: ${truncateSummary(String(error), 120)}`);
    return;
  }
  if (problems.length === 0) return;
  deps.note(`Pictures not found, asked to fix them before sending: ${truncateSummary(problems.join("; "), 160)}`);
  request.messages.push({ role: "user", content: [{ type: "text", text: pictureRetryText(problems) }] });
  try {
    const retried = await run();
    if (retried === undefined || retried.finish_reason.startsWith("error")) deps.note("The retry to fix pictures failed; sending the message as it was");
  } catch (error) {
    deps.note(`The retry to fix pictures failed; sending the message as it was: ${truncateSummary(String(error), 120)}`);
  }
}

export async function runHeartbeatToolLoop(
  request: SidecarRequest,
  deps: HeartbeatLoopDeps,
): Promise<HeartbeatLoopResult> {
  const result: HeartbeatLoopResult = { sendMessageText: undefined, images: [] };
  let iteration = 0;
  let captured: CapturedTool[] = [];
  const clock = deps.monotonicMs ?? Date.now;
  const deadline = clock() + (deps.deadlineMs ?? HEARTBEAT_LOOP_DEADLINE_MS);
  const normalCap = deps.maxToolIterations ?? Number.POSITIVE_INFINITY;
  let wrapUpNudged = false;
  const observe = (blocks: ContentBlock[]): void => {
    const text = blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    const sent = captured.filter((tool) => !tool.isError)
      .map((tool): ToolUse => ["", tool.name, tool.input]);
    const message = captureToolSendMessage(sent) ?? extractSendMessage(text);
    if (message !== undefined) {
      result.sendMessageText = message;
      result.thinking = thinkingOf(blocks);
    }
  };
  const record = (response: GenerateResponse): void => {
    observe(response.content_blocks);
    if (captured.some((tool) => tool.name === "generate_image" && !tool.isError) && result.sendMessageText === undefined) {
      result.thinking = thinkingOf(response.content_blocks);
    }
    if (response.finish_reason !== "tool_use") {
      request.messages.push({ role: "assistant", content: response.content_blocks });
    }
    deps.recordTranscript?.({
      callType: iteration === 0 ? "heartbeat" : "heartbeat_tool_loop",
      iteration,
      response,
      captured,
    });
    captured = [];
    iteration += 1;
  };
  const phase: ToolPhase = {
    messages: [],
    parallel: false,
    beforeTurn: (call) => {
      const action = budgetDecision(clock() >= deadline, iteration >= normalCap, deps.wrapUpGrace, wrapUpNudged);
      if (action === "break" || iteration >= normalCap + deps.wrapUpGrace) throw new ToolLoopStop();
      if (action === "nudge") {
        appendWrapUpNudge(call.messages);
        wrapUpNudged = true;
        deps.note("Wrap-up nudge: budget reached, model asked to summarize");
      }
    },
    onTurn: (turn) => { observe(turn.content_blocks); },
    afterTurn: record,
    runTool: async (use) => {
      const round = await dispatchHeartbeatTools([[use.id, use.name, use.input]], deps, request.tools);
      captured.push(...round.captured);
      result.images.push(...round.images);
      const message = captureToolSendMessage([[use.id, use.name, use.input]]);
      if (message !== undefined) result.sendMessageText = message;
      const block = round.results[0];
      if (block === undefined) throw new Error("Heartbeat tool returned no result");
      return block;
    },
    recordTurn: () => {},
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.deadlineMs ?? HEARTBEAT_LOOP_DEADLINE_MS);
  const run = async () => await deps.generate({
    ...request,
    ...(deps.maxToolIterations === undefined ? {} : { max_tool_iterations: deps.maxToolIterations + deps.wrapUpGrace }),
  }, phase, abort.signal);
  try {
    const response = await run();
    if (response !== undefined && !response.finish_reason.startsWith("error")) await retryPictures(request, result, deps, run, () => clock() < deadline);
    if (response === undefined) {
      result.failedRound = iteration;
    } else if (response.finish_reason.startsWith("error")) {
      result.failedRound = iteration - 1;
      result.failure = new Error(`Heartbeat generation ended with ${response.finish_reason}`);
    }
  } catch (failure) {
    result.failedRound = iteration;
    result.failure = failure;
  } finally {
    clearTimeout(timer);
  }
  return result;
}
