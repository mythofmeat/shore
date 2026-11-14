
export type ConfigTable = Record<string, unknown>;
export type ConfigPath = readonly string[];

export interface ConfigField {
  internal: ConfigPath;
  canonical: ConfigPath;
}

const field = (internal: string, canonical: string): ConfigField => ({
  internal: internal.split("."), canonical: canonical.split("."),
});

const SETTING_FIELDS: readonly ConfigField[] = Object.entries({
  budget_tokens: "reasoning_budget_tokens",
  replay_prior_thinking: "reasoning_replay", max_tool_iterations: "max_tool_rounds",
  openrouter_provider: "openrouter_routing", gemini_generation: "gemini_thinking_mode",
  zai_clear_thinking: "zai_clear_reasoning",
}).map(([old, key]) => field(old, key));

export const MODEL_FIELDS = [
  "max_context_tokens", "max_output_tokens", "temperature", "top_p", "reasoning_effort",
  "budget_tokens", "cache_ttl", "replay_prior_thinking",
  "max_tool_iterations", "openrouter_provider", "gemini_generation", "zai_clear_thinking", "supports_images",
  "system_prompt",
] as const;

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

function valueAt(root: unknown, path: ConfigPath): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as ConfigTable)[segment];
  }
  return current;
}

function putAt(root: ConfigTable, path: ConfigPath, value: unknown): void {
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

function removeAt(root: ConfigTable, path: ConfigPath, prune = true): void {
  const [head, ...tail] = path;
  if (head === undefined) return;
  if (tail.length === 0) { delete root[head]; return; }
  const child = root[head];
  if (!isConfigTable(child) && !Array.isArray(child)) return;
  removeAt(child as ConfigTable, tail, prune);
  if (prune && isConfigTable(child) && Object.keys(child).length === 0) delete root[head];
}

function matchingPaths(root: unknown, pattern: ConfigPath, prefix: string[] = []): string[][] {
  if (pattern.length === 0) return root === undefined ? [] : [prefix];
  if (typeof root !== "object" || root === null) return [];
  const [head, ...tail] = pattern;
  const keys = head === "*" ? Object.keys(root) : head === undefined ? [] : [head];
  return keys.flatMap((key) => matchingPaths((root as ConfigTable)[key], tail, [...prefix, key]));
}

function translatePath(path: ConfigPath, from: ConfigPath, to: ConfigPath): string[] | undefined {
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
  const providers = isConfigTable(table.providers) ? table.providers : {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!isConfigTable(provider)) continue;
    providers[name] = normalizeSettings(provider, `${source}: providers.${name}`);
  }
  for (const section of ["chat", "image"]) {
    const entries = table[section];
    if (entries === undefined) continue;
    if (!isConfigTable(entries)) throw new Error(`${source}: ${section} must be a table`);
    for (const [name, entry] of Object.entries(entries)) {
      if (isConfigTable(entry)) entries[name] = normalizeSettings(entry, source);
    }
  }
  return table;
}

export function publicConfig(input: ConfigTable): ConfigTable {
  const out = structuredClone(input);
  const providers = isConfigTable(out.providers) ? out.providers : {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!isConfigTable(provider)) continue;
    providers[name] = publicSettings(provider);
  }
  for (const section of ["chat", "image"]) {
    const profiles = out[section];
    if (!isConfigTable(profiles)) continue;
    for (const [name, value] of Object.entries(profiles)) if (isConfigTable(value) && name.includes(":")) profiles[name] = publicSettings(value);
  }
  return out;
}

function publicSettings(input: ConfigTable): ConfigTable {
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
