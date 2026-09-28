
export type ConfigTable = Record<string, unknown>;
export type ConfigPath = readonly string[];

export const CONFIG_SECTIONS = ["daemon", "chat", "embedding", "image", "providers", "heartbeat", "compaction", "tools", "subagents", "budgets", "plan_limits", "notifications", "mcp", "matrix", "retrieval", "usage"] as const;

export interface ConfigField {
  internal: ConfigPath;
  canonical: ConfigPath;
}

const field = (internal: string, canonical: string): ConfigField => ({
  internal: internal.split("."), canonical: canonical.split("."),
});

export const CONFIG_FIELDS: readonly ConfigField[] = [
  field("daemon.addr", "daemon.listen_addr"),
  field("cache.forensics", "daemon.cache_forensics"),
  field("defaults.model", "chat.model"),
  field("defaults.display_name", "chat.display_name"),
  field("defaults.embedding", "embedding.model"),
  field("defaults.image_generation", "image.model"),
  field("defaults.subagent_model", "subagents.model"),
  field("defaults.background.heartbeat", "heartbeat.model"),
  field("defaults.background.compaction", "compaction.model"),
  field("behavior.user_message_timestamps", "chat.user_timestamps"),
  field("memory.thinking.replay_prior_thinking", "chat.reasoning_replay"),
  ...["max_retries", "retry_backoff"].map((key) => field(`advanced.${key}`, `chat.${key}`)),
  ...Object.entries({
    default_interval: "default_interval",
    min_interval: "min_interval",
    max_interval: "max_interval",
    dormant_after_heartbeat_turns: "max_idle_turns",
    dormant_after_idle_time: "idle_timeout",
    wrap_up_grace_rounds: "max_wrap_up_rounds",
  }).map(([old, key]) => field(`behavior.autonomy.heartbeat.${old}`, `heartbeat.${key}`)),
  ...["enabled", "write_memory", "archive_after", "min_turns", "max_turns", "max_context_tokens", "keep_recent_turns"].map((key) => field(`memory.compaction.${key}`, `compaction.${key}`)),
  field("memory.compaction.idle_trigger", "compaction.idle_after"),
  field("memory.git_push", "compaction.git_push"),
  field("tools.enabled_tools", "tools.enabled"),
  field("tools.enabled_subagents", "subagents.enabled"),
  field("tools.enabled_mcp", "tools.mcp"),
  field("tools.config.*", "tools.*"),
  field("subagents.*.max_iterations", "subagents.*.max_tool_rounds"),
  ...Object.entries({
    mode: "mode", max_file_bytes: "max_file_bytes", max_indexed_files: "max_files",
    max_total_indexed_bytes: "max_total_bytes", max_embed_chars_per_file: "max_embedding_chars_per_file", binary: "binary",
  }).map(([old, key]) => field(`memory.retrieval.${old}`, `retrieval.${key}`)),
  ...Object.entries({
    enabled: "enabled", user_id: "user_id", room_id: "room_id", homeserver: "homeserver_url", mirror_all: "mirror_user_messages",
  }).map(([old, key]) => field(`connections.matrix.${old}`, `matrix.${key}`)),
    field("connections.matrix", "matrix"),
  field("notifications.generation_threshold", "notifications.min_generation_duration"),
  field("notifications.ntfy.url", "notifications.url"),
  field("notifications.ntfy.topic", "notifications.topic"),
  field("mcp.*.cwd", "mcp.*.working_dir"),
  field("usage.budgets", "budgets"),
  field("usage.plan_limits", "plan_limits"),
  field("image_generation", "image"),
  field("providers.*.discovery.enabled", "providers.*.discover"),
  field("providers.*.discovery.ignore", "providers.*.ignore_models"),
  field("providers.*.keys.*.env", "providers.*.keys.*.api_key_env"),
];

