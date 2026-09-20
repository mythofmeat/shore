import { expandShared } from "./support/shared_subtrees.ts";
import { required } from "../src/util/required.ts";

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import rawFixture from "./config_captures/preferences.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

import { catalogFromSections, defaultSdk, type ResolvedModel } from "../src/config/models.ts";
import { ConfigDuration } from "../src/config/duration.ts";
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
  resolveActiveModelAndOverlay,
  resolveChatModelForCharacter,
  resolveSamplerScopes,
  resolveSamplerSettings,
  resolveSelectedModel,
  resolveSubagentBaseModel,
  resolveSubagentModelSettings,
  resolveSubagentSampler,
  resolveSubagentScopes,
  setModelPreference,
  setSubagentModelPreference,
  setSubagentPreference,
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
import {
  ZAI_API_BASE_URL,
  ZAI_SUB_BASE_URL,
} from "../src/llm/providers/zai_config.ts";

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
  scopes: Record<string, string>;
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
  const dir = mkdtempSync(join(tmpdir(), "prefs-"));
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

function expectOnlyWhatIsSet(
  actual: Record<string, unknown>,
  recorded: Record<string, unknown>,
  where: string,
): void {
  expect(
    Object.fromEntries(Object.entries(actual).filter(([, v]) => v !== null)),
    where,
  ).toEqual(recorded);
  for (const [field, value] of Object.entries(actual)) {
    if (field in recorded) continue;
    expect(value, `${where}: ${field} is unset, because nothing set it`).toBeNull();
  }
}

function expectOnlyWhatIsSetDeep(
  actual: Record<string, unknown>,
  recorded: Record<string, unknown>,
  where: string,
): void {
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, prune(v)]),
    );
  };
  expect(prune(actual), where).toEqual(recorded);
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
};

function prefsFrom(text: string): ModelPreferences {
  if (text.trim() === "") return emptyPreferences();
  const root = tempRoot();
  const path = join(root, "models.toml");
  writeFileSync(path, text);
  return loadPreferences(path);
}

