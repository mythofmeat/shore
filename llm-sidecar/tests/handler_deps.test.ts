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
  buildGenerationDeps,
  chatCompactionRunner,
  chatToolDeps,
  generationRegistry,
  turnAutonomy,
  usageBudgetWarnings,
} from "../src/handler/deps.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
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
      const fresh = structuredClone(config.app);
      fresh.behavior.autonomy.cache_keepalive_max = ConfigDuration.fromSecs(60);
      fresh.usage.budgets = [{ ...(config.app.usage.budgets[0] ?? {}), cost_usd: 9 } as never];
      runtime.registry.setGlobalConfig({ ...config, app: fresh });

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
