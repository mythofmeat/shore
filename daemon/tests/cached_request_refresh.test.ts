import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { KeepaliveService } from "../src/cache/keepalive.ts";
import { LastRequestCache, type KeepaliveReprime } from "../src/cache/last_request.ts";
import { CachedRequestRefresher } from "../src/cache/refresh.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { MessageStore } from "../src/engine/message_store.ts";
import type { Message } from "../src/engine/types.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps, buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { createRuntime } from "../src/runtime.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { required } from "../src/util/required.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { eventsForResponse } from "./support/stream.ts";
import { testTmp } from "./support/tmp.ts";
import { until } from "./support/until.ts";

const KEY_ENV = "SHORE_CACHE_REFRESH_KEY";

afterAll(restoreTestEnv);

async function withAda(check: (config: LoadedConfig, env: Record<string, string>) => Promise<void>): Promise<void> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-cache-refresh-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096,
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  await check(config, { [KEY_ENV]: "fixture-key" });
}

function turnRequest(): SidecarRequest {
  return { sdk: "anthropic", model: "claude-fixture", api_key: "fixture", messages: [{ role: "user", content: [{ type: "text", text: "the real turn" }] }], context: { character: "ada", call_type: "message", thinking_enabled: false, thread: "main" } } as unknown as SidecarRequest;
}

function message(msg_id: string, role: Message["role"], text: string): Message {
  return { msg_id, role, content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [], timestamp: new Date().toISOString() };
}

function neverPings(): KeepaliveService {
  return new KeepaliveService(() => { throw new Error("no ping expected"); });
}

test("a turn that finishes during a rebuild keeps its own request and keepalive prefix", async () => {
  await withAda(async (config, env) => {
    const store = await MessageStore.load(join(config.dirs.data, "ada", "threads", "main", "active.jsonl"));
    expect(store.messageCount()).toBe(0);
    const keepalive = neverPings();
    const cache = new LastRequestCache(keepalive);
    const turn = turnRequest();
    const decision = await cache.reprimeFromDisk("ada", config.dirs.data, config, {
      env, thread: "main",
      mcpRegistry: { toolDefsFiltered: () => { cache.set("ada", turn, undefined, true, "main"); return []; } },
    });
    expect(decision.kind).toBe("superseded");
    expect(cache.get("ada")).toBe(turn);
    expect(keepalive.warmThread("ada")).toBe("main");
  });
});

function gatedRefresher(results: (() => KeepaliveReprime)[] = []): { refresher: CachedRequestRefresher; rebuilds: (string | undefined)[]; order: string[]; release: () => void; changes: { count: number } } {
  const rebuilds: (string | undefined)[] = [];
  const order: string[] = [];
  const changes = { count: 0 };
  let gate = Promise.withResolvers<void>();
  const refresher = new CachedRequestRefresher({
    disarm: (character) => { order.push(`disarm ${character}`); },
    invalidate: (character) => { order.push(`invalidate ${character}`); changes.count += 1; },
    changesTo: () => changes.count,
    rebuild: async (_character, thread) => {
      rebuilds.push(thread);
      await gate.promise;
      return results.shift()?.() ?? { kind: "superseded" };
    },
    delayMs: 0,
    retryMs: 1,
  });
  return { refresher, rebuilds, order, changes, release: () => { gate.resolve(); gate = Promise.withResolvers<void>(); } };
}

test("the cache is invalidated and keepalive disarmed before refresh returns, and no rebuild has started", () => {
  const { refresher, rebuilds, order } = gatedRefresher();
  refresher.refresh("ada", "model_setting_change", "main");
  expect(order).toEqual(["disarm ada", "invalidate ada"]);
  expect(rebuilds).toEqual([]);
  void refresher.stop();
});

test("several changes in a row share one rebuild, and the last change wins", async () => {
  const { refresher, rebuilds, release } = gatedRefresher();
  refresher.refresh("ada", "model_change", "first");
  refresher.refresh("ada", "thread_change", "second");
  refresher.refresh("ada", "model_setting_change", "third");
  await until(() => rebuilds.length === 1, "the first rebuild");
  expect(rebuilds).toEqual(["third"]);
  release();
  await refresher.stop();
  expect(rebuilds).toEqual(["third"]);
});

test("a change during a rebuild runs one more rebuild with the latest thread", async () => {
  const { refresher, rebuilds, release } = gatedRefresher();
  refresher.refresh("ada", "thread_change", "first");
  await until(() => rebuilds.length === 1, "the first rebuild");
  refresher.refresh("ada", "thread_change", "second");
  refresher.refresh("ada", "thread_change", "third");
  release();
  await until(() => rebuilds.length === 2, "the second rebuild");
  release();
  await refresher.stop();
  expect(rebuilds).toEqual(["first", "third"]);
});

