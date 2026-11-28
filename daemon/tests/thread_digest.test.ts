import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { threadDigest, type ThreadReader } from "../src/autonomy/thread_digest.ts";
import { NO_PRIOR_CONTEXT } from "../src/engine/segments.ts";
import type { ContentBlock, Message } from "../src/engine/types.ts";
import { Texts } from "../src/texts/texts.ts";
import { required } from "../src/util/required.ts";
import { testTmp } from "./support/tmp.ts";

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


function thread(active: Message[], segments: Message[][] = [], reads: number[] = []): ThreadReader {
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
  expect(required(await threadDigest(new Texts(), ring, T0 + 10 * MINUTE, "eve", "UTC"))).toBe([
    "What was said in this thread since your last wake here:",
    `you, in a wake · ${at("12:11 PM")}\nPart one: the fox came to the gate.`,
    `eve · ${at("12:12 PM")}\nand then?`,
    `you · ${at("12:12 PM")}\nChecking the tide.`,
    `you · ${at("12:12 PM")}\nIt came in at noon.`,
  ].join("\n\n"));
});

test("with no wake there before it is shown the last ten things said, however much working lies between them", async () => {
  const said = Array.from({ length: 6 }, (_unused, n) => [user(n, `question ${String(n)}`), reply(n, `answer ${String(n)}`)]).flat();
  const ring = thread([...said.slice(0, 4), opener(2.5), working(2.6, "Working."), result(2.7), reply(2.8, "A note."), ...said.slice(4)]);
  const shown = required(await threadDigest(new Texts(), ring, undefined, "eve", "UTC"));
  expect(shown.split("\n\n")).toEqual([
    "The last of what was said in this thread:",
    ...said.slice(2).map((each) => `${each.role === "user" ? "eve" : "you"} · ${at(`12:0${String(Math.floor((Date.parse(each.timestamp) - T0) / MINUTE))} PM`)}\n${each.content}`),
  ]);
  expect(shown).not.toContain("Working.");
  expect(shown).not.toContain("A note.");
});

test("what the character said before anyone else spoke, as when it opened the thread itself, is shown like any other reply", async () => {
  const opened = thread([reply(0, "I thought we could keep the story here."), user(1, "good idea")]);
  expect(required(await threadDigest(new Texts(), opened, undefined, "eve", "UTC"))).toBe([
    "The last of what was said in this thread:",
    `you · ${at("12:00 PM")}\nI thought we could keep the story here.`,
    `eve · ${at("12:01 PM")}\ngood idea`,
  ].join("\n\n"));
});

test("a thread with nothing said says so, in words for home or for the thread the wake is in", async () => {
  expect(required(await threadDigest(new Texts(), thread([]), undefined, "eve", "UTC"))).toBe("Nothing has been said in this thread yet.");
  expect(required(await threadDigest(new Texts(), thread([opener(1), reply(1, "A note.")]), T0, "eve", "UTC"))).toBe("Nothing has been said in this thread since your last wake here.");
  expect(required(await threadDigest(new Texts(), thread([user(1, "hello")]), T0 + MINUTE, "eve", "UTC"))).toBe("Nothing has been said in this thread since your last wake here.");
  expect(required(await threadDigest(new Texts(), thread([user(1, "hello")]), T0, "eve", "UTC"))).toBe(`What was said in this thread since your last wake here:\n\neve · ${at("12:01 PM")}\nhello`);
});

test("what was archived is read back only as far as it is needed, newest first, and no further than three archives", async () => {
  const older = [[user(1, "one")], [user(2, "two")], [user(3, "three")], [user(4, "four"), opener(4.5), reply(4.6, "A note.")]];
  const ten = Array.from({ length: 10 }, (_unused, n) => user(10 + n, `said ${String(n)}`));

  let reads: number[] = [];
  required(await threadDigest(new Texts(), thread(ten, older, reads), undefined, "eve", "UTC"));
  expect(reads).toEqual([]);

  reads = [];
  const nine = required(await threadDigest(new Texts(), thread(ten.slice(1), older, reads), undefined, "eve", "UTC"));
  expect(reads).toEqual([3]);
  expect(nine.split("\n\n")[1]).toBe(`eve · ${at("12:04 PM")}\nfour`);

  reads = [];
  const few = required(await threadDigest(new Texts(), thread([user(20, "late")], older, reads), undefined, "eve", "UTC"));
  expect(reads).toEqual([3, 2, 1]);
  expect(few.split("\n\n").slice(1).map((entry) => entry.split("\n")[1])).toEqual(["two", "three", "four", "late"]);

  reads = [];
  const since = required(await threadDigest(new Texts(), thread([user(20, "late")], older, reads), T0 + 3.5 * MINUTE, "eve", "UTC"));
  expect(reads).toEqual([3, 2]);
  expect(since.split("\n\n").slice(1).map((entry) => entry.split("\n")[1])).toEqual(["four", "late"]);

  reads = [];
  const lost = required(await threadDigest(new Texts(), thread([user(20, "late")], [[user(1, "one")], [user(2, "two")], [user(3, "three")], []].map((each, index) => index === 3 ? undefined : each) as Message[][], reads), undefined, "eve", "UTC"));
  expect(reads).toEqual([3, 2, 1]);
  expect(lost.split("\n\n").slice(1).map((entry) => entry.split("\n")[1])).toEqual(["two", "three", "late"]);
});

