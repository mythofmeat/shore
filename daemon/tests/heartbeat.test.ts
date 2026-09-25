import { describe, expect, test } from "bun:test";

import {
  HeartbeatClock,
  type HeartbeatClockConfig,
} from "../src/autonomy/heartbeat.ts";

const HOUR = 3_600_000;
const CONFIG_MIN = HOUR;
const CONFIG_MAX = 48 * HOUR;

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

describe("live heartbeat settings", () => {
  test("changing the default interval keeps elapsed time and becomes due if it already elapsed", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 10 * HOUR }), 0);
    clock.tick(0);
    clock.setConfig(config({ defaultIntervalMs: 4 * HOUR }), HOUR);
    expect(clock.nextWakeAt).toBe(4 * HOUR);
    clock.setConfig(config({ defaultIntervalMs: 2 * HOUR }), 3 * HOUR);
    expect(clock.tick(3 * HOUR)).toBe("run_tick");
  });

  test("raising the floor delays an existing explicit wake and leaves later wakes intact", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(HOUR, 0);
    clock.setConfig(config({ minIntervalMs: 2 * HOUR }), 30 * 60_000);
    expect(clock.nextWakeAt).toBe(2.5 * HOUR);
    clock.schedule(10 * HOUR, HOUR);
    clock.setConfig(config({ defaultIntervalMs: 4 * HOUR }), 2 * HOUR);
    expect(clock.nextWakeAt).toBe(10 * HOUR);
  });

  test("a reload preserves idle counters and does not schedule a dormant clock", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 2 }), 0);
    clock.forceDormant();
    clock.setConfig(config({ defaultIntervalMs: 2 * HOUR, maxIdleTicks: 2 }), HOUR);
    expect(clock.ticksWithoutUser).toBe(2);
    expect(clock.nextWakeAt).toBeUndefined();
    expect(clock.tick(HOUR)).toBe("none");
  });

  test("forced dormancy outlasts a reload that raises the idle limit", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 2 }), 0);
    clock.forceDormant();
    clock.setConfig(config({ maxIdleTicks: 5 }), HOUR);
    expect(clock.isDormant(HOUR)).toBe(true);
    expect(clock.tick(HOUR)).toBe("none");
    expect(clock.nextWakeAt).toBeUndefined();
    clock.onUserMessage(2 * HOUR);
    expect(clock.isDormant(2 * HOUR)).toBe(false);
  });

  test("forced dormancy outlasts a restart under a higher idle limit", () => {
    const clock = new HeartbeatClock(config({ maxIdleTicks: 2 }), 0);
    clock.forceDormant();
    const restored = new HeartbeatClock(config({ maxIdleTicks: 5 }), HOUR);
    restored.restore(clock.snapshot());
    expect(restored.isDormant(HOUR)).toBe(true);
    expect(restored.tick(HOUR)).toBe("none");
    expect(restored.nextWakeAt).toBeUndefined();
  });

  test("a restored default wake still follows a changed default_interval", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 10 * HOUR }), 0);
    clock.tick(0);
    const restored = new HeartbeatClock(config({ defaultIntervalMs: 10 * HOUR }), HOUR);
    restored.restore(clock.snapshot());
    restored.setConfig(config({ defaultIntervalMs: 4 * HOUR }), HOUR);
    expect(restored.nextWakeAt).toBe(4 * HOUR);
  });

  test("a restored default wake clamped to the bounds still follows a changed default_interval", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 10 * HOUR, maxIntervalMs: 10 * HOUR }), 0);
    clock.tick(0);
    const restored = new HeartbeatClock(config({ defaultIntervalMs: 4 * HOUR, maxIntervalMs: 4 * HOUR }), HOUR);
    restored.restore(clock.snapshot());
    restored.boundWake(HOUR);
    expect(restored.nextWakeAt).toBe(5 * HOUR);
    restored.setConfig(config({ defaultIntervalMs: 2 * HOUR, maxIntervalMs: 4 * HOUR }), HOUR);
    expect(restored.nextWakeAt).toBe(2 * HOUR);
  });

  test("a default wake clamped up to the floor keeps that floor when default_interval changes", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 2 * HOUR }), 0);
    clock.tick(0);
    const restored = new HeartbeatClock(config({ defaultIntervalMs: 2 * HOUR }), 3 * HOUR);
    restored.restore(clock.snapshot());
    restored.boundWake(3 * HOUR);
    expect(restored.nextWakeAt).toBe(4 * HOUR);
    restored.setConfig(config({ defaultIntervalMs: 2.5 * HOUR }), 3 * HOUR);
    expect(restored.nextWakeAt).toBe(4 * HOUR);
    restored.setConfig(config({ defaultIntervalMs: 6 * HOUR }), 3 * HOUR);
    expect(restored.nextWakeAt).toBe(6 * HOUR);
  });

  test("a retained default floor gives way to a lowered ceiling", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 2 * HOUR, minIntervalMs: 4 * HOUR }), 0);
    clock.tick(0);
    const restored = new HeartbeatClock(config({ defaultIntervalMs: 2 * HOUR, minIntervalMs: 4 * HOUR }), 3 * HOUR);
    restored.restore(clock.snapshot());
    restored.boundWake(3 * HOUR);
    expect(restored.nextWakeAt).toBe(7 * HOUR);
    restored.setConfig(config({ defaultIntervalMs: HOUR, minIntervalMs: HOUR, maxIntervalMs: 2 * HOUR }), 3 * HOUR);
    expect(restored.nextWakeAt).toBe(5 * HOUR);
  });

  test("a deferral makes a pending default wake explicit", () => {
    const clock = new HeartbeatClock(config({ defaultIntervalMs: 10 * HOUR }), 0);
    clock.tick(0);
    expect(clock.snapshot().default_wake).toBe(true);
    clock.boundWake(9.5 * HOUR, true);
    expect(clock.nextWakeAt).toBe(10.5 * HOUR);
    expect(clock.snapshot().default_wake).toBeUndefined();
  });

  test("a reload that does not raise the floor never postpones a pending wake", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.onUserMessage(0);
    clock.setConfig(config({ defaultIntervalMs: 2 * HOUR }), 59 * 60_000);
    expect(clock.nextWakeAt).toBe(HOUR);
    clock.setConfig(config({ defaultIntervalMs: 2 * HOUR, minIntervalMs: 30 * 60_000 }), 59 * 60_000);
    expect(clock.nextWakeAt).toBe(HOUR);
  });

  test("lowering the ceiling pulls a far wake in to it", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(40 * HOUR, 0);
    clock.setConfig(config({ maxIntervalMs: 3 * HOUR }), HOUR);
    expect(clock.nextWakeAt).toBe(4 * HOUR);
  });

  test("a clock with no wake uses the new bounds when it first schedules", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.setConfig(config({ defaultIntervalMs: 8 * HOUR, maxIntervalMs: 2 * HOUR }), 0);
    clock.tick(0);
    expect(clock.nextWakeAt).toBe(2 * HOUR);
  });
});

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

