import { describe, expect, test } from "bun:test";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { SegmentReader, presentSegment } from "../src/engine/segments.ts";
import type { Message } from "../src/engine/types.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { handleReadChatLogs, handleSearchChatLogs } from "../src/tools/history.ts";
import { testTmp } from "./support/tmp.ts";
import { required } from "../src/util/required.ts";
import { outcomeOf } from "./support/outcome.ts";

function message(id: string, content: string): Message {
  return {
    msg_id: id,
    role: id.startsWith("u") ? "user" : "assistant",
    content,
    images: [],
    content_blocks: [{ type: "text", text: content }],
    timestamp: "2026-08-13T10:00:00+10:00",
  };
}

function toolAssistant(id: string, toolId: string): Message {
  return {
    ...message(id, ""),
    role: "assistant",
    content_blocks: [{ type: "tool_use", id: toolId, name: "search", input: { q: id } }],
  };
}

function toolResult(id: string, toolId: string): Message {
  return {
    ...message(id, "result"),
    role: "user",
    content_blocks: [{ type: "tool_result", tool_use_id: toolId, content: "result" }],
  };
}

test("canonical history round-trips message bodies and alternatives", () => {
  const store = HistoryStore.openInMemory();
  const assistant = message("a1", "selected");
  assistant.alt_index = 1;
  assistant.alt_count = 2;
  assistant.alternatives = [
    {
      content: "first",
      images: [],
      content_blocks: [{ type: "text", text: "first" }],
      timestamp: "2026-08-13T09:59:00+10:00",
    },
    {
      content: "selected",
      images: [],
      content_blocks: [{ type: "text", text: "selected" }],
      timestamp: assistant.timestamp,
    },
  ];

  store.putSegment(
    "ada",
    0,
    {
      file: "0001.jsonl",
      message_count: 2,
      compacted_at: "2026-08-13T10:01:00+10:00",
      compaction_id: "compact-1",
    },
    [message("u1", "hello"), assistant],
  );

  expect(store.readSegment("ada", 0)).toEqual([message("u1", "hello"), assistant]);
  expect(store.hasCompactionOperation("ada", "compact-1")).toBe(true);
  store.close();
});

test("pending compactions are hidden and recover from either side of the active-file write", () => {
  const store = HistoryStore.openInMemory();
  const entry = {
    file: HISTORY_DB_FILE,
    message_count: 1,
    compacted_at: "2026-08-13T10:01:00+10:00",
  };
  const messages = [message("u1", "hello")];

  const aborted = store.beginCompaction("ada", entry, messages, "before\n", "after\n");
  expect(store.segmentCount("ada")).toBe(0);
  expect(store.segmentDisplayBounds("ada", aborted)).toBeUndefined();
  expect(store.segmentTurnCount("ada", aborted)).toBe(0);
  store.recoverPending("ada", "before\n");
  expect(store.hasSegment("ada", aborted)).toBe(false);

  const committed = store.beginCompaction("ada", entry, messages, "before\n", "after\n");
  expect(store.segmentCount("ada")).toBe(0);
  store.recoverPending("ada", "after\n");
  expect(store.hasSegment("ada", committed)).toBe(true);
  expect(store.readSegment("ada", committed)).toEqual(messages);
  expect(store.segmentDisplayBounds("ada", committed)).toEqual({ start: 0, end: 1 });
  expect(store.segmentTurnCount("ada", committed)).toBe(1);
  store.close();
});


test("a compaction remains readable after its JSONL recovery copy is removed", async () => {
  const dataDir = testTmp(`history-durable-${crypto.randomUUID()}`);
  const characterDir = join(dataDir, "ada");
  const dbPath = join(dataDir, HISTORY_DB_FILE);
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const messages = [message("u1", "hello"), message("a1", "hi")];
  const active = messages.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

  await archiveAndRetain(
    join(characterDir, "threads", "main"),
    { dbPath, archiveKey: "ada" },
    0,
    active,
    () => "2026-08-13T10:01:00+10:00",
    () => "conversation-2",
    "compact-2",
  );

  expect(await outcomeOf(access(join(characterDir, "threads", "main", "segments")))).toThrow();
  expect(await outcomeOf(access(join(characterDir, "threads", "main", "compaction.json")))).toThrow();
  const reader = await SegmentReader.load({
    dir: join(characterDir, "threads", "main"),
    dbPath,
    archiveKey: "ada",
    createHistoryDb: true,
  });
  expect(reader.segmentCount()).toBe(1);
  expect(await reader.readSegment(0)).toEqual(messages);
  reader.close();

  const options = { character: "ada", dbPath, timeZone: "Australia/Canberra" };
  expect(await handleSearchChatLogs({ query: "hello", all_time: true }, characterDir, options)).toBe([
    "hello: 1 match, showing 1–1, best match first",
    "",
    "2026-08-13 Thu 10:00  user  [hello]  u1",
  ].join("\n"));
  expect(await handleReadChatLogs({ around: "u1" }, characterDir, options)).toBe([
    "u1 in main: 0 before, 1 after (Australia/Canberra)",
    "",
    "▶ 2026-08-13 Thu 10:00  user  u1",
    "hello",
    "",
    "2026-08-13 Thu 10:00  ada  a1",
    "hi",
  ].join("\n"));
});



