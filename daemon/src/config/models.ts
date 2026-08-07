/**
 * The model catalog: the nested `[chat.<provider>.<model>]` structure, the
 * cascade that resolves it, and the hardcoded provider defaults underneath.
 *
 * Port of `crates/common/src/config/models.rs`.
 *
 * This is the first module on the TypeScript side to own *configuration*
 * rather than receive it. Everything ported before it took a narrow view
 * struct handed down by the Rust daemon, because the Rust daemon owned config.
 * `preferences` and `effective_catalog` are the resolution layer themselves, so
 * there is nobody upstream left to hand them a view — the parsing has to live
 * here.
 */

import { applicability, defaultValue, type Field, type Sdk } from "../llm/capabilities.ts";
import { ConfigDuration, type ParseResult } from "./duration.ts";
import { compareByCodePoint, sortedKeys } from "../sort.ts";
import type { ThinkingReplay } from "../llm/types.ts";
import type { ResolvedModel as RequestResolvedModel } from "../llm/request.ts";

export type { Sdk };

// ── Cache keepalive cadence ─────────────────────────────────────────────

/**
 * Per-model cache-keepalive cadence (`cache_keepalive` in `[models.*]`).
 *
 * `"off"` disables keepalive pings; any duration string sets the interval
 * between pings while the character is idle. The duration is a *literal* ping
 * interval — it is not derived from the provider's cache TTL, and is
 * deliberately independent of the Anthropic-only `cache_ttl` wire setting.
 */
export type CacheKeepaliveSetting =
  | { kind: "off" }
  | { kind: "every"; interval: ConfigDuration };

const KEEPALIVE_OFF_SPELLINGS = ["off", "none", "disabled", "false", "0"];

/**
 * Parse from a TOML string: `off`/`none`/`disabled`/`false`/`0` disable it,
 * any non-zero duration string sets the interval.
 *
 * A zero-length interval (`"0s"`, `"0ms"`) is rejected: it would re-arm the
 * timer at `now` on every tick and spin a ping loop. Use `"off"` to disable.
 */
export function parseCacheKeepalive(raw: string): ParseResult<CacheKeepaliveSetting> {
  const trimmed = raw.trim();
  if (KEEPALIVE_OFF_SPELLINGS.includes(asciiLowercase(trimmed))) return { ok: { kind: "off" } };

  const interval = ConfigDuration.parse(trimmed);
  if ("err" in interval) return interval;
  if (interval.ok.asMillisExact() === 0n) {
    return { err: 'cache_keepalive interval must be > 0; use "off" to disable' };
  }
  return { ok: { kind: "every", interval: interval.ok } };
}

/** The resolved ping interval in milliseconds, or `undefined` when off. */
export function keepaliveIntervalMs(setting: CacheKeepaliveSetting): number | undefined {
  return setting.kind === "off" ? undefined : setting.interval.asMillis();
}

/** The TOML spelling — `"off"` or the duration's canonical form. */
export function keepaliveToString(setting: CacheKeepaliveSetting): string {
  return setting.kind === "off" ? "off" : setting.interval.toString();
}

export function keepaliveEquals(a: CacheKeepaliveSetting, b: CacheKeepaliveSetting): boolean {
  if (a.kind === "off" || b.kind === "off") return a.kind === b.kind;
  return a.interval.equals(b.interval);
}

/**
 * `to_ascii_lowercase`, not `toLowerCase`.
 *
 * No current input distinguishes the two: every off spelling is pure ASCII, so
 * for a full-Unicode fold to reach one, the input would already have to be
 * ASCII. This is a guarantee about the *next* spelling rather than a live
 * behavioural difference — add a non-ASCII one (or one containing `k`, which
 * the Kelvin sign U+212A folds into) and the two rules diverge immediately.
 */
function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// ── SDK ─────────────────────────────────────────────────────────────────

const SDK_VARIANTS: readonly Sdk[] = [
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "zai",
  "deepseek",
  "moonshot",
];

/**
 * Parse a wire-protocol string into an `Sdk`, or `undefined` for unknown
 * strings — the caller decides whether to fall back or error.
 *
 * `moonshotai` is an accepted alias for `moonshot`. Note this is *not* the
 * config deserializer: {@link deserializeSdk} additionally accepts the
 * deprecated `zhipuai` and reports unknown variants as an error.
 */
