import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";

import rawFixture from "./tools_captures/tool_handlers.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);
import {
  DiceParseError,
  executeDiceRoll,
  handleRollDice,
  parseDiceNotation,
} from "../src/tools/basic.ts";
import { handleActivityHeatmap } from "../src/tools/activity.ts";
import type { ActivityStats, HourClassification } from "../src/autonomy/activity.ts";
import { handleModelHistory, kindFor, utcBound } from "../src/tools/model_history.ts";

const fx = fixture as unknown as {
  parse_dice_notation: {
    input: string;
    ok?: { count: number; sides: number; modifier: number };
    err?: string;
  }[];
  execute_dice_roll: {
    count: number;
    sides: number;
    modifier: number;
    observed_min: number;
    observed_max: number;
  }[];
  handle_roll_dice: Record<string, { input: Record<string, unknown>; err?: string; echoed?: string }>;
  kind_for: { call_type: string; kind: string }[];
  utc_bound: { input: Record<string, unknown>; ok?: string | null; err?: string }[];
  activity_heatmap_empty: Record<string, { input: Record<string, unknown>; output: unknown }>;
};

describe("parseDiceNotation", () => {
  test.each(fx.parse_dice_notation.map((c): [string, typeof c] => [JSON.stringify(c.input), c]))(
    "%s",
    (_label, c) => {
      if (c.ok !== undefined) {
        expect(parseDiceNotation(c.input)).toEqual(c.ok);
      } else {
        expect(() => parseDiceNotation(c.input)).toThrow(new DiceParseError(c.err));
      }
    },
  );

  test("a sign at position 0 belongs to the sides, not the modifier", () => {
    expect(() => parseDiceNotation("d-6")).toThrow("Invalid sides: -6");
    expect(parseDiceNotation("d+6")).toEqual({ count: 1, sides: 6, modifier: 0 });
  });

  test("a negative zero modifier is plain zero", () => {
    const parsed = parseDiceNotation("2d6-0");
    expect(parsed.modifier).toBe(0);
    expect(Object.is(parsed.modifier, -0)).toBe(false);
  });

  test("an integer argument accepts a leading + and rejects everything else", () => {
    expect(parseDiceNotation("+2d6")).toEqual({ count: 2, sides: 6, modifier: 0 });
    expect(() => parseDiceNotation("-2d6")).toThrow("Invalid dice count: -2");
    expect(() => parseDiceNotation("2.5d6")).toThrow("Invalid dice count: 2.5");
    expect(() => parseDiceNotation("2d6.5")).toThrow("Invalid sides: 6.5");
  });

  test("trimming happens once, up front", () => {
    expect(parseDiceNotation("  2D6+3  ")).toEqual({ count: 2, sides: 6, modifier: 3 });
    expect(() => parseDiceNotation("2 d 6")).toThrow("Invalid dice count: 2 ");
    expect(() => parseDiceNotation("2d6 +3")).toThrow("Invalid sides: 6 ");
  });

  test("roll counts are bounded while sides and modifiers retain their integer ranges", () => {
    expect(() => parseDiceNotation("4294967295d6")).toThrow("Dice count must be at most 1000");
    expect(() => parseDiceNotation("4294967296d6")).toThrow("Invalid dice count: 4294967296");
    expect(parseDiceNotation("1d6+2147483647").modifier).toBe(2_147_483_647);
    expect(() => parseDiceNotation("1d6+2147483648")).toThrow("Invalid modifier: +2147483648");
    expect(parseDiceNotation("1d6-2147483648").modifier).toBe(-2_147_483_648);
    expect(() => parseDiceNotation("1d6-2147483649")).toThrow("Invalid modifier: -2147483649");
  });
});

describe("executeDiceRoll", () => {
  test.each(
    fx.execute_dice_roll.map((c): [string, typeof c] => [
      `${c.count}d${c.sides}${c.modifier >= 0 ? "+" : ""}${c.modifier}`,
      c,
    ]),
  )("%s", (_label, c) => {
    const notation = { count: c.count, sides: c.sides, modifier: c.modifier };
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 500; i += 1) {
      const { rolls, total } = executeDiceRoll(notation);
      expect(rolls.length).toBe(c.count);
      let expected = c.modifier;
      for (const r of rolls) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(c.sides);
        expect(Number.isInteger(r)).toBe(true);
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
        expected = Math.min(2_147_483_647, Math.max(-2_147_483_648, expected + r));
      }
      expect(total).toBe(expected);
    }
    expect(lo).toBe(c.observed_min);
    expect(hi).toBe(c.observed_max);
  });

  test("the total saturates rather than wrapping", () => {
    const { total } = executeDiceRoll({ count: 1, sides: 1, modifier: 2_147_483_647 });
    expect(total).toBe(2_147_483_647);
  });
});

