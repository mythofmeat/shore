import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const DATABASE_FILE = "shore.db";
export const databasePath = (data: string): string => join(data, DATABASE_FILE);

export const STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS state_files (
  path TEXT PRIMARY KEY,
  character TEXT NOT NULL,
  content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS state_files_character ON state_files(character);
CREATE TABLE IF NOT EXISTS state_collections (
  path TEXT PRIMARY KEY,
  format TEXT NOT NULL CHECK(format IN ('jsonl', 'array'))
);
CREATE TABLE IF NOT EXISTS state_lines (
  path TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry_key TEXT,
  content BLOB NOT NULL,
  PRIMARY KEY(path, seq),
  UNIQUE(path, entry_key)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS delete_state_collection AFTER DELETE ON state_files BEGIN
  DELETE FROM state_lines WHERE path = old.path;
  DELETE FROM state_collections WHERE path = old.path;
END;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_key TEXT,
  timestamp TEXT NOT NULL,
  content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS events_character_kind ON events(character, kind, id);
CREATE INDEX IF NOT EXISTS events_key ON events(character, kind, event_key, id);
`;

export function openStorage(data: string): Database {
  mkdirSync(data, { recursive: true });
  const db = new Database(databasePath(data), { create: true });
  try {
    chmodSync(databasePath(data), 0o600);
    db.run("PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    db.run(STORAGE_SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const connections = new Map<string, { db: Database; dev: number; ino: number }>();
const MAX_CONNECTIONS = 32;

export function closeStorageConnections(): void {
  for (const entry of connections.values()) entry.db.close();
  connections.clear();
}

export function withStorage<T>(data: string, run: (db: Database) => T): T {
  const key = resolve(data);
  let entry = connections.get(key);
  if (entry !== undefined) {
    const stat = existsSync(databasePath(key)) ? statSync(databasePath(key)) : undefined;
    if (stat?.ino !== entry.ino || stat.dev !== entry.dev) {
      entry.db.close();
      connections.delete(key);
      entry = undefined;
    }
  }
  if (entry === undefined) {
    const db = openStorage(key);
    const stat = statSync(databasePath(key));
    entry = { db, dev: stat.dev, ino: stat.ino };
  }
  connections.delete(key);
  connections.set(key, entry);
  while (connections.size > MAX_CONNECTIONS) {
    const oldest = connections.entries().next().value;
    if (oldest === undefined) break;
    oldest[1].db.close();
    connections.delete(oldest[0]);
  }
  return run(entry.db);
}

export const pack = (content: string): Uint8Array => zstdCompressSync(Buffer.from(content));
export const unpack = (content: Uint8Array): string => zstdDecompressSync(content).toString("utf8");

export function characterScope(characterDir: string): { data: string; character: string } {
  return { data: dirname(characterDir), character: basename(characterDir) };
}

export function readState(data: string, path: string): string | undefined {
  return withStorage(data, (db) => {
    const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(path) as { content: Uint8Array } | null;
    return row === null ? undefined : (collectionText(db, path) ?? unpack(row.content));
  });
}

export function writeState(data: string, path: string, content: string, character = ""): void {
  withStorage(data, (db) => db.transaction(() => {
    const collection = db.query("SELECT format FROM state_collections WHERE path = ?1").get(path) as { format: CollectionFormat } | null;
    if (collection !== null) {
      replaceCollection(db, path, character, collection.format, content);
      return;
    }
    db.query(`INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)
      ON CONFLICT(path) DO UPDATE SET character = excluded.character, content = excluded.content`)
      .run(path, character, pack(content));
  })());
}

export function deleteState(data: string, path: string): void {
  withStorage(data, (db) => db.query("DELETE FROM state_files WHERE path = ?1").run(path));
}

export interface StoredEvent {
  character: string;
  kind: string;
  key?: string | undefined;
  timestamp: string;
  content: string;
}

export function insertEvent(db: Database, event: StoredEvent): void {
  db.query(`INSERT INTO events(character, kind, event_key, timestamp, content)
    VALUES (?1, ?2, ?3, ?4, ?5)`)
    .run(event.character, event.kind, event.key ?? null, event.timestamp, pack(event.content));
}

export function readEvents(data: string, character: string, kind: string | readonly string[], count = 0, ids?: readonly string[]): string[] {
  return withStorage(data, (db) => {
    const params: SQLQueryBindings[] = [character, typeof kind === "string" ? kind : JSON.stringify(kind), count > 0 ? count : -1];
    const kinds = typeof kind === "string" ? "kind = ?2" : "kind IN (SELECT value FROM json_each(?2))";
    const filter = ids === undefined ? "" : " AND event_key IN (SELECT value FROM json_each(?4))";
    if (ids !== undefined) params.push(JSON.stringify(ids));
    const rows = db.query(`SELECT content FROM (
      SELECT id, content FROM events WHERE character = ?1 AND ${kinds}${filter}
      ORDER BY id DESC LIMIT ?3) ORDER BY id`).all(...params) as { content: Uint8Array }[];
    return rows.map((row) => unpack(row.content));
  });
}

export function readCharacterState(characterDir: string, file: string): string | undefined {
  const { data, character } = characterScope(characterDir);
  return readState(data, `${character}/${file}`);
}

export function writeCharacterState(characterDir: string, file: string, content: string): void {
  const { data, character } = characterScope(characterDir);
  writeState(data, `${character}/${file}`, content, character);
}

export function deleteCharacterState(characterDir: string, file: string): void {
  const { data, character } = characterScope(characterDir);
  deleteState(data, `${character}/${file}`);
}

export type CollectionFormat = "jsonl" | "array";

function collectionEntries(content: string, format: CollectionFormat): { text: string; key?: string }[] {
  if (format === "jsonl") return (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(text => ({ text }));
  return (JSON.parse(content) as { uuid?: string }[]).map(entry => ({ text: JSON.stringify(entry), ...(entry.uuid === undefined ? {} : { key: entry.uuid }) }));
}

export function collectionText(db: Database, path: string): string | undefined {
  const collection = db.query("SELECT format FROM state_collections WHERE path = ?1").get(path) as { format: CollectionFormat } | null;
  if (collection === null) return undefined;
  const rows = db.query("SELECT content FROM state_lines WHERE path = ?1 ORDER BY seq").all(path) as { content: Uint8Array }[];
  const parts = rows.map(row => unpack(row.content));
  return collection.format === "jsonl" ? parts.join("") : `[${parts.join(",")}]`;
}

export function ensureCollection(db: Database, path: string, character: string, format: CollectionFormat): void {
  const existing = db.query("SELECT format FROM state_collections WHERE path = ?1").get(path) as { format: CollectionFormat } | null;
  if (existing !== null) {
    if (existing.format !== format) throw new Error(`Unexpected collection format for ${path}`);
    return;
  }
  const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(path) as { content: Uint8Array } | null;
  replaceCollection(db, path, character, format, row === null ? (format === "array" ? "[]" : "") : unpack(row.content));
}

export function replaceCollection(db: Database, path: string, character: string, format: CollectionFormat, content: string): void {
  const entries = collectionEntries(content, format);
  db.query("INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET character = excluded.character, content = excluded.content")
    .run(path, character, pack(format === "array" ? "[]" : ""));
  db.query("INSERT INTO state_collections VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET format = excluded.format").run(path, format);
  db.query("DELETE FROM state_lines WHERE path = ?1").run(path);
  appendCollection(db, path, entries);
}

export function appendCollection(db: Database, path: string, entries: readonly { text: string; key?: string }[]): void {
  let seq = (db.query("SELECT coalesce(max(seq), -1) AS seq FROM state_lines WHERE path = ?1").get(path) as { seq: number }).seq + 1;
  const insert = db.query("INSERT INTO state_lines(path, seq, entry_key, content) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(path, entry_key) DO UPDATE SET content = excluded.content");
  for (const entry of entries) insert.run(path, seq++, entry.key ?? null, pack(entry.text));
}
