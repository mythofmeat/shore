import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAndRetain, conversationManager } from "../src/memory/compaction/archive.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import * as files from "../src/storage/files.ts";
import { readDurable, threadFile, writeDurable } from "../src/storage/files.ts";
import { closeStorageConnections } from "../src/storage/store.ts";
import { outcomeOf } from "./support/outcome.ts";

const stamp = "2026-09-20T00:00:00Z";
const messages: Message[] = Array.from({ length: 4 }, (_, i) => ({
  msg_id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", timestamp: stamp,
  content: `turn ${i}`, content_blocks: [{ type: "text", text: `turn ${i}` }], images: [], version: `mv_${i}`,
}));
const jsonl = (rows: Message[]) => rows.map(row => JSON.stringify(row) + "\n").join("");

for (const keep of [0, 1, 4, 10]) {
  test(`archiving with ${keep} retained messages survives a conversation restart`, async () => {
    const data = await mkdtemp(join(tmpdir(), "shore-archive-writer-"));
    const dir = join(data, "ada/threads/main");
    await mkdir(dir, { recursive: true });
    const active = threadFile(data, "ada", "main", "active.jsonl");
    writeDurable(active, jsonl(messages));
    const location = { dbPath: join(data, "shore.db"), archiveKey: "ada" };
    const id = await archiveAndRetain(dir, location, keep, jsonl(messages), () => stamp, () => "next", "archive-once");
    expect(id).toBe("next");
    const retained = Math.min(keep, messages.length);
    expect(readDurable(active)).toBe(jsonl(messages.slice(messages.length - retained)));
    const engine = await ConversationEngine.load("ada", data);
    expect(engine.messages().map(row => row.msg_id)).toEqual(messages.slice(messages.length - retained).map(row => row.msg_id));
    const history = HistoryStore.open(location.dbPath);
    try {
      expect(history.segmentCount("ada")).toBe(retained < messages.length ? 1 : 0);
      if (retained < messages.length) {
        expect(history.readSegment("ada", 0).map(row => row.msg_id)).toEqual(messages.slice(0, messages.length - retained).map(row => row.msg_id));
        expect(history.hasCompactionOperation("ada", "archive-once")).toBe(true);
      }
    } finally { history.close(); }
  });
}

test("blank lines between messages are not counted as messages to keep", async () => {
  const data = await mkdtemp(join(tmpdir(), "shore-archive-blank-"));
  const dir = join(data, "ada/threads/main");
  await mkdir(dir, { recursive: true });
  const active = threadFile(data, "ada", "main", "active.jsonl");
  const spaced = messages.map(row => JSON.stringify(row) + "\n\n").join("");
  writeDurable(active, spaced);
  await archiveAndRetain(dir, { dbPath: join(data, "shore.db"), archiveKey: "ada" }, 2, spaced, () => stamp, () => "next", "spaced");
  expect(readDurable(active)).toBe(jsonl(messages.slice(2)));
});

test("retrying a completed compaction does not create another archive segment", async () => {
  const data = await mkdtemp(join(tmpdir(), "shore-archive-retry-"));
  const dir = join(data, "ada/threads/main");
  await mkdir(dir, { recursive: true });
  const location = { dbPath: join(data, "shore.db"), archiveKey: "ada" };
  writeDurable(threadFile(data, "ada", "main", "active.jsonl"), jsonl(messages));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await archiveAndRetain(dir, location, 2, jsonl(messages), () => stamp, () => "next", "same-operation");
  }
  const history = HistoryStore.open(location.dbPath);
  try { expect(history.segmentCount("ada")).toBe(1); }
  finally { history.close(); }
});

