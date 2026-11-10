import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../src/config/loader.ts";
import { configSchema } from "../src/config/schema.ts";
import { testTmp } from "./support/tmp.ts";
import { coolingDown, inItsHours, nextAt, parseTriggers, scheduledAt, type Trigger, type TriggerWhen } from "../src/autonomy/triggers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEFAULT_COOLDOWN = HOUR;
const WEEK = [0, 1, 2, 3, 4, 5, 6];
const SETTINGS = "every, at, on, when, after, follows, check, wake, reason, cooldown, between";
const AT_HELP = '`at` must be a 24-hour local time, with the days it applies to in front if not every day, like "20:00" or "Sat 20:00" or "Mon,Thu 09:30"';

function parse(content: string): ReturnType<typeof parseTriggers> {
  return parseTriggers(content, DEFAULT_COOLDOWN);
}

function only(body: string): Trigger | string {
  const { triggers, problems } = parse(`[t]\n${body}\n`);
  expect(triggers.length + problems.length).toBe(1);
  return triggers[0] ?? (problems[0] as string);
}

function whenOf(body: string): TriggerWhen | string {
  const parsed = only(`${body}\nreason = "r"`);
  return typeof parsed === "string" ? parsed : parsed.when;
}

function utc(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 9, day, hour, minute);
}

test("a triggers file is read one trigger per table, each with when it fires and what it does", () => {
  expect(parse([
    "[tide-table]",
    'every = "90m"',
    'check = " scripts/tide.sh  "',
    "wake = false",
    "",
    "[saturday_show]",
    'at = "Sat 20:00"',
    'reason = "  Write the show. "',
    'cooldown = "6h"',
    'between = "08:00-23:00"',
    "",
    "[welcome_back]",
    'when = "user_back"',
    'after = "8h"',
    'reason = "They are back."',
    'check = "scripts/gone_long.sh"',
    "",
    "[show-recap]",
    'follows = "saturday_show"',
    'reason = "Write up how it went."',
    "",
  ].join("\n"))).toEqual({
    problems: [],
    triggers: [
      { name: "tide-table", when: { kind: "every", everyMs: 90 * MINUTE }, wakes: false, reason: undefined, check: "scripts/tide.sh", cooldownMs: 0, between: undefined },
      { name: "saturday_show", when: { kind: "at", weekdays: [6], minute: 20 * 60 }, wakes: true, reason: "Write the show.", check: undefined, cooldownMs: 6 * HOUR, between: { startMinute: 8 * 60, endMinute: 23 * 60 } },
      { name: "welcome_back", when: { kind: "event", event: "user_back", afterMs: 8 * HOUR }, wakes: false, reason: "They are back.", check: "scripts/gone_long.sh", cooldownMs: 0, between: undefined },
      { name: "show-recap", when: { kind: "follows", trigger: "saturday_show" }, wakes: true, reason: "Write up how it went.", check: undefined, cooldownMs: DEFAULT_COOLDOWN, between: undefined },
    ],
  });
  expect(parse("")).toEqual({ triggers: [], problems: [] });
});

test("a file that isn't TOML runs no triggers and says so, and one bad trigger doesn't stop the rest", () => {
  const broken = parse('[a]\nevery = "1h"\nreason = "r"\n[b\n');
  expect(broken.triggers).toEqual([]);
  expect(broken.problems).toHaveLength(1);
  expect(broken.problems[0]).toStartWith("TRIGGERS.toml can't be read as TOML, so none of its triggers are running: ");
  expect(broken.problems[0]?.length).toBeGreaterThan("TRIGGERS.toml can't be read as TOML, so none of its triggers are running: ".length);

  const mixed = parse('stray = 5\nlist = [1]\n\n[good]\nevery = "1h"\nreason = "r"\n\n[bad]\nreason = "r"\n');
  expect(mixed.triggers.map((trigger) => trigger.name)).toEqual(["good"]);
  expect(mixed.problems).toEqual([
    "`stray` isn't running: write it as `[stray]` with its settings on the lines under it",
    "`list` isn't running: write it as `[list]` with its settings on the lines under it",
    "`bad` isn't running: it needs exactly one of `every`, `at`, `on`, `when` or `follows` to say when it fires",
  ]);
});

