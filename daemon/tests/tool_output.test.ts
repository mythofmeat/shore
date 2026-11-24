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
  const heatmap = { days: 7, messages_in_window: 0, total_messages: 5 } as unknown as HeatmapResult;
  expect(formatToolOutput(new Texts(), "activity_heatmap", heatmap)).toBe("Activity over 7 days: 0 messages (5 total)\nNo activity data in this window.");
  const history = { character: "ada", time_zone: "UTC", time_range: {}, models: [] } as unknown as ModelHistoryResult;
  expect(formatToolOutput(new Texts(), "model_history", history)).toBe("Model history for ada (UTC)\nNo model usage in this range.");
});

test("a bash result that isn't an object is shown as it came, and one with errors shows them after its output", () => {
  expect(["done", null, ["a", 1]].map((value) => formatToolOutput(new Texts(), "bash", value))).toEqual(["done", payloadText(null), payloadText(["a", 1])]);
  expect(formatToolOutput(new Texts(), "bash", { ...bash([]), exit_code: 2, stderr: "oops\n" })).toBe("bash: exit 2\nworkdir: /w\nhi\nstderr:\noops");
  expect(formatToolOutput(new Texts(), "threads", { started: "garden" })).toBe(payloadText({ started: "garden" }));
});
