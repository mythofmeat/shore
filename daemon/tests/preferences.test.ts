import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fixture from "./config_fixtures/preferences.json" with { type: "json" };

import { catalogFromSections, type ResolvedModel } from "../src/config/models.ts";
import {
  ProviderRegistry,
  ProviderRegistryError,
  defaultDiscovery,
  globMatches,
  isVisible,
  type ProviderEntry,
} from "../src/config/providers.ts";
import {
  PreferenceError,
  applySamplerOverlay,
  emptyPreferences,
  findStaticModel,
  keepaliveOrUndefined,
  loadPreferences,
  preferenceKey,
  preferencesAreEmpty,
  resolveActiveForCharacter,
  resolveBackgroundModel,
  resolveChatModelForCharacter,
  resolveSamplerScopes,
  resolveSamplerSettings,
  resolveSelectedModel,
  setModelPreference,
  savePreferences,
  selectionIsSet,
  selectionKey,
  serializePreferences,
  type BackgroundTask,
  type LoadedConfigView,
  type ModelPreferences,
  type SamplerSettings,
} from "../src/config/preferences.ts";
import {
  EffectiveCatalogError,
  findEffectiveModel,
  listEffectiveModels,
} from "../src/config/effective_catalog.ts";

interface GlobRow {
  pattern: string;
  input: string;
  matches: boolean;
}
interface VisibilityRow {
  ignore: string[];
  model_id: string;
  visible: boolean;
}
interface RegistryRow {
  name: string;
  toml: string;
  entries?: { provider: string; entry: Record<string, unknown> }[];
  err?: string;
}
interface PrefFileRow {
  name: string;
  toml: string;
  parsed?: Record<string, unknown>;
  is_empty?: boolean;
  model_keys?: string[];
  selected_key?: string | null;
  serialized?: string;
  round_trips?: boolean;
  err?: string;
}
interface ResolveRow {
  name: string;
  global_toml: string;
  character_toml: string;
  provider: string;
  model_id: string;
  use_static: boolean;
  settings: Record<string, unknown>;
  scopes: string;
  selected: [string, string] | null;
  patched: Record<string, unknown> | null;
}
interface EffRow {
  name: string;
  chat_toml: string;
  providers_toml: string;
  caches: { provider: string; body: string }[];
  lookups: {
    name: string;
    include_hidden: boolean;
    resolved?: Record<string, unknown>;
    err?: string;
  }[];
  listed: { source: string; qualified_name: string; hidden: boolean }[];
  listed_include_hidden: { source: string; qualified_name: string; hidden: boolean }[];
}
interface ActiveRow {
  name: string;
  global_toml: string;
  character_toml: string;
  legacy_active_model: string | null;
  app_default_model: string | null;
  qualified_name: string | null;
}
interface BackgroundRow {
  name: string;
  background_toml: string;
  character_prefs: string;
  heartbeat: { qualified_name: string; max_output_tokens: number | null } | null;
  chat: { qualified_name: string; max_output_tokens: number | null } | null;
}

const fx = fixture as unknown as {
  glob: GlobRow[];
  visibility: VisibilityRow[];
  registry: RegistryRow[];
  preference_files: PrefFileRow[];
  missing_file_is_empty: Record<string, unknown>;
  resolve_sampler: ResolveRow[];
  preference_key: { provider: string; model_id: string; key: string }[];
  effective_catalog: EffRow[];
  active_model: ActiveRow[];
  background_model: BackgroundRow[];
};

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "prefs-parity-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function parseToml(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return undefined;
  return Bun.TOML.parse(text) as Record<string, unknown>;
}

function samplerToWire(s: SamplerSettings): Record<string, unknown> {
  return {
    temperature: s.temperature ?? null,
    top_p: s.topP ?? null,
    reasoning_effort: s.reasoningEffort ?? null,
    budget_tokens: s.budgetTokens ?? null,
    max_output_tokens: s.maxOutputTokens ?? null,
    cache_ttl: s.cacheTtl ?? null,
    cache_keepalive: keepaliveOrUndefined(s.cacheKeepalive) ?? null,
    sdk: s.sdk ?? null,
    replay_prior_thinking: s.replayPriorThinking ?? null,
    max_tool_iterations: s.maxToolIterations ?? null,
    openrouter_provider: s.openrouterProvider ?? null,
    gemini_generation: s.geminiGeneration ?? null,
    zai_clear_thinking: s.zaiClearThinking ?? null,
    zai_subscription: s.zaiSubscription ?? null,
  };
}

