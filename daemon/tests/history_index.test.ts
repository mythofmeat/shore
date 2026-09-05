import { formatToolOutput } from "../src/tools/output.ts";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Message } from "../src/engine/types.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Embedder } from "../src/llm/embed.ts";
import {
  HISTORY_SEARCH_DB_FILE,
  HistorySearchIndex,
  chunkVisibleText,
} from "../src/memory/history_index.ts";
import { HistoryIndexService } from "../src/memory/history_index_service.ts";
import { required } from "../src/util/required.ts";
import { handleSearchHistory } from "../src/tools/history.ts";
import { testTmp } from "./support/tmp.ts";

function message(
  id: string,
  role: Message["role"],
  text: string,
  timestamp: string,
): Message {
  return {
    msg_id: id,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp,
  };
}

function dbPathFor(dir: string): string {
  return join(dirname(dir), HISTORY_DB_FILE);
}

function identity(dir: string): { character: string; dbPath: string } {
  return { character: basename(dir), dbPath: dbPathFor(dir) };
}

async function character(messages: Message[], name = "ada"): Promise<string> {
  const dataDir = testTmp(`history-index-${crypto.randomUUID()}`);
  const dir = join(dataDir, name);
  await mkdir(dir, { recursive: true });
  archive(dir, 0, messages);
  return dir;
}

function archive(characterDir: string, index: number, messages: Message[]): void {
  const store = HistoryStore.open(join(dirname(characterDir), HISTORY_DB_FILE));
  store.putSegment(basename(characterDir), index, {
    file: `${String(index + 1).padStart(4, "0")}.jsonl`,
    message_count: messages.length,
    compacted_at: messages[messages.length - 1]?.timestamp ?? "2026-08-13T00:00:00Z",
  }, messages);
  store.close();
}

async function activeWindow(characterDir: string, messages: Message[]): Promise<void> {
  await mkdir(join(characterDir, "threads", "main"), { recursive: true });
  await writeFile(
    join(characterDir, "threads", "main", "active.jsonl"),
    messages.map((item) => JSON.stringify(item)).join("\n") + "\n",
  );
}

class FakeEmbedder implements Embedder {
  readonly modelId = "fake-history-v1";
  readonly dimensions = 2;
  calls: string[][] = [];

  async embed(inputs: string[]): Promise<number[][]> {
    this.calls.push(inputs);
    return inputs.map((input) =>
      /orchard|fruit grove/iu.test(input) ? [1, 0] : [0, 1],
    );
  }
}

