import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import type { MoonshotAIProviderOptions } from "@ai-sdk/moonshotai";
import { ThinkingLevel } from "@google/genai";
import type { OutputConfig } from "@anthropic-ai/sdk/resources/messages";
import { ChatRequestEffort } from "@openrouter/sdk/models";
import type { ReasoningEffort as OpenAiReasoningEffort } from "openai/resources/shared";
import type { ZhipuReasoningEffort } from "zhipu-ai-provider";

import type { SamplerSettings } from "../config/preferences.ts";
import { ConfigDuration } from "../config/duration.ts";
import { parseCacheKeepalive, parseCacheKeepaliveMax } from "../config/keepalive.ts";
import type { DiscoveredModelSupport } from "./discovery.ts";
import { REASONING_OFF, SDK_VARIANTS, sdkFromWire, type Sdk } from "./types.ts";

export type SettingKind =
  | "number"
  | "u32"
  | "boolean"
  | "string"
  | "duration"
  | "duration_or_off"
  | "json_object";

export type SettingApplicability = "always" | "honored" | "ignored" | "rejected";

export interface SettingEditor {
  kind: "slider";
  min: number;
  max: number;
  step: number;
}

export interface SettingSchemaEntry {
  key: string;
  kind: SettingKind;
  applicability: SettingApplicability;
  suggestions: readonly string[];
  allow_custom: boolean;
  editor?: SettingEditor;
}

type Parsed = { value: unknown } | { error: string };
type SamplerField = keyof SamplerSettings;

interface SettingDefinition {
  key: string;
  field: SamplerField;
  kind: SettingKind;
  suggestions: readonly string[] | ((sdk: Sdk, support?: DiscoveredModelSupport) => readonly string[]);
  allowCustom: boolean | ((sdk: Sdk, support?: DiscoveredModelSupport) => boolean);
  editor?: SettingEditor;
  applicability: (sdk: Sdk, support?: DiscoveredModelSupport) => SettingApplicability;
  parse: (value: unknown) => Parsed;
  serialize?: (value: unknown) => unknown;
}

const show = (value: unknown): string => JSON.stringify(value) ?? "null";

const parseNumber = (name: string) => (value: unknown): Parsed => {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(parsed)
    ? { value: parsed }
    : { error: `${name} must be a number, got ${show(value)}` };
};

const parseString = (name: string) => (value: unknown): Parsed =>
  typeof value === "string"
    ? { value }
    : { error: `${name} must be a string, got ${show(value)}` };

const parseBoolean = (name: string) => (value: unknown): Parsed => {
  if (typeof value === "boolean") return { value };
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "yes":
      case "on":
        return { value: true };
      case "false":
      case "no":
      case "off":
        return { value: false };
    }
  }
  return { error: `${name} must be a boolean, got ${show(value)}` };
};

const parseU32 = (name: string) => (value: unknown): Parsed => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xff_ff_ff_ff
    ? { value: parsed }
    : { error: `${name} must be a non-negative integer fitting in u32, got ${show(value)}` };
};

const parseReasoning = (value: unknown): Parsed => {
  const raw = parseString("reasoning_effort")(value);
  if ("error" in raw) return raw;
  const effort = (raw.value as string).trim();
  if (effort === "") return { error: "reasoning_effort must be a non-empty string" };
  switch (effort.toLowerCase()) {
    case "none":
    case "disable":
    case "disabled":
      return { value: REASONING_OFF };
    default:
      return { value: effort };
  }
};

const parseReplay = (value: unknown): Parsed => {
  if (typeof value === "boolean") return { value: value ? "all" : "none" };
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "all":
      case "true":
      case "yes":
      case "on":
        return { value: "all" };
      case "none":
      case "false":
      case "no":
      case "off":
        return { value: "none" };
    }
  }
  return { error: `replay_prior_thinking must be "all" or "none"; got ${show(value)}` };
};

