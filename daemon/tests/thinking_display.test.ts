import { describe, expect, test } from "bun:test";

import { buildAnthropicPlan, buildThinkingParams } from "../src/llm/providers/anthropic.ts";
import { thinkingDisplayForCallType } from "../src/llm/thinking_display.ts";
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

describe("thinkingDisplayForCallType", () => {
  test("a call whose thinking a client renders keeps the summary", () => {
    for (const callType of ["message", "tool_loop", "subagent", "heartbeat", "dreaming"]) {
      expect(thinkingDisplayForCallType(callType)).toBe("summarized");
    }
  });

  test("a call with no surface for it does not pay to receive it", () => {
    for (const callType of ["compaction", "keepalive", "memory_agent"]) {
      expect(thinkingDisplayForCallType(callType)).toBe("omitted");
    }
  });

  test("an unlabelled call keeps the summary rather than guessing", () => {
    expect(thinkingDisplayForCallType(undefined)).toBe("summarized");
  });
});

describe("the built request follows the call type", () => {
  test("a chat turn asks for summarized thinking", () => {
    expect(displayOf(request("message"))).toBe("summarized");
  });

  test("a compaction pass asks for omitted", () => {
    expect(displayOf(request("compaction"))).toBe("omitted");
  });

  test("an explicit provider option overrides the call type either way", () => {
    expect(
      displayOf(
        request("compaction", {
          provider_options: { reasoning_effort: "adaptive", thinking_display: "summarized" },
        }),
      ),
    ).toBe("summarized");
    expect(
      displayOf(
        request("message", {
          provider_options: { reasoning_effort: "adaptive", thinking_display: "omitted" },
        }),
      ),
    ).toBe("omitted");
  });
});

describe("buildThinkingParams keeps its old default", () => {
  test("called without a display it still asks for summarized", () => {
    const built = buildThinkingParams({ reasoning_effort: "adaptive" }, "claude-opus-4-8", 4096);
    expect(built.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  test("the enabled-budget shape carries no display at all", () => {
    const built = buildThinkingParams({ budget_tokens: 2048 }, "claude-3-7-sonnet", 4096, "omitted");
    expect(built.thinking).toMatchObject({ type: "enabled" });
    expect(built.thinking).not.toHaveProperty("display");
  });
});
