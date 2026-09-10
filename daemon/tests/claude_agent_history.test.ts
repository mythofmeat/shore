import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemorySessionStore, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider, conversationKey, nextEntries, planTurn, type AgentQuery } from "../src/llm/providers/claude_agent.ts";
import { readBook, writeSession } from "../src/llm/providers/agent_sessions.ts";
import { seedNativeHistory } from "../src/llm/providers/claude_agent_history.ts";
import { startMockAnthropic } from "../src/testing/mock_anthropic.ts";
import type { SidecarRequest, StreamEvent, WireMessage } from "../src/llm/types.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import { required } from "../src/util/required.ts";

const user = (text: string): WireMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): WireMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const req = (messages: WireMessage[]): SidecarRequest => ({
  sdk: "claude_agent", model: "claude-sonnet-4-6", api_key: "test-key",
  messages, max_tokens: 256, replay_prior_thinking: "all",
});

test("native history preserves images, signed thinking and completed tool pairs", async () => {
  const request = req([
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "image" } }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "considering", signature: "signed" },
      { type: "tool_use", id: "toolu_old", name: "read", input: { path: "MEMORY.md" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "remembered", is_error: false }] },
    assistant("retained answer"), user("continue"),
  ]);
  request.tools = [{ name: "read", description: "read", input_schema: { type: "object" } }];
  const seeded = await seedNativeHistory(request, new InMemorySessionStore());
  const key = { sessionId: seeded.sessionId, projectKey: "" };
  const entries = await seeded.sessionStore.load(key);
  expect(entries?.map((entry) => entry.type)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(entries?.[0]?.message).toEqual(request.messages[0]);
  expect(entries?.[1]?.message).toMatchObject({ content: [
    request.messages[1]?.content[0],
    { ...request.messages[1]?.content[1], name: "mcp__shore__read" },
  ] });
  expect(entries?.[2]?.message).toEqual(request.messages[2]);
  expect(entries?.map((entry) => entry.parentUuid)).toEqual([null, ...required(entries).slice(0, -1).map((entry) => entry.uuid)]);
  expect(seeded.assistantUuids.get(3)).toBe(entries?.[3]?.uuid);
  expect(seeded.promptContent).toEqual(required(request.messages[4]).content);
  expect(await seeded.sessionStore.load({ ...key, sessionId: "different" })).toBeNull();
  expect(await seeded.sessionStore.load({ ...key, subpath: "subagents/other" })).toBeNull();
});

