import { expect, test } from "bun:test";
import { recordToolActivity } from "../src/browser/tool_activity.ts";

test("manual progress replaces each tool's state, separates nested streams and bounds retained text", () => {
  let activity = recordToolActivity([], { type: "tool_call", tool_id: "1", tool_name: "read", input: {} });
  expect(activity[0]?.label).toBe("Running read");
  activity = recordToolActivity(activity, { type: "tool_result", tool_id: "1", tool_name: "read", is_error: true, output: "No file" });
  expect(activity).toHaveLength(1); expect(activity[0]?.label).toBe("Failed read");
  for (const [subagent, text] of [["one", "First "], ["two", "Second"], ["one", "worker"]] as const) activity = recordToolActivity(activity, { type: "stream_chunk", subagent, task_id: "task", content_type: "text", text });
  expect(activity.find((item) => item.label === "one · response")?.text).toBe("First worker");
  expect(activity.find((item) => item.label === "two · response")?.text).toBe("Second");
  activity = recordToolActivity(activity, { type: "phase", phase: "Running", model: "Model" });
  expect(activity.at(-1)?.text).toBe("Model");
  for (let index = 0; index < 100; index++) activity = recordToolActivity(activity, { type: "tool_result", tool_id: String(index), tool_name: "read", is_error: false, output: "a".repeat(20000) + "last" });
  expect(activity).toHaveLength(64);
  expect(activity.every((item) => item.text.length <= 16000)).toBe(true);
  expect(activity.at(-1)?.text.endsWith("last")).toBe(true);
});
