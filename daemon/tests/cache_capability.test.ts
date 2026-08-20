import { describe, expect, test } from "bun:test";

import {
  effectiveCacheTtl,
  respectsInlineCacheHints,
  supportsExtendedCacheTtl,
} from "../src/llm/cache_capability.ts";
import { buildAnthropicPlan } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

const TURN: WireMessage = { role: "user", content: [{ type: "text", text: "hello" }] };

function request(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-opus-5",
    api_key: "k",
    max_tokens: 100,
    messages: [TURN],
    system: [{ text: "you are helpful", label: "system" }],
    provider_options: { cache_ttl: "1h" },
    ...over,
  } as SidecarRequest;
}

function markersIn(params: { messages: unknown[]; system?: unknown }): unknown[] {
  const system: unknown[] = Array.isArray(params.system) ? params.system : [];
  const blocks = [
    ...system,
    ...params.messages.flatMap((m): unknown[] => {
      const content = (m as { content?: unknown }).content;
      return Array.isArray(content) ? (content as unknown[]) : [];
    }),
  ];
  return blocks
    .map((b) => (b as { cache_control?: unknown }).cache_control)
    .filter((cc) => cc !== undefined);
}

describe("which protocols read an inline cache marker", () => {
  test("only the Anthropic Messages shape does", () => {
    expect(respectsInlineCacheHints("anthropic")).toBe(true);
    for (const sdk of ["openai", "openrouter", "gemini", "zai", "deepseek", "moonshot"] as const) {
      expect(respectsInlineCacheHints(sdk)).toBe(false);
    }
  });

  test("a marker requested for a protocol that discards it is not emitted", () => {
    expect(effectiveCacheTtl("openai", undefined, "1h")).toBe("");
    expect(effectiveCacheTtl("gemini", undefined, "5m")).toBe("");
  });

  test("caching off stays off, without a warning about protocols", () => {
    expect(effectiveCacheTtl("openai", undefined, "")).toBe("");
    expect(effectiveCacheTtl("anthropic", undefined, "")).toBe("");
  });
});

describe("which endpoints honour a 1h TTL", () => {
  test("Anthropic's own API and the Vertex endpoints do", () => {
    expect(supportsExtendedCacheTtl(undefined)).toBe(true);
    expect(supportsExtendedCacheTtl("https://api.anthropic.com")).toBe(true);
    expect(supportsExtendedCacheTtl("https://us-east5-aiplatform.googleapis.com/v1")).toBe(true);
  });

  test("a third-party proxy speaking the same shape does not", () => {
    expect(supportsExtendedCacheTtl("https://openrouter.ai/api/v1")).toBe(false);
    expect(supportsExtendedCacheTtl("https://some-gateway.example.com")).toBe(false);
  });

  test("a relay you run yourself does, because it forwards to Anthropic", () => {
    expect(supportsExtendedCacheTtl("http://localhost:4000")).toBe(true);
    expect(supportsExtendedCacheTtl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(supportsExtendedCacheTtl("http://192.168.1.20:4000")).toBe(true);
  });

  test("an ineligible host gets the default marker rather than a 1h one", () => {
    expect(effectiveCacheTtl("anthropic", "https://openrouter.ai/api/v1", "1h")).toBe("5m");
    expect(effectiveCacheTtl("anthropic", "https://api.anthropic.com", "1h")).toBe("1h");
  });
});

describe("the built request follows the capability", () => {
  test("Anthropic's own endpoint gets 1h markers", () => {
    const { params } = buildAnthropicPlan(request());
    const markers = markersIn(params);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0]).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("a proxy gets markers, but not the 1h TTL it would ignore", () => {
    const { params } = buildAnthropicPlan(request({ base_url: "https://openrouter.ai/api/v1" }));
    const markers = markersIn(params);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0]).toEqual({ type: "ephemeral" });
  });

  test("the ledger records the TTL that was actually sent, not the one asked for", () => {
    const context = {
      character: "Rhia",
      call_type: "message",
      thinking_enabled: false,
      cache_ttl: "1h",
    };
    buildAnthropicPlan(request({ base_url: "https://openrouter.ai/api/v1", context }));
    expect(context.cache_ttl).toBe("5m");
  });
});
