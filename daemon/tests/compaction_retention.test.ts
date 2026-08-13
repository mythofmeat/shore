/**
 * Compaction retention as a share of the context budget — issue #82.
 *
 * The reserve is a *ceiling*, not the floor opencode uses, and that is the
 * finding rather than a shortcut. opencode compacts under context pressure, so
 * a quarter of usable context is how much to keep once you are already
 * compacting. Shore triggers on turn count and idle time, so making the reserve
 * a floor retains everything on a small conversation, compaction never runs,
 * and no archive ever forms — measured by running it that way, which broke
 * eight idle-compaction tests.
 *
 * As a ceiling it does the thing the issue actually wanted: a model with a
 * small window, or a run of enormous turns, retains fewer of them, while the
 * configured `keep_recent_turns` still governs the ordinary case.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_RECENT_RESERVE_TOKENS,
  MIN_RECENT_RESERVE_TOKENS,
  RECENT_CONTEXT_FRACTION,
  recentReserveTokens,
  retainedTurns,
  turnsWithinReserve,
} from "../src/memory/compaction/retention.ts";
import type { ConversationMessage } from "../src/memory/compaction/types.ts";

function message(role: string, content: string): ConversationMessage {
  return {
    role,
    content,
    timestamp: "2026-08-12T00:00:00Z",
    isToolResultOnly: false,
    isAutonomous: false,
  };
}

function exchanges(count: number, charsEach: number): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(message("user", "q".repeat(charsEach)));
    out.push(message("assistant", "a".repeat(charsEach)));
  }
  return out;
}

describe("recentReserveTokens", () => {
  test("a quarter of the window, between a floor and a ceiling", () => {
    expect(recentReserveTokens(80_000)).toBe(80_000 * RECENT_CONTEXT_FRACTION);
    expect(recentReserveTokens(1_000)).toBe(MIN_RECENT_RESERVE_TOKENS);
    expect(recentReserveTokens(2_000_000)).toBe(MAX_RECENT_RESERVE_TOKENS);
  });

  test("an unconfigured window falls back to the floor rather than zero", () => {
    expect(recentReserveTokens(0)).toBe(MIN_RECENT_RESERVE_TOKENS);
  });
});

describe("turnsWithinReserve", () => {
  test("counts trailing turns until the reserve is spent", () => {
    expect(turnsWithinReserve(exchanges(10, 30), 4_000)).toBe(10);
    expect(turnsWithinReserve(exchanges(10, 30_000), 4_000)).toBe(0);
  });

  test("an empty conversation retains nothing", () => {
    expect(turnsWithinReserve([], 4_000)).toBe(0);
  });
});

describe("retainedTurns", () => {
  test("ordinary turns leave the configured count alone", () => {
    expect(retainedTurns(exchanges(10, 40), 2, 200_000)).toBe(2);
  });

  test("enormous turns retain fewer than configured, not more", () => {
    expect(retainedTurns(exchanges(10, 200_000), 6, 200_000)).toBe(1);
  });

  test("it never retains nothing, which would archive the live exchange", () => {
    expect(retainedTurns(exchanges(3, 500_000), 4, 8_000)).toBe(1);
  });

  test("a small window retains fewer turns than a large one, same conversation", () => {
    const conversation = exchanges(12, 3_000);
    const small = retainedTurns(conversation, 8, 16_000);
    const large = retainedTurns(conversation, 8, 400_000);
    expect(small).toBeLessThan(large);
  });

  test("with no window configured it is exactly the old turn count", () => {
    expect(retainedTurns(exchanges(10, 200_000), 3, 0)).toBe(3);
  });
});
