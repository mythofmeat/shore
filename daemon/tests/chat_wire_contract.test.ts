import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CallStore } from "../src/call_store.ts";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { turnEvents } from "../src/handler/generation.ts";
import { buildGenerationRequest, type SetupEngine } from "../src/handler/setup.ts";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { anthropicToolLoopEvents } from "../src/llm/providers/anthropic_loop.ts";
import { consumeStream } from "../src/llm/stream.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { installWireCapture } from "../src/llm/wire_capture.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type { Role } from "../src/engine/types.ts";

type Scripted =
  | { kind: "thinking"; thinking: string; signature: string; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; thinking?: { thinking: string; signature: string }; id: string; name: string; input: unknown };

interface WireRequest {
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  system?: Array<Record<string, unknown>>;
  thinking?: Record<string, unknown>;
  [k: string]: unknown;
}

function sse(turn: Scripted): string {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  let out = frame("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-fixture",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4 },
    },
  });

  let index = 0;
  const emitThinking = (thinking: string, signature: string) => {
    out += frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    out += frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    });
    out += frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature },
    });
    out += frame("content_block_stop", { type: "content_block_stop", index });
    index += 1;
  };

  if (turn.kind === "thinking") emitThinking(turn.thinking, turn.signature);
  if (turn.kind === "tool" && turn.thinking !== undefined) {
    emitThinking(turn.thinking.thinking, turn.thinking.signature);
  }

  if (turn.kind === "tool") {
    out += frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: turn.id, name: turn.name, input: {} },
    });
    out += frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
    });
    out += frame("content_block_stop", { type: "content_block_stop", index });
  } else {
    out += frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    out += frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: turn.text },
    });
    out += frame("content_block_stop", { type: "content_block_stop", index });
  }

  out += frame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  out += frame("message_stop", { type: "message_stop" });
  return out;
}

interface Fake {
  url: string;
  seen: WireRequest[];
  stop(): void;
}

function fakeAnthropic(script: Scripted[]): Fake {
  const seen: WireRequest[] = [];
  let next = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push((await request.json()) as WireRequest);
      const turn = script[next++] ?? { kind: "text" as const, text: "(exhausted)" };
      return new Response(sse(turn), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://localhost:${server.port}`, seen, stop: () => server.stop(true) };
}

const teardown: Array<() => void> = [];
afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
});

function serving(script: Scripted[]): Fake {
  const fake = fakeAnthropic(script);
  teardown.push(fake.stop);
  return fake;
}

const KEY_ENV = "SHORE_WIRE_CONTRACT_KEY";

function model(baseUrl: string): ResolvedModel {
  return {
    name: "fixture",
    qualifiedName: "chat.fixture",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-fixture",
    apiKeyEnv: KEY_ENV,
    baseUrl,
    cacheTtl: "5m",
    reasoningEffort: "high",
    maxContextTokens: 200_000,
    maxOutputTokens: 4096,
    maxToolIterations: 4,
  } as unknown as ResolvedModel;
}

async function loadedConfig(root: string): Promise<LoadedConfig> {
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  await mkdir(join(dirs.data, "poppy"), { recursive: true });

  const app: AppConfig = defaultAppConfig();
  app.defaults.model = "fixture";
  return {
    app,
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs,
    rawTable: undefined,
  };
}

const NO_MCP = { toolDefsFiltered: () => [] };

function engineOver(store: MessageStore): SetupEngine {
  return {
    messages: () => store.messages(),
    messagesThroughLastUserTurn: () => store.messagesThroughLastUserTurn(),
    segmentCount: () => 0,
  };
}

let minted = 0;
function userMessage(text: string): Message {
  minted += 1;
  return {
    msg_id: `u_${minted}`,
    role: "user",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: `2026-08-13T00:0${minted}:00Z`,
  };
}

function assistantFrom(blocks: ContentBlock[]): Message {
  minted += 1;
  return {
    msg_id: `a_${minted}`,
    role: "assistant",
    content: blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(""),
    images: [],
    content_blocks: blocks,
    timestamp: `2026-08-13T00:0${minted}:30Z`,
    provider_key: "anthropic",
    model: "claude-fixture",
  };
}

interface Harness {
  store: MessageStore;
  fake: Fake;
  request(regen: boolean): Promise<SidecarRequest>;
  say(text: string): Promise<ContentBlock[]>;
}

