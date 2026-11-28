import { expect, test } from "bun:test";

import { Texts } from "../src/texts/texts.ts";
import { handleModelHistory, type ModelHistoryQuery } from "../src/tools/model_history.ts";
import { outcomeOf } from "./support/outcome.ts";

function ledger() {
  const asked: [string, string | undefined, string | undefined][] = [];
  const query: ModelHistoryQuery = async (character, since, until) => {
    asked.push([character, since, until]);
    return [
      { model: "claude-sonnet-5-5", provider: "anthropic", call_type: "message", first_ts: "2026-11-01T09:00:00Z", last_ts: "2026-11-02T09:00:00Z", call_count: 12 },
      { model: "claude-sonnet-5-5", provider: "anthropic", call_type: "tool_loop", first_ts: "2026-11-01T09:01:00Z", last_ts: "2026-11-01T09:02:00Z", call_count: 3 },
      { model: "claude-opus-5-5", provider: "anthropic", call_type: "wake", first_ts: "2026-11-01T23:30:00Z", last_ts: "2026-11-01T23:30:00Z", call_count: 1 },
      { model: "claude-opus-5-5", provider: "anthropic", call_type: "wake_tool_loop", first_ts: "2026-11-01T23:31:00Z", last_ts: "2026-11-01T23:31:00Z", call_count: 2 },
      { model: "claude-haiku-5-5", provider: "anthropic", call_type: "label", first_ts: "2026-11-01T12:00:00Z", last_ts: "2026-11-01T12:00:00Z", call_count: 1 },
    ];
  };
  return { asked, query };
}

const sinceAsked = async (start_time: string): Promise<string | undefined> => {
  const { asked, query } = ledger();
  await handleModelHistory(new Texts(), { start_time }, "ada", query, "UTC");
  return asked[0]?.[1];
};

test("model history lists each model and kind of call, with when it was first and last used in the user's time zone", async () => {
  const { asked, query } = ledger();
  const result = await handleModelHistory(new Texts(), { start_time: "2026-11-01T10:00:00Z", end_time: "2026-11-02T10:00:00Z" }, "ada", query, "Europe/Berlin");
  expect(asked).toEqual([["ada", "2026-11-01T10:00:00+00:00", "2026-11-02T10:00:00+00:00"]]);
  expect(result).toEqual({
    character: "ada",
    time_zone: "Europe/Berlin",
    time_range: { start_time: "2026-11-01T11:00:00+01:00", end_time: "2026-11-02T11:00:00+01:00", inclusive: true },
    models: [
      { model: "claude-sonnet-5-5", provider: "anthropic", call_type: "message", kind: "interactive", first_seen: "2026-11-01T10:00:00+01:00", last_seen: "2026-11-02T10:00:00+01:00", calls: 12 },
      { model: "claude-sonnet-5-5", provider: "anthropic", call_type: "tool_loop", kind: "interactive", first_seen: "2026-11-01T10:01:00+01:00", last_seen: "2026-11-01T10:02:00+01:00", calls: 3 },
      { model: "claude-opus-5-5", provider: "anthropic", call_type: "wake", kind: "autonomous", first_seen: "2026-11-02T00:30:00+01:00", last_seen: "2026-11-02T00:30:00+01:00", calls: 1 },
      { model: "claude-opus-5-5", provider: "anthropic", call_type: "wake_tool_loop", kind: "autonomous", first_seen: "2026-11-02T00:31:00+01:00", last_seen: "2026-11-02T00:31:00+01:00", calls: 2 },
      { model: "claude-haiku-5-5", provider: "anthropic", call_type: "label", kind: "background", first_seen: "2026-11-01T13:00:00+01:00", last_seen: "2026-11-01T13:00:00+01:00", calls: 1 },
    ],
    count: 5,
  });
});

test("model history with no times asks the ledger for everything and says so", async () => {
  const { asked, query } = ledger();
  const result = await handleModelHistory(new Texts(), {}, "ada", query, "UTC");
  expect(asked).toEqual([["ada", undefined, undefined]]);
  expect(result.time_range).toEqual({ start_time: undefined, end_time: undefined, inclusive: true });
});

test("model history asks the ledger in UTC whatever offset a time was given in, keeping its fraction of a second", async () => {
  expect(await sinceAsked("2026-11-01T10:00:00+00:00")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("2026-11-01T12:30:00+02:30")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("2026-11-01T15:45:00+05:45")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("2026-11-01T06:30:00-03:30")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("2026-11-01T01:00:00+02:00")).toBe("2026-10-31T23:00:00+00:00");
  expect(await sinceAsked("2026-11-01T21:30:00+11:30")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("2026-10-31T22:00:00-12:00")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("2026-11-01T05:15:30.5-04:45")).toBe("2026-11-01T10:00:30.500+00:00");
  expect(await sinceAsked("2026-11-01T10:00:00.120z")).toBe("2026-11-01T10:00:00.120+00:00");
  expect(await sinceAsked("2026-11-01t10:00:00.1234Z")).toBe("2026-11-01T10:00:00.123400+00:00");
  expect(await sinceAsked("2026-11-01T10:00:00.000Z")).toBe("2026-11-01T10:00:00+00:00");
  expect(await sinceAsked("  ")).toBeUndefined();
});

test("model history refuses a time that isn't RFC3339, a start after the end, and a call with no ledger or no character", async () => {
  const { query } = ledger();
  const texts = new Texts();
  expect(await outcomeOf(handleModelHistory(texts, { start_time: "2026-11-01" }, "ada", query))).toThrow("invalid args: start_time must be an RFC3339 timestamp: premature end of input");
  expect(await outcomeOf(handleModelHistory(texts, { end_time: "yesterday" }, "ada", query))).toThrow("invalid args: end_time must be an RFC3339 timestamp: premature end of input");
  expect(await outcomeOf(handleModelHistory(texts, { start_time: "2026-11-02T00:00:00Z", end_time: "2026-11-01T23:59:59Z" }, "ada", query))).toThrow("invalid args: start_time must be before or equal to end_time");
  expect((await handleModelHistory(texts, { start_time: "2026-11-01T10:00:00Z", end_time: "2026-11-01T12:00:00+02:00" }, "ada", query, "UTC")).count).toBe(5);
  expect(await outcomeOf(handleModelHistory(texts, {}, "ada", undefined))).toThrow("the usage ledger is not available in this context");
  expect(await outcomeOf(handleModelHistory(texts, {}, "", query))).toThrow("invalid args: model history is not configured");
});