test("a trigger's name is letters, digits, dashes and underscores, at most 64 long, and a dotted one is explained", () => {
  const named = (name: string): string[] => parse(`["${name}"]\nevery = "1h"\nreason = "r"\n`).problems;
  const problem = (name: string): string[] => [`\`${name}\` isn't running: a trigger's name is letters, digits, dashes and underscores, starting with a letter or digit, at most 64 characters`];
  expect(named("a")).toEqual([]);
  expect(named("9tide_table-2")).toEqual([]);
  expect(named("tide.table")).toEqual(problem("tide.table"));
  expect(named("a".repeat(64))).toEqual([]);
  expect(named("a".repeat(65))).toEqual(problem("a".repeat(65)));
  expect(named("bad name")).toEqual(problem("bad name"));
  expect(named("-tide")).toEqual(problem("-tide"));
  expect(parse('[saturday.show]\nat = "Sat 20:00"\nreason = "r"\n').problems).toEqual([
    "`saturday` isn't running: a trigger's name can't have a dot in it, so `[saturday.show]` could be `[saturday-show]`",
  ]);
  expect(parse('[a]\nevery = "1h"\nreason = "r"\nextra = [1]\n').problems).toEqual([
    `\`a\` isn't running: \`extra\` isn't a trigger setting; the settings are ${SETTINGS}`,
  ]);
});

test("a setting that isn't one is named, with the list of those that are", () => {
  expect(only('every = "1h"\nreason = "r"\nthen = "note"\nfoo = 1')).toBe(
    `\`t\` isn't running: \`then\`, \`foo\` isn't a trigger setting; the settings are ${SETTINGS}`,
  );
});

test("a trigger says when it fires in exactly one way", () => {
  const one = "`t` isn't running: it needs exactly one of `every`, `at`, `on`, `when` or `follows` to say when it fires";
  expect(whenOf("")).toBe(one);
  expect(whenOf('every = "1h"\nat = "20:00"')).toBe(one);
  expect(whenOf('at = "20:00"\nwhen = "dream_done"')).toBe(one);
  expect(whenOf('every = "1h"\nfollows = "other"')).toBe(one);
  expect(whenOf('follows = "other"\nafter = "2h"')).toBe("`t` isn't running: `after` only goes with `when`");
  expect(whenOf('every = "1h"\nafter = "2h"')).toBe("`t` isn't running: `after` only goes with `when`");
  expect(whenOf('at = "20:00"\nafter = "2h"')).toBe("`t` isn't running: `after` only goes with `when`");
});

test("`every` is a length of time of at least a minute", () => {
  const length = '`t` isn\'t running: `every` must be a length of time in quotes, like "90m" or "6h"';
  expect(whenOf('every = "1m"')).toEqual({ kind: "every", everyMs: MINUTE });
  expect(whenOf('every = "2d"')).toEqual({ kind: "every", everyMs: 2 * DAY });
  expect(whenOf('every = "59s"')).toBe("`t` isn't running: `every` can't be shorter than a minute");
  expect(whenOf("every = 5")).toBe(length);
  expect(whenOf('every = "soon"')).toBe(length);
});

