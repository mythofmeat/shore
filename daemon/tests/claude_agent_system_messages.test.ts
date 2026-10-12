import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import { anchorKeys, insertSystemNotes, resultAnchor, type SystemNote } from "../src/llm/providers/claude_agent_injections.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import { startMockAnthropic, type MockAnthropic, type MockAnthropicOptions } from "../src/testing/mock_anthropic.ts";
import type { WireMessage } from "../src/llm/types.ts";

const STUB = "Continue according to the system instructions.";

type Sent = { role: string; content: { type: string; text?: string; content?: unknown }[]; output_config?: unknown };

function sentMessages(mock: MockAnthropic, index: number): Sent[] {
  return (mock.requests[index]?.body.messages ?? []) as Sent[];
}

function shape(messages: Sent[]): string[] {
  return messages.map(message => {
    const texts = message.content.flatMap(block => block.type === "text" ? [block.text ?? ""] : [`<${block.type}>`]);
    return `${message.role}: ${texts.join(" | ")}`;
  });
}

async function harness(script: NonNullable<MockAnthropicOptions["script"]>) {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-system-"));
  const workspace = join(dir, "heidi");
  await mkdir(workspace);
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: {
    emailAddress: "someone@example.com", accountUuid: "00000000-0000-4000-8000-000000000001",
    organizationUuid: "00000000-0000-4000-8000-000000000002",
  } }));
  const mock = await startMockAnthropic({ script });
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(dir, "sessions.json"),
    runQuery: params => query({ ...params, options: { ...params.options, env: {
      ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: dir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: dir, data: dir, cache: dir, runtime: dir },
    },
    providers: { claude_agent: provider }, retry: { maxRetries: 0, backoffBaseMs: 0 },
  };
  const turn = async (messages: WireMessage[], options: { model?: string; callType?: string; tools?: Partial<ToolPhase> } = {}) => {
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: options.model ?? "claude-opus-5-5",
      system: [{ label: "soul", text: "You are Heidi." }],
      tools: [{ name: "bash", description: "Run a shell command", input_schema: {
        type: "object", properties: { command: { type: "string" } }, required: ["command"],
      } }],
      context: { character: "heidi", workspace_dir: workspace, thinking_enabled: false, call_type: options.callType ?? "message" },
      provider_options: { reasoning_effort: "high" },
      max_tokens: 1024, replay_prior_thinking: "all", messages,
    }, { providerKey: "claude-code" }, deps, {
      signal: AbortSignal.timeout(30_000), sink: () => {},
      tools: { messages: [], recordTurn: () => {}, runTool: (use: { id: string }) =>
        Promise.resolve({ type: "tool_result" as const, tool_use_id: use.id, content: "plate.svg" }), ...options.tools },
    });
    return result;
  };
  return { mock, turn, cleanup: async () => { await mock.stop(); await rm(dir, { recursive: true, force: true }); } };
}

const user = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): WireMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const system = (text: string): WireMessage => ({ role: "system", content: [{ type: "text", text }] });

test("one-off guidance reaches the model as a system message after its user turn and stays there on later turns", async () => {
  const { mock, turn, cleanup } = await harness([{ text: "A shorter answer." }, { text: "Sure." }]);
  try {
    await turn([user("What is in your room?"), system("REGEN GUIDANCE: keep it short.")]);
    await turn([user("What is in your room?"), assistant("A shorter answer."), user("Tell me more.")]);

    expect(shape(sentMessages(mock, 0))).toEqual([
      "user: What is in your room?",
      "system: REGEN GUIDANCE: keep it short.",
    ]);
    expect(sentMessages(mock, 0)[1]?.output_config).toEqual({ effort: "high" });
    expect(shape(sentMessages(mock, 1))).toEqual([
      "user: What is in your room?",
      "system: REGEN GUIDANCE: keep it short.",
      "assistant: A shorter answer.",
      "user: Tell me more.",
    ]);
  } finally {
    await cleanup();
  }
}, 60_000);

test("regenerating again replaces the earlier guidance instead of stacking it", async () => {
  const { mock, turn, cleanup } = await harness([
    { text: "A0" }, { text: "A1" }, { text: "A2" }, { text: "A3" }, { text: "A4" },
  ]);
  try {
    await turn([user("hello")]);
    await turn([user("hello"), assistant("A0"), user("What is in your room?")]);
    await turn([user("hello"), assistant("A0"), user("What is in your room?"), system("FIRST GUIDANCE")]);
    await turn([user("hello"), assistant("A0"), user("What is in your room?"), system("SECOND GUIDANCE")]);
    await turn([user("hello"), assistant("A0"), user("What is in your room?"), assistant("A3"), user("Tell me more.")]);

    expect(shape(sentMessages(mock, 2)).slice(-2)).toEqual(["user: What is in your room?", "system: FIRST GUIDANCE"]);
    expect(shape(sentMessages(mock, 3)).slice(-2)).toEqual(["user: What is in your room?", "system: SECOND GUIDANCE"]);
    expect(shape(sentMessages(mock, 4)).slice(-4)).toEqual([
      "user: What is in your room?", "system: SECOND GUIDANCE", "assistant: A3", "user: Tell me more.",
    ]);
    expect(JSON.stringify(mock.requests.slice(3).map(request => request.body.messages))).not.toContain("FIRST GUIDANCE");
  } finally {
    await cleanup();
  }
}, 60_000);

