import { readFile, writeFile } from "node:fs/promises";
import terminal from "../../docs/capabilities/terminal.generated.json" with { type: "json" };
import wire from "../src/protocol/wire.generated.json" with { type: "json" };
import type { OperationDescriptor } from "../src/protocol/OperationDescriptor.ts";
import { actionControl } from "../src/browser/forms.ts";
import { SURFACES, TIERS, type Tier } from "../src/browser/surfaces.ts";
import { TERMINAL_LOCAL_COMMANDS } from "../src/browser/preferences.generated.ts";

export const KNOWN_GAPS_PATH = new URL("./browser_known_gaps.json", import.meta.url);

type Route = { tier: Tier; operations: string[]; fields: Record<string, string[]>; tiers: Record<string, Tier> };
const route = (tier: Tier, operations: string, fields: Record<string, string> = {}, tiers: Record<string, Tier> = {}): Route => ({
  tier, operations: operations.split(" ").filter(Boolean), fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.split(" ")])), tiers,
});
const role = { chat: "@chat_role", background: "background_task", subagent: "subagent" };
const modelFields = (operation: string) => Object.fromEntries(Object.entries(role).map(([key, field]) => [key, field.startsWith("@") ? field : `${operation}.${field}`]));
const roleTiers: Record<string, Tier> = { background: "settings", subagent: "settings" };
const usage = { last: "usage.last", provider: "usage.provider", api_key: "usage.api_key", model: "usage.model", call_type: "usage.call_type" };

