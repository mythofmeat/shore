import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { characterCacheDir } from "../config/dirs.ts";
import { CharacterHistoryReader, type CharacterHistoryRef } from "../engine/character_history.ts";
import { deriveContentFromBlocks } from "../engine/message_store.ts";
import { pictureText } from "../engine/embeds.ts";
import type { Message } from "../engine/types.ts";
import { versionOf } from "../engine/versions.ts";

export const HISTORY_INDEX_FILE = "chat_logs.db";
const LEGACY_INDEX_FILE = "history_search.db";
const SCHEMA_VERSION = "2";

const SCHEMA = `
CREATE TABLE metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE messages (
  id        INTEGER PRIMARY KEY,
  msg_id    TEXT    NOT NULL,
  thread    TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  run       INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  speaker   TEXT    NOT NULL,
  heartbeat INTEGER NOT NULL,
  model     TEXT,
  also_in   TEXT,
  copy_of   INTEGER,
  text      TEXT    NOT NULL
);
CREATE INDEX messages_ts ON messages (ts);
CREATE INDEX messages_thread_seq ON messages (thread, seq);
CREATE INDEX messages_msg_id ON messages (msg_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, content = 'messages', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
);
`;

export type Speaker = "user" | "character" | "system";

export interface ChatLogMessage {
  id: number;
  msg_id: string;
  thread: string;
  seq: number;
  run: number;
  ts: number;
  speaker: Speaker;
  heartbeat: number;
  model: string | null;
  also_in: string | null;
  copy_of: number | null;
  text: string;
}

export interface ChatLogHit extends ChatLogMessage {
  snippet: string | null;
}

export type ChatLogMatch = "words" | "substring";
export type ChatLogSort = "best" | "oldest" | "newest";

export interface ChatLogFilter {
  start?: number;
  end?: number;
  speaker?: Speaker;
  thread?: string;
}

export function historyIndexPath(cacheDir: string, character: string): string {
  return join(characterCacheDir(cacheDir, character), HISTORY_INDEX_FILE);
}

const indexLocks = new Map<string, Promise<void>>();

export async function withHistoryIndexLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prior = indexLocks.get(path);
  const started = prior === undefined ? run() : prior.then(run);
  const settled = started.then(
    () => undefined,
    () => undefined,
  );
  indexLocks.set(path, settled);
  try {
    return await started;
  } finally {
    if (indexLocks.get(path) === settled) indexLocks.delete(path);
  }
}

interface Item {
  msgId: string;
  thread: string;
  seq: number;
  run: number;
  ts: number;
  speaker: Speaker;
  heartbeat: boolean;
  model: string | null;
  text: string;
  alsoIn: string[];
  copyOf: Item | undefined;
  id: number;
}

interface ThreadCursor {
  seq: number;
  run: number;
  ts: number;
  broken: boolean;
}

function threadOf(character: string, archiveKey: string): string {
  return archiveKey === character ? "main" : archiveKey.slice(character.length + 1);
}

function speakerOf(role: Message["role"]): Speaker {
  return role === "user" ? "user" : role === "assistant" ? "character" : "system";
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readCorpus(ref: CharacterHistoryRef): Promise<Item[]> {
  const reader = await CharacterHistoryReader.load(ref);
  try {
    const entries = reader.entries().sort((a, b) => compareKeys(a.archiveKey, b.archiveKey) || a.idx - b.idx);
    const firstSeen = new Map<string, Item>();
    const seenInThread = new Set<string>();
    const cursors = new Map<string, ThreadCursor>();
    const items: Item[] = [];
    for (const entry of entries) {
      const thread = threadOf(ref.character, entry.archiveKey);
      const cursor = cursors.get(thread) ?? { seq: 0, run: 0, ts: 0, broken: false };
      cursors.set(thread, cursor);
      if (entry.excluded === true) {
        cursor.broken = true;
        continue;
      }
      for (const message of await reader.readSegment(entry.archiveKey, entry.idx)) {
        const text = pictureText(deriveContentFromBlocks(message.content_blocks, false), message.images);
        if (text === "") continue;
        const key = versionOf(message) ?? `${message.msg_id}\0${createHash("sha256").update(text).digest("hex")}`;
        if (seenInThread.has(`${thread}\0${key}`)) continue;
        seenInThread.add(`${thread}\0${key}`);
        const original = firstSeen.get(key);
        if (original !== undefined) original.alsoIn.push(thread);
        if (cursor.broken) {
          cursor.run += 1;
          cursor.broken = false;
        }
        cursor.seq += 1;
        const parsed = Date.parse(message.timestamp);
        if (!Number.isNaN(parsed)) cursor.ts = parsed;
        const item: Item = {
          msgId: message.msg_id,
          thread,
          seq: cursor.seq,
          run: cursor.run,
          ts: cursor.ts,
          speaker: speakerOf(message.role),
          heartbeat: message.origin === "autonomous",
          model: message.model ?? null,
          text,
          alsoIn: [],
          copyOf: original,
          id: 0,
        };
        if (original === undefined) firstSeen.set(key, item);
        items.push(item);
      }
    }
    return items;
  } finally {
    reader.close();
  }
}

async function sourceFingerprint(ref: CharacterHistoryRef): Promise<string> {
  const reader = await CharacterHistoryReader.load(ref);
  try {
    return `${SCHEMA_VERSION}:${reader.archiveDigest()}`;
  } finally {
    reader.close();
  }
}

async function readStableCorpus(ref: CharacterHistoryRef, initial: string): Promise<{ items: Item[]; fingerprint: string }> {
  let before = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const items = await readCorpus(ref);
    const after = await sourceFingerprint(ref);
    if (after === before) return { items, fingerprint: after };
    before = after;
  }
  throw new Error("the history archive kept changing while the chat log index was being built");
}

