import { formatWallClock } from "../engine/prompt.ts";
import { isToolResultOnly } from "../engine/message_store.ts";
import { isAutonomousNote } from "../engine/threads.ts";
import type { PriorContext } from "../engine/segments.ts";
import type { Message } from "../engine/types.ts";
import { messageText } from "../memory/history_index.ts";

export interface HomeReader {
  messages(): readonly Message[];
  segments(): { segmentCount(): number; readSegment(index: number): Promise<Message[]>; priorContext(): PriorContext };
}

export const HEARTBEAT_OPENER = "[heartbeat]";

const FIRST_HEARTBEAT_MESSAGES = 10;
const DIGEST_MAX_MESSAGES = 40;
const DIGEST_MAX_CHARS = 24_000;
const DIGEST_MESSAGE_CHARS = 4_000;
const HOME_SEGMENTS_READ = 3;

export interface DigestWords {
  nothingYet: string;
  nothingSince: string;
  first: string;
  since: string;
}

export function homeWords(home: string): DigestWords {
  const where = `your home thread, "${home}",`;
  return {
    nothingYet: `Nothing has been said in ${where} yet.`,
    nothingSince: `Nothing has been said in ${where} since your last heartbeat.`,
    first: `The last of what was said in ${where} before your first heartbeat here:`,
    since: `What was said in ${where} since your last heartbeat:`,
  };
}

export const THREAD_WORDS: DigestWords = {
  nothingYet: "Nothing has been said in this thread yet.",
  nothingSince: "Nothing has been said in this thread since your last wake here.",
  first: "The last of what was said in this thread:",
  since: "What was said in this thread since your last wake here:",
};

function spoken(message: Message): string | undefined {
  if (message.role === "system" || isToolResultOnly(message) || isAutonomousNote(message)) return undefined;
  const text = messageText(message).trim();
  return text === "" ? undefined : text;
}

function timeOf(message: Message): number {
  return Date.parse(message.timestamp);
}

function wakeWorking(messages: readonly Message[]): Set<string> {
  const working = new Set<string>();
  let inWake = false;
  for (const message of messages) {
    if (message.role === "user" && !isToolResultOnly(message)) inWake = isAutonomousNote(message);
    if (inWake && message.role === "assistant" && message.origin !== "autonomous") working.add(message.msg_id);
  }
  return working;
}

async function homeMessages(home: HomeReader, since: number | undefined): Promise<Message[]> {
  const seen = new Set<string>();
  let examined: Message[] = [];
  const take = (messages: readonly Message[]): void => {
    const fresh = messages.filter((message) => !seen.has(message.msg_id));
    for (const message of fresh) seen.add(message.msg_id);
    examined = [...fresh, ...examined];
  };
  const said = (): Message[] => {
    const working = wakeWorking(examined);
    return examined.filter((message) => spoken(message) !== undefined && !working.has(message.msg_id) && (since === undefined || timeOf(message) > since));
  };
  const enough = (): boolean => since === undefined
    ? said().length >= FIRST_HEARTBEAT_MESSAGES
    : examined.some((message) => timeOf(message) <= since);
  take(home.messages());
  const segments = home.segments();
  const oldest = Math.max(0, segments.segmentCount() - HOME_SEGMENTS_READ);
  for (let index = segments.segmentCount() - 1; index >= oldest && !enough(); index -= 1) {
    take(await segments.readSegment(index).catch(() => []));
  }
  const found = said();
  return since === undefined ? found.slice(-FIRST_HEARTBEAT_MESSAGES) : found;
}

function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length <= DIGEST_MESSAGE_CHARS ? text : `${chars.slice(0, DIGEST_MESSAGE_CHARS).join("")}… [cut]`;
}

function entry(message: Message, userName: string, timeZone: string): string {
  const speaker = message.role === "user" ? userName : message.origin === "autonomous" ? "you, on your own time" : "you";
  const at = timeOf(message);
  const when = Number.isNaN(at) ? "" : ` · ${formatWallClock(at, timeZone)}`;
  return `${speaker}${when}\n${cut(spoken(message) ?? "")}`;
}

export async function threadDigest(
  thread: HomeReader,
  words: DigestWords,
  since: number | undefined,
  userName: string,
  timeZone: string,
): Promise<string> {
  const messages = await homeMessages(thread, since);
  if (messages.length === 0) return since === undefined ? words.nothingYet : words.nothingSince;
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
  const omitted = left === 0 ? [] : [`(${String(left)} earlier ${left === 1 ? "message isn't" : "messages aren't"} shown.)`];
  return [since === undefined ? words.first : words.since, ...omitted, ...shown].join("\n\n");
}
