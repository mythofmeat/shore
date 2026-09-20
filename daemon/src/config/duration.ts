const MILLIS_PER_SECOND = 1_000n;
const MILLIS_PER_MINUTE = 60_000n;
const MILLIS_PER_HOUR = 3_600_000n;
const MILLIS_PER_DAY = 86_400_000n;

const U64_MAX = 18_446_744_073_709_551_615n;

export type ParseResult<T> = { ok: T } | { err: string };

export function rustTrim(s: string): string {
  return s.replace(/^\p{White_Space}+/u, "").replace(/\p{White_Space}+$/u, "");
}

function parseU64(digits: string): bigint | undefined {
  if (digits === "" || !/^[0-9]+$/.test(digits)) return undefined;
  const value = BigInt(digits);
  return value > U64_MAX ? undefined : value;
}

export class ConfigDuration {
  private constructor(private readonly millis: bigint) {}

  static parse(raw: string): ParseResult<ConfigDuration> {
    const s = rustTrim(raw);
    if (s === "") return { err: "duration string is empty" };
    if (s.startsWith("-")) return { err: "duration cannot be negative" };

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

  static deserialize(value: unknown): ParseResult<ConfigDuration> {
    if (typeof value === "string") return ConfigDuration.parse(value);
    return { err: invalidDurationType(value) };
  }

  static fromSecs(secs: bigint | number): ConfigDuration {
    const product = BigInt(secs) * MILLIS_PER_SECOND;
    return new ConfigDuration(product > U64_MAX ? U64_MAX : product);
  }

  static fromMillis(millis: bigint | number): ConfigDuration {
    return new ConfigDuration(BigInt(millis));
  }

  asMillis(): number {
    return Number(this.millis);
  }

  asMillisExact(): bigint {
    return this.millis;
  }

  asSecs(): bigint {
    return this.millis / MILLIS_PER_SECOND;
  }

  toString(): string {
    const ms = this.millis;
    if (ms === 0n) return "0s";
    if (ms % MILLIS_PER_DAY === 0n) return `${ms / MILLIS_PER_DAY}d`;
    if (ms % MILLIS_PER_HOUR === 0n) return `${ms / MILLIS_PER_HOUR}h`;
    if (ms % MILLIS_PER_MINUTE === 0n) return `${ms / MILLIS_PER_MINUTE}m`;
    if (ms % MILLIS_PER_SECOND === 0n) return `${ms / MILLIS_PER_SECOND}s`;
    return `${ms}ms`;
  }

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
  if (decimal === "" || decimal === ".") {
    return { err: `invalid number in duration: ${raw}` };
  }

  const dot = decimal.indexOf(".");
  if (dot < 0) return { ok: [decimal, undefined] };

  const wholeDigits = decimal.slice(0, dot);
  const fractionalDigits = decimal.slice(dot + 1);
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
  const U128_MAX = (1n << 128n) - 1n;
  const precisionErr = { err: `duration fractional precision is too large: ${raw}` };

  if (!/^[0-9]+$/.test(digits)) return precisionErr;
  const fractionalUnits = BigInt(digits);
  if (fractionalUnits > U128_MAX) return precisionErr;

  if (10n ** BigInt(digits.length) > U128_MAX) return precisionErr;
  const scale = 10n ** BigInt(digits.length);

  const scaled = fractionalUnits * unitMillisValue;
  if (scaled > U128_MAX) return precisionErr;

  const fractionalMillis = scaled / scale;
  if (fractionalMillis > U64_MAX) return { err: `duration too large: ${raw}` };
  return { ok: fractionalMillis };
}

const DURATION_EXPECTING = 'a duration string (e.g. "30s", "2m")';

function invalidDurationType(value: unknown): string {
  if (Array.isArray(value)) return `invalid type: sequence, expected ${DURATION_EXPECTING}`;
  if (typeof value === "boolean") {
    return `invalid type: boolean \`${value}\`, expected ${DURATION_EXPECTING}`;
  }
  if (value !== null && typeof value === "object") {
    return `invalid type: map, expected ${DURATION_EXPECTING}`;
  }
  return `invalid type: ${String(value)}, expected ${DURATION_EXPECTING}`;
}
