import {
  cachePath,
  describeDiscoveryError,
  discoverAnthropic,
  discoverOpenAiCompatible,
  readCacheSync,
  writeCache,
  CACHE_VERSION,
  type DiscoveredModel,
  type ProviderModelsCache,
} from "../llm/discovery.ts";
import { defaultBaseUrl } from "../llm/request.ts";
import { readLearnedImageSupport } from "../llm/image_support.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import { defaultSdk } from "../config/models.ts";
import type { LoadedConfig } from "../config/loader.ts";
import {
  enabledKeys,
  isVisible,
  providerCatalogSource,
  type ProviderEntry,
} from "../config/providers.ts";
import { internalError, invalidRequest, notFound, providerError } from "./errors.ts";

export type Args = Record<string, unknown>;

export interface ProvidersContext {
  config: LoadedConfig;
  fetchImpl?: typeof fetch;
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function requireProvider(args: Args): string {
  const provider = asStr(args["provider"]);
  if (provider === undefined || provider === "") {
    throw invalidRequest("missing required argument: provider");
  }
  return provider;
}

const envSet = (name: string): boolean => (process.env[name]?.trim() ?? "") !== "";

export function listProviders(ctx: ProvidersContext): unknown {
  const providers = ctx.config.providers.entries().map(([name, entry]) => {
    const catalogSource = providerCatalogSource(name, entry);
    const cache = readCacheSync(cachePath(ctx.config.dirs.cache, catalogSource));
    const hidden =
      cache === undefined
        ? 0
        : cache.models.filter((m) => !isVisible(entry.discovery, m.model_id)).length;

    return {
      name,
      enabled: entry.enabled,
      sdk: entry.sdk ?? defaultSdk(name),
      base_url: entry.baseUrl ?? defaultBaseUrl(name) ?? null,
      discovery_enabled: entry.discovery.enabled,
      ...(catalogSource === name ? {} : { catalog_source: catalogSource }),
      keys: entry.keys.map((k) => ({
        name: k.name,
        enabled: k.enabled,
        warn_on_fallback: k.warnOnFallback,
        env_set: envSet(k.env),
      })),
      cache:
        cache === undefined
          ? { present: false, models: 0, visible: 0, hidden: 0, fetched_at: null }
          : {
              present: true,
              models: cache.models.length,
              visible: cache.models.length - hidden,
              hidden,
              fetched_at: cache.fetched_at,
            },
    };
  });

  return { providers };
}

export interface RefreshOutcome {
  cache: ProviderModelsCache;
  cachePath: string;
}

export async function refreshOne(
  config: LoadedConfig,
  cacheDir: string,
  provider: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  const entry = config.providers.get(provider);
  if (entry === undefined) throw notFound(`provider ${JSON.stringify(provider)} is not configured`);
  if (!entry.enabled) throw invalidRequest(`provider ${JSON.stringify(provider)} is disabled`);
  if (!entry.discovery.enabled) {
    throw invalidRequest(`provider ${JSON.stringify(provider)} has discovery disabled`);
  }
  if (entry.catalogSource !== undefined) {
    throw invalidRequest(
      `provider ${JSON.stringify(provider)} mirrors the model catalog from ` +
        `${JSON.stringify(entry.catalogSource)}; refresh that provider instead`,
    );
  }

  const baseUrl = entry.baseUrl ?? defaultBaseUrl(provider);
  if (baseUrl === undefined) {
    throw invalidRequest(
      `provider ${JSON.stringify(provider)} has no base_url; required for provider discovery`,
    );
  }

  const key = firstUsableKey(entry);
  if (key === undefined) {
    throw providerError(
      `provider ${JSON.stringify(provider)} has no API key configured ` +
        `(no enabled key's env var is set)`,
    );
  }

  const sdk = entry.sdk ?? defaultSdk(provider);
  const discovered =
    sdk === "anthropic"
      ? await discoverAnthropic(provider, baseUrl, key, fetchImpl)
      : await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);
  if ("err" in discovered) {
    throw internalError(describeDiscoveryError(discovered.err));
  }

  const cache: ProviderModelsCache = {
    version: CACHE_VERSION,
    provider_key: provider,
    fetched_at: toRfc3339(Date.now()),
    base_url: baseUrl,
    models: discovered.ok,
  };

