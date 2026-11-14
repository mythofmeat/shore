import type { ToolPhase } from "../tools/execute.ts";
import { ToolLoopStop } from "../llm/tool_loop_control.ts";

import {
  captureToolSendMessage,
  extractSendMessage,
  isSendMessageTool,
  type ImageRef,
  type ToolUse,
} from "./wake_shape.ts";
import { appendWrapUpNudge, generatedImageRef, timeLeftPhrase } from "./wake_shape.ts";
import type { GenerateResponse, SidecarRequest, ToolDefinition, Usage } from "../llm/types.ts";
import type { ContentBlock } from "../engine/types.ts";
import { truncateSummary } from "../notifications.ts";
import type { CapturedTool } from "../transcript_capture.ts";
export type { CapturedTool };

export interface LoopToolResult {
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

export interface LoopRound {
  role: "user" | "assistant" | "system";
  blocks: ContentBlock[];
  model?: string;
}

export interface BackgroundLoopDeps {
  character: string;
  generate: (request: SidecarRequest, phase: ToolPhase, signal: AbortSignal) => Promise<GenerateResponse>;
  dispatch: (
    name: string,
    input: unknown,
    toolUseId?: string,
    tools?: readonly ToolDefinition[],
  ) => Promise<LoopToolResult>;
  note: (text: string) => void;
  recordTranscript?: (round: TranscriptRound) => void;
  wrapUpGrace: number;
  maxToolRounds: number | undefined;
  checkPictures?: (text: string) => Promise<string[]>;
  news?: (wrappingUp: boolean) => string | undefined;
  newsHeard?: () => void;
  persist?: (round: LoopRound) => Promise<void>;
  timeLimitMs: number;
  wrapUpMs: number;
  wrapUpText: (msLeft: number, rounds: number) => string;
  callTypes: readonly [string, string];
  name: string;
  interrupted?: () => boolean;
}

export interface BackgroundLoopResult {
  sendMessageText: string | undefined;
  images: ImageRef[];
  failedRound?: number | undefined;
  failure?: unknown;
  timedOut?: boolean;
  stoppedAt?: "time" | "rounds" | "interrupted";
  rounds: number;
  usage?: Usage;
}

export function pictureRetryText(problems: readonly string[]): string {
  return `[Your message has not been sent yet. These pictures in it could not be sent:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
    "Send the message again the same way, with the names fixed. If you do not send it again, it will be delivered " +
    "as it is, with only the names of those pictures shown.]";
}

export async function dispatchLoopTools(
  toolUses: readonly ToolUse[],
  deps: Pick<BackgroundLoopDeps, "dispatch" | "note">,
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

    deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);
  }

  return { results, captured, images };
}

async function retryPictures(
  request: SidecarRequest,
  result: Pick<BackgroundLoopResult, "sendMessageText">,
  deps: BackgroundLoopDeps,
  run: () => Promise<GenerateResponse>,
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
  const retry: ContentBlock[] = [{ type: "text", text: pictureRetryText(problems) }];
  request.messages.push({ role: "user", content: retry });
  await deps.persist?.({ role: "user", blocks: retry });
  try {
    const retried = await run();
    if (retried.finish_reason.startsWith("error")) deps.note("The retry to fix pictures failed; sending the message as it was");
  } catch (error) {
    deps.note(`The retry to fix pictures failed; sending the message as it was: ${truncateSummary(String(error), 120)}`);
  }
}

export async function runBackgroundLoop(
  request: SidecarRequest,
  deps: BackgroundLoopDeps,
): Promise<BackgroundLoopResult> {
  const result: Omit<BackgroundLoopResult, "rounds"> = { sendMessageText: undefined, images: [] };
  let iteration = 0;
  let captured: CapturedTool[] = [];
  const deadline = performance.now() + deps.timeLimitMs;
  const wrapUpMs = deps.wrapUpMs;
  const [firstCall, loopCall] = deps.callTypes;
  const normalCap = deps.maxToolRounds ?? Number.POSITIVE_INFINITY;
  const name = deps.name;
  let wrapUpEnd: number | undefined;
  let wrapUpFor: "time" | "rounds" = "time";
  let model: string | undefined;
  let persisted = false;
  const observe = (blocks: ContentBlock[]): void => {
    const text = blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    const sent = captured.filter((tool) => !tool.isError)
      .map((tool): ToolUse => ["", tool.name, tool.input]);
    const message = captureToolSendMessage(sent) ?? extractSendMessage(text);
    if (message !== undefined) result.sendMessageText = message;
  };
  const record = (response: GenerateResponse): void => {
    observe(response.content_blocks);
    if (response.finish_reason !== "tool_use") {
      request.messages.push({ role: "assistant", content: response.content_blocks });
    }
    deps.recordTranscript?.({
      callType: iteration === 0 ? firstCall : loopCall,
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
    beforeTurn: async (call) => {
      if (deps.interrupted?.() === true) {
        result.stoppedAt = "interrupted";
        throw new ToolLoopStop();
      }
      const left = deadline - performance.now();
      const nudgeDue = wrapUpEnd === undefined && !(left > wrapUpMs && iteration < normalCap);
      if (nudgeDue) wrapUpFor = left > wrapUpMs ? "rounds" : "time";
      if (wrapUpEnd === undefined ? nudgeDue && deps.wrapUpGrace === 0 : iteration >= wrapUpEnd) {
        result.stoppedAt = wrapUpFor;
        throw new ToolLoopStop();
      }
      const news = deps.news?.(nudgeDue || wrapUpEnd !== undefined);
      if (news !== undefined) {
        appendWrapUpNudge(call.messages, news);
        await deps.persist?.({ role: "system", blocks: [{ type: "text", text: news }] });
      }
      if (!nudgeDue) return;
      wrapUpEnd = iteration + deps.wrapUpGrace;
      const nudge = deps.wrapUpText(left, deps.wrapUpGrace);
      appendWrapUpNudge(call.messages, nudge);
      await deps.persist?.({ role: "system", blocks: [{ type: "text", text: nudge }] });
      deps.note(`Wrap-up nudge on round ${String(iteration)}, with ${timeLeftPhrase(left)} left`);
    },
    onTurn: (turn) => {
      model = turn.model;
      observe(turn.content_blocks);
    },
    afterTurn: async (response) => {
      deps.newsHeard?.();
      const recorded = persisted;
      persisted = false;
      result.usage = response.usage;
      record(response);
      if (!recorded) await deps.persist?.({ role: "assistant", blocks: response.content_blocks, model: response.model });
    },
    runTool: async (use) => {
      const round = await dispatchLoopTools([[use.id, use.name, use.input]], deps, request.tools);
      captured.push(...round.captured);
      result.images.push(...round.images);
      const message = captureToolSendMessage([[use.id, use.name, use.input]]);
      if (message !== undefined) result.sendMessageText = message;
      const block = round.results[0];
      if (block === undefined) throw new Error(`${name} tool returned no result`);
      return block;
    },
    recordTurn: async (role, blocks) => {
      if (role === "assistant") persisted = true;
      await deps.persist?.({ role, blocks, ...(role === "assistant" && model !== undefined ? { model } : {}) });
    },
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadline - performance.now());
  const run = async () => await deps.generate({
    ...request,
    ...(deps.maxToolRounds === undefined ? {} : { max_tool_rounds: deps.maxToolRounds + deps.wrapUpGrace }),
  }, phase, abort.signal);
  try {
    const response = await run();
    if (response.finish_reason.startsWith("error")) {
      result.failedRound = iteration - 1;
      result.failure = new Error(`${name} generation ended with ${response.finish_reason}`);
    } else {
      await retryPictures(request, result, deps, run, () => performance.now() < deadline);
    }
  } catch (failure) {
    result.failedRound = iteration;
    result.failure = failure;
  } finally {
    clearTimeout(timer);
  }
  if (result.failedRound !== undefined && abort.signal.aborted) result.timedOut = true;
  return { ...result, rounds: iteration };
}
