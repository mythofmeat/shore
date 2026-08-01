/**
 * The tool loop for every dialect that is not Anthropic.
 *
 * The Anthropic loop is built on that SDK's `toolRunner`, which has no
 * equivalent elsewhere — so the daemon kept driving the loop for the other five
 * adapters, and `handler/generation.rs`'s `can_delegate_tool_loop` said
 * `sdk == Anthropic` for exactly that reason. This is the equivalent, written
 * once against the `SidecarProvider` interface all six already implement.
 *
 * That interface is the reason this is one file rather than five. Every adapter
 * already yields Shore `StreamEvent`s and ends with a `done` carrying a finish
 * reason — which is all a loop needs to know. Nothing here is aware of which
 * provider it is driving.
 *
 * # Where the control flow lives
 *
 * `engine/tool_loop.ts`, ported from the Rust and pinned by
 * `tests/engine_fixtures/tool_loop_parity.json`. Deliberately NOT the AI SDK's
 * `stopWhen: stepCountIs(n)`, which counts steps where the daemon counted
 * dispatch rounds and which never spends the closing call that lets a capped
 * loop answer with its last tool results in hand. See that fixture's header.
 *
 * # What the daemon sees
 *
 * One flat `start` … `done`, regardless of how many model calls happened, with
 * usage summed across all of them and `content_blocks` carrying only the
 * terminal turn. Each individual call is announced as it lands via
 * `call_complete`, so its ledger row exists whether or not the loop ever
 * reaches `done`. This matches `anthropic_loop.ts` exactly; the daemon cannot
 * tell the two apart, and `wire_parity.json` is what says so.
 */

import type { ContentBlock } from "../../engine/types.ts";
import {
  runToolLoop,
  type ToolLoopDriver,
  type ToolUseEvent,
} from "../../engine/tool_loop.ts";
import {
  callDaemonTool,
  isTransportError,
  reportMessages,
  ToolRpcUnreachable,
  type ReportedMessage,
} from "../tool_rpc.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  Timing,
  ToolRpc,
  Usage,
} from "../types.ts";
import { marksFirstToken } from "./anthropic.ts";

/** One model call's outcome, as the loop needs to see it. */
interface ProviderTurn {
  blocks: ContentBlock[];
  finishReason: string;
}

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

function addUsage(total: Usage, one: Usage): Usage {
  return {
    input_tokens: total.input_tokens + one.input_tokens,
    output_tokens: total.output_tokens + one.output_tokens,
    cache_read_tokens: total.cache_read_tokens + one.cache_read_tokens,
    cache_creation_tokens: total.cache_creation_tokens + one.cache_creation_tokens,
    ...(total.total_cost_usd !== undefined || one.total_cost_usd !== undefined
      ? { total_cost_usd: (total.total_cost_usd ?? 0) + (one.total_cost_usd ?? 0) }
      : {}),
  };
}

/**
 * A one-slot handoff from the loop to the generator draining it.
 *
 * The loop has to be a plain async function — `runToolLoop` is pinned against a
 * fixture and takes a driver, not a generator — but the daemon has to see
 * tokens as they arrive, so the events cannot be buffered until it returns.
 *
 * Capacity one, not a queue: `yield` in the Anthropic path suspends the
 * producer until the consumer asks for the next event, and an unbounded buffer
 * would silently drop that backpressure. Single-producer by construction, since
 * `runToolLoop` awaits each driver call before making the next — which is why
 * `send` needs no wait-for-space branch.
 */
class EventChannel {
  private pending: { event: StreamEvent; taken: () => void } | undefined;
  private waiting: (() => void) | undefined;
  private closed = false;

  send(event: StreamEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((taken) => {
      this.pending = { event, taken };
      this.wake();
    });
  }

  /** Ends the drain. Releases a producer parked in `send` so it cannot hang. */
  close(): void {
    this.closed = true;
    this.pending?.taken();
    this.pending = undefined;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  async *drain(): AsyncIterable<StreamEvent> {
    for (;;) {
      const pending = this.pending;
      if (pending !== undefined) {
        this.pending = undefined;
        yield pending.event;
        // After the yield returns, not before: that is what makes this
        // backpressure rather than a one-deep buffer.
        pending.taken();
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resume) => {
        this.waiting = resume;
      });
    }
  }
}

/**
 * Turns one adapter's event stream into a turn, forwarding as it goes.
 *
 * Accumulating at the Shore-event level rather than the provider's raw one is
 * what makes this provider-agnostic — and it is also the only level at which
 * the reasoning carriers can be reassembled, since each adapter has already
 * normalized its own vendor shape into `thinking_signature`,
 * `reasoning_details` or `reasoning_content` by this point. They have to be put
 * back onto the turn: DeepSeek and Kimi hard-require prior-turn reasoning to be
 * replayed across a tool loop.
 */
