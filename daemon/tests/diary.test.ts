import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { addDiaryNote, closingNote, foldDiary, recentDiary, unfoldedDiary, unseenDiary } from "../src/autonomy/diary.ts";
import { assemblePrompt, DIARY_FOR_CHAT, diaryText, estimateMessageTokens, heartbeatRunningText } from "../src/engine/prompt.ts";
import { estimateTokens } from "../src/engine/tokens.ts";
import type { DiaryNote, Message } from "../src/engine/types.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 30, 12);

async function character(): Promise<string> {
  return join(await mkdtemp(testTmp("shore-diary-")), "ada");
}

function counter(): () => string {
  let n = 0;
  return () => `d${String(++n)}`;
}

function leave(dir: string, at: number, text: string, newId: () => string): void {
  addDiaryNote(dir, { at, thread: "heartbeat", source: "heartbeat", text }, newId);
}

function note(id: string, at: number, text: string): DiaryNote {
  return { id, at: new Date(at).toISOString(), thread: "heartbeat", source: "heartbeat", text };
}

test("a note is the closing text without what was sent, and a heartbeat with nothing to say leaves none", () => {
  expect(closingNote("Read the keeper's log up to March.\n<sendMessage>I found the log.</sendMessage>")).toBe("Read the keeper's log up to March.");
  expect(closingNote("<sendMessage>one</sendMessage>Half done.<sendMessage>two\nlines</sendMessage> Lamp next.")).toBe("Half done. Lamp next.");
  expect(closingNote("<sendMessage>I found the log.</sendMessage>")).toBeUndefined();
  expect(closingNote("  \n")).toBeUndefined();
  expect(closingNote("HEARTBEAT_OK")).toBeUndefined();
  expect(closingNote("HEARTBEAT_OK, and the lamp is lit.")).toBe("HEARTBEAT_OK, and the lamp is lit.");
});

test("a note shows at the start of turns for a day, and no longer", async () => {
  const dir = await character();
  leave(dir, T0, "The lamp is lit.", counter());

  expect(recentDiary(dir, T0 + DAY - 1)).toEqual({ notes: [note("d1", T0, "The lamp is lit.")], omitted: 0 });
  expect(recentDiary(dir, T0 + DAY)).toEqual({ notes: [], omitted: 0 });
});

test("only the newest twenty notes of the day are shown, with a count of the rest", async () => {
  const dir = await character();
  const newId = counter();
  for (let n = 1; n <= 20; n += 1) leave(dir, T0 + n, `note ${String(n)}`, newId);
  expect(recentDiary(dir, T0 + HOUR).notes.map((each) => each.id)).toEqual(Array.from({ length: 20 }, (_unused, n) => `d${String(n + 1)}`));
  expect(recentDiary(dir, T0 + HOUR).omitted).toBe(0);

  leave(dir, T0 + 21, "note 21", newId);
  const shown = recentDiary(dir, T0 + HOUR);
  expect(shown.notes.map((each) => each.id)).toEqual(Array.from({ length: 20 }, (_unused, n) => `d${String(n + 2)}`));
  expect(shown.omitted).toBe(1);
});

test("a note longer than 1,500 characters is cut there and says so, counting characters and not bytes", async () => {
  const dir = await character();
  const newId = counter();
  const whole = "🕯".repeat(1500);
  leave(dir, T0, whole, newId);
  leave(dir, T0 + 1, `${whole}x`, newId);

  expect(recentDiary(dir, T0 + HOUR).notes.map((each) => each.text)).toEqual([whole, `${whole}… [cut]`]);
});

test("the diary keeps its newest hundred notes", async () => {
  const dir = await character();
  const newId = counter();
  for (let n = 1; n <= 100; n += 1) leave(dir, T0 + n, `note ${String(n)}`, newId);
  expect(unfoldedDiary(dir)).toHaveLength(100);
  expect(unfoldedDiary(dir)[0]?.id).toBe("d1");

  leave(dir, T0 + 101, "note 101", newId);
  expect(unfoldedDiary(dir)).toHaveLength(100);
  expect(unfoldedDiary(dir)[0]?.id).toBe("d2");
  expect(unfoldedDiary(dir).at(-1)?.id).toBe("d101");
});

test("a dream is shown notes of any age until one has folded them, and folded notes still show at the start of turns for their day", async () => {
  const dir = await character();
  const newId = counter();
  leave(dir, T0, "Old and never folded.", newId);
  leave(dir, T0 + 3 * DAY, "Folded this morning.", newId);
  leave(dir, T0 + 3 * DAY + HOUR, "Left after the dream.", newId);
  expect(unfoldedDiary(dir).map((each) => each.id)).toEqual(["d1", "d2", "d3"]);

  foldDiary(dir, ["d1", "d2"]);

  expect(unfoldedDiary(dir)).toEqual([note("d3", T0 + 3 * DAY + HOUR, "Left after the dream.")]);
  expect(recentDiary(dir, T0 + 3 * DAY + 2 * HOUR).notes).toEqual([
    note("d2", T0 + 3 * DAY, "Folded this morning."),
    note("d3", T0 + 3 * DAY + HOUR, "Left after the dream."),
  ]);
});

