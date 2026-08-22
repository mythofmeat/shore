import { describe, expect, test } from "bun:test";
import { expandShared } from "./support/shared_subtrees.ts";
import { SESSION_MEDIANS_WINDOW } from "../src/autonomy/activity.ts";

import {
  ActivityTracker,
  classifyHours,
  type Weekday,
} from "../src/autonomy/activity.ts";

interface FixtureStats {
  engagement_score: number;
  consistency: number;
  tempo_score: number;
  session_count: number;
  sessions_per_day: number;
  hour_histogram: number[];
  has_sufficient_data: boolean;
  has_sufficient_heatmap: boolean;
  median_session_gap: number | null;
  anomaly_z_score: number | null;
}

interface Case {
  name: string;
  via: "record" | "backfill";
  timestamps: string[];
  message_count: number;
  by_weekday: Record<Weekday, FixtureStats>;
}

interface Fixture {
  cases: Case[];
}

const fixture = expandShared<Fixture>(
  await Bun.file(new URL("./autonomy_captures/activity_walks.json", import.meta.url)).json(),
);

const WEEKDAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function naive(iso: string): number {
  const at = Date.parse(`${iso}Z`);
  if (Number.isNaN(at)) throw new Error(`unparseable fixture timestamp: ${iso}`);
  return at;
}

function trackerFor(c: Case): ActivityTracker {
  const tracker = new ActivityTracker();
  const times = c.timestamps.map(naive);
  if (c.via === "backfill") {
    tracker.backfill(times);
  } else {
    for (const at of times) tracker.recordMessage(at);
  }
  return tracker;
}

describe("the fixture is real", () => {
  test("a silently unreadable fixture must not pass", () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
    for (const c of fixture.cases) {
      expect(Object.keys(c.by_weekday).sort()).toEqual([...WEEKDAYS].sort());
    }
  });

  test("the streams exercise the paths worth pinning", () => {
    const all = fixture.cases.flatMap((c) => Object.values(c.by_weekday));

    const beyond = all.filter((s) => s.session_count > SESSION_MEDIANS_WINDOW);
    expect(beyond.length, "the session window must actually be reached").toBeGreaterThan(0);

    expect(all.filter((s) => s.has_sufficient_heatmap).length).toBeGreaterThan(0);
    expect(all.filter((s) => !s.has_sufficient_heatmap).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.has_sufficient_data).length).toBeGreaterThan(0);
    expect(all.filter((s) => !s.has_sufficient_data).length).toBeGreaterThan(0);

    expect(all.filter((s) => s.anomaly_z_score === null).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.anomaly_z_score === 0).length).toBeGreaterThan(0);
    expect(all.filter((s) => (s.anomaly_z_score ?? 0) > 1).length).toBeGreaterThan(0);

    const classes = all.flatMap((s) => classifyHours(s.hour_histogram));
    for (const label of ["peak", "trough", "normal"]) {
      expect(classes.filter((c) => c === label).length, `${label} hours`).toBeGreaterThan(0);
    }

    expect(fixture.cases.filter((c) => c.via === "backfill").length).toBeGreaterThan(0);
    expect(fixture.cases.filter((c) => c.via === "record").length).toBeGreaterThan(0);
    const weekdaySensitive = fixture.cases.filter(
      (c) => new Set(Object.values(c.by_weekday).map((s) => JSON.stringify(s.hour_histogram))).size > 1,
    );
    expect(weekdaySensitive.length, "some case must prefer today's own history").toBeGreaterThan(0);
  });
});

