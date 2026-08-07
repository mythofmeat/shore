/**
 * The effective model catalog — the static `[chat.*]` catalog merged with the
 * provider registry and its on-disk discovery cache.
 *
 * Port of `crates/daemon/src/effective_catalog.rs`.
 *
 * Conflict rules:
 *
 * * Static entries always win when matched by short or qualified name;
 *   `findModel`'s behaviour is preserved verbatim.
 * * When a discovered model and a static entry share a `(provider, modelId)`,
 *   the static entry wins — the static-by-upstream check runs before any
 *   synthetic model is built.
 * * `discovery.ignore` never affects static entries; only discovered models
 *   can be hidden.
 *
 * Sampler preferences are applied separately at request time; this module
 * resolves identity and transport only.
 */

import {
  defaultSdk,
  findModel,
  hardcodedProviderDefaults,
  mergeFrom,
  resolvedModelFromParts,
  sdkFromWire,
  type ModelCatalog,
  type ModelConfigFields,
  type ResolvedModel,
  type Sdk,
} from "./models.ts";
import { CatalogError } from "./models.ts";
import { isVisible, type ProviderEntry } from "./providers.ts";
import type { LoadedConfigView } from "./preferences.ts";
import { cachePath, readCacheSync, type DiscoveredModel } from "../llm/discovery.ts";

// ── Errors ──────────────────────────────────────────────────────────────

export type EffectiveCatalogErrorKind = "not_found" | "ambiguous" | "hidden";

export class EffectiveCatalogError extends Error {
  constructor(
    readonly kind: EffectiveCatalogErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "EffectiveCatalogError";
  }

  static notFound(name: string): EffectiveCatalogError {
    return new EffectiveCatalogError(
      "not_found",
      `model ${JSON.stringify(name)} not found in static catalog or discovered models`,
    );
  }

  static ambiguous(name: string, locations: string): EffectiveCatalogError {
    return new EffectiveCatalogError(
      "ambiguous",
      `model name ${JSON.stringify(name)} is ambiguous across providers: ${locations}`,
    );
  }

  static hidden(name: string, provider: string): EffectiveCatalogError {
    return new EffectiveCatalogError(
      "hidden",
      `model ${JSON.stringify(name)} is hidden by [providers.${provider}.discovery.ignore]; ` +
        `pass include_hidden=true or update the ignore rules to allow it`,
    );
  }
}

/** Where an effective-catalog entry came from. */
export type EffectiveSource = "static" | "discovered";

/** One row of the merged catalog as surfaced to clients. */
export interface EffectiveModel {
  source: EffectiveSource;
  resolved: ResolvedModel;
  /** True when `discovery.ignore` would normally hide this model. Static
   *  entries are always `false`. */
  hidden: boolean;
}

// ── Lookup ──────────────────────────────────────────────────────────────

/**
 * Look up a model by name across the static catalog and the provider
 * discovery caches.
 *
 * 1. Static catalog by short or qualified name.
 * 2. Provider-prefixed `provider:model_id`. The provider must be registered
 *    and enabled. A legacy static entry sharing the same `(provider, modelId)`
 *    still wins this cycle; otherwise a discovery record is used when
 *    available, and failing that the `modelId` is trusted as-given and routed
 *    through the provider's transport.
 * 3. Bare upstream `model_id`, searched across every enabled provider's cache.
 *    Several providers carrying the same id is `ambiguous`.
 *
 * A disabled provider is *uniformly* unreferenceable — neither its
 * trusted/discovered models nor its legacy static entries resolve through
 * paths 2 or 3.
 *
 * `includeHidden` permits resolving discovered models matched by
 * `discovery.ignore`. Static entries are never hidden.
 */