function modelToWire(m: ResolvedModel): Record<string, unknown> {
  return {
    name: m.name,
    qualified_name: m.qualifiedName,
    category: m.category,
    provider_key: m.providerKey,
    sdk: m.sdk,
    model_id: m.modelId,
    api_key_env: m.apiKeyEnv ?? null,
    base_url: m.baseUrl ?? null,
    max_context_tokens: m.maxContextTokens ?? null,
    max_output_tokens: m.maxOutputTokens ?? null,
    temperature: m.temperature ?? null,
    top_p: m.topP ?? null,
    reasoning_effort: m.reasoningEffort ?? null,
    budget_tokens: m.budgetTokens ?? null,
    cache_ttl: m.cacheTtl ?? null,
    cache_keepalive: keepaliveOrUndefined(m.cacheKeepalive) ?? null,
    openrouter_provider: m.openrouterProvider ?? null,
    gemini_generation: m.geminiGeneration ?? null,
    zai_clear_thinking: m.zaiClearThinking ?? null,
    zai_subscription: m.zaiSubscription ?? null,
    replay_prior_thinking: m.replayPriorThinking ?? null,
    max_tool_iterations: m.maxToolIterations ?? null,
  };
}

function prefsToWire(p: ModelPreferences): Record<string, unknown> {
  return {
    selected: {
      provider: p.selected.provider ?? null,
      model_id: p.selected.modelId ?? null,
    },
    defaults: { sampler: samplerToWire(p.defaults.sampler) },
    models: Object.fromEntries(
      [...p.models].map(([k, v]) => [k, samplerToWire(v.sampler)]),
    ),
  };
}

function semanticTail(message: string): string {
  const lines = message.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] as string;
  return last.replace(/^failed to parse .*?: /, "");
}

function parseScopes(debug: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, field, scope] of debug.matchAll(/(\w+): Some\((\w+)\)/g)) {
    out[field as string] = (scope as string)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
  }
  return out;
}

const SCOPE_TOML_KEYS: Record<string, string> = {
  temperature: "temperature",
  topP: "top_p",
  reasoningEffort: "reasoning_effort",
  budgetTokens: "budget_tokens",
  maxOutputTokens: "max_output_tokens",
  cacheTtl: "cache_ttl",
  cacheKeepalive: "cache_keepalive",
  sdk: "sdk",
  replayPriorThinking: "replay_prior_thinking",
  maxToolIterations: "max_tool_iterations",
  openrouterProvider: "openrouter_provider",
  geminiGeneration: "gemini_generation",
  zaiClearThinking: "zai_clear_thinking",
  zaiSubscription: "zai_subscription",
};

function prefsFrom(text: string): ModelPreferences {
  if (text.trim() === "") return emptyPreferences();
  const root = tempRoot();
  const path = join(root, "models.toml");
  writeFileSync(path, text);
  return loadPreferences(path);
}

const STATIC_CHAT = `
[anthropic.opus]
model_id = "claude-opus-4-6"

[anthropic.sonnet]
model_id = "claude-sonnet-4-6"
`;

function buildConfig(
  chat: string,
  providers: string,
  root: string,
  backgroundModel?: (task: BackgroundTask) => string | undefined,
  defaultModel?: string,
): LoadedConfigView {
  const registry = ProviderRegistry.fromSection(parseToml(providers));
  const catalog = catalogFromSections(parseToml(chat), undefined, undefined, registry);
  const app: LoadedConfigView["app"] = {
    defaults: { backgroundModelName: backgroundModel ?? (() => undefined) },
  };
  if (defaultModel !== undefined) app.defaults.model = defaultModel;
  return {
    models: catalog,
    providers: registry,
    dirs: { data: join(root, "data"), cache: join(root, "cache") },
    app,
  };
}

function catchError<T extends Error>(ctor: new (...args: never[]) => T, fn: () => unknown): T {
  try {
    fn();
  } catch (e) {
    if (e instanceof ctor) return e;
    throw e;
  }
  throw new Error(`expected a ${ctor.name}`);
}

describe("globMatches", () => {
  for (const row of fx.glob) {
    test(`${JSON.stringify(row.pattern)} vs ${JSON.stringify(row.input)}`, () => {
      expect(globMatches(row.pattern, row.input)).toBe(row.matches);
    });
  }

  test("the length guard counts bytes, not UTF-16 units", () => {
    expect(globMatches("*", "🎵")).toBe(true);
    expect("🎵".length).toBe(2);
    expect(Buffer.from("🎵", "utf8").length).toBe(4);
    expect(globMatches("🎵*🎵", "🎵")).toBe(false);
  });
});