test("a turn is given only the notes its conversation doesn't hold yet", async () => {
  const dir = await character();
  const newId = counter();
  leave(dir, T0, "The lamp is lit.", newId);
  leave(dir, T0 + HOUR, "The log is read.", newId);
  const first = note("d1", T0, "The lamp is lit.");
  const second = note("d2", T0 + HOUR, "The log is read.");

  expect(unseenDiary(dir, [], T0 + 2 * HOUR)).toEqual([first, second]);
  expect(unseenDiary(dir, [{}, { diary: [first] }], T0 + 2 * HOUR)).toEqual([second]);
  expect(unseenDiary(dir, [{ diary: [first] }, { diary: [second] }], T0 + 2 * HOUR)).toEqual([]);
  expect(unseenDiary(dir, [], T0 + DAY + 1)).toEqual([second]);
});

test("a diary that can't be read is empty, and entries that aren't notes are passed over", async () => {
  const dir = await character();
  writeCharacterState(dir, "diary.json", "{not json");
  expect(unfoldedDiary(dir)).toEqual([]);
  expect(recentDiary(dir, T0)).toEqual({ notes: [], omitted: 0 });

  writeCharacterState(dir, "diary.json", JSON.stringify({ notes: [] }));
  expect(unfoldedDiary(dir)).toEqual([]);

  const good = note("d1", T0, "The lamp is lit.");
  writeCharacterState(dir, "diary.json", JSON.stringify([
    null,
    "a line of text",
    { ...good, id: 7 },
    { ...good, thread: undefined },
    { ...good, text: ["The lamp is lit."] },
    { ...good, at: T0 },
    { ...good, at: "last Tuesday" },
    { ...good, source: "someone else" },
    good,
    { ...good, id: "d2", folded: true },
    { ...good, id: "d3", folded: "yes" },
  ]));
  expect(unfoldedDiary(dir)).toEqual([good, { ...good, id: "d3" }]);
  expect(recentDiary(dir, T0 + HOUR).notes.map((each) => each.id)).toEqual(["d1", "d2", "d3"]);

  leave(dir, T0 + HOUR, "The log is read.", () => "d4");
  expect(unfoldedDiary(dir).map((each) => each.id)).toEqual(["d1", "d3", "d4"]);
});

test("the diary is written out with a heading, each note under where and when it was left, and a line that ends it", () => {
  const notes = [note("d1", T0, "The lamp is lit."), note("d2", T0 + 90 * 60_000, "The log is read.\nMarch is next.")];

  expect(diaryText(notes, "Your diary.", "UTC")).toBe([
    "[Your diary.]",
    "your note at the end of a heartbeat · Friday 2026-10-30 · 12:00 PM\nThe lamp is lit.",
    "your note at the end of a heartbeat · Friday 2026-10-30 · 1:30 PM\nThe log is read.\nMarch is next.",
    "[End of your diary.]",
  ].join("\n\n"));
  expect(diaryText(notes.slice(1), "Your diary.", "Australia/Sydney", 3)).toBe([
    "[Your diary.]",
    "(Earlier entries not shown: 3.)",
    "your note at the end of a heartbeat · Saturday 2026-10-31 · 12:30 AM\nThe log is read.\nMarch is next.",
    "[End of your diary.]",
  ].join("\n\n"));
});

function said(id: string, role: "user" | "assistant", text: string, at: number, diary?: DiaryNote[]): Message {
  return {
    msg_id: id, role, content: text, images: [], content_blocks: [{ type: "text", text }], alternatives: [],
    timestamp: new Date(at).toISOString(), ...(diary === undefined ? {} : { diary }),
  };
}

test("a message that arrived with diary notes carries them ahead of what the user wrote, every time the conversation is sent", () => {
  const left = [note("d1", T0, "The lamp is lit.")];
  const block = diaryText(left, DIARY_FOR_CHAT, "UTC");
  const prompt = assemblePrompt({
    character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "never",
    messages: [
      said("m1", "user", "good morning", T0 + HOUR, left),
      said("m2", "assistant", "morning!", T0 + HOUR),
      said("m3", "user", "is the lamp lit?", T0 + HOUR),
    ],
  }, "UTC");

  expect(block).toBe("[New in your diary. Each entry says where it came from.]\n\nyour note at the end of a heartbeat · Friday 2026-10-30 · 12:00 PM\nThe lamp is lit.\n\n[End of your diary.]");
  expect(prompt.messages.map((message) => message.content)).toEqual([`${block}\n\ngood morning`, "morning!", "is the lamp lit?"]);
  expect(prompt.messages.map((message) => message.content_blocks)).toEqual([
    [{ type: "text", text: block }, { type: "text", text: "good morning" }],
    [{ type: "text", text: "morning!" }],
    [{ type: "text", text: "is the lamp lit?" }],
  ]);
});

