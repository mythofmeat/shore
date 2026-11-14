import {
  cachePath,
  describeDiscoveryError,
  discoverAnthropic,
  discoverOpenAiCompatible,
  readCacheSync,
  writeCache,
  CACHE_VERSION,
  type DiscoveredModel,
  type DiscoveryResult,
  type ProviderModelsCache,
} from "../llm/discovery.ts";
import {
  fetchNanoGptSubscription,
  nanoGptSubscriptionPath,
  readNanoGptSubscriptionSync,
  writeNanoGptSubscription,
  type NanoGptSubscriptionState,
} from "../llm/nanogpt_subscription.ts";
import { isNanoGptProvider, NANOGPT_PROVIDER } from "../llm/providers/nanogpt_config.ts";
import { defaultBaseUrl } from "../llm/request.ts";
import { readLearnedImageSupport } from "../llm/image_support.ts";
import { toRfc3339 } from "../ledger/zoned.ts";
import { defaultSdk } from "../config/models.ts";
import type { LoadedConfig } from "../config/loader.ts";
import { isVisible, toCredentialsEntry, type ProviderEntry } from "../config/providers.ts";
import { readCandidateEnv, resolveKeyCandidates } from "../llm/credentials.ts";
import { internalError, invalidRequest, notFound, providerError } from "./errors.ts";
import { setNanoGptSubscription } from "../ledger/store.ts";
import { discoverClaudeAgent, type ClaudeAgentModelQuery } from "../llm/providers/claude_agent_models.ts";

import type { OperationInput, OperationResult } from "../operations/types.ts";
import type { ProviderDiscoveredModel } from "../protocol/ProviderDiscoveredModel.ts";
import type { ProviderStaticModel } from "../protocol/ProviderStaticModel.ts";

export interface ProvidersContext {
  config: LoadedConfig;
  fetchImpl?: typeof fetch;
  runClaudeAgentQuery?: ClaudeAgentModelQuery;
}

function requireProvider(args: OperationInput<"refresh_provider_models">): string {
  const provider = args.provider;
  if (provider === "") {
    throw invalidRequest("missing required argument: provider");
  }
  return provider;
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
  runClaudeAgentQuery?: ClaudeAgentModelQuery,
): Promise<RefreshOutcome> {
  const entry = config.providers.get(provider);
  if (entry === undefined) throw notFound(`provider ${JSON.stringify(provider)} is not configured`);
  if (!entry.enabled) throw invalidRequest(`provider ${JSON.stringify(provider)} is disabled`);
  if (!entry.discover) {
    throw invalidRequest(`provider ${JSON.stringify(provider)} has discovery disabled`);
  }

  const baseUrl = entry.baseUrl ?? defaultBaseUrl(provider);
  const key = firstUsableKey(provider, entry);
  const discovered = await discoverProviderModels(provider, entry, baseUrl, key, fetchImpl, runClaudeAgentQuery);
  if ("err" in discovered) {
    throw internalError(describeDiscoveryError(discovered.err));
  }

  let subscription: NanoGptSubscriptionState | undefined;
  if (isNanoGptProvider(provider) && baseUrl !== undefined && key !== undefined && (entry.sdk ?? defaultSdk(provider)) !== "claude_agent") {
    const result = await fetchNanoGptSubscription(baseUrl, key, fetchImpl);
    if ("err" in result) throw internalError(describeDiscoveryError(result.err));
    subscription = result.ok;
  }

  const cache: ProviderModelsCache = {
    version: CACHE_VERSION,
    provider_key: provider,
    fetched_at: toRfc3339(Date.now()),
    ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
    models: discovered.ok,
  };

  const path = cachePath(cacheDir, provider);
  try {
    await writeCache(path, cache);
    if (subscription !== undefined) {
      await writeNanoGptSubscription(nanoGptSubscriptionPath(cacheDir), subscription);
      setNanoGptSubscription(
        cache.models.filter((model) => model.subscription_included === true).map((model) => model.model_id),
        subscription,
      );
    }
  } catch (e) {
    throw internalError(`failed to write provider cache: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { cache, cachePath: path };
}

async function discoverProviderModels(
  provider: string,
  entry: ProviderEntry,
  baseUrl: string | undefined,
  key: string | undefined,
  fetchImpl: typeof fetch,
  runClaudeAgentQuery?: ClaudeAgentModelQuery,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  const sdk = entry.sdk ?? defaultSdk(provider);
  if (sdk === "claude_agent") return await discoverClaudeAgent(provider, baseUrl, runClaudeAgentQuery);
  if (baseUrl === undefined) {
    throw invalidRequest(
      `provider ${JSON.stringify(provider)} has no base_url; required for provider discovery`,
    );
  }
  if (key === undefined) {
    throw providerError(
      `provider ${JSON.stringify(provider)} has no API key configured ` +
        `(no enabled key's env var is set)`,
    );
  }
  return sdk === "anthropic"
    ? await discoverAnthropic(provider, baseUrl, key, fetchImpl)
    : await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);
}

