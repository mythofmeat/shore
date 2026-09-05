import { required } from "../src/util/required.ts";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleActivityHeatmap } from "../src/tools/activity.ts";
import { formatToolOutput } from "../src/tools/output.ts";
import { handleRead, handleSearch } from "../src/tools/workspace.ts";

describe("compact built-in output", () => {
  test("groups excerpts without repeating paths or ranking diagnostics, retaining limitations", () => {
    expect(formatToolOutput("search", {
      query: "tea", mode: "hybrid", results: [
        { path: "memory/tea.md", line: 2, excerpt: "Green tea", lexical_score: 0.12345 },
        { path: "memory/tea.md", line: 5, excerpt: "Black tea", semantic_score: 0.67890 },
      ],
      has_more: true, pending_files: 3, skipped_binary_or_large: 2,
      semantic_unavailable: "index unavailable",
    })).toBe('Search "tea" (hybrid): 2 results\n\nmemory/tea.md\n  2: Green tea\n  5: Black tea\nMore matches available. Increase max_results (up to 100) or narrow query/path.\nSemantic search unavailable: index unavailable\n3 files pending semantic indexing.\n2 binary or oversized files skipped.');
  });

  test("keeps web source URLs, multiline snippets, and identifies provider summaries", () => {
    expect(formatToolOutput("web_search", {
      query: "tea", answer: "A provider summary", results: [
        { title: "Tea", url: "https://example.com/tea", content: "First paragraph\nSecond paragraph" },
      ],
    })).toBe('Web search "tea": 1 results\n\nSearch provider summary: A provider summary\n\n1. Tea\nhttps://example.com/tea\nFirst paragraph\nSecond paragraph');
  });

  test("keeps Git failure status and stderr, without echoed arguments or empty fields", () => {
    expect(formatToolOutput("git", { exit_code: 1, stdout: "", stderr: "fatal: bad revision\n", args: ["bad"] }))
      .toBe("git: exit 1\nstderr:\nfatal: bad revision");
    expect(formatToolOutput("git", { exit_code: 0, stdout: "diff --git a/a b/a\n+hello\n", stderr: "" }))
      .toBe("git: exit 0\ndiff --git a/a b/a\n+hello");
  });

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
      character: "qifei", time_zone: "UTC", time_range: { start_time: "2026-01-01", inclusive: true },
      models: [{ model: "example", provider: "local", call_type: "tool_loop", kind: "interactive", calls: 12, first_seen: "2026-01-01", last_seen: "2026-01-02" }],
    });
    expect(output).toContain("2026-01-01 to latest (inclusive)");
    expect(output).toContain("example | local | tool_loop | interactive | 12 | 2026-01-01 | 2026-01-02");
    expect(output.split("\n")).toHaveLength(5);
  });

  test("MCP objects and small receipts retain their existing serialization", () => {
    const result = { content: [{ type: "text", text: "hello" }], count: 3 };
    expect(formatToolOutput("mcp__test__search", result)).toBe(JSON.stringify(result));
    expect(formatToolOutput("edit", { path: "a", bytes_written: 5 })).toBe('{"path":"a","bytes_written":5}');
    expect(formatToolOutput("read", "workspace/\n└── a")).toBe("workspace/\n└── a");
  });
});

test("real searches distinguish an exact limit from omitted matches, and reads preserve line numbers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "shore-output-"));
  try {
    await writeFile(join(workspace, "tea.md"), "tea one\ntea two\ncoffee");
    const search = async (max_results: number) => await handleSearch({ query: "tea", mode: "lexical", max_results }, workspace, undefined, undefined);
    expect(formatToolOutput("search", await search(1))).toContain("More matches available");
    expect(formatToolOutput("search", await search(2))).not.toContain("More matches available");
    const read = await handleRead({ path: "tea.md", offset: 2, limit: 1 }, workspace);
    expect(formatToolOutput("read", read)).toBe("tea.md: lines 2–2 of 3\n2: tea two\nShowing lines 2–2 of 3. Use offset=3 to continue.");
    expect(formatToolOutput("read", await handleRead({ path: "tea.md", limit: 0 }, workspace))).toContain("no lines returned");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