test("`at` is a 24-hour time, on every day unless days are named, and the days come out in order without repeats", () => {
  expect(whenOf('at = "20:00"')).toEqual({ kind: "at", weekdays: WEEK, minute: 1200 });
  expect(whenOf('at = " 0:05 "')).toEqual({ kind: "at", weekdays: WEEK, minute: 5 });
  expect(whenOf('at = "23:59"')).toEqual({ kind: "at", weekdays: WEEK, minute: 23 * 60 + 59 });
  expect(whenOf('at = "Mon,Thu 09:30"')).toEqual({ kind: "at", weekdays: [1, 4], minute: 570 });
  expect(whenOf('at = "saturday, Thursday  monday SAT 7:00"')).toEqual({ kind: "at", weekdays: [1, 4, 6], minute: 420 });
  expect(whenOf('at = "sun 7:00"')).toEqual({ kind: "at", weekdays: [0], minute: 420 });
  for (const wrong of ['"24:00"', '"12:60"', '"8PM"', '"Someday 10:00"', '"Sat"', '"20:00 Sat"', "8", '""']) {
    expect(whenOf(`at = ${wrong}`), wrong).toBe(`\`t\` isn't running: ${AT_HELP}`);
  }
});

test("`when` names something that happens, and the two about the user being away need how long", () => {
  expect(whenOf('when = "user_back"\nafter = "8h"')).toEqual({ kind: "event", event: "user_back", afterMs: 8 * HOUR });
  expect(whenOf('when = "user_quiet"\nafter = "36h"')).toEqual({ kind: "event", event: "user_quiet", afterMs: 36 * HOUR });
  expect(whenOf('when = "dream_done"')).toEqual({ kind: "event", event: "dream_done", afterMs: 0 });
  expect(whenOf('when = "user_back"')).toBe('`t` isn\'t running: `when = "user_back"` needs `after`, the least time away that counts');
  expect(whenOf('when = "user_quiet"')).toBe('`t` isn\'t running: `when = "user_quiet"` needs `after`, the least time away that counts');
  expect(whenOf('when = "dream_done"\nafter = "1h"')).toBe('`t` isn\'t running: `when = "dream_done"` takes no `after`');
  expect(whenOf('when = "user_back"\nafter = "later"')).toBe('`t` isn\'t running: `after` must be a length of time in quotes, like "90m" or "6h"');
  expect(whenOf('when = "wake_done"')).toBe('`t` isn\'t running: `when` must be one of "user_back", "user_quiet", "dream_done"');
  expect(whenOf('when = "full_moon"')).toBe('`t` isn\'t running: `when` must be one of "user_back", "user_quiet", "dream_done"');
  expect(whenOf("when = 3")).toBe('`t` isn\'t running: `when` must be one of "user_back", "user_quiet", "dream_done"');
});

test("a trigger wakes the character unless told not to, and has a reason of its own or a check to give one", () => {
  const wakes = (body: string): boolean | string => {
    const parsed = only(`every = "1h"\nreason = "r"\n${body}`);
    return typeof parsed === "string" ? parsed : parsed.wakes;
  };
  expect(wakes("")).toBe(true);
  expect(wakes("wake = true")).toBe(true);
  expect(wakes("wake = false")).toBe(false);
  expect(wakes('wake = "no"')).toBe("`t` isn't running: `wake` must be true or false, without quotes");

  expect(only('every = "1h"')).toBe("`t` isn't running: it needs a `reason` to show you when it fires, or a `check` whose output is the reason");
  expect(only('every = "1h"\nreason = 5')).toBe("`t` isn't running: `reason` must be text in quotes");
  expect(only('every = "1h"\nreason = "  "')).toBe("`t` isn't running: `reason` must be text in quotes");
  expect(only('every = "1h"\ncheck = ["a"]')).toBe("`t` isn't running: `check` must be text in quotes");
  expect(only('every = "1h"\ncheck = ""')).toBe("`t` isn't running: `check` must be text in quotes");
  expect(only('every = "1h"\ncheck = "true"')).toMatchObject({ reason: undefined, check: "true" });
});

