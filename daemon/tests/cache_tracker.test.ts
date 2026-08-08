/**
 * Ported from `crates/daemon/src/ledger/cache_tracker.rs::tests`, test for
 * test, while both implementations existed. The Rust is gone; these are now
 * this implementation's own tests, and they are kept case for case because the
 * cases are what was expensive to learn.
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

/**
 * The fourth cold trigger (#33).
 *
 * Tool definitions sit ahead of `system` and `messages` in the cached prefix,
 * so changing them invalidates the whole cache. The tracker modelled three
 * transitions and had no column describing the tools, so the resulting full
 * write was labelled `unexpected_write` — correct as billing, wrong as
 * diagnosis, and firing on a routine event. `unexpected_write` is the alert
 * this repo relies on; a tracker that cries wolf on a flapping MCP server is
 * worse than one that says nothing.
 */
describe("a tool-surface change", () => {
  const SURFACE_A = "aaaaaaaaaaaaaaaa";
  const SURFACE_B = "bbbbbbbbbbbbbbbb";

  test("goes cold, deliberately, with no anomaly", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500, tool_surface: SURFACE_A }));
    const r = t.observe(obs({ ts: at(1), cache_read_tokens: 0, tool_surface: SURFACE_B }));
    expect(r.state).toBe("cold");
    expect(r.anomaly).toBeUndefined();
  });

  test("with the write that follows it, the row is warm again — as a model change is", () => {
    // The convention `model` and `thinking_enabled` already set: the transition
    // drops the state to cold, and a row that then *writes* has re-established
    // the prefix by the time it ends, so it is recorded warm. Asserted beside
    // the model change so the two cannot drift apart.
    const surface = new CacheTracker();
    surface.observe(obs({ ts: at(0), cache_read_tokens: 500, tool_surface: SURFACE_A }));
    const bySurface = surface.observe(
      obs({ ts: at(1), cache_write_tokens: 5000, tool_surface: SURFACE_B }),
    );

    const model = new CacheTracker();
    model.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    const byModel = model.observe(
      obs({ ts: at(1), model: "claude-sonnet-4-6", cache_write_tokens: 5000 }),
    );

    expect(bySurface).toEqual(byModel);
    expect(bySurface.anomaly).toBeUndefined();
  });

  test("is what the live run recorded as unexpected_write", () => {
    // The rows from #33, verbatim: six ordinary turns, then `enabled_tools`
    // gains one entry and the whole 5,034-token prompt is rewritten. Row 7 was
    // `cold / unexpected_write`; it should be `cold` and nothing else.
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 4283, tool_surface: SURFACE_A }));
    t.observe(
      obs({ ts: at(1), cache_read_tokens: 4283, cache_write_tokens: 12, tool_surface: SURFACE_A }),
    );
    const afterReload = t.observe(
      obs({ ts: at(2), cache_read_tokens: 0, cache_write_tokens: 5034, tool_surface: SURFACE_B }),
    );
    // The whole point: no anomaly. Nothing was anomalous — one tool definition
    // moved the head of the prefix and the prompt was rewritten, exactly as a
    // model change would.
    expect(afterReload.anomaly).toBeUndefined();

    // And the turn after it reads the new prefix and is warm again — the
    // tool_loop row that followed in the recorded run.
    const next = t.observe(
      obs({
        ts: at(3),
        call_type: "tool_loop",
        cache_read_tokens: 5034,
        cache_write_tokens: 50,
        tool_surface: SURFACE_B,
      }),
    );
    expect(next.state).toBe("warm");
    expect(next.anomaly).toBeUndefined();
  });

  test("an unchanged surface is not a transition", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 500, tool_surface: SURFACE_A }));
    const r = t.observe(
      obs({ ts: at(1), cache_read_tokens: 500, cache_write_tokens: 50, tool_surface: SURFACE_A }),
    );
    expect(r.state).toBe("warm");
    expect(r.anomaly).toBeUndefined();
  });

  // The migration's safety property: `tool_surface` is null on every row
  // written before it, and a null must mean *unknown* rather than "no tools".
  // Otherwise the first row after the migration reports a change against a
  // null, and every pre-migration ledger produces one spurious cold row.
  test("unknown on either side changes nothing", () => {
    const fromUnknown = new CacheTracker();
    fromUnknown.observe(obs({ ts: at(0), cache_read_tokens: 500 }));
    expect(
      fromUnknown.observe(obs({ ts: at(1), cache_read_tokens: 500, tool_surface: SURFACE_A })).state,
    ).toBe("warm");

    const toUnknown = new CacheTracker();
    toUnknown.observe(obs({ ts: at(0), cache_read_tokens: 500, tool_surface: SURFACE_A }));
    expect(toUnknown.observe(obs({ ts: at(1), cache_read_tokens: 500 })).state).toBe("warm");
  });

  // A call that does not know its surface must not *erase* the one the tracker
  // has, or the next real comparison is silently against nothing — a change
  // straight after a keepalive would go unexplained again.
  test("an unknown call does not erase a known surface", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_read_tokens: 500, tool_surface: SURFACE_A }));
    t.observe(obs({ ts: at(1), call_type: "keepalive", cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: at(2), cache_read_tokens: 0, tool_surface: SURFACE_B }));
    expect(r.state).toBe("cold");
    expect(r.anomaly).toBeUndefined();
  });

  test("a cold tracker is unaffected by a surface change", () => {
    const t = new CacheTracker();
    const r = t.observe(obs({ ts: at(0), cache_write_tokens: 500, tool_surface: SURFACE_A }));
    expect(r.state).toBe("warm");
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
