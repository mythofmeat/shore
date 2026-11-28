import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { TriggerFiring } from "../src/autonomy/runner.ts";
import type { CheckOutcome } from "../src/autonomy/trigger_check.ts";
import { CharacterTriggers, type TriggerSettings } from "../src/autonomy/trigger_loop.ts";
import { triggerTimes } from "../src/autonomy/triggers.ts";
import { writeCharacterState } from "../src/storage/store.ts";
import { testTmp } from "./support/tmp.ts";
import { Texts } from "../src/texts/texts.ts";

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
  statuses: string[];
  handed: [name: string, statusesSeen: readonly string[] | undefined][];
  woke: TriggerFiring[];
  triggers: CharacterTriggers;
  at: (minutes: number) => Promise<void>;
  restart: () => void;
}

async function world(file: string | undefined, dir?: string): Promise<World> {
  const w = {
    dir: dir ?? join(await mkdtemp(testTmp("shore-trigger-loop-")), "ada"),
    now: T0,
    file,
    unreadable: false,
    settings: { enabled: true, checks: true, wakeCooldownMs: HOUR, checkLimitMs: 60_000, maxWakeLimitMs: 2 * HOUR, off: [] as string[] },
    dormant: false,
    lastUserAt: undefined,
    checks: {},
    ran: [],
    statuses: [],
    handed: [],
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
      statuses: () => [...w.statuses],
      readFile: async () => {
        if (w.unreadable) throw new Error("permission denied");
        return w.file;
      },
      texts: () => new Texts(),
      runCheck: async (trigger, limitMs, statusesSeen) => {
        w.ran.push([trigger.name, limitMs]);
        w.handed.push([trigger.name, statusesSeen]);
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
  expect(asleep.ran).toEqual([["tide", 60_000]]);
  expect((await asleep.triggers.view()).triggers.map((each) => [each.trigger.name, each.fired])).toEqual([["lamp", 1], ["tide", 1]]);
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

test("a trigger with a check isn't run for a character without the bash tool, which the list of its triggers says, and runs once it has the tool", async () => {
  const w = await world('[tide]\nevery = "1h"\ncheck = "tide.sh"\n\n[lamp]\nevery = "1h"\nreason = "Trim the lamp."\n');
  w.settings = { ...w.settings, checks: false };
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(0);
  await w.at(60);
  await w.at(120);
  expect(w.ran).toEqual([]);
  expect(w.woke.map((firing) => firing.name)).toEqual(["lamp", "lamp"]);
  expect((await w.triggers.view()).problems).toEqual(["`tide` isn't running: its `check` is a command, and you don't have the `bash` tool to run commands with"]);
  expect((await w.triggers.view()).triggers.map((each) => each.trigger.name)).toEqual(["lamp"]);

  w.settings = { ...w.settings, checks: true };
  await w.at(121);
  await w.at(181);
  expect(w.ran).toEqual([["tide", 60_000]]);
  expect((await w.triggers.view()).problems).toEqual([]);
  expect(w.woke.filter((firing) => firing.name === "tide").map((firing) => firing.reason)).toEqual(["The tide is out."]);
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
});

test("when a check last ran is kept, whether it printed, stayed quiet or failed, and through a restart, and a trigger with no check has no such time", async () => {
  const w = await world(`[tide]\nevery = "1h"\ncheck = "tide.sh"\nwake = false\n\n${HOURLY}`);
  const checked = async (): Promise<(number | undefined)[]> => (await w.triggers.view()).triggers.map((each) => each.checkedAt);
  await w.at(0);
  expect(await checked()).toEqual([undefined, undefined]);
  await w.at(60);
  expect(await checked()).toEqual([T0 + HOUR, undefined]);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 0, lastFiredAt: undefined, problem: undefined });

  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(120);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + 2 * HOUR, checkedAt: T0 + 2 * HOUR });

  w.checks["tide"] = { kind: "failed", problem: "it exited with status 2" };
  await w.at(180);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ problem: "it exited with status 2", lastFiredAt: T0 + 2 * HOUR, checkedAt: T0 + 3 * HOUR });
  w.restart();
  await w.at(181);
  expect(await checked()).toEqual([T0 + 3 * HOUR, undefined]);
  expect((await w.triggers.view()).triggers[0]?.problem).toBe("it exited with status 2");

  writeCharacterState(w.dir, "triggers.json", JSON.stringify({ records: { tide: { since: T0 + 181 * MINUTE, fired: 1, checkedAt: "then", problem: 2 } } }));
  await w.at(182);
  expect(await checked()).toEqual([undefined, undefined]);
  expect((await w.triggers.view()).triggers[0]?.problem).toBeUndefined();
});