test("a wake has the default cooldown unless it sets one, a note has none, and `between` is a range of local hours", () => {
  const rule = (body: string): Pick<Trigger, "cooldownMs" | "between"> | string => {
    const parsed = only(`every = "1h"\nreason = "r"\n${body}`);
    return typeof parsed === "string" ? parsed : { cooldownMs: parsed.cooldownMs, between: parsed.between };
  };
  expect(rule("")).toEqual({ cooldownMs: DEFAULT_COOLDOWN, between: undefined });
  expect(rule("wake = false")).toEqual({ cooldownMs: 0, between: undefined });
  expect(rule('wake = false\ncooldown = "2h"')).toEqual({ cooldownMs: 2 * HOUR, between: undefined });
  expect(rule('cooldown = "10m"\nbetween = "22:30-06:00"')).toEqual({ cooldownMs: 10 * MINUTE, between: { startMinute: 22 * 60 + 30, endMinute: 6 * 60 } });
  expect(rule("cooldown = 6")).toBe('`t` isn\'t running: `cooldown` must be a length of time in quotes, like "90m" or "6h"');
  expect(rule('between = "25:00-03:00"')).toBe('`t` isn\'t running: `between` must be a local time range like "08:00-23:00"');
  expect(rule("between = 8")).toBe('`t` isn\'t running: `between` must be a local time range like "08:00-23:00"');
});

test("the next time for `at` is the first one strictly later, today if it hasn't passed", () => {
  const daily = { kind: "at", weekdays: WEEK, minute: 20 * 60 } as const;
  expect(nextAt(daily, utc(30, 12), "UTC")).toBe(utc(30, 20));
  expect(nextAt(daily, utc(30, 20) - 1, "UTC")).toBe(utc(30, 20));
  expect(nextAt(daily, utc(30, 20), "UTC")).toBe(utc(31, 20));
  expect(nextAt(daily, utc(30, 20, 1), "UTC")).toBe(utc(31, 20));
  expect(nextAt({ ...daily, minute: 9 * 60 + 5 }, utc(30, 12), "UTC")).toBe(utc(31, 9, 5));
});

test("named days are waited for, and the same day next week once this week's time has passed", () => {
  const saturday = { kind: "at", weekdays: [6], minute: 20 * 60 } as const;
  expect(new Date(utc(30, 12)).getUTCDay()).toBe(5);
  expect(nextAt(saturday, utc(30, 12), "UTC")).toBe(utc(31, 20));
  expect(nextAt(saturday, utc(31, 19, 59), "UTC")).toBe(utc(31, 20));
  expect(nextAt(saturday, utc(31, 20), "UTC")).toBe(Date.UTC(2026, 10, 7, 20));
  expect(nextAt({ kind: "at", weekdays: [1, 4], minute: 9 * 60 + 30 }, utc(30, 12), "UTC")).toBe(Date.UTC(2026, 10, 2, 9, 30));
  expect(nextAt({ kind: "at", weekdays: [1, 4], minute: 9 * 60 + 30 }, Date.UTC(2026, 10, 2, 9, 30), "UTC")).toBe(Date.UTC(2026, 10, 5, 9, 30));
  expect(nextAt({ kind: "at", weekdays: [0], minute: 0 }, utc(30, 12), "UTC")).toBe(Date.UTC(2026, 10, 1, 0));
  expect(nextAt({ kind: "at", weekdays: [5], minute: 6 * 60 }, utc(30, 12), "UTC")).toBe(Date.UTC(2026, 10, 6, 6));
  for (const [weekday, day] of [[6, 31], [0, 32], [1, 33], [2, 34], [3, 35], [4, 36], [5, 37]] as const) {
    expect(nextAt({ kind: "at", weekdays: [weekday], minute: 13 * 60 }, utc(30, 13), "UTC"), `weekday ${String(weekday)}`).toBe(utc(day, 13));
  }
});

