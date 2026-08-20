import type { ContentBlock } from "../../engine/types.ts";
import {
  runToolLoop,
  type ToolLoopDriver,
  type ToolUseEvent,
} from "../../engine/tool_loop.ts";
import type { ToolPhase } from "../../tools/execute.ts";
import { describeError } from "../errors.ts";
import { isAbortError } from "../abort.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  Timing,
  Usage,
} from "../types.ts";
import { marksFirstToken } from "./anthropic.ts";
import { pushAssistantBlocks } from "../request.ts";

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

class EventChannel {
  private pending: { event: StreamEvent; taken: () => void } | undefined;
  private waiting: (() => void) | undefined;
  private closed = false;

  send(event: StreamEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pending = { event, taken: resolve };
      this.wake();
    });
  }

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
        pending.taken();
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

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

class ProviderLoopDriver implements ToolLoopDriver<ProviderTurn> {
  usage: Usage = emptyUsage();
  text = "";
  terminalBlocks: ContentBlock[] = [];
  terminalFinishReason = "end_turn";
  completedCalls = 0;
  firstTokenAt = 0;

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
      if (event.type === "start" || event.type === "done") continue;
      if (event.type === "error") {
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

    await this.channel.send({
      type: "call_complete",
      usage: builder.usage,
      timing: {
        total_ms: callEnd - this.callStartedAt,
        time_to_first_token_ms:
          callFirstTokenAt === 0 ? callEnd - this.callStartedAt : callFirstTokenAt - this.callStartedAt,
      },
      finish_reason: builder.finishReason,
      continuation: this.completedCalls > 0,
    });
    this.completedCalls += 1;
    this.callStartedAt = callEnd;

    return { blocks, finishReason: builder.finishReason };
  }

  async dispatch(turn: ProviderTurn, uses: ToolUseEvent[]): Promise<void> {
    pushAssistantBlocks(this.req, turn.blocks);

    this.recordPriorResults();
    this.tools.recordTurn("assistant", turn.blocks);

    this.pendingResults = await Promise.all(uses.map((use) => this.tools.runTool(use)));
  }

  appendToolResults(): void {
    this.req.messages.push({ role: "user", content: this.pendingResults });
  }

  private recordPriorResults(): void {
    if (this.pendingResults.length === 0) return;
    const blocks = this.pendingResults;
    this.pendingResults = [];
    this.tools.recordTurn("user", blocks);
  }

  recordFinalResults(): void {
    this.recordPriorResults();
  }
}

export async function* genericToolLoopEvents(
  provider: SidecarProvider,
  req: SidecarRequest,
  tools: ToolPhase,
  signal?: AbortSignal,
  now: () => number = Date.now,
): AsyncIterable<StreamEvent> {
  const startedAt = now();

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
      message: describeError(failure),
      usage: driver.usage,
      timing: timing(),
      ...(isAbortError(failure) || signal?.aborted === true ? { aborted: true } : {}),
    };
    return;
  }

  yield {
    type: "done",
    content: driver.text,
    finish_reason: driver.terminalFinishReason,
    content_blocks: driver.terminalBlocks,
    usage: driver.usage,
    timing: timing(),
  };
}
