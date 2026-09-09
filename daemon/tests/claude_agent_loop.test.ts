import { readFile } from "./support/stored_files.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAgentProvider, claudeAgentToolLoopEvents, planTurn } from "../src/llm/providers/claude_agent.ts";
import { fakeAgent, type FakeScript } from "../src/testing/fake_agent_query.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { SidecarRequest, StreamEvent, ToolDefinition } from "../src/llm/types.ts";
import type { SessionBook } from "../src/llm/providers/agent_sessions.ts";

const SCHEMA: Record<string, unknown> = { type: "object" };

function def(name: string): ToolDefinition {
  return { name, description: `the ${name} tool`, input_schema: SCHEMA };
}

interface Recorded {
  role: Role;
  blocks: ContentBlock[];
}

interface Phase extends ToolPhase {
  dispatched: ToolUseEvent[];
  recorded: Recorded[];
}

function phase(output: (use: ToolUseEvent) => string = () => "ok"): Phase {
  const dispatched: ToolUseEvent[] = [];
  const recorded: Recorded[] = [];
  const messages: Message[] = [];
  return {
    messages,
    dispatched,
    recorded,
    runTool: (use) => {
      dispatched.push(use);
      return Promise.resolve({
        type: "tool_result",
        tool_use_id: use.id,
        content: output(use),
      } satisfies ContentBlock);
    },
    recordTurn: (role, blocks) => {
      recorded.push({ role, blocks });
    },
  };
}

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "claude_agent",
    model: "claude-opus-5",
    api_key: "",
    messages: [{ role: "user", content: [{ type: "text", text: "read SOUL.md" }] }],
    max_tokens: 4096,
    replay_prior_thinking: "all",
    tools: [def("read"), def("ask_internet")],
    ...overrides,
  };
}

async function drive(
  script: FakeScript,
  tools: Phase,
  req: SidecarRequest = request(),
): Promise<{ events: StreamEvent[]; agent: ReturnType<typeof fakeAgent>; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-loop-"));
  const path = join(dir, "sessions.json");
  const agent = fakeAgent(script);
  const events: StreamEvent[] = [];
  const stream = claudeAgentToolLoopEvents(req, tools, undefined, {
    runQuery: agent.query,
    bookPath: () => path,
  });
  for await (const event of stream) events.push(event);
  return { events, agent, path };
}

function done(events: readonly StreamEvent[]): Extract<StreamEvent, { type: "done" }> {
  const found = events.find((e) => e.type === "done");
  if (found === undefined) throw new Error("no done event");
  return found;
}

const ONE_CALL: FakeScript = {
  rounds: [
    { blocks: [{ kind: "text", text: "let me look." }], toolCalls: [{ name: "read" }] },
    { blocks: [{ kind: "text", text: "it says Brian." }] },
  ],
};

describe("running shore's tools through the SDK", () => {
  test("a call reaches shore's dispatcher under the name it knows", async () => {
    const tools = phase();
    await drive(ONE_CALL, tools);
    expect(tools.dispatched.map((u) => u.name)).toEqual(["read"]);
  });

  test("the tool's own output is what goes back to the model", async () => {
    const tools = phase(() => "the freezer is named Brian");
    const { agent } = await drive(ONE_CALL, tools);
    expect(JSON.stringify(agent.toolOutcomes[0]?.output)).toContain("named Brian");
  });

  test("a subagent is dispatched like any other tool", async () => {
    const tools = phase();
    await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "ask_internet", input: { query: "hi" } }] },
          { blocks: [{ kind: "text", text: "done" }] },
        ],
      },
      tools,
    );
    expect(tools.dispatched.map((u) => u.name)).toEqual(["ask_internet"]);
    expect(tools.dispatched[0]?.input).toEqual({ query: "hi" });
  });

  test("the arguments the model wrote are the ones shore runs", async () => {
    const tools = phase();
    await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "read", input: { path: "SOUL.md" } }] },
          { blocks: [{ kind: "text", text: "done" }] },
        ],
      },
      tools,
    );
    expect(tools.dispatched[0]?.input).toEqual({ path: "SOUL.md" });
  });
});