test("a one-off that was to wake the character does so even when its check fails, saying why, and one that never wakes is only kept as failing", async () => {
  const w = await world([
    '[call]\non = "2026-10-30 13:00"\ncheck = "call.sh"\nreason = "Time to call."\n',
    '[bare]\non = "2026-10-30 13:00"\ncheck = "bare.sh"\n',
    '[note]\non = "2026-10-30 13:00"\ncheck = "note.sh"\nwake = false\n',
    '[after]\nfollows = "call"\nreason = "Write up the call."\n',
    '[watch]\nevery = "1h"\ncheck = "watch.sh"\nreason = "Keep watch."\n',
  ].join("\n"));
  for (const name of ["call", "bare", "note", "watch"]) w.checks[name] = { kind: "failed", problem: "it exited with status 2" };
  await w.at(0);
  await w.at(60);
  const woken = "Shore couldn't tell from this one-off's check whether to wake you, because the check failed: it exited with status 2. A one-off gets no second try, so you are woken anyway.";
  expect(w.woke).toEqual([
    { name: "call", reason: `Time to call.\n${woken}`, at: T0 + HOUR },
    { name: "bare", reason: woken, at: T0 + HOUR },
  ]);
  const failed = "it exited with status 2";
  expect((await w.triggers.view()).triggers.map((each) => [each.trigger.name, each.fired, each.problem, each.lastFiredAt, each.checkedAt, each.nextAt])).toEqual([
    ["call", 1, failed, T0 + HOUR, T0 + HOUR, undefined],
    ["bare", 1, failed, T0 + HOUR, T0 + HOUR, undefined],
    ["note", 0, failed, undefined, T0 + HOUR, undefined],
    ["after", 0, undefined, undefined, undefined, undefined],
    ["watch", 0, failed, undefined, T0 + HOUR, T0 + 2 * HOUR],
  ]);

  await w.at(61);
  await w.at(119);
  expect(w.ran.map(([name]) => name)).toEqual(["call", "bare", "note", "watch"]);
  await w.at(120);
  expect(w.ran.map(([name]) => name)).toEqual(["call", "bare", "note", "watch", "watch"]);
  expect(w.woke).toHaveLength(2);
  await w.triggers.finished(["call"]);
  await w.at(121);
  expect(w.woke.map((firing) => firing.name)).toEqual(["call", "bare", "after"]);
});

test("a one-off stays listed as fired with no next time, and a later time written in its place arms it again with no cooldown to wait out", async () => {
  const w = await world('[call]\non = "2026-10-30 13:00"\nreason = "Time to call."\n');
  await w.at(0);
  await w.at(60);
  expect(w.woke).toHaveLength(1);
  await w.at(70);
  expect((await w.triggers.view()).triggers.map((each) => [each.trigger.name, each.fired, each.lastFiredAt, each.nextAt])).toEqual([["call", 1, T0 + HOUR, undefined]]);

  w.file = '[call]\non = "2026-10-30 13:30"\nreason = "Time to call again."\n';
  await w.at(71);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 1, nextAt: T0 + 90 * MINUTE });
  await w.at(89);
  expect(w.woke).toHaveLength(1);
  await w.at(90);
  expect(w.woke).toEqual([
    { name: "call", reason: "Time to call.", at: T0 + HOUR },
    { name: "call", reason: "Time to call again.", at: T0 + 90 * MINUTE },
  ]);
  await w.at(600);
  expect(w.woke).toHaveLength(2);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 2, lastFiredAt: T0 + 90 * MINUTE, nextAt: undefined });
});

test("a failing check is kept with what went wrong until it works again, and nobody is woken for it", async () => {
  const w = await world('[tide]\nevery = "10m"\ncheck = "tide.sh"\nwake = false\n');
  const tide = async (): Promise<unknown> => (await w.triggers.view()).triggers[0];
  w.checks["tide"] = { kind: "failed", problem: "it exited with status 2" };
  await w.at(0);
  await w.at(10);
  expect(await tide()).toMatchObject({ problem: "it exited with status 2", fired: 0, lastFiredAt: undefined });
  await w.at(20);
  expect(w.ran).toHaveLength(2);
  expect(await tide()).toMatchObject({ problem: "it exited with status 2", fired: 0, checkedAt: T0 + 20 * MINUTE });

  w.checks["tide"] = { kind: "quiet" };
  await w.at(30);
  expect(await tide()).toMatchObject({ problem: undefined, fired: 0 });
  w.checks["tide"] = { kind: "failed", problem: "it was still running at its time limit and was stopped" };
  await w.at(40);
  expect(await tide()).toMatchObject({ problem: "it was still running at its time limit and was stopped" });

  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(50);
  expect(await tide()).toMatchObject({ problem: undefined, fired: 1, lastFiredAt: T0 + 50 * MINUTE });
  expect(w.woke).toEqual([]);
});

