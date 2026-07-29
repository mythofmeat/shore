/**
 * The wall-clock primitives, tested directly.
 *
 * `ledger_budget_parity.test.ts` exercises these through whole budget windows
 * against the Rust, which is the real lock. These are here because when that
 * one fails, the diff is a budget status and the cause is three layers down —
 * this says which primitive broke.
 *
 * The zone is pinned explicitly rather than taken from the host, so the suite
 * means the same thing on a laptop in Sydney and in CI in UTC.
 */

import { describe, expect, test } from "bun:test";

import {
  atHour,
  daysFromMonday,
  daysInMonth,
  formatLocalAmPm,
  HOUR_MS,
  naiveFrom,
  naiveInZone,
  partsOf,
  resolveInZone,
  toRfc3339,
} from "../src/ledger/zoned.ts";

const NY = "America/New_York";
const UTC = "UTC";

/** A wall-clock reading, for readability in assertions. */
const wall = (
  y: number,
  m: number,
  d: number,
  h: number,
  min = 0,
): number => Date.UTC(y, m - 1, d, h, min, 0, 0);

const iso = (s: string) => Date.parse(s);

describe("instant → wall clock", () => {
  test("reads the local hour on both sides of spring forward", () => {
    // 06:30Z is 01:30 EST; 07:30Z is 03:30 EDT — 02:30 never happens.
    expect(naiveInZone(iso("2026-03-08T06:30:00Z"), NY)).toBe(
      wall(2026, 3, 8, 1, 30),
    );
    expect(naiveInZone(iso("2026-03-08T07:30:00Z"), NY)).toBe(
      wall(2026, 3, 8, 3, 30),
    );
  });

  test("reads 01:30 twice across fall back", () => {
    expect(naiveInZone(iso("2026-11-01T05:30:00Z"), NY)).toBe(
      wall(2026, 11, 1, 1, 30),
    );
    expect(naiveInZone(iso("2026-11-01T06:30:00Z"), NY)).toBe(
      wall(2026, 11, 1, 1, 30),
    );
  });

  test("utc is the identity", () => {
    expect(naiveInZone(iso("2026-11-01T05:30:00Z"), UTC)).toBe(
      wall(2026, 11, 1, 5, 30),
    );
  });
});

describe("wall clock → instant", () => {
  test("unambiguous times resolve exactly", () => {
    expect(resolveInZone(wall(2026, 4, 15, 6), NY)).toBe(
      iso("2026-04-15T10:00:00Z"),
    );
    expect(resolveInZone(wall(2026, 1, 15, 6), NY)).toBe(
      iso("2026-01-15T11:00:00Z"),
    );
  });

  test("an ambiguous time takes the standard-time reading", () => {
    // Both 05:00Z (EDT) and 06:00Z (EST) read as 01:00 local. chrono's
    // `Ambiguous(.0, .1)` puts the standard-time one in `.0`, and the daemon
    // takes `.0` — despite binding it as `early`. Probed against chrono
    // directly; the budget fixture pins the consequence.
    expect(resolveInZone(wall(2026, 11, 1, 1), NY)).toBe(
      iso("2026-11-01T06:00:00Z"),
    );
    expect(resolveInZone(wall(2026, 11, 1, 1, 30), NY)).toBe(
      iso("2026-11-01T06:30:00Z"),
    );
  });

  test("a nonexistent time retries an hour later", () => {
    // 02:30 on spring-forward day does not exist; Rust shifts by an hour and
    // takes the earliest, landing on 03:30 EDT.
    expect(resolveInZone(wall(2026, 3, 8, 2, 30), NY)).toBe(
      iso("2026-03-08T07:30:00Z"),
    );
  });

  test("round-trips every hour across both transitions", () => {
    // Anything that resolves must read back as itself — except inside the gap,
    // where no instant carries that reading at all.
    for (const day of ["2026-03-08", "2026-11-01"]) {
      for (let h = 0; h < 24; h += 1) {
        const naive = Date.parse(`${day}T00:00:00Z`) + h * HOUR_MS;
        const instant = resolveInZone(naive, NY);
        const readBack = naiveInZone(instant, NY);
        const isGap = readBack !== naive;
        expect(isGap ? naive + HOUR_MS : naive, `${day} ${h}:00`).toBe(readBack);
      }
    }
  });
});

describe("naive field arithmetic", () => {
  test("atHour keeps the date and clamps the hour", () => {
    expect(atHour(wall(2026, 3, 8, 23, 45), 6)).toBe(wall(2026, 3, 8, 6));
    expect(atHour(wall(2026, 3, 8, 1), 99)).toBe(wall(2026, 3, 8, 23));
  });

  test("daysFromMonday counts from Monday, not Sunday", () => {
    expect(daysFromMonday(wall(2026, 3, 2, 0))).toBe(0); // Monday
    expect(daysFromMonday(wall(2026, 3, 4, 0))).toBe(2); // Wednesday
    expect(daysFromMonday(wall(2026, 3, 8, 0))).toBe(6); // Sunday
  });

  test("daysInMonth handles February and year ends", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  test("partsOf and naiveFrom round-trip", () => {
    const n = naiveFrom(2026, 11, 1, 1);
    expect(partsOf(n)).toEqual({ year: 2026, month: 11, day: 1, hour: 1 });
  });
});

describe("rendering", () => {
  test("rfc3339 uses a numeric offset, not Z", () => {
    // These strings are compared against the `ts` column as text, and chrono
    // writes `+00:00`. `toISOString()` would give `Z` and a millis field.
    expect(toRfc3339(iso("2026-03-09T10:00:00Z"))).toBe(
      "2026-03-09T10:00:00+00:00",
    );
  });

  test("local am/pm matches chrono's %Y-%m-%d %I:%M %p", () => {
    expect(formatLocalAmPm("2026-03-11T10:00:00+00:00", NY)).toBe(
      "2026-03-11 06:00 AM",
    );
    expect(formatLocalAmPm("2026-04-15T19:05:00+00:00", NY)).toBe(
      "2026-04-15 03:05 PM",
    );
    // Midnight is 12 AM, not 00 AM.
    expect(formatLocalAmPm("2026-04-15T04:00:00+00:00", NY)).toBe(
      "2026-04-15 12:00 AM",
    );
  });

  test("an unparseable timestamp passes through", () => {
    expect(formatLocalAmPm("not a timestamp", NY)).toBe("not a timestamp");
  });
});
