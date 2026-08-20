import { hostZone, naiveInZone } from "../ledger/zoned.ts";

export const SESSION_GAP_SECS = 1800;

export const SUFFICIENT_DATA_MSGS = 5;
export const SUFFICIENT_DATA_DAYS = 2;

export const SUFFICIENT_HEATMAP_MSGS = 20;
export const SUFFICIENT_HEATMAP_DAYS = 7;

export const WEEKDAY_HEATMAP_MIN = 5;

export const PEAK_HOUR_THRESHOLD = 1.5;
export const TROUGH_HOUR_THRESHOLD = 0.5;

export const STATS_CACHE_TTL_MS = 60_000;

export const SESSION_MEDIANS_WINDOW = 30;
export const SESSION_TEMPO_WINDOW = 10;

export const ANOMALY_Z_SCORE = 1.5;

const DAY_MS = 86_400_000;

function gapSecs(a: number, b: number): number {
  return Math.trunc(Math.abs(b - a) / 1000);
}

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

const WEEKDAY_BY_UTC_DAY: readonly Weekday[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

export function weekdayOf(at: number): Weekday {
  const day = new Date(at).getUTCDay();
  return WEEKDAY_BY_UTC_DAY[day] ?? "Mon";
}

export function localWallClock(instant: number, zone: string = hostZone()): number {
  const wholeSecond = Math.floor(instant / 1000) * 1000;
  return instant + (naiveInZone(instant, zone) - wholeSecond);
}

export type HourClassification = "peak" | "trough" | "normal";

interface Recorded {
  readonly at: number;
  readonly weekday: Weekday;
  readonly hour: number;
  readonly day: number;
}

function record(at: number): Recorded {
  const d = new Date(at);
  return {
    at,
    weekday: WEEKDAY_BY_UTC_DAY[d.getUTCDay()] ?? "Mon",
    hour: d.getUTCHours(),
    day: Math.floor(at / DAY_MS),
  };
}

export type WeekdayCounts = Readonly<Record<Weekday, number>>;

export interface ActivityWindow {
  readonly localNow: number;
  readonly days: number;
}

export interface ActivityStats {
  readonly engagementScore: number;
  readonly consistency: number;
  readonly tempoScore: number;
  readonly sessionCount: number;
  readonly sessionsPerDay: number;
  readonly hourHistogram: readonly number[];
  readonly hourClassifications: readonly HourClassification[];
  readonly pooledHourHistogram: readonly number[];
  readonly pooledHourClassifications: readonly HourClassification[];
  readonly weekdayCounts: WeekdayCounts;
  readonly windowMessageCount: number;
  readonly hasSufficientData: boolean;
  readonly hasSufficientHeatmap: boolean;
  readonly medianSessionGap: number | undefined;
  readonly anomalyZScore: number | undefined;
  readonly computedAt: number;
}

export class ActivityTracker {
  #timestamps: Recorded[] = [];
  #cached: { stats: ActivityStats; days: number | undefined } | undefined;

  recordMessage(at: number): void {
    this.#timestamps.push(record(at));
    this.#cached = undefined;
  }

  backfill(ats: readonly number[]): void {
    if (this.#timestamps.length > 0 || ats.length === 0) return;
    this.#timestamps = ats.map(record).sort((a, b) => a.at - b.at);
    this.#cached = undefined;
  }

  get messageCount(): number {
    return this.#timestamps.length;
  }

  stats(now: number, today: Weekday, window?: ActivityWindow): ActivityStats {
    const cached = this.#cached;
    if (
      cached !== undefined &&
      cached.days === window?.days &&
      now - cached.stats.computedAt < STATS_CACHE_TTL_MS
    ) {
      return cached.stats;
    }
    return this.recomputeStats(now, today, window);
  }

  recomputeStats(now: number, today: Weekday, window?: ActivityWindow): ActivityStats {
    const stats = { ...this.computeStats(today, window), computedAt: now };
    this.#cached = { stats, days: window?.days };
    return stats;
  }

  computeStats(today: Weekday, window?: ActivityWindow): Omit<ActivityStats, "computedAt"> {
    const source = this.#within(window);
    const distinctDays = countDistinctDays(source);
    const msgCount = source.length;

    const sessions = detectSessions(source);
    const sessionCount = sessions.length;

    const recent = recentSessions(sessions);
    const consistency = consistencyOf(source, distinctDays);
    const sessionGaps = gapsBetweenSessions(recent);
    const tempoScore = computeTempoScore(tempoGaps(recent));
    const hourHistogram = weekdayHourHistogram(source, today);
    const pooledHourHistogram = hourHistogramOf(source);

    return {
      engagementScore: 0.6 * consistency + 0.4 * tempoScore,
      consistency,
      tempoScore,
      sessionCount,
      sessionsPerDay: distinctDays > 0 ? sessionCount / distinctDays : 0,
      hourHistogram,
      hourClassifications: classifyHours(hourHistogram),
      pooledHourHistogram,
      pooledHourClassifications: classifyHours(pooledHourHistogram),
      weekdayCounts: countByWeekday(source),
      windowMessageCount: msgCount,
      hasSufficientData:
        msgCount >= SUFFICIENT_DATA_MSGS && distinctDays >= SUFFICIENT_DATA_DAYS,
      hasSufficientHeatmap:
        msgCount >= SUFFICIENT_HEATMAP_MSGS && distinctDays >= SUFFICIENT_HEATMAP_DAYS,
      medianSessionGap: median(sessionGaps),
      anomalyZScore: anomalyZScore(sessionGaps),
    };
  }

  #within(window: ActivityWindow | undefined): readonly Recorded[] {
    if (window === undefined || window.days <= 0) return this.#timestamps;
    const cutoff = window.localNow - window.days * DAY_MS;
    return this.#timestamps.filter((ts) => ts.at >= cutoff);
  }
}

function countDistinctDays(source: readonly Recorded[]): number {
  return new Set(source.map((ts) => ts.day)).size;
}

function consistencyOf(source: readonly Recorded[], distinctDays: number): number {
  if (source.length < 2) return source.length === 0 ? 0 : 1;

  const first = source[0];
  const last = source[source.length - 1];
  if (first === undefined || last === undefined) return 1;

  const spanDays = last.day - first.day + 1;
  if (spanDays <= 0) return 1;
  return Math.min(Math.max(distinctDays / spanDays, 0), 1);
}

function detectSessions(source: readonly Recorded[]): Recorded[][] {
  if (source.length === 0) return [];

  const sessions: Recorded[][] = [];
  let current: Recorded[] = [];

  for (const [i, ts] of source.entries()) {
    const prev = source[i - 1];
    if (prev !== undefined && gapSecs(prev.at, ts.at) >= SESSION_GAP_SECS) {
      sessions.push(current);
      current = [];
    }
    current.push(ts);
  }
  sessions.push(current);

  return sessions;
}

function gapsBetweenSessions(sessions: readonly Recorded[][]): number[] {
  const gaps: number[] = [];
  for (const [i, next] of sessions.entries()) {
    if (i === 0) continue;
    const prev = sessions[i - 1];
    const from = prev?.[prev.length - 1];
    const to = next[0];
    if (from === undefined || to === undefined) continue;
    gaps.push(gapSecs(from.at, to.at));
  }
  return gaps;
}

function tempoGaps(sessions: readonly Recorded[][]): number[] {
  const gaps: number[] = [];
  for (const session of sessions) {
    for (const [i, ts] of session.entries()) {
      const prev = session[i - 1];
      if (prev === undefined) continue;
      gaps.push(gapSecs(prev.at, ts.at));
    }
  }
  return gaps.slice(-SESSION_TEMPO_WINDOW);
}

function hourHistogramOf(source: readonly Recorded[]): number[] {
  const histogram = Array.from({ length: 24 }, () => 0);
  for (const ts of source) {
    histogram[ts.hour] = (histogram[ts.hour] ?? 0) + 1;
  }

  const total = histogram.reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const [i, count] of histogram.entries()) histogram[i] = count / total;
  }
  return histogram;
}

