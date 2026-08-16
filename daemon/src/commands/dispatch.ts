import { describeError } from "../llm/errors.ts";
import type { Command } from "../protocol/Command.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ResolvedModel } from "../config/models.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { CallStore } from "../call_store.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { AutonomyService } from "../autonomy/service.ts";
import { localWallClock } from "../autonomy/activity.ts";
import { CommandError, internalError, invalidRequest } from "./errors.ts";
import { callLog, transcript } from "./call_log.ts";
import { subagentTrace } from "./subagent_trace.ts";
import {
  config,
  configCheck,
  configReload,
  configSchemaCommand,
  tools,
  type ConfigRuntime,
} from "./config.ts";
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
import { sessionActivateCommand, type SessionActivateContext } from "./activate.ts";
import { keepalivePingNowCommand, type KeepalivePingContext } from "./keepalive.ts";
import { memory } from "./memory.ts";
import { describeTool, runTool, type RunToolContext } from "./run_tool.ts";
import {
  effectiveChatModel,
  listModels,
  modelInfo,
  modelSettings,
  resetModel,
  setModelSetting,
  switchModel,
} from "./models.ts";
import {
  characterInfo,
  createCharacter,
  listCharacters,
  switchCharacter,
  type Args,
} from "./navigation.ts";
import {
  listProviderModels,
  listProviders,
  refreshAllProviderModels,
  refreshProviderModels,
} from "./providers.ts";
import {
  errorLog,
  heartbeatLog,
  heartbeatSetActive,
  heartbeatSetDormant,
  heartbeatTickNow,
  status,
} from "./status.ts";
import { usage } from "./usage.ts";
import type { SessionTokens } from "../handler/persistence.ts";
import type { WorkspaceIndexSource } from "./workspace_index.ts";
import { usageConfigView } from "../ledger/budget.ts";

export interface CommandSession {
  config: LoadedConfig;
  configPath: string;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  activeResolvedModel: ResolvedModel | undefined;
  runtime: ConfigRuntime;
  env?: NodeJS.ProcessEnv;
}

export interface CommandDeps {
  sessionTokens: SessionTokens;
  autonomy: AutonomyService;
  diagnostics: Diagnostics;
  callStore: CallStore | undefined;
  ledgerPath: string | undefined;
  now?: () => number;
  localNow?: () => number;
  fetchImpl?: typeof fetch;
  compaction?: Omit<CompactContext, "config" | "autonomy">;
  keepalive?: Omit<KeepalivePingContext, "config" | "dataDir">;
  activate?: Pick<SessionActivateContext, "register">;
  runTool?: Pick<RunToolContext, "tools" | "mcpTools">;
  workspaceIndex?: WorkspaceIndexSource;
}

const CHARACTERLESS = new Set([
  "list_characters",
  "create_character",
  "list_models",
  "list_providers",
  "list_provider_models",
]);

export async function runCommand(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): Promise<unknown> {
  const args = (cmd.args ?? {}) as Args;
  const character = engine.characterName;
  const configDir = session.config.dirs.config;
  const workspaceRoot = session.config.dirs.workspace;

  switch (cmd.name) {
    case "list_characters":
      return listCharacters(configDir, character, workspaceRoot);
    case "create_character":
      return createCharacter(configDir, args, workspaceRoot);
    case "switch_character":
      return switchCharacter(configDir, character, args, workspaceRoot);
    case "character_info":
      return await characterInfo(
        { configDir, dataDir: session.dataDir, active: character, workspaceRoot },
        args,
      );

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
    case "memory":
      return await memory(configDir, character, args, workspaceRoot);
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
      return tools(session, (deps.runTool?.mcpTools() ?? []).map((t) => t.full_name));
    case "config_check":
      return configCheck(session, session.env ?? process.env);
    case "config_schema":
      return configSchemaCommand(session);
    case "config_reload":
      return await configReload(session, args);
    case "error_log":
      return errorLog(statusContext(engine, session, deps), args);
    case "heartbeat_log":
      return await heartbeatLog(statusContext(engine, session, deps), args);
    case "call_log":
      return callLog({ characterName: character, callStore: deps.callStore }, args);
    case "transcript":
      return transcript({ characterName: character, callStore: deps.callStore }, args);
    case "subagent_trace":
      return await subagentTrace({ dataDir: session.dataDir, characterName: character }, args);
    case "heartbeat_tick_now":
      return heartbeatTickNow(statusContext(engine, session, deps));
    case "session_activate":
      if (deps.keepalive === undefined || deps.activate === undefined) {
        throw unwired("session_activate");
      }
      return await sessionActivateCommand(character, {
        ...deps.keepalive,
        ...deps.activate,
        autonomy: deps.autonomy,
        config: session.config,
        dataDir: session.dataDir,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
    case "run_tool":
      if (deps.runTool === undefined) throw unwired("run_tool");
      if (args["describe"] === true) {
        return describeTool(
          character,
          {
            ...deps.runTool,
            config: session.config,
            dataDir: session.dataDir,
            conversation: engine.messages(),
          },
          args,
        );
      }
      return await runTool(
        character,
        {
          ...deps.runTool,
          config: session.config,
          dataDir: session.dataDir,
          conversation: engine.messages(),
        },
        args,
      );
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

export function runCharacterlessCommand(
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): unknown {
  const args = (cmd.args ?? {}) as Args;
  switch (cmd.name) {
    case "list_characters":
      return listCharacters(
        session.config.dirs.config,
        undefined,
        session.config.dirs.workspace,
      );
    case "create_character":
      return createCharacter(session.config.dirs.config, args, session.config.dirs.workspace);
    case "list_models":
      return listModels(session, args);
    case "list_providers":
      return listProviders(providersContext(session, deps));
    case "list_provider_models":
      return listProviderModels(providersContext(session, deps), args);
    default:
      throw invalidRequest(`Command '${cmd.name}' requires a character`);
  }
}

export function isCharacterless(name: string): boolean {
  return CHARACTERLESS.has(name);
}

export function commandFrame(name: string, outcome: { ok: unknown } | { err: unknown }): ServerMessage {
  if ("ok" in outcome) {
    return { type: "command_output", rid: null, name, data: outcome.ok };
  }
  const e = outcome.err;
  const error = e instanceof CommandError ? e : internalError(describeError(e));
  console.warn(`shore: command ${name} failed: ${error.message}`);
  return { type: "error", rid: null, code: error.code, message: error.message };
}

function unwired(name: string): CommandError {
  return internalError(`${name} is not available in this build`);
}

function statusContext(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
): Parameters<typeof status>[0] {
  return {
    characterName: engine.characterName,
    turnCount: engine.turnCount(),
    activeModel: effectiveChatModel(session.config, engine.characterName)?.qualifiedName,
    config: { app: { defaults: { model: session.config.app.defaults.model } }, dirs: session.config.dirs },
    sessionTokens: deps.sessionTokens,
    autonomy: deps.autonomy,
    diagnostics: deps.diagnostics,
    now: deps.now ?? Date.now,
    localNow: deps.localNow ?? (() => localWallClock(Date.now())),
    workspaceIndex:
      deps.workspaceIndex === undefined
        ? undefined
        : { ...deps.workspaceIndex, ...(deps.now === undefined ? {} : { now: deps.now }) },
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
  return {
    ledger: deps.ledgerPath,
    usage: usageConfigView(session.config.app.usage),
    callStore: deps.callStore,
  };
}
