import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listProviderModels, refreshAllProviderModels, refreshOne } from "../src/commands/providers.ts";
import { loadConfig, type LoadedConfig } from "../src/config/loader.ts";
import { refreshPass } from "../src/daemon/auto_discovery.ts";
import { CACHE_VERSION, cachePath, readCacheSync, writeCache } from "../src/llm/discovery.ts";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

afterAll(restoreTestEnv);

const KEY_ENV = "SHORE_TEST_PROVIDER_MODELS_KEY";

async function world(toml: string[]): Promise<{ config: LoadedConfig; fetchImpl: typeof fetch; asked: string[]; found: (provider: string) => string[] | undefined }> {
  setTestEnv(KEY_ENV, "fixture-key");
  const root = await mkdtemp(testTmp("shore-provider-models-"));
  await writeFile(join(root, "config.toml"), `${toml.join("\n")}\n`);
  const config = loadConfig(join(root, "config.toml"), {
    env: { SHORE_CONFIG_DIR: root, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "run") },
    onWarn: () => {},
  });
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    asked.push(new URL(url).host);
    return new Response(JSON.stringify({ data: [{ id: "fresh-a" }, { id: "fresh-b" }] }), { status: 200 });
  }) as typeof fetch;
  return { config, fetchImpl, asked, found: (provider) => readCacheSync(cachePath(config.dirs.cache, provider))?.models.map((model) => model.model_id) };
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
