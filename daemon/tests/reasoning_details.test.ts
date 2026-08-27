import { describe, expect, test } from "bun:test";
import type { ReasoningDetailUnion } from "@openrouter/sdk/models";

import { appendReasoningDetails } from "../src/llm/reasoning_details.ts";

function accumulate(...batches: ReasoningDetailUnion[][]): ReasoningDetailUnion[] {
  const details: ReasoningDetailUnion[] = [];
  for (const batch of batches) appendReasoningDetails(details, batch);
  return details;
}

describe("appendReasoningDetails", () => {
  test("concatenates consecutive text and carries late metadata", () => {
    expect(
      accumulate(
        [{ type: "reasoning.text", text: "alpha", index: 0 }],
        [{ type: "reasoning.text", text: "\n\n\n", index: 0 }],
        [
          {
            type: "reasoning.text",
            text: "beta",
            index: 0,
            signature: "signed",
            format: "unknown",
          },
        ],
      ),
    ).toEqual([
      {
        type: "reasoning.text",
        text: "alpha\n\n\nbeta",
        index: 0,
        signature: "signed",
        format: "unknown",
      },
    ]);
  });

  test("concatenates summaries by type transition rather than index", () => {
    expect(
      accumulate([
        { type: "reasoning.summary", summary: "one", index: 0 },
        { type: "reasoning.summary", summary: " two", index: 1, format: "unknown" },
      ]),
    ).toEqual([
      { type: "reasoning.summary", summary: "one two", index: 0, format: "unknown" },
    ]);
  });

  test("type transitions start new logical blocks", () => {
    const details = accumulate([
      { type: "reasoning.text", text: "one" },
      { type: "reasoning.summary", summary: "summary" },
      { type: "reasoning.text", text: "two" },
    ]);

    expect(details).toHaveLength(3);
  });

  test("encrypted and server-tool details remain discrete", () => {
    const details = accumulate([
      { type: "reasoning.encrypted", data: "cipher-a", id: "a", index: 0 },
      { type: "reasoning.encrypted", data: "cipher-b", id: "b", index: 0 },
      {
        type: "reasoning.server_tool_call",
        arguments: "{}",
        result: "first",
        toolCallId: "tool-a",
        toolName: "openrouter:fusion",
      },
      {
        type: "reasoning.server_tool_call",
        arguments: "{}",
        result: "second",
        toolCallId: "tool-b",
        toolName: "openrouter:fusion",
      },
    ]);

    expect(details).toHaveLength(4);
    expect(details.map((detail) => detail.type)).toEqual([
      "reasoning.encrypted",
      "reasoning.encrypted",
      "reasoning.server_tool_call",
      "reasoning.server_tool_call",
    ]);
  });
});
