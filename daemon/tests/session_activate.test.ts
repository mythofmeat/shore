import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AutonomyService } from "../src/autonomy/service.ts";
import type { AutonomyActionResult, AutonomyExecutor } from "../src/autonomy/runner.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { KeepaliveService } from "../src/cache/keepalive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { rebuildRequestFromDisk } from "../src/cache/rebuild.ts";
import { sessionActivateCommand, type KeepaliveActivation } from "../src/commands/activate.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { emptyCatalog } from "../src/config/models.ts";
import type { CacheKeepaliveSetting } from "../src/config/models.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { Message } from "../src/engine/types.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import { testTmp } from "./support/tmp.ts";

const CHARACTER = "ada";
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);

function keepaliveEvery(spelling: string): CacheKeepaliveSetting {
  const parsed = ConfigDuration.parse(spelling);
  if ("err" in parsed) throw new Error(parsed.err);
  return { kind: "every", interval: parsed.ok };
}

function fixtureModel(keepalive: CacheKeepaliveSetting | "off"): unknown {
  return {
    name: "fixture",
    qualifiedName: "chat.fixture",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-fixture",
    apiKeyEnv: "SHORE_FIXTURE_API_KEY",
    maxContextTokens: 200_000,
    maxOutputTokens: 4096,
    maxToolIterations: 4,
    ...(keepalive === "off" ? {} : { cacheKeepalive: keepalive }),
  };
}

function message(role: Message["role"], content: string): Message {
  return {
    msg_id: `m_${role}_${content.length}`,
    role,
    content,
    images: [],
    content_blocks: [{ type: "text", text: content }],
    alternatives: [],
    timestamp: "2026-08-08T07:00:00-05:00",
  };
}

const BETWEEN_TURNS: Message[] = [message("user", "hello"), message("assistant", "hi there")];

const MID_TURN: Message[] = [message("user", "hello")];

async function world(
  messages: Message[],
  keepalive: CacheKeepaliveSetting | "off" = keepaliveEvery("55m"),
): Promise<{ config: LoadedConfig; dataDir: string }> {
  const root = await mkdtemp(testTmp("shore-activate-"));
  const dirs = {
    config: join(root, "config"),
    data: root,
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const workspace = join(dirs.config, "characters", CHARACTER, "workspace");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), "# ada\n\nA fixture character.\n");
  await writeFile(join(workspace, "MEMORY.md"), "- nothing yet\n");

  const charDir = join(dirs.data, CHARACTER);
  await mkdir(charDir, { recursive: true });
  await writeFile(
    join(charDir, "active.jsonl"),
    messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length === 0 ? "" : "\n"),
  );

  const app = defaultAppConfig();
  app.defaults.model = "fixture";
  const models = emptyCatalog();
  models.chat.set("chat.fixture", fixtureModel(keepalive) as never);

  return {
    dataDir: dirs.data,
    config: { app, models, providers: ProviderRegistry.empty(), dirs, rawTable: undefined },
  };
}

function usage(read: number, written: number): GenerateResponse["usage"] {
  return {
    input_tokens: 12,
    output_tokens: 1,
    cache_read_tokens: read,
    cache_creation_tokens: written,
  };
}

function response(read: number, written: number): GenerateResponse {
  return {
    model: "claude-fixture",
    finish_reason: "end_turn",
    usage: usage(read, written),
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    tool_uses: [],
    content_blocks: [{ type: "text", text: "." }],
  } as unknown as GenerateResponse;
}

class NoopExecutor implements AutonomyExecutor {
  async runHeartbeatTick(): Promise<AutonomyActionResult> {
    return { events: [] };
  }
  async runCompaction(): Promise<AutonomyActionResult> {
    return { events: [] };
  }
  async runDeepArchive(): Promise<AutonomyActionResult> {
    return { events: [] };
  }
  async runDream(): Promise<AutonomyActionResult> {
    return { events: [] };
  }
}

interface Harness {
  activate: () => Promise<{ character: string; registered: boolean; keepalive: KeepaliveActivation; heartbeat: unknown }>;
  sent: SidecarRequest[];
  tick: () => Promise<void>;
  advance: (ms: number) => void;
  cache: LastRequestCache;
  config: LoadedConfig;
  dataDir: string;
}

