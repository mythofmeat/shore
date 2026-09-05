import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
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

test("archive retain work becomes visible only with the durable segment commit", () => {
  const store = HistoryStore.openInMemory();
  const messages = [message("u1", "hello")];
  const segment = store.beginCompaction(
    "ada",
    {
      file: HISTORY_DB_FILE,
      message_count: 1,
      compacted_at: "2026-08-13T10:01:00+10:00",
      retain: true,
    },
    messages,
    "before\n",
    "after\n",
  );

  expect(store.nextCharacterMemoryRetainJob("ada")).toBeUndefined();
  store.recoverPending("ada", "after\n");
  expect(store.nextCharacterMemoryRetainJob("ada")).toMatchObject({
    archiveKey: "ada",
    segment,
    action: "retain",
  });
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
    0,
    active,
    () => "2026-08-13T10:01:00+10:00",
    () => "conversation-2",
    "compact-2",
    { dbPath, archiveKey: "ada" },
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
      thread: "main",
      msg_id: "u1",
      role: "user",
      timestamp: "2026-08-13T10:00:00+10:00",
      model: null,
      text: "hello",
      locations: [{ thread: "main", segment: 0, ordinal: 0 }],
      before: [],
      after: [
        {
          thread: "main",
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

test("legacy segments import lazily and survive removal of the source files", async () => {
  const dataDir = testTmp(`history-import-${crypto.randomUUID()}`);
  const characterDir = join(dataDir, "ada");
  const segmentsDir = join(characterDir, "threads", "main", "segments");
  const dbPath = join(dataDir, HISTORY_DB_FILE);
  await mkdir(segmentsDir, { recursive: true });
  const messages = [message("u1", "old hello")];
  await writeFile(join(segmentsDir, "0001.jsonl"), `${JSON.stringify(messages[0])}\n`);
  await writeFile(
    join(characterDir, "threads", "main", "compaction.json"),
    JSON.stringify({
      segments: [
        {
          file: "0001.jsonl",
          message_count: 1,
          compacted_at: "2026-08-13T10:01:00+10:00",
        },
      ],
      total_compacted_messages: 1,
    }),
  );

  const importing = await SegmentReader.load({
    dir: join(characterDir, "threads", "main"),
    dbPath,
    archiveKey: "ada",
    createHistoryDb: true,
  });
  expect(await importing.readSegment(0)).toEqual(messages);
  importing.close();

  expect(access(segmentsDir)).rejects.toThrow();
  expect(access(join(characterDir, "threads", "main", "compaction.json"))).rejects.toThrow();
  const durable = await SegmentReader.load({
    dir: join(characterDir, "threads", "main"),
    dbPath,
    archiveKey: "ada",
    createHistoryDb: true,
  });
  expect(await durable.readSegment(0)).toEqual(messages);
  durable.close();
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

  test("an existing archive receives display metadata when it is upgraded", () => {
    const path = testTmp(`history-display-migration-${crypto.randomUUID()}.db`);
    const initial = HistoryStore.open(path);
    initial.putSegment(
      "ada",
      0,
      {
        file: HISTORY_DB_FILE,
        message_count: 3,
        compacted_at: "2026-08-13T10:01:00+10:00",
      },
      [toolAssistant("a1", "t1"), toolResult("r1", "t1"), message("a2", "done")],
    );
    initial.close();

    const raw = new Database(path, { readwrite: true });
    raw.run("DELETE FROM history_metadata WHERE key = 'display_version'");
    raw.run("UPDATE history_messages SET display_kind = 0, display_seq = NULL, is_user_turn = 0");
    raw.close();

    const upgraded = HistoryStore.open(path);
    expect(upgraded.displayMessageCount("ada")).toBe(1);
    expect(upgraded.readDisplayRange("ada", 0, 1).messages.map((entry) => entry.msg_id)).toEqual([
      "a1",
      "r1",
      "a2",
    ]);
    upgraded.close();
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

describe("the durable state of an archive document", () => {
  const segment = (store: HistoryStore, idx = 0, retain = true) => {
    store.putSegment("ada", idx, {
      file: HISTORY_DB_FILE,
      message_count: 1,
      compacted_at: "2026-08-13T10:01:00+10:00",
      retain,
    }, [message(`u${String(idx)}`, "hello")]);
  };
  const status = (store: HistoryStore, idx = 0) =>
    store.entries("ada").find((entry) => entry.idx === idx)?.memory_status;

  test("a submission is distinguishable from an ingestion across a reopen", () => {
    const root = testTmp(`history-memory-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const path = join(root, HISTORY_DB_FILE);
    let store = HistoryStore.open(path);
    segment(store);
    expect(store.beginMemorySubmission("ada", 0, 60_000, 1_800_000)).toBe(true);
    expect(store.recordMemoryOperation("ada", 0, "op-1", 60_000)).toBe(true);
    store.close();

    store = HistoryStore.open(path);
    expect(status(store)).toBe("submitted");
    expect(store.nextCharacterMemoryRetainJob("ada", 60_000)).toMatchObject({
      action: "confirm",
      status: "submitted",
      operation: "op-1",
      attempts: 1,
      expires: 1_800_000,
    });
    expect(store.nextCharacterMemoryRetainJob("ada", 59_999)).toBeUndefined();
    expect(store.nextCharacterMemoryRetainDeadline("ada")).toBe(60_000);
    store.close();
  });

  test("only a pending segment can begin a submission", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    expect(store.beginMemorySubmission("ada", 0, 1, 2)).toBe(true);
    expect(store.beginMemorySubmission("ada", 0, 1, 2)).toBe(false);
    expect(store.entries("ada")[0]?.memory_attempts).toBe(1);
    store.close();
  });

  test("a resubmission clears the operation it could not confirm", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.beginMemorySubmission("ada", 0, 1, 2);
    store.recordMemoryOperation("ada", 0, "op-1", 1);
    expect(store.requeueMemoryDocument("ada", 0, "operation failed", false)).toBe(true);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({
      action: "retain",
      operation: undefined,
      attempts: 1,
    });
    store.close();
  });

  test("an exhausted retain is terminal and holds its diagnostic", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.beginMemorySubmission("ada", 0, 1, 2);
    expect(store.requeueMemoryDocument("ada", 0, "document rejected", true)).toBe(true);
    expect(status(store)).toBe("failed");
    expect(store.nextCharacterMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(store.entries("ada")[0]?.memory_error).toBe("document rejected");
    expect(store.retryMemoryDocument("ada", 0)).toBe(true);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({ action: "retain", attempts: 0 });
    store.close();
  });

  test("excluding before any submission leaves nothing to delete", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    expect(status(store)).toBeUndefined();
    expect(store.nextCharacterMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toBeUndefined();
    store.close();
  });

  test("excluding after an ambiguous submission still queues a delete", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.beginMemorySubmission("ada", 0, 1, 2);
    store.requeueMemoryDocument("ada", 0, "retain timed out", false);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({ action: "delete" });
    store.close();
  });

  test("excluding mid-flight keeps the operation so the delete can wait for it", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.beginMemorySubmission("ada", 0, 1, 2);
    store.recordMemoryOperation("ada", 0, "op-1", 1);
    expect(store.setExcluded("ada", 0, true, true)).toBe(true);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({
      action: "delete",
      status: "submitted",
      operation: "op-1",
    });
    store.close();
  });

  test("re-including a deleted segment queues a fresh retain, a stored one does not", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.markMemoryDocument("ada", 0, "stored");
    store.setExcluded("ada", 0, true, true);
    store.markMemoryDocument("ada", 0, null);
    expect(store.setExcluded("ada", 0, false, true)).toBe(true);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({ action: "retain", attempts: 0 });

    segment(store, 1);
    store.markMemoryDocument("ada", 1, "stored");
    store.setExcluded("ada", 1, true, true);
    expect(store.setExcluded("ada", 1, false, true)).toBe(true);
    expect(status(store, 1)).toBe("stored");
    store.close();
  });

  test("a failed delete stays terminal until it is explicitly requeued", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.markMemoryDocument("ada", 0, "stored");
    store.setExcluded("ada", 0, true, true);
    expect(store.markMemoryDeleteFailure("ada", 0, "server unavailable", true, 0)).toBe(true);
    expect(status(store)).toBe("delete_failed");
    expect(store.nextCharacterMemoryRetainJob("ada", Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(store.retryMemoryDocument("ada", 0)).toBe(true);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({ action: "delete" });
    store.close();
  });

  test("an idle character reports no deadline at all", () => {
    const store = HistoryStore.openInMemory();
    segment(store, 0, false);
    expect(store.nextCharacterMemoryRetainDeadline("ada")).toBeUndefined();
    segment(store, 1);
    expect(store.nextCharacterMemoryRetainDeadline("ada")).toBe(0);
    store.markMemoryDocument("ada", 1, "stored");
    expect(store.nextCharacterMemoryRetainDeadline("ada")).toBeUndefined();
    store.close();
  });

  test("re-archiving a segment drops the operation state of the old one", () => {
    const store = HistoryStore.openInMemory();
    segment(store);
    store.beginMemorySubmission("ada", 0, 60_000, 1_800_000);
    store.recordMemoryOperation("ada", 0, "op-1", 60_000);
    segment(store);
    expect(store.nextCharacterMemoryRetainJob("ada", 0)).toMatchObject({
      action: "retain",
      operation: undefined,
      attempts: 0,
      expires: 0,
    });
    store.close();
  });
});
