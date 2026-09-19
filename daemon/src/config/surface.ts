import { ConfigDuration } from "./duration.ts";

export type ConfigTable = Record<string, unknown>;
export type ConfigPath = readonly string[];

export const CONFIG_FORMAT_VERSION = 1;
export const CONFIG_SECTIONS = ["daemon", "chat", "embedding", "image", "providers", "heartbeat", "compaction", "tools", "subagents", "cache", "budgets", "notifications", "mcp", "matrix", "web_search", "retrieval", "usage"] as const;
export const DEPRECATION_BOUNDARY = "supported until at least 180 days and two subsequent stable releases after the first flat-config release; no removal release scheduled";

export interface ConfigAlias {
  legacy: ConfigPath;
  canonical: ConfigPath;
}

const alias = (legacy: string, canonical: string): ConfigAlias => ({
  legacy: legacy.split("."), canonical: canonical.split("."),
});

export const CONFIG_ALIASES: readonly ConfigAlias[] = [
  alias("daemon.addr", "daemon.listen_addr"),
  alias("cache.forensics", "daemon.cache_forensics"),
  alias("cache.keepalive_max", "cache.keepalive_for"),
  alias("defaults.model", "chat.model"),
  alias("defaults.display_name", "chat.display_name"),
  alias("defaults.embedding", "embedding.model"),
  alias("defaults.image_generation", "image.model"),
  alias("defaults.subagent_model", "subagents.model"),
  alias("defaults.background.heartbeat", "heartbeat.model"),
  alias("defaults.background.compaction", "compaction.model"),
  alias("behavior.user_message_timestamps", "chat.user_timestamps"),
  alias("memory.thinking.replay_prior_thinking", "chat.reasoning_replay"),
  ...["max_retries", "retry_backoff"].map((key) => alias(`advanced.${key}`, `chat.${key}`)),
  ...Object.entries({
    fallback_heartbeat_interval: "interval",
    minimum_heartbeat_latency: "min_interval",
    dormant_after_heartbeat_turns: "max_idle_turns",
    dormant_after_idle_time: "idle_timeout",
    wrap_up_grace_rounds: "max_wrap_up_rounds",
  }).map(([old, key]) => alias(`behavior.autonomy.heartbeat.${old}`, `heartbeat.${key}`)),
  ...["enabled", "write_memory", "archive_after", "min_turns", "max_turns", "max_context_tokens", "keep_recent_turns"].map((key) => alias(`memory.compaction.${key}`, `compaction.${key}`)),
  alias("memory.compaction.idle_trigger", "compaction.idle_after"),
  alias("memory.git_push", "compaction.git_push"),
  alias("tools.enabled_tools", "tools.enabled"),
  alias("tools.enabled_subagents", "subagents.enabled"),
  alias("tools.config.*", "tools.*"),
  alias("subagents.*.max_iterations", "subagents.*.max_tool_rounds"),
  ...Object.entries({
    mode: "mode", max_file_bytes: "max_file_bytes", max_indexed_files: "max_files",
    max_total_indexed_bytes: "max_total_bytes", max_embed_chars_per_file: "max_embedding_chars_per_file", binary: "binary",
  }).map(([old, key]) => alias(`memory.retrieval.${old}`, `retrieval.${key}`)),
  ...Object.entries({
    enabled: "enabled", user_id: "user_id", room_id: "room_id", homeserver: "homeserver_url", mirror_all: "mirror_user_messages",
  }).map(([old, key]) => alias(`connections.matrix.${old}`, `matrix.${key}`)),
  alias("connections.matrix", "matrix"),
  alias("notifications.generation_threshold", "notifications.min_generation_duration"),
  alias("notifications.ntfy.url", "notifications.url"),
  alias("notifications.ntfy.topic", "notifications.topic"),
  ...Object.entries({api_key_env: "api_key_env", result_limit: "max_results", search_depth: "depth", include_answer: "include_answer"})
    .map(([old, key]) => alias(`tools.web_search.${old}`, `web_search.${key}`)),
  alias("mcp.*.cwd", "mcp.*.working_dir"),
  alias("usage.budgets", "budgets"),
  alias("image_generation", "image"),
  alias("providers.*.discovery.enabled", "providers.*.discover"),
  alias("providers.*.discovery.ignore", "providers.*.ignore_models"),
  alias("providers.*.keys.*.env", "providers.*.keys.*.api_key_env"),
];

