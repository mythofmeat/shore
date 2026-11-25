import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listProviderModels, refreshAllProviderModels, refreshOne } from "../src/commands/providers.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { refreshPass } from "../src/daemon/auto_discovery.ts";
import { configureClaudePlanLimits } from "../src/ledger/plan_limits.ts";
import { CACHE_VERSION, cachePath, readCacheSync, writeCache } from "../src/llm/discovery.ts";
import type { ClaudeAgentModelQuery } from "../src/llm/providers/claude_agent_models.ts";
import { restoreTestEnv, setTestEnv, unsetTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(() => {
  restoreTestEnv();
  configureClaudePlanLimits();
});

const KEY_ENV = "SHORE_TEST_PROVIDER_MODELS_KEY";

type Answer = (url: URL) => Response | Promise<Response>;

const roster: Answer = () => Response.json({ data: [{ id: "fresh-a" }, { id: "fresh-b" }] });

async function world(toml: string[], answer: Answer = roster): Promise<{ config: LoadedConfig; fetchImpl: typeof fetch; asked: string[]; requests: string[]; found: (provider: string) => string[] | undefined }> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-provider-models-"));
  await writeFile(join(root, "config.toml"), `${toml.join("\n")}\n`);
  const config = loadConfig(join(root, "config.toml"), {
    env: { SHORE_CONFIG_DIR: root, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "run") },
    onWarn: () => {},
  });
  const asked: string[] = [];
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    asked.push(url.host);
    requests.push([url.toString(), ...["authorization", "x-api-key", "x-goog-api-key"].flatMap((name) => (headers.has(name) ? [`${name}: ${String(headers.get(name))}`] : []))].join(" "));
    return await answer(url);
  }) as typeof fetch;
  return { config, fetchImpl, asked, requests, found: (provider) => readCacheSync(cachePath(config.dirs.cache, provider))?.models.map((model) => model.model_id) };
}

async function remembered(config: LoadedConfig, provider: string, ids: string[], fetchedAt: string): Promise<void> {
  await writeCache(cachePath(config.dirs.cache, provider), {
    version: CACHE_VERSION, provider_key: provider, fetched_at: fetchedAt,
    models: ids.map((id) => ({ provider_key: provider, model_id: id, sdk: "openai", discovered_at: fetchedAt })),
  });
}

const PROVIDERS = [
  "[providers.on]", 'base_url = "https://on.example/v1"', `api_key_env = "${KEY_ENV}"`, "discover = true", 'ignore_models = ["tucked-*"]',
  "[providers.off]", 'base_url = "https://off.example/v1"', `api_key_env = "${KEY_ENV}"`,
  "[providers.resting]", 'base_url = "https://resting.example/v1"', `api_key_env = "${KEY_ENV}"`, "discover = true", "enabled = false",
  '[chat."written:model-w"]', "max_output_tokens = 100",
];

test("a provider's models are fetched only while its discover is on: asking for one that is off is refused, and refreshing them all skips it", async () => {
  const w = await world(PROVIDERS);
  const fetched = await refreshOne(w.config, w.config.dirs.cache, "on", w.fetchImpl);
  expect([fetched.cache.models.map((model) => model.model_id), w.found("on")]).toEqual([["fresh-a", "fresh-b"], ["fresh-a", "fresh-b"]]);
  expect(await outcomeOf(refreshOne(w.config, w.config.dirs.cache, "off", w.fetchImpl))).toThrow('provider "off" has discovery disabled');
  expect(await outcomeOf(refreshOne(w.config, w.config.dirs.cache, "resting", w.fetchImpl))).toThrow('provider "resting" is disabled');

  w.asked.length = 0;
  const all = await refreshAllProviderModels({ config: w.config, fetchImpl: w.fetchImpl });
  expect(all.results.map((result) => [result.provider, result.ok, result.ok ? result.model_count : result.error])).toEqual([["on", true, 2]]);
  expect(all.skipped).toEqual([{ provider: "off", reason: "discovery disabled" }, { provider: "resting", reason: "disabled" }]);
  expect([w.asked, w.found("off"), w.found("resting")]).toEqual([["on.example"], undefined, undefined]);
});

