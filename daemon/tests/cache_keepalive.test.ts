import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import { CacheKeepalive } from "../src/cache/schedule.ts";

const MODEL = "opus";
const OTHER_MODEL = "glm";

const secs = (s: number) => s * 1000;
const minutes = (m: number) => m * 60_000;
const hours = (h: number) => h * 3_600_000;

const now = minutes(1000);

function armed(at: number): CacheKeepalive {
  const ka = new CacheKeepalive(hours(12));
  ka.setInterval(minutes(55), MODEL, at);
  ka.onCacheWarmed(MODEL, at);
  return ka;
}

describe("arming and cadence", () => {
  test("new returns no action", () => {
    expect(new CacheKeepalive(hours(12)).tick(now)).toBe("none");
  });

  test("off interval never pings", () => {
    const ka = new CacheKeepalive(hours(12));
    ka.onCacheWarmed(MODEL, now);
    expect(ka.tick(now + hours(2))).toBe("none");
    ka.setInterval(undefined, MODEL, now);
    expect(ka.tick(now + hours(2))).toBe("none");
  });

  test("ping fires after interval", () => {
    const ka = armed(now);
    expect(ka.tick(now + minutes(54))).toBe("none");
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("ping reschedules after confirm", () => {
    const ka = armed(now);
    expect(ka.tick(now + minutes(55))).toBe("ping");
    ka.onPingSucceeded(now + minutes(55));
    expect(ka.tick(now + minutes(109))).toBe("none");
    expect(ka.tick(now + minutes(110))).toBe("ping");
  });

  test("cache warm resets ping deadline", () => {
    const ka = armed(now);
    ka.onCacheWarmed(MODEL, now + minutes(30));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + minutes(85))).toBe("ping");
  });

  test("disabling interval stops pinging", () => {
    const ka = armed(now);
    ka.setInterval(undefined, MODEL, now + minutes(10));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + hours(3))).toBe("none");
  });

  test("switching interval reschedules from last activity", () => {
    const ka = armed(now);
    ka.setInterval(hours(6), MODEL, now + minutes(30));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + hours(6))).toBe("ping");
  });
});