export const BUDGET_ALIASES: readonly ConfigAlias[] = Object.entries({
  warn_at: "warn_fractions", limit: "limit_action", pace_warn_at: "pace_warn_fractions",
  usage_kind: "usage_kinds", allow_compaction_over_budget: "allow_compaction",
}).map(([old, key]) => alias(old, key));

export const SETTING_ALIASES: readonly ConfigAlias[] = Object.entries({
  budget_tokens: "reasoning_budget_tokens", cache_keepalive_max: "cache_keepalive_for",
  replay_prior_thinking: "reasoning_replay", max_tool_iterations: "max_tool_rounds",
  openrouter_provider: "openrouter_routing", gemini_generation: "gemini_thinking_mode",
  zai_clear_thinking: "zai_clear_reasoning",
}).map(([old, key]) => alias(old, key));

export const MODEL_FIELDS = [
  "max_context_tokens", "max_output_tokens", "temperature", "top_p", "reasoning_effort",
  "budget_tokens", "cache_ttl", "cache_keepalive", "cache_keepalive_max", "replay_prior_thinking",
  "max_tool_iterations", "openrouter_provider", "gemini_generation", "zai_clear_thinking", "supports_images",
] as const;

export const REMOVED_CONFIG = [
  { path: ["defaults", "stream"], reason: "streaming is selected by the client; delete this unused setting" },
  ...["max_note_bytes", "max_index_bytes", "max_prompt_bytes"].map((key) => ({
    path: ["memory", "file_limits", key], reason: "the active workspace tools do not enforce this ceiling; delete this unused setting",
  })),
] as const;

export const NOTIFICATION_EVENTS = ["autonomous_message", "cache_warning", "compaction_complete", "error", "message_complete", "usage_warning"] as const;

export interface ConfigDeprecation {
  source: string;
  path: string;
  replacement: string;
  boundary: string;
}

export function isConfigTable(value: unknown): value is ConfigTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatConfigPath(path: ConfigPath): string {
  return path.map((part) => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join(".");
}

export function parseConfigPath(key: string): string[] {
  const parsed = Bun.TOML.parse(`${key} = 0`);
  const path: string[] = [];
  let current: unknown = parsed;
  while (isConfigTable(current)) {
    const entries = Object.entries(current);
    const entry = entries[0];
    if (entries.length !== 1 || entry === undefined) throw new Error("expected one TOML key path");
    path.push(entry[0]);
    current = entry[1];
  }
  if (current !== 0 || path.length === 0) throw new Error("expected one TOML key path");
  return path;
}

export function valueAt(root: unknown, path: ConfigPath): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as ConfigTable)[segment];
  }
  return current;
}

export function putAt(root: ConfigTable, path: ConfigPath, value: unknown): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) current[segment] = {};
    else if (!isConfigTable(child) && !Array.isArray(child)) throw new Error(`${formatConfigPath(path)} conflicts with a scalar`);
    current = current[segment] as ConfigTable;
  }
  const last = path.at(-1);
  if (last !== undefined) current[last] = value;
}

export function removeAt(root: ConfigTable, path: ConfigPath, prune = true): void {
  const [head, ...tail] = path;
  if (head === undefined) return;
  if (tail.length === 0) { delete root[head]; return; }
  const child = root[head];
  if (!isConfigTable(child) && !Array.isArray(child)) return;
  removeAt(child as ConfigTable, tail, prune);
  if (prune && isConfigTable(child) && Object.keys(child).length === 0) delete root[head];
}

