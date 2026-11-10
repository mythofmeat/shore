import { parseDayWindow } from "../config/app.ts";
import { ConfigDuration } from "../config/duration.ts";
import { asNaive, DAY_MS, naiveInZone, resolveInZone } from "../ledger/zoned.ts";
import { inDayWindow, type DayWindow } from "./tick.ts";

export const TRIGGERS_FILE = "TRIGGERS.toml";

const TRIGGER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const SETTINGS = ["every", "at", "when", "after", "check", "wake", "reason", "cooldown", "between"];

const EVENTS = ["user_back", "user_quiet", "wake_done", "dream_done"] as const;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const AT = /^(?:(.*\S)\s+)?(\d{1,2}):(\d{2})$/;

const MINUTE_MS = 60_000;

export type TriggerEvent = (typeof EVENTS)[number];

export type TriggerWhen =
  | { kind: "every"; everyMs: number }
  | { kind: "at"; weekdays: readonly number[]; minute: number }
  | { kind: "event"; event: TriggerEvent; afterMs: number };

export interface Trigger {
  name: string;
  when: TriggerWhen;
  wakes: boolean;
  reason: string | undefined;
  check: string | undefined;
  cooldownMs: number;
  between: DayWindow | undefined;
}

export interface ParsedTriggers {
  triggers: Trigger[];
  problems: string[];
}

class Problem extends Error {}

function duration(value: unknown, setting: string): number {
  const parsed = ConfigDuration.deserialize(value);
  if ("err" in parsed) throw new Problem(`\`${setting}\` must be a length of time in quotes, like "90m" or "6h"`);
  return parsed.ok.asMillis();
}

function text(value: unknown, setting: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Problem(`\`${setting}\` must be text in quotes`);
  return value.trim();
}

function atTime(value: unknown): TriggerWhen {
  const wrong = new Problem('`at` must be a 24-hour local time, with the days it applies to in front if not every day, like "20:00" or "Sat 20:00" or "Mon,Thu 09:30"');
  const match = typeof value === "string" ? AT.exec(value.trim()) : null;
  if (match === null) throw wrong;
  const [, days, hour, minute] = match;
  if (Number(hour) > 23 || Number(minute) > 59) throw wrong;
  const named = (days ?? "").split(/[\s,]+/).filter((day) => day !== "").map((day) => WEEKDAYS.indexOf(day.slice(0, 3).toLowerCase()));
  if (named.includes(-1)) throw wrong;
  const week = WEEKDAYS.map((_day, weekday) => weekday);
  return { kind: "at", weekdays: named.length === 0 ? week : week.filter((weekday) => named.includes(weekday)), minute: Number(hour) * 60 + Number(minute) };
}

function whenOf(raw: Record<string, unknown>): TriggerWhen {
  const given = ["every", "at", "when"].filter((setting) => raw[setting] !== undefined);
  if (given.length !== 1) throw new Problem("it needs exactly one of `every`, `at` or `when` to say when it fires");
  if (raw["when"] === undefined && raw["after"] !== undefined) throw new Problem("`after` only goes with `when`");
  if (raw["every"] !== undefined) {
    const everyMs = duration(raw["every"], "every");
    if (everyMs < MINUTE_MS) throw new Problem("`every` can't be shorter than a minute");
    return { kind: "every", everyMs };
  }
  if (raw["at"] !== undefined) return atTime(raw["at"]);
  const event = EVENTS.find((each) => each === raw["when"]);
  if (event === undefined) throw new Problem(`\`when\` must be one of ${EVENTS.map((each) => `"${each}"`).join(", ")}`);
  const timed = event === "user_back" || event === "user_quiet";
  if (timed !== (raw["after"] !== undefined)) {
    throw new Problem(timed ? `\`when = "${event}"\` needs \`after\`, the least time away that counts` : `\`when = "${event}"\` takes no \`after\``);
  }
  return { kind: "event", event, afterMs: timed ? duration(raw["after"], "after") : 0 };
}

