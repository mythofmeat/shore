import * as ts from "typescript/unstable/ast";
import terminal from "../../docs/capabilities/terminal.generated.json" with { type: "json" };
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import { actionControl } from "../src/browser/forms.ts";
import { parseInventorySources } from "./capability_inventory.ts";

type Route = { operations: string[]; fields: Record<string, string[]> };
const route = (operations: string, fields: Record<string, string> = {}): Route => ({ operations: operations.split(" ").filter(Boolean), fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.split(" ")])) });
const role = { chat: "@chat_role", background: "background_task", subagent: "subagent" };
const modelFields = (operation: string) => Object.fromEntries(Object.entries(role).map(([key, field]) => [key, field.startsWith("@") ? field : `${operation}.${field}`]));
const usage = { last: "usage.last", provider: "usage.provider", api_key: "usage.api_key", model: "usage.model", call_type: "usage.call_type" };

export const TERMINAL_ROUTES: Record<string, Route> = {
  shore: route("switch_character switch_thread", { character: "switch_character.name", thread: "switch_thread.name", addr: "@origin" }),
  "shore msg": route("", {}),
  "shore msg send": route("message inject_system", { message: "message.text inject_system.text", images: "message.images message.image_data @attachments", system: "inject_system.text" }),
  "shore msg regen": route("regen", { guidance: "regen.guidance" }),
  "shore msg alt": route("alt list_alternatives", { selector: "alt.direction alt.position list_alternatives.ref", msg_ref: "alt.ref list_alternatives.ref" }),
  "shore msg edit": route("edit get", { msg_ref: "edit.ref get.ref", content: "edit.content @editor" }),
  "shore msg delete": route("delete", { msg_refs: "delete.refs" }),
  "shore log": route("log get", { msg_ref: "get.ref", count: "log.turns", role: "log.role", follow: "@follow", content: "@content", reasoning: "@thinking", tools: "@tools", subagent_tools: "@subagents" }),
  "shore compact": route("compact", { keep_turns: "compact.keep_turns", restart: "compact.restart" }),
  "shore segments": route("segments"),
  "shore segments show": route("segments", { index: "segments.index" }),
  "shore segments exclude": route("segments", { index: "segments.index" }),
  "shore segments include": route("segments", { index: "segments.index" }),
  "shore segments label": route("segments", { index: "segments.index", label: "segments.value" }),
  "shore segments note": route("segments", { index: "segments.index", note: "segments.value" }),
  "shore clear": route("clear", { exclude: "clear.exclude", note: "clear.note" }),
  "shore trace": route("", {}),
  "shore trace calls": route("call_log", { id: "call_log.id", count: "call_log.count", call_type: "call_log.call_type", diff: "call_log.diff", against: "call_log.against", wire: "call_log.wire" }),
  "shore trace heartbeat": route("transcript", { count: "transcript.count" }),
  "shore trace events": route("heartbeat_log", { count: "heartbeat_log.count" }),
  "shore trace errors": route("error_log", { count: "error_log.count" }),
  "shore trace subagent": route("subagent_trace", { id: "subagent_trace.ids", count: "subagent_trace.count" }),
  "shore character": route("list_characters character_info", { info: "@character_info" }),
  "shore character use": route("switch_character", { name: "switch_character.name" }),
  "shore character info": route("character_info"),
  "shore character new": route("create_character", { name: "create_character.name" }),
  "shore character delete": route("delete_character", { name: "delete_character.character", archive: "delete_character.archive @archives", yes: "delete_character.confirm @confirmation" }),
  "shore thread": route("list_threads"),
  "shore thread use": route("switch_thread", { name: "switch_thread.name" }),
  "shore thread new": route("create_thread", { name: "create_thread.name", label: "create_thread.label", model: "create_thread.model", compaction: "create_thread.compaction" }),
  "shore thread label": route("thread_label", { name: "thread_label.name", label: "thread_label.label" }),
  "shore thread model": route("thread_model", { name: "thread_model.name", model: "thread_model.model" }),
  "shore thread home": route("thread_home", { name: "thread_home.name" }),
  "shore thread archive": route("archive_thread", { name: "archive_thread.name" }),
  "shore thread fork": route("fork_thread", { name: "fork_thread.name", from: "fork_thread.from", turns: "fork_thread.turns" }),
  "shore export": route("export_character", { character: "export_character.character", output: "export_character.output @archives" }),
  "shore import": route("import_character", { archive: "import_character.archive @archives" }),
  "shore status": route("status", { section: "@status_section" }),
  "shore debug": route("", {}),
  "shore debug heartbeat_tick_now": route("heartbeat_tick_now"),
  "shore debug heartbeat_status_dormant": route("heartbeat_set_dormant"),
  "shore debug heartbeat_status_active": route("heartbeat_set_active"),
  "shore debug keepalive_ping_now": route("keepalive_ping_now"),
  "shore debug session_activate": route("session_activate"),
  "shore debug tool": route("run_tool", { name: "run_tool.tool", args: "run_tool.pairs", input: "run_tool.input", describe: "run_tool.describe", raw: "run_tool.raw" }),
  "shore debug subagent": route("run_tool", { name: "run_tool.tool @subagent_tool", query: "run_tool.input @subagent_tool", raw: "run_tool.raw" }),
  "shore model": route("list_models model_info reset_model", { all: "list_models.include_hidden", favorites: "list_models.favorites_only", info: "@model_info", reset: "@model_reset" }),
  "shore model use": route("switch_model", { name: "switch_model.name", ...modelFields("switch_model") }),
  "shore model info": route("model_info", { name: "model_info.name", ...modelFields("model_info") }),
  "shore model setting": route("model_settings set_model_setting", { key: "model_settings.key set_model_setting.key", value: "set_model_setting.value", global: "set_model_setting.scope", reset: "set_model_setting.value", model: "set_model_setting.name", ...modelFields("set_model_setting") }),
  "shore model fav": route("favorite_model", { name: "favorite_model.name" }),
  "shore model unfav": route("favorite_model", { name: "favorite_model.name" }),
  "shore model reset": route("reset_model", modelFields("reset_model")),
  "shore provider": route("list_providers"),
  "shore provider models": route("list_provider_models", { name: "list_provider_models.provider", all: "list_provider_models.include_hidden" }),
  "shore provider refresh": route("refresh_provider_models refresh_all_provider_models", { name: "refresh_provider_models.provider" }),
  "shore config": route("config config_check status", { path: "@config_path", check: "@config_check", toml: "@config_format", all: "@config_defaults" }),
  "shore config get": route("config", { key: "config.key", toml: "@config_format", all: "@config_defaults" }),
  "shore config set": route("config", { key: "config.key", value: "config.value" }),
  "shore config keys": route("config_schema", { filter: "@config_filter" }),
  "shore config reload": route("config_reload", { yes: "config_reload.apply config_reload.refresh_prompts @confirmation" }),
  "shore config tools": route("tools"),
  "shore usage": route("usage", usage),
  "shore usage by": route("usage", { ...usage, dimension: "usage.group_by" }),
  "shore usage budgets": route("usage", usage),
  "shore usage cache": route("usage", usage),
  "shore usage anomalies": route("usage", usage),
  "shore usage limits": route("usage", usage),
  "shore usage export": route("usage", { ...usage, tsv: "usage.export_tsv @usage_export" }),
  "shore view": route("", { key: "@display", value: "@display" }),
  "shore completions": route("", { shell: "@shell_scripts" }),
  "shore complete": route("", { kind: "@completion", arg: "@completion" }),
};

