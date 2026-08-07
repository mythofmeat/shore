/**
 * The activity tracker's own behaviour.
 *
 * `activity_parity.test.ts` replays message streams recorded from the Rust and
 * is the stronger check for anything a stream can reach. This file covers what
 * a recorded stream cannot: the stats cache, which is a function of elapsed
 * time rather than of the messages; the guards on `backfill`, which are about
 * what the tracker refuses to do; and exact values for the free functions,
 * where the fixture only ever pins whatever the streams happened to produce.
 *
 * Each test here mirrors one in `crates/daemon/src/autonomy/activity.rs`.
 */

import { describe, expect, test } from "bun:test";

import {
  ActivityTracker,
  anomalyZScore,
  classifyHours,
  computeTempoScore,
  median,
  recentSessions,
  SESSION_MEDIANS_WINDOW,
  STATS_CACHE_TTL_MS,
  weekdayOf,
} from "../src/autonomy/activity.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A naive local timestamp, the way the tracker carries them. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

describe("the tempo logistic", () => {
  // Centred on fifteen minutes. The published shape of the curve, not just
  // whatever the streams happened to sample.
  test.each([
    ["30 seconds", 30, 0.9, 0.02],
    ["5 minutes", 300, 0.82, 0.02],
    ["15 minutes", 900, 0.5, 0.01],
  ])("a %s median scores about %d", (_label, gap, want, tolerance) => {
    expect(Math.abs(computeTempoScore([gap]) - want)).toBeLessThan(tolerance);
  });

  test("half an hour scores badly", () => {
    expect(computeTempoScore([1800])).toBeLessThan(0.2);
  });

  test("no data at all is neutral, not slow", () => {
    expect(computeTempoScore([])).toBe(0.5);
  });
});

describe("median", () => {
  test("odd takes the middle", () => {
    expect(median([1, 3, 2])).toBe(2);
  });

  test("even splits the difference", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("empty has none", () => {
    expect(median([])).toBeUndefined();
  });

  test("the input is left alone", () => {
    // It sorts, and sorting in place would quietly reorder a caller's session
    // gaps — which are read again, in order, for the anomaly score.
    const gaps = [30, 10, 20];
    median(gaps);
    expect(gaps).toEqual([30, 10, 20]);
  });
});

describe("hour classification", () => {
  test("one heavy hour is a peak and the faint ones are troughs", () => {
    const histogram = new Array<number>(24).fill(0);
    histogram[10] = 0.5;
    histogram[14] = 0.3;
    histogram[3] = 0.01;
    histogram[4] = 0.01;
    // Average over the four non-zero hours is 0.205, so the peak line is at
    // 0.3075 and the trough line at 0.1025.
    const classes = classifyHours(histogram);
    expect(classes[10]).toBe("peak");
    expect(classes[14]).toBe("normal");
    expect(classes[3]).toBe("trough");
    expect(classes[4]).toBe("trough");
  });

  test("an hour with no events at all is a trough", () => {
    // The average is taken over non-zero hours only, but the comparison runs
    // over all 24 — so an hour nobody has ever spoken in is a trough. That is
    // what makes the heatmap read as a sleep pattern rather than a flat band.
    const histogram = new Array<number>(24).fill(0);
    histogram[10] = 0.5;
    histogram[11] = 0.5;

    const classes = classifyHours(histogram);
    expect(classes.filter((c) => c === "trough").length).toBe(22);
    expect(classes[0]).toBe("trough");
  });

  test("nothing recorded is normal everywhere, not trough everywhere", () => {
    expect(classifyHours(new Array<number>(24).fill(0)).every((c) => c === "normal")).toBe(true);
  });

  test("an hour exactly on either line is normal", () => {
    // Both comparisons are strict, and nothing else pins which way the
    // boundary falls. The numbers are chosen so the arithmetic is exact in
    // binary: two non-zero hours of 0.75 and 0.25 average to 0.5, putting the
    // peak line at exactly 0.75 and the trough line at exactly 0.25.
    const histogram = new Array<number>(24).fill(0);
    histogram[9] = 0.75;
    histogram[21] = 0.25;

    const classes = classifyHours(histogram);
    expect(classes[9], "on the peak line, not above it").toBe("normal");
    expect(classes[21], "on the trough line, not below it").toBe("normal");
  });
});

describe("the hour histogram", () => {
  test("exactly five events on a weekday is enough to prefer it", () => {
    // The check is `>=`, and a stream that happens to land on five is rare
    // enough that the fixture never did.
    const t = new ActivityTracker();
    for (let i = 0; i < 5; i += 1) t.recordMessage(at(2026, 3, 25, 10, i * 5)); // Wednesday
    for (let i = 0; i < 4; i += 1) t.recordMessage(at(2026, 3, 26, 14, i * 5)); // Thursday

    const wed = t.computeStats("Wed").hourHistogram;
    expect(wed[10], "five is enough to narrow to Wednesday").toBe(1);
    expect(wed[14]).toBe(0);

    // Four is not, so Thursday still sees everything.
    const thu = t.computeStats("Thu").hourHistogram;
    expect(thu[10]).toBeGreaterThan(0);
    expect(thu[14]).toBeGreaterThan(0);
  });
});

describe("the anomaly score", () => {
  test("wants three gaps before it will speak", () => {
    expect(anomalyZScore([100, 200])).toBeUndefined();
    expect(anomalyZScore([])).toBeUndefined();
    expect(anomalyZScore([100, 200, 300])).toBeDefined();
  });

  test("a perfectly regular rhythm scores zero rather than dividing by it", () => {
    // Without the guard this is 0/0 — a NaN that would ride out through
    // `engagementScore` into the activity tool as `null`.
    expect(anomalyZScore([7140, 7140, 7140])).toBe(0);
  });

  test("a long silence after a rhythm scores high", () => {
    const z = anomalyZScore([7140, 7140, 7140, 64_740]);
    expect(z).toBeDefined();
    expect(z ?? 0).toBeGreaterThan(1.5);
  });
});

describe("the stats cache", () => {
  // Absent from the parity fixture: it is a function of elapsed time, and the
  // fixture records only what the messages determine.

  function tracker(): ActivityTracker {
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 25, 10, 0, 0));
    t.recordMessage(at(2026, 3, 25, 10, 1, 0));
    return t;
  }

  test("is reused until the TTL is reached exactly", () => {
    const t = tracker();
    const first = t.stats(0, "Wed").computedAt;

    expect(t.stats(STATS_CACHE_TTL_MS - 1, "Wed").computedAt, "a hair inside the TTL").toBe(first);
    expect(t.stats(STATS_CACHE_TTL_MS, "Wed").computedAt, "at the TTL exactly").toBe(
      STATS_CACHE_TTL_MS,
    );
  });

  test("a new message drops it, however fresh it was", () => {
    const t = tracker();
    t.stats(0, "Wed");
    t.recordMessage(at(2026, 3, 25, 10, 5, 0));

    expect(t.stats(1, "Wed").computedAt, "recomputed one millisecond later").toBe(1);
  });

  test("is keyed on time alone, so a new weekday inside the TTL gets the old answer", () => {
    // The cache is keyed on nothing but time, so a second caller asking about
    // a different weekday inside the TTL gets the first one's answer. Pinned
    // because it is a real edge and the fixture cannot see it: in the daemon
    // only one weekday is ever current, so it never bites.
    const t = new ActivityTracker();
    for (let i = 0; i < 6; i += 1) t.recordMessage(at(2026, 3, 25, 10, i * 5, 0)); // Wednesday
    for (let i = 0; i < 6; i += 1) t.recordMessage(at(2026, 3, 26, 14, i * 5, 0)); // Thursday

    const wed = t.stats(0, "Wed");
    expect(wed.hourHistogram[10]).toBe(1);
    expect(t.stats(1, "Thu").hourHistogram[10], "served from the cache").toBe(1);
    expect(t.recomputeStats(1, "Thu").hourHistogram[14], "asked again properly").toBe(1);
  });

  test("recompute ignores the TTL", () => {
    const t = tracker();
    t.stats(0, "Wed");
    expect(t.recomputeStats(5, "Wed").computedAt).toBe(5);
  });
});