async function harness(script: Scripted[]): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "shore-wire-"));
  const config = await loadedConfig(root);
  const fake = serving(script);
  const resolved = model(fake.url);
  process.env[KEY_ENV] = "test-key";
  const store = MessageStore.create(join(root, "data", "poppy", "active.jsonl"));

  const request = async (regen: boolean): Promise<SidecarRequest> => {
    const built = await buildGenerationRequest({
      engine: engineOver(store),
      dataDir: config.dirs.data,
      charName: "poppy",
      config,
      resolved,
      regen,
      mcpRegistry: NO_MCP,
    });
    return { ...built.request, api_key: "test-key", base_url: fake.url };
  };

  const say = async (text: string): Promise<ContentBlock[]> => {
    await store.append(userMessage(text));
    const req = await request(false);
    const blocks = await runToDone(new AnthropicProvider().stream(req));
    await store.append(assistantFrom(blocks));
    return blocks;
  };

  return { store, fake, request, say };
}

async function runToDone(events: AsyncIterable<StreamEvent>): Promise<ContentBlock[]> {
  const outcome = await consumeStream(events, { regen: false, sink: () => {} });
  if ("err" in outcome) throw new Error(JSON.stringify(outcome.err));
  return outcome.ok.content_blocks;
}

const assistantTurns = (req: WireRequest) => req.messages.filter((m) => m.role === "assistant");

const thinkingIn = (m: { content: Array<Record<string, unknown>> }) =>
  m.content.filter((b) => b["type"] === "thinking" || b["type"] === "redacted_thinking");

function breakpointCount(req: WireRequest): number {
  const inMessages = req.messages.reduce(
    (n, m) => n + m.content.filter((b) => b["cache_control"] !== undefined).length,
    0,
  );
  const inSystem = (req.system ?? []).filter((b) => b["cache_control"] !== undefined).length;
  return inMessages + inSystem;
}

describe("what reaches the model", () => {
  test("thinking replays verbatim, with the signature the model minted", async () => {
    const h = await harness([
      { kind: "thinking", thinking: "she asked twice", signature: "sig-AAA", text: "first" },
      { kind: "text", text: "second" },
    ]);

    await h.say("hello");
    await h.say("again");

    const replayed = thinkingIn(assistantTurns(h.fake.seen[1]!)[0]!);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!["thinking"]).toBe("she asked twice");
    expect(replayed[0]!["signature"]).toBe("sig-AAA");
  });

  test("thinking survives a regenerate and a swipe back to the first response", async () => {
    const h = await harness([
      { kind: "thinking", thinking: "first pass", signature: "sig-FIRST", text: "one" },
      { kind: "thinking", thinking: "second pass", signature: "sig-SECOND", text: "two" },
      { kind: "text", text: "three" },
    ]);

    await h.say("hello");

    const target = h.store.messages().at(-1)!.msg_id;
    const prior = h.store.pendingRegenAlt()!.alternatives;
    const regenReq = await h.request(true);
    const regenerated = [assistantFrom(await runToDone(new AnthropicProvider().stream(regenReq)))];
    regenerated[0]!.msg_id = target;
    MessageStore.attachGeneratedAlt(regenerated, prior);
    await h.store.replaceAfterLastUserTurn(regenerated);

    await h.store.selectAlt(target, 0);
    await h.say("and now");

    const turns = assistantTurns(h.fake.seen.at(-1)!);
    expect(turns).toHaveLength(1);
    const replayed = thinkingIn(turns[0]!);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!["signature"]).toBe("sig-FIRST");
    expect(replayed[0]!["thinking"]).toBe("first pass");
  });

  test("every assistant turn that thought still carries thinking many turns later", async () => {
    const h = await harness([
      { kind: "thinking", thinking: "t1", signature: "sig-1", text: "a" },
      { kind: "thinking", thinking: "t2", signature: "sig-2", text: "b" },
      { kind: "thinking", thinking: "t3", signature: "sig-3", text: "c" },
      { kind: "text", text: "d" },
    ]);

    await h.say("one");
    await h.say("two");
    await h.say("three");
    await h.say("four");

    const last = h.fake.seen.at(-1)!;
    const turns = assistantTurns(last);
    expect(turns).toHaveLength(3);
    expect(turns.map((m) => thinkingIn(m).length)).toEqual([1, 1, 1]);
    expect(turns.map((m) => thinkingIn(m)[0]!["signature"])).toEqual(["sig-1", "sig-2", "sig-3"]);
  });

  test("no request ever carries an unsendable turn", async () => {
    const h = await harness([
      { kind: "thinking", thinking: "t1", signature: "sig-1", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
    ]);

    await h.say("one");
    await h.say("two");
    await h.say("three");

    for (const req of h.fake.seen) {
      for (const m of req.messages) {
        expect(m.content.length).toBeGreaterThan(0);
        for (const block of m.content) {
          if (block["type"] === "text") expect(String(block["text"]).trim()).not.toBe("");
        }
      }
      const uses = req.messages.flatMap((m) =>
        m.content.filter((b) => b["type"] === "tool_use").map((b) => b["id"]),
      );
      const results = req.messages.flatMap((m) =>
        m.content.filter((b) => b["type"] === "tool_result").map((b) => b["tool_use_id"]),
      );
      expect(results.sort()).toEqual(uses.sort());
    }
  });

  test("breakpoints stay within budget and always anchor the newest message", async () => {
    const h = await harness([
      { kind: "thinking", thinking: "t1", signature: "sig-1", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
      { kind: "text", text: "d" },
    ]);

    await h.say("one");
    await h.say("two");
    await h.say("three");
    await h.say("four");

    for (const req of h.fake.seen) {
      expect(breakpointCount(req)).toBeLessThanOrEqual(4);
      const last = req.messages.at(-1)!;
      expect(last.content.some((b) => b["cache_control"] !== undefined)).toBe(true);
    }
  });
});