describe("the shape of what gets written to the conversation", () => {
  test("a round is recorded as the assistant's call and then its result", async () => {
    const tools = phase();
    await drive(ONE_CALL, tools);
    expect(tools.recorded.map((r) => r.role)).toEqual(["assistant", "user"]);
  });

  test("the recorded result answers the call the assistant actually made", async () => {
    const tools = phase();
    await drive(ONE_CALL, tools);
    const call = tools.recorded[0]?.blocks.find((b) => b.type === "tool_use");
    const result = tools.recorded[1]?.blocks.find((b) => b.type === "tool_result");
    expect(call?.id).toBeDefined();
    expect(result?.tool_use_id).toBe(call?.id ?? "");
  });

  test("the call is written down under shore's own name, not the SDK's", async () => {
    const tools = phase();
    await drive(ONE_CALL, tools);
    const call = tools.recorded[0]?.blocks.find((b) => b.type === "tool_use");
    expect(call?.name).toBe("read");
  });

  test("the streamed call the client sees is named the same way", async () => {
    const tools = phase();
    const { events } = await drive(ONE_CALL, tools);
    const streamed = events.find((e) => e.type === "tool_use");
    expect(streamed?.name).toBe("read");
  });

  test("the assistant's prose from a tool round is kept with its call", async () => {
    const tools = phase();
    await drive(ONE_CALL, tools);
    const text = tools.recorded[0]?.blocks.find((b) => b.type === "text");
    expect(text?.text).toBe("let me look.");
  });

  test("the final reply is not recorded twice — it leaves in the finished turn", async () => {
    const tools = phase();
    const { events } = await drive(ONE_CALL, tools);
    expect(tools.recorded).toHaveLength(2);
    expect(done(events).content).toBe("it says Brian.");
  });

  test("prose from an earlier round does not leak into the final reply", async () => {
    const tools = phase();
    const { events } = await drive(ONE_CALL, tools);
    expect(done(events).content).not.toContain("let me look");
  });

  test("two rounds of tools are recorded as two pairs, in order", async () => {
    const tools = phase();
    await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "read" }] },
          { blocks: [], toolCalls: [{ name: "read" }] },
          { blocks: [{ kind: "text", text: "done" }] },
        ],
      },
      tools,
    );
    expect(tools.recorded.map((r) => r.role)).toEqual(["assistant", "user", "assistant", "user"]);
  });
});

describe("the tool budget", () => {
  test("a spent budget stops further calls but still lets the turn answer", async () => {
    const tools = phase();
    const { events, agent } = await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "read" }] },
          { blocks: [], toolCalls: [{ name: "read" }] },
          { blocks: [{ kind: "text", text: "what I have is enough" }] },
        ],
      },
      tools,
      request({ max_tool_iterations: 1 }),
    );
    expect(tools.dispatched).toHaveLength(1);
    expect(agent.toolOutcomes[1]?.allowed).toBe(false);
    expect(agent.toolOutcomes[1]?.denial).toContain("tool budget");
    expect(done(events).content).toBe("what I have is enough");
  });

  test("a tool shore never advertised is refused before it is dispatched", async () => {
    const tools = phase();
    const { agent } = await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "rm" }] },
          { blocks: [{ kind: "text", text: "not allowed" }] },
        ],
      },
      tools,
    );
    expect(tools.dispatched).toHaveLength(0);
    expect(agent.toolOutcomes[0]?.allowed).toBe(false);
  });
});

describe("what the SDK is handed", () => {
  test("shore's tools are the only server, and every call is asked about", async () => {
    const tools = phase();
    const { agent } = await drive(ONE_CALL, tools);
    const options = agent.calls[0]?.options;
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(["shore"]);
    expect(options?.allowedTools).toEqual([]);
    expect(options?.canUseTool).toBeDefined();
    expect(options?.tools).toEqual([]);
  });

  test("the cap is not left to the SDK's own turn limit", async () => {
    const tools = phase();
    const { agent } = await drive(ONE_CALL, tools, request({ max_tool_iterations: 3 }));
    expect(agent.calls[0]?.options.maxTurns).toBeGreaterThan(3);
  });

  test("a turn with no tools at all is left to the plain provider", async () => {
    const tools = phase();
    const { events, agent } = await drive(
      { rounds: [{ blocks: [{ kind: "text", text: "just talking" }] }] },
      tools,
      request({ tools: [] }),
    );
    expect(agent.calls[0]?.options.mcpServers).toBeUndefined();
    expect(agent.calls[0]?.options.maxTurns).toBe(1);
    expect(done(events).content).toBe("just talking");
  });
});

