import { formatWallClock } from "../engine/prompt.ts";
import { isToolResultOnly } from "../engine/message_store.ts";
import { isAutonomousNote } from "../engine/threads.ts";
import type { PriorContext } from "../engine/segments.ts";
import type { Message } from "../engine/types.ts";
import { messageText } from "../memory/history_index.ts";
import type { Texts } from "../texts/texts.ts";

export interface ThreadReader {
  messages(): readonly Message[];
  segments(): { segmentCount(): number; readSegment(index: number): Promise<Message[]>; priorContext(): PriorContext };
}

const FIRST_WAKE_MESSAGES = 10;
const DIGEST_MAX_MESSAGES = 40;
const DIGEST_MAX_CHARS = 24_000;
const DIGEST_MESSAGE_CHARS = 4_000;
const SEGMENTS_READ = 3;

function spoken(message: Message, texts: Texts): string | undefined {
  if (message.role === "system" || isToolResultOnly(message) || isAutonomousNote(message)) return undefined;
  const text = messageText(message, texts).trim();
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

async function saidIn(texts: Texts, thread: ThreadReader, since: number | undefined): Promise<Message[]> {
  const seen = new Set<string>();
  let examined: Message[] = [];
  const take = (messages: readonly Message[]): void => {
    const fresh = messages.filter((message) => !seen.has(message.msg_id));
    for (const message of fresh) seen.add(message.msg_id);
    examined = [...fresh, ...examined];
  };
  const said = (): Message[] => {
    const working = wakeWorking(examined);
    return examined.filter((message) => spoken(message, texts) !== undefined && !working.has(message.msg_id) && (since === undefined || timeOf(message) > since));
  };
  const enough = (): boolean => since === undefined
    ? said().length >= FIRST_WAKE_MESSAGES
    : examined.some((message) => timeOf(message) <= since);
  take(thread.messages());
  const segments = thread.segments();
  const oldest = Math.max(0, segments.segmentCount() - SEGMENTS_READ);
  for (let index = segments.segmentCount() - 1; index >= oldest && !enough(); index -= 1) {
    take(await segments.readSegment(index).catch(() => []));
  }
  const found = said();
  return since === undefined ? found.slice(-FIRST_WAKE_MESSAGES) : found;
}

function cut(texts: Texts, text: string): string {
  const chars = Array.from(text);
  if (chars.length <= DIGEST_MESSAGE_CHARS) return text;
  const head = chars.slice(0, DIGEST_MESSAGE_CHARS).join("");
  return texts.render("digest_cut", { text: head }) ?? head;
}

function entry(texts: Texts, message: Message, userName: string, timeZone: string): string | undefined {
  const speaker = message.role === "user" ? "digest_user" : message.origin === "autonomous" ? "digest_you_wake" : "digest_you";
  const at = timeOf(message);
  return texts.render(speaker, { user: userName, at: Number.isNaN(at) ? undefined : formatWallClock(at, timeZone), text: cut(texts, spoken(message, texts) ?? "") });
}

export async function threadDigest(
  texts: Texts,
  thread: ThreadReader,
  since: number | undefined,
  userName: string,
  timeZone: string,
): Promise<string | undefined> {
  const messages = await saidIn(texts, thread, since);
  if (messages.length === 0) return texts.render(since === undefined ? "digest_nothing_yet" : "digest_nothing_since");
  const shown: string[] = [];
  let used = 0;
  for (const message of messages.toReversed()) {
    const text = entry(texts, message, userName, timeZone) ?? "";
    if (shown.length === DIGEST_MAX_MESSAGES || used + text.length > DIGEST_MAX_CHARS) break;
    shown.unshift(text);
    used += text.length;
  }
  const left = messages.length - shown.length;
  const omitted = left === 0 ? undefined : texts.render("digest_left_out", { count: String(left), one: left === 1 ? "yes" : undefined });
  const parts = [texts.render(since === undefined ? "digest_first" : "digest_since"), omitted, ...shown].filter((part) => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