export const TERMINAL_ROUTES: Record<string, Route> = {
  shore: route("inline", "switch_character switch_thread", { character: "switch_character.name", thread: "switch_thread.name", addr: "@origin" }),
  "shore msg": route("inline", ""),
  "shore msg send": route("inline", "message inject_system", { message: "message.text inject_system.text", images: "message.images message.image_data @attachments", system: "inject_system.text" }, { system: "advanced" }),
  "shore msg regen": route("inline", "regen", { guidance: "regen.guidance" }),
  "shore msg alt": route("inline", "alt list_alternatives", { selector: "alt.direction alt.position list_alternatives.ref", msg_ref: "alt.ref list_alternatives.ref" }),
  "shore msg edit": route("inline", "edit get", { msg_ref: "edit.ref get.ref", content: "edit.content @editor" }),
  "shore msg delete": route("inline", "delete", { msg_refs: "delete.refs" }),
  "shore log": route("inline", "log get", { msg_ref: "get.ref", count: "log.turns", role: "log.role", follow: "@follow", content: "@content", reasoning: "@thinking", tools: "@tools", subagent_tools: "@subagents" },
    { msg_ref: "advanced", count: "advanced", role: "advanced" }),
  "shore compact": route("inline", "compact", { keep_turns: "compact.keep_turns", restart: "compact.restart" }),
  "shore segments": route("advanced", "segments"),
  "shore segments show": route("advanced", "segments", { index: "segments.index" }),
  "shore segments exclude": route("advanced", "segments", { index: "segments.index" }),
  "shore segments include": route("advanced", "segments", { index: "segments.index" }),
  "shore segments label": route("advanced", "segments", { index: "segments.index", label: "segments.value" }),
  "shore segments note": route("advanced", "segments", { index: "segments.index", note: "segments.value" }),
  "shore clear": route("inline", "clear", { exclude: "clear.exclude", note: "clear.note" }),
  "shore trace": route("advanced", ""),
  "shore trace calls": route("advanced", "call_log", { id: "call_log.id", count: "call_log.count", call_type: "call_log.call_type", diff: "call_log.diff", against: "call_log.against", wire: "call_log.wire" }),
  "shore trace heartbeat": route("advanced", "transcript", { count: "transcript.count" }),
  "shore trace events": route("advanced", "heartbeat_log", { count: "heartbeat_log.count" }),
  "shore trace errors": route("advanced", "error_log", { count: "error_log.count" }),
  "shore trace subagent": route("advanced", "subagent_trace", { id: "subagent_trace.ids", count: "subagent_trace.count" }),
  "shore character": route("settings", "list_characters character_info", { info: "@character_info" }),
  "shore character use": route("inline", "switch_character", { name: "switch_character.name" }),
  "shore character info": route("settings", "character_info"),
  "shore character new": route("inline", "create_character", { name: "create_character.name" }),
  "shore character delete": route("settings", "delete_character", { name: "delete_character.character", archive: "delete_character.archive @archives", yes: "delete_character.confirm @confirmation" }),
  "shore thread": route("inline", "list_threads"),
  "shore thread use": route("inline", "switch_thread", { name: "switch_thread.name" }),
  "shore thread new": route("inline", "create_thread", { name: "create_thread.name", label: "create_thread.label", model: "create_thread.model", compaction: "create_thread.compaction" }),
  "shore thread label": route("inline", "thread_label", { name: "thread_label.name", label: "thread_label.label" }),
  "shore thread model": route("inline", "thread_model", { name: "thread_model.name", model: "thread_model.model" }),
  "shore thread home": route("inline", "thread_home", { name: "thread_home.name" }),
  "shore thread archive": route("inline", "archive_thread", { name: "archive_thread.name" }),
  "shore thread fork": route("inline", "fork_thread", { name: "fork_thread.name", from: "fork_thread.from", turns: "fork_thread.turns" }),
  "shore export": route("advanced", "export_character", { character: "export_character.character", output: "export_character.output @archives" }),
  "shore import": route("advanced", "import_character", { archive: "import_character.archive @archives" }),
  "shore status": route("advanced", "status", { section: "@status_section" }),
  "shore debug": route("advanced", ""),
  "shore debug heartbeat_tick_now": route("advanced", "heartbeat_tick_now"),
  "shore debug heartbeat_status_dormant": route("advanced", "heartbeat_set_dormant"),
  "shore debug heartbeat_status_active": route("advanced", "heartbeat_set_active"),
  "shore debug keepalive_ping_now": route("advanced", "keepalive_ping_now"),
  "shore debug session_activate": route("advanced", "session_activate"),
  "shore debug tool": route("advanced", "run_tool", { name: "run_tool.tool", args: "run_tool.pairs", input: "run_tool.input", describe: "run_tool.describe", raw: "run_tool.raw" }),
  "shore debug subagent": route("advanced", "run_tool", { name: "run_tool.tool @subagent_tool", query: "run_tool.input @subagent_tool", raw: "run_tool.raw" }),
  "shore model": route("settings", "list_models model_info reset_model", { all: "list_models.include_hidden", favorites: "list_models.favorites_only", info: "@model_info", reset: "@model_reset" }),
  "shore model use": route("inline", "switch_model", { name: "switch_model.name", ...modelFields("switch_model") }, roleTiers),
  "shore model info": route("settings", "model_info", { name: "model_info.name", ...modelFields("model_info") }),
  "shore model setting": route("settings", "model_settings set_model_setting", { key: "model_settings.key set_model_setting.key", value: "set_model_setting.value", global: "set_model_setting.scope", reset: "set_model_setting.value", model: "set_model_setting.name", ...modelFields("set_model_setting") }),
  "shore model fav": route("settings", "favorite_model", { name: "favorite_model.name" }),
  "shore model unfav": route("settings", "favorite_model", { name: "favorite_model.name" }),
  "shore model reset": route("settings", "reset_model", modelFields("reset_model")),
  "shore provider": route("settings", "list_providers"),
  "shore provider models": route("settings", "list_provider_models", { name: "list_provider_models.provider", all: "list_provider_models.include_hidden" }),
  "shore provider refresh": route("settings", "refresh_provider_models refresh_all_provider_models", { name: "refresh_provider_models.provider" }),
  "shore config": route("advanced", "config config_check status", { path: "@config_path", check: "@config_check", toml: "@config_format", all: "@config_defaults" }),
  "shore config get": route("settings", "config", { key: "config.key", toml: "@config_format", all: "@config_defaults" }),
  "shore config set": route("settings", "config", { key: "config.key", value: "config.value" }),
  "shore config keys": route("settings", "config_schema", { filter: "@config_filter" }),
  "shore config reload": route("settings", "config_reload", { yes: "config_reload.apply config_reload.refresh_prompts @confirmation" }),
  "shore config tools": route("settings", "tools"),
  "shore usage": route("settings", "usage", usage),
  "shore usage by": route("settings", "usage", { ...usage, dimension: "usage.group_by" }),
  "shore usage budgets": route("settings", "usage", usage),
  "shore usage cache": route("settings", "usage", usage),
  "shore usage anomalies": route("settings", "usage", usage),
  "shore usage limits": route("settings", "usage", usage),
  "shore usage export": route("settings", "usage", { ...usage, tsv: "usage.export_tsv @usage_export" }),
  "shore view": route("settings", "", { key: "@display", value: "@display" }),
  "shore completions": route("advanced", "", { shell: "@shell_scripts" }),
  "shore complete": route("advanced", "", { kind: "@completion", arg: "@completion" }),
};

