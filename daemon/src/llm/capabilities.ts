import rawCaps from "./capabilities.toml";

import { parseCacheKeepalive } from "../config/models.ts";

export type Sdk =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "gemini"
  | "zai"
  | "deepseek"
  | "moonshot";
type ClaudeFamily = "opus" | "sonnet" | "haiku";

interface SdkEffort {
  domain: readonly string[];
  fold?: Record<string, string>;
  budget?: Record<string, number>;
}

interface ModelOverride {
  match: string;
  reasoning_effort?: readonly string[];
  rejects_sampling?: boolean;
}

interface ClaudeRule {
  contains?: string;
  family?: string;
  min_major?: number;
  min_minor?: number;
  max_major?: number;
  max_minor?: number;
  adaptive?: boolean;
  enabled?: boolean;
  rejects_sampling?: boolean;
}

interface CapabilitiesDoc {
  reasoning_effort: {
    anthropic: SdkEffort;
    openai: SdkEffort;
    openrouter: SdkEffort;
    gemini: SdkEffort;
    zai: SdkEffort;
    deepseek: SdkEffort;
    moonshot: SdkEffort;
  };
  claude: {
    default_adaptive: boolean;
    default_enabled: boolean;
    default_rejects_sampling: boolean;
    thinking_rule?: ClaudeRule[];
    sampler_rule?: ClaudeRule[];
  };
  model_override?: ModelOverride[];
}

const caps = rawCaps as CapabilitiesDoc;

function sdkEffort(sdk: Sdk): SdkEffort {
  switch (sdk) {
    case "anthropic":
      return caps.reasoning_effort.anthropic;
    case "openai":
      return caps.reasoning_effort.openai;
    case "openrouter":
      return caps.reasoning_effort.openrouter;
    case "gemini":
      return caps.reasoning_effort.gemini;
    case "zai":
      return caps.reasoning_effort.zai;
    case "deepseek":
      return caps.reasoning_effort.deepseek;
    case "moonshot":
      return caps.reasoning_effort.moonshot;
  }
}

export function reasoningDomain(sdk: Sdk, modelId?: string): readonly string[] {
  if (modelId !== undefined) {
    const lower = modelId.toLowerCase();
    for (const ov of caps.model_override ?? []) {
      if (ov.reasoning_effort && lower.includes(ov.match.toLowerCase())) return ov.reasoning_effort;
    }
  }
  return sdkEffort(sdk).domain;
}

export function foldEffort(sdk: Sdk, effort: string, modelId?: string): string | undefined {
  if (!reasoningDomain(sdk, modelId).includes(effort)) return undefined;
  return sdkEffort(sdk).fold?.[effort] ?? effort;
}

export function effortBudget(effort: string): number {
  return caps.reasoning_effort.anthropic.budget?.[effort] ?? 8192;
}

export function geminiLevelName(effort: string): string | undefined {
  const e = effort.toLowerCase();
  return reasoningDomain("gemini").includes(e) ? e : undefined;
}

interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number;
}

export function parseClaudeModel(modelId: string): ClaudeVersion | undefined {
  const slash = modelId.lastIndexOf("/");
  const lower = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();

  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.includes("claude")) return undefined;

  let family: ClaudeFamily | undefined;
  if (tokens.includes("opus")) family = "opus";
  else if (tokens.includes("sonnet")) family = "sonnet";
  else if (tokens.includes("haiku")) family = "haiku";
  else return undefined;

  let major: number | undefined;
  let minor = 0;
  for (const tok of tokens) {
    if (tok.length > 2 || !/^[0-9]+$/.test(tok)) continue;
    const n = Number.parseInt(tok, 10);
    if (Number.isNaN(n)) continue;
    if (major === undefined) major = n;
    else {
      minor = n;
      break;
    }
  }
  if (major === undefined) return undefined;
  return { family, major, minor };
}

function familyInSet(set: string, family: ClaudeFamily): boolean {
  return set.split("|").includes(family);
}

function ruleMatches(rule: ClaudeRule, idLower: string, v: ClaudeVersion | undefined): boolean {
  if (rule.contains !== undefined && !idLower.includes(rule.contains)) return false;
  const needsVersion =
    rule.family !== undefined || rule.min_major !== undefined || rule.max_major !== undefined;
  if (needsVersion) {
    if (v === undefined) return false;
    if (rule.family !== undefined && !familyInSet(rule.family, v.family)) return false;
    if (rule.min_major !== undefined) {
      const minMinor = rule.min_minor ?? 0;
      if (v.major < rule.min_major || (v.major === rule.min_major && v.minor < minMinor)) return false;
    }
    if (rule.max_major !== undefined) {
      const maxMinor = rule.max_minor ?? Number.MAX_SAFE_INTEGER;
      if (v.major > rule.max_major || (v.major === rule.max_major && v.minor > maxMinor)) return false;
    }
  }
  return rule.contains !== undefined || needsVersion;
}

