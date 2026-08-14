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

export interface ActivityStats {
  readonly engagementScore: number;
  readonly consistency: number;
  readonly tempoScore: number;
  readonly sessionCount: number;
  readonly sessionsPerDay: number;
  readonly hourHistogram: readonly number[];
  readonly hourClassifications: readonly HourClassification[];
  readonly hasSufficientData: boolean;
  readonly hasSufficientHeatmap: boolean;
  readonly medianSessionGap: number | undefined;
  readonly anomalyZScore: number | undefined;
  readonly computedAt: number;
}

export class ActivityTracker {
  #timestamps: Recorded[] = [];
  #cached: ActivityStats | undefined;

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

  stats(now: number, today: Weekday): ActivityStats {
    const cached = this.#cached;
    if (cached !== undefined && now - cached.computedAt < STATS_CACHE_TTL_MS) {
      return cached;
    }
    return this.recomputeStats(now, today);
  }

  recomputeStats(now: number, today: Weekday): ActivityStats {
    const stats = { ...this.computeStats(today), computedAt: now };
    this.#cached = stats;
    return stats;
  }

  computeStats(today: Weekday): Omit<ActivityStats, "computedAt"> {
    const distinctDays = this.#distinctDays();
    const msgCount = this.#timestamps.length;

    const sessions = this.#detectSessions();
    const sessionCount = sessions.length;

    const recent = recentSessions(sessions);
    const consistency = this.#consistency();
    const sessionGaps = this.#sessionGaps(recent);
    const tempoScore = computeTempoScore(this.#tempoGaps(recent));
    const hourHistogram = this.#hourHistogram(today);

    return {
      engagementScore: 0.6 * consistency + 0.4 * tempoScore,
      consistency,
      tempoScore,
      sessionCount,
      sessionsPerDay: distinctDays > 0 ? sessionCount / distinctDays : 0,
      hourHistogram,
      hourClassifications: classifyHours(hourHistogram),
      hasSufficientData:
        msgCount >= SUFFICIENT_DATA_MSGS && distinctDays >= SUFFICIENT_DATA_DAYS,
      hasSufficientHeatmap:
        msgCount >= SUFFICIENT_HEATMAP_MSGS && distinctDays >= SUFFICIENT_HEATMAP_DAYS,
      medianSessionGap: median(sessionGaps),
      anomalyZScore: anomalyZScore(sessionGaps),
    };
  }

  #distinctDays(): number {
    return new Set(this.#timestamps.map((ts) => ts.day)).size;
  }

  #consistency(): number {
    if (this.#timestamps.length < 2) return this.#timestamps.length === 0 ? 0 : 1;

    const first = this.#timestamps[0];
    const last = this.#timestamps[this.#timestamps.length - 1];
    if (first === undefined || last === undefined) return 1;

    const spanDays = last.day - first.day + 1;
    if (spanDays <= 0) return 1;
    return Math.min(Math.max(this.#distinctDays() / spanDays, 0), 1);
  }

  #detectSessions(): Recorded[][] {
    if (this.#timestamps.length === 0) return [];

    const sessions: Recorded[][] = [];
    let current: Recorded[] = [];

    for (const [i, ts] of this.#timestamps.entries()) {
      const prev = this.#timestamps[i - 1];
      if (prev !== undefined && gapSecs(prev.at, ts.at) >= SESSION_GAP_SECS) {
        sessions.push(current);
        current = [];
      }
      current.push(ts);
    }
    sessions.push(current);

    return sessions;
  }

  #sessionGaps(sessions: readonly Recorded[][]): number[] {
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

  #tempoGaps(sessions: readonly Recorded[][]): number[] {
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

  #hourHistogram(today: Weekday): number[] {
    const onToday = this.#timestamps.filter((ts) => ts.weekday === today);
    const source = onToday.length >= WEEKDAY_HEATMAP_MIN ? onToday : this.#timestamps;

    const histogram = new Array<number>(24).fill(0);
    for (const ts of source) {
      histogram[ts.hour] = (histogram[ts.hour] ?? 0) + 1;
    }

    const total = histogram.reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const [i, count] of histogram.entries()) histogram[i] = count / total;
    }
    return histogram;
  }
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

  if (avg < Number.EPSILON) return new Array<HourClassification>(24).fill("normal");

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