function weekdayHourHistogram(source: readonly Recorded[], today: Weekday): number[] {
  const onToday = source.filter((ts) => ts.weekday === today);
  return hourHistogramOf(onToday.length >= WEEKDAY_HEATMAP_MIN ? onToday : source);
}

function countByWeekday(source: readonly Recorded[]): WeekdayCounts {
  const counts: Record<Weekday, number> = {
    Mon: 0,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 0,
  };
  for (const ts of source) counts[ts.weekday] += 1;
  return counts;
}

export function recentSessions<T>(sessions: readonly T[]): readonly T[] {
  return sessions.slice(-SESSION_MEDIANS_WINDOW);
}

export function computeTempoScore(gaps: readonly number[]): number {
  const med = median(gaps);
  if (med === undefined) return 0.5;
  return 1 / (1 + Math.exp((med - 900) / 400));
}

export function classifyHours(histogram: readonly number[]): HourClassification[] {
  const nonZero = histogram.filter((d) => d > 0);
  const avg =
    nonZero.length === 0 ? 0 : nonZero.reduce((a, b) => a + b, 0) / nonZero.length;

  if (avg < Number.EPSILON) return Array.from({ length: 24 }, (): HourClassification => "normal");

  return Array.from({ length: 24 }, (_unused, hour): HourClassification => {
    const density = histogram[hour] ?? 0;
    if (density > avg * PEAK_HOUR_THRESHOLD) return "peak";
    if (density < avg * TROUGH_HOUR_THRESHOLD) return "trough";
    return "normal";
  });
}

export function anomalyZScore(gaps: readonly number[]): number | undefined {
  if (gaps.length < 3) return undefined;

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((acc, g) => acc + (g - mean) ** 2, 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev < Number.EPSILON) return 0;

  const last = gaps[gaps.length - 1];
  if (last === undefined) return undefined;
  return (last - mean) / stdDev;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid];

  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return undefined;
  return (lo + hi) / 2;
}
