import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { historyIndexSection } from "../src/commands/history_index.ts";
import { archiveKey, threadDataDir } from "../src/config/dirs.ts";
import { HISTORY_DB_FILE, HistoryStore, type SegmentEntry } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { HistoryIndex, refreshHistoryIndex, refreshLiveRows, type LiveThread } from "../src/memory/history_index.ts";
import { Texts } from "../src/texts/texts.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { required } from "../src/util/required.ts";
import { handlesUnder } from "./support/handles.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

function message(id: string, text: string, minute: number | string, extra: Partial<Message> = {}): Message {
  const timestamp = typeof minute === "string" ? minute : new Date(Date.parse("2026-11-01T09:00:00Z") + minute * 60_000).toISOString();
  return { msg_id: id, role: id.startsWith("u") ? "user" : "assistant", content: text, images: [], content_blocks: [{ type: "text", text }], timestamp, ...extra };
}

interface Archive {
  root: string;
  cache: string;
  indexPath: string;
  ref: { character: string; dbPath: string; mainConversationDir: string };
  put: (thread: string, idx: number, messages: Message[], entry?: Partial<SegmentEntry>) => void;
  index: () => Promise<HistoryIndex>;
}

async function archive(): Promise<Archive> {
  const root = testTmp(`history-index-${crypto.randomUUID()}`);
  const data = join(root, "data");
  const cache = join(root, "cache");
  await mkdir(join(data, "frank"), { recursive: true });
  await mkdir(cache, { recursive: true });
  initializeDatabase(data);
  const dbPath = join(data, HISTORY_DB_FILE);
  const indexPath = join(cache, "chat_logs.db");
  const ref = { character: "frank", dbPath, mainConversationDir: threadDataDir(data, "frank", "main") };
  return {
    root,
    cache,
    indexPath,
    ref,
    put: (thread, idx, messages, entry = {}) => {
      const store = HistoryStore.open(dbPath);
      try {
        store.putSegment(archiveKey("frank", thread), idx, { file: HISTORY_DB_FILE, compacted_at: "2026-11-05T10:00:00Z", ...entry }, messages);
      } finally {
        store.close();
      }
    },
    index: async () => {
      await refreshHistoryIndex(ref, indexPath);
      return HistoryIndex.open(indexPath);
    },
  };
}

function turnCounter(): { turns: () => number; stop: () => void } {
  let turns = 0;
  let spinning = true;
  const spin = (): void => {
    if (!spinning) return;
    turns += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  return { turns: () => turns, stop: () => { spinning = false; } };
}

const ids = (rows: readonly { msg_id: string }[]): string[] => rows.map((row) => row.msg_id);

describe("rebuilding the chat log index", () => {
  test("lets other work run between reading one archived conversation and the next", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse", 0), message("a1", "its keeper", 1)]);
    w.put("main", 1, [message("u2", "the harbour", 2)]);
    w.put("story", 0, [message("u3", "the boathouse", 3)]);
    const counter = turnCounter();
    const readAt: number[] = [];
    const read = Object.getOwnPropertyDescriptor(HistoryStore.prototype, "readSegment")?.value as typeof HistoryStore.prototype.readSegment;
    const spy = spyOn(HistoryStore.prototype, "readSegment").mockImplementation(function (this: HistoryStore, character, idx) {
      readAt.push(counter.turns());
      return read.call(this, character, idx);
    });
    try {
      expect(await refreshHistoryIndex(w.ref, w.indexPath, true)).toBe(true);
    } finally {
      counter.stop();
      spy.mockRestore();
    }
    expect(readAt).toHaveLength(3);
    expect(new Set(readAt).size).toBe(3);
  });

  test("writes the new index beside the old one, which answers searches until every message is in, and lets other work run between messages", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse", 0), message("a1", "its keeper", 1)]);
    await refreshHistoryIndex(w.ref, w.indexPath);
    w.put("main", 1, [message("u2", "the harbour", 2), message("a2", "the ferry", 3), message("u3", "the boathouse", 4)]);
    const searchable = (): number => {
      const index = HistoryIndex.open(w.indexPath);
      try {
        return index.count("words", "the OR its", {});
      } finally {
        index.close();
      }
    };
    const seenWhileWriting: number[] = [];
    let spinning = true;
    const watch = (): void => {
      if (!spinning) return;
      if (readdirSync(w.cache).some((name) => name.endsWith(".tmp"))) seenWhileWriting.push(searchable());
      setImmediate(watch);
    };
    setImmediate(watch);
    try {
      expect(await refreshHistoryIndex(w.ref, w.indexPath)).toBe(true);
    } finally {
      spinning = false;
    }
    expect(seenWhileWriting).toEqual([2, 2, 2, 2, 2]);
    expect(searchable()).toBe(5);
    expect(readdirSync(w.cache)).toEqual(["chat_logs.db"]);
  });

  test("leaves an index that matches the archive as it is, unless told to build it again", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse", 0)]);
    expect(await refreshHistoryIndex(w.ref, w.indexPath)).toBe(true);
    const built = statSync(w.indexPath);
    expect(await refreshHistoryIndex(w.ref, w.indexPath)).toBe(false);
    expect(statSync(w.indexPath).ino).toBe(built.ino);
    expect(await refreshHistoryIndex(w.ref, w.indexPath, true)).toBe(true);
    expect(statSync(w.indexPath).ino).not.toBe(built.ino);
  });

  test("closes the archive and the new index once it is built", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse", 0)]);
    await refreshHistoryIndex(w.ref, w.indexPath);
    const open = handlesUnder(w.root);
    for (let round = 0; round < 3; round += 1) await refreshHistoryIndex(w.ref, w.indexPath, true);
    expect(handlesUnder(w.root)).toBe(open);
  });

  test("fails without leaving part of an index behind when the new one can't be put in place, and says why when it can't be started", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse", 0)]);
    await mkdir(w.indexPath);
    expect(await outcomeOf(refreshHistoryIndex(w.ref, w.indexPath))).toThrow();
    expect(readdirSync(w.cache)).toEqual(["chat_logs.db"]);
    const elsewhere = join(w.root, "locked");
    await mkdir(elsewhere, { mode: 0o500 });
    try {
      expect(await outcomeOf(refreshHistoryIndex(w.ref, join(elsewhere, "chat_logs.db")))).toThrow("unable to open database file");
    } finally {
      await chmod(elsewhere, 0o700);
    }
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("removes the index kept under its old name once the new one is in place", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse", 0)]);
    for (const name of ["history_search.db", "history_search.db-wal", "history_search.db-shm"]) writeFileSync(join(w.cache, name), "");
    await refreshHistoryIndex(w.ref, w.indexPath);
    expect(readdirSync(w.cache)).toEqual(["chat_logs.db"]);
  });
});

