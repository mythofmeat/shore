/**
 * The sidecar-driven Anthropic tool loop.
 *
 * Two things are under test, and the second matters more than it looks.
 *
 * 1. Breakpoints move as the conversation grows. The schedule anchors partly on
 *    the last message, so a loop that leaves them where the first request put
 *    them re-sends its whole accumulated tail uncached on every continuation.
 *
 * 2. The two runner behaviours this driver depends on, which are consequences
 *    of a *private* flag inside `BetaToolRunner` and appear nowhere in its
 *    types: once `setMessagesParams` is called, the runner stops appending the
 *    assistant turn, and stops halting when the model asks for no tools. If an
 *    SDK upgrade changes either, the failure is silent — dropped turns, or a
 *    wasted full-price request per turn — so both are asserted against a real
 *    runner rather than trusted.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  placeContinuationBreakpoints,
  buildAnthropicParams,
} from "../src/llm/providers/anthropic.ts";
import { anthropicToolLoopEvents } from "../src/llm/providers/anthropic_loop.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type { SidecarRequest, StreamEvent, SystemContent } from "../src/llm/types.ts";

// ── breakpoint re-placement ────────────────────────────────────────────────

type Msg = { role: "user" | "assistant"; content: Array<Record<string, unknown>> };

const text = (t: string) => ({ type: "text", text: t });
const user = (t: string): Msg => ({ role: "user", content: [text(t)] });
const assistant = (t: string): Msg => ({ role: "assistant", content: [text(t)] });

const LABELLED: SystemContent = [
  { text: "you are a character", label: "character" },
  { text: "recent memories", label: "memory_index" },
];

/** Indices of messages carrying a breakpoint, and which system blocks do. */
function marked(messages: Msg[], system: Array<Record<string, unknown>>) {
  const msgs = messages.flatMap((m, i) =>
    m.content.some((b) => b["cache_control"] !== undefined) ? [i] : [],
  );
  const sys = system.flatMap((b, i) => (b["cache_control"] !== undefined ? [i] : []));
  return { msgs, sys };
}

describe("breakpoints follow a growing conversation", () => {
  test("caching off leaves the request untouched", () => {
    const messages = [user("hi"), assistant("hello")];
    const system = [{ type: "text", text: "sys" }];
    placeContinuationBreakpoints(messages as never, system as never, LABELLED, "");
    expect(marked(messages, system)).toEqual({ msgs: [], sys: [] });
  });

  test("the system anchor skips the block that churns every dream", () => {
    // memory_index is rewritten by every dreaming and compaction pass, so
    // anchoring on it would throw the system prefix away each time.
    const messages = [user("hi")];
    const system = [{ type: "text", text: "character" }, { type: "text", text: "memories" }];
    placeContinuationBreakpoints(messages as never, system as never, LABELLED, "5m");
    expect(marked(messages, system).sys).toEqual([0]);
  });

  test("re-placing strips the previous markers rather than accumulating", () => {
    // Four is the per-request maximum and the schedule places up to four, so a
    // re-place that did not strip would overflow within two turns.
    const messages = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
    const system = [{ type: "text", text: "character" }, { type: "text", text: "memories" }];

    placeContinuationBreakpoints(messages as never, system as never, LABELLED, "5m");
    const first = marked(messages, system);

    messages.push(user("q3"), assistant("a3"));
    placeContinuationBreakpoints(messages as never, system as never, LABELLED, "5m");
    const second = marked(messages, system);

    const total = second.msgs.length + second.sys.length;
    expect(total).toBeLessThanOrEqual(4);
    // And it actually moved — the last message is always an anchor.
    expect(second.msgs).toContain(messages.length - 1);
    expect(second.msgs).not.toEqual(first.msgs);
  });

  test("the last message is always an anchor as the loop appends", () => {
    const messages = [user("q1")];
    const system = [{ type: "text", text: "character" }];
    for (const turn of ["a1", "a2", "a3"]) {
      messages.push(assistant(turn));
      placeContinuationBreakpoints(messages as never, system as never, LABELLED, "5m");
      expect(marked(messages, system).msgs).toContain(messages.length - 1);
    }
  });

  test("a 1h ttl reaches the blocks it marks", () => {
    const messages = [user("hi")];
    const system: Array<Record<string, unknown>> = [{ type: "text", text: "character" }];
    placeContinuationBreakpoints(messages as never, system as never, LABELLED, "1h");
    expect(system[0]?.["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

// ── the loop itself, against a fake Anthropic ──────────────────────────────

/** One turn the fake server should produce. */
type Turn =
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "text"; text: string };

interface FakeAnthropic {
  url: string;
  /** Parsed request bodies, in order. */
  requests: Array<Record<string, unknown>>;
  stop(): void;
}

/** Server-sent events for one turn, in the shape the SDK's parser expects. */
function sseForTurn(turn: Turn): string {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const stopReason = turn.kind === "tool" ? "tool_use" : "end_turn";
  let out = frame("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4 },
    },
  });

  if (turn.kind === "text") {
    out += frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    out += frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: turn.text },
    });
    out += frame("content_block_stop", { type: "content_block_stop", index: 0 });
  } else {
    out += frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: turn.id, name: turn.name, input: {} },
    });
    out += frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
    });
    out += frame("content_block_stop", { type: "content_block_stop", index: 0 });
  }

  out += frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  out += frame("message_stop", { type: "message_stop" });
  return out;
}