const parseDuration = (name: string, orOff: boolean) => (value: unknown): Parsed => {
  const raw = parseString(name)(value);
  if ("error" in raw) return raw;
  const parsed = orOff
    ? parseCacheKeepalive(raw.value as string)
    : parseCacheKeepaliveMax(raw.value as string);
  return "err" in parsed ? { error: `${name}: ${parsed.err}` } : { value: parsed.ok };
};

const parseCacheTtl = (value: unknown): Parsed => {
  const raw = parseString("cache_ttl")(value);
  if ("error" in raw) return raw;
  const parsed = parseCacheKeepaliveMax(raw.value as string);
  return "err" in parsed
    ? { error: `cache_ttl: ${parsed.err}` }
    : { value: parsed.ok.toString() };
};

function tomlUnrepresentable(value: unknown): string | undefined {
  if (value === null) return "unsupported unit type";
  if (Array.isArray(value)) {
    for (const item of value) {
      const bad = tomlUnrepresentable(item);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const bad = tomlUnrepresentable(item);
      if (bad !== undefined) return bad;
    }
  }
  return undefined;
}

const parseJsonObject = (value: unknown): Parsed => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { error: `openrouter_provider must be a routing object, got ${show(value)}` };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `openrouter_provider must be a routing object, got ${show(value)}` };
  }
  const bad = tomlUnrepresentable(parsed);
  return bad === undefined
    ? { value: parsed }
    : { error: `openrouter_provider must be a TOML-compatible object: ${bad}` };
};

type AnthropicEffort = NonNullable<OutputConfig["effort"]>;
type OpenAiEffort = NonNullable<OpenAiReasoningEffort>;
type DeepSeekEffort = NonNullable<DeepSeekLanguageModelOptions["reasoningEffort"]>;
type MoonshotEffort = NonNullable<MoonshotAIProviderOptions["reasoningEffort"]>;

const ANTHROPIC_NAMED_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly AnthropicEffort[];
const ANTHROPIC_EFFORT = ["adaptive", ...ANTHROPIC_NAMED_EFFORT] as const;
const OPENAI_EFFORT = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly OpenAiEffort[];
const ZAI_EFFORT = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ZhipuReasoningEffort[];
const DEEPSEEK_EFFORT = ["low", "high", "max"] as const satisfies readonly DeepSeekEffort[];
const MOONSHOT_EFFORT = ["low", "high", "max"] as const satisfies readonly MoonshotEffort[];
const OPENROUTER_EFFORT = Object.values(ChatRequestEffort).filter((v) => v !== "none");
const GEMINI_EFFORT = Object.values(ThinkingLevel)
  .map((v) => v.toLowerCase())
  .filter((v) => !v.startsWith("thinking_level_"));

function adapterSupportsOff(sdk: Sdk): boolean {
  return sdk !== "gemini";
}

