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

async function character(messages: Message[]): Promise<string> {
  const dataDir = testTmp(`history-index-${crypto.randomUUID()}`);
  const dir = join(dataDir, "ada");
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
  await writeFile(
    join(characterDir, "active.jsonl"),
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

    const result = await handleSearchHistory({ query: "needle", mode: "lexical" }, dir);
    expect(result.mode).toBe("lexical");
    expect(result.results).toEqual([{
      msg_id: "a1",
      role: "assistant",
      timestamp: "2026-08-13T00:01:00Z",
      model: null,
      text: "First paragraph.\n\nNeedle stays formatted.\nThird line.",
      before: [{
        msg_id: "u1", role: "user", timestamp: "2026-08-13T00:00:00Z",
        model: null, text: "Before paragraph.",
      }],
      after: [{
        msg_id: "u2", role: "user", timestamp: "2026-08-13T00:03:00Z",
        model: null, text: "After paragraph.",
      }],
    }]);
    expect((await handleSearchHistory({ query: "private-never-find-this" }, dir)).count).toBe(0);
    expect((await handleSearchHistory({ query: "secret-result" }, dir)).count).toBe(0);
  });

  test("defaults to three matches and ignores excerpt_chars compatibility input", async () => {
    const dir = await character(Array.from({ length: 6 }, (_, i) =>
      message(`u${i}`, "user", `full text match ${i}\nsecond line`, `2026-08-13T00:0${i}:00Z`),
    ));
    const result = await handleSearchHistory({ query: "match", excerpt_chars: 1 }, dir);
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

    expect((await handleSearchHistory({ query: "alpha beta", mode: "lexical" }, dir)).results[0]?.msg_id)
      .toBe("a1");
    expect((await handleSearchHistory({ query: "café", mode: "lexical" }, dir)).results[0]?.msg_id)
      .toBe("a1");
    expect((await handleSearchHistory({ query: "\"punctuation\" 東京", mode: "lexical" }, dir)).results[0]?.msg_id)
      .toBe("u1");

    const filtered = await handleSearchHistory({
      query: "alpha",
      mode: "lexical",
      model: "gpt-5.6",
      start_time: "2026-08-12T23:59:00Z",
      end_time: "2026-08-13T00:30:00Z",
    }, dir);
    expect(filtered.results.map((result) => result.msg_id)).toEqual(["a1"]);
  });

  test("embeddings retrieve paraphrases and report complete coverage", async () => {
    const dir = await character([
      message("u1", "user", "We walked through the apple orchard", "2026-08-13T00:00:00Z"),
      message("a1", "assistant", "Database migration notes", "2026-08-13T00:01:00Z"),
    ]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    const index = HistorySearchIndex.open({ characterDataDir: dir, path });
    await index.reconcile();
    expect(await index.embedPending(embedder)).toBe(2);
    index.close();

    const result = await handleSearchHistory(
      { query: "fruit grove", mode: "hybrid" },
      dir,
      { indexPath: path, embedder },
    );
    expect(result.results[0]?.msg_id).toBe("u1");
    expect(result.semantic_index.pending_chunks).toBe(0);
    expect(result.mode).toBe("hybrid");
  });

  test("query embedding failures fall back to complete lexical search", async () => {
    const dir = await character([message("u1", "user", "reliable keyword", "2026-08-13T00:00:00Z")]);
    const failing: Embedder = {
      modelId: "broken",
      dimensions: 2,
      embed: () => Promise.reject(new Error("offline")),
    };
    const result = await handleSearchHistory(
      { query: "reliable", mode: "hybrid" }, dir, { embedder: failing },
    );
    expect(result.mode).toBe("lexical");
    expect(result.results[0]?.msg_id).toBe("u1");
    expect(result.semantic_unavailable).toContain("offline");
  });

  test("explicit vector mode reports partial semantic coverage", async () => {
    const dir = await character([message("u1", "user", "an orchard note", "2026-08-13T00:00:00Z")]);
    const result = await handleSearchHistory(
      { query: "fruit grove", mode: "vector" }, dir, { embedder: new FakeEmbedder() },
    );
    expect(result.mode).toBe("vector");
    expect(result.results).toEqual([]);
    expect(result.semantic_index.pending_chunks).toBe(1);
    expect(result.semantic_unavailable).toBe("incomplete_vector_coverage");
  });

  test("a deleted cache is rebuilt without touching canonical history", async () => {
    const dir = await character([message("u1", "user", "persistent words", "2026-08-13T00:00:00Z")]);
    await handleSearchHistory({ query: "persistent" }, dir);
    await unlink(join(dir, HISTORY_SEARCH_DB_FILE));
    expect((await handleSearchHistory({ query: "persistent" }, dir)).count).toBe(1);
  });

  test("a corrupt cache is discarded and rebuilt", async () => {
    const dir = await character([message("u1", "user", "recoverable words", "2026-08-13T00:00:00Z")]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    await handleSearchHistory({ query: "recoverable" }, dir);
    await writeFile(path, "not a sqlite database");
    expect((await handleSearchHistory({ query: "recoverable" }, dir)).count).toBe(1);
  });

  test("the active conversation is not searchable and cannot be asked for", async () => {
    const dir = await character([
      message("a1", "assistant", "archived needle", "2026-08-13T00:00:00Z"),
    ]);
    await activeWindow(dir, [
      message("u2", "user", "live needle in the active window", "2026-08-13T00:01:00Z"),
    ]);

    const result = await handleSearchHistory({ query: "needle" }, dir);
    expect(result.results.map((hit) => hit.msg_id)).toEqual(["a1"]);
    expect(result.searched_messages).toBe(1);
    expect((await handleSearchHistory({ query: "live", include_alternatives: true }, dir)).count)
      .toBe(0);
  });

  test("neighbors cross the archive segment boundary", async () => {
    const dir = await character([
      message("u1", "user", "archived before", "2026-08-13T00:00:00Z"),
      message("a1", "assistant", "boundary needle", "2026-08-13T00:01:00Z"),
    ]);
    archive(dir, 1, [message("u2", "user", "next segment after", "2026-08-13T00:03:00Z")]);

    const result = await handleSearchHistory({ query: "needle" }, dir);
    expect((result.results[0]?.before as Array<Record<string, unknown>>)[0]?.msg_id).toBe("u1");
    expect((result.results[0]?.after as Array<Record<string, unknown>>)[0]?.msg_id).toBe("u2");
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

    expect((await handleSearchHistory({ query: "alternate" }, dir)).count).toBe(0);
    expect((await handleSearchHistory({ query: "alternate", include_alternatives: true }, dir)).count)
      .toBe(0);
    const canonical = await handleSearchHistory({ query: "selected" }, dir);
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

    await handleSearchHistory({ query: "archived" }, dir);
    const settled = fingerprint();
    expect(settled).not.toBe("");

    for (let turn = 0; turn < 3; turn += 1) {
      await activeWindow(dir, Array.from({ length: turn + 1 }, (_, i) =>
        message(`u${i}`, "user", `live turn ${i}`, `2026-08-16T0${i}:00:00Z`),
      ));
      await handleSearchHistory({ query: "archived" }, dir);
      expect(fingerprint()).toBe(settled);
    }

    archive(dir, 1, [message("a2", "assistant", "newly archived note", "2026-08-16T04:00:00Z")]);
    await handleSearchHistory({ query: "archived" }, dir);
    expect(fingerprint()).not.toBe(settled);
  });

  test("archived edits replace stale terms", async () => {
    const dir = await character([
      message("a1", "assistant", "original answer", "2026-08-13T00:00:00Z"),
    ]);
    expect((await handleSearchHistory({ query: "original" }, dir)).count).toBe(1);

    archive(dir, 0, [message("a1", "assistant", "replacement answer", "2026-08-13T00:00:00Z")]);
    expect((await handleSearchHistory({ query: "original" }, dir)).count).toBe(0);
    expect((await handleSearchHistory({ query: "replacement" }, dir)).count).toBe(1);
  });

  test("reconciliation preserves vectors for unchanged content hashes", async () => {
    const first = message("u1", "user", "stable orchard", "2026-08-13T00:00:00Z");
    const dir = await character([first]);
    const path = join(dir, HISTORY_SEARCH_DB_FILE);
    const embedder = new FakeEmbedder();
    let index = HistorySearchIndex.open({ characterDataDir: dir, path });
    await index.reconcile();
    await index.embedPending(embedder);
    index.close();

    archive(dir, 0, [first, message("u2", "user", "new note", "2026-08-13T00:01:00Z")]);
    index = HistorySearchIndex.open({ characterDataDir: dir, path });
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
    let index = HistorySearchIndex.open({ characterDataDir: dir, path });
    await index.reconcile();
    await index.embedPending(first);
    expect(index.diagnostics(first).pending_chunks).toBe(0);
    index.close();

    const second: Embedder = {
      modelId: "fake-history-v2",
      dimensions: 2,
      embed: async (inputs) => inputs.map(() => [0, 1]),
    };
    index = HistorySearchIndex.open({ characterDataDir: dir, path });
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
    const index = HistorySearchIndex.open({ characterDataDir: dir, path });
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
    const firstDir = await character([message("u1", "user", "first corpus", "2026-08-13T00:00:00Z")]);
    const secondDir = await character([message("u2", "user", "second corpus", "2026-08-13T00:00:00Z")]);
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
      characterDataDir: firstDir,
      indexPath: join(firstDir, HISTORY_SEARCH_DB_FILE),
      embedder: embedderFor("one"),
    });
    service.register({
      character: "two",
      characterDataDir: secondDir,
      indexPath: join(secondDir, HISTORY_SEARCH_DB_FILE),
      embedder: embedderFor("two"),
    });
    const settled = HistorySearchIndex.open({
      characterDataDir: firstDir,
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
    service.register({ character: "ada", characterDataDir: dir, indexPath: path, embedder });
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
    service.register({ character: "ada", characterDataDir: dir, indexPath: path, embedder });
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
