import { asNaive, naiveInZone, resolveInZone } from "../src/ledger/zoned.ts";

export type TimestampShape = "rfc3339" | "naive_iso" | "wordy" | "unknown";

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const NAIVE_ISO = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;
const WORDY = /^([A-Za-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

export function classifyTimestamp(raw: string): TimestampShape {
  const value = raw.trim();
  if (RFC3339.test(value)) return "rfc3339";
  if (NAIVE_ISO.test(value)) return "naive_iso";
  if (monthIndex(WORDY.exec(value)?.[1]) !== undefined) return "wordy";
  return "unknown";
}

export function normalizeLegacyTimestamp(raw: string, timeZone: string): string | undefined {
  const value = raw.trim();
  if (RFC3339.test(value)) return undefined;

  const iso = NAIVE_ISO.exec(value);
  if (iso !== null) {
    const [, year, month, day, hour, minute, second, fraction] = iso;
    return zoned(
      Number(year), Number(month), Number(day),
      Number(hour), Number(minute), Number(second),
      fraction ?? "", timeZone,
    );
  }

  const wordy = WORDY.exec(value);
  if (wordy === null) return undefined;
  const [, name, day, year, hour, minute, meridiem] = wordy;
  const month = monthIndex(name);
  if (month === undefined || meridiem === undefined) return undefined;
  const hour12 = Number(hour);
  if (hour12 < 1 || hour12 > 12) return undefined;
  const pm = meridiem.toLowerCase() === "p";
  const hour24 = hour12 === 12 ? (pm ? 12 : 0) : pm ? hour12 + 12 : hour12;
  return zoned(Number(year), month, Number(day), hour24, Number(minute), 0, "", timeZone);
}

function monthIndex(name: string | undefined): number | undefined {
  if (name === undefined) return undefined;
  const i = MONTHS.indexOf(name.toLowerCase());
  return i === -1 ? undefined : i + 1;
}

function zoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  fraction: string,
  timeZone: string,
): string | undefined {
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day
  ) {
    return undefined;
  }

  const instant = resolveInZone(asNaive(wall.getTime()), timeZone);
  const local = new Date(naiveInZone(instant, timeZone));
  const offsetMinutes = Math.round((local.getTime() - instant) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${trimFraction(fraction)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function trimFraction(fraction: string): string {
  if (fraction === "") return "";
  const digits = fraction.slice(1).replace(/0+$/, "");
  return digits === "" ? "" : `.${digits}`;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
