import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import { archiveThread, createThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { HistorySearchIndex } from "../src/memory/history_index.ts";
import { handleSearchHistory } from "../src/tools/history.ts";

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
  return { dir, conversationDir, character: "ada", dbPath: join(dir, "shore.db"), path: join(dir, "search.db") };
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

    const result = await handleSearchHistory({ query: "needle", mode: "lexical", max_results: 50 }, f.conversationDir, f);
    expect(result.count).toBe(2);
    expect(result.searched_messages).toBe(6);
    for (const hit of result.results) {
      expect(["main", "side"]).toContain(String(hit.thread));
      expect(hit.text).toBe("needle");
      expect(hit.before).toMatchObject([{ thread: hit.thread, text: `${String(hit.thread)} before` }]);
      expect(hit.after).toMatchObject([{ thread: hit.thread, text: `${String(hit.thread)} after` }]);
    }
  });

  test("new and retired archives invalidate a settled index and exclusions remain per thread", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, ["main needle"]);
    const index = HistorySearchIndex.open(f);
    try {
      await index.reconcile();
      expect(index.allRows()).toHaveLength(1);
      await createThread(f.dir, "ada", "retired", stamp);
      await writeFile(join(f.dir, "ada", "threads", "retired", "active.jsonl"), JSON.stringify(message("retired needle")) + "\n");
      await archiveThread(f.dir, "ada", "retired");
      expect(existsSync(join(f.dir, "ada", "threads", "retired"))).toBe(false);
      await index.reconcile();
      expect(index.allRows().map((row) => row.archive_key)).toEqual(["ada", "ada/retired"]);
      store.setExcluded("ada/retired", 0, true);
      await index.reconcile();
      expect(index.allRows().map((row) => row.archive_key)).toEqual(["ada"]);
      store.setExcluded("ada/retired", 0, false);
      await index.reconcile();
      expect(index.allRows()).toHaveLength(2);
      put(store, "ada/side", 7, ["sparse needle"]);
      await index.reconcile();
      expect(index.allRows()).toHaveLength(3);
      const result = await handleSearchHistory({ query: "retired", mode: "lexical" }, f.conversationDir, { ...f, indexPath: f.path });
      expect(result.results).toMatchObject([{ thread: "retired", text: "retired needle", before: [], after: [] }]);
    } finally {
      index.close();
      store.close();
    }
  });

  test("rebuilds the old cache and embeds canonical text from every archive", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, ["urban skyline"]);
    put(store, "ada/retired", 0, ["orchard"]);
    store.close();
    const old = new Database(f.path);
    old.run("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 4");
    old.close();
    const seen: string[] = [];
    const embedder = {
      modelId: "thread-test", dimensions: 2,
      embed: async (texts: string[]) => {
        seen.push(...texts);
        return texts.map((text) => /orchard|fruit/.test(text) ? [1, 0] : [0, 1]);
      },
    };
    const index = HistorySearchIndex.open(f);
    try {
      await index.reconcile();
      expect(await index.embedPending(embedder)).toBe(2);
      expect(seen).toEqual(["urban skyline", "orchard"]);
    } finally {
      index.close();
    }
    const result = await handleSearchHistory({ query: "fruit", mode: "vector" }, f.conversationDir, { ...f, indexPath: f.path, embedder });
    expect(result.results[0]).toMatchObject({ thread: "retired", text: "orchard", before: [], after: [] });
    expect(result.semantic_index.pending_chunks).toBe(0);
  });

  test("character matching is literal, case sensitive and slash delimited", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    for (const key of ["a_b", "a_b/retired", "axb", "axb/side", "A_b/side", "a_bextra/side"]) put(store, key, 0, ["needle"]);
    expect(store.archiveKeys("a_b")).toEqual(["a_b", "a_b/retired"]);
    const result = await handleSearchHistory({ query: "needle" }, f.conversationDir, { ...f, character: "a_b" });
    expect(result.count).toBe(2);
    store.close();
  });
});