function firstUsableKey(provider: string, entry: ProviderEntry | undefined): string | undefined {
  for (const candidate of resolveKeyCandidates(provider, entry === undefined ? undefined : toCredentialsEntry(entry))) {
    const value = readCandidateEnv(candidate);
    if (value !== undefined && (value !== "" || candidate.none === true)) return value;
  }
  return undefined;
}

export function reportedNanoGptSubscription(config: LoadedConfig): NanoGptSubscriptionState | undefined {
  if (firstUsableKey(NANOGPT_PROVIDER, config.providers.get(NANOGPT_PROVIDER)) === undefined) return undefined;
  const state = readNanoGptSubscriptionSync(nanoGptSubscriptionPath(config.dirs.cache));
  return state?.state === "active" || state?.state === "grace" ? state : undefined;
}

export async function refreshProviderModels(ctx: ProvidersContext, args: OperationInput<"refresh_provider_models">): Promise<OperationResult<"refresh_provider_models">> {
  const provider = requireProvider(args);
  const outcome = await refreshOne(ctx.config, ctx.config.dirs.cache, provider, ctx.fetchImpl, ctx.runClaudeAgentQuery);
  return {
    provider,
    model_count: outcome.cache.models.length,
    fetched_at: outcome.cache.fetched_at,
    cache_path: outcome.cachePath,
  };
}

export async function refreshAllProviderModels(ctx: ProvidersContext): Promise<OperationResult<"refresh_all_provider_models">> {
  const results: OperationResult<"refresh_all_provider_models">["results"] = [];
  const skipped: OperationResult<"refresh_all_provider_models">["skipped"] = [];

  for (const [name, entry] of ctx.config.providers.entries()) {
    if (!entry.enabled) {
      skipped.push({ provider: name, reason: "disabled" });
      continue;
    }
    if (!entry.discover) {
      skipped.push({ provider: name, reason: "discovery disabled" });
      continue;
    }

    try {
      const outcome = await refreshOne(ctx.config, ctx.config.dirs.cache, name, ctx.fetchImpl, ctx.runClaudeAgentQuery);
      results.push({
        provider: name,
        ok: true,
        model_count: outcome.cache.models.length,
        fetched_at: outcome.cache.fetched_at,
        cache_path: outcome.cachePath,
      });
    } catch (e) {
      results.push({ provider: name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { results, skipped };
}

function discoveredToJson(m: DiscoveredModel, learned: Record<string, boolean>): ProviderDiscoveredModel {
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
    ...(m.subscription_included === undefined
      ? {}
      : { subscription_included: m.subscription_included }),
    ...(m.subscription_input_multiplier === undefined
      ? {}
      : { subscription_input_multiplier: m.subscription_input_multiplier }),
    discovered_at: m.discovered_at,
  };
}

export function listProviderModels(ctx: ProvidersContext, args: OperationInput<"list_provider_models">): OperationResult<"list_provider_models"> {
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
  const learned = readLearnedImageSupport(ctx.config.dirs.cache, provider);
  const discovered: ProviderDiscoveredModel[] = [];
  const hidden: ProviderDiscoveredModel[] = [];
  for (const m of cache?.models ?? []) {
    const visible = entry === undefined || isVisible(entry.ignoreModels, m.model_id);
    if (visible || includeHidden) discovered.push(discoveredToJson(m, learned));
    else hidden.push(discoveredToJson(m, learned));
  }

  const staticModels = [...ctx.config.models.chat.values()]
    .filter((m) => m.providerKey === provider)
    .map((m): ProviderStaticModel => ({
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
