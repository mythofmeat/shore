import { DEFAULT_WAKE_LIMIT_MS, WAKE_QUIET_MS } from "../autonomy/runner.ts";
import { localDateTime } from "../autonomy/triggers.ts";
import { spanPhrase } from "../autonomy/wake_shape.ts";
import { ConfigDuration } from "../config/duration.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { isValidThreadId } from "../engine/threads.ts";
import { asNaive, hostZone, resolveInZone } from "../ledger/zoned.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export interface WakeInThreadRequest {
  thread: string;
  reason: string;
  limitMs: number | undefined;
  overwrite: boolean;
  startsAt: number | undefined;
}

export interface WaitingWake {
  readonly from?: string | undefined;
  readonly reason: string;
  readonly at: number;
  readonly startsAt?: number | undefined;
}

export type WakeHandOff =
  | { kind: "queued"; limitMs: number | undefined; replaced?: WaitingWake | undefined }
  | { kind: "waiting"; waiting: WaitingWake }
  | { kind: "off" }
  | { kind: "no_thread" }
  | { kind: "wakes_thread" };

const MINUTE_MS = 60_000;

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i;

const LENGTH = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(?:(m)(?:ins?|inutes?)?|(h)(?:rs?|ours?)?|(d)(?:ays?)?)$/i;

const WHEN_FORMS = 'when must be a local date and time, like "2026-11-19 13:00" or "2026-11-19 1:00PM", or a length of time from now, like "in 5 hours" or "90m"';

function hour24(hour: string, meridiem: string | undefined): string {
  if (meridiem === undefined) return hour.padStart(2, "0");
  const twelve = Number(hour);
  if (twelve < 1 || twelve > 12) return "";
  return String((twelve % 12) + (/^p/i.test(meridiem) ? 12 : 0)).padStart(2, "0");
}

function atDateTime(text: string, timeZone: string): number | undefined {
  const written = text.replace(DATE_TIME, (_whole, date: string, hour: string, minute: string, meridiem: string | undefined) => `${date} ${hour24(hour, meridiem)}:${minute}`);
  const local = localDateTime(written);
  return local === undefined ? undefined : resolveInZone(asNaive(local), timeZone);
}

function afterLength(text: string, now: number): number | undefined {
  const match = LENGTH.exec(text);
  if (match === null) return undefined;
  const [, amount, minutes, hours, days] = match;
  const parsed = ConfigDuration.parse(`${amount ?? ""}${(minutes ?? hours ?? days ?? "").toLowerCase()}`);
  return "err" in parsed ? undefined : now + parsed.ok.asMillis();
}

export function wakeStartsAt(value: unknown, now: number, timeZone: string): number {
  const text = typeof value === "string" ? value.trim() : "";
  const at = atDateTime(text, timeZone) ?? afterLength(text, now);
  if (at === undefined) throw new InvalidArgs(WHEN_FORMS);
  if (at <= now) throw new InvalidArgs(`when must be a time still to come, and ${formatWallClock(at, timeZone)} is not: it is ${formatWallClock(now, timeZone)} now`);
  return at;
}

export function wakeInThreadRequest(input: Record<string, unknown>, now: number, timeZone: string): WakeInThreadRequest {
  const thread = typeof input["thread"] === "string" ? input["thread"].trim() : "";
  if (!isValidThreadId(thread)) throw new InvalidArgs("thread must be a thread's id, as `threads` lists it");
  const reason = typeof input["reason"] === "string" ? input["reason"].trim() : "";
  if (reason === "") throw new InvalidArgs("reason must be a non-empty string");
  const overwrite = input["overwrite"] === true;
  const when = input["when"];
  const startsAt = when === undefined || when === null ? undefined : wakeStartsAt(when, now, timeZone);
  const limit = input["limit"];
  if (limit === undefined || limit === null) return { thread, reason, limitMs: undefined, overwrite, startsAt };
  const parsed = ConfigDuration.deserialize(limit);
  if ("err" in parsed) throw new InvalidArgs('limit must be a length of time, like "45m" or "2h"');
  if (parsed.ok.asMillis() < MINUTE_MS) throw new InvalidArgs("limit can't be shorter than a minute");
  return { thread, reason, limitMs: parsed.ok.asMillis(), overwrite, startsAt };
}

function askedFor(waiting: WaitingWake, timeZone: string): string {
  const starts = waiting.startsAt === undefined ? "" : ` to start at ${formatWallClock(waiting.startsAt, timeZone)}`;
  return `asked for from "${waiting.from ?? ""}" at ${formatWallClock(waiting.at, timeZone)}${starts}: ${waiting.reason}`;
}

function whenItStarts(startsAt: number | undefined, userName: string, timeZone: string): string {
  const quiet = spanPhrase(WAKE_QUIET_MS);
  return startsAt === undefined
    ? `, once this turn is over and ${userName} has been quiet there for ${quiet}.`
    : ` at ${formatWallClock(startsAt, timeZone)}. If ${userName} has written there in the ${quiet} before, it waits until they have been quiet there that long.`;
}

export function handleWakeInThread(
  input: Record<string, unknown>,
  here: string | undefined,
  handOff: ((request: WakeInThreadRequest) => WakeHandOff) | undefined,
  userName: string,
  timeZone: string = hostZone(),
  now: number = Date.now(),
): string {
  if (handOff === undefined) throw new ToolIoError("a wake can't be handed on from here");
  const request = wakeInThreadRequest(input, now, timeZone);
  if (request.thread === here && request.startsAt === undefined) {
    throw new ToolIoError(`you are in "${request.thread}" now, so there is nothing to hand over. To be woken here later, give \`when\`.`);
  }
  const outcome = handOff(request);
  if (outcome.kind === "off") throw new ToolIoError(`${userName} has your triggers switched off, so nothing would wake you`);
  if (outcome.kind === "no_thread") throw new ToolIoError(`you have no thread "${request.thread}" to be woken in; \`threads\` lists the ones you have`);
  if (outcome.kind === "wakes_thread") throw new ToolIoError(`"${request.thread}" is where Shore keeps the working from your wakes, so no wake runs there`);
  if (outcome.kind === "waiting") {
    throw new ToolIoError(
      `you already have a wake waiting in "${request.thread}", ${askedFor(outcome.waiting, timeZone)}\nNothing was changed. To put this one in its place, call again with \`overwrite\` set to true.`,
    );
  }
  const replaced = outcome.replaced === undefined ? "" : `\nThis takes the place of the wake you had waiting there, ${askedFor(outcome.replaced, timeZone)}`;
  return `Shore will wake you in "${request.thread}" for up to ${spanPhrase(outcome.limitMs ?? DEFAULT_WAKE_LIMIT_MS)}${whenItStarts(request.startsAt, userName, timeZone)}${replaced}`;
}
