import { DEFAULT_WAKE_LIMIT_MS, WAKE_QUIET_MS } from "../autonomy/runner.ts";
import { localDateTime } from "../autonomy/triggers.ts";
import { spanPhrase } from "../autonomy/wake_shape.ts";
import { ConfigDuration } from "../config/duration.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { isValidThreadId } from "../engine/threads.ts";
import { asNaive, hostZone, resolveInZone } from "../ledger/zoned.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";
import type { Texts } from "../texts/texts.ts";

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

export interface WakeAsking {
  readonly handOff?: ((request: WakeInThreadRequest) => WakeHandOff) | undefined;
  readonly callOff?: ((thread: string) => WaitingWake | undefined) | undefined;
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
  const at = "err" in parsed ? Number.NaN : now + parsed.ok.asMillis();
  return Number.isNaN(new Date(at).getTime()) ? undefined : at;
}

export function wakeStartsAt(texts: Texts, value: unknown, now: number, timeZone: string): number {
  const text = typeof value === "string" ? value.trim() : "";
  const at = atDateTime(text, timeZone) ?? afterLength(text, now);
  if (at === undefined) throw new InvalidArgs(texts.always("wake_when_form"));
  if (at <= now) throw new InvalidArgs(texts.always("wake_when_past", { when: formatWallClock(texts, at, timeZone), now: formatWallClock(texts, now, timeZone) }));
  return at;
}

function threadIn(texts: Texts, input: Record<string, unknown>): string {
  const thread = typeof input["thread"] === "string" ? input["thread"].trim() : "";
  if (!isValidThreadId(thread)) throw new InvalidArgs(texts.always("arg_thread_id"));
  return thread;
}

export function wakeInThreadRequest(texts: Texts, input: Record<string, unknown>, now: number, timeZone: string): WakeInThreadRequest {
  const thread = threadIn(texts, input);
  const reason = typeof input["reason"] === "string" ? input["reason"].trim() : "";
  if (reason === "") throw new InvalidArgs(texts.always("wake_no_reason"));
  const overwrite = input["overwrite"] === true;
  const when = input["when"];
  const startsAt = when === undefined || when === null ? undefined : wakeStartsAt(texts, when, now, timeZone);
  const limit = input["limit"];
  if (limit === undefined || limit === null) return { thread, reason, limitMs: undefined, overwrite, startsAt };
  const parsed = ConfigDuration.deserialize(limit);
  if ("err" in parsed) throw new InvalidArgs(texts.always("wake_limit_form"));
  if (parsed.ok.asMillis() < MINUTE_MS) throw new InvalidArgs(texts.always("wake_limit_short"));
  return { thread, reason, limitMs: parsed.ok.asMillis(), overwrite, startsAt };
}

function askedFor(texts: Texts, waiting: WaitingWake, timeZone: string): string | undefined {
  return texts.render("wake_asked_for", {
    from: waiting.from ?? "",
    at: formatWallClock(texts, waiting.at, timeZone),
    starts: waiting.startsAt === undefined ? undefined : formatWallClock(texts, waiting.startsAt, timeZone),
    reason: waiting.reason,
  });
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function callOffWake(texts: Texts, input: Record<string, unknown>, callOff: WakeAsking["callOff"], timeZone: string): string {
  if (callOff === undefined) throw new ToolIoError(texts.always("wake_call_off_unavailable"));
  const thread = threadIn(texts, input);
  if (input["overwrite"] === true || given(input["when"])) throw new InvalidArgs(texts.always("wake_call_off_alone"));
  const waiting = callOff(thread);
  if (waiting === undefined) throw new ToolIoError(texts.always("wake_nothing_to_call_off", { thread }));
  return texts.render("wake_called_off", { thread, asked: askedFor(texts, waiting, timeZone) }) ?? "";
}

export function handleWakeInThread(
  texts: Texts,
  input: Record<string, unknown>,
  here: string | undefined,
  wakes: WakeAsking,
  userName: string,
  timeZone: string = hostZone(),
  now: number = Date.now(),
): string {
  if (input["call_off"] === true) return callOffWake(texts, input, wakes.callOff, timeZone);
  const handOff = wakes.handOff;
  if (handOff === undefined) throw new ToolIoError(texts.always("wake_unavailable"));
  const request = wakeInThreadRequest(texts, input, now, timeZone);
  const thread = request.thread;
  if (thread === here && request.startsAt === undefined) throw new ToolIoError(texts.always("wake_here", { thread }));
  const outcome = handOff(request);
  if (outcome.kind === "off") throw new ToolIoError(texts.always("wake_triggers_off", { user: userName }));
  if (outcome.kind === "no_thread") throw new ToolIoError(texts.always("wake_no_thread", { thread }));
  if (outcome.kind === "wakes_thread") throw new ToolIoError(texts.always("wake_in_wakes", { thread }));
  if (outcome.kind === "waiting") throw new ToolIoError(texts.always("wake_waiting", { thread, asked: askedFor(texts, outcome.waiting, timeZone) }));
  return texts.render("wake_queued", {
    thread,
    limit: spanPhrase(texts, outcome.limitMs ?? DEFAULT_WAKE_LIMIT_MS),
    at: request.startsAt === undefined ? undefined : formatWallClock(texts, request.startsAt, timeZone),
    user: userName,
    quiet: spanPhrase(texts, WAKE_QUIET_MS),
    replaced: outcome.replaced === undefined ? undefined : askedFor(texts, outcome.replaced, timeZone),
  }) ?? "";
}
