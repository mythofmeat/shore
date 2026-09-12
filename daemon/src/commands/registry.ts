import type { ConversationEngine } from "../engine/conversation.ts";
import type { OperationInput, OperationName, OperationResult } from "../operations/contracts.ts";
import { assertContractBindings } from "../operations/contracts.ts";
import { defineOperation, discoverOperations, type OperationPresentation, type OperationRegistry } from "../operations/registry.ts";
import type { CommandDeps, CommandSession } from "./dispatch.ts";
import { internalError, invalidRequest } from "./errors.ts";
import { characterInfo, createCharacter, listCharacters, switchCharacter } from "./navigation.ts";
import { archiveThread, forkThread, listThreads, newThread, switchThread, threadHome, threadLabel, threadModel } from "./threads.ts";
import { threadContext, threadListingContext } from "./thread_context.ts";
import { alt, deleteMessages, edit, get, historyPage, injectSystem, listAlternatives, log } from "./conversation.ts";
import { config, configCheck, configSchemaCommand, configReload, tools } from "./config.ts";
import { listProviders, listProviderModels, refreshProviderModels, refreshAllProviderModels, type ProvidersContext } from "./providers.ts";

export interface CommandOperationContext {
  session: CommandSession;
  deps: CommandDeps;
  engine?: ConversationEngine;
}

function engineOf(context: CommandOperationContext): ConversationEngine {
  if (context.engine === undefined) throw invalidRequest("This operation requires a character");
  return context.engine;
}

function providersContext({ session, deps }: CommandOperationContext): ProvidersContext {
  return { config: session.config, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) };
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
const configPresentation = {
  category: "Configuration", scope: "optional_character", prerequisites: [], effects: ["read"], confirmation: "none",
} as const;
const providerPresentation = {
  category: "Providers", scope: "global", prerequisites: [], effects: ["read"], confirmation: "none",
} as const;
const providerField = { label: "Provider", choices: "providers" } as const;
const threadPresentation = {
  category: "Threads", scope: "character", prerequisites: ["threads"], effects: ["read"], confirmation: "none",
} as const;
const threadName = { label: "Thread", choices: "threads" } as const;
const conversationPresentation = {
  category: "Conversation", scope: "character", prerequisites: [], effects: ["read"], confirmation: "none",
} as const;
const messageRef = { label: "Message reference", hint: "Message ID, 1-based index, negative index from the end, or last" } as const;
const historyFields = {
  turns: { label: "Recent turns", hint: "Defaults to 64; takes precedence over message count" },
  count: { label: "Message count", hint: "Used when recent turns is omitted" },
  role: { label: "Role filter" },
} as const;

