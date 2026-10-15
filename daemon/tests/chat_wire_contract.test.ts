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
import { startMockAnthropic, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import { setTestEnv } from "./support/env.ts";

type Reply = NonNullable<NonNullable<Parameters<typeof startMockAnthropic>[0]>["script"]>;

interface WireRequest {
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  system?: Array<Record<string, unknown>>;
}

let running: MockAnthropic | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

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
  seen(): WireRequest[];
  say(text: string): Promise<ContentBlock[]>;
}

async function harness(script: Reply): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "shore-wire-"));
  const config = await loadedConfig(root);
  const mock = await startMockAnthropic({ script });
  running = mock;
  const resolved = model(mock.url);
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
    return { ...built.request, api_key: "test-key", base_url: mock.url };
  };

  const say = async (text: string): Promise<ContentBlock[]> => {
    await store.append(userMessage(text));
    const req = await request(false);
    const blocks = await runToDone(new AnthropicProvider().stream(req));
    await store.append(assistantFrom(blocks));
    return blocks;
  };

  return { seen: () => mock.requests.map((r) => r.body as unknown as WireRequest), say };
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
      { thinking: "she asked twice", thinkingSignature: "sig-AAA", text: "first" },
      { text: "second" },
    ]);

    await h.say("hello");
    await h.say("again");

    const replayed = thinkingIn(required(assistantTurns(required(h.seen()[1]))[0]));
    expect(replayed).toHaveLength(1);
    expect(required(replayed[0])["thinking"]).toBe("she asked twice");
    expect(required(replayed[0])["signature"]).toBe("sig-AAA");
  });

  test("no request ever carries an unsendable turn", async () => {
    const h = await harness([
      { thinking: "t1", thinkingSignature: "sig-1", text: "a" },
      { text: "b" },
      { text: "c" },
    ]);

    await h.say("one");
    await h.say("two");
    await h.say("three");

    for (const req of h.seen()) {
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
      { thinking: "t1", thinkingSignature: "sig-1", text: "a" },
      { text: "b" },
      { text: "c" },
      { text: "d" },
    ]);

    await h.say("one");
    await h.say("two");
    await h.say("three");
    await h.say("four");

    for (const req of h.seen()) {
      expect(breakpointCount(req)).toBeLessThanOrEqual(4);
      const last = required(req.messages.at(-1));
      expect(last.content.some((b) => b["cache_control"] !== undefined)).toBe(true);
    }
  });
});