test.each([false, true])("the real SDK continues and regenerates after compaction (tools: %s)", async (withTools) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-native-history-"));
  const mock = await startMockAnthropic({ fallback: { text: "new answer" } });
  const calls: Parameters<AgentQuery>[0][] = [];
  const runQuery: AgentQuery = (params) => {
    calls.push(params);
    return query({ ...params, options: {
      ...params.options,
      env: { ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude") },
    } });
  };
  const provider = () => new ClaudeAgentProvider({ runQuery, bookPath: () => join(dir, "sessions.json") });
  const phase: ToolPhase = {
    messages: [], recordTurn: () => {},
    runTool: () => { throw new Error("Historical tools must not run again"); },
  };
  const drive = async (messages: WireMessage[]) => {
    const request = { ...req(messages), base_url: mock.url, system: [{ label: "memory", text: "Updated memory after compaction" }] };
    if (withTools) request.tools = [{ name: "read", description: "read", input_schema: { type: "object" } }];
    const client = provider();
    const events: StreamEvent[] = [];
    const signal = AbortSignal.timeout(25_000);
    for await (const event of withTools ? client.streamWithTools(request, phase, signal) : client.stream(request, signal)) events.push(event);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.find((event) => event.type === "done")?.content).toBe("new answer");
  };
  try {
    const retained: WireMessage[] = [user("retained question")];
    if (withTools) retained.push(
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_retained", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_retained", content: "retained tool output" }] },
    );
    retained.push(assistant("retained answer"), user("previous question"));
    await drive([user("archived question"), assistant("archived answer"), ...retained]);
    const compacted = [...retained, assistant("new answer"), user("after compaction")];
    await drive(compacted);
    expect(calls[1]?.options.sessionStore).toBeDefined();
    expect(calls[1]?.options.resume).not.toBe(calls[0]?.options.resume);
    const body = mock.requests.at(-1)?.body;
    const messages = body?.messages as WireMessage[];
    expect(messages.map((message) => message.role)).toEqual(compacted.map((message) => message.role));
    expect(JSON.stringify(messages)).not.toContain("archived");
    expect(JSON.stringify(messages)).not.toContain("prior_assistant_turn");
    expect(JSON.stringify(body?.system)).toContain("Updated memory after compaction");
    expect(JSON.stringify(messages)).toContain("retained answer");
    if (withTools) {
      expect(messages[1]?.content).toContainEqual({ type: "tool_use", id: "toolu_retained", name: "mcp__shore__read", input: {} });
      expect(messages[2]?.content).toContainEqual({ type: "tool_result", tool_use_id: "toolu_retained", content: "retained tool output" });
    }
    await drive(compacted);
    expect(calls[2]?.options.sessionStore).toBeDefined();
    expect(calls[2]?.options.forkSession).toBe(true);
    expect(calls[2]?.options.resume).toBe(calls[1]?.options.resume);
    await drive([...compacted, assistant("new answer"), user("next question")]);
    expect(calls[3]?.options.sessionStore).toBeDefined();
    expect(calls[3]?.options.forkSession).toBeUndefined();
    expect(JSON.stringify(mock.requests.at(-1)?.body.messages)).not.toContain("archived");
    const diverged = [...compacted.slice(0, -3), user("edited question"), assistant("new answer"), user("retry")];
    const record = readBook(join(dir, "sessions.json"))[conversationKey(req(diverged))];
    const oldPlan = planTurn(record, diverged);
    expect(oldPlan.fork).toBe(true);
    expect(oldPlan.delivered).toHaveLength(3);
    await drive(diverged);
    expect(calls[4]?.options.forkSession).toBeUndefined();
    expect(calls[4]?.options.resume).not.toBe(calls[3]?.options.resume);
    expect((required(mock.requests.at(-1)).body.messages as WireMessage[]).map((message) => message.role))
      .toEqual(diverged.map((message) => message.role));
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test.each(["legacy replay", "edited reply", "omitted reply", "heartbeat", "subagent", "heartbeat after reply"])("the real SDK preserves history for %s", async (scenario) => {
  const dir = await mkdtemp(join(tmpdir(), "shore-history-boundaries-"));
  const path = join(dir, "sessions.json");
  const mock = await startMockAnthropic({ fallback: { text: "native reply" } });
  const provider = new ClaudeAgentProvider({
    bookPath: () => path,
    runQuery: params => query({ ...params, options: {
      ...params.options,
      env: { ...params.options.env, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude") },
    } }),
  });
  const drive = async (messages: WireMessage[], callType = "message") => {
    const events: StreamEvent[] = [];
    const request: SidecarRequest = {
      ...req(messages), base_url: mock.url,
      context: { character: "test", call_type: callType, thinking_enabled: false },
    };
    const signal = AbortSignal.timeout(25_000);
    if (scenario === "heartbeat after reply") request.tools = [{ name: "read", description: "read", input_schema: { type: "object" } }];
    const phase: ToolPhase = {
      messages: [], recordTurn: () => {},
      runTool: () => { throw new Error("No tool execution expected"); },
    };
    for await (const event of request.tools === undefined ? provider.stream(request, signal) : provider.streamWithTools(request, phase, signal)) events.push(event);
    expect(events.filter(event => event.type === "error")).toEqual([]);
  };
  try {
    let expected: WireMessage[];
    if (scenario === "legacy replay") {
      await drive([user("old question\n\n<prior_assistant_turn>\nold answer\n</prior_assistant_turn>\n\nprevious question")]);
      const request = { ...req([]), context: { character: "test", call_type: "message", thinking_enabled: false } };
      const key = conversationKey(request);
      const record = required(readBook(path)[key]);
      const prior = [user("old question"), assistant("old answer"), user("previous question")];
      writeSession(path, key, { ...record, version: 5, entries: nextEntries(planTurn(undefined, prior), undefined) });
      expected = [...prior, assistant("native reply"), user("continue")];
      await drive(expected);
    } else if (scenario === "edited reply" || scenario === "omitted reply") {
      await drive([user("question")]);
      expected = [user("question"), ...(scenario === "edited reply" ? [assistant("edited answer")] : []), user("continue")];
      await drive(expected);
    } else if (scenario === "heartbeat after reply") {
      expected = [user("question"), assistant("answer"), user("Continue according to the system instructions.")];
      const messages: WireMessage[] = [...expected.slice(0, -1), { role: "system", content: [{ type: "text", text: "Check outstanding reminders." }] }];
      await drive(messages, "heartbeat");
      await drive(messages, "heartbeat");
      expect(JSON.stringify(required(mock.requests.at(-1)).body.system)).toContain("Check outstanding reminders.");
      expect(JSON.stringify(required(mock.requests.at(-1)).body.messages)).not.toContain("native reply");
    } else {
      expected = [user("question"), assistant("answer"), user("run background task")];
      await drive(expected, scenario);
    }
    const messages = required(mock.requests.at(-1)).body.messages as WireMessage[];
    if (scenario === "omitted reply") {
      expect(JSON.stringify(messages)).not.toContain("native reply");
      expect(JSON.stringify(messages)).toContain("question");
      expect(JSON.stringify(messages)).toContain("continue");
    } else {
      expect(messages.map(message => message.role)).toEqual(expected.map(message => message.role));
      for (const message of expected) expect(JSON.stringify(messages)).toContain((message.content[0] as { text: string }).text);
    }
    expect(JSON.stringify(messages)).not.toContain("prior_assistant_turn");
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