export const NOT_APPLICABLE: Readonly<Record<string, string>> = {
  "@help": "Terminal help output; the browser labels and explains its own controls.",
  "@version": "Browser and daemon compatibility is negotiated before a tab attaches.",
  "@result": "Machine-readable output for scripts; the browser renders structured results.",
  "@origin": "The page origin selects the daemon; TCP addresses and discovery are terminal transport details.",
  "@config_format": "TOML formatting is terminal output; the browser shows structured values.",
  "@shell_scripts": "Shell completion scripts have no browser equivalent.",
  "@completion": "The shell completion helper process has no browser equivalent; controls offer live choices instead.",
};

const LOCAL_TIERS: Partial<Record<string, Tier>> = { bind: "settings", unbind: "settings", output: "advanced", quit: "settings" };
export const RENDERER_FAMILIES = ["field", "request_phase", "archive_phase", "usage_mode", "compaction_status"] as const;

const choices: Record<string, readonly string[]> = {
  "shore log.role": ["user", "assistant", "character", "system"],
  "shore usage by.dimension": ["model", "provider", "call-type", "kind", "api-key", "cost-source"],
  "shore completions.shell": ["bash", "elvish", "fish", "powershell", "zsh"],
  "shore complete.kind": ["models", "characters", "threads", "providers", "sections", "tools", "subagents", "setting-keys", "setting-values", "config-keys", "config-sections", "config-values"],
  "shore view.key": terminal.view_preferences.map((preference) => preference.key),
  ...Object.fromEntries(["use", "info", "setting", "reset"].map((command) => [`shore model ${command}.background`, ["all", "heartbeat", "compaction"]])),
};

export interface TerminalInventory {
  commands: { path: string; arguments: { id: string; action: string; choices: string[] }[] }[];
  wire_examples: { mapping: { name: string; args: object } | null }[];
  view_preferences: { key: string }[];
}

export interface ParityUnit { id: string; tier: Tier | null; targets: string[] }

export interface ParityInputs {
  operations: OperationDescriptor[];
  requests: OperationDescriptor[];
  inventory?: TerminalInventory;
  local?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  routes?: Readonly<Record<string, Route>>;
}

export function parityUnits({ operations, requests, inventory = terminal, local = TERMINAL_LOCAL_COMMANDS, routes = TERMINAL_ROUTES }: ParityInputs): ParityUnit[] {
  const controls = new Map([...operations, ...requests].map((operation) => [operation.name, actionControl(operation)]));
  const units: ParityUnit[] = [];
  const seen = new Set<string>();
  for (const command of inventory.commands) {
    if (command.path === "shore ui" || command.path.startsWith("shore ui ")) continue;
    const mapping = routes[command.path];
    if (mapping === undefined) throw new Error(`Unmapped terminal command: ${command.path}`);
    seen.add(command.path);
    for (const operation of mapping.operations) if (!controls.has(operation)) throw new Error(`Missing terminal operation: ${command.path}:${operation}`);
    units.push({ id: `cli:${command.path}`, tier: mapping.tier, targets: mapping.operations });
    const expected = new Set(Object.keys(mapping.fields));
    for (const field of command.arguments) {
      if (field.id === "json" || field.action === "Help" || field.action === "Version") continue;
      expected.delete(field.id);
      const targets = mapping.fields[field.id];
      if (targets === undefined || targets.length === 0) throw new Error(`Unmapped terminal field: ${command.path}.${field.id}`);
      if (JSON.stringify(field.choices) !== JSON.stringify(choices[`${command.path}.${field.id}`] ?? [])) throw new Error(`Unmapped terminal choices: ${command.path}.${field.id}`);
      for (const target of targets) {
        if (target.startsWith("@")) continue;
        const [operation = "", key = ""] = target.split(".");
        if (!mapping.operations.includes(operation) || controls.get(operation)?.fields[key] === undefined) throw new Error(`Missing terminal field control: ${command.path}.${field.id}:${target}`);
      }
      units.push({ id: `cli:${command.path}.${field.id}`, tier: mapping.tiers[field.id] ?? mapping.tier, targets });
    }
    if (expected.size > 0) throw new Error(`Stale terminal mapping: ${command.path}:${[...expected].join(",")}`);
  }
  for (const path of Object.keys(routes)) if (!seen.has(path)) throw new Error(`Stale terminal route: ${path}`);
  for (const example of inventory.wire_examples) if (example.mapping !== null) {
    const control = controls.get(example.mapping.name);
    if (control === undefined) throw new Error(`Missing mapped operation: ${example.mapping.name}`);
    for (const key of Object.keys(example.mapping.args)) if (control.fields[key] === undefined) throw new Error(`Missing mapped option: ${example.mapping.name}.${key}`);
  }
  for (const preference of inventory.view_preferences) units.push({ id: `view:${preference.key}`, tier: "settings", targets: [`view:${preference.key}`] });
  for (const command of Object.keys(local)) units.push({ id: `local:${command}`, tier: LOCAL_TIERS[command] ?? "inline", targets: [`local:${command}`] });
  for (const variant of wire.client.oneOf) {
    const name = variant.properties.type.const;
    if (name === "hello" || name === "command") continue;
    const request = requests.find((item) => item.name === name);
    if (request === undefined) throw new Error(`Missing conversation request: ${name}`);
    const definitions: Record<string, { type: string; properties?: Record<string, unknown> }> = wire.client.$defs;
    const fields = Object.keys(definitions[variant.$ref.slice("#/$defs/".length)]?.properties ?? {}).filter((key) => key !== "rid").sort();
    if (fields.join(",") !== Object.keys(actionControl(request).fields).sort().join(",")) throw new Error(`Unaccounted conversation request fields: ${name}`);
    units.push({ id: `request:${name}`, tier: "inline", targets: [`request:${name}`] });
    for (const field of fields) units.push({ id: `request:${name}.${field}`, tier: "inline", targets: [`request:${name}.${field}`] });
  }
  for (const family of RENDERER_FAMILIES) units.push({ id: `renderer:${family}`, tier: null, targets: [`renderer:${family}`] });
  return units;
}

