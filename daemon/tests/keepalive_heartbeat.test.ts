import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { type KeepaliveEvent, prefixFingerprint } from "../src/cache/keepalive.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { buildGenerationDeps } from "../src/handler/deps.ts";
import { runGeneration } from "../src/handler/generation.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { createRuntime, startRuntimeClocks } from "../src/runtime.ts";
import { required } from "../src/util/required.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 19, 12);
const KEY_ENV = "SHORE_KEEPALIVE_HEARTBEAT_KEY";

afterAll(restoreTestEnv);
afterEach(() => setSystemTime());

function recordingProvider(seen: SidecarRequest[]): SidecarProvider {
  const reply = (request: SidecarRequest): GenerateResponse => {
    seen.push(structuredClone(request));
    const heartbeat = request.context?.call_type.startsWith("heartbeat") === true;
    const tail = request.messages.at(-1)?.content;
    const calledTool = Array.isArray(tail) && tail.some((block) => block.type === "tool_result");
    const blocks: GenerateResponse["content_blocks"] = heartbeat && !calledTool
      ? [{ type: "tool_use", id: "wake", name: "set_next_wake", input: { hours_from_now: 1, reason: "idle" } }]
      : [{ type: "text", text: heartbeat ? "HEARTBEAT_OK" : "hello" }];
    return {
      model: request.model,
      content: blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
      content_blocks: blocks,
      finish_reason: heartbeat && !calledTool ? "tool_use" : "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 4096, cache_creation_tokens: 0 },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  };
  return { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) };
}

test("idle heartbeat tool rounds preserve the chat keepalive and its idle ceiling", async () => {
  setTestEnv(KEY_ENV, "fixture-key");
  setSystemTime(new Date(T0));
  const root = await mkdtemp(testTmp("shore-keepalive-heartbeat-"));
  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  app.advanced.max_retries = 0;
  app.memory.compaction.enabled = false;
  app.tools.enabled_tools = [];
  app.behavior.autonomy.enabled = true;
  const models = emptyCatalog();
  models.chat.set("chat.fixture", {
    name: "fixture", qualifiedName: "chat.fixture", category: "chat", providerKey: "anthropic",
    sdk: "anthropic", modelId: "claude-fixture", apiKeyEnv: KEY_ENV,
    maxContextTokens: 200_000, maxOutputTokens: 4096, maxToolIterations: 3,
    cacheTtl: "1h",
    cacheKeepalive: { kind: "every", interval: ConfigDuration.fromSecs(55 * 60) },
    cacheKeepaliveMax: ConfigDuration.fromSecs(90 * 60),
  });
  const config: LoadedConfig = {
    app, models, providers: ProviderRegistry.empty(), rawTable: undefined,
    dirs: { config: join(root, "config"), data: join(root, "data"), cache: join(root, "cache"), runtime: join(root, "runtime") },
  };
  const workspace = join(config.dirs.config, "characters", "ada", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "Ada");
  const seen: SidecarRequest[] = [];
  const env = { [KEY_ENV]: "fixture-key" };
  const runtime = await createRuntime({ config, providers: { anthropic: recordingProvider(seen) }, env });
  const clocks = startRuntimeClocks(runtime);
  const events: KeepaliveEvent[] = [];
  runtime.keepalive.onEvent((event) => events.push(event));
  try {
    const autonomy = new TurnAutonomyBridge(runtime.autonomy);
    const deps = buildGenerationDeps({
      runtime, providers: runtime.providers, autonomy, diagnostics: new Diagnostics(), env, emitEvent: () => {},
    });
    await runGeneration(deps, {
      meta: {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main" },
        rid: "chat", kind: "message",
      },
      body: { rid: "chat", text: "hello", stream: true, images: [], image_data: [] },
      charName: "ada", regen: false, rid: "chat", signal: new AbortController().signal, send: async () => {},
    });
    await autonomy.settled("ada");
    const chatPrefix = required(runtime.cache.get("ada"));
    expect(runtime.keepalive.nextPingAt("ada")).toBe(T0 + 55 * MINUTE);

    const heartbeatAt = async (minutes: number) => {
      setSystemTime(new Date(T0 + minutes * MINUTE));
      expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
      await runtime.autonomy.tick();
    };
    await heartbeatAt(20);
    await heartbeatAt(50);
    setSystemTime(new Date(T0 + 55 * MINUTE));
    await runtime.keepalive.tick();

    const pings = seen.filter((request) => request.context?.call_type === "keepalive");
    expect(pings).toHaveLength(1);
    expect(events.map((event) => event.outcome)).toEqual(["sent"]);
    const ping = required(pings[0]);
    expect(ping.tools).toEqual(chatPrefix.tools);
    expect(ping.system).toEqual(chatPrefix.system);
    expect(ping.messages.slice(0, -1)).toEqual(chatPrefix.messages);
    expect(runtime.cache.get("ada")).toBe(chatPrefix);
    expect(runtime.keepalive.scheduleFor("ada")).toMatchObject({
      last_active_at: T0, last_warm_at: T0 + 55 * MINUTE,
    });
    const heartbeatCalls = seen.filter((request) => request.context?.call_type.startsWith("heartbeat"));
    expect(heartbeatCalls).toHaveLength(4);
    expect(heartbeatCalls.every((request) => prefixFingerprint(request) !== prefixFingerprint(chatPrefix))).toBe(true);
    const rows = required(runtime.callStore).database.query("SELECT call_type FROM calls ORDER BY id").all();
    expect(rows).toEqual(["message", "heartbeat", "heartbeat_tool_loop", "heartbeat", "heartbeat_tool_loop", "keepalive"]
      .map((call_type) => ({ call_type })));

    await heartbeatAt(100);
    setSystemTime(new Date(T0 + 110 * MINUTE));
    await runtime.keepalive.tick();
    expect(seen.filter((request) => request.context?.call_type === "keepalive")).toHaveLength(1);
    expect(runtime.keepalive.nextPingAt("ada")).toBeUndefined();
  } finally {
    clocks.stop();
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
