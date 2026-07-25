/**
 * Cross-language parity for the most-recent-assistant-turn boundary.
 *
 * `mostRecentAssistantTurnStart` (sidecar) must track
 * `most_recent_assistant_turn_start` (`backend/daemon/src/content_util.rs`) —
 * the boundary `replay_prior_thinking` strips against. The Anthropic cache
 * breakpoint is anchored just *before* that boundary, so if the two drift the
 * anchor lands inside the region the strip rewrites, both message breakpoints
 * miss, and every committed turn re-caches the whole conversation with nothing
 * failing. The only end-to-end guard is an `#[ignore]` live provider probe, so
 * both sides assert against one shared fixture instead.
 *
 * The Rust half is `content_util.rs::tests::turn_boundary_matches_shared_fixture`.
 * Adding a case to the fixture pins both implementations at once; if only one
 * side ends up green, they have diverged.
 */

import { describe, expect, test } from "bun:test";

import { mostRecentAssistantTurnStart } from "../src/llm/providers/anthropic.ts";
import type { SidecarRequest } from "../src/llm/types.ts";

type Case = {
  name: string;
  expected: number;
  messages: SidecarRequest["messages"];
};

const fixturePath = new URL("../../fixtures/turn_boundary_parity.json", import.meta.url);
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
