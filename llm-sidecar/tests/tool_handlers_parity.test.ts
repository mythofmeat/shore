/**
 * Replay of `tools_fixtures/tool_handlers_parity.json` against the TypeScript
 * ports of `tools/basic.rs`, `tools/activity.rs` and `tools/model_history.rs`.
 *
 * Frozen fixture: a diff against it is a defect in the port.
 */

import { describe, expect, test } from "bun:test";

import fixture from "./tools_fixtures/tool_handlers_parity.json" with { type: "json" };
import {
  DiceParseError,
  executeDiceRoll,
  handleRollDice,
  parseDiceNotation,
} from "../src/tools/basic.ts";
import { handleActivityHeatmap } from "../src/tools/activity.ts";
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
        expect(() => parseDiceNotation(c.input)).toThrow(new DiceParseError(c.err as string));
      }
    },
  );

  // Spelled out because they are the three details a rewrite gets wrong, and
  // the table above would still pass if two of them cancelled out.
  // `d-6` fails as *sides* `-6` rather than parsing as a modifier, and `d+6`
  // is a plain `1d6` — because the sides parser accepts the leading `+` that
  // the modifier scan declined to claim. The two spellings land in different
  // places for the same reason.
  test("a sign at position 0 belongs to the sides, not the modifier", () => {
    expect(() => parseDiceNotation("d-6")).toThrow("Invalid sides: -6");
    expect(parseDiceNotation("d+6")).toEqual({ count: 1, sides: 6, modifier: 0 });
  });

  // `Number("-0")` is `-0`, a value Rust's `i32` has no spelling for.
  test("a negative zero modifier is plain zero", () => {
    const parsed = parseDiceNotation("2d6-0");
    expect(parsed.modifier).toBe(0);
    expect(Object.is(parsed.modifier, -0)).toBe(false);
  });

  test("Rust's integer parsers accept a leading + and reject everything else", () => {
    expect(parseDiceNotation("+2d6")).toEqual({ count: 2, sides: 6, modifier: 0 });
    expect(() => parseDiceNotation("-2d6")).toThrow("Invalid dice count: -2");
    // Number("") is 0 and parseInt("2.5") is 2; both are parse failures here.
    expect(() => parseDiceNotation("2.5d6")).toThrow("Invalid dice count: 2.5");
    expect(() => parseDiceNotation("2d6.5")).toThrow("Invalid sides: 6.5");
  });

  test("trimming happens once, up front", () => {
    expect(parseDiceNotation("  2D6+3  ")).toEqual({ count: 2, sides: 6, modifier: 3 });
    expect(() => parseDiceNotation("2 d 6")).toThrow("Invalid dice count: 2 ");
    expect(() => parseDiceNotation("2d6 +3")).toThrow("Invalid sides: 6 ");
  });

  test("integer bounds are the Rust type's, not JavaScript's", () => {
    expect(parseDiceNotation("4294967295d6").count).toBe(4_294_967_295);
    expect(() => parseDiceNotation("4294967296d6")).toThrow("Invalid dice count: 4294967296");
    expect(parseDiceNotation("1d6+2147483647").modifier).toBe(2_147_483_647);
    expect(() => parseDiceNotation("1d6+2147483648")).toThrow("Invalid modifier: +2147483648");
    expect(parseDiceNotation("1d6-2147483648").modifier).toBe(-2_147_483_648);
    expect(() => parseDiceNotation("1d6-2147483649")).toThrow("Invalid modifier: -2147483649");
  });
});

