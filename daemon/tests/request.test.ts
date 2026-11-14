import { describe, expect, test } from "bun:test";

import { thinkingEnabled } from "../src/handler/generation.ts";
import { buildRequest, buildRequestWithProviderKeys, MissingApiKey, providerOptionsFor, type ResolvedModel } from "../src/llm/request";
import { type ProviderEntry } from "../src/llm/credentials";
import type { ProviderOptions, ThinkingReplay } from "../src/llm/types";

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

describe("finding the key in the environment", () => {

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

  test("a disabled provider is an error, not an ambient lookup", () => {
    expect(() => buildRequestWithProviderKeys(model(), entry([], false), INPUTS, env)).toThrow(
      MissingApiKey,
    );
    expect(() => buildRequestWithProviderKeys(model(), entry([], false), INPUTS, env)).toThrow("provider 'openrouter' has no enabled keys");
  });

  test("the first key whose variable is set is used, and when none is, the last one tried is named", () => {
    const keys = [key("first", "FIX_UNSET_ONE"), key("second", "FIX_FALLBACK"), key("third", "FIX_LEGACY")];
    const built = buildRequestWithProviderKeys(model(), entry(keys), INPUTS, env);
    expect([built.api_key_name, built.request.api_key]).toEqual(["second", "sk-fallback"]);
    const missing = (() => {
      try {
        buildRequestWithProviderKeys(model(), entry([key("first", "FIX_UNSET_ONE"), key("second", "FIX_UNSET_TWO")]), INPUTS, env);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(missing).toBeInstanceOf(MissingApiKey);
    expect((missing as MissingApiKey).variable).toBe("FIX_UNSET_TWO");
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
});

describe("the settings a provider is handed with a request", () => {
  const withSettings = (settings: Partial<ResolvedModel>): ResolvedModel => ({
    name: "m", qualified_name: "p:m", category: "chat", provider_key: "p", sdk: "openai", model_id: "m", ...settings,
  });

  test("each of a model's reasoning and vendor settings is handed over when it is set and left out when it is not", () => {
    expect(providerOptionsFor(withSettings({}))).toBeUndefined();
    expect(providerOptionsFor(withSettings({ openrouter_routing: null }))).toBeUndefined();
    const each: [Partial<ResolvedModel>, ProviderOptions][] = [
      [{ reasoning_effort: "high" }, { reasoning_effort: "high" }],
      [{ reasoning_effort: "off" }, { thinking_enabled: false }],
      [{ reasoning_budget_tokens: 2048 }, { reasoning_budget_tokens: 2048 }],
      [{ reasoning_budget_tokens: 0 }, { reasoning_budget_tokens: 0 }],
      [{ cache_ttl: "1h" }, { cache_ttl: "1h" }],
      [{ openrouter_routing: { order: ["a"] } }, { openrouter_routing: { order: ["a"] } }],
      [{ gemini_thinking_mode: "auto" }, { gemini_thinking_mode: "auto" }],
      [{ zai_clear_reasoning: false }, { zai_clear_reasoning: false }],
    ];
    for (const [setting, handed] of each) expect(providerOptionsFor(withSettings(setting))).toStrictEqual(handed);
    const all = { reasoning_effort: "low", reasoning_budget_tokens: 1024, cache_ttl: "5m", openrouter_routing: { only: ["z"] }, gemini_thinking_mode: "level" as const, zai_clear_reasoning: true };
    expect(providerOptionsFor(withSettings(all))).toStrictEqual(all);
  });

  test("a call counts as thinking when it has a reasoning budget above zero or an effort, and never once thinking is turned off", () => {
    expect([
      thinkingEnabled(undefined), thinkingEnabled({}), thinkingEnabled({ reasoning_budget_tokens: 0 }), thinkingEnabled({ reasoning_budget_tokens: 1 }),
      thinkingEnabled({ reasoning_effort: "low" }), thinkingEnabled({ reasoning_budget_tokens: 2048, thinking_enabled: false }), thinkingEnabled({ reasoning_effort: "high", thinking_enabled: false }),
    ]).toEqual([false, false, false, true, true, false, false]);
  });
});