class TurnBuilder {
  private thinking = "";
  private text = "";
  private signature: string | undefined;
  private reasoningDetails: unknown[] | undefined;
  private reasoningContent: string | undefined;
  private readonly redacted: ContentBlock[] = [];
  private readonly toolUses: ContentBlock[] = [];
  finishReason = "end_turn";
  usage: Usage = emptyUsage();

  accept(event: StreamEvent): void {
    switch (event.type) {
      case "text":
        this.text += event.text;
        break;
      case "thinking":
        this.thinking += event.text;
        break;
      case "thinking_signature":
        this.signature = event.signature;
        break;
      case "reasoning_details":
        this.reasoningDetails = event.details;
        break;
      case "reasoning_content":
        this.reasoningContent = event.reasoning;
        break;
      case "redacted_thinking":
        this.redacted.push({ type: "redacted_thinking", data: event.data });
        break;
      case "tool_use":
        this.toolUses.push({
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;
      case "done":
        this.finishReason = event.finish_reason;
        this.usage = event.usage;
        break;
      default:
        break;
    }
  }

  /** Canonical block order: thinking, then text, then the tools it asked for. */
  blocks(): ContentBlock[] {
    const out: ContentBlock[] = [];
    const hasReasoning =
      this.thinking.length > 0 ||
      this.signature !== undefined ||
      this.reasoningDetails !== undefined ||
      this.reasoningContent !== undefined;
    if (hasReasoning) {
      out.push({
        type: "thinking",
        thinking: this.thinking,
        ...(this.signature !== undefined ? { signature: this.signature } : {}),
        ...(this.reasoningDetails !== undefined
          ? { reasoning_details: this.reasoningDetails }
          : {}),
        ...(this.reasoningContent !== undefined
          ? { reasoning_content: this.reasoningContent }
          : {}),
      });
    }
    out.push(...this.redacted);
    if (this.text.length > 0) out.push({ type: "text", text: this.text });
    out.push(...this.toolUses);
    return out;
  }

  textSoFar(): string {
    return this.text;
  }
}

/** The driver `runToolLoop` calls. Owns everything provider-shaped. */
class ProviderLoopDriver implements ToolLoopDriver<ProviderTurn> {
  usage: Usage = emptyUsage();
  text = "";
  terminalBlocks: ContentBlock[] = [];
  terminalFinishReason = "end_turn";
  completedCalls = 0;
  firstTokenAt = 0;
  unreachable: ToolRpcUnreachable | undefined;

  /** This round's results, in the order the model asked for them. */
  private pendingResults: ContentBlock[] = [];
  private callStartedAt: number;

  constructor(
    private readonly provider: SidecarProvider,
    private readonly req: SidecarRequest,
    private readonly rpc: ToolRpc,
    private readonly channel: EventChannel,
    private readonly abort: AbortController,
    private readonly now: () => number,
    startedAt: number,
  ) {
    this.callStartedAt = startedAt;
  }

  finishReason(turn: ProviderTurn): string {
    return turn.finishReason;
  }

  toolUses(turn: ProviderTurn): ToolUseEvent[] {
    return turn.blocks.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
  }

  async callModel(): Promise<ProviderTurn> {
    const builder = new TurnBuilder();
    let callFirstTokenAt = 0;

    for await (const event of this.provider.stream(this.req, this.abort.signal)) {
      builder.accept(event);
      // One `start` per loop, emitted by the caller; an adapter's own `start`
      // and `done` frame its single call, not the loop.
      if (event.type === "start" || event.type === "done") continue;
      if (event.type === "error") {
        // The adapter reports a mid-flight failure as an event rather than a
        // throw, and carries whatever usage the provider had already billed.
        this.usage = addUsage(this.usage, event.usage);
        throw new Error(event.message);
      }
      if (marksFirstToken(event)) {
        if (this.firstTokenAt === 0) this.firstTokenAt = this.now();
        if (callFirstTokenAt === 0) callFirstTokenAt = this.now();
      }
      await this.channel.send(event);
    }

    const callEnd = this.now();
    this.usage = addUsage(this.usage, builder.usage);
    this.text += builder.textSoFar();
    const blocks = builder.blocks();
    this.terminalBlocks = blocks;
    this.terminalFinishReason = builder.finishReason;

    // Emitted before the loop continues, so the row exists whether or not the
    // loop ever reaches `done`.
    await this.channel.send({
      type: "call_complete",
      usage: builder.usage,
      timing: {
        total_ms: callEnd - this.callStartedAt,
        time_to_first_token_ms:
          callFirstTokenAt === 0 ? callEnd - this.callStartedAt : callFirstTokenAt - this.callStartedAt,
      },
      finish_reason: builder.finishReason,
      // The opening call is the turn itself; everything after it answers tool
      // results, which is what the daemon-driven loop called `tool_loop`.
      continuation: this.completedCalls > 0,
    });
    this.completedCalls += 1;
    this.callStartedAt = callEnd;

    return { blocks, finishReason: builder.finishReason };
  }

  async dispatch(turn: ProviderTurn, uses: ToolUseEvent[]): Promise<void> {
    // Appending the assistant turn is the driver's job — see the
    // `ToolLoopDriver` contract. The next call has to see it, and the daemon
    // has to persist it.
    this.req.messages.push({ role: "assistant", content: turn.blocks });

    // Reported BEFORE the tools run, on the same channel they run over: the
    // daemon's generated-image handling attaches to the assistant turn that
    // requested the tool, so that turn must already be recorded. Carries the
    // previous round's results with it, in conversation order, so a round costs
    // one report rather than two.
    const prior = this.drainResults();
    await reportMessages(
      this.rpc,
      [...prior, { role: "assistant", content_blocks: turn.blocks }],
      this.abort.signal,
    );

    // Concurrent, but collected in ask-order: `Promise.all` preserves input
    // order, so completion order never decides what the daemon stores. The
    // Anthropic path needs a record-as-they-land callback for this because the
    // SDK owns the scheduling; here the loop does, so it falls out.
    const outcomes = await Promise.all(
      uses.map(async (use) => {
        const outcome = await callDaemonTool(
          this.rpc.socket_path,
          {
            kind: "tool",
            rid: this.rpc.rid,
            tool_id: use.id,
            name: use.name,
            input: use.input,
          },
          this.abort.signal,
        ).catch((cause: unknown) => {
          throw cause instanceof ToolRpcUnreachable
            ? cause
            : new ToolRpcUnreachable(String(cause));
        });
        if (isTransportError(outcome)) throw new ToolRpcUnreachable(outcome.error);
        return outcome;
      }),
    ).catch((cause: unknown) => {
      // A tool the daemon could not even attempt is not something to tell the
      // model about; it ends the turn.
      const error =
        cause instanceof ToolRpcUnreachable ? cause : new ToolRpcUnreachable(String(cause));
      this.unreachable ??= error;
      this.abort.abort();
      throw error;
    });

    this.pendingResults = uses.map((use, i) => ({
      type: "tool_result",
      tool_use_id: use.id,
      content: outcomes[i]?.output ?? "",
      is_error: outcomes[i]?.is_error ?? false,
    }));
  }

  appendToolResults(): void {
    this.req.messages.push({ role: "user", content: this.pendingResults });
  }

  /** The finished round's results as one message. Drains, so it reports once. */
  drainResults(): ReportedMessage[] {
    if (this.pendingResults.length === 0) return [];
    const blocks = this.pendingResults;
    this.pendingResults = [];
    return [{ role: "user", content_blocks: blocks }];
  }

  /** The last round's results: after a terminal turn, and after a cap whose
   *  final round ran its tools with no turn following. */
  async reportFinalResults(): Promise<void> {
    await reportMessages(this.rpc, this.drainResults(), this.abort.signal);
  }
}

/**
 * Run the whole loop, emitting one flat stream of events.
 *
 * Mirrors `anthropicToolLoopEvents` frame for frame — the daemon parses one
 * stream shape and does not know which produced it.
 */
export async function* genericToolLoopEvents(
  provider: SidecarProvider,
  req: SidecarRequest,
  signal?: AbortSignal,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const rpc = req.tool_rpc;
  if (!rpc) throw new Error("genericToolLoopEvents requires tool_rpc on the request");

  const startedAt = now();

  // One controller drives everything the loop owns: the model calls and the
  // tool socket. The transport's signal feeds into it, so a client that hangs
  // up stops the whole loop rather than only its next call.
  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const channel = new EventChannel();
  const driver = new ProviderLoopDriver(provider, req, rpc, channel, abort, now, startedAt);

  let failure: unknown;
  const running = (async () => {
    try {
      await runToolLoop(driver, undefined, req.max_tool_iterations, "close_with_final_turn");
      await driver.reportFinalResults();
    } catch (error) {
      failure = error;
    } finally {
      channel.close();
    }
  })();

  yield { type: "start", model: req.model };

  try {
    for await (const event of channel.drain()) yield event;
  } finally {
    // A consumer that stops early leaves the loop parked in `send`; closing
    // releases it, and awaiting keeps the abort from racing the unwind.
    channel.close();
    await running;
  }

  const timing = (): Timing => {
    const total = now() - startedAt;
    return {
      total_ms: total,
      time_to_first_token_ms:
        driver.firstTokenAt === 0 ? total : driver.firstTokenAt - startedAt,
    };
  };

  // An unreachable daemon surfaces as an abort; report the real cause.
  const cause = driver.unreachable ?? failure;
  if (cause !== undefined) {
    yield {
      type: "error",
      message: String(cause instanceof Error ? cause.message : cause),
      usage: driver.usage,
      timing: timing(),
    };
    return;
  }

  yield {
    type: "done",
    content: driver.text,
    finish_reason: driver.terminalFinishReason,
    // Only the terminal turn. The daemon's stream accumulator sees every turn's
    // blocks in one flat stream and cannot tell where one ended, so it would
    // otherwise persist a final message replaying the whole loop.
    content_blocks: driver.terminalBlocks,
    usage: driver.usage,
    timing: timing(),
  };
}
