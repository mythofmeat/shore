import { describe, expect, test } from "bun:test";

import { turnToVercel } from "../src/llm/providers/vercel.ts";
import type { TurnMessage } from "../src/llm/types.ts";

type Rec = Record<string, unknown>;

describe("OpenRouter AI SDK message conversion", () => {
  const names = new Map<string, string>([["tc_1", "search"]]);
  const conv = (turn: TurnMessage) => turnToVercel(turn, names, "openrouter") as unknown as Rec[];

  test("tool results retain the tool name required by the AI SDK", () => {
    expect(
      conv({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc_1", content: "found 5" }],
      }),
    ).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc_1",
            toolName: "search",
            output: { type: "text", value: "found 5" },
          },
        ],
      },
    ]);
  });
});
