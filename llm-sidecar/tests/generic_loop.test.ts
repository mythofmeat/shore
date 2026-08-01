/**
 * The tool loop for every dialect that is not Anthropic.
 *
 * Driven against a fake `SidecarProvider` rather than a fake HTTP server,
 * because that interface is exactly what the loop consumes — the adapters
 * below it already have their own suites, and going through one of them would
 * test its wire parsing again rather than the loop.
 *
 * The bar is `anthropic_loop.test.ts`: the daemon parses one stream shape and
 * must not be able to tell which loop produced it. Several cases here are
 * deliberate mirrors of one there.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { genericToolLoopEvents } from "../src/llm/providers/generic_loop.ts";
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

interface DaemonCall {
  kind: string;
  name?: string;
  tool_id?: string;
  messages?: Array<{ role: string; content_blocks: unknown[] }>;
}

/**
 * A daemon that answers tool calls, optionally slowly.
 *
 * `delays` keyed by tool name lets a round's results land out of the order the
 * model asked for them, which is the only way to prove the loop reorders.
 */
function fakeToolDaemon(opts: {
  output?: (name: string) => string;
  delays?: Record<string, number>;
  unreachable?: boolean;
}) {
  const dir = `/tmp/shore-genloop-${Math.random().toString(36).slice(2)}`;
  Bun.spawnSync(["mkdir", "-p", dir]);
  const path = `${dir}/tools.sock`;
  const calls: DaemonCall[] = [];
  const completionOrder: string[] = [];

  const server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      // Buffered per connection, like the real daemon's `BufReader::lines`; a
      // loop opens one connection per call and they overlap.
      open(socket) {
        socket.data = { buf: "" };
      },
      data(socket, chunk) {
        socket.data.buf += new TextDecoder().decode(chunk);
        const nl = socket.data.buf.indexOf("\n");
        if (nl < 0) return;
        const line = socket.data.buf.slice(0, nl).trim();
        socket.data.buf = "";
        if (!line) return;
        const call = JSON.parse(line) as DaemonCall;
        calls.push(call);

        if (call.kind === "messages") {
          socket.write(`${JSON.stringify({ output: "", is_error: false })}\n`);
          socket.end();
          return;
        }
        if (opts.unreachable) {
          socket.write(`${JSON.stringify({ error: "no executor for this rid" })}\n`);
          socket.end();
          return;
        }

        const name = call.name ?? "";
        const reply = () => {
          completionOrder.push(name);
          socket.write(
            `${JSON.stringify({ output: opts.output?.(name) ?? `ran ${name}`, is_error: false })}\n`,
          );
          socket.end();
        };
        const delay = opts.delays?.[name] ?? 0;
        if (delay > 0) setTimeout(reply, delay);
        else reply();
      },
    },
  });

  return {
    path,
    calls,
    completionOrder,
    toolCalls: () => calls.filter((c) => c.kind === "tool"),
    reports: () => calls.filter((c) => c.kind === "messages"),
    stop: () => {
      server.stop(true);
      Bun.spawnSync(["rm", "-rf", dir]);
    },
  };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function request(socketPath: string, overrides: Partial<SidecarRequest> = {}): SidecarRequest {
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
    tool_rpc: { socket_path: socketPath, rid: "rid_1" },
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
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: { path: "/tmp/x" } }] },
      { kind: "text", text: "the file says hello" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(daemon.path)));

    // One start, one done, no matter how many calls happened.
    expect(typesOf(events).filter((t) => t === "start")).toEqual(["start"]);
    expect(typesOf(events).filter((t) => t === "done")).toEqual(["done"]);
    expect(provider.requests.length).toBe(2);

    expect(daemon.toolCalls().length).toBe(1);
    expect(daemon.toolCalls()[0]?.name).toBe("read");

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
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "tools", calls: [{ id: "tu_2", name: "read", input: {} }] },
      { kind: "text", text: "done" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(daemon.path)));
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
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }], text: "let me look" },
      { kind: "text", text: "the answer" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(daemon.path)));
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done");

    // Not the whole loop replayed: the first turn's text and tool_use are absent.
    expect(done.content_blocks).toEqual([{ type: "text", text: "the answer" }]);
  });

  test("the conversation grows by exactly one assistant turn and one result turn per round", async () => {
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "done" },
    ]);
    const req = request(daemon.path);

    await collect(genericToolLoopEvents(provider, req));

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

  test("the assistant turn reaches the daemon before the tools it asked for run", async () => {
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "done" },
    ]);

    await collect(genericToolLoopEvents(provider, request(daemon.path)));

    // Ordering, not just presence: the daemon attaches generated images to the
    // assistant turn that requested the tool, so a report arriving after the
    // dispatch would have nothing to attach to.
    const kinds = daemon.calls.map((c) => c.kind);
    expect(kinds.indexOf("messages")).toBeLessThan(kinds.indexOf("tool"));

    const firstReport = daemon.reports()[0];
    expect(firstReport?.messages?.[0]?.role).toBe("assistant");
  });

  test("a round's results are stored in ask order, not completion order", async () => {
    // `read` finishes last despite being asked for first.
    const daemon = fakeToolDaemon({ delays: { read: 40 } });
    stops.push(daemon.stop);
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
    const req = request(daemon.path);

    await collect(genericToolLoopEvents(provider, req));

    // The race actually happened, otherwise this proves nothing.
    expect(daemon.completionOrder).toEqual(["grep", "read"]);

    const results = req.messages[2]?.content;
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "ran read", is_error: false },
      { type: "tool_result", tool_use_id: "tu_2", content: "ran grep", is_error: false },
    ]);
  });

  test("a daemon that cannot run the tool ends the turn instead of telling the model", async () => {
    const daemon = fakeToolDaemon({ unreachable: true });
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "never reached" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(daemon.path)));

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("unreachable");
    expect(last.message).toContain("no executor");
    // The model was never asked to continue, and never saw a failed result.
    expect(provider.requests.length).toBe(1);
    // The call that did happen is still billed.
    expect(last.usage.input_tokens).toBe(USAGE.input_tokens);
  });

  test("a provider error mid-loop surfaces with the usage already billed", async () => {
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "error", message: "upstream exploded" },
    ]);

    const events = await collect(genericToolLoopEvents(provider, request(daemon.path)));
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error");
    expect(last.message).toBe("upstream exploded");
    // The first call's usage plus the partial the failing call reported.
    expect(last.usage.input_tokens).toBe(USAGE.input_tokens * 2);
  });

  test("the iteration cap spends a closing call so the model answers with its results", async () => {
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "tools", calls: [{ id: "tu_2", name: "read", input: {} }] },
      { kind: "tools", calls: [{ id: "tu_3", name: "read", input: {} }] },
    ]);

    await collect(
      genericToolLoopEvents(provider, request(daemon.path, { max_tool_iterations: 1 })),
    );

    // One dispatch round, then a closing call. `stopWhen: stepCountIs(1)` would
    // have made one call and handed the user a tool request as their reply.
    expect(daemon.toolCalls().length).toBe(1);
    expect(provider.requests.length).toBe(2);
  });

  test("a cap of zero dispatches nothing", async () => {
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
    const provider = new FakeProvider([
      { kind: "tools", calls: [{ id: "tu_1", name: "read", input: {} }] },
      { kind: "text", text: "unreached" },
    ]);

    await collect(
      genericToolLoopEvents(provider, request(daemon.path, { max_tool_iterations: 0 })),
    );

    expect(daemon.toolCalls().length).toBe(0);
    expect(provider.requests.length).toBe(1);
  });

  test("prior-turn reasoning is replayed to the next call in the loop", async () => {
    const daemon = fakeToolDaemon({});
    stops.push(daemon.stop);
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

    await collect(genericToolLoopEvents(provider, request(daemon.path)));

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
