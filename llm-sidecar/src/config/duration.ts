/**
 * Systemd-style duration strings (`500ms`, `30s`, `2m`, `1h`, `2d`), the shape
 * every duration-valued config key accepts.
 *
 * Port of `crates/common/src/config/duration.rs`. A bare integer means
 * *seconds*, for backwards compatibility with the pre-suffix config format.
 *
 * Values are milliseconds held as `bigint` rather than `number`. The Rust type
 * is a `u64` and reports "duration too large" exactly at that boundary; a
 * double would round near it and disagree about which inputs are errors. Every
 * real config value is minutes-to-hours, so callers should reach for
 * {@link ConfigDuration.asMillis} and never notice.
 */

const MILLIS_PER_SECOND = 1_000n;
const MILLIS_PER_MINUTE = 60_000n;
const MILLIS_PER_HOUR = 3_600_000n;
const MILLIS_PER_DAY = 86_400_000n;

const U64_MAX = 18_446_744_073_709_551_615n;

export type ParseResult<T> = { ok: T } | { err: string };

/**
 * Trim exactly what Rust's `str::trim` trims: characters with the Unicode
 * `White_Space` property.
 *
 * Not `String.prototype.trim`, which disagrees at both ends — it strips U+FEFF
 * (which Rust keeps, making the string an invalid duration) and keeps U+0085
 * (which Rust strips, making the string a valid one). Both are reachable from a
 * hand-edited config file.
 */
function rustTrim(s: string): string {
  return s.replace(/^\p{White_Space}+/u, "").replace(/\p{White_Space}+$/u, "");
}

/** A whole number of ASCII digits, the only thing Rust's `u64::from_str` takes. */
function parseU64(digits: string): bigint | undefined {
  if (digits === "" || !/^[0-9]+$/.test(digits)) return undefined;
  const value = BigInt(digits);
  return value > U64_MAX ? undefined : value;
}

export class ConfigDuration {
  private constructor(private readonly millis: bigint) {}

  /**
   * Parse a duration string. A bare integer is seconds; otherwise a decimal
   * (optionally fractional) followed by `ms` / `s` / `m` / `h` / `d`.
   */
  static parse(raw: string): ParseResult<ConfigDuration> {
    const s = rustTrim(raw);
    if (s === "") return { err: "duration string is empty" };
    if (s.startsWith("-")) return { err: "duration cannot be negative" };

    // Bare integer -> seconds. An integer too large for u64 does *not* stop
    // here: Rust's `parse::<u64>()` fails and falls through to the suffix
    // path, which then rejects it as having no suffix at all.
    const bare = parseU64(s);
    if (bare !== undefined) {
      const millis = bare * MILLIS_PER_SECOND;
      if (millis > U64_MAX) return { err: `duration too large: ${s}` };
      return { ok: new ConfigDuration(millis) };
    }

    // Where the numeric part ends. Digits and `.` count as numeric so `1.5h`
    // works. Everything before this index is ASCII, so the UTF-16 index here
    // and the byte index Rust's `find` returns are the same number.
    const digitEnd = s.search(/[^0-9.]/);
    if (digitEnd < 0) return { err: `invalid duration: ${s}` };

    const numStr = s.slice(0, digitEnd);
    const suffix = s.slice(digitEnd);

    const unit = unitMillis(suffix);
    if (unit === undefined) return { err: `invalid duration suffix: ${suffix}` };

    const millis = millisFromDecimalUnit(numStr, unit, s);
    if ("err" in millis) return millis;
    return { ok: new ConfigDuration(millis.ok) };
  }

  /** Saturating, like the Rust `const fn`: a seconds count whose milliseconds
   *  would exceed `u64` clamps rather than wrapping. */
  static fromSecs(secs: bigint | number): ConfigDuration {
    const product = BigInt(secs) * MILLIS_PER_SECOND;
    return new ConfigDuration(product > U64_MAX ? U64_MAX : product);
  }

  static fromMillis(millis: bigint | number): ConfigDuration {
    return new ConfigDuration(BigInt(millis));
  }

  /** Milliseconds as a `number`, for the timer and timeout callers. Exact for
   *  every value below 2^53 — i.e. everything short of ~285,000 years. */
  asMillis(): number {
    return Number(this.millis);
  }

  /** Milliseconds without the `number` conversion, for equality and hashing. */
  asMillisExact(): bigint {
    return this.millis;
  }

  /** Whole seconds, truncated. */
  asSecs(): bigint {
    return this.millis / MILLIS_PER_SECOND;
  }