const STATIC_CHAT = `
["anthropic:claude-opus-4-6"]
["anthropic:claude-sonnet-4-6"]`;

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

  test("the Coding Plan endpoint is configured on its own and bills as a subscription", () => {
    const registry = ProviderRegistry.fromSection(
      Bun.TOML.parse(`
[zai-sub]
api_key_env = "ZAI_API_KEY"

[zai-sub.discovery]
enabled = true
ignore = ["glm-4.5"]
`) as never,
    );

    expect(registry.entries().map(([name]) => name)).toEqual(["zai-sub"]);
    const sub = registry.get("zai-sub") as ProviderEntry;
    expect(sub.subscription).toBe(true);
    expect(sub.discovery).toEqual({ enabled: true, ignore: ["glm-4.5"] });
    expect(sub.keys).toEqual([
      { name: "default", env: "ZAI_API_KEY", enabled: true, warnOnFallback: false },
    ]);
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
      expectOnlyWhatIsSetDeep(
        prefsToWire(prefs),
        row.parsed as Record<string, unknown>,
        `${row.name}: what the preference file says`,
      );
      expect([...prefs.models.keys()]).toEqual(row.model_keys as string[]);
      expect(preferencesAreEmpty(prefs)).toBe(row.is_empty as boolean);
      expect(selectionKey(prefs.selected) ?? null).toBe(row.selected_key ?? null);
      expect(selectionIsSet(prefs.selected)).toBe(
      row.selected_key !== null && row.selected_key !== undefined,
    );

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
      expectOnlyWhatIsSet(
        samplerToWire(settings),
        row.settings,
        `${row.name}: the sampler settings that survive the layers`,
      );

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
      expect(wireScopes, `${row.name}: which layer each setting came from`).toEqual(row.scopes);

      expect(resolveSelectedModel(global, character) ?? null).toEqual(row.selected);

      if (staticModel !== undefined) {
        expectOnlyWhatIsSet(
          modelToWire(applySamplerOverlay(staticModel, settings)),
          row.patched as Record<string, unknown>,
          `${row.name}: the model the overlay produces`,
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
    const global = prefsFrom("[defaults.sampler]\nmax_tool_rounds = 0\n");
    expect(
      resolveSamplerSettings(global, undefined, "p", "m", undefined).maxToolIterations,
    ).toBeUndefined();
    const ok = prefsFrom("[defaults.sampler]\nmax_tool_rounds = 1\n");
    expect(resolveSamplerSettings(ok, undefined, "p", "m", undefined).maxToolIterations).toBe(1);
  });

  test("the registry carries a model's keepalive ceiling into effective settings", () => {
    const cacheKeepaliveMax = ConfigDuration.parse("12h");
    expect("ok" in cacheKeepaliveMax).toBe(true);
    if (!("ok" in cacheKeepaliveMax)) return;
    const model: ResolvedModel = {
      name: "ceiling",
      qualifiedName: "openai:ceiling",
      category: "chat",
      providerKey: "openai",
      sdk: "openai",
      modelId: "ceiling",
      cacheKeepaliveMax: cacheKeepaliveMax.ok,
    };

    expect(
      resolveSamplerSettings(emptyPreferences(), undefined, "openai", "ceiling", model)
        .cacheKeepaliveMax?.toString(),
    ).toBe("12h");
  });

  test("explicit discovered claims drop unsupported persisted sampler values", () => {
    const global = emptyPreferences();
    global.defaults.sampler = {
      temperature: 0.7,
      topP: 0.9,
      reasoningEffort: "medium",
    };
    const model: ResolvedModel = {
      name: "narrow",
      qualifiedName: "openrouter:narrow",
      category: "chat",
      providerKey: "openrouter",
      sdk: "openrouter",
      modelId: "narrow",
      support: {
        supported_parameters: [],
        effort: { supported: true, levels: ["low"] },
      },
    };
    const resolved = resolveSamplerSettings(global, undefined, "openrouter", "narrow", model);
    expect(resolved.temperature).toBeUndefined();
    expect(resolved.topP).toBeUndefined();
    expect(resolved.reasoningEffort).toBeUndefined();
  });

  test("missing discovered metadata leaves persisted sampler values permissive", () => {
    const global = emptyPreferences();
    global.defaults.sampler = { temperature: 0.7, topP: 0.9, reasoningEffort: "future" };
    const model: ResolvedModel = {
      name: "unknown",
      qualifiedName: "openrouter:unknown",
      category: "chat",
      providerKey: "openrouter",
      sdk: "openrouter",
      modelId: "unknown",
    };
    expect(resolveSamplerSettings(global, undefined, "openrouter", "unknown", model))
      .toMatchObject(global.defaults.sampler);
  });

  test("an explicit thinking denial drops a persisted budget", () => {
    const global = emptyPreferences();
    global.defaults.sampler = { budgetTokens: 2048 };
    const model: ResolvedModel = {
      name: "no-thinking",
      qualifiedName: "gemini:no-thinking",
      category: "chat",
      providerKey: "gemini",
      sdk: "gemini",
      modelId: "no-thinking",
      support: { thinking: { enabled: false } },
    };
    expect(resolveSamplerSettings(global, undefined, "gemini", "no-thinking", model).budgetTokens)
      .toBeUndefined();
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

  test("a saved sdk beats the one discovery guessed for a gateway model", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse(STATIC_CHAT) as Record<string, unknown>,
      undefined,
      undefined,
    );
    const model = findStaticModel(catalog, "anthropic", "claude-opus-4-6") as ResolvedModel;
    const gateway: ResolvedModel = {
      ...model,
      name: "kimi-k3",
      qualifiedName: "opencode-go:kimi-k3",
      providerKey: "opencode-go",
      sdk: defaultSdk("opencode-go"),
    };

    expect(gateway.sdk).toBe("openai");
    expect(applySamplerOverlay(gateway, { sdk: "moonshot" }).sdk).toBe("moonshot");
    expect(applySamplerOverlay(gateway, { sdk: "moonshotai" }).sdk).toBe("moonshot");
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
          const wire = modelToWire(run());
          const recorded = lookup.resolved as Record<string, unknown>;
          expect(
            Object.fromEntries(Object.entries(wire).filter(([, v]) => v !== null)),
            `${lookup.name}: what the catalog resolved it to`,
          ).toEqual(recorded);
          for (const [field, value] of Object.entries(wire)) {
            if (field in recorded) continue;
            expect(
              value,
              `${lookup.name}: ${field} is unset, because nothing in the config set it`,
            ).toBeNull();
          }
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

  test("each Z.ai endpoint resolves its own catalog", () => {
    const root = tempRoot();
    const cacheDir = join(root, "cache");
    let providers = "";
    for (const [provider, baseUrl] of [
      ["zai-api", ZAI_API_BASE_URL],
      ["zai-sub", ZAI_SUB_BASE_URL],
    ] as const) {
      const providerDir = join(cacheDir, "providers", provider);
      mkdirSync(providerDir, { recursive: true });
      writeFileSync(
        join(providerDir, "models.json"),
        JSON.stringify({
          version: 2,
          provider_key: provider,
          fetched_at: "2026-08-27T00:00:00Z",
          base_url: baseUrl,
          models: [
            {
              provider_key: provider,
              model_id: "glm-5.3-flash",
              sdk: "openai",
              base_url: baseUrl,
              discovered_at: "2026-08-27T00:00:00Z",
            },
          ],
        }),
      );
      providers += `[${provider}]\napi_key_env = "ZAI_API_KEY"\n[${provider}.discovery]\nenabled = true\n`;
    }
    const config = buildConfig("", providers, root);

    const api = findEffectiveModel(config, cacheDir, "zai-api:glm-5.3-flash", false);
    const sub = findEffectiveModel(config, cacheDir, "zai-sub:glm-5.3-flash", false);
    expect(api.providerKey).toBe("zai-api");
    expect(api.baseUrl).toBe(ZAI_API_BASE_URL);
    expect(api.sdk).toBe("zai");
    expect(sub.providerKey).toBe("zai-sub");
    expect(sub.qualifiedName).toBe("zai-sub:glm-5.3-flash");
    expect(sub.sdk).toBe("zai");
    expect(sub.baseUrl).toBe(ZAI_SUB_BASE_URL);
  });

  test("NanoGPT keeps its own protocol for Anthropic-namespaced models", () => {
    const root = tempRoot();
    const cacheDir = join(root, "cache");
    const providerDir = join(cacheDir, "providers", "nanogpt");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "models.json"), JSON.stringify({
      version: 2,
      provider_key: "nanogpt",
      fetched_at: "2026-09-02T00:00:00Z",
      base_url: "https://nano-gpt.com/api/v1",
      models: [{
        provider_key: "nanogpt",
        model_id: "anthropic/claude-opus-4.6",
        sdk: "nanogpt",
        base_url: "https://nano-gpt.com/api/v1",
        discovered_at: "2026-09-02T00:00:00Z",
      }],
    }));
    const config = buildConfig(
      "",
      "[nanogpt]\n[nanogpt.discovery]\nenabled = true\n",
      root,
    );

    const model = findEffectiveModel(
      config,
      cacheDir,
      "nanogpt:anthropic/claude-opus-4.6",
      false,
    );
    expect(model.providerKey).toBe("nanogpt");
    expect(model.sdk).toBe("nanogpt");
    expect(model.baseUrl).toBe("https://nano-gpt.com/api/v1");
    expect(model.cacheTtl).toBeUndefined();
  });

  test("a disabled provider hides its static entries too", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = buildConfig(
      "[\"openrouter:anthropic/claude-opus-4-6\"]",
      "[openrouter]\nenabled = false\n",
      root,
    );
    expect(() =>
      findEffectiveModel(config, join(root, "cache"), "openrouter:anthropic/claude-opus-4-6", false),
    ).toThrow(EffectiveCatalogError);
    expect(() => findEffectiveModel(config, join(root, "cache"), "anthropic/claude-opus-4-6", false)).toThrow(EffectiveCatalogError);
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
        row.app_default_model ?? undefined,
        findEffectiveModel,
      );
      expect(resolved?.qualifiedName ?? null).toBe(row.qualified_name);
    });
  }

  test("an unresolvable chat.model still falls through, but says so", () => {
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
        "nosuchprovider:nosuchmodel",
        findEffectiveModel,
      );
    } finally {
      console.warn = original;
    }

    expect(resolved).toBeDefined();
    expect(warnings.join("\n")).toContain("nosuchprovider:nosuchmodel");
    expect(warnings.join("\n")).toContain("chat.model");
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

      const winner = required([...LAYERS].reverse().find((l) => set.has(l)));
      expect(scopes.temperature, `mask ${mask} attributed the wrong layer`).toBe(winner);
      expect(settings.temperature, `mask ${mask} resolved the wrong value`).toBe(
        VALUE_OF[winner],
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
      const background = parseToml(row.background_toml) as Record<string, { model?: string }> | undefined;
      const config = buildConfig(STATIC_CHAT, "", root, (task) => background?.[task]?.model);

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
    const config = buildConfig(STATIC_CHAT, "", root, () => "claude-sonnet-4-6");
    const model = resolveBackgroundModel(config, "heartbeat", "ashe", findEffectiveModel);
    expect(model?.maxOutputTokens).toBe(32000);
  });
});