test("a heartbeat's instructions and its wrap-up nudge arrive as system messages, never as user text or inside a tool result", async () => {
  const { mock, turn, cleanup } = await harness([
    { toolUses: [{ id: "toolu_plate", name: "mcp__shore__bash", input: { command: "python3 plate.py" } }] },
    { text: "HEARTBEAT_OK" },
  ]);
  let rounds = 0;
  try {
    await turn([
      user("Good night."), assistant("Sleep well."), user("[heartbeat · 2:10 PM]"), system("HEARTBEAT INSTRUCTIONS"),
    ], { callType: "heartbeat", tools: { beforeTurn: (req) => {
      rounds += 1;
      if (rounds === 2) req.messages.at(-1)?.content.push({ type: "text", text: "WRAP UP NOW" });
    } } });

    expect(shape(sentMessages(mock, 0)).slice(-2)).toEqual(["user: [heartbeat · 2:10 PM]", "system: HEARTBEAT INSTRUCTIONS"]);
    expect(shape(sentMessages(mock, 1)).slice(-5)).toEqual([
      "user: [heartbeat · 2:10 PM]",
      "system: HEARTBEAT INSTRUCTIONS",
      "assistant: <tool_use>",
      "user: <tool_result>",
      "system: WRAP UP NOW",
    ]);
    const wire = JSON.stringify(mock.requests.map(request => request.body.messages));
    expect(wire).not.toContain(STUB);
    for (const message of sentMessages(mock, 1).filter(sent => sent.role === "user")) {
      expect(JSON.stringify(message.content)).not.toContain("HEARTBEAT INSTRUCTIONS");
      expect(JSON.stringify(message.content)).not.toContain("WRAP UP NOW");
    }
  } finally {
    await cleanup();
  }
}, 60_000);

test("a /sys note between turns applies to the next reply, after the user message that asks for it", async () => {
  const { mock, turn, cleanup } = await harness([{ text: "First." }, { text: "Second." }]);
  try {
    await turn([user("one")]);
    await turn([user("one"), assistant("First."), system("SYS NOTE"), user("two")]);
    expect(shape(sentMessages(mock, 1)).slice(-3)).toEqual(["assistant: First.", "user: two", "system: SYS NOTE"]);
  } finally {
    await cleanup();
  }
}, 60_000);

test("a model without mid-conversation system messages gets the instruction in its user turn, with no stub", async () => {
  const { mock, turn, cleanup } = await harness([{ text: "Short." }]);
  try {
    await turn([user("What is in your room?"), system("REGEN GUIDANCE")], { model: "claude-sonnet-5" });
    const sent = sentMessages(mock, 0);
    expect(sent.filter(message => message.role === "system").flatMap(message => message.content.filter(block => block.type === "text"))).toEqual([]);
    expect(shape(sent.filter(message => message.role === "user"))).toEqual(["user: What is in your room? | REGEN GUIDANCE"]);
  } finally {
    await cleanup();
  }
}, 60_000);

test("anchors follow the last text of a user turn, count repeats, and match any tool result in a turn", () => {
  const keys = anchorKeys([
    { role: "user", content: [{ type: "image" }, { type: "text", text: " ok " }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "ok" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a" }, { type: "tool_result", tool_use_id: "toolu_b" }] },
  ]);
  expect(keys[1]).toEqual([]);
  expect(keys[0]?.[0]?.replace(/#\d+$/, "")).toBe(keys[2]?.[0]?.replace(/#\d+$/, ""));
  expect([keys[0]?.[0]?.endsWith("#0"), keys[2]?.[0]?.endsWith("#1")]).toEqual([true, true]);
  expect(keys[3]).toEqual([resultAnchor("toolu_a"), resultAnchor("toolu_b")]);
});

test("notes merge into the CLI's own system message, skip turns another user message follows, and fold for older models", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "system", content: [], output_config: { effort: "high" } },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "user", content: [{ type: "text", text: "third" }] },
  ];
  const keys = anchorKeys(messages);
  const notes = (): SystemNote[] => [
    { anchor: keys[0]?.[0] ?? "", text: "after first" },
    { anchor: keys[3]?.[0] ?? "", text: "after second" },
    { anchor: keys[4]?.[0] ?? "", text: "after third" },
  ];
  const native = notes();
  expect(insertSystemNotes({ model: "claude-opus-5-5", messages }, native).messages).toEqual([
    messages[0],
    { role: "system", content: [{ type: "text", text: "after first" }], output_config: { effort: "high" } },
    messages[2], messages[3], messages[4],
    { role: "system", content: [{ type: "text", text: "after third" }] },
  ]);
  expect(native.map(note => note.delivered === true)).toEqual([true, false, true]);
  expect(insertSystemNotes({ model: "claude-sonnet-5", messages }, notes()).messages).toEqual([
    { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "after first" }] },
    messages[1], messages[2], messages[3],
    { role: "user", content: [{ type: "text", text: "third" }, { type: "text", text: "after third" }] },
  ]);
});