export function sdkFromWire(s: string): Sdk | undefined {
  if (s === "moonshotai") return "moonshot";
  return (SDK_VARIANTS as readonly string[]).includes(s) ? (s as Sdk) : undefined;
}

/** The config-file spelling, which tolerates one deprecated alias. */
function deserializeSdk(raw: string): ParseResult<Sdk> {
  if (raw === "zhipuai") {
    console.warn(
      `sdk = "${raw}" is deprecated and now maps to "openai". ` +
        `Update your config to use sdk = "openai" instead.`,
    );
    return { ok: "openai" };
  }
  const sdk = sdkFromWire(raw);
  if (sdk === undefined) {
    const expected = SDK_VARIANTS.map((v) => `\`${v}\``).join(", ");
    return { err: `unknown variant \`${raw}\`, expected one of ${expected}` };
  }
  return { ok: sdk };
}

/**
 * Whether this SDK's wire protocol requires the daemon to echo **unsigned**
 * reasoning text back to the provider on the next request.
 *
 * Anthropic signs its thinking blocks and rejects requests carrying unsigned
 * reasoning text from a prior turn; OpenAI and Z.AI expect the assistant's
 * prior `reasoning_content` to round-trip verbatim, and DeepSeek/Moonshot hard
 * require it during a tool loop. Gemini does not accept reasoning replay.
 */
export function sdkEchoesUnsignedThinking(sdk: Sdk): boolean {
  return sdk === "openai" || sdk === "zai" || sdk === "deepseek" || sdk === "moonshot";
}

/**
 * Whether requests for this SDK ultimately hit Anthropic's prompt-cache
 * machinery — so a background task reusing the chat-warmed prefix has to
 * preserve `request.system` verbatim and attach trailing instructions as an
 * inline `role:"system"` entry instead.
 */
export function sdkUsesAnthropicPromptCache(sdk: Sdk): boolean {
  return sdk === "anthropic";
}

// ── Shared model config fields ──────────────────────────────────────────

/**
 * The configuration fields shared by provider configs, model entries and
 * resolved models. Every field is optional — absent means "inherit from the
 * next level up" (model → provider → hardcoded defaults).
 *
 * The first three — `sdk` / `apiKeyEnv` / `baseUrl` — are **transport**, not
 * behavioral overlay. Transport has a single authoritative home, the
 * `[providers.<name>]` registry entry; these survive here only for the legacy
 * static `ModelEntry` path and for {@link ResolvedModel}, where they hold
 * *resolved* transport. Don't reintroduce them as an overlay knob.
 */
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
  openrouterProvider?: unknown;
  geminiGeneration?: number;
  zaiClearThinking?: boolean;
  zaiSubscription?: boolean;
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
  "openrouterProvider",
  "geminiGeneration",
  "zaiClearThinking",
  "zaiSubscription",
] as const satisfies readonly (keyof ModelConfigFields)[];

/** Overwrite `target`'s fields with any present field from `overlay`. */
export function mergeFrom(target: ModelConfigFields, overlay: ModelConfigFields): void {
  for (const key of FIELD_KEYS) {
    const value = overlay[key];
    if (value !== undefined) {
      // Each key indexes the same property on both sides, but TypeScript
      // widens `overlay[key]` to the union of every field type across the
      // loop, so the per-key correspondence has to be asserted.
      (target as Record<string, unknown>)[key] = value;
    }
  }
}

/** A new set of fields taking each value from `self` if present, else `fallback`. */
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

/** Provider-level configuration — the scalar keys under `[chat.<provider>]`. */
export interface ProviderConfig {
  fields: ModelConfigFields;
}

/** Per-model configuration — sub-tables under `[chat.<provider>.<model>]`. */
export interface ModelEntry {
  /** The upstream model identifier (e.g. `claude-opus-4-6`). Required. */
  modelId?: string;
  fields: ModelConfigFields;
}

// ── Resolved model ──────────────────────────────────────────────────────

