/**
 * Activity tracker — what a character has learned about when its user shows up.
 *
 * It holds one timestamp per user message and derives a handful of statistics
 * from them: how consistently the user appears, how fast they reply, which
 * hours of the day they favour, and whether the current silence is unusual. The
 * `activity` tool reads these so a character can time itself, and `shore status`
 * renders the histogram as a heatmap.
 *
 * Ported from `crates/daemon/src/autonomy/activity.rs` and pinned against it by
 * `tests/activity_parity.test.ts`, which replays message streams recorded from
 * the Rust.
 *
 * ## Time
 *
 * Timestamps are **naive local wall-clock, carried as epoch milliseconds in
 * UTC**. The Rust used `chrono::NaiveDateTime`: a calendar reading with no zone
 * attached, so subtracting two of them counts the clock's own ticks and ignores
 * any DST shift between. Representing the same thing as a UTC instant and using
 * only the `getUTC*` accessors reproduces that exactly, whereas a local-zone
 * `Date` would fold DST back in and make an autumn night an hour longer than the
 * character lived it.
 *
 * `stats()` takes both a `now` for its cache TTL and the weekday to favour.
 * They are separate because they are separate clocks: the TTL wants elapsed real
 * time, and the weekday is a calendar fact. The Rust read each from a different
 * global — `Instant::now()` and `Local::now()` — which is what kept the whole
 * computation off-limits to a fixture.
 *
 * ## What was dropped
 *
 * The Rust stored a monotonic `Instant` alongside each wall clock, documented as
 * being "for gap computation within a process lifetime". Nothing ever read it:
 * every gap in the file is computed from `wall_clock`. It is not carried here.
 */

/** Idle gap, in seconds, marking a session boundary. */
export const SESSION_GAP_SECS = 1800;

/** Minimum messages for adaptive timing. */
export const SUFFICIENT_DATA_MSGS = 5;
/** Minimum distinct days for adaptive timing. */
export const SUFFICIENT_DATA_DAYS = 2;

/** Minimum messages for hour-weighted (heatmap) timing. */
export const SUFFICIENT_HEATMAP_MSGS = 20;
/** Minimum distinct days for hour-weighted timing. */
export const SUFFICIENT_HEATMAP_DAYS = 7;

/** Below this many events on a weekday, fall back to the global histogram. */
export const WEEKDAY_HEATMAP_MIN = 5;

/** An hour is a peak when its density exceeds the average by this factor. */
export const PEAK_HOUR_THRESHOLD = 1.5;
/** An hour is a trough when its density falls below the average by this factor. */
export const TROUGH_HOUR_THRESHOLD = 0.5;

/** How long computed stats stay fresh. */
export const STATS_CACHE_TTL_MS = 60_000;

/** How many recent sessions the median and anomaly score look at. */
export const SESSION_MEDIANS_WINDOW = 30;
/** How many recent reply gaps the tempo score looks at. */
export const SESSION_TEMPO_WINDOW = 10;

/** Z-score at which a silence counts as anomalous. */
export const ANOMALY_Z_SCORE = 1.5;

const DAY_MS = 86_400_000;

/**
 * Whole seconds between two timestamps, in either order.
 *
 * Truncated, not rounded: the Rust took `num_seconds()` off a duration, which
 * drops the sub-second part, and real timestamps carry one. Absolute, because
 * `recordMessage` does not sort — see {@link ActivityTracker.detectSessions}.
 */
function gapSecs(a: number, b: number): number {
  return Math.trunc(Math.abs(b - a) / 1000);
}

/** Weekday names, as the fixture and the Rust's `chrono::Weekday` spell them. */
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