export const BUDGET_FIELDS: readonly ConfigField[] = Object.entries({
  warn_at: "warn_fractions", limit: "limit_action", pace_warn_at: "pace_warn_fractions",
  usage_kind: "usage_kinds", allow_compaction_over_budget: "allow_compaction",
}).map(([old, key]) => field(old, key));

export const SETTING_FIELDS: readonly ConfigField[] = Object.entries({
  budget_tokens: "reasoning_budget_tokens",
  replay_prior_thinking: "reasoning_replay", max_tool_iterations: "max_tool_rounds",
  openrouter_provider: "openrouter_routing", gemini_generation: "gemini_thinking_mode",
  zai_clear_thinking: "zai_clear_reasoning",
}).map(([old, key]) => field(old, key));

export const MODEL_FIELDS = [
  "max_context_tokens", "max_output_tokens", "temperature", "top_p", "reasoning_effort",
  "budget_tokens", "cache_ttl", "replay_prior_thinking",
  "max_tool_iterations", "openrouter_provider", "gemini_generation", "zai_clear_thinking", "supports_images",
] as const;

export const TOOLS_SCALAR_KEYS: readonly string[] = ["enabled", "mcp", "timeout", "max_result_chars", "max_inline_image_bytes"];

export const NOTIFICATION_EVENTS = ["autonomous_message", "cache_warning", "compaction_complete", "error", "message_complete", "usage_warning"] as const;

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

function toInternal(table: ConfigTable, fields: readonly ConfigField[]): void {
  for (const rule of fields) {
    for (const path of matchingPaths(table, rule.canonical)) {
      const target = translatePath(path, rule.canonical, rule.internal) as string[];
      const value = valueAt(table, path);
      removeAt(table, path);
      putAt(table, target, value);
    }
  }
}

export function canonicalSettingKey(key: string): string {
  return SETTING_FIELDS.find((rule) => rule.internal[0] === key)?.canonical[0] ?? key;
}

export function internalSettingKey(key: string): string {
  return SETTING_FIELDS.find((rule) => rule.canonical[0] === key)?.internal[0] ?? key;
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
  toInternal(table, SETTING_FIELDS);
  return table;
}

export function normalizeConfigSource(input: ConfigTable, source = "config"): ConfigTable {
  const table = structuredClone(input);
  const heartbeat = valueAt(table, ["heartbeat", "enabled"]);
  if (heartbeat !== undefined) {
    removeAt(table, ["heartbeat", "enabled"]);
    putAt(table, ["behavior", "autonomy", "enabled"], heartbeat);
  }
  const notifications = table.notifications;
  if (isConfigTable(notifications)) {
    if (notifications.via !== undefined) {
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
      if (TOOLS_SCALAR_KEYS.includes(name)) continue;
      delete sourceTools[name];
      putAt(table, ["tools", "config", name], value);
    }
  }
  const regular = CONFIG_FIELDS.filter((rule) => rule.internal.join(".") !== "tools.config.*");
  for (const rule of regular) {
    toInternal(table, [rule]);
  }
  const providers = isConfigTable(table.providers) ? table.providers : {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!isConfigTable(provider)) continue;
    const normalized = normalizeSettings(provider, `${source}: providers.${name}`);
    providers[name] = normalized;
    for (const key of MODEL_FIELDS) if (normalized[key] !== undefined) {
      putAt(normalized, ["defaults", key], normalized[key]);
      delete normalized[key];
    }
  }
  for (const section of ["chat", "embedding", "image_generation"]) {
    const entries = table[section];
    if (entries === undefined) continue;
    if (!isConfigTable(entries)) throw new Error(`${source}: ${section} must be a table`);
    for (const [name, entry] of Object.entries(entries)) {
      if (!isConfigTable(entry)) throw new Error(`${source}: ${formatConfigPath([section, name])} must be a table`);
      entries[name] = normalizeSettings(entry, source);
    }
  }
  const budgets = valueAt(table, ["usage", "budgets"]);
  if (Array.isArray(budgets)) for (const budget of budgets) if (isConfigTable(budget)) toInternal(budget, BUDGET_FIELDS);
  for (const section of ["heartbeat", "compaction", "retrieval", "matrix", "image"]) if (isConfigTable(table[section]) && Object.keys(table[section]).length === 0) delete table[section];
  return table;
}