function adapterEffortSuggestions(sdk: Sdk): readonly string[] {
  switch (sdk) {
    case "anthropic": return ANTHROPIC_EFFORT;
    case "openai": return OPENAI_EFFORT;
    case "openrouter": return OPENROUTER_EFFORT;
    case "gemini": return GEMINI_EFFORT;
    case "zai": return ZAI_EFFORT;
    case "deepseek": return DEEPSEEK_EFFORT;
    case "moonshot": return MOONSHOT_EFFORT;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function reasoningSuggestions(sdk: Sdk, support?: DiscoveredModelSupport): readonly string[] {
  const explicit = support?.effort !== undefined || support?.thinking !== undefined;
  const advertised = [
    ...(support?.effort?.supported === false ? [] : support?.effort?.levels ?? []),
    ...(support?.thinking?.adaptive === true ? ["adaptive"] : []),
  ];
  const base = explicit ? advertised : adapterEffortSuggestions(sdk);
  return unique([...base, ...(adapterSupportsOff(sdk) ? [REASONING_OFF] : [])]);
}

function reasoningAllowsCustom(sdk: Sdk, support?: DiscoveredModelSupport): boolean {
  if (support?.effort !== undefined) return false;
  return sdk !== "gemini";
}

function wireParameter(support: DiscoveredModelSupport | undefined, name: string): SettingApplicability {
  const parameters = support?.supported_parameters;
  if (parameters === undefined) return "honored";
  return parameters.includes(name) ? "honored" : "rejected";
}

function vendor(owner: Sdk) {
  return (sdk: Sdk): SettingApplicability => sdk === owner ? "honored" : "ignored";
}

function budgetApplicability(sdk: Sdk, support?: DiscoveredModelSupport): SettingApplicability {
  const supportedSdk = sdk === "anthropic" || sdk === "gemini" || sdk === "moonshot";
  if (!supportedSdk) return "ignored";
  return support?.thinking?.enabled === false ? "rejected" : "honored";
}

function reasoningApplicability(sdk: Sdk, support?: DiscoveredModelSupport): SettingApplicability {
  if (
    support?.effort?.supported === false &&
    support.thinking?.adaptive !== true &&
    !adapterSupportsOff(sdk)
  ) return "rejected";
  return "honored";
}

const always = (): SettingApplicability => "always";
const serializeKeepalive = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return value;
  const keepalive = value as { kind: string; interval?: { toString(): string } };
  return keepalive.kind === "off" ? "off" : keepalive.interval?.toString();
};
const serializeDuration = (value: unknown): unknown =>
  value instanceof ConfigDuration ? value.toString() : value;

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  { key: "temperature", field: "temperature", kind: "number", suggestions: [], allowCustom: true, editor: { kind: "slider", min: 0, max: 2, step: 0.1 }, applicability: (_sdk, support) => wireParameter(support, "temperature"), parse: parseNumber("temperature") },
  { key: "top_p", field: "topP", kind: "number", suggestions: [], allowCustom: true, editor: { kind: "slider", min: 0, max: 1, step: 0.05 }, applicability: (_sdk, support) => wireParameter(support, "top_p"), parse: parseNumber("top_p") },
  { key: "reasoning_effort", field: "reasoningEffort", kind: "string", suggestions: reasoningSuggestions, allowCustom: reasoningAllowsCustom, applicability: reasoningApplicability, parse: parseReasoning },
  { key: "budget_tokens", field: "budgetTokens", kind: "u32", suggestions: ["1024", "2048", "4096", "8192", "16384", "32768"], allowCustom: true, applicability: budgetApplicability, parse: parseU32("budget_tokens") },
  { key: "max_output_tokens", field: "maxOutputTokens", kind: "u32", suggestions: ["16384", "32768", "65536"], allowCustom: true, applicability: always, parse: parseU32("max_output_tokens") },
  { key: "cache_ttl", field: "cacheTtl", kind: "duration", suggestions: ["5m", "1h"], allowCustom: true, applicability: vendor("anthropic"), parse: parseCacheTtl },
  { key: "cache_keepalive", field: "cacheKeepalive", kind: "duration_or_off", suggestions: ["off", "55m"], allowCustom: true, applicability: always, parse: parseDuration("cache_keepalive", true), serialize: serializeKeepalive },
  { key: "cache_keepalive_max", field: "cacheKeepaliveMax", kind: "duration", suggestions: ["90m", "12h"], allowCustom: true, applicability: always, parse: parseDuration("cache_keepalive_max", false), serialize: serializeDuration },
  { key: "sdk", field: "sdk", kind: "string", suggestions: SDK_VARIANTS, allowCustom: false, applicability: always, parse: (value) => { const raw = parseString("sdk")(value); if ("error" in raw) return raw; const sdk = sdkFromWire(raw.value as string); return sdk === undefined ? { error: `sdk must be one of ${SDK_VARIANTS.map(show).join(", ")}; got ${show(raw.value)}` } : { value: raw.value }; } },
  { key: "replay_prior_thinking", field: "replayPriorThinking", kind: "string", suggestions: ["all", "none"], allowCustom: false, applicability: always, parse: parseReplay },
  { key: "max_tool_iterations", field: "maxToolIterations", kind: "u32", suggestions: ["8", "16", "32", "64"], allowCustom: true, applicability: always, parse: (value) => { const parsed = parseU32("max_tool_iterations")(value); return "error" in parsed || parsed.value !== 0 ? parsed : { error: "max_tool_iterations must be >= 1; unset it (null) for unlimited" }; } },
  { key: "openrouter_provider", field: "openrouterProvider", kind: "json_object", suggestions: [], allowCustom: true, applicability: vendor("openrouter"), parse: parseJsonObject },
  { key: "gemini_generation", field: "geminiGeneration", kind: "u32", suggestions: ["1", "2", "3"], allowCustom: true, applicability: vendor("gemini"), parse: parseU32("gemini_generation") },
  { key: "zai_clear_thinking", field: "zaiClearThinking", kind: "boolean", suggestions: ["true", "false"], allowCustom: false, applicability: vendor("zai"), parse: parseBoolean("zai_clear_thinking") },
  { key: "supports_images", field: "supportsImages", kind: "boolean", suggestions: ["true", "false"], allowCustom: false, applicability: always, parse: parseBoolean("supports_images") },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export const SAMPLER_KEYS: readonly string[] = SETTING_DEFINITIONS.map(({ key }) => key);
export const SETTING_STORAGE_FIELDS: readonly (readonly [SamplerField, string])[] =
  SETTING_DEFINITIONS.map(({ field, key }) => [field, key]);

export function settingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function applySamplerValue(sampler: SamplerSettings, key: string, value: unknown): void {
  const definition = BY_KEY.get(key);
  if (definition === undefined) throw new Error(`unknown setting key: ${key}`);
  const target = sampler as Record<string, unknown>;
  if (value === null || value === undefined) {
    target[definition.field] = undefined;
    return;
  }
  const parsed = definition.parse(value);
  if ("error" in parsed) throw new Error(parsed.error);
  target[definition.field] = parsed.value;
}

export function parsedSettingValue(key: string, value: unknown): Parsed {
  const definition = BY_KEY.get(key);
  return definition === undefined ? { error: `unknown setting key: ${key}` } : definition.parse(value);
}

export function settingApplicability(sdk: Sdk, key: string, support?: DiscoveredModelSupport): SettingApplicability {
  return BY_KEY.get(key)?.applicability(sdk, support) ?? "always";
}

export function validateSetting(sdk: Sdk, key: string, value: unknown, support?: DiscoveredModelSupport): string | undefined {
  if (value === null || value === undefined) return undefined;
  const definition = BY_KEY.get(key);
  if (definition === undefined) return undefined;
  const applicability = definition.applicability(sdk, support);
  if (applicability === "ignored" || applicability === "rejected") {
    return `\`${key}\` is not applicable to the \`${sdk}\` sdk for this model`;
  }
  const parsed = definition.parse(value);
  if ("error" in parsed) return parsed.error;
  if (key === "reasoning_effort") {
    const effort = parsed.value as string;
    const suggestions = reasoningSuggestions(sdk, support);
    const allowCustom = reasoningAllowsCustom(sdk, support);
    if (!allowCustom && !suggestions.includes(effort)) {
      return `\`reasoning_effort\` value ${JSON.stringify(effort)} is out of domain; allowed: ${suggestions.join(", ")}`;
    }
  }
  return undefined;
}

export function settingSchema(sdk: Sdk, support?: DiscoveredModelSupport): SettingSchemaEntry[] {
  return SETTING_DEFINITIONS.map((definition) => ({
    key: definition.key,
    kind: definition.kind,
    applicability: definition.applicability(sdk, support),
    suggestions: typeof definition.suggestions === "function" ? definition.suggestions(sdk, support) : definition.suggestions,
    allow_custom: typeof definition.allowCustom === "function" ? definition.allowCustom(sdk, support) : definition.allowCustom,
    ...(definition.editor === undefined ? {} : { editor: definition.editor }),
  }));
}

export function samplerToWire(sampler: SamplerSettings, nulls = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const definition of SETTING_DEFINITIONS) {
    const value = sampler[definition.field];
    const wire = value === undefined ? undefined : (definition.serialize?.(value) ?? value);
    if (wire !== undefined || nulls) out[definition.key] = wire ?? null;
  }
  return out;
}
