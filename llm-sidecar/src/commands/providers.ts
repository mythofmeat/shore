/**
 * Provider discovery commands: `list_providers`, `refresh_provider_models`,
 * `refresh_all_provider_models`, `list_provider_models`.
 *
 * Ported from `crates/daemon/src/commands/providers.rs`, pinned by
 * `tests/commands_fixtures/providers_parity.json`.
 *
 * # Secrets do not leave this module
 *
 * `list_providers` reports key *names*, whether each is enabled, and a boolean
 * for whether its env var currently holds a value. Not the env var's name, not
 * the value, not a prefix of it. A variable holding only whitespace reads as
 * unset — in the listing and in the key selection alike, so what the report
 * says and what a refresh would do agree.
 *
 * # A refresh only ever replaces a cache on success
 *
 * Every failure — a disabled provider, a missing key, a 500 from upstream —
 * leaves whatever was on disk exactly as it was. The daemon must never end a
 * refresh knowing about fewer models than it started with, so the write is the
 * last thing that happens and only on the success path.
 *
 * `refreshAll` follows from the same rule at the batch level: a per-provider
 * failure is aggregated into the report rather than aborting the run, because
 * one provider's expired key is no reason to leave the others stale.
 */

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
import { toRfc3339 } from "../ledger/zoned.ts";
import { defaultSdk } from "../config/models.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { enabledKeys, isVisible, type ProviderEntry } from "../config/providers.ts";
import { internalError, invalidRequest, notFound, providerError } from "./errors.ts";

/** Args arrive as a decoded JSON object; every field is optional and untyped. */
export type Args = Record<string, unknown>;

/**
 * What these commands need. They are characterless — runtime state about
 * configured providers, with no session attached — so this is the config and
 * the way out to the network.
 */
export interface ProvidersContext {
  config: LoadedConfig;
  /** Injected so the fixture can drive discovery against a local socket. */
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

/** Whether the env var holds a non-blank value. The value itself never escapes. */
const envSet = (name: string): boolean => (process.env[name]?.trim() ?? "") !== "";

// ── list_providers ────────────────────────────────────────────────────────

export function listProviders(ctx: ProvidersContext): unknown {
  const providers = ctx.config.providers.entries().map(([name, entry]) => {
    const cache = readCacheSync(cachePath(ctx.config.dirs.cache, name));
    const hidden =
      cache === undefined
        ? 0
        : cache.models.filter((m) => !isVisible(entry.discovery, m.model_id)).length;

    return {
      name,
      enabled: entry.enabled,
      sdk: entry.sdk ?? null,
      base_url: entry.baseUrl ?? null,
      discovery_enabled: entry.discovery.enabled,
      keys: entry.keys.map((k) => ({
        name: k.name,
        enabled: k.enabled,
        warn_on_fallback: k.warnOnFallback,
        env_set: envSet(k.env),
      })),
      // An unparseable cache file reads as absent rather than failing the whole
      // listing: this is a diagnostic, and a broken cache is what you called it
      // to find out about.
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

// ── refresh ───────────────────────────────────────────────────────────────

/** What a successful refresh produced. */
export interface RefreshOutcome {
  cache: ProviderModelsCache;
  cachePath: string;
}

/**
 * Fetch a provider's model list with the first usable key and write the cache.
 *
 * Deliberately decoupled from the command context so the auto-discovery
 * background loop can call it with only what it needs.
 *
 * There is no key rotation here, unlike chat traffic: the first enabled key
 * whose env var is non-blank is used, and a failure is reported so the user can
 * fix their credentials and retry. Rotating would mean a refresh that quietly
 * succeeded on a fallback key while the primary stayed broken.
 */
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
    // The previous cache stands.
    throw internalError(describeDiscoveryError(discovered.err));
  }

  const cache: ProviderModelsCache = {
    version: CACHE_VERSION,
    provider_key: provider,
    // chrono writes the numeric offset, not `Z`; the cache reader compares
    // these as text.
    fetched_at: toRfc3339(Date.now()),
    base_url: baseUrl,
    models: discovered.ok,
  };

  const path = cachePath(cacheDir, provider);
  try {
    await writeCache(path, cache);
  } catch (e) {
    throw internalError(`failed to write provider cache: ${e instanceof Error ? e.message : e}`);
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

/**
 * Refresh every provider that is enabled and has discovery on.
 *
 * Skipped providers are reported separately from failed ones: "you turned this
 * off" and "this tried and could not" are different answers, and only the
 * second is a problem.
 */
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

// ── list_provider_models ──────────────────────────────────────────────────

function discoveredToJson(m: DiscoveredModel): unknown {
  return {
    source: "discovered",
    model_id: m.model_id,
    display_name: m.display_name ?? null,
    sdk: m.sdk,
    owned_by: m.owned_by ?? null,
    context_length: m.context_length ?? null,
    max_output_tokens: m.max_output_tokens ?? null,
    supports_tools: m.supports_tools ?? null,
    supports_images: m.supports_images ?? null,
    supports_reasoning: m.supports_reasoning ?? null,
    supports_prompt_cache: m.supports_prompt_cache ?? null,
    discovered_at: m.discovered_at,
  };
}

/**
 * A provider's merged model list: discovered (from cache) plus statically
 * configured.
 *
 * Static entries are always returned, even with no cache at all — that is the
 * manual escape hatch, and they are never filtered by `discovery.ignore`
 * either, because a hand-written catalog entry is by definition intentional.
 *
 * A provider counts as known if the registry has it *or* a static entry
 * references it, so a config that predates the registry still answers.
 */
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

  const cache = readCacheSync(cachePath(ctx.config.dirs.cache, provider));
  const discovered: unknown[] = [];
  const hidden: unknown[] = [];
  for (const m of cache?.models ?? []) {
    const visible = entry === undefined || isVisible(entry.discovery, m.model_id);
    if (visible || includeHidden) discovered.push(discoveredToJson(m));
    else hidden.push(discoveredToJson(m));
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
