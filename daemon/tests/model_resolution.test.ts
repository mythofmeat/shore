import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";

import rawFixture from "./config_fixtures/model_resolution.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

import { ConfigDuration } from "../src/config/duration.ts";
import {
  fieldFromKey,
  type Sdk,
} from "../src/llm/capabilities.ts";
import {
  CatalogError,
  catalogFromSections,
  chatModelNames,
  defaultSdk,
  findModel,
  firstChatModel,
  hardcodedProviderDefaults,
  keepaliveToString,
  mergeFrom,
  orFallback,
  readModelConfigFields,
  resolvedModelFromParts,
  sdkEchoesUnsignedThinking,
  sdkFromWire,
  sdkUsesAnthropicPromptCache,
  type ModelConfigFields,
  type ProviderRegistryEntry,
  type ProviderRegistryView,
  type ResolvedModel,
} from "../src/config/models.ts";

interface DurationRow {
  raw: string;
  millis?: string;
  err?: string;
}
interface DisplayRow {
  millis: string;
  display: string;
  secs: string;
  json: string;
}
interface FromSecsRow {
  secs: string;
  millis: string;
}
interface KeepaliveRow {
  raw: string;
  display?: string;
  interval_millis?: string | null;
  json?: string;
  err?: string;
}
interface SdkWireRow {
  raw: string;
  sdk: string | null;
}
interface SdkFlagsRow {
  sdk: string;
  as_str: string;
  echoes_unsigned_thinking: boolean;
  uses_anthropic_prompt_cache: boolean;
}
interface ApplicabilityRow {
  sdk: string;
  model_id: string;
  field: string;
  applicability: string;
}
interface DefaultValueRow {
  sdk: string;
  field: string;
  default: string | null;
}
interface FieldFromKeyRow {
  key: string;
  field: string | null;
}
interface ProviderDefaultsRow {
  provider: string;
  fields: Record<string, unknown>;
  default_sdk: string;
}
interface FromPartsRow {
  sdk_fallback: string;
  model_id: string;
  explicit_samplers?: boolean;
  resolved: Record<string, unknown>;
}
interface CatalogRow {
  name: string;
  chat_toml: string;
  embedding_toml: string;
  image_generation_toml: string;
  providers_toml: string;
  catalog?: {
    chat: Record<string, Record<string, unknown>>;
    chat_order: string[];
    embedding: Record<string, Record<string, unknown>>;
    embedding_order: string[];
    image_generation: Record<string, Record<string, unknown>>;
    image_generation_order: string[];
  };
  err?: string;
}
interface LookupSection {
  toml: string;
  cases: { name: string; qualified_name?: string; err?: string }[];
  first_chat_model: string | null;
  chat_model_names: string[];
}

const fx = fixture as unknown as {
  duration_parse: DurationRow[];
  duration_display: DisplayRow[];
  duration_from_secs: FromSecsRow[];
  keepalive_parse: KeepaliveRow[];
  sdk_parse_wire: SdkWireRow[];
  sdk_flags: SdkFlagsRow[];
  applicability: ApplicabilityRow[];
  default_value: DefaultValueRow[];
  field_keys: { field: string; key: string }[];
  field_from_key: FieldFromKeyRow[];
  provider_defaults: ProviderDefaultsRow[];
  from_parts: FromPartsRow[];
  catalogs: CatalogRow[];
  lookup: LookupSection;
};

