import type { DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import type { MoonshotAIProviderOptions } from "@ai-sdk/moonshotai";
import { ThinkingLevel } from "@google/genai";
import type { OutputConfig } from "@anthropic-ai/sdk/resources/messages";
import { ChatRequestEffort } from "@openrouter/sdk/models";
import type { ReasoningEffort as OpenAiReasoningEffort } from "openai/resources/shared";
import type { ZhipuReasoningEffort } from "zhipu-ai-provider";

import { parseCacheKeepalive } from "../config/models.ts";

export type Sdk =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "gemini"
  | "zai"
  | "deepseek"
  | "moonshot";

export const REASONING_OFF = "off";

const WIRE_DISABLE_VALUE = "none";

export interface ModelCapabilities {
  effort_levels?: readonly string[];
  thinking_adaptive?: boolean;
  thinking_enabled?: boolean;
  supported_parameters?: readonly string[];
  supports_images?: boolean;
}

type MustBeExhaustive<T extends never> = T;

type UnlistedBy<Declared extends string, FromSdk extends string> = Exclude<
  FromSdk,
  Declared | typeof WIRE_DISABLE_VALUE
>;

type AnthropicEffort = NonNullable<OutputConfig["effort"]>;
type OpenAiEffort = NonNullable<OpenAiReasoningEffort>;
type DeepSeekEffort = NonNullable<DeepSeekLanguageModelOptions["reasoningEffort"]>;
type MoonshotEffort = NonNullable<MoonshotAIProviderOptions["reasoningEffort"]>;

const ANTHROPIC_EFFORT = [
  "adaptive",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const OPENAI_EFFORT = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly OpenAiEffort[];

const ZAI_EFFORT = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ZhipuReasoningEffort[];

const DEEPSEEK_EFFORT = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly DeepSeekEffort[];

const MOONSHOT_EFFORT = ["low", "high", "max"] as const satisfies readonly MoonshotEffort[];

export type EffortDomainsMatchTheSdks = [
  MustBeExhaustive<UnlistedBy<(typeof ANTHROPIC_EFFORT)[number], AnthropicEffort>>,
  MustBeExhaustive<UnlistedBy<(typeof OPENAI_EFFORT)[number], OpenAiEffort>>,
  MustBeExhaustive<UnlistedBy<(typeof ZAI_EFFORT)[number], ZhipuReasoningEffort>>,
  MustBeExhaustive<UnlistedBy<(typeof DEEPSEEK_EFFORT)[number], DeepSeekEffort>>,
  MustBeExhaustive<UnlistedBy<(typeof MOONSHOT_EFFORT)[number], MoonshotEffort>>,
];

const OPENROUTER_EFFORT: readonly string[] = Object.values(ChatRequestEffort).filter(
  (v) => v !== WIRE_DISABLE_VALUE,
);

const GEMINI_EFFORT: readonly string[] = Object.values(ThinkingLevel)
  .map((v) => v.toLowerCase())
  .filter((v) => !v.startsWith("thinking_level_"));

function sdkEffort(sdk: Sdk): readonly string[] {
  switch (sdk) {
    case "anthropic":
      return ANTHROPIC_EFFORT;
    case "openai":
      return OPENAI_EFFORT;
    case "openrouter":
      return OPENROUTER_EFFORT;
    case "gemini":
      return GEMINI_EFFORT;
    case "zai":
      return ZAI_EFFORT;
    case "deepseek":
      return DEEPSEEK_EFFORT;
    case "moonshot":
      return MOONSHOT_EFFORT;
  }
}

export function reasoningDomain(sdk: Sdk, caps?: ModelCapabilities): readonly string[] {
  const levels = caps?.effort_levels;
  if (levels === undefined || levels.length === 0) return sdkEffort(sdk);
  const wire = sdkEffort(sdk);
  const narrowed = wire.filter((v) => levels.includes(v));
  return narrowed.length === 0 ? wire : narrowed;
}

export function geminiLevelName(effort: string): ThinkingLevel | undefined {
  const wanted = effort.toLowerCase();
  return Object.values(ThinkingLevel).find((level) => level.toLowerCase() === wanted);
}

export function supportsReasoningOff(sdk: Sdk): boolean {
  return sdk !== "gemini";
}

export type Applicability = "honored" | "ignored" | "rejected";

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

function wireParameter(caps: ModelCapabilities | undefined, name: string): Applicability {
  const params = caps?.supported_parameters;
  if (params === undefined || params.length === 0) return "honored";
  return params.includes(name) ? "honored" : "rejected";
}

export function rejectsSampling(caps?: ModelCapabilities): boolean {
  return wireParameter(caps, "temperature") === "rejected";
}

export function applicability(
  sdk: Sdk,
  modelId: string,
  field: Field,
  caps?: ModelCapabilities,
): Applicability {
  switch (field) {
    case "max_context_tokens":
    case "max_output_tokens":
    case "cache_keepalive":
    case "reasoning_effort":
      return "honored";

    case "temperature":
      return wireParameter(caps, "temperature");

    case "top_p":
      return wireParameter(caps, "top_p");

    case "budget_tokens":
      return budgetTokensApplicability(sdk, caps);

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
      return "honored";
  }
}

function budgetTokensApplicability(sdk: Sdk, caps?: ModelCapabilities): Applicability {
  switch (sdk) {
    case "anthropic":
      return caps?.thinking_enabled === false ? "rejected" : "honored";
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

export function defaultValue(sdk: Sdk, field: Field): string | undefined {
  if (sdk !== "anthropic") return undefined;
  if (field === "cache_ttl") return "1h";
  return undefined;
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
  caps?: ModelCapabilities,
): CapabilityError | undefined {
  if (applicability(sdk, modelId, field, caps) !== "honored") {
    return new CapabilityError(`\`${field}\` is not applicable to the \`${sdk}\` sdk for this model`);
  }

  const outOfDomain = (value: string, allowed: string) =>
    new CapabilityError(`\`${field}\` value ${JSON.stringify(value)} is out of domain; allowed: ${allowed}`);

  if (field === "reasoning_effort" && probe !== true) {
    const domain = reasoningDomain(sdk, caps);
    if (!domain.includes(probe)) return outOfDomain(probe, domain.join(", "));
  }

  if (field === "cache_keepalive") {
    const allowed = "off, or a duration string like 55m / 6h / 30s";
    if (probe === true) return outOfDomain("true", allowed);
    if ("err" in parseCacheKeepalive(probe)) return outOfDomain(probe, allowed);
  }

  return undefined;
}