describe("sub-agent settings stand on their own", () => {
  const catalogModel = (): ResolvedModel =>
    ({
      name: "claude-opus-4-6",
      qualifiedName: "anthropic:claude-opus-4-6",
      category: "chat",
      providerKey: "anthropic",
      modelId: "claude-opus-4-6",
      sdk: "anthropic",
      temperature: 0.55,
    }) as unknown as ResolvedModel;

  test("chat model settings do not reach a sub-agent", () => {
    const global = emptyPreferences();
    const character = emptyPreferences();
    global.defaults.sampler.temperature = 0.11;
    character.defaults.sampler.temperature = 0.22;
    setModelPreference(global, "anthropic", "claude-opus-4-6", {
      sampler: { temperature: 0.33 },
    });
    setModelPreference(character, "anthropic", "claude-opus-4-6", {
      sampler: { temperature: 0.44 },
    });

    const sampler = resolveSubagentSampler(global, character, "librarian", "anthropic", "claude-opus-4-6", catalogModel());
    expect(sampler.temperature).toBe(0.55);
  });

  test("the same layers still reach the chat model that shares the id", () => {
    const global = emptyPreferences();
    const character = emptyPreferences();
    setModelPreference(character, "anthropic", "claude-opus-4-6", {
      sampler: { temperature: 0.44 },
    });

    const sampler = resolveSamplerSettings(
      global,
      character,
      "anthropic",
      "claude-opus-4-6",
      catalogModel(),
    );
    expect(sampler.temperature).toBe(0.44);
  });

  test("a sub-agent's own entry wins, character over global", () => {
    const global = emptyPreferences();
    const character = emptyPreferences();
    setSubagentPreference(global, "librarian", { sampler: { temperature: 0.1, topP: 0.9 } });
    setSubagentPreference(character, "librarian", { sampler: { temperature: 0.2 } });

    const sampler = resolveSubagentSampler(global, character, "librarian", "anthropic", "claude-opus-4-6", catalogModel());
    expect(sampler.temperature).toBe(0.2);
    expect(sampler.topP).toBe(0.9);
  });

  test("one sub-agent's entry does not reach another", () => {
    const global = emptyPreferences();
    setSubagentPreference(global, "librarian", { sampler: { temperature: 0.1 } });

    expect(resolveSubagentSampler(global, undefined, "archivist", "anthropic", "claude-opus-4-6", catalogModel()).temperature).toBe(
      0.55,
    );
  });

  test("scopes attribute a sub-agent value to the sub-agent layer", () => {
    const global = emptyPreferences();
    const character = emptyPreferences();
    setSubagentPreference(global, "librarian", { sampler: { topP: 0.9 } });
    setSubagentPreference(character, "librarian", { sampler: { temperature: 0.2 } });

    const scopes = resolveSubagentScopes(global, character, "librarian", "anthropic", "claude-opus-4-6", catalogModel());
    expect(scopes.temperature).toBe("character_subagent");
    expect(scopes.topP).toBe("global_subagent");
  });

  test("the section round-trips through the preferences file", () => {
    const prefs = emptyPreferences();
    setSubagentPreference(prefs, "librarian", { sampler: { temperature: 0.25 } });
    setSubagentPreference(prefs, "archivist", { sampler: { maxOutputTokens: 4096 } });

    const path = join(tempRoot(), "models.toml");
    savePreferences(path, prefs);
    const reloaded = loadPreferences(path);

    expect([...reloaded.subagents.keys()]).toEqual(["archivist", "librarian"]);
    expect(reloaded.subagents.get("librarian")?.sampler.temperature).toBe(0.25);
    expect(reloaded.subagents.get("archivist")?.sampler.maxOutputTokens).toBe(4096);
    expect(reloaded.models.size).toBe(0);
  });

  test("a file with no sub-agent settings stays empty rather than absent", () => {
    const path = join(tempRoot(), "models.toml");
    writeFileSync(path, "[selected]\n\n[defaults.sampler]\n\n[models]\n");
    expect(loadPreferences(path).subagents.size).toBe(0);
    expect(preferencesAreEmpty(loadPreferences(path))).toBe(true);
  });

  test("a saved sub-agent entry makes the file non-empty", () => {
    const prefs = emptyPreferences();
    setSubagentPreference(prefs, "librarian", { sampler: { temperature: 0.25 } });
    expect(preferencesAreEmpty(prefs)).toBe(false);
  });

  test("resolveSubagentModelSettings overlays the character's saved entry", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "ashe", "preferences", "models.toml"),
      '[subagents.librarian]\ntemperature = 0.25\nreasoning_effort = "low"\n',
    );

    const model = resolveSubagentModelSettings(root, "ashe", "librarian", catalogModel());
    expect(model.temperature).toBe(0.25);
    expect(model.reasoningEffort).toBe("low");
  });

  test("resolveSubagentModelSettings leaves the catalog alone when nothing is saved", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ashe", "preferences"), { recursive: true });
    const model = resolveSubagentModelSettings(root, "ashe", "librarian", catalogModel());
    expect(model.temperature).toBe(0.55);
  });
});

