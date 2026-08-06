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
 * - **What is read live.** `[usage]` and the keepalive ceiling come off the
 *   registry's global config per call, so a reload reaches them. Copied into
 *   the deps at assembly they would be frozen at whatever the daemon started
 *   with, and nothing would say so.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCommandPathDeps,
  buildGenerationDeps,
  buildMessageHandlerDeps,
  chatCompactionRunner,
  chatToolDeps,
  generationRegistry,
  handlerNotifier,
  handlerRegistry,
  turnAutonomy,
  usageBudgetWarnings,
  type CommandAssembly,
  type HandlerAssembly,
} from "../src/handler/deps.ts";
import { SessionRouter } from "../src/swp/session.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { CharacterError } from "../src/characters.ts";
import { createRuntime, type ShoreRuntime } from "../src/runtime.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { ConfigDuration } from "../src/config/duration.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { closeLedgers } from "../src/ledger/record.ts";
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

describe("the tool backends a character's turn gets", () => {
  test("a deferred edit lands in the character's own directory", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-defer-");
    try {
      const ada = chatToolDeps(runtime, "ada");
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
      await chatToolDeps(runtime, "ada").deferEdit?.("SOUL.md");
      await chatToolDeps(runtime, "nova").deferEdit?.("USER.md");

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
      expect(chatToolDeps(stubbed, "ada").activityStats?.()).toEqual({
        stats: { hour_histogram: [1] } as never,
        turnCount: 12,
      });
      expect(chatToolDeps(stubbed, "nova").activityStats?.()).toBeUndefined();
      expect(asked).toEqual(["ada", "nova"]);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the shared backends come along, so chat is not offered less than a heartbeat", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-shared-");
    try {
      const ada = chatToolDeps(runtime, "ada");
      expect(ada.mcpRegistry).toBe(runtime.mcp);
      expect(ada.imageGenerator).toBeDefined();
      expect(ada.modelHistoryQuery).toBeDefined();
      // Still absent: `crates/daemon/src/tools/subagent.rs` has not ported, so
      // `ask_*` is uncallable — which is what a daemon without the runtime did.
      expect(ada.runSubagent).toBeUndefined();
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
    autonomy.notifyLastRequest("ada", { model: "m", messages: [] });

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
  test("the body it extends is this character's, looked up per pass", async () => {
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

      // The pass itself has nothing to compact here; the lookup happens before
      // it either way, and it is the lookup that has to name the right
      // character.
      await runner.run("nova", runtime.config).catch(() => undefined);
      expect(asked).toEqual(["nova"]);
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
        expect(await warnings()).toEqual([]);
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
        // A ledger that will not open reports nothing rather than failing a
        // turn that has already been persisted and answered.
        expect(await warnings()).toEqual([]);
      } finally {
        console.error = real;
      }
      expect(errors.join(" ")).toContain("cannot open ledger");
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
      expect(deps.mcpRegistry).toBe(runtime.mcp);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the usage config and the keepalive ceiling are read live, not copied", async () => {
    const { root, config, runtime } = await runtimeUnder("shore-deps-live-", (app) => {
      app.behavior.autonomy.cache_keepalive_max = ConfigDuration.fromSecs(3600);
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
      expect(deps.usageConfig?.()?.budgets).toEqual([]);

      // A reload replaces the registry's global config. Copied at assembly,
      // both of these would still be answering with what the daemon started
      // with and nothing would say so.
      runtime.registry.setGlobalConfig({
        ...config,
        app: {
          ...config.app,
          behavior: {
            ...config.app.behavior,
            autonomy: {
              ...config.app.behavior.autonomy,
              cache_keepalive_max: ConfigDuration.fromSecs(60),
            },
          },
          usage: { ...config.app.usage, budgets: [{ cost_usd: 9 } as never] },
        },
      });

      expect(deps.keepaliveMaxSecs?.()).toBe(60);
      expect(deps.usageConfig?.()?.budgets?.[0]?.cost_usd).toBe(9);
    } finally {
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
      deps.sessions.setActiveModel(1, "anthropic:a");
      deps.sessions.setActiveModel(2, "openai:b");

      deps.dispatchRuntime.clearActiveModel();

      // The Rust kept one active model on the handler's single command context,
      // so `config_reset` cleared it for everyone. Per session here, and the
      // reset still has to reach all of them.
      expect(deps.sessions.activeModel(1)).toBeUndefined();
      expect(deps.sessions.activeModel(2)).toBeUndefined();
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a refreshed prompt snapshot drops the cached body", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-prompt-");
    try {
      const deps = buildCommandPathDeps(commandAssembly(runtime));
      runtime.cache.set("ada", { model: "m", messages: [] } as never);
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

  test("the compaction a command runs extends this character's body", async () => {
    const { root, runtime } = await runtimeUnder("shore-deps-cmd-compact-");
    try {
      runtime.cache.set("ada", { model: "m", messages: [] } as never);
      const deps = buildCommandPathDeps(commandAssembly(runtime));

      // `shore compact` and an inline pass must not disagree about what was in
      // context: a manual pass that rebuilt from disk would carry a colder
      // prefix than the automatic one.
      expect(deps.commands.compaction?.cachedRequest?.("ada")).toBeDefined();
      expect(deps.commands.compaction?.cachedRequest?.("nova")).toBeUndefined();
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
    });

    // A ping rebuilt from `model` and `messages` alone drops the system blocks
    // and the tool surface, which is what the cache prefix is keyed on.
    expect(seen[0]?.provider_key).toBe("anthropic");
    expect(seen[0]?.messages).toHaveLength(1);
  });
});