describe("what the chat log index holds", () => {
  test("leaves out excluded conversations and notes from the character's wakes, and reading around a message stops where an excluded conversation was", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "lantern one", 0), message("a1", "lantern two", 1)]);
    w.put("main", 1, [message("u2", "lantern hidden", 2)], { excluded: true });
    w.put("main", 2, [message("u3", "lantern three", 3), message("a3", "lantern four", 4), message("u4", "lantern wake", 5, { origin: "autonomous" })]);
    const index = await w.index();
    try {
      expect(ids(index.search("words", "lantern", {}, "oldest", 10, 0))).toEqual(["u1", "a1", "u3", "a3"]);
      const row = (id: string) => required(index.find(id));
      expect(ids(index.neighbors(row("u1"), 1, 10))).toEqual(["a1"]);
      expect(ids(index.neighbors(row("u3"), -1, 10))).toEqual([]);
      expect(ids(index.neighbors(row("u3"), 1, 10))).toEqual(["a3"]);
    } finally {
      index.close();
    }
  });

  test("runs through a thread's conversations in the order they were archived", async () => {
    const w = await archive();
    for (let idx = 0; idx < 4; idx += 1) w.put("main", idx, [message(`u${String(idx)}`, `chapter ${String(idx)}`, idx)]);
    const index = await w.index();
    try {
      expect(ids(index.neighbors(required(index.find("u0")), 1, 10))).toEqual(["u1", "u2", "u3"]);
    } finally {
      index.close();
    }
  });

  test("holds a message once in a thread however often it was archived there, and counts it once where it is also in another thread", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the kettle", 0)]);
    w.put("main", 1, [message("u1", "the kettle", 0), message("a1", "the kettle boiled", 1)]);
    w.put("story", 0, [message("u1", "the kettle", 0)]);
    const index = await w.index();
    try {
      const hits = index.search("words", "kettle", {}, "oldest", 10, 0);
      expect(hits.map((hit) => [hit.msg_id, hit.thread, hit.also_in])).toEqual([["u1", "main", JSON.stringify(["story"])], ["a1", "main", null]]);
      expect(ids(index.neighbors(required(index.find("u1", "main")), 1, 10))).toEqual(["a1"]);
    } finally {
      index.close();
    }
    const progress = { character: "frank", conversationDir: w.ref.mainConversationDir, dbPath: w.ref.dbPath, indexPath: w.indexPath, failures: 0, retryAt: 0, lastError: undefined };
    expect(historyIndexSection({ progressFor: () => progress, now: () => 0 }, "frank")).toEqual({ path: w.indexPath, messages: 2, background: { failures: 0 } });
  });

  test("puts messages from the same moment in thread order, then in the order they were said", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "bell", 0), message("a1", "bell", 0)]);
    w.put("main", 1, [message("u3", "bell", 5)]);
    w.put("bay", 0, [message("u2", "bell", 0)]);
    const index = await w.index();
    try {
      expect(ids(index.search("words", "bell", {}, "oldest", 10, 0))).toEqual(["u2", "u1", "a1", "u3"]);
    } finally {
      index.close();
    }
  });

  test("dates a message whose time can't be read at the first moment of 1970 when nothing before it in its thread has a time", async () => {
    const w = await archive();
    w.put("bay", 0, [message("u1", "anchor", "not a time")]);
    w.put("main", 0, [message("u2", "anchor", "1970-01-01T00:00:00.000Z")]);
    const index = await w.index();
    try {
      expect(index.search("words", "anchor", {}, "oldest", 10, 0).map((hit) => [hit.msg_id, hit.ts])).toEqual([["u1", 0], ["u2", 0]]);
    } finally {
      index.close();
    }
  });
});