describe("which model a sub-agent runs on", () => {
  function configWithSubagentDefault(
    root: string,
    subagentModel?: string,
    defaultModel?: string,
  ): LoadedConfigView {
    const config = buildConfig(STATIC_CHAT, "", root, () => undefined, defaultModel);
    if (subagentModel !== undefined) config.app.defaults.subagent_model = subagentModel;
    return config;
  }

  test("the sub-agent's own model wins over defaults.subagent_model", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = configWithSubagentDefault(root, "claude-sonnet-4-6", "claude-sonnet-4-6");

    const model = resolveSubagentBaseModel(config, "ashe", "claude-opus-4-6", findEffectiveModel);
    expect(model?.modelId).toBe("claude-opus-4-6");
  });

  test("defaults.subagent_model wins over the chat model", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = configWithSubagentDefault(root, "claude-opus-4-6", "claude-sonnet-4-6");

    const model = resolveSubagentBaseModel(config, "ashe", undefined, findEffectiveModel);
    expect(model?.modelId).toBe("claude-opus-4-6");
  });

  test("with neither set it is the character's chat model, saved choice included", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      '[selected]\nprovider = "anthropic"\nmodel_id = "claude-opus-4-6"\n',
    );
    const config = configWithSubagentDefault(root, undefined, "claude-sonnet-4-6");

    const model = resolveSubagentBaseModel(config, "ashe", undefined, findEffectiveModel);
    expect(model?.modelId).toBe("claude-opus-4-6");
  });

  test("the inherited chat model arrives without the chat model's saved settings", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      '[models."anthropic:claude-sonnet-4-6"]\nmax_output_tokens = 32000\n',
    );
    const config = configWithSubagentDefault(root, undefined, "claude-sonnet-4-6");

    const inherited = resolveSubagentBaseModel(config, "ashe", undefined, findEffectiveModel);
    const chat = resolveChatModelForCharacter(config, "ashe", findEffectiveModel);

    expect(chat?.maxOutputTokens).toBe(32000);
    expect(inherited?.maxOutputTokens).not.toBe(32000);
  });

  test("with no character there is no chat model to inherit", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = configWithSubagentDefault(root, undefined, "claude-sonnet-4-6");

    expect(
      resolveSubagentBaseModel(config, undefined, undefined, findEffectiveModel),
    ).toBeUndefined();
  });

  test("an explicitly empty model is a configuration error, not an unset value", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const config = configWithSubagentDefault(root, undefined, "claude-sonnet-4-6");

    expect(() => resolveSubagentBaseModel(config, "ashe", "", findEffectiveModel)).toThrow();
  });
});

