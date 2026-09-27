import { readdir } from "./support/stored_files.ts";
import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import type { KeepaliveArming } from "../src/cache/last_request.ts";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyReloadedConfig,
  buildCommandPathDeps,
  buildGenerationDeps,
  buildMessageHandlerDeps,
  chatCompactionRunner,
  chatToolDeps,
  configReloader,
  generationRegistry,
  handlerNotifier,
  commandChangesState,
  handlerRegistry,
  turnAutonomy,
  planLimitWarnings,
  usageBudgetWarnings,
  type CommandAssembly,
  type HandlerAssembly,
} from "../src/handler/deps.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { CharacterError } from "../src/characters.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import {
  createRuntime,
  mcpConfigView,
  sharedToolDeps,
  type ShoreRuntime,
} from "../src/runtime.ts";
import { buildToolContext, type ToolContextDeps } from "../src/handler/tool_context.ts";
import { dispatchTool } from "../src/tools/dispatch.ts";
import { readSubagentTraces } from "../src/tools/subagent_trace.ts";
import type { McpRegistry } from "../src/tools/mcp_registry.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { configureClaudePlanLimits, refreshClaudePlanLimits } from "../src/ledger/plan_limits.ts";
import { Ledger } from "../src/ledger/store.ts";
import type { SidecarProvider, SidecarRequest, StreamEvent } from "../src/llm/types.ts";

const NO_MCP = () => Promise.reject(new Error("no MCP server should be connected"));

function configFor(
  root: string,
  mutate: (app: ReturnType<typeof defaultAppConfig>) => void = () => {},
): LoadedConfig {
  const app = defaultAppConfig();
  mutate(app);
  return {
    app,
    models: emptyCatalog(),
    providers: ProviderRegistry.empty(),
    dirs: {
      config: join(root, "config"),
      data: join(root, "data"),
      cache: join(root, "cache"),
      runtime: join(root, "runtime"),
    },
    rawTable: undefined,
  };
}

function withCompaction(
  config: LoadedConfig,
  overrides: Partial<LoadedConfig["app"]["memory"]["compaction"]>,
): LoadedConfig {
  return {
    ...config,
    app: {
      ...config.app,
      memory: {
        ...config.app.memory,
        compaction: { ...config.app.memory.compaction, ...overrides },
      },
    },
  };
}

async function writeCharacter(root: string, name: string): Promise<void> {
  const workspace = join(root, "config", "characters", name, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "SOUL.md"), `# ${name}\n`, "utf8");
}

async function runtimeUnder(
  prefix: string,
  mutate: (app: ReturnType<typeof defaultAppConfig>) => void = () => {},
  characters: readonly string[] = [],
): Promise<{ root: string; config: LoadedConfig; runtime: ShoreRuntime }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const name of characters) await writeCharacter(root, name);
  const config = configFor(root, mutate);
  const runtime = await createRuntime({ config, providers: {}, connectMcp: NO_MCP });
  return { root, config, runtime };
}

async function routesToCurrentRegistry(
  runtime: ShoreRuntime,
  view: Pick<McpRegistry, "call">,
): Promise<boolean> {
  let reached = false;
  const stub = {
    call: async () => {
      reached = true;
      return undefined;
    },
  } as unknown as McpRegistry;
  const real = runtime.mcp.replace(stub);
  try {
    await view.call("mcp__anything__at_all", {});
  } finally {
    runtime.mcp.replace(real);
  }
  return reached;
}

function recordingService(gate?: Promise<void>) {
  const calls: string[] = [];
  return {
    calls,
    register: async () => {
      calls.push("register");
      if (gate !== undefined) await gate;
    },
    backfillActivity: () => calls.push("backfill"),
    onUserMessage: () => calls.push("user"),
    onAssistantMessage: (_c: string, turns: number) => calls.push(`assistant:${turns}`),
    setCompactionConfig: () => calls.push("compaction"),
    setHeartbeatConfig: () => {},
    shouldCompactNow: () => undefined,
    onCompactionComplete: () => calls.push("compacted"),
    onCompactionFailed: () => calls.push("failed"),
  };
}

function assemblyFor(runtime: ShoreRuntime): Parameters<typeof chatToolDeps>[0] {
  return {
    runtime,
    providers: {},
    diagnostics: new Diagnostics(),
  };
}

function turnFor(): Parameters<typeof chatToolDeps>[2] {
  return {
    conversation: [],
    send: () => {},
    now: () => "2026-01-01T00:00:00+00:00",
    newMessageId: () => "m_test",
    signal: new AbortController().signal,
  };
}

function withResearch(app: ReturnType<typeof defaultAppConfig>): void {
  app.subagents.set("research", {
    description: "reads things",
    prompt: "you look things up",
    tools: [],
    model: undefined,
    max_iterations: undefined,
    timeout: undefined,
  });
}

