/**
 * Ported from `the deleted port::tests`, test for test,
 * while both implementations existed. The Rust is gone; these are now this
 * implementation's own tests, kept case for case.
 *
 * Every one of these is a receipt. The Rust comments naming what each cost —
 * a sonnet keepalive paying a 21k write after a model switch, twelve
 * consecutive cold pings behind a budget block, background ticks pushing the
 * ping past its own TTL — are kept verbatim, because the tests are only
 * legible alongside the incident that produced them.
 */

import { describe, expect, test } from "bun:test";

import { CacheKeepalive } from "../src/cache/schedule.ts";

/** The model whose cache the keepalive maintains in these tests. */
const MODEL = "opus";
/** A different model — a warm reported on this must NOT count. */
const OTHER_MODEL = "glm";

const secs = (s: number) => s * 1000;
const minutes = (m: number) => m * 60_000;
const hours = (h: number) => h * 3_600_000;

/**
 * An arbitrary monotonic origin. The Rust reads `Instant::now()`; any fixed
 * base works here, and a non-zero one keeps the arithmetic honest.
 */
const now = minutes(1000);

/** A keepalive with a 12h idle ceiling and a 55m interval already armed. */
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
    // No interval set (keepalive off) — warming does not schedule a ping.
    ka.onCacheWarmed(MODEL, now);
    expect(ka.tick(now + hours(2))).toBe("none");
    // Explicitly off.
    ka.setInterval(undefined, MODEL, now);
    expect(ka.tick(now + hours(2))).toBe("none");
  });

  test("ping fires after interval", () => {
    const ka = armed(now);
    // Not due yet at 54 minutes (interval is 55min).
    expect(ka.tick(now + minutes(54))).toBe("none");
    // Due at 55 minutes.
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("ping reschedules after confirm", () => {
    const ka = armed(now);
    expect(ka.tick(now + minutes(55))).toBe("ping");
    // Confirm the ping succeeded — advances from the ping time.
    ka.onPingSucceeded(now + minutes(55));
    expect(ka.tick(now + minutes(109))).toBe("none");
    expect(ka.tick(now + minutes(110))).toBe("ping");
  });

  test("cache warm resets ping deadline", () => {
    const ka = armed(now);
    // A user message warms the cache at 30min.
    ka.onCacheWarmed(MODEL, now + minutes(30));
    // The old ping at 55min should NOT fire (deadline moved to 30+55=85).
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + minutes(85))).toBe("ping");
  });

  test("disabling interval stops pinging", () => {
    const ka = armed(now);
    // User switches to a model with keepalive off.
    ka.setInterval(undefined, MODEL, now + minutes(10));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + hours(3))).toBe("none");
  });

  test("switching interval reschedules from last activity", () => {
    const ka = armed(now);
    // Switch to a 6h cadence at 30min; anchored to last activity (now), the
    // next ping moves to 6h.
    ka.setInterval(hours(6), MODEL, now + minutes(30));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + hours(6))).toBe("ping");
  });
});

/**
 * #27: the deadline is anchored on the last *confirmed* warm of the prefix a
 * ping sends, not on the last event claiming to be a warm.
 *
 *     nextPingAt = min(now + interval, prefixWarmAt + interval)
 *
 * The evidence was eleven cold pings in one day, eight of them preceded exactly
 * 55 minutes earlier by a call on a *different* model — and three by a call on
 * the same model with a different prefix, which the model guard could not see.
 * In both shapes the timer re-armed on an event that never refreshed what the
 * ping sends, and the effective interval became "55 minutes after whatever ran
 * last" rather than 55 minutes after the prefix was last warm.
 */
