import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import { SegmentReader } from "../src/engine/segments.ts";
import type { Message } from "../src/engine/types.ts";
import { bookPathIn, readBook, sessionKey, SESSION_BOOK_VERSION, writeBook, type SessionRecord } from "../src/llm/providers/agent_sessions.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { handleReadChatLogs, handleSearchChatLogs } from "../src/tools/history.ts";
import { testTmp } from "./support/tmp.ts";
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

test("a finished compaction turns its memory claim into coverage; an aborted one releases it and leaves no stored bodies behind; either is harmless twice", async () => {
  const dataDir = testTmp(`history-coverage-${crypto.randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, HISTORY_DB_FILE);
  const store = HistoryStore.open(path);
  const entry = { file: HISTORY_DB_FILE, message_count: 1, compacted_at: "2026-08-13T10:01:00+10:00" };
  const now = Date.parse("2026-08-13T00:00:00Z");
  const blobs = (): unknown => {
    const db = new Database(path, { readonly: true });
    try {
      return db.query("SELECT count(*) AS n FROM history_blobs").get();
    } finally {
      db.close();
    }
  };

  expect(store.claimMemoryCoverage("ada", "compaction", ["v1"], "kept", "pass", now, 60_000)).toEqual(["v1"]);
  const finished = store.beginCompaction("ada", entry, [message("u1", "hello")], "before\n", "after\n", "kept");
  store.finishCompaction("ada", finished);
  store.finishCompaction("ada", finished);
  expect([...store.coveredMemoryVersions("ada", "compaction", ["v1"])]).toEqual(["v1"]);

  const stored = blobs();
  expect(store.claimMemoryCoverage("ada", "compaction", ["v2"], "dropped", "pass", now, 60_000)).toEqual(["v2"]);
  const aborted = store.beginCompaction("ada", entry, [message("u2", "a body only this pass stored")], "before\n", "after\n", "dropped");
  store.abortCompaction("ada", aborted);
  store.abortCompaction("ada", aborted);
  expect(store.coveredMemoryVersions("ada", "compaction", ["v2"]).size).toBe(0);
  expect(store.claimMemoryCoverage("ada", "compaction", ["v2"], "next", "pass", now, 60_000)).toEqual(["v2"]);
  expect(blobs()).toEqual(stored);
  store.close();
});

test("one compaction at a time, and a pending one matching neither side of its write is left alone", () => {
  const store = HistoryStore.openInMemory();
  const entry = { file: HISTORY_DB_FILE, message_count: 1, compacted_at: "2026-08-13T10:01:00+10:00" };
  const messages = [message("u1", "hello")];

  const pending = store.beginCompaction("ada", entry, messages, "before\n", "after\n");
  expect(() => store.beginCompaction("ada", entry, messages, "before\n", "after\n")).toThrow("already pending");
  expect(() => store.recoverPending("ada", "edited by hand\n")).toThrow("active history changed");
  expect(store.pendingCompactionSegment("ada")).toBe(pending);
  expect(store.beginCompaction("bo", entry, messages, "before\n", "after\n")).toBe(0);
  store.close();
});

test("archiving a thread's history starts that thread's Agent SDK sessions afresh, and only that thread's", async () => {
  const dataDir = testTmp(`history-sessions-${crypto.randomUUID()}`);
  initializeDatabase(dataDir);
  const threadDir = join(dataDir, "ada", "threads", "main");
  await mkdir(threadDir, { recursive: true });
  const record = (sessionId: string): SessionRecord => ({ version: SESSION_BOOK_VERSION, sessionId, entries: [] });
  const book = bookPathIn(dataDir);
  writeBook(book, {
    [sessionKey("ada", "", "main")]: record("archived"),
    [sessionKey("ada", "", "side")]: record("side"),
    [sessionKey("bo", "", "main")]: record("bo"),
  });
  const active = [message("u1", "hello"), message("a1", "hi")].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

  await archiveAndRetain(threadDir, { dbPath: join(dataDir, HISTORY_DB_FILE), archiveKey: "ada" }, 0, active);

  expect(Object.values(readBook(book)).map((r) => r.sessionId).sort()).toEqual(["bo", "side"]);
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

test("chat logs show where each picture the user sent is kept, or just its name once the file is gone, and search by name alone", async () => {
  const dataDir = testTmp(`history-pictures-${crypto.randomUUID()}`);
  const characterDir = join(dataDir, "ada");
  const dbPath = join(dataDir, HISTORY_DB_FILE);
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  const sha256 = `3f2a91c0${"0".repeat(56)}`;
  const kept = join(dataDir, "attachments", `${sha256}.jpeg`);
  await mkdir(join(dataDir, "attachments"));
  await writeFile(kept, "jpeg");
  const messages: Message[] = [
    { ...message("u1", ""), content_blocks: [], images: [{ path: kept, name: "IMG_0955.jpeg", sha256 }] },
    { ...message("u2", "look at this one"), images: [{ path: "/cache/attachments/20261021_163901_IMG_0956.jpeg" }] },
    { ...message("a1", "mine ![[cat.png]]"), images: [{ path: "/cache/cat.png", embed: "![[cat.png]]", name: "cat.png" }] },
    {
      ...message("u3", ""),
      content_blocks: [{ type: "tool_result", tool_use_id: "t1", content: "shown" }],
      images: [{ path: "/cache/tool.png", sha256: `9b${"1".repeat(62)}` }],
    },
  ];
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

  const options = { character: "ada", dbPath, timeZone: "Australia/Canberra" };
  expect(await handleSearchChatLogs({ query: "IMG_0955", all_time: true }, characterDir, options)).toBe([
    "IMG_0955: 1 match, showing 1–1, best match first",
    "",
    "2026-08-13 Thu 10:00  user  [picture: [IMG_0955].jpeg]  u1",
  ].join("\n"));
  for (const query of ["attachments", "3f2a91c0"]) {
    expect(await handleSearchChatLogs({ query, match: "substring", all_time: true }, characterDir, options), query).not.toContain("u1");
  }
  const read = (first: string) => [
    "u1 in main: 0 before, 2 after (Australia/Canberra)",
    "",
    "▶ 2026-08-13 Thu 10:00  user  u1",
    first,
    "",
    "2026-08-13 Thu 10:00  user  u2",
    "[picture: IMG_0956.jpeg]",
    "look at this one",
    "",
    "2026-08-13 Thu 10:00  ada  a1",
    "mine [picture: cat.png]",
  ].join("\n");
  expect(await handleReadChatLogs({ around: "u1" }, characterDir, options)).toBe(read(`[picture: ${kept}]`));
  await rm(kept);
  expect(await handleReadChatLogs({ around: "u1" }, characterDir, options)).toBe(read("[picture: IMG_0955.jpeg]"));
});

function historyDirs(): { dataDir: string; characterDir: string; dbPath: string } {
  const dataDir = testTmp(`history-${crypto.randomUUID().slice(0, 8)}`);
  return { dataDir, characterDir: join(dataDir, "ada"), dbPath: join(dataDir, HISTORY_DB_FILE) };
}

async function archiveMain(dirs: { characterDir: string; dbPath: string }, messages: readonly Message[]): Promise<void> {
  await mkdir(join(dirs.characterDir, "threads", "main"), { recursive: true });
  await archiveAndRetain(
    join(dirs.characterDir, "threads", "main"),
    { dbPath: dirs.dbPath, archiveKey: "ada" },
    0,
    messages.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    () => "2026-08-13T10:01:00+10:00",
    () => "conversation-2",
    "compact-2",
  );
}

function modeOf(path: string): number {
  return fs.statSync(path).mode & 0o777;
}

test("a page of chat logs holds what fits in 12,000 characters as they are shown, picture paths and all", async () => {
  const dirs = historyDirs();
  const { dataDir, characterDir, dbPath } = dirs;
  await mkdir(dataDir, { recursive: true });
  const sha256 = `5e${"0".repeat(62)}`;
  const kept = join(dataDir, `${sha256}.jpeg`);
  await writeFile(kept, "jpeg");
  const head = "2026-08-13 Thu 10:00  user  u01";
  const label = `[picture: ${kept}]`;
  const text = "x".repeat(272 - head.length - label.length - 1 - 3);
  const messages = Array.from({ length: 45 }, (_, i) => ({
    ...message(`u${String(i + 1).padStart(2, "0")}`, text),
    images: [{ path: kept, name: "IMG_0957.jpeg", sha256 }],
  }));
  await archiveMain(dirs, messages);

  const page = (await handleReadChatLogs({ start: "2026-08-13", end: "2026-08-13" }, characterDir, { character: "ada", dbPath, timeZone: "Australia/Canberra" })).split("\n");

  expect(page[0]).toBe("main, 2026-08-13 → 2026-08-13: messages 1–44 of 45 (Australia/Canberra)");
  expect(page.filter((line) => line === label)).toHaveLength(44);
  expect(page.at(-1)).toBe("Next page: offset=44");
});

test("the chat log index is put in place readable by the daemon alone, and closed again when it is found open", async () => {
  const dirs = historyDirs();
  const { dataDir, characterDir, dbPath } = dirs;
  await archiveMain(dirs, [message("u1", "hello"), message("a1", "hi")]);
  const options = { character: "ada", dbPath, timeZone: "Australia/Canberra", indexPath: join(dataDir, "chat_logs.db") };
  const renameSync = fs.renameSync;
  const modesPutInPlace: number[] = [];
  const placing = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === options.indexPath) modesPutInPlace.push(modeOf(String(from)));
    renameSync(from, to);
  });
  try {
    await handleSearchChatLogs({ query: "hello", all_time: true }, characterDir, options);
    expect(modesPutInPlace).toEqual([0o600]);
    expect(modeOf(options.indexPath)).toBe(0o600);

    await chmod(options.indexPath, 0o644);
    await handleSearchChatLogs({ query: "hello", all_time: true }, characterDir, options);
  } finally {
    placing.mockRestore();
  }

  expect(modesPutInPlace).toHaveLength(1);
  expect(modeOf(options.indexPath)).toBe(0o600);
});