test("the time is the character's local one, and a time a clock change skips moves to the hour after", () => {
  const morning = { kind: "at", weekdays: WEEK, minute: 9 * 60 } as const;
  expect(nextAt(morning, utc(30, 12), "Australia/Sydney")).toBe(utc(30, 22));
  expect(nextAt({ kind: "at", weekdays: [6], minute: 9 * 60 }, utc(30, 23), "Australia/Sydney")).toBe(Date.UTC(2026, 10, 6, 22));
  const skipped = { kind: "at", weekdays: WEEK, minute: 2 * 60 + 30 } as const;
  expect(nextAt(skipped, Date.UTC(2026, 2, 8, 5), "America/New_York")).toBe(Date.UTC(2026, 2, 8, 7, 30));
});

test("a schedule's next time counts from when it last ran, and something that happens has none", () => {
  expect(scheduledAt({ kind: "every", everyMs: 90 * MINUTE }, utc(30, 12), "UTC")).toBe(utc(30, 13, 30));
  expect(scheduledAt({ kind: "at", weekdays: [6], minute: 20 * 60 }, utc(30, 12), "UTC")).toBe(utc(31, 20));
  expect(scheduledAt({ kind: "event", event: "dream_done", afterMs: 0 }, utc(30, 12), "UTC")).toBeUndefined();
  expect(scheduledAt({ kind: "follows", trigger: "show" }, utc(30, 12), "UTC")).toBeUndefined();
});

test("a trigger is cooling down until its cooldown has passed since it last fired, and keeps to its hours in the local zone", () => {
  expect(coolingDown(HOUR, undefined, utc(30, 12))).toBe(false);
  expect(coolingDown(HOUR, utc(30, 12), utc(30, 13) - 1)).toBe(true);
  expect(coolingDown(HOUR, utc(30, 12), utc(30, 13))).toBe(false);
  expect(coolingDown(0, utc(30, 12), utc(30, 12))).toBe(false);

  const daytime = { startMinute: 8 * 60, endMinute: 23 * 60 };
  expect(inItsHours(undefined, utc(30, 3), "UTC")).toBe(true);
  expect(inItsHours(daytime, utc(30, 8), "UTC")).toBe(true);
  expect(inItsHours(daytime, utc(30, 8) - 1, "UTC")).toBe(false);
  expect(inItsHours(daytime, utc(30, 22, 59), "UTC")).toBe(true);
  expect(inItsHours(daytime, utc(30, 23), "UTC")).toBe(false);
  expect(inItsHours(daytime, utc(30, 12), "Australia/Sydney")).toBe(false);
  expect(inItsHours(daytime, utc(30, 22), "Australia/Sydney")).toBe(true);
  expect(inItsHours({ startMinute: 10 * 60, endMinute: 3 * 60 }, utc(30, 2, 59), "UTC")).toBe(true);
  expect(inItsHours({ startMinute: 10 * 60, endMinute: 3 * 60 }, utc(30, 3), "UTC")).toBe(false);
});

test("a trigger that answers the user coming back never wakes the character, and says so if asked to", () => {
  const back = 'when = "user_back"\nafter = "8h"\nreason = "r"';
  const never = '`t` isn\'t running: `when = "user_back"` never wakes you, because you are already answering them, and what it says arrives with their message; leave `wake` out';
  expect(only(back)).toMatchObject({ wakes: false, cooldownMs: 0 });
  expect(only(`${back}\ncooldown = "1d"`)).toMatchObject({ wakes: false, cooldownMs: DAY });
  expect(only(`${back}\nwake = true`)).toBe(never);
  expect(only(`${back}\nwake = false`)).toBe(never);
  expect(only('when = "user_quiet"\nafter = "8h"\nreason = "r"')).toMatchObject({ wakes: true, cooldownMs: DEFAULT_COOLDOWN });
  expect(only('when = "dream_done"\nreason = "r"\nwake = false')).toMatchObject({ wakes: false, cooldownMs: 0 });
});