test("a trigger that doesn't wake runs its check each time it comes due, and wakes nobody whatever the check prints", async () => {
  const w = await world('[tide]\nevery = "10m"\ncheck = "tide.sh"\nwake = false\n');
  w.checks["tide"] = { kind: "fired", output: "The tide is out." };
  await w.at(0);
  await w.at(10);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + 10 * MINUTE });
  w.checks["tide"] = { kind: "fired", output: "The tide is in." };
  await w.at(20);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 2, lastFiredAt: T0 + 20 * MINUTE });
  expect(w.ran).toEqual([["tide", 60_000], ["tide", 60_000]]);
  expect(w.woke).toEqual([]);
});

test("a trigger that comes due outside its hours is skipped, not held until they open", async () => {
  const w = await world('[lamp]\nevery = "1h"\nreason = "Trim the lamp."\nbetween = "14:30-16:00"\n');
  const next = async (): Promise<number | undefined> => (await w.triggers.view()).triggers[0]?.nextAt;
  await w.at(0);
  expect(await next()).toBe(T0 + 3 * HOUR);
  await w.at(60);
  await w.at(120);
  await w.at(150);
  await w.at(179);
  expect(w.woke).toEqual([]);
  await w.at(180);
  expect(w.woke).toEqual([{ name: "lamp", reason: "Trim the lamp.", at: T0 + 3 * HOUR }]);
  expect(await next()).toBe(T0 + 27 * HOUR);
  await w.at(240);
  await w.at(241);
  expect(w.woke).toHaveLength(1);
});

test("a trigger whose times never fall inside its hours has no next time, and one for the user going quiet has one only if the quiet ends inside them", async () => {
  const w = await world([
    '[daily]\nevery = "24h"\nreason = "Daily."\nbetween = "14:30-16:00"',
    '[supper]\nat = "13:30"\nreason = "Supper."\nbetween = "14:30-16:00"',
    '[early]\nwhen = "user_quiet"\nafter = "2h"\nreason = "Gone a while."\nbetween = "14:30-16:00"',
    '[late]\nwhen = "user_quiet"\nafter = "3h"\nreason = "Gone longer."\nbetween = "14:30-16:00"',
    '[status]\nwhen = "status_changed"\nreason = "Their status changed."',
  ].join("\n\n"));
  w.lastUserAt = T0;
  await w.at(0);
  expect((await w.triggers.view()).triggers.map((each) => [each.trigger.name, each.nextAt])).toEqual([
    ["daily", undefined], ["supper", undefined], ["early", undefined], ["late", T0 + 3 * HOUR], ["status", undefined],
  ]);
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
  const next = async (): Promise<number | undefined> => (await w.triggers.view()).triggers[0]?.nextAt;
  await w.at(0);
  await w.at(500);
  expect(w.woke).toEqual([]);
  expect(await next()).toBeUndefined();
  w.lastUserAt = T0 + 500 * MINUTE;
  expect(await next()).toBe(T0 + 620 * MINUTE);
  await w.at(619);
  expect(w.woke).toEqual([]);
  await w.at(620);
  expect(w.woke).toEqual([{ name: "missed", reason: "They have been gone a while.", at: T0 + 620 * MINUTE }]);
  expect(await next()).toBeUndefined();
  await w.at(900);
  expect(w.woke).toHaveLength(1);
  w.lastUserAt = T0 + 901 * MINUTE;
  await w.at(1020);
  expect(w.woke).toHaveLength(1);
  await w.at(1021);
  expect(w.woke).toHaveLength(2);
});

