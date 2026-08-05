/**
 * The tool loop for every dialect that is not Anthropic.
 *
 * Driven against a fake `SidecarProvider` rather than a fake HTTP server,
 * because that interface is exactly what the loop consumes — the adapters
 * below it already have their own suites, and going through one of them would
 * test its wire parsing again rather than the loop.
 *
 * The bar is `anthropic_loop.test.ts`: the caller parses one stream shape and
 * must not be able to tell which loop produced it. Several cases here are
 * deliberate mirrors of one there.
 *
 * Tools are a {@link ToolPhase} rather than a Unix socket. That is the whole of
 * what the rewiring changed here — the loop's decisions are identical, and the
 * cases that used to assert them through a fake daemon assert them through a
 * fake phase.
 */

import { describe, expect, test } from "bun:test";

import { genericToolLoopEvents } from "../src/llm/providers/generic_loop.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type {
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  GenerateResponse,
} from "../src/llm/types.ts";

/** Reasoning a turn thought before it said or did anything. */
interface Reasoning {
  thinking?: string;
  signature?: string;
  reasoning?: string;
}

/** One turn the fake provider should produce. */
type Turn =
  | ({
      kind: "tools";
      calls: Array<{ id: string; name: string; input: unknown }>;
      text?: string;
    } & Reasoning)
  | ({ kind: "text"; text: string } & Reasoning)
  | { kind: "error"; message: string };

const USAGE = {
  input_tokens: 10,
  output_tokens: 7,
  cache_read_tokens: 4,
  cache_creation_tokens: 0,
};

/** Answers each `stream()` with the next scripted turn. */
class FakeProvider implements SidecarProvider {
  requests: SidecarRequest[] = [];
  private next = 0;

  constructor(private readonly turns: Turn[]) {}

  async *stream(req: SidecarRequest): AsyncIterable<StreamEvent> {
    // Snapshot: the loop mutates `req.messages` in place between calls, so
    // holding the reference would show every request the final conversation.
    this.requests.push(structuredClone(req));
    const turn = this.turns[this.next++] ?? { kind: "text" as const, text: "(exhausted)" };

    yield { type: "start", model: req.model };

    if (turn.kind === "error") {
      yield {
        type: "error",
        message: turn.message,
        usage: USAGE,
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
      return;
    }

    if (turn.thinking !== undefined) yield { type: "thinking", text: turn.thinking };
    if (turn.signature !== undefined) {
      yield { type: "thinking_signature", signature: turn.signature };
    }
    if (turn.reasoning !== undefined) {
      yield { type: "reasoning_content", reasoning: turn.reasoning };
    }

    const text = turn.text;
    if (text !== undefined && text.length > 0) yield { type: "text", text };

    if (turn.kind === "tools") {
      for (const call of turn.calls) {
        yield { type: "tool_use", id: call.id, name: call.name, input: call.input };
      }
    }

    yield {
      type: "done",
      content: text ?? "",
      finish_reason: turn.kind === "tools" ? "tool_use" : "end_turn",
      usage: USAGE,
      timing: { total_ms: 5, time_to_first_token_ms: 2 },
    };
  }

  generate(): Promise<GenerateResponse> {
    throw new Error("the loop never calls generate");
  }
}

/**
 * A tool phase that answers every call, optionally slowly.
 *
 * `delays` keyed by tool name lets a round's results land out of the order the
 * model asked for them, which is the only way to prove the loop reorders.
 *
 * `order` interleaves recorded turns and dispatched tools, because the
 * relationship between the two is a real invariant: the generated-image side
 * channel hangs its ref off the assistant turn that asked for the tool, so a
 * turn recorded after its tools dispatched would have nothing to attach to.
 */
function fakePhase(
  opts: {
    output?: (name: string) => string;
    failing?: readonly string[];
    delays?: Record<string, number>;
  } = {},
) {
  const messages: Message[] = [];
  const order: string[] = [];
  const completionOrder: string[] = [];
  const runs: ToolUseEvent[] = [];
  let minted = 0;

  const phase: ToolPhase = {
    messages,
    recordTurn: (role: Role, blocks: ContentBlock[]) => {
      order.push(`record:${role}`);
      minted += 1;
      messages.push({
        msg_id: `m_${minted}`,
        role,
        content: "",
        images: [],
        content_blocks: blocks,
        timestamp: "2026-01-01T00:00:00-05:00",
      });
    },
    runTool: async (use: ToolUseEvent): Promise<ContentBlock> => {
      order.push(`run:${use.name}`);
      runs.push(use);
      const delay = opts.delays?.[use.name] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      completionOrder.push(use.name);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: opts.output?.(use.name) ?? `ran ${use.name}`,
        is_error: opts.failing?.includes(use.name) ?? false,
      };
    },
  };