test("the models found on their own are fetched again only for enabled providers with discover on whose list is missing or a day old", async () => {
  const w = await world([
    ...PROVIDERS,
    "[providers.recent]", 'base_url = "https://recent.example/v1"', `api_key_env = "${KEY_ENV}"`, "discover = true",
    "[providers.old]", 'base_url = "https://old.example/v1"', `api_key_env = "${KEY_ENV}"`, "discover = true",
  ]);
  await remembered(w.config, "recent", ["kept"], new Date().toISOString());
  await remembered(w.config, "old", ["stale"], "2026-01-01T00:00:00Z");
  await remembered(w.config, "off", ["untouched"], "2026-01-01T00:00:00Z");
  await remembered(w.config, "resting", ["untouched"], "2026-01-01T00:00:00Z");
  const said: unknown[] = [];
  await refreshPass({
    config: () => w.config, fetchImpl: w.fetchImpl,
    log: { info: (message, fields) => said.push([message, fields]), warn: (message, fields) => said.push(["warning", message, fields]) },
  });
  expect(said).toEqual([
    ["Auto-refreshed provider models", { provider: "old", models: 2 }],
    ["Auto-refreshed provider models", { provider: "on", models: 2 }],
  ]);
  expect(w.asked.toSorted()).toEqual(["old.example", "on.example"]);
  expect([w.found("on"), w.found("old"), w.found("recent"), w.found("off"), w.found("resting")])
    .toEqual([["fresh-a", "fresh-b"], ["fresh-a", "fresh-b"], ["kept"], ["untouched"], ["untouched"]]);
});

test("a provider's model list sets apart the ones its ignore_models hides, and a provider known only from a written model has none hidden", async () => {
  const w = await world(PROVIDERS);
  await remembered(w.config, "on", ["open-a", "tucked-away"], "2026-11-12T10:00:00Z");
  await remembered(w.config, "written", ["tucked-other"], "2026-11-12T10:00:00Z");
  const ids = (provider: string, includeHidden?: boolean): unknown[] => {
    const listed = listProviderModels({ config: w.config }, { provider, ...(includeHidden === undefined ? {} : { include_hidden: includeHidden }) });
    return [listed.discovered.map((model) => model.model_id), listed.hidden.map((model) => model.model_id), listed.static.map((model) => model.model_id), listed.cache.model_count];
  };
  expect(ids("on")).toEqual([["open-a"], ["tucked-away"], [], 2]);
  expect(ids("on", true)).toEqual([["open-a", "tucked-away"], [], [], 2]);
  expect(ids("written")).toEqual([["tucked-other"], [], ["model-w"], 1]);
  expect(() => ids("nowhere")).toThrow('provider "nowhere" is not configured');
});

