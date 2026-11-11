import { parseDayWindow } from "../config/app.ts";
import { ConfigDuration } from "../config/duration.ts";
import { isValidThreadId } from "../engine/threads.ts";
import { asNaive, DAY_MS, naiveInZone, resolveInZone } from "../ledger/zoned.ts";
import { inDayWindow, type DayWindow } from "./tick.ts";

export const TRIGGERS_FILE = "TRIGGERS.toml";

const TRIGGER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const SETTINGS = ["every", "at", "on", "when", "after", "follows", "check", "wake", "thread", "limit", "reason", "cooldown", "between"];

const EVENTS = ["user_back", "user_quiet", "dream_done", "status_changed"] as const;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const AT = /^(?:(.*\S)\s+)?(\d{1,2}):(\d{2})$/;

const ON = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;

const MINUTE_MS = 60_000;

export type TriggerEvent = (typeof EVENTS)[number];

export type TriggerWhen =
  | { kind: "every"; everyMs: number }
  | { kind: "at"; weekdays: readonly number[]; minute: number }
  | { kind: "once"; local: number }
  | { kind: "event"; event: TriggerEvent; afterMs: number }
  | { kind: "follows"; trigger: string };

export interface Trigger {
  name: string;
  when: TriggerWhen;
  wakes: boolean;
  reason: string | undefined;
  check: string | undefined;
  cooldownMs: number;
  between: DayWindow | undefined;
  thread: string | undefined;
  limitMs: number | undefined;
}

export interface ParsedTriggers {
  triggers: Trigger[];
  problems: string[];
}

function duration(value: unknown, setting: string): number {
  const parsed = ConfigDuration.deserialize(value);
  if ("err" in parsed) throw new Error(`\`${setting}\` must be a length of time in quotes, like "90m" or "6h"`);
  return parsed.ok.asMillis();
}

function text(value: unknown, setting: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`\`${setting}\` must be text in quotes`);
  return value.trim();
}

function atTime(value: unknown): TriggerWhen {
  const wrong = new Error('`at` must be a 24-hour local time, with the days it applies to in front if not every day, like "20:00" or "Sat 20:00" or "Mon,Thu 09:30"');
  const match = typeof value === "string" ? AT.exec(value.trim()) : null;
  if (match === null) throw wrong;
  const [, days, hour, minute] = match;
  if (Number(hour) > 23 || Number(minute) > 59) throw wrong;
  const named = (days ?? "").split(/[\s,]+/).filter((day) => day !== "").map((day) => WEEKDAYS.indexOf(day.slice(0, 3).toLowerCase()));
  if (named.includes(-1)) throw wrong;
  const week = WEEKDAYS.map((_day, weekday) => weekday);
  return { kind: "at", weekdays: named.length === 0 ? week : week.filter((weekday) => named.includes(weekday)), minute: Number(hour) * 60 + Number(minute) };
}

function onDate(value: unknown): TriggerWhen {
  const match = typeof value === "string" ? ON.exec(value.trim()) : null;
  const written = `${match?.[1] ?? ""}T${match?.[2] ?? ""}`;
  const local = Date.parse(`${written}:00Z`);
  if (Number.isNaN(local) || new Date(local).toISOString().slice(0, 16) !== written) {
    throw new Error('`on` must be a local date and 24-hour time, like "2026-11-12 00:00"');
  }
  return { kind: "once", local };
}

function whenOf(raw: Record<string, unknown>): TriggerWhen {
  const given = ["every", "at", "on", "when", "follows"].filter((setting) => raw[setting] !== undefined);
  if (given.length !== 1) throw new Error("it needs exactly one of `every`, `at`, `on`, `when` or `follows` to say when it fires");
  if (raw["when"] === undefined && raw["after"] !== undefined) throw new Error("`after` only goes with `when`");
  if (raw["every"] !== undefined) {
    const everyMs = duration(raw["every"], "every");
    if (everyMs < MINUTE_MS) throw new Error("`every` can't be shorter than a minute");
    return { kind: "every", everyMs };
  }
  if (raw["at"] !== undefined) return atTime(raw["at"]);
  if (raw["on"] !== undefined) return onDate(raw["on"]);
  if (raw["follows"] !== undefined) return { kind: "follows", trigger: text(raw["follows"], "follows") };
  const event = EVENTS.find((each) => each === raw["when"]);
  if (event === undefined) throw new Error(`\`when\` must be one of ${EVENTS.map((each) => `"${each}"`).join(", ")}`);
  const timed = event === "user_back" || event === "user_quiet";
  if (timed !== (raw["after"] !== undefined)) {
    throw new Error(timed ? `\`when = "${event}"\` needs \`after\`, the least time away that counts` : `\`when = "${event}"\` takes no \`after\``);
  }
  return { kind: "event", event, afterMs: timed ? duration(raw["after"], "after") : 0 };
}

