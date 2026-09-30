import {
  appConfigShape,
  type ConfigTypeInfo,
  type ConfigValueSource,
} from "./app.ts";
import { requiresRestart } from "./restart.ts";
import { BUDGET_FIELDS, canonicalConfigPath, canonicalSettingKey, formatConfigPath, isConfigTable, MODEL_FIELDS, NOTIFICATION_EVENTS, parseConfigPath, TOOLS_SCALAR_KEYS } from "./surface.ts";

import { isSecretConfigPath } from "./serialize.ts";
import type { ConfigSchemaEntry } from "../protocol/ConfigSchemaEntry.ts";

export type SchemaEntry = ConfigSchemaEntry & {
  description?: string;
  scope?: string;
  units?: string;
};

const DURATION_EXAMPLES = ["0s", "30s", "5m", "1h", "12h", "7d"] as const;
const BOOLEANS = ["true", "false"] as const;

function describe(info: ConfigTypeInfo): string {
  switch (info.kind) {
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "integer":
      return info.width ?? "integer";
    case "float":
      return "number";
    case "duration":
      return "duration";
    case "enum":
      return (info.variants ?? []).join(" | ");
    case "list":
      return `list of ${info.item === undefined ? "values" : describe(info.item)}`;
    case "map":
      return `table of ${info.item === undefined ? "values" : describe(info.item)}`;
    case "table":
      return "table";
    case "unknown":
      return "value";
  }
}

function candidates(info: ConfigTypeInfo): readonly string[] {
  switch (info.kind) {
    case "boolean":
      return BOOLEANS;
    case "enum":
      return info.variants ?? [];
    case "duration":
      return DURATION_EXAMPLES;
    case "list":
      return info.item === undefined ? [] : candidates(info.item);
    default:
      return [];
  }
}

function scalar(info: ConfigTypeInfo): boolean {
  switch (info.kind) {
    case "boolean":
    case "string":
    case "integer":
    case "float":
    case "duration":
    case "enum":
      return true;
    default:
      return false;
  }
}

function settable(info: ConfigTypeInfo): boolean {
  if (scalar(info)) return true;
  return info.kind === "list" && info.item !== undefined && scalar(info.item);
}

function sourceOf(info: ConfigTypeInfo): ConfigValueSource | undefined {
  if (info.source !== undefined) return info.source;
  return info.kind === "list" ? info.item?.source : undefined;
}

function entry(key: string, info: ConfigTypeInfo): SchemaEntry {
  const width = info.kind === "list" ? info.item?.width : info.width;
  const source = sourceOf(info);
  return {
    key,
    kind: info.kind,
    ...(info.item === undefined ? {} : { item_kind: info.item.kind }),
    ...(width === undefined ? {} : { width }),
    type: describe(info),
    settable: settable(info),
    optional: info.optional === true,
    restart_required: requiresRestart(key),
    secret: isSecretConfigPath(key.split(".")),
    values: [...candidates(info)],
    ...(source === undefined ? {} : { source }),
    ...(info.keySource === undefined ? {} : { key_source: info.keySource }),
  };
}

export interface LiveInstances {
  instancesAt(key: string): readonly string[];
}

function walk(prefix: string, info: ConfigTypeInfo, live: LiveInstances, out: SchemaEntry[]): void {
  const key = prefix;
  out.push(entry(key, info));

  if (info.kind === "table") {
    const shape = info.table?.();
    if (shape === undefined) return;
    for (const [field, child] of Object.entries(shape.fields)) {
      walk(`${key}.${field}`, child, live, out);
    }
    return;
  }

  if (info.kind === "map" && info.item !== undefined) {
    for (const instance of new Set(["<name>", ...live.instancesAt(key)])) {
      walk(`${key}.${formatConfigPath([instance])}`, info.item, live, out);
    }
  }
  if (info.kind === "list" && info.item?.kind === "table") walk(`${key}."<index>"`, info.item, live, out);
}

