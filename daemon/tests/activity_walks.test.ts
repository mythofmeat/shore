import { describe, expect, test } from "bun:test";

import {
  ActivityTracker,
  type HourClassification,
  type Weekday,
} from "../src/autonomy/activity.ts";

interface FixtureStats {
  engagement_score: number;
  consistency: number;
  tempo_score: number;
  session_count: number;
  sessions_per_day: number;
  hour_histogram: number[];
  hour_classifications: HourClassification[];
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
  thresholds: {
    session_gap_secs: number;
    sufficient_data_msgs: number;
    sufficient_data_days: number;
    sufficient_heatmap_msgs: number;
    sufficient_heatmap_days: number;
    weekday_heatmap_min: number;
    peak_hour_threshold: number;
    trough_hour_threshold: number;
    session_medians_window: number;
    session_tempo_window: number;
    anomaly_z_score: number;
    stats_cache_ttl_secs: number;
  };
  cases: Case[];
}

const fixture = (await Bun.file(
  new URL("./autonomy_fixtures/activity_walks.json", import.meta.url),
).json()) as Fixture;

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

    const beyond = all.filter((s) => s.session_count > fixture.thresholds.session_medians_window);
    expect(beyond.length, "the session window must actually be reached").toBeGreaterThan(0);

    expect(all.filter((s) => s.has_sufficient_heatmap).length).toBeGreaterThan(0);
    expect(all.filter((s) => !s.has_sufficient_heatmap).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.has_sufficient_data).length).toBeGreaterThan(0);
    expect(all.filter((s) => !s.has_sufficient_data).length).toBeGreaterThan(0);

    expect(all.filter((s) => s.anomaly_z_score === null).length).toBeGreaterThan(0);
    expect(all.filter((s) => s.anomaly_z_score === 0).length).toBeGreaterThan(0);
    expect(all.filter((s) => (s.anomaly_z_score ?? 0) > 1).length).toBeGreaterThan(0);

    const classes = all.flatMap((s) => s.hour_classifications);
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

describe("the constants match the Rust", () => {
  test("thresholds", async () => {
    const mod = await import("../src/autonomy/activity.ts");
    const t = fixture.thresholds;
    expect(mod.SESSION_GAP_SECS).toBe(t.session_gap_secs);
    expect(mod.SUFFICIENT_DATA_MSGS).toBe(t.sufficient_data_msgs);
    expect(mod.SUFFICIENT_DATA_DAYS).toBe(t.sufficient_data_days);
    expect(mod.SUFFICIENT_HEATMAP_MSGS).toBe(t.sufficient_heatmap_msgs);
    expect(mod.SUFFICIENT_HEATMAP_DAYS).toBe(t.sufficient_heatmap_days);
    expect(mod.WEEKDAY_HEATMAP_MIN).toBe(t.weekday_heatmap_min);
    expect(mod.PEAK_HOUR_THRESHOLD).toBe(t.peak_hour_threshold);
    expect(mod.TROUGH_HOUR_THRESHOLD).toBe(t.trough_hour_threshold);
    expect(mod.SESSION_MEDIANS_WINDOW).toBe(t.session_medians_window);
    expect(mod.SESSION_TEMPO_WINDOW).toBe(t.session_tempo_window);
    expect(mod.ANOMALY_Z_SCORE).toBe(t.anomaly_z_score);
    expect(mod.STATS_CACHE_TTL_MS).toBe(t.stats_cache_ttl_secs * 1000);
  });
});

describe("recorded streams replay identically", () => {
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
        expect(got.hourClassifications, `${where} classifications`).toEqual(
          want.hour_classifications,
        );
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
