import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MAIN_THREAD, resolveShoreDirs, rustJoin } from "../../config/dirs.ts";
import { shoreLog } from "../../log.ts";

export const SESSION_KEY_SEPARATOR = "\u0000";

export const SESSION_BOOK_FILE = "claude_agent_sessions.json";

export interface DeliveredEntry {
  hash: string;
  uuid?: string;
}

export interface SessionRecord {
  sessionId: string;
  entries: DeliveredEntry[];
  pendingAssistantUuid?: string;
}

export type SessionBook = Record<string, SessionRecord>;

export function sessionKey(character: string, ledger: string, thread: string): string {
  const base = `${character}${SESSION_KEY_SEPARATOR}${ledger}`;
  return thread === MAIN_THREAD ? base : `${base}${SESSION_KEY_SEPARATOR}${thread}`;
}

export function sessionKeyOwner(key: string): string | undefined {
  const parts = key.split(SESSION_KEY_SEPARATOR);
  return parts.length === 2 || parts.length === 3 ? parts[0] : undefined;
}

export function sessionKeyThread(key: string): string | undefined {
  const parts = key.split(SESSION_KEY_SEPARATOR);
  if (parts.length === 2) return MAIN_THREAD;
  return parts.length === 3 ? parts[2] : undefined;
}

export function bookPathIn(data: string): string {
  return rustJoin(data, SESSION_BOOK_FILE);
}

export function bookPath(): string {
  return bookPathIn(resolveShoreDirs().data);
}

export function readBook(path: string): SessionBook {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionBook;
  } catch {
    return {};
  }
}

export function writeBook(path: string, book: SessionBook): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(book), "utf8");
  } catch {
    shoreLog.warn("claude_agent: session book unwritable");
  }
}

export function withoutThread(
  book: SessionBook,
  character: string,
  thread: string,
): SessionBook | undefined {
  const kept: SessionBook = {};
  let dropped = 0;
  for (const [key, record] of Object.entries(book)) {
    if (sessionKeyOwner(key) === character && sessionKeyThread(key) === thread) {
      dropped += 1;
      continue;
    }
    kept[key] = record;
  }
  return dropped === 0 ? undefined : kept;
}

export function forgetThreadSessions(data: string, character: string, thread: string): number {
  const path = bookPathIn(data);
  const book = readBook(path);
  const kept = withoutThread(book, character, thread);
  if (kept === undefined) return 0;
  const dropped = Object.keys(book).length - Object.keys(kept).length;
  writeBook(path, kept);
  shoreLog.info(
    `shore: forgot ${String(dropped)} Agent SDK session(s) for ${character} thread ${thread}`,
  );
  return dropped;
}