function toWire(model: ResolvedModel): Record<string, unknown> {
  const keepalive = model.cacheKeepalive;
  return {
    name: model.name,
    qualified_name: model.qualifiedName,
    category: model.category,
    provider_key: model.providerKey,
    sdk: model.sdk,
    model_id: model.modelId,
    api_key_env: model.apiKeyEnv ?? null,
    base_url: model.baseUrl ?? null,
    max_context_tokens: model.maxContextTokens ?? null,
    max_output_tokens: model.maxOutputTokens ?? null,
    temperature: model.temperature ?? null,
    top_p: model.topP ?? null,
    reasoning_effort: model.reasoningEffort ?? null,
    budget_tokens: model.budgetTokens ?? null,
    cache_ttl: model.cacheTtl ?? null,
    cache_keepalive: keepalive === undefined ? null : keepaliveToString(keepalive),
    openrouter_provider: model.openrouterProvider ?? null,
    gemini_generation: model.geminiGeneration ?? null,
    zai_clear_thinking: model.zaiClearThinking ?? null,
    zai_subscription: model.zaiSubscription ?? null,
    replay_prior_thinking: model.replayPriorThinking ?? null,
    max_tool_iterations: model.maxToolIterations ?? null,
  };
}

function fieldsToWire(fields: ModelConfigFields): Record<string, unknown> {
  const keepalive = fields.cacheKeepalive;
  return {
    sdk: fields.sdk ?? null,
    api_key_env: fields.apiKeyEnv ?? null,
    base_url: fields.baseUrl ?? null,
    max_context_tokens: fields.maxContextTokens ?? null,
    max_output_tokens: fields.maxOutputTokens ?? null,
    temperature: fields.temperature ?? null,
    top_p: fields.topP ?? null,
    reasoning_effort: fields.reasoningEffort ?? null,
    budget_tokens: fields.budgetTokens ?? null,
    cache_ttl: fields.cacheTtl ?? null,
    cache_keepalive: keepalive === undefined ? null : keepaliveToString(keepalive),
    openrouter_provider: fields.openrouterProvider ?? null,
    gemini_generation: fields.geminiGeneration ?? null,
    zai_clear_thinking: fields.zaiClearThinking ?? null,
    zai_subscription: fields.zaiSubscription ?? null,
  };
}

function parseToml(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return undefined;
  return Bun.TOML.parse(text) as Record<string, unknown>;
}

function registryFromToml(text: string): ProviderRegistryView | undefined {
  const table = parseToml(text);
  if (table === undefined) return undefined;
  const entries = new Map<string, ProviderRegistryEntry>();
  for (const [name, raw] of Object.entries(table)) {
    const body = raw as Record<string, unknown>;
    const defaultsTable = (body["defaults"] ?? {}) as Record<string, unknown>;
    const defaults: ModelConfigFields = {};
    if (typeof defaultsTable["max_output_tokens"] === "number") {
      defaults.maxOutputTokens = defaultsTable["max_output_tokens"];
    }
    if (typeof defaultsTable["max_context_tokens"] === "number") {
      defaults.maxContextTokens = defaultsTable["max_context_tokens"];
    }
    if (typeof defaultsTable["temperature"] === "number") {
      defaults.temperature = defaultsTable["temperature"];
    }
    if (typeof defaultsTable["cache_ttl"] === "string") {
      defaults.cacheTtl = defaultsTable["cache_ttl"];
    }
    const entry: ProviderRegistryEntry = { defaults };
    if (typeof body["sdk"] === "string") entry.sdk = body["sdk"] as Sdk;
    if (typeof body["base_url"] === "string") entry.baseUrl = body["base_url"];
    entries.set(name, entry);
  }
  return { get: (name) => entries.get(name) };
}

function firstLine(message: string): string {
  return message.split("\n")[0] as string;
}

function catchCatalogError(fn: () => unknown): CatalogError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error("expected a CatalogError");
}

describe("the case data loaded", () => {
  test("every block the tests read is present and non-empty", () => {
    for (const block of [
      "sdk_parse_wire",
      "sdk_flags",
      "field_keys",
      "field_from_key",
      "provider_defaults",
      "from_parts",
      "catalogs",
    ] as const) {
      expect(((fixture as unknown as Record<string, unknown[]>)[block] ?? []).length, block).toBeGreaterThan(0);
    }
  });

  test("nothing still carries the keepalive default the port removed", () => {
    expect(JSON.stringify(fixture)).not.toContain('"cache_keepalive": "55m"');
  });
});

