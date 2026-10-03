import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { newMessageVersion } from "../src/engine/versions.ts";
import { handleSearchHistory } from "../src/tools/history.ts";
import { required } from "../src/util/required.ts";

const roots: string[] = [];
const STAMP = "2026-09-05T00:00:00Z";

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "shore-fork-recall-"));
  roots.push(dir);
  const conversationDir = join(dir, "ada", "threads", "main");
  await mkdir(conversationDir, { recursive: true });
  return {
    dir,
    conversationDir,
    character: "ada",
    dbPath: join(dir, "history.db"),
    path: join(dir, "search.db"),
  };
}

function message(text: string, version?: string, role: Message["role"] = "assistant"): Message {
  return {
    msg_id: `m_${text}_${version ?? "none"}`,
    role,
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp: STAMP,
    ...(version === undefined ? {} : { version }),
  };
}

function put(
  store: HistoryStore,
  key: string,
  idx: number,
  messages: Message[],
  options: Partial<SegmentEntry> = {},
) {
  store.putSegment(
    key,
    idx,
    {
      file: "history.db",
      message_count: messages.length,
      compacted_at: STAMP,
      ...options,
    },
    messages,
  );
}

describe("recalling a message that a fork copied", () => {
  test("a copied message is one result carrying every place it can be opened", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [
      message("main before", newMessageVersion()),
      message("needle", shared),
      message("main after", newMessageVersion()),
    ]);
    put(store, "ada/spin", 0, [
      message("spin before", newMessageVersion()),
      message("needle", shared),
      message("spin after", newMessageVersion()),
    ]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    expect(result.count).toBe(1);
    const hit = required(result.results[0]);
    expect(hit["locations"]).toEqual([
      { thread: "main", segment: 0, ordinal: 1 },
      { thread: "spin", segment: 0, ordinal: 1 },
    ]);
  });

  test("neighbours come from the representative's own thread, never mixed", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [
      message("main before", newMessageVersion()),
      message("needle", shared),
      message("main after", newMessageVersion()),
    ]);
    put(store, "ada/spin", 0, [
      message("spin before", newMessageVersion()),
      message("needle", shared),
      message("spin after", newMessageVersion()),
    ]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    const hit = required(result.results[0]);
    expect(hit["thread"]).toBe("main");
    expect(hit["before"]).toMatchObject([{ thread: "main", text: "main before" }]);
    expect(hit["after"]).toMatchObject([{ thread: "main", text: "main after" }]);
  });

  test("equal text from two separate events stays two results", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle", newMessageVersion())]);
    put(store, "ada/spin", 0, [message("needle", newMessageVersion())]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    expect(result.count).toBe(2);
  });

  test("an edited copy is a different version, so it comes back on its own", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle as first written", shared)]);
    put(store, "ada/spin", 0, [message("needle after the edit", newMessageVersion())]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    expect(result.count).toBe(2);
  });

  test("excluding one occurrence keeps the message findable through the other", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle", shared)]);
    put(store, "ada/spin", 0, [message("needle", shared)]);
    store.setExcluded("ada", 0, true);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    expect(result.count).toBe(1);
    expect(required(result.results[0])["locations"]).toEqual([
      { thread: "spin", segment: 0, ordinal: 0 },
    ]);
  });

  test("copies are folded together before the limit, so distinct matches are not crowded out", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle shared", shared)]);
    put(store, "ada/a", 0, [message("needle shared", shared)]);
    put(store, "ada/b", 0, [message("needle shared", shared)]);
    put(store, "ada/c", 0, [message("needle distinct", newMessageVersion())]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 2 },
      f.conversationDir,
      f,
    );
    expect(result.count).toBe(2);
    expect(result.results.map((hit) => String(hit["text"])).sort((a, b) => a.localeCompare(b))).toEqual([
      "needle distinct",
      "needle shared",
    ]);
  });

  test("counts separate distinct events from their copies", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle", shared), message("only here", newMessageVersion())]);
    put(store, "ada/spin", 0, [message("needle", shared)]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    expect(result.searched_message_occurrences).toBe(3);
    expect(result.searched_messages).toBe(2);
  });

  test("each archive counts its own display turns, a shared turn included", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("asked", shared, "user")]);
    put(store, "ada/spin", 0, [
      message("asked", shared, "user"),
      message("asked again", newMessageVersion(), "user"),
    ]);
    expect(store.segmentTurnCount("ada", 0)).toBe(1);
    expect(store.segmentTurnCount("ada/spin", 0)).toBe(2);
    store.close();
  });

  test("a retired source leaves the copy searchable on its own", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada/spin", 0, [message("needle", shared)]);
    store.close();

    const result = await handleSearchHistory(
      { query: "needle", mode: "lexical", max_results: 50 },
      f.conversationDir,
      f,
    );
    expect(result.count).toBe(1);
    expect(required(result.results[0])["thread"]).toBe("spin");
  });
});
