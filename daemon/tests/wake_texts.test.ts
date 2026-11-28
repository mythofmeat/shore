import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { spanPhrase, triggerFiredNote } from "../src/autonomy/wake_shape.ts";
import { firedBy } from "../src/autonomy/runner.ts";
import { wakeStoppedNote, wakeWrapUpText, wrapUpMsFor } from "../src/autonomy/wake.ts";
import { dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { handleWakeInThread, wakeInThreadRequest } from "../src/tools/wake_in_thread.ts";
import { Texts } from "../src/texts/texts.ts";
import { createThread } from "../src/engine/threads.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12);

function ask(input: Record<string, unknown>): ReturnType<typeof wakeInThreadRequest> {
  return wakeInThreadRequest(input, T0, "UTC");
}

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

test("a wake's wrap-up nudge says how long is left, how many rounds, and that the next wake starts fresh", () => {
  expect(wakeWrapUpText(new Texts(), 4 * MINUTE, 3, "eve")).toBe(
    "[System nudge: this wake stops in about 4 minutes or after 3 more rounds, counting this one, whichever comes first. " +
    "Wrap up now. Your next wake starts fresh, so whatever it will need has to be in a file before this one stops, " +
    "and nothing reaches eve unless you send it.]",
  );
  expect(wakeWrapUpText(new Texts(), 30_000, 1, "eve")).toStartWith("[System nudge: this wake stops in less than a minute or after this round, whichever comes first. ");
});

test("a wake that is stopped, or fails, is told why in its thread, and one only triggers set off is told how to call off its pick-up", () => {
  const triggers = [{ name: "parcel", reason: "r", at: T0 }, { name: "lamp", reason: "r", at: T0 }];
  const promised = "[eve wrote here while this wake was running, so Shore stopped it here for you to answer them. Once they have been quiet in this thread for 10 minutes, Shore wakes you here again to pick it up";
  expect(wakeStoppedNote(new Texts(), { why: "interrupted" }, "eve", 30 * MINUTE, triggers)).toBe(
    `${promised}, unless by then every trigger that set it off has been taken out of \`TRIGGERS.toml\` or given a new time.]`,
  );
  for (const other of [{ name: "", reason: "r", at: T0, from: "main" }, { name: "", reason: "r", at: T0, byHand: true }, { name: "", reason: "r", at: T0, seal: true }]) {
    expect(wakeStoppedNote(new Texts(), { why: "interrupted" }, "eve", 30 * MINUTE, [...triggers, other])).toBe(`${promised}.]`);
  }
  expect(wakeStoppedNote(new Texts(), { why: "time" }, "eve", 90 * MINUTE, triggers)).toBe("[This wake reached its limit of 90 minutes, and Shore stopped it here.]");
  expect(wakeStoppedNote(new Texts(), { why: "rounds" }, "eve", 90 * MINUTE, triggers)).toBe("[This wake used up its rounds of tool use, and Shore stopped it here.]");
  expect(wakeStoppedNote(new Texts(), { why: "failed", error: "usage limit reached" }, "eve", 90 * MINUTE, triggers)).toBe('[This wake failed here, before it had finished, with this error: "usage limit reached".]');
});

test("a wake says what set it off: its triggers, the turn that handed it over, a seal, or a start by hand", () => {
  const show = { name: "show", reason: "The show.", at: T0, thread: "ring" };
  const lamp = { name: "lamp", reason: "Trim it.", at: T0, thread: "ring" };
  const handed = { name: "", reason: "Carry on.", at: T0 + MINUTE, thread: "ring", from: "own-time" };
  const byHand = { name: "", reason: "", at: T0, byHand: true };
  const seal = { name: "", reason: "It is open.", at: T0, thread: "gift", seal: true };
  const asked = { name: "", reason: "As asked.", at: T0, thread: "ring", from: "main" };
  expect(firedBy([show])).toBe('trigger "show"');
  expect(firedBy([show, lamp])).toBe('trigger "show", "lamp"');
  expect(firedBy([handed])).toBe('a hand-off from "own-time"');
  expect(firedBy([handed, show, asked])).toBe('trigger "show" and a hand-off from "own-time", "main"');
  expect(firedBy([byHand])).toBe("a start by hand");
  expect(firedBy([seal])).toBe("its seal coming off");
  expect(firedBy([lamp, byHand, seal, asked])).toBe('trigger "lamp" and a start by hand and a hand-off from "main" and its seal coming off');
  expect(triggerFiredNote(new Texts(), show, "UTC")).toBe('[Your trigger "show" fired at Friday 2026-10-30 · 12:00 PM: The show.]');
  expect(triggerFiredNote(new Texts(), handed, "UTC")).toBe('[You asked for this wake from "own-time" at Friday 2026-10-30 · 12:01 PM: Carry on.]');
});

test("a hand-off needs a thread's id and a reason, and takes a limit of a minute or more", () => {
  expect(ask({ thread: " ring ", reason: " Carry on. " })).toEqual({ thread: "ring", reason: "Carry on.", limitMs: undefined, overwrite: false, startsAt: undefined });
  expect(ask({ thread: "ring", reason: "r", limit: null })).toEqual({ thread: "ring", reason: "r", limitMs: undefined, overwrite: false, startsAt: undefined });
  expect(ask({ thread: "ring", reason: "r", limit: "1m" })).toEqual({ thread: "ring", reason: "r", limitMs: MINUTE, overwrite: false, startsAt: undefined });
  expect(ask({ thread: "ring", reason: "r", limit: "2h", overwrite: true })).toEqual({ thread: "ring", reason: "r", limitMs: 120 * MINUTE, overwrite: true, startsAt: undefined });
  expect(ask({ thread: "ring", reason: "r", overwrite: true }).overwrite).toBe(true);
  expect(ask({ thread: "ring", reason: "r", overwrite: "yes" }).overwrite).toBe(false);
  const thread = "invalid args: thread must be a thread's id, as `threads` lists it";
  expect(refusal(() => ask({ reason: "r" }))).toContain(thread);
  expect(refusal(() => ask({ thread: 5, reason: "r" }))).toContain(thread);
  expect(refusal(() => ask({ thread: "the ring", reason: "r" }))).toContain(thread);
  const reason = "reason must be a non-empty string";
  expect(refusal(() => ask({ thread: "ring" }))).toContain(reason);
  expect(refusal(() => ask({ thread: "ring", reason: 5 }))).toContain(reason);
  expect(refusal(() => ask({ thread: "ring", reason: " " }))).toContain(reason);
  expect(refusal(() => ask({ thread: "ring", reason: "r", limit: "soon" }))).toContain('limit must be a length of time, like "45m" or "2h"');
  expect(refusal(() => ask({ thread: "ring", reason: "r", limit: "59s" }))).toContain("limit can't be shorter than a minute");
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
  expect(asked).toEqual([{ thread: "ring", reason: "r", limitMs: 45 * MINUTE, overwrite: false, startsAt: undefined }, { thread: "ring", reason: "r", limitMs: undefined, overwrite: false, startsAt: undefined }]);
  expect(refusal(() => handleWakeInThread({ thread: "ring", reason: "r" }, "ring", queue(undefined), "eve"))).toContain('you are in "ring" now, so there is nothing to hand over');
  expect(refusal(() => handleWakeInThread({ thread: "ring" }, "main", undefined, "eve"))).toContain("a wake can't be handed on from here");
  expect(asked).toHaveLength(2);
});

test("a hand-off's `when` is a local date with a 24-hour or 12-hour time, or a length of time from now, in minutes, hours or days", () => {
  const HOUR = 60 * MINUTE;
  const startsAt = (when: unknown, timeZone = "UTC"): number | undefined => wakeInThreadRequest({ thread: "ring", reason: "r", when }, T0, timeZone).startsAt;
  expect([
    "2026-10-30 13:00", "2026-10-30T13:00", " 2026-10-30 13:00 ", "2026-10-31 7:00", "2026-10-30 1:00PM", "2026-10-30 1:00 pm", "2026-10-30 1:05 p.m.",
    "2026-10-30 12:30PM", "2026-10-31 12:00AM", "2026-10-31 12:15 am", "2026-10-31 9:00AM", "2026-10-31 11:59PM",
  ].map((when) => ((startsAt(when) ?? 0) - T0) / MINUTE)).toEqual([60, 60, 60, 19 * 60, 60, 60, 65, 30, 12 * 60, 12 * 60 + 15, 21 * 60, 36 * 60 - 1]);
  expect(["in 5 hours", "5h", "in 1 hour", "In 3 Hrs", "2 hr", "90m", "in 90 minutes", "45 mins", "1 min", "in 1.5 hours", "in 2 days", "1d", "in 1 day"].map((when) => ((startsAt(when) ?? 0) - T0) / MINUTE)).toEqual([
    300, 300, 60, 180, 120, 90, 90, 45, 1, 90, 2880, 1440, 1440,
  ]);
  expect(startsAt("2026-10-31 09:00", "Australia/Sydney")).toBe(T0 + 10 * HOUR);
  expect(startsAt("in 2 hours", "Australia/Sydney")).toBe(T0 + 2 * HOUR);
  expect(startsAt(undefined)).toBeUndefined();
  expect(startsAt(null)).toBeUndefined();

  const unreadable = 'invalid args: when must be a local date and time, like "2026-11-19 13:00" or "2026-11-19 1:00PM", or a length of time from now, like "in 5 hours" or "90m"';
  for (const when of ["soon", "tomorrow", "", 5, true, "in 5 weeks", "30s", "in 999999999 days", "in 99999999999999999999 days", "in five hours", "2026-10-30 0:30AM", "2026-10-30 13:00PM", "2026-10-30 24:00", "2026-02-30 10:00", "2026-10-30 9:5", "2026-10-30", "13:00"]) {
    expect(refusal(() => startsAt(when))).toBe(`InvalidArgs: ${unreadable}`);
  }
  expect(refusal(() => startsAt("2026-10-30 12:00"))).toBe("InvalidArgs: invalid args: when must be a time still to come, and Friday 2026-10-30 · 12:00 PM is not: it is Friday 2026-10-30 · 12:00 PM now");
  expect(refusal(() => startsAt("2026-10-30 11:59AM"))).toBe("InvalidArgs: invalid args: when must be a time still to come, and Friday 2026-10-30 · 11:59 AM is not: it is Friday 2026-10-30 · 12:00 PM now");
  expect(refusal(() => startsAt("in 0 minutes"))).toBe("InvalidArgs: invalid args: when must be a time still to come, and Friday 2026-10-30 · 12:00 PM is not: it is Friday 2026-10-30 · 12:00 PM now");
  expect(refusal(() => startsAt("2026-10-31 09:00", "Australia/Sydney"))).toBe("");
});

test("a hand-off with `when` may be for the thread it is called from, and says when it starts and that it waits for the user to go quiet there", () => {
  const asked: unknown[] = [];
  const queue = (request: unknown) => {
    asked.push(request);
    return { kind: "queued" as const, limitMs: 45 * MINUTE };
  };
  expect(handleWakeInThread({ thread: "ring", reason: "Look again.", when: "in 5 hours", limit: "45m" }, "ring", queue, "eve", "UTC", T0)).toBe(
    'Shore will wake you in "ring" for up to 45 minutes at Friday 2026-10-30 · 5:00 PM. If eve has written there in the 10 minutes before, it waits until they have been quiet there that long. If you are dormant then, or eve has switched your triggers off, it is dropped.',
  );
  expect(handleWakeInThread({ thread: "ring", reason: "Look again.", when: "2026-10-31 9:00AM" }, "main", queue, "eve", "UTC", T0)).toStartWith(
    'Shore will wake you in "ring" for up to 45 minutes at Saturday 2026-10-31 · 9:00 AM. If eve',
  );
  expect(asked).toEqual([
    { thread: "ring", reason: "Look again.", limitMs: 45 * MINUTE, overwrite: false, startsAt: T0 + 300 * MINUTE },
    { thread: "ring", reason: "Look again.", limitMs: undefined, overwrite: false, startsAt: T0 + 21 * 60 * MINUTE },
  ]);
  expect(refusal(() => handleWakeInThread({ thread: "ring", reason: "r" }, "ring", queue, "eve", "UTC", T0))).toBe(
    'ToolIoError: io: you are in "ring" now, so there is nothing to hand over. To be woken here later, give `when`.',
  );
  expect(refusal(() => handleWakeInThread({ thread: "ring", reason: "r", when: "in 0 hours" }, "ring", queue, "eve", "UTC", T0))).toContain("when must be a time still to come");
  expect(asked).toHaveLength(2);

  const waiting = { from: "main", reason: "Tell part two.", at: T0 + 20 * MINUTE, startsAt: T0 + 6 * 60 * MINUTE };
  expect(refusal(() => handleWakeInThread({ thread: "ring", reason: "Tell part three." }, "main", () => ({ kind: "waiting", waiting }), "eve", "UTC", T0))).toBe(
    'ToolIoError: io: you already have a wake waiting in "ring", asked for from "main" at Friday 2026-10-30 · 12:20 PM to start at Friday 2026-10-30 · 6:00 PM: Tell part two.\n' +
    "Nothing was changed. To put this one in its place, call again with `overwrite` set to true.",
  );
  expect(handleWakeInThread({ thread: "ring", reason: "Tell part three.", overwrite: true }, "main", () => ({ kind: "queued", limitMs: undefined, replaced: waiting }), "eve", "UTC", T0)).toBe(
    'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and eve has been quiet there for 10 minutes.\n' +
    'This takes the place of the wake you had waiting there, asked for from "main" at Friday 2026-10-30 · 12:20 PM to start at Friday 2026-10-30 · 6:00 PM: Tell part two.',
  );
});

test("a hand-off into a thread where one is already waiting is refused with what is waiting, and one that takes its place says what it replaced", () => {
  const waiting = { from: "main", reason: "Tell part two.", at: T0 + 20 * MINUTE };
  expect(refusal(() => handleWakeInThread({ thread: "ring", reason: "Tell part three." }, "main", () => ({ kind: "waiting", waiting }), "eve", "UTC"))).toBe(
    'ToolIoError: io: you already have a wake waiting in "ring", asked for from "main" at Friday 2026-10-30 · 12:20 PM: Tell part two.\n' +
    "Nothing was changed. To put this one in its place, call again with `overwrite` set to true.",
  );
  expect(handleWakeInThread({ thread: "ring", reason: "Tell part three.", overwrite: true }, "main", () => ({ kind: "queued", limitMs: undefined, replaced: waiting }), "eve", "UTC")).toBe(
    'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and eve has been quiet there for 10 minutes.\n' +
    'This takes the place of the wake you had waiting there, asked for from "main" at Friday 2026-10-30 · 12:20 PM: Tell part two.',
  );
  expect(handleWakeInThread({ thread: "ring", reason: "r", overwrite: true }, "main", () => ({ kind: "queued", limitMs: undefined, replaced: undefined }), "eve", "UTC")).toBe(
    'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and eve has been quiet there for 10 minutes.',
  );
});

test("a dry run doesn't hand a wake over, start a thread or call an outside tool, and still lets the character read", async () => {
  const asked: unknown[] = [];
  const data = await mkdtemp(testTmp("shore-wake-texts-"));
  await createThread(data, "ada", "ring", "2026-11-01T00:00:00Z");
  const ctx: ToolContext = {
    texts: new Texts(),
    workspaceDir: "/nowhere", characterName: "ada", characterDataDir: "/nowhere", conversationDir: "/nowhere",
    historyDbPath: join(data, "shore.db"), configDir: "/nowhere", dryRun: true, thread: "main",
    wakeInThread: (request) => {
      asked.push(request);
      return { kind: "queued", limitMs: undefined };
    },
    mcpCall: async (name) => {
      asked.push(name);
      return "called";
    },
    triggers: async () => ({ enabled: false, problems: [], triggers: [], asked: [] }),
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
  expect(await blocked("threads", { action: "start", name: "ring", label: "Ring" })).toContain("threads start blocked: dry-run tools cannot change files or external state");
  expect(await blocked("threads", { action: "edit", name: "ring", label: "Ring" })).toContain("threads edit blocked: dry-run tools cannot change files or external state");
  expect(await blocked("mcp__weather__look", {})).toContain("mcp__weather__look blocked: dry-run tools cannot change files or external state");
  expect(asked).toEqual([]);
  expect(String(await dispatchTool("list_triggers", {}, ctx))).toContain("You have none there yet, so no trigger wakes you.");
  expect(await dispatchTool("wake_in_thread", { thread: "ring", reason: "r" }, { ...ctx, dryRun: false })).toBe(
    'Shore will wake you in "ring" for up to 30 minutes, once this turn is over and the user has been quiet there for 10 minutes.',
  );
  expect(asked).toEqual([{ thread: "ring", reason: "r", limitMs: undefined, overwrite: false }]);
});
