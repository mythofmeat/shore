import { DEFAULT_WAKE_LIMIT_MS } from "../autonomy/runner.ts";
import { spanPhrase } from "../autonomy/wake_shape.ts";
import { ConfigDuration } from "../config/duration.ts";
import { formatWallClock } from "../engine/prompt.ts";
import { isValidThreadId } from "../engine/threads.ts";
import { hostZone } from "../ledger/zoned.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export interface WakeInThreadRequest {
  thread: string;
  reason: string;
  limitMs: number | undefined;
  overwrite: boolean;
}

export interface WaitingWake {
  readonly from?: string | undefined;
  readonly reason: string;
  readonly at: number;
}

export type WakeHandOff =
  | { kind: "queued"; limitMs: number | undefined; replaced?: WaitingWake | undefined }
  | { kind: "waiting"; waiting: WaitingWake }
  | { kind: "off" }
  | { kind: "no_thread" };

const MINUTE_MS = 60_000;

export function wakeInThreadRequest(input: Record<string, unknown>): WakeInThreadRequest {
  const thread = typeof input["thread"] === "string" ? input["thread"].trim() : "";
  if (!isValidThreadId(thread)) throw new InvalidArgs("thread must be a thread's id, as `list_threads` shows it");
  const reason = typeof input["reason"] === "string" ? input["reason"].trim() : "";
  if (reason === "") throw new InvalidArgs("reason must be a non-empty string");
  const overwrite = input["overwrite"] === true;
  const limit = input["limit"];
  if (limit === undefined || limit === null) return { thread, reason, limitMs: undefined, overwrite };
  const parsed = ConfigDuration.deserialize(limit);
  if ("err" in parsed) throw new InvalidArgs('limit must be a length of time, like "45m" or "2h"');
  if (parsed.ok.asMillis() < MINUTE_MS) throw new InvalidArgs("limit can't be shorter than a minute");
  return { thread, reason, limitMs: parsed.ok.asMillis(), overwrite };
}

function askedFor(waiting: WaitingWake, timeZone: string): string {
  return `asked for from "${waiting.from ?? ""}" at ${formatWallClock(waiting.at, timeZone)}: ${waiting.reason}`;
}

export function handleWakeInThread(
  input: Record<string, unknown>,
  here: string | undefined,
  handOff: ((request: WakeInThreadRequest) => WakeHandOff) | undefined,
  userName: string,
  timeZone: string = hostZone(),
): string {
  if (handOff === undefined) throw new ToolIoError("a wake can't be handed on from here");
  const request = wakeInThreadRequest(input);
  if (request.thread === here) throw new ToolIoError(`you are in "${request.thread}" now, so there is nothing to hand over`);
  const outcome = handOff(request);
  if (outcome.kind === "off") throw new ToolIoError(`${userName} has your own time switched off, so nothing would wake you`);
  if (outcome.kind === "no_thread") throw new ToolIoError(`you have no thread "${request.thread}" to be woken in; \`list_threads\` shows the ones you have`);
  if (outcome.kind === "waiting") {
    throw new ToolIoError(
      `you already have a wake waiting in "${request.thread}", ${askedFor(outcome.waiting, timeZone)}\nNothing was changed. To put this one in its place, call again with \`overwrite\` set to true.`,
    );
  }
  const replaced = outcome.replaced === undefined ? "" : `\nThis takes the place of the wake you had waiting there, ${askedFor(outcome.replaced, timeZone)}`;
  return `Shore will wake you in "${request.thread}" for up to ${spanPhrase(outcome.limitMs ?? DEFAULT_WAKE_LIMIT_MS)}, once this turn is over and ${userName} has been quiet there for 10 minutes.${replaced}`;
}