describe("what a tool-using turn leaves in the session book", () => {
  test("each round is anchored on its own frame, not all on the last", async () => {
    const tools = phase();
    const { path } = await drive(ONE_CALL, tools);
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    const record = Object.values(book)[0];
    expect(record?.entries).toHaveLength(3);
    expect(record?.entries[1]?.uuid).toBe("msg_0_asst_1");
    expect(record?.pendingAssistantUuids).toEqual(["msg_1_asst_0"]);
  });

  test("a turn with no tools still records the one round it had", async () => {
    const tools = phase();
    const { path } = await drive(
      { rounds: [{ blocks: [{ kind: "text", text: "just talking" }] }] },
      tools,
      request({ tools: [] }),
    );
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    expect(Object.values(book)[0]?.pendingAssistantUuids).toEqual(["msg_0_asst_0"]);
  });
});

describe("continuing after native tool rounds", () => {
  test("successive turns send only the new user message, including after restarting the provider", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "shore-agent-continuation-")), "sessions.json");
    const agent = fakeAgent({ rounds: [
      { blocks: [{ kind: "thinking", text: "inspect", signature: "signed" }], toolCalls: [{ name: "read" }, { name: "ask_internet" }] },
      { blocks: [], toolCalls: [{ name: "read", input: { path: "second" } }] },
      { blocks: [{ kind: "text", text: "done" }] },
    ] });
    const history = request().messages;
    for (let turn = 0; turn < 3; turn += 1) {
      const tools = phase(() => `result from turn ${String(turn)}`);
      const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
      const events: StreamEvent[] = [];
      for await (const event of provider.streamWithTools(request({ messages: [...history] }), tools)) events.push(event);
      expect(events.filter((event) => event.type === "error" || event.type === "provider_warning")).toEqual([]);
      expect(agent.calls[turn]?.prompt).toBe(turn === 0 ? "read SOUL.md" : `continue ${String(turn)}`);
      if (turn > 0) expect(agent.calls[turn]?.options.resume).toBe("session-fake");
      history.push(...tools.recorded.map(({ role, blocks }) => ({ role, content: blocks })));
      history.push({ role: "assistant", content: (done(events).content_blocks ?? []) as ContentBlock[] });
      history.push({ role: "user", content: [{ type: "text", text: `continue ${String(turn + 1)}` }] });
    }
  });

  test("regenerating a final answer anchors after its tools and replays only their result", async () => {
    const tools = phase();
    const req = request();
    const { path } = await drive(ONE_CALL, tools, req);
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    const plan = planTurn(Object.values(book)[0], [
      ...req.messages,
      ...tools.recorded.map(({ role, blocks }) => ({ role, content: blocks })),
    ]);
    expect(plan.resume).toBe("session-fake");
    expect(plan.resumeSessionAt).toBe("msg_0_asst_1");
    expect(plan.fork).toBe(true);
    expect(plan.delivered).toHaveLength(1);
    expect(plan.prompt).not.toContain("read SOUL.md");
    expect(plan.prompt).not.toContain("prior_tool_call");
  });

  test("changed tool output forks instead of being mistaken for an unchanged native result", async () => {
    const tools = phase();
    const req = request();
    const { path } = await drive(ONE_CALL, tools, req);
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    const history = [...req.messages, ...tools.recorded.map(({ role, blocks }) => ({ role, content: blocks }))];
    const result = history.at(-1)?.content[0];
    if (result?.type !== "tool_result") throw new Error("expected recorded result");
    result.content = "edited result";
    const plan = planTurn(Object.values(book)[0], history);
    expect(plan.fork).toBe(true);
    expect(plan.resumeSessionAt).toBe("msg_0_asst_1");
    expect(plan.prompt).toContain("edited result");
  });

  test.each(["error", "image"])("a native %s result is not replayed on continuation", async (kind) => {
    const tools = phase();
    tools.runTool = async (use) => ({
      type: "tool_result",
      tool_use_id: use.id,
      ...(kind === "error" ? { is_error: true } : {}),
      content: kind === "error" ? "read failed" : [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      ],
    });
    const req = request();
    const { path, events } = await drive(ONE_CALL, tools, req);
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    const plan = planTurn(Object.values(book)[0], [
      ...req.messages,
      ...tools.recorded.map(({ role, blocks }) => ({ role, content: blocks })),
      { role: "assistant", content: (done(events).content_blocks ?? []) as ContentBlock[] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
    expect(plan.resume).toBe("session-fake");
    expect(plan.fork).toBe(false);
    expect(plan.prompt).toBe("continue");
    expect(plan.images).toEqual([]);
  });

  test("overlapping plain and tool-using chats retain both sessions", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "shore-agent-overlap-")), "sessions.json");
    const agent = fakeAgent(ONE_CALL);
    const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
    const plain = provider.stream(request({ tools: [], context: { character: "plain", call_type: "message", thinking_enabled: false } }))[Symbol.asyncIterator]();
    const native = provider.streamWithTools(request({ context: { character: "native", call_type: "message", thinking_enabled: false } }), phase())[Symbol.asyncIterator]();
    for (const stream of [plain, native]) {
      const started = await stream.next();
      if (started.done) throw new Error("stream ended before start");
      expect(started.value.type).toBe("start");
    }
    for (const stream of [plain, native]) {
      for (;;) {
        const next = await stream.next();
        if (next.done) break;
        expect(next.value.type).not.toBe("error");
      }
    }
    const book = JSON.parse(await readFile(path, "utf8")) as SessionBook;
    expect(Object.keys(book)).toHaveLength(2);
  });
});

