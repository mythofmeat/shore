import { describe, expect, test } from "bun:test";

import { CacheTracker, type Observation } from "../src/cache/tracker.ts";

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function call(seconds: number, overrides: Partial<Observation> = {}): Observation {
  return { ts: at(seconds), provider: "anthropic", model: "opus", thinking_enabled: false, cache_read_tokens: 0, cache_write_tokens: 0, call_type: "message", ...overrides };
}

function seen(tracker: CacheTracker, observation: Observation): string {
  const { state, anomaly } = tracker.observe(observation);
  return anomaly === undefined ? state : `${state} ${anomaly}`;
}

const rewrite = { cache_read_tokens: 0, cache_write_tokens: 500 };

describe("a character's cache", () => {
  test("is cold until a call reads or writes it", () => {
    expect(seen(new CacheTracker(), call(0))).toBe("cold");
    expect(seen(new CacheTracker(), call(0, { cache_read_tokens: 1 }))).toBe("warm");
    expect(seen(new CacheTracker(), call(0, { cache_write_tokens: 1 }))).toBe("warm");
  });

  test("expires a second after its time to live, not sooner", () => {
    const kept = new CacheTracker(3600);
    seen(kept, call(0, { cache_read_tokens: 1000 }));
    expect(seen(kept, call(3600, rewrite)), "still warm, so writing it again is unexpected").toBe("cold unexpected_write");
    const expired = new CacheTracker(3600);
    seen(expired, call(0, { cache_read_tokens: 1000 }));
    expect(seen(expired, call(3601, rewrite))).toBe("warm");
  });

  test("can't expire across a call with no readable time", () => {
    const untimed = new CacheTracker(3600);
    seen(untimed, call(0, { cache_read_tokens: 1000, ts: "not a time" }));
    expect(seen(untimed, call(7200, rewrite)), "the last call has no time").toBe("cold unexpected_write");
    const unreadable = new CacheTracker(3600);
    seen(unreadable, call(0, { cache_read_tokens: 1000 }));
    expect(seen(unreadable, call(7200, { ...rewrite, ts: "not a time" })), "this call has no time").toBe("cold unexpected_write");
  });

  test("starts cold on another model, with thinking switched, or with other tools", () => {
    const changes: [string, Partial<Observation>, Partial<Observation>][] = [
      ["model", {}, { model: "sonnet" }],
      ["provider", {}, { provider: "openrouter" }],
      ["thinking", {}, { thinking_enabled: true }],
      ["tools", { tool_surface: "a" }, { tool_surface: "b" }],
    ];
    for (const [name, first, second] of changes) {
      const rewritten = new CacheTracker();
      seen(rewritten, call(0, { ...first, cache_read_tokens: 1000 }));
      expect(seen(rewritten, call(60, { ...second, ...rewrite })), name).toBe("warm");
      const untouched = new CacheTracker();
      seen(untouched, call(0, { ...first, cache_read_tokens: 1000 }));
      expect(seen(untouched, call(60, second)), `${name}, then a call that neither reads nor writes it`).toBe("cold");
    }
    for (const [name, first, second] of [["no tools named before", {}, { tool_surface: "b" }], ["no tools named now", { tool_surface: "a" }, {}]] as const) {
      const tracker = new CacheTracker();
      seen(tracker, call(0, { ...first, cache_read_tokens: 1000 }));
      expect(seen(tracker, call(60, { ...second, ...rewrite })), name).toBe("cold unexpected_write");
    }
  });

  test("compares a turn only with the last turn's read, so a wake or keepalive in between doesn't move it", () => {
    const tracker = new CacheTracker();
    seen(tracker, call(0, { cache_read_tokens: 1000 }));
    expect(seen(tracker, call(60, { call_type: "wake", cache_read_tokens: 200 }))).toBe("warm");
    expect(seen(tracker, call(120, { call_type: "keepalive", cache_read_tokens: 200 }))).toBe("warm");
    expect(seen(tracker, call(180, { cache_read_tokens: 500, cache_write_tokens: 400 }))).toBe("cold unexpected_write");
  });

  test("forgets the last turn's read whenever it starts cold, even when a wake warms it again", () => {
    const starts: [string, Partial<Observation>, number][] = [
      ["another model", { model: "sonnet" }, 60],
      ["thinking switched", { thinking_enabled: true }, 60],
      ["other tools", { tool_surface: "b" }, 60],
      ["expiry", {}, 3601],
    ];
    for (const [name, change, after] of starts) {
      const tracker = new CacheTracker(3600);
      seen(tracker, call(0, { tool_surface: "a", cache_read_tokens: 1000 }));
      expect(seen(tracker, call(after, { ...change, call_type: "wake", cache_write_tokens: 300 })), name).toBe("warm");
      expect(seen(tracker, call(after + 60, { ...change, ...rewrite })), name).toBe("warm");
    }
  });
});

