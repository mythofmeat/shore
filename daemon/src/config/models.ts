import { shoreLog } from "../log.ts";

import { settingApplicability, validateSetting } from "../llm/settings.ts";
import type { DiscoveredModelSupport } from "../llm/discovery.ts";
import { SDK_VARIANTS, sdkFromWire, type Sdk } from "../llm/types.ts";
import { ConfigDuration, type ParseResult } from "./duration.ts";
import {
  parseCacheKeepalive,
  parseCacheKeepaliveMax,
  type CacheKeepaliveSetting,
} from "./keepalive.ts";
export {
  keepaliveIntervalMs,
  keepaliveToString,
  parseCacheKeepalive,
  parseCacheKeepaliveMax,
  type CacheKeepaliveSetting,
} from "./keepalive.ts";
import { compareByCodePoint, sortedKeys } from "../util/sort.ts";
import type { ThinkingReplay } from "../llm/types.ts";
import type { ResolvedModel as RequestResolvedModel } from "../llm/request.ts";
import {
  isZaiProvider,
  zaiBaseUrl,
  ZAI_API_PROVIDER,
  ZAI_SUB_PROVIDER,
  ZAI_SUBSCRIPTION_SETTING_MIGRATION,
} from "../llm/providers/zai_config.ts";

export type { Sdk };
export { SDK_VARIANTS, sdkFromWire };

function deserializeSdk(raw: string): ParseResult<Sdk> {
  if (raw === "zhipuai") {
    return { err: '`sdk = "zhipuai"` was removed — use `sdk = "openai"`' };
  }
  const sdk = sdkFromWire(raw);
  if (sdk === undefined) {
    const expected = SDK_VARIANTS.map((v) => `\`${v}\``).join(", ");
    return { err: `unknown variant \`${raw}\`, expected one of ${expected}` };
  }
  return { ok: sdk };
}

export function sdkEchoesUnsignedThinking(sdk: Sdk): boolean {
  return sdk === "openai" || sdk === "zai" || sdk === "deepseek" || sdk === "moonshot";
}

export function sdkUsesAnthropicPromptCache(sdk: Sdk): boolean {
  return sdk === "anthropic";
}

export interface ModelConfigFields {
  sdk?: Sdk;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
  budgetTokens?: number;
  cacheTtl?: string;
  cacheKeepalive?: CacheKeepaliveSetting;
  cacheKeepaliveMax?: ConfigDuration;
  openrouterProvider?: unknown;
  geminiGeneration?: number;
  zaiClearThinking?: boolean;
  supportsImages?: boolean;
}

const FIELD_KEYS = [
  "sdk",
  "apiKeyEnv",
  "baseUrl",
  "maxContextTokens",
  "maxOutputTokens",
  "temperature",
  "topP",
  "reasoningEffort",
  "budgetTokens",
  "cacheTtl",
  "cacheKeepalive",
  "cacheKeepaliveMax",
  "openrouterProvider",
  "geminiGeneration",
  "zaiClearThinking",
  "supportsImages",
] as const satisfies readonly (keyof ModelConfigFields)[];

