/**
 * OpenRouter reasoning-parameter tests (issue #164). Pin how `buildCall` maps
 * Shore's reasoning provider-options onto the OpenRouter `reasoning` field:
 *   - reasoning_effort → reasoning.effort (folded to the model's domain)
 *   - thinking_enabled=false (from `reasoning_effort = "off"`) → reasoning.effort
 *     = "none", which disables reasoning even on always-on models.
 */

import { expect, test } from "bun:test";

import { buildCall } from "../src/llm/providers/openrouter.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

function req(provider_options?: Record<string, unknown>): SidecarRequest {
  return {
    sdk: "openrouter",
    model: "z-ai/glm-5.1",
    api_key: "sk-test",
    messages: [],
    max_tokens: 1024,
    ...(provider_options ? { provider_options } : {}),
  };
}

type Reasoning = { effort?: string } | undefined;
const reasoningOf = (opts?: Record<string, unknown>): Reasoning =>
  buildCall(req(opts), false).chatRequest.reasoning as Reasoning;

test("thinking_enabled=false → reasoning.effort = 'none' (hard disable)", () => {
  expect(reasoningOf({ thinking_enabled: false })).toEqual({ effort: "none" });
});

test("reasoning_effort passes through as reasoning.effort", () => {
  expect(reasoningOf({ reasoning_effort: "high" })).toEqual({ effort: "high" });
});

test("disable wins over any effort present", () => {
  expect(reasoningOf({ thinking_enabled: false, reasoning_effort: "high" })).toEqual({
    effort: "none",
  });
});

test("no reasoning options → reasoning omitted", () => {
  expect(reasoningOf(undefined)).toBeUndefined();
  expect(reasoningOf({})).toBeUndefined();
});