describe("a compaction", () => {
  test("leaves the cache cold whatever it read, and forgets the last turn's read", () => {
    const tracker = new CacheTracker();
    seen(tracker, call(0, { cache_read_tokens: 1000 }));
    expect(seen(tracker, call(60, { call_type: "compaction", cache_read_tokens: 900, cache_write_tokens: 900 }))).toBe("cold");
    expect(seen(tracker, call(120, { call_type: "wake", cache_write_tokens: 300 }))).toBe("warm");
    expect(seen(tracker, call(180, rewrite))).toBe("warm");
  });

  test("names the tools the next calls are compared with", () => {
    const tracker = new CacheTracker();
    seen(tracker, call(0, { tool_surface: "a", cache_read_tokens: 1000 }));
    seen(tracker, call(60, { call_type: "compaction", tool_surface: "b" }));
    seen(tracker, call(120, { cache_read_tokens: 1000 }));
    expect(seen(tracker, call(180, { tool_surface: "b", ...rewrite })), "the same tools as the compaction").toBe("cold unexpected_write");
  });

  test("ends a run of missed keepalives", () => {
    const tracker = new CacheTracker();
    seen(tracker, call(0, { call_type: "keepalive" }));
    seen(tracker, call(60, { call_type: "compaction" }));
    expect(seen(tracker, call(120, { call_type: "keepalive" }))).toBe("cold cold_keepalive");
  });
});

describe("a keepalive", () => {
  const keepalive = (seconds: number, overrides: Partial<Observation> = {}) => call(seconds, { call_type: "keepalive", ...overrides });

  test("that reads nothing is a cold keepalive, and a second one in a row on the same model a double miss", () => {
    const tracker = new CacheTracker();
    expect(seen(tracker, keepalive(0))).toBe("cold cold_keepalive");
    expect(seen(tracker, keepalive(60))).toBe("cold keepalive_double_miss");
    expect(seen(tracker, keepalive(120, { model: "sonnet" })), "on another model it is a first miss").toBe("cold cold_keepalive");
  });

  test("that reads is fine unless it writes a thousand tokens or more again", () => {
    const tracker = new CacheTracker();
    expect(seen(tracker, keepalive(0, { cache_read_tokens: 500, cache_write_tokens: 999 }))).toBe("warm");
    expect(seen(tracker, keepalive(60, { cache_read_tokens: 500, cache_write_tokens: 1000 }))).toBe("warm keepalive_rewrote");
    expect(seen(tracker, keepalive(120, { cache_read_tokens: 1 }))).toBe("warm");
  });

  test("miss stays missed until a turn reads the cache, and a wake's read doesn't count", () => {
    const after = (between: Partial<Observation>) => {
      const tracker = new CacheTracker();
      seen(tracker, keepalive(0));
      seen(tracker, call(60, between));
      return seen(tracker, keepalive(120));
    };
    expect(after({ cache_read_tokens: 1 })).toBe("warm cold_keepalive");
    expect(after({ call_type: "tool_loop", cache_read_tokens: 1 })).toBe("warm cold_keepalive");
    expect(after({ cache_write_tokens: 1 })).toBe("warm keepalive_double_miss");
    expect(after({ call_type: "wake", cache_read_tokens: 1 })).toBe("warm keepalive_double_miss");
    expect(after({ call_type: "wake_tool_loop", cache_read_tokens: 1 })).toBe("warm keepalive_double_miss");
    expect(after({ model: "sonnet", cache_read_tokens: 1 }), "a read on another model").toBe("cold keepalive_double_miss");
    expect(after({ call_type: "keepalive", cache_read_tokens: 1 }), "a keepalive that read").toBe("warm cold_keepalive");
  });
});

