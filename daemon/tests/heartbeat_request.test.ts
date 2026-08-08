/**
 * The body a heartbeat runs and the model it runs on.
 *
 * The four `heartbeat_override_*` tests in
 * `crates/daemon/src/autonomy/manager.rs` are carried across whole — they are
 * the specification for the override, and each one is a regression with a
 * commit behind it. Two more sit beside them for the paths the Rust asserted
 * about in prose but never drove: a pin that does not resolve, and a model with
 * no key.
 *
 * The `prepare` half has no Rust test at all, because in the Rust it could not
 * have one — it read a `Mutex<AutonomyState>` and wrote a prompt snapshot to
 * disk. What it decides is worth pinning anyway, and one of those decisions is
 * the most expensive mistake in this file:
 *
 * **The cached body is copied before anything is appended to it.** It is the
 * object chat's next turn extends and every keepalive ping refreshes. A tick
 * that pushed its inline system entry into that object would leave the cache
 * holding a body no real turn reuses, and the only symptom would be the
 * provider quietly charging cache-write prices from then on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyHeartbeatModelOverride,
  fallbackIntervalPhrase,
  prepareHeartbeatRequest,
} from "../src/autonomy/heartbeat_request.ts";
import { LastRequestCache } from "../src/autonomy/last_request.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import type { Message } from "../src/engine/types.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

// ── harness ─────────────────────────────────────────────────────────────

const CHAT_ENV = "SHORE_HB_TEST_CHAT";
const OVERRIDE_ENV = "SHORE_HB_TEST_OVERRIDE";

/** The two chat models the Rust's `loaded_config_with_two_chat_models` built. */
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
  const root = await mkdtemp(join(tmpdir(), "shore-hbreq-"));
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

/** The Rust's `minimal_request`, in wire shape. */
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

const ENV = { [CHAT_ENV]: "chat-secret", [OVERRIDE_ENV]: "slowthink-secret" };

// The cold rebuild builds a chat request through the handler, which reads the
// ambient environment rather than an injected one. `env` above stays injected
// because the override tests need to control which keys are *missing*.
process.env[CHAT_ENV] = "chat-secret";
process.env[OVERRIDE_ENV] = "slowthink-secret";

// ── the override, from the Rust ─────────────────────────────────────────

