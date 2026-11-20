import { formatWallClock } from "../engine/prompt.ts";
import { budgetStopIn, describeError } from "../llm/errors.ts";
import { shoreLog } from "../log.ts";
import { truncateSummary } from "../notifications.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { BackgroundLoopResult, LoopRound } from "./background_loop.ts";
import { spanPhrase } from "./wake_shape.ts";

export const LAST_WORDS_CHARS = 1500;

export function cutLastWords(text: string): string {
  const chars = Array.from(text);
  return chars.length > LAST_WORDS_CHARS ? `${chars.slice(0, LAST_WORDS_CHARS).join("")}… [cut]` : text;
}

export type WakeEnding = { why: "time" | "rounds" | "interrupted" } | { why: "failed"; error: string };

export type WakeStop = WakeEnding & {
  at: number;
  limitMs: number;
  rounds: number;
  sent: boolean;
  last: string;
};

export interface WakeRecord {
  through?: number;
  stopped?: WakeStop;
}

function read(characterDir: string, file: string): Record<string, unknown> {
  try {
    return JSON.parse(readCharacterState(characterDir, file) ?? "{}") as Record<string, unknown>;
  } catch (error) {
    shoreLog.error(`shore: could not read ${file} at ${characterDir}: ${String(error)}`);
    return {};
  }
}

function recordFile(thread: string): string {
  return `threads/${thread}/wake.json`;
}

export function keepWakeRecord(characterDir: string, thread: string, record: WakeRecord): void {
  writeCharacterState(characterDir, recordFile(thread), JSON.stringify(record));
}

export function wakeRecord(characterDir: string, thread: string): WakeRecord {
  return read(characterDir, recordFile(thread));
}

export class WakeWords {
  last = "";

  heard(round: LoopRound): void {
    if (round.role !== "assistant") return;
    const text = round.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
    if (text !== "") this.last = text;
  }
}

export function failureText(failure: unknown): string {
  const stop = budgetStopIn(failure);
  return stop === undefined ? truncateSummary(describeError(failure), 200) : stop.summary ?? stop.message;
}

export function stopOf(loop: Pick<BackgroundLoopResult, "timedOut" | "stoppedAt" | "failedRound" | "failure">): WakeEnding | undefined {
  if (loop.timedOut === true) return { why: "time" };
  if (loop.stoppedAt !== undefined) return { why: loop.stoppedAt };
  return loop.failedRound === undefined ? undefined : { why: "failed", error: failureText(loop.failure) };
}

export interface WakeEnd {
  startedAt: number;
  endedAt: number;
  limitMs: number;
  loop: Pick<BackgroundLoopResult, "timedOut" | "stoppedAt" | "failedRound" | "failure" | "rounds">;
  words: WakeWords;
  sent: boolean;
}

export function recordWakeEnd(characterDir: string, thread: string, before: WakeRecord, end: WakeEnd): void {
  const ending = stopOf(end.loop);
  if (ending === undefined) {
    keepWakeRecord(characterDir, thread, { through: end.startedAt });
    return;
  }
  const stopped: WakeStop = { ...ending, at: end.endedAt, limitMs: end.limitMs, rounds: end.loop.rounds, sent: end.sent, last: cutLastWords(end.words.last) };
  keepWakeRecord(characterDir, thread, { ...(before.through === undefined ? {} : { through: before.through }), stopped });
}

export function wakeStopNote(stop: WakeStop, userName: string, timeZone: string): string {
  const rounds = stop.rounds === 1 ? "1 round" : `${String(stop.rounds)} rounds`;
  const why = {
    time: `reached its limit of ${spanPhrase(stop.limitMs)} and was stopped`,
    rounds: "used up its rounds of tool use and was stopped",
    interrupted: `was stopped for ${userName}'s message`,
    failed: "failed",
  }[stop.why];
  const error = stop.why === "failed" ? `, with this error: "${stop.error}"` : "";
  const sent = stop.sent ? `The message it had already written was still sent to ${userName}.` : `Nothing from it was sent to ${userName}.`;
  const last = stop.last === "" ? "" : ` The last thing it wrote: "${stop.last}"`;
  return `[Your last wake here ${why} at ${formatWallClock(stop.at, timeZone)}, after ${rounds}, before it had finished${error}. ${sent}${last} Whatever it had already changed with its tools is still in place.]`;
}
