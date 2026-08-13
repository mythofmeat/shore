/**
 * Thinking display follows Anthropic's two documented values and nothing else.
 *
 * https://platform.claude.com/docs/en/build-with-claude/thinking
 *   "It accepts two values" — "summarized" and "omitted". "No `display` setting
 *   returns the raw chain of thought."
 *   "You're still charged for the full thinking tokens. Omitting reduces
 *   latency, not cost."
 *   "`display` is invalid with `thinking.type: "disabled"`"
 *
 * Shore asks for the summary everywhere and lets an explicit provider option
 * override it. Deriving the value from the call type, as `6c1b80da` did, bought
 * no token saving and made a keepalive ping send a different thinking parameter
 * than the call whose prefix it was armed against.
 */

import { describe, expect, test } from "bun:test";

import { buildAnthropicPlan, buildThinkingParams } from "../src/llm/providers/anthropic.ts";
import type { CallContext, SidecarRequest } from "../src/llm/types.ts";

function context(callType: string): CallContext {
  return { character: "Rhia", call_type: callType, thinking_enabled: true };
}

function request(callType: string, over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-opus-4-8",
    api_key: "k",
    max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: [{ text: "you are helpful", label: "system" }],
    provider_options: { reasoning_effort: "adaptive" },
    context: context(callType),
    ...over,
  } as SidecarRequest;
}

const displayOf = (req: SidecarRequest): unknown =>
  (buildAnthropicPlan(req).params as { thinking?: { display?: unknown } }).thinking?.display;

describe("every call type asks for the same thinking display", () => {
  test("the call type does not change what goes on the wire", () => {
    for (const callType of [
      "message",
      "tool_loop",
      "subagent",
      "heartbeat",
      "dreaming",
      "compaction",
      "keepalive",
      "memory_agent",
    ]) {
      expect(displayOf(request(callType))).toBe("summarized");
    }
  });

  test("a keepalive ping matches the chat turn whose prefix it re-sends", () => {
    expect(displayOf(request("keepalive"))).toBe(displayOf(request("message")));
  });

  test("an explicit provider option overrides it either way", () => {
    expect(
      displayOf(
        request("message", {
          provider_options: { reasoning_effort: "adaptive", thinking_display: "omitted" },
        }),
      ),
    ).toBe("omitted");
    expect(
      displayOf(
        request("compaction", {
          provider_options: { reasoning_effort: "adaptive", thinking_display: "summarized" },
        }),
      ),
    ).toBe("summarized");
  });
});

describe("buildThinkingParams", () => {
  test("called without a display it asks for summarized", () => {
    const built = buildThinkingParams({ reasoning_effort: "adaptive" }, "claude-opus-4-8", 4096);
    expect(built.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  test("the enabled-budget shape carries no display at all", () => {
    const built = buildThinkingParams({ budget_tokens: 2048 }, "claude-3-7-sonnet", 4096, "omitted");
    expect(built.thinking).toMatchObject({ type: "enabled" });
    expect(built.thinking).not.toHaveProperty("display");
  });

  test("a request that asks for no thinking carries no display to pair with it", () => {
    const built = buildThinkingParams({}, "claude-opus-4-8", 4096, "summarized");
    expect(built.thinking).toBeUndefined();
  });
});