export const commandOperations: OperationRegistry<CommandOperationContext> = {
  config: register("config", { ...configPresentation, label: "Read or edit configuration", effects: ["read", "config_write"], fields: {
    key: { label: "Configuration key", choices: "config_keys", hint: "Omit to inspect the complete configuration" },
    value: { label: "New value", multiline: true, hint: "Omit to read; setting a value also requires a key. Lists accept bracketed values." },
  } }, ({ session }, args) => config(session, args)),
  config_schema: register("config_schema", { ...configPresentation, label: "Browse configuration schema", fields: {} },
    ({ session }) => configSchemaCommand(session)),
  config_check: register("config_check", { ...configPresentation, label: "Check configuration", fields: {} },
    ({ session }) => configCheck(session, session.env ?? process.env)),
  config_reload: register("config_reload", { ...configPresentation, label: "Reload configuration", effects: ["config_write"], fields: {
    apply: { label: "Apply configuration", hint: "Omit or leave false to preview changes without applying" },
    refresh_prompts: { label: "Refresh prompt snapshot", hint: "Requires a selected character and Apply configuration" },
  } }, ({ session }, args) => configReload(session, args)),
  tools: register("tools", { ...configPresentation, label: "Inspect tool access", fields: {} },
    ({ session, deps }) => tools(session, (deps.runTool?.mcpTools() ?? []).map((tool) => tool.full_name))),
  list_providers: register("list_providers", { ...providerPresentation, label: "Browse providers", fields: {} },
    (context) => listProviders(providersContext(context))),
  list_provider_models: register("list_provider_models", { ...providerPresentation, label: "Browse provider models", fields: {
    provider: providerField, include_hidden: { label: "Include hidden models", hint: "Include models excluded by discovery filters" },
  } }, (context, args) => listProviderModels(providersContext(context), args)),
  refresh_provider_models: register("refresh_provider_models", { ...providerPresentation, label: "Refresh provider models", effects: ["provider_discovery"], fields: { provider: providerField } },
    (context, args) => refreshProviderModels(providersContext(context), args)),
  refresh_all_provider_models: register("refresh_all_provider_models", { ...providerPresentation, label: "Refresh all providers", effects: ["provider_discovery"], fields: {} },
    (context) => refreshAllProviderModels(providersContext(context))),
  discover_operations: register("discover_operations", {
    category: "Application", scope: "optional_character", prerequisites: [], effects: ["read"], confirmation: "none", label: "Browse available actions", fields: {},
  }, (context) => ({ operations: commandCatalogue(context) })),
  log: register("log", { ...conversationPresentation, label: "Read conversation history", fields: historyFields },
    (context, args) => log(engineOf(context), args)),
  history_page: register("history_page", { ...conversationPresentation, label: "Read earlier history", fields: { ...historyFields, before: { label: "Before cursor", hint: "A message cursor, or active for the start of the active context" } } },
    (context, args) => historyPage(engineOf(context), args)),
  get: register("get", { ...conversationPresentation, label: "Inspect message", fields: { ref: messageRef, role: historyFields.role } },
    (context, args) => get(engineOf(context), args)),
  edit: register("edit", { ...conversationPresentation, label: "Edit message", effects: ["history_write"], fields: { ref: messageRef, content: { label: "Message text", multiline: true } } },
    (context, args) => edit(engineOf(context), args)),
  delete: register("delete", { ...conversationPresentation, label: "Delete messages", effects: ["history_write"], confirmation: "delete", fields: { refs: { label: "Message references", hint: "One reference or a collection; each selected turn includes its tool loop" } } },
    (context, args) => deleteMessages(engineOf(context), args)),
  list_alternatives: register("list_alternatives", { ...conversationPresentation, label: "Browse alternative responses", fields: { ref: { ...messageRef, hint: "Omit for the latest assistant message" } } },
    (context, args) => listAlternatives(engineOf(context), args)),
  alt: register("alt", { ...conversationPresentation, label: "Select alternative response", effects: ["history_write"], fields: {
    ref: { ...messageRef, hint: "Omit for the latest assistant message" },
    index: { label: "Zero-based index", hint: "Takes precedence over position and direction" },
    position: { label: "One-based position", hint: "Used when index is omitted" },
    direction: { label: "Direction", hint: "Defaults to next; used when index and position are omitted" },
  } }, (context, args) => alt(engineOf(context), args)),
  inject_system: register("inject_system", { ...conversationPresentation, label: "Add system instruction", effects: ["history_write"], fields: { text: { label: "Instruction", multiline: true } } },
    (context, args) => injectSystem(engineOf(context), args)),
  list_characters: register("list_characters", {
    ...characterPresentation, label: "Browse characters", fields: {},
  }, ({ session, engine }) => listCharacters(session.config.dirs.config, engine?.characterName, session.config.dirs.workspace)),
  create_character: register("create_character", {
    ...characterPresentation, label: "Create character", effects: ["workspace_write"],
    fields: { name: { label: "Character name" } },
  }, ({ session, deps }, args) => {
    const result = createCharacter(session.config.dirs.config, args, session.config.dirs.workspace);
    return deps.onCharacterCreated === undefined
      ? result
      : deps.onCharacterCreated(result.character).then(() => result);
  }),
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
    ...(context === undefined ? {} : { available:
      (operation.scope !== "character" || context.engine !== undefined) &&
      (!operation.prerequisites.includes("threads") || context.deps.threads !== undefined) }),
  }));
}
