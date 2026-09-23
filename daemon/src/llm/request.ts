import { shoreLog } from "../log.ts";

import {
  defaultApiKeyEnv,
  isKeylessSdk,
  KEYLESS_CANDIDATE,
  readCandidateEnv,
  resolveKeyCandidates,
} from "./credentials";
import type { ProviderEntry } from "./credentials";
import { sanitizeToolPairs } from "./sanitize";
import type {
  GenerateResponse,
  ProviderOptions,
  Sdk,
  SidecarRequest,
  ThinkingReplay,
  WireMessage,
} from "./types";
import type { ContentBlock } from "../engine/types";
import { rustTrim } from "../memory/lines";
import { zaiBaseUrl, ZAI_API_PROVIDER, ZAI_SUB_PROVIDER } from "./providers/zai_config";
import { NANOGPT_BASE_URL, NANOGPT_PROVIDER, nanogptTransportError } from "./providers/nanogpt_config";
import { DEFAULT_KEEPALIVE_PINGS } from "../config/keepalive.ts";

const DEFAULT_MAX_TOKENS = 32768;

export interface ResolvedModel {
  name: string;
  qualified_name: string;
  category: string;
  provider_key: string;
  sdk: Sdk;
  model_id: string;
  api_key_env?: string;
  base_url?: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  budget_tokens?: number;
  cache_ttl?: string;
  cache_keepalive?: string;
  cache_keepalive_pings?: number;
  openrouter_provider?: unknown;
  gemini_generation?: number;
  zai_clear_thinking?: boolean;
  max_tool_iterations?: number;
  supports_images?: boolean;
}

export interface BuiltRequest {
  request: SidecarRequest;
  api_key_name?: string;
  keepalive_interval_ms?: number;
  keepalive_pings?: number;
}

export class MissingApiKey extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`API key environment variable ${variable} is not set`);
    this.name = "MissingApiKey";
    this.variable = variable;
  }
}

export function defaultBaseUrl(providerKey: string): string | undefined {
  switch (providerKey) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com";
    default:
      return hardcodedProviderBaseUrl(providerKey);
  }
}

export function hardcodedProviderBaseUrl(providerKey: string): string | undefined {
  switch (providerKey) {
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "moonshot":
    case "moonshotai":
      return "https://api.moonshot.ai/v1";
    case "xai":
      return "https://api.x.ai/v1";
    case "zhipuai":
      return "https://open.bigmodel.cn/api/paas/v4";
    case ZAI_API_PROVIDER:
    case ZAI_SUB_PROVIDER:
      return zaiBaseUrl(providerKey);
    case NANOGPT_PROVIDER:
      return NANOGPT_BASE_URL;
    case "opencode-go":
      return "https://opencode.ai/zen/go/v1";
    default:
      return undefined;
  }
}

export function providerOptionsFor(model: ResolvedModel): ProviderOptions | undefined {
  const disabled = model.reasoning_effort === "off";

  const options: ProviderOptions = {
    ...(!disabled && model.reasoning_effort !== undefined
      ? { reasoning_effort: model.reasoning_effort }
      : {}),
    ...(disabled ? { thinking_enabled: false } : {}),
    ...(model.budget_tokens !== undefined ? { budget_tokens: model.budget_tokens } : {}),
    ...(model.cache_ttl !== undefined ? { cache_ttl: model.cache_ttl } : {}),
    ...(model.openrouter_provider !== undefined && model.openrouter_provider !== null
      ? { openrouter_provider: model.openrouter_provider }
      : {}),
    ...(model.gemini_generation !== undefined
      ? { gemini_generation: model.gemini_generation }
      : {}),
    ...(model.zai_clear_thinking !== undefined
      ? { zai_clear_thinking: model.zai_clear_thinking }
      : {}),
  };

  return Object.keys(options).length === 0 ? undefined : options;
}

export interface BuildInputs {
  messages: WireMessage[];
  system?: SidecarRequest["system"];
  tools?: SidecarRequest["tools"];
  providerOptions?: ProviderOptions;
  replay: ThinkingReplay;
}

