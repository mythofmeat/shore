import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";

import rawFixture from "./tools_captures/tool_handlers.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);
import { handleActivityHeatmap } from "../src/tools/activity.ts";
import type { ActivityStats, HourClassification } from "../src/autonomy/activity.ts";
import { handleModelHistory, kindFor, utcBound } from "../src/tools/model_history.ts";
import { outcomeOf } from "./support/outcome.ts";

const fx = fixture as unknown as {
  kind_for: { call_type: string; kind: string }[];
  utc_bound: { input: Record<string, unknown>; ok?: string | null; err?: string }[];
  activity_heatmap_empty: Record<string, { input: Record<string, unknown>; output: unknown }>;
};

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
    expect(await outcomeOf(handleModelHistory({}, "frank", undefined))).toThrow(
      "io: the usage ledger is not available in this context",
    );
  });

  test("an empty character is an argument error", async () => {
    expect(await outcomeOf(handleModelHistory({}, "", async () => []))).toThrow(
      "invalid args: model history is not configured",
    );
  });

  test("a reversed range is rejected", async () => {
    expect(
      await outcomeOf(handleModelHistory(
        { start_time: "2026-06-01T00:00:00Z", end_time: "2026-05-01T00:00:00Z" },
        "frank",
        async () => [],
      )),
    ).toThrow("invalid args: start_time must be before or equal to end_time");
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