test("a trigger can follow another by name, but not itself, one that isn't running, or one that answers the user coming back", () => {
  const show = '[show]\nat = "Sat 20:00"\nreason = "r"\n';
  const follows = (leader: string): string => `[recap]\nfollows = ${leader}\nreason = "r"\n`;
  expect(parse(show + follows('" show "')).triggers.map((trigger) => trigger.when)).toEqual([
    { kind: "at", weekdays: [6], minute: 1200 },
    { kind: "follows", trigger: "show" },
  ]);
  expect(parse(follows('"show"') + show).problems).toEqual([]);
  expect(parse('[show]\nwhen = "dream_done"\nreason = "r"\n' + follows('"show"'))).toMatchObject({ triggers: [{ name: "show" }, { name: "recap" }], problems: [] });
  expect(parse('[show]\nwhen = "user_quiet"\nafter = "8h"\nreason = "r"\n' + follows('"show"'))).toMatchObject({ triggers: [{ name: "show" }, { name: "recap" }], problems: [] });
  expect(parse(show + follows("7"))).toMatchObject({ problems: ["`recap` isn't running: `follows` must be text in quotes"] });
  expect(parse(show + follows('"recap"')).problems).toEqual(["`recap` isn't running: it can't follow itself"]);
  expect(parse(show + follows('"encore"')).problems).toEqual(["`recap` isn't running: it follows `encore`, which isn't a running trigger in this file"]);
  expect(parse('[show]\nat = "Sat 25:00"\nreason = "r"\n' + follows('"show"'))).toEqual({
    triggers: [],
    problems: [`\`show\` isn't running: ${AT_HELP}`, "`recap` isn't running: it follows `show`, which isn't a running trigger in this file"],
  });
  expect(parse('[show]\nwhen = "user_back"\nafter = "8h"\nreason = "r"\n' + follows('"show"'))).toMatchObject({
    triggers: [{ name: "show" }],
    problems: ["`recap` isn't running: it follows `show`, which fires as you start answering, so nothing can follow it"],
  });
});

test("triggers that follow each other in a ring are all refused, and so is anything that followed one of them", () => {
  const link = (name: string, leader: string): string => `[${name}]\nfollows = "${leader}"\nreason = "r"\n`;
  const ring = (name: string, leader: string): string => `\`${name}\` isn't running: it follows \`${leader}\`, which ends up following it, so each would set the other off forever`;
  expect(parse(link("a", "b") + link("b", "a"))).toEqual({ triggers: [], problems: [ring("a", "b"), ring("b", "a")] });
  expect(parse(link("a", "b") + link("b", "c") + link("c", "a"))).toEqual({ triggers: [], problems: [ring("a", "b"), ring("b", "c"), ring("c", "a")] });
  expect(parse(link("a", "b") + link("b", "c") + link("c", "d") + link("d", "e") + '[e]\nevery = "1h"\nreason = "r"\n').problems).toEqual([]);
  expect(parse(link("a", "b") + link("b", "c") + link("c", "d") + link("d", "e")).problems).toEqual([
    "`d` isn't running: it follows `e`, which isn't a running trigger in this file",
    "`c` isn't running: it follows `d`, which isn't a running trigger in this file",
    "`b` isn't running: it follows `c`, which isn't a running trigger in this file",
    "`a` isn't running: it follows `b`, which isn't a running trigger in this file",
  ]);
  expect(parse(link("d", "a") + link("a", "b") + link("b", "a") + '[e]\nevery = "1h"\nreason = "r"\n' + link("f", "e") + link("g", "f"))).toEqual({
    triggers: [
      { name: "e", when: { kind: "every", everyMs: HOUR }, wakes: true, reason: "r", check: undefined, cooldownMs: DEFAULT_COOLDOWN, between: undefined },
      { name: "f", when: { kind: "follows", trigger: "e" }, wakes: true, reason: "r", check: undefined, cooldownMs: DEFAULT_COOLDOWN, between: undefined },
      { name: "g", when: { kind: "follows", trigger: "f" }, wakes: true, reason: "r", check: undefined, cooldownMs: DEFAULT_COOLDOWN, between: undefined },
    ],
    problems: [ring("a", "b"), ring("b", "a"), "`d` isn't running: it follows `a`, which isn't a running trigger in this file"],
  });
});

