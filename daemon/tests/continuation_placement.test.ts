import { describe, expect, test } from "bun:test";

import { ANTHROPIC_CACHE_CONTROL_LIMIT } from "../src/cache/forensics.ts";
import { placeContinuationBreakpoints } from "../src/llm/providers/anthropic.ts";
import type { SystemContent } from "../src/llm/types.ts";

const LABELLED: SystemContent = [{ text: "you are helpful", label: "system" }];

function turn(role: "user" | "assistant", text: string) {
  return { role, content: [{ type: "text", text }] };
}

function conversation(rounds: number) {
  const messages = [turn("user", "the question")];
  for (let i = 0; i < rounds; i += 1) {
    messages.push(turn("assistant", `calling a tool, round ${String(i)}`));
    messages.push(turn("user", `tool result ${String(i)}`));
  }
  return messages as never[];
}

function system() {
  return [{ type: "text", text: "you are helpful" }] as never[];
}

function markerCount(messages: never[], sys: never[]): number {
  const blocks = [
    ...sys,
    ...messages.flatMap((m) => (m as { content: unknown[] }).content),
  ];
  return blocks.filter((b) => (b as { cache_control?: unknown }).cache_control !== undefined)
    .length;
}

describe("what the clear step buys", () => {
  test("markers stay within the API's cap across a growing loop", () => {
    const sys = system();
    const messages = conversation(1);
    placeContinuationBreakpoints(messages, sys, LABELLED, "1h");

    for (let round = 2; round <= 5; round += 1) {
      messages.push(turn("assistant", `calling a tool, round ${String(round)}`) as never);
      messages.push(turn("user", `tool result ${String(round)}`) as never);
      placeContinuationBreakpoints(messages, sys, LABELLED, "1h");

      expect(markerCount(messages, sys)).toBeLessThanOrEqual(
        ANTHROPIC_CACHE_CONTROL_LIMIT,
      );
    }
  });
});