export function uncoveredUnits(units: readonly ParityUnit[], surfaces: Readonly<Record<string, Tier>> = SURFACES): string[] {
  const referenced = new Set<string>();
  const missing: string[] = [];
  for (const unit of units) {
    let covered = true;
    for (const target of unit.targets) {
      if (NOT_APPLICABLE[target] !== undefined) continue;
      referenced.add(target);
      const tier = surfaces[target];
      if (tier === undefined) { covered = false; continue; }
      if (unit.tier !== null && TIERS.indexOf(tier) > TIERS.indexOf(unit.tier)) throw new Error(`Surface ${target} is ${tier}, but ${unit.id} is triaged as ${unit.tier}`);
    }
    if (!covered) missing.push(unit.id);
  }
  for (const key of Object.keys(surfaces)) if (!referenced.has(key)) throw new Error(`Unknown browser surface: ${key}`);
  return [...new Set(missing)].sort();
}

export function assertParity(missing: readonly string[], gaps: readonly string[]): void {
  if (new Set(gaps).size !== gaps.length) throw new Error("Duplicate known gaps");
  const listed = new Set(gaps);
  const unlisted = missing.filter((id) => !listed.has(id));
  if (unlisted.length > 0) throw new Error(`New browser parity gaps; implement them or add them to scripts/browser_known_gaps.json: ${unlisted.join(", ")}`);
  const uncovered = new Set(missing);
  const stale = gaps.filter((id) => !uncovered.has(id));
  if (stale.length > 0) throw new Error(`Stale known gaps are now covered; remove them (bun run scripts/browser_parity.ts --prune): ${stale.join(", ")}`);
}

export async function readKnownGaps(): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(KNOWN_GAPS_PATH, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("Known gaps must be a JSON array of strings");
  return parsed;
}

if (import.meta.main) {
  const { commandCatalogue } = await import("../src/commands/registry.ts");
  const { requestCatalogue } = await import("../src/operations/requests.ts");
  const missing = uncoveredUnits(parityUnits({ operations: commandCatalogue(), requests: requestCatalogue() }));
  if (process.argv.includes("--prune")) {
    const uncovered = new Set(missing);
    const kept = (await readKnownGaps()).filter((id) => uncovered.has(id));
    await writeFile(KNOWN_GAPS_PATH, JSON.stringify(kept, null, 2) + "\n");
    console.log(`${String(kept.length)} known gaps remain`);
  } else console.log(missing.join("\n"));
}
