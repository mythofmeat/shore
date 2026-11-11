import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { unfoldedDiary } from "../src/autonomy/diary.ts";
import type { TriggerFiring } from "../src/autonomy/runner.ts";
import type { CheckOutcome } from "../src/autonomy/trigger_check.ts";
import { CharacterTriggers, type TriggerSettings } from "../src/autonomy/trigger_loop.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 30, 12);

interface World {
  dir: string;
  now: number;
  file: string | undefined;
  unreadable: boolean;
  settings: TriggerSettings;
  dormant: boolean;
  lastUserAt: number | undefined;
  checks: Record<string, CheckOutcome | Error>;
  ran: [name: string, limitMs: number][];
  woke: TriggerFiring[];
  triggers: CharacterTriggers;
  at: (minutes: number) => Promise<void>;
  notes: () => [from: string, text: string][];
  restart: () => void;
}

async function world(file: string | undefined, dir?: string): Promise<World> {
  const w = {
    dir: dir ?? join(await mkdtemp(testTmp("shore-trigger-loop-")), "ada"),
    now: T0,
    file,
    unreadable: false,
    settings: { enabled: true, wakeCooldownMs: HOUR, checkLimitMs: 60_000, maxWakeLimitMs: 2 * HOUR, off: [] as string[] },
    dormant: false,
    lastUserAt: undefined,
    checks: {},
    ran: [],
    woke: [],
  } as unknown as World;
  w.restart = () => {
    w.triggers = new CharacterTriggers({
      characterDir: w.dir,
      timeZone: "UTC",
      now: () => w.now,
      settings: () => w.settings,
      dormant: () => w.dormant,
      lastUserAt: () => w.lastUserAt,
      readFile: async () => {
        if (w.unreadable) throw new Error("permission denied");
        return w.file;
      },
      runCheck: async (trigger, limitMs) => {
        w.ran.push([trigger.name, limitMs]);
        const outcome = w.checks[trigger.name] ?? { kind: "quiet" };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      wake: (firing) => { w.woke.push(firing); },
    });
  };
  w.restart();
  w.at = async (minutes) => {
    w.now = T0 + minutes * MINUTE;
    await w.triggers.tick();
  };
  w.notes = () => unfoldedDiary(w.dir).map((note) => [note.source === "trigger" ? note.trigger ?? "" : note.source, note.text]);
  return w;
}

const HOURLY = '[lamp]\nevery = "1h"\nreason = "Trim the lamp."\n';

test("a schedule starts counting when Shore first sees it, fires when its time comes, and counts again from there", async () => {
  const w = await world(HOURLY);
  await w.at(0);
  await w.at(59);
  expect(w.woke).toEqual([]);
  await w.at(60);
  expect(w.woke).toEqual([{ name: "lamp", reason: "Trim the lamp.", at: T0 + HOUR }]);
  await w.at(60);
  await w.at(119);
  expect(w.woke).toHaveLength(1);
  await w.at(120);
  expect(w.woke).toHaveLength(2);
  expect(w.notes()).toEqual([]);
  expect(w.ran).toEqual([]);
});

test("nothing runs while triggers are off, and what comes due while the character is dormant is passed over, not saved up", async () => {
  const off = await world(HOURLY);
  off.settings = { ...off.settings, enabled: false };
  await off.at(0);
  await off.at(60);
  expect(off.woke).toEqual([]);
  off.settings = { ...off.settings, enabled: true };
  await off.at(61);
  await off.at(120);
  expect(off.woke).toEqual([]);
  await off.at(121);
  expect(off.woke).toHaveLength(1);

  const asleep = await world(`${HOURLY}\n[tide]\nevery = "1h"\ncheck = "tide.sh"\nwake = false\n`);
  asleep.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await asleep.at(0);
  asleep.dormant = true;
  await asleep.at(60);
  await asleep.at(200);
  expect(asleep.woke).toEqual([]);
  expect(asleep.ran).toEqual([]);
  asleep.dormant = false;
  await asleep.at(201);
  await asleep.at(259);
  expect(asleep.woke).toEqual([]);
  expect(asleep.ran).toEqual([]);
  await asleep.at(260);
  expect(asleep.woke).toEqual([{ name: "lamp", reason: "Trim the lamp.", at: T0 + 260 * MINUTE }]);
  expect(asleep.notes()).toEqual([["tide", "The tide is out."]]);
});

test("a trigger that comes due during its cooldown waits for it to end, and its check isn't run until then", async () => {
  const w = await world('[tide]\nevery = "15m"\ncheck = "tide.sh"\n');
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(0);
  await w.at(15);
  expect(w.woke).toEqual([{ name: "tide", reason: "The tide is out.", at: T0 + 15 * MINUTE }]);
  await w.at(30);
  await w.at(45);
  await w.at(74);
  expect(w.ran).toEqual([["tide", 60_000]]);
  await w.at(75);
  expect(w.ran).toHaveLength(2);
  expect(w.woke).toHaveLength(2);
  await w.at(76);
  expect(w.ran).toHaveLength(2);
});

test("a quiet check does nothing, and one that prints fires with the trigger's reason above what it printed", async () => {
  const w = await world('[tide]\nevery = "1h"\ncheck = "tide.sh"\nreason = "Look at the shore."\n');
  await w.at(0);
  await w.at(60);
  expect(w.ran).toHaveLength(1);
  expect(w.woke).toEqual([]);
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(119);
  expect(w.ran).toHaveLength(1);
  await w.at(120);
  expect(w.woke).toEqual([{ name: "tide", reason: "Look at the shore.\nThe tide is out.", at: T0 + 2 * HOUR }]);
  expect(w.notes()).toEqual([]);
});

test("a failing check is reported once, and again only after it has worked in between", async () => {
  const w = await world('[tide]\nevery = "10m"\ncheck = "tide.sh"\nwake = false\n');
  const failed = "The check for your trigger `tide` failed: it exited with status 2. It keeps being tried, and you'll be told again only once it has worked and then failed again.";
  w.checks["tide"] = { kind: "failed", problem: "it exited with status 2" };
  await w.at(0);
  await w.at(10);
  expect(w.notes()).toEqual([["shore", failed]]);
  await w.at(20);
  expect(w.ran).toHaveLength(2);
  expect(w.notes()).toHaveLength(1);
  expect(w.triggers.view().triggers[0]).toMatchObject({ failing: true, fired: 0, lastFiredAt: undefined });

  w.checks["tide"] = { kind: "quiet" };
  await w.at(30);
  expect(w.triggers.view().triggers[0]?.failing).toBe(false);
  w.checks["tide"] = { kind: "failed", problem: "it exited with status 2" };
  await w.at(40);
  expect(w.notes()).toEqual([["shore", failed], ["shore", failed]]);

  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(50);
  expect(w.triggers.view().triggers[0]).toMatchObject({ failing: false, fired: 1, lastFiredAt: T0 + 50 * MINUTE });
  expect(w.woke).toEqual([]);
});

test("a trigger that doesn't wake leaves a diary entry in its own name, with no cooldown unless it sets one", async () => {
  const w = await world('[tide]\nevery = "10m"\ncheck = "tide.sh"\nwake = false\n');
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(0);
  await w.at(10);
  expect(w.notes()).toEqual([["tide", "The tide is out."]]);
  w.checks["tide"] = { kind: "fired", output: "The tide is in." };
  await w.at(20);
  expect(w.notes()).toEqual([["tide", "The tide is in."]]);
  expect(w.woke).toEqual([]);
  expect(unfoldedDiary(w.dir)[0]).toMatchObject({ at: new Date(T0 + 20 * MINUTE).toISOString(), thread: "", source: "trigger", trigger: "tide" });
});

test("a trigger that comes due outside its hours is skipped, not held until they open", async () => {
  const w = await world('[lamp]\nevery = "1h"\nreason = "Trim the lamp."\nbetween = "14:30-16:00"\n');
  await w.at(0);
  await w.at(60);
  await w.at(120);
  await w.at(150);
  await w.at(179);
  expect(w.woke).toEqual([]);
  await w.at(180);
  expect(w.woke).toEqual([{ name: "lamp", reason: "Trim the lamp.", at: T0 + 3 * HOUR }]);
  await w.at(240);
  await w.at(241);
  expect(w.woke).toHaveLength(1);
});

test("a trigger for a time of day fires at that time, and once, late, if Shore wasn't looking then", async () => {
  const w = await world('[supper]\nat = "13:30"\nreason = "Supper."\ncooldown = "1m"\n');
  await w.at(0);
  await w.at(89);
  expect(w.woke).toEqual([]);
  await w.at(90);
  expect(w.woke).toEqual([{ name: "supper", reason: "Supper.", at: T0 + 90 * MINUTE }]);
  await w.at(3 * 24 * 60 + 100);
  expect(w.woke).toHaveLength(2);
  await w.at(3 * 24 * 60 + 101);
  expect(w.woke).toHaveLength(2);
});

test("a trigger for the user going quiet fires once each time they have been quiet that long", async () => {
  const w = await world('[missed]\nwhen = "user_quiet"\nafter = "2h"\nreason = "They have been gone a while."\ncooldown = "1m"\n');
  await w.at(0);
  await w.at(500);
  expect(w.woke).toEqual([]);
  w.lastUserAt = T0 + 500 * MINUTE;
  await w.at(619);
  expect(w.woke).toEqual([]);
  await w.at(620);
  expect(w.woke).toEqual([{ name: "missed", reason: "They have been gone a while.", at: T0 + 620 * MINUTE }]);
  await w.at(900);
  expect(w.woke).toHaveLength(1);
  w.lastUserAt = T0 + 901 * MINUTE;
  await w.at(1020);
  expect(w.woke).toHaveLength(1);
  await w.at(1021);
  expect(w.woke).toHaveLength(2);
});

test("a trigger for a dream finishing waits for one, and for its own cooldown, without losing the dream", async () => {
  const w = await world('[after-dream]\nwhen = "dream_done"\nreason = "Read what the dream changed."\n');
  await w.at(0);
  await w.at(600);
  expect(w.woke).toEqual([]);
  await w.triggers.dreamDone();
  await w.at(601);
  expect(w.woke).toEqual([{ name: "after-dream", reason: "Read what the dream changed.", at: T0 + 601 * MINUTE }]);
  await w.at(602);
  expect(w.woke).toHaveLength(1);
  await w.triggers.dreamDone();
  await w.at(660);
  expect(w.woke).toHaveLength(1);
  await w.at(661);
  expect(w.woke).toHaveLength(2);

  const early = await world('[after-dream]\nwhen = "dream_done"\nreason = "Read what the dream changed."\n\n[missed]\nwhen = "user_quiet"\nafter = "2h"\nreason = "Gone a while."\n');
  await early.at(0);
  early.restart();
  writeCharacterState(early.dir, "triggers.json", "{}");
  await early.triggers.dreamDone();
  expect(early.triggers.view().triggers.map((each) => each.fired)).toEqual([0, 0]);
  await early.at(1);
  expect(early.woke.map((firing) => firing.name)).toEqual(["after-dream"]);
  expect(early.triggers.view().triggers.map((each) => each.fired)).toEqual([1, 0]);

  const status = await world('[status]\nwhen = "status_changed"\nreason = "Their status changed."\ncooldown = "1m"\n\n[after-dream]\nwhen = "dream_done"\nreason = "r"\n');
  await status.at(0);
  await status.triggers.statusChanged();
  await status.at(1);
  expect(status.woke).toEqual([{ name: "status", reason: "Their status changed.", at: T0 + MINUTE }]);
  await status.at(2);
  expect(status.woke).toHaveLength(1);

  const off = await world('[after-dream]\nwhen = "dream_done"\nreason = "Read what the dream changed."\n');
  off.settings = { ...off.settings, enabled: false };
  await off.triggers.dreamDone();
  off.settings = { ...off.settings, enabled: true };
  await off.at(1);
  await off.at(2);
  expect(off.woke).toEqual([]);
});

test("a follower fires after the trigger it names: at once when that one left a note, and after its wake is finished when it woke the character", async () => {
  const w = await world([
    '[recap]\nfollows = "tide"\nreason = "Write up the tide."\ncooldown = "1m"\n',
    '[tide]\nevery = "1h"\ncheck = "tide.sh"\nwake = false\n',
    '[encore]\nfollows = "show"\nreason = "Write up the show."\ncooldown = "1m"\n',
    '[show]\nat = "14:00"\nreason = "The show."\n',
    '[unrelated]\nfollows = "encore"\nreason = "After the encore."\n',
  ].join("\n"));
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(0);
  await w.at(60);
  expect(w.woke).toEqual([]);
  await w.at(61);
  expect(w.woke).toEqual([{ name: "recap", reason: "Write up the tide.", at: T0 + 61 * MINUTE }]);

  await w.at(120);
  expect(w.woke.map((firing) => firing.name)).toEqual(["recap", "show"]);
  await w.at(121);
  expect(w.woke.map((firing) => firing.name)).toEqual(["recap", "show", "recap"]);
  await w.triggers.finished(["recap", "show"]);
  await w.at(122);
  expect(w.woke.map((firing) => firing.name)).toEqual(["recap", "show", "recap", "encore"]);
  await w.at(123);
  expect(w.woke).toHaveLength(4);
});

test("a trigger switched off doesn't fire or run its check until it is switched back on", async () => {
  const w = await world('[tide]\nevery = "10m"\ncheck = "tide.sh"\nwake = false\n\n[lamp]\nevery = "10m"\nreason = "Trim the lamp."\ncooldown = "1m"\n');
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  w.settings = { ...w.settings, off: ["tide"] };
  await w.at(0);
  await w.at(10);
  expect(w.ran).toEqual([]);
  expect(w.woke.map((firing) => firing.name)).toEqual(["lamp"]);
  expect(w.triggers.view().triggers.map((each) => [each.trigger.name, each.off, each.fired, each.nextAt])).toEqual([["tide", true, 0, undefined], ["lamp", false, 1, T0 + 20 * MINUTE]]);
  w.settings = { ...w.settings, off: [] };
  await w.at(11);
  await w.at(20);
  expect(w.ran).toEqual([]);
  await w.at(21);
  expect(w.ran).toEqual([["tide", 60_000]]);
});

test("triggers that don't make sense are reported to the character once, and again when what's wrong changes", async () => {
  const w = await world('[lamp]\nreason = "Trim the lamp."\n\n[tide]\nevery = "1h"\nreason = "Look."\n');
  const lamp = "`lamp` isn't running: it needs exactly one of `every`, `at`, `on`, `when` or `follows` to say when it fires";
  await w.at(0);
  await w.at(1);
  expect(w.notes()).toEqual([["shore", `These triggers in TRIGGERS.toml aren't running:\n- ${lamp}`]]);
  expect(w.triggers.view().problems).toEqual([lamp]);

  w.file = HOURLY;
  await w.at(2);
  expect(w.notes()).toHaveLength(1);
  expect(w.triggers.view().problems).toEqual([]);

  w.file = '[lamp]\nevery = "1h"\n\n[ferry]\nat = "noon"\nreason = "r"\n';
  await w.at(3);
  expect(w.notes()).toHaveLength(2);
  expect(w.notes()[1]?.[1]).toStartWith("These triggers in TRIGGERS.toml aren't running:\n- `lamp` isn't running: it needs a `reason`");
  expect(w.notes()[1]?.[1]).toContain("\n- `ferry` isn't running: `at` must be");
});

test("an edited file is picked up at the next look, a trigger taken out and put back starts over, and a file that can't be read changes nothing", async () => {
  const w = await world(undefined);
  await w.at(0);
  expect(w.triggers.view()).toEqual({ enabled: true, triggers: [], problems: [] });
  w.file = HOURLY;
  await w.at(10);
  await w.at(69);
  expect(w.woke).toEqual([]);
  await w.at(70);
  expect(w.woke).toHaveLength(1);

  w.file = "";
  await w.at(71);
  w.file = HOURLY;
  await w.at(72);
  await w.at(131);
  expect(w.woke).toHaveLength(1);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 0, lastFiredAt: undefined, nextAt: T0 + 132 * MINUTE });
  w.unreadable = true;
  await w.at(132);
  expect(w.woke).toHaveLength(2);
  w.unreadable = false;

  w.settings = { ...w.settings, wakeCooldownMs: 3 * HOUR };
  await w.at(192);
  expect(w.woke).toHaveLength(2);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + 132 * MINUTE, nextAt: T0 + 312 * MINUTE });
});

