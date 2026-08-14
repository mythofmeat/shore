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
    const classes = classifyHours(histogram);
    expect(classes[10]).toBe("peak");
    expect(classes[14]).toBe("normal");
    expect(classes[3]).toBe("trough");
    expect(classes[4]).toBe("trough");
  });

  test("an hour with no events at all is a trough", () => {
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
    const t = new ActivityTracker();
    for (let i = 0; i < 5; i += 1) t.recordMessage(at(2026, 3, 25, 10, i * 5));
    for (let i = 0; i < 4; i += 1) t.recordMessage(at(2026, 3, 26, 14, i * 5));

    const wed = t.computeStats("Wed").hourHistogram;
    expect(wed[10], "five is enough to narrow to Wednesday").toBe(1);
    expect(wed[14]).toBe(0);

    const thu = t.computeStats("Thu").hourHistogram;
    expect(thu[10]).toBeGreaterThan(0);
    expect(thu[14]).toBeGreaterThan(0);
  });

  test("the pooled one never narrows to a weekday", () => {
    const t = new ActivityTracker();
    for (let i = 0; i < 5; i += 1) t.recordMessage(at(2026, 3, 25, 10, i * 5));
    for (let i = 0; i < 4; i += 1) t.recordMessage(at(2026, 3, 26, 14, i * 5));

    const pooled = t.computeStats("Wed").pooledHourHistogram;
    expect(pooled[10]).toBeCloseTo(5 / 9, 12);
    expect(pooled[14]).toBeCloseTo(4 / 9, 12);
    expect(t.computeStats("Thu").pooledHourHistogram).toEqual(pooled);
  });

  test("weekday counts are of the window, not of all time", () => {
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 4, 10));
    t.recordMessage(at(2026, 4, 6, 10));
    t.recordMessage(at(2026, 4, 7, 10));

    const localNow = at(2026, 4, 8, 10);
    const all = t.computeStats("Wed");
    expect(all.weekdayCounts.Wed).toBe(1);
    expect(all.windowMessageCount).toBe(3);

    const week = t.computeStats("Wed", { localNow, days: 7 });
    expect(week.weekdayCounts.Wed, "the March Wednesday is outside the window").toBe(0);
    expect(week.weekdayCounts.Mon).toBe(1);
    expect(week.windowMessageCount).toBe(2);
  });
});

describe("the window", () => {
  const localNow = at(2026, 4, 8, 12);
  const tracker = (): ActivityTracker => {
    const t = new ActivityTracker();
    for (let day = 1; day <= 8; day += 1) t.recordMessage(at(2026, 4, day, 10));
    return t;
  };

  test("keeps a message exactly on the boundary", () => {
    const stats = tracker().computeStats("Wed", { localNow, days: 7 });
    expect(stats.windowMessageCount).toBe(7);
  });

  test("a window nobody asked for is all of history", () => {
    expect(tracker().computeStats("Wed").windowMessageCount).toBe(8);
  });

  test("changing the window busts the cache the TTL would have served", () => {
    const t = tracker();
    const week = t.stats(0, "Wed", { localNow, days: 7 });
    const day = t.stats(1, "Wed", { localNow, days: 1 });
    expect(week.windowMessageCount).toBe(7);
    expect(day.windowMessageCount, "not the cached seven-day answer").toBe(1);
    expect(t.stats(2, "Wed", { localNow, days: 1 }).computedAt, "same window, cached").toBe(1);
  });
});

describe("the anomaly score", () => {
  test("wants three gaps before it will speak", () => {
    expect(anomalyZScore([100, 200])).toBeUndefined();
    expect(anomalyZScore([])).toBeUndefined();
    expect(anomalyZScore([100, 200, 300])).toBeDefined();
  });

  test("a perfectly regular rhythm scores zero rather than dividing by it", () => {
    expect(anomalyZScore([7140, 7140, 7140])).toBe(0);
  });

  test("a long silence after a rhythm scores high", () => {
    const z = anomalyZScore([7140, 7140, 7140, 64_740]);
    expect(z).toBeDefined();
    expect(z ?? 0).toBeGreaterThan(1.5);
  });
});

describe("the stats cache", () => {
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
    const t = new ActivityTracker();
    for (let i = 0; i < 6; i += 1) t.recordMessage(at(2026, 3, 25, 10, i * 5, 0));
    for (let i = 0; i < 6; i += 1) t.recordMessage(at(2026, 3, 26, 14, i * 5, 0));

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
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 25, 10, 0, 0));
    t.backfill([at(2026, 3, 20, 10), at(2026, 3, 21, 14)]);
    expect(t.messageCount).toBe(1);
  });

  test("an empty history is a no-op", () => {
    const t = new ActivityTracker();
    t.backfill([]);
    expect(t.messageCount).toBe(0);
    t.backfill([at(2026, 3, 20, 10)]);
    expect(t.messageCount).toBe(1);
  });

  test("sorts what arrives out of order", () => {
    const t = new ActivityTracker();
    t.backfill([at(2026, 3, 22, 9), at(2026, 3, 20, 10), at(2026, 3, 21, 14)]);
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
    expect(stats.sessionsPerDay).toBeCloseTo(1, 12);
  });

  test("the rate stops falling as the habit continues", () => {
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
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 21, 10));
    t.recordMessage(at(2026, 3, 25, 10));
    expect(t.computeStats("Wed").consistency).toBeCloseTo(0.4, 12);
  });
});

describe("the tempo window", () => {
  test("reads only the last ten gaps", () => {
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
    const t = new ActivityTracker();
    t.recordMessage(at(2026, 3, 29, 1, 0, 0));
    t.recordMessage(at(2026, 3, 30, 1, 0, 0));

    const stats = t.computeStats("Sun");
    expect(stats.sessionCount).toBe(2);
    expect(stats.medianSessionGap, "exactly one day, whatever the zone did").toBe(86_400);
  });
});
