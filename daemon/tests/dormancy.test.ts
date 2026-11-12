import { describe, expect, test } from "bun:test";

import { Dormancy, type DormancyConfig } from "../src/autonomy/dormancy.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 16);

function config(overrides: Partial<DormancyConfig> = {}): DormancyConfig {
  return { maxIdleWakes: 100, maxSilentMs: 48 * HOUR, ...overrides };
}

describe("going dormant", () => {
  test("a character nothing has happened to yet is active, with no wakes counted", () => {
    const fresh = new Dormancy(config({ maxIdleWakes: 1, maxSilentMs: 0 }));
    expect(fresh.isDormant(T0)).toBe(false);
    expect(fresh.snapshot()).toEqual({ wakesWithoutUser: 0, lastUserAt: undefined, forcedDormant: false });
  });

  test("silence: exactly at the limit is already too long, and a millisecond short is not", () => {
    const own = new Dormancy(config({ maxSilentMs: 2 * HOUR }));
    own.onUserMessage(T0);
    expect(own.isDormant(T0 + 2 * HOUR - 1)).toBe(false);
    expect(own.isDormant(T0 + 2 * HOUR)).toBe(true);
  });

  test("a character the user has never written to isn't dormant for silence, and a time taken from its history doesn't replace one it has", () => {
    const own = new Dormancy(config({ maxSilentMs: HOUR }));
    expect(own.lastUserAt).toBeUndefined();
    expect(own.isDormant(T0 + 1000 * HOUR)).toBe(false);
    own.seedLastUserAtIfUnset(T0);
    expect(own.isDormant(T0 + HOUR)).toBe(true);
    own.seedLastUserAtIfUnset(T0 + HOUR);
    expect(own.lastUserAt).toBe(T0);
  });

  test("wakes: each one counts, and reaching the limit is already dormant", () => {
    const own = new Dormancy(config({ maxIdleWakes: 2 }));
    own.wakeStarted();
    expect(own.wakesWithoutUser).toBe(1);
    expect(own.isDormant(T0)).toBe(false);
    own.wakeStarted();
    expect(own.wakesWithoutUser).toBe(2);
    expect(own.isDormant(T0)).toBe(true);
  });

  test("a message from the user ends it, whatever brought it on", () => {
    const idle = new Dormancy(config({ maxIdleWakes: 1 }));
    idle.wakeStarted();
    expect(idle.isDormant(T0 + HOUR)).toBe(true);
    idle.onUserMessage(T0 + 20 * HOUR);
    expect(idle.isDormant(T0 + 20 * HOUR)).toBe(false);
    expect(idle.wakesWithoutUser).toBe(0);
    expect(idle.lastUserAt).toBe(T0 + 20 * HOUR);

    const slept = new Dormancy(config());
    slept.forceDormant();
    expect(slept.isDormant(T0)).toBe(true);
    expect(slept.wakesWithoutUser).toBe(0);
    slept.onUserMessage(T0 + HOUR);
    expect(slept.isDormant(T0 + HOUR)).toBe(false);
  });

  test("the user's new settings count from the moment they are set", () => {
    const own = new Dormancy(config({ maxIdleWakes: 5 }));
    own.wakeStarted();
    expect(own.isDormant(T0)).toBe(false);
    own.setConfig(config({ maxIdleWakes: 1 }));
    expect(own.config.maxIdleWakes).toBe(1);
    expect(own.isDormant(T0)).toBe(true);
  });

  test("across a restart everything it keeps comes back as it was", () => {
    const own = new Dormancy(config());
    own.onUserMessage(T0 + 2 * HOUR);
    own.wakeStarted();
    own.forceDormant();
    const kept = own.snapshot();
    expect(kept).toEqual({ wakesWithoutUser: 1, lastUserAt: T0 + 2 * HOUR, forcedDormant: true });
    const back = new Dormancy(config());
    back.restore(kept);
    expect(back.snapshot()).toEqual(kept);
    expect(back.isDormant(T0 + 2 * HOUR)).toBe(true);
  });
});