test("[triggers] is read under its own name, off unless turned on, and a check time limit of zero is refused", async () => {
  const root = await mkdtemp(testTmp("shore-triggers-config-"));
  const read = (): (boolean | number | string[])[] => {
    const triggers = loadConfig(join(root, "config.toml"), { env: { SHORE_CONFIG_DIR: root }, onWarn: () => {} }).app.behavior.autonomy.triggers;
    return [triggers.enabled, Number(triggers.wake_cooldown.asSecs()), Number(triggers.check_time_limit.asSecs()), triggers.off];
  };
  await writeFile(join(root, "config.toml"), '[chat]\ndisplay_name = "eve"\n');
  expect(read()).toEqual([false, 3600, 60, []]);

  await writeFile(join(root, "config.toml"), '[triggers]\nenabled = true\nwake_cooldown = "2h"\ncheck_time_limit = "10s"\noff = ["tide-table"]\n');
  expect(read()).toEqual([true, 7200, 10, ["tide-table"]]);

  await writeFile(join(root, "config.toml"), '[triggers]\ncheck_time_limit = "0s"\n');
  expect(read).toThrow("triggers.check_time_limit must be greater than zero");
});

test("each [triggers] setting is described in the config schema", () => {
  const described = configSchema({ instancesAt: () => [] }).filter((entry) => entry.key.startsWith("triggers.")).map((entry) => [entry.key, (entry.description ?? "").split(" ").slice(0, 4).join(" ")]);
  expect(described).toEqual([
    ["triggers.check_time_limit", "Longest a trigger's check"],
    ["triggers.enabled", "Run the triggers the"],
    ["triggers.off", "Names of triggers that"],
    ["triggers.wake_cooldown", "Least time between two"],
  ]);
});

test("`on` is one local date and time, and a date that doesn't exist is refused", () => {
  const help = '`t` isn\'t running: `on` must be a local date and 24-hour time, like "2026-11-12 00:00"';
  expect(whenOf('on = "2026-11-12 00:00"')).toEqual({ kind: "once", local: Date.UTC(2026, 10, 12) });
  expect(whenOf('on = " 2026-02-28T23:59 "')).toEqual({ kind: "once", local: Date.UTC(2026, 1, 28, 23, 59) });
  expect(whenOf('on = "2028-02-29 12:30"')).toEqual({ kind: "once", local: Date.UTC(2028, 1, 29, 12, 30) });
  for (const wrong of ['"2026-02-29 12:00"', '"2026-13-01 12:00"', '"2026-11-31 12:00"', '"2026-11-12 24:00"', '"2026-11-12 12:60"', '"2026-11-12"', '"12 Nov 2026 00:00"', '"2026-11-12 00:00:00"', "20261112", '""']) {
    expect(whenOf(`on = ${wrong}`), wrong).toBe(help);
  }
  expect(whenOf('on = "2026-11-12 00:00"\nevery = "1h"')).toBe("`t` isn't running: it needs exactly one of `every`, `at`, `on`, `when` or `follows` to say when it fires");
});

test("a one-off is due at its time in the local zone, and never again once that time is behind the last look", () => {
  const once = { kind: "once", local: Date.UTC(2026, 10, 12) } as const;
  expect(scheduledAt(once, Date.UTC(2026, 10, 1), "UTC")).toBe(Date.UTC(2026, 10, 12));
  expect(scheduledAt(once, Date.UTC(2026, 10, 12) - 1, "UTC")).toBe(Date.UTC(2026, 10, 12));
  expect(scheduledAt(once, Date.UTC(2026, 10, 12), "UTC")).toBeUndefined();
  expect(scheduledAt(once, Date.UTC(2026, 10, 13), "UTC")).toBeUndefined();
  expect(scheduledAt(once, Date.UTC(2026, 10, 1), "Australia/Sydney")).toBe(Date.UTC(2026, 10, 11, 13));
});
