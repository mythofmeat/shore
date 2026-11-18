import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { BackgroundLoopResult } from "../src/autonomy/background_loop.ts";
import { cutLastWords, keepWakeRecord, recordWakeEnd, stopOf, wakeRecord, wakeStopNote, WakeWords, type WakeEnd, type WakeRecord, type WakeStop } from "../src/autonomy/wake_record.ts";
import { deleteThreadState } from "../src/storage/files.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);

async function character(): Promise<string> {
  return join(await mkdtemp(testTmp("shore-wake-record-")), "ada");
}

function loop(over: Partial<BackgroundLoopResult> = {}): BackgroundLoopResult {
  return { images: [], rounds: 3, ...over };
}

function wrote(...rounds: [text: string, tool: boolean][]): WakeWords {
  const words = new WakeWords();
  for (const [text, tool] of rounds) {
    words.heard({ role: "assistant", blocks: [{ type: "thinking", thinking: "not this", signature: "s" }, { type: "text", text }, ...(tool ? [{ type: "tool_use" as const, id: "t", name: "read", input: {} }] : [])] });
  }
  return words;
}

function ended(over: Partial<WakeEnd> = {}): WakeEnd {
  return { startedAt: T0 + 60 * MINUTE, endedAt: T0 + 70 * MINUTE, limitMs: 30 * MINUTE, loop: loop(), words: new WakeWords(), sent: false, ...over };
}

const BEFORE: WakeRecord = { through: T0 };

test("a wake's words are the last text it wrote, with or without a tool call after", () => {
  const words = wrote(["Let me look.", true], ["  \n", true]);
  expect(words.last).toBe("Let me look.");
  words.heard({ role: "user", blocks: [{ type: "text", text: "a nudge" }] });
  expect(words.last).toBe("Let me look.");
  words.heard({ role: "assistant", blocks: [{ type: "text", text: " Half " }, { type: "text", text: "done. " }] });
  expect(words.last).toBe("Half done.");
  words.heard({ role: "assistant", blocks: [{ type: "text", text: "One more." }, { type: "tool_use", id: "t", name: "read", input: {} }] });
  expect(words.last).toBe("One more.");
});

test("a wake that finished moves where its thread was looked at up to its start, and keeps nothing of what it wrote", async () => {
  const dir = await character();
  expect(wakeRecord(dir, "ring")).toEqual({});
  recordWakeEnd(dir, "ring", {}, ended());
  expect(wakeRecord(dir, "ring")).toEqual({ through: T0 + 60 * MINUTE });

  recordWakeEnd(dir, "ring", BEFORE, ended({ words: wrote(["Verse three is done.", false]) }));
  expect(wakeRecord(dir, "ring")).toEqual({ through: T0 + 60 * MINUTE });
  expect(wakeRecord(dir, "garden")).toEqual({});
});

test("a wake that was stopped leaves where its thread was looked at alone, and records why, after how many rounds, what it sent and the last thing it wrote", async () => {
  const dir = await character();
  const said = wrote(["Reading the log.", true], ["Now the lamp.", true]);
  recordWakeEnd(dir, "ring", BEFORE, ended({ loop: loop({ timedOut: true, failedRound: 3, rounds: 4 }), words: said, sent: true, limitMs: 90 * MINUTE }));
  expect(wakeRecord(dir, "ring")).toEqual({
    ...BEFORE,
    stopped: { at: T0 + 70 * MINUTE, why: "time", limitMs: 90 * MINUTE, rounds: 4, sent: true, last: "Now the lamp." },
  });

  recordWakeEnd(dir, "ring", {}, ended({ loop: loop({ stoppedAt: "interrupted" }) }));
  expect(wakeRecord(dir, "ring")).toEqual({ stopped: { at: T0 + 70 * MINUTE, why: "interrupted", limitMs: 30 * MINUTE, rounds: 3, sent: false, last: "" } });

  const long = wrote([`${"é".repeat(1500)}!`, true]);
  recordWakeEnd(dir, "ring", {}, ended({ loop: loop({ stoppedAt: "rounds" }), words: long }));
  expect(wakeRecord(dir, "ring").stopped).toMatchObject({ why: "rounds", last: `${"é".repeat(1500)}… [cut]` });
  expect(cutLastWords("é".repeat(1500))).toBe("é".repeat(1500));

  expect(stopOf(loop())).toBeUndefined();
  expect(stopOf(loop({ stoppedAt: "rounds" }))).toBe("rounds");
  expect(stopOf(loop({ timedOut: true, stoppedAt: "rounds" }))).toBe("time");
  expect(stopOf(loop({ timedOut: false, stoppedAt: "interrupted" }))).toBe("interrupted");
});

test("a wake whose model call failed leaves the record as it was, so the next one is told the same", async () => {
  const dir = await character();
  const stopped: WakeStop = { at: T0, why: "time", limitMs: 30 * MINUTE, rounds: 2, sent: false, last: "" };
  keepWakeRecord(dir, "ring", { ...BEFORE, stopped });
  recordWakeEnd(dir, "ring", { ...BEFORE, stopped }, ended({ loop: loop({ failedRound: 0 }) }));
  expect(wakeRecord(dir, "ring")).toEqual({ ...BEFORE, stopped });
  recordWakeEnd(dir, "ring", { ...BEFORE, stopped }, ended());
  expect(wakeRecord(dir, "ring")).toEqual({ through: T0 + 60 * MINUTE });
});

test("the next wake is told how the last one was stopped, in these words", () => {
  const stop: WakeStop = { at: T0 + 30 * MINUTE, why: "time", limitMs: 30 * MINUTE, rounds: 4, sent: false, last: "" };
  expect(wakeStopNote(stop, "eve", "UTC")).toBe(
    "[Your last wake here reached its limit of 30 minutes and was stopped at Friday 2026-10-30 · 12:30 PM, after 4 rounds, before it had finished. " +
    "Nothing from it was sent to eve. Whatever it had already changed with its tools is still in place.]",
  );
  expect(wakeStopNote({ ...stop, why: "rounds", rounds: 1, sent: true, last: "Now the lamp." }, "eve", "UTC")).toBe(
    "[Your last wake here used up its rounds of tool use and was stopped at Friday 2026-10-30 · 12:30 PM, after 1 round, before it had finished. " +
    'The message it had already written was still sent to eve. The last thing it wrote: "Now the lamp." Whatever it had already changed with its tools is still in place.]',
  );
  expect(wakeStopNote({ ...stop, why: "interrupted", limitMs: 2 * 60 * MINUTE, rounds: 0 }, "eve", "UTC")).toBe(
    "[Your last wake here was stopped for eve's message at Friday 2026-10-30 · 12:30 PM, after 0 rounds, before it had finished. " +
    "Nothing from it was sent to eve. Whatever it had already changed with its tools is still in place.]",
  );
  expect(wakeStopNote({ ...stop, limitMs: 2 * 60 * MINUTE }, "eve", "UTC")).toStartWith("[Your last wake here reached its limit of 2 hours and was stopped at ");
});

test("a record goes when its thread does", async () => {
  const dir = await character();
  keepWakeRecord(dir, "ring", { through: T0 });
  expect(wakeRecord(dir, "ring")).toEqual({ through: T0 });
  deleteThreadState(join(dir, ".."), "ada", "ring");
  expect(wakeRecord(dir, "ring")).toEqual({});
});

test("a record that can't be read is taken as none", async () => {
  const dir = await character();
  writeCharacterState(dir, "threads/ring/wake.json", "{ not json");
  expect(wakeRecord(dir, "ring")).toEqual({});
});
