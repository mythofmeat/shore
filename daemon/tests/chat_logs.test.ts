import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { archiveKey, threadDataDir } from "../src/config/dirs.ts";
import { HISTORY_DB_FILE } from "../src/engine/history_store.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { createThread, ensureWakesThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { handleChatLogs, type ChatLogOptions } from "../src/tools/history.ts";
import { required } from "../src/util/required.ts";
import { handlesUnder } from "./support/handles.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-05T10:00:00Z";

function message(id: string, text: string, timestamp: string, extra: Partial<Message> = {}): Message {
  return {
    msg_id: id,
    role: id.startsWith("u") ? "user" : "assistant",
    content: text,
    images: [],
    content_blocks: [{ type: "text", text }],
    timestamp,
    ...extra,
  };
}

interface World {
  data: string;
  options: ChatLogOptions;
  archive: (thread: string, messages: Message[], extra?: { excluded?: boolean; at?: string }) => Promise<void>;
  ask: (input: Record<string, unknown>, options?: Partial<ChatLogOptions>) => Promise<string>;
}

async function world(...threads: string[]): Promise<World> {
  const root = testTmp(`chat-logs-list-${crypto.randomUUID()}`);
  const data = join(root, "data");
  await mkdir(join(data, "frank"), { recursive: true });
  await mkdir(join(root, "cache"), { recursive: true });
  initializeDatabase(data);
  for (const thread of threads) {
    if (thread === "wakes") await ensureWakesThread(data, "frank", NOW);
    else await createThread(data, "frank", thread, NOW);
  }
  const dbPath = join(data, HISTORY_DB_FILE);
  const options: ChatLogOptions = { character: "frank", dbPath, dataDir: data, thread: "main", indexPath: join(root, "cache", "chat_logs.db"), timeZone: "UTC", userName: "sam" };
  return {
    data,
    options,
    archive: async (thread, messages, extra = {}) => {
      await archiveAndRetain(
        threadDataDir(data, "frank", thread),
        { dbPath, archiveKey: archiveKey("frank", thread) },
        0,
        serializeMessages(messages),
        () => extra.at ?? NOW,
        () => crypto.randomUUID(),
        undefined,
        extra.excluded === true ? { excluded: true } : {},
      );
    },
    ask: async (input, over = {}) => await handleChatLogs(input, threadDataDir(data, "frank", "main"), { ...options, ...over }),
  };
}

const day = (date: string, time: string): string => `2026-11-${date}T${time}:00Z`;