describe("history search index", () => {
  test("returns full visible messages and skips private and invisible neighbors", async () => {
    const before = message("u1", "user", "Before paragraph.", "2026-08-13T00:00:00Z");
    const hit = message(
      "a1",
      "assistant",
      "First paragraph.\n\nNeedle stays formatted.\nThird line.",
      "2026-08-13T00:01:00Z",
    );
    hit.content_blocks.push({ type: "thinking", thinking: "private-never-find-this" });
    const invisible = message("s1", "system", "", "2026-08-13T00:02:00Z");
    invisible.content_blocks = [{ type: "tool_result", tool_use_id: "t1", content: "secret-result" }];
    const after = message("u2", "user", "After paragraph.", "2026-08-13T00:03:00Z");
    const dir = await character([before, hit, invisible, after]);

    const result = await handleSearchHistory({ query: "needle", mode: "lexical" }, dir, { ...identity(dir),
      timeZone: "UTC",
    });
    expect(result.mode).toBe("lexical");
    expect(result.results).toEqual([{
      thread: "main", segment: 0, ordinal: 1,
      msg_id: "a1",
      role: "assistant",
      timestamp: "2026-08-13T00:01:00+00:00",
      model: null,
      text: "First paragraph.\n\nNeedle stays formatted.\nThird line.",
      locations: [{ thread: "main", segment: 0, ordinal: 1 }],
      before: [{
        thread: "main", segment: 0, ordinal: 0, msg_id: "u1", role: "user", timestamp: "2026-08-13T00:00:00+00:00",
        model: null, text: "Before paragraph.",
      }],
      after: [{
        thread: "main", segment: 0, ordinal: 3, msg_id: "u2", role: "user", timestamp: "2026-08-13T00:03:00+00:00",
        model: null, text: "After paragraph.",
      }],
    }]);
    expect((await handleSearchHistory({ query: "private-never-find-this" }, dir, identity(dir))).count).toBe(0);
    expect((await handleSearchHistory({ query: "secret-result" }, dir, identity(dir))).count).toBe(0);
  });

  test("defaults to three matches and ignores excerpt_chars compatibility input", async () => {
    const dir = await character(Array.from({ length: 6 }, (_, i) =>
      message(`u${i}`, "user", `full text match ${i}\nsecond line`, `2026-08-13T00:0${i}:00Z`),
    ));
    const result = await handleSearchHistory({ query: "match", excerpt_chars: 1 }, dir, identity(dir));
    expect(result.count).toBe(3);
    expect((result.results[0]?.text as string)).toContain("\nsecond line");
  });

  test("FTS handles phrases, Unicode, punctuation, and combined metadata filters", async () => {
    const phrase = message(
      "a1", "assistant", "Café launch: alpha beta.", "2026-08-13T00:00:00Z",
    );
    phrase.model = "openai/gpt-5.6";
    const separated = message(
      "a2", "assistant", "alpha words between beta", "2026-08-13T01:00:00Z",
    );
    separated.model = "anthropic/opus-4.6";
    const punctuation = message(
      "u1", "user", "Quoted \"punctuation\" and 東京 notes.", "2026-08-13T02:00:00Z",
    );
    const dir = await character([phrase, separated, punctuation]);

    expect((await handleSearchHistory({ query: "alpha beta", mode: "lexical" }, dir, identity(dir))).results[0]?.msg_id)
      .toBe("a1");
    expect((await handleSearchHistory({ query: "café", mode: "lexical" }, dir, identity(dir))).results[0]?.msg_id)
      .toBe("a1");
    expect((await handleSearchHistory({ query: "\"punctuation\" 東京", mode: "lexical" }, dir, identity(dir))).results[0]?.msg_id)
      .toBe("u1");

    const filtered = await handleSearchHistory({
      query: "alpha",
      mode: "lexical",
      model: "gpt-5.6",
      start_time: "2026-08-12T23:59:00Z",
      end_time: "2026-08-13T00:30:00Z",
    }, dir, identity(dir));
    expect(filtered.results.map((result) => result.msg_id)).toEqual(["a1"]);
  });

  test("embeddings retrieve paraphrases and report complete coverage", async () => {
    const dir = await character([
      message("u1", "user", "We walked through the apple orchard", "2026-08-13T00:00:00Z"),
      message("a1", "assistant", "Database migration notes", "2026-08-13T00:01:00Z"),
    ]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    const index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir), path });
    await index.reconcile();
    expect(await index.embedPending(embedder)).toBe(2);
    index.close();

    const db = new Database(path, { readonly: true });
    const stored = db.query(
      "SELECT COUNT(*) AS count, MAX(length(vector)) AS bytes FROM embeddings",
    ).get() as { count: number; bytes: number };
    const lsh = db.query("SELECT COUNT(*) AS count FROM embedding_lsh").get() as { count: number };
    db.close();
    expect(stored).toEqual({ count: 2, bytes: 2 });
    expect(lsh.count).toBe(16);

    const result = await handleSearchHistory(
      { query: "fruit grove", mode: "hybrid" },
      dir,
      { ...identity(dir), indexPath: path, embedder },
    );
    expect(result.results[0]?.msg_id).toBe("u1");
    expect(result.semantic_index.pending_chunks).toBe(0);
    expect(result.mode).toBe("hybrid");
  });

  test("vector reranking is bounded before vectors leave SQLite", async () => {
    const dir = await character(Array.from({ length: 2_100 }, (_, index) =>
      message(
        `u${String(index)}`,
        "user",
        `orchard entry ${String(index)}`,
        `2026-08-13T00:${String(index % 60).padStart(2, "0")}:00Z`,
      ),
    ));
    const index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir) });
    const embedder = new FakeEmbedder();
    await index.reconcile();
    let embedded: number;
    do {
      embedded = await index.embedPending(embedder);
    } while (embedded > 0);

    expect(index.vectorRows([1, 0], embedder)).toHaveLength(2_048);
    index.close();
  });

  test("query embedding failures fall back to complete lexical search", async () => {
    const dir = await character([message("u1", "user", "reliable keyword", "2026-08-13T00:00:00Z")]);
    const failing: Embedder = {
      modelId: "broken",
      dimensions: 2,
      embed: () => Promise.reject(new Error("offline")),
    };
    const result = await handleSearchHistory(
      { query: "reliable", mode: "hybrid" }, dir, { ...identity(dir), embedder: failing },
    );
    expect(result.mode).toBe("lexical");
    expect(result.results[0]?.msg_id).toBe("u1");
    expect(result.semantic_unavailable).toContain("offline");
  });

  test("explicit vector mode reports partial semantic coverage", async () => {
    const dir = await character([message("u1", "user", "an orchard note", "2026-08-13T00:00:00Z")]);
    const result = await handleSearchHistory(
      { query: "fruit grove", mode: "vector" }, dir, { ...identity(dir), embedder: new FakeEmbedder() },
    );
    expect(result.mode).toBe("vector");
    expect(result.results).toEqual([]);
    expect(result.semantic_index.pending_chunks).toBe(1);
    expect(result.semantic_unavailable).toBe("incomplete_vector_coverage");
  });

  test("a deleted cache is rebuilt without touching canonical history", async () => {
    const dir = await character([message("u1", "user", "persistent words", "2026-08-13T00:00:00Z")]);
    await handleSearchHistory({ query: "persistent" }, dir, identity(dir));
    await unlink(join(dir, HISTORY_SEARCH_DB_FILE));
    expect((await handleSearchHistory({ query: "persistent" }, dir, identity(dir))).count).toBe(1);
  });

  test("a corrupt cache is discarded and rebuilt", async () => {
    const dir = await character([message("u1", "user", "recoverable words", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    await handleSearchHistory({ query: "recoverable" }, dir, identity(dir));
    await writeFile(path, "not a sqlite database");
    expect((await handleSearchHistory({ query: "recoverable" }, dir, identity(dir))).count).toBe(1);
  });

  test("the active conversation is not searchable and cannot be asked for", async () => {
    const dir = await character([
      message("a1", "assistant", "archived needle", "2026-08-13T00:00:00Z"),
    ]);
    await activeWindow(dir, [
      message("u2", "user", "live needle in the active window", "2026-08-13T00:01:00Z"),
    ]);

    const result = await handleSearchHistory({ query: "needle" }, dir, identity(dir));
    expect(result.results.map((hit) => hit.msg_id)).toEqual(["a1"]);
    expect(result.searched_messages).toBe(1);
    expect((await handleSearchHistory({ query: "live", include_alternatives: true }, dir, identity(dir))).count)
      .toBe(0);
  });

  test("neighbors cross the archive segment boundary", async () => {
    const dir = await character([
      message("u1", "user", "archived before", "2026-08-13T00:00:00Z"),
      message("a1", "assistant", "boundary needle", "2026-08-13T00:01:00Z"),
    ]);
    archive(dir, 1, [message("u2", "user", "next segment after", "2026-08-13T00:03:00Z")]);

    const result = await handleSearchHistory({ query: "needle" }, dir, identity(dir));
    const found = result.results[0];
    const before = found?.before as Record<string, unknown>[] | undefined;
    const after = found?.after as Record<string, unknown>[] | undefined;
    expect(before?.[0]?.["msg_id"]).toBe("u1");
    expect(after?.[0]?.["msg_id"]).toBe("u2");
  });

  test("regenerated alternatives are never indexed or returned", async () => {
    const selected = message("a1", "assistant", "selected response", "2026-08-13T00:00:00Z");
    selected.model = "selected-model";
    selected.alternatives = [{
      content: "different alternate phrase",
      images: [],
      content_blocks: [{ type: "text", text: "different alternate phrase" }],
      timestamp: "2026-08-13T00:01:00Z",
      model: "alternate-model",
    }];
    const dir = await character([selected]);

    expect((await handleSearchHistory({ query: "alternate" }, dir, identity(dir))).count).toBe(0);
    expect((await handleSearchHistory({ query: "alternate", include_alternatives: true }, dir, identity(dir))).count)
      .toBe(0);
    const canonical = await handleSearchHistory({ query: "selected" }, dir, identity(dir));
    expect(canonical.results[0]).toMatchObject({ model: "selected-model", text: "selected response" });
    expect(canonical.results[0]).not.toHaveProperty("alternative_index");
  });

  test("conversation turns do not invalidate the index; compaction does", async () => {
    const dir = await character([message("a1", "assistant", "archived note", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const fingerprint = (): string => {
      const db = new Database(path, { readonly: true });
      const row = db.query(
        "SELECT value FROM metadata WHERE key = 'source_fingerprint'",
      ).get() as { value: string } | null;
      db.close();
      return row?.value ?? "";
    };

    await handleSearchHistory({ query: "archived" }, dir, identity(dir));
    const settled = fingerprint();
    expect(settled).not.toBe("");

    for (let turn = 0; turn < 3; turn += 1) {
      await activeWindow(dir, Array.from({ length: turn + 1 }, (_, i) =>
        message(`u${i}`, "user", `live turn ${i}`, `2026-08-16T0${i}:00:00Z`),
      ));
      await handleSearchHistory({ query: "archived" }, dir, identity(dir));
      expect(fingerprint()).toBe(settled);
    }

    archive(dir, 1, [message("a2", "assistant", "newly archived note", "2026-08-16T04:00:00Z")]);
    await handleSearchHistory({ query: "archived" }, dir, identity(dir));
    expect(fingerprint()).not.toBe(settled);
  });

  test("archived edits replace stale terms", async () => {
    const dir = await character([
      message("a1", "assistant", "original answer", "2026-08-13T00:00:00Z"),
    ]);
    expect((await handleSearchHistory({ query: "original" }, dir, identity(dir))).count).toBe(1);

    archive(dir, 0, [message("a1", "assistant", "replacement answer", "2026-08-13T00:00:00Z")]);
    expect((await handleSearchHistory({ query: "original" }, dir, identity(dir))).count).toBe(0);
    expect((await handleSearchHistory({ query: "replacement" }, dir, identity(dir))).count).toBe(1);
  });

  test("reconciliation preserves vectors for unchanged content hashes", async () => {
    const first = message("u1", "user", "stable orchard", "2026-08-13T00:00:00Z");
    const dir = await character([first]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    let index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir), path });
    await index.reconcile();
    await index.embedPending(embedder);
    index.close();

    archive(dir, 0, [first, message("u2", "user", "new note", "2026-08-13T00:01:00Z")]);
    index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir), path });
    await index.reconcile();
    expect(index.diagnostics(embedder)).toEqual({
      indexed_chunks: 1,
      total_chunks: 2,
      pending_chunks: 1,
    });
    index.close();
  });

  test("embedding identity changes invalidate old vector coverage", async () => {
    const dir = await character([message("u1", "user", "stable orchard", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const first = new FakeEmbedder();
    let index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir), path });
    await index.reconcile();
    await index.embedPending(first);
    expect(index.diagnostics(first).pending_chunks).toBe(0);
    index.close();

    const second: Embedder = {
      modelId: "fake-history-v2",
      dimensions: 2,
      embed: async (inputs) => inputs.map(() => [0, 1]),
    };
    index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir), path });
    expect(index.diagnostics(second).pending_chunks).toBe(1);
    await index.embedPending(second);
    expect(index.diagnostics(second).pending_chunks).toBe(0);
    expect(index.diagnostics(first).pending_chunks).toBe(1);
    index.close();
  });

  test("every chunk of a multi-chunk message gets embedded", async () => {
    const long = `${"orchard ".repeat(200)}\n\n${"harbour ".repeat(200)}\n\n${"lantern ".repeat(200)}`;
    expect(chunkVisibleText(long).length).toBeGreaterThan(1);
    const dir = await character([
      message("u1", "user", long, "2026-08-13T00:00:00Z"),
      message("u2", "user", "short tail", "2026-08-13T00:01:00Z"),
    ]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    const index = HistorySearchIndex.open({ conversationDir: dir, ...identity(dir), path });
    await index.reconcile();
    const total = index.diagnostics(embedder).total_chunks;
    expect(total).toBeGreaterThan(2);
    for (;;) {
      if ((await index.embedPending(embedder)) === 0) break;
    }
    expect(index.diagnostics(embedder)).toEqual({
      indexed_chunks: total,
      total_chunks: total,
      pending_chunks: 0,
    });
    index.close();
  });

  test("a stalled character does not starve the others", async () => {
    const firstDir = await character(
      [message("u1", "user", "first corpus", "2026-08-13T00:00:00Z")],
      "one",
    );
    const secondDir = await character(
      [message("u2", "user", "second corpus", "2026-08-13T00:00:00Z")],
      "two",
    );
    const seen: string[] = [];
    const embedderFor = (name: string): Embedder => ({
      modelId: "fan-model",
      dimensions: 2,
      embed: async (inputs) => {
        seen.push(name);
        return inputs.map(() => [0, 1]);
      },
    });
    let now = 0;
    const service = new HistoryIndexService({ now: () => now, idleDelayMs: 30_000, batchPauseMs: 1 });
    service.register({
      character: "one",
      conversationDir: firstDir,
      dbPath: dbPathFor(firstDir),
      indexPath: join(firstDir, HISTORY_SEARCH_DB_FILE),
      embedder: embedderFor("one"),
    });
    service.register({
      character: "two",
      conversationDir: secondDir,
      dbPath: dbPathFor(secondDir),
      indexPath: join(secondDir, HISTORY_SEARCH_DB_FILE),
      embedder: embedderFor("two"),
    });
    const settled = HistorySearchIndex.open({
      conversationDir: firstDir,
      ...identity(firstDir),
      path: join(firstDir, HISTORY_SEARCH_DB_FILE),
    });
    await settled.reconcile();
    const warm = embedderFor("one");
    for (;;) {
      if ((await settled.embedPending(warm)) === 0) break;
    }
    settled.close();
    seen.length = 0;

    await service.reconcileAll();
    now = 31_000;
    await service.runOnce();
    now = 31_002;
    await service.runOnce();
    await service.shutdown();
    expect(seen).toContain("two");
  });

  test("a settled character backs off instead of rescanning every pause", async () => {
    const dir = await character([message("u1", "user", "settled corpus", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    let now = 0;
    const service = new HistoryIndexService({
      now: () => now,
      idleDelayMs: 30_000,
      batchPauseMs: 1_000,
      maxBatchPauseMs: 60_000,
    });
    service.register({
      character: "ada",
      conversationDir: dir,
      dbPath: dbPathFor(dir),
      indexPath: path,
      embedder,
    });
    await service.reconcileAll();

    now = 31_000;
    await service.runOnce();
    expect(embedder.calls.length).toBeGreaterThan(0);
    expect(service.progress("ada")?.nextBatchAt).toBe(32_000);

    const pauses: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      now = required(service.progress("ada")?.nextBatchAt);
      await service.runOnce();
      pauses.push(required(service.progress("ada")?.nextBatchAt) - now);
    }
    await service.shutdown();

    expect(pauses).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  test("an llm-shaped embedder failure is recorded readably, not as [object Object]", async () => {
    const dir = await character([message("u1", "user", "settled corpus", "2026-08-13T00:00:00Z")]);
    const service = new HistoryIndexService({ now: () => 0, idleDelayMs: 0, batchPauseMs: 1 });
    service.register({
      character: "ada",
      conversationDir: dir,
      dbPath: dbPathFor(dir),
      indexPath: join(dir, HISTORY_SEARCH_DB_FILE),
      embedder: {
        modelId: "fake-history-v1",
        dimensions: 2,
        embed: () => {
          throw { kind: "http_status", status: 413, body: "too many tokens" };
        },
      },
    });
    await service.reconcileAll();
    await service.runOnce();

    const recorded = service.progress("ada")?.lastError;
    expect(recorded).toBe("HTTP 413: too many tokens");
    await service.shutdown();
  });

  test("a mutation cancels the back-off so new history indexes promptly", async () => {
    const dir = await character([message("u1", "user", "settled corpus", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    let now = 0;
    const service = new HistoryIndexService({
      now: () => now,
      idleDelayMs: 30_000,
      batchPauseMs: 1_000,
      maxBatchPauseMs: 60_000,
    });
    service.register({
      character: "ada",
      conversationDir: dir,
      dbPath: dbPathFor(dir),
      indexPath: path,
      embedder: new FakeEmbedder(),
    });
    await service.reconcileAll();

    now = 31_000;
    for (let round = 0; round < 5; round += 1) {
      now = required(service.progress("ada")?.nextBatchAt) || now;
      await service.runOnce();
    }
    expect(required(service.progress("ada")?.nextBatchAt) - now).toBeGreaterThan(1_000);

    service.noteMutation("ada");
    expect(service.progress("ada")?.nextBatchAt).toBe(0);

    now += 1;
    await service.runOnce();
    expect(required(service.progress("ada")?.nextBatchAt) - now).toBe(2_000);
    await service.shutdown();
  });

  test("chunking is deterministic, overlapped, and bounded around paragraph breaks", () => {
    const text = `${"a".repeat(700)}\n\n${"b".repeat(700)}\n\n${"c".repeat(700)}`;
    const first = chunkVisibleText(text);
    expect(chunkVisibleText(text)).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.length <= 1_200)).toBe(true);
    expect(first[0]?.endsWith("\n\n")).toBe(true);
  });

  test("idle service pauses for foreground work and respects item batch limits", async () => {
    const dir = await character(Array.from({ length: 40 }, (_, i) =>
      message(`u${i}`, "user", `document ${i}`, `2026-08-13T00:${String(i).padStart(2, "0")}:00Z`),
    ));
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    let now = 0;
    const service = new HistoryIndexService({ now: () => now, idleDelayMs: 30_000, batchPauseMs: 1 });
    service.register({
      character: "ada",
      conversationDir: dir,
      dbPath: dbPathFor(dir),
      indexPath: path,
      embedder,
    });
    await service.reconcileAll();
    const end = service.beginForeground();
    now = 31_000;
    await service.runOnce();
    expect(embedder.calls).toHaveLength(0);
    end();
    now = 62_000;
    await service.runOnce();
    expect(embedder.calls[0]?.length).toBe(32);
    await service.shutdown();

    const db = new Database(path, { readonly: true });
    const embedded = db.query("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    expect(embedded.n).toBe(32);
    db.close();
  });

  test("idle service retries embedding failures with bounded backoff", async () => {
    const dir = await character([message("u1", "user", "retry document", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    let attempts = 0;
    const embedder: Embedder = {
      modelId: "retry-model",
      dimensions: 2,
      embed: async (inputs) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary outage");
        return inputs.map(() => [1, 0]);
      },
    };
    let now = 0;
    const service = new HistoryIndexService({ now: () => now, idleDelayMs: 30_000 });
    service.register({
      character: "ada",
      conversationDir: dir,
      dbPath: dbPathFor(dir),
      indexPath: path,
      embedder,
    });
    await service.reconcileAll();

    now = 31_000;
    await service.runOnce();
    expect(attempts).toBe(1);
    now = 31_999;
    await service.runOnce();
    expect(attempts).toBe(1);
    now = 32_000;
    await service.runOnce();
    expect(attempts).toBe(2);
    await service.shutdown();
  });
});

describe("timestamps a subagent can line up", () => {
  const encodings = [
    "2026-08-13T00:00:00+11:00",
    "2026-08-13T00:10:00.656165788+00:00",
    "2026-08-13T00:20:00.123Z",
    "2026-08-13T00:30:00+10:00",
  ];

  test("every stored encoding comes back in one zone with an explicit offset", async () => {
    const dir = await character(
      encodings.map((ts, i) => message(`m${i}`, "user", `needle ${i}`, ts)),
    );

    const result = await handleSearchHistory(
      { query: "needle", max_results: 10, mode: "lexical" },
      dir,
      { ...identity(dir), timeZone: "Australia/Canberra" },
    );

    expect(result.count).toBe(encodings.length);
    expect(result.time_zone).toBe("Australia/Canberra");
    for (const hit of result.results) {
      expect(String(hit.timestamp)).toMatch(/\+10:00$/u);
    }
    const byId = new Map(result.results.map((r) => [String(r.msg_id), String(r.timestamp)]));
    encodings.forEach((ts, i) => {
      expect(Date.parse(required(byId.get(`m${i}`)))).toBe(Date.parse(ts));
    });
  });

  test("the archive boundary and now let an empty window be read correctly", async () => {
    const dir = await character(
      encodings.map((ts, i) => message(`m${i}`, "user", `needle ${i}`, ts)),
    );

    const result = await handleSearchHistory(
      { start_time: "2026-08-20T00:00:00Z", end_time: "2026-08-21T00:00:00Z" },
      dir,
      { ...identity(dir), timeZone: "UTC", now: () => Date.parse("2026-08-22T00:00:00Z") },
    );

    expect(result.count).toBe(0);
    expect(result.now).toBe("2026-08-22T00:00:00+00:00");
    expect(result.archive_boundary.oldest).toBe("2026-08-12T13:00:00+00:00");
    expect(result.archive_boundary.newest).toBe("2026-08-13T00:20:00.123+00:00");
    expect(result.time_range.start_time).toBe("2026-08-20T00:00:00+00:00");
    expect(result.time_range.end_time).toBe("2026-08-21T00:00:00+00:00");
  });

  test("the boundary is the widest instant, not the widest string", async () => {
    const dir = await character([
      message("m0", "user", "alpha", "2026-08-13T00:00:00+11:00"),
      message("m1", "user", "beta", "2026-08-12T20:00:00Z"),
    ]);

    const result = await handleSearchHistory({ query: "alpha" }, dir, { ...identity(dir), timeZone: "UTC" });

    expect(result.archive_boundary.oldest).toBe("2026-08-12T13:00:00+00:00");
    expect(result.archive_boundary.newest).toBe("2026-08-12T20:00:00+00:00");
  });
});

test("actual history results merge adjacent context and report additional distinct matches", async () => {
  const dir = await character([
    message("a", "user", "needle one", "2026-08-13T00:00:00Z"),
    message("b", "assistant", "needle two", "2026-08-13T00:01:00Z"),
    message("c", "user", "needle three", "2026-08-13T00:02:00Z"),
  ]);
  const partial = await handleSearchHistory({ query: "needle", mode: "lexical", max_results: 2 }, dir, identity(dir));
  expect(partial.has_more).toBe(true);
  const all = await handleSearchHistory({ query: "needle", mode: "lexical", max_results: 3 }, dir, identity(dir));
  expect(all.has_more).toBeUndefined();
  const output = formatToolOutput("search_chat_logs", all);
  for (const text of ["needle one", "needle two", "needle three"]) expect(output.match(new RegExp(text, "g"))).toHaveLength(1);
  expect(output.match(/— match/g)).toHaveLength(3);
});