test("what is known about each trigger survives a restart, and state that can't be read starts over", async () => {
  const w = await world(HOURLY);
  await w.at(0);
  w.restart();
  await w.at(59);
  expect(w.woke).toEqual([]);
  await w.at(60);
  expect(w.woke).toHaveLength(1);
  w.restart();
  expect(w.triggers.view().triggers).toEqual([]);
  await w.at(61);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + HOUR, off: false, failing: false, nextAt: T0 + 2 * HOUR });

  writeCharacterState(w.dir, "triggers.json", "{not json");
  await w.at(120);
  expect(w.woke).toHaveLength(1);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 0, nextAt: T0 + 180 * MINUTE });
  writeCharacterState(w.dir, "triggers.json", JSON.stringify({ records: { lamp: { since: "then", fired: 1 }, gone: 5 }, problems: "none" }));
  await w.at(121);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 0, nextAt: T0 + 181 * MINUTE });
  writeCharacterState(w.dir, "triggers.json", JSON.stringify({ records: { gone: null, lamp: { since: T0 + 100 * MINUTE, fired: 7, lastFiredAt: T0 + 100 * MINUTE } } }));
  await w.at(122);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 7, lastFiredAt: T0 + 100 * MINUTE, nextAt: T0 + 160 * MINUTE });
});

