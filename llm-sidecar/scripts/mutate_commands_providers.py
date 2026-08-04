#!/usr/bin/env python3
"""Mutation pass over the provider discovery commands (#18 / #12).

#12 requires every parity fixture be mutation-checked. Two of this module's
failure modes are worse than an error:

- **Leaking a credential.** `list_providers` is a diagnostic the user runs and
  pastes into a bug report. It must report *whether* a key's env var is set and
  nothing else — not the variable's name, not the value, not a prefix.
- **Losing a cache.** A refresh that fails must leave the previous cache exactly
  as it was. Writing on the failure path would replace a good model list with an
  empty one, and nothing would report an error afterwards; the daemon would just
  quietly know about fewer models than it did before.

A mutant is KILLED if `bun test tests/providers_parity.test.ts` fails with it
applied.

The first pass was 38/49 and the third is 49/49. Nine of the eleven first-pass
survivors were real gaps (two were mis-typed patterns of mine), and closing four
of them needed the *upstream* to start caring what it was sent — the key value
never appears in any payload, so which key was chosen is unobservable against a
server that answers everything:

- **No listing case had a key whose env var held only whitespace**, so "blank
  counts as unset" and "any value counts as set" agreed everywhere.
- **The hidden and visible counts were equal** (two models, one hidden), so
  inverting the filter changed nothing. The cache has three models now.
- **No provider had two usable keys.** Both refresh cases had exactly one, so
  first-vs-last could not differ. There is now a provider with two, against an
  upstream that accepts only the first one's value.
- **No provider had a disabled key holding a usable value**, so skipping
  disabled keys was untested.
- **No provider had both a configured base_url and a built-in default**, so
  which one wins was invisible; and no provider took its *sdk* from a built-in
  default either. Both are now one case: a provider named `anthropic` with a
  configured base_url, against an upstream that demands the `x-api-key` header
  only the anthropic adapter sends. A wrong base url 502s and a wrong sdk 401s.
- **`include_hidden` was only ever `true` or absent**, so `as_bool` semantics —
  a `1` or a `"true"` is *absent*, not truthy — went unpinned.
- **No cache existed for a provider with no registry entry**, so "no entry means
  nothing is hidden" had nothing to act on, and **no static entry matched an
  ignore rule**, so "statics are never filtered" was equally free.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_commands_providers.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src/commands/providers.ts"

# (label, find, replace)
MUTANTS = [
    # --- argument handling ---------------------------------------------------
    ("provider: an empty string is a provider",
     '  if (provider === undefined || provider === "") {',
     "  if (provider === undefined) {"),
    ("include_hidden: any truthy value opts in",
     '  const includeHidden = args["include_hidden"] === true;',
     '  const includeHidden = Boolean(args["include_hidden"]);'),
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
    ("listing: an unset sdk reports as its default rather than null",
     "      sdk: entry.sdk ?? null,",
     "      sdk: entry.sdk ?? defaultSdk(name),"),

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
     '    sdk === "anthropic"\n'
     "      ? await discoverAnthropic(provider, baseUrl, key, fetchImpl)\n"
     "      : await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);",
     "    await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);"),
    ("refresh: every sdk takes the anthropic path",
     '    sdk === "anthropic"\n'
     "      ? await discoverAnthropic(provider, baseUrl, key, fetchImpl)\n"
     "      : await discoverOpenAiCompatible(provider, baseUrl, key, fetchImpl);",
     "    await discoverAnthropic(provider, baseUrl, key, fetchImpl);"),
    ("refresh: the sdk default is not consulted",
     "  const sdk = entry.sdk ?? defaultSdk(provider);",
     '  const sdk = entry.sdk ?? "openai";'),

    # --- the cache write ------------------------------------------------------
    ("refresh: a failed discovery still writes a cache",
     '  if ("err" in discovered) {\n'
     "    // The previous cache stands.\n"
     "    throw internalError(describeDiscoveryError(discovered.err));\n"
     "  }",
     '  if ("err" in discovered) {\n'
     "    await writeCache(cachePath(cacheDir, provider), {\n"
     "      version: CACHE_VERSION,\n"
     "      provider_key: provider,\n"
     "      fetched_at: toRfc3339(Date.now()),\n"
     "      base_url: baseUrl,\n"
     "      models: [],\n"
     "    });\n"
     "    throw internalError(describeDiscoveryError(discovered.err));\n"
     "  }"),
    ("refresh: the discovery error message is replaced",
     "    throw internalError(describeDiscoveryError(discovered.err));",
     '    throw internalError("discovery failed");'),
    ("refresh: the base url is not recorded in the cache",
     "    base_url: baseUrl,\n    models: discovered.ok,",
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
     "      results.push({ provider: name, ok: false, error: (e as Error).message });\n"
     "    }",
     "    } catch (e) {\n"
     "      throw e;\n"
     "    }"),
    ("refresh_all: a failure is reported as a skip",
     "      results.push({ provider: name, ok: false, error: (e as Error).message });",
     '      skipped.push({ provider: name, reason: (e as Error).message });'),
    ("refresh_all: a failure is reported as a success",
     "      results.push({ provider: name, ok: false, error: (e as Error).message });",
     "      results.push({ provider: name, ok: true, error: (e as Error).message });"),

    # --- list_provider_models -------------------------------------------------
    ("models: a provider known only through a static entry is a miss",
     "  if (entry === undefined && !knownInStatic) {",
     "  if (entry === undefined) {"),
    ("models: an unknown provider answers empty rather than erroring",
     "    throw notFound(`provider ${JSON.stringify(provider)} is not configured`);\n  }\n\n  const cache",
     "    return { provider, discovered: [], hidden: [], static: [], include_hidden: includeHidden,\n"
     "      cache: { fetched_at: null, model_count: 0 } };\n  }\n\n  const cache"),
    ("models: hidden entries are dropped instead of split out",
     "    if (visible || includeHidden) discovered.push(discoveredToJson(m));\n"
     "    else hidden.push(discoveredToJson(m));",
     "    if (visible || includeHidden) discovered.push(discoveredToJson(m));"),
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
     "    .map((m) => ({\n      source: \"static\",",
     "    .map((m) => ({\n      source: \"static\","),
    ("models: the cache summary counts only what was returned",
     "        : { fetched_at: cache.fetched_at, model_count: cache.models.length },",
     "        : { fetched_at: cache.fetched_at, model_count: discovered.length },"),
    ("models: include_hidden is not echoed back",
     "    include_hidden: includeHidden,",
     "    include_hidden: false,"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/providers_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = SRC.read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        SRC.write_text(original.replace(find, replace, 1))
        killed = not run()
        SRC.write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    SRC.write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
