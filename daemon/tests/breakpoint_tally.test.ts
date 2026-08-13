import { describe, expect, test } from "bun:test";

import { ANTHROPIC_CACHE_CONTROL_LIMIT } from "../src/cache/forensics.ts";
import { buildAnthropicPlan, placeBreakpoints } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";

const CC = { type: "ephemeral", ttl: "1h" } as never;

function turn(role: "user" | "assistant", text: string): WireMessage {
  return { role, content: [{ type: "text", text }] } as WireMessage;
}

function request(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-opus-5",
    api_key: "k",
    max_tokens: 100,
    messages: [turn("user", "one"), turn("assistant", "two"), turn("user", "three")],
    system: [{ text: "you are a helpful assistant", label: "system" }],
    provider_options: { cache_ttl: "1h" },
    ...over,
  } as SidecarRequest;
}

describe("breakpoint placement is counted", () => {
  test("a normal request places what it asks for and drops nothing", () => {
    const { placement } = buildAnthropicPlan(request());
    expect(placement.breakpoints_requested).toBe(
      placement.msg_breakpoints.length + placement.sys_breakpoints.length,
    );
    expect(placement.breakpoints_placed).toBe(placement.breakpoints_requested);
    expect(placement.breakpoints_dropped_no_anchor).toBe(0);
    expect(placement.breakpoints_dropped_over_limit).toBe(0);
  });

  test("shore never asks for more than the API allows", () => {
    const { placement } = buildAnthropicPlan(request());
    expect(placement.breakpoints_requested).toBeLessThanOrEqual(ANTHROPIC_CACHE_CONTROL_LIMIT);
    expect(placement.breakpoints_placed).toBeLessThanOrEqual(ANTHROPIC_CACHE_CONTROL_LIMIT);
  });

  test("an anchor with no block that will take a marker is counted, not shrugged off", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "   " }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ] as never[];
    const tally = placeBreakpoints(messages, [], CC, [1], []);

    expect(tally.requested).toBe(1);
    expect(tally.placed).toBe(0);
    expect(tally.droppedNoAnchor).toBe(1);
  });

  test("past the API's four-per-request cap the extras are dropped and counted", () => {
    const messages = Array.from({ length: 6 }, (_unused, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `turn ${String(i)}` }],
    })) as never[];
    const system = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ] as never[];
    const tally = placeBreakpoints(messages, system, CC, [1, 2, 3, 4, 5], [0, 1]);

    expect(tally.requested).toBe(7);
    expect(tally.placed).toBe(ANTHROPIC_CACHE_CONTROL_LIMIT);
    expect(tally.droppedOverLimit).toBe(7 - ANTHROPIC_CACHE_CONTROL_LIMIT);
    expect(tally.placed + tally.droppedOverLimit + tally.droppedNoAnchor).toBe(tally.requested);
  });

  test("caching off asks for nothing and so drops nothing", () => {
    const { placement } = buildAnthropicPlan(request({ provider_options: {} }));
    expect(placement.cache_enabled).toBe(false);
    expect(placement.breakpoints_requested).toBe(0);
    expect(placement.breakpoints_placed).toBe(0);
  });
});
