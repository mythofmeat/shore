import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { historyIndexSection } from "../src/commands/history_index.ts";
import { HISTORY_DB_FILE, HistoryStore } from "../src/engine/history_store.ts";
import type { Message } from "../src/engine/types.ts";
import { HISTORY_INDEX_FILE, HistoryIndex } from "../src/memory/history_index.ts";
import { HistoryIndexService } from "../src/memory/history_index_service.ts";
import { writeDurable } from "../src/storage/files.ts";
import { handleReadChatLogs, handleSearchChatLogs, type ChatLogOptions } from "../src/tools/history.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = Date.parse("2026-08-20T12:00:00Z");

function message(id: string, role: Message["role"], text: string, timestamp: string, extra: Partial<Message> = {}): Message {
  return { msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], timestamp, ...extra };
}

function archive(dir: string, index: number, messages: Message[], key = basename(dir)): void {
  const store = HistoryStore.open(join(dirname(dir), HISTORY_DB_FILE));
  store.putSegment(key, index, { file: HISTORY_DB_FILE, message_count: messages.length, compacted_at: "2026-08-20T00:00:00Z" }, messages);
  store.close();
}

async function history(...segments: Message[][]): Promise<string> {
  const dir = join(testTmp(`chat-logs-${crypto.randomUUID()}`), "ada");
  await mkdir(dir, { recursive: true });
  segments.forEach((messages, index) => { archive(dir, index, messages); });
  return dir;
}

function options(dir: string, over: Partial<ChatLogOptions> = {}): ChatLogOptions {
  return { character: basename(dir), dbPath: join(dirname(dir), HISTORY_DB_FILE), userName: "robin", timeZone: "UTC", now: () => NOW, ...over };
}

async function search(dir: string, input: Record<string, unknown>, over: Partial<ChatLogOptions> = {}): Promise<string> {
  return await handleSearchChatLogs(input, dir, options(dir, over));
}

async function read(dir: string, input: Record<string, unknown>, over: Partial<ChatLogOptions> = {}): Promise<string> {
  return await handleReadChatLogs(input, dir, options(dir, over));
}

const picnic = [
  message("m1", "user", "We baked a lemon tart for the picnic.", "2026-08-01T10:00:00Z"),
  message("m2", "assistant", "The lemon tart came out of the oven golden.", "2026-08-01T10:05:00Z"),
  message("m3", "user", "Only lemon here.", "2026-08-02T09:00:00Z"),
];

