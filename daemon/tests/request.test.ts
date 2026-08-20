import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import {
  buildRequest,
  buildRequestWithProviderKeys,
  buildRequestWithResolvedKey,
  defaultBaseUrl,
  MissingApiKey,
  preprocessRequest,
  providerOptionsFor,
  providerOptionsFor as derive,
  requiresReasoningReplay,
  type ResolvedModel,
} from "../src/llm/request";
import { defaultApiKeyEnv, type ProviderEntry } from "../src/llm/credentials";
import type { ProviderOptions, SidecarRequest, ThinkingReplay } from "../src/llm/types";

type Json = Record<string, unknown>;

interface ModelJson {
  name: string;
  qualified_name: string;
  category: string;
  provider_key: string;
  sdk: string;
  model_id: string;
  api_key_env: string | null;
  base_url: string | null;
  max_context_tokens: number | null;
  max_output_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  reasoning_effort: string | null;
  budget_tokens: number | null;
  cache_ttl: string | null;
  cache_keepalive: string | null;
  openrouter_provider: unknown;
  gemini_generation: number | null;
  zai_clear_thinking: boolean | null;
  zai_subscription: boolean | null;
  max_tool_iterations: number | null;
}

interface Fixture {
  provider_tables: {
    provider_key: string;
    default_api_key_env: string;
    default_base_url: string | null;
    requires_reasoning_replay: boolean;
  }[];
  provider_options_for: { name: string; model: ModelJson; expect: Json | null }[];
  build_request_with_resolved_key: {
    name: string;
    model: ModelJson;
    replay: ThinkingReplay;
    expect: Json;
    keepalive_interval_ms: number | null;
    retain_long: boolean;
  }[];
  build_request: {
    name: string;
    model: ModelJson;
    env: Record<string, string>;
    expect: { ok: { api_key: string; api_key_name: string | null } } | { error: string };
  }[];
  build_request_with_provider_keys: {
    name: string;
    providers_toml: string;
    model: ModelJson;
    expect: { ok: { api_key: string; api_key_name: string | null } } | { error: string };
  }[];
  preprocess_request: { name: string; request: Json; borrowed: boolean; expect: Json }[];
}

const fixture = (await Bun.file(
  new URL("./llm_fixtures/request.json", import.meta.url),
).json()) as Fixture;

function model(m: ModelJson): ResolvedModel {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v !== null) out[k] = v;
  }
  return out as unknown as ResolvedModel;
}

