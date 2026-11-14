export type ConfigTable = Record<string, unknown>;
export type ConfigPath = readonly string[];

export const MODEL_FIELDS = [
  "max_context_tokens", "max_output_tokens", "temperature", "top_p", "reasoning_effort",
  "reasoning_budget_tokens", "cache_ttl", "reasoning_replay",
  "max_tool_rounds", "openrouter_routing", "gemini_thinking_mode", "zai_clear_reasoning", "supports_images",
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