describe("search_chat_logs", () => {
  test("prints the total and one line per hit", async () => {
    const dir = await history(picnic);
    expect(await search(dir, { query: "lemon tart", sort: "oldest" })).toBe([
      "lemon tart: 2 matches, showing 1–2, oldest first",
      "",
      "2026-08-01 Sat 10:00  robin  We baked a [lemon] [tart] for the picnic.  m1",
      "2026-08-01 Sat 10:05  ada    The [lemon] [tart] came out of the oven golden.  m2",
    ].join("\n"));
  });

  test("sorts by best match, oldest or newest", async () => {
    const dir = await history([
      message("long", "user", "a long note about the weather, the garden, the neighbours and finally a tart", "2026-08-01T10:00:00Z"),
      message("short", "user", "tart", "2026-08-02T10:00:00Z"),
      message("middle", "user", "a tart for later", "2026-08-03T10:00:00Z"),
    ]);
    const ids = async (sort?: string) => (await search(dir, { query: "tart", ...(sort === undefined ? {} : { sort }) }))
      .split("\n").slice(2).map((line) => line.split("  ").at(-1));
    expect(await ids()).toEqual(["short", "middle", "long"]);
    expect(await ids("oldest")).toEqual(["long", "short", "middle"]);
    expect(await ids("newest")).toEqual(["middle", "short", "long"]);
    expect(await outcomeOf(search(dir, { query: "tart", sort: "random" }))).toThrow("sort must be best, oldest or newest");
  });

  test("reads FTS5 phrases, OR, NOT, prefixes and NEAR", async () => {
    const dir = await history([
      message("a", "user", "the apple orchard was quiet", "2026-08-01T10:00:00Z"),
      message("b", "user", "an orchard of pears", "2026-08-01T10:01:00Z"),
      message("c", "user", "baking, baked, bakes", "2026-08-01T10:02:00Z"),
      message("d", "user", "café crème", "2026-08-01T10:03:00Z"),
    ]);
    const total = async (query: string) => (await search(dir, { query })).split("\n")[0];
    expect(await total('"apple orchard"')).toBe('"apple orchard": 1 match, showing 1–1, best match first');
    expect(await total("apple OR pears")).toStartWith("apple OR pears: 2 matches");
    expect(await total("orchard NOT pears")).toStartWith("orchard NOT pears: 1 match");
    expect(await total("bake*")).toStartWith("bake*: 1 match");
    expect(await total("NEAR(apple quiet, 3)")).toStartWith("NEAR(apple quiet, 3): 1 match");
    expect(await total("cafe creme")).toStartWith("cafe creme: 1 match");
  });

  test("an invalid FTS5 query is searched word by word, and says so", async () => {
    const dir = await history([message("a", "user", "robin's walk-in pantry", "2026-08-01T10:00:00Z")]);
    const out = await search(dir, { query: "robin's walk-in" });
    expect(out.split("\n").slice(0, 2)).toEqual([
      'Not valid FTS5 syntax (fts5: syntax error near "\'"), so each word was searched as written: "robin\'s" "walk-in"',
      "robin's walk-in: 1 match, showing 1–1, best match first",
    ]);
  });

  test("substring matching finds text inside words", async () => {
    const dir = await history(picnic);
    expect(await search(dir, { query: "EMON", match: "substring" })).toBe([
      "EMON (substring): 3 matches, showing 1–3, newest first",
      "",
      "2026-08-02 Sun 09:00  robin  Only l[emon] here.  m3",
      "2026-08-01 Sat 10:05  ada    The l[emon] tart came out of the oven golden.  m2",
      "2026-08-01 Sat 10:00  robin  We baked a l[emon] tart for the picnic.  m1",
    ].join("\n"));
    expect(await search(dir, { query: "50%_", match: "substring" })).toStartWith("50%_ (substring): 0 matches.");
  });

  test("no match says what was searched, by instant rather than by string", async () => {
    const dir = await history([
      message("late", "user", "west coast", "2026-08-01T23:00:00-05:00"),
      message("early", "user", "utc", "2026-08-02T01:00:00Z"),
      message("first", "user", "start", "2026-07-30T08:00:00Z"),
    ]);
    expect(await search(dir, { query: "zeppelin" })).toBe([
      "zeppelin: 0 matches.",
      "Searched 3 archived messages, 2026-07-30 → 2026-08-02 Sun 04:00. Newer messages are still in your context and aren't searched.",
      'For partial words, typos or CJK, try match="substring".',
    ].join("\n"));
  });

  test("searches the last 6 months unless told otherwise, and counts what it left out", async () => {
    const dir = await history([
      message("old", "user", "the lighthouse trip", "2026-01-10T10:00:00Z"),
      message("older", "user", "lighthouse keeper story", "2025-12-01T10:00:00Z"),
      message("recent", "user", "back at the lighthouse", "2026-08-01T10:00:00Z"),
    ]);
    expect((await search(dir, { query: "lighthouse" })).split("\n")[0])
      .toBe("lighthouse: 1 match in the last 6 months (2 older), showing 1–1, best match first");
    expect(await search(dir, { query: "keeper" })).toBe("keeper: 0 matches in the last 6 months (1 older).");
    expect((await search(dir, { query: "lighthouse", all_time: true })).split("\n")[0]).toBe("lighthouse: 3 matches, showing 1–3, best match first");
    expect((await search(dir, { query: "lighthouse", start: "2025-01-01" })).split("\n")[0])
      .toBe("lighthouse: 3 matches since 2025-01-01, showing 1–3, best match first");
    expect((await search(dir, { query: "back" })).split("\n")[0]).toBe("back: 1 match, showing 1–1, best match first");
  });

  test("filters by speaker, by role or by name, and by thread", async () => {
    const dir = await history(picnic);
    archive(dir, 0, [message("s1", "assistant", "a lemon from the side thread", "2026-08-03T10:00:00Z")], "ada/side");
    const first = async (input: Record<string, unknown>) => (await search(dir, { query: "lemon", ...input })).split("\n")[0];
    expect(await first({ speaker: "user" })).toBe("lemon: 2 matches from robin, showing 1–2, best match first");
    expect(await first({ speaker: "Robin" })).toBe("lemon: 2 matches from robin, showing 1–2, best match first");
    expect(await first({ speaker: "ADA" })).toBe("lemon: 2 matches from ada, showing 1–2, best match first");
    expect(await first({ thread: "side", speaker: "character" })).toBe("lemon: 1 match from ada in thread side, showing 1–1, best match first");
    expect(await search(dir, { query: "lemon", thread: "side" })).toContain("[side] a [lemon] from the side thread  s1");
    expect(await outcomeOf(search(dir, { query: "lemon", speaker: "bob" }))).toThrow("speaker must be user, character, robin or ada");
    expect(await outcomeOf(search(dir, { query: "lemon", thread: "nowhere" }))).toThrow('no archived thread is named "nowhere"; archived threads: main, side');
  });

  test("pages with limit and offset", async () => {
    const dir = await history(picnic);
    const out = await search(dir, { query: "lemon", sort: "oldest", limit: 2 });
    expect(out.split("\n")[0]).toBe("lemon: 3 matches, showing 1–2, oldest first");
    expect(out).toEndWith("Next page: offset=2");
    const next = await search(dir, { query: "lemon", sort: "oldest", limit: 2, offset: 2 });
    expect(next).toBe(["lemon: 3 matches, showing 3–3, oldest first", "", "2026-08-02 Sun 09:00  robin  Only [lemon] here.  m3"].join("\n"));
    expect(await outcomeOf(search(dir, { query: "lemon", limit: -1 }))).toThrow("limit must be a whole number, 0 or more");
  });

  test("only what was said is searched: not thinking, tool results, alternatives or the active conversation", async () => {
    const said = message("a1", "assistant", "visible reply", "2026-08-01T10:00:00Z", {
      alternatives: [{ content: "regenerated draft", images: [], content_blocks: [{ type: "text", text: "regenerated draft" }], timestamp: "2026-08-01T10:00:00Z" }],
      alt_index: 0,
      alt_count: 1,
    });
    said.content_blocks.push({ type: "thinking", thinking: "private plan" });
    const tool = message("t1", "user", "", "2026-08-01T10:01:00Z");
    tool.content_blocks = [{ type: "tool_result", tool_use_id: "x", content: "tool secret" }];
    const dir = await history([said, tool]);
    await mkdir(join(dir, "threads", "main"), { recursive: true });
    writeDurable(join(dir, "threads", "main", "active.jsonl"), `${JSON.stringify(message("u9", "user", "fresh words", "2026-08-20T10:00:00Z"))}\n`);
    for (const query of ["private", "tool", "regenerated", "fresh"]) expect(await search(dir, { query })).toStartWith(`${query}: 0 matches.`);
    expect(await search(dir, { query: "visible" })).toStartWith("visible: 1 match");
  });

  test("a message carried into later segments is one match and is read once", async () => {
    const carried = message("c1", "user", "the carried question", "2026-08-01T10:00:00Z");
    const dir = await history(
      [message("p1", "assistant", "before it", "2026-08-01T09:59:00Z"), carried],
      [carried, message("n1", "assistant", "the answer", "2026-08-01T10:01:00Z")],
    );
    expect(await search(dir, { query: "carried" })).toStartWith("carried: 1 match");
    const context = await read(dir, { around: "n1" });
    expect(context).toContain("n1 in main: 2 before, 0 after");
    expect(context.match(/the carried question/g)).toHaveLength(1);
  });

  test("timestamps in any stored shape come out in the local zone", async () => {
    const dir = await history([
      message("z", "user", "clock one", "2026-08-01T01:00:00Z"),
      message("offset", "user", "clock two", "2026-08-01T11:30:00+10:00"),
      message("nanos", "user", "clock three", "2026-08-01T02:15:30.123456789+00:00"),
    ]);
    const lines = (await search(dir, { query: "clock", sort: "oldest" }, { timeZone: "Asia/Tokyo" })).split("\n").slice(2);
    expect(lines.map((line) => line.slice(0, 20))).toEqual(["2026-08-01 Sat 10:00", "2026-08-01 Sat 10:30", "2026-08-01 Sat 11:15"]);
  });
});

