import { describe, expect, test } from "bun:test";

import {
  HeartbeatClock,
  type HeartbeatClockConfig,
} from "../src/autonomy/heartbeat.ts";

const HOUR = 3_600_000;
const CONFIG_MIN = HOUR;
const CONFIG_MAX = 48 * HOUR;
const T0 = Date.UTC(2026, 9, 16);

function config(overrides: Partial<HeartbeatClockConfig> = {}): HeartbeatClockConfig {
  return {
    defaultIntervalMs: HOUR,
    maxIdleTicks: 100,
    maxSilentMs: 48 * HOUR,
    minIntervalMs: HOUR,
    maxIntervalMs: 48 * 3_600_000,
    ...overrides,
  };
}

describe("the configured bounds apply to every wake, whoever set it", () => {
  test("a wake the character asks for is held inside min_interval and max_interval", () => {
    const clock = new HeartbeatClock(config({ minIntervalMs: 10 * 60_000, maxIntervalMs: 3 * HOUR }), 0);
    expect(clock.schedule(60_000, 0)).toBe(10 * 60_000);
    expect(clock.nextWakeAt).toBe(10 * 60_000);
    expect(clock.schedule(10 * HOUR, 0)).toBe(3 * HOUR);
    expect(clock.nextWakeAt).toBe(3 * HOUR);
    expect(clock.schedule(2 * HOUR, 0)).toBe(2 * HOUR);
  });

  test("a default_interval below min_interval waits for the floor", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 10 * 60_000, minIntervalMs: HOUR }), 0);
    expect(clock.tick(0)).toBe("none");
    expect(clock.nextWakeAt).toBe(HOUR);
  });

  test("a default_interval above max_interval is cut to the ceiling", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 72 * HOUR }), 0);
    expect(clock.tick(0)).toBe("none");
    expect(clock.nextWakeAt).toBe(48 * HOUR);
  });

  test("a user message pushes any sooner wake back to the floor", () => {
    const clock = new HeartbeatClock(config({ minIntervalMs: 2 * HOUR }), 0);
    clock.schedule(2 * HOUR, 0);
    clock.onUserMessage(HOUR);
    expect(clock.nextWakeAt).toBe(3 * HOUR);
  });
});

describe("the abandonment guards trip at the threshold, not past it", () => {
  test("silence: exactly at the ceiling is already too silent", () => {
    const maxSilentMs = 2 * HOUR;
    const clock = new HeartbeatClock(config({ maxSilentMs }), T0);
    clock.onUserMessage(T0);
    clock.schedule(T0 + HOUR, T0);

    expect(clock.tick(T0 + maxSilentMs)).toBe("none");
    expect(clock.nextWakeAt, "tripping the guard clears the deadline").toBeUndefined();
  });

  test("silence: one millisecond short still fires", () => {
    const maxSilentMs = 2 * HOUR;
    const clock = new HeartbeatClock(config({ maxSilentMs }), T0);
    clock.onUserMessage(T0);
    clock.schedule(T0 + HOUR, T0);

    expect(clock.tick(T0 + maxSilentMs - 1)).toBe("run_tick");
  });

  test("silence: the label and the bootstrap branch agree at the threshold", () => {
    const maxSilentMs = 2 * HOUR;
    const clock = new HeartbeatClock(config({ maxSilentMs }), T0);
    clock.onUserMessage(T0);
    clock.restore({ ticks_without_user: 0, next_wake_at: undefined, last_user_at: T0 });

    expect(clock.stateAt(T0 + maxSilentMs)).toBe("Dormant");
    expect(clock.tick(T0 + maxSilentMs)).toBe("none");
    expect(clock.nextWakeAt, "an abandoned clock must not re-arm itself").toBeUndefined();
  });

  test("tick count: reaching the ceiling is already abandoned", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 2, defaultIntervalMs: 60_000, minIntervalMs: 60_000 }), 0);
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
  test("nothing fires before its time, and the next default wake counts from the last one", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 2 * HOUR }), T0);
    clock.schedule(T0 + HOUR, T0);
    expect(clock.tick(T0 + HOUR - 1)).toBe("none");
    expect(clock.tick(T0 + HOUR)).toBe("run_tick");
    expect(clock.tick(T0 + HOUR + 1)).toBe("none");
    expect(clock.nextWakeAt).toBe(T0 + 3 * HOUR);
  });

  test("a wake sooner than the floor is pushed out to it", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(1_000, 0);
    expect(clock.nextWakeAt).toBe(CONFIG_MIN);
  });

  test("a wake beyond the ceiling is pulled back to it", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(365 * 24 * HOUR, 0);
    expect(clock.nextWakeAt).toBe(CONFIG_MAX);
  });

  test("a wake in the past clamps to the floor rather than firing immediately", () => {
    const clock = new HeartbeatClock(config(), 10 * HOUR);
    clock.schedule(HOUR, 10 * HOUR);
    expect(clock.nextWakeAt).toBe(11 * HOUR);
  });
});

describe("a character that has stopped waking stays stopped", () => {
  test("a wake it set itself does not fire once it is past the tick ceiling", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 1 }), T0);
    clock.schedule(T0 + HOUR, T0);
    expect(clock.tick(T0 + HOUR)).toBe("run_tick");
    clock.schedule(T0 + 2 * HOUR, T0 + HOUR);
    expect(clock.tick(T0 + 2 * HOUR)).toBe("none");
    expect(clock.nextWakeAt).toBeUndefined();
  });

  test("put to sleep, it stays asleep across a restart, even with a wake on the books", () => {
    const idle = new HeartbeatClock(config(), T0);
    idle.restore({ ticks_without_user: 0, next_wake_at: undefined, last_user_at: undefined, forced_dormant: true });
    expect(idle.stateAt(T0)).toBe("Dormant");
    expect(idle.tick(T0)).toBe("none");
    expect(idle.nextWakeAt).toBeUndefined();

    const booked = new HeartbeatClock(config(), T0);
    booked.restore({ ticks_without_user: 0, next_wake_at: T0 + HOUR, last_user_at: undefined, forced_dormant: true });
    expect(booked.tick(T0 + HOUR)).toBe("none");
  });

  test("a user message brings it back", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 1 }), T0);
    clock.schedule(T0 + HOUR, T0);
    expect(clock.tick(T0 + HOUR)).toBe("run_tick");
    expect(clock.stateAt(T0 + HOUR)).toBe("Dormant");

    clock.onUserMessage(T0 + 2 * HOUR);
    expect(clock.stateAt(T0 + 2 * HOUR)).toBe("Active");
    expect(clock.tick(T0 + 3 * HOUR)).toBe("run_tick");

    clock.forceDormant();
    clock.onUserMessage(T0 + 4 * HOUR);
    expect(clock.tick(T0 + 5 * HOUR)).toBe("run_tick");
  });
});
