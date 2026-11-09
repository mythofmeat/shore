import { describe, expect, test } from "bun:test";

import {
  atHour,
  daysFromMonday,
  daysInMonth,
  formatLocalAmPm,
  normalizeToZone,
  toZonedRfc3339,
  HOUR_MS,
  asNaive,
  naiveFrom,
  naiveInZone,
  partsOf,
  resolveInZone,
  toRfc3339,
  type Naive,
} from "../src/ledger/zoned.ts";

const NY = "America/New_York";
const UTC = "UTC";

const wall = (
  y: number,
  m: number,
  d: number,
  h: number,
  min = 0,
): Naive => asNaive(Date.UTC(y, m - 1, d, h, min, 0, 0));

const iso = (s: string) => Date.parse(s);

describe("instant → wall clock", () => {
  test("reads the local hour on both sides of spring forward", () => {
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
    expect(resolveInZone(wall(2026, 11, 1, 1), NY)).toBe(
      iso("2026-11-01T06:00:00Z"),
    );
    expect(resolveInZone(wall(2026, 11, 1, 1, 30), NY)).toBe(
      iso("2026-11-01T06:30:00Z"),
    );
  });

  test("a nonexistent time retries an hour later", () => {
    expect(resolveInZone(wall(2026, 3, 8, 2, 30), NY)).toBe(
      iso("2026-03-08T07:30:00Z"),
    );
  });

  test("round-trips every hour across both transitions", () => {
    for (const day of ["2026-03-08", "2026-11-01"]) {
      for (let h = 0; h < 24; h += 1) {
        const naive = asNaive(Date.parse(`${day}T00:00:00Z`) + h * HOUR_MS);
        const instant = resolveInZone(naive, NY);
        const readBack = naiveInZone(instant, NY);
        const isGap = readBack !== naive;
        expect(asNaive(isGap ? naive + HOUR_MS : naive), `${day} ${h}:00`).toBe(readBack);
      }
    }
  });
});

describe("naive field arithmetic", () => {
  test("atHour keeps the date and clamps the hour", () => {
    expect(atHour(wall(2026, 3, 8, 23, 45), 6)).toBe(wall(2026, 3, 8, 6));
    expect(atHour(wall(2026, 3, 8, 1), 99)).toBe(wall(2026, 3, 8, 23));
    expect(atHour(wall(2026, 3, 8, 13), 0)).toBe(wall(2026, 3, 8, 0));
    expect(atHour(wall(2026, 3, 8, 13), -3)).toBe(wall(2026, 3, 8, 0));
  });

  test("months have the days the calendar gives them, December and leap Februaries included", () => {
    expect([1, 2, 4, 12].map((month) => daysInMonth(2026, month))).toEqual([31, 28, 30, 31]);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(99, 12)).toBe(31);
  });

  test("a wall-clock time keeps a year before 100 and before the common era", () => {
    expect(partsOf(naiveFrom(42, 6, 15, 9))).toEqual({ year: 42, month: 6, day: 15, hour: 9 });
    const ancient = Date.UTC(2000, 0, 1) - 2100 * 365.25 * 24 * HOUR_MS;
    expect(partsOf(naiveInZone(ancient, UTC)).year).toBe(new Date(ancient).getUTCFullYear());
    expect(new Date(ancient).getUTCFullYear()).toBeLessThan(0);
  });

  test("a timestamp names its milliseconds to three places, and leaves them off when there are none", () => {
    expect(toRfc3339(Date.UTC(2026, 2, 8, 6, 30, 0, 5))).toBe("2026-03-08T06:30:00.005+00:00");
    expect(toRfc3339(Date.UTC(2026, 2, 8, 6, 30, 0, 250))).toBe("2026-03-08T06:30:00.250+00:00");
    expect(toRfc3339(Date.UTC(2026, 2, 8, 6, 30, 0, 0))).toBe("2026-03-08T06:30:00+00:00");
  });

  test("a wall-clock time a zone skipped resolves to the next time that exists, one it repeated to its later occurrence, and one in a skipped day is read as UTC", () => {
    expect(resolveInZone(wall(2026, 3, 8, 2, 30), NY)).toBe(iso("2026-03-08T07:30:00Z"));
    expect(resolveInZone(wall(2026, 11, 1, 1, 30), NY)).toBe(iso("2026-11-01T06:30:00Z"));
    expect(resolveInZone(wall(2026, 4, 5, 2, 30), "Australia/Sydney")).toBe(iso("2026-04-04T16:30:00Z"));
    expect(resolveInZone(wall(2011, 12, 30, 12), "Pacific/Apia")).toBe(Date.UTC(2011, 11, 30, 12));
  });

  test("daysFromMonday counts from Monday, not Sunday", () => {
    expect(daysFromMonday(wall(2026, 3, 2, 0))).toBe(0);
    expect(daysFromMonday(wall(2026, 3, 4, 0))).toBe(2);
    expect(daysFromMonday(wall(2026, 3, 8, 0))).toBe(6);
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
    expect(formatLocalAmPm("2026-04-15T04:00:00+00:00", NY)).toBe(
      "2026-04-15 12:00 AM",
    );
  });

  test("an unparseable timestamp passes through", () => {
    expect(formatLocalAmPm("not a timestamp", NY)).toBe("not a timestamp");
  });
});

describe("rendering an instant in a zone", () => {
  const CBR = "Australia/Canberra";

  test("the offset is the zone's, on both sides of a DST boundary", () => {
    expect(toZonedRfc3339(Date.parse("2026-08-13T00:00:00Z"), CBR)).toBe(
      "2026-08-13T10:00:00+10:00",
    );
    expect(toZonedRfc3339(Date.parse("2026-01-13T00:00:00Z"), CBR)).toBe(
      "2026-01-13T11:00:00+11:00",
    );
    expect(toZonedRfc3339(Date.parse("2026-08-13T00:00:00Z"), "UTC")).toBe(
      "2026-08-13T00:00:00+00:00",
    );
  });

  test("a negative offset keeps its sign", () => {
    expect(toZonedRfc3339(Date.parse("2026-03-11T10:00:00Z"), "America/New_York")).toBe(
      "2026-03-11T06:00:00-04:00",
    );
  });

  test("sub-second precision survives, and whole seconds stay bare", () => {
    expect(toZonedRfc3339(Date.parse("2026-08-13T00:00:00.123Z"), "UTC")).toBe(
      "2026-08-13T00:00:00.123+00:00",
    );
    expect(toZonedRfc3339(Date.parse("2026-08-13T00:00:00.000Z"), "UTC")).toBe(
      "2026-08-13T00:00:00+00:00",
    );
  });

  test("every stored encoding normalizes to the same instant", () => {
    const same = [
      "2026-08-13T00:00:00Z",
      "2026-08-13T00:00:00+00:00",
      "2026-08-13T10:00:00+10:00",
      "2026-08-13T11:00:00+11:00",
    ];
    for (const ts of same) {
      expect(normalizeToZone(ts, CBR)).toBe("2026-08-13T10:00:00+10:00");
    }
  });

  test("nanosecond precision from the Rust era is accepted", () => {
    expect(normalizeToZone("2026-03-30T07:33:16.656165788+00:00", "UTC")).toBe(
      "2026-03-30T07:33:16.656+00:00",
    );
  });

  test("an unparseable timestamp passes through untouched", () => {
    expect(normalizeToZone("not-a-timestamp", CBR)).toBe("not-a-timestamp");
  });
});
