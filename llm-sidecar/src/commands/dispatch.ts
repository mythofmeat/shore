/**
 * The command table: a name, and the handler it reaches.
 *
 * Ported from `crates/daemon/src/commands/mod.rs`, pinned by
 * `tests/commands_fixtures/dispatch_parity.json`.
 *
 * Every handler here has its own frozen fixture already. What this module adds
 * is the routing, and routing is where the silent failures live: an arm wired
 * to the wrong handler answers *something*, and a name missing from the table
 * becomes "unknown command" for a client that has been sending it for months.
 * So the fixture drives every name the Rust knows — and three it does not —
 * through the real dispatcher and records what came back.
 *
 * # One context, deliberately mutable
 *
 * `switch_model`, `reset_model`, `config` and `config_reset` write the active
 * model back through the context, and the dispatcher's caller mirrors it into
 * the session. That is the Rust's `&mut CommandContext`, and the same object
 * has to reach every arm for it to work — so this passes one
 * {@link CommandSession} rather than building a fresh narrow context per call.
 * The narrow contexts the individual commands declare still hold: this
 * satisfies each of them structurally.
 *
 * # Nothing is injected any more
 *
 * Two arms landed here unwired — `compact` and `keepalive_ping_now`, the only
 * two that reach an LLM — because each was blocked on a module that had not
 * ported. Both are real arms now. What they need is not a missing module but a
 * *runtime*: something that can make a provider call, reach the tool layer, or
 * ping a cached prefix. `deps.compaction` and `deps.keepalive` carry those the
 * way `deps.ledgerPath` carries `usage`'s, and an absent one still refuses with
 * `unwired` — which is what a build with no LLM client behind it would do.
 */

import type { Command } from "../protocol/Command.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ResolvedModel } from "../config/models.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { CallStore } from "../call_store.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { AutonomyService } from "../autonomy/service.ts";
import { CommandError, internalError, invalidRequest } from "./errors.ts";
import { callLog, transcript } from "./call_log.ts";
import { config, configCheck, configReload, configReset, tools, type ConfigRuntime } from "./config.ts";
import {
  alt,
  edit,
  deleteMessages,
  get,
  historyPage,
  injectSystem,
  listAlternatives,
  log,
} from "./conversation.ts";
import { compact, type CompactContext } from "./compact.ts";
import { keepalivePingNowCommand, type KeepalivePingContext } from "./keepalive.ts";
import { memory } from "./memory.ts";
import {
  backgroundModels,
  listModels,
  modelInfo,
  modelSettings,
  resetModel,
  setModelSetting,
  switchModel,
} from "./models.ts";
import { characterInfo, listCharacters, switchCharacter, type Args } from "./navigation.ts";
import {
  listProviderModels,
  listProviders,
  refreshAllProviderModels,
  refreshProviderModels,
} from "./providers.ts";
import {
  diagnostics as diagnosticsCommand,
  heartbeatLog,
  heartbeatSetActive,
  heartbeatSetDormant,
  heartbeatTickNow,
  status,
} from "./status.ts";
import { usage } from "./usage.ts";
import type { SessionTokens } from "../handler/persistence.ts";
import type { UsageBudgetConfig, UsageConfig } from "../ledger/budget.ts";

/**
 * The dispatcher's own state, shared by every arm and written by four of them.
 *
 * Structurally this is `ConfigContext` and `ModelsContext` at once, which is
 * what lets the active-model writes be visible to the caller. The Rust called
 * it `CommandContext` and had the same double duty.
 */
export interface CommandSession {
  /** The character-effective config: global, with this character's overlay. */
  config: LoadedConfig;
  /** The file the daemon was started with — not the character's overlay. */
  configPath: string;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  activeResolvedModel: ResolvedModel | undefined;
  runtime: ConfigRuntime;
  env?: NodeJS.ProcessEnv;
}

