import { HEARTBEAT_TIME_LIMIT_MS } from "../autonomy/heartbeat_loop.ts";
import { spanPhrase } from "../autonomy/heartbeat_shape.ts";
import { ConfigDuration } from "../config/duration.ts";
import { isValidThreadId } from "../engine/threads.ts";
import { InvalidArgs, ToolIoError } from "./errors.ts";

export interface WakeInThreadRequest {
  thread: string;
  reason: string;
  limitMs: number | undefined;
}

export type WakeHandOff =
  | { kind: "queued"; limitMs: number | undefined }
  | { kind: "off" }
  | { kind: "no_thread" };

const MINUTE_MS = 60_000;

export function wakeInThreadRequest(input: Record<string, unknown>): WakeInThreadRequest {
  const thread = typeof input["thread"] === "string" ? input["thread"].trim() : "";
  if (!isValidThreadId(thread)) throw new InvalidArgs("thread must be a thread's id, as `list_threads` shows it");
  const reason = typeof input["reason"] === "string" ? input["reason"].trim() : "";
  if (reason === "") throw new InvalidArgs("reason must be a non-empty string");
  const limit = input["limit"];
  if (limit === undefined || limit === null) return { thread, reason, limitMs: undefined };
  const parsed = ConfigDuration.deserialize(limit);
  if ("err" in parsed) throw new InvalidArgs('limit must be a length of time, like "45m" or "2h"');
  if (parsed.ok.asMillis() < MINUTE_MS) throw new InvalidArgs("limit can't be shorter than a minute");
  return { thread, reason, limitMs: parsed.ok.asMillis() };
}

export function handleWakeInThread(
  input: Record<string, unknown>,
  here: string | undefined,
  handOff: ((request: WakeInThreadRequest) => WakeHandOff) | undefined,
  userName: string,
): string {
  if (handOff === undefined) throw new ToolIoError("a wake can't be handed on from here");
  const request = wakeInThreadRequest(input);
  if (request.thread === here) throw new ToolIoError(`you are in "${request.thread}" now, so there is nothing to hand over`);
  const outcome = handOff(request);
  if (outcome.kind === "off") throw new ToolIoError("heartbeats are not running for this character");
  if (outcome.kind === "no_thread") throw new ToolIoError(`you have no thread "${request.thread}" to be woken in; \`list_threads\` shows the ones you have`);
  return `Shore will wake you in "${request.thread}" for up to ${spanPhrase(outcome.limitMs ?? HEARTBEAT_TIME_LIMIT_MS)}, once this turn is over and ${userName} has been quiet there for 10 minutes.`;
}
