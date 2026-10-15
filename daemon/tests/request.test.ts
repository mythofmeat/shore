import { describe, expect, test } from "bun:test";

import { buildRequest, buildRequestWithProviderKeys, MissingApiKey, type ResolvedModel } from "../src/llm/request";
import { type ProviderEntry } from "../src/llm/credentials";
import type { ThinkingReplay } from "../src/llm/types";

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
