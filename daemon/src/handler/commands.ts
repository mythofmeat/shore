import type { Command } from "../protocol/Command.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { configView, savedModelForCharacter } from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import { CharacterError } from "../characters.ts";
import {
  commandFrame,
  isCharacterless,
  runCharacterlessCommand,
  runCommand,
  type CommandDeps,
  type CommandSession,
} from "../commands/dispatch.ts";
import { internalError, invalidRequest } from "../commands/errors.ts";
import type { ConfigRuntime } from "../commands/config.ts";
import { runRegisteredOperation, isRegisteredOperation, commandOperations } from "../commands/registry.ts";
import { parseOperationInput, parseOperationResult } from "../operations/contracts.ts";
import { threadModelOf, type ThreadRecord } from "../engine/threads.ts";
import { afterConfigurationCommand, afterCommand, type DispatchRuntime, type ReloadSummary } from "./command_dispatch.ts";
import type { HandshakeProvider } from "../swp/connection.ts";
import type { SessionRouter } from "../swp/session.ts";
import type { FrameSink } from "../llm/stream.ts";
import type { RequestMeta } from "../swp/session.ts";

export interface CommandRegistry {
  resolveCharacter(selected: string | undefined): string;
  getOrCreate(name: string, thread?: string): Promise<ConversationEngine>;
  effectiveConfig(name: string): LoadedConfig;
  listThreads(name: string): readonly ThreadRecord[];
}

export interface CommandPathDeps {
  registry: CommandRegistry;
  globalConfig(): LoadedConfig;
  configPath: string;
  dataDir: string;
  commands: CommandDeps;
  runtime: ConfigRuntime;
  dispatchRuntime: DispatchRuntime;
  router: SessionRouter;
  handshake: HandshakeProvider;
  env?: NodeJS.ProcessEnv;
}

export function makeDispatchCommand(
  deps: CommandPathDeps,
): (cmd: Command, meta: RequestMeta, signal: AbortSignal) => Promise<ServerMessage> {
  return (cmd, meta, signal) => dispatchCommand(deps, cmd, meta, signal);
}

export async function dispatchCommand(
  originalDeps: CommandPathDeps,
  cmd: Command,
  meta: RequestMeta,
  signal: AbortSignal = new AbortController().signal,
): Promise<ServerMessage> {
  const archive = originalDeps.commands.archive;
  const deps = archive === undefined || meta.session.archiveLimits === undefined ? originalDeps : {
    ...originalDeps, commands: { ...originalDeps.commands, archive: { ...archive, limits: meta.session.archiveLimits } },
  };
  const sessionId = meta.session.sessionId;
  const selected = meta.session.selectedCharacter ?? undefined;
  const rid = meta.rid ?? undefined;

  if (isRegisteredOperation(cmd.name)) {
    try {
      parseOperationInput(cmd.name, cmd.args);
    } catch (error) {
      return frameWithRid(commandFrame(cmd.name, { err: error }), rid);
    }
  }

  if (isCharacterless(cmd.name) && !(cmd.name === "list_models" && selected !== undefined)) {
    return characterlessCommand(deps, cmd, sessionId, selected, rid, signal);
  }
  if (cmd.name === "switch_character") {
    return await switchCharacterCommand(deps, cmd, sessionId, rid, selected);
  }

  let character: string;
  const optionalCharacter = isRegisteredOperation(cmd.name) && commandOperations[cmd.name].presentation.scope === "optional_character";
  try {
    character = deps.registry.resolveCharacter(selected);
  } catch (e) {
    if (optionalCharacter) return characterlessCommand(deps, cmd, sessionId, selected, rid, signal);
    const message = e instanceof CharacterError ? e.message : String(e);
    return frameWithRid(commandFrame(cmd.name, { err: invalidRequest(message) }), rid);
  }

  let config: LoadedConfig;
  let engine: ConversationEngine;
  try {
    config = deps.registry.effectiveConfig(character);
    const thread = liveThread(deps.registry, character, meta.session.selectedThread);
    engine = await deps.registry.getOrCreate(character, thread);
  } catch (e) {
    if (optionalCharacter) return characterlessCommand(deps, cmd, sessionId, selected, rid, signal);
    const message = e instanceof Error ? e.message : String(e);
    return frameWithRid(commandFrame(cmd.name, { err: internalError(message) }), rid);
  }

  const session = characterSession(deps, character, config, sessionId, rid, signal, engine.thread);

  let frame: ServerMessage;
  try {
    const data = await runCommand(engine, session, deps.commands, cmd);
    const annotated = await afterCommand(cmd.name, cmd.args, data, {
      character,
      config: session.config,
      sessionId,
      rid,
      runtime: deps.dispatchRuntime,
      router: deps.router,
      handshake: deps.handshake,
    });
    frame = commandFrame(cmd.name, { ok: isRegisteredOperation(cmd.name) ? parseOperationResult(cmd.name, annotated) : annotated });
  } catch (e) {
    frame = commandFrame(cmd.name, { err: e });
  }

  return frameWithRid(frame, rid);
}

