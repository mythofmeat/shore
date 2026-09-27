import { requestCatalogue } from "../operations/requests.ts";
import { compact } from "./compact.ts";
import { deleteCharacter, exportCharacter, importCharacter, type ArchiveContext } from "./archive.ts";
import { usage } from "./usage.ts";
import { usageConfigView } from "../ledger/budget.ts";
import { describeTool, runTool } from "./run_tool.ts";
import { clear, segments } from "./segments.ts";
import { status, errorLog, heartbeatLog, heartbeatTickNow, heartbeatSetDormant, heartbeatSetActive } from "./status.ts";
import { statusContext } from "./status_context.ts";
import { callLog, transcript } from "./call_log.ts";
import { subagentTrace } from "./subagent_trace.ts";
import { keepalivePingNowCommand } from "./keepalive.ts";
import { sessionActivateCommand } from "./activate.ts";
import type { OperationPrerequisite } from "../protocol/OperationPrerequisite.ts";
import { changeThreadModel, effectiveChatModel, listModels, favoriteModel, modelInfo, modelSettings, resetModel, setModelSetting, switchModel } from "./models.ts";
import type { ConversationEngine } from "../engine/conversation.ts";
import type { OperationInput, OperationName, OperationResult } from "../operations/contracts.ts";
import { assertContractBindings } from "../operations/contracts.ts";
import { defineOperation, discoverOperations, type OperationPresentation, type OperationRegistry } from "../operations/registry.ts";
import type { CommandDeps, CommandSession } from "./dispatch.ts";
import { internalError, invalidRequest } from "./errors.ts";
import { characterInfo, createCharacter, listCharacters, switchCharacter } from "./navigation.ts";
import { archiveThread, forkThread, listThreads, newThread, switchThread, threadHome, threadLabel, threadModel } from "./threads.ts";
import { archiveWithSignal, threadContext, threadListingContext } from "./thread_context.ts";
import { alt, deleteMessages, edit, get, historyPage, injectSystem, listAlternatives, log } from "./conversation.ts";
import { config, configCheck, configSchemaCommand, configReload, tools } from "./config.ts";
import { listProviders, listProviderModels, refreshProviderModels, refreshAllProviderModels, type ProvidersContext } from "./providers.ts";

export interface CommandOperationContext {
  session: CommandSession;
  deps: CommandDeps;
  engine?: ConversationEngine;
}

const LEDGER_UNAVAILABLE = "provider error: usage reports need a ledger on disk; this client has none configured";

function engineOf(context: CommandOperationContext): ConversationEngine {
  if (context.engine === undefined) throw invalidRequest("This operation requires a character");
  return context.engine;
}

