import { defaultAppConfig } from "./app.ts";
import { serializeConfigValue } from "./serialize.ts";
import { formatConfigPath, publicConfig } from "./surface.ts";

export const UNSET = "<unset>";


function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlValue(value: unknown): string {
  if (value === null) return UNSET;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return JSON.stringify(value);
}

function renderTable(
  path: readonly string[],
  table: Record<string, unknown>,
  includeUnset: boolean,
  out: string[],
): void {
  const scalars: [string, unknown][] = [];
  const tables: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) tables.push([key, value]);
    else if (value !== null || includeUnset) scalars.push([key, value]);
  }

  if (path.length > 0) {
    if (out.length > 0) out.push("");
    out.push(`[${formatConfigPath(path)}]`);
  }
  for (const [key, value] of scalars) out.push(`${formatConfigPath([key])} = ${tomlValue(value)}`);
  for (const [key, value] of tables) renderTable([...path, key], value, includeUnset, out);
}

export function renderDefaultsToml(includeUnset = false): string {
  const tree = publicConfig(serializeConfigValue(defaultAppConfig()) as Record<string, unknown>);
  if (!isTable(tree)) throw new Error("defaultAppConfig did not serialize to a table");

  const lines: string[] = [];
  renderTable([], tree, includeUnset, lines);
  return `${lines.join("\n")}\n`;
}

export function renderStarterConfig(): string {
  return `# Shore configuration. Set ANTHROPIC_API_KEY in the environment or .env.
# See docs/CONFIG_REFERENCE.md for optional settings and defaults.
# Add characters/<name>/workspace/SOUL.md to define a character.
# Additional TOML files in conf.d/ load automatically, in filename order.
# The daemon creates a client authentication token beside this file.

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[chat]
model = "anthropic:claude-opus-4-8"

[tools]
enabled = ["bash", "read", "edit", "apply_patch", "search", "search_chat_logs"]
`;
}