type Adapter = { reason: string; hooks: Record<string, string[]> };
const adapter = (reason: string, file: string, ...hooks: string[]): Adapter => ({ reason, hooks: { [file]: hooks } });
export const TERMINAL_ADAPTERS: Record<string, Adapter> = {
  help: adapter("Schema-backed action help and workspace help replace terminal help output.", "app.tsx", "Object.entries(control.fields)", "LocalHelp"),
  version: adapter("Browser/daemon release compatibility is negotiated before attachment.", "connection.ts", "body.contract", "body.protocol"),
  result: adapter("Every action result remains inspectable and downloadable as JSON.", "components.tsx", "JSON.stringify(value, null, 2)", "URL.createObjectURL"),
  origin: adapter("The page origin selects the daemon; TCP discovery and addresses are terminal transport details.", "app.tsx", "location.origin"),
  attachments: adapter("Local image files and pasted images use browser uploads; daemon paths remain available in advanced controls.", "composer.tsx", "onPaste", "imageUpload(file, data)"),
  editor: adapter("Built-in editing replaces launching a local editor process.", "composer.tsx", "TextHistory", "editText", "textHistory.change"),
  follow: adapter("Conversation updates arrive live and automatic scrolling can be toggled.", "app.tsx", "setFollow", "tail.current?.scrollIntoView"),
  content: adapter("Message details retain all text and structured blocks; Copy exports message text.", "app.tsx", "Inspect:value=message", "navigator.clipboard.writeText(message.content)"),
  thinking: adapter("Thinking is a persistent display preference.", "app.tsx", 'display.option("thinking")'),
  tools: adapter("Tool content is a persistent display preference.", "app.tsx", 'display.option("tools")'),
  subagents: adapter("Live nested streams and stored subagent traces have browser views.", "activity.tsx", "stream.subagent"),
  character_info: adapter("Character information uses the canonical action form.", "app.tsx", "workspace.actions.runDiscovered(operation.name, values)"),
  archives: adapter("Browser upload/download adapters complement explicitly labelled daemon paths.", "archives.tsx", 'transfer("", file, { "content-type": "application/octet-stream", "x-shore-filename": encodeURIComponent(file.name) }, controller.signal)', "transfer(`/${archive.id}/download`)", "URL.createObjectURL(blob)"),
  confirmation: adapter("Reviewed forms replace terminal yes flags; destructive confirmation remains mandatory.", "app.tsx", "policy.confirmation", "setConfirming"),
  status_section: adapter("Status sections are selected from the actual status response.", "diagnostics.tsx", "status.sections.map", "Inspect:value=status"),
  subagent_tool: adapter("Discovered subagent tools expose their structured query fields.", "tool_workbench.tsx", "toolNames(access)", "toolControl(response.input_schema)"),
  chat_role: adapter("Chat is the default model role when no background or subagent target is supplied.", "models.tsx", "targetArgs"),
  model_info: adapter("The model information action and designed Models view expose complete results.", "models.tsx", 'actions.run("model_info"'),
  model_reset: adapter("Role-specific reset reaches the shared reset operation.", "models.tsx", 'actions.run("reset_model"'),
  config_path: adapter("Diagnostics exposes the daemon config directory in the complete status report; offline local directory discovery is terminal-specific.", "diagnostics.tsx", "Inspect:value=status"),
  config_check: adapter("Settings checks configuration through the shared operation.", "settings.tsx", 'actions.run("config_check"'),
  config_format: adapter("Structured effective/default views and JSON downloads replace terminal TOML formatting without omitting values.", "settings.tsx", "JSON.stringify(effective, null, 2)", "JSON.stringify(fallback, null, 2)"),
  config_defaults: adapter("Both effective and default values are available for every schema key.", "settings.tsx", "view.config", "view.defaults"),
  config_filter: adapter("Searchable schema keys replace the terminal prefix filter.", "settings.tsx", "schema?.schema.filter"),
  usage_export: adapter("CSV and TSV exports are real browser downloads.", "usage.tsx", "URL.createObjectURL", "export_tsv"),
  display: adapter("The separate display coverage gate checks every ViewKey choice and its actual reader.", "display.tsx", "VIEW_CONTROLS"),
  shell_scripts: adapter("Installing a shell completion script has no application effect; browser discovery replaces it.", "app.tsx", "setPalette"),
  completion: { reason: "Dynamic browser choices replace the shell helper process; all current completion kinds are accounted for below.", hooks: { "app.tsx": ["setModelNames", "setSubagentNames", "setModelSettingKeys", "setProviderNames", "setAvailableTools", "setConfigSchema", "state.characters", "state.threads"], "settings.tsx": ["entry.values", "schema?.sources"], "models.tsx": ["modelSettingControl"], "diagnostics.tsx": ["status.sections.map"] } },
};

