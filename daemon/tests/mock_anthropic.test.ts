import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { startMockAnthropic, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import type { SidecarRequest, StreamEvent, WireMessage } from "../src/llm/types.ts";

let running: MockAnthropic | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function mock(...args: Parameters<typeof startMockAnthropic>): Promise<MockAnthropic> {
  running = await startMockAnthropic(...args);
  return running;
}

const user = (text: string): WireMessage =>
  ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): WireMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] });

function request(
  url: string,
  messages: WireMessage[],
  system: { text: string; label: string }[] = [{ text: "You are a test.", label: "system" }],
  ttl = "1h",
): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-mock",
    api_key: "test-key",
    base_url: url,
    system,
    messages,
    max_tokens: 256,
    provider_options: { cache_ttl: ttl },
  } as SidecarRequest;
}

async function drive(
  url: string,
  messages: WireMessage[],
  ...rest: [system?: { text: string; label: string }[], ttl?: string]
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of new AnthropicProvider().stream(request(url, messages, ...rest))) out.push(e);
  return out;
}

describe("the adapter's schedule, against the modelled cache", () => {

  test("a second turn on the same prefix reads it", async () => {
    const m = await mock();
    const history = [user("first question"), assistant("first answer")];

    await drive(m.url, [...history, user("second question")]);
    const cold = m.lastUsage;
    expect(cold.cache_read_input_tokens).toBe(0);

    await drive(m.url, [
      ...history,
      user("second question"),
      assistant("second answer"),
      user("third question"),
    ]);
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);
    expect(m.lastUsage.cache_creation_input_tokens).toBeLessThan(
      cold.cache_creation_input_tokens,
    );
  });

  test("the adapter places breakpoints in both system and messages", async () => {
    const m = await mock();
    await drive(m.url, [user("first"), assistant("answer"), user("second")]);

    const where = m.lastBreakpoints.map((b) => b.where);
    expect(where).toContain("system");
    expect(where).toContain("messages");
    expect(m.lastBreakpoints.length).toBeLessThanOrEqual(4);
  });

  test("a churning memory_index block leaves the system prefix readable", async () => {
    const m = await mock();
    const messages = [user("first"), assistant("answer"), user("second")];
    const withIndex = (index: string) => [
      { text: "You are a test.", label: "system" },
      { text: index, label: "memory_index" },
    ];

    await drive(m.url, messages, withIndex("index rev 1"));
    await drive(m.url, messages, withIndex("index rev 1"));
    const steady = m.lastUsage.cache_read_input_tokens;
    expect(steady).toBeGreaterThan(0);

    await drive(m.url, messages, withIndex("index rev 2 — totally different content"));
    const afterChurn = m.lastUsage.cache_read_input_tokens;

    const systemAnchor = m.lastBreakpoints.find((b) => b.where === "system");
    expect(systemAnchor).toBeDefined();
    expect(afterChurn).toBe(required(systemAnchor).prefixTokens);
    expect(afterChurn).toBeGreaterThan(0);
    expect(afterChurn).toBeLessThan(steady);
  });

  test("across three turns, each read equals every write before it", async () => {
    const m = await mock();
    const messages: WireMessage[] = [user("Say the word: one")];

    await drive(m.url, messages);
    const t1 = m.lastUsage;
    expect(t1.cache_read_input_tokens).toBe(0);
    expect(t1.cache_creation_input_tokens).toBeGreaterThan(0);

    messages.push(assistant("one"), user("Say the word: two"));
    await drive(m.url, messages);
    const t2 = m.lastUsage;
    expect(t2.cache_read_input_tokens).toBe(t1.cache_creation_input_tokens);

    messages.push(assistant("two"), user("Say the word: three"));
    await drive(m.url, messages);
    const t3 = m.lastUsage;
    expect(t3.cache_read_input_tokens).toBe(
      t1.cache_creation_input_tokens + t2.cache_creation_input_tokens,
    );

    expect(t3.input_tokens).toBe(t2.input_tokens);
  });

  test("an empty cache_ttl places no breakpoints at all", async () => {
    const m = await mock();
    await drive(m.url, [user("hello")], [{ text: "sys", label: "system" }], "");

    expect(m.lastBreakpoints).toHaveLength(0);
    expect(m.lastUsage.cache_read_input_tokens).toBe(0);
    expect(m.lastUsage.cache_creation_input_tokens).toBe(0);
  });
});
