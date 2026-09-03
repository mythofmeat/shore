import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { clear, segments } from "../src/commands/segments.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import type { Embedder } from "../src/llm/embed.ts";
import { HISTORY_SEARCH_DB_FILE, HistorySearchIndex } from "../src/memory/history_index.ts";
import { handleSearchHistory } from "../src/tools/history.ts";
import { testTmp } from "./support/tmp.ts";

function message(id: string, text: string, minute: number): Message {
  return {
    msg_id: id,
    role: id.startsWith("u") ? "user" : "assistant",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: `2026-08-20T10:${String(minute).padStart(2, "0")}:00+10:00`,
  };
}

function put(characterDir: string, idx: number, messages: Message[]): void {
  const store = HistoryStore.open(join(dirname(characterDir), HISTORY_DB_FILE));
  store.putSegment(basename(characterDir), idx, {
    file: HISTORY_DB_FILE,
    message_count: messages.length,
    compacted_at: "2026-08-20T11:00:00+10:00",
  }, messages);
  store.close();
}

describe("segment management", () => {
  test("migrates old rows and exposes stable inspection metadata", async () => {
    const root = testTmp(`segments-migrate-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, HISTORY_DB_FILE);
    const db = new Database(path, { create: true });
    db.run(`CREATE TABLE history_segments (
      character TEXT NOT NULL, idx INTEGER NOT NULL, file TEXT NOT NULL,
      message_count INTEGER NOT NULL, compacted_at TEXT NOT NULL,
      PRIMARY KEY (character, idx)
    )`);
    db.run(`INSERT INTO history_segments VALUES ('ada', 0, '0001.jsonl', 2, '2026-08-20T11:00:00Z')`);
    db.close();

    const store = HistoryStore.open(path);
    expect(store.entries("ada")).toEqual([{
      idx: 0,
      file: "0001.jsonl",
      message_count: 2,
      compacted_at: "2026-08-20T11:00:00Z",
      first_message_at: null,
      last_message_at: null,
    }]);
    store.close();
  });

  test("shows the complete contents of an individual segment", async () => {
    const root = testTmp(`segments-show-${crypto.randomUUID()}`);
    const characterDir = join(root, "ada");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    put(characterDir, 0, [message("u0", "the opening", 0), message("a0", "the reply", 1)]);
    await segments(root, "ada", { action: "exclude", index: 0 });

    const shown = await segments(root, "ada", { action: "show", index: 0 });
    expect(shown).toMatchObject({
      character: "ada",
      segment: { index: 0, message_count: 2, excluded: true },
      messages: [
        { msg_id: "u0", role: "user", content: "the opening" },
        { msg_id: "a0", role: "assistant", content: "the reply" },
      ],
    });
  });

  test("exclude removes a whole segment and its false adjacency, then include reuses vectors", async () => {
    const root = testTmp(`segments-search-${crypto.randomUUID()}`);
    const characterDir = join(root, "ada");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    put(characterDir, 0, [message("a0", "first needle", 0)]);
    put(characterDir, 1, [message("u1", "disowned orchard", 1)]);
    put(characterDir, 2, [message("a2", "unrelated tail", 2)]);

    const path = join(characterDir, HISTORY_SEARCH_DB_FILE);
    const embedder: Embedder = {
      modelId: "fake",
      dimensions: 2,
      embed: async (inputs) => inputs.map(() => [1, 0]),
    };
    let index = HistorySearchIndex.open({
      conversationDir: characterDir,
      character: "ada",
      dbPath: join(root, "history.db"),
      path,
    });
    await index.reconcile();
    await index.embedPending(embedder);
    index.close();

    let mutations = 0;
    const excluded = await segments(root, "ada", { action: "exclude", index: 1 }, {
      noteMutation: () => { mutations += 1; },
    });
    expect(excluded).toMatchObject({ action: "exclude", segment: { index: 1, excluded: true } });
    expect(mutations).toBe(1);
    expect((await handleSearchHistory({ query: "disowned", mode: "lexical" }, characterDir, {
      character: "ada",
      dbPath: join(root, "history.db"),
      indexPath: path,
    })).count).toBe(0);
    const first = await handleSearchHistory({ query: "needle", mode: "lexical" }, characterDir, {
      character: "ada",
      dbPath: join(root, "history.db"),
      indexPath: path,
    });
    expect(first.searched_messages).toBe(2);
    expect(first.results[0]?.after).toEqual([]);

    await segments(root, "ada", { action: "include", index: 1 });
    index = HistorySearchIndex.open({
      conversationDir: characterDir,
      character: "ada",
      dbPath: join(root, "history.db"),
      path,
    });
    await index.reconcile();
    expect(await index.embedPending(embedder)).toBe(0);
    index.close();
    expect((await handleSearchHistory({ query: "disowned", mode: "lexical" }, characterDir, {
      character: "ada",
      dbPath: join(root, "history.db"),
      indexPath: path,
    })).count).toBe(1);
  });

  test("excluding a pre-existing segment schedules hindsight cleanup when retain is managed", async () => {
    const root = testTmp(`segments-retain-exclude-${crypto.randomUUID()}`);
    const characterDir = join(root, "ada");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    put(characterDir, 0, [message("u0", "old import", 0)]);

    await segments(root, "ada", { action: "exclude", index: 0 }, undefined, true);
    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    expect(store.nextMemoryRetainJob("ada")).toMatchObject({
      segment: 0,
      action: "delete",
    });
    store.close();
  });

  test("shows an exhausted hindsight operation and explicitly requeues it", async () => {
    const root = testTmp(`segments-retain-retry-${crypto.randomUUID()}`);
    const characterDir = join(root, "ada");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    const store = HistoryStore.open(join(root, HISTORY_DB_FILE));
    store.putSegment("ada", 0, {
      file: HISTORY_DB_FILE,
      message_count: 1,
      compacted_at: "2026-08-20T11:00:00+10:00",
      retain: true,
    }, [message("u0", "rejected memory", 0)]);
    store.requeueMemoryDocument("ada", 0, "document rejected", true);
    store.close();

    expect(await segments(root, "ada", { action: "show", index: 0 })).toMatchObject({
      segment: {
        memory_status: "failed",
        memory_attempts: 0,
        memory_error: "document rejected",
      },
    });

    let wakes = 0;
    expect(await segments(root, "ada", { action: "retry", index: 0 }, {
      noteMemoryWork: () => { wakes += 1; },
    })).toMatchObject({
      action: "retry",
      segment: { memory_status: "pending", memory_attempts: 0, memory_error: null },
    });
    expect(wakes).toBe(1);

    const retried = HistoryStore.open(join(root, HISTORY_DB_FILE));
    expect(retried.nextMemoryRetainJob("ada")).toMatchObject({
      segment: 0,
      action: "retain",
      attempts: 0,
    });
    retried.close();
  });

  test("clear archives without memory work and can exclude and annotate atomically", async () => {
    const root = testTmp(`segments-clear-${crypto.randomUUID()}`);
    const characterDir = join(root, "ada");
    await mkdir(join(characterDir, "threads", "main"), { recursive: true });
    const active = [message("u0", "risky experiment", 0), message("a0", "result", 1)];
    await writeFile(
      join(characterDir, "threads", "main", "active.jsonl"),
      `${active.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await mkdir(join(characterDir, "active_prompt"), { recursive: true });
    await writeFile(join(characterDir, "active_prompt", "MEMORY.md"), "stale memory\n");
    await writeFile(join(characterDir, "deferred_edits.jsonl"), '{"path":"MEMORY.md"}\n');
    let reloads = 0;
    let repoints = 0;
    let completed = 0;
    const result = await clear({
      characterName: "ada",
      reload: () => { reloads += 1; return Promise.resolve(); },
    }, {
      dataDir: root,
      repoint: () => { repoints += 1; return Promise.resolve(); },
      onComplete: () => { completed += 1; },
      now: () => "2026-08-20T11:00:00+10:00",
      newId: () => "after-clear",
    }, { exclude: true, note: "bad branch" });

    expect(result).toMatchObject({
      status: "clear",
      message_count: 2,
      segment: { index: 0, excluded: true, note: "bad branch" },
    });
    expect(await readFile(join(characterDir, "threads", "main", "active.jsonl"), "utf8")).toBe("");
    expect(existsSync(join(characterDir, "active_prompt"))).toBe(false);
    expect(existsSync(join(characterDir, "deferred_edits.jsonl"))).toBe(false);
    expect({ reloads, repoints, completed }).toEqual({ reloads: 1, repoints: 1, completed: 1 });
    expect((await handleSearchHistory({ query: "risky", mode: "lexical" }, characterDir, {
      character: "ada",
      dbPath: join(root, "history.db"),
    })).count).toBe(0);
  });
});