describe("the working from a character's wakes, kept in its wakes thread", () => {
  async function kept(): Promise<World> {
    const w = await world("story", "wakes");
    await w.archive("main", [message("u1", "the keeper's name is Mara", day("01", "09:00")), message("a1", "Mara it is", day("01", "09:01"))]);
    await w.archive("wakes", [message("w1", "Mara keeps a spare key in the boathouse", day("01", "12:00"), { origin: "autonomous" })]);
    writeDurable(threadFile(w.data, "frank", "wakes", "active.jsonl"), serializeMessages([
      message("w2", "Mara oiled the hinges", day("01", "13:00"), { origin: "autonomous" }),
    ]));
    return w;
  }
  const found = (result: string): string[] => result.split("\n").slice(2);

  test("is left out of a search that names no thread", async () => {
    const w = await kept();
    expect(found(await w.ask({ action: "search", query: "Mara", all_time: true, sort: "oldest" }, { thread: "story" }))).toEqual([
      "2026-11-01 Sun 09:00  sam    the keeper's name is [Mara]  u1",
      "2026-11-01 Sun 09:01  frank  [Mara] it is  a1",
    ]);
    expect(await w.ask({ action: "search", query: "hinges", match: "substring", all_time: true }, { thread: "story" })).toBe(
      "hinges (substring): 0 matches.\nSearched 2 messages from every thread, 2026-11-01 → 2026-11-01 Sun 09:01. This thread's messages in your context aren't searched.\n" +
        "What you wrote while working in your wakes wasn't searched: for that, try thread=\"wakes\".",
    );
  });

  test("is searched when the search names the wakes thread, and no other thread's search finds it", async () => {
    const w = await kept();
    expect(found(await w.ask({ action: "search", query: "Mara", all_time: true, sort: "oldest", thread: "wakes" }, { thread: "story" }))).toEqual([
      "2026-11-01 Sun 12:00  frank  [wakes] (wake) [Mara] keeps a spare key in the boathouse  w1",
      "2026-11-01 Sun 13:00  frank  [wakes] (wake) [Mara] oiled the hinges  w2",
    ]);
    expect(found(await w.ask({ action: "search", query: "Mara", all_time: true, sort: "oldest", thread: "main" }, { thread: "story" }))).toEqual([
      "2026-11-01 Sun 09:00  sam    the keeper's name is [Mara]  u1",
      "2026-11-01 Sun 09:01  frank  [Mara] it is  a1",
    ]);
  });

  test("is read in order when the read names the wakes thread or one of its messages", async () => {
    const w = await kept();
    expect((await w.ask({ action: "read", start: "2026-11-01", thread: "wakes" }, { thread: "story" })).split("\n").filter((line) => line.startsWith("2026"))).toEqual([
      "2026-11-01 Sun 12:00  frank  (wake)  w1",
      "2026-11-01 Sun 13:00  frank  (wake)  w2",
    ]);
    expect(await w.ask({ action: "read", around: "w1", before: 0, after: 0 }, { thread: "story" })).toContain("▶ 2026-11-01 Sun 12:00  frank  (wake)  w1\nMara keeps a spare key in the boathouse");
  });

  test("is left out of a day's overview", async () => {
    const w = await kept();
    expect((await w.ask({ action: "read", overview: "2026-11-01" }, { thread: "story" })).split("\n")).toEqual([
      "2026-11-01 Sun: 1 conversation, 2 messages that day (split at gaps of 90+ min, UTC)",
      "",
      "09:00 → 09:01  2 msgs  first: the keeper's name is Mara",
    ]);
  });

  test("is still found where a message of it is also in another thread", async () => {
    const w = await world("wakes", "zebra");
    const both = [message("w1", "Mara keeps a spare key in the boathouse", day("01", "12:00"), { origin: "autonomous" })];
    await w.archive("wakes", both);
    await w.archive("zebra", both);
    expect(found(await w.ask({ action: "search", query: "Mara", all_time: true }))).toEqual([
      "2026-11-01 Sun 12:00  frank  [wakes] (wake) [Mara] keeps a spare key in the boathouse  w1 · also in zebra",
    ]);
  });

  test("is searched like any thread by a character that keeps no wakes thread, or whose data folder isn't known", async () => {
    const w = await world("story");
    await w.archive("story", [message("w1", "Mara keeps a spare key in the boathouse", day("01", "12:00"), { origin: "autonomous" })]);
    const hit = "2026-11-01 Sun 12:00  frank  [story] (wake) [Mara] keeps a spare key in the boathouse  w1";
    expect(found(await w.ask({ action: "search", query: "Mara", all_time: true }))).toEqual([hit]);
    const { dataDir: _unknown, ...withoutData } = w.options;
    expect(found(await handleChatLogs({ action: "search", query: "Mara", all_time: true }, threadDataDir(w.data, "frank", "main"), withoutData))).toEqual([hit]);
  });
});

