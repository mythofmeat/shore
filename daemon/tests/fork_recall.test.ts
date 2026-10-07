import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { newMessageVersion } from "../src/engine/versions.ts";
import { handleReadChatLogs, handleSearchChatLogs } from "../src/tools/history.ts";

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
    indexPath: join(dir, "chat_logs.db"),
    timeZone: "UTC",
    now: () => Date.parse("2026-09-06T00:00:00Z"),
  };
}

async function search(f: Awaited<ReturnType<typeof fixture>>, input: Record<string, unknown>): Promise<string> {
  return await handleSearchChatLogs(input, f.conversationDir, f);
}

async function read(f: Awaited<ReturnType<typeof fixture>>, input: Record<string, unknown>): Promise<string> {
  return await handleReadChatLogs(input, f.conversationDir, f);
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

    const out = await search(f, { query: "needle" });
    expect(out).toContain("needle: 1 match, showing 1–1, best match first");
    expect(out).toContain(`${message("needle", shared).msg_id} · also in spin`);
    const there = await read(f, { around: message("needle", shared).msg_id, thread: "spin" });
    expect(there).toContain("in spin: 1 before, 1 after");
    expect(there).toContain("spin before");
    expect(there).toContain("spin after");
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

    const out = await read(f, { around: message("needle", shared).msg_id });
    expect(out).toContain("in main: 1 before, 1 after");
    expect(out).toContain("Also in thread spin.");
    expect(out).toContain("main before");
    expect(out).toContain("main after");
    expect(out).not.toContain("spin before");
    expect(out).not.toContain("spin after");
  });

  test("equal text from two separate events stays two results", async () => {
    const f = await fixture();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle", newMessageVersion())]);
    put(store, "ada/spin", 0, [message("needle", newMessageVersion())]);
    store.close();

    expect(await search(f, { query: "needle" })).toContain("needle: 2 matches");
  });

  test("an edited copy is a different version, so it comes back on its own", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle as first written", shared)]);
    put(store, "ada/spin", 0, [message("needle after the edit", newMessageVersion())]);
    store.close();

    expect(await search(f, { query: "needle" })).toContain("needle: 2 matches");
  });

  test("excluding one occurrence keeps the message findable through the other", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle", shared)]);
    put(store, "ada/spin", 0, [message("needle", shared)]);
    store.setExcluded("ada", 0, true);
    store.close();

    const out = await search(f, { query: "needle" });
    expect(out).toContain("needle: 1 match");
    expect(out).toContain("[spin] [needle]");
    expect(out).not.toContain("also in");
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

    const out = await search(f, { query: "needle", limit: 2 });
    expect(out).toContain("needle: 2 matches, showing 1–2");
    expect(out).toContain("[needle] shared");
    expect(out).toContain("[needle] distinct");
  });

  test("counts separate distinct events from their copies", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("needle", shared), message("only here", newMessageVersion())]);
    put(store, "ada/spin", 0, [message("needle", shared)]);
    store.close();

    expect(await search(f, { query: "absent" })).toContain("Searched 2 archived messages");
  });

  test("a fork thread reads with the messages it copied", async () => {
    const f = await fixture();
    const shared = newMessageVersion();
    const answer = message("answered in spin", newMessageVersion());
    const store = HistoryStore.open(f.dbPath);
    put(store, "ada", 0, [message("asked first", shared, "user")]);
    put(store, "ada/spin", 0, [message("asked first", shared, "user"), answer]);
    store.close();

    const context = await read(f, { around: answer.msg_id, thread: "spin" });
    expect(context).toContain("in spin: 1 before, 0 after");
    expect(context).toContain("asked first");
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

    const out = await search(f, { query: "needle" });
    expect(out).toContain("needle: 1 match");
    expect(out).toContain("[spin] [needle]");
  });
});