describe("handleRollDice", () => {
  test("missing notation", () => {
    expect(() => handleRollDice({})).toThrow(fx.handle_roll_dice["missing_notation"]?.err);
  });

  test("a non-string notation reports as missing", () => {
    expect(() => handleRollDice({ notation: 6 })).toThrow(
      fx.handle_roll_dice["notation_not_a_string"]?.err,
    );
  });

  test("a parse failure is wrapped, keeping the inner message", () => {
    expect(() => handleRollDice({ notation: "abc" })).toThrow(
      fx.handle_roll_dice["parse_failure_is_wrapped"]?.err,
    );
  });

  test("the echoed notation is the raw input, not the normalized parse", () => {
    const echoed = fx.handle_roll_dice["echoes_raw_notation"]?.echoed as string;
    const out = handleRollDice({ notation: echoed }) as { notation: string };
    expect(out.notation).toBe(echoed);
  });
});

describe("kindFor", () => {
  test.each(fx.kind_for.map((c): [string, typeof c] => [JSON.stringify(c.call_type), c]))(
    "%s",
    (_label, c) => {
      expect(kindFor(c.call_type)).toBe(c.kind);
    },
  );

  test("matching is exact — no trimming, no case folding", () => {
    expect(kindFor("Message")).toBe("background");
    expect(kindFor("tool_loop ")).toBe("background");
  });
});

describe("utcBound", () => {
  test.each(fx.utc_bound.map((c): [string, typeof c] => [JSON.stringify(c.input), c]))(
    "%s",
    (_label, c) => {
      if (c.err !== undefined) {
        expect(() => utcBound(c.input, "start_time")).toThrow(c.err);
      } else {
        expect(utcBound(c.input, "start_time")).toBe(c.ok ?? undefined);
      }
    },
  );

  test("UTC is written +00:00, never Z", () => {
    expect(utcBound({ start_time: "2026-05-13T09:00:00Z" }, "start_time")).toBe(
      "2026-05-13T09:00:00+00:00",
    );
  });

  test("nanosecond precision survives the rebase", () => {
    expect(
      utcBound({ start_time: "2026-05-13T09:00:00.123456789+05:30" }, "start_time"),
    ).toBe("2026-05-13T03:30:00.123456789+00:00");
  });

  test("an offset is subtracted, not ignored", () => {
    expect(utcBound({ start_time: "2026-05-13T09:00:00+10:00" }, "start_time")).toBe(
      "2026-05-12T23:00:00+00:00",
    );
    expect(utcBound({ start_time: "2026-05-13T09:00:00-07:00" }, "start_time")).toBe(
      "2026-05-13T16:00:00+00:00",
    );
  });
});