test("a rebuild that fails, or lands mid-turn, tries again a few times and then stops, and not at all if a turn got there first", async () => {
  const failing = (): KeepaliveReprime => { throw new Error("database busy"); };
  const failed = gatedRefresher([failing, () => ({ kind: "disarm" }), () => ({ kind: "disarm" }), () => ({ kind: "disarm" }), () => ({ kind: "disarm" })]);
  failed.refresher.refresh("ada", "model_change", "main");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    failed.release();
    await until(() => failed.rebuilds.length === attempt, `attempt ${String(attempt)}`);
  }
  failed.release();
  await Bun.sleep(30);
  await failed.refresher.stop();
  expect(failed.rebuilds).toEqual(["main", "main", "main", "main"]);

  const recovers = gatedRefresher([failing, () => ({ kind: "push", request: turnRequest(), keepalive: { intervalMs: undefined, pings: undefined } })]);
  recovers.refresher.refresh("ada", "model_change", "main");
  recovers.release();
  await until(() => recovers.rebuilds.length === 1, "the failed rebuild");
  recovers.release();
  await until(() => recovers.rebuilds.length === 2, "the retry");
  recovers.release();
  await Bun.sleep(30);
  await recovers.refresher.stop();
  expect(recovers.rebuilds).toEqual(["main", "main"]);

  const overtaken = gatedRefresher([() => { overtaken.changes.count += 1; throw new Error("database busy"); }]);
  overtaken.refresher.refresh("ada", "model_change", "main");
  overtaken.release();
  await until(() => overtaken.rebuilds.length === 1, "the overtaken rebuild");
  overtaken.release();
  await Bun.sleep(30);
  await overtaken.refresher.stop();
  expect(overtaken.rebuilds).toEqual(["main"]);
});

test("while a rebuild is waiting or running, its thread counts as the warm one, so archiving that thread can still move it", async () => {
  const { refresher, rebuilds, release } = gatedRefresher();
  refresher.refresh("ada", "thread_change", "side");
  expect(refresher.targetThread("ada")).toBe("side");
  await until(() => rebuilds.length === 1, "the rebuild");
  expect(refresher.targetThread("ada")).toBe("side");
  expect(refresher.targetThread("nova")).toBeUndefined();
  refresher.refresh("ada", "thread_change", "main");
  expect(refresher.targetThread("ada")).toBe("main");
  release();
  await until(() => rebuilds.length === 2, "the rebuild of the new target");
  release();
  await refresher.stop();
  expect(rebuilds).toEqual(["side", "main"]);
});

test("changing the model answers before the rebuild runs, and the rebuild then re-arms keepalive", async () => {
  await withAda(async (config, env) => {
    const runtime = await createRuntime({ config, providers: {}, env });
    try {
      const commands = buildCommandPathDeps({
        runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(),
        router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env,
      });
      const engine = await runtime.registry.getOrCreate("ada", "main");
      await engine.appendMessage(message("m_1", "user", "hello"));
      await engine.appendMessage(message("m_2", "assistant", "hi"));
      runtime.cache.set("ada", turnRequest(), undefined, true, "main");
      const frame = await dispatchCommand(commands, { name: "switch_model", args: { name: "fixture" } }, {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" },
        rid: "change",
        kind: "command",
      });
      expect(frame.type).toBe("command_output");
      expect(runtime.cache.get("ada")).toBeUndefined();
      expect(runtime.keepalive.warmThread("ada")).toBeUndefined();
      await until(() => runtime.cache.get("ada") !== undefined, "the detached rebuild");
      expect(runtime.keepalive.warmThread("ada")).toBe("main");
    } finally {
      await runtime.autonomy.shutdown();
      await runtime.shutdown();
    }
  });
});

test("a message sent right after a model change uses the new model, with the rebuild not yet done", async () => {
  await withAda(async (config, env) => {
    config.models.chat.set("chat.other", {
      name: "other", qualifiedName: "chat.other", category: "chat", providerKey: "anthropic",
      sdk: "anthropic", modelId: "claude-other", apiKeyEnv: KEY_ENV,
      maxContextTokens: 200_000, maxOutputTokens: 4096,
    });
    config.app.memory.compaction.enabled = false;
    config.app.tools.enabled_tools = [];
    const seen: SidecarRequest[] = [];
    const reply = (request: SidecarRequest): GenerateResponse => {
      seen.push(request);
      return { model: request.model, content: "hi", content_blocks: [{ type: "text", text: "hi" }], finish_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 } };
    };
    const runtime = await createRuntime({ config, providers: { anthropic: { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) } }, env });
    try {
      const autonomy = new TurnAutonomyBridge(runtime.autonomy);
      const commands = buildCommandPathDeps({ runtime, autonomy, diagnostics: new Diagnostics(), router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env });
      const session = { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" };
      const held = Promise.withResolvers<void>();
      const reprime = runtime.cache.reprimeFromDisk.bind(runtime.cache);
      const rebuilt = spyOn(runtime.cache, "reprimeFromDisk").mockImplementation(async (...args) => {
        await held.promise;
        return await reprime(...args);
      });
      expect((await dispatchCommand(commands, { name: "switch_model", args: { name: "other" } }, { session, rid: "change", kind: "command" })).type).toBe("command_output");
      const deps = buildGenerationDeps({ runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {} });
      await runGeneration(deps, {
        meta: { session, rid: "chat", kind: "message" },
        body: { rid: "chat", text: "hello", stream: true, images: [], image_data: [] },
        charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
      });
      expect(required(seen.at(-1)).model).toBe("claude-other");
      held.resolve();
      await until(() => rebuilt.mock.calls.length > 0, "the rebuild");
      await until(() => runtime.keepalive.warmThread("ada") === "main", "keepalive to come back");
      const armed = await Promise.resolve(runtime.cache.get("ada"));
      expect(required(armed).model).toBe("claude-other");
      rebuilt.mockRestore();
    } finally {
      await runtime.autonomy.shutdown();
      await runtime.shutdown();
    }
  });
});
