/**
 * Regression cases for the most-recent-assistant-turn boundary.
 *
 * The Anthropic cache breakpoint is anchored just *before* this boundary, so an
 * anchor that lands inside the region `replay_prior_thinking` rewrites makes
 * both message breakpoints miss, and every committed turn re-caches the whole
 * conversation with nothing failing. The only end-to-end guard is an `#[ignore]`
 * live provider probe, which is why these cases are pinned here.
 *
 * This *was* a cross-language parity test: the daemon had its own
 * `most_recent_assistant_turn_start` in `content_util.rs`, and both sides
 * asserted against this one fixture because two implementations of one rule
 * cannot be trusted to agree. That function no longer exists — the replay
 * decision moved here wholesale — so there is one implementation now and
 * nothing left to hold parity with. The fixture stays because the cases are
 * worth keeping; it still lives under `crates/daemon/tests/fixtures/` only
 * because moving it is churn.
 */

import { describe, expect, test } from "bun:test";

import { mostRecentAssistantTurnStart } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

type Case = {
  name: string;
  expected: number;
  messages: SidecarRequest["messages"];
};

const fixturePath = new URL(
  "./rust_fixtures/turn_boundary_parity.json",
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