export function buildRequestWithResolvedKey(
  model: ResolvedModel,
  apiKey: string,
  inputs: BuildInputs,
): BuiltRequest {
  const transportError = nanogptTransportError(model.provider_key, model.sdk);
  if (transportError !== undefined) throw new Error(transportError);
  const request: SidecarRequest = {
    sdk: model.sdk,
    model: model.model_id,
    ...(model.supports_images === undefined ? {} : { supports_images: model.supports_images }),
    api_key: apiKey,
    ...(model.base_url !== undefined ? { base_url: model.base_url } : {}),
    messages: inputs.messages,
    ...(inputs.system !== undefined ? { system: inputs.system } : {}),
    ...(inputs.tools !== undefined ? { tools: inputs.tools } : {}),
    max_tokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.top_p !== undefined ? { top_p: model.top_p } : {}),
    ...(() => {
      const options = inputs.providerOptions ?? providerOptionsFor(model);
      return options === undefined ? {} : { provider_options: options };
    })(),
    provider_key: model.provider_key,
    replay_prior_thinking: inputs.replay,
  };

  const intervalMs = keepaliveIntervalMs(model.cache_keepalive);
  return {
    request,
    ...(intervalMs === undefined
      ? {}
      : { keepalive_interval_ms: intervalMs, keepalive_pings: model.cache_keepalive_pings ?? DEFAULT_KEEPALIVE_PINGS }),
  };
}

function keepaliveIntervalMs(setting: string | undefined): number | undefined {
  if (setting === undefined || setting === "off") return undefined;
  return parseDurationMs(setting);
}

function parseDurationMs(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(raw);
  if (m === null) return undefined;
  const value = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return undefined;
  }
}

export function buildRequest(
  model: ResolvedModel,
  inputs: BuildInputs,
  env: NodeJS.ProcessEnv = process.env,
): BuiltRequest {
  const apiKeyEnv = model.api_key_env ?? defaultApiKeyEnv(model.provider_key);
  const apiKey = readCandidateEnv({ name: "default", env: apiKeyEnv, warn_on_fallback: false }, env);
  if (apiKey === undefined) throw new MissingApiKey(apiKeyEnv);

  const built = buildRequestWithResolvedKey(model, apiKey, inputs);
  return { ...built, api_key_name: "default" };
}

export function buildRequestWithProviderKeys(
  model: ResolvedModel,
  entry: ProviderEntry | undefined,
  inputs: BuildInputs,
  env: NodeJS.ProcessEnv = process.env,
): BuiltRequest {
  if (isKeylessSdk(model.sdk)) {
    const built = buildRequestWithResolvedKey(model, "", inputs);
    return { ...built, api_key_name: KEYLESS_CANDIDATE.name };
  }

  const candidates = resolveKeyCandidates(model.provider_key, entry, model.api_key_env);

  if (candidates.length === 0) {
    throw new MissingApiKey(`provider '${model.provider_key}' has no enabled keys`);
  }

  let lastEnv = candidates[0]?.env ?? "";
  for (const candidate of candidates) {
    const apiKey = readCandidateEnv(candidate, env);
    if (apiKey !== undefined) {
      const built = buildRequestWithResolvedKey(model, apiKey, inputs);
      return { ...built, api_key_name: candidate.name };
    }
    lastEnv = candidate.env;
  }

  throw new MissingApiKey(lastEnv);
}

export function preprocessRequest(request: SidecarRequest): SidecarRequest {
  const cleaned = sanitizeToolPairs(request.messages);
  if (cleaned === undefined) return request;

  shoreLog.warn(
    `stripped orphan tool_use/tool_result blocks from outbound LLM request ` +
      `(${request.messages.length} messages -> ${cleaned.length})`,
  );
  return { ...request, messages: cleaned };
}

export function pushAssistantTurn(request: SidecarRequest, resp: GenerateResponse): void {
  let content: ContentBlock[];
  if (resp.content_blocks.length === 0) {
    if (rustTrim(resp.content) === "") return;
    content = [{ type: "text", text: resp.content }];
  } else {
    content = resp.content_blocks;
  }
  pushAssistantBlocks(request, content);
}

export function pushAssistantBlocks(request: SidecarRequest, content: ContentBlock[]): void {
  request.messages.push({
    role: "assistant",
    content,
    ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),
    model: request.model,
  });
}

export function pushInlineSystem(request: SidecarRequest, content: string): void {
  request.messages.push({ role: "system", content: [{ type: "text", text: content }] });
}
