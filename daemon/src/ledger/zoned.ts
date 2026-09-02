import { required } from "../util/required.ts";

declare const NaiveBrand: unique symbol;

export type Naive = number & { readonly [NaiveBrand]: true };

export function asNaive(value: number): Naive {
  return value as Naive;
}

export const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

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

export function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function zoneFor(configTimezone: string, localZone?: string): string {
  return configTimezone === "utc" ? "UTC" : (localZone ?? hostZone());
}

export function naiveInZone(instant: number, timeZone: string): Naive {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p === undefined ? 0 : Number(p.value);
  };
  const bc = parts.some((p) => p.type === "era" && p.value.startsWith("B"));
  const year = bc ? 1 - get("year") : get("year");
  const d = new Date(0);
  d.setUTCFullYear(year, get("month") - 1, get("day"));
  d.setUTCHours(get("hour"), get("minute"), get("second"), 0);
  return asNaive(d.getTime());
}

function offsetAt(instant: number, timeZone: string): number {
  return naiveInZone(instant, timeZone) - instant;
}

function candidatesFor(naive: Naive, timeZone: string): number[] {
  const guess = naive - offsetAt(naive, timeZone);
  const probes = [guess - 12 * HOUR_MS, guess, guess + 12 * HOUR_MS];
  const offsets = [...new Set(probes.map((t) => offsetAt(t, timeZone)))];
  const candidates = [...new Set(offsets.map((o) => naive - o))];
  return candidates
    .filter((t) => naiveInZone(t, timeZone) === naive)
    .sort((a, b) => a - b);
}

export function resolveInZone(naive: Naive, timeZone: string): number {
  const direct = candidatesFor(naive, timeZone);
  if (direct.length > 0) {
    return required(direct[direct.length - 1]);
  }
  const shifted = candidatesFor(asNaive(naive + HOUR_MS), timeZone);
  return shifted.length > 0 ? required(shifted[0]) : naive;
}

export interface NaiveParts {
  year: number;
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

export function daysFromMonday(naive: Naive): number {
  return (new Date(naive).getUTCDay() + 6) % 7;
}

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
  return asNaive(d.getTime());
}

export function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 0);
  return d.getUTCDate();
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function toRfc3339(instant: number): string {
  const d = new Date(instant);
  const ms = d.getUTCMilliseconds();
  const y = d.getUTCFullYear();
  const date = `${pad(y, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = ms === 0 ? "" : `.${pad(ms, 3)}`;
  return `${date}T${time}${frac}+00:00`;
}

export function formatLocalAmPm(rfc3339: string, timeZone: string): string {
  const instant = Date.parse(rfc3339);
  if (Number.isNaN(instant)) {
    return rfc3339;
  }
  const { year, month, day, hour } = partsOf(naiveInZone(instant, timeZone));
  const minute = new Date(naiveInZone(instant, timeZone)).getUTCMinutes();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour12)}:${pad(minute)} ${meridiem}`;
}

function offsetLabel(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const minutes = Math.round(Math.abs(offsetMs) / MINUTE_MS);
  return `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function toZonedRfc3339(instant: number, timeZone: string): string {
  const wholeSecond = Math.floor(instant / SECOND_MS) * SECOND_MS;
  const naive = naiveInZone(wholeSecond, timeZone);
  const d = new Date(naive);
  const ms = instant - wholeSecond;
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = ms === 0 ? "" : `.${pad(ms, 3)}`;
  return `${date}T${time}${frac}${offsetLabel(naive - wholeSecond)}`;
}

export function normalizeToZone(rfc3339: string, timeZone: string): string {
  const instant = Date.parse(rfc3339);
  return Number.isNaN(instant) ? rfc3339 : toZonedRfc3339(instant, timeZone);
}
