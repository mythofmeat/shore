import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import { HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { readDurable, threadFile, writeDurable } from "../src/storage/files.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const stamp = "2026-09-20T00:00:00Z";
const messages: Message[] = Array.from({ length: 4 }, (_, i) => ({
  msg_id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", timestamp: stamp,
  content: `turn ${i}`, content_blocks: [{ type: "text", text: `turn ${i}` }], images: [], version: `mv_${i}`,
}));
const jsonl = (rows: Message[]) => rows.map(row => JSON.stringify(row) + "\n").join("");

for (const keep of [0, 1, 4, 10]) {
  test(`archiving with ${keep} retained messages survives a conversation restart`, async () => {
    const data = await mkdtemp(join(tmpdir(), "shore-archive-writer-"));
    roots.push(data);
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

test("retrying a completed compaction does not create another archive segment", async () => {
  const data = await mkdtemp(join(tmpdir(), "shore-archive-retry-"));
  roots.push(data);
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