describe("what the finished turn says it was", () => {
  test("a tool round is not repeated in the final turn, which would duplicate the call", async () => {
    const tools = phase();
    const { events } = await drive({
      rounds: [
        { blocks: [], toolCalls: [{ name: "read", input: { path: "SOUL.md" } }] },
        { blocks: [{ kind: "text", text: "it says hello" }] },
      ],
    }, tools);
    const finished = events.find((e) => e.type === "done");
    const kinds = ((finished?.content_blocks ?? []) as ContentBlock[]).map((b) => b.type);
    expect(kinds).toEqual(["text"]);
    expect(tools.recorded.map((r) => r.role)).toEqual(["assistant", "user"]);
  });

  test("the round shore recorded is the one that holds the call", async () => {
    const tools = phase();
    await drive({
      rounds: [
        { blocks: [], toolCalls: [{ name: "read", input: { path: "SOUL.md" } }] },
        { blocks: [{ kind: "text", text: "it says hello" }] },
      ],
    }, tools);
    expect((tools.recorded[0]?.blocks ?? []).map((b) => b.type)).toEqual(["tool_use"]);
  });
});

describe("what the CLI is told about result size", () => {
  test("the CLI's own output ceiling is lifted, so shore's truncation is the only one", async () => {
    const tools = phase();
    const { agent } = await drive(
      { rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] },
      tools,
    );
    const env = (agent.calls[0]?.options.env ?? {}) as Record<string, string>;
    expect(Number(env.MAX_MCP_OUTPUT_TOKENS)).toBeGreaterThan(25_000);
  });
});

describe("what compaction is told the context weighs", () => {
  test("five tool rounds report one round's context, not five summed", async () => {
    const tools = phase();
    const { events } = await drive(
      {
        rounds: [
          {
            blocks: [{ kind: "text", text: "let me look." }],
            toolCalls: [{ name: "read" }],
            startUsage: { input_tokens: 3, cache_read_input_tokens: 53_915 },
          },
          {
            blocks: [],
            toolCalls: [{ name: "read" }],
            startUsage: { input_tokens: 3, cache_read_input_tokens: 55_800 },
          },
          {
            blocks: [],
            toolCalls: [{ name: "read" }],
            startUsage: { input_tokens: 3, cache_read_input_tokens: 57_200 },
          },
          {
            blocks: [],
            toolCalls: [{ name: "read" }],
            startUsage: { input_tokens: 3, cache_read_input_tokens: 58_900 },
          },
          {
            blocks: [{ kind: "text", text: "it says Brian." }],
            startUsage: { input_tokens: 3, cache_read_input_tokens: 60_400 },
          },
        ],
        resultUsage: {
          input_tokens: 15,
          output_tokens: 2_387,
          cache_read_input_tokens: 286_215,
          cache_creation_input_tokens: 8_790,
        },
      },
      tools,
    );
    const finished = done(events);
    expect(finished.usage.cache_read_tokens).toBe(286_215);
    expect(finished.context_usage?.cache_read_tokens).toBe(60_400);
  });
});

test("the SDK tool loop blocks collapsed history before querying or running tools", async () => {
  const tools = phase();
  const { events, agent } = await drive(ONE_CALL, tools, request({ messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "read SOUL.md" }] },
  ] }));
  const error = events.find((event) => event.type === "error");
  expect(error?.message).toContain("blocked replay of 3 conversation messages");
  expect(agent.calls).toEqual([]);
  expect(tools.dispatched).toEqual([]);
  expect(events.some((event) => event.type === "done")).toBe(false);
});