const choices: Record<string, readonly string[]> = {
  "shore log.role": ["user", "assistant", "character", "system"],
  "shore usage by.dimension": ["model", "provider", "call-type", "kind", "api-key", "cost-source"],
  "shore completions.shell": ["bash", "elvish", "fish", "powershell", "zsh"],
  "shore complete.kind": ["models", "characters", "threads", "providers", "sections", "tools", "subagents", "setting-keys", "setting-values", "config-keys", "config-sections", "config-values"],
  "shore view.key": terminal.view_preferences.map((preference) => preference.key),
  ...Object.fromEntries(["use", "info", "setting", "reset"].map((command) => [`shore model ${command}.background`, ["all", "heartbeat", "compaction"]])),
};

export async function terminalBrowserHooks(texts: Record<string, string>): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for (const [file, text] of Object.entries(texts)) {
    const source = (await parseInventorySources([text], "tsx"))[0];
    if (source === undefined) throw new Error(`Missing browser source: ${file}`);
    const hooks = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        hooks.add(node.getText(source));
        hooks.add(node.expression.getText(source));
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteral(first)) hooks.add(`${node.expression.getText(source)}(${first.getText(source)}`);
      }
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isJsxAttribute(node)) hooks.add(ts.isJsxAttribute(node) ? node.name.getText(source) : node.getText(source));
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) for (const property of node.attributes.properties) {
        if (ts.isJsxAttribute(property) && property.initializer !== undefined && ts.isJsxExpression(property.initializer) && property.initializer.expression !== undefined) hooks.add(`${node.tagName.getText(source)}:${property.name.getText(source)}=${property.initializer.expression.getText(source)}`);
      }
      node.forEachChild(visit);
    };
    visit(source); result.set(file, hooks);
  }
  return result;
}

