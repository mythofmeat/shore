import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { CacheKeepalive } from "../src/cache/schedule.ts";

const MODEL = "opus";
const minutes = (m: number) => m * 60_000;
const hours = (h: number) => h * 3_600_000;

const now = minutes(1000);

const PLENTY = 12;

describe("arming and cadence", () => {

  test("off interval never pings", () => {
    const ka = new CacheKeepalive(PLENTY);
    ka.onCacheWarmed(MODEL, now);
    expect(ka.tick(now + hours(2))).toBe("none");
    ka.setInterval(undefined, MODEL, now);
    expect(ka.tick(now + hours(2))).toBe("none");
  });
});

describe("the ping count", () => {
  test("each successful ping spends one, and a spent count stops the schedule", () => {
    const ka = new CacheKeepalive(2);
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    expect(ka.tick(now + minutes(55))).toBe("ping");
    ka.onPingSucceeded(now + minutes(55));
    expect(ka.tick(now + minutes(110))).toBe("ping");
    ka.onPingSucceeded(now + minutes(110));
    expect(ka.tick(now + minutes(165))).toBe("none");
    expect(ka.tick(now + minutes(166))).toBe("none");
  });

  test("the last allowed ping leaves no next ping scheduled", () => {
    const ka = new CacheKeepalive(1);
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);
    ka.onPingSucceeded(now + minutes(55));
    expect(ka.nextPingAt).toBeUndefined();

    const restored = new CacheKeepalive(1);
    expect(restored.restore(required(ka.snapshot()), now + minutes(60))).toBe(true);
    expect(restored.nextPingAt).toBeUndefined();
  });

  test("real activity gives the count back and resumes", () => {
    const ka = new CacheKeepalive(1);
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);
    expect(ka.tick(now + minutes(55))).toBe("ping");
    ka.onPingSucceeded(now + minutes(55));
    expect(ka.tick(now + minutes(110))).toBe("none");

    ka.onCacheWarmed(MODEL, now + minutes(115));
    ka.onPrefixWarmed(now + minutes(115));
    expect(ka.tick(now + minutes(120))).toBe("none");
    expect(ka.tick(now + minutes(170))).toBe("ping");
  });
});