export function matchingPaths(root: unknown, pattern: ConfigPath, prefix: string[] = []): string[][] {
  if (pattern.length === 0) return root === undefined ? [] : [prefix];
  if (typeof root !== "object" || root === null) return [];
  const [head, ...tail] = pattern;
  const keys = head === "*" ? Object.keys(root) : head === undefined ? [] : [head];
  return keys.flatMap((key) => matchingPaths((root as ConfigTable)[key], tail, [...prefix, key]));
}

export function translatePath(path: ConfigPath, from: ConfigPath, to: ConfigPath): string[] | undefined {
  if (path.length < from.length || !from.every((part, i) => part === "*" || part === path[i])) return undefined;
  const captures = from.flatMap((part, i) => part === "*" ? [path[i] as string] : []);
  let index = 0;
  return [...to.map((part) => part === "*" ? captures[index++] as string : part), ...path.slice(from.length)];
}

function conflict(source: string, first: ConfigPath, second: ConfigPath): never {
  throw new Error(`${source}: conflicting declarations ${formatConfigPath(first)} and ${formatConfigPath(second)}; use only the canonical spelling in this source`);
}

function moveAliases(table: ConfigTable, aliases: readonly ConfigAlias[], source: string): void {
  for (const rule of aliases) {
    for (const path of matchingPaths(table, rule.canonical)) {
      const target = translatePath(path, rule.canonical, rule.legacy) as string[];
      if (valueAt(table, target) !== undefined) conflict(source, target, path);
      const value = valueAt(table, path);
      removeAt(table, path);
      putAt(table, target, value);
    }
  }
}

export function canonicalSettingKey(key: string): string {
  return SETTING_ALIASES.find((rule) => rule.legacy[0] === key)?.canonical[0] ?? key;
}

export function internalSettingKey(key: string): string {
  return SETTING_ALIASES.find((rule) => rule.canonical[0] === key)?.legacy[0] ?? key;
}

export function geminiMode(value: unknown): unknown {
  return typeof value === "number" ? value === 0 ? "auto" : value < 3 ? "budget" : "level" : value;
}

export function normalizeSettings(input: ConfigTable, source = "model settings"): ConfigTable {
  const table = structuredClone(input);
  if (table.gemini_thinking_mode !== undefined) {
    const mode = table.gemini_thinking_mode;
    if (mode !== "auto" && mode !== "budget" && mode !== "level") throw new Error(`${source}: gemini_thinking_mode must be auto, budget, or level`);
    table.gemini_thinking_mode = mode === "auto" ? 0 : mode === "budget" ? 2 : 3;
  }
  moveAliases(table, SETTING_ALIASES, source);
  return table;
}

export function settingPaths(input: ConfigTable, preferences = false): string[][] {
  const patterns = preferences
    ? [["defaults", "sampler"], ["models", "*"], ["subagent_models", "*"], ["subagents", "*"]]
    : [["providers", "*"], ["providers", "*", "defaults"], ["chat", "*"], ["chat", "*", "*"]];
  return patterns.flatMap((pattern) => matchingPaths(input, pattern)).filter((path) => isConfigTable(valueAt(input, path)));
}

