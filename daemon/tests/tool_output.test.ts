import { expect, test } from "bun:test";

import { Texts } from "../src/texts/texts.ts";
import { formatToolOutput } from "../src/tools/output.ts";
import { payloadText } from "../src/tools/media.ts";
import type { BashResult } from "../src/tools/bash.ts";
import type { HeatmapResult } from "../src/tools/activity.ts";
import type { ModelHistoryResult } from "../src/tools/model_history.ts";

const bash = (changed: string[]): BashResult => ({ exit_code: 0, workdir: "/w", stdout: "hi\n", stderr: "", prompt_files_changed: changed });

test("a bash result says which prompt files it changed, and nothing of it when none were or the note is switched off", () => {
  expect(formatToolOutput(new Texts(), "bash", bash(["SOUL.md"]))).toBe("bash: exit 0\nworkdir: /w\nhi\nPrompt reload queued: SOUL.md.");
  expect(formatToolOutput(new Texts(), "bash", bash(["SOUL.md", "USER.md"])).split("\n").at(-1)).toBe("Prompt reload queued: SOUL.md, USER.md.");
  expect(formatToolOutput(new Texts(), "bash", bash([]))).toBe("bash: exit 0\nworkdir: /w\nhi");
  expect(formatToolOutput(new Texts({ prompt_reload: false }), "bash", bash(["SOUL.md"]))).toBe("bash: exit 0\nworkdir: /w\nhi");
});

test("an activity heatmap and a model history with nothing in them say so", () => {
  const heatmap = { days: 7, messages_in_window: 0, total_messages: 5, has_sufficient_data: false, engagement_score: 0, sessions_per_day: 0, hours: [], weekdays: [] } as unknown as HeatmapResult;
  expect(formatToolOutput(new Texts(), "activity_heatmap", heatmap)).toBe("Activity over 7 days: 0 messages (5 total)\nNo activity data in this window.");
  const history = { character: "ada", time_zone: "UTC", time_range: {}, models: [] } as unknown as ModelHistoryResult;
  expect(formatToolOutput(new Texts(), "model_history", history)).toBe("Model history for ada (UTC)\nNo model usage in this range.");
});

test("an activity heatmap lists each hour's and weekday's share, and says when there is too little to go on", () => {
  const heatmap = {
    days: 30, messages_in_window: 120, total_messages: 400, has_sufficient_data: true, engagement_score: 0.4567, sessions_per_day: 1.235,
    hours: [{ hour: 7, density: 0.0412, classification: "quiet" }, { hour: 21, density: 0.2, classification: "peak" }],
    weekdays: [{ weekday: "Mon", message_count: 12, density: 0.1 }, { weekday: "Sat", message_count: 1234, density: 0.3456 }],
  } as unknown as HeatmapResult;
  const shown = [
    "Activity over 30 days: 120 messages (400 total)",
    "Engagement: 0.46; sessions/day: 1.24",
    "",
    "Hour  Share   Activity",
    "07      4.1%  quiet",
    "21     20.0%  peak",
    "",
    "Day  Messages  Share",
    "Mon        12  10.0%",
    "Sat      1234  34.6%",
  ];
  expect(formatToolOutput(new Texts(), "activity_heatmap", heatmap)).toBe(shown.join("\n"));
  expect(formatToolOutput(new Texts(), "activity_heatmap", { ...heatmap, has_sufficient_data: false })).toBe([shown[0], "Insufficient data for reliable activity patterns.", ...shown.slice(1)].join("\n"));
});

test("a model history shows the range it covers, from the earliest or to the latest when one end is open, and a row for each model on one line", () => {
  const row = { model: "claude-sonnet-5-5", provider: "anthropic", call_type: "message", kind: "interactive", first_seen: "2026-11-01T10:00:00+00:00", last_seen: "2026-11-02T10:00:00+00:00", calls: 12 };
  const history = (time_range: object, character = "ada") => ({ character, time_zone: "UTC", time_range: { inclusive: true, ...time_range }, models: [row], count: 1 }) as unknown as ModelHistoryResult;
  const table = "\n\nModel | Provider | Call type | Kind | Calls | First seen | Last seen\nclaude-sonnet-5-5 | anthropic | message | interactive | 12 | 2026-11-01T10:00:00+00:00 | 2026-11-02T10:00:00+00:00";
  expect(formatToolOutput(new Texts(), "model_history", history({}))).toBe(`Model history for ada (UTC)${table}`);
  expect(formatToolOutput(new Texts(), "model_history", history({ start_time: "2026-11-01T00:00:00+00:00" }))).toBe(`Model history for ada (UTC)\n2026-11-01T00:00:00+00:00 to latest (inclusive)${table}`);
  expect(formatToolOutput(new Texts(), "model_history", history({ end_time: "2026-11-03T00:00:00+00:00" }))).toBe(`Model history for ada (UTC)\nearliest to 2026-11-03T00:00:00+00:00 (inclusive)${table}`);
  expect(formatToolOutput(new Texts(), "model_history", history({}, "ada\nthe second"))).toStartWith("Model history for ada\\nthe second (UTC)");
});

test("a bash result that isn't an object is shown as it came, and one with errors shows them after its output", () => {
  expect(["done", null, ["a", 1]].map((value) => formatToolOutput(new Texts(), "bash", value))).toEqual(["done", payloadText(null), payloadText(["a", 1])]);
  expect(formatToolOutput(new Texts(), "bash", { ...bash([]), exit_code: 2, stderr: "oops\n" })).toBe("bash: exit 2\nworkdir: /w\nhi\nstderr:\noops");
  expect(formatToolOutput(new Texts(), "bash", { ...bash([]), stdout: "\n", stderr: "\n" })).toBe("bash: exit 0\nworkdir: /w\n\nstderr:\n");
  expect(formatToolOutput(new Texts(), "bash", { ...bash([]), exit_code: null, stdout: "" })).toBe("bash: exit terminated by signal\nworkdir: /w");
  expect(formatToolOutput(new Texts(), "threads", { started: "garden" })).toBe(payloadText({ started: "garden" }));
});
