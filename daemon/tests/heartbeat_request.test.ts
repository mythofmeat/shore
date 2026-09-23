import { writeDurable } from "../src/storage/files.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyHeartbeatModelOverride,
  fallbackIntervalPhrase,
  prepareHeartbeatRequest,
} from "../src/autonomy/heartbeat_request.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { Message } from "../src/engine/types.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import type { KeepalivePrefix } from "../src/cache/keepalive.ts";
import { testTmp } from "./support/tmp.ts";

beforeEach(() => {
  setTestEnv(CHAT_ENV, "chat-secret");
  setTestEnv(OVERRIDE_ENV, "slowthink-secret");
});

afterAll(restoreTestEnv);

const CHAT_ENV = "SHORE_HB_TEST_CHAT";
const OVERRIDE_ENV = "SHORE_HB_TEST_OVERRIDE";

function catalogWithTwoModels() {
  const models = emptyCatalog();
  models.chat.set("chat.anthropic.sonnet", {
    name: "sonnet",
    qualifiedName: "chat.anthropic.sonnet",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-sonnet-chat",
    apiKeyEnv: CHAT_ENV,
    maxOutputTokens: 4096,
    maxToolIterations: 4,
  } as never);
  models.chat.set("chat.anthropic.slowthink", {
    name: "slowthink",
    qualifiedName: "chat.anthropic.slowthink",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-opus-slowthink",
    apiKeyEnv: OVERRIDE_ENV,
    maxOutputTokens: 4096,
    maxToolIterations: 9,
  } as never);
  return models;
}

async function baseConfig(heartbeat?: string): Promise<LoadedConfig> {
  const root = await mkdtemp(testTmp("shore-hbreq-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const app = defaultAppConfig();
  app.defaults.model = "sonnet";
  if (heartbeat !== undefined) app.defaults.background.heartbeat = heartbeat;

  return {
    app,
    models: catalogWithTwoModels(),
    providers: ProviderRegistry.empty(),
    dirs,
    rawTable: undefined,
  };
}

function minimalRequest(modelId: string): SidecarRequest {
  return {
    sdk: "anthropic",
    model: modelId,
    api_key: "chat-secret",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: [{ type: "text", text: "you are a character" }],
    tools: [{ name: "edit", description: "write a file", input_schema: { type: "object" } }],
    max_tokens: 4096,
    replay_prior_thinking: "off",
  } as never;
}

function blockText(block: unknown): string {
  const text = (block as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") {
    throw new TypeError(`expected a text block, got ${JSON.stringify(block)}`);
  }
  return text;
}

const ENV = { [CHAT_ENV]: "chat-secret", [OVERRIDE_ENV]: "slowthink-secret" };


describe("the heartbeat model override", () => {
  test("swaps the model and keeps the cacheable prefix intact", async () => {
    const config = await baseConfig("slowthink");
    const request = minimalRequest("claude-sonnet-chat");
    const originalMessages = request.messages;
    const originalSystem = request.system;
    const originalTools = request.tools;

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: ENV,
    });

    expect(override?.name).toBe("slowthink");
    expect(out.model).toBe("claude-opus-slowthink");
    expect(out.api_key).toBe("slowthink-secret");
    expect(out.messages).toEqual(originalMessages);
    expect(out.system).toEqual(originalSystem);
    expect(out.tools).toEqual(originalTools);
  });

  test("is a no-op when nothing is configured", async () => {
    const config = await baseConfig();
    const request = minimalRequest("claude-sonnet-chat");

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: ENV,
    });

    expect(override).toBeUndefined();
    expect(out.model).toBe("claude-sonnet-chat");
    expect(out).toBe(request);
  });

  test("applies the configured model's credentials and settings even when its ID is already in use", async () => {
    const config = await baseConfig("slowthink");
    const request = minimalRequest("claude-opus-slowthink");

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: ENV,
    });

    expect(override?.name).toBe("slowthink");
    expect(out.model).toBe("claude-opus-slowthink");
    expect(out.api_key).toBe("slowthink-secret");
    expect(out).not.toBe(request);
  });

  test("resolves a provider-prefixed pin with no static entry", async () => {
    const config = await baseConfig("testdyn:dyn-model");
    config.providers = ProviderRegistry.fromSection({
      testdyn: { base_url: "http://127.0.0.1:9", api_key_env: "SHORE_HB_TEST_PIN" },
    });
    const request = minimalRequest("claude-sonnet-chat");
    const originalMessages = request.messages;

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: { ...ENV, SHORE_HB_TEST_PIN: "pin-secret" },
    });

    expect(override).toBeDefined();
    expect(out.model).toBe("dyn-model");
    expect(out.api_key).toBe("pin-secret");
    expect(out.messages).toEqual(originalMessages);
  });

  test("keeps the chat model when the configured name does not resolve", async () => {
    const config = await baseConfig("no-such-model");
    const request = minimalRequest("claude-opus-slowthink");

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: ENV,
    });

    expect(override).toBeUndefined();
    expect(out).toBe(request);
    expect(out.model).toBe("claude-opus-slowthink");
  });

  test("keeps the chat model when the override model has no key", async () => {
    const config = await baseConfig("slowthink");
    const request = minimalRequest("claude-sonnet-chat");

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: { [CHAT_ENV]: "chat-secret" },
    });

    expect(override).toBeUndefined();
    expect(out).toBe(request);
    expect(out.model).toBe("claude-sonnet-chat");
  });
});