async function failureFrom(runtime: ShoreRuntime, deps: ToolContextDeps): Promise<string> {
  const ctx = await buildToolContext(runtime.config, runtime.config.dirs.data, "ada", deps);
  try {
    await dispatchTool("ask_research", { query: "what is the time" }, ctx);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "the subagent somehow ran";
}

async function wakeFailure(config: LoadedConfig, deps: ToolContextDeps): Promise<string> {
  const ctx = await buildToolContext(config, config.dirs.data, "ada", deps);
  try {
    await dispatchTool("set_next_wake", { hours_from_now: 3, reason: "after dinner" }, ctx);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "the wake was scheduled";
}

async function subagentFailure(runtime: ShoreRuntime, character: string): Promise<string> {
  return await failureFrom(runtime, chatToolDeps(assemblyFor(runtime), character, turnFor()));
}

const SUBAGENT_KEY_ENV = "SHORE_DEPS_SUBAGENT_KEY";

const SUBAGENT_MODEL = {
  name: "fixture",
  qualifiedName: "chat.fixture",
  category: "chat",
  providerKey: "openrouter",
  sdk: "openrouter",
  modelId: "model-fixture",
  apiKeyEnv: SUBAGENT_KEY_ENV,
  maxContextTokens: 200_000,
  maxOutputTokens: 4096,
  maxToolIterations: 3,
} as never;

function withQuotingResearch(app: ReturnType<typeof defaultAppConfig>): void {
  app.defaults.model = "fixture";
  app.subagents.set("research", {
    description: "reads things",
    prompt: "You look things up.\n{{active_history:5}}",
    tools: ["roll_dice"],
    model: undefined,
    max_iterations: undefined,
    timeout: undefined,
  });
}

function subagentWorld(root: string): LoadedConfig {
  const config = configFor(root, withQuotingResearch);
  config.models.chat.set("chat.fixture", SUBAGENT_MODEL);
  return {
    ...config,
    providers: ProviderRegistry.fromSection({
      openrouter: { api_key_env: SUBAGENT_KEY_ENV },
    }),
  };
}

function dicerollingProvider(seen: SidecarRequest[]): SidecarProvider {
  let call = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(req: SidecarRequest): AsyncGenerator<StreamEvent> {
      seen.push(req);
      call += 1;
      const usage = {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      };
      const timing = { total_ms: 1, time_to_first_token_ms: 1 };
      yield { type: "start", model: req.model };
      if (call === 1) {
        yield { type: "tool_use", id: "toolu_dice", name: "roll_dice", input: { notation: "1d6" } };
        yield { type: "done", content: "", finish_reason: "tool_use", usage, timing };
        return;
      }
      yield { type: "text", text: "rolled" };
      yield { type: "done", content: "rolled", finish_reason: "end_turn", usage, timing };
    },
    generate: () => {
      throw new Error("a sub-agent streams");
    },
  };
}

function streamingAssembly(
  runtime: ShoreRuntime,
  provider: SidecarProvider,
): Parameters<typeof chatToolDeps>[0] {
  return {
    runtime,
    providers: { openrouter: provider },
    diagnostics: new Diagnostics(),
    env: { [SUBAGENT_KEY_ENV]: "sk-test" },
  };
}

describe("the tool backends a character's turn gets", () => {
  test("a sub-agent is handed the turn it was spawned from, not a bare runner", async () => {
    const { root, runtime } = await runtimeUnder(
      "shore-deps-subagent-turn-",
      withQuotingResearch,
      ["ada"],
    );
    try {
      runtime.registry.setRuntimeEffectiveConfig("ada", subagentWorld(root));

      const frames: ServerMessage[] = [];
      const seen: SidecarRequest[] = [];
      const turn: Parameters<typeof chatToolDeps>[2] = {
        conversation: [
          {
            msg_id: "m_parent",
            role: "user",
            content: "the tide is out at Whitstable",
            images: [],
            content_blocks: [{ type: "text", text: "the tide is out at Whitstable" }],
            alternatives: [],
            timestamp: "2026-01-01T09:00:00+00:00",
          },
        ],
        send: (message: ServerMessage) => frames.push(message),
        rid: "rid-7",
        now: () => "2026-01-01T10:00:00+00:00",
        newMessageId: () => "m_from_the_turn",
        signal: new AbortController().signal,
      };

      const deps = chatToolDeps(streamingAssembly(runtime, dicerollingProvider(seen)), "ada", turn);
      const ctx = await buildToolContext(runtime.config, runtime.config.dirs.data, "ada", deps);
      const answer = await dispatchTool(
        "ask_research",
        { query: "how is the tide" },
        { ...ctx, toolUseId: "toolu_parent" },
      );

      expect(answer).toBe("rolled");

      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect((frame as { subagent?: string }).subagent).toBe("research");
      }
      const rids = frames
        .map((frame) => (frame as { rid?: string | null }).rid)
        .filter((rid) => rid !== null && rid !== undefined);
      expect(rids.length).toBeGreaterThan(0);
      expect([...new Set(rids)]).toEqual(["rid-7"]);

      expect(JSON.stringify(seen[0]?.system)).toContain("the tide is out at Whitstable");

      const traces = await readSubagentTraces(join(root, "data", "ada"));
      expect(traces).toHaveLength(1);
      const reported = traces[0]?.messages ?? [];
      expect(reported.length).toBeGreaterThan(0);
      for (const message of reported) {
        expect(message.msg_id).toBe("m_from_the_turn");
        expect(message.timestamp).toBe("2026-01-01T10:00:00+00:00");
      }
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a deferred edit lands in the character's own directory", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-defer-");
    try {
      const ada = chatToolDeps(assemblyFor(runtime), "ada", turnFor());
      await ada.deferEdit?.("SOUL.md");

      expect(await readdir(join(root, "data", "ada"))).toEqual(["deferred_edits.jsonl"]);
      expect(await readdir(join(root, "data"))).not.toContain("deferred_edits.jsonl");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("two characters queue to two directories", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-defer2-");
    try {
      await chatToolDeps(assemblyFor(runtime), "ada", turnFor()).deferEdit?.("SOUL.md");
      await chatToolDeps(assemblyFor(runtime), "nova", turnFor()).deferEdit?.("USER.md");

      expect(await readdir(join(root, "data", "ada"))).toEqual(["deferred_edits.jsonl"]);
      expect(await readdir(join(root, "data", "nova"))).toEqual(["deferred_edits.jsonl"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the heatmap is asked about this character, and gets the count under its own name", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-activity-");
    try {
      const asked: string[] = [];
      const stubbed = {
        ...runtime,
        autonomy: {
          activityStats: (character: string, _localAt: number, days: number) => {
            asked.push(`${character}:${String(days)}`);
            return character === "ada"
              ? { stats: { hour_histogram: [1] } as never, messageCount: 12 }
              : undefined;
          },
        },
      } as unknown as ShoreRuntime;

      const ada = await buildToolContext(runtime.config, runtime.config.dirs.data, "ada",
        chatToolDeps(assemblyFor(stubbed), "ada", turnFor()));
      const nova = await buildToolContext(runtime.config, runtime.config.dirs.data, "nova",
        chatToolDeps(assemblyFor(stubbed), "nova", turnFor()));
      expect(ada.activityStats?.(30)).toEqual({
        stats: { hour_histogram: [1] } as never,
        turnCount: 12,
      });
      expect(
        nova.activityStats?.(7),
      ).toBeUndefined();
      expect(asked).toEqual(["ada:30", "nova:7"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a subagent's model comes from the character's config, not the global one", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-subagent-model-", withResearch, [
      "ada",
    ]);
    try {
      runtime.registry.setRuntimeEffectiveConfig(
        "ada",
        configFor(root, (app) => {
          withResearch(app);
          app.defaults.subagent_model = "chosen-by-ada";
        }),
      );

      expect(await subagentFailure(runtime, "ada")).toContain("chosen-by-ada");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the heartbeat resolves it the same way the chat path a turn really takes does", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-subagent-", withResearch, [
      "ada",
    ]);
    try {
      runtime.registry.setRuntimeEffectiveConfig(
        "ada",
        configFor(root, (app) => {
          withResearch(app);
          app.defaults.subagent_model = "chosen-by-ada";
        }),
      );

      const chat = chatToolDeps(assemblyFor(runtime), "ada", turnFor());
      const heartbeat = sharedToolDeps(runtime.config, runtime.mcp, runtime.autonomy, {
        providers: {},
        registry: runtime.registry,
      });

      const fromHeartbeat = await failureFrom(runtime, heartbeat);
      expect(fromHeartbeat).toEqual(await failureFrom(runtime, chat));
      expect(fromHeartbeat).not.toContain("has no model");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the shared backends come along, so chat is not offered less than a heartbeat", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-shared-");
    try {
      const ada = chatToolDeps(assemblyFor(runtime), "ada", turnFor());
      expect(ada.mcpRegistry).toBeDefined();
      expect(await routesToCurrentRegistry(runtime, required(ada.mcpRegistry))).toBe(true);
      expect(ada.imageGenerator).toBeDefined();
      expect(ada.modelHistoryQuery).toBeDefined();
      expect(ada.runSubagent).toBeDefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat turn's set_next_wake moves that character's heartbeat, and logs why", async () => {
    const hour = 3_600_000;
    const { root, config, runtime } = await runtimeUnder(
      "shore-deps-wake-",
      (app) => {
        app.behavior.autonomy.enabled = true;
      },
      ["ada", "nova"],
    );
    try {
      const bridge = new TurnAutonomyBridge(runtime.autonomy);
      for (const character of ["ada", "nova"]) {
        bridge.ensureState(character, config);
        await bridge.settled(character);
      }
      const novaBefore = runtime.autonomy.status("nova")?.next_wake_at;
      const ctx = await buildToolContext(config, config.dirs.data, "ada", chatToolDeps(assemblyFor(runtime), "ada", turnFor()));

      const before = Date.now();
      expect(await dispatchTool("set_next_wake", { hours_from_now: 3, reason: "after dinner" }, ctx)).toBe(
        "Scheduled next moment in 3.0 hours.",
      );

      expect(runtime.autonomy.status("ada")?.next_wake_at).toBeGreaterThanOrEqual(before + 3 * hour);
      expect(runtime.autonomy.status("ada")?.next_wake_at).toBeLessThanOrEqual(Date.now() + 3 * hour);
      expect(JSON.stringify(runtime.autonomy.status("ada")?.recent_events)).toContain(
        "set_next_wake: 3.0h - after dinner",
      );
      expect(runtime.autonomy.status("nova")?.next_wake_at).toBe(novaBefore);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with heartbeats off, a chat turn's set_next_wake is told so and moves nothing", async () => {
    const { root, config, runtime } = await runtimeUnder("shore-deps-wake-off-", () => {}, ["ada"]);
    try {
      const bridge = new TurnAutonomyBridge(runtime.autonomy);
      bridge.ensureState("ada", config);
      await bridge.settled("ada");
      const before = runtime.autonomy.status("ada")?.next_wake_at;

      expect(await wakeFailure(config, chatToolDeps(assemblyFor(runtime), "ada", turnFor()))).toBe(
        "io: heartbeats are not running for this character",
      );
      expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(before);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat turn's set_next_wake answers from the runner, not from config it has not picked up", async () => {
    const { root, config, runtime } = await runtimeUnder("shore-deps-wake-stale-", () => {}, ["ada"]);
    try {
      const bridge = new TurnAutonomyBridge(runtime.autonomy);
      bridge.ensureState("ada", config);
      await bridge.settled("ada");
      const before = runtime.autonomy.status("ada")?.next_wake_at;
      config.app.behavior.autonomy.enabled = true;

      expect(await wakeFailure(config, chatToolDeps(assemblyFor(runtime), "ada", turnFor()))).toBe(
        "io: heartbeats are not running for this character",
      );
      expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(before);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("background work gets no heartbeat schedule of its own", async () => {
    const { root, config, runtime } = await runtimeUnder(
      "shore-deps-wake-background-",
      (app) => {
        app.behavior.autonomy.enabled = true;
      },
      ["ada"],
    );
    try {
      const background = sharedToolDeps(runtime.config, runtime.mcp, runtime.autonomy);

      expect(await wakeFailure(config, background)).toBe(
        "io: the heartbeat schedule is not available in this context",
      );
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the autonomy surface a turn drives", () => {
  test("the cached request is set at once, without waiting on a registration", () => {
    const cached: Array<[string, number | undefined]> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = new TurnAutonomyBridge(recordingService(gate));
    const autonomy = turnAutonomy(bridge, {
      set: (character: string, _request: unknown, keepalive?: KeepaliveArming) =>
        cached.push([character, keepalive?.intervalMs]),
    });

    autonomy.ensureState("ada", configFor("/tmp/shore-deps-none"));
    autonomy.notifyLastRequest("ada", { model: "m", messages: [] }, {
      intervalMs: 55 * 60_000,
      pings: undefined,
    });

    expect(cached, "the cadence rides along, or the armed prefix has none").toEqual([
      ["ada", 55 * 60_000],
    ]);
    release();
  });

  test("the ping count rides along with the cadence, not just the cadence", () => {
    const cached: Array<KeepaliveArming | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = new TurnAutonomyBridge(recordingService(gate));
    const autonomy = turnAutonomy(bridge, {
      set: (_character: string, _request: unknown, keepalive?: KeepaliveArming) =>
        cached.push(keepalive),
    });

    autonomy.ensureState("ada", configFor("/tmp/shore-deps-none"));
    autonomy.notifyLastRequest("ada", { model: "m", messages: [] }, {
      intervalMs: 10 * 60_000,
      pings: 3,
    });

    expect(cached).toEqual([{ intervalMs: 10 * 60_000, pings: 3 }]);
    release();
  });

  test("the turn's thread rides along, so a home thread off main is armed as itself", () => {
    const threads: Array<string | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = new TurnAutonomyBridge(recordingService(gate));
    const autonomy = turnAutonomy(bridge, {
      set: (_character: string, _request: unknown, _keepalive?: KeepaliveArming, _warm?: boolean, thread?: string) =>
        threads.push(thread),
    });

    autonomy.ensureState("ada", configFor("/tmp/shore-deps-none"));
    autonomy.notifyLastRequest("ada", { model: "m", messages: [] }, {
      intervalMs: 10 * 60_000,
      pings: undefined,
    }, "garden");

    expect(threads).toEqual(["garden"]);
    release();
  });

  test("the assistant turn waits for the registration it followed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = recordingService(gate);
    const bridge = new TurnAutonomyBridge(service);
    const autonomy = turnAutonomy(bridge, { set: () => {} });

    autonomy.ensureState("ada", configFor("/tmp/shore-deps-none"));
    autonomy.notifyAssistantMessage("ada", 7);

    expect(service.calls).toEqual(["register"]);
    release();
    await bridge.settled("ada");
    expect(service.calls).toEqual(["register", "assistant:7"]);
  });
});

describe("the compaction a long turn runs inline", () => {
  test("the source is rebuilt from disk without consulting the stale request cache", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-compact-");
    try {
      const asked: string[] = [];
      const stubbed = {
        ...runtime,
        cache: {
          get: (character: string) => {
            asked.push(character);
            return undefined;
          },
        },
      } as unknown as ShoreRuntime;

      const runner = chatCompactionRunner({
        runtime: stubbed,
        providers: {},
        autonomy: new TurnAutonomyBridge(recordingService()),
        emitEvent: () => {},
        diagnostics: { api_calls: { push: () => {} } } as never,
      });

      await runner.run("nova", runtime.config).catch(() => undefined);
      expect(asked).toEqual([]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the budget check", () => {
  test("does not open the ledger when no budget is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "shore-deps-budget-"));
    try {
      const errors: string[] = [];
      const real = console.error;
      console.error = (msg: unknown) => errors.push(String(msg));
      try {
        const warnings = usageBudgetWarnings(
          join(root, "absent.db"),
          () => ({ budgets: [] }),
          undefined,
        );
        expect(await warnings("aria")).toEqual([]);
      } finally {
        console.error = real;
      }
      expect(errors).toEqual([]);
      expect(
        existsSync(join(root, "absent.db")),
        "an empty budget list must not cost a file open",
      ).toBe(false);
    } finally {
      closeLedgers();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a ledger that cannot be opened reports no warnings rather than failing the turn", async () => {
    const errors: string[] = [];
    const real = console.error;
    console.error = (msg: unknown) => errors.push(String(msg));
    try {
      const warnings = usageBudgetWarnings(
        "/nonexistent-shore-dir/nested/absent.db",
        () => ({ budgets: [{ cost_usd: 5 }] }),
        undefined,
      );
      expect(await warnings("aria")).toEqual([]);
    } finally {
      console.error = real;
      closeLedgers();
    }
  });

  test("does open it once a budget exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "shore-deps-budget2-"));
    try {
      const errors: string[] = [];
      const real = console.error;
      console.error = (msg: unknown) => errors.push(String(msg));
      try {
        const warnings = usageBudgetWarnings(
          join(root, "absent.db"),
          () => ({ budgets: [{ cost_usd: 5 }] }),
          undefined,
        );
        expect(await warnings("aria")).toEqual([]);
      } finally {
        console.error = real;
      }
      expect(errors).toEqual([]);
      const ledger = Ledger.open(join(root, "absent.db"));
      expect(ledger.database.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='calls'",
      ).get()).toEqual({ name: "calls" });
      ledger.close();
    } finally {
      closeLedgers();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a Claude plan reading warns even for a character with no usage config", async () => {
    const root = await mkdtemp(join(tmpdir(), "shore-deps-plan-"));
    const resets = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    try {
      configureClaudePlanLimits({
        fetch: () => Promise.resolve({ subscription_type: "max", five_hour: { percent_used: 0.9, resets_at: resets }, seven_day: null }),
      });
      await refreshClaudePlanLimits(0);
      const warnings = planLimitWarnings(join(root, "shore.db"), () => undefined, undefined);
      const first = await warnings("aria");
      expect(first.map((warning) => [warning.limit, warning.window, warning.crossed_warn_at])).toEqual([["Claude 5-hour limit", "five_hour", [0.8]]]);
      expect(await warnings("aria"), "each threshold is announced once per window").toEqual([]);
    } finally {
      configureClaudePlanLimits();
      closeLedgers();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("what the assembly hands the driver", () => {
  test("the ledger is the one the runtime created", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-assembly-");
    try {
      const deps = buildGenerationDeps({
        runtime,
        providers: {},
        autonomy: new TurnAutonomyBridge(recordingService()),
        emitEvent: () => {},
        diagnostics: { api_calls: { push: () => {} } } as never,
      });

      expect(deps.ledgerPath).toBe(join(root, "data", "shore.db"));
      expect(deps.dataDir).toBe(join(root, "data"));
      expect(deps.notifier).toBe(runtime.notifier);
      expect(await routesToCurrentRegistry(runtime, deps.mcpRegistry)).toBe(true);
      expect(deps.mcpRegistry.toolDefsFiltered(["*"])).toEqual([]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("budget warnings come from the character's config, not the global one", async () => {
    const { root, config, runtime } = await runtimeUnder(
      "shore-deps-charbudget-",
      () => {},
      ["ada", "nova"],
    );
    try {
      const deps = buildGenerationDeps({
        runtime,
        providers: {},
        autonomy: new TurnAutonomyBridge(recordingService()),
        emitEvent: () => {},
        diagnostics: { api_calls: { push: () => {} } } as never,
      });

      await mkdir(join(root, "data"), { recursive: true });
      const ledger = Ledger.open(join(root, "data", "shore.db"));
      for (const character of ["ada", "nova"]) {
        ledger.database.query(
          `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
           VALUES (?1, ?2, 'anthropic', 'default', 'claude-opus-4-6', 'message',
             10, 5, 0, 0, 100, 10, 'end_turn', 1, 'pricing_catalog', 5.0)`,
        ).run(new Date().toISOString(), character);
      }
      ledger.close();

      runtime.registry.setRuntimeEffectiveConfig("ada", {
        ...config,
        app: {
          ...config.app,
          usage: {
            ...config.app.usage,
            budgets: [
              {
                name: "ada-only",
                period: "month",
                cost_usd: 1.0,
                warn_at: [1.0],
                limit: "block",
                character: "ada",
                usage_kind: [],
              } as never,
            ],
          },
        },
      });

      expect(
        (await deps.newlyCrossedUsageBudgetWarnings("ada")).map((w) => w.budget),
      ).toEqual(["ada-only"]);

      expect(await deps.newlyCrossedUsageBudgetWarnings("nova")).toEqual([]);
    } finally {
      closeLedgers();
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the engine a turn gets can count its segments", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-engine-", () => {}, ["ada"]);
    try {
      const registry = generationRegistry(runtime.registry);
      const engine = await registry.getOrCreate("ada");

      expect(engine.segmentCount()).toBe(0);
      expect(registry.effectiveConfig("ada").dirs.data).toBe(runtime.config.dirs.data);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the handler, whole", () => {
  function handlerAssembly(runtime: ShoreRuntime): HandlerAssembly {
    return {
      runtime,
      autonomy: new TurnAutonomyBridge(recordingService()),
      diagnostics: { api_calls: { push: () => {} } } as never,
      router: new SessionRouter(),
      handshake: {
        hello: () => Promise.resolve({} as never),
        history: () => Promise.resolve({} as never),
      },
      providers: {},
      emitEvent: () => {},
    };
  }

  test("every field the router reads is present", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-handler-");
    try {
      const a = handlerAssembly(runtime);
      const deps = buildMessageHandlerDeps(a);

      expect(deps.router).toBe(a.router);
      expect(typeof deps.dispatchCommand).toBe("function");
      expect(typeof deps.runGeneration).toBe("function");
      expect(deps.commandChangesState).toBe(commandChangesState);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("with no embedding model configured the indexer says so instead of waiting", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-noembed-", () => {}, ["ada"]);
    try {
      const progress = runtime.workspaceIndex.progress("ada");
      expect(progress?.sweptAt).toBeUndefined();
      expect(progress?.embedderError).toContain("no embedding model configured");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a chat turn holds the workspace indexer off, not just the history one", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-foreground-");
    try {
      const held: string[] = [];
      const released: string[] = [];
      const watch = (name: string, service: { beginForeground: () => () => void }) => {
        service.beginForeground = () => {
          held.push(name);
          return () => released.push(name);
        };
      };
      watch("history", runtime.historyIndex);
      watch("workspace", runtime.workspaceIndex);

      const deps = buildMessageHandlerDeps(handlerAssembly(runtime));
      await deps
        .dispatchCommand({ name: "status" } as never, {} as never, new AbortController().signal)
        .catch(() => undefined);

      expect(held).toEqual(["history", "workspace"]);
      expect(released).toEqual(["history", "workspace"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a command that takes the snapshot itself is not first held as a reader", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-exclusive-", () => {}, ["ada"]);
    try {
      const deps = buildMessageHandlerDeps(handlerAssembly(runtime));

      const frame = await deps.dispatchCommand(
        {
          rid: null,
          name: "delete_character",
          args: { character: "ada", confirm: "ada" },
        },
        { session: { sessionId: 1, selectedCharacter: null, selectedThread: null } } as never,
        new AbortController().signal,
      );

      expect(frame.type).toBe("command_output");
      expect(existsSync(join(root, "config", "characters", "ada"))).toBe(false);
      expect(runtime.registry.hasCharacter("ada")).toBe(false);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("only commands that change state survive their client disconnecting", () => {
    const command = (name: string, args: unknown = {}) => ({ type: "command" as const, name, args });
    expect(commandChangesState(command("compact"))).toBe(true);
    expect(commandChangesState(command("archive_thread", { name: "side" }))).toBe(true);
    expect(commandChangesState(command("status"))).toBe(false);
    expect(commandChangesState(command("switch_thread", { name: "side" }))).toBe(false);
    expect(commandChangesState(command("no_such_command"))).toBe(true);
  });
});

describe("resolving a character for the router", () => {
  test("a conversation is named by its live thread, so an unset thread means home", () => {
    const registry = handlerRegistry({
      resolveCharacter: (r) => r ?? "ada",
      homeThread: () => "main",
      listThreads: () => [{ id: "main" }, { id: "side" }] as never,
    });
    expect(registry.resolveThread?.("ada", null)).toBe("main");
    expect(registry.resolveThread?.("ada", "side")).toBe("side");
    expect(registry.resolveThread?.("ada", "gone")).toBe("main");
  });

  test("the only character is chosen when none was selected", () => {
    const registry = handlerRegistry({ resolveCharacter: (r) => r ?? "ada" });
    expect(registry.resolveCharacter(null)).toEqual({ name: "ada" });
  });

  test("`null` is asked as an absence, not as a character called that", () => {
    const seen: (string | undefined)[] = [];
    const registry = handlerRegistry({
      resolveCharacter: (r) => {
        seen.push(r);
        return "ada";
      },
    });
    registry.resolveCharacter(null);
    registry.resolveCharacter("");
    expect(seen).toEqual([undefined, ""]);
  });

  test("the registry's own sentence travels as a message rather than a throw", () => {
    const registry = handlerRegistry({
      resolveCharacter: () => {
        throw CharacterError.notFound("zed", ["ada", "nova"]);
      },
    });

    const answer = registry.resolveCharacter("zed");
    expect(answer).toHaveProperty("error");
    expect((answer as { error: string }).error).toContain("zed");
    expect((answer as { error: string }).error).toContain("ada");
  });

  test("anything else is stringified, not rethrown", () => {
    const registry = handlerRegistry({
      resolveCharacter: () => {
        throw new Error("the disk went away");
      },
    });
    expect(registry.resolveCharacter("ada")).toEqual({ error: "Error: the disk went away" });
  });
});

describe("the router's notifier", () => {
  test("files under the event whose toggle it obeys", () => {
    const filed: string[] = [];
    const notifier = handlerNotifier({
      notify: (event, title, body) => filed.push(`${event}:${title}:${body}`),
    });

    notifier.notify("error", "Shore - ada", "the model refused");
    expect(filed).toEqual(["error:Shore - ada:the model refused"]);
  });
});

describe("the command path", () => {
  test("config refresh preserves a session's selected side thread", async () => {
    const { root, runtime } = await runtimeUnder("reload-side-thread-", () => {}, ["ada"]);
    try {
      await runtime.registry.createThread("ada", "side");
      const requested: (string | null | undefined)[] = [];
      const router = new SessionRouter();
      router.registerSession({ id: 1, character: "ada", thread: "side", capabilities: [], clientType: "cli", clientName: "test" }, async () => {});
      await applyReloadedConfig(commandAssembly(runtime, {
        router,
        handshake: { hello: () => ({}) as never, history: (_character, thread) => {
          requested.push(thread);
          return Promise.resolve({} as never);
        } },
      }), runtime.registry.globalConfig());
      expect(requested).toEqual(["side"]);
    } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  function commandAssembly(runtime: ShoreRuntime, extra: Partial<CommandAssembly> = {}) {
    return {
      runtime,
      autonomy: new TurnAutonomyBridge(recordingService()),
      diagnostics: { api_calls: { push: () => {} } } as never,
      router: new SessionRouter(),
      handshake: { hello: () => ({}) as never, history: () => Promise.resolve({} as never) },
      providers: {},
      ...extra,
    } satisfies CommandAssembly;
  }

  test("the reload path names the file the daemon was started from", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-path-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      expect(deps.configPath).toBe(join(root, "config", "config.toml"));
      expect(deps.dispatchRuntime.reloadGlobalConfig()).toBeDefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a config that stopped parsing drops the annotation rather than failing", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-broken-");
    try {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(join(root, "config", "config.toml"), "definitely = not [ toml", "utf8");

      const deps = buildCommandPathDeps(commandAssembly(runtime));
      const warned: string[] = [];
      const real = console.warn;
      console.warn = (msg: unknown) => warned.push(String(msg));
      try {
        expect(deps.dispatchRuntime.reloadGlobalConfig()).toBeUndefined();
      } finally {
        console.warn = real;
      }
      expect(warned.join(" ")).toContain("could not re-read");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a hot reload the daemon refuses is told to the clients, not just the log", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-warn-");
    try {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(join(root, "config", "config.toml"), "definitely = not [ toml", "utf8");

      const emitted: ServerMessage[] = [];
      const reload = configReloader({
        ...commandAssembly(runtime),
        emitEvent: (message) => emitted.push(message),
      });

      const real = console.warn;
      console.warn = () => {};
      try {
        await reload([join(root, "config", "config.toml")]);
      } finally {
        console.warn = real;
      }

      expect(emitted).toHaveLength(1);
      const warning = emitted[0] as Extract<ServerMessage, { type: "config_warning" }>;
      expect(warning.type).toBe("config_warning");
      expect(warning.path).toBe(join(root, "config", "config.toml"));
      expect(warning.character).toBeUndefined();
      expect(warning.message.length).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a broken character overlay names the character and its own file", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-warn-char-", () => {}, ["ada"]);
    try {
      const overlay = join(root, "config", "characters", "ada", "config.toml");
      await writeFile(overlay, "definitely = not [ toml", "utf8");

      const emitted: ServerMessage[] = [];
      const reload = configReloader({
        ...commandAssembly(runtime),
        emitEvent: (message) => emitted.push(message),
      });

      const real = console.warn;
      console.warn = () => {};
      try {
        await reload([overlay]);
      } finally {
        console.warn = real;
      }

      expect(emitted).toHaveLength(1);
      const warning = emitted[0] as Extract<ServerMessage, { type: "config_warning" }>;
      expect(warning.character).toBe("ada");
      expect(warning.path).toBe(overlay);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("adopting a reloaded config re-scans, and tells every registered character", async () => {
    const { root, config, runtime } = await runtimeUnder(
      "shore-deps-cmd-adopt-",
      () => {},
      ["ada"],
    );
    try {
      const bridge = new TurnAutonomyBridge(recordingService());
      const deps = buildCommandPathDeps(commandAssembly(runtime, { autonomy: bridge }));

      bridge.ensureState("ada", config);
      await bridge.settled("ada");

      await writeCharacter(root, "nova");
      const summary = await deps.dispatchRuntime.applyReloadedConfig(config);
      await bridge.settled("ada");

      expect(summary.characterDiscoveryChanged).toBe(true);
      expect(runtime.registry.availableCharacters()).toEqual(["ada", "nova"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applying config reload updates heartbeat status and existing schedules", async () => {
    const hour = 3_600_000;
    const { root, config, runtime } = await runtimeUnder("shore-heartbeat-reload-", () => {}, ["ada", "nova"]);
    try {
      const bridge = new TurnAutonomyBridge(runtime.autonomy);
      const deps = buildCommandPathDeps(commandAssembly(runtime, { autonomy: bridge }));
      for (const character of ["ada", "nova"]) {
        bridge.ensureState(character, config);
        await bridge.settled(character);
      }
      runtime.autonomy.scheduleNextWake("ada", 47, "later");
      const clock = required(runtime.autonomy.runnerFor("nova")).clock;
      clock.tick(Date.now());
      const before = Date.now();
      const updated = configFor(root, (app) => {
        const heartbeat = app.behavior.autonomy.heartbeat;
        heartbeat.default_interval = ConfigDuration.fromSecs(90 * 60);
        heartbeat.min_interval = ConfigDuration.fromSecs(20 * 60);
        heartbeat.max_interval = ConfigDuration.fromSecs(2 * 3600);
      });
      await deps.dispatchRuntime.applyReloadedConfig(updated);
      await bridge.settled("ada");
      await bridge.settled("nova");
      expect(runtime.autonomy.status("ada")).toMatchObject({
        default_interval_ms: 1.5 * hour,
        min_interval_ms: hour / 3,
        max_interval_ms: 2 * hour,
      });
      expect(runtime.autonomy.status("ada")?.next_wake_at).toBeGreaterThanOrEqual(before + 2 * hour);
      expect(runtime.autonomy.status("ada")?.next_wake_at).toBeLessThanOrEqual(Date.now() + 2 * hour);
      expect(clock.nextWakeAt).toBeGreaterThan(before + 1.5 * hour - 1000);
      expect(clock.nextWakeAt).toBeLessThanOrEqual(Date.now() + 1.5 * hour);
      expect(runtime.autonomy.scheduleNextWake("ada", 0, "soon")).toBeCloseTo(1 / 3);
      const deadline = runtime.autonomy.status("ada")?.next_wake_at;
      await deps.dispatchRuntime.applyReloadedConfig(updated);
      await bridge.settled("ada");
      expect(runtime.autonomy.status("ada")?.next_wake_at).toBe(deadline);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a refreshed prompt snapshot drops the cached body", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-prompt-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      runtime.cache.set("ada", { model: "m", messages: [] } as never, undefined);
      expect(runtime.cache.get("ada")).toBeDefined();

      deps.runtime.notifyPromptSnapshotRefreshed("ada");

      expect(runtime.cache.get("ada")).toBeUndefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a model change disarms the old keepalive before rebuilding its request", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-model-change-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      runtime.cache.set(
        "ada",
        {
          sdk: "anthropic",
          model: "claude-old",
          provider_options: { cache_ttl: "1h" },
          api_key: "",
          messages: [],
          max_tokens: 128,
          replay_prior_thinking: "all",
        },
        { intervalMs: 55 * 60_000, pings: undefined },
      );
      expect(runtime.keepalive.nextPingAt("ada")).toBeDefined();

      await deps.dispatchRuntime.refreshCachedRequest("ada");

      expect(runtime.cache.get("ada")).toBeUndefined();
      expect(runtime.keepalive.nextPingAt("ada")).toBeUndefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the home thread comes from the registry, so moving home moves the heartbeat", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-home-", () => {}, ["ada"]);
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));

      expect(deps.dispatchRuntime.homeThread("ada")).toBe("main");

      await runtime.registry.createThread("ada", "eval");
      await runtime.registry.setHomeThread("ada", "eval");

      expect(deps.dispatchRuntime.homeThread("ada")).toBe("eval");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a `config` set reaches the registry and the loop", async () => {
    const { root, config, runtime } = await runtimeUnder("shore-deps-cmd-set-", () => {}, ["ada"]);
    try {
      const service = recordingService();
      const bridge = new TurnAutonomyBridge(service);
      const deps = buildCommandPathDeps(commandAssembly(runtime, { autonomy: bridge }));

      bridge.ensureState("ada", config);
      await bridge.settled("ada");

      const overridden = withCompaction(config, { max_turns: 77 });
      await deps.dispatchRuntime.setEffectiveConfig("ada", overridden);
      deps.dispatchRuntime.reloadRuntimeConfig(overridden);
      await bridge.settled("ada");

      expect(runtime.registry.effectiveConfig("ada").app.memory.compaction.max_turns).toBe(77);
      expect(service.calls).toContain("compaction");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("adopting a config makes the live readers behind it see the new value", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-adopt-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      const before = runtime.registry.globalConfig();
      const fresh: LoadedConfig = {
        ...before,
        app: {
          ...before.app,
          memory: {
            ...before.app.memory,
            compaction: { ...before.app.memory.compaction, idle_trigger: ConfigDuration.fromSecs(4242) },
          },
        },
      };

      deps.runtime.adoptGlobalConfig(fresh);

      expect(
        Number(runtime.registry.globalConfig().app.memory.compaction.idle_trigger.asSecs()),
      ).toBe(4242);
      expect(
        Number(runtime.registry.effectiveConfig("ada").app.memory.compaction.idle_trigger.asSecs()),
      ).toBe(4242);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the compaction command can repoint the live request cache", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-compact-");
    try {
      runtime.cache.set("ada", { model: "m", messages: [] } as never, undefined);
      const deps = buildCommandPathDeps(commandAssembly(runtime));

      expect(deps.commands.compaction?.repoint).toBeFunction();
      expect(deps.commands.keepalive?.lastRequest).toBe(runtime.cache);
      expect(deps.commands.keepalive?.keepalive).toBe(runtime.keepalive);
      expect(deps.commands.callStore).toBe(runtime.callStore);
      expect(deps.commands.ledgerPath).toBe(join(root, "data", "shore.db"));
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("reloading [mcp]", () => {
  function assemblyOf(runtime: ShoreRuntime): CommandAssembly {
    return {
      runtime,
      autonomy: new TurnAutonomyBridge(recordingService()),
      diagnostics: { api_calls: { push: () => {} } } as never,
      router: new SessionRouter(),
      handshake: { hello: () => ({}) as never, history: () => Promise.resolve({} as never) },
      providers: {},
    } satisfies CommandAssembly;
  }

  function fakeServer(tool: string) {
    let shutdowns = 0;
    const connect = (spec: { name: string }) =>
      Promise.resolve({
        listTools: () =>
          Promise.resolve([
            { server: spec.name, name: tool, description: `the ${tool} tool`, input_schema: {} },
          ]),
        call: () => Promise.resolve(`${tool} ran`),
        shutdown: () => {
          shutdowns += 1;
          return Promise.resolve();
        },
      } as never);
    return { connect, shutdowns: () => shutdowns };
  }

  function withServer(app: ReturnType<typeof defaultAppConfig>, name: string, command: string) {
    app.mcp.set(name, {
      command,
      args: [],
      env: new Map(),
      cwd: undefined,
      url: undefined,
      headers: new Map(),
      bearer_token_env: undefined,
    });
  }

  async function runtimeWithMcp(server: ReturnType<typeof fakeServer>, command = "hue-server") {
    const root = await mkdtemp(join(tmpdir(), "shore-mcp-reload-"));
    const config = configFor(root, (app) => withServer(app, "hue", command));
    const runtime = await createRuntime({ config, providers: {}, connectMcp: server.connect });
    return { root, config, runtime };
  }

  test("a changed [mcp] reconnects and swaps the surface", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      expect(runtime.mcp.current.toolDefsFiltered(["*"]).map((t) => t.name)).toEqual([
        "mcp__hue__set_light",
      ]);

      const fresh = configFor(root, (app) => withServer(app, "hue", "hue-server-v2"));
      await applyReloadedConfig(assemblyOf(runtime), fresh);

      expect(runtime.mcp.current.matchesConfig(mcpConfigView(fresh))).toBe(true);
      expect(server.shutdowns()).toBe(1);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unrelated reload leaves the connections alone", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      const before = runtime.mcp.current;
      const fresh = configFor(root, (app) => {
        withServer(app, "hue", "hue-server");
        app.memory.compaction.enabled = !app.memory.compaction.enabled;
      });
      await applyReloadedConfig(assemblyOf(runtime), fresh);

      expect(runtime.mcp.current).toBe(before);
      expect(server.shutdowns()).toBe(0);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a removed server drops its tools", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      const fresh = configFor(root);
      await applyReloadedConfig(assemblyOf(runtime), fresh);

      expect(runtime.mcp.current.toolDefsFiltered(["*"])).toEqual([]);
      expect(server.shutdowns()).toBe(1);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removing every server on purpose does empty the surface", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      await applyReloadedConfig(assemblyOf(runtime), configFor(root));
      expect(runtime.mcp.current.connectedServers()).toBe(0);
      expect(server.shutdowns()).toBe(1);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a turn already in flight dispatches to the new registry", async () => {
    const first = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(first);
    try {
      const inFlight = chatToolDeps(assemblyFor(runtime), "ada", turnFor());

      const second = fakeServer("set_light");
      const fresh = configFor(root, (app) => withServer(app, "hue", "hue-server-v2"));
      await applyReloadedConfig(
        assemblyOf({ ...runtime, connectMcp: second.connect }),
        fresh,
      );

      expect(required(inFlight.mcpRegistry).call("mcp__hue__set_light", {})).resolves.toBe(
        "set_light ran",
      );
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed [mcp] drops the cached request that still holds the old tool surface", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      runtime.cache.set(
        "ada",
        {
          sdk: "anthropic",
          model: "claude-fixture",
          messages: [],
          tools: [{ name: "mcp__hue__set_light", description: "the old surface", input_schema: {} }],
        } as never,
        undefined,
      );
      expect(runtime.cache.get("ada")?.tools?.map((t) => t.name)).toEqual([
        "mcp__hue__set_light",
      ]);

      const fresh = configFor(root, (app) => withServer(app, "hue", "hue-server-v2"));
      await applyReloadedConfig(assemblyOf(runtime), fresh);

      expect(runtime.cache.get("ada")?.tools).not.toEqual([
        { name: "mcp__hue__set_light", description: "the old surface", input_schema: {} },
      ]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unrelated reload leaves the cached request in place", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      const body = { sdk: "anthropic", model: "claude-fixture", messages: [], tools: [] } as never;
      runtime.cache.set("ada", body, undefined);

      const fresh = configFor(root, (app) => {
        withServer(app, "hue", "hue-server");
        app.memory.compaction.enabled = !app.memory.compaction.enabled;
      });
      await applyReloadedConfig(assemblyOf(runtime), fresh);

      expect(runtime.cache.get("ada")).toBe(body);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reconnect that reaches nothing keeps the running servers", async () => {
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      const before = runtime.mcp.current;
      const fresh = configFor(root, (app) => withServer(app, "hue", "hue-server-v2"));
      const broken = {
        ...runtime,
        connectMcp: () => {
          throw new Error("the whole rebuild failed");
        },
      } as ShoreRuntime;
      await applyReloadedConfig(assemblyOf(broken), fresh);

      expect(runtime.mcp.current).toBe(before);
      expect(server.shutdowns()).toBe(0);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the shape of what is cached", () => {
  test("the whole request reaches the cache", () => {
    const seen: SidecarRequest[] = [];
    const bridge = new TurnAutonomyBridge(recordingService());
    const autonomy = turnAutonomy(bridge, {
      set: (_c: string, request: SidecarRequest) => seen.push(request),
    });

    autonomy.ensureState("ada", configFor("/tmp/shore-deps-none"));
    autonomy.notifyLastRequest("ada", {
      model: "m",
      provider_key: "anthropic",
      messages: [{ role: "user", content: "hi" } as never],
    }, { intervalMs: undefined, pings: undefined });

    expect(seen[0]?.provider_key).toBe("anthropic");
    expect(seen[0]?.messages).toHaveLength(1);
  });
});
