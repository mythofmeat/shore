import { afterEach, describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { anthropicToolLoopEvents } from "../src/llm/providers/anthropic_loop.ts";
import { buildKeepalivePing, type KeepalivePrefix } from "../src/cache/keepalive.ts";
import { completedResponseMessages, lastRequestWithResponse } from "../src/handler/persistence.ts";
import { consumeStream } from "../src/llm/stream.ts";
import { startMockAnthropic, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { SidecarRequest, StreamEvent, WireMessage } from "../src/llm/types.ts";

let running: MockAnthropic | undefined;
let clock = 0;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function mock(script?: Parameters<typeof startMockAnthropic>[0]): Promise<MockAnthropic> {
  clock = 0;
  running = await startMockAnthropic({ ...script, now: () => clock });
  return running;
}

const MINUTE = 60 * 1000;

const user = (text: string): WireMessage =>
  ({ role: "user", content: [{ type: "text", text }] }) as WireMessage;
const assistant = (text: string): WireMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as WireMessage;

function request(url: string, messages: WireMessage[], character = "ada"): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-mock",
    provider_key: "anthropic",
    api_key: "test-key",
    base_url: url,
    system: [
      { text: "You are ada. A system prompt long enough to be worth caching.", label: "character" },
    ],
    messages,
    max_tokens: 256,
    provider_options: { cache_ttl: "1h" },
    context: { character, call_type: "message" },
  } as SidecarRequest;
}

async function turn(req: SidecarRequest) {
  const outcome = await consumeStream(new AnthropicProvider().stream(req), {
    regen: false,
    sink: () => {},
  });
  if (!("ok" in outcome)) throw new Error(`stream failed: ${JSON.stringify(outcome.err)}`);
  return outcome.ok;
}

describe("the keepalive ping", () => {
  function pushedPrefix(req: SidecarRequest, result: Awaited<ReturnType<typeof turn>>) {
    const withResponse = lastRequestWithResponse(req, completedResponseMessages(result));
    return { ...withResponse, keepalive_interval_ms: 55 * MINUTE } as KeepalivePrefix;
  }

  test("reads the prefix the turn wrote, rather than writing its own", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);
    const wrote = m.lastUsage.cache_creation_input_tokens;
    expect(wrote).toBeGreaterThan(0);

    clock += 50 * MINUTE;
    await turn(buildKeepalivePing(pushedPrefix(first, result)));

    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThanOrEqual(wrote);
    expect(m.requests.at(-1)?.body.max_tokens).toBe(1);
  });

  test("keeps the next real turn warm past the original TTL", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);
    const wrote = m.lastUsage.cache_creation_input_tokens;

    clock += 50 * MINUTE;
    await turn(buildKeepalivePing(pushedPrefix(first, result)));

    clock += 40 * MINUTE;
    const next = request(m.url, [user("hello"), assistant(result.content), user("still there?")]);
    await turn(next);

    expect(m.lastUsage.cache_read_input_tokens).toBe(wrote);
    const systemAnchor = m.lastBreakpoints.find((b) => b.where === "system");
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(systemAnchor!.prefixTokens);
  });

  test("without the ping, that same turn is cold", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);

    clock += 90 * MINUTE;
    const next = request(m.url, [user("hello"), assistant(result.content), user("still there?")]);
    await turn(next);

    expect(m.lastUsage.cache_read_input_tokens).toBe(0);
  });

  test("the appended turn sits after the prefix, not inside it", async () => {
    const m = await mock();
    const first = request(m.url, [user("hello")]);
    const result = await turn(first);
    const prefix = pushedPrefix(first, result);
    const ping = buildKeepalivePing(prefix);
    await turn(ping);

    const sent = m.requests.at(-1)!.body.messages as WireMessage[];
    expect(sent).toHaveLength(prefix.messages.length + 1);
    expect(sent.at(-1)!.role).toBe("user");
    expect(ping.context?.call_type).toBe("keepalive");
    expect(m.requests.at(-1)!.body.context).toBeUndefined();
  });
});

