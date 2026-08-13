import { describe, expect, test } from "bun:test";

import { StreamAccumulator, emptyTiming, emptyUsage } from "../src/llm/stream.ts";
import type { StreamEvent } from "../src/llm/types.ts";

const SIGNATURE = "EosnCkYICxIMMb3LzNrMu0000signature";

function drain(events: StreamEvent[]) {
  const accumulator = new StreamAccumulator();
  for (const event of events) accumulator.handle(event, false, () => {});
  return accumulator.finish("done", "end_turn", emptyUsage(), emptyTiming());
}

describe("thinking blocks are captured whenever a signature arrives", () => {
  test("display summarized: thinking text and signature land on one block", () => {
    const result = drain([
      { type: "start", model: "claude-opus-4-6" },
      { type: "thinking", text: "weighing the options" },
      { type: "thinking_signature", signature: SIGNATURE },
      { type: "text", text: "the answer" },
    ]);

    expect(result.content_blocks).toEqual([
      { type: "thinking", thinking: "weighing the options", signature: SIGNATURE },
      { type: "text", text: "the answer" },
    ]);
  });

  test("display omitted: a signature with no thinking deltas still records a block", () => {
    const result = drain([
      { type: "start", model: "claude-opus-4-8" },
      { type: "thinking_signature", signature: SIGNATURE },
      { type: "text", text: "the answer" },
    ]);

    expect(result.content_blocks).toEqual([
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "text", text: "the answer" },
    ]);
  });

  test("display omitted before a tool call: the tool_use keeps its thinking block", () => {
    const result = drain([
      { type: "start", model: "claude-opus-4-8" },
      { type: "thinking_signature", signature: SIGNATURE },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
    ]);

    expect(result.content_blocks).toEqual([
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
    ]);
  });

  test("a signature is never carried onto a later, unrelated thinking block", () => {
    const result = drain([
      { type: "start", model: "claude-opus-4-8" },
      { type: "thinking_signature", signature: SIGNATURE },
      { type: "text", text: "first" },
      { type: "thinking", text: "second round" },
      { type: "thinking_signature", signature: "second-signature" },
    ]);

    expect(result.content_blocks).toEqual([
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "text", text: "first" },
      { type: "thinking", thinking: "second round", signature: "second-signature" },
    ]);
  });

  test("no thinking at all records no thinking block", () => {
    const result = drain([
      { type: "start", model: "claude-opus-4-8" },
      { type: "text", text: "just an answer" },
    ]);

    expect(result.content_blocks).toEqual([{ type: "text", text: "just an answer" }]);
  });
});
