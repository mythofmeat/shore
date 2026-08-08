import { defaultAppConfig } from "./app.ts";
import { serializeConfigValue } from "./serialize.ts";

export const UNSET = "<unset>";

const PREAMBLE = `Shore configuration

Every line below is commented out, and every value shown is the built-in
default rendered from this binary. Uncomment a line to override it; a line
you leave alone keeps following the default, including after an upgrade
that changes what the default is.

\`${UNSET}\` marks an option with no default at all. Uncommenting one without
replacing the marker is a parse error, which is the intent — there is no
value to fall back to.

Characters are discovered from the characters/ directory. Create
characters/<name>/workspace/SOUL.md to define a character.

Models are referenced as \`provider:model_id\` against a [providers.*] entry.
You can also use \`include = ["extra.toml"]\` or conf.d/*.toml for modular
config.

Providers are not part of the generated block below — they are yours to
name, so there is no default to show.

  include = ["models.toml"]

  [providers.anthropic]
  api_key_env = "ANTHROPIC_API_KEY"

  [providers.anthropic.defaults]
  cache_ttl = "1h"

Every client authenticates with a shared token. The daemon writes one to
<config>/token on first start; SHORE_TOKEN overrides it, which is how a
client on another host or in another container is given the value.`;

const DEPRECATED_PATHS = new Set(["defaults.heartbeat"]);

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
    if (DEPRECATED_PATHS.has([...path, key].join("."))) continue;
    if (isTable(value)) tables.push([key, value]);
    else if (value !== null || includeUnset) scalars.push([key, value]);
  }

  if (path.length > 0) {
    if (out.length > 0) out.push("");
    out.push(`[${path.join(".")}]`);
    for (const [key, value] of scalars) out.push(`${key} = ${tomlValue(value)}`);
  }
  for (const [key, value] of tables) renderTable([...path, key], value, includeUnset, out);
}

export function renderDefaultsToml(includeUnset = false): string {
  const tree = serializeConfigValue(defaultAppConfig());
  if (!isTable(tree)) throw new Error("defaultAppConfig did not serialize to a table");

  const lines: string[] = [];
  renderTable([], tree, includeUnset, lines);
  return `${lines.join("\n")}\n`;
}

function commented(body: string): string {
  return body
    .split("\n")
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
}

export function renderStarterConfig(): string {
  return `${commented(PREAMBLE)}\n\n${commented(renderDefaultsToml(true).trimEnd())}\n`;
}
