import { describe, expect, test } from "bun:test";

import {
  CacheTracker,
  CacheTrackers,
  type Anomaly,
  type Observation,
} from "../src/cache/tracker.ts";

const MODEL = "claude-opus-4-6";

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

const at = (mm: number, ss = 0) =>
  `2026-04-05T12:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}Z`;

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
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 4283, tool_surface: SURFACE_A }));
    t.observe(
      obs({ ts: at(1), cache_read_tokens: 4283, cache_write_tokens: 12, tool_surface: SURFACE_A }),
    );
    const afterReload = t.observe(
      obs({ ts: at(2), cache_read_tokens: 0, cache_write_tokens: 5034, tool_surface: SURFACE_B }),
    );
    expect(afterReload.anomaly).toBeUndefined();

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
    const t = new CacheTracker();
    t.observe(obs({ ts: at(0), cache_write_tokens: 10_000 }));
    t.observe(obs({ ts: at(1), cache_read_tokens: 10_000 }));
    const r = t.observe(obs({ ts: at(2), cache_read_tokens: 9_000, cache_write_tokens: 40 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("a keepalive reading less than the message baseline is not an anomaly", () => {
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
  test("zero-write misses still halt, and heartbeat hits do not clear chat misses", () => {
    const t = new CacheTracker();
    expect(t.observe(obs({ ts: at(0), call_type: "keepalive", cache_read_tokens: 0, cache_write_tokens: 0 })).anomaly)
      .toBe("cold_keepalive");
    t.observe(obs({ ts: at(1), call_type: "heartbeat", cache_read_tokens: 500 }));
    expect(t.observe(obs({ ts: at(2), call_type: "keepalive", cache_read_tokens: 0, cache_write_tokens: 0 })).anomaly)
      .toBe("keepalive_double_miss");
  });

  test("TTL expiry plus a non-keepalive call is a miss", () => {
    const t = new CacheTracker();
    t.observe(obs({ ts: hour(1), cache_read_tokens: 500, keepalive_window_secs: 12 * 3600 }));
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

  test("past the keepalive window, a cold start is by design", () => {
    const t = new CacheTracker(3600);
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_read_tokens: 500, keepalive_window_secs: 6 * 3600 }));
    const r = t.observe(obs({ ts: "2026-04-05T20:00:00Z", cache_write_tokens: 500 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("with no known keepalive window, a cold start is not a miss", () => {
    const t = new CacheTracker(3600);
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_read_tokens: 500 }));
    const r = t.observe(obs({ ts: "2026-04-05T04:00:00Z", cache_write_tokens: 500 }));
    expect(r.anomaly).toBeUndefined();
  });

  test("inside the keepalive window, a miss still fires", () => {
    const t = new CacheTracker(3600);
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_read_tokens: 500, keepalive_window_secs: 6 * 3600 }));
    const r = t.observe(obs({ ts: "2026-04-05T04:00:00Z", cache_write_tokens: 500 }));
    expect(r.anomaly).toBe<Anomaly>("keepalive_miss");
  });

  test("pings do not shrink the apparent idle gap", () => {
    const t = new CacheTracker(3600);
    t.observe(obs({ ts: "2026-04-05T00:00:00Z", cache_write_tokens: 11_000 }));
    t.observe(obs({ ts: "2026-04-05T00:55:00Z", call_type: "keepalive", cache_read_tokens: 11_000 }));
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
  test("a character with no tracker asks to be seeded", () => {
    const trackers = new CacheTrackers();
    expect(trackers.needsSeed("aria")).toBe(true);
    trackers.seed("aria", CacheTracker.reconstruct(at(30), MODEL, true, 500, 3600, Date.parse(at(35))));
    expect(trackers.needsSeed("aria")).toBe(false);
    expect(trackers.forCharacter("aria").state).toBe("warm");
  });
});
