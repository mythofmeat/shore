/**
 * Cross-language parity for the heartbeat clock.
 *
 * The unit tests in `heartbeat.test.ts` were translated from the Rust alongside
 * the implementation, so they cannot catch a mistake made in both halves of the
 * translation at once. This can: the fixture is *generated* by driving the real
 * Rust clock through deterministic event walks
 * (`heartbeat_decisions_match_shared_fixture` in
 * `crates/daemon/src/autonomy/heartbeat.rs`) and recording what it decided at
 * every observable point. This replays those walks and demands the same answer.
 *
 * What a failure here means: the two implementations disagree about when a
 * character wakes up, or about when it should stop waking up. Both directions
 * cost — a clock that fires when the Rust would not runs a tool loop nobody
 * asked for, and one that stays silent when the Rust would fire leaves the
 * character mute. Treat a diff as a defect until proven otherwise, not as a
 * fixture that needs regenerating.
 */

import { describe, expect, test } from "bun:test";

import {
  HeartbeatClock,
  MAX_WAKE_INTERVAL_MS,
  MIN_WAKE_INTERVAL_MS,
  type HeartbeatAction,
} from "../src/autonomy/heartbeat.ts";

interface WalkStep {
  now_ms: number;
  event:
    | { kind: "tick" }
    | { kind: "user_message" }
    | { kind: "schedule"; delta_ms: number }
    | { kind: "force_dormant" }
    | { kind: "seed_last_user_if_unset"; at_ms: number };
  action: HeartbeatAction | null;
  state: {
    next_wake_ms: number | null;
    ticks_without_user: number;
    last_user_ms: number | null;
    label: "Active" | "Dormant";
  };
}

interface Walk {
  seed: number;
  config: {
    default_interval_secs: number;
    max_idle_ticks: number;
    max_silent_secs: number;
    min_wake_secs: number;
  };
  steps: WalkStep[];
}

interface Fixture {
  bounds: { min_wake_interval_secs: number; max_wake_interval_secs: number };
  walks: Walk[];
}

const fixture = (await Bun.file(
  new URL("../../crates/daemon/tests/fixtures/heartbeat_parity.json", import.meta.url),
).json()) as Fixture;

describe("the fixture is real", () => {
  test("a silently unreadable fixture must not pass", () => {
    expect(fixture.walks.length).toBeGreaterThan(0);
    const steps = fixture.walks.reduce((n, w) => n + w.steps.length, 0);
    expect(steps).toBeGreaterThan(300);
  });

  test("the walks exercise the paths worth pinning", () => {
    // A fixture that never fires a tick, or never trips the guard, would pass
    // against almost any implementation. These counts are what make it an
    // assertion rather than a formality.
    const steps = fixture.walks.flatMap((w) => w.steps);
    expect(steps.filter((s) => s.action === "run_tick").length).toBeGreaterThan(20);
    expect(steps.filter((s) => s.state.label === "Dormant").length).toBeGreaterThan(20);

    const deltas = steps
      .filter((s) => s.event.kind === "schedule")
      .map((s) => (s.event as { delta_ms: number }).delta_ms);
    expect(deltas.filter((d) => d < MIN_WAKE_INTERVAL_MS).length, "below the floor").toBeGreaterThan(5);
    expect(deltas.filter((d) => d > MAX_WAKE_INTERVAL_MS).length, "above the ceiling").toBeGreaterThan(5);
  });
});

describe("the bounds match", () => {
  test("the clamp is the same on both sides", () => {
    expect(fixture.bounds.min_wake_interval_secs * 1000).toBe(MIN_WAKE_INTERVAL_MS);
    expect(fixture.bounds.max_wake_interval_secs * 1000).toBe(MAX_WAKE_INTERVAL_MS);
  });
});

describe("replaying the Rust's decisions", () => {
  for (const walk of fixture.walks) {
    test(`walk ${walk.seed} (interval ${walk.config.default_interval_secs}s, ceiling ${walk.config.max_idle_ticks} ticks)`, () => {
      // The origin is 0: the fixture records every instant as milliseconds from
      // the start of the walk, so the clock can be built at 0 and driven with
      // those offsets directly.
      const clock = new HeartbeatClock(
        {
          defaultIntervalMs: walk.config.default_interval_secs * 1000,
          maxIdleTicks: walk.config.max_idle_ticks,
          maxSilentMs: walk.config.max_silent_secs * 1000,
          minWakeIntervalMs: walk.config.min_wake_secs * 1000,
        },
        0,
      );

      for (const [i, step] of walk.steps.entries()) {
        const now = step.now_ms;
        let action: HeartbeatAction | null = null;

        switch (step.event.kind) {
          case "tick":
            action = clock.tick(now);
            break;
          case "user_message":
            clock.onUserMessage(now);
            break;
          case "schedule":
            clock.schedule(now + step.event.delta_ms, now);
            break;
          case "force_dormant":
            clock.forceDormant();
            break;
          case "seed_last_user_if_unset":
            clock.seedLastUserAtIfUnset(step.event.at_ms);
            break;
        }

        const where = `walk ${walk.seed} step ${i} (${step.event.kind} @ ${now}ms)`;
        expect(action, `${where}: action`).toBe(step.action);
        expect(clock.nextWakeAt ?? null, `${where}: next wake`).toBe(step.state.next_wake_ms);
        expect(clock.ticksWithoutUser, `${where}: tick count`).toBe(step.state.ticks_without_user);
        expect(clock.lastUserAt ?? null, `${where}: last user`).toBe(step.state.last_user_ms);
        expect(clock.stateAt(now), `${where}: label`).toBe(step.state.label);
      }
    });
  }
});
