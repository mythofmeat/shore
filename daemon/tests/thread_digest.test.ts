import { expect, test } from "bun:test";

import { homeWords, THREAD_WORDS, threadDigest, type HomeReader } from "../src/autonomy/heartbeat_thread.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);

let ids = 0;

function message(role: Message["role"], minutes: number, blocks: ContentBlock[] | string, over: Partial<Message> = {}): Message {
  const content_blocks: ContentBlock[] = typeof blocks === "string" ? [{ type: "text", text: blocks }] : blocks;
  return {
    msg_id: `m${String(++ids)}`, role, images: [], content_blocks,
    content: content_blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    timestamp: new Date(T0 + minutes * MINUTE).toISOString(), ...over,
  };
}

const user = (minutes: number, text: string): Message => message("user", minutes, text);
const reply = (minutes: number, text: string): Message => message("assistant", minutes, text);
const opener = (minutes: number): Message => message("user", minutes, "[wake]\n\n[Your trigger \"show\" fired]", { origin: "autonomous" });
const working = (minutes: number, text: string): Message => message("assistant", minutes, [{ type: "text", text }, { type: "tool_use", id: "t", name: "read", input: {} }]);
const result = (minutes: number): Message => message("user", minutes, [{ type: "tool_result", tool_use_id: "t", content: "SOUL.md: Ada" }]);
const sent = (minutes: number, text: string): Message => message("assistant", minutes, text, { origin: "autonomous" });
const stopNote = (minutes: number): Message => message("system", minutes, "[This wake reached its limit, and Shore stopped it here.]", { origin: "autonomous" });

function thread(active: Message[], segments: Message[][] = [], reads: number[] = []): HomeReader {
  return {
    messages: () => active,
    segments: () => ({
      segmentCount: () => segments.length,
      readSegment: async (index) => {
        reads.push(index);
        const stored = segments[index];
        if (stored === undefined) throw new Error("gone");
        return stored;
      },
      priorContext: () => NO_PRIOR_CONTEXT,
    }),
  };
}

function at(time: string): string {
  return `Friday 2026-10-30 · ${time}`;
}

test("a wake is shown what was said in its thread since the last one, not that wake's own working, and the message it sent as its own", async () => {
  const ring = thread([
    user(1, "tell me a story in parts"),
    reply(1, "all right"),
    opener(10),
    working(10.2, "Let me look."),
    result(10.3),
    working(10.5, "And once more."),
    result(10.6),
    reply(11, "Told part one.\n[sent to eve as the next message here]"),
    sent(11, "Part one: the fox came to the gate."),
    stopNote(11),
    user(12, "and then?"),
    working(12.1, "Checking the tide."),
    result(12.2),
    reply(12.3, "It came in at noon."),
  ]);
  expect(await threadDigest(ring, THREAD_WORDS, T0 + 10 * MINUTE, "eve", "UTC")).toBe([
    "What was said in this thread since your last wake here:",
    `you, on your own time · ${at("12:11 PM")}\nPart one: the fox came to the gate.`,
    `eve · ${at("12:12 PM")}\nand then?`,
    `you · ${at("12:12 PM")}\nChecking the tide.`,
    `you · ${at("12:12 PM")}\nIt came in at noon.`,
  ].join("\n\n"));
});

test("with no wake there before it is shown the last ten things said, however much working lies between them", async () => {
  const said = Array.from({ length: 6 }, (_unused, n) => [user(n, `question ${String(n)}`), reply(n, `answer ${String(n)}`)]).flat();
  const ring = thread([...said.slice(0, 4), opener(2.5), working(2.6, "Working."), result(2.7), reply(2.8, "A note."), ...said.slice(4)]);
  const shown = await threadDigest(ring, THREAD_WORDS, undefined, "eve", "UTC");
  expect(shown.split("\n\n")).toEqual([
    "The last of what was said in this thread:",
    ...said.slice(2).map((each) => `${each.role === "user" ? "eve" : "you"} · ${at(`12:0${String(Math.floor((Date.parse(each.timestamp) - T0) / MINUTE))} PM`)}\n${each.content}`),
  ]);
  expect(shown).not.toContain("Working.");
  expect(shown).not.toContain("A note.");
});