export function mergeFrom(target: ModelConfigFields, overlay: ModelConfigFields): void {
  for (const key of FIELD_KEYS) {
    const value = overlay[key];
    if (value !== undefined) {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}

export function orFallback(
  self: ModelConfigFields,
  fallback: ModelConfigFields,
): ModelConfigFields {
  const out: ModelConfigFields = {};
  for (const key of FIELD_KEYS) {
    const value = self[key] ?? fallback[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export interface ProviderConfig {
  fields: ModelConfigFields;
}

export interface ModelEntry {
  modelId?: string;
  fields: ModelConfigFields;
}

export interface ResolvedModel {
  name: string;
  qualifiedName: string;
  category: string;
  providerKey: string;
  sdk: Sdk;
  modelId: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
  budgetTokens?: number;
  cacheTtl?: string;
  cacheKeepalive?: CacheKeepaliveSetting;
  cacheKeepaliveMax?: ConfigDuration;
  openrouterProvider?: unknown;
  geminiGeneration?: number;
  zaiClearThinking?: boolean;
  replayPriorThinking?: ThinkingReplay;
  maxToolIterations?: number;
  support?: DiscoveredModelSupport;
  discoveredSupportsImages?: boolean;
  supportsImages?: boolean;
}

export function resolvedReplayPriorThinking(
  model: ResolvedModel,
  globalDefault: ThinkingReplay,
): ThinkingReplay {
  return model.replayPriorThinking ?? globalDefault;
}

export function toRequestModel(model: ResolvedModel): RequestResolvedModel {
  return {
    name: model.name,
    qualified_name: model.qualifiedName,
    category: model.category,
    provider_key: model.providerKey,
    sdk: model.sdk,
    model_id: model.modelId,
    ...opt("api_key_env", model.apiKeyEnv),
    ...opt("base_url", model.baseUrl),
    ...opt("max_context_tokens", model.maxContextTokens),
    ...opt("max_output_tokens", model.maxOutputTokens),
    ...opt("temperature", model.temperature),
    ...opt("top_p", model.topP),
    ...opt("reasoning_effort", model.reasoningEffort),
    ...opt("budget_tokens", model.budgetTokens),
    ...opt("cache_ttl", model.cacheTtl),
    ...opt("cache_keepalive", keepaliveString(model.cacheKeepalive)),
    ...opt("cache_keepalive_max", model.cacheKeepaliveMax?.toString()),
    ...opt("openrouter_provider", model.openrouterProvider),
    ...opt("gemini_generation", model.geminiGeneration),
    ...opt("zai_clear_thinking", model.zaiClearThinking),
    ...opt("max_tool_iterations", model.maxToolIterations),
    ...opt("supports_images", effectiveSupportsImages(model)),
  };
}

export function effectiveSupportsImages(model: ResolvedModel): boolean | undefined {
  return model.supportsImages ?? model.discoveredSupportsImages;
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function keepaliveString(setting: CacheKeepaliveSetting | undefined): string | undefined {
  if (setting === undefined) return undefined;
  return setting.kind === "off" ? "off" : setting.interval.toString();
}

export function resolvedModelFromParts(
  name: string,
  qualifiedName: string,
  category: string,
  providerKey: string,
  modelId: string,
  sdkFallback: Sdk,
  fields: ModelConfigFields,
  support?: DiscoveredModelSupport,
  discoveredSupportsImages?: boolean,
): ResolvedModel {
  const merged: ModelConfigFields = { ...fields };

  const sdk: Sdk =
    merged.sdk ?? (modelId.startsWith("anthropic/") ? "anthropic" : sdkFallback);

  if (merged.cacheTtl === undefined) {
    if (sdk === "anthropic") merged.cacheTtl = "1h";
  }

  stripRejectedSampler(sdk, modelId, "temperature", merged, "temperature", undefined, support);
  stripRejectedSampler(sdk, modelId, "top_p", merged, "topP", undefined, support);
  stripRejectedSampler(sdk, modelId, "budget_tokens", merged, "budgetTokens", undefined, support);
  stripRejectedSampler(sdk, modelId, "reasoning_effort", merged, "reasoningEffort", undefined, support);

  warnIgnoredFields(sdk, modelId, merged, support);

  const resolved: ResolvedModel = {
    name,
    qualifiedName,
    category,
    providerKey,
    sdk,
    modelId,
  };
  assignIfPresent(resolved, "apiKeyEnv", merged.apiKeyEnv);
  assignIfPresent(resolved, "baseUrl", merged.baseUrl);
  assignIfPresent(resolved, "maxContextTokens", merged.maxContextTokens);
  assignIfPresent(resolved, "maxOutputTokens", merged.maxOutputTokens);
  assignIfPresent(resolved, "temperature", merged.temperature);
  assignIfPresent(resolved, "topP", merged.topP);
  assignIfPresent(resolved, "reasoningEffort", merged.reasoningEffort);
  assignIfPresent(resolved, "budgetTokens", merged.budgetTokens);
  assignIfPresent(resolved, "cacheTtl", merged.cacheTtl);
  assignIfPresent(resolved, "cacheKeepalive", merged.cacheKeepalive);
  assignIfPresent(resolved, "cacheKeepaliveMax", merged.cacheKeepaliveMax);
  assignIfPresent(resolved, "support", support);
  assignIfPresent(resolved, "discoveredSupportsImages", discoveredSupportsImages);
  assignIfPresent(resolved, "openrouterProvider", merged.openrouterProvider);
  assignIfPresent(resolved, "geminiGeneration", merged.geminiGeneration);
  assignIfPresent(resolved, "zaiClearThinking", merged.zaiClearThinking);
  assignIfPresent(resolved, "supportsImages", merged.supportsImages);
  return resolved;
}

function assignIfPresent<K extends keyof ResolvedModel>(
  target: ResolvedModel,
  key: K,
  value: ResolvedModel[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function stripRejectedSampler(
  sdk: Sdk,
  modelId: string,
  settingKey: string,
  fields: ModelConfigFields,
  key: "temperature" | "topP" | "budgetTokens" | "reasoningEffort",
  silentDefault: number | string | undefined,
  support: DiscoveredModelSupport | undefined,
): void {
  const value = fields[key];
  if (value === undefined) return;
  const rejected = settingApplicability(sdk, settingKey, support) === "rejected";
  const closedReasoning = settingKey === "reasoning_effort" &&
    validateSetting(sdk, settingKey, value, support) !== undefined;
  if (!rejected && !closedReasoning) return;
  if (fields[key] !== silentDefault) {
    shoreLog.warn(
      `shore: dropping \`${settingKey}\` for model ${modelId} (sdk ${sdk}): the ` +
        `provider reports that this model does not accept it`,
    );
  }
  delete fields[key];
}

function warnIgnoredFields(
  sdk: Sdk,
  modelId: string,
  fields: ModelConfigFields,
  support?: DiscoveredModelSupport,
): void {
  const checks: readonly [string, boolean][] = [
    ["cache_ttl", fields.cacheTtl !== undefined],
    ["openrouter_provider", fields.openrouterProvider !== undefined],
    ["gemini_generation", fields.geminiGeneration !== undefined],
    ["zai_clear_thinking", fields.zaiClearThinking !== undefined],
  ];
  for (const [field, present] of checks) {
    if (present && settingApplicability(sdk, field, support) === "ignored") {
      shoreLog.warn(
        `shore: ignoring \`${field}\` for model ${modelId}: the \`${sdk}\` sdk does not honor it`,
      );
    }
  }
}

export interface EmbeddingSettings {
  dimensions?: number;
}

export interface ImageGenSettings {
  size?: string;
  quality?: string;
  aspectRatio?: string;
  imageSize?: string;
}

export interface ModelCatalog {
  chat: Map<string, ResolvedModel>;
  embedding: Map<string, EmbeddingSettings>;
  imageGeneration: Map<string, ImageGenSettings>;
}

export function emptyCatalog(): ModelCatalog {
  return { chat: new Map(), embedding: new Map(), imageGeneration: new Map() };
}

export type CatalogErrorKind =
  | "missing_model_id"
  | "parse_entry"
  | "ambiguous_name"
  | "not_found"
  | "removed_provider"
  | "provider_scalar_retired"
  | "aux_profile_invalid";

export class CatalogError extends Error {
  constructor(
    readonly kind: CatalogErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }

  static missingModelId(category: string, provider: string, name: string): CatalogError {
    return new CatalogError(
      "missing_model_id",
      `model "${name}" in [${category}.${provider}] is missing required field \`model_id\``,
    );
  }

  static parseEntry(
    category: string,
    provider: string,
    name: string,
    source: string,
  ): CatalogError {
    return new CatalogError(
      "parse_entry",
      `failed to parse model entry [${category}.${provider}.${name}]: ${source}`,
    );
  }

  static ambiguousName(name: string, locations: string): CatalogError {
    return new CatalogError(
      "ambiguous_name",
      `ambiguous model name "${name}" — found in: ${locations}`,
    );
  }

  static notFound(name: string): CatalogError {
    return new CatalogError("not_found", `model "${name}" not found`);
  }

  static removedProvider(category: string): CatalogError {
    return new CatalogError(
      "removed_provider",
      `[${category}.claude_code] is no longer supported — the Claude Code transport ` +
        `was removed; drop this section from your config`,
    );
  }

  static providerScalarRetired(
    category: string,
    provider: string,
    key: string,
    target: string,
  ): CatalogError {
    return new CatalogError(
      "provider_scalar_retired",
      `[${category}.${provider}] no longer accepts provider-level scalar \`${key}\`; ` +
        `move it to ${target}`,
    );
  }

  static auxProfileInvalid(
    category: string,
    key: string,
    detail: string,
    example: string,
  ): CatalogError {
    return new CatalogError(
      "aux_profile_invalid",
      `[${category}.${JSON.stringify(key)}] is not a valid \`provider:model_id\` settings ` +
        `table: ${detail}. Identity is the key (e.g. ` +
        `\`[${category}."openai:${example}"]\`); put transport (sdk/base_url/api_key_env) on ` +
        `[providers.<provider>] and keep only category settings in the table`,
    );
  }
}

const TRANSPORT_SCALAR_KEYS = ["sdk", "api_key_env", "base_url", "keys"];

const RESERVED_DICT_KEYS = ["openrouter_provider"];

export interface ProviderRegistryView {
  get(name: string): ProviderRegistryEntry | undefined;
}

export interface ProviderRegistryEntry {
  sdk?: Sdk;
  baseUrl?: string;
  defaults: ModelConfigFields;
}

export function catalogFromSections(
  chat: Record<string, unknown> | undefined,
  embedding: Record<string, unknown> | undefined,
  imageGeneration: Record<string, unknown> | undefined,
  providers?: ProviderRegistryView,
): ModelCatalog {
  const chatModels =
    chat === undefined
      ? new Map<string, ResolvedModel>()
      : parseCategory("chat", chat, providers);

  const embeddingProfiles =
    embedding === undefined
      ? new Map<string, EmbeddingSettings>()
      : parseAuxSection("embedding", embedding, "text-embedding-3-large", readEmbeddingSettings);
  const imageGenProfiles =
    imageGeneration === undefined
      ? new Map<string, ImageGenSettings>()
      : parseAuxSection("image_generation", imageGeneration, "dall-e-3", readImageGenSettings);

  return { chat: chatModels, embedding: embeddingProfiles, imageGeneration: imageGenProfiles };
}

export function findModel(catalog: ModelCatalog, name: string): ResolvedModel {
  for (const model of catalog.chat.values()) {
    if (model.qualifiedName === name) return model;
  }

  const matches = [...catalog.chat.values()].filter((m) => m.name === name);
  if (matches.length === 0) throw CatalogError.notFound(name);
  if (matches.length === 1) return matches[0] as ResolvedModel;
  throw CatalogError.ambiguousName(name, matches.map((m) => m.qualifiedName).join(", "));
}

export const NO_CHAT_MODELS_MESSAGE =
  "No chat models configured. Add a [providers.*] entry and set " +
  "[defaults].model to a provider:model_id.";

export function firstChatModel(catalog: ModelCatalog): ResolvedModel | undefined {
  for (const model of catalog.chat.values()) return model;
  return undefined;
}

export function chatModelNames(catalog: ModelCatalog): string[] {
  return [...catalog.chat.keys()];
}

function parseCategory(
  category: string,
  section: Record<string, unknown>,
  providers: ProviderRegistryView | undefined,
): Map<string, ResolvedModel> {
  const models: [string, ResolvedModel][] = [];

  for (const providerKey of sortedKeys(section)) {
    if (providerKey === "claude_code") throw CatalogError.removedProvider(category);

    const providerValue = section[providerKey];
    if (!isTable(providerValue)) {
      shoreLog.warn(`shore: skipping non-table key "${providerKey}" in [${category}]`);
      continue;
    }

    for (const k of sortedKeys(providerValue)) {
      if (!isTable(providerValue[k]) || RESERVED_DICT_KEYS.includes(k)) {
        const target = TRANSPORT_SCALAR_KEYS.includes(k)
          ? "the matching [providers.<name>] entry"
          : "[providers.<name>.defaults]";
        throw CatalogError.providerScalarRetired(category, providerKey, k, target);
      }
    }

    const providerConfig = hardcodedProviderDefaults(providerKey);

    const entry = providers?.get(providerKey);
    if (entry !== undefined) {
      const registryOverlay: ModelConfigFields = {};
      if (entry.sdk !== undefined) registryOverlay.sdk = entry.sdk;
      if (entry.baseUrl !== undefined) registryOverlay.baseUrl = entry.baseUrl;
      mergeFrom(providerConfig.fields, registryOverlay);
      mergeFrom(providerConfig.fields, entry.defaults);
    }

    for (const modelName of sortedKeys(providerValue)) {
      const modelValue = providerValue[modelName];
      if (!isTable(modelValue) || RESERVED_DICT_KEYS.includes(modelName)) continue;

      const parsed = readModelEntry(modelValue);
      if ("err" in parsed) {
        throw CatalogError.parseEntry(category, providerKey, modelName, parsed.err);
      }
      const modelId = parsed.ok.modelId;
      if (modelId === undefined) {
        throw CatalogError.missingModelId(category, providerKey, modelName);
      }

      const qualified = `${category}.${providerKey}.${modelName}`;
      const merged = orFallback(parsed.ok.fields, providerConfig.fields);
      models.push([
        qualified,
        resolvedModelFromParts(
          modelName,
          qualified,
          category,
          providerKey,
          modelId,
          defaultSdk(providerKey),
          merged,
        ),
      ]);
    }
  }

  if (models.length > 0) {
    shoreLog.warn(
      `shore: \`[${category}.*]\` is deprecated and will be removed: define models via ` +
        `\`[providers.<provider>]\` and select them as \`provider:model_id\`; set ` +
        `per-provider overrides under \`[providers.<provider>.defaults]\` and per-model ` +
        `ones with \`shore model setting\`. The static entries are still honored this ` +
        `release.`,
    );
  }

  return new Map(models.sort((a, b) => compareByCodePoint(a[0], b[0])));
}

function parseAuxSection<T>(
  category: string,
  section: Record<string, unknown>,
  example: string,
  read: (table: Record<string, unknown>) => ParseResult<T>,
): Map<string, T> {
  const out: [string, T][] = [];
  for (const key of sortedKeys(section)) {
    const colon = key.indexOf(":");
    if (colon < 0) {
      throw CatalogError.auxProfileInvalid(
        category,
        key,
        "the key must be a `provider:model_id` identity, not a bare alias",
        example,
      );
    }
    if (colon === 0 || colon === key.length - 1) {
      throw CatalogError.auxProfileInvalid(
        category,
        key,
        "both the provider and model_id halves of the `provider:model_id` key must be non-empty",
        example,
      );
    }

    const value = section[key];
    if (!isTable(value)) {
      throw CatalogError.auxProfileInvalid(
        category,
        key,
        "the value must be a settings table",
        example,
      );
    }

    const settings = read(value);
    if ("err" in settings) {
      throw CatalogError.auxProfileInvalid(category, key, settings.err, example);
    }
    out.push([key, settings.ok]);
  }
  return new Map(out.sort((a, b) => compareByCodePoint(a[0], b[0])));
}

function baseProviderDefaults(): ModelConfigFields {
  return { maxOutputTokens: 32768, maxContextTokens: 200_000 };
}

export function hardcodedProviderDefaults(providerKey: string): ProviderConfig {
  const base = baseProviderDefaults();
  switch (providerKey) {
    case "anthropic":
      return { fields: { ...base, sdk: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } };
    case "openrouter":
      return {
        fields: {
          ...base,
          sdk: "openrouter",
          apiKeyEnv: "OPENROUTER_API_KEY",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      };
    case "deepseek":
      return {
        fields: {
          ...base,
          sdk: "deepseek",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          baseUrl: "https://api.deepseek.com/v1",
        },
      };
    case "moonshot":
    case "moonshotai":
      return {
        fields: {
          ...base,
          sdk: "moonshot",
          apiKeyEnv: "MOONSHOT_API_KEY",
          baseUrl: "https://api.moonshot.ai/v1",
        },
      };
    case "gemini":
      return { fields: { ...base, sdk: "gemini", apiKeyEnv: "GEMINI_API_KEY" } };
    case "xai":
      return {
        fields: {
          ...base,
          sdk: "openai",
          apiKeyEnv: "XAI_API_KEY",
          baseUrl: "https://api.x.ai/v1",
        },
      };
    case "zhipuai":
      return {
        fields: {
          ...base,
          sdk: "openai",
          apiKeyEnv: "ZAI_API_KEY",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        },
      };
    case ZAI_API_PROVIDER:
    case ZAI_SUB_PROVIDER:
      return {
        fields: {
          ...base,
          sdk: "zai",
          apiKeyEnv: "ZAI_API_KEY",
          baseUrl: zaiBaseUrl(providerKey),
          zaiClearThinking: false,
        },
      };
    case "nanogpt":
      return {
        fields: {
          ...base,
          sdk: "openai",
          apiKeyEnv: "NANOGPT_API_KEY",
          baseUrl: "https://nano-gpt.com/api/v1",
        },
      };
    case "opencode-go":
      return {
        fields: {
          ...base,
          apiKeyEnv: "OPENCODE_API_KEY",
          baseUrl: "https://opencode.ai/zen/go/v1",
        },
      };
    default:
      return { fields: {} };
  }
}

export function defaultSdk(providerKey: string): Sdk {
  switch (providerKey) {
    case "anthropic":
      return "anthropic";
    case "openrouter":
      return "openrouter";
    case "gemini":
      return "gemini";
    case "deepseek":
      return "deepseek";
    case "moonshot":
    case "moonshotai":
      return "moonshot";
    default:
      return isZaiProvider(providerKey) ? "zai" : "openai";
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlTypeName(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "floating point";
  if (Array.isArray(value)) return "sequence";
  if (isTable(value)) return "map";
  return "unit";
}

function tomlValueRepr(value: unknown): string | undefined {
  if (Array.isArray(value) || isTable(value)) return undefined;
  return typeof value === "string" ? `"${value}"` : `\`${String(value)}\``;
}

export function invalidType(value: unknown, expected: string): string {
  const repr = tomlValueRepr(value);
  const got = repr === undefined ? tomlTypeName(value) : `${tomlTypeName(value)} ${repr}`;
  return `invalid type: ${got}, expected ${expected}`;
}

function readString(table: Record<string, unknown>, key: string): ParseResult<string | undefined> {
  const value = table[key];
  if (value === undefined) return { ok: undefined };
  if (typeof value !== "string") return { err: invalidType(value, "a string") };
  return { ok: value };
}

function readBool(table: Record<string, unknown>, key: string): ParseResult<boolean | undefined> {
  const value = table[key];
  if (value === undefined) return { ok: undefined };
  if (typeof value !== "boolean") return { err: invalidType(value, "a boolean") };
  return { ok: value };
}

function readU32(table: Record<string, unknown>, key: string): ParseResult<number | undefined> {
  const value = table[key];
  if (value === undefined) return { ok: undefined };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { err: invalidType(value, "u32") };
  }
  if (value < 0 || value > 0xffff_ffff) {
    return { err: `invalid value: integer \`${value}\`, expected u32` };
  }
  return { ok: value };
}

function readF64(table: Record<string, unknown>, key: string): ParseResult<number | undefined> {
  const value = table[key];
  if (value === undefined) return { ok: undefined };
  if (typeof value !== "number") return { err: invalidType(value, "a float") };
  return { ok: value };
}

export function readModelConfigFields(table: Record<string, unknown>): ParseResult<ModelConfigFields> {
  if (Object.hasOwn(table, "zai_subscription")) {
    return { err: ZAI_SUBSCRIPTION_SETTING_MIGRATION };
  }
  const out: ModelConfigFields = {};

  const sdkRaw = readString(table, "sdk");
  if ("err" in sdkRaw) return sdkRaw;
  if (sdkRaw.ok !== undefined) {
    const sdk = deserializeSdk(sdkRaw.ok);
    if ("err" in sdk) return sdk;
    out.sdk = sdk.ok;
  }

  const strings: [keyof ModelConfigFields, string][] = [
    ["apiKeyEnv", "api_key_env"],
    ["baseUrl", "base_url"],
    ["reasoningEffort", "reasoning_effort"],
    ["cacheTtl", "cache_ttl"],
  ];
  for (const [field, key] of strings) {
    const read = readString(table, key);
    if ("err" in read) return read;
    if (read.ok !== undefined) (out as Record<string, unknown>)[field] = read.ok;
  }

  const u32s: [keyof ModelConfigFields, string][] = [
    ["maxContextTokens", "max_context_tokens"],
    ["maxOutputTokens", "max_output_tokens"],
    ["budgetTokens", "budget_tokens"],
    ["geminiGeneration", "gemini_generation"],
  ];
  for (const [field, key] of u32s) {
    const read = readU32(table, key);
    if ("err" in read) return read;
    if (read.ok !== undefined) (out as Record<string, unknown>)[field] = read.ok;
  }

  const floats: [keyof ModelConfigFields, string][] = [
    ["temperature", "temperature"],
    ["topP", "top_p"],
  ];
  for (const [field, key] of floats) {
    const read = readF64(table, key);
    if ("err" in read) return read;
    if (read.ok !== undefined) (out as Record<string, unknown>)[field] = read.ok;
  }

  const bools: [keyof ModelConfigFields, string][] = [
    ["zaiClearThinking", "zai_clear_thinking"],
    ["supportsImages", "supports_images"],
  ];
  for (const [field, key] of bools) {
    const read = readBool(table, key);
    if ("err" in read) return read;
    if (read.ok !== undefined) (out as Record<string, unknown>)[field] = read.ok;
  }

  const keepaliveRaw = readString(table, "cache_keepalive");
  if ("err" in keepaliveRaw) return keepaliveRaw;
  if (keepaliveRaw.ok !== undefined) {
    const keepalive = parseCacheKeepalive(keepaliveRaw.ok);
    if ("err" in keepalive) return keepalive;
    out.cacheKeepalive = keepalive.ok;
  }

  const keepaliveMaxRaw = readString(table, "cache_keepalive_max");
  if ("err" in keepaliveMaxRaw) return keepaliveMaxRaw;
  if (keepaliveMaxRaw.ok !== undefined) {
    const max = parseCacheKeepaliveMax(keepaliveMaxRaw.ok);
    if ("err" in max) return max;
    out.cacheKeepaliveMax = max.ok;
  }

  if (table["openrouter_provider"] !== undefined) {
    out.openrouterProvider = table["openrouter_provider"];
  }

  return { ok: out };
}

function readModelEntry(table: Record<string, unknown>): ParseResult<ModelEntry> {
  const modelId = readString(table, "model_id");
  if ("err" in modelId) return modelId;
  const fields = readModelConfigFields(table);
  if ("err" in fields) return fields;
  const entry: ModelEntry = { fields: fields.ok };
  if (modelId.ok !== undefined) entry.modelId = modelId.ok;
  return { ok: entry };
}

function denyUnknown(table: Record<string, unknown>, known: readonly string[]): string | undefined {
  for (const key of sortedKeys(table)) {
    if (!known.includes(key)) {
      return `unknown field \`${key}\`, expected ${expectedList(known)}`;
    }
  }
  return undefined;
}

function expectedList(known: readonly string[]): string {
  if (known.length === 0) return "no fields";
  if (known.length === 1) return `\`${known[0]}\``;
  const head = known.slice(0, -1).map((k) => `\`${k}\``).join(", ");
  return `one of ${head}, \`${known[known.length - 1]}\``;
}

const EMBEDDING_KEYS = ["dimensions"];

function readEmbeddingSettings(table: Record<string, unknown>): ParseResult<EmbeddingSettings> {
  const unknown = denyUnknown(table, EMBEDDING_KEYS);
  if (unknown !== undefined) return { err: unknown };
  const dimensions = readU32(table, "dimensions");
  if ("err" in dimensions) return dimensions;
  const out: EmbeddingSettings = {};
  if (dimensions.ok !== undefined) out.dimensions = dimensions.ok;
  return { ok: out };
}

const IMAGE_GEN_KEYS = ["size", "quality", "aspect_ratio", "image_size"];

function readImageGenSettings(table: Record<string, unknown>): ParseResult<ImageGenSettings> {
  const unknown = denyUnknown(table, IMAGE_GEN_KEYS);
  if (unknown !== undefined) return { err: unknown };
  const out: ImageGenSettings = {};
  const pairs: [keyof ImageGenSettings, string][] = [
    ["size", "size"],
    ["quality", "quality"],
    ["aspectRatio", "aspect_ratio"],
    ["imageSize", "image_size"],
  ];
  for (const [field, key] of pairs) {
    const read = readString(table, key);
    if ("err" in read) return read;
    if (read.ok !== undefined) (out as Record<string, unknown>)[field] = read.ok;
  }
  return { ok: out };
}

export function resolvedModelToWire(model: ResolvedModel): Record<string, unknown> {
  const or = <T>(v: T | undefined): T | null => v ?? null;
  return {
    name: model.name,
    qualified_name: model.qualifiedName,
    category: model.category,
    provider_key: model.providerKey,
    sdk: model.sdk,
    model_id: model.modelId,
    api_key_env: or(model.apiKeyEnv),
    base_url: or(model.baseUrl),
    max_context_tokens: or(model.maxContextTokens),
    max_output_tokens: or(model.maxOutputTokens),
    temperature: or(model.temperature),
    top_p: or(model.topP),
    reasoning_effort: or(model.reasoningEffort),
    budget_tokens: or(model.budgetTokens),
    cache_ttl: or(model.cacheTtl),
    cache_keepalive: or(keepaliveString(model.cacheKeepalive)),
    cache_keepalive_max: or(model.cacheKeepaliveMax?.toString()),
    openrouter_provider: or(model.openrouterProvider),
    gemini_generation: or(model.geminiGeneration),
    zai_clear_thinking: or(model.zaiClearThinking),
    replay_prior_thinking: or(model.replayPriorThinking),
    max_tool_iterations: or(model.maxToolIterations),
    supports_images: or(effectiveSupportsImages(model)),
  };
}