/** A fully resolved model profile with all provider defaults merged in. */
export interface ResolvedModel {
  /** Short name — the TOML key under the provider (e.g. `opus`). */
  name: string;
  /** Qualified path (e.g. `chat.anthropic.opus`). */
  qualifiedName: string;
  /** Category: `chat`, `tools`, … */
  category: string;
  /** Provider key (e.g. `anthropic`, `openrouter`). */
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
  openrouterProvider?: unknown;
  geminiGeneration?: number;
  zaiClearThinking?: boolean;
  zaiSubscription?: boolean;
  /**
   * Per-model override for preserving prior-turn extended-thinking blocks.
   * Absent means "inherit the global `[memory.thinking].replay_prior_thinking`".
   * Not sourced from the static catalog — stamped here by the runtime
   * preference overlay. The quality effect is model-dependent, so there is no
   * opinionated default.
   */
  replayPriorThinking?: ThinkingReplay;
  /**
   * Maximum tool-loop iterations per turn, governing every agentic tool loop.
   * Absent means **unlimited** — the loop runs until the model stops requesting
   * tools. Like `replayPriorThinking`, stamped by the runtime overlay rather
   * than the static catalog.
   */
  maxToolIterations?: number;
}

/**
 * Prior-thinking replay for this model: the per-model overlay when set,
 * otherwise the global `[memory.thinking]` default.
 *
 * The one place the two-level fallback is resolved, so a caller cannot
 * silently ship the global default to a model that overrode it.
 */
export function resolvedReplayPriorThinking(
  model: ResolvedModel,
  globalDefault: ThinkingReplay,
): ThinkingReplay {
  return model.replayPriorThinking ?? globalDefault;
}

/**
 * The same model in the shape `llm/request.ts` reads.
 *
 * Rust has one `ResolvedModel`. Here there are two, because the request builder
 * was ported against the sidecar's snake_case wire mirror months before the
 * catalog itself moved and grew this camelCase one. They describe the same
 * struct and the split is a port artefact rather than a design — but collapsing
 * them touches every adapter, so until that happens the conversion lives here,
 * in the module that owns the catalog spelling, and nowhere else. Do not
 * open-code it at a call site.
 *
 * Two fields are not a rename. `cacheKeepalive` is parsed here and stringly
 * over there, so it goes back through {@link ConfigDuration.toString}, which is
 * documented to round-trip through `parse` — the request builder re-parses it
 * immediately. `replayPriorThinking` and `maxToolIterations` have no
 * counterpart at all: the builder takes the replay policy as an explicit
 * argument, and nothing about a tool loop reaches a single request.
 */
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
    ...opt("openrouter_provider", model.openrouterProvider),
    ...opt("gemini_generation", model.geminiGeneration),
    ...opt("zai_clear_thinking", model.zaiClearThinking),
    ...opt("zai_subscription", model.zaiSubscription),
    ...opt("max_tool_iterations", model.maxToolIterations),
  };
}

/** `exactOptionalPropertyTypes` means an absent field and a `undefined` one are
 * different types, so an absent one has to be spread in rather than assigned. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function keepaliveString(setting: CacheKeepaliveSetting | undefined): string | undefined {
  if (setting === undefined) return undefined;
  return setting.kind === "off" ? "off" : setting.interval.toString();
}

/**
 * Build a `ResolvedModel` from metadata plus merged config fields.
 * `sdkFallback` is used when `fields.sdk` is absent.
 */