function trigger(name: string, raw: unknown, defaultCooldownMs: number): Trigger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`write it as \`[${name}]\` with its settings on the lines under it`);
  if (!TRIGGER_NAME.test(name)) throw new Error("a trigger's name is letters, digits, dashes and underscores, starting with a letter or digit, at most 64 characters");
  const settings = raw as Record<string, unknown>;
  const unknown = Object.keys(settings).filter((setting) => !SETTINGS.includes(setting));
  const nested = unknown.find((setting) => typeof settings[setting] === "object" && !Array.isArray(settings[setting]));
  if (nested !== undefined) throw new Error(`a trigger's name can't have a dot in it, so \`[${name}.${nested}]\` could be \`[${name}-${nested}]\``);
  if (unknown.length > 0) throw new Error(`${unknown.map((setting) => `\`${setting}\``).join(", ")} isn't a trigger setting; the settings are ${SETTINGS.join(", ")}`);
  const when = whenOf(settings);
  const arrives = when.kind === "event" && when.event === "user_back";
  if (arrives && settings["wake"] !== undefined) {
    throw new Error('`when = "user_back"` never wakes you, because you are already answering them, and what it says arrives with their message; leave `wake` out');
  }
  const wakes = settings["wake"] ?? !arrives;
  if (typeof wakes !== "boolean") throw new Error("`wake` must be true or false, without quotes");
  const reason = settings["reason"] === undefined ? undefined : text(settings["reason"], "reason");
  const check = settings["check"] === undefined ? undefined : text(settings["check"], "check");
  if (reason === undefined && check === undefined) throw new Error("it needs a `reason` to show you when it fires, or a `check` whose output is the reason");
  const between = settings["between"] === undefined ? undefined : parseDayWindow(typeof settings["between"] === "string" ? settings["between"] : "");
  if (settings["between"] !== undefined && between === undefined) throw new Error('`between` must be a local time range like "08:00-23:00"');
  const cooldownMs = settings["cooldown"] === undefined ? (wakes ? defaultCooldownMs : 0) : duration(settings["cooldown"], "cooldown");
  const thread = settings["thread"] === undefined ? undefined : text(settings["thread"], "thread");
  if (thread !== undefined && !wakes) throw new Error("`thread` is where a wake runs, and this trigger doesn't wake you");
  if (thread !== undefined && !isValidThreadId(thread)) throw new Error(`\`thread\` must be a thread's id, as \`list_threads\` shows it, and ${JSON.stringify(thread)} can't be one`);
  if (settings["limit"] !== undefined && thread === undefined) throw new Error("`limit` is how long a wake in a thread may run, so it only goes with `thread`");
  const limitMs = settings["limit"] === undefined ? undefined : duration(settings["limit"], "limit");
  if (limitMs !== undefined && limitMs < MINUTE_MS) throw new Error("`limit` can't be shorter than a minute");
  return { name, when, wakes, reason, check, cooldownMs, between, thread, limitMs };
}

export function parseTriggers(content: string, defaultCooldownMs: number): ParsedTriggers {
  let table: Record<string, unknown>;
  try {
    table = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (error) {
    return { triggers: [], problems: [`${TRIGGERS_FILE} can't be read as TOML, so none of its triggers are running: ${(error as Error).message}`] };
  }
  const parsed: ParsedTriggers = { triggers: [], problems: [] };
  for (const [name, raw] of Object.entries(table)) {
    try {
      parsed.triggers.push(trigger(name, raw, defaultCooldownMs));
    } catch (error) {
      parsed.problems.push(`\`${name}\` isn't running: ${(error as Error).message}`);
    }
  }
  return parsed.triggers.reduce((settled) => withoutLostFollowers(settled), parsed);
}

function withoutLostFollowers(parsed: ParsedTriggers): ParsedTriggers {
  const lost = parsed.triggers.flatMap((each) => {
    const problem = followProblem(each, parsed.triggers);
    return problem === undefined ? [] : [{ name: each.name, problem }];
  });
  return {
    triggers: parsed.triggers.filter((each) => lost.every((gone) => gone.name !== each.name)),
    problems: [...parsed.problems, ...lost.map((gone) => `\`${gone.name}\` isn't running: ${gone.problem}`)],
  };
}

function followed(follower: Trigger, all: readonly Trigger[]): Trigger | undefined {
  const when = follower.when;
  return when.kind === "follows" ? all.find((other) => other.name === when.trigger) : undefined;
}

function followProblem(follower: Trigger, all: readonly Trigger[]): string | undefined {
  if (follower.when.kind !== "follows") return undefined;
  const leader = followed(follower, all);
  if (leader === follower) return "it can't follow itself";
  if (leader === undefined) return `it follows \`${follower.when.trigger}\`, which isn't a running trigger in this file`;
  if (leader.when.kind === "event" && leader.when.event === "user_back") return `it follows \`${leader.name}\`, which fires as you start answering, so nothing can follow it`;
  const end = all.reduce<Trigger | undefined>((at) => (at === undefined || at === follower ? at : followed(at, all)), leader);
  return end === follower ? `it follows \`${leader.name}\`, which ends up following it, so each would set the other off forever` : undefined;
}

export function nextAt(when: Extract<TriggerWhen, { kind: "at" }>, after: number, timeZone: string): number {
  const local = naiveInZone(after, timeZone);
  const midnight = local - (local % DAY_MS);
  const coming = [...WEEKDAYS.keys(), WEEKDAYS.length]
    .map((daysAhead) => midnight + daysAhead * DAY_MS)
    .filter((day) => when.weekdays.includes(new Date(day).getUTCDay()))
    .map((day) => resolveInZone(asNaive(day + when.minute * MINUTE_MS), timeZone));
  return Math.min(...coming.filter((instant) => instant > after));
}

export function scheduledAt(when: TriggerWhen, since: number, timeZone: string): number | undefined {
  if (when.kind === "every") return since + when.everyMs;
  if (when.kind === "at") return nextAt(when, since, timeZone);
  const once = when.kind === "once" ? resolveInZone(asNaive(when.local), timeZone) : undefined;
  return once !== undefined && once > since ? once : undefined;
}

export function coolingDown(cooldownMs: number, lastFiredAt: number | undefined, now: number): boolean {
  return lastFiredAt !== undefined && now - lastFiredAt < cooldownMs;
}

export function inItsHours(between: DayWindow | undefined, now: number, timeZone: string): boolean {
  if (between === undefined) return true;
  const local = naiveInZone(now, timeZone);
  return inDayWindow(between, Math.floor((local % DAY_MS) / MINUTE_MS));
}
