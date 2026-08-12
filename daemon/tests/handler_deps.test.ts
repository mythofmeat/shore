/**
 * Supplying a chat turn from the runtime.
 *
 * `handler/generation.ts` takes every collaborator as an argument and has never
 * had one supplied. Almost all of this wiring is a name for a name, and what is
 * worth pinning is the handful of places where the wrong name produces no error
 * at all:
 *
 * - **The two per-character tool backends.** `deferEdit` writes into one
 *   character's queue and `activityStats` reads one character's tracker. Bound
 *   to the wrong character, an edit lands in someone else's conversation and a
 *   heatmap reports someone else's hours; bound to none, both silently do
 *   nothing.
 * - **The cached request behind a compaction.** One runner serves every
 *   character, so the body has to be looked up per pass. A fixed one would hand
 *   Ada's conversation to Nova's compaction — the same shape and entirely the
 *   wrong bytes.
 * - **The budget check.** It must not open the ledger when no budget is
 *   configured, because that is the common case and the answer is always the
 *   same.
 * - **What is read live, and off whose config.** The keepalive ceiling comes
 *   off the registry's global config per call, so a reload reaches it; copied
 *   into the deps at assembly it would be frozen at whatever the daemon
 *   started with, and nothing would say so. `[usage]` comes off the *speaking
 *   character's* effective config, so a budget written into one character's
 *   overlay governs that character's turns and no one else's.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  handlerRegistry,
  turnAutonomy,
  usageBudgetWarnings,
  type CommandAssembly,
  type HandlerAssembly,
} from "../src/handler/deps.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { CharacterError } from "../src/characters.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { createRuntime, mcpConfigView, type ShoreRuntime } from "../src/runtime.ts";
import type { McpRegistry } from "../src/tools/mcp_registry.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { Ledger } from "../src/ledger/store.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

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

/**
 * `config` with `[memory.compaction]` overridden.
 *
 * Spread all the way down rather than cloned: the config carries
 * `ConfigDuration` instances, and `structuredClone` reduces them to plain
 * objects that no longer answer `asSecs()`.
 */
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

/** A character on disk, which is what discovery looks for. */
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

/**
 * Whether `view.call` dispatches to whatever the runtime's holder points at
 * *now*, rather than to the registry that existed when the view was made.
 *
 * Swaps in a stub, calls through the view, and puts the real one back — the
 * caller still has to shut the runtime down cleanly.
 */
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

/** Records what reached the service, and when it was allowed to. */
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
    shouldCompactNow: () => undefined,
    onCompactionComplete: () => calls.push("compacted"),
    onCompactionFailed: () => calls.push("failed"),
  };
}

/** The assembly slice `chatToolDeps` reads, over a runtime. */
function assemblyFor(runtime: ShoreRuntime): Parameters<typeof chatToolDeps>[0] {
  return {
    runtime,
    providers: {},
    diagnostics: new Diagnostics(),
  } as unknown as Parameters<typeof chatToolDeps>[0];
}

/** A turn with nothing live behind it. `runSubagent` is the only reader. */
function turnFor(): Parameters<typeof chatToolDeps>[2] {
  return {
    conversation: [],
    send: () => {},
    now: () => "2026-01-01T00:00:00+00:00",
    newMessageId: () => "m_test",
    signal: new AbortController().signal,
  };
}