describe("isVisible", () => {
  for (const [i, row] of fx.visibility.entries()) {
    test(`${i}: ${JSON.stringify(row.ignore)} vs ${row.model_id}`, () => {
      expect(isVisible({ enabled: true, ignore: [...row.ignore] }, row.model_id)).toBe(row.visible);
    });
  }

  test("the last matching pattern wins", () => {
    expect(isVisible({ enabled: true, ignore: ["!a*", "a*"] }, "abc")).toBe(false);
    expect(isVisible({ enabled: true, ignore: ["a*", "!a*"] }, "abc")).toBe(true);
  });

  test("an empty ignore list shows everything", () => {
    expect(isVisible(defaultDiscovery(), "anything")).toBe(true);
  });
});

describe("ProviderRegistry.fromSection", () => {
  for (const row of fx.registry) {
    test(row.name, () => {
      const build = () => ProviderRegistry.fromSection(parseToml(row.toml));

      if (row.err !== undefined) {
        const error = catchError(ProviderRegistryError, build);
        expect(semanticTail(error.message)).toBe(semanticTail(row.err));
        return;
      }

      const registry = build();
      const entries = row.entries as NonNullable<RegistryRow["entries"]>;
      expect(registry.entries().map(([k]) => k)).toEqual(entries.map((e) => e.provider));

      for (const { provider, entry: want } of entries) {
        const got = registry.get(provider) as ProviderEntry;
        expect(got.enabled).toBe(want["enabled"] as boolean);
        expect(got.sdk ?? null).toBe((want["sdk"] ?? null) as never);
        expect(got.baseUrl ?? null).toBe((want["base_url"] ?? null) as never);
        expect(got.apiKeyEnv).toBeUndefined();
        expect(want["api_key_env"]).toBeNull();
        expect(
          got.keys.map((k) => ({
            name: k.name,
            env: k.env,
            enabled: k.enabled,
            warn_on_fallback: k.warnOnFallback,
          })),
        ).toEqual(want["keys"] as never);
        expect(got.discovery.enabled).toBe(
          (want["discovery"] as Record<string, unknown>)["enabled"] as boolean,
        );
        expect(got.discovery.ignore).toEqual(
          (want["discovery"] as Record<string, unknown>)["ignore"] as never,
        );
      }
    });
  }

  test("entry.enabled defaults true but discovery.enabled defaults false", () => {
    const registry = ProviderRegistry.fromSection(Bun.TOML.parse("[p]\n[p.discovery]\n") as never);
    const entry = registry.get("p") as ProviderEntry;
    expect(entry.enabled).toBe(true);
    expect(entry.discovery.enabled).toBe(false);
  });

  test("the compact key form becomes a synthetic `default` key", () => {
    const registry = ProviderRegistry.fromSection(
      Bun.TOML.parse('[p]\napi_key_env = "MY_KEY"\n') as never,
    );
    const entry = registry.get("p") as ProviderEntry;
    expect(entry.keys).toEqual([
      { name: "default", env: "MY_KEY", enabled: true, warnOnFallback: false },
    ]);
    expect(entry.apiKeyEnv).toBeUndefined();
  });
});

describe("loadPreferences", () => {
  for (const row of fx.preference_files) {
    test(row.name, () => {
      const root = tempRoot();
      const path = join(root, "models.toml");
      writeFileSync(path, row.toml);

      if (row.err !== undefined) {
        const error = catchError(PreferenceError, () => loadPreferences(path));
        expect(error.kind).toBe("parse");
        expect(semanticTail(error.message)).toBe(semanticTail(row.err));
        return;
      }

      const prefs = loadPreferences(path);
      expect(prefsToWire(prefs)).toEqual(row.parsed as Record<string, unknown>);
      expect([...prefs.models.keys()]).toEqual(row.model_keys as string[]);
      expect(preferencesAreEmpty(prefs)).toBe(row.is_empty as boolean);
      expect(selectionKey(prefs.selected) ?? null).toBe(row.selected_key ?? null);
      expect(selectionIsSet(prefs.selected)).toBe(row.selected_key != null);

      const hasNestedValue =
        prefs.defaults.sampler.openrouterProvider !== undefined ||
        [...prefs.models.values()].some((m) => m.sampler.openrouterProvider !== undefined);
      if (!hasNestedValue) {
        expect(serializePreferences(prefs)).toBe(row.serialized as string);
      }

      const roundPath = join(root, "round.toml");
      savePreferences(roundPath, prefs);
      expect(prefsToWire(loadPreferences(roundPath))).toEqual(prefsToWire(prefs));
    });
  }

  test("a missing file is empty defaults, not an error", () => {
    const prefs = loadPreferences(join(tempRoot(), "nope.toml"));
    expect(prefsToWire(prefs)).toEqual(fx.missing_file_is_empty);
  });

  test("an empty file still serializes the whole schema", () => {
    expect(serializePreferences(emptyPreferences())).toBe(
      "[selected]\n\n[defaults.sampler]\n\n[models]\n",
    );
  });

  test("a float keeps its decimal point", () => {
    const prefs = emptyPreferences();
    prefs.defaults.sampler.temperature = 1;
    expect(serializePreferences(prefs)).toContain("temperature = 1.0");
  });
});