export function canonicalConfigPath(path: ConfigPath): string[] {
  const sections: Record<string, string[]> = {
    "memory.compaction": ["compaction"], "memory.retrieval": ["retrieval"], "connections.matrix": ["matrix"],
    "tools.config": ["tools"],
  };
  const section = sections[path.join(".")];
  if (section !== undefined) return section;
  let result = [...path];
  for (const rule of CONFIG_FIELDS) {
    const mapped = translatePath(path, rule.internal, rule.canonical);
    if (mapped !== undefined) { result = mapped; break; }
  }
  if (path.join(".") === "behavior.autonomy.enabled") return ["heartbeat", "enabled"];
  if (result[0] === "providers" && result[2] === "defaults") result.splice(2, 1);
  const settingIndex = result[0] === "providers" ? 2 : result[0] === "chat" && result[1]?.includes(":") ? 2 : undefined;
  if (settingIndex !== undefined && result[settingIndex] !== undefined) result[settingIndex] = canonicalSettingKey(result[settingIndex]);
  if (result[0] === "budgets" && result[2] !== undefined) result[2] = BUDGET_FIELDS.find((rule) => rule.internal[0] === result[2])?.canonical[0] ?? result[2];
  return result;
}

export function publicConfig(input: ConfigTable): ConfigTable {
  const out = structuredClone(input);
  for (const rule of CONFIG_FIELDS) for (const path of matchingPaths(input, rule.internal)) {
    const original = valueAt(out, path);
    if (original === undefined) continue;
    const target = translatePath(path, rule.internal, rule.canonical) as string[];
    if (path[0] === "tools" && path[1] === "config" && TOOLS_SCALAR_KEYS.includes(path[2] ?? "")) continue;
    removeAt(out, path);
    const value = structuredClone(original);
    const existing = valueAt(out, target);
    putAt(out, target, isConfigTable(value) && isConfigTable(existing) ? { ...value, ...existing } : value);
  }
  putAt(out, ["heartbeat", "enabled"], valueAt(input, ["behavior", "autonomy", "enabled"]) === true);
  const enabled = valueAt(input, ["notifications", "enabled"]);
  putAt(out, ["notifications", "via"], enabled === true ? valueAt(input, ["notifications", "backend"]) ?? "notify_send" : "off");
  const events = valueAt(input, ["notifications", "events"]);
  if (isConfigTable(events)) putAt(out, ["notifications", "events"], NOTIFICATION_EVENTS.filter((key) => events[key] === true));
  const budgets = out.budgets;
  if (Array.isArray(budgets)) for (const budget of budgets) if (isConfigTable(budget)) {
    for (const rule of BUDGET_FIELDS) {
      const old = rule.internal[0] as string;
      const key = rule.canonical[0] as string;
      if (budget[old] !== undefined) { budget[key] = budget[old]; delete budget[old]; }
    }
    budget.allow_compaction ??= false;
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
  for (const path of [
    ["behavior"], ["defaults"],
    ["notifications", "enabled"], ["notifications", "backend"], ["tools", "config"],
  ]) removeAt(out, path);
  return out;
}

export function publicSettings(input: ConfigTable): ConfigTable {
  const out = { ...input };
  for (const rule of SETTING_FIELDS) {
    const old = rule.internal[0] as string;
    const key = rule.canonical[0] as string;
    if (out[old] === undefined) continue;
    out[key] = old === "gemini_generation" ? geminiMode(out[old]) : out[old];
    delete out[old];
  }
  return out;
}