describe("the tool backends a character's turn gets", () => {
  test("a deferred edit lands in the character's own directory", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-defer-");
    try {
      const ada = chatToolDeps(assemblyFor(runtime), "ada", turnFor());
      await ada.deferEdit?.("SOUL.md");

      // Under `<data>/ada`, not `<data>` and not anyone else's. A queue written
      // to the wrong root applies one character's self-edit to another's prompt
      // at the next compaction.
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
          activityStats: (character: string) => {
            asked.push(character);
            return character === "ada"
              ? { stats: { hour_histogram: [1] } as never, messageCount: 12 }
              : undefined;
          },
        },
      } as unknown as ShoreRuntime;

      // `messageCount` on this side is the Rust's `turn_count`: one number, two
      // names, and the tool reads the second.
      expect(chatToolDeps(assemblyFor(stubbed), "ada", turnFor()).activityStats?.()).toEqual({
        stats: { hour_histogram: [1] } as never,
        turnCount: 12,
      });
      expect(chatToolDeps(assemblyFor(stubbed), "nova", turnFor()).activityStats?.()).toBeUndefined();
      expect(asked).toEqual(["ada", "nova"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the shared backends come along, so chat is not offered less than a heartbeat", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-shared-");
    try {
      const ada = chatToolDeps(assemblyFor(runtime), "ada", turnFor());
      // A live view rather than the registry object, so a `[mcp]` reload
      // reaches a turn already in flight (#28). Asserted by behaviour, because
      // identity is exactly what it no longer has.
      expect(ada.mcpRegistry).toBeDefined();
      expect(await routesToCurrentRegistry(runtime, ada.mcpRegistry!)).toBe(true);
      expect(ada.imageGenerator).toBeDefined();
      expect(ada.modelHistoryQuery).toBeDefined();
      // A *binder*, not the runner: a sub-agent's nested loop runs against the
      // built context minus its own `runSubagent`, so the runner cannot exist
      // until the context does. `buildToolContext` is where the two meet.
      expect(ada.runSubagent).toBeDefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the autonomy surface a turn drives", () => {
  test("the cached request is set at once, without waiting on a registration", () => {
    const cached: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = new TurnAutonomyBridge(recordingService(gate));
    const autonomy = turnAutonomy(bridge, {
      set: (character: string) => cached.push(character),
    });

    autonomy.ensureState("ada", configFor("/tmp/shore-deps-none"));
    autonomy.notifyLastRequest("ada", { model: "m", messages: [] }, undefined);

    // Arming the keepalive needs no runner. Queueing it would leave a live
    // prefix unprotected for as long as the state read takes.
    expect(cached).toEqual(["ada"]);
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

    // Dropped instead of queued, the heartbeat believes the character has been
    // silent since before this turn and wakes to talk over it.
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
        sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
      // An open per turn to be told there is nothing to say is a cost with no
      // answer. A ledger that was reached and refused would have logged.
      expect(errors).toEqual([]);
    } finally {
      closeLedgers();
      await rm(root, { recursive: true, force: true });
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
        sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        diagnostics: { api_calls: { push: () => {} } } as never,
      });

      expect(deps.ledgerPath).toBe(join(root, "data", "ledger.db"));
      expect(deps.dataDir).toBe(join(root, "data"));
      expect(deps.notifier).toBe(runtime.notifier);
      expect(await routesToCurrentRegistry(runtime, deps.mcpRegistry)).toBe(true);
      // The other half of the split: the tool *surface* is read from the
      // registry current when the turn was assembled, which is what keeps a
      // turn's cache prefix stable across a reload.
      expect(deps.mcpRegistry.toolDefsFiltered(["*"])).toEqual([]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the keepalive ceiling is read live, not copied", async () => {
    const { root, config, runtime } = await runtimeUnder("shore-deps-live-", (app) => {
      app.cache.keepalive_max = ConfigDuration.fromSecs(3600);
    });
    try {
      const deps = buildGenerationDeps({
        runtime,
        providers: {},
        autonomy: new TurnAutonomyBridge(recordingService()),
        emitEvent: () => {},
        sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        diagnostics: { api_calls: { push: () => {} } } as never,
      });

      expect(deps.keepaliveMaxSecs?.()).toBe(3600);

      // A reload replaces the registry's global config. Copied at assembly,
      // this would still be answering with what the daemon started with and
      // nothing would say so.
      runtime.registry.setGlobalConfig({
        ...config,
        app: {
          ...config.app,
          cache: { ...config.app.cache, keepalive_max: ConfigDuration.fromSecs(60) },
        },
      });

      expect(deps.keepaliveMaxSecs?.()).toBe(60);
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
        sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        diagnostics: { api_calls: { push: () => {} } } as never,
      });

      await mkdir(join(root, "data"), { recursive: true });
      const ledger = Ledger.open(join(root, "data", "ledger.db"));
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

      // Nova's config has no budgets. Read off the global config, ada's would
      // apply to every character's turn — and nova would be told about a
      // budget that is none of hers.
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

      // The one method the adaptation exists for: `setup.ts` asks for
      // `segmentCount()` and the engine exposes the reader that has it.
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
      sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
      expect(deps.leases).toBeDefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("each handler gets its own leases", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-leases-");
    try {
      // A lease names a session id on one server, and two servers number their
      // sessions from 1 independently — a shared map would hand one daemon's
      // stream to the other's session.
      const first = buildMessageHandlerDeps(handlerAssembly(runtime));
      const second = buildMessageHandlerDeps(handlerAssembly(runtime));
      expect(first.leases).not.toBe(second.leases);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolving a character for the router", () => {
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
    // An empty string is a *request* for a character named "", which the
    // registry fails as not-found. `undefined` is "nobody chose".
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
    // The client can fix this by choosing, so it needs to be told what there
    // was to choose from.
    expect((answer as { error: string }).error).toContain("zed");
    expect((answer as { error: string }).error).toContain("ada");
  });

  test("anything else is stringified, not rethrown", () => {
    const registry = handlerRegistry({
      resolveCharacter: () => {
        throw new Error("the disk went away");
      },
    });
    // A throw here takes down the loop draining every other session's messages,
    // and the router's only move either way is to answer this one client.
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
    // Narrowed to one event so `[notifications.events].error` is the switch
    // this obeys and cannot quietly become another.
    expect(filed).toEqual(["error:Shore - ada:the model refused"]);
  });
});

describe("the command path", () => {
  function commandAssembly(runtime: ShoreRuntime, extra: Partial<CommandAssembly> = {}) {
    return {
      runtime,
      autonomy: new TurnAutonomyBridge(recordingService()),
      sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
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
      // Not guessed from the environment on each reload: a re-resolve could
      // land on a different file than startup read.
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
        // The command that asked has already succeeded; all this costs is the
        // `restart_required` list.
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

      // The daemon is still on the config it started with; without this frame
      // the only sign the saved file is not in effect is a log line nobody is
      // reading.
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

      // The registry re-scanned, so a character added while the daemon was up
      // is discoverable without a restart.
      expect(summary.characterDiscoveryChanged).toBe(true);
      expect(runtime.registry.availableCharacters()).toEqual(["ada", "nova"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a reset forgets every session's active model, not just the one that asked", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-reset-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      deps.sessions.setActiveModel(1, "ada", "anthropic:a");
      deps.sessions.setActiveModel(2, "nova", "openai:b");

      deps.dispatchRuntime.clearActiveModel();

      // The Rust kept one active model on the handler's single command context,
      // so `config_reset` cleared it for everyone. Per session here, and the
      // reset still has to reach all of them.
      expect(deps.sessions.activeModel(1, "ada")).toBeUndefined();
      expect(deps.sessions.activeModel(2, "nova")).toBeUndefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("one session's active model is remembered per character, not per session", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-switch-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      deps.sessions.setActiveModel(1, "ada", "anthropic:a");

      // Same session, after a switch to nova. Keyed by session alone this
      // answered "anthropic:a" — ada's model, reported as nova's, to every
      // status/model/config command until nova's own ran.
      expect(deps.sessions.activeModel(1, "nova")).toBeUndefined();
      expect(deps.sessions.activeModel(1, "ada")).toBe("anthropic:a");
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

      // The cached body still carries the pre-refresh system prompt bytes;
      // replaying it for keepalive would keep a dead prefix warm.
      expect(runtime.cache.get("ada")).toBeUndefined();
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

      // Spread rather than `structuredClone`: the config holds `ConfigDuration`
      // instances, and a structured clone turns them into plain objects that no
      // longer answer `asSecs()`.
      const overridden = withCompaction(config, { max_turns: 77 });
      await deps.dispatchRuntime.setEffectiveConfig("ada", overridden);
      deps.dispatchRuntime.reloadRuntimeConfig(overridden);
      await bridge.settled("ada");

      // Read back through the registry rather than from the argument, so the
      // override the set just installed is the one the loop adopts.
      expect(runtime.registry.effectiveConfig("ada").app.memory.compaction.max_turns).toBe(77);
      expect(service.calls).toContain("compaction");
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the two setters with a live reader behind them are no-ops", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-noop-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      // `[usage]` and `cache_keepalive_max` are read off the registry's global
      // config per call, which the same command replaces. A holder here would
      // be a second copy of a value that already has one authority.
      expect(() => {
        deps.runtime.setUsageConfig(runtime.config);
        deps.runtime.setCacheKeepaliveCeiling(ConfigDuration.fromSecs(1));
      }).not.toThrow();
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
      expect(deps.commands.ledgerPath).toBe(join(root, "data", "ledger.db"));
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Reloading `[mcp]` (#28).
 *
 * Before this, servers added, removed or re-pointed kept their startup
 * connections until the daemon restarted, and the command reported success —
 * `matchesConfig` had already ported and had no caller.
 */
describe("reloading [mcp]", () => {
  /** The command-path assembly, which is all `applyReloadedConfig` reads. */
  function assemblyOf(runtime: ShoreRuntime): CommandAssembly {
    return {
      runtime,
      autonomy: new TurnAutonomyBridge(recordingService()),
      sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      diagnostics: { api_calls: { push: () => {} } } as never,
      router: new SessionRouter(),
      handshake: { hello: () => ({}) as never, history: () => Promise.resolve({} as never) },
      providers: {},
    } satisfies CommandAssembly;
  }

  /** A fake server offering one tool, so a surface change is observable. */
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
    } as never);
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

      // The same server re-pointed at a different command: a real `[mcp]` edit.
      const fresh = configFor(root, (app) => withServer(app, "hue", "hue-server-v2"));
      await applyReloadedConfig(assemblyOf(runtime), fresh);

      expect(runtime.mcp.current.matchesConfig(mcpConfigView(fresh))).toBe(true);
      // And the registry it replaced was shut down, so the old child is gone
      // rather than left running for the life of the daemon.
      expect(server.shutdowns()).toBe(1);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unrelated reload leaves the connections alone", async () => {
    // The comparison is not an optimisation. Every rebuild respawns every stdio
    // child *and* changes the tool surface, which is a cache prefix change —
    // so an edit to a different section must not cause one.
    const server = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(server);
    try {
      const before = runtime.mcp.current;
      const fresh = configFor(root, (app) => {
        withServer(app, "hue", "hue-server");
        app.defaults.stream = !app.defaults.stream;
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
    // The other side of the guard above: with nothing declared, nothing
    // connected is the correct answer rather than a failure.
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
    // The decision this issue asked to be made rather than assumed. A turn
    // holds the tool *definitions* it was assembled with — so its cache prefix
    // is stable — but its calls follow the holder, which is what stops the rest
    // of the turn's MCP calls dying with the old transports.
    const first = fakeServer("set_light");
    const { root, runtime } = await runtimeWithMcp(first);
    try {
      const inFlight = chatToolDeps(assemblyFor(runtime), "ada", turnFor());

      const second = fakeServer("set_light");
      const fresh = configFor(root, (app) => withServer(app, "hue", "hue-server-v2"));
      await applyReloadedConfig(
        assemblyOf({ ...runtime, connectMcp: second.connect } as ShoreRuntime),
        fresh,
      );

      await expect(inFlight.mcpRegistry!.call("mcp__hue__set_light", {})).resolves.toBe(
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
        app.defaults.stream = !app.defaults.stream;
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

      // `fromConfig` skips an unreachable server rather than failing, which is
      // right at startup and wrong on a reload: it would swap in an empty
      // surface and shut down the working connections, silently, for the rest
      // of the session. Declared servers plus none connected is a failed
      // rebuild, not an intentionally empty surface.
      expect(runtime.mcp.current).toBe(before);
      expect(server.shutdowns()).toBe(0);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Kept honest: the request the cache is handed is the body, not a projection. */
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
    }, undefined);

    // A ping rebuilt from `model` and `messages` alone drops the system blocks
    // and the tool surface, which is what the cache prefix is keyed on.
    expect(seen[0]?.provider_key).toBe("anthropic");
    expect(seen[0]?.messages).toHaveLength(1);
  });
});
