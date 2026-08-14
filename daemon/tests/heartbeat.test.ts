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
    maxIdleTicks: 100,
    maxSilentMs: 48 * HOUR,
    minWakeIntervalMs: HOUR,
    ...overrides,
  };
}

describe("the abandonment guards trip at the threshold, not past it", () => {
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
      clock.tick(now);
      now += 61_000;
      return clock.tick(now);
    };

    expect(fire()).toBe("run_tick");
    expect(fire()).toBe("run_tick");
    expect(clock.ticksWithoutUser).toBe(2);
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
  test("force dormant stops the clock until a user returns", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 5 }), 0);
    clock.schedule(HOUR, 0);
    clock.forceDormant();

    expect(clock.ticksWithoutUser).toBe(5);
    expect(clock.nextWakeAt).toBeUndefined();
    expect(clock.stateAt(0)).toBe("Dormant");
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
    const clock = new HeartbeatClock(config({ maxIdleTicks: 5 }), 0);
    clock.onUserMessage(0);
    clock.tick(2 * HOUR);
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
    const fresh = new HeartbeatClock(config(), 0);
    fresh.seedLastUserAtIfUnset(HOUR);
    expect(fresh.lastUserAt).toBe(HOUR);

    const spoken = new HeartbeatClock(config(), 0);
    spoken.onUserMessage(5 * HOUR);
    spoken.seedLastUserAtIfUnset(HOUR);
    expect(spoken.lastUserAt).toBe(5 * HOUR);
  });
});
