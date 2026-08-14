import { describe, expect, test } from "bun:test";

import { mostRecentAssistantTurnStart } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

type Case = {
  name: string;
  expected: number;
  messages: SidecarRequest["messages"];
};

const fixturePath = new URL(
  "./rust_fixtures/turn_boundary.json",
  import.meta.url,
);
const fixture = (await Bun.file(fixturePath).json()) as { cases: Case[] };

describe("turn-boundary parity with content_util.rs (shared fixture)", () => {
  test("fixture is non-empty (a silently unreadable fixture must not pass)", () => {
    expect(fixture.cases.length).toBeGreaterThan(5);
  });

  for (const c of fixture.cases) {
    test(c.name, () => {
      expect(mostRecentAssistantTurnStart(c.messages as never)).toBe(c.expected);
    });
  }
});