export function configSchema(live: LiveInstances): SchemaEntry[] {
  const shape = appConfigShape();
  const internal: SchemaEntry[] = [];
  const internalLive: LiveInstances = {
    instancesAt(key) {
      if (key === "tools.config") return live.instancesAt("tools").filter((name) => !TOOLS_SCALAR_KEYS.includes(name));
      if (key === "subagents") return live.instancesAt(key).filter((name) => !["enabled", "model"].includes(name));
      return live.instancesAt(key);
    },
  };
  for (const [field, info] of Object.entries(shape.fields)) {
    walk(field, info, internalLive, internal);
  }
  const out: SchemaEntry[] = [];
  for (const old of internal) {
    if (old.kind === "table" || old.kind === "map") continue;
    if (["notifications.enabled", "notifications.backend"].includes(old.key) || old.key.startsWith("notifications.events.")) continue;
    const path = canonicalConfigPath(parseConfigPath(old.key));
    if (path[0] === "budgets" && path.length === 3) {
      path[2] = BUDGET_FIELDS.find((rule) => rule.internal[0] === path[2])?.canonical[0] ?? path[2] as string;
    }
    const key = formatConfigPath(path);
    out.push({ ...old, key, secret: isSecretConfigPath(path), settable: old.settable && !path.includes("<index>"), description: describeOption(path), scope: "global or character", ...(unitsOf(path) === undefined ? {} : { units: unitsOf(path) as string }) });
  }
  const add = (path: string[], info: ConfigTypeInfo): void => {
    const key = formatConfigPath(path);
    const row = entry(key, info);
    out.push({ ...row, description: describeOption(path), scope: "global or character", settable: row.settable && !path.includes("<index>") });
  };
  add(["notifications", "via"], { kind: "enum", variants: ["off", "notify_send", "ntfy", "command"] });
  add(["notifications", "events"], { kind: "list", item: { kind: "enum", variants: NOTIFICATION_EVENTS } });
  for (const name of new Set(["<name>", ...live.instancesAt("providers")])) {
    const prefix = ["providers", name];
    for (const field of ["enabled", "subscription", "discover"]) add([...prefix, field], { kind: "boolean" });
    for (const field of ["sdk", "base_url", "api_key_env"]) add([...prefix, field], { kind: "string", optional: true });
    add([...prefix, "ignore_models"], { kind: "list", item: { kind: "string" } });
    add([...prefix, "keys"], { kind: "list", item: { kind: "table" } });
    for (const field of ["name", "api_key_env"]) add([...prefix, "keys", "<index>", field], { kind: "string" });
    for (const field of ["enabled", "warn_on_fallback"]) add([...prefix, "keys", "<index>", field], { kind: "boolean" });
    for (const field of MODEL_FIELDS) add([...prefix, canonicalSettingKey(field)], modelInfo(field));
  }
  for (const section of ["chat", "embedding", "image"]) {
    for (const identity of new Set(["<provider:model_id>", ...live.instancesAt(section).filter((name) => name.includes(":"))])) {
      if (section === "chat") for (const field of [...MODEL_FIELDS, "sdk"]) add([section, identity, canonicalSettingKey(field)], modelInfo(field));
      if (section === "embedding") add([section, identity, "dimensions"], { kind: "integer", width: "u32", optional: true });
      if (section === "image") for (const field of ["size", "quality", "aspect_ratio", "image_size"]) add([section, identity, field], { kind: "string", optional: true });
    }
  }
  const parents = new Set<string>();
  for (const row of out) {
    const path = parseConfigPath(row.key);
    for (let length = 1; length < path.length; length += 1) parents.add(formatConfigPath(path.slice(0, length)));
  }
  for (const key of parents) if (!out.some((row) => row.key === key)) out.push(entry(key, { kind: "table", ...(key === "tools" ? { keySource: "tools" } : key === "subagents" ? { keySource: "subagents" } : {}) }));
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

function modelInfo(field: string): ConfigTypeInfo {
  if (field === "gemini_generation") return { kind: "enum", variants: ["auto", "budget", "level"], optional: true };
  if (field === "replay_prior_thinking") return { kind: "enum", variants: ["all", "none"], optional: true };
  if (field === "supports_images" || field === "zai_clear_thinking") return { kind: "boolean", optional: true };
  if (field === "temperature" || field === "top_p") return { kind: "float", optional: true };
  if (["max_context_tokens", "max_output_tokens", "budget_tokens", "max_tool_iterations"].includes(field)) return { kind: "integer", width: "u32", optional: true };
  if (field === "openrouter_provider") return { kind: "table", optional: true };
  if (field === "cache_ttl") return { kind: "duration", optional: true };
  return { kind: "string", optional: true };
}

const PLAN_LIMIT_DESCRIPTIONS: Record<string, string> = {
  warn_fractions: "Claude plan utilization fractions that trigger warnings (0.8 means 80% of the window).",
  limit_fraction: "Claude plan utilization fraction at which limit_action applies; 1.0 is the whole window.",
  limit_action: "What reaching limit_fraction does to calls on the Claude subscription: warn, block, pause_background or pause_heartbeat.",
};

const IMAGE_DESCRIPTIONS: Record<string, string> = {
  max_tokens: "Most tokens an image may cost; Claude charges one per 28×28-pixel patch. 1,600 fits a 4:3 photo at about 1270×952 (1,564 tokens), 1,000 at 1008×756; 0 leaves only max_edge and the model's own limit.",
  max_edge: "Longest side in pixels. A 4:3 photo costs 1,036 tokens at 1024, 1,610 at 1280, 2,352 at 1568 and 3,888 at 2000 on Claude 4.7 and later; earlier models cap any image at 1,568 tokens (about 1270×952).",
  format: "keep sends an image within the limits untouched and re-encodes the rest as PNG, then WebP; jpeg, webp and png convert every image, and jpeg uses WebP for images that may be transparent. Changes bytes, not tokens.",
  quality: "JPEG and WebP quality, 1–100. To meet max_bytes it is lowered in steps of 10 toward 50 before the image is made smaller. Changes bytes, not tokens.",
  png_compression: "PNG zlib level, 0–9; 9 is smaller and slower. Changes bytes, not tokens.",
  png_palette: "Reduce re-encoded PNGs to 256 colours; very effective on screenshots. Changes bytes, not tokens.",
  max_bytes: "Largest encoded size of one image; met by lowering quality first and size second.",
  tell_model: "Tell the model when a workspace image it reads was reduced, with the original and sent size, format and token cost.",
  allow_original: "Let the model read a workspace image with original: true, at the full resolution its model accepts.",
};

const IMAGE_SECTIONS: Record<string, string> = {
  read: "workspace images the model reads, including images in Markdown",
  upload: "images a user sends",
  mcp: "images in MCP tool results",
};

function describeImageOption(path: readonly string[]): string | undefined {
  const leaf = path.at(-1) ?? "";
  const description = IMAGE_DESCRIPTIONS[leaf];
  if (path.length === 2 || description === undefined) return description;
  const section = IMAGE_SECTIONS[path[1] ?? ""];
  return section === undefined || leaf === "tell_model" || leaf === "allow_original" ? description : `${description} Overrides images.${leaf} for ${section}.`;
}

function describeOption(path: readonly string[]): string {
  const leaf = path.at(-1) ?? "configuration";
  const plan = path[0] === "plan_limits" ? PLAN_LIMIT_DESCRIPTIONS[leaf] : undefined;
  if (plan !== undefined) return plan;
  const image = path[0] === "images" ? describeImageOption(path) : undefined;
  if (image !== undefined) return image;
  const descriptions: Record<string, string> = {
    model: "Fallback model as provider:model_id; stored chat selection and thread pins retain precedence.",
    enabled: "Enable this feature or select the names granted access.",
    mcp: "MCP servers granted by name; each grants every tool of that [mcp.<name>] server.",
    bearer_token_env: "Environment variable holding a bearer token sent as the Authorization header; HTTP servers only.",
    default_interval: "Time until the next heartbeat when the character does not schedule one.",
    min_interval: "Shortest time before any heartbeat, measured from the last heartbeat, message, or daemon start.",
    max_interval: "Longest time the character may schedule its next heartbeat.",
    via: "Notification delivery method; off disables delivery.",
    events: "Notification events to deliver; a list replaces the inherited selection.",
    discover: "Discover this provider's models; false by default.",
    reasoning_budget_tokens: "Maximum reasoning token budget, where supported by the model SDK.",
    max_tool_rounds: "Maximum model/tool iterations; positive integer.",
    max_inline_image_bytes: "Total prepared (resized) image bytes sent to the model per tool result; defaults to 5 MiB. Zero disables inline images.",
    cost_usd: "Spending ceiling in US dollars for this budget window.",
    allow_compaction: "Allow compaction to exceed this budget's ceiling.",
    warn_fractions: "Budget fractions that trigger warnings (0.9 means 90%).",
    pace_warn_fractions: "Pacing fractions that trigger warnings.",
  };
  return descriptions[leaf] ?? `${leaf.replaceAll("_", " ")} for ${path[0]}.`;
}

function unitsOf(path: readonly string[]): string | undefined {
  const leaf = path.at(-1) ?? "";
  return leaf.endsWith("_bytes") ? "bytes" : leaf.endsWith("_chars") ? "characters" : leaf.endsWith("_tokens") ? "tokens" : leaf.endsWith("_fractions") || leaf === "limit_fraction" ? "fraction" : leaf === "cost_usd" ? "USD" : leaf === "max_edge" ? "pixels" : undefined;
}

export function findSchemaEntry(entries: readonly SchemaEntry[], key: string): SchemaEntry | undefined {
  const exact = entries.find((e) => e.key === key);
  if (exact !== undefined) return exact;
  const path = parseConfigPath(key);
  const template = entries.find((candidate) => {
    const pattern = parseConfigPath(candidate.key);
    return pattern.length === path.length && pattern.every((part, i) => part === path[i] || part === "<name>" || part === "<index>" && /^[0-9]+$/.test(path[i] ?? "") || part === "<provider:model_id>" && path[i]?.includes(":") === true);
  });
  return template === undefined ? undefined : { ...template, key };
}

const REMOVED_SECTIONS: ReadonlyMap<string, string> = new Map([
  ["web_search", "[web_search] is no longer supported: the built-in web_search tool was removed. Delete this section and configure a search MCP server instead, for example [mcp.tavily] with url = \"https://mcp.tavily.com/mcp/\" and bearer_token_env = \"TAVILY_API_KEY\", then grant it with tools.mcp = [\"tavily\"]"],
]);

export function validateConfigSource(input: Record<string, unknown>, source: string): void {
  const entries = configSchema({ instancesAt: () => [] });
  const visit = (value: unknown, path: string[]): void => {
    const key = formatConfigPath(path);
    const info = findSchemaEntry(entries, key);
    const removed = path.length === 1 ? REMOVED_SECTIONS.get(key) : undefined;
    if (removed !== undefined) throw new Error(`${source}: ${removed}`);
    if (info === undefined) {
      const expected = entries.filter((candidate) => parseConfigPath(candidate.key).length === 1).map((candidate) => `\`${candidate.key}\``);
      throw new Error(`${source}: unknown field \`${key}\`${path.length === 1 ? `, expected one of ${expected.join(", ")}` : ""}`);
    }
    if (info.kind === "table") {
      if (!isConfigTable(value)) throw new Error(`${source}: ${key} must be a table`);
      if (path.at(-1) === "openrouter_routing") return;
      for (const [name, child] of Object.entries(value)) visit(child, [...path, name]);
    } else if (info.kind === "list" && info.item_kind === "table" && Array.isArray(value)) {
      for (const [index, child] of value.entries()) visit(child, [...path, String(index)]);
    } else if (info.kind === "enum" && !info.values.includes(String(value))) {
      throw new Error(`${source}: ${key} must be ${info.values.join(", ")}`);
    }
  };
  for (const [key, value] of Object.entries(input)) visit(value, [key]);
}
