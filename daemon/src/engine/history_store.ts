import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { deriveContentFromBlocks, normalizeMessage } from "./message_store.ts";
import type {
  ContentBlock,
  ImageRef,
  Message,
  MessageAlternative,
  MessageOrigin,
} from "./types.ts";

export const HISTORY_DB_FILE = "history.db";

export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS history_blobs (
    hash       TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    compressed INTEGER NOT NULL,
    data       BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS history_segments (
    character     TEXT    NOT NULL,
    idx           INTEGER NOT NULL,
    file          TEXT    NOT NULL,
    message_count INTEGER NOT NULL,
    compacted_at  TEXT    NOT NULL,
    compaction_id TEXT,
    committed     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (character, idx)
);

CREATE TABLE IF NOT EXISTS history_pending (
    character  TEXT PRIMARY KEY,
    segment    INTEGER NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character    TEXT    NOT NULL,
    segment      INTEGER NOT NULL,
    ordinal      INTEGER NOT NULL,
    msg_id       TEXT    NOT NULL,
    role         TEXT    NOT NULL,
    timestamp    TEXT    NOT NULL,
    provider_key TEXT,
    model        TEXT,
    origin       TEXT,
    alt_index    INTEGER,
    alt_count    INTEGER,
    images       TEXT,
    blocks_hash  TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_history_messages_slot
    ON history_messages (character, segment, ordinal);

CREATE TABLE IF NOT EXISTS history_alternatives (
    message_id   INTEGER NOT NULL,
    ordinal      INTEGER NOT NULL,
    timestamp    TEXT    NOT NULL,
    provider_key TEXT,
    model        TEXT,
    images       TEXT,
    blocks_hash  TEXT    NOT NULL,
    PRIMARY KEY (message_id, ordinal)
);
`;

export interface SegmentEntry {
  file: string;
  message_count: number;
  compacted_at: string;
  compaction_id?: string;
}

const ZSTD_LEVEL = 3;
const BLOB_RAW_UNDER = 256;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8");

interface BodyRow {
  images: string | null;
  blocks_hash: string;
  timestamp: string;
  provider_key: string | null;
  model: string | null;
}

export class HistoryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;`);
    db.exec(HISTORY_SCHEMA);
    migrate(db);
  }

  static open(path: string): HistoryStore {
    const store = new HistoryStore(new Database(path, { create: true, readwrite: true }));
    try {
      chmodSync(path, 0o600);
    } catch {}
    return store;
  }

  static openInMemory(): HistoryStore {
    return new HistoryStore(new Database(":memory:"));
  }

  close(): void {
    this.#db.close();
  }

  putSegment(character: string, idx: number, entry: SegmentEntry, messages: Message[]): void {
    this.#db.transaction(() => {
      this.#replaceSegment(character, idx, entry, messages, true);
      this.#collectGarbage();
    })();
  }

  beginCompaction(
    character: string,
    entry: SegmentEntry,
    messages: Message[],
    activeBefore: string,
    activeAfter: string,
  ): number {
    return this.#db.transaction(() => {
      const pending = this.#db
        .query("SELECT 1 FROM history_pending WHERE character = ?1")
        .get(character);
      if (pending !== null) throw new PendingCompaction(character);
      const row = this.#db
        .query("SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM history_segments WHERE character = ?1")
        .get(character) as { idx: number };
      const idx = row.idx;
      this.#replaceSegment(character, idx, entry, messages, false);
      this.#db
        .query(
          `INSERT INTO history_pending (character, segment, before_hash, after_hash)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .run(character, idx, textHash(activeBefore), textHash(activeAfter));
      return idx;
    })();
  }

  finishCompaction(character: string, idx: number): void {
    this.#db.transaction(() => {
      this.#db
        .query("UPDATE history_segments SET committed = 1 WHERE character = ?1 AND idx = ?2")
        .run(character, idx);
      this.#db
        .query("DELETE FROM history_pending WHERE character = ?1 AND segment = ?2")
        .run(character, idx);
    })();
  }

  abortCompaction(character: string, idx: number): void {
    this.#db.transaction(() => {
      this.#deleteSegment(character, idx);
      this.#db
        .query("DELETE FROM history_pending WHERE character = ?1 AND segment = ?2")
        .run(character, idx);
      this.#collectGarbage();
    })();
  }

  recoverPending(character: string, activeContent: string): void {
    const row = this.#db
      .query(
        `SELECT segment, before_hash, after_hash FROM history_pending
         WHERE character = ?1`,
      )
      .get(character) as
      | { segment: number; before_hash: string; after_hash: string }
      | null;
    if (row === null) return;
    const actual = textHash(activeContent);
    if (actual === row.after_hash) {
      this.finishCompaction(character, row.segment);
      return;
    }
    if (actual === row.before_hash) {
      this.abortCompaction(character, row.segment);
      return;
    }
    throw new PendingCompactionConflict(character);
  }

  hasSegment(character: string, idx: number): boolean {
    return this.#db
      .query(
        `SELECT 1 FROM history_segments
         WHERE character = ?1 AND idx = ?2 AND committed = 1`,
      )
      .get(character, idx) !== null;
  }

  hasCompactionOperation(character: string, operationId: string): boolean {
    return this.#db
      .query(
        `SELECT 1 FROM history_segments
         WHERE character = ?1 AND compaction_id = ?2 AND committed = 1`,
      )
      .get(character, operationId) !== null;
  }

  segmentCount(character: string): number {
    const row = this.#db
      .query(
        "SELECT COUNT(*) AS n FROM history_segments WHERE character = ?1 AND committed = 1",
      )
      .get(character) as { n: number };
    return row.n;
  }

  totalMessageCount(character: string): number {
    const row = this.#db
      .query(
        `SELECT COALESCE(SUM(message_count), 0) AS n FROM history_segments
         WHERE character = ?1 AND committed = 1`,
      )
      .get(character) as { n: number };
    return row.n;
  }

  archiveDigest(character: string): string {
    const rows = this.#db
      .query(
        `SELECT m.segment, m.ordinal, m.msg_id, m.blocks_hash FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND s.committed = 1
         ORDER BY m.segment, m.ordinal`,
      )
      .all(character) as {
      segment: number;
      ordinal: number;
      msg_id: string;
      blocks_hash: string;
    }[];
    const digest = createHash("sha256");
    for (const row of rows) {
      digest.update(`${row.segment}:${row.ordinal}:${row.msg_id}:${row.blocks_hash}\n`);
    }
    return `${rows.length}:${digest.digest("hex")}`;
  }

  entries(character: string): SegmentEntry[] {
    const rows = this.#db
      .query(
        `SELECT file, message_count, compacted_at, compaction_id FROM history_segments
         WHERE character = ?1 AND committed = 1 ORDER BY idx`,
      )
      .all(character) as (Omit<SegmentEntry, "compaction_id"> & {
      compaction_id: string | null;
    })[];
    return rows.map((row) => ({
      file: row.file,
      message_count: row.message_count,
      compacted_at: row.compacted_at,
      ...(row.compaction_id === null ? {} : { compaction_id: row.compaction_id }),
    }));
  }

  readSegment(character: string, idx: number): Message[] {
    const rows = this.#db
      .query(
        `SELECT id, msg_id, role, timestamp, provider_key, model, origin,
                alt_index, alt_count, images, blocks_hash
         FROM history_messages
         WHERE character = ?1 AND segment = ?2
           AND EXISTS (
             SELECT 1 FROM history_segments
             WHERE character = ?1 AND idx = ?2 AND committed = 1
           )
         ORDER BY ordinal`,
      )
      .all(character, idx) as (BodyRow & {
      id: number;
      msg_id: string;
      role: Message["role"];
      origin: MessageOrigin | null;
      alt_index: number | null;
      alt_count: number | null;
    })[];

    const altQuery = this.#db.query(
      `SELECT timestamp, provider_key, model, images, blocks_hash
       FROM history_alternatives WHERE message_id = ?1 ORDER BY ordinal`,
    );

    return rows.map((row) => {
      const { blocks, images, content } = this.#body(row);
      const message: Message = {
        msg_id: row.msg_id,
        role: row.role,
        content,
        images,
        content_blocks: blocks,
        timestamp: row.timestamp,
      };
      if (row.alt_index !== null) message.alt_index = row.alt_index;
      if (row.alt_count !== null) message.alt_count = row.alt_count;
      if (row.provider_key !== null) message.provider_key = row.provider_key;
      if (row.model !== null) message.model = row.model;
      if (row.origin !== null) message.origin = row.origin;

      const altRows = altQuery.all(row.id) as BodyRow[];
      if (altRows.length > 0) {
        message.alternatives = altRows.map((alt) => this.#alternative(alt));
      }
      return normalizeMessage(message);
    });
  }

  #insertMessage(character: string, segment: number, ordinal: number, message: Message): void {
    const blocksHash = this.#storeBlob(utf8.encode(JSON.stringify(message.content_blocks)));
    this.#db
      .query(
        `INSERT INTO history_messages
             (character, segment, ordinal, msg_id, role, timestamp,
              provider_key, model, origin, alt_index, alt_count, images, blocks_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .run(
        character,
        segment,
        ordinal,
        message.msg_id,
        message.role,
        message.timestamp,
        message.provider_key ?? null,
        message.model ?? null,
        message.origin ?? null,
        message.alt_index ?? null,
        message.alt_count ?? null,
        imagesColumn(message.images),
        blocksHash,
      );

    if (message.alternatives === undefined || message.alternatives.length === 0) return;
    const messageId = (this.#db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
      .id;
    const insertAlt = this.#db.query(
      `INSERT INTO history_alternatives
           (message_id, ordinal, timestamp, provider_key, model, images, blocks_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    );
    message.alternatives.forEach((alternative, altOrdinal) => {
      insertAlt.run(
        messageId,
        altOrdinal,
        alternative.timestamp,
        alternative.provider_key ?? null,
        alternative.model ?? null,
        imagesColumn(alternative.images),
        this.#storeBlob(utf8.encode(JSON.stringify(alternative.content_blocks))),
      );
    });
  }

  #replaceSegment(
    character: string,
    idx: number,
    entry: SegmentEntry,
    messages: Message[],
    committed: boolean,
  ): void {
    this.#deleteSegment(character, idx);
    this.#db
      .query(
        `INSERT INTO history_segments
             (character, idx, file, message_count, compacted_at, compaction_id, committed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (character, idx) DO UPDATE SET
           file = excluded.file,
           message_count = excluded.message_count,
           compacted_at = excluded.compacted_at,
           compaction_id = excluded.compaction_id,
           committed = excluded.committed`,
      )
      .run(
        character,
        idx,
        entry.file,
        entry.message_count,
        entry.compacted_at,
        entry.compaction_id ?? null,
        committed ? 1 : 0,
      );
    messages.forEach((message, ordinal) => {
      this.#insertMessage(character, idx, ordinal, normalizeMessage(message));
    });
  }

  #deleteSegment(character: string, idx: number): void {
    const stale = this.#db
      .query("SELECT id FROM history_messages WHERE character = ?1 AND segment = ?2")
      .all(character, idx) as { id: number }[];
    const dropAlts = this.#db.query("DELETE FROM history_alternatives WHERE message_id = ?1");
    for (const row of stale) dropAlts.run(row.id);
    this.#db
      .query("DELETE FROM history_messages WHERE character = ?1 AND segment = ?2")
      .run(character, idx);
    this.#db
      .query("DELETE FROM history_segments WHERE character = ?1 AND idx = ?2")
      .run(character, idx);
  }

  #alternative(row: BodyRow): MessageAlternative {
    const body = this.#body(row);
    return {
      content: body.content,
      images: body.images,
      content_blocks: body.blocks,
      timestamp: row.timestamp,
      ...(row.provider_key === null ? {} : { provider_key: row.provider_key }),
      ...(row.model === null ? {} : { model: row.model }),
    };
  }

  #body(row: BodyRow): { blocks: ContentBlock[]; images: ImageRef[]; content: string } {
    const bytes = this.#loadBlob(row.blocks_hash);
    if (bytes === null) throw new MissingBody(row.blocks_hash);
    const blocks = JSON.parse(decoder.decode(bytes)) as ContentBlock[];
    const images = row.images === null ? [] : (JSON.parse(row.images) as ImageRef[]);
    return { blocks, images, content: deriveContentFromBlocks(blocks, true) };
  }

  #storeBlob(bytes: Uint8Array): string {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const compressed = bytes.byteLength >= BLOB_RAW_UNDER;
    const data = compressed
      ? zstdCompressSync(bytes, { params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
      : bytes;
    this.#db
      .query(
        `INSERT OR IGNORE INTO history_blobs (hash, size, compressed, data)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .run(hash, bytes.byteLength, compressed ? 1 : 0, data);
    return hash;
  }

  #loadBlob(hash: string): Uint8Array | null {
    const row = this.#db
      .query("SELECT size, compressed, data FROM history_blobs WHERE hash = ?1")
      .get(hash) as { size: number; compressed: number; data: Uint8Array } | null;
    if (row === null) return null;
    const bytes = row.compressed === 0 ? row.data : zstdDecompressSync(row.data);
    return bytes.byteLength === row.size ? bytes : null;
  }

  #collectGarbage(): void {
    this.#db.exec(`DELETE FROM history_blobs
                   WHERE hash NOT IN (
                     SELECT blocks_hash FROM history_messages
                     UNION SELECT blocks_hash FROM history_alternatives
                   )`);
  }
}

function imagesColumn(images: ImageRef[] | undefined): string | null {
  return images === undefined || images.length === 0 ? null : JSON.stringify(images);
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function migrate(db: Database): void {
  const columns = db.query("PRAGMA table_info(history_segments)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "compaction_id")) {
    db.exec("ALTER TABLE history_segments ADD COLUMN compaction_id TEXT");
  }
  if (!columns.some((column) => column.name === "committed")) {
    db.exec("ALTER TABLE history_segments ADD COLUMN committed INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_history_segments_operation
           ON history_segments (character, compaction_id)
           WHERE compaction_id IS NOT NULL`);
  const oldBlobs = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blobs'")
    .get();
  if (oldBlobs !== null) {
    db.exec(`INSERT OR IGNORE INTO history_blobs (hash, size, compressed, data)
             SELECT hash, size, compressed, data FROM blobs`);
  }
}

export class MissingBody extends Error {
  constructor(hash: string) {
    super(`history blob ${hash} is missing`);
    this.name = "MissingBody";
  }
}

export class PendingCompaction extends Error {
  constructor(character: string) {
    super(`history compaction is already pending for ${character}`);
    this.name = "PendingCompaction";
  }
}

export class PendingCompactionConflict extends Error {
  constructor(character: string) {
    super(`cannot recover the pending history compaction for ${character}: active history changed`);
    this.name = "PendingCompactionConflict";
  }
}
