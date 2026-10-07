import { required } from "../src/util/required.ts";
import { describe, expect, test } from "bun:test";
import { handleActivityHeatmap } from "../src/tools/activity.ts";
import { formatToolOutput } from "../src/tools/output.ts";

describe("compact built-in output", () => {
  test("no activity does not produce zero-filled tables", () => {
    expect(formatToolOutput("activity_heatmap", handleActivityHeatmap({}, () => undefined)))
      .toBe("Activity over 30 days: 0 messages (0 total)\nNo activity data in this window.");
  });

  test("activity rows have readable percentages and retain insufficient-data notices", () => {
    const value = handleActivityHeatmap({}, () => undefined);
    value.messages_in_window = 2;
    value.total_messages = 10;
    required(value.hours[0]).density = 0.5;
    const output = formatToolOutput("activity_heatmap", value);
    expect(output).toContain("Insufficient data");
    expect(output).toContain("00     50.0%  normal");
    expect(output.split("\n")).toHaveLength(38);
  });

  test("model usage is one row per record, preserving provider, call type and range", () => {
    const output = formatToolOutput("model_history", {
      character: "heidi", time_zone: "UTC", time_range: { start_time: "2026-01-01", inclusive: true },
      models: [{ model: "example", provider: "local", call_type: "tool_loop", kind: "interactive", calls: 12, first_seen: "2026-01-01", last_seen: "2026-01-02" }],
    });
    expect(output).toContain("2026-01-01 to latest (inclusive)");
    expect(output).toContain("example | local | tool_loop | interactive | 12 | 2026-01-01 | 2026-01-02");
    expect(output.split("\n")).toHaveLength(5);
  });

  test("MCP objects and small receipts retain their existing serialization", () => {
    const result = { content: [{ type: "text", text: "hello" }], count: 3 };
    expect(formatToolOutput("mcp__test__search", result)).toBe(JSON.stringify(result));
    expect(formatToolOutput("mcp__test__write", { path: "a", bytes_written: 5 })).toBe('{"path":"a","bytes_written":5}');
    expect(formatToolOutput("mcp__test__list", "workspace/\n└── a")).toBe("workspace/\n└── a");
  });
});