export function legacyValues(input: ConfigTable, preferences = false): { path: string[]; value: unknown }[] {
  const settings = settingPaths(input, preferences);
  const durations = preferences ? [] : [
    ["chat", "retry_backoff"], ["heartbeat", "interval"], ["heartbeat", "min_interval"], ["heartbeat", "idle_timeout"],
    ["compaction", "idle_after"], ["compaction", "archive_after"], ["tools", "timeout"], ["tools", "*", "timeout"],
    ["subagents", "*", "timeout"], ["cache", "keepalive_for"], ["notifications", "min_generation_duration"],
  ].flatMap((pattern) => matchingPaths(input, pattern));
  durations.push(...settings.flatMap((path) => ["cache_ttl", "cache_keepalive_for", "cache_keepalive_max"].map((key) => [...path, key])));
  const changes: { path: string[]; value: unknown }[] = [];
  for (const path of durations) {
    const value = valueAt(input, path);
    if (typeof value !== "number" && !(typeof value === "string" && /^[0-9]+$/.test(value))) continue;
    const parsed = ConfigDuration.deserialize(value);
    if ("ok" in parsed) changes.push({ path, value: parsed.ok.toString() });
  }
  for (const path of [...settings.flatMap((prefix) => ["reasoning_replay", "replay_prior_thinking"].map((key) => [...prefix, key])), ...(!preferences ? [["chat", "reasoning_replay"], ["memory", "thinking", "replay_prior_thinking"]] : [])]) {
    const value = valueAt(input, path);
    if (value === true || value === false || value === "last_turn") changes.push({ path, value: value === false ? "none" : "all" });
  }
  for (const prefix of settings) {
    const path = [...prefix, "cache_keepalive"];
    const value = valueAt(input, path);
    if (typeof value !== "string" || value === "off") continue;
    if (["off", "none", "disabled", "false", "0"].includes(value.trim().toLowerCase())) changes.push({ path, value: "off" });
    else if (/^[0-9]+$/.test(value.trim())) {
      const parsed = ConfigDuration.parse(value);
      if ("ok" in parsed) changes.push({ path, value: parsed.ok.toString() });
    }
  }
  return changes;
}

export function settingsDeprecations(input: ConfigTable, source: string, preferences = false): ConfigDeprecation[] {
  const found: ConfigDeprecation[] = [];
  for (const prefix of settingPaths(input, preferences)) for (const rule of SETTING_ALIASES) {
    const path = [...prefix, ...rule.legacy];
    if (valueAt(input, path) !== undefined) found.push({ source, path: formatConfigPath(path), replacement: formatConfigPath([...prefix, ...rule.canonical]), boundary: DEPRECATION_BOUNDARY });
  }
  for (const change of legacyValues(input, preferences)) found.push({ source, path: formatConfigPath(change.path), replacement: `${formatConfigPath(change.path)} with an explicit duration unit or canonical enum value`, boundary: DEPRECATION_BOUNDARY });
  return found;
}

function deprecations(input: ConfigTable, source: string): ConfigDeprecation[] {
  const found = new Map<string, ConfigDeprecation>();
  const add = (path: ConfigPath, replacement: string): void => {
    const key = formatConfigPath(path);
    found.set(key, { source, path: key, replacement, boundary: DEPRECATION_BOUNDARY });
  };
  for (const rule of CONFIG_ALIASES) for (const path of matchingPaths(input, rule.legacy)) {
    add(path, formatConfigPath(translatePath(path, rule.legacy, rule.canonical) as string[]));
  }
  for (const rule of REMOVED_CONFIG) if (valueAt(input, rule.path) !== undefined) add(rule.path, rule.reason);
  for (const [path, replacement] of [
    ["behavior.autonomy.enabled", "heartbeat.enabled (combine both legacy gates)"],
    ["behavior.autonomy.heartbeat.enabled", "heartbeat.enabled (combine both legacy gates)"],
    ["defaults.background.model", "heartbeat.model and compaction.model where inherited"],
    ["usage.allow_compaction_over_budget", "budgets[].allow_compaction where inherited"],
    ["notifications.enabled", "notifications.via"], ["notifications.backend", "notifications.via"],
    ["notifications.ntfy.token", "notifications.token_env; relocate nonempty secrets manually"],
  ]) if (path !== undefined && valueAt(input, path.split(".")) !== undefined) add(path.split("."), replacement as string);
  if (isConfigTable(valueAt(input, ["notifications", "events"]))) for (const key of Object.keys(valueAt(input, ["notifications", "events"]) as ConfigTable)) add(["notifications", "events", key], "notifications.events (list)");
  for (const [name, provider] of Object.entries(isConfigTable(input.providers) ? input.providers : {})) {
    if (!isConfigTable(provider)) continue;
    if (isConfigTable(provider.defaults)) for (const key of Object.keys(provider.defaults)) add(["providers", name, "defaults", key], formatConfigPath(["providers", name, canonicalSettingKey(key)]));
  }
  for (const entry of settingsDeprecations(input, source)) if (!found.has(entry.path)) add(parseConfigPath(entry.path), entry.replacement);
  for (const root of [["budgets"], ["usage", "budgets"]]) for (const rule of BUDGET_ALIASES) for (const path of matchingPaths(input, [...root, "*", ...rule.legacy])) add(path, formatConfigPath(["budgets", path[root.length] as string, ...rule.canonical]));
  for (const path of matchingPaths(input, ["chat", "*", "*"])) if (isConfigTable(valueAt(input, path)) && !path[1]?.includes(":")) add(path, "a quoted [chat.\"provider:model_id\"] table; use shore config migrate");
  for (const name of ["enabled", "model"]) if (isConfigTable(valueAt(input, ["subagents", name]))) add(["subagents", name], "rename this legacy subagent; its name is now reserved");
  for (const path of [["web_search", "depth"], ["tools", "web_search", "search_depth"]]) if (valueAt(input, path) === "ultra-fast") add(path, "web_search.depth = ultra_fast");
  return [...found.values()];
}

