import { pack, unpack, withStorage } from "../../storage/store.ts";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { MAIN_THREAD, resolveShoreDirs, rustJoin } from "../../config/dirs.ts";
import { shoreLog } from "../../log.ts";
import { reconcileSessions, retireSession } from "./agent_session_retention.ts";

export const SESSION_KEY_SEPARATOR = "\u0000";

export const SESSION_BOOK_FILE = "claude_agent_sessions.json";

export interface DeliveredEntry {
  hash: string;
  uuid?: string;
  sessionId?: string;
}

export const SESSION_BOOK_VERSION = 6;

export interface SessionRecord {
  version: number;
  sessionId: string;
  entries: DeliveredEntry[];
  pendingAssistantUuids?: string[];
  pendingAssistantHashes?: string[];
  storedTranscript?: true;
}

export type SessionBook = Record<string, SessionRecord>;

export function sessionKey(character: string, ledger: string, thread: string, scope?: string): string {
  const canonicalLedger = basename(ledger) === "ledger.db" ? join(dirname(ledger), "shore.db") : ledger;
  const base = `${character}${SESSION_KEY_SEPARATOR}${canonicalLedger}`;
  if (scope !== undefined) return `${base}${SESSION_KEY_SEPARATOR}${thread}${SESSION_KEY_SEPARATOR}${scope}`;
  return thread === MAIN_THREAD ? base : `${base}${SESSION_KEY_SEPARATOR}${thread}`;
}

export function sessionKeyOwner(key: string): string | undefined {
  const parts = key.split(SESSION_KEY_SEPARATOR);
  return parts.length >= 2 && parts.length <= 4 ? parts[0] : undefined;
}

export function sessionKeyThread(key: string): string | undefined {
  const parts = key.split(SESSION_KEY_SEPARATOR);
  if (parts.length === 2) return MAIN_THREAD;
  return parts.length === 3 || parts.length === 4 ? parts[2] : undefined;
}

export function bookPathIn(data: string): string {
  return rustJoin(data, SESSION_BOOK_FILE);
}

export function bookPath(): string {
  return bookPathIn(resolveShoreDirs().data);
}

function bookPrefix(path: string): string {
  return `sdk_sessions/${basename(path)}/`;
}

function normalizeKey(key: string): string {
  const parts = key.split(SESSION_KEY_SEPARATOR);
  if (parts[1] !== undefined && basename(parts[1]) === "ledger.db") parts[1] = join(dirname(parts[1]), "shore.db");
  return parts.join(SESSION_KEY_SEPARATOR);
}

export function readBook(path: string): SessionBook {
  if (existsSync(path)) {
    const legacy = JSON.parse(readFileSync(path, "utf8")) as SessionBook;
    writeBook(path, Object.fromEntries(Object.entries(legacy).map(([key, record]) => [normalizeKey(key), record])));
  }
  const prefix = bookPrefix(path);
  return withStorage(dirname(path), (db) => {
    const rows = db.query("SELECT path, content FROM state_files WHERE substr(path, 1, length(?1)) = ?1").all(prefix) as { path: string; content: Uint8Array }[];
    return Object.fromEntries(rows.map((row) => [Buffer.from(row.path.slice(prefix.length), "base64url").toString(), JSON.parse(unpack(row.content)) as SessionRecord]));
  });
}

export function writeBook(path: string, book: SessionBook, nowMs = Date.now()): void {
  const prefix = bookPrefix(path);
  withStorage(dirname(path), (db) => db.transaction(() => {
    const previous = db.query("SELECT path, content FROM state_files WHERE substr(path, 1, length(?1)) = ?1").all(prefix) as { path: string; content: Uint8Array }[];
    const before = Object.fromEntries(previous.map(row => [Buffer.from(row.path.slice(prefix.length), "base64url").toString(), JSON.parse(unpack(row.content)) as SessionRecord]));
    reconcileSessions(db, before, book, nowMs);
    db.query("DELETE FROM state_files WHERE substr(path, 1, length(?1)) = ?1").run(prefix);
    db.query("DELETE FROM state_files WHERE path = ?1").run(basename(path));
    if (Object.keys(book).length === 0) db.query("INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)").run(basename(path), "", pack("{}"));
    const insert = db.query("INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)");
    for (const [key, record] of Object.entries(book)) {
      insert.run(prefix + Buffer.from(normalizeKey(key)).toString("base64url"), sessionKeyOwner(key) ?? "", pack(JSON.stringify(record)));
    }
  })());
  if (existsSync(path)) unlinkSync(path);
}

export function writeSession(path: string, key: string, record: SessionRecord, previous?: { record: SessionRecord | undefined }): void {
  const book = readBook(path);
  if (previous !== undefined && JSON.stringify(book[key]) !== JSON.stringify(previous.record)) {
    withStorage(dirname(path), db => retireSession(db, record.sessionId, sessionKeyOwner(key) ?? "", Date.now()));
    return;
  }
  writeBook(path, { ...book, [key]: record });
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

export function forgetThreadSessions(data: string, character: string, thread: string, nowMs = Date.now()): number {
  const path = bookPathIn(data);
  const book = readBook(path);
  const kept = withoutThread(book, character, thread);
  if (kept === undefined) return 0;
  const dropped = Object.keys(book).length - Object.keys(kept).length;
  writeBook(path, kept, nowMs);
  shoreLog.info(
    `shore: forgot ${String(dropped)} Agent SDK session(s) for ${character} thread ${thread}`,
  );
  return dropped;
}
