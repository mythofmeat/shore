import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider, keepalivePlan } from "../src/llm/providers/claude_agent.ts";
import { readBook, SESSION_BOOK_VERSION } from "../src/llm/providers/agent_sessions.ts";
import { startMockAnthropic, type AnthropicRequestRecord } from "../src/testing/mock_anthropic.ts";
import { fakeAgent } from "../src/testing/fake_agent_query.ts";
import type { SidecarRequest, StreamEvent, ToolDefinition, WireMessage } from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import { required } from "../src/util/required.ts";

const user = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): WireMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const TOOLS: ToolDefinition[] = [{ name: "read", description: "read a file", input_schema: { type: "object" } }];

function request(messages: WireMessage[], callType: string, extra: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "test-key",
    messages, max_tokens: 256, replay_prior_thinking: "all",
    system: [{ text: "You are Ada.", label: "character" }],
    context: { character: "ada", ledger: "/l.db", call_type: callType, thinking_enabled: false },
    ...extra,
  };
}

function withoutMarks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarks);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control")
    .map(([key, inner]) => [key, withoutMarks(inner)]));
}

function prefixOf(record: AnthropicRequestRecord): unknown {
  return withoutMarks({
    system: record.body.system,
    tools: record.body["tools"],
    messages: record.body.messages.slice(0, -1),
  });
}

function storedTranscriptEntries(dir: string): number {
  const db = new Database(join(dir, "shore.db"), { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM state_files WHERE path LIKE 'sdk_transcripts/%'").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function lastUserText(record: AnthropicRequestRecord): string {
  const last = record.body.messages.at(-1) as { content: unknown };
  const blocks = Array.isArray(last.content) ? last.content as { type: string; text?: string }[] : [];
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test.each([false, true])("the real SDK pings the chat session's own prefix and keeps nothing (tools: %s)", async (withTools) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-keepalive-"));
  const path = join(dir, "sessions.json");
  const mock = await startMockAnthropic({ fallback: { text: "native reply" } });
  const provider = new ClaudeAgentProvider({
    bookPath: () => path,
    runQuery: params => query({ ...params, options: {
      ...params.options,
      env: { ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude") },
    } }),
  });
  const extra: Partial<SidecarRequest> = {
    base_url: mock.url,
    provider_options: { cache_ttl: "1h" },
    ...(withTools ? { tools: TOOLS } : {}),
  };
  const phase: ToolPhase = {
    messages: [], recordTurn: () => {},
    runTool: () => { throw new Error("No tool execution expected"); },
  };
  const turn = async (messages: WireMessage[]) => {
    const events: StreamEvent[] = [];
    const req = request(messages, "message", extra);
    const signal = AbortSignal.timeout(25_000);
    for await (const event of withTools ? provider.streamWithTools(req, phase, signal) : provider.stream(req, signal)) events.push(event);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  };
  try {
    await turn([user("hello")]);
    const bookAfterTurn = readBook(path);
    const transcriptsAfterTurn = storedTranscriptEntries(dir);

    const ping = await provider.generate(request([user("hello"), assistant("native reply")], "keepalive", extra), AbortSignal.timeout(25_000));
    const pinged = required(mock.requests.at(-1));
    expect(lastUserText(pinged)).toBe(".");
    expect(ping.usage.cache_read_tokens, "the ping read the system prefix the turn cached").toBeGreaterThan(0);
    expect(pinged.breakpoints.every((breakpoint) => breakpoint.ttl === "1h"), "cache_ttl reached the SDK").toBe(true);
    expect(readBook(path), "the ping left the session book alone").toEqual(bookAfterTurn);
    expect(storedTranscriptEntries(dir), "the ping stored no transcript of its own").toBe(transcriptsAfterTurn);

    await turn([user("hello"), assistant("native reply"), user("again")]);
    const next = required(mock.requests.at(-1));
    expect(lastUserText(next)).toBe("again");
    expect(JSON.stringify(next.body.messages)).not.toContain('"."');
    expect(prefixOf(next), "the next real turn resumes the prefix the ping kept warm").toEqual(prefixOf(pinged));
  } finally {
    await mock.stop();
  }
}, 120_000);

test("a ping with no stored session fails rather than seeding one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-keepalive-none-"));
  const agent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => join(dir, "sessions.json") });
  const caught = await provider.generate(request([user("hello")], "keepalive")).then(() => undefined, (error: unknown) => error);
  expect(String(caught)).toContain("no stored session");
  expect(agent.calls).toHaveLength(0);
});

test("a ping resumes where the next turn would, on a fork whose writes are dropped", () => {
  const plan = keepalivePlan({
    version: SESSION_BOOK_VERSION, sessionId: "s-1", entries: [], storedTranscript: true,
    pendingAssistantUuids: ["a-1", "a-2"], model: "claude-sonnet-4-6",
  }, "/tmp/unused/sessions.json", "ada", "claude-sonnet-4-6");
  expect(plan.resume).toBe("s-1");
  expect(plan.resumeSessionAt).toBe("a-2");
  expect(plan.fork).toBe(true);
  expect(plan.content).toEqual([{ type: "text", text: "." }]);
});

test("the ping stops reading once the API has reported what it cached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-keepalive-stop-"));
  const path = join(dir, "sessions.json");
  const agent = fakeAgent({
    rounds: [{ blocks: [{ kind: "text", text: "hi" }], startUsage: { input_tokens: 3, cache_read_input_tokens: 4096 } }],
  });
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => path });
  for await (const _event of provider.stream(request([user("hello")], "message"))) void _event;

  const ping = await provider.generate(request([user("hello"), assistant("hi")], "keepalive"));
  expect(ping.usage.cache_read_tokens).toBe(4096);
  expect(ping.content).toBe("");
  expect(agent.calls[1]?.options.abortController?.signal.aborted).toBe(true);
  expect(agent.calls[1]?.options.forkSession).toBe(true);
});

test.each([
  ["1h", "1h"],
  ["5m", "5m"],
  [undefined, undefined],
] as const)("cache_ttl %s reaches the SDK as promptCacheTtl %s", async (ttl, expected) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-ttl-"));
  const agent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "hi" }] }] });
  const provider = new ClaudeAgentProvider({ runQuery: agent.query, bookPath: () => join(dir, "sessions.json") });
  const req = request([user("hello")], "message", ttl === undefined ? {} : { provider_options: { cache_ttl: ttl } });
  for await (const _event of provider.stream(req)) void _event;
  expect(agent.calls[0]?.options.settings).toEqual({
    autoCompactEnabled: false,
    ...(expected === undefined ? {} : { promptCacheTtl: expected }),
  });
});
