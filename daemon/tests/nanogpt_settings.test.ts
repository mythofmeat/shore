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

test("a provider's defaults in config.toml cannot carry a keepalive", () => {
  expect(() => ProviderRegistry.fromSection({ nanogpt: { defaults: { cache_keepalive: "55m" } } })).toThrow("cache_keepalive");
  expect(() => ProviderRegistry.fromSection({ nanogpt: { defaults: { cache_keepalive_for: "12h" } } })).toThrow("cache_keepalive_for");
});

test("a keepalive needs no TTL, and only warns when it cannot beat a known one", async () => {
  const ctx = await context();
  const untimed = setModelSetting(ctx, { name: CLAUDE, key: "cache_keepalive", value: "55m" }) as Record<string, unknown>;
  expect(untimed["warning"]).toBeUndefined();

  setModelSetting(ctx, { name: CLAUDE, key: "cache_ttl", value: "1h" });
  const late = setModelSetting(ctx, { name: CLAUDE, key: "cache_keepalive", value: "1h" }) as Record<string, unknown>;
  expect(late["warning"]).toContain("1h cache TTL");
  const shortened = setModelSetting(ctx, { name: CLAUDE, key: "cache_ttl", value: "5m" }) as Record<string, unknown>;
  expect(shortened["warning"]).toContain("5m cache TTL");

  const settings = modelSettings(ctx, { name: CLAUDE }) as { effective_sampler: Record<string, unknown> };
  expect(settings.effective_sampler["cache_keepalive"], "a warning never rewrites what was set").toBe("1h");
});

test("a TTL written in other units is judged by the value that gets stored", async () => {
  const ctx = await context();
  setModelSetting(ctx, { name: CLAUDE, key: "cache_keepalive", value: "55m" });
  const hour = setModelSetting(ctx, { name: CLAUDE, key: "cache_ttl", value: "60m" }) as Record<string, unknown>;
  expect(hour["warning"]).toBeUndefined();
});

test("implicit-cache models take a keepalive like any other", async () => {
  const ctx = await context({ cache_ttl: "1h" });
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "cache_keepalive", value: "55m" })).not.toThrow();
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "cache_keepalive_pings", value: "3" })).not.toThrow();
  const settings = modelSettings(ctx, { name: GEMINI }) as {
    effective_sampler: Record<string, unknown>;
    setting_schema: Array<{ key: string; applicability: string }>;
  };
  expect(settings.effective_sampler["cache_keepalive"]).toBe("55m");
  expect(settings.effective_sampler["cache_keepalive_pings"]).toBe(3);
  expect(settings.setting_schema.find((setting) => setting.key === "cache_keepalive")?.applicability).toBe("always");
  expect(settings.setting_schema.find((setting) => setting.key === "cache_keepalive_pings")?.applicability).toBe("always");
});

test("native Gemini is rejected when setting or loading a NanoGPT override", async () => {
  const ctx = await context();
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "sdk", value: "gemini" })).toThrow('sdk = "nanogpt"');
  const model = findEffectiveModel(configView(ctx.config), ctx.config.dirs.cache, GEMINI, true);
  expect(() => applySamplerOverlay(model, { sdk: "gemini" })).toThrow('sdk = "nanogpt"');
  expect(() => setModelSetting(ctx, { name: GEMINI, key: "sdk", value: "nanogpt" })).not.toThrow();
});
