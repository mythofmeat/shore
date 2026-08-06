/**
 * The daemon's chat turn, assembled from a {@link ShoreRuntime}.
 *
 * Ported from the `GenContext` half of `build_server_and_handler` and
 * `build_command_context` in `crates/daemon/src/main.rs`.
 *
 * `handler/generation.ts` is a complete turn driver that takes every collaborator
 * as an argument, and nothing has ever supplied them. This is the supply. What
 * it mostly does is name which of the runtime's pieces answers each question,
 * and the two places it does more than that are the two places the Rust did:
 *
 * - **Two of the tool backends are per character.** `deferEdit` writes into one
 *   character's queue and `activityStats` reads one character's tracker, so the
 *   tool context is built per turn from {@link sharedToolDeps} plus those two.
 *   A heartbeat gets the shared half alone — see `runtime.ts`.
 * - **The budget check is a read that writes.** Each threshold it reports is
 *   marked delivered, so it must run once per turn and only once, and it must
 *   not run at all when no budget is configured — otherwise every turn opens
 *   the ledger to be told there is nothing to say.
 *
 * # What is read live rather than held
 *
 * `[usage]` and the keepalive ceiling are read off `CharacterRegistry.globalConfig()`
 * per call instead of being copied into this object. The Rust held both on the
 * ledger client and had `set_usage_config`/`set_cache_keepalive_ceiling` push
 * new values in on every reload; reading through the registry is the same
 * values with nothing to forget to push. The registry's global config is what a
 * reload replaces, so a budget added at runtime is in force on the next turn.
 */

import { compactionGenerate } from "../autonomy/in_process.ts";
import type { LastRequestCache } from "../autonomy/last_request.ts";
import type { TurnAutonomyBridge } from "../autonomy/registration.ts";
import type { CharacterRegistry } from "../characters.ts";
import { characterDataDir, rustJoin } from "../config/dirs.ts";
import type { Diagnostics } from "../diagnostics.ts";
import {
  newlyCrossedBudgetWarnings,
  usageConfigView,
  type UsageBudgetWarningEvent,
  type UsageConfig,
} from "../ledger/budget.ts";
import { ledgerFor } from "../ledger/record.ts";
import type { SidecarProvider, SidecarRequest } from "../llm/types.ts";
import { queueDeferredEdit } from "../memory/deferred_edits.ts";
import { compactionRunner } from "../memory/compaction/run.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { sharedToolDeps, type ShoreRuntime } from "../runtime.ts";
import { deferEditTo } from "../tools/dispatch.ts";
import {
  generationEngine,
  type GenerationDeps,
  type GenerationRegistry,
} from "./generation.ts";
import type { SessionTokens } from "./persistence.ts";
import type { ToolContextDeps } from "./tool_context.ts";

/** What a turn needs that the runtime does not already hold. */
export interface GenerationAssembly {
  runtime: ShoreRuntime;
  /** One adapter per dialect, as `server.ts` builds them. */
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  /** The turn's end of the autonomy loop — see `autonomy/registration.ts`. */
  autonomy: TurnAutonomyBridge;
  /** The SWP broadcast: every connected session sees these. */
  emitEvent: (message: ServerMessage) => void;
  /** Process-lifetime totals behind `shore status`. */
  sessionTokens: SessionTokens;
  /** Process-lifetime rings behind `shore status --diagnostics`. */
  diagnostics: Diagnostics;
  env?: NodeJS.ProcessEnv | undefined;
  /** Injected so a test can pin the budget window without moving the clock. */
  now?: (() => number) | undefined;
}

/** Everything `makeRunGeneration` asks for. */
export function buildGenerationDeps(a: GenerationAssembly): GenerationDeps {
  const { runtime } = a;
  const dataDir = runtime.config.dirs.data;
  const ledgerPath = rustJoin(dataDir, "ledger.db");
  const global = () => runtime.registry.globalConfig();
  const usage = () => usageConfigView(global().app.usage);

  return {
    registry: generationRegistry(runtime.registry),
    dataDir,
    providers: a.providers,
    autonomy: turnAutonomy(a.autonomy, runtime.cache),
    notifier: runtime.notifier,
    sessionTokens: a.sessionTokens,
    diagnostics: a.diagnostics,
    emitEvent: a.emitEvent,
    mcpRegistry: runtime.mcp,
    compaction: chatCompactionRunner(a),
    newlyCrossedUsageBudgetWarnings: usageBudgetWarnings(ledgerPath, usage, a.now),
    ledgerPath,
    usageConfig: usage,
    keepaliveMaxSecs: () =>
      Number(global().app.behavior.autonomy.cache_keepalive_max.asSecs()),
    tools: (charName) => chatToolDeps(runtime, charName),
    ...(a.env === undefined ? {} : { env: a.env }),
  };
}

/**
 * The character registry as a turn reads it.
 *
 * `getOrCreate` is adapted rather than passed straight through because
 * `setup.ts` wants `segmentCount()` and the engine exposes the reader that has
 * it; {@link generationEngine} is where that one method's difference lives.
 */
export function generationRegistry(registry: CharacterRegistry): GenerationRegistry {
  return {
    getOrCreate: async (name) => generationEngine(await registry.getOrCreate(name)),
    effectiveConfig: (name) => registry.effectiveConfig(name),
  };
}