export function resolvedModelFromParts(
  name: string,
  qualifiedName: string,
  category: string,
  providerKey: string,
  modelId: string,
  sdkFallback: Sdk,
  fields: ModelConfigFields,
): ResolvedModel {
  const merged: ModelConfigFields = { ...fields };

  // Anthropic-slug auto-promotion: OpenRouter and similar gateways accept
  // Anthropic-shape `/v1/messages` for `anthropic/*` models, and the Anthropic
  // SDK is the only path that emits `cache_control`. If the user didn't pin an
  // SDK, route any `anthropic/*` model_id through the Anthropic SDK so caching
  // works by default.
  const sdk: Sdk =
    merged.sdk ?? (modelId.startsWith("anthropic/") ? "anthropic" : sdkFallback);

  // Anthropic prompt caching is opt-in on the wire — `cache_control` blocks
  // are only added when `cache_ttl` is present and non-empty. Fill only when
  // unset so user/provider config wins (set `cache_ttl = ""` to disable).
  if (merged.cacheTtl === undefined) {
    const fallbackTtl = defaultValue(sdk, "cache_ttl");
    if (fallbackTtl !== undefined) merged.cacheTtl = fallbackTtl;
  }

  // The keepalive cadence default is also sdk-keyed. Fill only when unset so
  // an explicit `cache_keepalive = "off"` (or any interval) wins. Separate
  // from `cache_ttl`: keepalive can run on any provider with a cache, but is
  // opt-in everywhere except Anthropic.
  if (merged.cacheKeepalive === undefined) {
    const raw = defaultValue(sdk, "cache_keepalive");
    if (raw !== undefined) {
      const parsed = parseCacheKeepalive(raw);
      // `.ok()` in the Rust: an unparseable baked-in default leaves the field
      // unset rather than failing the catalog.
      if ("ok" in parsed) merged.cacheKeepalive = parsed.ok;
    }
  }

  // Drop sampler knobs the model's wire rejects so a baked-in default never
  // 400s. The `temperature = 1.0` baseline from the provider defaults is
  // dropped silently; an explicit non-default value is dropped with a warning.
  // `top_p` and `budget_tokens` have no code default, so any present value is
  // user-set and warns.
  stripRejectedSampler(sdk, modelId, "temperature", merged, "temperature", 1.0);
  stripRejectedSampler(sdk, modelId, "top_p", merged, "topP", undefined);
  stripRejectedSampler(sdk, modelId, "budget_tokens", merged, "budgetTokens", undefined);

  warnIgnoredFields(sdk, modelId, merged);

  const resolved: ResolvedModel = {
    name,
    qualifiedName,
    category,
    providerKey,
    sdk,
    modelId,
  };
  // `exactOptionalPropertyTypes` is on, so an absent field has to stay absent
  // rather than becoming an explicit `undefined` — `"cacheTtl" in model` is
  // observable, and the Rust distinguishes `None` from a set value.
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
  assignIfPresent(resolved, "openrouterProvider", merged.openrouterProvider);
  assignIfPresent(resolved, "geminiGeneration", merged.geminiGeneration);
  assignIfPresent(resolved, "zaiClearThinking", merged.zaiClearThinking);
  assignIfPresent(resolved, "zaiSubscription", merged.zaiSubscription);
  // `replayPriorThinking` and `maxToolIterations` are deliberately left unset:
  // the static catalog has no such fields, and the runtime preference overlay
  // stamps them later. Absent means "inherit the global default" and
  // "unlimited" respectively.
  return resolved;
}

