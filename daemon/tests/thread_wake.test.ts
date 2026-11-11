import { expect, test } from "bun:test";

import { spanPhrase, triggerFiredNote } from "../src/autonomy/heartbeat_shape.ts";
import { firedBy } from "../src/autonomy/runner.ts";
import { pickedUpNote, wakeCutShortNote, wakeStoppedNote, wakeWrapUpText, withoutSent, wrapUpMsFor } from "../src/autonomy/thread_wake.ts";
import { dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { handleWakeInThread, wakeInThreadRequest } from "../src/tools/wake_in_thread.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String(error);
  }
  return "";
}

test("a wake is warned a sixth of its limit before the end, and never more than a quarter of an hour before", () => {
  expect([30, 60, 89, 90, 91, 120, 1].map((minutes) => wrapUpMsFor(minutes * MINUTE) / 1000)).toEqual([300, 600, 890, 900, 900, 900, 10]);
  expect(wrapUpMsFor(100_001)).toBe(16_666);
});

test("a length of time is spelled in the largest unit that fits it evenly, down to seconds under a minute", () => {
  expect([0, 1, 59, 60, 61, 119, 120, 1500, 3599, 3600, 6300, 7200].map((secs) => spanPhrase(secs * 1000))).toEqual([
    "0 seconds", "1 second", "59 seconds", "1 minute", "1 minute", "1 minute", "2 minutes", "25 minutes", "59 minutes", "1 hour", "105 minutes", "2 hours",
  ]);
  expect(spanPhrase(59_999)).toBe("59 seconds");
});

test("a wake's wrap-up nudge says how long is left, how many rounds, and where to pick up", () => {
  expect(wakeWrapUpText(4 * MINUTE, 3, "eve")).toBe(
    "[System nudge: this wake stops in about 4 minutes or after 3 more rounds, counting this one, whichever comes first. " +
    "Wrap up now: finish with your note to yourself, saying where you stopped so you can pick it up here next time. " +
    "Only what you put in <sendMessage> tags is posted for eve.]",
  );
  expect(wakeWrapUpText(30_000, 1, "eve")).toStartWith("[System nudge: this wake stops in less than a minute or after this round, whichever comes first. ");
});

test("what a wake sent is left out of the note it keeps in the thread, since the message follows it there", () => {
  expect(withoutSent([
    { type: "thinking", thinking: "<sendMessage>not this</sendMessage>", signature: "s" },
    { type: "text", text: "Done.\n<sendMessage>Part one.\nIt rained.</sendMessage> And <sendMessage>two</sendMessage>" },
    { type: "text", text: "nothing sent" },
  ], "eve")).toEqual([
    { type: "thinking", thinking: "<sendMessage>not this</sendMessage>", signature: "s" },
    { type: "text", text: "Done.\n[sent to eve as the next message here] And [sent to eve as the next message here]" },
    { type: "text", text: "nothing sent" },
  ]);
});

test("a wake that is stopped is told why in its thread, and the diary says when one ran out before it finished", () => {
  expect(wakeStoppedNote("interrupted", "eve", 30 * MINUTE)).toBe(
    "[eve wrote here while this wake was running, so Shore stopped it here for you to answer them. Once they have been quiet in this thread for 10 minutes, Shore wakes you here again to pick it up.]",
  );
  expect(wakeStoppedNote("time", "eve", 90 * MINUTE)).toBe("[This wake reached its limit of 90 minutes, and Shore stopped it here.]");
  expect(wakeStoppedNote("rounds", "eve", 90 * MINUTE)).toBe("[This wake used up its rounds of tool use, and Shore stopped it here.]");
  expect(wakeCutShortNote("time", "ring", 2 * 60 * MINUTE)).toBe('Your wake in "ring" reached its limit of 2 hours before you finished. Where it stopped is in that thread.');
  expect(wakeCutShortNote("rounds", "ring", 2 * 60 * MINUTE)).toBe('Your wake in "ring" used up its rounds of tool use before you finished. Where it stopped is in that thread.');
  expect(pickedUpNote(T0 + 12 * MINUTE, "eve", "UTC")).toBe("[This picks up the wake that eve interrupted at Friday 2026-10-30 · 12:12 PM.]");
});

test("a wake says what set it off: its triggers, or the turn that handed it over", () => {
  const show = { name: "show", reason: "The show.", at: T0, thread: "ring" };
  const lamp = { name: "lamp", reason: "Trim it.", at: T0, thread: "ring" };
  const handed = { name: "", reason: "Carry on.", at: T0 + MINUTE, thread: "ring", from: "heartbeat" };
  const asked = { name: "", reason: "As asked.", at: T0, thread: "ring", from: "main" };
  expect(firedBy([show])).toBe('trigger "show"');
  expect(firedBy([show, lamp])).toBe('trigger "show", "lamp"');
  expect(firedBy([handed])).toBe('a hand-off from "heartbeat"');
  expect(firedBy([handed, show, asked])).toBe('trigger "show" and a hand-off from "heartbeat", "main"');
  expect(triggerFiredNote(show, "UTC")).toBe('[Your trigger "show" fired at Friday 2026-10-30 · 12:00 PM: The show.]');
  expect(triggerFiredNote(handed, "UTC")).toBe('[You asked for this wake from "heartbeat" at Friday 2026-10-30 · 12:01 PM: Carry on.]');
});

