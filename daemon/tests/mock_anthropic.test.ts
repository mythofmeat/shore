/**
 * The Anthropic mock, and the cache behaviour it exists to make testable.
 *
 * Two layers. {@link PrefixCache} is tested directly, because it is the part
 * that encodes a claim about how Anthropic behaves and is what the live-key
 * check validates. Everything else runs `AnthropicProvider` against the server,
 * so the breakpoints under assertion are the ones the real schedule placed —
 * asserting on hand-built requests would test the mock against itself.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import {
  PrefixCache,
  startMockAnthropic,
  type MockAnthropic,
} from "../src/testing/mock_anthropic.ts";
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
  ({ role: "user", content: [{ type: "text", text }] }) as WireMessage;
const assistant = (text: string): WireMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as WireMessage;

/** A request with caching on — an empty `cache_ttl` disables the schedule. */
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

async function drive(url: string, messages: WireMessage[], ...rest: any[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of new AnthropicProvider().stream(request(url, messages, ...rest))) out.push(e);
  return out;
}

// ── the cache model, on its own ─────────────────────────────────────────────

describe("PrefixCache", () => {
  const marked = (text: string) => ({ type: "text", text, cache_control: { type: "ephemeral" } });

  test("an identical prefix reads the second time", () => {
    const cache = new PrefixCache(() => 1000);
    const system = [marked("stable system prompt")];

    const first = cache.account(system, [user("hello")]);
    expect(first.usage.cache_read_input_tokens).toBe(0);
    expect(first.usage.cache_creation_input_tokens).toBeGreaterThan(0);

    const second = cache.account(system, [user("hello")]);
    expect(second.usage.cache_read_input_tokens).toBe(
      first.usage.cache_creation_input_tokens,
    );
  });

  test("one changed byte before the breakpoint costs a write and reads nothing", () => {
    const cache = new PrefixCache(() => 1000);
    cache.account([marked("stable system prompt")], [user("hello")]);

    // A single character, which is the whole failure mode.
    const second = cache.account([marked("stable system prompt.")], [user("hello")]);
    expect(second.usage.cache_read_input_tokens).toBe(0);
    expect(second.usage.cache_creation_input_tokens).toBeGreaterThan(0);
  });

  test("the three buckets sum to the whole input", () => {
    const cache = new PrefixCache(() => 1000);
    const system = [marked("stable")];
    const messages = [user("first"), assistant("reply"), user("second")];
    cache.account(system, messages);
    const { usage } = cache.account(system, messages);

    const total =
      usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    const fresh = new PrefixCache(() => 1000).account(system, messages).usage;
    expect(total).toBe(
      fresh.input_tokens + fresh.cache_read_input_tokens + fresh.cache_creation_input_tokens,
    );
  });

  test("a prefix past its TTL is cold again", () => {
    let clock = 0;
    const cache = new PrefixCache(() => clock);
    const system = [marked("stable")];

    cache.account(system, [user("hello")]);
    clock = 4 * 60 * 1000; // inside the 5m default
    expect(cache.account(system, [user("hello")]).usage.cache_read_input_tokens).toBeGreaterThan(0);

    clock = 4 * 60 * 1000 + 6 * 60 * 1000; // past it
    expect(cache.account(system, [user("hello")]).usage.cache_read_input_tokens).toBe(0);
  });

  test("a 1h breakpoint outlives the 5m default", () => {
    let clock = 0;
    const cache = new PrefixCache(() => clock);
    const system = [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }];

    cache.account(system, [user("hello")]);
    clock = 30 * 60 * 1000;
    expect(cache.account(system, [user("hello")]).usage.cache_read_input_tokens).toBeGreaterThan(0);
  });
});

// ── through the real adapter and its real breakpoint schedule ───────────────

