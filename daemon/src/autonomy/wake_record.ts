import { formatWallClock } from "../engine/prompt.ts";
import { shoreLog } from "../log.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { BackgroundLoopResult, LoopRound } from "./background_loop.ts";
import { spanPhrase } from "./wake_shape.ts";

export const LAST_WORDS_CHARS = 1500;

export function cutLastWords(text: string): string {
  const chars = Array.from(text);
  return chars.length > LAST_WORDS_CHARS ? `${chars.slice(0, LAST_WORDS_CHARS).join("")}… [cut]` : text;
}

export type WakeStopReason = "time" | "rounds" | "interrupted";

export interface WakeStop {
  at: number;
  why: WakeStopReason;
  limitMs: number;
  rounds: number;
  sent: boolean;
  last: string;
}

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

export function stopOf(loop: Pick<BackgroundLoopResult, "timedOut" | "stoppedAt">): WakeStopReason | undefined {
  return loop.timedOut === true ? "time" : loop.stoppedAt;
}

export interface WakeEnd {
  startedAt: number;
  endedAt: number;
  limitMs: number;
  loop: Pick<BackgroundLoopResult, "timedOut" | "stoppedAt" | "failedRound" | "rounds">;
  words: WakeWords;
  sent: boolean;
}

export function recordWakeEnd(characterDir: string, thread: string, before: WakeRecord, end: WakeEnd): void {
  const why = stopOf(end.loop);
  if (why !== undefined) {
    const stopped: WakeStop = { at: end.endedAt, why, limitMs: end.limitMs, rounds: end.loop.rounds, sent: end.sent, last: cutLastWords(end.words.last) };
    keepWakeRecord(characterDir, thread, { ...(before.through === undefined ? {} : { through: before.through }), stopped });
    return;
  }
  if (end.loop.failedRound !== undefined) return;
  keepWakeRecord(characterDir, thread, { through: end.startedAt });
}

export function wakeStopNote(stop: WakeStop, userName: string, timeZone: string): string {
  const rounds = stop.rounds === 1 ? "1 round" : `${String(stop.rounds)} rounds`;
  const ran = stop.why === "time" ? `reached its limit of ${spanPhrase(stop.limitMs)} and was stopped` : "used up its rounds of tool use and was stopped";
  const why = stop.why === "interrupted" ? `was stopped for ${userName}'s message` : ran;
  const sent = stop.sent ? `The message it had already written was still sent to ${userName}.` : `Nothing from it was sent to ${userName}.`;
  const last = stop.last === "" ? "" : ` The last thing it wrote: "${stop.last}"`;
  return `[Your last wake here ${why} at ${formatWallClock(stop.at, timeZone)}, after ${rounds}, before it had finished. ${sent}${last} Whatever it had already changed with its tools is still in place.]`;
}