describe("read_chat_logs", () => {
  test("around marks the message and its neighbours across segments, with gaps marked", async () => {
    const dir = await history(
      [message("m1", "user", "hello", "2026-08-01T10:00:00Z"), message("m2", "assistant", "hi there", "2026-08-01T10:01:00Z")],
      [message("m3", "user", "back again", "2026-08-01T13:31:00Z"), message("m4", "assistant", "welcome back", "2026-08-01T13:32:00Z")],
    );
    expect(await read(dir, { around: "m3", before: 2, after: 1 })).toBe([
      "m3 in main: 2 before, 1 after (UTC)",
      "",
      "2026-08-01 Sat 10:00  robin  m1",
      "hello",
      "",
      "2026-08-01 Sat 10:01  ada  m2",
      "hi there",
      "",
      "· · · 3 h 30 min later · · ·",
      "",
      "▶ 2026-08-01 Sat 13:31  robin  m3",
      "back again",
      "",
      "2026-08-01 Sat 13:32  ada  m4",
      "welcome back",
    ].join("\n"));
    expect(await read(dir, { around: "m9" })).toBe("No archived message has id m9. Messages still in your context aren't archived yet.");
  });

  test("around stops near 12,000 characters, leaving out the farthest messages first", async () => {
    const long = (id: string, minute: number) =>
      message(id, minute % 2 === 0 ? "user" : "assistant", `${id} ${"word ".repeat(600)}`, `2026-08-01T10:${String(minute).padStart(2, "0")}:00Z`);
    const dir = await history(Array.from({ length: 11 }, (_, i) => long(`m${String(i)}`, i)));
    const out = await read(dir, { around: "m5", before: 5, after: 5 });
    expect(out.split("\n")[0]).toBe("m5 in main: 1 before, 1 after (UTC)");
    expect(out).toContain("m4 word");
    expect(out).toContain("m6 word");
    expect(out).not.toContain("m3 word");
    expect(out).toEndWith("Stopped at about 12,000 characters; 4 earlier and 4 later messages not shown.");
  });

  test("a range reads in order, one page at a time", async () => {
    const dir = await history(Array.from({ length: 15 }, (_, i) =>
      message(`r${String(i)}`, "user", `r${String(i)} ${"word ".repeat(200)}`, `2026-08-01T10:${String(i).padStart(2, "0")}:00Z`)));
    const first = await read(dir, { start: "2026-08-01", end: "2026-08-01" });
    expect(first.split("\n")[0]).toBe("main, 2026-08-01 → 2026-08-01: messages 1–11 of 15 (UTC)");
    expect(first).toEndWith("Next page: offset=11");
    const second = await read(dir, { start: "2026-08-01", end: "2026-08-01", offset: 11 });
    expect(second.split("\n")[0]).toBe("main, 2026-08-01 → 2026-08-01: messages 12–15 of 15 (UTC)");
    expect(second).not.toContain("Next page");
    expect(await read(dir, { start: "2026-08-01T10:03", end: "2026-08-01T10:04" })).toStartWith(
      "main, 2026-08-01T10:03 → 2026-08-01T10:04: messages 1–2 of 2",
    );
    expect(await read(dir, { start: "2026-08-02" })).toBe(
      "main, from 2026-08-02: no archived messages. The archive runs 2026-08-01 → 2026-08-01 Sat 10:14; newer messages are still in your context.",
    );
  });

  test("a range reads main unless another thread is named", async () => {
    const dir = await history(picnic);
    archive(dir, 0, [message("s1", "assistant", "side words", "2026-08-01T11:00:00Z")], "ada/side");
    expect(await read(dir, { start: "2026-08-01" })).not.toContain("side words");
    expect(await read(dir, { start: "2026-08-01", thread: "side" })).toContain("side words");
  });

  test("an overview splits a day at 90-minute gaps and names the first line", async () => {
    const heartbeat = { origin: "autonomous" as const };
    const dir = await history([
      message("a1", "user", "late hello", "2026-08-09T23:30:00Z"),
      message("a2", "assistant", "still up", "2026-08-10T00:15:00Z"),
      message("b1", "assistant", "a thought while you slept", "2026-08-10T06:00:00Z", heartbeat),
      message("c1", "assistant", "good morning?", "2026-08-10T09:00:00Z", heartbeat),
      message("c2", "user", "morning! sorry, slept in", "2026-08-10T09:20:00Z"),
      message("c3", "assistant", "no worries", "2026-08-10T09:25:00Z"),
      message("d1", "user", "one more thing", "2026-08-10T23:00:00Z"),
      message("d2", "assistant", "go on", "2026-08-11T00:20:00Z"),
      message("e1", "user", "next day", "2026-08-11T05:00:00Z"),
    ]);
    expect(await read(dir, { overview: "2026-08-10" })).toBe([
      "2026-08-10 Mon: 4 conversations, 6 messages that day (split at gaps of 90+ min, UTC)",
      "",
      "Sun 23:30 → 00:15  2 msgs  first: late hello",
      "06:00 → 06:00      1 msg   a heartbeat from ada, no reply from robin",
      "09:00 → 09:25      3 msgs  first: morning! sorry, slept in",
      "23:00 → Tue 00:20  2 msgs  first: one more thing",
    ].join("\n"));
    expect(await read(dir, { overview: "2026-08-15" })).toBe(
      "2026-08-15: no archived messages on this day. The archive runs 2026-08-09 → 2026-08-11 Tue 05:00; newer messages are still in your context.",
    );
  });

  test("takes exactly one way of reading, and valid dates", async () => {
    const dir = await history(picnic);
    expect(await outcomeOf(read(dir, {}))).toThrow("give exactly one of around, overview, or start and end");
    expect(await outcomeOf(read(dir, { around: "m1", overview: "2026-08-01" }))).toThrow("give exactly one of around, overview, or start and end");
    expect(await outcomeOf(read(dir, { start: "2026-02-30" }))).toThrow("start must be a date like 2026-03-01");
    expect(await outcomeOf(read(dir, { start: "2026-08-02", end: "2026-08-01" }))).toThrow("start must not be after end");
    expect(await outcomeOf(read(dir, { overview: "August 1" }))).toThrow("overview must be a date like 2026-03-01");
  });
});

