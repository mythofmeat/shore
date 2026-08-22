import { describe, expect, test } from "bun:test";

import {
  HeartbeatClock,
  MAX_WAKE_INTERVAL_MS,
  MIN_WAKE_INTERVAL_MS,
} from "../src/autonomy/heartbeat.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CONFIG = {
  defaultIntervalMs: HOUR,
  maxIdleTicks: 6,
  maxSilentMs: 2 * DAY,
  minWakeIntervalMs: HOUR,
};

const clockAt = (now = 0, over: Partial<typeof CONFIG> = {}) =>
  new HeartbeatClock({ ...CONFIG, ...over }, now);

describe("a clock that has never been scheduled", () => {
  test("does not fire on its first tick, it arms itself instead", () => {
    const clock = clockAt(0);
    expect(clock.tick(0)).toBe("none");
    expect(clock.nextWakeAt).toBe(CONFIG.defaultIntervalMs);
  });

  test("arms relative to when it was created, not to when the tick arrived", () => {
    const clock = clockAt(1000);
    clock.tick(500_000);
    expect(clock.nextWakeAt).toBe(1000 + CONFIG.defaultIntervalMs);
  });
});

describe("a tick against an armed clock", () => {
  test("does nothing before the wake time", () => {
    const clock = clockAt(0);
    clock.tick(0);
    expect(clock.tick(CONFIG.defaultIntervalMs - 1)).toBe("none");
    expect(clock.nextWakeAt).toBe(CONFIG.defaultIntervalMs);
  });

  test("fires at the wake time, and disarms so it cannot fire twice", () => {
    const clock = clockAt(0);
    clock.tick(0);
    expect(clock.tick(CONFIG.defaultIntervalMs)).toBe("run_tick");
    expect(clock.nextWakeAt).toBeUndefined();
  });

  test("counts each firing against the idle budget", () => {
    const clock = clockAt(0);
    expect(clock.ticksWithoutUser).toBe(0);
    clock.tick(0);
    clock.tick(HOUR);
    expect(clock.ticksWithoutUser).toBe(1);
  });
});

describe("a clock that has run out of idle budget", () => {
  test("stops firing once it has ticked its ceiling", () => {
    const clock = clockAt(0);
    let fired = 0;
    for (let i = 0; i <= CONFIG.maxIdleTicks * 3; i += 1) {
      if (clock.tick(i * HOUR) === "run_tick") fired += 1;
    }
    expect(fired).toBe(CONFIG.maxIdleTicks);
  });

  test("reads as dormant", () => {
    const clock = clockAt(0);
    for (let i = 0; i <= CONFIG.maxIdleTicks * 2; i += 1) clock.tick(i * HOUR);
    expect(clock.stateAt(CONFIG.maxIdleTicks * 2 * HOUR)).toBe("Dormant");
  });

  test("does not re-arm itself on a later tick", () => {
    const clock = clockAt(0);
    for (let i = 0; i <= CONFIG.maxIdleTicks * 2; i += 1) clock.tick(i * HOUR);
    clock.tick(100 * HOUR);
    expect(clock.nextWakeAt).toBeUndefined();
  });
});

describe("silence for long enough is dormancy too, however few ticks have run", () => {
  test("a clock whose last user is older than the ceiling stops firing", () => {
    const clock = clockAt(0);
    clock.onUserMessage(0);
    expect(clock.stateAt(CONFIG.maxSilentMs - 1)).toBe("Active");
    expect(clock.stateAt(CONFIG.maxSilentMs)).toBe("Dormant");
    expect(clock.tick(CONFIG.maxSilentMs)).toBe("none");
  });

  test("a clock that has never seen a user is not silent, only unstarted", () => {
    const clock = clockAt(0);
    expect(clock.stateAt(10 * DAY)).toBe("Active");
  });
});

describe("a user message", () => {
  test("clears the idle budget, so a dormant clock wakes up again", () => {
    const clock = clockAt(0);
    for (let i = 0; i <= CONFIG.maxIdleTicks * 2; i += 1) clock.tick(i * HOUR);
    expect(clock.stateAt(50 * HOUR)).toBe("Dormant");

    clock.onUserMessage(50 * HOUR);
    expect(clock.ticksWithoutUser).toBe(0);
    expect(clock.stateAt(50 * HOUR)).toBe("Active");
  });

  test("pushes the next wake out to at least the minimum latency", () => {
    const clock = clockAt(0);
    clock.onUserMessage(0);
    expect(clock.nextWakeAt).toBe(CONFIG.minWakeIntervalMs);
  });

  test("never pulls an already-later wake forward", () => {
    const clock = clockAt(0);
    clock.schedule(10 * DAY, 0);
    const scheduled = clock.nextWakeAt;
    clock.onUserMessage(0);
    expect(clock.nextWakeAt).toBe(scheduled);
  });

  test("records when it arrived, which is what silence is measured from", () => {
    const clock = clockAt(0);
    clock.onUserMessage(12345);
    expect(clock.lastUserAt).toBe(12345);
  });
});

