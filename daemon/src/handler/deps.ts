/**
 * The daemon's message handler, assembled from a {@link ShoreRuntime}.
 *
 * Ported from the `MessageHandlerDeps` and `GenContext` halves of
 * `build_server_and_handler`, and from `build_command_context`, in
 * `crates/daemon/src/main.rs`.
 *
 * {@link buildMessageHandlerDeps} is the whole of it; the two `build*Deps`
 * calls underneath it are separable and separately tested. Every module they
 * supply — the turn driver, the command table, the router — was written to take
 * its collaborators as arguments, and nothing has ever supplied them.
 *
 * What this mostly does is name which of the runtime's pieces answers each
 * question. The places it does more than that are the places the Rust did:
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
 *
 * That is also why the two setters below are no-ops rather than gaps.
 *
 * # The command path, and the one thing it does not do
 *
 * {@link buildCommandPathDeps} supplies `handler/commands.ts`, which needs two
 * more surfaces nothing had implemented: `ConfigRuntime` — what a `config`
 * command pushes outward — and `DispatchRuntime`, what the four
 * post-processing hooks reach into.
 *
 * **`[mcp]` is not reconnected on reload** — issue #28. The Rust's `apply_reloaded_config`
 * compares the section and rebuilds the registry when it moved. Doing that here
 * means `ShoreRuntime.mcp` becoming a holder both this path *and* the autonomy
 * executor read through, because a chat turn and a heartbeat must offer the
 * same tool surface — a background tick with fewer tools writes a prefix the
 * next chat turn cannot reuse, and the keepalive then pays for a cache write
 * and buys nothing. Swapping only the copy chat sees would cause exactly that,
 * so this does nothing rather than half of it: edits to `[mcp]` need a restart,
 * and everything else in a reload lands.
 */

import { compactionGenerate } from "../autonomy/in_process.ts";
import type { LastRequestCache } from "../autonomy/last_request.ts";
import type { TurnAutonomyBridge } from "../autonomy/registration.ts";
import { CharacterError, type CharacterRegistry } from "../characters.ts";
import type { CommandDeps } from "../commands/dispatch.ts";
import type { ConfigRuntime } from "../commands/config.ts";
import { characterDataDir, discoverCharacters, rustJoin } from "../config/dirs.ts";
import { loadCharacterConfig, loadConfig, type LoadedConfig } from "../config/loader.ts";
import { restartRequiredChanges } from "../config/restart.ts";
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
import type { NotificationService } from "../notifications.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { mcpConfigView, sharedToolDeps, type ShoreRuntime } from "../runtime.ts";
import { McpRegistry } from "../tools/mcp_registry.ts";
import { pluginsDir } from "../config/dirs.ts";
import { historyMessage, type HandshakeProvider } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";
import { deferEditTo, type ToolContext } from "../tools/dispatch.ts";
import { subagentRunner } from "../tools/subagent_loop.ts";
import { makeDispatchCommand, type CommandPathDeps, type SessionCache } from "./commands.ts";
import type { DispatchRuntime, ReloadSummary } from "./command_dispatch.ts";
import {
  generationEngine,
  makeRunGeneration,
  type GenerationDeps,
  type GenerationRegistry,
  type SubagentTurn,
} from "./generation.ts";
import { StreamLeases } from "./lease.ts";
import type {
  HandlerNotifier,
  HandlerRegistry,
  MessageHandlerDeps,
} from "./router.ts";
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
    // Two halves, deliberately different. `toolDefsFiltered` is read once here
    // and the request built from it is reused for every round of the turn's
    // loop, so the surface — and the cache prefix keyed on it — is fixed for
    // this turn whatever a reload does mid-flight. `call` follows the holder,
    // so a turn that outlives a `[mcp]` reload dispatches to the registry that
    // is actually connected rather than to one whose transports just closed
    // (#28).
    mcpRegistry: {
      toolDefsFiltered: (patterns) => runtime.mcp.current.toolDefsFiltered(patterns),
      ...runtime.mcp.callView(),
    },
    compaction: chatCompactionRunner(a),
    newlyCrossedUsageBudgetWarnings: usageBudgetWarnings(ledgerPath, usage, a.now),
    ledgerPath,
    usageConfig: usage,
    keepaliveMaxSecs: () =>
      Number(global().app.behavior.autonomy.cache_keepalive_max.asSecs()),
    tools: (charName, turn) => chatToolDeps(a, charName, turn),
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
 * **`runSubagent`** is the third, and it is per *turn* as well as per
 * character: the nested loop streams into the session that asked and its
 * history macro reads that turn's conversation tail. `buildToolContext` gates
 * it on `[subagents]` being non-empty, so passing one costs nothing for a
 * character that has none.
 */
