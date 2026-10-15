import { required } from "../src/util/required.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultAppConfig, type AppConfig } from "../src/config/app.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { buildGenerationRequest, type SetupEngine } from "../src/handler/setup.ts";
import { AnthropicProvider } from "../src/llm/providers/anthropic.ts";
import { consumeStream } from "../src/llm/stream.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { setTestEnv } from "./support/env.ts";

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
  return { url: `http://localhost:${server.port}`, seen, stop: () => void server.stop(true) };
}

const teardown: Array<() => void> = [];
afterEach(() => {
  for (const undo of teardown.splice(0)) undo();
});

function serving(script: Scripted[]): Fake {
  const fake = fakeAnthropic(script);
  teardown.push(() => fake.stop());
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
  await mkdir(join(dirs.data, "frank"), { recursive: true });

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
  setTestEnv(KEY_ENV, "test-key");
  const store = MessageStore.create(join(root, "data", "frank", "threads", "main", "active.jsonl"));

  const request = async (regen: boolean): Promise<SidecarRequest> => {
    const built = await buildGenerationRequest({
      engine: engineOver(store),
      dataDir: config.dirs.data,
      charName: "frank",
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

    const replayed = thinkingIn(required(assistantTurns(required(h.fake.seen[1]))[0]));
    expect(replayed).toHaveLength(1);
    expect(required(replayed[0])["thinking"]).toBe("she asked twice");
    expect(required(replayed[0])["signature"]).toBe("sig-AAA");
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
      const byText = (a: unknown, b: unknown) => String(a).localeCompare(String(b));
      expect(results.sort(byText)).toEqual(uses.sort(byText));
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
      const last = required(req.messages.at(-1));
      expect(last.content.some((b) => b["cache_control"] !== undefined)).toBe(true);
    }
  });
});