test("a trigger for a status change waits for one, and for its own cooldown, without losing the change", async () => {
  const w = await world('[status]\nwhen = "status_changed"\nreason = "Their status changed."\n');
  await w.at(0);
  await w.at(600);
  expect(w.woke).toEqual([]);
  await w.triggers.statusChanged();
  await w.at(601);
  expect(w.woke).toEqual([{ name: "status", reason: "Their status changed.", at: T0 + 601 * MINUTE }]);
  await w.at(602);
  expect(w.woke).toHaveLength(1);
  await w.triggers.statusChanged();
  await w.at(660);
  expect(w.woke).toHaveLength(1);
  await w.at(661);
  expect(w.woke).toHaveLength(2);

  const early = await world('[status]\nwhen = "status_changed"\nreason = "Their status changed."\n\n[missed]\nwhen = "user_quiet"\nafter = "2h"\nreason = "Gone a while."\n');
  await early.at(0);
  early.restart();
  writeCharacterState(early.dir, "triggers.json", "{}");
  await early.triggers.statusChanged();
  expect((await early.triggers.view()).triggers.map((each) => each.fired)).toEqual([0, 0]);
  await early.at(1);
  expect(early.woke.map((firing) => firing.name)).toEqual(["status"]);
  expect((await early.triggers.view()).triggers.map((each) => each.fired)).toEqual([1, 0]);

  const off = await world('[status]\nwhen = "status_changed"\nreason = "Their status changed."\n');
  off.settings = { ...off.settings, enabled: false };
  await off.triggers.statusChanged();
  off.settings = { ...off.settings, enabled: true };
  await off.at(1);
  await off.at(2);
  expect(off.woke).toEqual([]);
});

test("a check for a status change is handed the statuses on when its trigger last came due or was first seen, so changes during a cooldown or while triggers were off add up, and no other check is handed any", async () => {
  const w = await world('[status]\nwhen = "status_changed"\ncheck = "x"\n\n[lamp]\nevery = "1h"\ncheck = "y"\n');
  w.checks["status"] = { kind: "fired", output: "changed" };
  w.statuses = ["home"];
  await w.at(0);
  w.statuses = ["home", "sick"];
  await w.triggers.statusChanged();
  w.statuses = ["home", "sick", "in bed"];
  await w.triggers.statusChanged();
  await w.at(1);
  expect(w.handed).toEqual([["status", ["home"]]]);

  w.statuses = ["in bed"];
  await w.triggers.statusChanged();
  await w.at(30);
  expect(w.handed).toHaveLength(1);
  w.restart();
  await w.at(61);
  expect(w.handed).toEqual([["status", ["home"]], ["status", ["home", "sick", "in bed"]], ["lamp", undefined]]);

  w.settings = { ...w.settings, enabled: false };
  w.statuses = [];
  await w.triggers.statusChanged();
  w.settings = { ...w.settings, enabled: true };
  w.statuses = ["out"];
  await w.triggers.statusChanged();
  await w.at(122);
  expect(w.handed.slice(3)).toEqual([["status", ["in bed"]], ["lamp", undefined]]);

  for (const [kept, handed] of [[["home", 5, null], ["home"]], ["home", ["out"]]] as const) {
    writeCharacterState(w.dir, "triggers.json", JSON.stringify({ records: { status: { since: T0, fired: 0, pending: true, statusesSeen: kept } } }));
    w.handed.length = 0;
    await w.at(200);
    expect(w.handed.filter(([name]) => name === "status")).toEqual([["status", handed]]);
  }
});

test("a follower fires after the trigger it names: at the next look when that one doesn't wake, and after its wake is finished when it woke the character", async () => {
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
  expect((await w.triggers.view()).triggers.map((each) => [each.trigger.name, each.off, each.fired, each.nextAt])).toEqual([["tide", true, 0, undefined], ["lamp", false, 1, T0 + 20 * MINUTE]]);
  w.settings = { ...w.settings, off: [] };
  await w.at(11);
  await w.at(20);
  expect(w.ran).toEqual([]);
  await w.at(21);
  expect(w.ran).toEqual([["tide", 60_000]]);
});

test("triggers that don't make sense are listed as not running, and the list follows the file", async () => {
  const w = await world('[lamp]\nreason = "Trim the lamp."\n\n[tide]\nevery = "1h"\nreason = "Look."\n');
  const lamp = "`lamp` isn't running: it needs exactly one of `every`, `at`, `on`, `when` or `follows` to say when it fires";
  await w.at(0);
  await w.at(1);
  expect((await w.triggers.view()).problems).toEqual([lamp]);
  expect((await w.triggers.view()).triggers.map((each) => each.trigger.name)).toEqual(["tide"]);

  w.file = HOURLY;
  await w.at(2);
  expect((await w.triggers.view()).problems).toEqual([]);

  w.file = '[lamp]\nevery = "1h"\n\n[ferry]\nat = "noon"\nreason = "r"\n';
  await w.at(3);
  expect((await w.triggers.view()).problems).toHaveLength(2);
  expect((await w.triggers.view()).problems[0]).toStartWith("`lamp` isn't running: it needs a `reason`");
  expect((await w.triggers.view()).problems[1]).toStartWith("`ferry` isn't running: `at` must be");
  expect(w.woke).toEqual([]);
});