describe("the chat log index", () => {
  test("is a read-only file, rebuilt when the archive changes and not when the conversation does", async () => {
    const dir = await history(picnic);
    const path = join(dir, HISTORY_INDEX_FILE);
    await search(dir, { query: "lemon" });
    const built = statSync(path);
    expect(built.mode & 0o777).toBe(0o444);
    await mkdir(join(dir, "threads", "main"), { recursive: true });
    writeDurable(join(dir, "threads", "main", "active.jsonl"), `${JSON.stringify(message("u9", "user", "lemon again", "2026-08-20T10:00:00Z"))}\n`);
    await search(dir, { query: "lemon" });
    expect(statSync(path).ino).toBe(built.ino);
    archive(dir, 1, [message("m4", "user", "a lemon sorbet", "2026-08-03T10:00:00Z")]);
    expect(await search(dir, { query: "lemon" })).toStartWith("lemon: 4 matches");
    expect(statSync(path).ino).not.toBe(built.ino);
    archive(dir, 0, [message("m1", "user", "We baked a plum tart for the picnic.", "2026-08-01T10:00:00Z")]);
    expect(await search(dir, { query: "lemon" })).toStartWith("lemon: 1 match");
  });

  test("a deleted or corrupt index is rebuilt from the archive", async () => {
    const dir = await history(picnic);
    const path = join(dir, HISTORY_INDEX_FILE);
    await search(dir, { query: "lemon" });
    await unlink(path);
    expect(await search(dir, { query: "lemon" })).toStartWith("lemon: 3 matches");
    await unlink(path);
    writeFileSync(path, "not a database");
    expect(await search(dir, { query: "lemon" })).toStartWith("lemon: 3 matches");
  });
});