function trigger(name: string, raw: unknown, defaultCooldownMs: number): Trigger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Problem(`write it as \`[${name}]\` with its settings on the lines under it`);
  if (!TRIGGER_NAME.test(name)) throw new Problem("a trigger's name is letters, digits, dashes and underscores, starting with a letter or digit, at most 64 characters");
  const settings = raw as Record<string, unknown>;
  const unknown = Object.keys(settings).filter((setting) => !SETTINGS.includes(setting));
  const nested = unknown.find((setting) => typeof settings[setting] === "object" && !Array.isArray(settings[setting]));
  if (nested !== undefined) throw new Problem(`a trigger's name can't have a dot in it, so \`[${name}.${nested}]\` could be \`[${name}-${nested}]\``);
  if (unknown.length > 0) throw new Problem(`${unknown.map((setting) => `\`${setting}\``).join(", ")} isn't a trigger setting; the settings are ${SETTINGS.join(", ")}`);
  const when = whenOf(settings);
  const wakes = settings["wake"] ?? true;
  if (typeof wakes !== "boolean") throw new Problem("`wake` must be true or false, without quotes");
  const reason = settings["reason"] === undefined ? undefined : text(settings["reason"], "reason");
  const check = settings["check"] === undefined ? undefined : text(settings["check"], "check");
  if (reason === undefined && check === undefined) throw new Problem("it needs a `reason` to show you when it fires, or a `check` whose output is the reason");
  const between = settings["between"] === undefined ? undefined : parseDayWindow(typeof settings["between"] === "string" ? settings["between"] : "");
  if (settings["between"] !== undefined && between === undefined) throw new Problem('`between` must be a local time range like "08:00-23:00"');
  const cooldownMs = settings["cooldown"] === undefined ? (wakes ? defaultCooldownMs : 0) : duration(settings["cooldown"], "cooldown");
  return { name, when, wakes, reason, check, cooldownMs, between };
}

export function parseTriggers(content: string, defaultCooldownMs: number): ParsedTriggers {
  let table: Record<string, unknown>;
  try {
    table = Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (error) {
    return { triggers: [], problems: [`${TRIGGERS_FILE} can't be read as TOML, so none of its triggers are running: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed: ParsedTriggers = { triggers: [], problems: [] };
  for (const [name, raw] of Object.entries(table)) {
    try {
      parsed.triggers.push(trigger(name, raw, defaultCooldownMs));
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      parsed.problems.push(`\`${name}\` isn't running: ${error.message}`);
    }
  }
  return parsed;
}

export function nextAt(when: Extract<TriggerWhen, { kind: "at" }>, after: number, timeZone: string): number {
  const local = naiveInZone(after, timeZone);
  const midnight = local - (local % DAY_MS);
  const today = new Date(midnight).getUTCDay();
  const coming = when.weekdays.flatMap((weekday) => {
    const ahead = (weekday - today + 7) % 7;
    return [ahead, ahead + 7].map((days) => resolveInZone(asNaive(midnight + days * DAY_MS + when.minute * MINUTE_MS), timeZone));
  });
  return Math.min(...coming.filter((instant) => instant > after));
}

export function scheduledAt(when: TriggerWhen, since: number, timeZone: string): number | undefined {
  if (when.kind === "every") return since + when.everyMs;
  return when.kind === "at" ? nextAt(when, since, timeZone) : undefined;
}

export function allowedNow(rule: Pick<Trigger, "cooldownMs" | "between">, lastFiredAt: number | undefined, now: number, timeZone: string): boolean {
  if (lastFiredAt !== undefined && now - lastFiredAt < rule.cooldownMs) return false;
  if (rule.between === undefined) return true;
  const local = naiveInZone(now, timeZone);
  return inDayWindow(rule.between, Math.floor((local % DAY_MS) / MINUTE_MS));
}