test("a hand-off needs a thread's id and a reason, and takes a limit of a minute or more", () => {
  expect(wakeInThreadRequest({ thread: " ring ", reason: " Carry on. " })).toEqual({ thread: "ring", reason: "Carry on.", limitMs: undefined });
  expect(wakeInThreadRequest({ thread: "ring", reason: "r", limit: null })).toEqual({ thread: "ring", reason: "r", limitMs: undefined });
  expect(wakeInThreadRequest({ thread: "ring", reason: "r", limit: "1m" })).toEqual({ thread: "ring", reason: "r", limitMs: MINUTE });
  expect(wakeInThreadRequest({ thread: "ring", reason: "r", limit: "2h" })).toEqual({ thread: "ring", reason: "r", limitMs: 120 * MINUTE });
  const thread = "invalid args: thread must be a thread's id, as `list_threads` shows it";
  expect(refusal(() => wakeInThreadRequest({ reason: "r" }))).toContain(thread);
  expect(refusal(() => wakeInThreadRequest({ thread: 5, reason: "r" }))).toContain(thread);
  expect(refusal(() => wakeInThreadRequest({ thread: "the ring", reason: "r" }))).toContain(thread);
  const reason = "reason must be a non-empty string";
  expect(refusal(() => wakeInThreadRequest({ thread: "ring" }))).toContain(reason);
  expect(refusal(() => wakeInThreadRequest({ thread: "ring", reason: 5 }))).toContain(reason);
  expect(refusal(() => wakeInThreadRequest({ thread: "ring", reason: " " }))).toContain(reason);
  expect(refusal(() => wakeInThreadRequest({ thread: "ring", reason: "r", limit: "soon" }))).toContain('limit must be a length of time, like "45m" or "2h"');
  expect(refusal(() => wakeInThreadRequest({ thread: "ring", reason: "r", limit: "59s" }))).toContain("limit can't be shorter than a minute");
});

test("a hand-off answers with where and for how long, and refuses the thread it is called from before anything is queued", () => {
  const asked: unknown[] = [];
  const queue = (limitMs: number | undefined) => (request: unknown) => {
    asked.push(request);
    return { kind: "queued" as const, limitMs };
  };
  expect(handleWakeInThread({ thread: "ring", reason: "r", limit: "45m" }, "main", queue(45 * MINUTE), "eve")).toBe(
    'Shore will wake you in "ring" for up to 45 minutes, once this turn is over and eve has been quiet there for 10 minutes.',
  );
  expect(handleWakeInThread({ thread: "ring", reason: "r" }, undefined, queue(undefined), "eve")).toBe(
    'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and eve has been quiet there for 10 minutes.',
  );
  expect(asked).toEqual([{ thread: "ring", reason: "r", limitMs: 45 * MINUTE }, { thread: "ring", reason: "r", limitMs: undefined }]);
  expect(refusal(() => handleWakeInThread({ thread: "ring", reason: "r" }, "ring", queue(undefined), "eve"))).toContain('you are in "ring" now, so there is nothing to hand over');
  expect(refusal(() => handleWakeInThread({ thread: "ring" }, "main", undefined, "eve"))).toContain("a wake can't be handed on from here");
  expect(asked).toHaveLength(2);
});

test("a dry run doesn't hand a wake over, start a thread or call an outside tool, and still lets the character read", async () => {
  const asked: unknown[] = [];
  const ctx: ToolContext = {
    workspaceDir: "/nowhere", characterName: "ada", characterDataDir: "/nowhere", imageDir: "/nowhere", conversationDir: "/nowhere",
    historyDbPath: "/nowhere/shore.db", configDir: "/nowhere", dryRun: true, thread: "main",
    wakeInThread: (request) => {
      asked.push(request);
      return { kind: "queued", limitMs: undefined };
    },
    mcpCall: async (name) => {
      asked.push(name);
      return "called";
    },
    triggers: () => ({ enabled: false, problems: [], triggers: [] }),
  };
  const blocked = async (name: string, input: unknown): Promise<string> => {
    try {
      await dispatchTool(name, input, ctx);
    } catch (error) {
      return String(error);
    }
    return "";
  };
  expect(await blocked("wake_in_thread", { thread: "ring", reason: "r" })).toContain("wake_in_thread blocked: dry-run tools cannot change files or external state");
  expect(await blocked("start_thread", { name: "ring", label: "Ring" })).toContain("start_thread blocked: dry-run tools cannot change files or external state");
  expect(await blocked("mcp__weather__look", {})).toContain("mcp__weather__look blocked: dry-run tools cannot change files or external state");
  expect(asked).toEqual([]);
  expect(String(await dispatchTool("list_triggers", {}, ctx))).toContain("You have none yet.");
  expect(await dispatchTool("wake_in_thread", { thread: "ring", reason: "r" }, { ...ctx, dryRun: false })).toBe(
    'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and the user has been quiet there for 10 minutes.',
  );
  expect(asked).toEqual([{ thread: "ring", reason: "r", limitMs: undefined }]);
});