test("a time marker stays on the user's own words when diary notes come ahead of them", () => {
  const left = [note("d1", T0, "The lamp is lit.")];
  const prompt = assemblePrompt({
    character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "always",
    messages: [said("m1", "user", "good morning", T0 + HOUR, left)],
  }, "UTC");

  expect(prompt.messages[0]?.content_blocks).toEqual([
    { type: "text", text: diaryText(left, DIARY_FOR_CHAT, "UTC") },
    { type: "text", text: "[Friday 2026-10-30 · 1:00 PM]\n\ngood morning" },
  ]);
});

test("diary notes on a message count towards the room the conversation takes", () => {
  const plain = said("m1", "user", "good morning", T0);
  const text = "The lamp is lit, and the log is read up to March.";
  const second = "Mara's letters are in the tin.";

  expect(estimateTokens(text)).toBeGreaterThan(1);
  expect(estimateMessageTokens(plain)).toBe(estimateTokens("good morning"));
  expect(estimateMessageTokens({ ...plain, diary: [note("d1", T0, text)] })).toBe(estimateMessageTokens(plain) + estimateTokens(text));
  expect(estimateMessageTokens({ ...plain, diary: [note("d1", T0, text), note("d2", T0, second)] }))
    .toBe(estimateMessageTokens(plain) + estimateTokens(text) + estimateTokens(second));
});

test("a message that arrived while a heartbeat ran says so between the diary notes and what the user wrote", () => {
  const left = [note("d1", T0, "The lamp is lit.")];
  const heartbeat = { started_at: new Date(T0 + HOUR).toISOString(), reason: "check the tide table" };
  const diary = diaryText(left, DIARY_FOR_CHAT, "UTC");
  const running = heartbeatRunningText(heartbeat, "UTC");
  const prompt = assemblePrompt({
    character_name: "ada", display_name: "eve", has_prior_context: false, user_timestamp_mode: "never",
    messages: [
      { ...said("m1", "user", "good morning", T0 + HOUR), heartbeat_running: heartbeat },
      said("m2", "assistant", "morning!", T0 + HOUR),
      { ...said("m3", "user", "is the lamp lit?", T0 + HOUR, left), heartbeat_running: heartbeat },
    ],
  }, "UTC");

  expect(prompt.messages.map((message) => message.content)).toEqual([
    `${running}\n\ngood morning`,
    "morning!",
    `${diary}\n\n${running}\n\nis the lamp lit?`,
  ]);
  expect(prompt.messages.map((message) => message.content_blocks)).toEqual([
    [{ type: "text", text: running }, { type: "text", text: "good morning" }],
    [{ type: "text", text: "morning!" }],
    [{ type: "text", text: diary }, { type: "text", text: running }, { type: "text", text: "is the lamp lit?" }],
  ]);
});

test("an entry says whether it is the character's own note, from one of its triggers by name, or from Shore", async () => {
  const dir = await character();
  const newId = counter();
  addDiaryNote(dir, { at: T0, thread: "heartbeat", source: "heartbeat", text: "The lamp is lit." }, newId);
  addDiaryNote(dir, { at: T0 + HOUR, thread: "heartbeat", source: "trigger", trigger: "tide-table", text: "The tide is out." }, newId);
  addDiaryNote(dir, { at: T0 + 2 * HOUR, thread: "heartbeat", source: "shore", text: "Your trigger `lamp` isn't running." }, newId);
  const kept = unfoldedDiary(dir);

  expect(kept).toEqual([
    note("d1", T0, "The lamp is lit."),
    { ...note("d2", T0 + HOUR, "The tide is out."), source: "trigger", trigger: "tide-table" },
    { ...note("d3", T0 + 2 * HOUR, "Your trigger `lamp` isn't running."), source: "shore" },
  ]);
  expect(Object.keys(kept[0] ?? {})).not.toContain("trigger");
  expect(diaryText(kept, "Your diary.", "UTC")).toBe([
    "[Your diary.]",
    "your note at the end of a heartbeat · Friday 2026-10-30 · 12:00 PM\nThe lamp is lit.",
    'from your trigger "tide-table" · Friday 2026-10-30 · 1:00 PM\nThe tide is out.',
    "from Shore · Friday 2026-10-30 · 2:00 PM\nYour trigger `lamp` isn't running.",
    "[End of your diary.]",
  ].join("\n\n"));

  writeCharacterState(dir, "diary.json", JSON.stringify([{ ...note("d4", T0, "A trigger with a name that isn't text."), source: "trigger", trigger: 7 }]));
  expect(unfoldedDiary(dir)).toEqual([{ ...note("d4", T0, "A trigger with a name that isn't text."), source: "trigger" }]);
  expect(diaryText(unfoldedDiary(dir), "Your diary.", "UTC")).toContain('from your trigger "" · ');
});