  const path = cachePath(cacheDir, provider);
  try {
    await writeCache(path, cache);
  } catch (e) {
    throw internalError(`failed to write provider cache: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { cache, cachePath: path };
}

function firstUsableKey(entry: ProviderEntry): string | undefined {
  for (const k of enabledKeys(entry)) {
    const value = process.env[k.env];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

export async function refreshProviderModels(ctx: ProvidersContext, args: Args): Promise<unknown> {
  const provider = requireProvider(args);
  const outcome = await refreshOne(ctx.config, ctx.config.dirs.cache, provider, ctx.fetchImpl);
  return {
    provider,
    model_count: outcome.cache.models.length,
    fetched_at: outcome.cache.fetched_at,
    cache_path: outcome.cachePath,
  };
}

export async function refreshAllProviderModels(ctx: ProvidersContext): Promise<unknown> {
  const results: unknown[] = [];
  const skipped: unknown[] = [];

  for (const [name, entry] of ctx.config.providers.entries()) {
    if (!entry.enabled) {
      skipped.push({ provider: name, reason: "disabled" });
      continue;
    }
    if (!entry.discovery.enabled) {
      skipped.push({ provider: name, reason: "discovery disabled" });
      continue;
    }
    if (entry.catalogSource !== undefined) {
      skipped.push({ provider: name, reason: `catalog mirrors ${entry.catalogSource}` });
      continue;
    }

    try {
      const outcome = await refreshOne(ctx.config, ctx.config.dirs.cache, name, ctx.fetchImpl);
      results.push({
        provider: name,
        ok: true,
        model_count: outcome.cache.models.length,
        fetched_at: outcome.cache.fetched_at,
        cache_path: outcome.cachePath,
      });
    } catch (e) {
      results.push({ provider: name, ok: false, error: (e as Error).message });
    }
  }

  return { results, skipped };
}

function discoveredToJson(m: DiscoveredModel, learned: Record<string, boolean>): unknown {
  return {
    source: "discovered",
    model_id: m.model_id,
    display_name: m.display_name ?? null,
    sdk: m.sdk,
    owned_by: m.owned_by ?? null,
    context_length: m.context_length ?? null,
    max_output_tokens: m.max_output_tokens ?? null,
    supports_tools: m.supports_tools ?? null,
    supports_images: m.supports_images ?? learned[m.model_id] ?? null,
    supports_reasoning: m.supports_reasoning ?? null,
    supports_prompt_cache: m.supports_prompt_cache ?? null,
    discovered_at: m.discovered_at,
  };
}

export function listProviderModels(ctx: ProvidersContext, args: Args): unknown {
  const provider = requireProvider(args);
  const includeHidden = args["include_hidden"] === true;

  const entry = ctx.config.providers.get(provider);
  const knownInStatic = [...ctx.config.models.chat.values()].some(
    (m) => m.providerKey === provider,
  );
  if (entry === undefined && !knownInStatic) {
    throw notFound(`provider ${JSON.stringify(provider)} is not configured`);
  }

  const catalogSource = entry === undefined ? provider : providerCatalogSource(provider, entry);
  const cache = readCacheSync(cachePath(ctx.config.dirs.cache, catalogSource));
  const learned = readLearnedImageSupport(ctx.config.dirs.cache, catalogSource);
  const discovered: unknown[] = [];
  const hidden: unknown[] = [];
  for (const m of cache?.models ?? []) {
    const visible = entry === undefined || isVisible(entry.discovery, m.model_id);
    if (visible || includeHidden) discovered.push(discoveredToJson(m, learned));
    else hidden.push(discoveredToJson(m, learned));
  }

  const staticModels = [...ctx.config.models.chat.values()]
    .filter((m) => m.providerKey === provider)
    .map((m) => ({
      source: "static",
      name: m.name,
      qualified_name: m.qualifiedName,
      model_id: m.modelId,
      sdk: m.sdk,
      max_output_tokens: m.maxOutputTokens ?? null,
    }));

  return {
    provider,
    ...(catalogSource === provider ? {} : { catalog_source: catalogSource }),
    discovered,
    hidden,
    static: staticModels,
    include_hidden: includeHidden,
    cache:
      cache === undefined
        ? { fetched_at: null, model_count: 0 }
        : { fetched_at: cache.fetched_at, model_count: cache.models.length },
  };
}