describe("the chat log index service", () => {
  async function registered(now: { value: number }) {
    const dir = await history(picnic);
    const service = new HistoryIndexService({ now: () => now.value });
    const indexPath = join(dirname(dir), "cache", HISTORY_INDEX_FILE);
    service.register({ character: "ada", conversationDir: dir, dbPath: join(dirname(dir), HISTORY_DB_FILE), indexPath });
    const indexed = () => {
      const index = HistoryIndex.open(indexPath);
      try {
        return index.metadata("messages");
      } finally {
        index.close();
      }
    };
    return { dir, service, indexPath, indexed };
  }

  test("builds at start and rebuilds once history changes, but not while a reply is being written", async () => {
    const { dir, service, indexed } = await registered({ value: NOW });
    await service.reconcileAll();
    expect(indexed()).toBe("3");
    archive(dir, 1, [message("m4", "user", "a lemon sorbet", "2026-08-03T10:00:00Z")]);
    service.noteMutation("ada");
    const end = service.beginForeground();
    await service.runOnce();
    expect(indexed()).toBe("3");
    end();
    await service.runOnce();
    expect(indexed()).toBe("4");
    expect(historyIndexSection({ progressFor: (name) => service.progress(name) }, "ada")).toMatchObject({
      messages: 4, background: { failures: 0 },
    });
  });

  test("records a failure readably and retries after a back-off", async () => {
    const now = { value: NOW };
    const dir = await history(picnic);
    const service = new HistoryIndexService({ now: () => now.value });
    service.register({ character: "ada", conversationDir: dir, dbPath: dir, indexPath: join(dir, HISTORY_INDEX_FILE) });
    await service.runOnce();
    expect(service.progress("ada")).toMatchObject({ failures: 1, retryAt: NOW + 1_000 });
    expect(typeof service.progress("ada")?.lastError).toBe("string");
    await service.runOnce();
    expect(service.progress("ada")?.failures).toBe(1);
    now.value += 1_000;
    await service.runOnce();
    expect(service.progress("ada")).toMatchObject({ failures: 2, retryAt: now.value + 2_000 });
  });
});