test("the replay guard checks the prompt after the initial hook changes it", async () => {
  const tools = phase();
  tools.beforeTurn = (req) => {
    if (req.messages.length === 1) {
      req.messages.push({ role: "user", content: [{ type: "text", text: "another message" }] });
    }
  };
  const { events, agent } = await drive(ONE_CALL, tools);
  const error = events.find((event) => event.type === "error");
  expect(error?.message).toContain("blocked replay of 2 conversation messages");
  expect(agent.calls).toEqual([]);
});


test("captured native tool streams finish when the consumer stops at done", async () => {
  const { withCallCapture } = await import("../src/llm/capture.ts");
  const { toolLoopEvents } = await import("../src/llm/tool_loop.ts");
  const { consumeStream } = await import("../src/llm/stream.ts");
  const agent = fakeAgent(ONE_CALL);
  const dir = await mkdtemp(join(tmpdir(), "shore-native-capture-"));
  const records: unknown[] = [];
  const provider = withCallCapture(new ClaudeAgentProvider({
    runQuery: agent.query, bookPath: () => join(dir, "sessions.json"),
  }), { recordCall: (record) => { records.push(record); return records.length; } });
  const tools = phase();
  const order: string[] = [];
  tools.onTurn = () => { order.push("checkpoint"); };
  const dispatch = tools.runTool;
  tools.runTool = (use) => { order.push("execute"); return dispatch(use); };
  tools.afterTurn = () => { order.push("complete"); };
  const result = await consumeStream(toolLoopEvents(provider, request(), tools), { regen: false, sink: () => {} });
  expect("ok" in result).toBe(true);
  expect(order).toEqual(["checkpoint", "execute", "complete", "checkpoint", "complete"]);
  expect(tools.dispatched).toHaveLength(1);
  expect(records).toHaveLength(1);
});

test("native round hooks pass appended wrap-up instructions into the SDK tool result", async () => {
  const tools = phase();
  let calls = 0;
  tools.beforeTurn = (req) => {
    calls += 1;
    if (calls === 2) req.messages.at(-1)?.content.push({ type: "text", text: "Finish the heartbeat now." });
  };
  const { agent } = await drive(ONE_CALL, tools);
  expect(JSON.stringify(agent.toolOutcomes[0]?.output)).toContain("Finish the heartbeat now.");
});

test("compaction cap stops native generation before a further model checkpoint", async () => {
  const tools = phase();
  const turns: string[] = [];
  tools.onTurn = (turn) => { turns.push(turn.finish_reason); };
  const agent = fakeAgent(ONE_CALL);
  const dir = await mkdtemp(join(tmpdir(), "shore-native-cap-"));
  const events: StreamEvent[] = [];
  for await (const event of claudeAgentToolLoopEvents(request({ max_tool_iterations: 1 }), tools, undefined,
    { runQuery: agent.query, bookPath: () => join(dir, "sessions.json") }, { capBehavior: "stop_after_dispatch" })) {
    events.push(event);
  }
  expect(turns).toEqual(["tool_use"]);
  expect(tools.dispatched).toHaveLength(1);
  expect(done(events).finish_reason).toBe("tool_use");
});

test.each([false, true])("native retry only repeats a run before effects (%s)", async (checkpointed) => {
  const { retryToolStream } = await import("../src/llm/tool_loop.ts");
  const { consumeStream } = await import("../src/llm/stream.ts");
  let attempts = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const timing = { total_ms: 0, time_to_first_token_ms: 0 };
  const outcome = await consumeStream(retryToolStream(async function* (tools) {
    attempts += 1;
    yield { type: "start", model: "test" };
    if (checkpointed) await tools.onTurn?.({ model: "test", content: "", content_blocks: [], finish_reason: "end_turn", usage, timing });
    if (attempts === 1) yield { type: "error", message: "temporarily unavailable", usage, timing };
    else yield { type: "done", content: "recovered", finish_reason: "end_turn", usage, timing };
  }, phase(), undefined, { settings: { maxRetries: 2, backoffBaseMs: 1 }, sleep: async () => {} }), { regen: false, sink: () => {} });
  expect(attempts).toBe(checkpointed ? 1 : 2);
  expect("ok" in outcome).toBe(!checkpointed);
});