async function harnessFor(
  messages: Message[],
  keepalive: CacheKeepaliveSetting | "off" = keepaliveEvery("55m"),
): Promise<Harness> {
  const { config, dataDir } = await world(messages, keepalive);
  let clock = T0;

  const sent: SidecarRequest[] = [];
  let reply = response(0, 5000);
  const keepaliveService = new KeepaliveService(
    async (req) => {
      sent.push(req);
      return reply;
    },
    () => clock,
  );
  const cache = new LastRequestCache(keepaliveService);
  const autonomy = new AutonomyService(new NoopExecutor(), () => clock);
  const bridge = new TurnAutonomyBridge(autonomy, () => clock);

  return {
    sent,
    cache,
    config,
    dataDir,
    advance: (ms) => {
      clock += ms;
      reply = response(5000, 0);
    },
    tick: () => keepaliveService.tick(),
    activate: async () =>
      (await sessionActivateCommand(CHARACTER, {
        keepalive: keepaliveService,
        lastRequest: cache,
        autonomy,
        register: async (character, cfg) => {
          const created = bridge.ensureState(character, cfg);
          await bridge.settled(character);
          return created;
        },
        config,
        dataDir,
        now: () => clock,
      })) as Awaited<ReturnType<Harness["activate"]>>,
  };
}

beforeEach(() => {
  process.env["SHORE_FIXTURE_API_KEY"] = "sk-fixture";
});

afterEach(() => {
  delete process.env["SHORE_FIXTURE_API_KEY"];
});

describe("session_activate", () => {
  test("a cold character never pings until it is activated", async () => {
    const h = await harnessFor(BETWEEN_TURNS);

    h.advance(90 * MINUTE);
    await h.tick();
    expect(h.sent.length).toBe(0);

    const activated = await h.activate();
    expect(activated.keepalive.status).toBe("primed");
    expect(h.sent.length).toBe(1);

    h.advance(56 * MINUTE);
    await h.tick();
    expect(h.sent.length).toBe(2);
  });

  test("the priming call reports the cache write it paid for", async () => {
    const h = await harnessFor(BETWEEN_TURNS);
    const activated = await h.activate();

    expect(activated.keepalive).toMatchObject({
      status: "primed",
      wrote_cache: true,
      cache_creation_tokens: 5000,
      cache_read_tokens: 0,
      interval_secs: 3300,
      seconds_until_ping: 3300,
    });
  });

  test("a schedule that is already running is resumed, not re-primed", async () => {
    const h = await harnessFor(BETWEEN_TURNS);
    const built = await rebuildRequestFromDisk(CHARACTER, h.dataDir, h.config, {});
    if (built === undefined) throw new Error("the fixture conversation did not rebuild");
    h.cache.set(CHARACTER, built.request, built.keepalive_interval_ms);

    const activated = await h.activate();

    expect(h.sent.length).toBe(0);
    expect(activated.keepalive).toMatchObject({ status: "resumed", seconds_until_ping: 3300 });
  });

  test("a model with cache_keepalive off is registered but never primed", async () => {
    const h = await harnessFor(BETWEEN_TURNS, "off");
    const activated = await h.activate();

    expect(activated.keepalive).toEqual({ status: "off" });
    expect(h.sent.length).toBe(0);
    expect(activated.registered).toBe(true);
  });

  test("a conversation that cannot be rebuilt is reported, not primed", async () => {
    const h = await harnessFor(MID_TURN);
    const activated = await h.activate();

    expect(activated.keepalive).toEqual({
      status: "unavailable",
      detail: "no cached or rebuildable request",
    });
    expect(h.sent.length).toBe(0);
  });

  test("activation registers the heartbeat clock once", async () => {
    const h = await harnessFor(BETWEEN_TURNS);

    const first = await h.activate();
    expect(first.registered).toBe(true);
    expect(first.heartbeat).toMatchObject({ state: "Active" });

    const second = await h.activate();
    expect(second.registered).toBe(false);
  });
});
