/**
 * Ported from `crates/daemon/src/ledger/cache_tracker.rs::tests`, test for
 * test, so the two implementations can be compared while both exist.
 *
 * Several of these encode things that cost real money to learn — why the
 * keepalive window anchors on foreground activity rather than the previous
 * call, why a tiny tail write is not an alarm, why a summed loop row invents
 * an anomaly. The Rust comments explaining each are kept.
 */

import { describe, expect, test } from "bun:test";

import {
  CacheTracker,
  CacheTrackers,
  type Anomaly,
  type Observation,
} from "../src/ledger/cache_tracker.ts";

const MODEL = "claude-opus-4-6";

/** An observation with the fiddly fields defaulted. */
function obs(over: Partial<Observation> & Pick<Observation, "ts">): Observation {
  return {
    model: MODEL,
    thinking_enabled: true,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    call_type: "message",
    ...over,
  };
}

/** `2026-04-05T12:mm:ss` — minutes and seconds, for readable sequences. */
const at = (mm: number, ss = 0) =>
  `2026-04-05T12:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}Z`;

/** Hours into 2026-04-05, for TTL and idle-ceiling tests. */
const hour = (h: number) => `2026-04-05T${String(h).padStart(2, "0")}:00:00Z`;

describe("warm/cold transitions", () => {
  test("starts cold", () => {
    expect(new CacheTracker().state).toBe("cold");
  });

  test("a cache write warms it", () => {
    const t = new CacheTracker();
    const r = t.observe(obs({ ts: at(0), cache_write_tokens: 500 }));
    expect(r.state).toBe("warm");
    expect(r.anomaly).toBeUndefined();
  });

  test("a cache read warms it", () => {
    const t = new CacheTracker();
    expect(t.observe(obs({ ts: at(0), cache_read_tokens: 500 })).state).toBe("warm");
  });

  test("an increasing read stays warm and quiet", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 500 }));
    const r = t.observe(obs({ ts: at(1), cache_read_tokens: 500, cache_write_tokens: 50 }));
    expect(r.state).toBe("warm");
    expect(r.anomaly).toBeUndefined();
  });

  test("compaction goes cold, deliberately, with no anomaly", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: at(1), call_type: "compaction" }));
    expect(r.state).toBe("cold");
    expect(r.anomaly).toBeUndefined();
  });

  test("a model change goes cold, deliberately", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: at(1), model: "claude-sonnet-4-6", cache_read_tokens: 0 }));
    expect(r.state).toBe("cold");
    expect(r.anomaly).toBeUndefined();
  });

  test("toggling thinking goes cold, deliberately", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: at(1), thinking_enabled: false, cache_read_tokens: 0 }));
    expect(r.state).toBe("cold");
    expect(r.anomaly).toBeUndefined();
  });
});

describe("unexpected_write", () => {
  test("a read below the baseline with a real write is an anomaly", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 500 }));
    t.observe(obs({ ts: at(0, 30), cache_read_tokens: 500, cache_write_tokens: 50 }));
    const r = t.observe(obs({ ts: at(1), cache_read_tokens: 200, cache_write_tokens: 400 }));
    expect(r.anomaly).toBe<Anomaly>("unexpected_write");
    expect(r.state).toBe("cold");
  });

  test("a tiny tail write on a shorter read is not an alarm", () => {
    // An edited or regenerated turn hits a still-warm prefix and recaches its
    // tail. Costs pennies and warms the cache; alarming buries the real signal.
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 10_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 10_000 }));
    const r = t.observe(obs({ ts: at(2), cache_read_tokens: 9_000, cache_write_tokens: 40 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("a keepalive reading less than the message baseline is not an anomaly", () => {
    // It runs a different prefix, so its read is not comparable.
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 5_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 5_000 }));
    const r = t.observe(
      obs({ ts: at(2), call_type: "keepalive", cache_read_tokens: 4_000, cache_write_tokens: 100 }),
    );
    expect(r.anomaly).toBeUndefined();
  });

  test("a subagent reading less than the message baseline is not an anomaly", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 5_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 5_000 }));
    const r = t.observe(
      obs({ ts: at(2), call_type: "subagent", cache_read_tokens: 100, cache_write_tokens: 900 }),
    );
    expect(r.anomaly).toBeUndefined();
  });
});