describe("Sdk", () => {
  for (const row of fx.sdk_parse_wire) {
    test(`parse_wire ${JSON.stringify(row.raw)}`, () => {
      expect<string | null>(sdkFromWire(row.raw) ?? null).toBe(row.sdk);
    });
  }

  for (const row of fx.sdk_flags) {
    test(`${row.sdk} flags`, () => {
      const sdk = row.sdk as Sdk;
      expect(sdk).toBe(row.as_str as Sdk);
      expect(sdkEchoesUnsignedThinking(sdk)).toBe(row.echoes_unsigned_thinking);
      expect(sdkUsesAnthropicPromptCache(sdk)).toBe(row.uses_anthropic_prompt_cache);
    });
  }

  test("moonshotai is an alias, not a distinct sdk", () => {
    expect(sdkFromWire("moonshotai")).toBe("moonshot");
  });
});

describe("Field keys", () => {
  test("every field's key is its own name", () => {
    for (const row of fx.field_keys) expect(row.field).toBe(row.key);
  });

  for (const row of fx.field_from_key) {
    test(`fieldFromKey ${JSON.stringify(row.key)}`, () => {
      expect<string | null>(fieldFromKey(row.key) ?? null).toBe(row.field);
    });
  }
});

describe("hardcodedProviderDefaults", () => {
  for (const row of fx.provider_defaults) {
    test(row.provider || "<empty>", () => {
      expect(fieldsToWire(hardcodedProviderDefaults(row.provider).fields)).toEqual(row.fields);
      expect(defaultSdk(row.provider)).toBe(row.default_sdk as Sdk);
    });
  }

  test("an unknown provider gets nothing, not the shared baseline", () => {
    expect(hardcodedProviderDefaults("whoknows").fields).toEqual({});
    expect(hardcodedProviderDefaults("anthropic").fields.maxContextTokens).toBe(200_000);
  });

  test("opencode-go deliberately leaves sdk unset", () => {
    expect(hardcodedProviderDefaults("opencode-go").fields.sdk).toBeUndefined();
    expect(defaultSdk("opencode-go")).toBe("openai");
  });
});

describe("resolvedModelFromParts", () => {
  for (const [i, row] of fx.from_parts.entries()) {
    test(`${i}: ${row.sdk_fallback} / ${row.model_id}`, () => {
      const fields: ModelConfigFields =
        row.explicit_samplers === true
          ? { temperature: 0.3, topP: 0.9, budgetTokens: 4096 }
          : { temperature: 1.0, maxOutputTokens: 8192 };
      const resolved = resolvedModelFromParts(
        "m",
        "chat.p.m",
        "chat",
        "p",
        row.model_id,
        row.sdk_fallback as Sdk,
        fields,
      );
      expect(toWire(resolved)).toEqual(row.resolved);
    });
  }

  test("an anthropic/* slug promotes the sdk only when none was pinned", () => {
    const promoted = resolvedModelFromParts(
      "m", "chat.p.m", "chat", "p", "anthropic/claude-opus-4-6", "openrouter", {},
    );
    expect(promoted.sdk).toBe("anthropic");
    expect(promoted.cacheTtl).toBe("1h");

    const pinned = resolvedModelFromParts(
      "m", "chat.p.m", "chat", "p", "anthropic/claude-opus-4-6", "openrouter",
      { sdk: "openrouter" },
    );
    expect(pinned.sdk).toBe("openrouter");
    expect(pinned.cacheTtl).toBeUndefined();
  });

  test("an explicit cache_ttl of empty string survives the default", () => {
    const model = resolvedModelFromParts(
      "m", "chat.p.m", "chat", "p", "claude-opus-4-6", "anthropic", { cacheTtl: "" },
    );
    expect(model.cacheTtl).toBe("");
  });

  test("an explicit keepalive is carried, and nothing is defaulted in beside it", () => {
    const off = resolvedModelFromParts(
      "m", "chat.p.m", "chat", "p", "claude-opus-4-6", "anthropic",
      { cacheKeepalive: { kind: "off" } },
    );
    expect(keepaliveToString(off.cacheKeepalive as never)).toBe("off");

    const every = resolvedModelFromParts(
      "m", "chat.p.m", "chat", "p", "claude-opus-4-6", "anthropic",
      { cacheKeepalive: { kind: "every", interval: ConfigDuration.fromSecs(3300) } as never },
    );
    expect(keepaliveToString(every.cacheKeepalive as never)).toBe("55m");

    const defaulted = resolvedModelFromParts(
      "m", "chat.p.m", "chat", "p", "claude-opus-4-6", "anthropic", {},
    );
    expect(defaulted.cacheKeepalive).toBeUndefined();
    expect(defaulted.cacheTtl).toBe("1h");
  });

  test("the input fields are not mutated", () => {
    const fields: ModelConfigFields = { temperature: 1.0 };
    resolvedModelFromParts("m", "q", "chat", "p", "claude-opus-4-7", "anthropic", fields);
    expect(fields.temperature).toBe(1.0);
  });

  test("the runtime-overlay fields are left absent, not null", () => {
    const model = resolvedModelFromParts("m", "q", "chat", "p", "x", "openai", {});
    expect("replayPriorThinking" in model).toBe(false);
    expect("maxToolIterations" in model).toBe(false);
  });
});

