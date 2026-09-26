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
import type { RunToolContext } from "./run_tool.ts";

import type { ThreadRegistry } from "./threads.ts";
import { commandOperations, isRegisteredOperation, runRegisteredOperation } from "./registry.ts";
import type { HistoryIndexSource } from "./history_index.ts";
import type { WorkspaceIndexSource } from "./workspace_index.ts";
import type { McpServerStatus } from "../tools/mcp_registry.ts";
import type { ArchiveContext } from "./archive.ts";

export interface CommandSession {
  config: LoadedConfig;
  configPath: string;
  dataDir: string;
  characterName: string | undefined;
  activeModel: string | undefined;
  thread?: string;
  threadModel?: string;
  homeThreadModel?: string;
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

export async function runCommand(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
  cmd: Command,
): Promise<unknown> {
  if (isRegisteredOperation(cmd.name)) {
    return await runRegisteredOperation(cmd.name, { engine, session, deps }, cmd.args);
  }
  throw invalidRequest(`Unknown command: ${cmd.name}`);
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
  throw invalidRequest(`Command '${cmd.name}' requires a character`);
}

export function isCharacterless(name: string): boolean {
  return isRegisteredOperation(name) && commandOperations[name].presentation.scope === "global";
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