describe("resolveSamplerSettings", () => {
  const staticCatalog = catalogFromSections(
    Bun.TOML.parse(STATIC_CHAT) as Record<string, unknown>,
    undefined,
    undefined,
  );

  for (const row of fx.resolve_sampler) {
    test(row.name, () => {
      const global = prefsFrom(row.global_toml);
      const character = prefsFrom(row.character_toml);
      const staticModel = row.use_static
        ? findStaticModel(staticCatalog, row.provider, row.model_id)
        : undefined;

      const settings = resolveSamplerSettings(
        global,
        character,
        row.provider,
        row.model_id,
        staticModel,
      );
      expect(samplerToWire(settings)).toEqual(row.settings);

      const scopes = resolveSamplerScopes(
        global,
        character,
        row.provider,
        row.model_id,
        staticModel,
      );
      const wireScopes: Record<string, string> = {};
      for (const [field, scope] of Object.entries(scopes)) {
        if (scope !== undefined) wireScopes[SCOPE_TOML_KEYS[field] as string] = scope;
      }
      expect(wireScopes).toEqual(parseScopes(row.scopes));

      expect(resolveSelectedModel(global, character) ?? null).toEqual(row.selected);

      if (staticModel !== undefined) {
        expect(modelToWire(applySamplerOverlay(staticModel, settings))).toEqual(
          row.patched as Record<string, unknown>,
        );
      }
    });
  }

  test("an unparseable sdk is dropped from the effective view", () => {
    const global = prefsFrom('[defaults.sampler]\nsdk = "nope"\n');
    expect(resolveSamplerSettings(global, undefined, "p", "m", undefined).sdk).toBeUndefined();
    expect(resolveSamplerSettings(global, undefined, "p", "m", undefined)).toEqual({});
  });

  test("a zero iteration cap is treated as unset", () => {
    const global = prefsFrom("[defaults.sampler]\nmax_tool_iterations = 0\n");
    expect(
      resolveSamplerSettings(global, undefined, "p", "m", undefined).maxToolIterations,
    ).toBeUndefined();
    const ok = prefsFrom("[defaults.sampler]\nmax_tool_iterations = 1\n");
    expect(resolveSamplerSettings(ok, undefined, "p", "m", undefined).maxToolIterations).toBe(1);
  });

  test("applySamplerOverlay never mutates the catalog entry", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse(STATIC_CHAT) as Record<string, unknown>,
      undefined,
      undefined,
    );
    const model = findStaticModel(catalog, "anthropic", "claude-opus-4-6") as ResolvedModel;
    const before = modelToWire(model);
    applySamplerOverlay(model, { temperature: 0.1, maxOutputTokens: 5 });
    expect(modelToWire(model)).toEqual(before);
  });

  test("applySamplerOverlay keeps the catalog sdk for an unparseable one", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse(STATIC_CHAT) as Record<string, unknown>,
      undefined,
      undefined,
    );
    const model = findStaticModel(catalog, "anthropic", "claude-opus-4-6") as ResolvedModel;
    expect(applySamplerOverlay(model, { sdk: "nope" }).sdk).toBe("anthropic");
    expect(applySamplerOverlay(model, { sdk: "gemini" }).sdk).toBe("gemini");
  });

  test('reasoning_effort "off" survives the overlay', () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse(STATIC_CHAT) as Record<string, unknown>,
      undefined,
      undefined,
    );
    const model = findStaticModel(catalog, "anthropic", "claude-opus-4-6") as ResolvedModel;
    expect(applySamplerOverlay(model, { reasoningEffort: "off" }).reasoningEffort).toBe("off");
  });
});