describe("an expired cache", () => {
  const warm = (window?: number, overrides: Partial<Observation> = {}) => {
    const tracker = new CacheTracker(3600);
    seen(tracker, call(0, { cache_read_tokens: 1000, ...(window === undefined ? {} : { keepalive_window_secs: window }), ...overrides }));
    return tracker;
  };

  test("is a missed keepalive when the user was active within the keepalive window", () => {
    expect(seen(warm(7200), call(3601, rewrite))).toBe("warm keepalive_miss");
    expect(seen(warm(3601), call(3601, rewrite)), "at the window's edge").toBe("warm keepalive_miss");
    expect(seen(warm(3600), call(3601, rewrite)), "past the window").toBe("warm");
    expect(seen(warm(), call(3601, rewrite)), "no keepalives for this model").toBe("warm");
    const justActive = warm();
    justActive.noteActivity(at(3601));
    expect(seen(justActive, call(3601, rewrite)), "no keepalives for this model, however recent the activity").toBe("warm");
    const shortest = warm(1);
    shortest.noteActivity(at(3601));
    expect(seen(shortest, call(3601, rewrite)), "a window of one second").toBe("warm keepalive_miss");
    expect(seen(warm(7200, { model: "sonnet" }), call(3601, rewrite)), "the window was another model's").toBe("warm");
  });

  test("keeps the model's window from the call that named it", () => {
    const tracker = warm(7200);
    seen(tracker, call(60, { cache_read_tokens: 1000 }));
    expect(seen(tracker, call(3661, rewrite))).toBe("warm keepalive_miss");
  });

  test("is not a missed keepalive when the cache was already cold", () => {
    const tracker = new CacheTracker(3600);
    seen(tracker, call(0, { keepalive_window_secs: 7200 }));
    expect(seen(tracker, call(3601, rewrite))).toBe("warm");
  });

  test("is not a missed keepalive for the keepalive itself", () => {
    expect(seen(warm(7200), call(3601, { call_type: "keepalive" }))).toBe("cold cold_keepalive");
  });

  test("counts only turns and their tool loops as the user being active", () => {
    const since = (first: Partial<Observation>) => {
      const tracker = new CacheTracker(3600);
      tracker.noteActivity(at(-7200));
      seen(tracker, call(0, { cache_read_tokens: 1000, keepalive_window_secs: 3700, ...first }));
      return seen(tracker, call(3601, { call_type: "wake", ...rewrite }));
    };
    expect(since({})).toBe("warm keepalive_miss");
    expect(since({ call_type: "tool_loop" })).toBe("warm keepalive_miss");
    expect(since({ call_type: "wake" }), "the user was last active two hours before the wake").toBe("warm");
  });

  test("doesn't count a turn with no readable time as the user being active", () => {
    const tracker = new CacheTracker(3600);
    tracker.noteActivity(at(-7200));
    seen(tracker, call(0, { call_type: "wake", cache_read_tokens: 1000, keepalive_window_secs: 3700 }));
    seen(tracker, call(50, { cache_read_tokens: 1000, ts: "not a time" }));
    seen(tracker, call(100, { call_type: "wake", cache_read_tokens: 1000 }));
    expect(seen(tracker, call(3701, { call_type: "wake", ...rewrite }))).toBe("warm");
  });

  test("with no activity known counts as missed", () => {
    const tracker = new CacheTracker(3600);
    seen(tracker, call(0, { call_type: "wake", cache_read_tokens: 1000, keepalive_window_secs: 60 }));
    expect(seen(tracker, call(3601, { call_type: "wake", ...rewrite }))).toBe("warm keepalive_miss");
  });

  test("restarts a tool loop's baseline once it was missed", () => {
    const tracker = new CacheTracker(3600);
    seen(tracker, call(0, { call_type: "tool_loop", cache_read_tokens: 1000, keepalive_window_secs: 7200 }));
    expect(seen(tracker, call(3601, { call_type: "tool_loop", cache_write_tokens: 2000 }))).toBe("warm keepalive_miss");
    expect(seen(tracker, call(3602, { call_type: "tool_loop", cache_read_tokens: 500, cache_write_tokens: 500 }))).toBe("warm");
  });
});

describe("a tool loop", () => {
  test("is compared with its own last call", () => {
    const tracker = new CacheTracker();
    seen(tracker, call(0, { call_type: "tool_loop", cache_read_tokens: 1000 }));
    expect(seen(tracker, call(1, { call_type: "tool_loop", cache_read_tokens: 500, cache_write_tokens: 500 }))).toBe("cold unexpected_write");
  });
});