describe("a prefix-rewriting pass", () => {
  const history = [
    user("first question"),
    assistant("first answer"),
    user("second question"),
    assistant("second answer"),
    user("third question"),
  ];
  const compacted = [user("[summary of the conversation so far]"), user("third question")];

  test("writes, and the turn after it reads the new prefix", async () => {
    const m = await mock();
    await turn(request(m.url, history));
    await turn(request(m.url, history));
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);

    await turn(request(m.url, compacted));
    const rewrite = m.lastUsage;
    expect(rewrite.cache_creation_input_tokens).toBeGreaterThan(0);

    await turn(request(m.url, [...compacted, assistant("an answer"), user("fourth question")]));
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThanOrEqual(
      rewrite.cache_creation_input_tokens,
    );
  });

  test("the system prompt survives a history rewrite", async () => {
    const m = await mock();
    await turn(request(m.url, history));
    await turn(request(m.url, compacted));

    const systemAnchor = m.lastBreakpoints.find((b) => b.where === "system");
    expect(systemAnchor).toBeDefined();
    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThanOrEqual(
      systemAnchor!.prefixTokens,
    );
  });
});

describe("a regen", () => {
  test("reads the whole prefix and writes nothing", async () => {
    const m = await mock();
    const messages = [user("first question"), assistant("first answer"), user("second question")];

    await turn(request(m.url, messages));
    const original = m.lastUsage;

    await turn(request(m.url, messages));
    const regen = m.lastUsage;

    expect(regen.cache_creation_input_tokens).toBe(0);
    expect(regen.cache_read_input_tokens).toBe(
      original.cache_read_input_tokens + original.cache_creation_input_tokens,
    );
  });
});

function fakePhase(output: string): ToolPhase {
  const messages: Message[] = [];
  let minted = 0;
  return {
    messages,
    recordTurn: (role: Role, blocks: ContentBlock[]) => {
      minted += 1;
      messages.push({
        msg_id: `m_${minted}`,
        role,
        content: "",
        images: [],
        content_blocks: blocks,
        timestamp: "2026-01-01T00:00:00-05:00",
      } as Message);
    },
    runTool: (use) =>
      Promise.resolve({ type: "tool_result", tool_use_id: use.id, content: output } as ContentBlock),
  };
}

describe("a tool loop", () => {
  test("the second call reads the first call's write", async () => {
    const m = await mock({
      script: [
        { toolUses: [{ name: "read", input: { path: "/notes.md" } }] },
        { text: "the notes say hello" },
      ],
    });

    const req = {
      ...request(m.url, [user("read my notes")]),
      tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    } as SidecarRequest;

    const events: StreamEvent[] = [];
    for await (const e of anthropicToolLoopEvents(req, fakePhase("hello"))) events.push(e);

    expect(m.requests).toHaveLength(2);
    const [first, second] = m.requests;
    expect(first!.usage.cache_read_input_tokens).toBe(0);
    expect(second!.usage.cache_read_input_tokens).toBe(
      first!.usage.cache_creation_input_tokens,
    );
    expect(second!.breakpoints.at(-1)?.hit).toBe(false);
    expect(second!.breakpoints.at(-1)?.prefixTokens).toBeGreaterThan(
      first!.usage.cache_creation_input_tokens,
    );
    const completed = events.filter((e) => e.type === "call_complete");
    expect(completed).toHaveLength(2);
  });

  test("a turn after the loop reads what the loop wrote", async () => {
    const m = await mock({
      script: [
        { toolUses: [{ name: "read", input: { path: "/notes.md" } }] },
        { text: "the notes say hello" },
      ],
    });
    const req = {
      ...request(m.url, [user("read my notes")]),
      tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
    } as SidecarRequest;
    for await (const _ of anthropicToolLoopEvents(req, fakePhase("hello"))) void _;

    const loopTail = m.requests.at(-1)!.body.messages as WireMessage[];
    await turn({ ...req, messages: [...loopTail, user("thanks")] });

    expect(m.lastUsage.cache_read_input_tokens).toBeGreaterThan(0);
  });
});