describe("the ping deadline", () => {
  /** A schedule whose prefix was confirmed warm by a completed turn. */
  function pushed(at: number): CacheKeepalive {
    const ka = new CacheKeepalive(hours(12));
    ka.setInterval(minutes(55), MODEL, at);
    ka.onCacheWarmed(MODEL, at);
    ka.onPrefixWarmed(at);
    return ka;
  }

  test("a warm with no prefix behind it cannot push the ping past the TTL", () => {
    const ka = pushed(now);
    // The worked example from the issue: a background tick lands 13 minutes in.
    // It ran, so the funnel reports it — but it never touched this prefix.
    ka.onCacheWarmed(MODEL, now + minutes(13));

    // The old shape put the next ping at 13+55 = 68 minutes, past a 1h TTL.
    expect(ka.tick(now + minutes(68))).toBe("ping");
    // And it is due at 55, where it always should have been.
    expect(ka.tick(now + minutes(55))).toBe("ping");
    expect(ka.tick(now + minutes(54))).toBe("none");
  });

  test("a real turn does move it, because the push confirms the prefix", () => {
    const ka = pushed(now);
    // A turn: the funnel sees the call, then the body it sent is cached.
    ka.onCacheWarmed(MODEL, now + minutes(30));
    ka.onPrefixWarmed(now + minutes(30));

    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + minutes(85))).toBe("ping");
  });

  test("a same-model warm is clamped too", () => {
    // The three cold pings `4ee6bb7f` left behind: the model guard passes,
    // because the call really was on this model, but the prefix it warmed was
    // not the one the ping sends. Only a push can tell the difference.
    const ka = pushed(now);
    ka.onCacheWarmed(MODEL, now + minutes(40));
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("a successful ping confirms the prefix it sent", () => {
    const ka = pushed(now);
    ka.onPingSucceeded(now + minutes(55));
    // Anchored on the ping, and unmoved by a warm that follows it.
    ka.onCacheWarmed(MODEL, now + minutes(70));
    expect(ka.tick(now + minutes(109))).toBe("none");
    expect(ka.tick(now + minutes(110))).toBe("ping");
  });

  test("with nothing confirmed, the plain cadence still arms", () => {
    // A character whose calls never push — the clamp must not leave it unarmed,
    // which would be a keepalive that never pings at all.
    const ka = new CacheKeepalive(hours(12));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);
    expect(ka.tick(now + minutes(54))).toBe("none");
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("after invalidation, only a real turn re-arms", () => {
    // The rebuild-from-disk push is the case to get right: that body was
    // assembled from `active.jsonl` and has never been sent, so it arrives as
    // `setInterval` alone with no `onPrefixWarmed` behind it, and must leave
    // the schedule stood down.
    const rebuilt = pushed(now);
    rebuilt.onCacheInvalidated();
    rebuilt.setInterval(minutes(55), MODEL, now + minutes(5));
    expect(rebuilt.tick(now + hours(6))).toBe("none");

    // A real turn is the other half: the funnel sees the call and the body it
    // sent is cached, so there is a warm prefix again and pinging resumes.
    const real = pushed(now);
    real.onCacheInvalidated();
    real.onCacheWarmed(MODEL, now + minutes(5));
    real.onPrefixWarmed(now + minutes(5));
    expect(real.tick(now + minutes(59))).toBe("none");
    expect(real.tick(now + minutes(60))).toBe("ping");
  });

  test("the idle ceiling is untouched by a push", () => {
    // `onPrefixWarmed` says the prefix is warm, not that the user is present.
    // Moving the idle anchor here would let a run of turns-plus-pings keep the
    // ceiling out of reach.
    const ka = pushed(now);
    for (let m = 55; m <= 60 * 12; m += 55) {
      ka.onPrefixWarmed(now + minutes(m));
    }
    expect(ka.tick(now + hours(12) + minutes(1))).toBe("none");
  });
});

describe("the idle ceiling", () => {
  test("ping succeeded does not reset idle clock", () => {
    // The maxIdle cutoff counts from the last REAL activity, so repeated pings
    // must not push it back. With a 2h ceiling and 55m interval, the third
    // scheduled ping lands past the ceiling and must be suppressed.
    const ka = new CacheKeepalive(hours(2));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    // Ping 1 at 55m — within 2h.
    expect(ka.tick(now + minutes(55))).toBe("ping");
    ka.onPingSucceeded(now + minutes(55));
    // Ping 2 at 110m — within 2h.
    expect(ka.tick(now + minutes(110))).toBe("ping");
    ka.onPingSucceeded(now + minutes(110));
    // Ping 3 would be at 165m — past the 2h (120m) idle ceiling → stop.
    expect(ka.tick(now + minutes(165))).toBe("none");
    // Cleared, so later ticks also stay quiet until real activity resumes.
    expect(ka.tick(now + minutes(166))).toBe("none");
  });

  test("real activity resets idle clock and resumes", () => {
    const ka = new CacheKeepalive(hours(2));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    // Drift to just under the ceiling, then a real message arrives.
    ka.onCacheWarmed(MODEL, now + minutes(115));
    // The old 55m ping does not fire; the timer moved to 115+55=170m.
    expect(ka.tick(now + minutes(120))).toBe("none");
    // Fires at 170m, now measured against the fresh activity at 115m.
    expect(ka.tick(now + minutes(170))).toBe("ping");
  });
});

describe("off-model warms", () => {
  test("warm on different model is ignored", () => {
    // Regression: a heartbeat/background tick on a DIFFERENT model than the
    // keepalive target does not refresh the target's prompt cache, so it must
    // neither reschedule the ping nor reset the idle clock. Counting it (the
    // old bug) pushed the ping past the cache's TTL, turning every ping into a
    // full cache recreation.
    const ka = armed(now);
    // Off-model "warm" at 30min must NOT move the deadline to 30+55=85m...
    ka.onCacheWarmed(OTHER_MODEL, now + minutes(30));
    // ...the original 55m ping (from the real warm at `now`) still stands.
    expect(ka.tick(now + minutes(55))).toBe("ping");
  });

  test("warm on different model does not reset idle ceiling", () => {
    // The idle ceiling counts from the last REAL target warm. An off-model tick
    // must not push it back, or background noise would keep the cache warm
    // forever while the user is away.
    const ka = new CacheKeepalive(hours(2));
    ka.setInterval(minutes(55), MODEL, now);
    ka.onCacheWarmed(MODEL, now);

    // An off-model tick at 90min does not reset the 2h ceiling anchored at `now`.
    ka.onCacheWarmed(OTHER_MODEL, now + minutes(90));
    ka.onPingSucceeded(now + minutes(55));
    ka.onPingSucceeded(now + minutes(110));
    // Ping 3 at 165m is past the 2h ceiling (still measured from `now`) → stop.
    expect(ka.tick(now + minutes(165))).toBe("none");
  });
});

describe("invalidation and model switches", () => {
  test("invalidation pauses and warm resumes", () => {
    const ka = armed(now);
    // The cached prefix becomes unusable (e.g. model switch).
    ka.onCacheInvalidated();
    expect(ka.tick(now + minutes(55))).toBe("none");
    // Next real call warms a new prefix — pings resume.
    ka.onCacheWarmed(MODEL, now + hours(1));
    expect(ka.tick(now + hours(1) + minutes(55))).toBe("ping");
  });

  test("model switch requires fresh warm before pinging", () => {
    // Switching the chat model retargets the keepalive, but the new model's
    // prefix has never been warmed — an armed timer carried across the switch
    // would fire a cold ping (observed live: a sonnet keepalive paying a 21k
    // write right after an opus→sonnet switch).
    const ka = armed(now);
    ka.setInterval(minutes(55), OTHER_MODEL, now + minutes(10));
    expect(ka.tick(now + minutes(55))).toBe("none");
    expect(ka.tick(now + hours(3))).toBe("none");

    // A real warm on the new model resumes pinging.
    ka.onCacheWarmed(OTHER_MODEL, now + hours(4));
    expect(ka.tick(now + hours(4) + minutes(55))).toBe("ping");
  });

  test("set interval after invalidation does not arm cold cache", () => {
    // After invalidation, a model-switch `setInterval` must NOT re-arm off the
    // stale activity timestamp: pinging a cold prefix is exactly what
    // invalidation exists to prevent. Only a real warm resumes pinging.
    const ka = armed(now);
    ka.onCacheInvalidated();

    // New request cached for the switched model, but nothing has warmed its
    // prefix yet → no ping armed, even far in the future.
    ka.setInterval(minutes(55), MODEL, now + minutes(5));
    expect(ka.tick(now + hours(2))).toBe("none");

    // A real call warms the new prefix → pinging resumes from there.
    ka.onCacheWarmed(MODEL, now + hours(1));
    expect(ka.tick(now + hours(1) + minutes(55))).toBe("ping");
  });
});

describe("retry and give-up", () => {
  test("retry backs off when not confirmed", () => {
    const ka = armed(now);
    expect(ka.tick(now + minutes(55))).toBe("ping");
    // Caller does NOT confirm (ping failed/skipped) — short backoff, not a
    // tight spin.
    ka.onPingFailed(now + minutes(55));
    expect(ka.tick(now + minutes(55) + secs(29))).toBe("none");
    expect(ka.tick(now + minutes(55) + secs(30))).toBe("ping");
  });

  test("persistent ping failures disarm once warm window expires", () => {
    // A budget block (or provider outage) fails every ping. Retries are fine
    // while the prefix could still be warm, but once the last warm is older
    // than interval + grace the cache is dead — retrying further would
    // eventually "succeed" with a full cold write hours later (the $-burning
    // failure mode observed live). The keepalive must disarm.
    const ka = armed(now);
    expect(ka.tick(now + minutes(55))).toBe("ping");

    // Failures within the warm window keep retrying...
    ka.onPingFailed(now + minutes(55));
    expect(ka.tick(now + minutes(55) + secs(30))).toBe("ping");
    ka.onPingFailed(now + minutes(56));
    expect(ka.tick(now + minutes(57))).toBe("ping");

    // ...but a failure past interval (55m) + grace (5m) disarms for good.
    ka.onPingFailed(now + minutes(61));
    expect(ka.tick(now + minutes(62))).toBe("none");
    expect(ka.tick(now + hours(3))).toBe("none");

    // A real warm re-arms the schedule.
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
    expect(snapshot!.model).toBe(MODEL);
    expect(snapshot!.interval).toBe(minutes(55));

    // Restart 20 minutes later: warm is fresher than one interval, so the
    // schedule re-arms and the ping still fires at last_warm + interval.
    const restored = new CacheKeepalive(hours(12));
    expect(restored.restore(snapshot!, now + minutes(20))).toBe(true);
    expect(restored.tick(now + minutes(54))).toBe("none");
    expect(restored.tick(now + minutes(55))).toBe("ping");
  });

  test("restore stays unarmed when warm is stale", () => {
    // Restart after more than one interval since the last warm: the prefix may
    // already be past its TTL, so re-arming could fire a cold ping. Stay
    // unarmed until the next real warm.
    const ka = armed(now);
    const snapshot = ka.snapshot();
    expect(snapshot).toBeDefined();

    const restored = new CacheKeepalive(hours(12));
    expect(restored.restore(snapshot!, now + minutes(56))).toBe(false);
    expect(restored.tick(now + hours(2))).toBe("none");
  });

  test("snapshot absent when unarmed or invalidated", () => {
    expect(new CacheKeepalive(hours(12)).snapshot()).toBeUndefined();

    const ka = armed(now);
    ka.onCacheInvalidated();
    expect(ka.snapshot()).toBeUndefined();
  });
});