describe("the fallback interval phrase", () => {
  test("whole hours read as hours", () => {
    expect(fallbackIntervalPhrase(3600n)).toBe("1 hour");
    expect(fallbackIntervalPhrase(7200n)).toBe("2 hours");
    expect(fallbackIntervalPhrase(172_800n)).toBe("48 hours");
  });

  test("anything else reads as truncated minutes", () => {
    expect(fallbackIntervalPhrase(1800n)).toBe("30 minutes");
    expect(fallbackIntervalPhrase(5400n)).toBe("90 minutes");
    expect(fallbackIntervalPhrase(90n)).toBe("1 minutes");
    expect(fallbackIntervalPhrase(30n)).toBe("0 minutes");
  });
});

function message(role: "user" | "assistant", id: string, text: string): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    alternatives: [],
    timestamp: "2026-01-01T10:00:00-05:00",
  };
}

async function withConversation(config: LoadedConfig): Promise<void> {
  const characterDir = join(config.dirs.data, "alice");
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await mkdir(join(config.dirs.config, "characters", "alice", "workspace", "memory"), {
    recursive: true,
  });
  writeDurable(join(characterDir, "threads", "main", "active.jsonl"), [message("user", "m_1", "hi"), message("assistant", "m_2", "hello")]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n");
}

const PINNED = { now: () => Date.parse("2026-07-30T13:00:00Z"), timeZone: "UTC" };

describe("preparing a heartbeat body", () => {
  test("never appends to the cached body the keepalive is holding", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const cache = new LastRequestCache();
    const cached = minimalRequest("claude-sonnet-chat");
    cache.set("alice", cached, undefined);
    const beforeLength = cached.messages.length;

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared).toBeDefined();
    expect(prepared?.request.messages.at(-1)?.role).toBe("system");
    expect(cached.messages.length).toBe(beforeLength);
    expect(cache.get("alice")).toBe(cached);
  });

  test("pins the heartbeat prompt as an inline system entry at the tail", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    const last = prepared?.request.messages.at(-1);
    expect(last?.role).toBe("system");
    const text = blockText(last?.content[0]);
    expect(text).toStartWith("[Current time: Thursday 2026-07-30 · 1:00 PM]");
    expect(text).toContain("This is a private heartbeat turn");
    expect(text).not.toContain("{{");
  });

  test("says the configured fallback interval, not the default one", async () => {
    const config = await baseConfig();
    config.app.behavior.autonomy.heartbeat.fallback_heartbeat_interval =
      ConfigDuration.fromSecs(10_800);
    await mkdir(join(config.dirs.config, "prompts"), { recursive: true });
    await writeFile(
      join(config.dirs.config, "prompts", "heartbeat.md"),
      "[{{now}}]\n\nnext wake in {{default_interval}}\n",
    );
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    const text = blockText(prepared?.request.messages.at(-1)?.content[0]);
    expect(text).toContain("next wake in 3 hours");
  });

  test("uses a heartbeat.md override from the config prompts dir", async () => {
    const config = await baseConfig();
    await mkdir(join(config.dirs.config, "prompts"), { recursive: true });
    await writeFile(
      join(config.dirs.config, "prompts", "heartbeat.md"),
      "[{{now}}]\n\ncustom body for {{user}} every {{default_interval}}\n",
    );
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    const text = blockText(prepared?.request.messages.at(-1)?.content[0]);
    expect(text).toStartWith("[Thursday 2026-07-30 · 1:00 PM]");
    expect(text).toContain("custom body");
    expect(text).toContain("every 1 hour");
    expect(text).not.toContain("{{");
  });

  test("prefers a per-character heartbeat.md override", async () => {
    const config = await baseConfig();
    await mkdir(join(config.dirs.config, "characters", "alice", "prompts"), {
      recursive: true,
    });
    await writeFile(
      join(config.dirs.config, "characters", "alice", "prompts", "heartbeat.md"),
      "char-level {{user}} wakes in {{default_interval}}",
    );
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    const text = blockText(prepared?.request.messages.at(-1)?.content[0]);
    expect(text).toContain("char-level");
    expect(text).toContain("wakes in 1 hour");
    expect(text).not.toContain("{{");
  });

  test("drops the stale request id from the chat turn that seeded the body", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const cache = new LastRequestCache();
    const cached = minimalRequest("claude-sonnet-chat");
    cached.context = { character: "alice", call_type: "message", thinking_enabled: false, rid: "r_1" };
    cache.set("alice", cached, undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared?.request.context?.rid).toBeUndefined();
    expect(prepared?.request.context?.call_type).toBe("heartbeat");
    expect(cached.context?.rid).toBe("r_1");
    expect(cached.context?.call_type).toBe("message");
  });

  test("rebuilds from disk when nothing is cached, and caches what it rebuilt", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const cache = new LastRequestCache();

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared).toBeDefined();
    const now = cache.get("alice");
    expect(now).toBeDefined();
    expect(now?.messages.at(-1)?.role).not.toBe("system");
  });

  test("the cold rebuild arms with the model's own ping count, not a bare cadence", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const sonnet = config.models.chat.get("chat.anthropic.sonnet") as unknown as Record<
      string,
      unknown
    >;
    sonnet["cacheKeepalive"] = { kind: "every", interval: ConfigDuration.fromSecs(600) };
    sonnet["cacheKeepalivePings"] = 9;
    sonnet["cacheTtl"] = "1h";

    const armed: KeepalivePrefix[] = [];
    const warmed: boolean[] = [];
    const cache = new LastRequestCache({
      arm: (prefix: KeepalivePrefix, warm: boolean) => { armed.push(prefix); warmed.push(warm); },
      disarm: () => {},
    } as never);

    await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(armed[0]?.keepalive_interval_ms).toBe(600_000);
    expect(armed[0]?.keepalive_pings).toBe(9);
    expect(armed[0]?.context?.keepalive_window_secs).toBe(5400);
    expect(warmed).toEqual([false]);
  });

  test("skips the tick when the conversation is mid-turn", async () => {
    const config = await baseConfig();
    const characterDir = join(config.dirs.data, "alice");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    writeDurable(join(characterDir, "threads", "main", "active.jsonl"), JSON.stringify(message("user", "m_1", "you there?")) + "\n");

    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-opus-slowthink"));
    const prepared = await prepareHeartbeatRequest("alice", config, {
      cache,
      env: ENV,
      ...PINNED,
    });

    expect(prepared).toBeUndefined();
  });

  test("still ticks when the prompt snapshot cannot be written", async () => {
    const config = await baseConfig();
    await withConversation(config);
    await writeFile(join(config.dirs.data, "alice", "active_prompt"), "not a directory\n");
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared).toBeDefined();
    expect(prepared?.request.messages.at(-1)?.role).toBe("system");
  });

  test("takes the round cap from the model the body actually runs on", async () => {
    const config = await baseConfig("slowthink");
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared?.override?.name).toBe("slowthink");
    expect(prepared?.maxToolIterations).toBe(9);
  });

  test("falls back to the chat model's cap when no override applies", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared?.override).toBeUndefined();
    expect(prepared?.maxToolIterations).toBe(4);
  });

  test("the home thread's pinned model sets the cap the tick runs under", async () => {
    const config = await baseConfig();
    await withConversation(config);
    writeDurable(
      join(config.dirs.data, "alice", "threads.json"),
      JSON.stringify({
        version: 1,
        home: "main",
        threads: [
          {
            id: "main",
            created_at: "2026-07-30T00:00:00.000Z",
            compaction: true,
            chat_model: "chat.anthropic.slowthink",
          },
        ],
      }),
    );
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared?.override).toBeUndefined();
    expect(prepared?.maxToolIterations).toBe(9);
    expect(prepared?.request.model).toBe("claude-opus-slowthink");
  });

  test("a side thread's pin does not reach the heartbeat, which lives at home", async () => {
    const config = await baseConfig();
    await withConversation(config);
    writeDurable(
      join(config.dirs.data, "alice", "threads.json"),
      JSON.stringify({
        version: 1,
        home: "main",
        threads: [
          { id: "main", created_at: "2026-07-30T00:00:00.000Z", compaction: true },
          {
            id: "eval",
            created_at: "2026-07-30T00:00:00.000Z",
            compaction: false,
            chat_model: "chat.anthropic.slowthink",
          },
        ],
      }),
    );
    const cache = new LastRequestCache();
    const sideRequest = minimalRequest("claude-opus-slowthink");
    sideRequest.messages = [{ role: "user", content: [{ type: "text", text: "side thread secret" }] }];
    sideRequest.context = { character: "alice", thread: "eval", call_type: "message", thinking_enabled: false };
    cache.set("alice", sideRequest);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared?.maxToolIterations).toBe(4);
    expect(prepared?.request.model).toBe("claude-sonnet-chat");
    expect(prepared?.request.context?.thread).toBe("main");
    expect(JSON.stringify(prepared?.request.messages)).not.toContain("side thread secret");
    expect(JSON.stringify(prepared?.request.messages)).toContain("hello");
    expect(cache.get("alice")).toBe(sideRequest);
  });
});