/** Indexed by `Date.prototype.getUTCDay()`, which counts from Sunday. */
const WEEKDAY_BY_UTC_DAY: readonly Weekday[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

/** The weekday a naive-local timestamp falls on. */
export function weekdayOf(at: number): Weekday {
  const day = new Date(at).getUTCDay();
  return WEEKDAY_BY_UTC_DAY[day] ?? "Mon";
}

/** How busy an hour of the day is, relative to the hours the user does use. */
export type HourClassification = "peak" | "trough" | "normal";

/** One recorded message, with the parts of it the statistics need. */
interface Recorded {
  /** Naive local wall clock, as epoch ms in UTC. */
  readonly at: number;
  readonly weekday: Weekday;
  /** Hour of the day, 0–23. */
  readonly hour: number;
  /** Days since the epoch — the calendar date, as something comparable. */
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

/** Everything derived from the recorded messages. */
export interface ActivityStats {
  /** `0.6 × consistency + 0.4 × tempo`. */
  readonly engagementScore: number;
  /** Active days over the span between first and last message. */
  readonly consistency: number;
  /** Logistic over the median reply gap: 1 at instant, 0 at glacial. */
  readonly tempoScore: number;
  /** Sessions detected, capped at {@link SESSION_MEDIANS_WINDOW}. */
  readonly sessionCount: number;
  /** The capped session count over every distinct day on record — see
   *  {@link ActivityTracker.computeStats}. */
  readonly sessionsPerDay: number;
  /** 24 densities summing to 1, or all zero when there is nothing to divide. */
  readonly hourHistogram: readonly number[];
  readonly hourClassifications: readonly HourClassification[];
  readonly hasSufficientData: boolean;
  readonly hasSufficientHeatmap: boolean;
  /** Median gap between sessions, in seconds. `undefined` below two sessions. */
  readonly medianSessionGap: number | undefined;
  /** How unusual the most recent inter-session gap is. `undefined` below three. */
  readonly anomalyZScore: number | undefined;
  /** When this was computed, on the caller's `now` clock. */
  readonly computedAt: number;
}

export class ActivityTracker {
  #timestamps: Recorded[] = [];
  #cached: ActivityStats | undefined;

  /** Record a message. */
  recordMessage(at: number): void {
    this.#timestamps.push(record(at));
    this.#cached = undefined;
  }

  /**
   * Seed from existing chat history.
   *
   * Sorts, because history arrives in whatever order it was read in. A no-op
   * once anything has been recorded: backfilling a live tracker would double
   * every message it had already seen.
   */
  backfill(ats: readonly number[]): void {
    if (this.#timestamps.length > 0 || ats.length === 0) return;
    this.#timestamps = ats.map(record).sort((a, b) => a.at - b.at);
    this.#cached = undefined;
  }

  get messageCount(): number {
    return this.#timestamps.length;
  }

  /** Stats, recomputed when the cache is absent or has aged past the TTL. */
  stats(now: number, today: Weekday): ActivityStats {
    const cached = this.#cached;
    if (cached !== undefined && now - cached.computedAt < STATS_CACHE_TTL_MS) {
      return cached;
    }
    return this.recomputeStats(now, today);
  }

  /** Stats, unconditionally recomputed. */
  recomputeStats(now: number, today: Weekday): ActivityStats {
    const stats = { ...this.computeStats(today), computedAt: now };
    this.#cached = stats;
    return stats;
  }

  /**
   * The whole computation, as a pure function of what has been recorded.
   *
   * `sessionsPerDay` divides a capped session count by an uncapped day count,
   * so a character with a long history reports a rate lower than it lived, and
   * the number keeps sinking as history grows. That is what the Rust did and
   * what the activity tool has always reported; it is preserved deliberately
   * rather than quietly corrected during a port.
   */
  computeStats(today: Weekday): Omit<ActivityStats, "computedAt"> {
    const distinctDays = this.#distinctDays();
    const msgCount = this.#timestamps.length;

    const sessions = this.#detectSessions();
    const sessionCount = sessions.length;

    const consistency = this.#consistency();
    const sessionGaps = this.#sessionGaps(sessions);
    const tempoScore = computeTempoScore(this.#tempoGaps(sessions));
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

  /** Active days over the span they are spread across, both ends inclusive. */
  #consistency(): number {
    // One message has no span to be consistent over, and reads as fully
    // consistent rather than not at all; none at all reads as neither.
    if (this.#timestamps.length < 2) return this.#timestamps.length === 0 ? 0 : 1;

    const first = this.#timestamps[0];
    const last = this.#timestamps[this.#timestamps.length - 1];
    if (first === undefined || last === undefined) return 1;

    // First and last as recorded, not earliest and latest: unsorted input gives
    // a negative span, which falls through to the same answer a single message
    // gets rather than to a nonsense ratio.
    const spanDays = last.day - first.day + 1;
    if (spanDays <= 0) return 1;
    return Math.min(Math.max(this.#distinctDays() / spanDays, 0), 1);
  }

  /**
   * Split the messages into sessions at every gap of {@link SESSION_GAP_SECS}
   * or more, keeping the most recent {@link SESSION_MEDIANS_WINDOW}.
   *
   * Gaps are absolute. Messages arrive in order in practice, and `backfill`
   * guarantees it, but `recordMessage` does not — so a clock that steps
   * backwards splits a session rather than collapsing one.
   */
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

    return sessions.slice(-SESSION_MEDIANS_WINDOW);
  }

  /** Seconds between the end of each session and the start of the next. */
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

  /**
   * Seconds between consecutive messages inside sessions, most recent
   * {@link SESSION_TEMPO_WINDOW} only.
   *
   * The window trims from the front, so a conversation that started slow and
   * turned fast scores as fast.
   */
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

  /**
   * Which hours the user shows up in, as densities summing to 1.
   *
   * Prefers `today`'s own history once there is enough of it, so a character
   * asking on a Sunday is told about Sundays. Below {@link WEEKDAY_HEATMAP_MIN}
   * events it falls back to every day at once, which is wrong in a useful
   * direction: a blurred picture beats one drawn from three points.
   */
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

/**
 * How fast the replies come, as a logistic over the median gap.
 *
 * Centred on fifteen minutes: faster than that scores above a half, slower
 * below. Neutral when there is nothing to go on.
 */
export function computeTempoScore(gaps: readonly number[]): number {
  const med = median(gaps);
  if (med === undefined) return 0.5;
  return 1 / (1 + Math.exp((med - 900) / 400));
}

/**
 * Label each hour against the average of the hours that see any use at all.
 *
 * Averaging over only the non-empty hours but comparing across all 24 means an
 * hour nobody has ever spoken in is a trough, not a normal — which is what
 * makes the heatmap read as a sleep pattern rather than a flat band.
 */
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

/**
 * How far the latest gap sits from the usual one, in standard deviations.
 *
 * `undefined` below three gaps, because two points are not a distribution. A
 * perfectly regular rhythm has no spread to measure against and scores zero
 * rather than dividing by it.
 */
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

/** Median of a list, or `undefined` when it is empty. */
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
