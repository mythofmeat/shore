import { describe, expect, test } from "bun:test";

import {
  classifyTimestamp,
  normalizeLegacyTimestamp,
  type TimestampShape,
} from "../scripts/legacy_timestamps.ts";

const ZONE = "Australia/Canberra";

describe("classifying what the archive actually holds", () => {
  const cases: [string, TimestampShape][] = [
    ["2026-08-11T09:36:17.108Z", "rfc3339"],
    ["2026-03-28T14:02:11.123456789+11:00", "rfc3339"],
    ["2024-11-13T00:51:00", "naive_iso"],
    ["March 4, 2025 11:27am", "wordy"],
    ["August 18, 2025 5:40pm", "wordy"],
    ["not-a-timestamp", "unknown"],
    ["", "unknown"],
  ];
  for (const [raw, shape] of cases) {
    test(`${raw || "(empty)"} is ${shape}`, () => {
      expect(classifyTimestamp(raw)).toBe(shape);
    });
  }
});

describe("sillytavern send_date becomes a real instant", () => {
  test("a summer date carries the daylight offset", () => {
    expect(normalizeLegacyTimestamp("March 4, 2025 11:27am", ZONE)).toBe("2025-03-04T11:27:00+11:00");
  });

  test("a winter date carries the standard offset", () => {
    expect(normalizeLegacyTimestamp("August 18, 2025 5:40pm", ZONE)).toBe("2025-08-18T17:40:00+10:00");
  });

  test("midnight and noon land on the right side of the clock", () => {
    expect(normalizeLegacyTimestamp("June 1, 2025 12:03am", ZONE)).toBe("2025-06-01T00:03:00+10:00");
    expect(normalizeLegacyTimestamp("June 1, 2025 12:03pm", ZONE)).toBe("2025-06-01T12:03:00+10:00");
  });

  test("a two digit hour parses like a one digit hour", () => {
    expect(normalizeLegacyTimestamp("March 1, 2025 11:59pm", ZONE)).toBe("2025-03-01T23:59:00+11:00");
  });
});

describe("offsetless iso keeps its wall clock", () => {
  test("the first imported message stays on its own day", () => {
    expect(normalizeLegacyTimestamp("2024-11-13T00:51:00", ZONE)).toBe("2024-11-13T00:51:00+11:00");
  });

  test("a fraction survives", () => {
    expect(normalizeLegacyTimestamp("2025-07-02T08:15:30.250", ZONE)).toBe("2025-07-02T08:15:30.25+10:00");
  });
});

describe("daylight saving edges resolve rather than throw", () => {
  test("a wall clock inside the spring gap moves forward", () => {
    expect(normalizeLegacyTimestamp("2025-10-05T02:30:00", ZONE)).toBe("2025-10-05T03:30:00+11:00");
  });

  test("a repeated autumn wall clock takes the standard offset", () => {
    expect(normalizeLegacyTimestamp("2025-04-06T02:30:00", ZONE)).toBe("2025-04-06T02:30:00+10:00");
  });
});

describe("nothing else is touched", () => {
  const untouched = [
    "2026-08-11T09:36:17.108Z",
    "2026-03-28T14:02:11+11:00",
    "not-a-timestamp",
    "",
    "Smarch 4, 2025 11:27am",
    "March 4, 2025 13:27am",
    "February 30, 2025 1:00am",
  ];
  for (const raw of untouched) {
    test(`${raw || "(empty)"} converts to nothing`, () => {
      expect(normalizeLegacyTimestamp(raw, ZONE)).toBeUndefined();
    });
  }

  test("a converted timestamp is already canonical", () => {
    const once = normalizeLegacyTimestamp("March 4, 2025 11:27am", ZONE) ?? "";
    expect(classifyTimestamp(once)).toBe("rfc3339");
    expect(normalizeLegacyTimestamp(once, ZONE)).toBeUndefined();
  });

  test("the zone is an argument, not the host", () => {
    expect(normalizeLegacyTimestamp("March 4, 2025 11:27am", "UTC")).toBe("2025-03-04T11:27:00+00:00");
  });
});