describe("scheduling a wake explicitly", () => {
  test("is clamped up to the minimum, so nothing can ask to wake immediately", () => {
    const clock = clockAt(0);
    clock.schedule(1, 0);
    expect(clock.nextWakeAt).toBe(MIN_WAKE_INTERVAL_MS);
  });

  test("is clamped down to the maximum, so nothing can sleep forever", () => {
    const clock = clockAt(0);
    clock.schedule(365 * DAY, 0);
    expect(clock.nextWakeAt).toBe(MAX_WAKE_INTERVAL_MS);
  });

  test("a time already past is treated as the soonest allowed, not as overdue", () => {
    const clock = clockAt(0);
    clock.schedule(-DAY, HOUR);
    expect(clock.nextWakeAt).toBe(HOUR + MIN_WAKE_INTERVAL_MS);
  });
});

describe("the forcing controls", () => {
  test("forceDormant stops it immediately, without waiting out the budget", () => {
    const clock = clockAt(0);
    clock.forceDormant();
    expect(clock.stateAt(0)).toBe("Dormant");
    expect(clock.nextWakeAt).toBeUndefined();
    expect(clock.tick(100 * HOUR)).toBe("none");
  });

  test("forceActive undoes it, and arms the clock for now", () => {
    const clock = clockAt(0);
    clock.forceDormant();
    clock.forceActive(5 * HOUR);
    expect(clock.stateAt(5 * HOUR)).toBe("Active");
    expect(clock.nextWakeAt).toBe(5 * HOUR);
    expect(clock.tick(5 * HOUR)).toBe("run_tick");
  });

  test("seeding a last-user time only fills a gap, it never overwrites", () => {
    const clock = clockAt(0);
    clock.seedLastUserAtIfUnset(1000);
    expect(clock.lastUserAt).toBe(1000);
    clock.seedLastUserAtIfUnset(9999);
    expect(clock.lastUserAt).toBe(1000);
  });
});

describe("over a long randomised run of events", () => {
  function walk(seed: number): void {
    let state = seed * 2654435761;
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };

    const clock = clockAt(0);
    let now = 0;
    let fired = 0;
    let lastUser: number | undefined;

    for (let step = 0; step < 400; step += 1) {
      now += rand(3 * HOUR) + 1;
      switch (rand(5)) {
        case 0:
          clock.onUserMessage(now);
          lastUser = now;
          break;
        case 1:
          clock.schedule(now + rand(5 * DAY), now);
          break;
        case 2:
          clock.forceDormant();
          break;
        case 3:
          clock.seedLastUserAtIfUnset(now);
          lastUser ??= now;
          break;
        default:
          if (clock.tick(now) === "run_tick") fired += 1;
      }

      const where = `seed ${seed} step ${step}`;
      const wake = clock.nextWakeAt;
      if (wake !== undefined) {
        expect(wake, `${where}: a wake is never scheduled beyond the ceiling`).toBeLessThanOrEqual(
          now + MAX_WAKE_INTERVAL_MS,
        );
      }
      expect(clock.ticksWithoutUser, `${where}: idle budget is never negative`).toBeGreaterThanOrEqual(0);
      expect(
        clock.ticksWithoutUser,
        `${where}: idle budget never runs past its ceiling`,
      ).toBeLessThanOrEqual(CONFIG.maxIdleTicks);
      expect(clock.lastUserAt, `${where}: last user time is only ever set forward`).toBe(lastUser);
      expect(
        clock.stateAt(now),
        `${where}: dormancy agrees with the budget and the silence`,
      ).toBe(
        clock.ticksWithoutUser >= CONFIG.maxIdleTicks ||
          (lastUser !== undefined && now - lastUser >= CONFIG.maxSilentMs)
          ? "Dormant"
          : "Active",
      );
    }

    expect(fired, `seed ${seed}: a long run fires at least once`).toBeGreaterThan(0);
  }

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`the invariants hold for seed ${seed}`, () => {
      walk(seed);
    });
  }
});