describe("executeDiceRoll", () => {
  // The roll is random, so the fixture records invariants and the observed
  // span rather than values. 500 draws per case, same as the generator.
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
    // The Rust saw the whole range over 500 draws of a die this small; so
    // should this, which is what stops a constant implementation passing.
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
    expect(() => handleRollDice({})).toThrow(fx.handle_roll_dice["missing_notation"]?.err as string);
  });

  // `as_str()` returns None for a non-string, which lands on the same arm as
  // an absent key — so a numeric notation reports as *missing*, not as a type
  // error. Reproduced rather than tidied.
  test("a non-string notation reports as missing", () => {
    expect(() => handleRollDice({ notation: 6 })).toThrow(
      fx.handle_roll_dice["notation_not_a_string"]?.err as string,
    );
  });

  test("a parse failure is wrapped, keeping the inner message", () => {
    expect(() => handleRollDice({ notation: "abc" })).toThrow(
      fx.handle_roll_dice["parse_failure_is_wrapped"]?.err as string,
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

  // The two spellings `Date.toISOString()` gets wrong.
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

  test("a wired tracker is reshaped, not recomputed", () => {
    const stats = {
      engagementScore: 0.75,
      consistency: 0.5,
      tempoScore: 0.9,
      sessionCount: 4,
      sessionsPerDay: 1.25,
      hourHistogram: Array.from({ length: 24 }, (_u, h) => (h === 9 ? 1.0 : 0.0)),
      hourClassifications: Array.from({ length: 24 }, (_u, h) =>
        h === 9 ? ("peak" as const) : ("normal" as const),
      ),
      hasSufficientData: true,
      hasSufficientHeatmap: true,
      medianSessionGap: 3600,
      anomalyZScore: undefined,
      computedAt: 0,
    };
    const out = handleActivityHeatmap({ days: 7 }, () => ({ stats, turnCount: 42 }));
    expect(out.days).toBe(7);
    expect(out.hours[9]).toEqual({ hour: 9, density: 1.0, classification: "peak" });
    expect(out.hours[0]).toEqual({ hour: 0, density: 0.0, classification: "normal" });
    expect(out.total_messages).toBe(42);
    expect(out.total_turns).toBe(42);
    expect(out.has_sufficient_data).toBe(true);
    expect(out.engagement_score).toBe(0.75);
    expect(out.sessions_per_day).toBe(1.25);
  });

  // `.get(h)` with a default in the Rust: a short histogram degrades rather
  // than failing the tool.
  test("a truncated histogram degrades to zero and normal", () => {
    const stats = {
      engagementScore: 0,
      consistency: 0,
      tempoScore: 0,
      sessionCount: 0,
      sessionsPerDay: 0,
      hourHistogram: [0.5],
      hourClassifications: ["peak" as const],
      hasSufficientData: false,
      hasSufficientHeatmap: false,
      medianSessionGap: undefined,
      anomalyZScore: undefined,
      computedAt: 0,
    };
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
    await expect(handleModelHistory({}, "poppy", undefined)).rejects.toThrow(
      "io: the usage ledger is not available in this context",
    );
  });

  test("an empty character is an argument error", async () => {
    await expect(handleModelHistory({}, "", async () => [])).rejects.toThrow(
      "invalid args: model history is not configured",
    );
  });

  test("a reversed range is rejected", async () => {
    await expect(
      handleModelHistory(
        { start_time: "2026-06-01T00:00:00Z", end_time: "2026-05-01T00:00:00Z" },
        "poppy",
        async () => [],
      ),
    ).rejects.toThrow("invalid args: start_time must be before or equal to end_time");
  });

  // The comparison runs after the UTC rebase, so a range that only looks
  // reversed in its written offsets is accepted.
  test("the range check runs on the rebased bounds", async () => {
    const out = await handleModelHistory(
      { start_time: "2026-05-13T09:00:00+10:00", end_time: "2026-05-13T00:00:00Z" },
      "poppy",
      async () => [],
    );
    expect(out.time_range.start_time).toBe("2026-05-12T23:00:00+00:00");
    expect(out.time_range.end_time).toBe("2026-05-13T00:00:00+00:00");
  });

  test("rows are shaped and classified", async () => {
    const out = await handleModelHistory({}, "poppy", async () => rows);
    expect(out.character).toBe("poppy");
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
    // A row for a deleted feature still classifies rather than throwing: the
    // ledger keeps historical rows and they do not stop existing.
    expect(out.models[1]?.kind).toBe("background");
  });

  test("the bounds reach the query already rebased", async () => {
    let seen: [string | undefined, string | undefined] = [undefined, undefined];
    await handleModelHistory(
      { start_time: "2026-05-13T09:00:00+10:00" },
      "poppy",
      async (_c, since, until) => {
        seen = [since, until];
        return [];
      },
    );
    expect(seen).toEqual(["2026-05-12T23:00:00+00:00", undefined]);
  });
});
