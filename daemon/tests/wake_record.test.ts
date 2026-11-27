import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { BackgroundLoopResult } from "../src/autonomy/background_loop.ts";
import { cutLastWords, keepWakeRecord, recordWakeEnd, stopOf, wakeRecord, wakeStopNote, WakeWords, type WakeEnd, type WakeRecord, type WakeStop } from "../src/autonomy/wake_record.ts";
import { deleteThreadState } from "../src/storage/files.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";
import { Texts } from "../src/texts/texts.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);

async function character(): Promise<string> {
  return join(await mkdtemp(testTmp("shore-wake-record-")), "ada");
}

function loop(over: Partial<BackgroundLoopResult> = {}): BackgroundLoopResult {
  return { rounds: 3, ...over };
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
  expect(stopOf(loop({ stoppedAt: "rounds" }))).toEqual({ why: "rounds" });
  expect(stopOf(loop({ timedOut: true, stoppedAt: "rounds", failedRound: 2, failure: new Error("aborted") }))).toEqual({ why: "time" });
  expect(stopOf(loop({ timedOut: false, stoppedAt: "interrupted", failedRound: 2, failure: new Error("aborted") }))).toEqual({ why: "interrupted" });
});

test("a wake whose model call failed records that it failed, with the error, and leaves where its thread was looked at alone", async () => {
  const dir = await character();
  const failure = new Error("claude_agent: usage limit reached", { cause: new Error("429") });
  recordWakeEnd(dir, "ring", BEFORE, ended({ loop: loop({ failedRound: 3, failure, rounds: 4 }), words: wrote(["Half done.", true]) }));
  expect(wakeRecord(dir, "ring")).toEqual({
    ...BEFORE,
    stopped: { at: T0 + 70 * MINUTE, why: "failed", error: "claude_agent: usage limit reached", limitMs: 30 * MINUTE, rounds: 4, sent: false, last: "Half done." },
  });
  expect(stopOf(loop({ failedRound: 0, failure: "not an Error" }))).toEqual({ why: "failed", error: "not an Error" });
  expect(stopOf(loop({ failedRound: 1, failure: new Error(`${"é".repeat(99)}ab`) }))).toEqual({ why: "failed", error: `${"é".repeat(99)}ab` });
  expect(stopOf(loop({ failedRound: 1, failure: new Error(`${"é".repeat(99)}abc`) }))).toEqual({ why: "failed", error: `${"é".repeat(99)}ab…` });
  const budget = (summary?: string) => new Error("call refused", { cause: Object.assign(new Error("Budget Monthly is spent until 2026-12-01"), { name: "BudgetBlocked", ...(summary === undefined ? {} : { summary }) }) });
  expect([stopOf(loop({ failedRound: 1, failure: budget("Monthly budget spent") })), stopOf(loop({ failedRound: 1, failure: budget() }))]).toEqual([
    { why: "failed", error: "Monthly budget spent" }, { why: "failed", error: "Budget Monthly is spent until 2026-12-01" },
  ]);
});

test("the next wake is told how the last one was stopped, in these words", () => {
  const stop: WakeStop = { at: T0 + 30 * MINUTE, why: "time", limitMs: 30 * MINUTE, rounds: 4, sent: false, last: "" };
  expect(wakeStopNote(new Texts(), stop, "eve", "UTC")).toBe(
    "[Your last wake here reached its limit of 30 minutes and was stopped at Friday 2026-10-30 · 12:30 PM, after 4 rounds, before it had finished. " +
    "Nothing from it was sent to eve. Whatever it had already changed with its tools is still in place.]",
  );
  expect(wakeStopNote(new Texts(), { ...stop, why: "rounds", rounds: 1, sent: true, last: "Now the lamp." }, "eve", "UTC")).toBe(
    "[Your last wake here used up its rounds of tool use and was stopped at Friday 2026-10-30 · 12:30 PM, after 1 round, before it had finished. " +
    'The message it had already written was still sent to eve. The last thing it wrote: "Now the lamp." Whatever it had already changed with its tools is still in place.]',
  );
  expect(wakeStopNote(new Texts(), { ...stop, why: "interrupted", limitMs: 2 * 60 * MINUTE, rounds: 0 }, "eve", "UTC")).toBe(
    "[Your last wake here was stopped for eve's message at Friday 2026-10-30 · 12:30 PM, after 0 rounds, before it had finished. " +
    "Nothing from it was sent to eve. Whatever it had already changed with its tools is still in place.]",
  );
  expect(wakeStopNote(new Texts(), { ...stop, limitMs: 2 * 60 * MINUTE }, "eve", "UTC")).toStartWith("[Your last wake here reached its limit of 2 hours and was stopped at ");
  expect(wakeStopNote(new Texts(), { ...stop, why: "failed", error: "usage limit reached", rounds: 73, last: "Half done." }, "eve", "UTC")).toBe(
    '[Your last wake here failed at Friday 2026-10-30 · 12:30 PM, after 73 rounds, before it had finished, with this error: "usage limit reached". ' +
    'Nothing from it was sent to eve. The last thing it wrote: "Half done." Whatever it had already changed with its tools is still in place.]',
  );
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