export function liveThread(
  registry: Pick<CommandRegistry, "listThreads">,
  character: string,
  selected: string | null,
): string | undefined {
  if (selected === null) return undefined;
  return registry.listThreads(character).some((t) => t.id === selected) ? selected : undefined;
}

async function switchCharacterCommand(
  deps: CommandPathDeps,
  cmd: Command,
  sessionId: number,
  rid: string | undefined,
  pinned: string | undefined,
): Promise<ServerMessage> {
  const globalConfig = deps.globalConfig();

  let frame: ServerMessage;
  try {
    const data = await runRegisteredOperation("switch_character", {
      session: {
        config: globalConfig,
        configPath: deps.configPath,
        dataDir: deps.dataDir,
        characterName: pinned,
        activeModel: undefined,
        runtime: deps.runtime,
      },
      deps: deps.commands,
    }, cmd.args);
    const annotated = await afterCommand(cmd.name, cmd.args, data, {
      character: data.character,
      config: deps.registry.effectiveConfig(data.character),
      sessionId,
      rid,
      runtime: deps.dispatchRuntime,
      router: deps.router,
      handshake: deps.handshake,
    });
    frame = commandFrame(cmd.name, { ok: isRegisteredOperation(cmd.name) ? parseOperationResult(cmd.name, annotated) : annotated });
  } catch (e) {
    frame = commandFrame(cmd.name, { err: e });
  }

  return frameWithRid(frame, rid);
}

async function characterlessCommand(
  deps: CommandPathDeps,
  cmd: Command,
  sessionId: number,
  selected: string | undefined,
  rid: string | undefined,
  signal: AbortSignal,
): Promise<ServerMessage> {
  const session: CommandSession = {
    config: deps.globalConfig(),
    configPath: deps.configPath,
    dataDir: deps.dataDir,
    characterName: undefined,
    activeModel: undefined,
    runtime: deps.runtime,
    signal,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };

  let frame: ServerMessage;
  try {
    const data = await runCharacterlessCommand(session, deps.commands, cmd);
    const annotated = await afterConfigurationCommand(cmd.name, cmd.args, data, { config: session.config, runtime: deps.dispatchRuntime });
    frame = commandFrame(cmd.name, { ok: isRegisteredOperation(cmd.name) ? parseOperationResult(cmd.name, annotated) : annotated });
  } catch (e) {
    frame = commandFrame(cmd.name, { err: e });
  }

  return frameWithRid(frame, rid);
}

function characterSession(
  deps: CommandPathDeps,
  character: string,
  config: LoadedConfig,
  sessionId: number,
  rid: string | undefined,
  signal: AbortSignal,
  thread?: string,
): CommandSession {
  const saved = savedModelForCharacter(
    configView(config),
    character,
    (view, cacheDir, name, includeHidden) =>
      findEffectiveModel(view, cacheDir, name, includeHidden),
  );

  const threadModel =
    thread === undefined
      ? undefined
      : threadModelOf(deps.registry.listThreads(character), thread);

  return {
    config,
    configPath: deps.configPath,
    dataDir: deps.dataDir,
    characterName: character,
    activeModel: saved?.qualifiedName,
    ...(thread === undefined ? {} : { thread }),
    ...(threadModel === undefined ? {} : { threadModel }),
    runtime: deps.runtime,
    signal,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    emit: sessionEmitter(deps.router, sessionId, rid),
  };
}

export function sessionEmitter(
  router: Pick<SessionRouter, "sendToSession">,
  sessionId: number,
  rid: string | undefined,
): FrameSink {
  return (msg) => {
    void router.sendToSession(sessionId, frameWithRid(msg, rid));
  };
}

function frameWithRid(frame: ServerMessage, rid: string | undefined): ServerMessage {
  if (rid === undefined) return frame;
  switch (frame.type) {
    case "command_output":
    case "error":
    case "stream_start":
    case "stream_chunk":
    case "stream_end":
    case "phase":
    case "tool_call":
    case "tool_result":
    case "send_image":
      return { ...frame, rid };
    default:
      return frame;
  }
}

export type { ReloadSummary };