test("an edited file is picked up at the next look, a trigger taken out and put back starts over, and a file that can't be read changes nothing", async () => {
  const w = await world(undefined);
  await w.at(0);
  expect((await w.triggers.view())).toEqual({ enabled: true, triggers: [], problems: [] });
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
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 0, lastFiredAt: undefined, nextAt: T0 + 132 * MINUTE });
  w.unreadable = true;
  await w.at(132);
  expect(w.woke).toHaveLength(2);
  w.unreadable = false;

  w.settings = { ...w.settings, wakeCooldownMs: 3 * HOUR };
  await w.at(192);
  expect(w.woke).toHaveLength(2);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + 132 * MINUTE, nextAt: T0 + 312 * MINUTE });
});

test("the list is read from the file whenever it is asked for, with triggers switched off too, and a file that can't be read leaves the list it had", async () => {
  const w = await world(undefined);
  w.settings = { ...w.settings, enabled: false };
  expect(await w.triggers.view()).toEqual({ enabled: false, triggers: [], problems: [] });
  w.file = HOURLY;
  expect((await w.triggers.view()).triggers.map((each) => each.trigger.name)).toEqual(["lamp"]);
  w.unreadable = true;
  expect((await w.triggers.view()).triggers.map((each) => each.trigger.name)).toEqual(["lamp"]);
  w.unreadable = false;
  w.file = "";
  expect((await w.triggers.view()).triggers).toEqual([]);
  expect(w.woke).toEqual([]);
});

test("the times a stopped wake's triggers are held to are read from the file as it is, whether or not triggers are on, with none for a file that isn't there and nothing for one that can't be read", async () => {
  const w = await world(HOURLY);
  w.settings = { ...w.settings, enabled: false };
  expect(await w.triggers.times()).toEqual(triggerTimes(HOURLY));
  w.file = '[lamp]\nevery = "2h"\nreason = "Trim the lamp."\n';
  expect(await w.triggers.times()).toEqual(triggerTimes(w.file));
  expect(await w.triggers.times()).not.toEqual(triggerTimes(HOURLY));
  w.file = undefined;
  expect(await w.triggers.times()).toEqual(new Map());
  w.unreadable = true;
  expect(await w.triggers.times()).toBeUndefined();
  expect(w.woke).toEqual([]);
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
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + HOUR, nextAt: T0 + 2 * HOUR });
  await w.at(61);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 1, lastFiredAt: T0 + HOUR, off: false, problem: undefined, nextAt: T0 + 2 * HOUR });

  writeCharacterState(w.dir, "triggers.json", "{not json");
  await w.at(120);
  expect(w.woke).toHaveLength(1);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 0, nextAt: T0 + 180 * MINUTE });
  writeCharacterState(w.dir, "triggers.json", JSON.stringify({ records: { lamp: { since: "then", fired: 1 }, gone: 5 }, problems: "none" }));
  await w.at(121);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 0, nextAt: T0 + 181 * MINUTE });
  writeCharacterState(w.dir, "triggers.json", JSON.stringify({ records: { gone: null, lamp: { since: T0 + 100 * MINUTE, fired: 7, lastFiredAt: T0 + 100 * MINUTE } } }));
  await w.at(122);
  expect((await w.triggers.view()).triggers[0]).toMatchObject({ fired: 7, lastFiredAt: T0 + 100 * MINUTE, nextAt: T0 + 160 * MINUTE });
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

test("a one-off fires once at its time, late if Shore wasn't looking then, and never if its time had passed when it was added", async () => {
  const w = await world('[midnight]\non = "2026-10-30 13:30"\nreason = "It is time."\n\n[missed]\non = "2026-10-30 11:00"\nreason = "Too late."\n');
  await w.at(0);
  expect((await w.triggers.view()).triggers.map((each) => each.nextAt)).toEqual([T0 + 90 * MINUTE, undefined]);
  await w.at(89);
  expect(w.woke).toEqual([]);
  await w.at(95);
  expect(w.woke).toEqual([{ name: "midnight", reason: "It is time.", at: T0 + 95 * MINUTE }]);
  await w.at(96);
  await w.at(3 * 24 * 60);
  expect(w.woke).toHaveLength(1);
  expect((await w.triggers.view()).triggers.map((each) => [each.fired, each.nextAt])).toEqual([[1, undefined], [0, undefined]]);
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