describe("a pinned background model keeps its own settings slot", () => {
  test("the chat model's saved entry does not reach a differently pinned background model", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      '[models."anthropic:claude-opus-4-6"]\nmax_output_tokens = 32000\n\n' +
        '[models."anthropic:claude-sonnet-4-6"]\nmax_output_tokens = 4096\n',
    );
    const config = buildConfig(STATIC_CHAT, "", root, () => "claude-sonnet-4-6", "claude-opus-4-6");

    const background = resolveBackgroundModel(config, "heartbeat", "ashe", findEffectiveModel);
    const chat = resolveChatModelForCharacter(config, "ashe", findEffectiveModel);

    expect(chat?.maxOutputTokens).toBe(32000);
    expect(background?.maxOutputTokens).toBe(4096);
  });

  test("an unpinned background model shares the chat model's slot", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      '[models."anthropic:claude-opus-4-6"]\nmax_output_tokens = 32000\n',
    );
    const config = buildConfig(STATIC_CHAT, "", root, () => undefined, "claude-opus-4-6");

    const background = resolveBackgroundModel(config, "heartbeat", "ashe", findEffectiveModel);
    expect(background?.maxOutputTokens).toBe(32000);
  });
});

describe("settings shared by every sub-agent on a model", () => {
  const modelNamed = (modelId: string): ResolvedModel =>
    ({
      name: modelId,
      qualifiedName: `opencode-go:${modelId}`,
      category: "chat",
      providerKey: "opencode-go",
      modelId,
      sdk: "anthropic",
    }) as unknown as ResolvedModel;

  test("the model slot reaches every sub-agent on that model", () => {
    const prefs = emptyPreferences();
    setSubagentModelPreference(prefs, "opencode-go", "glm-5.3", {
      sampler: { temperature: 0.3 },
    });

    for (const name of ["internet", "memory", "music"]) {
      const sampler = resolveSubagentSampler(
        prefs,
        undefined,
        name,
        "opencode-go",
        "glm-5.3",
        modelNamed("glm-5.3"),
      );
      expect(sampler.temperature).toBe(0.3);
    }
  });

  test("swapping the sub-agent model leaves the old model's settings behind", () => {
    const prefs = emptyPreferences();
    setSubagentModelPreference(prefs, "opencode-go", "glm-5.3", {
      sampler: { temperature: 0.3 },
    });

    const swapped = resolveSubagentSampler(
      prefs,
      undefined,
      "internet",
      "openrouter",
      "google/gemini-3.7-flash",
      modelNamed("gemini"),
    );
    expect(swapped.temperature).toBeUndefined();
  });

  test("a per-name setting still overrides the shared model slot", () => {
    const prefs = emptyPreferences();
    setSubagentModelPreference(prefs, "opencode-go", "glm-5.3", {
      sampler: { temperature: 0.3, topP: 0.8 },
    });
    setSubagentPreference(prefs, "music", { sampler: { temperature: 0.9 } });

    const shared = resolveSubagentSampler(
      prefs,
      undefined,
      "internet",
      "opencode-go",
      "glm-5.3",
      modelNamed("glm-5.3"),
    );
    const overridden = resolveSubagentSampler(
      prefs,
      undefined,
      "music",
      "opencode-go",
      "glm-5.3",
      modelNamed("glm-5.3"),
    );

    expect(shared.temperature).toBe(0.3);
    expect(overridden.temperature).toBe(0.9);
    expect(overridden.topP).toBe(0.8);
  });

  test("the chat model's slot on the same model still does not leak in", () => {
    const prefs = emptyPreferences();
    setModelPreference(prefs, "opencode-go", "glm-5.3", { sampler: { temperature: 0.9 } });

    const sampler = resolveSubagentSampler(
      prefs,
      undefined,
      "internet",
      "opencode-go",
      "glm-5.3",
      modelNamed("glm-5.3"),
    );
    expect(sampler.temperature).toBeUndefined();
  });

  test("scopes name the shared model layer and the per-name layer apart", () => {
    const global = emptyPreferences();
    const character = emptyPreferences();
    setSubagentModelPreference(global, "opencode-go", "glm-5.3", { sampler: { topP: 0.8 } });
    setSubagentModelPreference(character, "opencode-go", "glm-5.3", {
      sampler: { maxOutputTokens: 8192 },
    });
    setSubagentPreference(character, "music", { sampler: { temperature: 0.9 } });

    const scopes = resolveSubagentScopes(
      global,
      character,
      "music",
      "opencode-go",
      "glm-5.3",
      modelNamed("glm-5.3"),
    );
    expect(scopes.topP).toBe("global_subagent_model");
    expect(scopes.maxOutputTokens).toBe("character_subagent_model");
    expect(scopes.temperature).toBe("character_subagent");
  });

  test("the section round-trips through the preferences file", () => {
    const prefs = emptyPreferences();
    setSubagentModelPreference(prefs, "opencode-go", "glm-5.3", {
      sampler: { temperature: 0.3 },
    });
    setSubagentPreference(prefs, "music", { sampler: { temperature: 0.9 } });

    const path = join(tempRoot(), "models.toml");
    savePreferences(path, prefs);
    const reloaded = loadPreferences(path);

    expect(reloaded.subagentModels.get("opencode-go:glm-5.3")?.sampler.temperature).toBe(0.3);
    expect(reloaded.subagents.get("music")?.sampler.temperature).toBe(0.9);
    expect(reloaded.models.size).toBe(0);
  });
});