/** What the table needs beyond the session, none of which any arm writes. */
export interface CommandDeps {
  sessionTokens: SessionTokens;
  autonomy: AutonomyService;
  diagnostics: Diagnostics;
  /** The observability store, for `call_log` and `transcript`. */
  callStore: CallStore | undefined;
  /** `ledger.db`. Absent makes `usage` an internal error, as it did. */
  ledgerPath: string | undefined;
  /** Wall clock, milliseconds. Injected so a replay can pin it. */
  now?: () => number;
  /** The same clock read as local time, for the heartbeat's day boundaries. */
  localNow?: () => number;
  fetchImpl?: typeof fetch;
  /**
   * What a compaction pass runs against: the provider call, the tool layer, and
   * the conversation's cached last request. Absent leaves `compact` unwired.
   */
  compaction?: Omit<CompactContext, "config" | "autonomy">;
  /**
   * The armed prefix and the body behind it, for the `keepalive_ping_now`
   * diagnostic. Absent leaves the arm unwired.
   */
  keepalive?: Omit<KeepalivePingContext, "config" | "dataDir">;
}

/** The five names that answer without a character, and their handlers. */
const CHARACTERLESS = new Set([
  "list_characters",
  "list_models",
  "background_models",
  "list_providers",
  "list_provider_models",
]);

/**
 * Run one command against a character's conversation.
 *
 * Throws {@link CommandError}; {@link commandFrame} is what turns either
 * outcome into a frame. The split is not the Rust's — it returned the frame
 * from `dispatch` — and it exists because the characterless path needs the same
 * envelope from a different table, and building it twice is how the two drift.
 */
export async function runCommand(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): Promise<unknown> {
  const args = (cmd.args ?? {}) as Args;
  const character = engine.characterName;
  const configDir = session.config.dirs.config;

  switch (cmd.name) {
    // ── navigation ──────────────────────────────────────────────────────
    case "list_characters":
      return listCharacters(configDir, character);
    case "switch_character":
      return switchCharacter(configDir, character, args);
    case "character_info":
      return await characterInfo(
        { configDir, dataDir: session.dataDir, active: character },
        args,
      );

    // ── conversation ────────────────────────────────────────────────────
    case "log":
      return await log(engine, args);
    case "history_page":
      return await historyPage(engine, args);
    case "get":
      return get(engine, args);
    case "edit":
      return await edit(engine, args);
    case "delete":
      return await deleteMessages(engine, args);
    case "alt":
      return await alt(engine, args);
    case "list_alternatives":
      return listAlternatives(engine, args);
    case "inject_system":
      return await injectSystem(engine, args);

    // ── state ───────────────────────────────────────────────────────────
    case "status":
      return await status(statusContext(engine, session, deps));
    case "list_models":
      return listModels(session, args);
    case "model_info":
      return modelInfo(session, args);
    case "switch_model":
      return switchModel(session, args);
    case "reset_model":
      return resetModel(session);
    case "set_model_setting":
      return setModelSetting(session, args);
    case "model_settings":
      return modelSettings(session, args);
    case "background_models":
      return backgroundModels(session);
    case "memory":
      return await memory(configDir, character, args);
    case "compact":
      if (deps.compaction === undefined) throw unwired("compact");
      return await compact(
        engine,
        { ...deps.compaction, config: session.config, autonomy: deps.autonomy },
        args,
      );
    case "config":
      return config(session, args);
    case "tools":
      return tools(session);
    case "config_check":
      return configCheck(session, session.env ?? process.env);
    case "config_reload":
      return await configReload(session, args);
    case "config_reset":
      return configReset(session);
    case "diagnostics":
      return diagnosticsCommand(statusContext(engine, session, deps), args);
    case "heartbeat_log":
      return heartbeatLog(statusContext(engine, session, deps), args);
    case "call_log":
      return callLog({ characterName: character, callStore: deps.callStore }, args);
    case "transcript":
      return transcript({ characterName: character, callStore: deps.callStore }, args);
    case "heartbeat_tick_now":
      return heartbeatTickNow(statusContext(engine, session, deps));
    case "keepalive_ping_now":
      if (deps.keepalive === undefined) throw unwired("keepalive_ping_now");
      return await keepalivePingNowCommand(character, {
        ...deps.keepalive,
        config: session.config,
        dataDir: session.dataDir,
      });
    case "heartbeat_set_dormant":
      return heartbeatSetDormant(statusContext(engine, session, deps));
    case "heartbeat_set_active":
      return heartbeatSetActive(statusContext(engine, session, deps));
    case "usage":
      return await usage(usageContext(session, deps), args);

    // ── provider discovery ──────────────────────────────────────────────
    case "list_providers":
      return listProviders(providersContext(session, deps));
    case "refresh_provider_models":
      return await refreshProviderModels(providersContext(session, deps), args);
    case "refresh_all_provider_models":
      return await refreshAllProviderModels(providersContext(session, deps));
    case "list_provider_models":
      return listProviderModels(providersContext(session, deps), args);

    default:
      throw invalidRequest(`Unknown command: ${cmd.name}`);
  }
}