  /**
   * The canonical spelling: the largest unit that divides the value exactly.
   * `0` is `"0s"`. This is what gets written back to TOML, so it has to
   * round-trip through {@link ConfigDuration.parse}.
   */
  toString(): string {
    const ms = this.millis;
    if (ms === 0n) return "0s";
    if (ms % MILLIS_PER_DAY === 0n) return `${ms / MILLIS_PER_DAY}d`;
    if (ms % MILLIS_PER_HOUR === 0n) return `${ms / MILLIS_PER_HOUR}h`;
    if (ms % MILLIS_PER_MINUTE === 0n) return `${ms / MILLIS_PER_MINUTE}m`;
    if (ms % MILLIS_PER_SECOND === 0n) return `${ms / MILLIS_PER_SECOND}s`;
    return `${ms}ms`;
  }

  /** JSON/TOML serialization is the string form, matching the Rust `Serialize`. */
  toJSON(): string {
    return this.toString();
  }

  equals(other: ConfigDuration): boolean {
    return this.millis === other.millis;
  }
}

function unitMillis(suffix: string): bigint | undefined {
  switch (suffix) {
    case "ms":
      return 1n;
    case "s":
      return MILLIS_PER_SECOND;
    case "m":
      return MILLIS_PER_MINUTE;
    case "h":
      return MILLIS_PER_HOUR;
    case "d":
      return MILLIS_PER_DAY;
    default:
      return undefined;
  }
}

function millisFromDecimalUnit(
  decimal: string,
  unitMillisValue: bigint,
  raw: string,
): ParseResult<bigint> {
  const parts = decimalParts(decimal, raw);
  if ("err" in parts) return parts;
  const [wholeDigits, fractionalDigits] = parts.ok;

  // An empty whole part (`.5h`) is zero, not an error.
  let wholeUnits = 0n;
  if (wholeDigits !== "") {
    const parsed = parseU64(wholeDigits);
    if (parsed === undefined) return { err: `duration too large: ${raw}` };
    wholeUnits = parsed;
  }

  const wholeMillis = wholeUnits * unitMillisValue;
  if (wholeMillis > U64_MAX) return { err: `duration too large: ${raw}` };

  let fractionalMillis = 0n;
  if (fractionalDigits !== undefined && fractionalDigits !== "") {
    const frac = millisFromFractionalDigits(fractionalDigits, unitMillisValue, raw);
    if ("err" in frac) return frac;
    fractionalMillis = frac.ok;
  }

  const total = wholeMillis + fractionalMillis;
  if (total > U64_MAX) return { err: `duration too large: ${raw}` };
  return { ok: total };
}

function decimalParts(
  decimal: string,
  raw: string,
): ParseResult<[string, string | undefined]> {
  // The `"."` half of this guard is redundant with the both-halves-empty check
  // below, which catches the same input with the same message. Kept because
  // the Rust carries the same redundancy, and removing it here would make the
  // two read differently for no gain.
  if (decimal === "" || decimal === ".") {
    return { err: `invalid number in duration: ${raw}` };
  }

  const dot = decimal.indexOf(".");
  if (dot < 0) return { ok: [decimal, undefined] };

  const wholeDigits = decimal.slice(0, dot);
  const fractionalDigits = decimal.slice(dot + 1);
  // A second `.` (`1.2.3h`) is malformed, and so is a lone `.` with a suffix
  // (`.s`) — which is the both-halves-empty case, and the reason the guard
  // above is redundant rather than the other way round.
  if (fractionalDigits.includes(".") || (wholeDigits === "" && fractionalDigits === "")) {
    return { err: `invalid number in duration: ${raw}` };
  }
  return { ok: [wholeDigits, fractionalDigits] };
}

function millisFromFractionalDigits(
  digits: string,
  unitMillisValue: bigint,
  raw: string,
): ParseResult<bigint> {
  // The Rust computes this in `u128` and errors on any step that overflows it.
  // `bigint` cannot overflow, so the boundary has to be checked explicitly at
  // each of the three steps to keep the same inputs erroring.
  const U128_MAX = (1n << 128n) - 1n;
  const precisionErr = { err: `duration fractional precision is too large: ${raw}` };

  if (!/^[0-9]+$/.test(digits)) return precisionErr;
  const fractionalUnits = BigInt(digits);
  if (fractionalUnits > U128_MAX) return precisionErr;

  // `10u128.checked_pow(len)` overflows past 38 digits of fractional precision.
  if (10n ** BigInt(digits.length) > U128_MAX) return precisionErr;
  const scale = 10n ** BigInt(digits.length);

  const scaled = fractionalUnits * unitMillisValue;
  if (scaled > U128_MAX) return precisionErr;

  const fractionalMillis = scaled / scale;
  if (fractionalMillis > U64_MAX) return { err: `duration too large: ${raw}` };
  return { ok: fractionalMillis };
}