function builtFingerprint(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query("SELECT value FROM metadata WHERE key = 'fingerprint'").get() as { value: string } | null)?.value;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function writeIndex(path: string, items: Item[], fingerprint: string): void {
  items.sort((a, b) => a.ts - b.ts || compareKeys(a.thread, b.thread) || a.seq - b.seq);
  items.forEach((item, i) => { item.id = i + 1; });
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
  try {
    const db = new Database(temp, { create: true, readwrite: true });
    try {
      db.run(SCHEMA);
      const put = db.query(
        `INSERT INTO messages (id, msg_id, thread, seq, run, ts, speaker, heartbeat, model, also_in, copy_of, text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      );
      const meta = db.query("INSERT INTO metadata (key, value) VALUES (?1, ?2)");
      db.transaction(() => {
        for (const item of items) {
          put.run(
            item.id, item.msgId, item.thread, item.seq, item.run, item.ts, item.speaker, item.heartbeat ? 1 : 0,
            item.model, item.alsoIn.length === 0 ? null : JSON.stringify(item.alsoIn), item.copyOf?.id ?? null, item.text,
          );
        }
        db.run("INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')");
        meta.run("fingerprint", fingerprint);
        meta.run("built_at", new Date().toISOString());
        meta.run("messages", String(items.filter((item) => item.copyOf === undefined).length));
      })();
    } finally {
      db.close();
    }
    chmodSync(temp, 0o444);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (basename(path) !== LEGACY_INDEX_FILE) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dirname(path), `${LEGACY_INDEX_FILE}${suffix}`), { force: true });
  }
}

export async function refreshHistoryIndex(ref: CharacterHistoryRef, path: string, force = false): Promise<boolean> {
  const fingerprint = await sourceFingerprint(ref);
  if (!force && builtFingerprint(path) === fingerprint) return false;
  const { items, fingerprint: settled } = await readStableCorpus(ref, fingerprint);
  writeIndex(path, items, settled);
  return true;
}

function filterSql(filter: ChatLogFilter, params: Record<string, string | number>): string[] {
  const where: string[] = [];
  if (filter.start !== undefined) {
    where.push("m.ts >= $start");
    params["$start"] = filter.start;
  }
  if (filter.end !== undefined) {
    where.push("m.ts <= $end");
    params["$end"] = filter.end;
  }
  if (filter.speaker !== undefined) {
    where.push("m.speaker = $speaker");
    params["$speaker"] = filter.speaker;
  }
  if (filter.thread !== undefined) {
    where.push("(m.thread = $thread OR EXISTS (SELECT 1 FROM json_each(m.also_in) WHERE value = $thread))");
    params["$thread"] = filter.thread;
  }
  return where;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class HistoryIndex {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static open(path: string): HistoryIndex {
    return new HistoryIndex(new Database(path, { readonly: true }));
  }

  close(): void {
    this.#db.close();
  }

  metadata(key: string): string | undefined {
    return (this.#db.query("SELECT value FROM metadata WHERE key = ?1").get(key) as { value: string } | null)?.value;
  }

  span(): { messages: number; oldest: number; newest: number } | undefined {
    const row = this.#db.query("SELECT COUNT(*) AS messages, MIN(ts) AS oldest, MAX(ts) AS newest FROM messages WHERE copy_of IS NULL")
      .get() as { messages: number; oldest: number | null; newest: number | null };
    return row.oldest === null || row.newest === null ? undefined : { messages: row.messages, oldest: row.oldest, newest: row.newest };
  }

  threads(): string[] {
    return (this.#db.query("SELECT DISTINCT thread FROM messages ORDER BY thread = 'main' DESC, thread").all() as { thread: string }[])
      .map((row) => row.thread);
  }

  #matching(match: ChatLogMatch, query: string, filter: ChatLogFilter): { from: string; params: Record<string, string | number> } {
    const params: Record<string, string | number> = {};
    const where = ["m.copy_of IS NULL", ...filterSql(filter, params)];
    if (match === "words") {
      params["$query"] = query;
      return { from: `FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH $query AND ${where.join(" AND ")}`, params };
    }
    params["$pattern"] = likePattern(query);
    return { from: `FROM messages m WHERE m.text LIKE $pattern ESCAPE '\\' AND ${where.join(" AND ")}`, params };
  }

  count(match: ChatLogMatch, query: string, filter: ChatLogFilter): number {
    const { from, params } = this.#matching(match, query, filter);
    return (this.#db.query(`SELECT COUNT(*) AS n ${from}`).get(params) as { n: number }).n;
  }

  search(match: ChatLogMatch, query: string, filter: ChatLogFilter, sort: ChatLogSort, limit: number, offset: number): ChatLogHit[] {
    const { from, params } = this.#matching(match, query, filter);
    const order = sort === "oldest" ? "m.ts, m.id" : sort === "best" && match === "words" ? "bm25(messages_fts), m.ts DESC, m.id DESC" : "m.ts DESC, m.id DESC";
    const snippet = match === "words" ? "snippet(messages_fts, 0, '[', ']', '…', 14)" : "NULL";
    return this.#db.query(`SELECT m.*, ${snippet} AS snippet ${from} ORDER BY ${order} LIMIT $limit OFFSET $offset`)
      .all({ ...params, $limit: limit, $offset: offset }) as ChatLogHit[];
  }

  find(msgId: string, thread?: string): ChatLogMessage | undefined {
    const row = thread === undefined
      ? this.#db.query("SELECT * FROM messages WHERE msg_id = ?1 ORDER BY copy_of IS NOT NULL, id LIMIT 1").get(msgId)
      : this.#db.query("SELECT * FROM messages WHERE msg_id = ?1 AND thread = ?2 ORDER BY id LIMIT 1").get(msgId, thread);
    return (row as ChatLogMessage | null) ?? undefined;
  }

  neighbors(row: ChatLogMessage, direction: -1 | 1, limit: number): ChatLogMessage[] {
    if (limit === 0) return [];
    const sql = direction < 0
      ? "SELECT * FROM messages WHERE thread = ?1 AND run = ?2 AND seq < ?3 ORDER BY seq DESC LIMIT ?4"
      : "SELECT * FROM messages WHERE thread = ?1 AND run = ?2 AND seq > ?3 ORDER BY seq LIMIT ?4";
    return this.#db.query(sql).all(row.thread, row.run, row.seq, limit) as ChatLogMessage[];
  }

  countRange(thread: string, start: number, end: number): number {
    return (this.#db.query("SELECT COUNT(*) AS n FROM messages WHERE thread = ?1 AND ts BETWEEN ?2 AND ?3")
      .get(thread, start, end) as { n: number }).n;
  }

  range(thread: string, start: number, end: number, offset: number, limit: number): ChatLogMessage[] {
    return this.#db.query("SELECT * FROM messages WHERE thread = ?1 AND ts BETWEEN ?2 AND ?3 ORDER BY ts, seq LIMIT ?5 OFFSET ?4")
      .all(thread, start, end, offset, limit) as ChatLogMessage[];
  }

  between(start: number, end: number): ChatLogMessage[] {
    return this.#db.query("SELECT * FROM messages WHERE copy_of IS NULL AND ts BETWEEN ?1 AND ?2 ORDER BY thread = 'main' DESC, thread, ts, seq")
      .all(start, end) as ChatLogMessage[];
  }
}
