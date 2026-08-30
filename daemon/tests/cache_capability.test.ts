import { describe, expect, test } from "bun:test";

import {
  effectiveCacheTtl,
  respectsInlineCacheHints,
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
    expect(effectiveCacheTtl("openai", "1h")).toBe("");
    expect(effectiveCacheTtl("gemini", "5m")).toBe("");
  });

  test("caching off stays off, without a warning about protocols", () => {
    expect(effectiveCacheTtl("openai", "")).toBe("");
    expect(effectiveCacheTtl("anthropic", "")).toBe("");
  });
});

describe("the built request follows the capability", () => {
  test("Anthropic's own endpoint gets 1h markers", () => {
    const { params } = buildAnthropicPlan(request());
    const markers = markersIn(params);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0]).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("an Anthropic-compatible endpoint receives the requested 1h TTL unchanged", () => {
    const { params } = buildAnthropicPlan(request({ base_url: "https://openrouter.ai/api/v1" }));
    const markers = markersIn(params);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0]).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("an Anthropic-compatible endpoint does not rewrite the call context TTL", () => {
    const context = {
      character: "Rhia",
      call_type: "message",
      thinking_enabled: false,
      cache_ttl: "1h",
    };
    buildAnthropicPlan(request({ base_url: "https://openrouter.ai/api/v1", context }));
    expect(context.cache_ttl).toBe("1h");
  });
});
