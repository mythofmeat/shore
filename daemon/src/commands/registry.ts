import type { ConversationEngine } from "../engine/conversation.ts";
import type { OperationInput, OperationName, OperationResult } from "../operations/contracts.ts";
import { assertContractBindings } from "../operations/contracts.ts";
import { defineOperation, discoverOperations, type OperationPresentation, type OperationRegistry } from "../operations/registry.ts";
import type { CommandDeps, CommandSession } from "./dispatch.ts";
import { internalError, invalidRequest } from "./errors.ts";
import { characterInfo, createCharacter, listCharacters, switchCharacter } from "./navigation.ts";
import { archiveThread, forkThread, listThreads, newThread, switchThread, threadHome, threadLabel, threadModel } from "./threads.ts";
import { threadContext, threadListingContext } from "./thread_context.ts";

export interface CommandOperationContext {
  session: CommandSession;
  deps: CommandDeps;
  engine?: ConversationEngine;
}

function engineOf(context: CommandOperationContext): ConversationEngine {
  if (context.engine === undefined) throw invalidRequest("This operation requires a character");
  return context.engine;
}

function register<N extends OperationName>(
  name: N,
  presentation: OperationPresentation<N>,
  handler: (context: CommandOperationContext, input: OperationInput<N>) => OperationResult<N> | Promise<OperationResult<N>>,
) {
  return defineOperation(name, presentation, handler);
}

const characterPresentation = {
  category: "Characters", scope: "global", prerequisites: [], effects: ["read"], confirmation: "none",
} as const;
const threadPresentation = {
  category: "Threads", scope: "character", prerequisites: ["threads"], effects: ["read"], confirmation: "none",
} as const;
const threadName = { label: "Thread", choices: "threads" } as const;

export const commandOperations: OperationRegistry<CommandOperationContext> = {
  list_characters: register("list_characters", {
    ...characterPresentation, label: "Browse characters", fields: {},
  }, ({ session, engine }) => listCharacters(session.config.dirs.config, engine?.characterName, session.config.dirs.workspace)),
  create_character: register("create_character", {
    ...characterPresentation, label: "Create character", effects: ["workspace_write"],
    fields: { name: { label: "Character name" } },
  }, ({ session }, args) => createCharacter(session.config.dirs.config, args, session.config.dirs.workspace)),
  switch_character: register("switch_character", {
    ...characterPresentation, label: "Select character", scope: "selection", effects: ["selection"],
    fields: { name: { label: "Character", choices: "characters" } },
  }, ({ session, engine }, args) => switchCharacter(session.config.dirs.config, engine?.characterName ?? session.characterName, args, session.config.dirs.workspace)),
  character_info: register("character_info", {
    ...characterPresentation, label: "Inspect character", scope: "character",
    fields: { name: { label: "Character", choices: "characters", hint: "Omit for the selected character" } },
  }, (context, args) => characterInfo({
    configDir: context.session.config.dirs.config,
    dataDir: context.session.dataDir,
    active: engineOf(context).characterName,
    workspaceRoot: context.session.config.dirs.workspace,
  }, args)),
  list_threads: register("list_threads", {
    ...threadPresentation, label: "Browse threads", fields: {},
  }, async (context) => listThreads(await threadListingContext(context.deps, engineOf(context), context.session))),
  switch_thread: register("switch_thread", {
    ...threadPresentation, label: "Select thread", effects: ["selection"],
    fields: { name: threadName, resync: { label: "Refresh history", hint: "Request a full history snapshot even if already selected" } },
  }, (context, args) => switchThread(threadContext(context.deps, engineOf(context), context.session.signal), args)),
  create_thread: register("create_thread", {
    ...threadPresentation, label: "Create thread", effects: ["history_write"],
    fields: {
      name: { label: "New thread ID" }, label: { label: "Label" },
      model: { label: "Chat model", choices: "models" }, compaction: { label: "Enable scheduled compaction" },
    },
  }, async (context, args) => newThread(await threadListingContext(context.deps, engineOf(context), context.session), args)),
  archive_thread: register("archive_thread", {
    ...threadPresentation, label: "Archive thread", effects: ["history_write"], confirmation: "archive",
    fields: { name: threadName },
  }, async (context, args) => {
    const engine = engineOf(context);
    const result = await archiveThread(await threadListingContext(context.deps, engine, context.session), args);
    context.deps.historyIndex?.noteMutation?.(engine.characterName);
    return result;
  }),
  fork_thread: register("fork_thread", {
    ...threadPresentation, label: "Fork thread", effects: ["history_write"],
    fields: {
      name: { label: "New thread ID" }, from: { label: "Source thread", choices: "threads", hint: "Omit for the selected thread" },
      turns: { label: "Recent turns", hint: "Omit to copy the complete active context" },
    },
  }, async (context, args) => {
    const engine = engineOf(context);
    const result = await forkThread(await threadListingContext(context.deps, engine, context.session), args);
    context.deps.historyIndex?.noteMutation?.(engine.characterName);
    return result;
  }),
  thread_home: register("thread_home", {
    ...threadPresentation, label: "Set heartbeat home", effects: ["history_write"], fields: { name: threadName },
  }, async (context, args) => threadHome(await threadListingContext(context.deps, engineOf(context), context.session), args)),
  thread_label: register("thread_label", {
    ...threadPresentation, label: "Label thread", effects: ["history_write"],
    fields: { name: threadName, label: { label: "Label", hint: "Leave empty to clear" } },
  }, async (context, args) => threadLabel(await threadListingContext(context.deps, engineOf(context), context.session), args)),
  thread_model: register("thread_model", {
    ...threadPresentation, label: "Pin thread model", effects: ["model_selection"],
    fields: { name: threadName, model: { label: "Chat model", choices: "models", hint: "Leave empty to inherit the character default" } },
  }, async (context, args) => threadModel(await threadListingContext(context.deps, engineOf(context), context.session), args)),
};

assertContractBindings(Object.keys(commandOperations));

export function isRegisteredOperation(name: string): name is OperationName {
  return Object.hasOwn(commandOperations, name);
}

export function runRegisteredOperation<N extends OperationName>(
  name: N,
  context: CommandOperationContext,
  args: unknown,
): OperationResult<N> | Promise<OperationResult<N>> {
  const registration = commandOperations[name];
  if (registration.presentation.scope === "character") engineOf(context);
  if (registration.presentation.prerequisites.includes("threads") && context.deps.threads === undefined) {
    throw internalError("thread commands need a character registry, and this one has none");
  }
  return registration.invoke(context, args);
}

export function commandCatalogue(context?: CommandOperationContext) {
  return discoverOperations(commandOperations).map((operation) => ({
    ...operation,
    available: context === undefined ? undefined :
      (operation.scope !== "character" || context.engine !== undefined) &&
      (!operation.prerequisites.includes("threads") || context.deps.threads !== undefined),
  }));
}
