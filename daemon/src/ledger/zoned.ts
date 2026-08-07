/**
 * Wall-clock ↔ instant conversion in a named timezone.
 *
 * This exists because budget windows are anchored to a wall-clock hour and must
 * stay there across a DST transition. A weekly budget that resets Wednesday
 * 06:00 opens at 06:00 EST and closes at 06:00 EDT; every day-pace boundary
 * inside that week has to sit at 06:00 *local*. Stepping in instant space
 * instead would hold every boundary at the same UTC time, which is 07:00 local
 * after the transition — an hour off the budget's own reset hour.
 *
 * Rust gets this from chrono (`NaiveDateTime` plus `Local.from_local_datetime`).
 * There is no equivalent here: `Temporal` is not in Bun 1.3, and `Date` is an
 * instant with no wall-clock type beside it. So a naive wall-clock time is
 * represented as **epoch milliseconds interpreted as if UTC** — the standard
 * encoding, and the one that makes naive arithmetic plain addition, exactly as
 * `NaiveDateTime::checked_add_signed` is.
 *
 * The two directions are not symmetric, and that asymmetry is the whole
 * subject:
 *
 *   - instant → naive is total. Every instant has one wall-clock reading.
 *   - naive → instant is not. A wall-clock time in the spring-forward gap
 *     names no instant, and one in the autumn overlap names two.
 *
 * {@link resolveInZone} reproduces chrono's `LocalResult` handling for both:
 * ambiguous picks the earlier instant, and a gap retries an hour later before
 * falling back to reading the wall-clock as UTC.
 */

/** Epoch millis reinterpreted as a wall-clock reading. Not an instant. */
export type Naive = number;

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** `Intl.DateTimeFormat` is expensive to construct; one per zone is plenty. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The host's zone, which is what Rust's `chrono::Local` resolves to. */
export function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A config `timezone` ("utc" / "local") as an IANA zone name. Anything that is
 * not exactly "utc" selects the local path, matching the Rust's `match`.
 */
export function zoneFor(configTimezone: string, localZone?: string): string {
  return configTimezone === "utc" ? "UTC" : (localZone ?? hostZone());
}

/** Wall-clock reading of `instant` in `timeZone`. */
export function naiveInZone(instant: number, timeZone: string): Naive {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p === undefined ? 0 : Number(p.value);
  };
  const bc = parts.some((p) => p.type === "era" && p.value.startsWith("B"));
  const year = bc ? 1 - get("year") : get("year");
  // `Date.UTC` maps years 0-99 into the 20th century; `setUTCFullYear` does not.
  const d = new Date(0);
  d.setUTCFullYear(year, get("month") - 1, get("day"));
  d.setUTCHours(get("hour"), get("minute"), get("second"), 0);
  return d.getTime();
}

/** `wall-clock − instant` at a given instant, i.e. the zone's UTC offset there. */
function offsetAt(instant: number, timeZone: string): number {
  return naiveInZone(instant, timeZone) - instant;
}

/**
 * Every instant whose wall-clock reading in `timeZone` is exactly `naive`,
 * earliest first. Empty in the spring-forward gap, two long in the autumn
 * overlap, one otherwise — chrono's `LocalResult`, as an array.
 *
 * The offsets are sampled a **half-day either side** of a first guess, not
 * iteratively from the guess itself. Iterating converges: for an ambiguous
 * 01:00 during a fall-back, the offset at the guess is the one that produced
 * the guess, so re-probing returns the same instant and the second reading is
 * never found. Sampling across the transition surfaces both offsets, and a
 * candidate per distinct offset then covers every reading. Twelve hours is
 * comfortably wider than any real transition (at most an hour or two) and
 * narrower than the gap between them.
 */
function candidatesFor(naive: Naive, timeZone: string): number[] {
  const guess = naive - offsetAt(naive, timeZone);
  const probes = [guess - 12 * HOUR_MS, guess, guess + 12 * HOUR_MS];
  const offsets = [...new Set(probes.map((t) => offsetAt(t, timeZone)))];
  const candidates = [...new Set(offsets.map((o) => naive - o))];
  return candidates
    .filter((t) => naiveInZone(t, timeZone) === naive)
    .sort((a, b) => a - b);
}

