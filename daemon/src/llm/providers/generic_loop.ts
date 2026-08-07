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
 * # What the caller sees
 *
 * One flat `start` … `done`, regardless of how many model calls happened, with
 * usage summed across all of them and `content_blocks` carrying only the
 * terminal turn. Each individual call is announced as it lands via
 * `call_complete`, so its ledger row exists whether or not the loop ever
 * reaches `done`. This matches `anthropic_loop.ts` exactly.
 *
 * # Tools are function calls
 *
 * They used to be one Unix-socket round trip each, because the executors lived
 * in the daemon and the loop lived here. Both are this process now, so the loop
 * is handed a {@link ToolPhase} and calls it — and the failure taxonomy
 * collapses with the transport. There is no longer a "the daemon could not
 * attempt this" that has to end the turn without telling the model, because
 * there is no attempt that can fail to arrive.
 */

import type { ContentBlock } from "../../engine/types.ts";
import {
  runToolLoop,
  type ToolLoopDriver,
  type ToolUseEvent,
} from "../../engine/tool_loop.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  Timing,
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
 * fixture and takes a driver, not a generator — but the caller has to see
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

  /** This round's results, in the order the model asked for them. */
  private pendingResults: ContentBlock[] = [];
  private callStartedAt: number;

  constructor(
    private readonly provider: SidecarProvider,
    private readonly req: SidecarRequest,
    private readonly tools: ToolPhase,
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
    // `ToolLoopDriver` contract. The next call has to see it, and the caller
    // has to persist it.
    this.req.messages.push({ role: "assistant", content: turn.blocks });

    // Recorded BEFORE the tools run, and in conversation order: the
    // generated-image side channel hangs its `ImageRef` off the assistant turn
    // that asked for the tool, so that turn has to be in the list by the time
    // the tool dispatches. The previous round's results go first because they
    // came first, not because anything downstream sorts them.
    this.recordPriorResults();
    this.tools.recordTurn("assistant", turn.blocks);

    // Concurrent, but collected in ask-order: `Promise.all` preserves input
    // order, so completion order never decides what gets stored. The Anthropic
    // path needs a record-as-they-land callback for this because the SDK owns
    // the scheduling; here the loop does, so it falls out.
    this.pendingResults = await Promise.all(uses.map((use) => this.tools.runTool(use)));
  }

  appendToolResults(): void {
    this.req.messages.push({ role: "user", content: this.pendingResults });
  }

  /** Record the finished round's results as one turn. Drains, so once. */
  private recordPriorResults(): void {
    if (this.pendingResults.length === 0) return;
    const blocks = this.pendingResults;
    this.pendingResults = [];
    this.tools.recordTurn("user", blocks);
  }

  /** The last round's results: after a terminal turn, and after a cap whose
   *  final round ran its tools with no turn following. */
  recordFinalResults(): void {
    this.recordPriorResults();
  }
}

/**
 * Run the whole loop, emitting one flat stream of events.
 *
 * Mirrors `anthropicToolLoopEvents` frame for frame — the caller parses one
 * stream shape and does not know which produced it.
 */
export async function* genericToolLoopEvents(
  provider: SidecarProvider,
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();

  // One controller drives the model calls. The caller's signal feeds into it,
  // so a client that hangs up stops the whole loop rather than only its next
  // call. Tools are not on it: a running tool is bounded by its own
  // `[tools] timeout`, which `dispatchWithinDeadline` owns.
  const abort = new AbortController();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  const channel = new EventChannel();
  const driver = new ProviderLoopDriver(provider, req, tools, channel, abort, now, startedAt);

  let failure: unknown;
  const running = (async () => {
    try {
      await runToolLoop(driver, undefined, req.max_tool_iterations, "close_with_final_turn");
      driver.recordFinalResults();
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

  if (failure !== undefined) {
    yield {
      type: "error",
      message: String(failure instanceof Error ? failure.message : failure),
      usage: driver.usage,
      timing: timing(),
    };
    return;
  }

  yield {
    type: "done",
    content: driver.text,
    finish_reason: driver.terminalFinishReason,
    // Only the terminal turn. A stream accumulator sees every turn's blocks in
    // one flat stream and cannot tell where one ended, so it would otherwise
    // persist a final message replaying the whole loop.
    content_blocks: driver.terminalBlocks,
    usage: driver.usage,
    timing: timing(),
  };
}
