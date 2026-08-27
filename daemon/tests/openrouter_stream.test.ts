import { describe, expect, test } from "bun:test";
import type { ChatStreamChunk } from "@openrouter/sdk/models";

import { openRouterStreamEvents } from "../src/llm/providers/openrouter.ts";
import type { StreamEvent } from "../src/llm/types.ts";

async function* gen(arr: Array<Record<string, unknown>>): AsyncIterable<ChatStreamChunk> {
  for (const c of arr) yield c as unknown as ChatStreamChunk;
}
function fakeClock(): () => number {
  let t = 0;
  return () => (t += 10);
}
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const types = (out: StreamEvent[]) => out.map((e) => e.type);

describe("openRouterStreamEvents", () => {
  test("reasoning + details + text + tool_use → ordered events; signature carries details", async () => {
    const details = [{ type: "reasoning.text", text: "thinking...", id: "r1", format: "unknown" }];
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning: "thinking..." }, finishReason: null }] },
      { choices: [{ index: 0, delta: { reasoningDetails: details }, finishReason: null }] },
      { choices: [{ index: 0, delta: { content: "answer" }, finishReason: null }] },
      { choices: [{ index: 0, delta: { toolCalls: [{ index: 0, id: "tc_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }] }, finishReason: null }] },
      { choices: [{ index: 0, delta: {}, finishReason: "tool_calls" }], usage: { promptTokens: 50, completionTokens: 30, cost: 0.001 } },
    ];

    const out = await collect(openRouterStreamEvents("deepseek/deepseek-v4-pro", gen(chunks), fakeClock()));

    expect(types(out)).toEqual(["start", "thinking", "reasoning_details", "text", "tool_use", "done"]);
    expect(out[1]).toEqual({ type: "thinking", text: "thinking..." });

    expect(out[2]).toEqual({ type: "reasoning_details", details });

    expect(out[4]).toEqual({ type: "tool_use", id: "tc_1", name: "search", input: { q: "x" } });

    const done = out[5];
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.content).toBe("answer");
      expect(done.finish_reason).toBe("tool_use");
      expect(done.usage.input_tokens).toBe(50);
      expect(done.usage.output_tokens).toBe(30);
      expect(done.usage.total_cost_usd).toBe(0.001);
    }
  });

  test("tool-only turn (no text): the carrier still precedes tool_use", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning: "r" }, finishReason: null }] },
      { choices: [{ index: 0, delta: { reasoningDetails: [{ type: "reasoning.text", text: "r", id: "r1" }] }, finishReason: null }] },
      { choices: [{ index: 0, delta: { toolCalls: [{ index: 0, id: "t", type: "function", function: { name: "f", arguments: "{}" } }] }, finishReason: null }] },
      { choices: [{ index: 0, delta: {}, finishReason: "tool_calls" }] },
    ];
    const out = await collect(openRouterStreamEvents("z-ai/glm-5.1", gen(chunks), fakeClock()));
    expect(types(out)).toEqual(["start", "thinking", "reasoning_details", "tool_use", "done"]);
  });

  test("reasoning detail deltas become one replayable logical block", async () => {
    const details = [
      { type: "reasoning.text", text: "ok", format: "unknown", index: 0 },
      { type: "reasoning.text", text: "\n\n\n", format: "unknown", index: 0 },
      { type: "reasoning.text", text: " i", format: "unknown", index: 0 },
    ];
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning: "ok", reasoningDetails: [details[0]] }, finishReason: null }] },
      { choices: [{ index: 0, delta: { reasoning: "\n\n\n", reasoningDetails: [details[1]] }, finishReason: null }] },
      { choices: [{ index: 0, delta: { reasoning: " i", reasoningDetails: [details[2]] }, finishReason: null }] },
      { choices: [{ index: 0, delta: { content: "answer" }, finishReason: "stop" }] },
    ];

    const out = await collect(openRouterStreamEvents("moonshotai/kimi-k3", gen(chunks), fakeClock()));
    const carrier = out.find((event) => event.type === "reasoning_details");

    expect(carrier).toEqual({
      type: "reasoning_details",
      details: [{ type: "reasoning.text", text: "ok\n\n\n i", format: "unknown", index: 0 }],
    });
    expect(out.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", text: "ok" },
      { type: "thinking", text: "\n\n\n" },
      { type: "thinking", text: " i" },
    ]);
  });

  test("no thinking → no orphan carrier", async () => {
    const chunks = [{ choices: [{ index: 0, delta: { content: "hi" }, finishReason: "stop" }] }];
    const out = await collect(openRouterStreamEvents("openai/gpt-5.1", gen(chunks), fakeClock()));
    expect(types(out)).toEqual(["start", "text", "done"]);
    const done = out[2];
    if (done?.type === "done") expect(done.finish_reason).toBe("end_turn");
  });
});