export function normalizeConfigSource(input: ConfigTable, source = "config"): { table: ConfigTable; deprecations: ConfigDeprecation[] } {
  for (const key of Object.keys(input)) if (!(CONFIG_SECTIONS as readonly string[]).includes(key) && !["defaults", "behavior", "memory", "connections", "advanced", "image_generation"].includes(key)) {
    throw new Error(`${source}: unknown field \`${key}\`, expected one of ${CONFIG_SECTIONS.map((section) => `\`${section}\``).join(", ")}`);
  }
  const warnings = deprecations(input, source);
  const table = structuredClone(input);
  const heartbeat = valueAt(table, ["heartbeat", "enabled"]);
  if (heartbeat !== undefined) {
    for (const path of [["behavior", "autonomy", "enabled"], ["behavior", "autonomy", "heartbeat", "enabled"]]) {
      if (valueAt(table, path) !== undefined) conflict(source, path, ["heartbeat", "enabled"]);
    }
    removeAt(table, ["heartbeat", "enabled"]);
    putAt(table, ["behavior", "autonomy", "enabled"], heartbeat);
    putAt(table, ["behavior", "autonomy", "heartbeat", "enabled"], true);
  }
  const notifications = table.notifications;
  if (isConfigTable(notifications)) {
    if (notifications.token_env !== undefined && valueAt(notifications, ["ntfy", "token"]) !== undefined && valueAt(notifications, ["ntfy", "token"]) !== "") conflict(source, ["notifications", "ntfy", "token"], ["notifications", "token_env"]);
    if (notifications.via !== undefined) {
      for (const key of ["enabled", "backend"]) if (notifications[key] !== undefined) conflict(source, ["notifications", key], ["notifications", "via"]);
      const via = notifications.via;
      if (typeof via !== "string" || !["off", "notify_send", "ntfy", "command"].includes(via)) throw new Error(`${source}: notifications.via must be off, notify_send, ntfy, or command`);
      notifications.enabled = via !== "off";
      if (via !== "off") notifications.backend = via;
      delete notifications.via;
    }
    if (Array.isArray(notifications.events)) {
      const selected = notifications.events;
      if (selected.some((event) => typeof event !== "string" || !(NOTIFICATION_EVENTS as readonly string[]).includes(event))) throw new Error(`${source}: notifications.events contains an unknown event`);
      notifications.events = Object.fromEntries(NOTIFICATION_EVENTS.map((key) => [key, selected.includes(key)]));
    }
  }
  const sourceTools = table.tools;
  if (isConfigTable(sourceTools)) {
    for (const [name, value] of Object.entries(sourceTools)) {
      if (["enabled", "enabled_tools", "enabled_subagents", "timeout", "max_result_chars", "config"].includes(name)) continue;
      if (name === "web_search") {
        if (!isConfigTable(value)) continue;
        const overrides = Object.fromEntries(Object.entries(value).filter(([key]) => ["timeout", "max_result_chars"].includes(key)));
        for (const key of Object.keys(overrides)) delete value[key];
        if (Object.keys(overrides).length > 0) putAt(table, ["tools", "config", name], overrides);
        continue;
      }
      if (valueAt(table, ["tools", "config", name]) !== undefined) conflict(source, ["tools", "config", name], ["tools", name]);
      delete sourceTools[name];
      putAt(table, ["tools", "config", name], value);
    }
  }
  const regular = CONFIG_ALIASES.filter((rule) => rule.legacy.join(".") !== "tools.config.*");
  for (const rule of regular) {
    if (rule.canonical[0] === "subagents" && rule.canonical.length === 2 && isConfigTable(valueAt(table, rule.canonical))) continue;
    moveAliases(table, [rule], source);
  }
  const providers = isConfigTable(table.providers) ? table.providers : {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!isConfigTable(provider)) continue;
    const normalized = normalizeSettings(provider, `${source}: providers.${name}`);
    providers[name] = normalized;
    for (const key of MODEL_FIELDS) if (normalized[key] !== undefined) {
      if (valueAt(normalized, ["defaults", key]) !== undefined) conflict(source, ["providers", name, "defaults", key], ["providers", name, canonicalSettingKey(key)]);
      putAt(normalized, ["defaults", key], normalized[key]);
      delete normalized[key];
    }
    if (isConfigTable(normalized.defaults)) normalized.defaults = normalizeSettings(normalized.defaults, source);
  }
  for (const section of ["chat", "embedding", "image_generation"]) {
    const entries = table[section];
    if (entries === undefined) continue;
    if (!isConfigTable(entries)) throw new Error(`${source}: ${section} must be a table`);
    for (const [name, entry] of Object.entries(entries)) {
      if (!isConfigTable(entry)) throw new Error(`${source}: ${formatConfigPath([section, name])} must be a table`);
      if (name.includes(":")) entries[name] = normalizeSettings(entry, source);
      else if (section === "chat") for (const [model, settings] of Object.entries(entry)) if (isConfigTable(settings)) entry[model] = normalizeSettings(settings, source);
    }
  }
  const budgets = valueAt(table, ["usage", "budgets"]);
  if (Array.isArray(budgets)) for (const budget of budgets) if (isConfigTable(budget)) moveAliases(budget, BUDGET_ALIASES, source);
  const depth = valueAt(table, ["tools", "web_search", "search_depth"]);
  if (depth === "ultra_fast") putAt(table, ["tools", "web_search", "search_depth"], "ultra-fast");
  else if (depth !== undefined && (typeof depth !== "string" || !["basic", "advanced", "fast", "ultra-fast"].includes(depth))) throw new Error(`${source}: web_search.depth must be basic, advanced, fast, or ultra_fast`);
  for (const section of ["heartbeat", "compaction", "retrieval", "matrix", "web_search", "image"]) if (isConfigTable(table[section]) && Object.keys(table[section]).length === 0) delete table[section];
  return { table, deprecations: warnings };
}

export function canonicalConfigPath(path: ConfigPath): string[] {
  const sections: Record<string, string[]> = {
    "memory.compaction": ["compaction"], "memory.retrieval": ["retrieval"], "connections.matrix": ["matrix"],
    "tools.web_search": ["web_search"], "tools.config": ["tools"],
  };
  const section = sections[path.join(".")];
  if (section !== undefined) return section;
  let result = [...path];
  for (const rule of CONFIG_ALIASES) {
    const mapped = translatePath(path, rule.legacy, rule.canonical);
    if (mapped !== undefined) { result = mapped; break; }
  }
  if (path.join(".") === "behavior.autonomy.enabled" || path.join(".") === "behavior.autonomy.heartbeat.enabled") return ["heartbeat", "enabled"];
  if (result[0] === "providers" && result[2] === "defaults") result.splice(2, 1);
  const settingIndex = result[0] === "providers" ? 2 : result[0] === "chat" ? result[1]?.includes(":") ? 2 : 3 : undefined;
  if (settingIndex !== undefined && result[settingIndex] !== undefined) result[settingIndex] = canonicalSettingKey(result[settingIndex]);
  if (result[0] === "budgets" && result[2] !== undefined) result[2] = BUDGET_ALIASES.find((rule) => rule.legacy[0] === result[2])?.canonical[0] ?? result[2];
  return result;
}

export function publicConfig(input: ConfigTable): ConfigTable {
  const out = structuredClone(input);
  for (const rule of CONFIG_ALIASES) for (const path of matchingPaths(input, rule.legacy)) {
    const original = valueAt(out, path);
    if (original === undefined) continue;
    const target = translatePath(path, rule.legacy, rule.canonical) as string[];
    if (path[0] === "tools" && path[1] === "config" && ["enabled", "timeout", "max_result_chars"].includes(path[2] ?? "")) continue;
    if (target[0] === "subagents" && target.length === 2 && isConfigTable(valueAt(out, target))) continue;
    removeAt(out, path);
    const value = structuredClone(original);
    const existing = valueAt(out, target);
    putAt(out, target, isConfigTable(value) && isConfigTable(existing) ? { ...value, ...existing } : value);
  }
  putAt(out, ["heartbeat", "enabled"], valueAt(input, ["behavior", "autonomy", "enabled"]) === true && valueAt(input, ["behavior", "autonomy", "heartbeat", "enabled"]) !== false);
  const fallback = valueAt(input, ["defaults", "background", "model"]);
  for (const task of ["heartbeat", "compaction"]) {
    const selected = valueAt(out, [task, "model"]);
    if ((selected === null || selected === undefined) && fallback !== null && fallback !== undefined) putAt(out, [task, "model"], fallback);
  }
  const enabled = valueAt(input, ["notifications", "enabled"]);
  putAt(out, ["notifications", "via"], enabled === true ? valueAt(input, ["notifications", "backend"]) ?? "notify_send" : "off");
  const events = valueAt(input, ["notifications", "events"]);
  if (isConfigTable(events)) putAt(out, ["notifications", "events"], NOTIFICATION_EVENTS.filter((key) => events[key] === true));
  const budgets = out.budgets;
  if (Array.isArray(budgets)) for (const budget of budgets) if (isConfigTable(budget)) {
    for (const rule of BUDGET_ALIASES) {
      const old = rule.legacy[0] as string;
      const key = rule.canonical[0] as string;
      if (budget[old] !== undefined) { budget[key] = budget[old]; delete budget[old]; }
    }
    budget.allow_compaction ??= valueAt(input, ["usage", "allow_compaction_over_budget"]) ?? false;
  }
  const providers = isConfigTable(out.providers) ? out.providers : {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!isConfigTable(provider)) continue;
    if (isConfigTable(provider.defaults)) { Object.assign(provider, provider.defaults); delete provider.defaults; }
    providers[name] = publicSettings(provider);
  }
  for (const section of ["chat", "embedding", "image"]) {
    const profiles = out[section];
    if (!isConfigTable(profiles)) continue;
    for (const [name, value] of Object.entries(profiles)) if (isConfigTable(value) && name.includes(":")) profiles[name] = publicSettings(value);
  }
  if (valueAt(out, ["web_search", "depth"]) === "ultra-fast") putAt(out, ["web_search", "depth"], "ultra_fast");
  for (const path of [
    ["behavior"], ["defaults"], ["memory", "file_limits"], ["usage", "allow_compaction_over_budget"],
    ["notifications", "enabled"], ["notifications", "backend"], ["notifications", "ntfy", "token"],
  ]) removeAt(out, path);
  return out;
}

export function publicSettings(input: ConfigTable): ConfigTable {
  const out = { ...input };
  for (const rule of SETTING_ALIASES) {
    const old = rule.legacy[0] as string;
    const key = rule.canonical[0] as string;
    if (out[old] === undefined) continue;
    out[key] = old === "gemini_generation" ? geminiMode(out[old]) : out[old];
    delete out[old];
  }
  return out;
}