describe("handleActivityHeatmap", () => {
  test.each(Object.entries(fx.activity_heatmap_empty))("%s (no tracker)", (_label, c) => {
    expect(handleActivityHeatmap(c.input, () => undefined)).toEqual(c.output as never);
  });

  const statsWith = (over: Partial<ActivityStats>): ActivityStats => ({
    engagementScore: 0,
    consistency: 0,
    tempoScore: 0,
    sessionCount: 0,
    sessionsPerDay: 0,
    hourHistogram: Array.from({ length: 24 }, () => 0),
    hourClassifications: Array.from({ length: 24 }, (): HourClassification => "normal"),
    pooledHourHistogram: Array.from({ length: 24 }, () => 0),
    pooledHourClassifications: Array.from({ length: 24 }, (): HourClassification => "normal"),
    weekdayCounts: { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 },
    windowMessageCount: 0,
    hasSufficientData: false,
    hasSufficientHeatmap: false,
    medianSessionGap: undefined,
    anomalyZScore: undefined,
    computedAt: 0,
    ...over,
  });

  test("a wired tracker is reshaped, not recomputed", () => {
    const stats = statsWith({
      engagementScore: 0.75,
      consistency: 0.5,
      tempoScore: 0.9,
      sessionCount: 4,
      sessionsPerDay: 1.25,
      pooledHourHistogram: Array.from({ length: 24 }, (_u, h) => (h === 9 ? 1.0 : 0.0)),
      pooledHourClassifications: Array.from({ length: 24 }, (_u, h) =>
        h === 9 ? ("peak" as const) : ("normal" as const),
      ),
      weekdayCounts: { Mon: 3, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 1, Sun: 0 },
      windowMessageCount: 4,
      hasSufficientData: true,
      hasSufficientHeatmap: true,
      medianSessionGap: 3600,
    });
    const out = handleActivityHeatmap({ days: 7 }, () => ({ stats, turnCount: 42 }));
    expect(out.days).toBe(7);
    expect(out.hours[9]).toEqual({ hour: 9, density: 1.0, classification: "peak" });
    expect(out.hours[0]).toEqual({ hour: 0, density: 0.0, classification: "normal" });
    expect(out.total_messages).toBe(42);
    expect(out.messages_in_window).toBe(4);
    expect(out.has_sufficient_data).toBe(true);
    expect(out.engagement_score).toBe(0.75);
    expect(out.sessions_per_day).toBe(1.25);
  });

  test("the hours it reports are the pooled ones, not today's weekday slice", () => {
    const stats = statsWith({
      hourHistogram: Array.from({ length: 24 }, (_u, h) => (h === 9 ? 1.0 : 0.0)),
      hourClassifications: Array.from({ length: 24 }, (_u, h) =>
        h === 9 ? ("peak" as const) : ("normal" as const),
      ),
      pooledHourHistogram: Array.from({ length: 24 }, (_u, h) => (h === 2 ? 1.0 : 0.0)),
      pooledHourClassifications: Array.from({ length: 24 }, (_u, h) =>
        h === 2 ? ("peak" as const) : ("normal" as const),
      ),
      windowMessageCount: 1,
    });
    const out = handleActivityHeatmap({}, () => ({ stats, turnCount: 1 }));
    expect(out.hours[2]).toEqual({ hour: 2, density: 1.0, classification: "peak" });
    expect(out.hours[9]).toEqual({ hour: 9, density: 0.0, classification: "normal" });
  });

  test("weekday densities are shares of the window", () => {
    const stats = statsWith({
      weekdayCounts: { Mon: 1, Tue: 1, Wed: 0, Thu: 0, Fri: 0, Sat: 2, Sun: 0 },
      windowMessageCount: 4,
    });
    const out = handleActivityHeatmap({}, () => ({ stats, turnCount: 4 }));
    expect(out.weekdays.map((w) => w.weekday)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(out.weekdays[5]).toEqual({ weekday: "Sat", message_count: 2, density: 0.5 });
    expect(out.weekdays.reduce((a, w) => a + w.density, 0)).toBeCloseTo(1, 12);
  });

  test("the window a caller asked for is the window the tracker is given", () => {
    const asked: number[] = [];
    handleActivityHeatmap({ days: 7 }, (days) => {
      asked.push(days);
      return undefined;
    });
    handleActivityHeatmap({}, (days) => {
      asked.push(days);
      return undefined;
    });
    expect(asked).toEqual([7, 30]);
  });

  test("a truncated histogram degrades to zero and normal", () => {
    const stats = statsWith({
      pooledHourHistogram: [0.5],
      pooledHourClassifications: ["peak" as const],
      windowMessageCount: 1,
    });
    const out = handleActivityHeatmap({}, () => ({ stats, turnCount: 1 }));
    expect(out.hours.length).toBe(24);
    expect(out.hours[0]).toEqual({ hour: 0, density: 0.5, classification: "peak" });
    expect(out.hours[23]).toEqual({ hour: 23, density: 0.0, classification: "normal" });
  });
});

describe("handleModelHistory", () => {
  const rows = [
    {
      model: "claude-opus-4-6",
      provider: "anthropic",
      call_type: "message",
      first_ts: "2026-05-01T00:00:00+00:00",
      last_ts: "2026-05-02T00:00:00+00:00",
      call_count: 3,
    },
    {
      model: "gpt-5",
      provider: "openai",
      call_type: "dreaming",
      first_ts: "2026-05-01T00:00:00+00:00",
      last_ts: "2026-05-01T00:00:00+00:00",
      call_count: 1,
    },
  ];

  test("no ledger reports io, not not-implemented", async () => {
    expect(handleModelHistory({}, "frank", undefined)).rejects.toThrow(
      "io: the usage ledger is not available in this context",
    );
  });

  test("an empty character is an argument error", async () => {
    expect(handleModelHistory({}, "", async () => [])).rejects.toThrow(
      "invalid args: model history is not configured",
    );
  });

  test("a reversed range is rejected", async () => {
    expect(
      handleModelHistory(
        { start_time: "2026-06-01T00:00:00Z", end_time: "2026-05-01T00:00:00Z" },
        "frank",
        async () => [],
      ),
    ).rejects.toThrow("invalid args: start_time must be before or equal to end_time");
  });

  test("the range check runs on the rebased bounds", async () => {
    const out = await handleModelHistory(
      { start_time: "2026-05-13T09:00:00+10:00", end_time: "2026-05-13T00:00:00Z" },
      "frank",
      async () => [],
    );
    expect(out.time_range.start_time).toBe("2026-05-12T23:00:00+00:00");
    expect(out.time_range.end_time).toBe("2026-05-13T00:00:00+00:00");
  });

  test("rows are shaped and classified", async () => {
    const out = await handleModelHistory({}, "frank", async () => rows);
    expect(out.character).toBe("frank");
    expect(out.count).toBe(2);
    expect(out.time_range).toEqual({
      start_time: undefined,
      end_time: undefined,
      inclusive: true,
    });
    expect(out.models[0]).toEqual({
      model: "claude-opus-4-6",
      provider: "anthropic",
      call_type: "message",
      kind: "interactive",
      first_seen: "2026-05-01T00:00:00+00:00",
      last_seen: "2026-05-02T00:00:00+00:00",
      calls: 3,
    });
    expect(out.models[1]?.kind).toBe("background");
  });

  test("the bounds reach the query already rebased", async () => {
    let seen: [string | undefined, string | undefined] = [undefined, undefined];
    await handleModelHistory(
      { start_time: "2026-05-13T09:00:00+10:00" },
      "frank",
      async (_c, since, until) => {
        seen = [since, until];
        return [];
      },
    );
    expect(seen).toEqual(["2026-05-12T23:00:00+00:00", undefined]);
  });
});