describe("storage-native display paging", () => {
  const entry = (count: number) => ({
    file: HISTORY_DB_FILE,
    message_count: count,
    compacted_at: "2026-08-13T10:01:00+10:00",
  });

  test("a display group that crosses segments is read one segment at a time", () => {
    const store = HistoryStore.openInMemory();
    const put = (idx: number, messages: Message[]) => {
      store.putSegment("ada", idx, entry(messages.length), messages);
    };
    put(0, [message("u1", "hello"), toolAssistant("a1", "t1")]);
    put(1, [toolResult("r1", "t1"), toolAssistant("a2", "t2")]);
    put(2, [toolResult("r2", "t2"), message("a3", "done"), message("u2", "next")]);

    expect([0, 1, 2].map((idx) => store.segmentDisplayBounds("ada", idx))).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 2 },
      { start: 1, end: 3 },
    ]);
    expect([0, 1, 2].map((idx) => store.segmentTurnCount("ada", idx))).toEqual([1, 0, 1]);
    expect(store.segmentStartForTurns("ada", 2, 3, 1)).toBe(2);
    expect(store.segmentStartForTurns("ada", 2, 3, 2)).toBe(0);
    expect(store.segmentStartForTurns("ada", 0, 2, 1)).toBe(0);
    expect(store.segmentStartForTurns("ada", 0, 2, 0)).toBe(2);
    expect(store.segmentStartForTurns("ada", 2, 2, 1)).toBe(0);
    expect(store.readSegmentDisplayRange("ada", 0, 0, 1).messages.map((row) => row.msg_id)).toEqual(["u1"]);
    expect(store.readSegmentDisplayRange("ada", 1, 5, 9).metrics.segments_read).toBe(0);

    const middle = store.readSegmentDisplayRange("ada", 1, 1, 2);
    expect(middle.messages.map((row) => row.msg_id)).toEqual(["r1", "a2"]);
    expect(middle.metrics.rows_read).toBe(2);
    expect(middle.metrics.segments_read).toBe(1);
    expect(middle.metrics.decoded_body_bytes).toBeGreaterThan(0);

    const last = store.readSegmentDisplayRange("ada", 2, 1, 3);
    expect(last.messages.map((row) => row.msg_id)).toEqual(["r2", "a3", "u2"]);
    expect(store.readSegmentDisplayRange("ada", 2, 2, 2).messages).toEqual([]);
    store.close();
  });

  test("reading the newest segment costs the same in a short and a long archive", () => {
    const measure = (segments: number) => {
      const store = HistoryStore.openInMemory();
      for (let idx = 0; idx < segments; idx += 1) {
        store.putSegment(
          "ada",
          idx,
          entry(2),
          [message(`u${String(idx).padStart(4, "0")}`, "prompt"), message(`a${String(idx).padStart(4, "0")}`, "reply")],
        );
      }
      const newest = segments - 1;
      const bounds = store.segmentDisplayBounds("ada", newest);
      if (bounds === undefined) throw new Error("newest segment has no display rows");
      const slice = store.readSegmentDisplayRange("ada", newest, bounds.start, bounds.end);
      store.close();
      return slice.metrics;
    };

    const short = measure(10);
    const long = measure(250);
    expect(short).toEqual(long);
    expect(long.rows_read).toBe(2);
    expect(long.segments_read).toBe(1);
  });

  test("a turn budget larger than its segment does not run on into earlier ones", () => {
    const store = HistoryStore.openInMemory();
    for (const idx of [0, 1, 2]) store.putSegment("ada", idx, entry(2), [message(`u${String(idx)}`, "prompt"), message(`a${String(idx)}`, "reply")]);

    expect(store.segmentDisplayBounds("ada", 2)).toEqual({ start: 4, end: 6 });
    expect(store.segmentStartForTurns("ada", 2, 6, 1)).toBe(4);
    expect(store.segmentStartForTurns("ada", 2, 6, 2)).toBe(0);
    store.close();
  });

  test("a presented segment keeps its own times, label and exclusion", () => {
    const store = HistoryStore.openInMemory();
    store.putSegment("ada", 0, { ...entry(2), label: "trip", excluded: true }, [
      { ...message("u1", "out"), timestamp: "2026-09-28T10:00:00Z" },
      { ...message("a1", "back"), timestamp: "2026-10-01T22:00:00Z" },
    ]);

    expect(presentSegment(required(store.entry("ada", 0)))).toEqual({
      index: 0, first_message_at: "2026-09-28T10:00:00Z", last_message_at: "2026-10-01T22:00:00Z",
      compacted_at: "2026-08-13T10:01:00+10:00", message_count: 2, excluded: true, label: "trip",
      note: null, memory_before: null, memory_after: null,
    });
    store.close();
  });

  test("a segment with nothing to display has no bounds", () => {
    const store = HistoryStore.openInMemory();
    store.putSegment("ada", 0, entry(1), [message("u1", "hello")]);
    store.putSegment("ada", 1, entry(1), [toolResult("r9", "t9")]);

    expect(store.segmentDisplayBounds("ada", 1)).toBeUndefined();
    expect(store.segmentDisplayBounds("ada", 7)).toBeUndefined();
    expect(store.segmentDisplayBounds("bea", 0)).toBeUndefined();
    store.close();
  });

  test("segment lookups find neighbours in order and skip a pending compaction", () => {
    const store = HistoryStore.openInMemory();
    store.putSegment("ada", 0, entry(1), [message("u1", "one")]);
    store.putSegment("ada", 2, { ...entry(1), label: "trip" }, [message("u2", "two")]);
    store.putSegment("bea", 5, entry(1), [message("u3", "elsewhere")]);
    const pending = store.beginCompaction("ada", entry(1), [message("u4", "pending")], "before", "after");

    expect(pending).toBe(3);
    expect(store.entry("ada", 2)?.label).toBe("trip");
    expect(store.entry("ada", 1)).toBeUndefined();
    expect(store.entry("ada", pending)).toBeUndefined();
    expect(store.latestEntry("ada")?.idx).toBe(2);
    expect(store.entryBefore("ada", 2)?.idx).toBe(0);
    expect(store.entryBefore("ada", 0)).toBeUndefined();
    expect(store.entryAfter("ada", 0)?.idx).toBe(2);
    expect(store.entryAfter("ada", 2)).toBeUndefined();
    expect(store.latestEntry("cyd")).toBeUndefined();
    expect(store.entry("ada", 2)).toEqual(store.entries("ada")[1]);

    store.finishCompaction("ada", pending);
    expect(store.latestEntry("ada")?.idx).toBe(pending);
    expect(store.entryAfter("ada", 0)?.idx).toBe(2);
    expect(store.entryBefore("ada", pending)?.idx).toBe(2);
    expect(store.entryAfter("ada", 2)?.idx).toBe(pending);
    store.close();
  });
});

