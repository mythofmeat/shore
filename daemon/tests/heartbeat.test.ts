/**
 * The heartbeat clock's own behaviour.
 *
 * `heartbeat_walks.test.ts` replays decision walks recorded from the Rust and
 * is the stronger check for anything a walk can reach. This file covers what a
 * randomised walk cannot: exact boundaries, and the two `force*` calls that read
 * the clock rather than taking a `now`, so they could not be recorded.
 *
 * Each test here mirrors one in `the deleted port`.
 */

import { describe, expect, test } from "bun:test";

import {
  HeartbeatClock,
  MAX_WAKE_INTERVAL_MS,
  MIN_WAKE_INTERVAL_MS,
  type HeartbeatClockConfig,
} from "../src/autonomy/heartbeat.ts";

const HOUR = 3_600_000;

function config(overrides: Partial<HeartbeatClockConfig> = {}): HeartbeatClockConfig {
  return {
    defaultIntervalMs: HOUR,
    maxIdleTicks: 100, // high, so the tick-count guard does not trip first
    maxSilentMs: 48 * HOUR,
    minWakeIntervalMs: HOUR,
    ...overrides,
  };
}

describe("the abandonment guards trip at the threshold, not past it", () => {
  // Both guards are `>=`. The Rust's own `guard_trips_on_silent_duration` steps
  // a second beyond the ceiling, and the parity walks advance by random amounts
  // that essentially never land on an exact 48-hour mark — so relaxing either to
  // `>` passed everything until these existed. Mirrors
  // `silent_guard_trips_exactly_at_the_threshold`.

  test("silence: exactly at the ceiling is already too silent", () => {
    const maxSilentMs = 2 * HOUR;
    const clock = new HeartbeatClock(config({ maxSilentMs }), 0);
    clock.onUserMessage(0);
    clock.schedule(HOUR, 0);

    expect(clock.tick(maxSilentMs)).toBe("none");
    expect(clock.nextWakeAt, "tripping the guard clears the deadline").toBeUndefined();
  });

  test("silence: one millisecond short still fires", () => {
    const maxSilentMs = 2 * HOUR;
    const clock = new HeartbeatClock(config({ maxSilentMs }), 0);
    clock.onUserMessage(0);
    clock.schedule(HOUR, 0);

    expect(clock.tick(maxSilentMs - 1)).toBe("run_tick");
  });

  test("silence: the label and the bootstrap branch agree at the threshold", () => {
    // `isAbandoned` holds a second copy of the silence check, for two callers
    // the deadline path never reaches: the bootstrap branch, which must refuse
    // to re-arm a dormant clock, and `stateAt`, which labels it. Relaxing only
    // that copy leaves the test above green. Mirrors
    // `silence_marks_dormant_exactly_at_the_threshold`.
    const maxSilentMs = 2 * HOUR;
    const clock = new HeartbeatClock(config({ maxSilentMs }), 0);
    clock.onUserMessage(0);
    clock.restore({ ticks_without_user: 0, next_wake_at: undefined, last_user_at: 0 });

    expect(clock.stateAt(maxSilentMs)).toBe("Dormant");
    expect(clock.tick(maxSilentMs)).toBe("none");
    expect(clock.nextWakeAt, "an abandoned clock must not re-arm itself").toBeUndefined();
  });

  test("tick count: reaching the ceiling is already abandoned", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 2, defaultIntervalMs: 60_000 }), 0);
    let now = 0;
    const fire = () => {
      now += 61_000;
      clock.tick(now); // bootstraps the next deadline
      now += 61_000;
      return clock.tick(now);
    };

    expect(fire()).toBe("run_tick");
    expect(fire()).toBe("run_tick");
    expect(clock.ticksWithoutUser).toBe(2);
    // ticksWithoutUser == maxIdleTicks, so the third is refused.
    expect(fire()).toBe("none");
    expect(clock.nextWakeAt).toBeUndefined();
  });
});

describe("the clamp", () => {
  test("a wake sooner than the floor is pushed out to it", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(1_000, 0);
    expect(clock.nextWakeAt).toBe(MIN_WAKE_INTERVAL_MS);
  });

  test("a wake beyond the ceiling is pulled back to it", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(365 * 24 * HOUR, 0);
    expect(clock.nextWakeAt).toBe(MAX_WAKE_INTERVAL_MS);
  });

  test("a wake in the past clamps to the floor rather than firing immediately", () => {
    // `saturating_duration_since` on the Rust side, so a negative delta is zero
    // and then clamped up. A character asking to wake yesterday gets an hour,
    // not a tick on the next loop.
    const clock = new HeartbeatClock(config(), 10 * HOUR);
    clock.schedule(HOUR, 10 * HOUR);
    expect(clock.nextWakeAt).toBe(11 * HOUR);
  });
});

