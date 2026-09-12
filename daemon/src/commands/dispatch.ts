import { shoreLog } from "../log.ts";

import { describeError } from "../llm/errors.ts";
import type { FrameSink } from "../llm/stream.ts";
import type { Command } from "../protocol/Command.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LoadedConfig } from "../config/loader.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { CallStore } from "../call_store.ts";
import type { Diagnostics } from "../diagnostics.ts";
import type { AutonomyService } from "../autonomy/service.ts";
import { CommandError, internalError, invalidRequest } from "./errors.ts";
import {
  type ConfigRuntime,
} from "./config.ts";

import type { CompactContext } from "./compact.ts";
import type { SessionActivateContext } from "./activate.ts";
import type { KeepalivePingContext } from "./keepalive.ts";
import { describeTool, runTool, type RunToolContext } from "./run_tool.ts";
import type { Args } from "./navigation.ts";

import { usage } from "./usage.ts";
import type { ThreadRegistry } from "./threads.ts";
import { archiveWithSignal } from "./thread_context.ts";
import { commandOperations, isRegisteredOperation, runRegisteredOperation } from "./registry.ts";
import type { HistoryIndexSource } from "./history_index.ts";
import type { WorkspaceIndexSource } from "./workspace_index.ts";
import type { McpServerStatus } from "../tools/mcp_registry.ts";
import { usageConfigView } from "../ledger/budget.ts";
import {
  deleteCharacter,
  exportCharacter,
  importCharacter,
  type ArchiveContext,
} from "./archive.ts";

export interface CommandSession {
  config: LoadedConfig;
  configPath: string;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  thread?: string;
  threadModel?: string;
  runtime: ConfigRuntime;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  emit?: FrameSink;
}

export interface CommandDeps {
  threads?: ThreadRegistry;
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
  historyIndex?: HistoryIndexSource;
  mcpStatus?: () => readonly McpServerStatus[];
  archive?: ArchiveContext;
  onCharacterCreated?: (character: string) => Promise<void>;
}

const CHARACTERLESS = new Set([
  "export_character",
  "import_character",
  "delete_character",
]);

export async function runCommand(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): Promise<unknown> {
  if (isRegisteredOperation(cmd.name)) {
    return await runRegisteredOperation(cmd.name, { engine, session, deps }, cmd.args);
  }
  const args = (cmd.args ?? {}) as Args;
  const character = engine.characterName;

  switch (cmd.name) {
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
          ...(session.signal === undefined ? {} : { signal: session.signal }),
        },
        args,
      );
    case "usage":
      return await usage(usageContext(session, deps), args);

    default:
      throw invalidRequest(`Unknown command: ${cmd.name}`);
  }
}

export function runCharacterlessCommand(
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): unknown {
  if (isRegisteredOperation(cmd.name)) {
    if (!["global", "optional_character"].includes(commandOperations[cmd.name].presentation.scope)) {
      throw invalidRequest(`Command '${cmd.name}' requires a character`);
    }
    return runRegisteredOperation(cmd.name, { session, deps }, cmd.args);
  }
  const args = (cmd.args ?? {}) as Args;
  switch (cmd.name) {
    case "export_character": {
      if (deps.archive === undefined) throw unwired("export_character");
      return exportCharacter(archiveWithSignal(deps.archive, session.signal), args);
    }
    case "import_character": {
      if (deps.archive === undefined) throw unwired("import_character");
      return importCharacter(archiveWithSignal(deps.archive, session.signal), args);
    }
    case "delete_character": {
      if (deps.archive === undefined) throw unwired("delete_character");
      return deleteCharacter(archiveWithSignal(deps.archive, session.signal), args);
    }
    default:
      throw invalidRequest(`Command '${cmd.name}' requires a character`);
  }
}

export function isCharacterless(name: string): boolean {
  return isRegisteredOperation(name) ? commandOperations[name].presentation.scope === "global" : CHARACTERLESS.has(name);
}

export function commandFrame(name: string, outcome: { ok: unknown } | { err: unknown }): ServerMessage {
  if ("ok" in outcome) {
    return { type: "command_output", rid: null, name, data: outcome.ok };
  }
  const e = outcome.err;
  const error = e instanceof CommandError ? e : internalError(describeError(e));
  shoreLog.warn(`shore: command ${name} failed: ${error.message}`);
  return { type: "error", rid: null, code: error.code, message: error.message };
}

function unwired(name: string): CommandError {
  return internalError(`${name} is not available in this build`);
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
    cacheDir: session.config.dirs.cache,
    usage: usageConfigView(session.config.app.usage),
    callStore: deps.callStore,
  };
}
