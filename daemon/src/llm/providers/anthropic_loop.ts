/**
 * The Anthropic tool loop, driven here rather than in the daemon.
 *
 * Uses the SDK's `toolRunner`, which is the reason this move is worth doing:
 * the request → execute → continue cycle, the iteration cap, and cancellation
 * all come from the SDK instead of being reimplemented. Tools run in this
 * process, through the {@link ToolPhase} the caller supplies — see
 * `tools/execute.ts`.
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

import { runnableTools } from "./anthropic_tools.ts";
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

/** One call's usage, in Shore's shape. */
function callUsage(message: BetaMessage): Usage {
  const u = message.usage;
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Accumulated usage across every call a loop makes. */
function addUsage(total: Usage, one: Usage): Usage {
  return {
    input_tokens: total.input_tokens + one.input_tokens,
    output_tokens: total.output_tokens + one.output_tokens,
    cache_read_tokens: total.cache_read_tokens + one.cache_read_tokens,
    cache_creation_tokens: total.cache_creation_tokens + one.cache_creation_tokens,
  };
}

/**
 * Run the whole loop, emitting one flat stream of events.
 *
 * The caller sees a single `start` … `done` regardless of how many model calls
 * the loop made; usage is the sum across all of them. The per-tool frames a
 * client renders are emitted by `executeToolUse` as each tool runs, on the
 * requesting session's channel — not on this stream.
 */
export async function* anthropicToolLoopEvents(
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();
  let firstTokenAt = 0;
  // Per-call, so each ledger row gets its own timing rather than the loop's.
  let callStartedAt = startedAt;
  let callFirstTokenAt = 0;
  const markFirst = () => {
    if (firstTokenAt === 0) firstTokenAt = now();
    if (callFirstTokenAt === 0) callFirstTokenAt = now();
  };

  const client = new Anthropic({
    apiKey: req.api_key,
    maxRetries: 0,
    ...(req.base_url ? { baseURL: req.base_url.replace(/\/v1\/?$/, "") } : {}),
  });

  const { params } = buildAnthropicPlan(req);
  const labelled: SystemContent = req.system ?? [];
  const cacheTtl = req.provider_options?.cache_ttl ?? "";

  // One controller drives the model calls and the runner itself. The caller's
  // signal feeds into it, so a client that hangs up stops the whole loop rather
  // than only its next call. A running tool is not on it — it is bounded by its
  // own `[tools] timeout`, which `dispatchWithinDeadline` owns.
  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  // A round's tools run concurrently, so results arrive in a race. They are
  // collected here and recorded in the order the model asked for them, because
  // completion order must not decide what gets stored.
  const results = new Map<string, ContentBlock>();
  let pendingToolIds: string[] = [];

  const runnable = runnableTools(req.tools ?? [], tools, (toolId, block) =>
    results.set(toolId, block),
  );

  /**
   * The finished round's results as one message, in the order the model asked.
   *
   * Empty until a round's tools have run. Drains, so a round is reported once.
   */
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
  /** The last turn's blocks — what the caller persists as this response. */
  let terminalBlocks: unknown[] = [];
  /** How many provider calls have completed, which is what makes the next one
   *  a continuation. The calls themselves are not held: each is emitted as a
   *  `call_complete` and recorded there and then, so a loop that fails or is
   *  abandoned keeps the rows for the calls that already happened. */
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
      // Emitted before the loop continues, so the row exists whether or not the
      // loop ever reaches `done`.
      yield {
        type: "call_complete",
        usage: one,
        timing: {
          total_ms: callEnd - callStartedAt,
          time_to_first_token_ms:
            callFirstTokenAt === 0 ? callEnd - callStartedAt : callFirstTokenAt - callStartedAt,
        },
        finish_reason: finishReason,
        // The opening call is the turn itself; everything after it answers tool
        // results, which is what the daemon-driven loop called `tool_loop`.
        continuation: completedCalls > 0,
      };
      completedCalls += 1;
      callStartedAt = callEnd;
      callFirstTokenAt = 0;
      // Persisted from the `done` event rather than from a stream accumulator,
      // which cannot tell one turn from the next.
      terminalBlocks = message.content;

      // The model stopped asking for tools. Break here rather than letting the
      // runner notice: with messages taken over it would spend another request
      // first. See the module doc.
      if (message.stop_reason !== "tool_use") break;

      // The loop is the only thing that knows where each turn ended, so it
      // records them. In conversation order: the previous round's results
      // (their tools ran while the runner was producing this turn), then this
      // turn — and before this turn's tools dispatch, so the assistant turn is
      // in the list in time for the generated-image side channel to find it.
      recordResults();
      pendingToolIds = message.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
      tools.recordTurn("assistant", message.content as ContentBlock[]);

      // Appending the assistant turn is now this side's job, and re-placing the
      // breakpoints over the grown conversation is the point of doing so.
      runner.setMessagesParams((prev) => {
        const messages: BetaMessageParam[] = [
          ...prev.messages,
          // Cloned. `placeContinuationBreakpoints` sets `cache_control` on
          // blocks *in place*, and `message.content` is the same array
          // `recordTurn` just handed to persistence — and the one
          // `terminalBlocks` holds for the `done` event. Sharing it stamps a
          // wire-only marker into the stored turn, and a marker on disk comes
          // back on every later request as `hasExistingMarkers`, which used to
          // switch caching off for the rest of the conversation. Everything
          // already in `prev.messages` came from `normalizeMessages`, which
          // builds fresh blocks, so only the turn appended here is shared.
          { role: message.role, content: structuredClone(message.content) },
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
    // The last round's results: after a terminal turn, and after an
    // iteration cap, whose final round ran its tools with no turn following.
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
    };
    return;
  }

  const total = now() - startedAt;
  yield {
    type: "done",
    content: text,
    finish_reason: finishReason,
    // Only the terminal turn. The stream accumulator sees every turn's blocks
    // in one flat stream and cannot tell where one ended, so it would otherwise
    // persist a final message replaying the whole loop.
    content_blocks: terminalBlocks,
    usage,
    timing: {
      total_ms: total,
      time_to_first_token_ms: firstTokenAt === 0 ? total : firstTokenAt - startedAt,
    },
  };
}
