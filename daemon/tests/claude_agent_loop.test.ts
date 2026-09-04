import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeAgentToolLoopEvents } from "../src/llm/providers/claude_agent.ts";
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
    expect(Object.values(book)[0]?.pendingAssistantUuids).toEqual([
      "msg_0_asst_1",
      "msg_1_asst_0",
    ]);
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
