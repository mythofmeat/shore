import { describe, expect, test } from "bun:test";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { mergeToolLoopMessages } from "../src/engine/merge.ts";
import { SegmentReader } from "../src/engine/segments.ts";
import type { Message } from "../src/engine/types.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { handleSearchHistory } from "../src/tools/history.ts";
import { testTmp } from "./support/tmp.ts";

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
  expect(store.displayMessageCount("ada")).toBe(0);
  expect(store.displayTurnCount("ada")).toBe(0);
  store.recoverPending("ada", "before\n");
  expect(store.hasSegment("ada", aborted)).toBe(false);

  const committed = store.beginCompaction("ada", entry, messages, "before\n", "after\n");
  expect(store.segmentCount("ada")).toBe(0);
  store.recoverPending("ada", "after\n");
  expect(store.hasSegment("ada", committed)).toBe(true);
  expect(store.readSegment("ada", committed)).toEqual(messages);
  expect(store.displayMessageCount("ada")).toBe(1);
  expect(store.displayTurnCount("ada")).toBe(1);
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

  expect(access(join(characterDir, "threads", "main", "segments"))).rejects.toThrow();
  expect(access(join(characterDir, "threads", "main", "compaction.json"))).rejects.toThrow();
  const reader = await SegmentReader.load({
    dir: join(characterDir, "threads", "main"),
    dbPath,
    archiveKey: "ada",
    createHistoryDb: true,
  });
  expect(reader.segmentCount()).toBe(1);
  expect(await reader.readSegment(0)).toEqual(messages);
  reader.close();

  const search = await handleSearchHistory({ query: "hello" }, characterDir, {
    character: "ada",
    dbPath,
    timeZone: "Australia/Canberra",
  });
  expect(search.results).toEqual([
    {
      thread: "main", segment: 0, ordinal: 0,
      msg_id: "u1",
      role: "user",
      timestamp: "2026-08-13T10:00:00+10:00",
      model: null,
      text: "hello",
      locations: [{ thread: "main", segment: 0, ordinal: 0 }],
      before: [],
      after: [
        {
          thread: "main", segment: 0, ordinal: 1,
          msg_id: "a1",
          role: "assistant",
          timestamp: "2026-08-13T10:00:00+10:00",
          model: null,
          text: "hi",
        },
      ],
    },
  ]);
});



describe("storage-native display paging", () => {
  test("one display group can cross several archived segments", () => {
    const store = HistoryStore.openInMemory();
    const put = (idx: number, messages: Message[]) => {
      store.putSegment(
        "ada",
        idx,
        {
          file: HISTORY_DB_FILE,
          message_count: messages.length,
          compacted_at: "2026-08-13T10:01:00+10:00",
        },
        messages,
      );
    };
    put(0, [message("u1", "hello"), toolAssistant("a1", "t1")]);
    put(1, [toolResult("r1", "t1"), toolAssistant("a2", "t2")]);
    put(2, [toolResult("r2", "t2"), message("a3", "done"), message("u2", "next")]);

    expect(store.displayMessageCount("ada")).toBe(3);
    expect(store.displayTurnCount("ada")).toBe(2);
    expect(store.displayStartForTurns("ada", 3, 1)).toBe(2);
    expect(store.displayStartForTurns("ada", 3, 2)).toBe(0);

    const slice = store.readDisplayRange("ada", 1, 2);
    expect(slice.messages.map((entry) => entry.msg_id)).toEqual(["a1", "r1", "a2", "r2", "a3"]);
    expect(mergeToolLoopMessages(slice.messages).map((entry) => entry.msg_id)).toEqual(["a3"]);
    expect(slice.metrics.rows_read).toBe(5);
    expect(slice.metrics.segments_read).toBe(3);
    expect(slice.metrics.decoded_body_bytes).toBeGreaterThan(0);
    store.close();
  });

  test("a page reads the same bounded rows in a short and a long archive", () => {
    const measure = (segments: number) => {
      const store = HistoryStore.openInMemory();
      for (let idx = 0; idx < segments; idx += 1) {
        store.putSegment(
          "ada",
          idx,
          {
            file: HISTORY_DB_FILE,
            message_count: 2,
            compacted_at: "2026-08-13T10:01:00+10:00",
          },
          [message(`u${String(idx).padStart(4, "0")}`, "prompt"), message(`a${String(idx).padStart(4, "0")}`, "reply")],
        );
      }
      const end = store.displayMessageCount("ada");
      const slice = store.readDisplayRange("ada", end - 8, end);
      store.close();
      return slice.metrics;
    };

    const short = measure(10);
    const long = measure(250);
    expect(short).toEqual(long);
    expect(long.rows_read).toBe(8);
    expect(long.segments_read).toBe(4);
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
