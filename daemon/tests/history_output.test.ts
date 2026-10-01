import { expect, test } from "bun:test";
import type { HistoryHit, HistoryMessage, SearchHistoryResult } from "../src/tools/history.ts";
import { formatToolOutput } from "../src/tools/output.ts";

function message(ordinal: number, thread = "main"): HistoryMessage {
  return { thread, segment: 0, ordinal, msg_id: `m${ordinal}`, timestamp: "2026-09-01T12:00:00+00:00", role: "user", model: null, text: `Message ${ordinal}\n\nSecond paragraph.` };
}

function hit(ordinal: number, thread = "main"): HistoryHit {
  return { ...message(ordinal, thread), locations: [{ thread, segment: 0, ordinal }], before: [message(ordinal - 1, thread)], after: [message(ordinal + 1, thread)] };
}

function result(hits: HistoryHit[]): SearchHistoryResult {
  return {
    mode: "lexical", semantic_index: { indexed_chunks: 0, total_chunks: 0, pending_chunks: 0 },
    query: "Message", time_zone: "UTC", now: "2026-09-06T00:00:00+00:00",
    archive_boundary: { oldest: "2026-09-01T00:00:00+00:00", newest: "2026-09-02T00:00:00+00:00" },
    time_range: { start_time: null, end_time: null, inclusive: true }, model_filter: null,
    results: hits.map((item) => ({ ...item })), count: hits.length, searched_message_occurrences: 7, searched_messages: 7, skipped_invalid_timestamps: 0,
  };
}

test("overlapping history windows merge even when a lower-ranked hit bridges two blocks", () => {
  const output = formatToolOutput("search_chat_logs", result([hit(1), hit(5), hit(3)]));
  expect(output.match(/Thread "main"/g)).toHaveLength(1);
  for (let ordinal = 0; ordinal < 7; ordinal += 1) {
    expect(output.match(new RegExp(`Message ${ordinal}`, "g"))).toHaveLength(1);
    if (ordinal > 0) expect(output.indexOf(`Message ${ordinal}`)).toBeGreaterThan(output.indexOf(`Message ${ordinal - 1}`));
  }
  expect(output.match(/— match/g)).toHaveLength(3);
  expect(output).toContain('0:3 id="m3"');
  expect(output).toContain("Message 3\n\nSecond paragraph.");
});

test("identical messages at different locations are distinct events and different threads retain their context", () => {
  const first = hit(1);
  const second = { ...hit(5), text: first.text, msg_id: first.msg_id };
  first.locations.push({ thread: "fork", segment: 0, ordinal: 1 });
  const output = formatToolOutput("search_chat_logs", result([first, second, hit(1, "other")]));
  expect(output.match(/Message 1\n/g)).toHaveLength(3);
  expect(output).toContain('Also archived at: "fork" 0:1');
  expect(output).toContain('Thread "other"');
});

test("the header counts one match as one match", () => {
  expect(formatToolOutput("search_chat_logs", result([hit(1)])).split("\n")[0]).toBe("Chat history: 1 match (lexical; UTC)");
  expect(formatToolOutput("search_chat_logs", result([hit(1), hit(5)])).split("\n")[0]).toBe("Chat history: 2 matches (lexical; UTC)");
  expect(formatToolOutput("search_chat_logs", result([])).split("\n")[0]).toBe("Chat history: 0 matches (lexical; UTC)");
});

test("empty and partial history results retain the facts needed to interpret them", () => {
  const value = result([]);
  value.semantic_unavailable = "embedder offline";
  value.semantic_index.pending_chunks = 12;
  value.skipped_invalid_timestamps = 2;
  value.has_more = true;
  const output = formatToolOutput("search_chat_logs", value);
  expect(output).toContain("Active conversation messages are not searched");
  expect(output).toContain("Archive: 2026-09-01");
  expect(output).toContain("now: 2026-09-06");
  expect(output).toContain("12 chunks pending");
  expect(output).toContain("embedder offline");
  expect(output).toContain("2 messages skipped");
  expect(output).toContain("More matches available");
});