async function bare(...lines: [name: string, wording: string][]): Promise<Texts> {
  const dir = await mkdtemp(testTmp("digest-texts-"));
  for (const [name, wording] of lines) await writeFile(join(dir, `${name}.md`), `${wording}\n`);
  return new Texts(Object.fromEntries(lines.map(([name]) => [name, `${name}.md`])), dir);
}

test("a wake is shown at most forty messages and as many as fit in 24,000 characters, newest first kept, and says how many earlier ones it leaves out", async () => {
  const texts = await bare(["digest_user", "{{text}}"], ["digest_since", "since"], ["digest_left_out", "<{{count}}{{#if one}} one{{/if}}>"]);
  const said = (count: number, size: number): Message[] => Array.from({ length: count }, (_, index) => user(1 + index / 100, String(index % 10).repeat(size)));
  const parts = async (messages: Message[]): Promise<string[]> => required(await threadDigest(texts, thread(messages), T0, "eve", "UTC")).split("\n\n");
  const forty = said(41, 1);
  expect(await parts(forty)).toEqual(["since", "<1 one>", ...forty.slice(1).map((each) => each.content)]);
  const fits = said(6, 4_000);
  expect(await parts(fits)).toEqual(["since", ...fits.map((each) => each.content)]);
  const over = said(8, 4_000);
  expect(await parts(over)).toEqual(["since", "<2>", ...over.slice(2).map((each) => each.content)]);
});

test("a message longer than 4,000 characters is cut there and says so, and one of exactly 4,000 is kept whole", async () => {
  const texts = await bare(["digest_user", "{{text}}"], ["digest_first", "first"]);
  const whole = "w".repeat(3_999) + "!";
  expect(await threadDigest(texts, thread([user(1, whole)]), undefined, "eve", "UTC")).toBe(`first\n\n${whole}`);
  expect(await threadDigest(texts, thread([user(1, `${whole}x`)]), undefined, "eve", "UTC")).toBe(`first\n\n${whole}… [cut]`);
  const plain = await bare(["digest_user", "{{text}}"], ["digest_first", "first"], ["digest_cut", ""]);
  expect(await threadDigest(plain, thread([user(1, `${whole}x`)]), undefined, "eve", "UTC")).toBe(`first\n\n${whole}`);
});

test("a speaker switched off leaves their messages out of what a wake is shown, and with everything off it is shown nothing", async () => {
  const quiet = await bare(["digest_you", ""], ["digest_first", "first"]);
  expect(await threadDigest(quiet, thread([user(1, "hello"), reply(2, "hi")]), undefined, "eve", "UTC")).toBe(`first\n\neve · ${at("12:01 PM")}\nhello`);
  const silent = new Texts({ digest_first: false, digest_user: false }, "");
  expect(await threadDigest(silent, thread([user(1, "hello")]), undefined, "eve", "UTC")).toBeUndefined();
  expect(await threadDigest(new Texts({ digest_nothing_yet: false }, ""), thread([]), undefined, "eve", "UTC")).toBeUndefined();
});

test("a message of Shore's own in the thread is never shown as said, whoever it came from", async () => {
  const ring = thread([user(1, "hello"), message("system", 2, "[a note Shore left]"), reply(3, "hi")]);
  const shown = required(await threadDigest(new Texts(), ring, undefined, "eve", "UTC"));
  expect(shown).toContain("hello");
  expect(shown).not.toContain("a note Shore left");
});