export function claudeThinkingCaps(model: string): { adaptive: boolean; enabled: boolean } {
  const lower = model.toLowerCase();
  const v = parseClaudeModel(model);
  for (const rule of caps.claude.thinking_rule ?? []) {
    if (ruleMatches(rule, lower, v)) {
      return {
        adaptive: rule.adaptive ?? caps.claude.default_adaptive,
        enabled: rule.enabled ?? caps.claude.default_enabled,
      };
    }
  }
  return { adaptive: caps.claude.default_adaptive, enabled: caps.claude.default_enabled };
}

function claudeRejectsSampling(model: string): boolean {
  const lower = model.toLowerCase();
  const v = parseClaudeModel(model);
  for (const rule of caps.claude.sampler_rule ?? []) {
    if (ruleMatches(rule, lower, v)) {
      return rule.rejects_sampling ?? caps.claude.default_rejects_sampling;
    }
  }
  return caps.claude.default_rejects_sampling;
}

export function modelOverrideRejectsSampling(model: string): boolean {
  const lower = model.toLowerCase();
  for (const ov of caps.model_override ?? []) {
    if (ov.rejects_sampling !== undefined && lower.includes(ov.match.toLowerCase())) {
      return ov.rejects_sampling;
    }
  }
  return false;
}

export function rejectsSampling(model: string): boolean {
  return claudeRejectsSampling(model) || modelOverrideRejectsSampling(model);
}

export type Applicability =
  | "honored"
  | "ignored"
  | "rejected";

export type Field =
  | "max_context_tokens"
  | "max_output_tokens"
  | "temperature"
  | "top_p"
  | "reasoning_effort"
  | "budget_tokens"
  | "cache_ttl"
  | "cache_keepalive"
  | "openrouter_provider"
  | "gemini_generation"
  | "zai_clear_thinking"
  | "zai_subscription"
  | "replay_prior_thinking";

export const FIELDS: readonly Field[] = [
  "max_context_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning_effort",
  "budget_tokens",
  "cache_ttl",
  "cache_keepalive",
  "openrouter_provider",
  "gemini_generation",
  "zai_clear_thinking",
  "zai_subscription",
  "replay_prior_thinking",
];

export function fieldFromKey(key: string): Field | undefined {
  return (FIELDS as readonly string[]).includes(key) ? (key as Field) : undefined;
}

function vendorField(sdk: Sdk, owner: Sdk): Applicability {
  return sdk === owner ? "honored" : "ignored";
}

export function applicability(sdk: Sdk, modelId: string, field: Field): Applicability {
  switch (field) {
    case "max_context_tokens":
    case "max_output_tokens":
    case "cache_keepalive":
      return "honored";

    case "reasoning_effort":
      return "honored";

    case "temperature":
    case "top_p":
      return rejectsSampling(modelId) ? "rejected" : "honored";

    case "budget_tokens":
      return budgetTokensApplicability(sdk, modelId);

    case "cache_ttl":
      return vendorField(sdk, "anthropic");

    case "openrouter_provider":
      return vendorField(sdk, "openrouter");

    case "gemini_generation":
      return vendorField(sdk, "gemini");

    case "zai_clear_thinking":
    case "zai_subscription":
      return vendorField(sdk, "zai");

    case "replay_prior_thinking":
      return replayApplicability(sdk);
  }
}

function budgetTokensApplicability(sdk: Sdk, modelId: string): Applicability {
  switch (sdk) {
    case "anthropic":
      return claudeRejectsSampling(modelId) ? "rejected" : "honored";
    case "gemini":
    case "moonshot":
      return "honored";
    case "openai":
    case "openrouter":
    case "zai":
    case "deepseek":
      return "ignored";
  }
}

function replayApplicability(sdk: Sdk): Applicability {
  switch (sdk) {
    case "anthropic":
    case "openai":
    case "zai":
    case "openrouter":
    case "gemini":
      return "honored";
    case "deepseek":
    case "moonshot":
      return "ignored";
  }
}

export function defaultValue(sdk: Sdk, field: Field): string | undefined {
  if (sdk !== "anthropic") return undefined;
  if (field === "cache_ttl") return "1h";
  return undefined;
}

export function supportsReasoningOff(sdk: Sdk): boolean {
  return sdk === "anthropic" || sdk === "deepseek" || sdk === "moonshot" || sdk === "openrouter" || sdk === "zai";
}

class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function validate(
  sdk: Sdk,
  modelId: string,
  field: Field,
  probe: string | true,
): CapabilityError | undefined {
  if (applicability(sdk, modelId, field) !== "honored") {
    return new CapabilityError(`\`${field}\` is not applicable to the \`${sdk}\` sdk for this model`);
  }

  const outOfDomain = (value: string, allowed: string) =>
    new CapabilityError(`\`${field}\` value ${JSON.stringify(value)} is out of domain; allowed: ${allowed}`);

  if (field === "reasoning_effort" && probe !== true) {
    const domain = reasoningDomain(sdk, modelId);
    if (!domain.includes(probe)) return outOfDomain(probe, domain.join(", "));
  }

  if (field === "cache_keepalive") {
    const allowed = "off, or a duration string like 55m / 6h / 30s";
    if (probe === true) return outOfDomain("true", allowed);
    if ("err" in parseCacheKeepalive(probe)) return outOfDomain(probe, allowed);
  }

  return undefined;
}