describe("what the archive writer records and refuses", () => {
  async function conversation(name: string, content = jsonl(messages)): Promise<{ data: string; dir: string; active: ReturnType<typeof threadFile>; dbPath: string }> {
    const data = await mkdtemp(join(tmpdir(), `shore-archive-${name}-`));
    const dir = join(data, "ada/threads/main");
    await mkdir(dir, { recursive: true });
    const active = threadFile(data, "ada", "main", "active.jsonl");
    writeDurable(active, content);
    return { data, dir, active, dbPath: join(data, "shore.db") };
  }

  test("the conversation manager passes on a pass's claim, exclusion and note, and keeps the location's claim when the pass has none", async () => {
    const { dir, active, dbPath } = await conversation("manager");
    const claims = HistoryStore.open(dbPath);
    const now = Date.parse(stamp);
    claims.claimMemoryCoverage("ada", "compaction", ["v1"], "pass-claim", "pass", now, 60_000);
    claims.claimMemoryCoverage("ada", "compaction", ["v0"], "base-claim", "pass", now, 60_000);
    claims.close();
    const manager = conversationManager(dir, { dbPath, archiveKey: "ada", coverageClaim: "base-claim" }, () => stamp, () => "next");
    await manager.archiveAndRetain("ada", { keepLastN: 2, activeContent: jsonl(messages), operationId: "first", coverageClaim: "pass-claim", excluded: true, note: "a note" });
    const after = readDurable(active);
    writeDurable(active, after + jsonl([{ ...messages[0] as Message, msg_id: "m4" }]));
    await manager.archiveAndRetain("ada", { keepLastN: 1, activeContent: readDurable(active), operationId: "second" });
    const history = HistoryStore.open(dbPath);
    try {
      expect([...history.coveredMemoryVersions("ada", "compaction", ["v0", "v1"])].sort()).toEqual(["v0", "v1"]);
      expect(history.entry("ada", 0)).toMatchObject({ excluded: true, note: "a note" });
      expect(history.entry("ada", 1)?.excluded).not.toBe(true);
      expect(history.entry("ada", 1)).not.toHaveProperty("note");
    } finally {
      history.close();
    }
  });

  test("with nothing to archive the conversation is still rewritten without its blank lines, and a loaded conversation sees it", async () => {
    const spaced = messages.map((row) => JSON.stringify(row) + "\n\n").join("");
    const { data, dir, active, dbPath } = await conversation("nothing", spaced);
    const engine = await ConversationEngine.load("ada", data);
    await archiveAndRetain(dir, { dbPath, archiveKey: "ada" }, 10, spaced, () => stamp, () => "next");
    expect(readDurable(active)).toBe(jsonl(messages));
    const kept = await conversation("loaded");
    const loaded = await ConversationEngine.load("ada", kept.data);
    await archiveAndRetain(kept.dir, { dbPath: kept.dbPath, archiveKey: "ada" }, 1, jsonl(messages), () => stamp, () => "next");
    expect(loaded.messages().map((row) => row.msg_id)).toEqual(["m3"]);
    expect(engine.messages()).toHaveLength(4);
  });

  test("a retained-messages write that fails is reported, and the archive it began is taken back", async () => {
    for (const keep of [2, 10]) {
      const { dir, dbPath } = await conversation(`unwritable-${String(keep)}`);
      const write = spyOn(files, "writeDurable").mockImplementation(() => {
        throw new Error("disk full");
      });
      try {
        expect(await outcomeOf(archiveAndRetain(dir, { dbPath, archiveKey: "ada" }, keep, jsonl(messages), () => stamp, () => "next"))).toThrow("failed to write retained messages: disk full");
      } finally {
        write.mockRestore();
      }
      const history = HistoryStore.open(dbPath);
      try {
        expect(history.segmentCount("ada")).toBe(0);
        expect(history.pendingCompactionSegment("ada")).toBeUndefined();
      } finally {
        history.close();
      }
    }
  });

  test("a compaction a crash left pending is settled before the next one, and nothing stays open", async () => {
    const { dir, dbPath } = await conversation("pending");
    const crashed = HistoryStore.open(dbPath);
    crashed.beginCompaction("ada", { file: "shore.db", message_count: 1, compacted_at: stamp }, [messages[0] as Message], jsonl(messages), jsonl(messages.slice(1)));
    crashed.close();
    closeStorageConnections();
    const before = readdirSync("/proc/self/fd").length;
    await archiveAndRetain(dir, { dbPath, archiveKey: "ada" }, 2, jsonl(messages), () => stamp, () => "next");
    closeStorageConnections();
    expect(readdirSync("/proc/self/fd").length).toBe(before);
    const history = HistoryStore.open(dbPath);
    try {
      expect(history.segmentCount("ada")).toBe(1);
      expect(history.readSegment("ada", 0).map((row) => row.msg_id)).toEqual(["m0", "m1"]);
      expect(history.pendingCompactionSegment("ada")).toBeUndefined();
    } finally {
      history.close();
    }
  });
});