describe("a user message", () => {
  test("pushes an imminent deadline out to the floor", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(HOUR, 0);
    clock.onUserMessage(30 * 60_000);
    expect(clock.nextWakeAt).toBe(30 * 60_000 + MIN_WAKE_INTERVAL_MS);
  });

  test("preserves a deadline the character set further out", () => {
    // The floor is a minimum, not a reset. A character that asked for two days
    // keeps them.
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(47 * HOUR, 0);
    const scheduled = clock.nextWakeAt;
    clock.onUserMessage(60_000);
    expect(clock.nextWakeAt).toBe(scheduled);
  });

  test("wakes a clock the guard had abandoned", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 1 }), 0);
    clock.forceDormant();
    expect(clock.stateAt(0)).toBe("Dormant");

    clock.onUserMessage(HOUR);
    expect(clock.ticksWithoutUser).toBe(0);
    expect(clock.stateAt(HOUR)).toBe("Active");
    expect(clock.nextWakeAt).toBe(HOUR + MIN_WAKE_INTERVAL_MS);
  });
});

describe("the forced transitions", () => {
  // Absent from the parity fixture: the Rust reads `Instant::now()` inside these
  // rather than taking a `now`, so they cannot appear in a time-controlled walk.

  test("force dormant stops the clock until a user returns", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 5 }), 0);
    clock.schedule(HOUR, 0);
    clock.forceDormant();

    expect(clock.ticksWithoutUser).toBe(5);
    expect(clock.nextWakeAt).toBeUndefined();
    expect(clock.stateAt(0)).toBe("Dormant");
    // And it does not re-arm itself on the next loop.
    expect(clock.tick(10 * HOUR)).toBe("none");
    expect(clock.nextWakeAt).toBeUndefined();
  });

  test("force active clears the counters and fires at once", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 5 }), 0);
    clock.forceDormant();
    clock.forceActive(HOUR);

    expect(clock.ticksWithoutUser).toBe(0);
    expect(clock.stateAt(HOUR)).toBe("Active");
    expect(clock.tick(HOUR)).toBe("run_tick");
  });

  test("force wake fires without pretending the user came back", () => {
    // Deliberately does NOT reset the abandonment counters: a forced wake is an
    // operator action, not evidence of a user.
    const clock = new HeartbeatClock(config({ maxIdleTicks: 5 }), 0);
    clock.onUserMessage(0);
    clock.tick(2 * HOUR); // fires, count -> 1
    const before = clock.ticksWithoutUser;

    clock.forceWake(3 * HOUR);
    expect(clock.ticksWithoutUser).toBe(before);
    expect(clock.tick(3 * HOUR)).toBe("run_tick");
  });
});

describe("restore", () => {
  test("a future deadline survives a restart", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.restore({ ticks_without_user: 2, next_wake_at: 5 * HOUR, last_user_at: HOUR });

    expect(clock.ticksWithoutUser).toBe(2);
    expect(clock.nextWakeAt).toBe(5 * HOUR);
    expect(clock.tick(4 * HOUR)).toBe("none");
    expect(clock.tick(5 * HOUR)).toBe("run_tick");
  });

  test("a deadline already in the past fires on the next tick", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.restore({ ticks_without_user: 0, next_wake_at: HOUR, last_user_at: 0 });
    expect(clock.tick(2 * HOUR)).toBe("run_tick");
  });

  test("a snapshot round-trips", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.onUserMessage(HOUR);
    const snapshot = clock.snapshot();

    const restored = new HeartbeatClock(config(), 0);
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
  });
});

describe("seeding the silence anchor", () => {
  test("fills an empty anchor but never overwrites a real one", () => {
    // `undefined` reads as "never silent", which would let dreaming run against
    // a conversation idle for weeks. Backfill fills it; a real message wins.
    const fresh = new HeartbeatClock(config(), 0);
    fresh.seedLastUserAtIfUnset(HOUR);
    expect(fresh.lastUserAt).toBe(HOUR);

    const spoken = new HeartbeatClock(config(), 0);
    spoken.onUserMessage(5 * HOUR);
    spoken.seedLastUserAtIfUnset(HOUR);
    expect(spoken.lastUserAt).toBe(5 * HOUR);
  });
});