describe("a thread's pinned model", () => {
  function pinnedRoot(selected?: string): { root: string; config: LoadedConfigView } {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    if (selected !== undefined) {
      writeFileSync(
        join(root, "data", "ashe", "preferences", "models.toml"),
        `[selected]\nprovider = "anthropic"\nmodel_id = "${selected}"\n`,
      );
    }
    return { root, config: buildConfig(STATIC_CHAT, "", root) };
  }

  test("outranks the character's own selection", () => {
    const { config } = pinnedRoot("claude-opus-4-6");

    expect(resolveChatModelForCharacter(config, "ashe", findEffectiveModel)?.modelId).toBe(
      "claude-opus-4-6",
    );
    expect(
      resolveChatModelForCharacter(config, "ashe", findEffectiveModel, "anthropic:claude-sonnet-4-6")
        ?.modelId,
    ).toBe("claude-sonnet-4-6");
  });

  test("an unpinned thread leaves the character's selection alone", () => {
    const { config } = pinnedRoot("claude-opus-4-6");

    expect(
      resolveChatModelForCharacter(config, "ashe", findEffectiveModel, undefined)?.modelId,
    ).toBe("claude-opus-4-6");
  });

  test("a pin that resolves to nothing falls back rather than leaving the thread mute", () => {
    const { config } = pinnedRoot("claude-opus-4-6");

    expect(
      resolveChatModelForCharacter(config, "ashe", findEffectiveModel, "nowhere:nothing")?.modelId,
    ).toBe("claude-opus-4-6");
  });

  test("a pin under a registered provider resolves to that provider's model", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    const config = buildConfig(STATIC_CHAT, '[anthropic]\napi_key_env = "K"\n', root);

    const pinned = resolveChatModelForCharacter(
      config,
      "ashe",
      findEffectiveModel,
      "anthropic:claude-haiku-9",
    );
    expect(pinned?.providerKey).toBe("anthropic");
    expect(pinned?.modelId).toBe("claude-haiku-9");
  });

  test("half a pair is not a pin — a trailing colon falls back instead of naming nothing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      '[selected]\nprovider = "anthropic"\nmodel_id = "claude-opus-4-6"\n',
    );
    const config = buildConfig(STATIC_CHAT, '[anthropic]\napi_key_env = "K"\n', root);

    const pinned = resolveChatModelForCharacter(config, "ashe", findEffectiveModel, "anthropic:");
    expect(pinned?.modelId).toBe("claude-opus-4-6");
  });

  test("a a model id resolves the same as a qualified pin", () => {
    const { config } = pinnedRoot("claude-opus-4-6");

    expect(resolveChatModelForCharacter(config, "ashe", findEffectiveModel, "claude-sonnet-4-6")?.modelId).toBe(
      "claude-sonnet-4-6",
    );
  });

  test("the saved settings that apply are the pinned model's, not the character's", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "data", "ashe", "preferences"), { recursive: true });
    writeFileSync(
      join(root, "data", "ashe", "preferences", "models.toml"),
      '[selected]\nprovider = "anthropic"\nmodel_id = "claude-opus-4-6"\n\n' +
        '[models."anthropic:claude-opus-4-6"]\nmax_output_tokens = 32000\n\n' +
        '[models."anthropic:claude-sonnet-4-6"]\nmax_output_tokens = 4096\n',
    );
    const config = buildConfig(STATIC_CHAT, "", root);

    expect(
      resolveChatModelForCharacter(config, "ashe", findEffectiveModel)?.maxOutputTokens,
    ).toBe(32000);
    expect(
      resolveChatModelForCharacter(config, "ashe", findEffectiveModel, "anthropic:claude-sonnet-4-6")
        ?.maxOutputTokens,
    ).toBe(4096);
  });

  test("the overlay a turn is built with follows the pin too", () => {
    const { config } = pinnedRoot("claude-opus-4-6");

    const plain = resolveActiveModelAndOverlay(config, "ashe", findEffectiveModel);
    const pinned = resolveActiveModelAndOverlay(
      config,
      "ashe",
      findEffectiveModel,
      "anthropic:claude-sonnet-4-6",
    );

    expect(plain.model?.modelId).toBe("claude-opus-4-6");
    expect(pinned.model?.modelId).toBe("claude-sonnet-4-6");
  });

  test("background work stays on the character's model, pin or no pin", () => {
    const { config } = pinnedRoot("claude-opus-4-6");

    expect(
      resolveBackgroundModel(config, "heartbeat", "ashe", findEffectiveModel)?.modelId,
    ).toBe("claude-opus-4-6");
  });
});
