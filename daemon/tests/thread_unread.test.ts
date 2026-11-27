import { expect, spyOn, test } from "bun:test";
import { shoreLog } from "../src/log.ts";
import { join } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createThread, markThreadRead } from "../src/engine/threads.ts";
import { ThreadUnreadTracker } from "../src/handler/thread_unread.ts";
import type { Message } from "../src/engine/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import { initializeDatabase } from "../src/storage/database.ts";
import { threadFile, writeDurable } from "../src/storage/files.ts";
import { testTmp } from "./support/tmp.ts";

const at = (minute: number): string => `2026-11-27T10:${String(minute).padStart(2, "0")}:00.000Z`;

function line(fields: Partial<Message>): Message {
  return { msg_id: crypto.randomUUID(), role: "assistant", content: "", images: [], alternatives: [], content_blocks: [], timestamp: at(0), ...fields };
}

const said = (minute: number, text: string, fields: Partial<Message> = {}) => line({ role: "assistant", timestamp: at(minute), content: text, content_blocks: [{ type: "text", text }], ...fields });
const asked = (minute: number, text: string, fields: Partial<Message> = {}) => line({ role: "user", timestamp: at(minute), content: text, content_blocks: [{ type: "text", text }], ...fields });

async function tracked(lines: Message[], readThrough: number) {
  const data = join(mkdtempSync(testTmp("shore-thread-unread-")), "data");
  mkdirSync(data, { recursive: true });
  initializeDatabase(data);
  await createThread(data, "ada", "garden", at(0));
  markThreadRead(data, "ada", "garden", Date.parse(at(readThrough)));
  const sent: ServerMessage[] = [];
  const tracker = new ThreadUnreadTracker({ dataDir: data, broadcast: (message) => sent.push(message), now: () => Date.parse(at(59)) });
  const announced = async (message: Message) => {
    const upTo = lines.slice(0, lines.indexOf(message) + 1);
    writeDurable(threadFile(data, "ada", "garden", "active.jsonl"), upTo.map((each) => `${JSON.stringify(each)}\n`).join(""));
    sent.length = 0;
    tracker.observe({ type: "new_message", revision: 1, character: "ada", thread: "garden", ...message });
    await Bun.sleep(5);
    return [...sent];
  };
  return { tracker, sent, announced };
}

test("a thread's unread count carries the reply that made it unread, and nothing for any other message", async () => {
  const reply = said(2, "the beans are up");
  const mine = asked(3, "lovely");
  const quiet = said(4, "   ");
  const { announced } = await tracked([asked(1, "how is the garden?"), reply, mine, quiet], 1);
  expect(await announced(reply)).toEqual([{ type: "thread_unread", character: "ada", thread: "garden", unread: 1, last_active: at(2), reply: "the beans are up" }]);
  expect(await announced(mine), "the user's own message").toEqual([{ type: "thread_unread", character: "ada", thread: "garden", unread: 0, last_active: at(3) }]);
  expect(await announced(quiet), "a reply with no words").toEqual([{ type: "thread_unread", character: "ada", thread: "garden", unread: 0, last_active: at(4) }]);
});

test("a thread's first reply starts its read mark just before it, so the reply counts as unread", async () => {
  const data = join(mkdtempSync(testTmp("shore-thread-unread-")), "data");
  mkdirSync(data, { recursive: true });
  initializeDatabase(data);
  await createThread(data, "ada", "garden", at(0));
  const reply = said(2, "first words here");
  writeDurable(threadFile(data, "ada", "garden", "active.jsonl"), `${JSON.stringify(reply)}\n`);
  const sent: ServerMessage[] = [];
  const tracker = new ThreadUnreadTracker({ dataDir: data, broadcast: (message) => sent.push(message) });
  tracker.observe({ type: "new_message", revision: 1, character: "ada", thread: "garden", ...reply });
  await Bun.sleep(5);
  expect(sent).toEqual([{ type: "thread_unread", character: "ada", thread: "garden", unread: 1, last_active: at(2), reply: "first words here" }]);
});

test("only a new message with a character, a time and a thread that exists is followed, without a warning for the rest", async () => {
  const data = join(mkdtempSync(testTmp("shore-thread-unread-")), "data");
  mkdirSync(data, { recursive: true });
  initializeDatabase(data);
  const sent: ServerMessage[] = [];
  const warned = spyOn(shoreLog, "warn");
  try {
    const tracker = new ThreadUnreadTracker({ dataDir: data, broadcast: (message) => sent.push(message) });
    const seen = async (frame: Record<string, unknown>) => {
      sent.length = 0;
      tracker.observe({ type: "new_message", revision: 1, ...said(2, "hello"), character: "ada", ...frame });
      await Bun.sleep(5);
      return sent.map((each) => each.type === "thread_unread" ? each.thread : each.type);
    };
    expect(await seen({ thread: "main" }), "a character with no threads yet has main").toEqual(["main"]);
    expect(await seen({ thread: "garden" })).toEqual([]);
    expect(await seen({ thread: undefined }), "no thread is main").toEqual(["main"]);
    await createThread(data, "ada", "garden", at(0));
    expect(await seen({ thread: "garden" })).toEqual(["garden"]);
    expect(await seen({ thread: "elsewhere" }), "a thread not in the list").toEqual([]);
    expect(await seen({ type: "stream_end", thread: "garden" }), "not a new message").toEqual([]);
    expect(await seen({ character: undefined, thread: "garden" })).toEqual([]);
    expect(await seen({ thread: "garden", timestamp: "not a time" })).toEqual([]);
    expect(warned.mock.calls).toEqual([]);
  } finally {
    warned.mockRestore();
  }
});

test("a reply already read, a wake's working that isn't for the user, or a mark of reading carries no reply", async () => {
  const read = said(2, "seen already");
  const opener = asked(5, "a wake", { origin: "autonomous" });
  const working = said(6, "checking the beds");
  const spoken = said(7, "the frost is coming", { origin: "autonomous" });
  const { announced, tracker, sent } = await tracked([asked(1, "hi"), read, opener, working, spoken], 3);
  const replies = (frames: ServerMessage[]) => frames.map((frame) => frame.type === "thread_unread" ? frame.reply ?? null : frame.type);
  expect(replies(await announced(read))).toEqual([null]);
  expect(replies(await announced(working))).toEqual([null]);
  expect(replies(await announced(spoken))).toEqual(["the frost is coming"]);
  sent.length = 0;
  expect(tracker.markRead("ada", "garden", Date.parse(at(7)))).toEqual({ character: "ada", thread: "garden", unread: 0, last_active: at(7) });
  expect(sent).toEqual([{ type: "thread_unread", character: "ada", thread: "garden", unread: 0, last_active: at(7) }]);
});