describe("tool loops", () => {
  test("a first loop turn reading zero after a warm message is an anomaly", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 5_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 5_000 }));
    const r = t.observe(
      obs({ ts: at(2), call_type: "tool_loop", cache_read_tokens: 0, cache_write_tokens: 5_000 }),
    );
    expect(r.anomaly).toBe<Anomaly>("unexpected_write");
  });

  test("a loop whose read drops mid-loop is an anomaly", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 5_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 5_000 }));
    t.observe(obs({ ts: at(2), call_type: "tool_loop", cache_read_tokens: 5_000 }));
    const r = t.observe(
      obs({ ts: at(3), call_type: "tool_loop", cache_read_tokens: 100, cache_write_tokens: 5_000 }),
    );
    expect(r.anomaly).toBe<Anomaly>("unexpected_write");
  });

  test("a loop does not replace the message baseline", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 5_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 5_000 }));
    t.observe(obs({ ts: at(2), call_type: "tool_loop", cache_read_tokens: 6_000 }));
    expect(t.lastCacheRead).toBe(5_000);
  });

  test("a summed loop row would invent an anomaly", () => {
    // Why one ledger row per provider call is load-bearing. A summed row
    // reports a read no single call made; it becomes the baseline, and the
    // next ordinary message looks like a regression on a healthy cache.
    const seq = (t: CacheTracker, o: Array<[number, number, string]>) =>
      o.map(([read, write, ct]) =>
        t.observe(
          obs({ ts: at(0), cache_read_tokens: read, cache_write_tokens: write, call_type: ct }),
        ),
      );

    const perCall = new CacheTracker();
    seq(perCall, [
      [0, 2000, "message"],
      [2000, 200, "message"],
      [2200, 200, "tool_loop"],
      [2400, 200, "tool_loop"],
    ]);
    expect(perCall.observe(obs({ ts: at(0), cache_read_tokens: 2600, cache_write_tokens: 200 })).anomaly)
      .toBeUndefined();

    const summed = new CacheTracker();
    seq(summed, [
      [0, 2000, "message"],
      [2000 + 2200 + 2400, 600, "message"],
    ]);
    const after = summed.observe(
      obs({ ts: at(0), cache_read_tokens: 2600, cache_write_tokens: 200 }),
    );
    expect(after.anomaly).toBe<Anomaly>("unexpected_write");
    expect(after.state).toBe("cold");
  });
});