describe("the thresholds activity stats are read against", () => {
  test("are all positive, so no window is empty by construction", async () => {
    const mod = await import("../src/autonomy/activity.ts");
    for (const [name, value] of [
      ["SESSION_GAP_SECS", mod.SESSION_GAP_SECS],
      ["SUFFICIENT_DATA_MSGS", mod.SUFFICIENT_DATA_MSGS],
      ["SUFFICIENT_DATA_DAYS", mod.SUFFICIENT_DATA_DAYS],
      ["SUFFICIENT_HEATMAP_MSGS", mod.SUFFICIENT_HEATMAP_MSGS],
      ["SUFFICIENT_HEATMAP_DAYS", mod.SUFFICIENT_HEATMAP_DAYS],
      ["WEEKDAY_HEATMAP_MIN", mod.WEEKDAY_HEATMAP_MIN],
      ["SESSION_MEDIANS_WINDOW", mod.SESSION_MEDIANS_WINDOW],
      ["SESSION_TEMPO_WINDOW", mod.SESSION_TEMPO_WINDOW],
      ["STATS_CACHE_TTL_MS", mod.STATS_CACHE_TTL_MS],
    ] as const) {
      expect(value, name).toBeGreaterThan(0);
    }
  });

  test("a peak is above a trough, or the two would name the same hours", async () => {
    const mod = await import("../src/autonomy/activity.ts");
    expect(mod.PEAK_HOUR_THRESHOLD).toBeGreaterThan(mod.TROUGH_HOUR_THRESHOLD);
  });

  test("the heatmap needs at least as much history as the summary does", async () => {
    const mod = await import("../src/autonomy/activity.ts");
    expect(mod.SUFFICIENT_HEATMAP_MSGS).toBeGreaterThanOrEqual(mod.SUFFICIENT_DATA_MSGS);
    expect(mod.SUFFICIENT_HEATMAP_DAYS).toBeGreaterThanOrEqual(mod.SUFFICIENT_DATA_DAYS);
  });

  test("an anomaly needs a real excursion, not a rounding error", async () => {
    const mod = await import("../src/autonomy/activity.ts");
    expect(mod.ANOMALY_Z_SCORE).toBeGreaterThan(1);
  });

  test("a session gap is minutes, not seconds or hours", async () => {
    const mod = await import("../src/autonomy/activity.ts");
    expect(mod.SESSION_GAP_SECS).toBeGreaterThanOrEqual(60);
    expect(mod.SESSION_GAP_SECS).toBeLessThanOrEqual(6 * 3600);
  });
});

describe("computing stats over a recorded stream of messages", () => {
  for (const c of fixture.cases) {
    test(`${c.name} (${c.via})`, () => {
      const tracker = trackerFor(c);
      expect(tracker.messageCount, "message count").toBe(c.message_count);

      for (const weekday of WEEKDAYS) {
        const want = c.by_weekday[weekday];
        const got = tracker.computeStats(weekday);
        const where = `${c.name} / ${weekday}`;

        expect(got.consistency, `${where} consistency`).toBe(want.consistency);
        expect(got.sessionCount, `${where} session count`).toBe(want.session_count);
        expect(got.sessionsPerDay, `${where} sessions per day`).toBe(want.sessions_per_day);
        expect(got.hourHistogram, `${where} histogram`).toEqual(want.hour_histogram);
        expect(
          got.hourClassifications,
          `${where}: an hour is a peak or a trough by how it stands against the day's own average`,
        ).toEqual(classifyHours(got.hourHistogram));
        expect(got.hasSufficientData, `${where} sufficient data`).toBe(want.has_sufficient_data);
        expect(got.hasSufficientHeatmap, `${where} sufficient heatmap`).toBe(
          want.has_sufficient_heatmap,
        );
        expect(got.medianSessionGap ?? null, `${where} median session gap`).toBe(
          want.median_session_gap,
        );

        expect(got.anomalyZScore ?? null, `${where} anomaly z`).toBe(want.anomaly_z_score);

        expect(got.tempoScore, `${where} tempo`).toBeCloseTo(want.tempo_score, 12);
        expect(got.engagementScore, `${where} engagement`).toBeCloseTo(want.engagement_score, 12);
      }
    });
  }
});
