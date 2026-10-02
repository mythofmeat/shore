#!/usr/bin/env python3
"""Mutation pass over the provider discovery commands: listings, API-key
detection, refreshes, and the model rows they report.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/providers.ts"

MUTANTS = [
    # --- argument handling ---------------------------------------------------
    ("provider: an empty string is a provider",
     '  if (provider === "") {',
     "  if (false) {"),
    ("include_hidden: omission and null opt in",
     '  const includeHidden = args["include_hidden"] === true;',
     '  const includeHidden = args["include_hidden"] !== false;'),
    ("include_hidden: always on",
     '  const includeHidden = args["include_hidden"] === true;',
     "  const includeHidden = true as boolean;"),

    # --- the env probe --------------------------------------------------------
    ("env: a blank value counts as set",
     'const envSet = (name: string): boolean => (process.env[name]?.trim() ?? "") !== "";',
     "const envSet = (name: string): boolean => process.env[name] !== undefined;"),
    ("env: never set",
     'const envSet = (name: string): boolean => (process.env[name]?.trim() ?? "") !== "";',
     "const envSet = (name: string): boolean => false;"),
    ("env: the key selection accepts a blank value",
     '    if (value !== undefined && value.trim() !== "") return value;',
     "    if (value !== undefined) return value;"),
    ("env: the key selection ignores whether the key is enabled",
     "  for (const k of enabledKeys(entry)) {",
     "  for (const k of entry.keys) {"),
    ("env: the last usable key wins rather than the first",
     "  for (const k of enabledKeys(entry)) {\n"
     "    const value = process.env[k.env];\n"
     '    if (value !== undefined && value.trim() !== "") return value;\n'
     "  }\n"
     "  return undefined;",
     "  let found: string | undefined;\n"
     "  for (const k of enabledKeys(entry)) {\n"
     "    const value = process.env[k.env];\n"
     '    if (value !== undefined && value.trim() !== "") found = value;\n'
     "  }\n"
     "  return found;"),

    # --- list_providers -------------------------------------------------------
    ("listing: the env var name is surfaced",
     "        name: k.name,\n"
     "        enabled: k.enabled,\n"
     "        warn_on_fallback: k.warnOnFallback,\n"
     "        env_set: envSet(k.env),",
     "        name: k.env,\n"
     "        enabled: k.enabled,\n"
     "        warn_on_fallback: k.warnOnFallback,\n"
     "        env_set: envSet(k.env),"),
    ("listing: warn_on_fallback is dropped",
     "        warn_on_fallback: k.warnOnFallback,",
     "        warn_on_fallback: false,"),
    ("listing: a key's enabled flag is dropped",
     "        enabled: k.enabled,\n        warn_on_fallback:",
     "        enabled: true,\n        warn_on_fallback:"),
    ("listing: the hidden count ignores the ignore rules",
     "        : cache.models.filter((m) => !isVisible(entry.discovery, m.model_id)).length;",
     "        : 0;"),
    ("listing: the hidden count is inverted",
     "        : cache.models.filter((m) => !isVisible(entry.discovery, m.model_id)).length;",
     "        : cache.models.filter((m) => isVisible(entry.discovery, m.model_id)).length;"),
    ("listing: visible is the whole model count",
     "              visible: cache.models.length - hidden,",
     "              visible: cache.models.length,"),
    ("listing: an absent cache reports as present",
     "        cache === undefined\n"
     "          ? { present: false, models: 0, visible: 0, hidden: 0, fetched_at: null }",
     "        cache === undefined\n"
     "          ? { present: true, models: 0, visible: 0, hidden: 0, fetched_at: null }"),
    ("listing: the provider's enabled flag is dropped",
     "      enabled: entry.enabled,\n      sdk:",
     "      enabled: true,\n      sdk:"),
    ("listing: discovery_enabled reports the provider's enabled flag",
     "      discovery_enabled: entry.discovery.enabled,",
     "      discovery_enabled: entry.enabled,"),
    ("listing: an unset sdk is reported as null rather than the default it will use",
     "      sdk: entry.sdk ?? defaultSdk(name),",
     "      sdk: entry.sdk ?? null,"),

    # --- refreshOne guards ----------------------------------------------------
    ("refresh: an unconfigured provider is an invalid request",
     "  if (entry === undefined) throw notFound(`provider ${JSON.stringify(provider)} is not configured`);",
     "  if (entry === undefined)\n"
     "    throw invalidRequest(`provider ${JSON.stringify(provider)} is not configured`);"),
    ("refresh: a disabled provider refreshes anyway",
     "  if (!entry.enabled) throw invalidRequest(`provider ${JSON.stringify(provider)} is disabled`);",
     "  void entry.enabled;"),
    ("refresh: discovery-disabled refreshes anyway",
     "  if (!entry.discovery.enabled) {\n"
     "    throw invalidRequest(`provider ${JSON.stringify(provider)} has discovery disabled`);\n"
     "  }",
     "  if (false as boolean) {\n"
     "    throw invalidRequest(`provider ${JSON.stringify(provider)} has discovery disabled`);\n"
     "  }"),
    ("refresh: the built-in base url is not consulted",
     "  const baseUrl = entry.baseUrl ?? defaultBaseUrl(provider);",
     "  const baseUrl = entry.baseUrl;"),
    ("refresh: the built-in base url beats the configured one",
     "  const baseUrl = entry.baseUrl ?? defaultBaseUrl(provider);",
     "  const baseUrl = defaultBaseUrl(provider) ?? entry.baseUrl;"),
    ("refresh: a missing key is an internal error rather than a provider one",
     "    throw providerError(",
     "    throw internalError("),

    # --- the sdk branch -------------------------------------------------------
    ("refresh: every sdk takes the openai-compatible path",
     '  return sdk === "anthropic"\n'
     "    ? await discoverAnthropic(provider, baseUrl, key, fetchImpl)\n"
     "    : await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);",
     "  return await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);"),
    ("refresh: every sdk takes the anthropic path",
     '  return sdk === "anthropic"\n'
     "    ? await discoverAnthropic(provider, baseUrl, key, fetchImpl)\n"
     "    : await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);",
     "  return await discoverAnthropic(provider, baseUrl, key, fetchImpl);"),
    ("refresh: the sdk default is not consulted",
     "  const sdk = entry.sdk ?? defaultSdk(provider);",
     '  const sdk = entry.sdk ?? "openai";'),

    # --- the cache write ------------------------------------------------------
    ("refresh: a failed discovery still writes a cache",
     '  if ("err" in discovered) {\n    throw internalError(describeDiscoveryError(discovered.err));\n  }',
     '  if ("err" in discovered) {\n'
     "    await writeCache(cachePath(cacheDir, provider), {\n"
     "      version: CACHE_VERSION,\n"
     "      provider_key: provider,\n"
     "      fetched_at: toRfc3339(Date.now()),\n"
     "      base_url: baseUrl,\n"
     "      models: [],\n"
     "    });\n"
     "    throw internalError(describeDiscoveryError(discovered.err));\n  }"),
    ("refresh: the discovery error message is replaced",
     "    throw internalError(describeDiscoveryError(discovered.err));",
     '    throw internalError("discovery failed");'),
    ("refresh: the base url is not recorded in the cache",
     "    ...(baseUrl === undefined ? {} : { base_url: baseUrl }),\n    models: discovered.ok,",
     "    base_url: undefined,\n    models: discovered.ok,"),
    ("refresh: the cache version is not stamped",
     "    version: CACHE_VERSION,",
     "    version: 0,"),
    ("refresh: the timestamp is toISOString rather than chrono's spelling",
     "    fetched_at: toRfc3339(Date.now()),",
     "    fetched_at: new Date().toISOString(),"),
    ("refresh: the cache is written under the wrong provider",
     "  const path = cachePath(cacheDir, provider);",
     '  const path = cachePath(cacheDir, "shared");'),
    ("refresh: nothing is written at all",
     "    await writeCache(path, cache);",
     "    void path;"),

    # --- refresh_all ----------------------------------------------------------
    ("refresh_all: a disabled provider is attempted",
     "    if (!entry.enabled) {\n"
     '      skipped.push({ provider: name, reason: "disabled" });\n'
     "      continue;\n"
     "    }",
     "    if (false as boolean) {\n"
     '      skipped.push({ provider: name, reason: "disabled" });\n'
     "      continue;\n"
     "    }"),
    ("refresh_all: discovery-disabled is attempted",
     "    if (!entry.discovery.enabled) {\n"
     '      skipped.push({ provider: name, reason: "discovery disabled" });\n'
     "      continue;\n"
     "    }",
     "    if (false as boolean) {\n"
     '      skipped.push({ provider: name, reason: "discovery disabled" });\n'
     "      continue;\n"
     "    }"),
    ("refresh_all: the two skip reasons are swapped",
     '      skipped.push({ provider: name, reason: "disabled" });',
     '      skipped.push({ provider: name, reason: "discovery disabled" });'),
    ("refresh_all: a failure aborts the batch",
     "    } catch (e) {\n"
     "      results.push({ provider: name, ok: false, error: e instanceof Error ? e.message : String(e) });\n"
     "    }",
     "    } catch (e) {\n"
     "      throw e;\n"
     "    }"),
    ("refresh_all: a failure is reported as a skip",
     "      results.push({ provider: name, ok: false, error: e instanceof Error ? e.message : String(e) });",
     '      skipped.push({ provider: name, reason: e instanceof Error ? e.message : String(e) });'),
    ("refresh_all: a failure is reported as a success",
     "      results.push({ provider: name, ok: false, error: e instanceof Error ? e.message : String(e) });",
     "      results.push({ provider: name, ok: true, error: e instanceof Error ? e.message : String(e) });"),

    # --- list_provider_models -------------------------------------------------
    ("models: a provider known only through a static entry is a miss",
     "  if (entry === undefined && !knownInStatic) {",
     "  if (entry === undefined) {"),
    ("models: an unknown provider answers empty rather than erroring",
     "  if (entry === undefined && !knownInStatic) {\n"
     "    throw notFound(`provider ${JSON.stringify(provider)} is not configured`);\n"
     "  }",
     "  if (entry === undefined && !knownInStatic) {\n"
     "    return { provider, discovered: [], hidden: [], static: [], include_hidden: includeHidden,\n"
     "      cache: { fetched_at: null, model_count: 0 } };\n"
     "  }"),
    ("models: hidden entries are dropped instead of split out",
     "    if (visible || includeHidden) discovered.push(discoveredToJson(m, learned));\n"
     "    else hidden.push(discoveredToJson(m, learned));",
     "    if (visible || includeHidden) discovered.push(discoveredToJson(m, learned));"),
    ("models: learned image support is not carried onto the rows",
     "  const learned = readLearnedImageSupport(ctx.config.dirs.cache, provider);",
     "  const learned = undefined;"),
    ("models: the ignore rules are not applied",
     "    const visible = entry === undefined || isVisible(entry.discovery, m.model_id);",
     "    const visible = true as boolean;"),
    ("models: an unregistered provider's models are all hidden",
     "    const visible = entry === undefined || isVisible(entry.discovery, m.model_id);",
     "    const visible = entry !== undefined && isVisible(entry.discovery, m.model_id);"),
    ("models: static entries are filtered by the ignore rules too",
     "  const staticModels = [...ctx.config.models.chat.values()]\n"
     "    .filter((m) => m.providerKey === provider)",
     "  const staticModels = [...ctx.config.models.chat.values()]\n"
     "    .filter((m) => m.providerKey === provider)\n"
     "    .filter((m) => entry === undefined || isVisible(entry.discovery, m.modelId))"),
    ("models: static entries from every provider are returned",
     "    .filter((m) => m.providerKey === provider)\n"
     "    .map((m): ProviderStaticModel => ({\n      source: \"static\",",
     "    .map((m): ProviderStaticModel => ({\n      source: \"static\","),
    ("models: the cache summary counts only what was returned",
     "        : { fetched_at: cache.fetched_at, model_count: cache.models.length },",
     "        : { fetched_at: cache.fetched_at, model_count: discovered.length },"),
    ("models: include_hidden is not echoed back",
     "    include_hidden: includeHidden,",
     "    include_hidden: false,"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/providers.test.ts"], src=SRC)


if __name__ == "__main__":
    sys.exit(main())