const GEMINI_MODELS = {
  models: [
    { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", description: "Thinks first", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
    { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-004", inputTokenLimit: 2048, supportedGenerationMethods: ["embedContent"] },
    { name: "models/aqa" },
    { supportedGenerationMethods: ["generateContent"] },
    null,
  ],
};

const GEMINI = ["[providers.gemini]", `api_key_env = "${KEY_ENV}"`, "discover = true"];

test("a gemini provider's models come from Google's own list with no base_url: only the ones that write text, by the names shore calls them, with their limits", async () => {
  const w = await world(GEMINI, () => Response.json(GEMINI_MODELS));
  const all = await refreshAllProviderModels({ config: w.config, fetchImpl: w.fetchImpl });
  expect(all.results.map((result) => [result.provider, result.ok ? result.model_count : result.error])).toEqual([["gemini", 2]]);
  expect(w.requests).toEqual(["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000 x-goog-api-key: fixture-key"]);
  const cache = readCacheSync(cachePath(w.config.dirs.cache, "gemini"));
  expect(cache?.base_url).toBeUndefined();
  expect(cache?.models.map((model) => [model.model_id, model.display_name, model.description, model.sdk, model.base_url, model.context_length, model.max_output_tokens, model.supports_reasoning])).toEqual([
    ["gemini-3-pro", "Gemini 3 Pro", "Thinks first", "gemini", undefined, 1048576, 65536, true],
    ["gemini-2.0-flash", "Gemini 2.0 Flash", undefined, "gemini", undefined, 1048576, 8192, undefined],
  ]);
  expect(listProviderModels({ config: w.config }, { provider: "gemini" }).discovered.map((model) => model.model_id)).toEqual(["gemini-3-pro", "gemini-2.0-flash"]);
});

test("a gemini provider with a base_url of its own is asked there, and the models found there keep it", async () => {
  const w = await world([...GEMINI, 'base_url = "https://proxy.example/gemini"'], () => Response.json(GEMINI_MODELS));
  const fetched = await refreshOne(w.config, w.config.dirs.cache, "gemini", w.fetchImpl);
  expect(w.requests).toEqual(["https://proxy.example/gemini/v1beta/models?pageSize=1000 x-goog-api-key: fixture-key"]);
  expect([fetched.cache.base_url, ...fetched.cache.models.map((model) => model.base_url)]).toEqual(["https://proxy.example/gemini", "https://proxy.example/gemini", "https://proxy.example/gemini"]);
});

test("when Google's model list can't be fetched or read, refreshing says which and keeps the list it had", async () => {
  const cases: [Answer, string][] = [
    [() => { throw new Error("connection refused"); }, "provider gemini: network error: Error: connection refused"],
    [() => Response.json({ error: { code: 403, message: "PERMISSION_DENIED" } }, { status: 403 }), "provider gemini: discovery HTTP 403"],
    [() => new Response("<html>"), "provider gemini: failed to parse models response: SyntaxError"],
    [() => Response.json({}), "provider gemini: failed to parse models response: `models` is not an array"],
  ];
  for (const [answer, message] of cases) {
    const w = await world(GEMINI, answer);
    await remembered(w.config, "gemini", ["kept"], "2026-01-01T00:00:00Z");
    expect(await outcomeOf(refreshOne(w.config, w.config.dirs.cache, "gemini", w.fetchImpl))).toThrow(message);
    expect(w.found("gemini")).toEqual(["kept"]);
  }
});

test("each kind of provider is asked for its models its own way, and one shore can't ask says what it lacks", async () => {
  unsetTestEnv("SHORE_TEST_PROVIDER_MODELS_UNSET");
  configureClaudePlanLimits({ home: await mkdtemp(testTmp("shore-provider-models-home-")) });
  const w = await world([
    "[providers.anthropic]", `api_key_env = "${KEY_ENV}"`, "discover = true",
    "[providers.on]", 'base_url = "https://on.example/v1"', `api_key_env = "${KEY_ENV}"`, "discover = true",
    "[providers.keyless]", 'base_url = "https://keyless.example/v1"', 'api_key_env = "SHORE_TEST_PROVIDER_MODELS_UNSET"', "discover = true",
    "[providers.bare]", 'sdk = "openai"', `api_key_env = "${KEY_ENV}"`, "discover = true",
    "[providers.claude_agent]", "discover = true",
  ]);
  const runClaudeAgentQuery = (() => ({
    supportedModels: () => Promise.resolve([{ value: "opus", displayName: "Opus", description: "Most capable" }]),
    close: () => {},
  })) as unknown as ClaudeAgentModelQuery;
  const all = await refreshAllProviderModels({ config: w.config, fetchImpl: w.fetchImpl, runClaudeAgentQuery });
  expect(all.results.map((result) => [result.provider, result.ok ? result.model_count : result.error])).toEqual([
    ["anthropic", 2],
    ["bare", 'provider "bare" has no base_url; required for provider discovery'],
    ["claude_agent", 1],
    ["keyless", 'provider "keyless" has no API key configured (no enabled key\'s env var is set)'],
    ["on", 2],
  ]);
  expect(w.requests).toEqual(["https://api.anthropic.com/v1/models x-api-key: fixture-key", "https://on.example/v1/models authorization: Bearer fixture-key"]);
  expect([w.found("anthropic"), w.found("claude_agent")]).toEqual([["fresh-a", "fresh-b"], ["opus"]]);
});