describe("keepalive", () => {
  test("TTL expiry plus a non-keepalive call is a miss", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: hour(1), cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: hour(3), cache_write_tokens: 500 }));
    expect(r.anomaly).toBe<Anomaly>("keepalive_miss");
  });

  test("a keepalive that refreshes a warm prefix is not a miss", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: hour(1), cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: hour(3), call_type: "keepalive", cache_read_tokens: 500 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("a ping that writes instead of reading is a cold keepalive", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    const r = t.observe(
      obs({ ts: at(1), call_type: "keepalive", cache_read_tokens: 0, cache_write_tokens: 5_000 }),
    );
    expect(r.anomaly).toBe<Anomaly>("cold_keepalive");
  });

  test("a cold keepalive survives interleaved model thrash", () => {
    // Detected per-observation, independent of the warm/cold machine, so other
    // models churning the state cannot mask it.
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    t.observe(obs({ ts: at(1), model: "claude-sonnet-4-6", cache_write_tokens: 900 }));
    const r = t.observe(
      obs({ ts: at(2), call_type: "keepalive", cache_read_tokens: 0, cache_write_tokens: 5_000 }),
    );
    expect(r.anomaly).toBe<Anomaly>("cold_keepalive");
  });

  test("compaction going cold is not a keepalive miss", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    t.observe(obs({ ts: at(1), call_type: "compaction" }));
    const r = t.observe(obs({ ts: at(2), cache_write_tokens: 500 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("cold from the start is not a keepalive miss", () => {
    const t = new CacheTracker();
    const r = t.observe(obs({ ts: at(0), cache_write_tokens: 500 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("past the idle ceiling, a cold start is by design", () => {
    // The keepalive deliberately stops after `cache_keepalive_max`; a cold
    // start beyond that gap is the ceiling working, not a failure.
    const t = new CacheTracker(3600, 6 * 3600);
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: "2026-04-05T20:00:00Z", cache_write_tokens: 500 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("inside the ceiling, a miss still fires", () => {
    const t = new CacheTracker(3600, 6 * 3600);
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: "2026-04-05T04:00:00Z", cache_write_tokens: 500 }));
    expect(r.anomaly).toBe<Anomaly>("keepalive_miss");
  });

  test("pings do not shrink the apparent idle gap", () => {
    // The nightly pattern observed live: the user's last message is at 00:00,
    // pings bridge the gap and deliberately stop at the 12h ceiling, and the
    // user returns at 19:00. The gap since the last *ping* is 7h — inside the
    // window if wrongly measured from there — but the ceiling anchors on real
    // activity, and 19h since the message is outside it. This cold start is
    // the keepalive stopping as designed, not a miss.
    //
    // The numbers matter: they are chosen so the two readings disagree. A
    // sequence where both land on the same answer cannot catch the bug.
    const t = new CacheTracker(3600); // default 12h ceiling
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_write_tokens: 11_000 }));
    t.observe(obs({ ts: "2026-04-05T00:55:00Z", call_type: "keepalive", cache_read_tokens: 11_000 }));
    // Last ping before the ceiling, ~12h after the message.
    t.observe(obs({ ts: "2026-04-05T11:50:00Z", call_type: "keepalive", cache_read_tokens: 11_000 }));

    const r = t.observe(obs({ ts: "2026-04-05T19:00:00Z", cache_write_tokens: 11_200 }));
    expect(r.anomaly).toBeUndefined();
  });
});

describe("reconstruction", () => {
  const now = Date.parse("2026-04-05T12:00:00Z");

  test("warm inside the TTL with a read", () => {
    const t = CacheTracker.reconstruct(at(30), MODEL, true, 500, 3600, now);
    expect(t.state).toBe("warm");
  });

  test("cold when the last call read nothing", () => {
    const t = CacheTracker.reconstruct(at(30), MODEL, true, 0, 3600, now);
    expect(t.state).toBe("cold");
  });

  test("cold when the TTL has expired", () => {
    const t = CacheTracker.reconstruct("2026-04-05T09:00:00Z", MODEL, true, 500, 3600, now);
    expect(t.state).toBe("cold");
  });
});

describe("the tracker map", () => {
  test("raising the ceiling retunes live trackers", () => {
    const trackers = new CacheTrackers();
    const t = trackers.forCharacter("aria");
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_read_tokens: 500 }));
    trackers.setMaxIdleSecs(6 * 3600);
    // 20h later is past the new ceiling, so the cold start is by design.
    expect(t.observe(obs({ ts: "2026-04-05T20:00:00Z", cache_write_tokens: 500 })).anomaly)
      .toBeUndefined();
  });

  test("a character with no tracker asks to be seeded", () => {
    const trackers = new CacheTrackers();
    expect(trackers.needsSeed("aria")).toBe(true);
    trackers.seed("aria", CacheTracker.reconstruct(at(30), MODEL, true, 500, 3600, Date.parse(at(35))));
    expect(trackers.needsSeed("aria")).toBe(false);
    expect(trackers.forCharacter("aria").state).toBe("warm");
  });
});
