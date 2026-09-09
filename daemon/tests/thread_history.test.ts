import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import { archiveThread, createThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { HindsightRetainService } from "../src/memory/hindsight_retain_service.ts";
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
    file: "shore.db", message_count: texts.length, compacted_at: stamp, retain: true, ...options,
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
      await archiveThread(f.dir, "ada", "retired", { retain: true });
      expect(existsSync(join(f.dir, "ada", "threads", "retired"))).toBe(false);
      await index.reconcile();
      expect(index.allRows().map((row) => row.archive_key)).toEqual(["ada", "ada/retired"]);
      store.setExcluded("ada/retired", 0, true, true);
      await index.reconcile();
      expect(index.allRows().map((row) => row.archive_key)).toEqual(["ada"]);
      store.setExcluded("ada/retired", 0, false, true);
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
    expect(store.nextCharacterMemoryRetainJob("a_b")?.archiveKey).toBe("a_b");
    store.markMemoryDocument("a_b", 0, "stored");
    expect(store.nextCharacterMemoryRetainJob("a_b")?.archiveKey).toBe("a_b/retired");
    store.markMemoryDocument("a_b/retired", 0, "stored");
    expect(store.nextCharacterMemoryRetainJob("a_b")).toBeUndefined();
    expect(store.nextCharacterMemoryRetainDeadline("a_b")).toBeUndefined();
    store.close();
  });
});

describe("character memory and thread documents", () => {
  test("submits, confirms and deletes side-thread documents in the owning character's backend", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    for (const key of ["ada", "ada/side", "ada/retired", "adam/side"]) put(store, key, 0, [`${key} content`]);
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const owners: string[] = [];
    let now = 0;
    const service = new HindsightRetainService((character) => {
      owners.push(character);
      if (character !== "ada") return undefined;
      return { call: async (name, args) => {
        calls.push({ name, args });
        if (name === "retain") return { status: "accepted", operation_id: `op-${String(args.document_id)}` };
        if (name === "get_operation") return { status: "completed" };
        if (name === "get_document") return { id: args.document_id };
        if (name === "delete_document") return { status: "deleted" };
        throw new Error(`unexpected ${name}`);
      } };
    }, { now: () => now });
    service.register({ character: "ada", historyPath: f.dbPath, userName: "Ren", possessivePronoun: "her", timeoutMs: 1000 });
    try {
      for (let i = 0; i < 3; i++) await service.runOnce();
      const retains = calls.filter((call) => call.name === "retain");
      expect(retains.map((call) => call.args.document_id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(["shore:ada/retired:seg0", "shore:ada/side:seg0", "shore:ada:seg0"].sort((a, b) => a.localeCompare(b)));
      for (const call of retains) {
        expect(call.args.context).toContain("between Ren and ada,");
        expect(call.args.content).toStartWith("ada (");
      }
      expect(store.entries("adam/side")[0]?.memory_status).toBe("pending");
      now = 60_000;
      for (let i = 0; i < 3; i++) await service.runOnce();
      for (const key of ["ada", "ada/side", "ada/retired"]) expect(store.entries(key)[0]?.memory_status).toBe("stored");
      store.setExcluded("ada/side", 0, true, true);
      service.noteWork("ada");
      await service.runOnce();
      expect(calls.filter((call) => call.name === "delete_document")).toMatchObject([{ args: { document_id: "shore:ada/side:seg0" } }]);
      expect(store.entries("ada/side")[0]?.memory_status).toBeUndefined();
      expect(store.entries("ada")[0]?.memory_status).toBe("stored");
      expect(new Set(owners)).toEqual(new Set(["ada"]));
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  test("a side-thread failure retries its own segment without changing main", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, ["main"]);
    store.markMemoryDocument("ada", 0, "stored");
    put(store, "ada/side", 0, ["side"]);
    const service = new HindsightRetainService(() => ({ call: async () => { throw new Error("offline"); } }), { now: () => 0 });
    service.register({ character: "ada", historyPath: f.dbPath, userName: "Ren", possessivePronoun: "her", timeoutMs: 1000 });
    try {
      await service.runOnce();
      expect(store.entries("ada/side")[0]).toMatchObject({ memory_status: "pending", memory_attempts: 1, memory_error: "offline" });
      expect(store.entries("ada")[0]?.memory_status).toBe("stored");
      expect(store.nextCharacterMemoryRetainJob("ada", 0)).toBeUndefined();
      expect(store.nextCharacterMemoryRetainDeadline("ada")).toBeGreaterThan(0);
      expect(store.nextCharacterMemoryRetainJob("ada", 60_000)?.archiveKey).toBe("ada/side");
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  test("upgrades old retirement jobs once, preserving exclusions, terminal states and explicit opt-outs", async () => {
    const f = await fixture();
    let store = HistoryStore.open(f.dbPath);
    for (const key of ["ada", "ada/retired", "ada/excluded", "ada/failed", "adam/retired"]) {
      put(store, key, 0, [key], { retain: false, compaction_id: `thread-archive-${key}`, excluded: key === "ada/excluded" });
    }
    put(store, "ada/ordinary", 0, ["ordinary compaction"], { retain: false });
    store.close();
    const old = new Database(f.dbPath);
    old.run("ALTER TABLE history_segments DROP COLUMN retain_requested");
    old.run("UPDATE history_segments SET memory_doc = 'failed', memory_doc_attempts = 10 WHERE character = 'ada/failed'");
    old.close();
    store = HistoryStore.open(f.dbPath);
    put(store, "ada/disabled", 0, ["deliberately disabled"], { retain: false, compaction_id: "thread-archive-disabled" });
    expect(store.backfillThreadArchiveRetention("ada")).toBe(2);
    expect(store.entries("ada")[0]?.memory_status).toBe("pending");
    expect(store.entries("ada/retired")[0]?.memory_status).toBe("pending");
    for (const key of ["ada/excluded", "ada/ordinary", "ada/disabled", "adam/retired"]) expect(store.entries(key)[0]?.memory_status).toBeUndefined();
    expect(store.entries("ada/failed")[0]?.memory_status).toBe("failed");
    store.markMemoryDocument("ada/retired", 0, null);
    store.close();
    store = HistoryStore.open(f.dbPath);
    expect(store.backfillThreadArchiveRetention("ada")).toBe(0);
    expect(store.entries("ada/retired")[0]?.memory_status).toBeUndefined();
    store.close();
  });
});