export function findEffectiveModel(
  config: LoadedConfigView,
  cacheDir: string,
  name: string,
  includeHidden: boolean,
): ResolvedModel {
  try {
    return findModel(config.models, name);
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
  }

  const colon = name.indexOf(":");
  if (colon >= 0) {
    const result = resolveProviderPrefixed(
      config,
      cacheDir,
      name,
      name.slice(0, colon),
      name.slice(colon + 1),
      includeHidden,
    );
    if (result !== undefined) {
      if (result instanceof EffectiveCatalogError) throw result;
      return result;
    }
  }

  // Bare upstream id: collect matches across all providers. Static entries are
  // always considered; discovered matches need both provider.enabled and
  // discovery.enabled.
  const hits: { provider: string; resolved: ResolvedModel; hidden: boolean }[] = [];
  for (const [providerKey, entry] of config.providers.entries()) {
    // A disabled provider is uniformly unreferenceable, its legacy static
    // entries included — so this gate runs before the static check.
    if (!entry.enabled) continue;

    const staticMatch = findStaticByUpstream(config.models, providerKey, name);
    if (staticMatch !== undefined) {
      hits.push({ provider: providerKey, resolved: staticMatch, hidden: false });
      continue;
    }
    if (!entry.discovery.enabled) continue;

    const disc = readProviderDiscovery(cacheDir, providerKey, name);
    if (disc === undefined) continue;
    hits.push({
      provider: providerKey,
      resolved: buildResolvedFromProvider(providerKey, entry, disc.model_id, disc),
      hidden: !isVisible(entry.discovery, disc.model_id),
    });
  }

  // Hidden hits don't count toward ambiguity unless the caller opted in. A
  // single hidden-only match still surfaces as `hidden`, which is clearer than
  // `not_found`.
  const visible = includeHidden ? hits : hits.filter((h) => !h.hidden);
  const hiddenOnly = includeHidden ? [] : hits.filter((h) => h.hidden);

  if (visible.length === 1) return (visible[0] as (typeof visible)[number]).resolved;
  if (visible.length === 0) {
    const first = hiddenOnly[0];
    throw first === undefined
      ? EffectiveCatalogError.notFound(name)
      : EffectiveCatalogError.hidden(name, first.provider);
  }
  const locations = visible.map((h) => `${h.provider}:${h.resolved.modelId}`).join(", ");
  throw EffectiveCatalogError.ambiguous(name, locations);
}

/**
 * Every static chat model plus every discovered model.
 *
 * Discovered models are deduplicated against static entries with the same
 * `(provider, modelId)` — one row, sourced from the static side.
 *
 * `includeHidden = false` drops discovered rows hidden by `discovery.ignore`.
 * Static rows are always included.
 */
export function listEffectiveModels(
  config: LoadedConfigView,
  cacheDir: string,
  includeHidden: boolean,
): EffectiveModel[] {
  const out: EffectiveModel[] = [...config.models.chat.values()].map((resolved) => ({
    source: "static" as const,
    resolved,
    hidden: false,
  }));

  for (const [providerKey, entry] of config.providers.entries()) {
    if (!entry.enabled || !entry.discovery.enabled) continue;
    const cache = readCacheSync(cachePath(cacheDir, providerKey));
    if (cache === undefined) continue;

    // Discovery caches preserve the provider's raw `/v1/models` order, which
    // is effectively arbitrary. Sort by upstream id so each provider's block
    // lists alphabetically; the static entries above are already in key order.
    const discovered = [...cache.models].sort((a, b) => compareBytes(a.model_id, b.model_id));
    for (const disc of discovered) {
      if (findStaticByUpstream(config.models, providerKey, disc.model_id) !== undefined) continue;
      const hidden = !isVisible(entry.discovery, disc.model_id);
      if (hidden && !includeHidden) continue;
      out.push({
        source: "discovered",
        resolved: buildResolvedFromProvider(providerKey, entry, disc.model_id, disc),
        hidden,
      });
    }
  }
  return out;
}

// ── Internals ───────────────────────────────────────────────────────────

/** `String::cmp` — byte order, which for UTF-8 is code-point order. */
function compareBytes(a: string, b: string): number {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ab, bb);
}

function readProviderDiscovery(
  cacheDir: string,
  providerKey: string,
  modelId: string,
): DiscoveredModel | undefined {
  const cache = readCacheSync(cachePath(cacheDir, providerKey));
  return cache?.models.find((m) => m.model_id === modelId);
}

/**
 * Resolve the provider-prefixed form.
 *
 * Returns a model or an error when the provider is registered *and enabled* —
 * the lookup is authoritative from there. Returns `undefined` when the prefix
 * is malformed, unregistered, or disabled, so the caller falls through to the
 * bare-id search (which then yields `not_found`).
 */
function resolveProviderPrefixed(
  config: LoadedConfigView,
  cacheDir: string,
  name: string,
  provider: string,
  modelId: string,
  includeHidden: boolean,
): ResolvedModel | EffectiveCatalogError | undefined {
  if (provider === "" || modelId === "") return undefined;
  const entry = config.providers.get(provider);
  if (entry === undefined) return undefined;

  // A disabled provider is *uniformly* unreferenceable — never trust a stale
  // cache, route to a provider the user turned off, or resolve a legacy static
  // entry sitting under it. This gate runs before the static-by-upstream check
  // so disabling a provider hides its statics too.
  if (!entry.enabled) return undefined;

  // For an enabled provider, a legacy static entry sharing this
  // `(provider, modelId)` still wins this cycle, so its hand-configured fields
  // are honored over the trusted/discovered build.
  const staticMatch = findStaticByUpstream(config.models, provider, modelId);
  if (staticMatch !== undefined) return staticMatch;

  if (entry.discovery.enabled) {
    // Prefer a cached record (richer upstream metadata) and honor visibility.
    const disc = readProviderDiscovery(cacheDir, provider, modelId);
    if (disc !== undefined) {
      if (!isVisible(entry.discovery, disc.model_id) && !includeHidden) {
        return EffectiveCatalogError.hidden(name, provider);
      }
      return buildResolvedFromProvider(provider, entry, disc.model_id, disc);
    }
    // Not cached, but an explicitly-ignored id stays hidden so a qualified ref
    // cannot bypass `discovery.ignore`.
    if (!isVisible(entry.discovery, modelId) && !includeHidden) {
      return EffectiveCatalogError.hidden(name, provider);
    }
  }

  // Trust a fully-qualified reference on an enabled provider even without a
  // discovery record: route transport from `[providers.<provider>]` and take
  // the id as given. This keeps models on discovery-off providers
  // referenceable once the static catalog is retired.
  return buildResolvedFromProvider(provider, entry, modelId, undefined);
}

