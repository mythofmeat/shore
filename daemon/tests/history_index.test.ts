import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  const dir = testTmp(`history-index-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "active.jsonl"), messages.map((item) => JSON.stringify(item)).join("\n") + "\n");
  return dir;
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

  test("neighbors cross from the final archive segment into the active window", async () => {
    const dataDir = testTmp(`history-boundary-${crypto.randomUUID()}`);
    const dir = join(dataDir, "ada");
    await mkdir(dir, { recursive: true });
    const archived = [
      message("u1", "user", "archived before", "2026-08-13T00:00:00Z"),
      message("a1", "assistant", "boundary needle", "2026-08-13T00:01:00Z"),
    ];
    const store = HistoryStore.open(join(dataDir, HISTORY_DB_FILE));
    store.putSegment("ada", 0, {
      file: "0001.jsonl",
      message_count: archived.length,
      compacted_at: "2026-08-13T00:02:00Z",
    }, archived);
    store.close();
    await writeFile(
      join(dir, "active.jsonl"),
      `${JSON.stringify(message("u2", "user", "active after", "2026-08-13T00:03:00Z"))}\n`,
    );

    const result = await handleSearchHistory({ query: "needle" }, dir);
    expect((result.results[0]?.after as Array<Record<string, unknown>>)[0]?.msg_id).toBe("u2");
  });

  test("active edits replace stale terms and alternatives keep their own metadata", async () => {
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
    const alternative = await handleSearchHistory(
      { query: "alternate", include_alternatives: true }, dir,
    );
    expect(alternative.results[0]).toMatchObject({
      alternative_index: 0,
      alternative_count: 1,
      model: "alternate-model",
      text: "different alternate phrase",
    });

    const edited = message("a1", "assistant", "replacement answer", "2026-08-13T00:00:00Z");
    await writeFile(join(dir, "active.jsonl"), `${JSON.stringify(edited)}\n`);
    expect((await handleSearchHistory({ query: "selected" }, dir)).count).toBe(0);
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

    await writeFile(
      join(dir, "active.jsonl"),
      `${JSON.stringify(first)}\n${JSON.stringify(message("u2", "user", "new note", "2026-08-13T00:01:00Z"))}\n`,
    );
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
    expect(Number(embedded.n)).toBe(32);
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