describe("a search of the chat logs", () => {
  const MAY = "2026-05-05T00:00:00.000Z";
  async function kept(): Promise<World> {
    const w = await world("story", "wakes");
    await w.archive("main", [
      message("u0", "Mara was here before the window", "2026-05-04T23:59:59.999Z"),
      message("a0", "Mara on the first night of the window", MAY),
    ]);
    await w.archive("main", [message("u1", "the keeper's name is Mara", day("01", "09:00")), message("a1", "Mara it is", day("01", "09:01"))]);
    await w.archive("main", [message("u2", "Mara rows out at dawn", day("02", "09:00"))]);
    return w;
  }
  const from = { thread: "story", now: () => Date.parse("2026-11-05T10:00:00Z") };
  const ids = (result: string): string[] => result.split("\n").flatMap((line) => /^\d{4}-/.test(line) ? [line.slice(line.lastIndexOf("  ") + 2)] : []);

  test("looks through the last six months unless it is told otherwise, and says how many older matches there are", async () => {
    const w = await kept();
    const windowed = await w.ask({ action: "search", query: "Mara", sort: "oldest" }, from);
    expect(windowed.split("\n")[0]).toBe("Mara: 4 matches in the last 6 months (1 older), showing 1–4, oldest first");
    expect(ids(windowed)).toEqual(["a0", "u1", "a1", "u2"]);
    const all = await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: true }, from);
    expect(all.split("\n")[0]).toBe("Mara: 5 matches, showing 1–5, oldest first");
    expect(ids(all)).toEqual(["u0", "a0", "u1", "a1", "u2"]);
    expect(ids(await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: false }, from))).toEqual(["a0", "u1", "a1", "u2"]);
    expect((await w.ask({ action: "search", query: "window" }, { ...from, now: () => Date.parse("2026-11-06T10:00:00Z") })).split("\n")[0]).toBe("window: 0 matches in the last 6 months (2 older).");
  });

  test("takes a start and an end as whole days, both included, and drops the six-month window for either", async () => {
    const w = await kept();
    expect(ids(await w.ask({ action: "search", query: "Mara", sort: "oldest", start: "2026-11-02" }, from))).toEqual(["u2"]);
    expect(ids(await w.ask({ action: "search", query: "Mara", sort: "oldest", end: "2026-11-01" }, from))).toEqual(["u0", "a0", "u1", "a1"]);
    const between = await w.ask({ action: "search", query: "Mara", sort: "oldest", start: "2026-05-04", end: "2026-11-01" }, from);
    expect(between.split("\n")[0]).toBe("Mara: 4 matches between 2026-05-04 and 2026-11-01, showing 1–4, oldest first");
    expect(ids(between)).toEqual(["u0", "a0", "u1", "a1"]);
    expect(ids(await w.ask({ action: "search", query: "Mara", start: MAY, end: MAY }, from))).toEqual(["a0"]);
  });

  test("keeps to one speaker, or to one thread, when asked", async () => {
    const w = await kept();
    await w.archive("story", [message("u9", "Mara in the story", day("03", "09:00"))]);
    const spoken = await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: true, speaker: "frank" }, from);
    expect(spoken.split("\n")[0]).toBe("Mara: 2 matches from frank, showing 1–2, oldest first");
    expect(ids(spoken)).toEqual(["a0", "a1"]);
    expect(ids(await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: true, thread: "story" }, { ...from, thread: "main" }))).toEqual(["u9"]);
  });

  test("comes a page at a time, never fewer than one hit to a page", async () => {
    const w = await kept();
    const first = await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: true, limit: 1 }, from);
    expect([ids(first), first.split("\n").at(-1)]).toEqual([["u0"], "Next page: offset=1"]);
    expect(ids(await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: true, limit: 0, offset: 1 }, from))).toEqual(["a0"]);
    const last = await w.ask({ action: "search", query: "Mara", sort: "oldest", all_time: true, limit: 2, offset: 3 }, from);
    expect([ids(last), last.split("\n")[0], last.split("\n").at(-1)?.startsWith("Next page")]).toEqual([["a1", "u2"], "Mara: 5 matches, showing 4–5, oldest first", false]);
  });

  test("searches each word as written when the query isn't valid FTS5, and says so, but never for a substring", async () => {
    const w = await kept();
    expect((await w.ask({ action: "search", query: "keeper's", all_time: true }, from)).split("\n")).toEqual([
      "Not valid FTS5 syntax (fts5: syntax error near \"'\"), so each word was searched as written: \"keeper's\"",
      "keeper's: 1 match, showing 1–1, best match first",
      "",
      "2026-11-01 Sun 09:00  sam    the [keeper's] name is Mara  u1",
    ]);
    expect((await w.ask({ action: "search", query: "keeper's", match: "substring", all_time: true }, from)).split("\n")).toEqual([
      "keeper's (substring): 1 match, showing 1–1, newest first",
      "",
      "2026-11-01 Sun 09:00  sam    the [keeper's] name is Mara  u1",
    ]);
  });

  test("that finds nothing says how much was searched, and how to find part of a word", async () => {
    const w = await kept();
    expect((await w.ask({ action: "search", query: "heron", all_time: true }, from)).split("\n")).toEqual([
      "heron: 0 matches.",
      "Searched 5 messages from every thread, 2026-05-04 → 2026-11-02 Mon 09:00. This thread's messages in your context aren't searched.",
      "For partial words, typos or CJK, try match=\"substring\".",
    ]);
    const empty = await world();
    expect(await empty.ask({ action: "search", query: "heron" })).toBe(
      "heron: 0 matches.\nThere is nothing to search yet; this thread's messages in your context aren't searched.\nFor partial words, typos or CJK, try match=\"substring\".",
    );
  });

  test("that finds nothing says so when the working from the character's wakes was left out, and only then", async () => {
    const w = await kept();
    await w.archive("wakes", [message("w1", "the heron is back on the rail", day("03", "12:00"), { origin: "autonomous" })]);
    const hint = "What you wrote while working in your wakes wasn't searched: for that, try thread=\"wakes\".";
    expect((await w.ask({ action: "search", query: "heron", all_time: true }, from)).split("\n").slice(2)).toEqual([hint, "For partial words, typos or CJK, try match=\"substring\"."]);
    expect(await w.ask({ action: "search", query: "heron", all_time: true, thread: "main" }, from)).not.toContain(hint);
    expect(await w.ask({ action: "search", query: "Mara" }, { ...from, now: () => Date.parse("2027-11-05T10:00:00Z") })).toBe("Mara: 0 matches in the last 6 months (5 older).");
  });

  test("refuses a query it can't run, and says why", async () => {
    const w = await kept();
    expect(await outcomeOf(w.ask({ action: "search" }, from))).toThrow("invalid args: query is required");
    expect(await outcomeOf(w.ask({ action: "search", query: "  " }, from))).toThrow("invalid args: query is required");
    expect(await outcomeOf(w.ask({ action: "search", query: "Mara", start: "2026-11-02", end: "2026-11-01" }, from))).toThrow("invalid args: start must not be after end");
    expect(await outcomeOf(w.ask({ action: "search", query: "Mara", thread: "attic" }, from))).toThrow('invalid args: no thread with messages to read is named "attic"; threads: main');
    expect(await outcomeOf(handleChatLogs({ action: "search", query: "Mara" }, "", w.options))).toThrow("invalid args: conversation history is not configured");
  });
});

