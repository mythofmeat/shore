import { formatWallClock } from "../engine/prompt.ts";
import { isToolResultOnly } from "../engine/message_store.ts";
import { isAutonomousNote } from "../engine/threads.ts";
import type { Message } from "../engine/types.ts";
import { messageText } from "../memory/history_index.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import { shoreLog } from "../log.ts";

export interface HomeReader {
  messages(): readonly Message[];
  segments(): { segmentCount(): number; readSegment(index: number): Promise<Message[]> };
}

export const HEARTBEAT_OPENER = "[heartbeat]";

const FIRST_HEARTBEAT_MESSAGES = 10;
const DIGEST_MAX_MESSAGES = 40;
const DIGEST_MAX_CHARS = 24_000;
const DIGEST_MESSAGE_CHARS = 4_000;
const HOME_SEGMENTS_READ = 3;
const HOME_THROUGH_STATE = "heartbeat_home.json";

function spoken(message: Message): string | undefined {
  if (message.role === "system" || isToolResultOnly(message) || isAutonomousNote(message)) return undefined;
  const text = messageText(message).trim();
  return text === "" ? undefined : text;
}

function timeOf(message: Message): number {
  return Date.parse(message.timestamp);
}

async function homeMessages(home: HomeReader, since: number | undefined): Promise<Message[]> {
  const seen = new Set<string>();
  let examined: Message[] = [];
  const take = (messages: readonly Message[]): void => {
    const fresh = messages.filter((message) => !seen.has(message.msg_id));
    for (const message of fresh) seen.add(message.msg_id);
    examined = [...fresh, ...examined];
  };
  const wanted = (message: Message): boolean => spoken(message) !== undefined && (since === undefined || timeOf(message) > since);
  const enough = (): boolean => since === undefined
    ? examined.filter(wanted).length >= FIRST_HEARTBEAT_MESSAGES
    : examined.some((message) => timeOf(message) <= since);
  take(home.messages());
  const segments = home.segments();
  const oldest = Math.max(0, segments.segmentCount() - HOME_SEGMENTS_READ);
  for (let index = segments.segmentCount() - 1; index >= oldest && !enough(); index -= 1) {
    take(await segments.readSegment(index).catch(() => []));
  }
  const found = examined.filter(wanted);
  return since === undefined ? found.slice(-FIRST_HEARTBEAT_MESSAGES) : found;
}

function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length <= DIGEST_MESSAGE_CHARS ? text : `${chars.slice(0, DIGEST_MESSAGE_CHARS).join("")}… [cut]`;
}

function entry(message: Message, userName: string, timeZone: string): string {
  const speaker = message.role === "user" ? userName : message.origin === "autonomous" ? "you, from a heartbeat" : "you";
  const at = timeOf(message);
  const when = Number.isNaN(at) ? "" : ` · ${formatWallClock(at, timeZone)}`;
  return `${speaker}${when}\n${cut(spoken(message) ?? "")}`;
}

export async function homeDigest(
  home: HomeReader,
  homeId: string,
  since: number | undefined,
  userName: string,
  timeZone: string,
): Promise<string> {
  const messages = await homeMessages(home, since);
  const where = `your home thread, "${homeId}",`;
  if (messages.length === 0) {
    return since === undefined ? `Nothing has been said in ${where} yet.` : `Nothing has been said in ${where} since your last heartbeat.`;
  }
  const shown: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0 && shown.length < DIGEST_MAX_MESSAGES; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = entry(message, userName, timeZone);
    if (shown.length > 0 && used + text.length > DIGEST_MAX_CHARS) break;
    shown.unshift(text);
    used += text.length;
  }
  const left = messages.length - shown.length;
  const intro = since === undefined
    ? `The last of what was said in ${where} before your first heartbeat here:`
    : `What was said in ${where} since your last heartbeat:`;
  const omitted = left === 0 ? [] : [`(${String(left)} earlier ${left === 1 ? "message isn't" : "messages aren't"} shown.)`];
  return [intro, ...omitted, ...shown].join("\n\n");
}

export function readHomeThrough(characterDir: string): number | undefined {
  try {
    const raw = readCharacterState(characterDir, HOME_THROUGH_STATE);
    if (raw === undefined) return undefined;
    const { through } = JSON.parse(raw) as Record<string, unknown>;
    const at = typeof through === "string" ? Date.parse(through) : Number.NaN;
    return Number.isNaN(at) ? undefined : at;
  } catch (error) {
    shoreLog.error(`shore: could not read when the last heartbeat looked at the home thread, at ${characterDir}: ${String(error)}`);
    return undefined;
  }
}

export function recordHomeThrough(characterDir: string, at: number): void {
  try {
    writeCharacterState(characterDir, HOME_THROUGH_STATE, JSON.stringify({ through: new Date(at).toISOString() }));
  } catch (error) {
    shoreLog.error(`shore: could not record when this heartbeat looked at the home thread, at ${characterDir}: ${String(error)}`);
  }
}