describe("the heartbeat model override", () => {
  /**
   * Regression, verbatim from the Rust: `defaults.heartbeat` was silently
   * ignored on the warm path because the tick reused the cached chat-turn
   * request without rewriting the model.
   */
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
    // The three fields the prompt-cache hash covers. A swap that rebuilt any of
    // them would cost the cache the swap exists to keep.
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

  test("is a no-op when the configured model is the one already in use", async () => {
    const config = await baseConfig("slowthink");
    const request = minimalRequest("claude-opus-slowthink");

    const { request: out, override } = applyHeartbeatModelOverride(request, config, "alice", {
      env: ENV,
    });

    expect(override).toBeUndefined();
    expect(out.model).toBe("claude-opus-slowthink");
    expect(out).toBe(request);
  });

  /**
   * Regression, verbatim from the Rust: a pin written `provider:model_id` with
   * no static `[chat.*]` entry behind it resolves only through the effective
   * catalog. The pre-check used the static lookup, so it rejected every such
   * pin — and that is the only pin shape a modern config can express, so
   * heartbeat silently never left the chat model at all.
   */
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

  /**
   * The pre-check's whole reason for existing. `resolveBackgroundModel` would
   * fall back to the chat model here and report it as a resolution — which for
   * compaction is right and here is not, because the user asked for a specific
   * model and got a different one with no way to tell.
   */
  test("keeps the chat model when the configured name does not resolve", async () => {
    const config = await baseConfig("no-such-model");
    // The body is on a *different* model than `defaults.model` selects, which
    // is what a `shore model` swap leaves behind mid-session. Without the
    // pre-check, `resolveBackgroundModel`'s fallback resolves the chat model
    // and the typo'd pin silently swaps the body onto it — a swap the user
    // never asked for, reported as though the pin had worked.
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

// ── the fallback interval, as the prompt says it ────────────────────────

describe("the fallback interval phrase", () => {
  test("whole hours read as hours", () => {
    expect(fallbackIntervalPhrase(3600n)).toBe("1 hour");
    expect(fallbackIntervalPhrase(7200n)).toBe("2 hours");
    expect(fallbackIntervalPhrase(172_800n)).toBe("48 hours");
  });

  test("anything else reads as truncated minutes", () => {
    expect(fallbackIntervalPhrase(1800n)).toBe("30 minutes");
    expect(fallbackIntervalPhrase(5400n)).toBe("90 minutes");
    // Truncating division, both faithful and only reachable from a config that
    // asked for it.
    expect(fallbackIntervalPhrase(90n)).toBe("1 minutes");
    expect(fallbackIntervalPhrase(30n)).toBe("0 minutes");
  });
});

// ── preparing the body ──────────────────────────────────────────────────

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

/** A character with a conversation on disk, so the cold rebuild has something. */
async function withConversation(config: LoadedConfig): Promise<void> {
  const characterDir = join(config.dirs.data, "alice");
  await mkdir(characterDir, { recursive: true });
  await mkdir(join(config.dirs.config, "characters", "alice", "workspace", "memory"), {
    recursive: true,
  });
  await writeFile(
    join(characterDir, "active.jsonl"),
    [message("user", "m_1", "hi"), message("assistant", "m_2", "hello")]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n",
  );
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
    // The prompt landed on the copy...
    expect(prepared?.request.messages.length).toBe(beforeLength + 1);
    // ...and the cache still holds exactly what chat's next turn will extend.
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
    const text = (last?.content[0] as { text: string }).text;
    expect(text).toStartWith("[Current time: Thursday 2026-07-30 · 1:00 PM]");
    expect(text).toContain("your next moment will arrive in 1 hour");
  });

  test("says the configured fallback interval, not the default one", async () => {
    const config = await baseConfig();
    config.app.behavior.autonomy.heartbeat.fallback_heartbeat_interval =
      ConfigDuration.fromSecs(10_800);
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    const text = (prepared?.request.messages.at(-1)?.content[0] as { text: string }).text;
    expect(text).toContain("your next moment will arrive in 3 hours");
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
    expect(prepared?.request.context?.call_type).toBe("message");
    // The cached body keeps its own id — the copy is what was edited.
    expect(cached.context?.rid).toBe("r_1");
  });

  test("rebuilds from disk when nothing is cached, and caches what it rebuilt", async () => {
    const config = await baseConfig();
    await withConversation(config);
    const cache = new LastRequestCache();

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    expect(prepared).toBeDefined();
    // Cached, so a keepalive ping has a body to send before the next user
    // message. Throwing the rebuild away means paying to rebuild it every tick.
    const now = cache.get("alice");
    expect(now).toBeDefined();
    // What was cached is the chat-shape body, not the one carrying the prompt.
    expect(now?.messages.at(-1)?.role).not.toBe("system");
  });

  test("skips the tick when the conversation is mid-turn", async () => {
    const config = await baseConfig();
    const characterDir = join(config.dirs.data, "alice");
    await mkdir(characterDir, { recursive: true });
    // A user message still waiting on an answer. Anchoring a heartbeat onto one
    // builds a request with two consecutive user turns, which the provider
    // rejects — so the tick does not happen rather than failing at the wire.
    await writeFile(
      join(characterDir, "active.jsonl"),
      JSON.stringify(message("user", "m_1", "you there?")) + "\n",
    );

    const prepared = await prepareHeartbeatRequest("alice", config, {
      cache: new LastRequestCache(),
      env: ENV,
      ...PINNED,
    });

    expect(prepared).toBeUndefined();
  });

  test("still ticks when the prompt snapshot cannot be written", async () => {
    const config = await baseConfig();
    await withConversation(config);
    // A plain file where the snapshot directory belongs, so `mkdir` throws.
    await writeFile(join(config.dirs.data, "alice", "active_prompt"), "not a directory\n");
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    // Degraded, not skipped. The tick can still think, still write files and
    // still send a message; refusing to run because one snapshot is stale
    // trades a slightly stale prompt for no heartbeat at all.
    expect(prepared).toBeDefined();
    expect(prepared?.request.messages.at(-1)?.role).toBe("system");
  });

  test("takes the round cap from the model the body actually runs on", async () => {
    const config = await baseConfig("slowthink");
    await withConversation(config);
    const cache = new LastRequestCache();
    cache.set("alice", minimalRequest("claude-sonnet-chat"), undefined);

    const prepared = await prepareHeartbeatRequest("alice", config, { cache, env: ENV, ...PINNED });

    // The override model's 9, not the chat model's 4. Re-resolving the cap
    // independently is how those two come apart.
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
});