function findStaticByUpstream(
  catalog: ModelCatalog,
  provider: string,
  modelId: string,
): ResolvedModel | undefined {
  for (const model of catalog.chat.values()) {
    if (model.providerKey === provider && model.modelId === modelId) return model;
  }
  return undefined;
}

/**
 * Build a `ResolvedModel` for a `provider:model_id` reference, routing
 * transport from the provider registry entry.
 *
 * With a discovery record, its upstream metadata (SDK hint, base URL,
 * context/output limits) fills fields the provider entry leaves unset. Without
 * one, the id is trusted as-given and only provider and hardcoded defaults
 * apply.
 *
 * `[providers.<provider>.defaults]` is applied last, so it wins over
 * discovered metadata — mirroring the static cascade.
 */
export function buildResolvedFromProvider(
  providerKey: string,
  entry: ProviderEntry,
  modelId: string,
  disc: DiscoveredModel | undefined,
): ResolvedModel {
  const providerDefaults = hardcodedProviderDefaults(providerKey).fields;

  // Mirror the `anthropic/*` auto-promotion that fires on static entries.
  // OpenRouter's discovery feed reports `sdk = "openai"` for every model, so
  // without this an `anthropic/*` slug under a registry that omits
  // `sdk = "anthropic"` would land on the OpenAI wire and miss prompt caching.
  // Only fires when the user hasn't pinned an SDK on the provider entry.
  //
  // The curated hardcoded default is preferred over the feed's `disc.sdk`,
  // because openai-compatible discovery stamps a blanket `"openai"` for every
  // model and carries no real per-model signal. That keeps the discovered path
  // consistent with the static one. A provider with no hardcoded default falls
  // through to `disc.sdk`, then to `defaultSdk`.
  const sdk: Sdk =
    entry.sdk ??
    (modelId.startsWith("anthropic/") ? "anthropic" : undefined) ??
    providerDefaults.sdk ??
    (disc === undefined ? undefined : sdkFromWire(disc.sdk)) ??
    defaultSdk(providerKey);

  const baseUrl = entry.baseUrl ?? disc?.base_url ?? providerDefaults.baseUrl;
  const maxContextTokens = asU32(disc?.context_length) ?? providerDefaults.maxContextTokens;
  const maxOutputTokens = asU32(disc?.max_output_tokens) ?? providerDefaults.maxOutputTokens;

  const fields: ModelConfigFields = { sdk };
  if (baseUrl !== undefined) fields.baseUrl = baseUrl;
  if (maxContextTokens !== undefined) fields.maxContextTokens = maxContextTokens;
  if (maxOutputTokens !== undefined) fields.maxOutputTokens = maxOutputTokens;
  if (providerDefaults.temperature !== undefined) fields.temperature = providerDefaults.temperature;
  if (providerDefaults.zaiClearThinking !== undefined) {
    fields.zaiClearThinking = providerDefaults.zaiClearThinking;
  }
  // Everything else is deliberately left unset: `api_key_env` never cascades
  // here (credentials come from the registry's key list), and the remaining
  // sampler and vendor knobs are the provider-defaults bag's job below.

  // Applied last so user config wins over discovered upstream metadata — the
  // same precedence the static cascade gives. Carries routing, `cache_ttl`,
  // sampler knobs and the rest that the discovery feed never reports.
  mergeFrom(fields, entry.defaults);

  // The overlay may have changed `sdk`; `resolvedModelFromParts` reads it from
  // `fields` when present, so pass the possibly-overridden value as the
  // fallback too.
  const sdkFallback = fields.sdk ?? sdk;

  return resolvedModelFromParts(
    modelId,
    // Canonical `provider:model_id` identity, not the retired
    // `chat.<provider>.<model_id>` static-catalog cosplay. Unlike that
    // synthetic name, this round-trips back through `findEffectiveModel`.
    `${providerKey}:${modelId}`,
    "chat",
    providerKey,
    modelId,
    sdkFallback,
    fields,
  );
}

/** `u32::try_from(v).ok()` — a value outside the range drops to `undefined`
 *  rather than clamping, so the provider default takes over. */
function asU32(value: number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) return undefined;
  return value;
}