describe("the adapter's schedule, against the modelled cache", () => {
  test("a second turn on the same prefix reads it", async () => {
    const m = await mock();
    const history = [user("first question"), assistant("first answer")];

    await drive(m.url, [...history, user("second question")]);
    const cold = m.lastUsage;
    expect(cold.cache_read_input_tokens).toBe(0);

    // Same conversation, one more exchange appended — the frozen prefix is
    // untouched, so the read must cover it.
    await drive(m.url, [
      ...history,
      user("second question"),
      assistant("second answer"),
      user("third question"),
    ]);
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);
    // And the write covers only what is new, not the whole prompt again.
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
    // Four is the provider limit and the schedule's ceiling.
    expect(m.lastBreakpoints.length).toBeLessThanOrEqual(4);
  });

  test("editing the system prompt collapses the read", async () => {
    const m = await mock();
    const messages = [user("first"), assistant("answer"), user("second")];

    await drive(m.url, messages, [{ text: "You are a test.", label: "system" }]);
    await drive(m.url, messages, [{ text: "You are a test.", label: "system" }]);
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);

    await drive(m.url, messages, [{ text: "You are a different test.", label: "system" }]);
    expect(m.lastUsage.cache_read_input_tokens).toBe(0);
  });

  test("a churning memory_index block leaves the system prefix readable", async () => {
    // `memory_index` is rewritten by every dreaming and compaction pass, so the
    // system anchor deliberately sits on the last block that is *not* it.
    //
    // The anchor surviving does not mean the whole read survives: a message
    // breakpoint's prefix includes the system blocks, so rewriting any system
    // block misses every message anchor downstream of it. What the label buys
    // is that the read falls back to the system prefix instead of to zero —
    // which is precisely what `providers/anthropic.ts` means by "those reads
    // collapse to the system prefix". If the anchor ever moved onto
    // `memory_index`, this would read 0 and every pass would re-pay for the
    // whole system prompt.
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

    // Still reading, and reading exactly the system anchor's prefix.
    const systemAnchor = m.lastBreakpoints.find((b) => b.where === "system");
    expect(systemAnchor).toBeDefined();
    expect(afterChurn).toBe(systemAnchor!.prefixTokens);
    expect(afterChurn).toBeGreaterThan(0);
    expect(afterChurn).toBeLessThan(steady);
  });

  test("an empty cache_ttl places no breakpoints at all", async () => {
    const m = await mock();
    await drive(m.url, [user("hello")], [{ text: "sys", label: "system" }], "");

    expect(m.lastBreakpoints).toHaveLength(0);
    expect(m.lastUsage.cache_read_input_tokens).toBe(0);
    expect(m.lastUsage.cache_creation_input_tokens).toBe(0);
  });

  test("eviction models a cold cache", async () => {
    const m = await mock();
    const messages = [user("first"), assistant("answer"), user("second")];

    await drive(m.url, messages);
    await drive(m.url, messages);
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);

    m.evictCache();
    await drive(m.url, messages);
    expect(m.lastUsage.cache_read_input_tokens).toBe(0);
  });
});

// ── turn mechanics, so the mock is usable for more than the cache ───────────

describe("stream mechanics", () => {
  test("text, thinking and its signature come back in order", async () => {
    const m = await mock({
      script: [{ thinking: "considering it", thinkingSignature: "sig-abc", text: "the answer" }],
    });
    const events = await drive(m.url, [user("hello")]);

    expect(events[0]).toEqual({ type: "start", model: "claude-mock" });
    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking.map((e) => (e as { text: string }).text).join("")).toBe("considering it");
    expect(events.find((e) => e.type === "thinking_signature")).toEqual({
      type: "thinking_signature",
      signature: "sig-abc",
    });
    // The signature must follow its thinking and precede the text, or the
    // consumer attaches it to the wrong block on flush.
    expect(events.findIndex((e) => e.type === "thinking_signature")).toBeLessThan(
      events.findIndex((e) => e.type === "text"),
    );

    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.content).toBe("the answer");
    expect(done.finish_reason).toBe("end_turn");
  });

  test("a tool use is consolidated with its input parsed", async () => {
    const m = await mock({
      script: [{ toolUses: [{ name: "read", input: { path: "/notes.md", limit: 40 } }] }],
    });
    const events = await drive(m.url, [user("read my notes")]);

    const uses = events.filter((e) => e.type === "tool_use");
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({
      type: "tool_use",
      name: "read",
      input: { path: "/notes.md", limit: 40 },
    });
    expect((events.at(-1) as Extract<StreamEvent, { type: "done" }>).finish_reason).toBe("tool_use");
  });

  test("usage reaches done", async () => {
    const m = await mock({ script: [{ text: "hi" }] });
    const events = await drive(m.url, [user("hello")]);
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;

    expect(done.usage.output_tokens).toBeGreaterThan(0);
    expect(done.usage.cache_creation_tokens).toBe(m.lastUsage.cache_creation_input_tokens);
    expect(done.usage.cache_read_tokens).toBe(m.lastUsage.cache_read_input_tokens);
  });

  test("a scripted status fails the call", async () => {
    const m = await mock({ script: [{ status: 429 }] });
    expect(drive(m.url, [user("hello")])).rejects.toThrow();
  });
});
