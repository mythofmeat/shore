import type { ToolPhase } from "../tools/execute.ts";
import { shoreLog } from "../log.ts";

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
  generate: (
    request: SidecarRequest,
    iteration: number,
    callType: string,
  ) => Promise<GenerateResponse | undefined>;
  generateWithTools?: (request: SidecarRequest, phase: ToolPhase, signal: AbortSignal) => Promise<GenerateResponse>;
  dispatch: (
    name: string,
    input: unknown,
    toolUseId?: string,
    tools?: readonly ToolDefinition[],
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
  thinking?: ContentBlock[];
  failedRound?: number | undefined;
  failure?: unknown;
}

function thinkingOf(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
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
  tools?: readonly ToolDefinition[],
): Promise<{ results: ContentBlock[]; captured: CapturedTool[]; images: ImageRef[] }> {
  const results: ContentBlock[] = [];
  const captured: CapturedTool[] = [];
  const images: ImageRef[] = [];

  for (const [id, name, input] of toolUses) {
    let output: string;
    let isError: boolean;
    let block: ContentBlock | undefined;

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

    if (name !== "set_next_wake") deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);
  }

  return { results, captured, images };
}

export async function runHeartbeatToolLoop(
  request: SidecarRequest,
  deps: HeartbeatLoopDeps,
): Promise<HeartbeatLoopResult> {
  if (request.sdk === "claude_agent") return runSdkHeartbeat(request, deps);

  const maxNormalIterations = deps.maxToolIterations ?? Number.POSITIVE_INFINITY;
  const totalIterations = maxNormalIterations + deps.wrapUpGrace;

  shoreLog.info(
    `shore: heartbeat tool loop for ${deps.character} ` +
      `(max_iterations=${maxNormalIterations}, wrap_up_grace=${deps.wrapUpGrace})`,
  );

  let sendMessageText: string | undefined;
  let messageThinking: ContentBlock[] = [];
  let failedRound: number | undefined;
  let failure: unknown;
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
      appendWrapUpNudge(request.messages);
      wrapUpNudged = true;
      deps.note("Wrap-up nudge: budget reached, model asked to summarize");
    }

    const callType = iteration === 0 ? "heartbeat" : "heartbeat_tool_loop";
    let resp: GenerateResponse | undefined;
    try {
      resp = await deps.generate(request, iteration, callType);
    } catch (e) {
      failedRound = iteration;
      failure = e;
      break;
    }
    if (resp === undefined) {
      failedRound = iteration;
      break;
    }

    const thinking = thinkingOf(resp.content_blocks);
    const tagged = extractSendMessage(responseText(resp));
    if (tagged !== undefined) {
      sendMessageText = tagged;
      messageThinking = thinking;
    }

    request.messages.push({
      role: "assistant",
      content: resp.content_blocks,
      ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
      model: request.model,
    });

    const toolUses = toolUsesOf(resp.content_blocks);
    const hasTools = toolUses.length > 0 && resp.finish_reason === "tool_use";

    const fromTool = captureToolSendMessage(toolUses);
    if (fromTool !== undefined) {
      sendMessageText = fromTool;
      messageThinking = thinking;
    }

    let captured: CapturedTool[] = [];
    if (hasTools) {
      const round = await dispatchHeartbeatTools(toolUses, deps, request.tools);
      request.messages.push({ role: "user", content: round.results });
      if (round.images.length > 0 && sendMessageText === undefined) messageThinking = thinking;
      images.push(...round.images);
      captured = round.captured;
    }

    deps.recordTranscript?.({ callType, iteration, response: resp, captured });

    if (!hasTools) break;
  }

  return { sendMessageText, images, thinking: messageThinking, failedRound, failure };
}

async function runSdkHeartbeat(
  request: SidecarRequest,
  deps: HeartbeatLoopDeps,
): Promise<HeartbeatLoopResult> {
  request = {
    ...request,
    tools: [
      ...(request.tools ?? []).filter((tool) => tool.name !== "set_next_wake" && !isSendMessageTool(tool.name)),
      {
        name: "set_next_wake",
        description: "Schedule the next heartbeat.",
        input_schema: {
          type: "object",
          properties: { hours_from_now: { type: "number" }, reason: { type: "string" } },
          required: ["hours_from_now", "reason"],
        },
      },
      {
        name: "send_message",
        description: "Send a message to the user when this heartbeat finishes.",
        input_schema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
  };
  const result: HeartbeatLoopResult = { sendMessageText: undefined, images: [] };
  if (deps.generateWithTools === undefined) {
    return { ...result, failedRound: 0, failure: new Error("Claude Agent SDK heartbeat tool loop is unavailable") };
  }
  let iteration = 0;
  let captured: CapturedTool[] = [];
  let pendingBlocks: ContentBlock[] = [];
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
    recordTurn: (role, blocks) => {
      if (role === "assistant") {
        pendingBlocks = blocks;
      } else {
        record({
          model: request.model,
          content: pendingBlocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
          content_blocks: pendingBlocks,
          finish_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
          timing: { total_ms: 0, time_to_first_token_ms: 0 },
        });
        pendingBlocks = [];
      }
    },
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.deadlineMs ?? HEARTBEAT_LOOP_DEADLINE_MS);
  try {
    const response = await deps.generateWithTools({
      ...request,
      ...(deps.maxToolIterations === undefined ? {} : { max_tool_iterations: deps.maxToolIterations }),
    }, phase, abort.signal);
    record(response);
    if (response.finish_reason.startsWith("error")) {
      result.failedRound = iteration - 1;
      result.failure = new Error(`Claude Agent SDK heartbeat ended with ${response.finish_reason}`);
    }
  } catch (failure) {
    result.failedRound = iteration;
    result.failure = failure;
  } finally {
    clearTimeout(timer);
  }
  return result;
}