test("a check that throws doesn't stop the triggers from being looked at again", async () => {
  const w = await world('[tide]\nevery = "10m"\ncheck = "tide.sh"\ncooldown = "1m"\n');
  w.checks["tide"] = new Error("shutting down");
  await w.at(0);
  await w.at(10);
  expect(w.woke).toEqual([]);
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(11);
  expect(w.woke).toEqual([{ name: "tide", reason: "The tide is out.", at: T0 + 11 * MINUTE }]);
});

const BACK = '[welcome]\nwhen = "user_back"\nafter = "8h"\nreason = "They were away a while."\n';

test("a trigger for the user's return leaves its entry as they arrive, only when they were away long enough, and never from the regular look", async () => {
  const w = await world(BACK);
  await w.at(0);
  await w.at(600);
  expect(w.notes()).toEqual([]);
  await w.triggers.userBack(8 * HOUR - 1);
  expect(w.notes()).toEqual([]);
  await w.triggers.userBack(8 * HOUR);
  expect(w.notes()).toEqual([["welcome", "They were away a while."]]);
  expect(w.woke).toEqual([]);
  expect(w.triggers.view().triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + 600 * MINUTE, nextAt: undefined });
});

test("the check of a trigger for the user's return gets ten seconds at most, since their reply waits on it", async () => {
  const w = await world('[welcome]\nwhen = "user_back"\nafter = "8h"\ncheck = "welcome.sh"\ncooldown = "1h"\nbetween = "08:00-23:00"\n');
  w.checks["welcome"] = { kind: "fired", output: "Three days since the last note." };
  await w.triggers.userBack(9 * HOUR);
  expect(w.ran).toEqual([["welcome", 10_000]]);
  expect(w.notes()).toEqual([["welcome", "Three days since the last note."]]);

  w.now = T0 + 59 * MINUTE;
  await w.triggers.userBack(9 * HOUR);
  expect(w.ran).toHaveLength(1);
  w.now = T0 + HOUR;
  w.settings = { ...w.settings, checkLimitMs: 4_000 };
  await w.triggers.userBack(9 * HOUR);
  expect(w.ran).toEqual([["welcome", 10_000], ["welcome", 4_000]]);

  w.now = T0 + 12 * HOUR;
  await w.triggers.userBack(9 * HOUR);
  expect(w.ran).toHaveLength(2);
});