describe("archive revision", () => {
  const entry = (idx: number) => ({
    file: `000${idx}.jsonl`,
    message_count: 1,
    compacted_at: "2026-08-13T10:01:00+10:00",
    compaction_id: `compact-${idx}`,
  });

  test("the digest tracks archive content without rescanning it", () => {
    const store = HistoryStore.openInMemory();
    const empty = store.archiveDigest("ada");

    store.putSegment("ada", 0, entry(0), [message("u1", "hello")]);
    const afterFirst = store.archiveDigest("ada");
    expect(afterFirst).not.toBe(empty);

    expect(store.archiveDigest("ada")).toBe(afterFirst);

    store.putSegment("ada", 1, entry(1), [message("u2", "second")]);
    const afterSecond = store.archiveDigest("ada");
    expect(afterSecond).not.toBe(afterFirst);

    expect(store.setExcluded("ada", 1, true)).toBe(true);
    const afterExcluded = store.archiveDigest("ada");
    expect(afterExcluded).not.toBe(afterSecond);

    expect(store.setLabel("ada", 1, "nickname")).toBe(true);
    expect(store.archiveDigest("ada")).toBe(afterExcluded);

    store.close();
  });

  test("one character's writes do not invalidate another's digest", () => {
    const store = HistoryStore.openInMemory();
    store.putSegment("ada", 0, entry(0), [message("u1", "hello")]);
    const ada = store.archiveDigest("ada");

    store.putSegment("bo", 0, entry(0), [message("u1", "unrelated")]);
    store.putSegment("bo", 1, entry(1), [message("u2", "unrelated again")]);
    expect(store.archiveDigest("ada")).toBe(ada);

    store.close();
  });
});
