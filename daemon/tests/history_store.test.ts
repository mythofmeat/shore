import { expect, test } from "bun:test";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
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
  store.recoverPending("ada", "before\n");
  expect(store.hasSegment("ada", aborted)).toBe(false);

  const committed = store.beginCompaction("ada", entry, messages, "before\n", "after\n");
  expect(store.segmentCount("ada")).toBe(0);
  store.recoverPending("ada", "after\n");
  expect(store.hasSegment("ada", committed)).toBe(true);
  expect(store.readSegment("ada", committed)).toEqual(messages);
  store.close();
});

test("a compaction remains readable after its JSONL recovery copy is removed", async () => {
  const dataDir = testTmp(`history-durable-${crypto.randomUUID()}`);
  const characterDir = join(dataDir, "ada");
  const dbPath = join(dataDir, HISTORY_DB_FILE);
  await mkdir(characterDir, { recursive: true });
  const messages = [message("u1", "hello"), message("a1", "hi")];
  const active = messages.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

  await archiveAndRetain(
    characterDir,
    0,
    active,
    () => "2026-08-13T10:01:00+10:00",
    () => "conversation-2",
    "compact-2",
    { dbPath, character: "ada" },
  );

  expect(access(join(characterDir, "segments"))).rejects.toThrow();
  expect(access(join(characterDir, "compaction.json"))).rejects.toThrow();
  const reader = await SegmentReader.load(characterDir, { dbPath, character: "ada" });
  expect(reader.segmentCount()).toBe(1);
  expect(await reader.readSegment(0)).toEqual(messages);
  reader.close();

  const search = await handleSearchHistory({ query: "hello" }, characterDir);
  expect(search.results).toEqual([
    {
      msg_id: "u1",
      role: "user",
      timestamp: "2026-08-13T10:00:00+10:00",
      model: null,
      text: "hello",
      before: [],
      after: [
        {
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
  const segmentsDir = join(characterDir, "segments");
  const dbPath = join(dataDir, HISTORY_DB_FILE);
  await mkdir(segmentsDir, { recursive: true });
  const messages = [message("u1", "old hello")];
  await writeFile(join(segmentsDir, "0001.jsonl"), `${JSON.stringify(messages[0])}\n`);
  await writeFile(
    join(characterDir, "compaction.json"),
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

  const importing = await SegmentReader.load(characterDir, { dbPath, character: "ada" });
  expect(await importing.readSegment(0)).toEqual(messages);
  importing.close();

  expect(access(segmentsDir)).rejects.toThrow();
  expect(access(join(characterDir, "compaction.json"))).rejects.toThrow();
  const durable = await SegmentReader.load(characterDir, { dbPath, character: "ada" });
  expect(await durable.readSegment(0)).toEqual(messages);
  durable.close();
});
