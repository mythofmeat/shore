import { createHash } from "node:crypto";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const DATABASE_FILE = "shore.db";
export const databasePath = (data: string): string => join(data, DATABASE_FILE);

const importRowsSchema = (table: string, ifNotExists = false) => `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
  kind TEXT NOT NULL,
  table_name TEXT NOT NULL,
  digest BLOB NOT NULL CHECK(typeof(digest) = 'blob' AND length(digest) = 32),
  occurrence INTEGER NOT NULL,
  target_id INTEGER,
  PRIMARY KEY(kind, table_name, digest, occurrence)
) WITHOUT ROWID;`;

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
${importRowsSchema("storage_import_rows", true)}
`;

export function openStorage(data: string): Database {
  mkdirSync(data, { recursive: true });
  const db = new Database(databasePath(data), { create: true });
  try {
    chmodSync(databasePath(data), 0o600);
    db.run("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    db.run(STORAGE_SCHEMA);
    migrateImportRows(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrateImportRows(db: Database): void {
  const column = db.query("SELECT type FROM pragma_table_info('storage_import_rows') WHERE name = 'digest'").get() as { type: string };
  const table = db.query("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = 'storage_import_rows'").get() as { wr: number };
  if (column.type === "BLOB" && table.wr === 1) return;
  db.transaction(() => {
    db.run(importRowsSchema("storage_import_rows_compact"));
    const insert = db.query("INSERT INTO storage_import_rows_compact VALUES (?1, ?2, ?3, ?4, ?5)");
    const rows = db.query("SELECT kind, table_name, digest, occurrence, target_id FROM storage_import_rows").iterate() as Iterable<{
      kind: string; table_name: string; digest: string | Uint8Array; occurrence: number; target_id: number | null;
    }>;
    for (const row of rows) {
      const digest = typeof row.digest === "string" && /^[0-9a-f]{64}$/i.test(row.digest)
        ? Buffer.from(row.digest, "hex") : row.digest;
      if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
        throw new Error("Invalid storage import digest; refusing to discard migration records");
      }
      insert.run(row.kind, row.table_name, digest, row.occurrence, row.target_id);
    }
    db.run("DROP TABLE storage_import_rows; ALTER TABLE storage_import_rows_compact RENAME TO storage_import_rows;");
  })();
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
  const content = withStorage(data, (db) => {
    const read = () => db.query("SELECT content FROM state_files WHERE path = ?1").get(path) as { content: Uint8Array } | null;
    let row = read();
    if (row === null && existsSync(legacy)) {
      db.query("INSERT OR IGNORE INTO state_files(path, character, content) VALUES (?1, ?2, ?3)")
        .run(path, character, pack(readFileSync(legacy, "utf8")));
      row = read();
    }
    return row === null ? undefined : unpack(row.content);
  });
  if (content !== undefined) retireLegacyFile(legacy, content, data);
  return content;
}

export function retireLegacyFile(path: string, authoritative: string, data = dirname(path)): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  if (content === authoritative) unlinkSync(path);
  else {
    const dir = join(data, "legacy-conflicts");
    mkdirSync(dir, { recursive: true });
    const digest = createHash("sha256").update(path).update("\0").update(content).digest("hex");
    renameSync(path, join(dir, `${basename(path)}.legacy-conflict-${digest}`));
  }
}

export function writeState(data: string, path: string, content: string, character = ""): void {
  if (existsSync(join(data, path))) readState(data, path, character);
  withStorage(data, (db) => {
    db.query(`INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)
      ON CONFLICT(path) DO UPDATE SET character = excluded.character, content = excluded.content`)
      .run(path, character, pack(content));
  });
  const legacy = join(data, path);
  retireLegacyFile(legacy, content, data);
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