test("a trigger for the user's return works while the character is dormant, but not when it is switched off or triggers are off", async () => {
  const w = await world(BACK);
  w.dormant = true;
  await w.triggers.userBack(9 * HOUR);
  expect(w.notes()).toHaveLength(1);

  const off = await world(BACK);
  off.settings = { ...off.settings, off: ["welcome"] };
  await off.triggers.userBack(9 * HOUR);
  off.settings = { ...off.settings, off: [], enabled: false };
  await off.triggers.userBack(9 * HOUR);
  expect(off.notes()).toEqual([]);
  off.settings = { ...off.settings, enabled: true };
  await off.triggers.userBack(9 * HOUR);
  expect(off.notes()).toHaveLength(1);

  const other = await world(HOURLY);
  await other.triggers.userBack(9 * HOUR);
  expect(other.woke).toEqual([]);
  expect(other.notes()).toEqual([]);
});

test("a one-off fires once at its time, late if Shore wasn't looking then, and never if its time had passed when it was added", async () => {
  const w = await world('[midnight]\non = "2026-10-30 13:30"\nreason = "It is time."\n\n[missed]\non = "2026-10-30 11:00"\nreason = "Too late."\n');
  await w.at(0);
  expect(w.triggers.view().triggers.map((each) => each.nextAt)).toEqual([T0 + 90 * MINUTE, undefined]);
  await w.at(89);
  expect(w.woke).toEqual([]);
  await w.at(95);
  expect(w.woke).toEqual([{ name: "midnight", reason: "It is time.", at: T0 + 95 * MINUTE }]);
  await w.at(96);
  await w.at(3 * 24 * 60);
  expect(w.woke).toHaveLength(1);
  expect(w.triggers.view().triggers.map((each) => [each.fired, each.nextAt])).toEqual([[1, undefined], [0, undefined]]);
});

test("a firing says which thread to wake the character in, with the limit it asked for held to the user's ceiling", async () => {
  const w = await world([
    '[show]\nevery = "1h"\nreason = "The show."\nthread = "ring"\nlimit = "90m"\n',
    '[long]\nevery = "1h"\nreason = "A long sit."\nthread = "bench"\nlimit = "6h"\n',
    '[walk]\nevery = "1h"\nreason = "A walk."\nthread = "garden"\n',
    '[lamp]\nevery = "1h"\nreason = "Trim the lamp."\n',
  ].join("\n"));
  await w.at(0);
  await w.at(60);
  expect(w.woke).toEqual([
    { name: "show", reason: "The show.", at: T0 + HOUR, thread: "ring", limitMs: 90 * MINUTE },
    { name: "long", reason: "A long sit.", at: T0 + HOUR, thread: "bench", limitMs: 2 * HOUR },
    { name: "walk", reason: "A walk.", at: T0 + HOUR, thread: "garden" },
    { name: "lamp", reason: "Trim the lamp.", at: T0 + HOUR },
  ]);
});
