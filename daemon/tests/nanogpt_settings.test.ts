import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { modelSettings, setModelSetting, type ModelsContext } from "../src/commands/models.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { findEffectiveModel } from "../src/config/effective_catalog.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { applySamplerOverlay, configView } from "../src/config/preferences.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { testTmp } from "./support/tmp.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function context(defaults: Record<string, unknown> = {}): Promise<ModelsContext> {
  const root = await mkdtemp(testTmp("shore-nanogpt-settings-"));
  roots.push(root);
  const dataDir = join(root, "data");
  return {
    dataDir, characterName: "ada", activeModel: undefined,
    config: {
      app: defaultAppConfig(), models: emptyCatalog(),
      providers: ProviderRegistry.fromSection({ nanogpt: { defaults } }), rawTable: undefined,
      dirs: { data: dataDir, config: join(root, "config"), cache: join(root, "cache"), runtime: join(root, "runtime") },
    },
  };
}

const CLAUDE = "nanogpt:anthropic/claude-opus-4-6";
const GEMINI = "nanogpt:google/gemini-flash-latest";

test.each([CLAUDE, GEMINI, "nanogpt:deepseek/deepseek-v4.1-flash"])("%s has no built-in keepalive cadence", async (name) => {
  const ctx = await context();
  const model = findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, name, true);
  expect(model.cacheKeepalive).toBeUndefined();
});

test("provider-wide caching settings only arm Claude models", async () => {
  const ctx = await context({ cache_ttl: "1h", cache_keepalive: "55m" });
  const resolve = (name: string) => findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, name, true);
  expect(resolve(CLAUDE).cacheKeepalive?.kind).toBe("every");
  expect(resolve(GEMINI).cacheKeepalive).toEqual({ kind: "off" });
});

test("setting a TTL then opting in uses the saved TTL and survives a reload", async () => {
  const ctx = await context();
  expect(() => setModelSetting(ctx, { name: CLAUDE, key: "cache_keepalive", value: "55m" })).toThrow("cache_ttl");
  setModelSetting(ctx, { name: CLAUDE, key: "cache_ttl", value: "1h" });
  expect(() => setModelSetting(ctx, { name: CLAUDE, key: "cache_keepalive", value: "55m" })).not.toThrow();
  const settings = modelSettings(ctx, { name: CLAUDE }) as { effective_sampler: Record<string, unknown> };
  expect(settings.effective_sampler["cache_keepalive"]).toBe("55m");
  expect(() => setModelSetting(ctx, { name: CLAUDE, key: "cache_keepalive", value: "1h" })).toThrow("shorter");
  setModelSetting(ctx, { name: CLAUDE, key: "cache_ttl", value: "5m" });
  const shorter = modelSettings(ctx, { name: CLAUDE }) as { effective_sampler: Record<string, unknown> };
  expect(shorter.effective_sampler["cache_keepalive"]).toBe("off");
});

test("implicit-cache models reject enabling keepalive but always allow disabling it", async () => {
  const ctx = await context({ cache_ttl: "1h" });
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "cache_keepalive", value: "55m" })).toThrow("not applicable");
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "cache_keepalive", value: "off" })).not.toThrow();
  const settings = modelSettings(ctx, { name: GEMINI }) as { setting_schema: Array<{ key: string; applicability: string }> };
  expect(settings.setting_schema.find((setting) => setting.key === "cache_keepalive")?.applicability).toBe("ignored");
});

test("native Gemini is rejected when setting or loading a NanoGPT override", async () => {
  const ctx = await context();
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "sdk", value: "gemini" })).toThrow('sdk = "nanogpt"');
  const model = findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, GEMINI, true);
  expect(() => applySamplerOverlay(model, { sdk: "gemini" })).toThrow('sdk = "nanogpt"');
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "sdk", value: "nanogpt" })).not.toThrow();
});