interface TerminalInventory {
  commands: { path: string; arguments: { id: string; action: string; choices: string[] }[] }[];
  wire_examples: { mapping: { name: string; args: object } | null }[];
}

export function assertTerminalCoverage(operations: OperationDescriptor[], hooks: ReadonlyMap<string, ReadonlySet<string>>, inventory: TerminalInventory = terminal): void {
  const controls = new Map(operations.map((operation) => [operation.name, actionControl(operation)]));
  const assertAdapter = (name: string) => {
    const entry = TERMINAL_ADAPTERS[name];
    if (entry === undefined || entry.reason.length === 0) throw new Error(`Unjustified terminal adapter: ${name}`);
    for (const [file, required] of Object.entries(entry.hooks)) for (const hook of required) if (!hooks.get(file)?.has(hook)) throw new Error(`Missing browser adapter: ${name}:${file}:${hook}`);
  };
  for (const command of inventory.commands) {
    if (command.path === "shore ui" || command.path.startsWith("shore ui ")) continue;
    const mapping = TERMINAL_ROUTES[command.path];
    if (mapping === undefined) throw new Error(`Unmapped terminal command: ${command.path}`);
    for (const operation of mapping.operations) if (!controls.has(operation)) throw new Error(`Missing terminal operation: ${command.path}:${operation}`);
    const expectedFields = new Set(Object.keys(mapping.fields));
    for (const field of command.arguments) {
      const presentation = field.id === "json" ? "result" : field.action === "Help" ? "help" : field.action === "Version" ? "version" : null;
      if (presentation !== null) { assertAdapter(presentation); continue; }
      expectedFields.delete(field.id);
      const targets = mapping.fields[field.id];
      if (targets === undefined || targets.length === 0) throw new Error(`Unmapped terminal field: ${command.path}.${field.id}`);
      if (JSON.stringify(field.choices) !== JSON.stringify(choices[`${command.path}.${field.id}`] ?? [])) throw new Error(`Unmapped terminal choices: ${command.path}.${field.id}`);
      for (const target of targets) {
        if (target.startsWith("@")) { assertAdapter(target.slice(1)); continue; }
        const [operation = "", key = ""] = target.split(".");
        if (!mapping.operations.includes(operation) || controls.get(operation)?.fields[key] === undefined) throw new Error(`Missing terminal field control: ${command.path}.${field.id}:${target}`);
      }
    }
    if (expectedFields.size > 0) throw new Error(`Stale terminal mapping: ${command.path}:${[...expectedFields].join(",")}`);
  }
  for (const hook of ["Object.entries(control.fields)", "Field:control=field", "Inspect:value=result", "workspace.actions.runDiscovered(operation.name, values)"]) if (!hooks.get("app.tsx")?.has(hook)) throw new Error(`Missing generated action path: ${hook}`);
  for (const example of inventory.wire_examples) if (example.mapping !== null) {
    const control = controls.get(example.mapping.name);
    if (control === undefined) throw new Error(`Missing mapped operation: ${example.mapping.name}`);
    for (const key of Object.keys(example.mapping.args)) if (control.fields[key] === undefined) throw new Error(`Missing mapped option: ${example.mapping.name}.${key}`);
  }
}
