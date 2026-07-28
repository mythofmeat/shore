/**
 * The Anthropic tool loop, driven here rather than in the daemon.
 *
 * Uses the SDK's `toolRunner`, which is the reason this move is worth doing:
 * the request → execute → continue cycle, the iteration cap, and cancellation
 * all come from the SDK instead of being reimplemented. Tools execute in the
 * daemon over the tool socket — see `llm/tool_rpc.ts`.
 *
 * # Breakpoints have to be re-placed every turn
 *
 * The cache schedule anchors partly on the *last* message, so as a loop appends
 * assistant turns and tool results the breakpoints must move with them.
 * Leaving them where the first request put them means every continuation
 * re-sends the loop's whole accumulated tail uncached — and since the daemon
 * previously rebuilt each continuation from scratch, that would be a
 * regression, not a limitation carried over.
 *
 * # Why the loop is written this way
 *
 * `setMessagesParams` sets a private "the caller has taken over messages" flag,
 * and the runner then changes behaviour in two ways that are invisible from its
 * public types (read out of `BetaToolRunner`'s implementation, 0.100.1):
 *
 *   1. It stops appending the assistant turn itself. So a driver that calls
 *      `setMessagesParams` **must** append that turn, or the conversation
 *      silently loses every model reply.
 *   2. It no longer stops when the model asks for no tools — it issues one more
 *      full-price request first. So the terminal turn is detected here and the
 *      iteration broken out of, rather than left to the runner.
 *
 * Both are pinned by tests below. They rest on a private field of a beta API,
 * so an SDK upgrade should re-check them: the failure mode for (1) is dropped
 * turns and for (2) a wasted call per turn, and neither is loud.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages";

import { daemonTools, type ToolRpcUnreachable } from "../tool_rpc.ts";
import type { SidecarRequest, StreamEvent, SystemContent, Usage } from "../types.ts";
import {
  anthropicContentEvents,
  buildAnthropicPlan,
  marksFirstToken,
  newTurnAccumulator,
  placeContinuationBreakpoints,
} from "./anthropic.ts";

/** Accumulated usage across every call a loop makes. */
function addUsage(total: Usage, message: BetaMessage): Usage {
  const u = message.usage;
  return {
    input_tokens: total.input_tokens + (u.input_tokens ?? 0),
    output_tokens: total.output_tokens + (u.output_tokens ?? 0),
    cache_read_tokens: total.cache_read_tokens + (u.cache_read_input_tokens ?? 0),
    cache_creation_tokens: total.cache_creation_tokens + (u.cache_creation_input_tokens ?? 0),
  };
}

/**
 * Run the whole loop, emitting one flat stream of events.
 *
 * The daemon sees a single `start` … `done` regardless of how many model calls
 * the loop made; usage is the sum across all of them. Per-tool events reach the
 * client from the daemon's own side of the socket, where the executors are.
 */
export async function* anthropicToolLoopEvents(
  req: SidecarRequest,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const rpc = req.tool_rpc;
  if (!rpc) throw new Error("anthropicToolLoopEvents requires tool_rpc on the request");

  const startedAt = now();
  let firstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
  };

  const client = new Anthropic({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: req.base_url.replace(/\/v1\/?$/, "") } : {}),
  });

  const { params } = buildAnthropicPlan(req);
  const labelled: SystemContent = req.system ?? [];
  const cacheTtl = req.provider_options?.cache_ttl ?? "";

  // A tool the daemon could not even attempt is not something to tell the model
  // about; it ends the turn. Aborting is the only way to do that from inside a
  // tool — see `llm/tool_rpc.ts`.
  const abort = new AbortController();
  let unreachable: ToolRpcUnreachable | undefined;
  const tools = daemonTools(req.tools ?? [], rpc, (error) => {
    unreachable ??= error;
    abort.abort();
  });

  const runner = client.beta.messages.toolRunner({
    ...params,
    tools,
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
      usage = addUsage(usage, message);
      finishReason = message.stop_reason ?? "end_turn";

      // The model stopped asking for tools. Break here rather than letting the
      // runner notice: with messages taken over it would spend another request
      // first. See the module doc.
      if (message.stop_reason !== "tool_use") break;

      // Appending the assistant turn is now this side's job, and re-placing the
      // breakpoints over the grown conversation is the point of doing so.
      runner.setMessagesParams((prev) => {
        const messages: BetaMessageParam[] = [
          ...prev.messages,
          { role: message.role, content: message.content },
        ];
        const system = (prev.system ?? []) as BetaTextBlockParam[];
        // The beta and non-beta param shapes are identical for the fields
        // placement touches (role, content blocks, cache_control).
        placeContinuationBreakpoints(
          messages as never,
          system as never,
          labelled,
          cacheTtl,
        );
        return { ...prev, messages, system };
      });
    }
  } catch (error) {
    // An unreachable daemon surfaces as an abort; report the real cause.
    const cause = unreachable ?? error;
    const total = now() - startedAt;
    yield {
      type: "error",
      message: String(cause instanceof Error ? cause.message : cause),
      usage,
      timing: {
        total_ms: total,
        time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
      },
    };
    return;
  }

  if (unreachable) {
    const total = now() - startedAt;
    yield {
      type: "error",
      message: unreachable.message,
      usage,
      timing: {
        total_ms: total,
        time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
      },
    };
    return;
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: text,
    finish_reason: finishReason,
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}