describe("what gets recorded", () => {
  test("a tools-enabled turn writes a call row and its raw HTTP exchanges", async () => {
    const fake = serving([
      { kind: "tool", thinking: { thinking: "look it up", signature: "sig-T" }, id: "toolu_1", name: "read", input: { path: "a.md" } },
      { kind: "text", text: "done" },
    ]);
    const store = CallStore.openInMemory();
    teardown.push(() => store.close());
    teardown.push(installWireCapture((e) => store.recordHttpCall(e)));

    const phase = collectingPhase();
    const req: SidecarRequest = {
      sdk: "anthropic",
      model: "claude-fixture",
      provider_key: "anthropic",
      api_key: "test-key",
      base_url: fake.url,
      messages: [{ role: "user", content: [{ type: "text", text: "read a.md" }] }],
      system: [{ text: "you are a character", label: "character" }],
      tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
      max_tokens: 1024,
      replay_prior_thinking: "all",
      provider_options: { cache_ttl: "5m" },
      context: { character: "poppy", call_type: "message", thinking_enabled: true },
    };

    await runToDone(
      turnEvents({ callStore: store }, unusableProvider(), req, phase, new AbortController().signal),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const calls = store.queryCalls({ character: "poppy", limit: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call_type).toBe("message");

    const wire = store.httpCallsFor(store.getCall(calls[0]!.id)!.call_id);
    expect(wire.length).toBe(2);
    expect(wire.every((w) => w.status === 200)).toBe(true);
    expect(wire[0]!.request_body).toContain("claude-fixture");
    expect(wire.map((w) => w.seq)).toEqual([0, 1]);
  });

  test("the tool loop keeps its thinking block alongside the tool_use it justified", async () => {
    const fake = serving([
      { kind: "tool", thinking: { thinking: "look it up", signature: "sig-T" }, id: "toolu_1", name: "read", input: { path: "a.md" } },
      { kind: "text", text: "done" },
    ]);
    const phase = collectingPhase();
    const req: SidecarRequest = {
      sdk: "anthropic",
      model: "claude-fixture",
      provider_key: "anthropic",
      api_key: "test-key",
      base_url: fake.url,
      messages: [{ role: "user", content: [{ type: "text", text: "read a.md" }] }],
      system: [{ text: "you are a character", label: "character" }],
      tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object" } }],
      max_tokens: 1024,
      replay_prior_thinking: "all",
      provider_options: { cache_ttl: "5m" },
    };

    await runToDone(anthropicToolLoopEvents(req, phase));

    const continuation = fake.seen[1]!;
    const assistant = assistantTurns(continuation)[0]!;
    expect(assistant.content.map((b) => b["type"])).toEqual(["thinking", "tool_use"]);
    expect(thinkingIn(assistant)[0]!["signature"]).toBe("sig-T");
  });
});

function unusableProvider(): SidecarProvider {
  return {
    stream(): AsyncIterable<StreamEvent> {
      throw new Error("the Anthropic tool loop must not route through the provider table");
    },
    generate() {
      return Promise.reject(new Error("unused"));
    },
  };
}

function collectingPhase(): ToolPhase {
  const messages: Message[] = [];
  let n = 0;
  return {
    messages,
    recordTurn: (role: Role, blocks: ContentBlock[]) => {
      n += 1;
      messages.push({
        msg_id: `t_${n}`,
        role,
        content: "",
        images: [],
        content_blocks: blocks,
        timestamp: "2026-08-13T00:00:00Z",
      });
    },
    runTool: (use: ToolUseEvent): Promise<ContentBlock> =>
      Promise.resolve({
        type: "tool_result",
        tool_use_id: use.id,
        content: "file contents",
        is_error: false,
      }),
  };
}