describe("a user message", () => {
  test("pushes an imminent deadline out to the floor", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.schedule(HOUR, 0);
    clock.onUserMessage(30 * 60_000);
    expect(clock.nextWakeAt).toBe(30 * 60_000 + CONFIG_MIN);
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
    expect(clock.nextWakeAt).toBe(HOUR + CONFIG_MIN);
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

describe("deferring the wake to the minimum latency", () => {
  test("an overdue deadline is pushed out instead of firing at once", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.restore({ ticks_without_user: 0, next_wake_at: HOUR, last_user_at: 0 });
    clock.boundWake(2 * HOUR);

    expect(clock.nextWakeAt).toBe(3 * HOUR);
    expect(clock.tick(2 * HOUR)).toBe("none");
    expect(clock.tick(3 * HOUR)).toBe("run_tick");
  });

  test("a deadline already past the minimum is left where it is", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.restore({ ticks_without_user: 0, next_wake_at: 9 * HOUR, last_user_at: 0 });
    clock.boundWake(2 * HOUR);

    expect(clock.nextWakeAt).toBe(9 * HOUR);
  });

  test("a clock with no deadline stays unarmed", () => {
    const clock = new HeartbeatClock(config(), 0);
    clock.restore({ ticks_without_user: 0, next_wake_at: undefined, last_user_at: 0 });
    clock.boundWake(2 * HOUR);

    expect(clock.nextWakeAt).toBeUndefined();
  });

  test("the minimum comes from config, not the default interval", () => {
    const clock = new HeartbeatClock(config({ minIntervalMs: 5 * HOUR }), 0);
    clock.restore({ ticks_without_user: 0, next_wake_at: HOUR, last_user_at: 0 });
    clock.boundWake(2 * HOUR);

    expect(clock.nextWakeAt).toBe(7 * HOUR);
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