function archiveContext({ session, deps }: CommandOperationContext): ArchiveContext {
  if (deps.archive === undefined) throw internalError("Character archives are unavailable");
  return archiveWithSignal(deps.archive, session.signal);
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
const diagnosticPresentation = { category: "Diagnostics", scope: "character", prerequisites: [], effects: ["read"], confirmation: "none" } as const;
const diagnosticCount = { label: "Recent entries", hint: "Zero returns an empty list; omit for the command's default" } as const;
const storedDiagnosticCount = { ...diagnosticCount, hint: "Zero returns all stored entries; omit for the command's default" } as const;
const heartbeatPresentation = { ...diagnosticPresentation, prerequisites: ["autonomy"], effects: ["runtime_write"] } as const;
const modelPresentation = { category: "Models", scope: "optional_character", prerequisites: [], effects: ["read"], confirmation: "none" } as const;
const modelTargetFields = {
  name: { label: "Model", choices: "models", hint: "Omit for the active model; do not combine with role selectors" },
  background_task: { label: "Background task", hint: "all, heartbeat or compaction; settings can also affect other roles sharing this model" },
  subagent: { label: "Subagent", choices: "subagents", hint: "A configured name, or all for the shared subagent model" },
} as const;
const modelHiddenField = { label: "Include hidden models", hint: "Allow a model excluded by discovery filters" } as const;
const modelSettingField = { label: "Setting key", choices: "model_settings" } as const;
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
  export_character: register("export_character", { ...characterPresentation, prerequisites: ["archive"], effects: ["read", "workspace_write"], label: "Export character", fields: {
    character: { label: "Character", choices: "characters" },
    output: { label: "Archive output on daemon host", hint: "Absolute server path to a new archive; its parent directory must exist. Existing files are never overwritten." },
  } }, (context, args) => exportCharacter(archiveContext(context), args)),
  import_character: register("import_character", { ...characterPresentation, prerequisites: ["archive"], effects: ["workspace_write", "history_write", "config_write", "runtime_write"], label: "Import character", fields: {
    archive: { label: "Archive on daemon host", hint: "Absolute server path to a Shore character archive. Existing characters are never overwritten." },
  } }, (context, args) => importCharacter(archiveContext(context), args)),
  delete_character: register("delete_character", { ...characterPresentation, prerequisites: ["archive"], effects: ["workspace_write", "history_write", "config_write", "runtime_write"], confirmation: "delete", label: "Delete character", fields: {
    character: { label: "Character", choices: "characters" }, confirm: { label: "Repeat character name", hint: "Deletion permanently removes the character's workspace, configuration, history, usage records and cached data." },
    archive: { label: "Backup archive on daemon host", hint: "Optional absolute server path to a new backup. If the backup fails, deletion does not proceed." },
  } }, (context, args) => deleteCharacter(archiveContext(context), args)),
  usage: register("usage", { category: "Usage", scope: "optional_character", prerequisites: ["ledger"], effects: ["read"], confirmation: "none", label: "Usage report", fields: {
    last: { label: "Period", hint: "today, week, month, all, or a count such as 4h, 7d, 2w, 1M; omit for the current budget window or today" },
    character: { label: "Character filter", choices: "characters", hint: "Omit for all characters, including when a conversation is selected" },
    provider: { label: "Provider filter", choices: "providers" }, api_key: { label: "API key name", hint: "Configured name, not a credential; unknown matches older records" },
    model: { label: "Model filter", hint: "Ledger model ID" }, call_type: { label: "Call type", hint: "For example message, tool_loop, heartbeat or subagent" },
    group_by: { label: "Group by" }, budget: { label: "Budgets only", hint: "Reports configured budget scopes independently of the report filters; takes precedence over other modes" },
    anomalies: { label: "Cache anomalies", hint: "today uses a seven-day lookback; exports and grouping take precedence" },
    export_csv: { label: "Export CSV", hint: "Full filtered ledger; takes precedence over grouping and anomalies" }, export_tsv: { label: "Export TSV", hint: "Full filtered ledger; takes precedence over CSV" },
  } }, ({ session, deps }, args) => {
    if (deps.ledgerPath === undefined) throw internalError(LEDGER_UNAVAILABLE);
    const chatModel = args.budget === true ? effectiveChatModel(session.config, session.characterName, session.threadModel) : undefined;
    return usage({ ledger: deps.ledgerPath, cacheDir: session.config.dirs.cache, usage: usageConfigView(session.config.app.usage), callStore: deps.callStore, claudePlanLimits: chatModel?.sdk === "claude_agent" }, args);
  }),
  run_tool: register("run_tool", { category: "Tools", scope: "character", prerequisites: ["tool_execution"], effects: ["workspace_write", "history_write", "config_write", "provider_call"], confirmation: "execute", label: "Run tool", fields: {
    tool: { label: "Tool", choices: "tools", hint: "Built-in tool, configured ask_<subagent>, or connected MCP tool" },
    input: { label: "Tool input", hint: "Structured arguments; the daemon validates them using the selected tool's schema" },
    pairs: { label: "Argument overrides", hint: "Text values are converted using the tool schema and override matching Tool input fields" },
    raw: { label: "Include full output", hint: "Keep the complete result and nested tool inputs/outputs, including text omitted from the normal window" },
    describe: { label: "Describe only", hint: "Read the tool definition without running it" },
  }, policies: [{ condition: { kind: "equals", field: "describe", value: true }, effects: ["read"], confirmation: "none" }] }, (context, args) => {
    const engine = engineOf(context);
    const dependencies = context.deps.runTool;
    if (dependencies === undefined) throw internalError("run_tool is not available in this build");
    const toolContext = { ...dependencies, config: context.session.config, dataDir: context.session.dataDir, conversation: engine.messages(), ...(context.session.emit === undefined ? {} : { emit: context.session.emit }), ...(context.session.signal === undefined ? {} : { signal: context.session.signal }) };
    return args.describe === true ? describeTool(engine.characterName, toolContext, args) : runTool(engine.characterName, toolContext, args);
  }),
  compact: register("compact", { category: "Memory", scope: "character", prerequisites: ["compaction"], effects: ["history_write", "workspace_write", "provider_call"], confirmation: "archive", label: "Compact active context", fields: {
    dry_run: { label: "Preview only", hint: "Uses the provider to preview memory writes without archiving the conversation" },
    restart: { label: "Restart paused work", hint: "Discard the paused checkpoint and summarize again; already written memory files remain" },
    keep_turns: { label: "Retain recent turns", hint: "Zero retains no recent user turns; omit for configured retention" },
  }, policies: [{ condition: { kind: "equals", field: "dry_run", value: true }, effects: ["read", "provider_call"], confirmation: "none" }] }, (context, args) => {
    const engine = engineOf(context);
    const compaction = context.deps.compaction;
    if (compaction === undefined) throw internalError("compact is not available in this build");
    return compact(engine, { ...compaction, config: context.session.config, autonomy: context.deps.autonomy, run: { ...compaction.run, ...(context.session.signal === undefined ? {} : { signal: context.session.signal }), ...(context.session.emit === undefined ? {} : { emit: context.session.emit }) } }, args);
  }),
  segments: register("segments", { category: "Memory", scope: "character", prerequisites: [], effects: ["history_write"], confirmation: "none", label: "Inspect and manage segments", fields: {
    action: { label: "Segment action", hint: "Omit to list segments; inspection and edits require an index" },
    index: { label: "Segment index" },
    value: { label: "Label or note", multiline: true, hint: "Used by label/note; explicitly unset or empty text clears the saved value" },
  }, policies: [
    { condition: { kind: "absent", field: "action" }, effects: ["read"], confirmation: "none" },
    ...([null, "list", "show"] as const).map((value) => ({ condition: { kind: "equals" as const, field: "action", value }, effects: ["read" as const], confirmation: "none" as const })),
  ] }, (context, args) => segments(context.session.dataDir, engineOf(context).characterName, engineOf(context).thread, args, context.deps.historyIndex)),
  clear: register("clear", { category: "Memory", scope: "character", prerequisites: [], effects: ["history_write"], confirmation: "archive", label: "Clear active context", fields: {
    exclude: { label: "Exclude from history search", hint: "The archived segment stays inspectable and can be included again" },
    note: { label: "Archive note", multiline: true },
  } }, (context, args) => clear(engineOf(context), {
    dataDir: context.session.dataDir,
    ...(context.deps.compaction?.repoint === undefined ? {} : { repoint: async (name) => await context.deps.compaction?.repoint?.(name, context.session.config) }),
    onComplete: (name) => context.deps.autonomy.onCompactionComplete(name, 0),
  }, args)),
  status: register("status", { ...diagnosticPresentation, label: "System status", fields: {} },
    (context) => status(statusContext(engineOf(context), context.session, context.deps))),
  error_log: register("error_log", { ...diagnosticPresentation, label: "Errors and key fallbacks", fields: { count: diagnosticCount } },
    (context, args) => errorLog(statusContext(engineOf(context), context.session, context.deps), args)),
  heartbeat_log: register("heartbeat_log", { ...diagnosticPresentation, label: "Heartbeat events", fields: { count: diagnosticCount } },
    (context, args) => heartbeatLog(statusContext(engineOf(context), context.session, context.deps), args)),
  call_log: register("call_log", { ...diagnosticPresentation, label: "Inspect model calls", fields: {
    id: { label: "Call ID", hint: "Omit to list recent calls" }, count: storedDiagnosticCount,
    call_type: { label: "Call type", hint: "Filter the listing by its ledger call type" },
    character: { label: "Call character filter", choices: "characters", hint: "Optional listing filter; defaults to the selected character" },
    diff: { label: "Compare calls", hint: "Compare the chosen call with its previous call or an explicit comparison ID" },
    against: { label: "Compare against call ID" }, wire: { label: "Include full HTTP bodies", hint: "Inspect captured request/response bodies and redacted headers" },
  } }, (context, args) => callLog({ characterName: engineOf(context).characterName, callStore: context.deps.callStore }, args)),
  transcript: register("transcript", { ...diagnosticPresentation, label: "Read transcripts", fields: { source: { label: "Transcript source", hint: "Heartbeat activity or memory recall" }, count: storedDiagnosticCount } },
    (context, args) => transcript({ characterName: engineOf(context).characterName, callStore: context.deps.callStore }, args)),
  subagent_trace: register("subagent_trace", { ...diagnosticPresentation, label: "Stored subagent runs", fields: { ids: { label: "Parent tool-use IDs", hint: "Omit to list recent runs" }, count: storedDiagnosticCount } },
    (context, args) => subagentTrace({ characterName: engineOf(context).characterName, dataDir: context.session.dataDir }, args)),
  heartbeat_tick_now: register("heartbeat_tick_now", { ...heartbeatPresentation, label: "Schedule heartbeat now", effects: ["runtime_write", "provider_call"], fields: {} },
    (context) => heartbeatTickNow(statusContext(engineOf(context), context.session, context.deps))),
  heartbeat_set_dormant: register("heartbeat_set_dormant", { ...heartbeatPresentation, label: "Make heartbeat dormant", fields: {} },
    (context) => heartbeatSetDormant(statusContext(engineOf(context), context.session, context.deps))),
  heartbeat_set_active: register("heartbeat_set_active", { ...heartbeatPresentation, label: "Activate heartbeat", fields: {} },
    (context) => heartbeatSetActive(statusContext(engineOf(context), context.session, context.deps))),
  keepalive_ping_now: register("keepalive_ping_now", { ...diagnosticPresentation, prerequisites: ["keepalive"], label: "Send cache keepalive ping", effects: ["runtime_write", "provider_call"], fields: {} },
    (context) => {
      if (context.deps.keepalive === undefined) throw internalError("keepalive_ping_now is not available in this build");
      return keepalivePingNowCommand(engineOf(context).characterName, { ...context.deps.keepalive, config: context.session.config, dataDir: context.session.dataDir });
    }),
  session_activate: register("session_activate", { ...diagnosticPresentation, prerequisites: ["keepalive", "session_activation"], label: "Activate session and cache", effects: ["runtime_write", "provider_call"], fields: {} },
    (context) => {
      if (context.deps.keepalive === undefined || context.deps.activate === undefined) throw internalError("session_activate is not available in this build");
      return sessionActivateCommand(engineOf(context).characterName, { ...context.deps.keepalive, ...context.deps.activate, autonomy: context.deps.autonomy, config: context.session.config, dataDir: context.session.dataDir, ...(context.deps.now === undefined ? {} : { now: context.deps.now }) });
    }),

  list_models: register("list_models", { ...modelPresentation, scope: "global", label: "Browse models", fields: { include_hidden: modelHiddenField, favorites_only: { label: "Favorites only" } } },
    ({ session }, args) => listModels(session, args)),
  favorite_model: register("favorite_model", { ...modelPresentation, scope: "global", label: "Favorite model", effects: ["model_selection"], fields: { name: { ...modelTargetFields.name, hint: "The model whose favorite status will change" }, favorite: { label: "Favorite", hint: "Omit to toggle; explicit true/false avoids toggling twice" } } },
    ({ session }, args) => favoriteModel(session, args)),
  model_info: register("model_info", { ...modelPresentation, label: "Inspect model", fields: modelTargetFields },
    ({ session }, args) => modelInfo(session, args)),
  switch_model: register("switch_model", { ...modelPresentation, label: "Select model", effects: ["model_selection", "config_write"], fields: { ...modelTargetFields, name: { ...modelTargetFields.name, hint: "Model to select. Chat selection pins the current thread; roles write global configuration." }, include_hidden: modelHiddenField } },
    async ({ session, deps, engine }, args) => {
      const threads = deps.threads;
      if (engine !== undefined && threads !== undefined && args["background_task"] === undefined && args["subagent"] === undefined) {
        return await changeThreadModel(session, args, (model) => threads.setThreadModel(engine.characterName, engine.thread, model, session.signal));
      }
      return switchModel(session, args);
    }),
  reset_model: register("reset_model", { ...modelPresentation, label: "Reset model selection", effects: ["model_selection", "config_write"], fields: { background_task: modelTargetFields.background_task, subagent: modelTargetFields.subagent } },
    async ({ session, deps, engine }, args) => {
      const threads = deps.threads;
      if (engine !== undefined && threads !== undefined && args["background_task"] === undefined && args["subagent"] === undefined) {
        return await changeThreadModel(session, args, (model) => threads.setThreadModel(engine.characterName, engine.thread, model, session.signal), true);
      }
      return resetModel(session, args);
    }),
  model_settings: register("model_settings", { ...modelPresentation, label: "Inspect model settings", fields: { ...modelTargetFields, key: modelSettingField, overview: { label: "Role overview", hint: "Show saved settings across roles" } } },
    ({ session }, args) => modelSettings(session, args)),
  set_model_setting: register("set_model_setting", { ...modelPresentation, label: "Change model setting", effects: ["model_selection"], fields: { ...modelTargetFields, key: modelSettingField, scope: { label: "Preference scope", hint: "character (default), or global to save across characters" }, value: { label: "Setting value", hint: "Omit or explicitly unset to clear the saved setting. Vendor object values have structured fields." } } },
    ({ session }, args) => setModelSetting(session, args)),

  config: register("config", { ...configPresentation, label: "Read or edit configuration", effects: ["read", "config_write"], fields: {
    key: { label: "Configuration key", choices: "config_keys", hint: "Omit to inspect the complete configuration" },
    value: { label: "New value", multiline: true, hint: "Omit to read; setting a value also requires a key. Lists accept bracketed values." },
  }, policies: [
    { condition: { kind: "absent", field: "value" }, effects: ["read"], confirmation: "none" },
    { condition: { kind: "equals", field: "value", value: null }, effects: ["read"], confirmation: "none" },
  ] }, ({ session }, args) => config(session, args)),
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
  }, (context) => ({ operations: commandCatalogue(context), requests: requestCatalogue(context.engine !== undefined) })),
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