describe("preferenceKey", () => {
  for (const row of fx.preference_key) {
    test(`${JSON.stringify(row.provider)} + ${JSON.stringify(row.model_id)}`, () => {
      expect(preferenceKey(row.provider, row.model_id)).toBe(row.key);
    });
  }
});

describe("findEffectiveModel", () => {
  for (const row of fx.effective_catalog) {
    test(row.name, () => {
      const root = tempRoot();
      const cacheDir = join(root, "cache");
      for (const { provider, body } of row.caches) {
        mkdirSync(join(cacheDir, "providers", provider), { recursive: true });
        writeFileSync(join(cacheDir, "providers", provider, "models.json"), body);
      }
      const config = buildConfig(row.chat_toml, row.providers_toml, root);

      for (const lookup of row.lookups) {
        const run = () => findEffectiveModel(config, cacheDir, lookup.name, lookup.include_hidden);
        if (lookup.err !== undefined) {
          const error = catchError(EffectiveCatalogError, run);
          expect(error.message).toBe(lookup.err);
        } else {
          expect(modelToWire(run())).toEqual(
            lookup.resolved as Record<string, unknown>,
          );
        }
      }

      const summarize = (includeHidden: boolean): Record<string, unknown>[] =>
        listEffectiveModels(config, cacheDir, includeHidden).map((m) => ({
          source: m.source as string,
          qualified_name: m.resolved.qualifiedName,
          hidden: m.hidden,
        }));
      expect(summarize(false)).toEqual(row.listed as unknown as Record<string, unknown>[]);
      expect(summarize(true)).toEqual(
        row.listed_include_hidden as unknown as Record<string, unknown>[],
      );
    });
  }

  test("a disabled provider hides its static entries too", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = buildConfig(
      '[openrouter.opus]\nmodel_id = "anthropic/claude-opus-4-6"\n',
      "[openrouter]\nenabled = false\n",
      root,
    );
    expect(() =>
      findEffectiveModel(config, join(root, "cache"), "openrouter:anthropic/claude-opus-4-6", false),
    ).toThrow(EffectiveCatalogError);
    expect(findEffectiveModel(config, join(root, "cache"), "opus", false).name).toBe("opus");
  });

  test("a corrupt discovery cache is no discovery data, not an error", () => {
    const root = tempRoot();
    const cacheDir = join(root, "cache");
    mkdirSync(join(cacheDir, "providers", "openrouter"), { recursive: true });
    writeFileSync(join(cacheDir, "providers", "openrouter", "models.json"), "{ not json");
    const config = buildConfig("", "[openrouter]\n[openrouter.discovery]\nenabled = true\n", root);

    expect(findEffectiveModel(config, cacheDir, "openrouter:some/model", false).modelId).toBe(
      "some/model",
    );
    expect(listEffectiveModels(config, cacheDir, false)).toEqual([]);
  });

  test("the canonical identity round-trips back through the lookup", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = buildConfig("", "[openrouter]\n", root);
    const first = findEffectiveModel(config, join(root, "cache"), "openrouter:some/model", false);
    const again = findEffectiveModel(config, join(root, "cache"), first.qualifiedName, false);
    expect(modelToWire(again)).toEqual(modelToWire(first));
  });
});

describe("resolveActiveForCharacter", () => {
  for (const row of fx.active_model) {
    test(row.name, () => {
      const root = tempRoot();
      mkdirSync(join(root, "cache"), { recursive: true });
      const config = buildConfig(STATIC_CHAT, "", root);
      const resolved = resolveActiveForCharacter(
        config,
        prefsFrom(row.global_toml),
        prefsFrom(row.character_toml),
        row.legacy_active_model ?? undefined,
        row.app_default_model ?? undefined,
        findEffectiveModel,
      );
      expect(resolved?.qualifiedName ?? null).toBe(row.qualified_name);
    });
  }

  test("an unresolvable [defaults].model still falls through, but says so", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = buildConfig(STATIC_CHAT, "", root);

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => void warnings.push(String(msg));
    let resolved;
    try {
      resolved = resolveActiveForCharacter(
        config,
        emptyPreferences(),
        emptyPreferences(),
        undefined,
        "nosuchprovider:nosuchmodel",
        findEffectiveModel,
      );
    } finally {
      console.warn = original;
    }

    expect(resolved).toBeDefined();
    expect(warnings.join("\n")).toContain("nosuchprovider:nosuchmodel");
    expect(warnings.join("\n")).toContain("[defaults].model");
  });

  test("an empty catalog resolves to nothing rather than throwing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = buildConfig("", "", root);
    expect(
      resolveActiveForCharacter(
        config,
        emptyPreferences(),
        emptyPreferences(),
        undefined,
        undefined,
        findEffectiveModel,
      ),
    ).toBeUndefined();
  });
});