/**
 * The autonomy surface a turn drives, which is two surfaces.
 *
 * Everything the loop has to be *told* goes through the bridge, so it queues
 * behind a registration that may still be reading state off disk. The cached
 * request does not: arming the keepalive needs no runner, and delaying it would
 * leave a live prefix unprotected for as long as the disk read takes.
 */
export function turnAutonomy(
  bridge: TurnAutonomyBridge,
  cache: Pick<LastRequestCache, "set">,
): GenerationDeps["autonomy"] {
  return {
    ensureState: (character, config) => bridge.ensureState(character, config),
    backfillActivity: (character, timestamps) => {
      bridge.backfillActivity(character, timestamps);
    },
    onUserMessage: (character, turnCount) => {
      bridge.onUserMessage(character, turnCount);
    },
    shouldCompactNow: (character, turnCount, contextTokens) =>
      bridge.shouldCompactNow(character, turnCount, contextTokens),
    onCompactionComplete: (character, retained) => {
      bridge.onCompactionComplete(character, retained);
    },
    onCompactionFailed: (character) => {
      bridge.onCompactionFailed(character);
    },
    notifyAssistantMessage: (character, turnCount) => {
      bridge.onAssistantMessage(character, turnCount);
    },
    // The body as sent, minus its per-call context — the driver already
    // stripped that. `set` caches it and arms the keepalive off it, in that
    // order, because arming is what reads the cadence out of a body.
    notifyLastRequest: (character, request) => {
      cache.set(character, request as SidecarRequest);
    },
  };
}

/**
 * The tool backends for one character's turn.
 *
 * The shared half is `runtime.ts`'s, unchanged, so a heartbeat and a chat turn
 * reach the same image generator and the same ledger. The two added here are
 * the two that name a character:
 *
 * - **`deferEdit`** queues a prompt-visible write against this character's data
 *   directory, so the edit lands at the next compaction rather than rewriting
 *   the system prompt under a live cache entry.
 * - **`activityStats`** answers `activity_heatmap` from this character's
 *   tracker. `messageCount` is the Rust's `turn_count` — one number, two names,
 *   and the rename happens here rather than in the tool.
 *
 * `runSubagent` is still absent: `crates/daemon/src/tools/subagent.rs` has not
 * ported, so `ask_*` is uncallable, which is what a daemon without the runtime
 * did.
 */
export function chatToolDeps(runtime: ShoreRuntime, charName: string): ToolContextDeps {
  return {
    ...sharedToolDeps(runtime.config, runtime.mcp),
    deferEdit: deferEditTo(
      characterDataDir(runtime.config.dirs.data, charName),
      queueDeferredEdit,
    ),
    activityStats: () => {
      const report = runtime.autonomy.activityStats(charName, Date.now());
      return report === undefined
        ? undefined
        : { stats: report.stats, turnCount: report.messageCount };
    },
  };
}

/**
 * The pass an over-long turn runs inline.
 *
 * The same pass the idle trigger runs, with the same credential rotation — see
 * {@link compactionGenerate}, which both call — and deliberately with no
 * notification hook. The Rust fires `compaction_complete` from *inside* the
 * pass, where the "ran but wrote no memory" outcome exists; that half has not
 * ported. Notifying from out here would send "compaction complete" for the one
 * outcome that most needs a different sentence. See `memory/compaction/run.ts`.
 */
export function chatCompactionRunner(a: GenerationAssembly): GenerationDeps["compaction"] {
  const { runtime } = a;
  return compactionRunner({
    generate: compactionGenerate({
      providers: a.providers,
      config: runtime.config,
      ...(a.env === undefined ? {} : { env: a.env }),
    }),
    // The body this character last sent, looked up per pass. A pass that finds
    // none rebuilds from `active.jsonl` — same shape, colder prefix.
    cachedRequest: (character) => runtime.cache.get(character),
    tools: sharedToolDeps(runtime.config, runtime.mcp),
  });
}

/**
 * Budget thresholds this turn newly crossed.
 *
 * Two things it must get right. It is a **read that writes** — each threshold
 * it reports is marked delivered, so the same 80% crossing is announced once
 * per window and calling it twice per turn would swallow the second one. And it
 * **must not open the ledger when no budget is configured**, which is the
 * common case: an open per turn to be told there is nothing to say is a cost
 * with no answer.
 *
 * A ledger that will not open reports nothing rather than failing the turn. The
 * turn has already completed and been persisted by the time this runs; a
 * missing warning is worth less than the answer the user is reading.
 */
export function usageBudgetWarnings(
  ledgerPath: string,
  usage: () => UsageConfig | undefined,
  now: (() => number) | undefined,
): () => Promise<UsageBudgetWarningEvent[]> {
  const clock = now ?? (() => Date.now());
  return () => {
    const config = usage();
    if (config === undefined || (config.budgets ?? []).length === 0) {
      return Promise.resolve([]);
    }
    const ledger = ledgerFor(ledgerPath);
    if (ledger === null) return Promise.resolve([]);
    return Promise.resolve(newlyCrossedBudgetWarnings(ledger.database, config, clock()));
  };
}
