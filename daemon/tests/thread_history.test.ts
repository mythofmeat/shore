import { writeDurable } from "../src/storage/files.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import { archiveThread, createThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { handleReadChatLogs, handleSearchChatLogs } from "../src/tools/history.ts";

const roots: string[] = [];
const stamp = "2026-09-05T00:00:00Z";

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "shore-thread-history-"));
  roots.push(dir);
  const conversationDir = join(dir, "ada", "threads", "main");
  await mkdir(conversationDir, { recursive: true });
  return {
    dir, conversationDir, character: "ada", dbPath: join(dir, "shore.db"), indexPath: join(dir, "cache", "chat_logs.db"),
    timeZone: "UTC", now: () => Date.parse("2026-09-06T00:00:00Z"),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function search(f: Fixture, input: Record<string, unknown>): Promise<string> {
  return await handleSearchChatLogs(input, f.conversationDir, f);
}

function idsIn(out: string): string[] {
  return [...out.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/gm)].map((m) => m[1] ?? "");
}

function message(text: string): Message {
  return {
    msg_id: crypto.randomUUID(), role: "assistant", timestamp: stamp,
    content: text, content_blocks: [{ type: "text", text }], images: [],
  };
}

function put(store: HistoryStore, key: string, idx: number, texts: string[], options: Partial<SegmentEntry> = {}) {
  store.putSegment(key, idx, {
    file: "shore.db", message_count: texts.length, compacted_at: stamp, ...options,
  }, texts.map(message));
}

describe("a character's history across threads", () => {
  test("overlapping slots remain distinct and neighbors stay in their source thread", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, ["main before", "needle", "main after"]);
    put(store, "ada/side", 0, ["side before", "needle", "side after"]);
    put(store, "adam/side", 0, ["needle from another character"]);
    store.close();

    const out = await search(f, { query: "needle" });
    expect(out).toContain("needle: 2 matches");
    expect(await search(f, { query: "absent" })).toContain("Searched 6 archived messages");
    const ids = idsIn(out);
    expect(ids).toHaveLength(2);
    for (const [id, thread] of ids.map((hit) => [hit, out.includes(`[side] [needle]  ${hit}`) ? "side" : "main"] as const)) {
      const context = await handleReadChatLogs({ around: id, thread }, f.conversationDir, f);
      expect(context).toContain(`${thread} before`);
      expect(context).toContain(`${thread} after`);
      expect(context).not.toContain(`${thread === "main" ? "side" : "main"} before`);
    }
  });

  test("new and retired archives invalidate a settled index and exclusions remain per thread", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    try {
      put(store, "ada", 0, ["main needle"]);
      expect(await search(f, { query: "needle" })).toContain("needle: 1 match");
      await createThread(f.dir, "ada", "retired", stamp);
      writeDurable(join(f.dir, "ada", "threads", "retired", "active.jsonl"), JSON.stringify(message("retired needle")) + "\n");
      await archiveThread(f.dir, "ada", "retired");
      expect(existsSync(join(f.dir, "ada", "threads", "retired"))).toBe(false);
      expect(await search(f, { query: "needle" })).toContain("needle: 2 matches");
      store.setExcluded("ada/retired", 0, true);
      expect(await search(f, { query: "needle" })).toContain("needle: 1 match");
      store.setExcluded("ada/retired", 0, false);
      expect(await search(f, { query: "needle" })).toContain("needle: 2 matches");
      put(store, "ada/side", 7, ["sparse needle"]);
      expect(await search(f, { query: "needle" })).toContain("needle: 3 matches");
      const retired = await search(f, { query: "retired" });
      expect(retired).toContain("[retired] [retired] needle");
      const [id] = idsIn(retired);
      expect(await handleReadChatLogs({ around: id }, f.conversationDir, f)).toContain("in retired: 0 before, 0 after");
    } finally {
      store.close();
    }
  });

  test("replaces the old search cache with a read-only chat log index", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, ["urban skyline"]);
    put(store, "ada/retired", 0, ["orchard"]);
    store.close();
    const old = join(f.dir, "cache", "history_search.db");
    await mkdir(join(f.dir, "cache"), { recursive: true });
    writeFileSync(old, "old cache");
    writeFileSync(`${old}-wal`, "");

    expect(await search(f, { query: "orchard" })).toContain("[retired] [orchard]");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}-wal`)).toBe(false);
    expect(statSync(f.indexPath).mode & 0o777).toBe(0o444);
    expect(await search(f, { query: "skyline" })).toContain("skyline: 1 match");
  });

  test("character matching is literal, case sensitive and slash delimited", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    for (const key of ["a_b", "a_b/retired", "axb", "axb/side", "A_b/side", "a_bextra/side"]) put(store, key, 0, ["needle"]);
    expect(store.archiveKeys("a_b")).toEqual(["a_b", "a_b/retired"]);
    expect(await search({ ...f, character: "a_b" }, { query: "needle" })).toContain("needle: 2 matches");
    store.close();
  });
});
