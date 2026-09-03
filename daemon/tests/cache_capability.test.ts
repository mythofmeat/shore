import { describe, expect, test } from "bun:test";

import {
  cachingIsSilentlyOff,
  effectiveCacheTtl,
  honorsCacheTtl,
} from "../src/llm/cache_capability.ts";
import { shoreLog } from "../src/log.ts";
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

describe("which protocols carry a cache TTL", () => {
  test("the Anthropic Messages shape and nano-gpt's helper do", () => {
    for (const sdk of ["anthropic", "nanogpt"] as const) {
      expect(honorsCacheTtl(sdk)).toBe(true);
    }
    for (const sdk of ["openai", "openrouter", "gemini", "zai", "deepseek", "moonshot"] as const) {
      expect(honorsCacheTtl(sdk)).toBe(false);
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

  test("leaving caching unset is loud only where caching was available", () => {
    for (const sdk of ["anthropic", "nanogpt"] as const) {
      expect(cachingIsSilentlyOff(sdk, "")).toBe(true);
      expect(cachingIsSilentlyOff(sdk, "1h")).toBe(false);
    }
    for (const sdk of ["openai", "openrouter", "gemini", "zai"] as const) {
      expect(cachingIsSilentlyOff(sdk, "")).toBe(false);
    }
  });

  test("the unset-cache warning is said once, not once per request", () => {
    const said: string[] = [];
    const original = shoreLog.warn.bind(shoreLog);
    shoreLog.warn = (...args: unknown[]) => void said.push(args.join(" "));
    try {
      effectiveCacheTtl("anthropic", "");
      said.length = 0;
      effectiveCacheTtl("anthropic", "");
      effectiveCacheTtl("anthropic", "");
      effectiveCacheTtl("openai", "");
    } finally {
      shoreLog.warn = original;
    }
    expect(said).toEqual([]);
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