describe("field merging", () => {
  test("mergeFrom overwrites only present overlay fields", () => {
    const target: ModelConfigFields = { temperature: 1.0, maxOutputTokens: 8192 };
    mergeFrom(target, { temperature: 0.2 });
    expect(target).toEqual({ temperature: 0.2, maxOutputTokens: 8192 });
  });

  test("orFallback prefers self and fills the rest", () => {
    const self: ModelConfigFields = { temperature: 0.2 };
    const fallback: ModelConfigFields = { temperature: 1.0, maxOutputTokens: 8192 };
    expect(orFallback(self, fallback)).toEqual({ temperature: 0.2, maxOutputTokens: 8192 });
  });

  test("orFallback does not alias the openrouter_provider value", () => {
    const fallback: ModelConfigFields = { openrouterProvider: { order: ["a"] } };
    const merged = orFallback({}, fallback);
    expect(merged.openrouterProvider).toEqual({ order: ["a"] });
  });

  test("a false boolean is a value, not an absence", () => {
    const merged = orFallback({ zaiClearThinking: false }, { zaiClearThinking: true });
    expect(merged.zaiClearThinking).toBe(false);
  });
});

describe("catalogFromSections", () => {
  for (const row of fx.catalogs) {
    test(row.name, () => {
      const build = () =>
        catalogFromSections(
          parseToml(row.chat_toml),
          parseToml(row.embedding_toml),
          parseToml(row.image_generation_toml),
          registryFromToml(row.providers_toml),
        );

      if (row.err !== undefined) {
        const error = catchCatalogError(build);
        expect(firstLine(error.message)).toBe(firstLine(row.err));
        return;
      }

      const catalog = build();
      const expected = row.catalog as NonNullable<CatalogRow["catalog"]>;

      expect([...catalog.chat.keys()]).toEqual(expected.chat_order);
      for (const [key, model] of catalog.chat) {
        expect(toWire(model)).toEqual(
          expected.chat[key] as Record<string, unknown>,
        );
      }

      expect([...catalog.embedding.keys()]).toEqual(expected.embedding_order);
      for (const [key, settings] of catalog.embedding) {
        const want = expected.embedding[key] as Record<string, unknown>;
        expect<Record<string, unknown>>({ dimensions: settings.dimensions ?? null }).toEqual(want);
      }

      expect([...catalog.imageGeneration.keys()]).toEqual(expected.image_generation_order);
      for (const [key, settings] of catalog.imageGeneration) {
        const want = expected.image_generation[key] as Record<string, unknown>;
        expect<Record<string, unknown>>({
          size: settings.size ?? null,
          quality: settings.quality ?? null,
          aspect_ratio: settings.aspectRatio ?? null,
          image_size: settings.imageSize ?? null,
        }).toEqual(want);
      }
    });
  }

  test("catalog order is code point order, not UTF-16 order", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse(
        '["🎵drum".m]\nmodel_id = "a"\n["ﬀute".m]\nmodel_id = "b"\n[zzz.m]\nmodel_id = "c"\n',
      ) as Record<string, unknown>,
      undefined,
      undefined,
    );
    expect([...catalog.chat.keys()]).toEqual([
      "chat.zzz.m",
      "chat.ﬀute.m",
      "chat.🎵drum.m",
    ]);
    expect([...catalog.chat.keys()].sort()).not.toEqual([...catalog.chat.keys()]);
  });

  test("the \\U escape decodes the way Rust's does", () => {
    expect(Bun.TOML.parse('a = "\\U0001F3B5"')).toEqual({ a: "🎵" });
    expect(Bun.TOML.parse('a = "\\u00e9"')).toEqual({ a: "é" });
    expect(Bun.TOML.parse('a = "🎵"')).toEqual({ a: "🎵" });
  });

  test("the retired-scalar error names the first offending key in BTreeMap order", () => {
    const error = catchCatalogError(() =>
      catalogFromSections(
        Bun.TOML.parse('[anthropic]\nzzz = 1\naaa = 2\n[anthropic.opus]\nmodel_id = "x"\n') as Record<
          string,
          unknown
        >,
        undefined,
        undefined,
      ),
    );
    expect(error.message).toContain("`aaa`");
    expect(error.message).not.toContain("`zzz`");
  });

  test("a transport scalar and a behavioral scalar point at different homes", () => {
    const transport = catchCatalogError(() =>
      catalogFromSections(
        Bun.TOML.parse('[anthropic]\nsdk = "anthropic"\n') as Record<string, unknown>,
        undefined,
        undefined,
      ),
    );
    expect(transport.message).toContain("the matching [providers.<name>] entry");

    const behavioral = catchCatalogError(() =>
      catalogFromSections(
        Bun.TOML.parse("[anthropic]\nmax_output_tokens = 1\n") as Record<string, unknown>,
        undefined,
        undefined,
      ),
    );
    expect(behavioral.message).toContain("[providers.<name>.defaults]");
  });

  test("the registry cascade sits between hardcoded defaults and per-model fields", () => {
    const chat = Bun.TOML.parse(
      '[custom.fast]\nmodel_id = "m"\nmax_output_tokens = 111\n',
    ) as Record<string, unknown>;
    const registry = registryFromToml(
      '[custom]\nsdk = "openai"\nbase_url = "https://custom.example/v1"\n' +
        "[custom.defaults]\nmax_output_tokens = 4096\ntemperature = 0.7\n",
    );
    const catalog = catalogFromSections(chat, undefined, undefined, registry);
    const model = catalog.chat.get("chat.custom.fast") as ResolvedModel;

    expect(model.maxOutputTokens).toBe(111);
    expect(model.temperature).toBe(0.7);
    expect(model.baseUrl).toBe("https://custom.example/v1");
    expect(model.sdk).toBe("openai");
  });

  test("a provider default idle ceiling reaches its models, and a model overrides it", () => {
    const chat = Bun.TOML.parse(
      '[moonshotai.k3]\nmodel_id = "kimi-k3"\n' +
        '[moonshotai.k3-long]\nmodel_id = "kimi-k3"\ncache_keepalive_max = "6h"\n',
    ) as Record<string, unknown>;
    const read = readModelConfigFields(
      Bun.TOML.parse('cache_keepalive = "10m"\ncache_keepalive_max = "90m"\n') as Record<
        string,
        unknown
      >,
    );
    if ("err" in read) throw new Error(read.err);
    const registry: ProviderRegistryView = {
      get: () => ({ sdk: "openai", defaults: read.ok }),
    };
    const catalog = catalogFromSections(chat, undefined, undefined, registry);

    const inherited = catalog.chat.get("chat.moonshotai.k3") as ResolvedModel;
    expect(inherited.cacheKeepaliveMax?.toString()).toBe("90m");

    const overridden = catalog.chat.get("chat.moonshotai.k3-long") as ResolvedModel;
    expect(overridden.cacheKeepaliveMax?.toString()).toBe("6h");
  });

  test("a model that names no ceiling leaves the field absent for the global to fill", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse('[anthropic.main]\nmodel_id = "claude-opus-4-6"\n') as Record<
        string,
        unknown
      >,
      undefined,
      undefined,
    );
    expect((catalog.chat.get("chat.anthropic.main") as ResolvedModel).cacheKeepaliveMax)
      .toBeUndefined();
  });

  test("registry credentials deliberately do not cascade", () => {
    const registry: ProviderRegistryView = {
      get: () => ({ sdk: "openai", defaults: {}, baseUrl: "https://x/v1" }),
    };
    const catalog = catalogFromSections(
      Bun.TOML.parse('[custom.fast]\nmodel_id = "m"\n') as Record<string, unknown>,
      undefined,
      undefined,
      registry,
    );
    expect((catalog.chat.get("chat.custom.fast") as ResolvedModel).apiKeyEnv).toBeUndefined();
  });

  test("the provider defaults are not shared between models", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse(
        '[anthropic.new]\nmodel_id = "claude-opus-4-7"\ntemperature = 0.5\n[anthropic.old]\nmodel_id = "claude-opus-4-6"\n',
      ) as Record<string, unknown>,
      undefined,
      undefined,
    );
    expect((catalog.chat.get("chat.anthropic.new") as ResolvedModel).temperature).toBe(0.5);
    expect((catalog.chat.get("chat.anthropic.old") as ResolvedModel).temperature).toBeUndefined();
  });

  test("the final sort is load-bearing, not a formality", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse('[a.m]\nmodel_id = "x"\n["a-b".m]\nmodel_id = "y"\n') as Record<
        string,
        unknown
      >,
      undefined,
      undefined,
    );
    expect([...catalog.chat.keys()]).toEqual(["chat.a-b.m", "chat.a.m"]);
  });

  test("a non-table provider value is skipped, not an error", () => {
    const catalog = catalogFromSections(
      Bun.TOML.parse("anthropic = 1\n") as Record<string, unknown>,
      undefined,
      undefined,
    );
    expect(catalog.chat.size).toBe(0);
  });
});

