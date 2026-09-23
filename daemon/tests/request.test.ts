import { describe, expect, test } from "bun:test";

import {
  buildRequest,
  buildRequestWithProviderKeys,
  buildRequestWithResolvedKey,
  defaultBaseUrl,
  MissingApiKey,
  preprocessRequest,
  hardcodedProviderBaseUrl,
  providerOptionsFor,
  type ResolvedModel,
} from "../src/llm/request";
import { defaultApiKeyEnv, type ProviderEntry } from "../src/llm/credentials";
import type { SidecarRequest, ThinkingReplay } from "../src/llm/types";

function model(over: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    name: "fixture",
    qualifiedName: "chat.fixture",
    providerKey: "openrouter",
    provider_key: "openrouter",
    sdk: "openai",
    model_id: "vendor/model",
    ...over,
  } as unknown as ResolvedModel;
}

const INPUTS = { messages: [], replay: "all" as ThinkingReplay };
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe("what a provider is reached at by default", () => {
  test("each supported provider has its own endpoint and key variable", () => {
    for (const key of [
      "anthropic",
      "openai",
      "openrouter",
      "deepseek",
      "xai",
      "zai-api",
      "zai-sub",
    ]) {
      expect(defaultBaseUrl(key), key).toMatch(/^https:\/\//);
      expect(defaultApiKeyEnv(key), key).toMatch(/_API_KEY$/);
    }
  });

  test("no two providers share an endpoint, so one cannot be reached as another", () => {
    const urls = [
      "anthropic",
      "openai",
      "openrouter",
      "deepseek",
      "xai",
      "zai-api",
      "zai-sub",
    ].map((k) => defaultBaseUrl(k));
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("moonshot's two spellings are one provider", () => {
    expect(defaultBaseUrl("moonshotai")).toBe(defaultBaseUrl("moonshot"));
    expect(defaultApiKeyEnv("moonshotai")).toBe(defaultApiKeyEnv("moonshot"));
  });

  test("an unknown provider gets a fallback key variable but no invented endpoint", () => {
    expect(defaultApiKeyEnv("nobody-has-heard-of-this")).toBe("LLM_API_KEY");
    expect(defaultBaseUrl("nobody-has-heard-of-this")).toBeUndefined();
    expect(defaultBaseUrl("")).toBeUndefined();
  });
});

describe("the two base-URL lookups cannot drift apart", () => {
  test("every provider with a hardcoded endpoint is reachable by default", () => {
    for (const key of [
      "openrouter",
      "moonshot",
      "moonshotai",
      "xai",
      "zhipuai",
      "zai-api",
      "zai-sub",
      "nanogpt",
      "opencode-go",
    ]) {
      expect(defaultBaseUrl(key), key).toBe(hardcodedProviderBaseUrl(key));
      expect(defaultBaseUrl(key), key).toMatch(/^https:\/\//);
    }
  });

  test("nano-gpt discovery has an endpoint to talk to", () => {
    expect(defaultBaseUrl("nanogpt")).toBe("https://nano-gpt.com/api/v1");
  });
});

describe("the provider options a model derives", () => {
  test("are absent entirely when the model asks for nothing", () => {
    expect(providerOptionsFor(model())).toBeUndefined();
  });

  test("carry only what the model actually set", () => {
    expect(plain(providerOptionsFor(model({ reasoning_effort: "high" })))).toEqual({
      reasoning_effort: "high",
    });
    expect(plain(providerOptionsFor(model({ cache_ttl: "1h" })))).toEqual({ cache_ttl: "1h" });
  });

  test("combine when several are set", () => {
    const got = plain(
      providerOptionsFor(model({ reasoning_effort: "low", budget_tokens: 2048, cache_ttl: "5m" })),
    );
    expect(got).toEqual({ reasoning_effort: "low", budget_tokens: 2048, cache_ttl: "5m" });
  });

  test("turn `off` into a disabled flag, never an effort level on the wire", () => {
    const got = plain(providerOptionsFor(model({ reasoning_effort: "off" }))) as Record<
      string,
      unknown
    >;
    expect(got.thinking_enabled).toBe(false);
    expect(Object.hasOwn(got, "reasoning_effort")).toBe(false);
  });

  test("carry a false flag, which is a setting, not an absence", () => {
    const got = plain(providerOptionsFor(model({ zai_clear_thinking: false }))) as Record<
      string,
      unknown
    >;
    expect(got.zai_clear_thinking).toBe(false);
  });
});

describe("building a request once the key is known", () => {
  test("carries the model's identity and the caller's key", () => {
    const built = buildRequestWithResolvedKey(
      model({ base_url: "https://or.test/v1" }),
      "sk-resolved",
      INPUTS,
    );
    expect(built.request).toMatchObject({
      sdk: "openai",
      model: "vendor/model",
      api_key: "sk-resolved",
      base_url: "https://or.test/v1",
      provider_key: "openrouter",
      replay_prior_thinking: "all",
    });
  });

  test("gives max_tokens a default rather than sending nothing", () => {
    expect(buildRequestWithResolvedKey(model(), "k", INPUTS).request.max_tokens).toBeGreaterThan(0);
    expect(
      buildRequestWithResolvedKey(model({ max_output_tokens: 100 }), "k", INPUTS).request.max_tokens,
    ).toBe(100);
  });

  test("omits sampling knobs the model did not set", () => {
    const request = buildRequestWithResolvedKey(model(), "k", INPUTS).request;
    expect(Object.hasOwn(request, "temperature")).toBe(false);
    expect(Object.hasOwn(request, "top_p")).toBe(false);
  });

  test("keeps a zero temperature, which is a real setting", () => {
    expect(
      buildRequestWithResolvedKey(model({ temperature: 0 }), "k", INPUTS).request.temperature,
    ).toBe(0);
  });

  test("caller-supplied provider options replace the derived ones outright", () => {
    const built = buildRequestWithResolvedKey(model({ reasoning_effort: "high" }), "k", {
      ...INPUTS,
      providerOptions: { cache_ttl: "1h" },
    });
    expect(built.request.provider_options).toEqual({ cache_ttl: "1h" });
  });
});

describe("keepalive settings ride alongside the request, never inside it", () => {
  test("an interval is returned in milliseconds and stays off the wire", () => {
    const built = buildRequestWithResolvedKey(model({ sdk: "anthropic", cache_ttl: "1h", cache_keepalive: "10m" }), "k", INPUTS);
    expect(built.keepalive_interval_ms).toBe(600_000);
    expect(Object.keys(built.request)).not.toContain("keepalive_interval");
    expect(Object.keys(built.request)).not.toContain("cache_keepalive");
  });

  test("a ping count rides beside the cadence and stays off the wire", () => {
    const built = buildRequestWithResolvedKey(model({ cache_keepalive: "10m", cache_keepalive_pings: 4 }), "k", INPUTS);
    expect(built.keepalive_pings).toBe(4);
    expect(Object.keys(built.request)).not.toContain("keepalive_pings");
    expect(Object.keys(built.request)).not.toContain("cache_keepalive_pings");
  });

  test("a cadence with no count takes one ping", () => {
    const built = buildRequestWithResolvedKey(model({ cache_keepalive: "10m" }), "k", INPUTS);
    expect(built.keepalive_pings).toBe(1);
  });

  test("a count without a cadence arms nothing", () => {
    const built = buildRequestWithResolvedKey(model({ cache_keepalive_pings: 4 }), "k", INPUTS);
    expect(built.keepalive_interval_ms).toBeUndefined();
    expect(built.keepalive_pings).toBeUndefined();
  });
});

describe("finding the key in the environment", () => {
  test("the model's own variable is used when it names one", () => {
    const built = buildRequest(model({ api_key_env: "MY_KEY" }), INPUTS, { MY_KEY: "sk-mine" });
    expect(built.request.api_key).toBe("sk-mine");
  });

  test("the provider's conventional variable is the fallback", () => {
    const built = buildRequest(model(), INPUTS, { OPENROUTER_API_KEY: "sk-conventional" });
    expect(built.request.api_key).toBe("sk-conventional");
  });

  test("an unset variable is an error naming it, never a silent empty key", () => {
    expect(() => buildRequest(model({ api_key_env: "ABSENT_VAR" }), INPUTS, {})).toThrow(
      MissingApiKey,
    );
    try {
      buildRequest(model({ api_key_env: "ABSENT_VAR" }), INPUTS, {});
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MissingApiKey).variable).toBe("ABSENT_VAR");
      expect((e as Error).message).toContain("ABSENT_VAR");
    }
  });

  test("an empty or blank value is not a credential", () => {
    for (const value of ["", "   "]) {
      expect(() => buildRequest(model({ api_key_env: "E" }), INPUTS, { E: value })).toThrow(
        MissingApiKey,
      );
    }
  });
});

describe("choosing among a provider's configured keys", () => {
  const env: NodeJS.ProcessEnv = {
    FIX_FALLBACK: "sk-fallback",
    FIX_LEGACY: "sk-legacy",
    OPENROUTER_API_KEY: "sk-openrouter-default",
  };
  const key = (name: string, e: string, enabled = true) => ({
    name,
    env: e,
    enabled,
    warn_on_fallback: false,
  });
  const entry = (keys: ReturnType<typeof key>[], enabled = true): ProviderEntry => ({
    enabled,
    keys,
  });

  test("the first candidate whose variable is set wins", () => {
    const built = buildRequestWithProviderKeys(
      model(),
      entry([key("primary", "FIX_PRIMARY"), key("fallback", "FIX_FALLBACK")]),
      INPUTS,
      env,
    );
    expect(built.request.api_key).toBe("sk-fallback");
    expect(built.api_key_name).toBe("fallback");
  });

  test("with several set, order still decides", () => {
    const built = buildRequestWithProviderKeys(
      model(),
      entry([key("first", "FIX_FALLBACK"), key("second", "FIX_LEGACY")]),
      INPUTS,
      env,
    );
    expect(built.api_key_name).toBe("first");
  });

  test("a disabled key is skipped even when its variable is set", () => {
    const built = buildRequestWithProviderKeys(
      model(),
      entry([key("off", "FIX_FALLBACK", false), key("on", "FIX_LEGACY")]),
      INPUTS,
      env,
    );
    expect(built.api_key_name).toBe("on");
    expect(built.request.api_key).toBe("sk-legacy");
  });

  test("an entry with no keys falls back to the conventional variable", () => {
    const built = buildRequestWithProviderKeys(model(), entry([]), INPUTS, env);
    expect(built.request.api_key).toBe("sk-openrouter-default");
  });

  test("a disabled provider is an error, not an ambient lookup", () => {
    expect(() => buildRequestWithProviderKeys(model(), entry([], false), INPUTS, env)).toThrow(
      MissingApiKey,
    );
  });

  test("every candidate unset names the last variable tried, so the fix is obvious", () => {
    try {
      buildRequestWithProviderKeys(
        model(),
        entry([key("one", "FIX_MISSING_ONE"), key("two", "FIX_MISSING_TWO")]),
        INPUTS,
        env,
      );
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MissingApiKey).variable).toBe("FIX_MISSING_TWO");
    }
  });

  test("a subscription sdk is billed to the subscription, not to a key that happens to be set", () => {
    const built = buildRequestWithProviderKeys(
      model({ provider_key: "anthropic", sdk: "claude_agent" }),
      entry([key("primary", "ANTHROPIC_API_KEY")]),
      INPUTS,
      { ...env, ANTHROPIC_API_KEY: "sk-ant-would-be-billed" },
    );
    expect(built.request.api_key).toBe("");
    expect(built.api_key_name).toBe("subscription");
  });

  test("a key-using sdk on the same provider still takes the key", () => {
    const built = buildRequestWithProviderKeys(
      model({ provider_key: "anthropic", sdk: "anthropic" }),
      entry([key("primary", "ANTHROPIC_API_KEY")]),
      INPUTS,
      { ...env, ANTHROPIC_API_KEY: "sk-ant-would-be-billed" },
    );
    expect(built.request.api_key).toBe("sk-ant-would-be-billed");
  });

  test("with no registry entry at all, the model's own variable still seeds the lookup", () => {
    const built = buildRequestWithProviderKeys(
      model({ api_key_env: "FIX_LEGACY" }),
      undefined,
      INPUTS,
      env,
    );
    expect(built.request.api_key).toBe("sk-legacy");
  });
});

describe("preprocessing a request before it goes out", () => {
  const request = (over: Partial<SidecarRequest> = {}): SidecarRequest =>
    ({
      sdk: "openai",
      model: "m",
      api_key: "k",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 1024,
      replay_prior_thinking: "all",
      ...over,
    }) as unknown as SidecarRequest;

  test("a request needing no repair is handed back as-is, not copied", () => {
    const input = request();
    expect(preprocessRequest(input)).toBe(input);
  });

  test("an orphaned tool pair is repaired into a new request", () => {
    const input = request({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }] },
      ],
    });
    const got = preprocessRequest(input);
    expect(got).not.toBe(input);
    expect(got.messages).toEqual([]);
  });

  test("the input is never mutated, whichever branch runs", () => {
    for (const input of [
      request(),
      request({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }] },
        ],
      }),
    ]) {
      const before = JSON.stringify(input);
      preprocessRequest(input);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});