function plain(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

describe("the fixture is real", () => {
  test("provider options are recorded present and absent", () => {
    expect(fixture.provider_options_for.some((c) => c.expect === null)).toBe(true);
    expect(fixture.provider_options_for.some((c) => c.expect !== null)).toBe(true);
  });

  test("both credential outcomes are recorded", () => {
    for (const section of [fixture.build_request, fixture.build_request_with_provider_keys]) {
      expect(section.some((c) => "ok" in c.expect)).toBe(true);
      expect(section.some((c) => "error" in c.expect)).toBe(true);
    }
  });

  test("a keepalive case carries a real interval and another carries none", () => {
    const withInterval = fixture.build_request_with_resolved_key.filter(
      (c) => c.keepalive_interval_ms !== null,
    );
    const without = fixture.build_request_with_resolved_key.filter(
      (c) => c.keepalive_interval_ms === null,
    );
    expect(withInterval.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });

  test("both preprocessing branches are recorded", () => {
    expect(fixture.preprocess_request.some((c) => c.borrowed)).toBe(true);
    expect(fixture.preprocess_request.some((c) => !c.borrowed)).toBe(true);
  });
});

describe("provider tables", () => {
  for (const c of fixture.provider_tables) {
    test(c.provider_key || "(empty)", () => {
      expect(defaultApiKeyEnv(c.provider_key)).toBe(c.default_api_key_env);
      expect(defaultBaseUrl(c.provider_key)).toBe(c.default_base_url ?? undefined);
      expect(requiresReasoningReplay(c.provider_key)).toBe(c.requires_reasoning_replay);
    });
  }

  test("an unknown provider gets a fallback key var but no base URL", () => {
    expect(defaultApiKeyEnv("nobody-has-heard-of-this")).toBe("LLM_API_KEY");
    expect(defaultBaseUrl("nobody-has-heard-of-this")).toBeUndefined();
  });
});

describe("providerOptionsFor", () => {
  for (const c of fixture.provider_options_for) {
    test(c.name, () => {
      const got = providerOptionsFor(model(c.model));
      if (c.expect === null) {
        expect(got).toBeUndefined();
        return;
      }
      expect(plain(got)).toEqual(c.expect);
    });
  }

  test("the off sentinel never reaches the wire as an effort", () => {
    const m = model(required(fixture.provider_options_for[0]).model);
    const got = derive({ ...m, reasoning_effort: "off" }) as ProviderOptions;
    expect(got.reasoning_effort).toBeUndefined();
    expect(got.thinking_enabled).toBe(false);
  });
});

describe("buildRequestWithResolvedKey", () => {
  for (const c of fixture.build_request_with_resolved_key) {
    test(c.name, () => {
      const built = buildRequestWithResolvedKey(model(c.model), "sk-resolved", {
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        replay: c.replay,
      });
      expect(plain(built.request)).toEqual(c.expect);
      expect(built.keepalive_interval_ms ?? null).toBe(c.keepalive_interval_ms);
    });
  }

  test("keepalive never reaches the serialized request", () => {
    for (const c of fixture.build_request_with_resolved_key) {
      const built = buildRequestWithResolvedKey(model(c.model), "k", {
        messages: [],
        replay: c.replay,
      });
      expect(Object.keys(built.request), c.name).not.toContain("keepalive_interval");
    }
  });

  test("caller-supplied provider options replace the derived ones", () => {
    const withEffort = model({
      ...required(fixture.provider_options_for[0]).model,
      reasoning_effort: "high",
    });
    const built = buildRequestWithResolvedKey(withEffort, "k", {
      messages: [],
      replay: "all",
      providerOptions: { cache_ttl: "1h" },
    });
    expect(built.request.provider_options).toEqual({ cache_ttl: "1h" });
  });
});

describe("buildRequest", () => {
  for (const c of fixture.build_request) {
    test(c.name, () => {
      const inputs = { messages: [], replay: "all" as ThinkingReplay };
      if ("error" in c.expect) {
        expect(() => buildRequest(model(c.model), inputs, c.env)).toThrow(c.expect.error);
        return;
      }
      const built = buildRequest(model(c.model), inputs, c.env);
      expect(built.request.api_key).toBe(c.expect.ok.api_key);
      expect(built.api_key_name ?? null).toBe(c.expect.ok.api_key_name);
    });
  }

  test("an empty environment value is not a credential", () => {
    const m = model(required(fixture.build_request[0]).model);
    expect(() => buildRequest({ ...m, api_key_env: "E" }, { messages: [], replay: "all" }, { E: "" })).toThrow(
      MissingApiKey,
    );
  });

  test("the error names the variable and never the value", () => {
    const m = model(required(fixture.build_request[0]).model);
    try {
      buildRequest({ ...m, api_key_env: "ABSENT_VAR" }, { messages: [], replay: "all" }, {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MissingApiKey).variable).toBe("ABSENT_VAR");
      expect((e as Error).message).toContain("ABSENT_VAR");
    }
  });
});

describe("buildRequestWithProviderKeys", () => {
  const entries: Record<string, ProviderEntry | undefined> = {
    "the first candidate whose env is set wins": {
      enabled: true,
      keys: [
        { name: "primary", env: "FIX_PRIMARY", enabled: true, warn_on_fallback: false },
        { name: "fallback", env: "FIX_FALLBACK", enabled: true, warn_on_fallback: false },
      ],
    },
    "with several candidates set, the first still wins": {
      enabled: true,
      keys: [
        { name: "first", env: "FIX_FALLBACK", enabled: true, warn_on_fallback: false },
        { name: "second", env: "FIX_LEGACY", enabled: true, warn_on_fallback: false },
      ],
    },
    "a disabled key is skipped even when its variable is set": {
      enabled: true,
      keys: [
        { name: "off", env: "FIX_FALLBACK", enabled: false, warn_on_fallback: false },
        { name: "on", env: "FIX_LEGACY", enabled: true, warn_on_fallback: false },
      ],
    },
    "a registry entry with no keys keeps the legacy single-key path": {
      enabled: true,
      keys: [],
    },
    "a disabled provider is an error, not an ambient env lookup": {
      enabled: false,
      keys: [],
    },
    "every candidate unset names the last variable tried": {
      enabled: true,
      keys: [
        { name: "one", env: "FIX_MISSING_ONE", enabled: true, warn_on_fallback: false },
        { name: "two", env: "FIX_MISSING_TWO", enabled: true, warn_on_fallback: false },
      ],
    },
    "the model's api_key_env seeds the legacy candidate": { enabled: true, keys: [] },
  };

  const env: NodeJS.ProcessEnv = {
    FIX_FALLBACK: "sk-fallback",
    FIX_LEGACY: "sk-legacy",
    OPENROUTER_API_KEY: "sk-openrouter-default",
  };

  for (const c of fixture.build_request_with_provider_keys) {
    test(c.name, () => {
      const entry = entries[c.name];
      const inputs = { messages: [], replay: "all" as ThinkingReplay };
      if ("error" in c.expect) {
        expect(() => buildRequestWithProviderKeys(model(c.model), entry, inputs, env)).toThrow(
          c.expect.error,
        );
        return;
      }
      const built = buildRequestWithProviderKeys(model(c.model), entry, inputs, env);
      expect(built.request.api_key).toBe(c.expect.ok.api_key);
      expect(built.api_key_name ?? null).toBe(c.expect.ok.api_key_name);
    });
  }

  test("every fixture case is covered by a mapped registry entry", () => {
    for (const c of fixture.build_request_with_provider_keys) {
      expect(Object.hasOwn(entries, c.name), c.name).toBe(true);
    }
  });
});

describe("preprocessRequest", () => {
  for (const c of fixture.preprocess_request) {
    test(c.name, () => {
      const request = c.request as unknown as SidecarRequest;
      const got = preprocessRequest(request);
      expect(plain(got)).toEqual(c.expect);
      expect(got === request, "borrowed").toBe(c.borrowed);
    });
  }

  test("the input request is never mutated", () => {
    for (const c of fixture.preprocess_request) {
      const request = c.request as unknown as SidecarRequest;
      const before = JSON.stringify(request);
      preprocessRequest(request);
      expect(JSON.stringify(request), c.name).toBe(before);
    }
  });
});