export function chatToolDeps(
  a: GenerationAssembly,
  charName: string,
  turn: SubagentTurn,
): ToolContextDeps {
  const { runtime } = a;
  return {
    ...sharedToolDeps(runtime.config, runtime.mcp),
    // A binder: `buildToolContext` calls it with the context it just built,
    // and the nested loop runs against that context minus this very field.
    runSubagent: (parent: ToolContext) =>
      subagentRunner({
      config: runtime.registry.effectiveConfig(charName),
      ctx: parent,
      providers: a.providers,
      mcpRegistry: runtime.mcp.current,
      sendDirect: turn.send,
      diagnostics: a.diagnostics.tool_calls,
      conversation: turn.conversation,
      ...(a.env === undefined ? {} : { env: a.env }),
      ...(turn.rid === undefined ? {} : { rid: turn.rid }),
      now: turn.now,
      newMessageId: turn.newMessageId,
      }),
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

// ── the whole handler ───────────────────────────────────────────────────

/** What the message handler needs that neither half already carries. */
export interface HandlerAssembly
  extends Omit<GenerationAssembly, "emitEvent">,
    Omit<CommandAssembly, "runtime" | "autonomy" | "sessionTokens" | "diagnostics" | "providers" | "env"> {
  runtime: ShoreRuntime;
  /**
   * The SWP broadcast, and the only reason this takes a `Server` rather than
   * its parts: a broadcast frame goes to every session, a routed reply goes to
   * one, and the two are separate channels on the same object.
   */
  emitEvent: (message: ServerMessage) => void;
  log?: MessageHandlerDeps["log"];
}

/**
 * The handler, assembled.
 *
 * Everything below the two `build*Deps` calls is an adapter of a few lines,
 * and each exists because this module reads a runtime piece more narrowly than
 * the piece is written — a registry that answers with a message instead of
 * throwing, a notifier that only ever files an error.
 */
export function buildMessageHandlerDeps(a: HandlerAssembly): MessageHandlerDeps {
  return {
    router: a.router,
    // Fresh, and never shared with anything: a lease names a session on this
    // server, and a second daemon's sessions are different numbers.
    leases: new StreamLeases(),
    registry: handlerRegistry(a.runtime.registry),
    notifier: handlerNotifier(a.runtime.notifier),
    dispatchCommand: makeDispatchCommand(buildCommandPathDeps(a)),
    runGeneration: makeRunGeneration(buildGenerationDeps(a)),
    ...(a.log === undefined ? {} : { log: a.log }),
  };
}

/**
 * The registry as the router reads it: a message instead of a throw.
 *
 * The Rust returned `Result<String, _>` and the caller turned the error into an
 * `invalid_request` frame. {@link CharacterError} already carries the sentence
 * — which character was asked for and which exist — so this only changes how it
 * travels. Anything that is not a `CharacterError` is stringified rather than
 * rethrown: the router's only move either way is to answer the client, and a
 * throw here would take down the loop draining every other session's messages.
 */
export function handlerRegistry(
  registry: Pick<CharacterRegistry, "resolveCharacter">,
): HandlerRegistry {
  return {
    resolveCharacter: (selected) => {
      try {
        // `null` is "none selected" and `undefined` is what the registry spells
        // that as; an empty string is a *request* for a character called "",
        // and stays one.
        return { name: registry.resolveCharacter(selected ?? undefined) };
      } catch (e) {
        return { error: e instanceof CharacterError ? e.message : String(e) };
      }
    },
  };
}

/**
 * Desktop notifications, for a generation that failed outright.
 *
 * Narrowed to the one event the router files, so the `[notifications.events]`
 * toggle this obeys is `error` and cannot quietly become another — the same
 * reason `runtime.ts` names its two autonomy hooks separately.
 */
export function handlerNotifier(
  notifier: Pick<NotificationService, "notify">,
): HandlerNotifier {
  return {
    notify: (event, title, body) => {
      notifier.notify(event, title, body);
    },
  };
}

// ── the command path ────────────────────────────────────────────────────

/** What a command needs that the runtime does not already hold. */
export interface CommandAssembly {
  runtime: ShoreRuntime;
  /** Shared with the turn: the same registrations, the same queue. */
  autonomy: TurnAutonomyBridge;
  sessionTokens: SessionTokens;
  diagnostics: Diagnostics;
  /** Direct sends and session metadata — a `switch_character` moves a session. */
  router: SessionRouter;
  /** What answers a pushed history snapshot. */
  handshake: HandshakeProvider;
  providers: Partial<Record<SidecarRequest["sdk"], SidecarProvider>>;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Everything `makeDispatchCommand` asks for. */
export function buildCommandPathDeps(a: CommandAssembly): CommandPathDeps {
  const { runtime } = a;
  const sessions = new ProcessSessionCache();
  return {
    registry: runtime.registry,
    globalConfig: () => runtime.registry.globalConfig(),
    configPath: runtime.configPath,
    dataDir: runtime.config.dirs.data,
    sessions,
    commands: commandDeps(a),
    runtime: configRuntime(a),
    dispatchRuntime: dispatchRuntime(a, sessions),
    router: a.router,
    handshake: a.handshake,
    ...(a.env === undefined ? {} : { env: a.env }),
  };
}

/**
 * The per-session active-model cache, for the daemon's lifetime.
 *
 * The Rust kept one active model on the handler's single `CommandContext`, so
 * every session shared it and a `switch_model` in one window moved another's.
 * Per session here, which is what the field means — and it is why
 * {@link clear} exists: `config_reset` sets the Rust's single copy to `None`,
 * and the same reset has to reach every session's.
 */
export class ProcessSessionCache implements SessionCache {
  readonly #models = new Map<number, string>();

  activeModel(sessionId: number): string | undefined {
    return this.#models.get(sessionId);
  }

  setActiveModel(sessionId: number, model: string | undefined): void {
    if (model === undefined) this.#models.delete(sessionId);
    else this.#models.set(sessionId, model);
  }

  /** Forget every session's, which is what a `config_reset` does. */
  clear(): void {
    this.#models.clear();
  }
}

/**
 * What a `config` command pushes outward once it has written to disk.
 *
 * Two of the four are no-ops, and both for the same reason rather than as an
 * omission: `[usage]` and `cache_keepalive_max` are read live off the
 * registry's global config (see the module doc), which the same command
 * replaces. There is nothing left to push, and a holder here would be a second
 * copy of a value that already has one authority.
 */
export function configRuntime(a: CommandAssembly): ConfigRuntime {
  const { runtime } = a;
  return {
    // Every registered character adopts the new `[memory.compaction]`, read
    // through the registry. At this moment the registry may still be holding
    // the pre-reload global — `adopt` runs inside the command and
    // `applyReloadedConfig` adopts it just afterwards — but that hook pushes
    // again once the registry has taken it, and nothing can run a turn in
    // between. So the transient staleness is not observable, and the
    // alternative is a second derivation of "this character's effective
    // config" that has to agree with the registry's forever.
    reloadRuntimeConfig: () => {
      a.autonomy.reloadConfig((name) => runtime.registry.effectiveConfig(name));
    },
    setUsageConfig: () => {},
    setCacheKeepaliveCeiling: () => {},
    notifyPromptSnapshotRefreshed: (character) => {
      // The cached body still carries the pre-refresh system prompt bytes, so
      // replaying it for keepalive would keep a dead prefix warm.
      runtime.cache.invalidate(character, "prompt_reload");
      // Re-arming reads `active.jsonl`, which the Rust deliberately did after
      // releasing its state lock; here that is the same as not awaiting it. A
      // rebuild that fails leaves the keepalive disarmed, which is the safe
      // side: nothing is pinged rather than the wrong thing.
      void runtime.cache
        .reprimeFromDisk(character, runtime.config.dirs.data, runtime.registry.effectiveConfig(character), {
          mcpRegistry: runtime.mcp.current,
        })
        .catch((e: unknown) => {
          console.warn(`shore: keepalive reprime failed for ${character}: ${String(e)}`);
        });
    },
  };
}

/**
 * The handler-owned state the four post-processing hooks reach into.
 *
 * `applyReloadedConfig` is the interesting one: it is the whole of what a
 * reload turns out to move, and the order is the Rust's — adopt into the
 * registry first, because everything after it reads the registry.
 */
export function dispatchRuntime(
  a: CommandAssembly,
  sessions: ProcessSessionCache,
): DispatchRuntime {
  const { runtime } = a;
  return {
    globalConfig: () => runtime.registry.globalConfig(),

    reloadGlobalConfig: () => {
      try {
        return loadConfig(runtime.configPath, a.env === undefined ? {} : { env: a.env });
      } catch (e) {
        // The annotation is dropped rather than the command failed: it already
        // succeeded, and an edit that broke the file since only costs the
        // `restart_required` list.
        console.warn(`shore: could not re-read ${runtime.configPath}: ${String(e)}`);
        return undefined;
      }
    },

    setEffectiveConfig: (character, config) => {
      runtime.registry.setRuntimeEffectiveConfig(character, config);
      return Promise.resolve();
    },

    reloadRuntimeConfig: () => {
      a.autonomy.reloadConfig((name) => runtime.registry.effectiveConfig(name));
    },

    applyReloadedConfig: async (config) => await applyReloadedConfig(a, config),

    clearActiveModel: () => {
      sessions.clear();
    },
  };
}

/**
 * Adopt a freshly-loaded config everywhere that holds one.
 *
 * A module function rather than a closure on {@link dispatchRuntime} because
 * it has a second caller that has nothing to do with commands: the config
 * watcher. A `config_reload` and a file saved in `$XDG_CONFIG_HOME/shore` are
 * the same event as far as the daemon is concerned, and it would be a poor
 * kind of hot reload that did less than the command.
 */
export async function applyReloadedConfig(
  a: CommandAssembly,
  config: LoadedConfig,
): Promise<ReloadSummary> {
  // First, because it is what every read below goes through: the registry
  // holds the global config, re-scans the character list, drops the
  // per-character config cache and discards engines that no longer exist.
  const summary = await a.runtime.registry.reloadRuntimeState(config);
  await reconnectMcpIfChanged(a, config);
  a.autonomy.reloadConfig((name) => a.runtime.registry.effectiveConfig(name));
  await pushHistorySnapshots(a);
  return {
    characterDiscoveryChanged: summary.characterDiscoveryChanged,
    droppedEngines: summary.droppedEngines,
  };
}

/**
 * Rebuild the MCP registry when `[mcp]` moved, and only then (#28).
 *
 * **The comparison is the point, not an optimisation.** Rebuilding on every
 * reload would tear down and respawn every stdio child for an unrelated edit —
 * and each rebuild is a tool-surface change, which is a cache prefix change,
 * which costs a full write on every character's next turn. An unrelated config
 * edit must not do that.
 *
 * Order: connect the new one, swap the holder, then shut the old one down.
 * Connecting first means a total failure to connect leaves the running
 * registry in place rather than a hole; swapping before shutting down means
 * nothing can take a reference to a registry that is about to close.
 *
 * The old registry's transports close immediately. A generation already in
 * flight keeps the tool *definitions* it was assembled with — those are read
 * once in `buildGenerationRequest`, so its prefix is stable — but its `call`s
 * go through the holder and land on the new registry. A call already on the
 * wire when the swap happens fails once; that one is unavoidable without
 * keeping the old child processes alive for an unbounded time.
 */
async function reconnectMcpIfChanged(a: CommandAssembly, config: LoadedConfig): Promise<void> {
  const servers = mcpConfigView(config);
  if (a.runtime.mcp.current.matchesConfig(servers)) return;

  let next: McpRegistry;
  try {
    next = await McpRegistry.fromConfig(
      servers,
      pluginsDir(config.dirs.data),
      a.runtime.connectMcp,
    );
  } catch (e) {
    // `fromConfig` skips a server it cannot reach rather than throwing, so this
    // is something structural. Keep running on the registry that works and say
    // so loudly: a reload that silently kept the old tool surface is the bug
    // this function exists to fix.
    console.error(`shore: [mcp] reload failed, keeping the running servers: ${String(e)}`);
    return;
  }

  // `fromConfig` skips a server it cannot reach rather than failing, which is
  // right at startup — a bad server must never take the daemon down. On a
  // *reload* the same policy would let one bad moment destroy every working
  // connection and leave the daemon serving an empty tool surface for the rest
  // of the session, which is the silent, expensive failure #37 describes. So a
  // rebuild that declared servers and connected none of them is treated as a
  // failed rebuild rather than as an intentionally empty surface. Removing
  // every server from the config still empties it, because then none were
  // declared.
  if (Object.keys(servers).length > 0 && next.connectedServers() === 0) {
    console.error(
      "shore: [mcp] reload connected none of the configured servers; " +
        "keeping the running ones",
    );
    await next.shutdown();
    return;
  }

  const previous = a.runtime.mcp.replace(next);
  try {
    await previous.shutdown();
  } catch (e) {
    console.warn(`shore: shutting down the previous MCP registry failed: ${String(e)}`);
  }
  console.info("shore: [mcp] changed; reconnected servers and swapped the tool surface");
}

/**
 * Re-read `config.toml` from disk and adopt it, or keep what is running.
 *
 * What the watcher calls. Two things it must get right, both of them about
 * *not* adopting:
 *
 * - **A config that will not parse changes nothing.** Someone is editing the
 *   file, and half-typed TOML reaches the watcher as often as finished TOML
 *   does. A daemon that adopted every intermediate state would spend the edit
 *   flapping between configurations.
 * - **A broken per-character overlay changes nothing either.** `loadConfig`
 *   only parses the global file, so a `characters/<name>/config.toml` that
 *   does not parse would be discovered later, one character at a time, as a
 *   silent fall back to the global config. Every overlay is validated against
 *   the new global before any of it is committed.
 *
 * Startup-owned settings that moved are warned about rather than applied. The
 * listen address and the data directory are read once, before any of this
 * exists; saying so is the only thing that can be done about them.
 */
export function configReloader(
  a: CommandAssembly,
): (changedPaths: readonly string[]) => Promise<void> {
  return async (changedPaths) => {
    const where = `${a.runtime.configPath} (changed: ${changedPaths.join(", ")})`;

    let config: LoadedConfig;
    try {
      config = loadConfig(a.runtime.configPath, a.env === undefined ? {} : { env: a.env });
    } catch (e) {
      console.warn(
        `shore: config hot reload failed, keeping the running config — ${where}: ${String(e)}`,
      );
      return;
    }

    for (const name of discoverCharacters(config.dirs.config, config.dirs.workspace)) {
      try {
        loadCharacterConfig(config, name);
      } catch (e) {
        console.warn(
          `shore: config hot reload failed on ${name}'s overlay, keeping the running config — ` +
            `${where}: ${String(e)}`,
        );
        return;
      }
    }

    const restart = restartRequiredChanges(a.runtime.registry.globalConfig(), config);
    if (restart.length > 0) {
      console.warn(
        `shore: config hot reload saw startup-owned changes (${restart.join(", ")}); ` +
          `restart the daemon to apply them`,
      );
    }

    await applyReloadedConfig(a, config);
    console.info(`shore: config hot reload applied — ${where}`);
  };
}

/**
 * Hand every session the conversation it is now looking at.
 *
 * A reload can have moved a character's merged config, replaced its engine, or
 * removed it outright, and a session that is not told keeps rendering what it
 * last received until something else makes it reload. A session with nothing
 * selected gets the empty snapshot, which is what its next handshake would say.
 */
async function pushHistorySnapshots(a: CommandAssembly): Promise<void> {
  for (const [sessionId, character] of a.router.sessions()) {
    if (character === null) continue;
    try {
      const snapshot = await a.handshake.history(character);
      // No rid: nobody asked for this one.
      await a.router.sendToSession(sessionId, historyMessage(snapshot, undefined));
    } catch (e) {
      // One session that has gone away must not stop the rest being told.
      console.warn(`shore: could not push history to session ${sessionId}: ${String(e)}`);
    }
  }
}

/**
 * What the command table needs beyond the session.
 *
 * `autonomy` is the *service*, not the turn's bridge: these commands ask
 * questions (`status`, `log`, `heartbeat_now`) about a character the loop is
 * already running, rather than reporting a turn's events into it.
 */
export function commandDeps(a: CommandAssembly): CommandDeps {
  const { runtime } = a;
  const ledgerPath = rustJoin(runtime.config.dirs.data, "ledger.db");
  return {
    sessionTokens: a.sessionTokens,
    autonomy: runtime.autonomy,
    diagnostics: a.diagnostics,
    callStore: runtime.callStore,
    ledgerPath,
    compaction: {
      run: {
        generate: compactionGenerate({
          providers: a.providers,
          config: runtime.config,
          ...(a.env === undefined ? {} : { env: a.env }),
        }),
        tools: sharedToolDeps(runtime.config, runtime.mcp),
      },
      // `shore compact` extends the body that character last sent, the same one
      // an inline or idle pass would — otherwise the manual pass rebuilds a
      // colder prefix than the automatic one and the two disagree about what
      // was in context.
      cachedRequest: (character) => runtime.cache.get(character),
    },
    keepalive: {
      keepalive: runtime.keepalive,
      lastRequest: runtime.cache,
      // Read at rebuild time, not captured: a keepalive body assembled from a
      // stale surface would ping a prefix no turn will send.
      rebuild: { mcpRegistry: runtime.mcp.current },
    },
  };
}
