import { createHash } from "node:crypto";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
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
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_key TEXT,
  timestamp TEXT NOT NULL,
  content BLOB NOT NULL,
  legacy_source TEXT,
  legacy_line INTEGER,
  UNIQUE(legacy_source, legacy_line)
);
CREATE INDEX IF NOT EXISTS events_character_kind ON events(character, kind, id);
CREATE INDEX IF NOT EXISTS events_key ON events(character, kind, event_key, id);
CREATE TABLE IF NOT EXISTS storage_imports (
  source TEXT PRIMARY KEY,
  digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_import_rows (
  kind TEXT NOT NULL,
  table_name TEXT NOT NULL,
  digest TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  target_id INTEGER,
  PRIMARY KEY(kind, table_name, digest, occurrence)
);
`;

export function openStorage(data: string): Database {
  mkdirSync(data, { recursive: true });
  const db = new Database(databasePath(data), { create: true });
  try {
    chmodSync(databasePath(data), 0o600);
    db.run("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    db.run(STORAGE_SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withStorage<T>(data: string, run: (db: Database) => T): T {
  const db = openStorage(data);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

export const pack = (content: string): Uint8Array => zstdCompressSync(Buffer.from(content));
export const unpack = (content: Uint8Array): string => zstdDecompressSync(content).toString("utf8");

export function characterScope(characterDir: string): { data: string; character: string } {
  return { data: dirname(characterDir), character: basename(characterDir) };
}

export function readState(data: string, path: string, character = ""): string | undefined {
  const legacy = join(data, path);
  if (existsSync(legacy)) {
    const content = readFileSync(legacy, "utf8");
    writeState(data, path, content, character);
    return content;
  }
  return withStorage(data, (db) => {
    const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(path) as { content: Uint8Array } | null;
    return row === null ? undefined : unpack(row.content);
  });
}

export function writeState(data: string, path: string, content: string, character = ""): void {
  withStorage(data, (db) => {
    db.query(`INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)
      ON CONFLICT(path) DO UPDATE SET character = excluded.character, content = excluded.content`)
      .run(path, character, pack(content));
  });
  const legacy = join(data, path);
  if (existsSync(legacy)) unlinkSync(legacy);
}

export function deleteState(data: string, path: string): void {
  withStorage(data, (db) => db.query("DELETE FROM state_files WHERE path = ?1").run(path));
  const legacy = join(data, path);
  if (existsSync(legacy)) unlinkSync(legacy);
}

export interface StoredEvent {
  character: string;
  kind: string;
  key?: string | undefined;
  timestamp: string;
  content: string;
}

export function insertEvent(db: Database, event: StoredEvent, source?: string, line?: number): void {
  db.query(`INSERT OR IGNORE INTO events(character, kind, event_key, timestamp, content, legacy_source, legacy_line)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .run(event.character, event.kind, event.key ?? null, event.timestamp, pack(event.content), source ?? null, line ?? null);
}

export function readEvents(data: string, character: string, kind: string, count = 0, ids?: readonly string[]): string[] {
  return withStorage(data, (db) => {
    const params: SQLQueryBindings[] = [character, kind, count > 0 ? count : -1];
    const filter = ids === undefined ? "" : " AND event_key IN (SELECT value FROM json_each(?4))";
    if (ids !== undefined) params.push(JSON.stringify(ids));
    const rows = db.query(`SELECT content FROM (
      SELECT id, content FROM events WHERE character = ?1 AND kind = ?2${filter}
      ORDER BY id DESC LIMIT ?3) ORDER BY id`).all(...params) as { content: Uint8Array }[];
    return rows.map((row) => unpack(row.content));
  });
}

const importing = new Map<string, Promise<void>>();

export async function importLegacyLog(data: string, path: string, decode: (line: string) => StoredEvent): Promise<void> {
  const file = join(data, path);
  const pending = importing.get(file);
  if (pending !== undefined) return await pending;
  if (!existsSync(file)) return;
  const work = (async () => {
    const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let number = 0;
    let batch: { event: StoredEvent; line: number }[] = [];
    const flush = () => {
      withStorage(data, (db) => db.transaction(() => {
        for (const entry of batch) insertEvent(db, entry.event, `${path}:${createHash("sha256").update(entry.event.content).digest("hex")}`, entry.line);
      })());
      batch = [];
    };
    try {
      for await (const line of reader) {
        number += 1;
        if (line.trim() !== "") batch.push({ event: decode(line), line: number });
        if (batch.length >= 128) flush();
      }
      if (batch.length > 0) flush();
      unlinkSync(file);
    } finally {
      reader.close();
    }
  })();
  importing.set(file, work);
  try {
    await work;
  } finally {
    importing.delete(file);
  }
}

export function readCharacterState(characterDir: string, file: string): string | undefined {
  const { data, character } = characterScope(characterDir);
  return readState(data, `${character}/${file}`, character);
}

export function writeCharacterState(characterDir: string, file: string, content: string): void {
  const { data, character } = characterScope(characterDir);
  writeState(data, `${character}/${file}`, content, character);
}

export function deleteCharacterState(characterDir: string, file: string): void {
  const { data, character } = characterScope(characterDir);
  deleteState(data, `${character}/${file}`);
}
