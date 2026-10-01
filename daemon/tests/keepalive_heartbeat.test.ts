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
import { buildAnthropicPlan } from "../src/llm/providers/anthropic.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import { createRuntime, startRuntimeClocks, type ShoreRuntime } from "../src/runtime.ts";
import { required } from "../src/util/required.ts";
import { eventsForResponse } from "./support/stream.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 19, 12);
const KEY_ENV = "SHORE_KEEPALIVE_HEARTBEAT_KEY";
const CHAT_PREFIX_TOKENS = 4096;
const SYSTEM_PROMPT_TOKENS = 1024;

afterAll(restoreTestEnv);
afterEach(() => setSystemTime());

function recordingProvider(seen: SidecarRequest[], heartbeatRead: number): SidecarProvider {
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
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: heartbeat ? heartbeatRead : CHAT_PREFIX_TOKENS,
        cache_creation_tokens: 0,
      },
      timing: { total_ms: 1, time_to_first_token_ms: 1 },
    };
  };
  return { generate: async (request) => reply(request), stream: (request) => eventsForResponse(reply(request)) };
}

interface IdleChat {
  runtime: ShoreRuntime;
  seen: SidecarRequest[];
  events: KeepaliveEvent[];
  chatPrefix: SidecarRequest;
  heartbeatAt: (minutes: number) => Promise<void>;
  keepaliveTickAt: (minutes: number) => Promise<void>;
}

async function afterOneChat(heartbeatRead: number, idle: (chat: IdleChat) => Promise<void>): Promise<void> {
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
    cacheKeepalivePings: 1,
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
  const runtime = await createRuntime({ config, providers: { anthropic: recordingProvider(seen, heartbeatRead) }, env });
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
    await idle({
      runtime,
      seen,
      events,
      chatPrefix: required(runtime.cache.get("ada")),
      heartbeatAt: async (minutes) => {
        setSystemTime(new Date(T0 + minutes * MINUTE));
        expect(runtime.autonomy.forceHeartbeatNow("ada")).toBeDefined();
        await runtime.autonomy.tick();
      },
      keepaliveTickAt: async (minutes) => {
        setSystemTime(new Date(T0 + minutes * MINUTE));
        await runtime.keepalive.tick();
      },
    });
  } finally {
    clocks.stop();
    await runtime.autonomy.shutdown();
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

const pingsIn = (seen: SidecarRequest[]) => seen.filter((request) => request.context?.call_type === "keepalive");

const callTypesIn = (runtime: ShoreRuntime) =>
  required(runtime.callStore).database.query("SELECT call_type FROM calls ORDER BY id").all();

const ANTHROPIC_LOOKBACK_BLOCKS = 20;

function wireBlocks(messages: readonly { role: string; content: unknown }[]): { block: unknown; marked: boolean }[] {
  return messages.flatMap((message) =>
    (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]).map((block) => {
      const { cache_control: marker, ...rest } = block as { cache_control?: unknown };
      return { block: { role: message.role, ...rest }, marked: marker !== undefined };
    }),
  );
}

function wireOf(seen: SidecarRequest[], callType: string) {
  return buildAnthropicPlan(structuredClone(required(seen.find((request) => request.context?.call_type === callType)))).params;
}

test("idle heartbeat tool rounds that read only the system prompt preserve the chat keepalive and its ping count", async () => {
  await afterOneChat(SYSTEM_PROMPT_TOKENS, async ({ runtime, seen, events, chatPrefix, heartbeatAt, keepaliveTickAt }) => {
    expect(runtime.keepalive.nextPingAt("ada")).toBe(T0 + 55 * MINUTE);

    await heartbeatAt(20);
    await heartbeatAt(50);
    await keepaliveTickAt(55);

    const pings = pingsIn(seen);
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
    expect(callTypesIn(runtime)).toEqual(["message", "heartbeat", "heartbeat_tool_loop", "heartbeat", "heartbeat_tool_loop", "keepalive"]
      .map((call_type) => ({ call_type })));

    await heartbeatAt(100);
    await keepaliveTickAt(110);
    expect(pingsIn(seen)).toHaveLength(1);
    expect(runtime.keepalive.nextPingAt("ada")).toBeUndefined();
  });
});

test("idle heartbeats that read the whole chat prefix push the ping out, and change nothing else", async () => {
  await afterOneChat(CHAT_PREFIX_TOKENS, async ({ runtime, seen, events, chatPrefix, heartbeatAt, keepaliveTickAt }) => {
    expect(runtime.keepalive.nextPingAt("ada")).toBe(T0 + 55 * MINUTE);

    await heartbeatAt(20);
    expect(runtime.keepalive.nextPingAt("ada")).toBe(T0 + 75 * MINUTE);
    await heartbeatAt(50);
    expect(runtime.keepalive.nextPingAt("ada")).toBe(T0 + 105 * MINUTE);
    expect(runtime.keepalive.scheduleFor("ada")).toMatchObject({
      last_active_at: T0, last_warm_at: T0 + 50 * MINUTE, pings_sent: 0,
    });

    await keepaliveTickAt(55);
    expect(pingsIn(seen)).toHaveLength(0);

    await keepaliveTickAt(105);
    const pings = pingsIn(seen);
    expect(pings).toHaveLength(1);
    expect(events.map((event) => event.outcome)).toEqual(["sent"]);
    expect(required(pings[0]).messages.slice(0, -1)).toEqual(chatPrefix.messages);
    expect(runtime.cache.get("ada")).toBe(chatPrefix);
    expect(runtime.keepalive.scheduleFor("ada")).toMatchObject({
      last_active_at: T0, last_warm_at: T0 + 105 * MINUTE, pings_sent: 1,
    });

    await heartbeatAt(120);
    await keepaliveTickAt(240);
    expect(pingsIn(seen)).toHaveLength(1);
    expect(runtime.keepalive.nextPingAt("ada")).toBeUndefined();
    expect(callTypesIn(runtime)).toEqual([
      "message", "heartbeat", "heartbeat_tool_loop", "heartbeat", "heartbeat_tool_loop", "keepalive", "heartbeat", "heartbeat_tool_loop",
    ].map((call_type) => ({ call_type })));
  });
});

test("a heartbeat's first round repeats the chat's cached prefix on the wire, ahead of its own prompt", async () => {
  await afterOneChat(CHAT_PREFIX_TOKENS, async ({ seen, heartbeatAt }) => {
    await heartbeatAt(20);
    const chat = wireOf(seen, "message");
    const heartbeat = wireOf(seen, "heartbeat");
    expect(heartbeat.tools).toEqual(chat.tools);
    expect(heartbeat.system).toEqual(chat.system);

    const chatBlocks = wireBlocks(chat.messages);
    const heartbeatBlocks = wireBlocks(heartbeat.messages);
    const chatEntry = chatBlocks.findLastIndex((entry) => entry.marked);
    expect(chatEntry).toBeGreaterThanOrEqual(0);
    expect(heartbeatBlocks.slice(0, chatEntry + 1).map((entry) => entry.block))
      .toEqual(chatBlocks.slice(0, chatEntry + 1).map((entry) => entry.block));

    const heartbeatMarks = heartbeatBlocks.flatMap((entry, at) => (entry.marked ? [at] : []));
    expect(heartbeatMarks.some((at) => at >= chatEntry && at - chatEntry < ANTHROPIC_LOOKBACK_BLOCKS)).toBe(true);
    expect(required(heartbeatMarks.at(-1))).toBeLessThan(heartbeatBlocks.length - 1);
  });
});