describe("rows from conversations still being held", () => {
  const live = (thread: string, messages: Message[]): LiveThread => ({ thread, raw: JSON.stringify(messages), messages });
  const rows = (index: HistoryIndex, thread: string) => index.range(thread, 0, Number.MAX_SAFE_INTEGER, 0, 100);

  test("a live thread is indexed after the archive in each thread, from the first row in one with none, and refreshing again with the same rows and texts changes nothing", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse door", 0), message("a1", "repainted", 1)]);
    (await w.index()).close();
    const texts = new Texts();
    const threads = [
      live("main", [message("u2", "and the lamp", 2), message("a2", "lit", "not a time")]),
      live("garden", [message("u3", "beans", 3), message("a3", "up", 4)]),
    ];
    expect(refreshLiveRows(w.indexPath, "main", threads, texts)).toBe(true);
    const index = HistoryIndex.open(w.indexPath);
    try {
      expect(rows(index, "main").map((row) => [row.msg_id, row.seq, row.run, row.live])).toEqual([["u1", 1, 0, 0], ["a1", 2, 0, 0], ["u2", 3, 0, 1], ["a2", 4, 0, 1]]);
      expect(rows(index, "garden").map((row) => [row.msg_id, row.seq, row.run])).toEqual([["u3", 1, 0], ["a3", 2, 0]]);
      expect(required(index.find("a2")).ts).toBe(Date.parse("2026-11-01T09:02:00Z"));
      const all = [...rows(index, "main"), ...rows(index, "garden")].map((row) => row.id).sort((a, b) => a - b);
      expect(all).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      index.close();
    }
    expect(refreshLiveRows(w.indexPath, "main", threads, texts)).toBe(false);
    expect(refreshLiveRows(w.indexPath, "main", threads, new Texts({ picture: false }))).toBe(true);
  });

  test("a garden thread's first live row counts from nothing when the archive holds none of it", async () => {
    const w = await archive();
    (await w.index()).close();
    refreshLiveRows(w.indexPath, "main", [live("garden", [message("u3", "beans", "not a time")])], new Texts());
    const index = HistoryIndex.open(w.indexPath);
    try {
      expect(rows(index, "garden").map((row) => [row.msg_id, row.seq, row.run, row.ts])).toEqual([["u3", 1, 0, 0]]);
    } finally {
      index.close();
    }
  });

  test("notes, empty messages and a message seen twice in a thread are left out, and one already archived in its thread is not indexed again", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse door", 0)]);
    (await w.index()).close();
    refreshLiveRows(w.indexPath, "main", [live("main", [
      message("u1", "the lighthouse door", 0),
      message("u9", "a note from a wake", 1, { origin: "autonomous" }),
      message("u2", "", 2),
      message("u3", "twice", 3),
      message("u3", "twice", 3),
    ])], new Texts());
    const index = HistoryIndex.open(w.indexPath);
    try {
      expect(rows(index, "main").map((row) => row.msg_id)).toEqual(["u1", "u3"]);
    } finally {
      index.close();
    }
  });

  test("a live message the archive or another live thread already holds is a copy of the first, and a live row that changes leaves no trace in search", async () => {
    const w = await archive();
    w.put("main", 0, [message("u1", "the lighthouse door", 0)]);
    w.put("story", 0, [message("u1", "the lighthouse door", 0)]);
    (await w.index()).close();
    refreshLiveRows(w.indexPath, "main", [
      live("garden", [message("u1", "the lighthouse door", 0), message("u5", "shared bean", 5)]),
      live("notes", [message("u5", "shared bean", 5)]),
    ], new Texts());
    let index = HistoryIndex.open(w.indexPath);
    try {
      const original = required(index.find("u1", "main"));
      expect(required(index.find("u1", "story")).copy_of).toBe(original.id);
      expect(required(index.find("u1", "garden")).copy_of).toBe(original.id);
      const bean = required(index.find("u5", "garden"));
      expect([bean.copy_of, required(index.find("u5", "notes")).copy_of]).toEqual([null, bean.id]);
      expect(ids(index.search("words", "bean", {}, "newest", 10, 0))).toEqual(["u5"]);
    } finally {
      index.close();
    }
    refreshLiveRows(w.indexPath, "main", [live("garden", [message("u6", "pea", 6)])], new Texts());
    index = HistoryIndex.open(w.indexPath);
    try {
      expect(index.search("words", "bean", {}, "newest", 10, 0)).toEqual([]);
      expect(ids(index.search("words", "pea", {}, "newest", 10, 0))).toEqual(["u6"]);
    } finally {
      index.close();
    }
  });
});
