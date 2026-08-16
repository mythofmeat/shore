import {
  SAMPLER_FIELD_BY_KEY,
  SAMPLER_KEYS,
  type SamplerSettings,
} from "../config/preferences.ts";
import { parseCacheKeepalive, sdkFromWire, SDK_VARIANTS, type Sdk } from "../config/models.ts";
import { parseThinkingReplay } from "../config/app.ts";
import {
  applicability,
  fieldFromKey,
  reasoningDomain,
  supportsReasoningOff,
  validate,
  type Applicability,
  type ModelCapabilities,
} from "../llm/capabilities.ts";
import { invalidRequest, type CommandError } from "./errors.ts";

export { SAMPLER_KEYS };

const show = (v: unknown): string => JSON.stringify(v) ?? "null";

type Parsed = { value: unknown } | { error: string };

const number = (name: string) => (v: unknown): Parsed =>
  typeof v === "number" ? { value: v } : { error: `${name} must be a number, got ${show(v)}` };

const string = (name: string) => (v: unknown): Parsed =>
  typeof v === "string" ? { value: v } : { error: `${name} must be a string, got ${show(v)}` };

const boolean = (name: string) => (v: unknown): Parsed =>
  typeof v === "boolean" ? { value: v } : { error: `${name} must be a boolean, got ${show(v)}` };

const u32 = (name: string) => (v: unknown): Parsed =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xff_ff_ff_ff
    ? { value: v }
    : { error: `${name} must be a non-negative integer fitting in u32, got ${show(v)}` };

const PARSERS: Record<string, (v: unknown) => Parsed> = {
  temperature: number("temperature"),
  top_p: number("top_p"),
  reasoning_effort: string("reasoning_effort"),
  budget_tokens: u32("budget_tokens"),
  max_output_tokens: u32("max_output_tokens"),
  cache_ttl: string("cache_ttl"),
  gemini_generation: u32("gemini_generation"),
  zai_clear_thinking: boolean("zai_clear_thinking"),
  zai_subscription: boolean("zai_subscription"),
  supports_images: boolean("supports_images"),

  cache_keepalive: (v) => {
    const raw = string("cache_keepalive")(v);
    if ("error" in raw) return raw;
    const parsed = parseCacheKeepalive(raw.value as string);
    return "err" in parsed ? { error: `cache_keepalive: ${parsed.err}` } : { value: parsed.ok };
  },

  sdk: (v) => {
    const raw = string("sdk")(v);
    if ("error" in raw) return raw;
    const s = raw.value as string;
    return sdkFromWire(s) === undefined
      ? { error: `sdk must be one of ${SDK_VARIANTS.map(show).join(", ")}; got ${show(s)}` }
      : { value: s };
  },

  replay_prior_thinking: (v) => {
    if (typeof v === "boolean") return { value: v ? "all" : "none" };
    if (typeof v !== "string") {
      return { error: `replay_prior_thinking must be "all" or "none"; got ${show(v)}` };
    }
    const parsed = parseThinkingReplay(v);
    return parsed === undefined
      ? { error: `replay_prior_thinking must be "all" or "none"; got ${show(v)}` }
      : { value: parsed };
  },

  max_tool_iterations: (v) => {
    const parsed = u32("max_tool_iterations")(v);
    if ("error" in parsed) return parsed;
    return parsed.value === 0
      ? { error: "max_tool_iterations must be >= 1; unset it (null) for unlimited" }
      : parsed;
  },

  openrouter_provider: (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { error: `openrouter_provider must be a routing object, got ${show(v)}` };
    }
    const bad = tomlUnrepresentable(v);
    return bad === undefined
      ? { value: v }
      : { error: `openrouter_provider must be a TOML-compatible object: ${bad}` };
  },
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

export function applySamplerValue(sampler: SamplerSettings, key: string, value: unknown): void {
  const field = SAMPLER_FIELD_BY_KEY.get(key);
  const parser = PARSERS[key];
  if (field === undefined || parser === undefined) {
    throw invalidRequest(`unknown setting key: ${key}`);
  }

  const target = sampler as Record<string, unknown>;
  if (value === null || value === undefined) {
    target[field] = undefined;
    return;
  }

  const parsed = parser(value);
  if ("error" in parsed) throw invalidRequest(parsed.error);
  target[field] = parsed.value;
}

export function capabilityCheck(
  sdk: Sdk,
  modelId: string,
  key: string,
  value: unknown,
  capabilities?: ModelCapabilities,
): CommandError | undefined {
  if (value === null || value === undefined) return undefined;
  const field = fieldFromKey(key);
  if (field === undefined) return undefined;

  const reasoningOff =
    field === "reasoning_effort" && value === "off" && supportsReasoningOff(sdk);

  const probe: string | true = typeof value === "string" && !reasoningOff ? value : true;
  const failure = validate(sdk, modelId, field, probe, capabilities);
  return failure === undefined ? undefined : invalidRequest(failure.message);
}

export function keyApplicability(
  sdk: Sdk,
  modelId: string,
  capabilities?: ModelCapabilities,
): Record<string, Applicability | "always"> {
  const out: Record<string, Applicability | "always"> = {};
  for (const key of SAMPLER_KEYS) {
    const field = fieldFromKey(key);
    out[key] = field === undefined ? "always" : applicability(sdk, modelId, field, capabilities);
  }
  return out;
}

export const reasoningEffortDomain = reasoningDomain;