const prerequisiteAvailable: Record<OperationPrerequisite, (context: CommandOperationContext) => boolean> = {
  archive: (context) => context.deps.archive !== undefined,
  tool_execution: (context) => context.deps.runTool !== undefined,
  ledger: (context) => context.deps.ledgerPath !== undefined,
  compaction: (context) => context.deps.compaction !== undefined,
  threads: (context) => context.deps.threads !== undefined,
  autonomy: (context) => context.engine !== undefined && context.deps.autonomy.status(context.engine.characterName) !== undefined,
  keepalive: (context) => context.deps.keepalive !== undefined,
  session_activation: (context) => context.deps.activate !== undefined,
};

export function runRegisteredOperation<N extends OperationName>(
  name: N,
  context: CommandOperationContext,
  args: unknown,
): OperationResult<N> | Promise<OperationResult<N>> {
  const registration = commandOperations[name];
  if (registration.presentation.scope === "character") engineOf(context);
  for (const requirement of registration.presentation.prerequisites) {
    if (prerequisiteAvailable[requirement](context)) continue;
    if (requirement === "ledger") throw internalError(LEDGER_UNAVAILABLE);
    if (requirement === "autonomy") throw invalidRequest(`No autonomy state for character '${engineOf(context).characterName}'`);
    throw internalError(requirement === "threads" ? "thread commands need a character registry, and this one has none" : `${name} is not available in this build`);
  }
  return registration.invoke(context, args);
}

export function commandCatalogue(context?: CommandOperationContext) {
  return discoverOperations(commandOperations).map((operation) => ({
    ...operation,
    ...(context === undefined ? {} : { available:
      (operation.scope !== "character" || context.engine !== undefined) &&
      operation.prerequisites.every((requirement) => prerequisiteAvailable[requirement](context)) }),
  }));
}