/** Answers each request with the next scripted turn. */
function fakeAnthropic(turns: Turn[]): FakeAnthropic {
  const requests: Array<Record<string, unknown>> = [];
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      const turn = turns[next++] ?? { kind: "text" as const, text: "(exhausted)" };
      return new Response(sseForTurn(turn), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

/**
 * A tool phase that answers every call with the same output.
 *
 * `order` interleaves recorded turns and dispatched tools: the assistant turn
 * has to be in the list before the tools it asked for run, because the
 * generated-image side channel hangs its ref off that turn.
 */
function fakePhase(output: string, failing: readonly string[] = []) {
  const messages: Message[] = [];
  const order: string[] = [];
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
    runTool: (use: ToolUseEvent): Promise<ContentBlock> => {
      order.push(`run:${use.name}`);
      runs.push(use);
      return Promise.resolve({
        type: "tool_result",
        tool_use_id: use.id,
        content: output,
        is_error: failing.includes(use.name),
      });
    },
  };

  return { phase, messages, order, runs };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function request(anthropic: FakeAnthropic): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-opus-4-8",
    provider_key: "anthropic",
    api_key: "k",
    base_url: anthropic.url,
    messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    system: [{ text: "you are a character", label: "character" }],
    tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    max_tokens: 1024,
    replay_prior_thinking: "all",
    provider_options: { cache_ttl: "5m" },
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("driving a tool loop", () => {
  test("runs the tool, continues, and reports one flat stream", async () => {
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: { path: "/tmp/x" } },
      { kind: "text", text: "the file says hello" },
    ]);
    const tools = fakePhase("hello");
    stops.push(anthropic.stop);

    const events = await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));
    const types = events.map((e) => e.type);

    // One start, one done, whatever the loop did in between.
    expect(types.filter((t) => t === "start")).toHaveLength(1);
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    expect(types).toContain("tool_use");

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("unreachable");
    expect(done.content).toBe("the file says hello");
    expect(done.finish_reason).toBe("end_turn");
    // Usage is the sum across both calls, not just the last.
    expect(done.usage.output_tokens).toBe(14);
    expect(done.usage.cache_read_tokens).toBe(8);

    // …and each call announced itself as it landed, because the ledger row is
    // written there and then. A single summed row reports a `cache_read` no
    // call made, which poisons the cache tracker's baseline — and recording
    // only at the end would lose the completed calls of a loop that failed or
    // was abandoned partway.
    const completed = events.filter((e) => e.type === "call_complete");
    expect(completed.map((c) => c.continuation)).toEqual([false, true]);
    expect(completed.reduce((n, c) => n + c.usage.output_tokens, 0)).toBe(
      done.usage.output_tokens,
    );
    expect(completed.reduce((n, c) => n + c.usage.cache_read_tokens, 0)).toBe(
      done.usage.cache_read_tokens,
    );
    // Each one precedes the `done` it contributes to — that ordering is what
    // makes a mid-loop failure keep the rows that were already billed.
    expect(types.lastIndexOf("call_complete")).toBeLessThan(types.indexOf("done"));

    // The tool actually ran — and the assistant turn that asked for it was
    // recorded first, so the generated-image side channel has somewhere to
    // attach. The round's results follow once it completes, as one turn rather
    // than one per tool.
    expect(tools.order).toEqual(["record:assistant", "run:read", "record:user"]);
    expect(tools.runs[0]).toMatchObject({ id: "tu_1", name: "read" });
  });

  test("the recorded turns carry the blocks they produced", async () => {
    // The loop is the only thing that knows what the conversation became: it
    // reaches its caller as one flat stream carrying no per-turn structure, so
    // the grouping has to be written down as it happens.
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));

    // The assistant turn that asked for the tool, then the round's results.
    expect(tools.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(tools.messages[0]!.content_blocks.map((b) => b.type)).toEqual(["tool_use"]);
    expect(tools.messages[1]!.content_blocks.map((b) => b.type)).toEqual(["tool_result"]);
  });

  test("breakpoints never reach the turns handed to persistence", async () => {
    // Regression, production 2026-08-07. `placeContinuationBreakpoints` mutates
    // blocks in place, and the loop was handing `message.content` to *both* the
    // params array and `recordTurn` — the same objects. A breakpoint landed on
    // a `tool_use` block that then went to disk in `active.jsonl`. Every later
    // request read that marker back, and the adapter's `has_existing_markers`
    // gate answered by placing nothing at all, so prompt caching stayed off for
    // the whole conversation until the file was edited by hand. Both halves are
    // fixed; this pins the half that stops the corruption being written.
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));

    // Nothing that went to persistence carries a wire-only field.
    for (const m of tools.messages) {
      for (const block of m.content_blocks as Array<Record<string, unknown>>) {
        expect(block["cache_control"]).toBeUndefined();
      }
    }

    // …and the continuation request still got its breakpoints, so this is the
    // marker not leaking rather than the loop quietly ceasing to cache.
    const second = anthropic.requests[1] as { messages: Msg[] };
    expect(
      second.messages.some((m) => m.content.some((b) => b["cache_control"] !== undefined)),
    ).toBe(true);
  });

  test("the assistant turn is appended exactly once", async () => {
    // Runner contract 1: with messages taken over it stops appending the
    // assistant turn itself. Getting this wrong drops every model reply, or
    // duplicates it — both silent.
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));

    const second = anthropic.requests[1] as { messages: Array<{ role: string }> };
    const roles = second.messages.map((m) => m.role);
    // user → assistant(tool_use) → user(tool_result), each exactly once.
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  test("a terminal turn ends the loop without spending another request", async () => {
    // Runner contract 2: with messages taken over it does not stop when the
    // model asks for no tools — it issues one more full-price call first.
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));
    expect(anthropic.requests).toHaveLength(2);
  });

  test("the continuation's breakpoints moved to the grown conversation", async () => {
    // The whole reason this driver re-places rather than letting the initial
    // placement ride: otherwise the loop's accumulated tail is uncached on
    // every continuation.
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));

    const second = anthropic.requests[1] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const markedIdx = second.messages.flatMap((m, i) =>
      m.content.some((b) => b["cache_control"] !== undefined) ? [i] : [],
    );
    expect(markedIdx.length).toBeGreaterThan(0);
    // Anchored at or past the assistant turn the first request never had.
    expect(Math.max(...markedIdx)).toBeGreaterThanOrEqual(1);
  });

  test("a tool that failed is told to the model and the loop continues", async () => {
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "that file is missing, then" },
    ]);
    const tools = fakePhase("no such file", ["read"]);
    stops.push(anthropic.stop);

    const events = await collect(anthropicToolLoopEvents(request(anthropic), tools.phase));

    // There is no second failure channel any more. Over the socket, a call the
    // daemon could not attempt ended the turn without telling the model — a
    // distinction that only existed because the transport could fail
    // separately from the tool. In one process every tool answers, and the
    // runner is handed a `ToolError` so the model reads the tool's own text
    // rather than an "Error: " prefix.
    expect(tools.messages[1]!.content_blocks[0]).toMatchObject({
      type: "tool_result",
      content: "no such file",
      is_error: true,
    });
    expect(anthropic.requests).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("an aborted transport stops the loop", async () => {
    // The caller's signal feeds the controller that owns the model calls and
    // the runner — so a client that hangs up stops the whole loop, not just its
    // next call.
    const anthropic = fakeAnthropic([
      { kind: "tool", id: "tu_1", name: "read", input: {} },
      { kind: "text", text: "done" },
    ]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    const events = await collect(
      anthropicToolLoopEvents(request(anthropic), tools.phase, AbortSignal.abort()),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect(anthropic.requests).toHaveLength(0);
  });

  test("the initial request is the same one the non-loop path would send", async () => {
    // The loop changes who drives, not what the first call looks like.
    const anthropic = fakeAnthropic([{ kind: "text", text: "hi" }]);
    const tools = fakePhase("ok");
    stops.push(anthropic.stop);

    const req = request(anthropic);
    await collect(anthropicToolLoopEvents(req, tools.phase));

    const sent = anthropic.requests[0] as Record<string, unknown>;
    const expected = buildAnthropicParams(req);
    expect(sent["messages"]).toEqual(expected.messages as never);
    expect(sent["system"]).toEqual(expected.system as never);
  });
});
