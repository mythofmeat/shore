import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKSPACE_INDEX_DB_FILE = "workspace_index.db";
export const WORKSPACE_INDEX_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE files (
  display_path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  modified_at_secs INTEGER NOT NULL,
  document_hash TEXT NOT NULL,
  embed_chars INTEGER NOT NULL,
  embedded INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX files_document ON files(document_hash);
CREATE TABLE embeddings (
  document_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY(document_hash, model, dimensions)
);
`;

export interface FileRow {
  display_path: string;
  size: number;
  modified_at_secs: number;
  document_hash: string;
  embed_chars: number;
  embedded: boolean;
  reason: string | undefined;
}

export interface WorkspaceIndexStats {
  files: number;
  embedded: number;
  pending: number;
  skipped: number;
  skipReasons: Record<string, number>;
  vectors: number;
  models: string[];
  bytes: number;
  lastIndexedAt: string | undefined;
  unusableReason: string | undefined;
}

export function workspaceIndexDbPath(cacheDir: string, character: string): string {
  return join(cacheDir, "characters", character, WORKSPACE_INDEX_DB_FILE);
}

export function documentHash(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}

export function vectorToBytes(vector: readonly number[]): Uint8Array {
  const floats = new Float32Array(vector.length);
  vector.forEach((value, i) => {
    floats[i] = Math.fround(value);
  });
  return new Uint8Array(floats.buffer.slice(0));
}

export function bytesToVector(bytes: Uint8Array): Float32Array {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

function removeCacheFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      unlinkSync(candidate);
    } catch {}
  }
}

const SQLITE_MAGIC = "SQLite format 3\0";

export function occupiedByForeignFile(path: string): boolean {
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) return true;
    size = info.size;
  } catch {
    return false;
  }
  if (size === 0) return false;

  const head = Buffer.alloc(SQLITE_MAGIC.length);
  let read = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    read = readSync(fd, head, 0, head.length, 0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  return read < head.length || head.toString("latin1") !== SQLITE_MAGIC;
}

const storeLocks = new Map<string, Promise<void>>();

export async function withWorkspaceIndexLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prior = storeLocks.get(path);
  const started = prior === undefined ? run() : prior.then(run);
  const settled = started.then(
    () => undefined,
    () => undefined,
  );
  storeLocks.set(path, settled);
  try {
    return await started;
  } finally {
    if (storeLocks.get(path) === settled) storeLocks.delete(path);
  }
}

export class WorkspaceIndexStore {
  readonly path: string;
  readonly unusableReason: string | undefined;
  #db: Database;

  private constructor(path: string, db: Database, unusableReason?: string) {
    this.path = path;
    this.unusableReason = unusableReason;
    this.#db = db;
  }

  static open(path: string): WorkspaceIndexStore {
    if (occupiedByForeignFile(path)) {
      return WorkspaceIndexStore.#inMemory(
        path,
        "it already holds something that is not a SQLite database, and shore will not overwrite it",
      );
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {}
    let db: Database | undefined;
    try {
      db = new Database(path, { create: true, readwrite: true });
      const version = Number(
        (db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ??
          0,
      );
      if (version !== WORKSPACE_INDEX_SCHEMA_VERSION) {
        db.close();
        db = undefined;
        removeCacheFiles(path);
        db = new Database(path, { create: true, readwrite: true });
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${WORKSPACE_INDEX_SCHEMA_VERSION}`);
      }
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      try {
        chmodSync(path, 0o600);
      } catch {}
      return new WorkspaceIndexStore(path, db);
    } catch {
      try {
        db?.close();
      } catch {}
      removeCacheFiles(path);
      return WorkspaceIndexStore.#rebuild(path);
    }
  }

  static #rebuild(path: string): WorkspaceIndexStore {
    try {
      const db = new Database(path, { create: true, readwrite: true });
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${WORKSPACE_INDEX_SCHEMA_VERSION}`);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      try {
        chmodSync(path, 0o600);
      } catch {}
      return new WorkspaceIndexStore(path, db);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      return WorkspaceIndexStore.#inMemory(path, `it cannot hold a database: ${cause}`);
    }
  }

  static #inMemory(path: string, reason: string): WorkspaceIndexStore {
    console.warn(
      `shore: the workspace index at ${path} is unusable, so search is running on a ` +
        `throwaway in-memory index that is discarded when the daemon stops: ${reason}`,
    );
    const db = new Database(":memory:", { create: true, readwrite: true });
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${WORKSPACE_INDEX_SCHEMA_VERSION}`);
    return new WorkspaceIndexStore(path, db, reason);
  }

  close(): void {
    try {
      this.#db.close();
    } catch {}
  }

  files(): Map<string, FileRow> {
    const rows = this.#db
      .query(
        `SELECT display_path, size, modified_at_secs, document_hash, embed_chars, embedded, reason
         FROM files`,
      )
      .all() as {
      display_path: string;
      size: number;
      modified_at_secs: number;
      document_hash: string;
      embed_chars: number;
      embedded: number;
      reason: string | null;
    }[];
    const out = new Map<string, FileRow>();
    for (const row of rows) {
      out.set(row.display_path, {
        display_path: row.display_path,
        size: row.size,
        modified_at_secs: row.modified_at_secs,
        document_hash: row.document_hash,
        embed_chars: row.embed_chars,
        embedded: row.embedded === 1,
        reason: row.reason ?? undefined,
      });
    }
    return out;
  }

  vectorsFor(model: string, hashes: readonly string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    if (hashes.length === 0) return out;
    const unique = [...new Set(hashes)];
    const chunk = 512;
    for (let start = 0; start < unique.length; start += chunk) {
      const slice = unique.slice(start, start + chunk);
      const holes = slice.map((_, i) => `?${i + 2}`).join(",");
      const rows = this.#db
        .query(
          `SELECT document_hash, vector FROM embeddings
           WHERE model = ?1 AND document_hash IN (${holes})`,
        )
        .all(model, ...slice) as { document_hash: string; vector: Uint8Array }[];
      for (const row of rows) out.set(row.document_hash, bytesToVector(row.vector));
    }
    return out;
  }

  hasVector(model: string, hash: string): boolean {
    const row = this.#db
      .query("SELECT 1 AS present FROM embeddings WHERE model = ?1 AND document_hash = ?2")
      .get(model, hash) as { present: number } | null;
    return row !== null;
  }

  putFiles(rows: readonly FileRow[]): void {
    if (rows.length === 0) return;
    const put = this.#db.query(
      `INSERT INTO files
         (display_path, size, modified_at_secs, document_hash, embed_chars, embedded, reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(display_path) DO UPDATE SET
         size = excluded.size,
         modified_at_secs = excluded.modified_at_secs,
         document_hash = excluded.document_hash,
         embed_chars = excluded.embed_chars,
         embedded = excluded.embedded,
         reason = excluded.reason`,
    );
    this.#db.transaction(() => {
      for (const row of rows) {
        put.run(
          row.display_path,
          row.size,
          row.modified_at_secs,
          row.document_hash,
          row.embed_chars,
          row.embedded ? 1 : 0,
          row.reason ?? null,
        );
      }
    })();
  }

  deleteFiles(paths: readonly string[]): void {
    if (paths.length === 0) return;
    const drop = this.#db.query("DELETE FROM files WHERE display_path = ?1");
    this.#db.transaction(() => {
      for (const path of paths) drop.run(path);
    })();
  }

  putEmbeddings(
    model: string,
    entries: readonly { hash: string; vector: readonly number[] }[],
  ): void {
    if (entries.length === 0) return;
    const put = this.#db.query(
      `INSERT OR REPLACE INTO embeddings(document_hash, model, dimensions, vector)
       VALUES (?1, ?2, ?3, ?4)`,
    );
    this.#db.transaction(() => {
      for (const entry of entries) {
        put.run(entry.hash, model, entry.vector.length, vectorToBytes(entry.vector));
      }
    })();
  }

  pruneEmbeddings(): number {
    const result = this.#db
      .query(
        `DELETE FROM embeddings
         WHERE document_hash NOT IN (SELECT document_hash FROM files WHERE embedded = 1)`,
      )
      .run();
    return Number(result.changes ?? 0);
  }

  metadata(key: string): string | undefined {
    const row = this.#db.query("SELECT value FROM metadata WHERE key = ?1").get(key) as
      | { value: string }
      | null;
    return row?.value;
  }

  setMetadata(key: string, value: string): void {
    this.#db
      .query("INSERT OR REPLACE INTO metadata(key, value) VALUES (?1, ?2)")
      .run(key, value);
  }

  stats(): WorkspaceIndexStats {
    const files = this.#db.query("SELECT COUNT(*) AS n FROM files").get() as { n: number };
    const embedded = this.#db
      .query("SELECT COUNT(*) AS n FROM files WHERE embedded = 1")
      .get() as { n: number };
    const reasons = this.#db
      .query(
        `SELECT COALESCE(reason, 'unembedded') AS reason, COUNT(*) AS n
         FROM files WHERE embedded = 0 GROUP BY reason`,
      )
      .all() as { reason: string; n: number }[];
    const vectors = this.#db.query("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    const models = this.#db.query("SELECT DISTINCT model FROM embeddings ORDER BY model").all() as {
      model: string;
    }[];

    const skipReasons: Record<string, number> = {};
    let skipped = 0;
    let pending = 0;
    for (const row of reasons) {
      if (row.reason === "unembedded") pending += row.n;
      else {
        skipReasons[row.reason] = row.n;
        skipped += row.n;
      }
    }

    let bytes = 0;
    if (this.unusableReason === undefined) {
      for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
        try {
          bytes += statSync(candidate).size;
        } catch {}
      }
    }

    return {
      files: files.n,
      embedded: embedded.n,
      pending,
      skipped,
      skipReasons,
      vectors: vectors.n,
      models: models.map((m) => m.model),
      bytes,
      lastIndexedAt: this.metadata("last_indexed_at"),
      unusableReason: this.unusableReason,
    };
  }
}