describe("the index the chat logs are searched through", () => {
  async function kept(): Promise<World> {
    const w = await world("story");
    await w.archive("main", [message("u1", "the keeper's name is Mara", day("01", "09:00")), message("a1", "Mara it is", day("01", "09:01"))]);
    return w;
  }
  const from = { thread: "story" };

  test("finds text inside words when the match is by substring", async () => {
    const w = await kept();
    expect((await w.ask({ action: "search", query: "eeper", match: "substring", all_time: true }, from)).split("\n")).toEqual([
      "eeper (substring): 1 match, showing 1–1, newest first",
      "",
      "2026-11-01 Sun 09:00  sam    the k[eeper]'s name is Mara  u1",
    ]);
  });

  test("is built again from the archive when it can't be brought up to date as it stands", async () => {
    const w = await kept();
    const search = async (): Promise<string[]> => (await w.ask({ action: "search", query: "Mara", all_time: true, sort: "oldest" }, from)).split("\n").slice(2);
    const first = await search();
    expect(first).toHaveLength(2);
    const index = new Database(required(w.options.indexPath));
    index.run("ALTER TABLE messages RENAME COLUMN wake TO heartbeat");
    index.close();
    writeDurable(threadFile(w.data, "frank", "main", "active.jsonl"), serializeMessages([message("u2", "and where is Mara now", day("02", "09:00"))]));
    expect(await search()).toEqual([...first, "2026-11-02 Mon 09:00  sam    and where is [Mara] now  u2"]);
  });

  test("is reported as unreadable when it can't be built at all", async () => {
    const w = await kept();
    await mkdir(required(w.options.indexPath), { recursive: true });
    expect(await outcomeOf(w.ask({ action: "search", query: "Mara" }, from))).toThrow("io: ");
  });

  test("is closed again after a search and a read", async () => {
    const w = await kept();
    const root = join(w.data, "..");
    await w.ask({ action: "search", query: "Mara", all_time: true }, from);
    const open = handlesUnder(root);
    for (let round = 0; round < 3; round += 1) {
      await w.ask({ action: "search", query: "Mara", all_time: true }, from);
      await w.ask({ action: "read", around: "u1" }, from);
    }
    expect(handlesUnder(root)).toBe(open);
  });
});
