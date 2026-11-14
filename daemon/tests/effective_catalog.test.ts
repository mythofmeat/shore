import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { findEffectiveModel, listEffectiveModels } from "../src/config/effective_catalog.ts";
import { loadConfig } from "../src/config/loader.ts";
import { CACHE_VERSION, cachePath, writeCache } from "../src/llm/discovery.ts";
import { testTmp } from "./support/tmp.ts";

async function catalog(toml: string[], discovered: Record<string, string[]>): Promise<{
  find: (name: string, includeHidden?: boolean) => string;
  list: (includeHidden?: boolean) => unknown[];
}> {
  const root = await mkdtemp(testTmp("shore-effective-catalog-"));
  await writeFile(join(root, "config.toml"), `${toml.join("\n")}\n`);
  const config = loadConfig(join(root, "config.toml"), {
    env: { SHORE_CONFIG_DIR: root, XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "run") },
    onWarn: () => {},
  });
  for (const [provider, ids] of Object.entries(discovered)) {
    await writeCache(cachePath(config.dirs.cache, provider), {
      version: CACHE_VERSION, provider_key: provider, fetched_at: "2026-11-12T10:00:00Z",
      models: ids.map((id) => ({ provider_key: provider, model_id: id, sdk: "openai", discovered_at: "2026-11-12T10:00:00Z" })),
    });
  }
  return {
    find: (name, includeHidden = false) => findEffectiveModel(config, config.dirs.cache, name, includeHidden).qualifiedName,
    list: (includeHidden = false) => listEffectiveModels(config, config.dirs.cache, includeHidden).map((model) => [model.resolved.qualifiedName, model.source, model.hidden]),
  };
}

const PROVIDERS = [
  "[providers.openrouter]", 'api_key_env = "K"', "discover = true", 'ignore_models = ["tucked-*", "!tucked-shown"]',
  "[providers.deepseek]", 'api_key_env = "K"', "discover = true",
  "[providers.nanogpt]", 'api_key_env = "K"', 'ignore_models = ["quiet-*"]',
  "[providers.moonshotai]", 'api_key_env = "K"', "discover = true", "enabled = false",
  '[chat."deepseek:written"]', "max_output_tokens = 100",
];
const DISCOVERED = {
  openrouter: ["open-a", "tucked-away", "tucked-shown", "shared"],
  deepseek: ["deep-a", "shared", "written"],
  nanogpt: ["nano-a", "quiet-one"],
  moonshotai: ["moon-a"],
};

test("the models on offer are the ones written in the config and the ones a provider with discover on has found, less those its ignore_models hides", async () => {
  const { list } = await catalog(PROVIDERS, DISCOVERED);
  expect(list()).toEqual([
    ["deepseek:written", "static", false],
    ["deepseek:deep-a", "discovered", false], ["deepseek:shared", "discovered", false],
    ["openrouter:open-a", "discovered", false], ["openrouter:shared", "discovered", false], ["openrouter:tucked-shown", "discovered", false],
  ]);
  expect(list(true)).toEqual([
    ["deepseek:written", "static", false],
    ["deepseek:deep-a", "discovered", false], ["deepseek:shared", "discovered", false],
    ["openrouter:open-a", "discovered", false], ["openrouter:shared", "discovered", false], ["openrouter:tucked-away", "discovered", true], ["openrouter:tucked-shown", "discovered", false],
  ]);
});

test("a model asked for by provider and id is found unless ignore_models hides it, and ignore_models counts only while discover is on", async () => {
  const { find } = await catalog(PROVIDERS, DISCOVERED);
  expect([find("openrouter:open-a"), find("openrouter:tucked-shown"), find("openrouter:never-listed"), find("nanogpt:quiet-one"), find("nanogpt:quiet-unlisted")])
    .toEqual(["openrouter:open-a", "openrouter:tucked-shown", "openrouter:never-listed", "nanogpt:quiet-one", "nanogpt:quiet-unlisted"]);
  expect(() => find("openrouter:tucked-away")).toThrow(
    'model "openrouter:tucked-away" is hidden by providers.openrouter.ignore_models; pass include_hidden=true or update the ignore rules to allow it',
  );
  expect(() => find("openrouter:tucked-unlisted")).toThrow('model "openrouter:tucked-unlisted" is hidden by providers.openrouter.ignore_models');
  expect([find("openrouter:tucked-away", true), find("openrouter:tucked-unlisted", true)]).toEqual(["openrouter:tucked-away", "openrouter:tucked-unlisted"]);
});

test("a model asked for by id alone is looked for among what each enabled provider with discover on has found", async () => {
  const { find } = await catalog(PROVIDERS, DISCOVERED);
  expect([find("open-a"), find("deep-a"), find("written"), find("tucked-shown")]).toEqual(["openrouter:open-a", "deepseek:deep-a", "deepseek:written", "openrouter:tucked-shown"]);
  expect(() => find("shared")).toThrow('model name "shared" is ambiguous across providers: deepseek:shared, openrouter:shared');
  expect(() => find("tucked-away")).toThrow('model "tucked-away" is hidden by providers.openrouter.ignore_models');
  expect(find("tucked-away", true)).toBe("openrouter:tucked-away");
  for (const unseen of ["nano-a", "moon-a", "nowhere"]) expect(() => find(unseen)).toThrow(`model ${JSON.stringify(unseen)} not found in static catalog or discovered models`);
});