/**
 * Run a command that needs no character.
 *
 * A strict subset of the table above, and the refusal is the point: it is what
 * tells a client that `status` is meaningless before a character is chosen,
 * rather than answering for an arbitrary one.
 */
export function runCharacterlessCommand(
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): unknown {
  const args = (cmd.args ?? {}) as Args;
  switch (cmd.name) {
    case "list_characters":
      // No active character to mark, which is the whole difference from the
      // character-backed arm: that one lists the current character first, and
      // this one is in discovery order because there is no current character.
      return listCharacters(session.config.dirs.config);
    case "list_models":
      return listModels(session, args);
    case "background_models":
      return backgroundModels(session);
    case "list_providers":
      return listProviders(providersContext(session, deps));
    case "list_provider_models":
      return listProviderModels(providersContext(session, deps), args);
    default:
      throw invalidRequest(`Command '${cmd.name}' requires a character`);
  }
}

/** Whether a name can be answered without a character at all. */
export function isCharacterless(name: string): boolean {
  return CHARACTERLESS.has(name);
}

/**
 * The frame a command's outcome becomes.
 *
 * A success carries the command's own name back, which is what lets a client
 * correlate an answer it did not ask for a rid on. A failure carries the code
 * the handler chose; anything thrown that is not a {@link CommandError} is an
 * internal error, because a handler that threw a bare `Error` has already
 * failed in a way no code describes.
 */
export function commandFrame(name: string, outcome: { ok: unknown } | { err: unknown }): ServerMessage {
  if ("ok" in outcome) {
    return { type: "command_output", rid: null, name, data: outcome.ok };
  }
  const e = outcome.err;
  const error =
    e instanceof CommandError
      ? e
      : internalError(e instanceof Error ? e.message : String(e));
  console.warn(`shore: command ${name} failed: ${error.message}`);
  return { type: "error", rid: null, code: error.code, message: error.message };
}

/** An arm whose dependency has not been wired. See the module doc. */
function unwired(name: string): CommandError {
  return internalError(`${name} is not available in this build`);
}

// ── the narrow contexts, built per call ─────────────────────────────────

function statusContext(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
): Parameters<typeof status>[0] {
  return {
    characterName: engine.characterName,
    turnCount: engine.turnCount(),
    activeModel: session.activeModel,
    config: { app: { defaults: { model: session.config.app.defaults.model } }, dirs: session.config.dirs },
    sessionTokens: deps.sessionTokens,
    autonomy: deps.autonomy,
    diagnostics: deps.diagnostics,
    now: deps.now ?? Date.now,
    localNow: deps.localNow ?? Date.now,
  };
}

function providersContext(
  session: CommandSession,
  deps: CommandDeps,
): Parameters<typeof listProviders>[0] {
  return {
    config: session.config,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
}

function usageContext(
  session: CommandSession,
  deps: CommandDeps,
): Parameters<typeof usage>[0] {
  if (deps.ledgerPath === undefined) {
    throw internalError(
      "provider error: usage reports need a ledger on disk; this client has none configured",
    );
  }
  return { ledger: deps.ledgerPath, usage: usageView(session.config.app.usage) };
}

/**
 * `[usage]` as the budget gate reads it.
 *
 * A rename in the other direction to the rest of this file: the parsed config
 * spells an unset filter `undefined` because it is a struct field, and the
 * gate spells it *absent* because it came from the wire, where the daemon
 * omitted it. Dropping the undefined keys is the whole translation.
 */
function usageView(cfg: LoadedConfig["app"]["usage"]): UsageConfig {
  return {
    timezone: cfg.timezone,
    allow_compaction_over_budget: cfg.allow_compaction_over_budget,
    budgets: cfg.budgets.map(
      (b) => defined(b as unknown as Record<string, unknown>) as unknown as UsageBudgetConfig,
    ),
    spike_warnings: cfg.spike_warnings,
  };
}

/** The record without its undefined-valued keys. */
function defined(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined));
}
