import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { archiveKey, threadDataDir } from "../src/config/dirs.ts";
import { HISTORY_DB_FILE } from "../src/engine/history_store.ts";
import { serializeMessages } from "../src/engine/message_store.ts";
import { createThread } from "../src/engine/threads.ts";
import type { Message } from "../src/engine/types.ts";
import { archiveAndRetain } from "../src/memory/compaction/archive.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { Texts } from "../src/texts/texts.ts";
import { handleChatLogs, type ChatLogOptions } from "../src/tools/history.ts";
import { required } from "../src/util/required.ts";
import { outcomeOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = "2026-11-12T10:00:00Z";

function message(id: string, text: string, timestamp: string): Message {
  return { msg_id: id, role: id.startsWith("u") ? "user" : "assistant", content: text, images: [], content_blocks: [{ type: "text", text }], timestamp };
}

async function world(...threads: string[]) {
  const root = testTmp(`chat-logs-read-${crypto.randomUUID()}`);
  const data = join(root, "data");
  await mkdir(join(data, "frank"), { recursive: true });
  await mkdir(join(root, "cache"), { recursive: true });
  initializeDatabase(data);
  for (const thread of threads) await createThread(data, "frank", thread, NOW);
  const dbPath = join(data, HISTORY_DB_FILE);
  const options: ChatLogOptions = { texts: new Texts(), character: "frank", dbPath, dataDir: data, thread: "main", indexPath: join(root, "cache", "chat_logs.db"), timeZone: "UTC", userName: "sam" };
  let segment = 0;
  return {
    options,
    archive: async (thread: string, messages: Message[]) => {
      await archiveAndRetain(threadDataDir(data, "frank", thread), { dbPath, archiveKey: archiveKey("frank", thread) }, segment++, serializeMessages(messages), () => NOW, () => crypto.randomUUID(), undefined, {});
    },
    read: async (input: Record<string, unknown>, dir = threadDataDir(data, "frank", "main")) => await handleChatLogs({ action: "read", ...input }, dir, options),
  };
}

const ids = (result: string): string[] => result.split("\n").flatMap((line) => /\d{2}:\d{2} {2}\S+(?: {2}\(wake\))? {2}(\S+)$/.exec(line)?.slice(1, 2) ?? []);

const long = (length: number): string => "x".repeat(length);

describe("reading the chat logs between two times", () => {
  test("shows each message under when and who, and says how long passed where 90 minutes or more did", async () => {
    const w = await world();
    await w.archive("main", [
      message("u1", "one", "2026-11-01T10:00:00Z"),
      message("a1", "two", "2026-11-01T11:30:00Z"),
      message("u2", "three", "2026-11-01T12:59:59Z"),
      message("a2", "four", "2026-11-01T16:00:20Z"),
      message("u3", "five", "2026-11-03T15:59:20Z"),
      message("a3", "six", "2026-11-05T15:59:20Z"),
      message("u4", "seven", "2026-11-08T21:29:20Z"),
      message("a4", "eight", "2026-11-11T09:29:20Z"),
    ]);
    expect(await w.read({ start: "2026-11-01", end: "2026-11-11" })).toBe([
      "main, 2026-11-01 → 2026-11-11: messages 1–8 of 8 (UTC)",
      "",
      "2026-11-01 Sun 10:00  sam  u1", "one", "",
      "· · · 1 h 30 min later · · ·", "",
      "2026-11-01 Sun 11:30  frank  a1", "two", "",
      "2026-11-01 Sun 12:59  sam  u2", "three", "",
      "· · · 3 h later · · ·", "",
      "2026-11-01 Sun 16:00  frank  a2", "four", "",
      "· · · 47 h 59 min later · · ·", "",
      "2026-11-03 Tue 15:59  sam  u3", "five", "",
      "· · · 2 days later · · ·", "",
      "2026-11-05 Thu 15:59  frank  a3", "six", "",
      "· · · 3 days later · · ·", "",
      "2026-11-08 Sun 21:29  sam  u4", "seven", "",
      "· · · 3 days later · · ·", "",
      "2026-11-11 Wed 09:29  frank  a4", "eight",
    ].join("\n"));
  });

  test("takes a local time to the minute or the second, a whole day, or an RFC3339 time, each end included", async () => {
    const w = await world();
    await w.archive("main", [
      message("u1", "before", "2026-11-01T21:29:59Z"),
      message("a1", "at", "2026-11-01T21:30:00Z"),
      message("u2", "end of the minute", "2026-11-01T21:30:59.999Z"),
      message("a2", "the next minute", "2026-11-01T21:31:00Z"),
      message("u3", "the last of the day", "2026-11-01T23:59:59.999Z"),
      message("a3", "the next day", "2026-11-02T00:00:00Z"),
    ]);
    expect(ids(await w.read({ start: "2026-11-01T21:30", end: "2026-11-01T21:30" }))).toEqual(["a1", "u2"]);
    expect(ids(await w.read({ start: "2026-11-01 21:30:00", end: "2026-11-01t21:30:59" }))).toEqual(["a1", "u2"]);
    expect(ids(await w.read({ start: "2026-11-01T21:30:01", end: "2026-11-01T21:30:58" }))).toEqual([]);
    expect(ids(await w.read({ start: "2026-11-01T21:30", end: "2026-11-01" }))).toEqual(["a1", "u2", "a2", "u3"]);
    expect(ids(await w.read({ start: "2026-11-01T22:30:00+01:00", end: "2026-11-01T21:30:00Z" }))).toEqual(["a1"]);
    expect(await w.read({ start: "2026-11-02" })).toBe("main, from 2026-11-02: messages 1–1 of 1 (UTC)\n\n2026-11-02 Mon 00:00  frank  a3\nthe next day");
    expect(ids(await w.read({ end: "2026-11-01T21:29" }))).toEqual(["u1"]);
    expect(await w.read({ end: "2026-11-01T21:29" })).toStartWith("main, until 2026-11-01T21:29: messages 1–1 of 1 (UTC)");
  });

  test("refuses a time it can't read, or a start after the end", async () => {
    const w = await world();
    await w.archive("main", [message("u1", "one", "2026-11-01T10:00:00Z")]);
    const form = (field: string) => `invalid args: ${field} must be a date like 2026-03-01, a local time like 2026-03-01T21:30, or an RFC3339 timestamp`;
    expect(await outcomeOf(w.read({ start: "2026-02-30" }))).toThrow(form("start"));
    expect(await outcomeOf(w.read({ end: "2026-02-30T10:00" }))).toThrow(form("end"));
    expect(await outcomeOf(w.read({ start: "yesterday" }))).toThrow(form("start"));
    expect(await outcomeOf(w.read({ start: "2026-11-02", end: "2026-11-01" }))).toThrow("invalid args: start must not be after end");
  });

  test("says when there is nothing between the times, and how far the logs run", async () => {
    const empty = await world();
    expect(await empty.read({ start: "2026-11-01" })).toBe("main, from 2026-11-01: no messages. There is nothing to read yet; this thread's messages in your context aren't included.");
    const w = await world();
    await w.archive("main", [message("u1", "one", "2026-11-01T10:00:00Z"), message("a1", "two", "2026-11-01T10:01:00Z")]);
    expect(await w.read({ start: "2026-11-05" })).toBe("main, from 2026-11-05: no messages. The chat logs run 2026-11-01 → 2026-11-01 Sun 10:01; this thread's messages in your context aren't included.");
    expect(await w.read({ start: "2026-11-01", offset: 2 })).toBe("main, from 2026-11-01: 2 messages, so offset 2 is past the end.");
    expect(ids(await w.read({ start: "2026-11-01", offset: 1 }))).toEqual(["a1"]);
  });

  test("shows as many messages as fit in about 12,000 characters, always at least one, and where the next page starts", async () => {
    const w = await world();
    await w.archive("main", [
      message("u1", long(6000), "2026-11-01T10:00:00Z"),
      message("a1", long(5934), "2026-11-01T10:01:00Z"),
      message("u2", "small", "2026-11-01T10:02:00Z"),
    ]);
    const fits = await w.read({ start: "2026-11-01" });
    expect(ids(fits)).toEqual(["u1", "a1"]);
    expect(fits.split("\n").at(-1)).toBe("Next page: offset=2");
    expect(fits.split("\n")[0]).toBe("main, from 2026-11-01: messages 1–2 of 3 (UTC)");

    const big = await world();
    await big.archive("main", [message("u1", long(13_000), "2026-11-01T10:00:00Z"), message("a1", long(7000), "2026-11-01T10:01:00Z"), message("u2", long(7000), "2026-11-01T10:02:00Z")]);
    expect(ids(await big.read({ start: "2026-11-01" }))).toEqual(["u1"]);
    expect(ids(await big.read({ start: "2026-11-01", offset: 1 }))).toEqual(["a1"]);
  });

  test("counts each message as its line, its text and three characters more against the budget", async () => {
    const w = await world();
    const lengths = [2367, 2367, 2367, 2367, 2368];
    await w.archive("main", [
      ...["u1", "a1", "u2", "a2", "u3"].map((id, n) => message(id, long(lengths[n] ?? 0), `2026-11-01T10:0${String(n)}:00Z`)),
      message("a3", "a", "2026-11-01T10:05:00Z"),
    ]);
    const read = await w.read({ start: "2026-11-01" });
    expect(ids(read)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(read.split("\n").at(-1)).toBe("Next page: offset=5");
  });

  test("rounds a gap to the nearest minute", async () => {
    const w = await world();
    await w.archive("main", [message("u1", "one", "2026-11-01T00:00:00Z"), message("a1", "two", new Date(Date.parse("2026-11-01T00:00:00Z") + 120_030_600).toISOString())]);
    expect(await w.read({ start: "2026-11-01" })).toContain("· · · 33 h 21 min later · · ·");
  });

  test("reads past a hundred messages in one go when they fit", async () => {
    const w = await world();
    await w.archive("main", Array.from({ length: 101 }, (_, n) => message(`${n % 2 === 0 ? "u" : "a"}${String(n)}`, "hi", new Date(Date.parse("2026-11-01T10:00:00Z") + n * 1000).toISOString())));
    const read = await w.read({ start: "2026-11-01" });
    expect(read.split("\n")[0]).toBe("main, from 2026-11-01: messages 1–101 of 101 (UTC)");
    expect(ids(read)).toHaveLength(101);
  });

  test("reads another thread when it is named, and refuses one with no messages to read", async () => {
    const w = await world("garden");
    await w.archive("main", [message("u1", "home", "2026-11-01T10:00:00Z")]);
    await w.archive("garden", [message("u9", "roses", "2026-11-01T11:00:00Z")]);
    expect(ids(await w.read({ start: "2026-11-01", thread: "garden" }))).toEqual(["u9"]);
    expect(await outcomeOf(w.read({ start: "2026-11-01", thread: "nowhere" }))).toThrow('invalid args: no thread with messages to read is named "nowhere"; threads: main, garden');
  });
});

describe("reading the chat logs around a message", () => {
  test("shows the nearest messages on both sides that fit in about 12,000 characters, and says how many it left out", async () => {
    const w = await world();
    const names = ["u1", "a1", "u2", "a2", "u3", "a3", "u4"];
    await w.archive("main", names.map((id, n) => message(id, long(2500), `2026-11-01T10:0${String(n)}:00Z`)));
    const read = await w.read({ around: "a2", before: 3, after: 3 });
    expect(read.split("\n")[0]).toBe("a2 in main: 2 before, 1 after (UTC)");
    expect(ids(read)).toEqual(["a1", "u2", "a2", "u3"]);
    expect(read.split("\n").at(-1)).toBe("Stopped at about 12,000 characters; 1 earlier and 2 later messages not shown.");
  });

  test("keeps a message that fills the budget exactly, and counts what's left out on one side alone", async () => {
    const exact = await world();
    await exact.archive("main", [message("u1", long(5934), "2026-11-01T10:00:00Z"), message("a1", long(6000), "2026-11-01T10:01:00Z")]);
    const read = await exact.read({ around: "a1", before: 1, after: 0 });
    expect(ids(read)).toEqual(["u1", "a1"]);
    expect(read).not.toContain("Stopped");

    const later = await world();
    await later.archive("main", ["u1", "a1", "u2", "a2"].map((id, n) => message(id, long(3500), `2026-11-01T10:0${String(n)}:00Z`)));
    expect((await later.read({ around: "u1", before: 0, after: 3 })).split("\n").at(-1)).toBe("Stopped at about 12,000 characters; 1 later message not shown.");

    const earlier = await world();
    await earlier.archive("main", ["u1", "a1", "u2", "a2", "u3"].map((id, n) => message(id, long(3500), `2026-11-01T10:0${String(n)}:00Z`)));
    const back = await earlier.read({ around: "u3", before: 4, after: 0 });
    expect(ids(back)).toEqual(["u2", "a2", "u3"]);
    expect(back.split("\n").at(-1)).toBe("Stopped at about 12,000 characters; 2 earlier messages not shown.");
  });

  test("goes on along the side that has more once the other runs out", async () => {
    const w = await world();
    await w.archive("main", ["u1", "a1", "u2", "a2", "u3"].map((id, n) => message(id, "short", `2026-11-01T10:0${String(n)}:00Z`)));
    expect(ids(await w.read({ around: "a1", before: 3, after: 3 }))).toEqual(["u1", "a1", "u2", "a2", "u3"]);
  });

  test("says which other threads the message is in", async () => {
    const w = await world("garden");
    const shared = [message("u1", "the shared start", "2026-11-01T10:00:00Z")];
    await w.archive("main", shared);
    await w.archive("garden", [...shared, message("a5", "roses", "2026-11-01T10:05:00Z")]);
    const read = await w.read({ around: "u1", thread: "main" });
    expect(read.split("\n").slice(0, 2)).toEqual(["u1 in main: 0 before, 0 after (UTC)", "Also in thread garden."]);
    expect((await w.read({ around: "a5" })).split("\n")[1]).toBe("");
  });

  test("says when no message has the id, and refuses a thread with no messages to read", async () => {
    const w = await world("garden");
    await w.archive("main", [message("u1", "home", "2026-11-01T10:00:00Z")]);
    await w.archive("garden", [message("u9", "roses", "2026-11-01T11:00:00Z")]);
    expect(await w.read({ around: "u7" })).toBe("No message has id u7. This thread's messages in your context aren't included.");
    expect(await w.read({ around: "u1", thread: "garden" })).toBe("No message has id u1 in thread garden. This thread's messages in your context aren't included.");
    expect(await outcomeOf(w.read({ around: "u1", thread: "nowhere" }))).toThrow('invalid args: no thread with messages to read is named "nowhere"; threads: main, garden');
  });
});

describe("a day's overview of the chat logs", () => {
  test("counts what falls on the day, from the first millisecond to the last", async () => {
    const w = await world();
    await w.archive("main", [
      message("u1", "late the day before", "2026-10-31T23:59:59.999Z"),
      message("a1", "the first moment", "2026-11-01T00:00:00Z"),
      message("u2", "the last moment", "2026-11-01T23:59:59.999Z"),
      message("a2", "the next day", "2026-11-02T00:00:00Z"),
    ]);
    expect((await w.read({ overview: "2026-11-01" })).split("\n")[0]).toBe("2026-11-01 Sun: 2 conversations, 2 messages that day (split at gaps of 90+ min, UTC)");
  });

  test("says when the day has nothing, and refuses a day that isn't one", async () => {
    const w = await world();
    await w.archive("main", [message("u1", "one", "2026-11-01T10:00:00Z")]);
    expect(await w.read({ overview: "2026-11-03" })).toBe("2026-11-03: no messages on this day. The chat logs run 2026-11-01 → 2026-11-01 Sun 10:00; this thread's messages in your context aren't included.");
    expect(await outcomeOf(w.read({ overview: "2026-02-30" }))).toThrow("invalid args: overview must be a date like 2026-03-01");
    expect(await outcomeOf(w.read({ overview: "Sunday" }))).toThrow("invalid args: overview must be a date like 2026-03-01");
  });
});

test("a read needs exactly one way to read, and conversation history to read from", async () => {
  const w = await world();
  await w.archive("main", [message("u1", "one", "2026-11-01T10:00:00Z")]);
  const one = "invalid args: give exactly one of around, overview, or start and end";
  expect(await outcomeOf(w.read({}))).toThrow(one);
  expect(await outcomeOf(w.read({ around: "u1", overview: "2026-11-01" }))).toThrow(one);
  expect(await outcomeOf(w.read({ around: "u1", start: "2026-11-01" }))).toThrow(one);
  expect(await outcomeOf(w.read({ around: "u1" }, ""))).toThrow("invalid args: conversation history is not configured");
});

test("the chat logs' index is kept as it is from one read to the next while nothing has changed", async () => {
  const w = await world();
  await w.archive("main", [message("u1", "one", "2026-11-01T10:00:00Z")]);
  await w.read({ start: "2026-11-01" });
  const built = statSync(required(w.options.indexPath)).ino;
  await w.read({ start: "2026-11-01" });
  expect(statSync(required(w.options.indexPath)).ino).toBe(built);
});

describe("a search of the chat logs, kept to one speaker or to one side of a time", () => {
  const search = async (input: Record<string, unknown>) => {
    const w = await world();
    await w.archive("main", [
      message("u1", "the lamp is out", "2026-10-31T10:00:00Z"),
      message("a1", "I'll light the lamp", "2026-11-01T10:00:00Z"),
      message("u2", "the lamp is lit", "2026-11-02T10:00:00Z"),
    ]);
    return await handleChatLogs({ action: "search", query: "lamp", sort: "oldest", ...input }, "unused", w.options);
  };

  test("finds a speaker by user, character, or either one's name in any case", async () => {
    const hits = (result: string): string[] => result.split("\n").flatMap((line) => /^\d{4}-/.test(line) ? [line.slice(line.lastIndexOf("  ") + 2)] : []);
    for (const speaker of ["user", "sam", "SAM"]) expect(hits(await search({ speaker }))).toEqual(["u1", "u2"]);
    for (const speaker of ["character", "Frank"]) expect(hits(await search({ speaker }))).toEqual(["a1"]);
    expect(await outcomeOf(search({ speaker: "eve" }))).toThrow("invalid args: speaker must be user, character, sam or frank");
  });

  test("says when the search was kept since a start, or until an end", async () => {
    expect((await search({ start: "2026-11-01" })).split("\n")[0]).toBe("lamp: 2 matches since 2026-11-01, showing 1–2, oldest first");
    expect((await search({ end: "2026-11-01" })).split("\n")[0]).toBe("lamp: 2 matches until 2026-11-01, showing 1–2, oldest first");
  });
});