describe("backfill", () => {
  test("refuses a tracker that already has messages", () => {
    // Seeding a live tracker from history would double every message it had
    // already recorded.
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 25, 10, 0, 0));
    t.backfill([at(2026, 3, 20, 10), at(2026, 3, 21, 14)]);
    expect(t.messageCount).toBe(1);
  });

  test("an empty history is a no-op", () => {
    const t = new ActivityTracker();
    t.backfill([]);
    expect(t.messageCount).toBe(0);
    // And still lets a real backfill land afterwards.
    t.backfill([at(2026, 3, 20, 10)]);
    expect(t.messageCount).toBe(1);
  });

  test("sorts what arrives out of order", () => {
    const t = new ActivityTracker();
    t.backfill([at(2026, 3, 22, 9), at(2026, 3, 20, 10), at(2026, 3, 21, 14)]);
    // Three consecutive days, each its own session, in the right order: the
    // span is three days and all three are active.
    expect(t.messageCount).toBe(3);
    expect(t.computeStats("Fri").consistency).toBe(1);
  });

  test("recording continues after it", () => {
    const t = new ActivityTracker();
    t.backfill([at(2026, 3, 20, 10), at(2026, 3, 21, 14)]);
    t.recordMessage(at(2026, 3, 22, 9));
    expect(t.messageCount).toBe(3);
  });
});