describe("the layer order exists once", () => {
  const LAYERS = [
    "static_default",
    "global_default",
    "character_default",
    "global_model",
    "character_model",
  ] as const;

  function prefsFor(set: ReadonlySet<string>) {
    const global = emptyPreferences();
    const character = emptyPreferences();
    if (set.has("global_default")) global.defaults.sampler.temperature = 0.11;
    if (set.has("character_default")) character.defaults.sampler.temperature = 0.22;
    if (set.has("global_model")) {
      setModelPreference(global, "anthropic", "m", { sampler: { temperature: 0.33 } });
    }
    if (set.has("character_model")) {
      setModelPreference(character, "anthropic", "m", { sampler: { temperature: 0.44 } });
    }
    const staticDefault = set.has("static_default")
      ? ({ sdk: "anthropic", temperature: 0.55 } as unknown as ResolvedModel)
      : undefined;
    return { global, character, staticDefault };
  }

  const VALUE_OF: Record<string, number> = {
    static_default: 0.55,
    global_default: 0.11,
    character_default: 0.22,
    global_model: 0.33,
    character_model: 0.44,
  };

  test("resolveSamplerScopes attributes every value to the layer that supplied it", () => {
    for (let mask = 0; mask < 1 << LAYERS.length; mask += 1) {
      const set = new Set(LAYERS.filter((_, i) => (mask & (1 << i)) !== 0));
      const { global, character, staticDefault } = prefsFor(set);

      const settings = resolveSamplerSettings(global, character, "anthropic", "m", staticDefault);
      const scopes = resolveSamplerScopes(global, character, "anthropic", "m", staticDefault);

      if (set.size === 0) {
        expect(settings.temperature).toBeUndefined();
        expect(scopes.temperature).toBeUndefined();
        continue;
      }

      const winner = [...LAYERS].reverse().find((l) => set.has(l))!;
      expect(scopes.temperature, `mask ${mask} attributed the wrong layer`).toBe(winner);
      expect(settings.temperature, `mask ${mask} resolved the wrong value`).toBe(
        VALUE_OF[winner]!,
      );
    }
  });
});

describe("resolveBackgroundModel", () => {
  for (const row of fx.background_model) {
    test(row.name, () => {
      const root = tempRoot();
      mkdirSync(join(root, "cache"), { recursive: true });
      mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
      writeFileSync(
        join(root, "data", "ashe", "preferences", "models.toml"),
        row.character_prefs,
      );
      if (row.name.includes("legacy")) {
        writeFileSync(
          join(root, "data", "ashe", "runtime_state.json"),
          '{"active_model": "sonnet"}',
        );
      }

      const app = parseToml(row.background_toml) as
        | { defaults?: { background?: Record<string, string> } }
        | undefined;
      const background = app?.defaults?.background;
      const config = buildConfig(STATIC_CHAT, "", root, (task) =>
        background === undefined ? undefined : (background[task] ?? background["model"]),
      );

      const heartbeat = resolveBackgroundModel(config, "heartbeat", "ashe", findEffectiveModel);
      expect(
        heartbeat === undefined
          ? null
          : {
              qualified_name: heartbeat.qualifiedName,
              max_output_tokens: heartbeat.maxOutputTokens ?? null,
            },
      ).toEqual(row.heartbeat);

      const chat = resolveChatModelForCharacter(config, "ashe", findEffectiveModel);
      expect(
        chat === undefined
          ? null
          : {
              qualified_name: chat.qualifiedName,
              max_output_tokens: chat.maxOutputTokens ?? null,
            },
      ).toEqual(row.chat);
    });
  }

  test("the per-character overlay reaches the background model", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      "[defaults.sampler]\nmax_output_tokens = 32000\n",
    );
    const config = buildConfig(STATIC_CHAT, "", root, () => "sonnet");
    const model = resolveBackgroundModel(config, "heartbeat", "ashe", findEffectiveModel);
    expect(model?.maxOutputTokens).toBe(32000);
  });
});
