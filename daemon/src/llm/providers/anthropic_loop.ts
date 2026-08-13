import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages";

import { runnableTools } from "./anthropic_tools.ts";
import { isAbortError } from "../abort.ts";
import { effectiveCacheTtl } from "../cache_capability.ts";
import { anthropicClientFor } from "./anthropic_client.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import type { ContentBlock } from "../../engine/types.ts";
import type { SidecarRequest, StreamEvent, SystemContent, Usage } from "../types.ts";
import {
  anthropicContentEvents,
  buildAnthropicPlan,
  marksFirstToken,
  newTurnAccumulator,
  placeContinuationBreakpoints,
} from "./anthropic.ts";

function callUsage(message: BetaMessage): Usage {
  const u = message.usage;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(total: Usage, one: Usage): Usage {
  return {
    input_tokens: total.input_tokens + one.input_tokens,
    output_tokens: total.output_tokens + one.output_tokens,
    cache_read_tokens: total.cache_read_tokens + one.cache_read_tokens,
    cache_creation_tokens: total.cache_creation_tokens + one.cache_creation_tokens,
  };
}

export async function* anthropicToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  let callStartedAt = startedAt;
  let callFirstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
    if (callFirstTokenAt === 0) callFirstTokenAt = now();
  };

  const client = anthropicClientFor(req);

  const { params } = buildAnthropicPlan(req);
  const labelled: SystemContent = req.system ?? [];
  const cacheTtl = effectiveCacheTtl(req.sdk, req.base_url, req.provider_options?.cache_ttl ?? "");

  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const results = new Map<string, ContentBlock>();
  let pendingToolIds: string[] = [];

  const runnable = runnableTools(req.tools ?? [], tools, (toolId, block) =>
    results.set(toolId, block),
  );

  const recordResults = (): void => {
    if (pendingToolIds.length === 0) return;
    const blocks = pendingToolIds.map(
      (id) =>
        results.get(id) ?? {
          type: "tool_result" as const,
          tool_use_id: id,
          content: "",
          is_error: false,
        },
    );
    pendingToolIds = [];
    tools.recordTurn("user", blocks);
  };

  const runner = client.beta.messages.toolRunner({
    ...params,
    tools: runnable,
    stream: true,
    ...(req.max_tool_iterations !== undefined
      ? { max_iterations: req.max_tool_iterations }
      : {}),
  });
  runner.setRequestOptions({ signal: abort.signal });

  yield { type: "start", model: req.model };

  let usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  let text = "";
  let finishReason = "end_turn";
  let terminalBlocks: unknown[] = [];
  let completedCalls = 0;

  try {
    for await (const stream of runner) {
      const acc = newTurnAccumulator();
      for await (const event of anthropicContentEvents(
        stream as AsyncIterable<never>,
        acc,
      )) {
        if (marksFirstToken(event)) markFirst();
        yield event;
      }
      text += acc.text;

      const message = await stream.finalMessage();
      const one = callUsage(message);
      usage = addUsage(usage, one);
      finishReason = message.stop_reason ?? "end_turn";
      const callEnd = now();
      yield {
        type: "call_complete",
        usage: one,
        timing: {
          total_ms: callEnd - callStartedAt,
          time_to_first_token_ms:
            callFirstTokenAt === 0 ? callEnd - callStartedAt : callFirstTokenAt - callStartedAt,
        },
        finish_reason: finishReason,
        continuation: completedCalls > 0,
      };
      completedCalls += 1;
      callStartedAt = callEnd;
      callFirstTokenAt = 0;
      terminalBlocks = message.content;

      if (message.stop_reason !== "tool_use") break;

      recordResults();
      pendingToolIds = message.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
      tools.recordTurn("assistant", message.content as ContentBlock[]);

      runner.setMessagesParams((prev) => {
        const messages: BetaMessageParam[] = [
          ...prev.messages,
          { role: message.role, content: structuredClone(message.content) },
        ];
        const system = (prev.system ?? []) as BetaTextBlockParam[];
        placeContinuationBreakpoints(
          messages as never,
          system as never,
          labelled,
          cacheTtl,
        );
        return { ...prev, messages, system };
      });
    }
    recordResults();
  } catch (cause) {
    const total = now() - startedAt;
    yield {
      type: "error",
      message: String(cause instanceof Error ? cause.message : cause),
      usage,
      timing: {
        total_ms: total,
        time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
      },
      ...(isAbortError(cause) || signal?.aborted === true ? { aborted: true } : {}),
    };
    return;
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: text,
    finish_reason: finishReason,
    content_blocks: terminalBlocks,
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}