describe("session detection", () => {
  test("a gap of exactly half an hour starts a new session", () => {
    // The comparison is `>=`. A stream drawn at random never lands on the
    // boundary, so nothing else pins which side it falls on.
    const start = at(2026, 3, 25, 10, 0, 0);
    const exact = new ActivityTracker();
    exact.recordMessage(start);
    exact.recordMessage(start + 30 * MINUTE);
    expect(exact.computeStats("Wed").sessionCount).toBe(2);

    const under = new ActivityTracker();
    under.recordMessage(start);
    under.recordMessage(start + 30 * MINUTE - 1000);
    expect(under.computeStats("Wed").sessionCount).toBe(1);
  });

  test("the count and the rate see every session", () => {
    const t = new ActivityTracker();
    for (let day = 0; day < 35; day += 1) {
      t.recordMessage(at(2026, 3, 1, 10) + day * 24 * HOUR);
      t.recordMessage(at(2026, 3, 1, 10) + day * 24 * HOUR + MINUTE);
    }
    const stats = t.computeStats("Fri");
    expect(stats.sessionCount).toBe(35);
    // Before #15 the numerator was windowed to 30 and this read 0.857.
    expect(stats.sessionsPerDay).toBeCloseTo(1, 12);
  });

  test("the rate stops falling as the habit continues", () => {
    // The defect's signature: the more consistent the user, the lower the
    // number. Same habit at three lengths of record, one answer.
    for (const days of [20, 60, 200]) {
      const t = new ActivityTracker();
      for (let day = 0; day < days; day += 1) {
        t.recordMessage(at(2026, 3, 1, 10) + day * 24 * HOUR);
        t.recordMessage(at(2026, 3, 1, 10) + day * 24 * HOUR + MINUTE);
      }
      expect(t.computeStats("Fri").sessionsPerDay, `${days} days`).toBeCloseTo(1, 12);
    }
  });
});

describe("the recent-rhythm window", () => {
  test("it is the newest sessions, and a no-op below its size", () => {
    const many = Array.from({ length: 35 }, (_, i) => i);
    expect(recentSessions(many)).toHaveLength(SESSION_MEDIANS_WINDOW);
    expect(recentSessions(many)[0]).toBe(5);
    expect(recentSessions(many).at(-1)).toBe(34);

    expect(recentSessions([1, 2, 3])).toEqual([1, 2, 3]);
    expect(recentSessions([])).toEqual([]);
  });

  test("the median gap ignores rhythm the character has left behind", () => {
    // Forty two-hourly sessions, then thirty-one daily ones. The count sees
    // all of it; the median must report the day it now lives by.
    const t = new ActivityTracker();
    const base = at(2026, 3, 1, 0);
    for (let i = 0; i < 40; i += 1) {
      t.recordMessage(base + i * 2 * HOUR);
      t.recordMessage(base + i * 2 * HOUR + MINUTE);
    }
    const later = base + 30 * 24 * HOUR;
    for (let day = 0; day < 31; day += 1) {
      t.recordMessage(later + day * 24 * HOUR);
      t.recordMessage(later + day * 24 * HOUR + MINUTE);
    }

    const stats = t.computeStats("Fri");
    expect(stats.sessionCount).toBe(71);
    expect(stats.medianSessionGap).toBe(86_340);
  });
});

describe("consistency", () => {
  test("nothing is zero and one message is one", () => {
    expect(new ActivityTracker().computeStats("Wed").consistency).toBe(0);

    const one = new ActivityTracker();
    one.recordMessage(at(2026, 3, 25, 10));
    expect(one.computeStats("Wed").consistency).toBe(1);
  });

  test("counts the days a character stayed quiet", () => {
    // Two active days at the ends of a five-day span. The span is inclusive of
    // both endpoints, so this is 2/5 and not 2/4.
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 21, 10));
    t.recordMessage(at(2026, 3, 25, 10));
    expect(t.computeStats("Wed").consistency).toBeCloseTo(0.4, 12);
  });
});

describe("the tempo window", () => {
  test("reads only the last ten gaps", () => {
    // The window trims from the front: a conversation that started slow and
    // turned fast scores as fast.
    const t = new ActivityTracker();
    let cursor = at(2026, 3, 25, 8, 0, 0);
    t.recordMessage(cursor);
    for (let i = 0; i < 12; i += 1) {
      cursor += 600_000;
      t.recordMessage(cursor);
    }
    for (let i = 0; i < 10; i += 1) {
      cursor += 10_000;
      t.recordMessage(cursor);
    }

    const stats = t.computeStats("Wed");
    expect(stats.sessionCount, "the whole walk is one session").toBe(1);
    // Ten-second gaps only; the twelve ten-minute ones are dropped, not averaged.
    expect(stats.tempoScore).toBeCloseTo(computeTempoScore([10]), 12);
  });
});

describe("naive timestamps", () => {
  test("the weekday comes from the reading, not the machine's zone", () => {
    expect(weekdayOf(at(2026, 3, 2))).toBe("Mon");
    expect(weekdayOf(at(2026, 3, 8))).toBe("Sun");
    expect(weekdayOf(at(2026, 3, 25))).toBe("Wed");
  });

  test("a day that lost an hour is still a day long", () => {
    // The point of carrying naive local time as UTC. In a zone that springs
    // forward on 2026-03-29, a local-zone Date would make this 23 hours and
    // put the two messages in one session; as a calendar reading it is 24.
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 29, 1, 0, 0));
    t.recordMessage(at(2026, 3, 30, 1, 0, 0));

    const stats = t.computeStats("Sun");
    expect(stats.sessionCount).toBe(2);
    expect(stats.medianSessionGap, "exactly one day, whatever the zone did").toBe(86_400);
  });
});
