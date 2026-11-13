import { formatWallClock } from "../engine/prompt.ts";
import type { DiaryNote } from "../engine/types.ts";
import { shoreLog } from "../log.ts";
import { deleteCharacterState, readCharacterState, writeCharacterState } from "../storage/store.ts";
import { cutNote } from "./diary.ts";
import type { BackgroundLoopResult, LoopRound } from "./background_loop.ts";
import { spanPhrase } from "./wake_shape.ts";

const OLD_HOME_THROUGH = "heartbeat_home.json";

const OLD_CUT_OFF = "heartbeat_cut_off.json";

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
  note?: Pick<DiaryNote, "id" | "at" | "text">;
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

function fromBefore(characterDir: string, limitMs: number): WakeRecord {
  const through = Date.parse(String(read(characterDir, OLD_HOME_THROUGH)["through"]));
  const { at, rounds, sent } = read(characterDir, OLD_CUT_OFF) as { at?: number; rounds: number; sent: boolean };
  return {
    ...(Number.isNaN(through) ? {} : { through }),
    ...(at === undefined ? {} : { stopped: { at, why: "time", limitMs, rounds, sent, last: "" } }),
  };
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

export function legacyRecord(characterDir: string, thread: string, limitMs: number): WakeRecord {
  if (readCharacterState(characterDir, recordFile(thread)) !== undefined) return wakeRecord(characterDir, thread);
  const adopted = fromBefore(characterDir, limitMs);
  keepWakeRecord(characterDir, thread, adopted);
  deleteCharacterState(characterDir, OLD_HOME_THROUGH);
  deleteCharacterState(characterDir, OLD_CUT_OFF);
  return adopted;
}

export class WakeWords {
  closing = "";
  last = "";

  heard(round: LoopRound): void {
    if (round.role !== "assistant") return;
    const text = round.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    this.closing = round.blocks.some((block) => block.type === "tool_use") ? "" : text;
    if (text.trim() !== "") this.last = text.trim();
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
  note: DiaryNote | undefined;
}

export function recordWakeEnd(characterDir: string, thread: string, before: WakeRecord, end: WakeEnd): void {
  const why = stopOf(end.loop);
  const note = end.note === undefined ? before.note : { id: end.note.id, at: end.note.at, text: end.note.text };
  const kept = note === undefined ? {} : { note };
  if (why !== undefined) {
    const stopped: WakeStop = { at: end.endedAt, why, limitMs: end.limitMs, rounds: end.loop.rounds, sent: end.sent, last: cutNote(end.words.last) };
    keepWakeRecord(characterDir, thread, { ...(before.through === undefined ? {} : { through: before.through }), ...kept, stopped });
    return;
  }
  if (end.loop.failedRound !== undefined) return;
  keepWakeRecord(characterDir, thread, { through: end.startedAt, ...kept });
}

export function wakeStopNote(stop: WakeStop, userName: string, timeZone: string): string {
  const rounds = stop.rounds === 1 ? "1 round" : `${String(stop.rounds)} rounds`;
  const ran = stop.why === "time" ? `reached its limit of ${spanPhrase(stop.limitMs)} and was stopped` : "used up its rounds of tool use and was stopped";
  const why = stop.why === "interrupted" ? `was stopped for ${userName}'s message` : ran;
  const sent = stop.sent ? `The message it had already written was still sent to ${userName}.` : `Nothing from it was sent to ${userName}.`;
  const last = stop.last === "" ? "" : ` The last thing it wrote: "${stop.last}"`;
  return `[Your last wake here ${why} at ${formatWallClock(stop.at, timeZone)}, after ${rounds}, before it had finished. ${sent}${last} Whatever it had already changed with its tools is still in place.]`;
}

export function keptNote(record: WakeRecord, shown: readonly Pick<DiaryNote, "id">[], timeZone: string): string | undefined {
  const note = record.note;
  if (note === undefined || shown.some((each) => each.id === note.id)) return undefined;
  return `[Your note from the end of your last wake here, ${formatWallClock(Date.parse(note.at), timeZone)}, kept for this one:]\n\n${note.text}`;
}