describe("the ping deadline", () => {
  function pushed(at: number): CacheKeepalive {
    const ka = new CacheKeepalive(hours(12));
    ka.setInterval(minutes(55), MODEL, at);
    ka.onCacheWarmed(MODEL, at);
    ka.onPrefixWarmed(at);
    return ka;
  }

  test("a warm with no prefix behind it cannot push the ping past the TTL", () => {
    const ka = pushed(now);
    ka.onCacheWarmed(MODEL, now + minutes(13));

    expect(ka.tick(now + minutes(68))).toBe("ping");
    expect(ka.tick(now + minutes(55))).toBe("ping");
    expect(ka.tick(now + minutes(54))).toBe("none");
  });

  test("a real turn does move it, because the push confirms the prefix", () => {
    const ka = pushed(now);
    ka.onCacheWarmed(MODEL, now + minutes(30));
    ka.onPrefixWarmed(now + minutes(30));

    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + minutes(85))).toBe("ping");
  });

  test("a same-model warm is clamped too", () => {
    const ka = pushed(now);
    ka.onCacheWarmed(MODEL, now + minutes(40));
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("a successful ping confirms the prefix it sent", () => {
    const ka = pushed(now);
    ka.onPingSucceeded(now + minutes(55));
    ka.onCacheWarmed(MODEL, now + minutes(70));
    expect(ka.tick(now + minutes(109))).toBe("none");
    expect(ka.tick(now + minutes(110))).toBe("ping");
  });

  test("with nothing confirmed, the plain cadence still arms", () => {
    const ka = new CacheKeepalive(hours(12));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);
    expect(ka.tick(now + minutes(54))).toBe("none");
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("after invalidation, only a real turn re-arms", () => {
    const rebuilt = pushed(now);
    rebuilt.onCacheInvalidated();
    rebuilt.setInterval(minutes(55), MODEL, now + minutes(5));
    expect(rebuilt.tick(now + hours(6))).toBe("none");

    const real = pushed(now);
    real.onCacheInvalidated();
    real.onCacheWarmed(MODEL, now + minutes(5));
    real.onPrefixWarmed(now + minutes(5));
    expect(real.tick(now + minutes(59))).toBe("none");
    expect(real.tick(now + minutes(60))).toBe("ping");
  });

  test("the idle ceiling is untouched by a push", () => {
    const ka = pushed(now);
    for (let m = 55; m <= 60 * 12; m += 55) {
      ka.onPrefixWarmed(now + minutes(m));
    }
    expect(ka.tick(now + hours(12) + minutes(1))).toBe("none");
  });
});

describe("the idle ceiling", () => {
  test("ping succeeded does not reset idle clock", () => {
    const ka = new CacheKeepalive(hours(2));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    expect(ka.tick(now + minutes(55))).toBe("ping");
    ka.onPingSucceeded(now + minutes(55));
    expect(ka.tick(now + minutes(110))).toBe("ping");
    ka.onPingSucceeded(now + minutes(110));
    expect(ka.tick(now + minutes(165))).toBe("none");
    expect(ka.tick(now + minutes(166))).toBe("none");
  });

  test("real activity resets idle clock and resumes", () => {
    const ka = new CacheKeepalive(hours(2));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    ka.onCacheWarmed(MODEL, now + minutes(115));
    expect(ka.tick(now + minutes(120))).toBe("none");
    expect(ka.tick(now + minutes(170))).toBe("ping");
  });
});

describe("off-model warms", () => {
  test("warm on different model is ignored", () => {
    const ka = armed(now);
    ka.onCacheWarmed(OTHER_MODEL, now + minutes(30));
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("warm on different model does not reset idle ceiling", () => {
    const ka = new CacheKeepalive(hours(2));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    ka.onCacheWarmed(OTHER_MODEL, now + minutes(90));
    ka.onPingSucceeded(now + minutes(55));
    ka.onPingSucceeded(now + minutes(110));
    expect(ka.tick(now + minutes(165))).toBe("none");
  });
});

describe("invalidation and model switches", () => {
  test("invalidation pauses and warm resumes", () => {
    const ka = armed(now);
    ka.onCacheInvalidated();
    expect(ka.tick(now + minutes(55))).toBe("none");
    ka.onCacheWarmed(MODEL, now + hours(1));
    expect(ka.tick(now + hours(1) + minutes(55))).toBe("ping");
  });

  test("model switch requires fresh warm before pinging", () => {
    const ka = armed(now);
    ka.setInterval(minutes(55), OTHER_MODEL, now + minutes(10));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + hours(3))).toBe("none");

    ka.onCacheWarmed(OTHER_MODEL, now + hours(4));
    expect(ka.tick(now + hours(4) + minutes(55))).toBe("ping");
  });

  test("set interval after invalidation does not arm cold cache", () => {
    const ka = armed(now);
    ka.onCacheInvalidated();

    ka.setInterval(minutes(55), MODEL, now + minutes(5));
    expect(ka.tick(now + hours(2))).toBe("none");

    ka.onCacheWarmed(MODEL, now + hours(1));
    expect(ka.tick(now + hours(1) + minutes(55))).toBe("ping");
  });
});

describe("retry and give-up", () => {
  test("retry backs off when not confirmed", () => {
    const ka = armed(now);
    expect(ka.tick(now + minutes(55))).toBe("ping");
    ka.onPingFailed(now + minutes(55));
    expect(ka.tick(now + minutes(55) + secs(29))).toBe("none");
    expect(ka.tick(now + minutes(55) + secs(30))).toBe("ping");
  });

  test("persistent ping failures disarm once warm window expires", () => {
    const ka = armed(now);
    expect(ka.tick(now + minutes(55))).toBe("ping");

    ka.onPingFailed(now + minutes(55));
    expect(ka.tick(now + minutes(55) + secs(30))).toBe("ping");
    ka.onPingFailed(now + minutes(56));
    expect(ka.tick(now + minutes(57))).toBe("ping");

    ka.onPingFailed(now + minutes(61));
    expect(ka.tick(now + minutes(62))).toBe("none");
    expect(ka.tick(now + hours(3))).toBe("none");

    ka.onCacheWarmed(MODEL, now + hours(4));
    ka.setInterval(minutes(55), MODEL, now + hours(4));
    expect(ka.tick(now + hours(4) + minutes(55))).toBe("ping");
  });
});

describe("snapshot and restore", () => {
  test("snapshot roundtrips through restore", () => {
    const ka = armed(now);
    const snapshot = ka.snapshot();
    expect(snapshot).toBeDefined();
    expect(required(snapshot).model).toBe(MODEL);
    expect(required(snapshot).interval).toBe(minutes(55));

    const restored = new CacheKeepalive(hours(12));
    expect(restored.restore(required(snapshot), now + minutes(20))).toBe(true);
    expect(restored.tick(now + minutes(54))).toBe("none");
    expect(restored.tick(now + minutes(55))).toBe("ping");
  });

  test("restore stays unarmed when warm is stale", () => {
    const ka = armed(now);
    const snapshot = ka.snapshot();
    expect(snapshot).toBeDefined();

    const restored = new CacheKeepalive(hours(12));
    expect(restored.restore(required(snapshot), now + minutes(56))).toBe(false);
    expect(restored.tick(now + hours(2))).toBe("none");
  });

  test("snapshot absent when unarmed or invalidated", () => {
    expect(new CacheKeepalive(hours(12)).snapshot()).toBeUndefined();

    const ka = armed(now);
    ka.onCacheInvalidated();
    expect(ka.snapshot()).toBeUndefined();
  });
});
