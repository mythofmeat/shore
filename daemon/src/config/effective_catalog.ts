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

export type EffectiveSource = "static" | "discovered" | "favorite";

export interface EffectiveModel {
  source: EffectiveSource;
  resolved: ResolvedModel;
  hidden: boolean;
  subscriptionIncluded?: boolean;
}

export function findEffectiveModel(
  config: LoadedConfigView,
  cacheDir: string,
  name: string,
  includeHidden: boolean,
): ResolvedModel {
  try {
    const model = findModel(config.models, name);
    if (config.providers.get(model.providerKey)?.enabled === false) throw EffectiveCatalogError.notFound(name);
    return model;
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

  const hits: { provider: string; resolved: ResolvedModel; hidden: boolean }[] = [];
  for (const [providerKey, entry] of config.providers.entries()) {
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

export function listEffectiveModels(
  config: LoadedConfigView,
  cacheDir: string,
  includeHidden: boolean,
): EffectiveModel[] {
  const out: EffectiveModel[] = [...config.models.chat.values()].map((resolved) => ({
    source: "static" as const,
    resolved,
    hidden: false,
    ...optionalSubscription(readProviderDiscovery(cacheDir, resolved.providerKey, resolved.modelId)),
  }));

  for (const [providerKey, entry] of config.providers.entries()) {
    if (!entry.enabled || !entry.discovery.enabled) continue;
    const cache = readCacheSync(cachePath(cacheDir, providerKey));
    if (cache === undefined) continue;

    const discovered = [...cache.models].sort((a, b) => compareBytes(a.model_id, b.model_id));
    for (const disc of discovered) {
      if (findStaticByUpstream(config.models, providerKey, disc.model_id) !== undefined) continue;
      const hidden = !isVisible(entry.discovery, disc.model_id);
      if (hidden && !includeHidden) continue;
      out.push({
        source: "discovered",
        resolved: buildResolvedFromProvider(providerKey, entry, disc.model_id, disc),
        hidden,
        ...optionalSubscription(disc),
      });
    }
  }
  return out;
}

function optionalSubscription(
  model: DiscoveredModel | undefined,
): { subscriptionIncluded?: boolean } {
  return model?.subscription_included === undefined
    ? {}
    : { subscriptionIncluded: model.subscription_included };
}

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

  if (!entry.enabled) return undefined;

  const staticMatch = findStaticByUpstream(config.models, provider, modelId);
  if (staticMatch !== undefined) return staticMatch;

  if (entry.discovery.enabled) {
    const disc = readProviderDiscovery(cacheDir, provider, modelId);
    if (disc !== undefined) {
      if (!isVisible(entry.discovery, disc.model_id) && !includeHidden) {
        return EffectiveCatalogError.hidden(name, provider);
      }
      return buildResolvedFromProvider(provider, entry, disc.model_id, disc);
    }
    if (!isVisible(entry.discovery, modelId) && !includeHidden) {
      return EffectiveCatalogError.hidden(name, provider);
    }
  }

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

function buildResolvedFromProvider(
  providerKey: string,
  entry: ProviderEntry,
  modelId: string,
  disc: DiscoveredModel | undefined,
): ResolvedModel {
  const providerDefaults = hardcodedProviderDefaults(providerKey).fields;

  const sdk: Sdk =
    entry.sdk ??
    (providerKey === "nanogpt" ? providerDefaults.sdk : undefined) ??
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

  mergeFrom(fields, entry.defaults);

  const sdkFallback = fields.sdk ?? sdk;

  return resolvedModelFromParts(
    modelId,
    `${providerKey}:${modelId}`,
    "chat",
    providerKey,
    modelId,
    sdkFallback,
    fields,
    disc?.support,
    disc?.supports_images,
  );
}

function asU32(value: number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) return undefined;
  return value;
}