  return { phase, messages, order, runs, completionOrder };
}

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "deepseek",
    model: "deepseek-chat",
    provider_key: "deepseek",
    api_key: "k",
    messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    system: [{ text: "you are a character", label: "character" }],
    tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    ...overrides,
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const typesOf = (events: StreamEvent[]) => events.map((e) => e.type);

describe("driving a tool loop for a non-Anthropic dialect", () => {
  test("runs the tool, continues, and reports one flat stream", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: { path: "/tmp/x" } }] },
      { kind: "text", text: "the file says hello" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(), tools.phase));

    // One start, one done, no matter how many calls happened.
    expect(typesOf(events).filter((t) => t === "start")).toEqual(["start"]);
    expect(typesOf(events).filter((t) => t === "done")).toEqual(["done"]);
    expect(provider.requests.length).toBe(2);

    expect(tools.runs.length).toBe(1);
    expect(tools.runs[0]?.name).toBe("read");

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("unreachable");
    expect(done.content).toBe("the file says hello");
    expect(done.finish_reason).toBe("end_turn");
    // Summed across both calls.
    expect(done.usage.input_tokens).toBe(USAGE.input_tokens * 2);
    expect(done.usage.output_tokens).toBe(USAGE.output_tokens * 2);
  });

  test("every call gets its own row, and only the first is not a continuation", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "tools", calls: [{ id: "tu_2", name: "read", input: {} }] },
      { kind: "text", text: "done" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(), tools.phase));
    const completes = events.filter((e) => e.type === "call_complete");

    expect(completes.length).toBe(3);
    expect(completes.map((e) => (e.type === "call_complete" ? e.continuation : null))).toEqual([
      false,
      true,
      true,
    ]);
    // Each row carries one call's usage, not the running sum — a summed row is
    // the shape that misreports the cache.
    for (const c of completes) {
      if (c.type !== "call_complete") throw new Error("unreachable");
      expect(c.usage.input_tokens).toBe(USAGE.input_tokens);
    }
  });

  test("done carries only the terminal turn's blocks", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }], text: "let me look" },
      { kind: "text", text: "the answer" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(), tools.phase));
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done");

    // Not the whole loop replayed: the first turn's text and tool_use are absent.
    expect(done.content_blocks).toEqual([{ type: "text", text: "the answer" }]);
  });

  test("the conversation grows by exactly one assistant turn and one result turn per round", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "done" },
    ]);
    const req = request();

    await collect(genericToolLoopEvents(provider, req, tools.phase));

    // The second request the provider saw: original user turn, the assistant
    // turn that asked, then the results.
    const second = provider.requests[1];
    expect(second?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second?.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "ran read", is_error: false },
    ]);
    // And the caller's own request object ends up holding the same thing —
    // this is what keeps `last_request` equal to what actually went out.
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("the assistant turn is recorded before the tools it asked for run", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "done" },
    ]);

    await collect(genericToolLoopEvents(provider, request(), tools.phase));

    // Ordering, not just presence: `executeToolUse` hangs a generated image off
    // the assistant turn that requested the tool, so a turn recorded after the
    // dispatch would have nothing to attach to.
    expect(tools.order).toEqual(["record:assistant", "run:read", "record:user"]);
    expect(tools.messages[0]?.role).toBe("assistant");
  });

  test("a round's results are stored in ask order, not completion order", async () => {
    // `read` finishes last despite being asked for first.
    const tools = fakePhase({ delays: { read: 40 } });
    const provider = new FakeProvider([
      {
        kind: "tools",
        calls: [
          { id: "tu_1", name: "read", input: {} },
          { id: "tu_2", name: "grep", input: {} },
        ],
      },
      { kind: "text", text: "done" },
    ]);
    const req = request();

    await collect(genericToolLoopEvents(provider, req, tools.phase));

    // The race actually happened, otherwise this proves nothing.
    expect(tools.completionOrder).toEqual(["grep", "read"]);

    const results = req.messages[2]?.content;
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "ran read", is_error: false },
      { type: "tool_result", tool_use_id: "tu_2", content: "ran grep", is_error: false },
    ]);
  });

  test("a tool that failed is told to the model and the loop continues", async () => {
    const tools = fakePhase({ failing: ["read"] });
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "that file is missing, then" },
    ]);
    const req = request();

    const events = await collect(genericToolLoopEvents(provider, req, tools.phase));

    // There is no second failure channel any more. Over the socket, a call the
    // daemon could not attempt ended the turn without telling the model — a
    // distinction that only existed because there was a transport that could
    // fail separately from the tool. In one process every tool answers, and a
    // failure answers with `is_error`.
    expect(req.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "ran read", is_error: true },
    ]);
    expect(provider.requests.length).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a provider error mid-loop surfaces with the usage already billed", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "error", message: "upstream exploded" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(), tools.phase));
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error");
    expect(last.message).toBe("upstream exploded");
    // The first call's usage plus the partial the failing call reported.
    expect(last.usage.input_tokens).toBe(USAGE.input_tokens * 2);
  });

  test("the iteration cap spends a closing call so the model answers with its results", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "tools", calls: [{ id: "tu_2", name: "read", input: {} }] },
      { kind: "tools", calls: [{ id: "tu_3", name: "read", input: {} }] },
    ]);

    await collect(
      genericToolLoopEvents(provider, request({ max_tool_iterations: 1 }), tools.phase),
    );

    // One dispatch round, then a closing call. `stopWhen: stepCountIs(1)` would
    // have made one call and handed the user a tool request as their reply.
    expect(tools.runs.length).toBe(1);
    expect(provider.requests.length).toBe(2);
  });

  test("a cap of zero dispatches nothing", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "unreached" },
    ]);

    await collect(
      genericToolLoopEvents(provider, request({ max_tool_iterations: 0 }), tools.phase),
    );

    expect(tools.runs.length).toBe(0);
    expect(provider.requests.length).toBe(1);
  });

  test("prior-turn reasoning is replayed to the next call in the loop", async () => {
    const tools = fakePhase();
    const provider = new FakeProvider([
      {
        kind: "tools",
        calls: [{ id: "tu_1", name: "read", input: {} }],
        thinking: "let me check",
        signature: "sig_1",
        reasoning: "raw chain",
      },
      { kind: "text", text: "done" },
    ]);

    await collect(genericToolLoopEvents(provider, request(), tools.phase));

    // DeepSeek and Kimi hard-require prior-turn reasoning across a tool loop,
    // and the carriers are what the adapters replay from. Dropping any of them
    // when rebuilding the turn is silent — the model just gets worse.
    const appended = provider.requests[1]?.messages[1];
    expect(appended?.role).toBe("assistant");
    expect(appended?.content[0]).toEqual({
      type: "thinking",
      thinking: "let me check",
      signature: "sig_1",
      reasoning_content: "raw chain",
    });
    // Canonical order: thinking, then the tools it asked for.
    expect(appended?.content[1]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "read",
      input: {},
    });
  });
});
