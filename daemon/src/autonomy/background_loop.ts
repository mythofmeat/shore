import type { ToolPhase } from "../tools/execute.ts";
import { ToolLoopStop } from "../llm/tool_loop_control.ts";

import { appendWrapUpNudge, generatedImageRef, timeLeftPhrase, type ImageRef, type ToolUse } from "./wake_shape.ts";
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
  images: ImageRef[];
  failedRound?: number | undefined;
  failure?: unknown;
  timedOut?: boolean;
  stoppedAt?: "time" | "rounds" | "interrupted";
  rounds: number;
  usage?: Usage;
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
    const result = await deps.dispatch(name, input, id, tools);
    const output = result.output;
    const isError = result.isError;
    const block = result.block;
    if (!isError && name === "generate_image") {
      const ref = generatedImageRef(result.value);
      if (ref !== undefined) images.push(ref);
    }

    results.push(
      block ?? { type: "tool_result", tool_use_id: id, content: output, is_error: isError },
    );
    captured.push({ name, input, output, isError });

    deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);
  }

  return { results, captured, images };
}

export async function runBackgroundLoop(
  request: SidecarRequest,
  deps: BackgroundLoopDeps,
): Promise<BackgroundLoopResult> {
  const result: Omit<BackgroundLoopResult, "rounds"> = { images: [] };
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
  const record = (response: GenerateResponse): void => {
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