test("what the character said before anyone else spoke, as when it opened the thread itself, is shown like any other reply", async () => {
  const opened = thread([reply(0, "I thought we could keep the story here."), user(1, "good idea")]);
  expect(await threadDigest(opened, THREAD_WORDS, undefined, "eve", "UTC")).toBe([
    "The last of what was said in this thread:",
    `you · ${at("12:00 PM")}\nI thought we could keep the story here.`,
    `eve · ${at("12:01 PM")}\ngood idea`,
  ].join("\n\n"));
});

test("a thread with nothing said says so, in words for home or for the thread the wake is in", async () => {
  expect(await threadDigest(thread([]), THREAD_WORDS, undefined, "eve", "UTC")).toBe("Nothing has been said in this thread yet.");
  expect(await threadDigest(thread([opener(1), reply(1, "A note.")]), THREAD_WORDS, T0, "eve", "UTC")).toBe("Nothing has been said in this thread since your last wake here.");
  expect(await threadDigest(thread([user(1, "hello")]), THREAD_WORDS, T0 + MINUTE, "eve", "UTC")).toBe("Nothing has been said in this thread since your last wake here.");
  expect(await threadDigest(thread([user(1, "hello")]), THREAD_WORDS, T0, "eve", "UTC")).toBe(`What was said in this thread since your last wake here:\n\neve · ${at("12:01 PM")}\nhello`);
  expect(await threadDigest(thread([]), homeWords("main"), undefined, "eve", "UTC")).toBe('Nothing has been said in your home thread, "main", yet.');
  expect(await threadDigest(thread([]), homeWords("main"), T0, "eve", "UTC")).toBe('Nothing has been said in your home thread, "main", since your last heartbeat.');
  expect(await threadDigest(thread([user(1, "hello")]), homeWords("den"), undefined, "eve", "UTC")).toBe(`The last of what was said in your home thread, "den", before your first heartbeat here:\n\neve · ${at("12:01 PM")}\nhello`);
  expect(await threadDigest(thread([user(1, "hello")]), homeWords("den"), T0, "eve", "UTC")).toStartWith('What was said in your home thread, "den", since your last heartbeat:\n\n');
});

test("what was archived is read back only as far as it is needed, newest first, and no further than three archives", async () => {
  const older = [[user(1, "one")], [user(2, "two")], [user(3, "three")], [user(4, "four"), opener(4.5), reply(4.6, "A note.")]];
  const ten = Array.from({ length: 10 }, (_unused, n) => user(10 + n, `said ${String(n)}`));

  let reads: number[] = [];
  await threadDigest(thread(ten, older, reads), THREAD_WORDS, undefined, "eve", "UTC");
  expect(reads).toEqual([]);

  reads = [];
  const nine = await threadDigest(thread(ten.slice(1), older, reads), THREAD_WORDS, undefined, "eve", "UTC");
  expect(reads).toEqual([3]);
  expect(nine.split("\n\n")[1]).toBe(`eve · ${at("12:04 PM")}\nfour`);

  reads = [];
  const few = await threadDigest(thread([user(20, "late")], older, reads), THREAD_WORDS, undefined, "eve", "UTC");
  expect(reads).toEqual([3, 2, 1]);
  expect(few.split("\n\n").slice(1).map((entry) => entry.split("\n")[1])).toEqual(["two", "three", "four", "late"]);

  reads = [];
  const since = await threadDigest(thread([user(20, "late")], older, reads), THREAD_WORDS, T0 + 3.5 * MINUTE, "eve", "UTC");
  expect(reads).toEqual([3, 2]);
  expect(since.split("\n\n").slice(1).map((entry) => entry.split("\n")[1])).toEqual(["four", "late"]);

  reads = [];
  const lost = await threadDigest(thread([user(20, "late")], [[user(1, "one")], [user(2, "two")], [user(3, "three")], []].map((each, index) => index === 3 ? undefined : each) as Message[][], reads), THREAD_WORDS, undefined, "eve", "UTC");
  expect(reads).toEqual([3, 2, 1]);
  expect(lost.split("\n\n").slice(1).map((entry) => entry.split("\n")[1])).toEqual(["two", "three", "late"]);
});