function assignIfPresent<K extends keyof ResolvedModel>(
  target: ResolvedModel,
  key: K,
  value: ResolvedModel[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Drop a sampler field the resolved `(sdk, modelId)` wire rejects. A value
 * equal to `silentDefault` (the baked-in code default) goes quietly; any other
 * present value is dropped with a warning, since sending it would be a 400.
 */
function stripRejectedSampler(
  sdk: Sdk,
  modelId: string,
  field: Field,
  fields: ModelConfigFields,
  key: "temperature" | "topP" | "budgetTokens",
  silentDefault: number | undefined,
): void {
  if (fields[key] === undefined) return;
  if (applicability(sdk, modelId, field) !== "rejected") return;
  if (fields[key] !== silentDefault) {
    console.warn(
      `shore: dropping \`${field}\` for model ${modelId} (sdk ${sdk}): the ` +
        `\`${modelId}\` wire rejects it (Claude >=4.7 cutoff or per-model ` +
        `OpenRouter override)`,
    );
  }
  delete fields[key];
}

/**
 * Warn about — but keep — every present field the resolved sdk silently
 * ignores. Harmless on the wire, but a likely misconfiguration worth surfacing
 * (e.g. `cache_ttl` on a non-Anthropic sdk).
 */
function warnIgnoredFields(sdk: Sdk, modelId: string, fields: ModelConfigFields): void {
  const checks: readonly [Field, boolean][] = [
    ["cache_ttl", fields.cacheTtl !== undefined],
    ["openrouter_provider", fields.openrouterProvider !== undefined],
    ["gemini_generation", fields.geminiGeneration !== undefined],
    ["zai_clear_thinking", fields.zaiClearThinking !== undefined],
    ["zai_subscription", fields.zaiSubscription !== undefined],
  ];
  for (const [field, present] of checks) {
    if (present && applicability(sdk, modelId, field) === "ignored") {
      console.warn(
        `shore: ignoring \`${field}\` for model ${modelId}: the \`${sdk}\` sdk does not honor it`,
      );
    }
  }
}

// ── Auxiliary model categories ──────────────────────────────────────────

/**
 * Per-model settings for an `[embedding."provider:model_id"]` table.
 *
 * Identity (`provider:model_id`) is the map key; transport comes from
 * `[providers.<provider>]`. Unknown keys are rejected so leftover inline
 * transport from the retired flat shape fails loudly.
 */
export interface EmbeddingSettings {
  /** Embedding vector dimensions. Absent falls back to the resolver default. */
  dimensions?: number;
}

/** Per-model settings for an `[image_generation."provider:model_id"]` table. */
export interface ImageGenSettings {
  /** Default size for the OpenAI path (e.g. `1024x1024`). */
  size?: string;
  /** Optional quality hint for the OpenAI path (e.g. `hd`). */
  quality?: string;
  /** OpenRouter aspect ratio (e.g. `1:1`, `16:9`). */
  aspectRatio?: string;
  /** OpenRouter image size (e.g. `1K`, `2K`, `4K`). */
  imageSize?: string;
}

// ── Model catalog ───────────────────────────────────────────────────────

/**
 * The parsed model catalog.
 *
 * Every map is in Rust `BTreeMap` order — code-point sorted by key, not
 * insertion order. `firstChatModel` reads the first entry, so the order is
 * load-bearing, not cosmetic.
 */
export interface ModelCatalog {
  /** Chat models keyed by qualified name. */
  chat: Map<string, ResolvedModel>;
  /** Embedding settings keyed by `provider:model_id`. */
  embedding: Map<string, EmbeddingSettings>;
  /** Image-generation settings keyed by `provider:model_id`. */
  imageGeneration: Map<string, ImageGenSettings>;
}

export function emptyCatalog(): ModelCatalog {
  return { chat: new Map(), embedding: new Map(), imageGeneration: new Map() };
}

/** Every variant of a catalog parse or lookup failure. */
export type CatalogErrorKind =
  | "missing_model_id"
  | "parse_entry"
  | "ambiguous_name"
  | "not_found"
  | "removed_provider"
  | "provider_scalar_retired"
  | "aux_profile_invalid";

/** Errors from model catalog parsing and lookup. */
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

/**
 * Transport keys that belong on the `[providers.<name>]` entry itself rather
 * than its `[.defaults]` behavioral bag.
 */
const TRANSPORT_SCALAR_KEYS = ["sdk", "api_key_env", "base_url", "keys"];

/**
 * Dict-valued TOML keys at the provider level that are config fields, NOT
 * model sub-tables.
 */
const RESERVED_DICT_KEYS = ["openrouter_provider"];

/**
 * The slice of the `[providers.*]` registry the catalog cascade needs.
 *
 * Declared as an interface rather than imported so this module does not depend
 * on the registry's own parsing; `providers.ts` supplies the implementation.
 */
export interface ProviderRegistryView {
  get(name: string): ProviderRegistryEntry | undefined;
}

export interface ProviderRegistryEntry {
  sdk?: Sdk;
  baseUrl?: string;
  defaults: ModelConfigFields;
}

/**
 * Build a catalog from the raw TOML sections, optionally letting the
 * `[providers.<name>]` registry cascade transport defaults into static model
 * entries.
 *
 * With a registry, each `[chat.<name>]` entry inherits its `sdk` and
 * `base_url` as defaults — lower precedence than per-model fields, higher than
 * the hardcoded provider defaults. This lets a custom OpenAI-compatible
 * provider configured solely under `[providers.<name>]` route its static
 * aliases through the right transport without duplicating fields.
 */
export function catalogFromSections(
  chat: Record<string, unknown> | undefined,
  embedding: Record<string, unknown> | undefined,
  imageGeneration: Record<string, unknown> | undefined,
  providers?: ProviderRegistryView,
): ModelCatalog {
  const chatModels = chat === undefined ? new Map() : parseCategory("chat", chat, providers);

  // Embedding and image_generation are keyed by `provider:model_id`; identity
  // is the key, transport resolves through `[providers.*]`, and the table body
  // holds only category settings. The old flat shape (bare alias key with
  // inline transport) is rejected here.
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

/**
 * Look up a model by short name or qualified name.
 *
 * Qualified names (`chat.anthropic.opus`) are tried first. Short names
 * (`opus`) search across all providers and error on ambiguity.
 *
 * Both miss paths throw a `CatalogError` and neither warns: this lookup is
 * also used as a speculative probe, where a miss is expected. Terminal callers
 * that treat a miss as real misconfiguration log it themselves.
 */
export function findModel(catalog: ModelCatalog, name: string): ResolvedModel {
  for (const model of catalog.chat.values()) {
    if (model.qualifiedName === name) return model;
  }

  const matches = [...catalog.chat.values()].filter((m) => m.name === name);
  if (matches.length === 0) throw CatalogError.notFound(name);
  if (matches.length === 1) return matches[0] as ResolvedModel;
  throw CatalogError.ambiguousName(name, matches.map((m) => m.qualifiedName).join(", "));
}

/** The first chat model in catalog order, if any. */
export function firstChatModel(catalog: ModelCatalog): ResolvedModel | undefined {
  for (const model of catalog.chat.values()) return model;
  return undefined;
}

/** Every chat model's qualified name, in catalog order. */
export function chatModelNames(catalog: ModelCatalog): string[] {
  return [...catalog.chat.keys()];
}

// ── Category parser ─────────────────────────────────────────────────────

/**
 * Parse a category section (`[chat]`) into resolved models keyed by qualified
 * name.
 *
 * Provider-level defaults no longer live here — they were rehomed onto
 * `[providers.<provider>.defaults]`. Scalar keys directly under
 * `[<category>.<provider>]` are therefore rejected with a migration error.
 *
 * Keys are walked in `BTreeMap` order because the first offending key is the
 * one that throws, and that key has to be the same one Rust picks.
 */
function parseCategory(
  category: string,
  section: Record<string, unknown>,
  providers: ProviderRegistryView | undefined,
): Map<string, ResolvedModel> {
  const models: [string, ResolvedModel][] = [];

  for (const providerKey of sortedKeys(section)) {
    // The Claude Code transport was removed; reject leftover sections
    // explicitly so the breaking change surfaces as a clear config error
    // rather than silently routing through `defaultSdk("claude_code")`.
    if (providerKey === "claude_code") throw CatalogError.removedProvider(category);

    const providerValue = section[providerKey];
    if (!isTable(providerValue)) {
      console.warn(`shore: skipping non-table key "${providerKey}" in [${category}]`);
      continue;
    }

    // Provider-level scalars were retired in favor of
    // `[providers.<provider>.defaults]`. Reject any leftover so a stale config
    // fails loudly instead of silently dropping (e.g.) routing.
    for (const k of sortedKeys(providerValue)) {
      if (!isTable(providerValue[k]) || RESERVED_DICT_KEYS.includes(k)) {
        const target = TRANSPORT_SCALAR_KEYS.includes(k)
          ? "the matching [providers.<name>] entry"
          : "[providers.<name>.defaults]";
        throw CatalogError.providerScalarRetired(category, providerKey, k, target);
      }
    }

    // Cascade order, lowest to highest precedence:
    //   1. hardcoded provider defaults
    //   2. `[providers.<provider>]` registry transport (sdk + base_url)
    //   3. `[providers.<provider>.defaults]` behavioral/vendor defaults
    //   4. `[<category>.<provider>.<model>]` per-model fields
    //
    // Credentials intentionally do NOT cascade through this path: the
    // registry's compact `api_key_env` is folded into its `keys[]` list at
    // parse time and the credential resolver reads that list directly.
    // Overlaying a single env name back onto the static model would defeat the
    // multi-key fallback machinery.
    const providerConfig = hardcodedProviderDefaults(providerKey);

    const entry = providers?.get(providerKey);
    if (entry !== undefined) {
      const registryOverlay: ModelConfigFields = {};
      if (entry.sdk !== undefined) registryOverlay.sdk = entry.sdk;
      if (entry.baseUrl !== undefined) registryOverlay.baseUrl = entry.baseUrl;
      // These two merges cannot currently observe each other's order:
      // `registryOverlay` carries only transport, and `[.defaults]` rejects
      // transport keys at parse time, so the two sets are disjoint. The order
      // is kept because it states the intended precedence for the day
      // `[.defaults]` accepts a key that overlaps.
      mergeFrom(providerConfig.fields, registryOverlay);
      mergeFrom(providerConfig.fields, entry.defaults);
    }

    for (const modelName of sortedKeys(providerValue)) {
      const modelValue = providerValue[modelName];
      // Scalars and reserved dict keys are rejected above; only model
      // sub-tables remain here.
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

  // Deprecation window: `[chat.*]` is no longer the primary model-definition
  // mechanism. Identity is now `provider:model_id`, transport lives in
  // `[providers.<p>]`, and behavioral knobs in `[models."<p>:<id>"]`. The
  // static entries are still honored, but warn once per non-empty category so
  // configs migrate before the entries are physically removed.
  if (models.length > 0) {
    console.warn(
      `shore: \`[${category}.*]\` is deprecated and will be removed: define models via ` +
        `\`[providers.<provider>]\` and select them as \`provider:model_id\`; move ` +
        `behavioral overrides to \`[models."<provider>:<model_id>"]\`. The static ` +
        `entries are still honored this release.`,
    );
  }

  return new Map(models.sort((a, b) => compareByCodePoint(a[0], b[0])));
}

// ── Auxiliary category parser ───────────────────────────────────────────

/**
 * Parse an `[embedding]` or `[image_generation]` section keyed by
 * `provider:model_id`. Each value table holds only category settings;
 * transport and identity come from the key plus `[providers.*]`. The retired
 * flat shape — a bare alias key, or inline transport in the table body — is
 * rejected with a migration error.
 */
function parseAuxSection<T>(
  category: string,
  section: Record<string, unknown>,
  example: string,
  read: (table: Record<string, unknown>) => ParseResult<T>,
): Map<string, T> {
  const out: [string, T][] = [];
  for (const key of sortedKeys(section)) {
    // The new shape requires a `provider:model_id` identity key with both
    // halves non-empty. A bare alias (no colon) is the retired flat shape;
    // `:model` and `provider:` are malformed.
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

    // Unknown keys are rejected, which is what catches leftover inline
    // transport/identity from the old shape as well as misspelled settings.
    const settings = read(value);
    if ("err" in settings) {
      throw CatalogError.auxProfileInvalid(category, key, settings.err, example);
    }
    out.push([key, settings.ok]);
  }
  return new Map(out.sort((a, b) => compareByCodePoint(a[0], b[0])));
}

// ── Provider defaults ───────────────────────────────────────────────────

/** Shared baseline for all known providers. */
function baseProviderDefaults(): ModelConfigFields {
  return { temperature: 1.0, maxOutputTokens: 8192, maxContextTokens: 200_000 };
}

/**
 * Hardcoded provider defaults — the lowest, code-level tier of the cascade,
 * below `[providers.<provider>.defaults]`.
 *
 * Public so the effective-catalog merger can synthesize `ResolvedModel`
 * records for discovered and trusted models on the same footing.
 */
export function hardcodedProviderDefaults(providerKey: string): ProviderConfig {
  const base = baseProviderDefaults();
  switch (providerKey) {
    case "anthropic":
      return { fields: { ...base, sdk: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } };
    case "openrouter":
      // Non-Anthropic OpenRouter models route through the first-party
      // `@openrouter/sdk` adapter — the normalized path that folds each
      // vendor's reasoning shape into one `reasoning_details` array.
      // Claude-over-OpenRouter uses a separate `openrouter-anthropic` provider
      // with an explicit `sdk = "anthropic"`.
      return {
        fields: {
          ...base,
          sdk: "openrouter",
          apiKeyEnv: "OPENROUTER_API_KEY",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      };
    case "deepseek":
      // Native DeepSeek via the Vercel AI SDK provider, which adds reasoning
      // control over the old plain OpenAI-compatible path.
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
      // Native Moonshot (Kimi): native thinking on/off plus reasoningHistory.
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
    case "zai":
      return {
        fields: { ...base, sdk: "zai", apiKeyEnv: "ZAI_API_KEY", zaiClearThinking: false },
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
      // A flat-rate subscription gateway serving open models across two wire
      // dialects behind one key: most via the OpenAI `/chat/completions` path,
      // MiniMax/Qwen via the Anthropic `/messages` path. `sdk` is deliberately
      // left unset so the per-model SDK that discovery stamps wins, rather
      // than a blanket provider default.
      return {
        fields: {
          ...base,
          apiKeyEnv: "OPENCODE_API_KEY",
          baseUrl: "https://opencode.ai/zen/go/v1",
        },
      };
    default:
      // Note: no `baseProviderDefaults()` for an unknown provider — an unknown
      // key gets a completely empty config, not the shared baseline.
      return { fields: {} };
  }
}

/** Default SDK for a provider key, when neither hardcoded nor TOML specifies one. */
export function defaultSdk(providerKey: string): Sdk {
  switch (providerKey) {
    case "anthropic":
      return "anthropic";
    // OpenRouter's non-Anthropic models route through the first-party adapter
    // by default; `anthropic/*` model_ids are still auto-promoted in
    // `resolvedModelFromParts`.
    case "openrouter":
      return "openrouter";
    case "gemini":
      return "gemini";
    case "zai":
      return "zai";
    case "deepseek":
      return "deepseek";
    case "moonshot":
    case "moonshotai":
      return "moonshot";
    // Everything else (xai, zhipuai, custom) defaults to the direct
    // OpenAI-compatible path.
    default:
      return "openai";
  }
}

// ── TOML readers ────────────────────────────────────────────────────────

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `serde` spelling of a TOML value's type, for error messages. */
function tomlTypeName(value: unknown): string {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "floating point";
  if (Array.isArray(value)) return "sequence";
  if (isTable(value)) return "map";
  return "unit";
}

/**
 * How `serde::de::Unexpected` renders a value: strings in double quotes,
 * every other scalar in backticks.
 *
 * Sequences and maps render as the bare type name with no value — serde's
 * `Unexpected::Seq` and `Unexpected::Map` carry nothing to print. Nothing in
 * the model catalog reaches either (its fields are all scalars), but `AppConfig`
 * does, and `[defaults] model = []` must say `invalid type: sequence, expected
 * a string` rather than inventing a rendering of the array.
 */
function tomlValueRepr(value: unknown): string | undefined {
  if (Array.isArray(value) || isTable(value)) return undefined;
  return typeof value === "string" ? `"${value}"` : `\`${String(value)}\``;
}

/** The serde phrasing for a value of the wrong type. */
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

/**
 * A TOML float. Rust's `f64` deserializer rejects a bare integer, so
 * `temperature = 1` is an error where `temperature = 1.0` is fine — and a
 * round-tripped TOML float that happens to be integral (`1.0`) arrives here as
 * the JavaScript number `1`, indistinguishable from the integer. The
 * distinction is therefore only enforceable at the raw-text level, which is
 * where the TOML parser already sits; this reader accepts both.
 */
function readF64(table: Record<string, unknown>, key: string): ParseResult<number | undefined> {
  const value = table[key];
  if (value === undefined) return { ok: undefined };
  if (typeof value !== "number") return { err: invalidType(value, "a float") };
  return { ok: value };
}

/** Read the shared config fields out of a table, ignoring anything else. */
export function readModelConfigFields(table: Record<string, unknown>): ParseResult<ModelConfigFields> {
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
    ["zaiSubscription", "zai_subscription"],
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

  // `openrouter_provider` is an opaque TOML value forwarded verbatim.
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

/** Reject unknown keys, mirroring `deny_unknown_fields` on the aux settings. */
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

/**
 * `ResolvedModel` as serde wrote it, for the command surface that ships one to
 * a client.
 *
 * Not {@link toRequestModel}, and the differences are deliberate rather than
 * incidental: this writes **every** field, spelling absent as `null` where the
 * request builder omits it, and it carries `replay_prior_thinking`, which the
 * request builder drops because the wire takes the replay policy as a separate
 * argument. Field order follows the Rust struct so a diff against a recorded
 * payload reads in the same order as the declaration.
 */
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
    openrouter_provider: or(model.openrouterProvider),
    gemini_generation: or(model.geminiGeneration),
    zai_clear_thinking: or(model.zaiClearThinking),
    zai_subscription: or(model.zaiSubscription),
    replay_prior_thinking: or(model.replayPriorThinking),
    max_tool_iterations: or(model.maxToolIterations),
  };
}
