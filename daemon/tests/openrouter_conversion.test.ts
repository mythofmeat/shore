import { describe, expect, test } from "bun:test";

import { turnToOpenRouter } from "../src/llm/providers/openrouter.ts";
import type { TurnMessage } from "../src/llm/types.ts";

type Rec = Record<string, unknown>;
const conv = (t: TurnMessage) => turnToOpenRouter(t) as unknown as Rec[];

describe("turnToOpenRouter", () => {
  test("assistant text + tool_use → content + toolCalls; no reasoning leaked", () => {
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ],
    });
    expect(m?.role).toBe("assistant");
    expect(m?.content).toBe("let me check");
    expect((m?.toolCalls as Rec[])[0]).toMatchObject({
      id: "tu_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"x"}' },
    });
    expect(m).not.toHaveProperty("reasoning");
    expect(m).not.toHaveProperty("reasoningDetails");
  });

  test("thinking block with reasoning_details → replays them verbatim", () => {
    const details = [{ type: "reasoning.text", text: "prior", id: "r1", format: "unknown" }];
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "prior", reasoning_details: details },
        { type: "tool_use", id: "tu_2", name: "f", input: {} },
      ],
    });
    expect(m?.reasoningDetails).toEqual(details);
  });

  test("thinking block carrying only an Anthropic signature → no replay", () => {
    const [m] = conv({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x", signature: "Ev0BCkYIB...opaque-anthropic-sig" },
        { type: "text", text: "hi" },
      ],
    });
    expect(m).not.toHaveProperty("reasoningDetails");
  });

  test("user tool_result → role:tool with toolCallId", () => {
    const msgs = conv({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "found 5 results" }],
    });
    expect(msgs[0]).toEqual({ role: "tool", toolCallId: "tu_1", content: "found 5 results" });
  });

  test("user text → single role:user message", () => {
    const msgs = conv({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("inline system turn passes through raw (no wrapper)", () => {
    const msgs = conv({ role: "system", content: [{ type: "text", text: "be brief" }] });
    expect(msgs[0]).toEqual({ role: "system", content: "be brief" });
  });
});