/**
 * The instant at which `naive` occurs in `timeZone`.
 *
 * Mirrors the Rust's `resolve_local`:
 *   - unambiguous → that instant;
 *   - ambiguous (autumn overlap) → the **later** instant, i.e. the standard-time
 *     reading. See the note below; this is not what the Rust *looks* like it
 *     does;
 *   - nonexistent (spring-forward gap) → retry one hour later, and if that
 *     somehow fails too, read the wall-clock as UTC rather than throw. A budget
 *     boundary that cannot be resolved must still produce *a* boundary;
 *     refusing would fail every call the budget governs.
 *
 * **On the ambiguous arm.** The daemon writes
 * `LocalResult::Ambiguous(early, _) => early`, which reads as "take the earlier
 * instant". It does not: chrono fills `.0` with the standard-time reading, so
 * for `2026-11-01 01:00` in America/New_York it holds `06:00Z` (EST) and `.1`
 * holds `05:00Z` (EDT). Probed directly against chrono before writing this, and
 * pinned by the fall-back cases in the budget parity fixture. The binding name
 * is misleading; the behaviour is what a budget window actually gets, so it is
 * what this reproduces.
 */
export function resolveInZone(naive: Naive, timeZone: string): number {
  const direct = candidatesFor(naive, timeZone);
  if (direct.length > 0) {
    return direct[direct.length - 1]!;
  }
  const shifted = candidatesFor(naive + HOUR_MS, timeZone);
  // The gap arm genuinely does take the earliest: Rust calls `.earliest()`.
  return shifted.length > 0 ? shifted[0]! : naive;
}

// ── Naive field access ───────────────────────────────────────────────────────
//
// A naive is UTC-encoded, so the UTC getters read wall-clock fields directly.

export interface NaiveParts {
  year: number;
  /** 1-12, as in chrono, not `Date`'s 0-11. */
  month: number;
  day: number;
  hour: number;
}

export function partsOf(naive: Naive): NaiveParts {
  const d = new Date(naive);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
  };
}

/** 0 = Monday .. 6 = Sunday, matching chrono's `num_days_from_monday`. */
export function daysFromMonday(naive: Naive): number {
  return (new Date(naive).getUTCDay() + 6) % 7;
}

/** The naive at `hour:00:00` on the date part of `naive`. Hour clamps to 0..=23. */
export function atHour(naive: Naive, hour: number): Naive {
  const { year, month, day } = partsOf(naive);
  return naiveFrom(year, month, day, Math.min(Math.max(hour, 0), 23));
}

export function naiveFrom(
  year: number,
  month: number,
  day: number,
  hour: number,
): Naive {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, 0, 0, 0);
  return d.getTime();
}

export function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  // Day 0 of the next month is the last day of this one.
  d.setUTCFullYear(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 0);
  return d.getUTCDate();
}

// ── RFC 3339 ─────────────────────────────────────────────────────────────────

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * An instant as chrono's `DateTime<Utc>::to_rfc3339` renders it.
 *
 * Note `+00:00`, not `Z`: chrono writes the numeric offset, and these strings
 * are compared against the `ts` column as text. `toISOString()` would produce
 * `Z` and a milliseconds field, and neither would sort where the Rust's does.
 */
export function toRfc3339(instant: number): string {
  const d = new Date(instant);
  const ms = d.getUTCMilliseconds();
  const y = d.getUTCFullYear();
  const date = `${pad(y, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  // chrono's `AutoSi` omits the subsecond field entirely when it is zero, which
  // it always is for a window boundary.
  const frac = ms === 0 ? "" : `.${pad(ms, 3)}`;
  return `${date}T${time}${frac}+00:00`;
}

/**
 * `YYYY-MM-DD HH:MM AM|PM` in `timeZone`, matching chrono's
 * `%Y-%m-%d %I:%M %p`. The 12-hour fields are derived arithmetically rather
 * than asked of `Intl`, whose locale data decides casing and spacing for
 * itself.
 */
export function formatLocalAmPm(rfc3339: string, timeZone: string): string {
  const instant = Date.parse(rfc3339);
  if (Number.isNaN(instant)) {
    // Better to show something than nothing in a warning message.
    return rfc3339;
  }
  const { year, month, day, hour } = partsOf(naiveInZone(instant, timeZone));
  const minute = new Date(naiveInZone(instant, timeZone)).getUTCMinutes();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour12)}:${pad(minute)} ${meridiem}`;
}