describe("findModel", () => {
  const catalog = catalogFromSections(
    Bun.TOML.parse(fx.lookup.toml) as Record<string, unknown>,
    undefined,
    undefined,
  );

  for (const row of fx.lookup.cases) {
    test(`looks up ${JSON.stringify(row.name)}`, () => {
      if (row.err !== undefined) {
        const error = catchCatalogError(() => findModel(catalog, row.name));
        expect(error.message).toBe(row.err);
        return;
      }
      expect(findModel(catalog, row.name).qualifiedName).toBe(row.qualified_name as string);
    });
  }

  test("first_chat_model and chat_model_names follow catalog order", () => {
    expect(firstChatModel(catalog)?.qualifiedName ?? null).toBe(fx.lookup.first_chat_model);
    expect(chatModelNames(catalog)).toEqual(fx.lookup.chat_model_names);
  });

  test("a qualified name beats a short name", () => {
    expect(findModel(catalog, "chat.openrouter.opus").providerKey).toBe("openrouter");
    expect(() => findModel(catalog, "opus")).toThrow(/ambiguous/);
  });

  test("an empty catalog reports not-found rather than throwing something else", () => {
    const empty = catalogFromSections(undefined, undefined, undefined);
    const error = catchCatalogError(() => findModel(empty, "opus"));
    expect(error.kind).toBe("not_found");
    expect(firstChatModel(empty)).toBeUndefined();
  });
});
