import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  deriveContentFromBlocks,
  normalizeMessage,
} from "./message_store.ts";
import { alternativeVersionOf, versionOf } from "./versions.ts";
import { imageBlobs, imageCacheFor, withImageData, withImageReferences, type ImageBlobs } from "../storage/image_blobs.ts";
import { required } from "../util/required.ts";
import type {
  ContentBlock,
  ImageRef,
  Message,
  MessageAlternative,
  MessageOrigin,
} from "./types.ts";

export const HISTORY_DB_FILE = "shore.db";

const bumpRevision = (source: "NEW" | "OLD") =>
  `INSERT INTO history_archive_revision(character, revision) VALUES (${source}.character, 1)
     ON CONFLICT(character) DO UPDATE SET revision = revision + 1;`;

const ARCHIVE_REVISION_TRIGGERS = [
  ["messages_insert", "AFTER INSERT ON history_messages", "NEW"],
  ["messages_delete", "AFTER DELETE ON history_messages", "OLD"],
  [
    "messages_update",
    "AFTER UPDATE OF segment, ordinal, msg_id, blocks_hash ON history_messages",
    "NEW",
  ],
  ["segments_insert", "AFTER INSERT ON history_segments", "NEW"],
  ["segments_delete", "AFTER DELETE ON history_segments", "OLD"],
  ["segments_update", "AFTER UPDATE OF committed, excluded ON history_segments", "NEW"],
].map(([name, event, source]) =>
  `CREATE TRIGGER IF NOT EXISTS trg_archive_revision_${name} ${event} BEGIN
  ${bumpRevision(source as "NEW" | "OLD")}
END;`
).join("\n\n");

const HISTORY_SCHEMA = `
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
    memory_before TEXT,
    memory_after  TEXT,
    excluded      INTEGER NOT NULL DEFAULT 0,
    label         TEXT,
    note          TEXT,
    PRIMARY KEY (character, idx)
);

CREATE TABLE IF NOT EXISTS history_pending (
    character  TEXT PRIMARY KEY,
    segment    INTEGER NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash  TEXT NOT NULL,
    coverage_claim TEXT
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
    blocks_hash  TEXT    NOT NULL,
    display_kind INTEGER NOT NULL,
    display_seq  INTEGER,
    is_user_turn INTEGER NOT NULL,
    version      TEXT
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
    version      TEXT,
    PRIMARY KEY (message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS history_thread_forks (
    character     TEXT    NOT NULL,
    fork_id       TEXT    NOT NULL,
    child         TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    created_at    TEXT    NOT NULL,
    message_count INTEGER NOT NULL,
    turn_count    INTEGER NOT NULL,
    PRIMARY KEY (character, fork_id)
);

CREATE INDEX IF NOT EXISTS idx_history_thread_forks_child
    ON history_thread_forks (character, child);

CREATE TABLE IF NOT EXISTS memory_coverage (
    character  TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    version    TEXT    NOT NULL,
    state      TEXT    NOT NULL,
    unit       TEXT,
    claim      TEXT,
    claimed_at INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (character, path, version)
);

CREATE INDEX IF NOT EXISTS idx_memory_coverage_claim
    ON memory_coverage (character, path, state, claimed_at);

DROP TABLE IF EXISTS history_character_stats;

CREATE TABLE IF NOT EXISTS history_archive_revision (
    character TEXT PRIMARY KEY,
    revision  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_messages_version ON history_messages (character, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_segments_operation ON history_segments (character, compaction_id) WHERE compaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_history_messages_display ON history_messages (character, display_seq, segment, ordinal);
CREATE INDEX IF NOT EXISTS idx_history_messages_turn ON history_messages (character, is_user_turn, display_seq);
${ARCHIVE_REVISION_TRIGGERS}
`;

export interface SegmentEntry {
  file: string;
  message_count: number;
  compacted_at: string;
  compaction_id?: string;
  memory_before?: string;
  memory_after?: string;
  excluded?: boolean;
  label?: string;
  note?: string;
}

export interface SegmentRecord extends SegmentEntry {
  idx: number;
  first_message_at: string | null;
  last_message_at: string | null;
}

export type MemoryPath = "compaction";

export interface ThreadForkRecord {
  fork_id: string;
  child: string;
  source: string;
  created_at: string;
  message_count: number;
  turn_count: number;
}

export const CHARACTER_ARCHIVES_SQL = "(character = ?1 OR substr(character, 1, length(?1) + 1) = ?1 || '/')";

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
  version: string | null;
}

interface MessageRow extends BodyRow {
  id: number;
  msg_id: string;
  role: Message["role"];
  origin: MessageOrigin | null;
  alt_index: number | null;
  alt_count: number | null;
  segment: number;
}

export interface HistoryReadMetrics {
  segments_read: number;
  rows_read: number;
  decoded_body_bytes: number;
}

export interface HistoryDisplayBounds {
  start: number;
  end: number;
}

export interface HistoryDisplaySlice {
  messages: Message[];
  metrics: HistoryReadMetrics;
}

const DISPLAY_OTHER = 0;
const DISPLAY_ASSISTANT = 1;
const DISPLAY_TOOL_ASSISTANT = 2;
const DISPLAY_TOOL_RESULT = 3;

export class HistoryStore {
  readonly #db: Database;
  readonly #data: string | undefined;

  constructor(db: Database, data?: string) {
    this.#db = db;
    this.#data = data;
    db.run(`PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;`);
    db.run(HISTORY_SCHEMA);
  }

  static open(path: string): HistoryStore {
    const store = new HistoryStore(new Database(path, { create: true, readwrite: true }), dirname(path));
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
    coverageClaim?: string,
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
          `INSERT INTO history_pending (character, segment, before_hash, after_hash, coverage_claim)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .run(character, idx, textHash(activeBefore), textHash(activeAfter), coverageClaim ?? null);
      return idx;
    })();
  }

  finishCompaction(character: string, idx: number): void {
    this.#db.transaction(() => {
      const pending = this.#db
        .query(
          "SELECT coverage_claim FROM history_pending WHERE character = ?1 AND segment = ?2",
        )
        .get(character, idx) as { coverage_claim: string | null } | null;
      this.#db
        .query("UPDATE history_segments SET committed = 1 WHERE character = ?1 AND idx = ?2")
        .run(character, idx);
      this.#db
        .query("DELETE FROM history_pending WHERE character = ?1 AND segment = ?2")
        .run(character, idx);
      if (pending?.coverage_claim !== null && pending?.coverage_claim !== undefined) {
        this.commitMemoryCoverage(
          characterOfArchiveKey(character),
          "compaction",
          pending.coverage_claim,
        );
      }
    })();
  }

  abortCompaction(character: string, idx: number): void {
    this.#db.transaction(() => {
      const pending = this.#db
        .query(
          "SELECT coverage_claim FROM history_pending WHERE character = ?1 AND segment = ?2",
        )
        .get(character, idx) as { coverage_claim: string | null } | null;
      this.#deleteSegment(character, idx);
      this.#db
        .query("DELETE FROM history_pending WHERE character = ?1 AND segment = ?2")
        .run(character, idx);
      if (pending?.coverage_claim !== null && pending?.coverage_claim !== undefined) {
        this.releaseMemoryCoverage(
          characterOfArchiveKey(character),
          "compaction",
          pending.coverage_claim,
        );
      }
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

  pendingCompactionSegment(character: string): number | undefined {
    const row = this.#db
      .query("SELECT segment FROM history_pending WHERE character = ?1")
      .get(character) as { segment: number } | null;
    return row?.segment ?? undefined;
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

  segmentDisplayBounds(character: string, idx: number): HistoryDisplayBounds | undefined {
    const row = this.#db
      .query(
        `SELECT MIN(m.display_seq) AS first, MAX(m.display_seq) AS last
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1
           AND m.display_seq IS NOT NULL`,
      )
      .get(character, idx) as { first: number | null; last: number | null };
    if (row.first === null || row.last === null) return undefined;
    return { start: row.first, end: row.last + 1 };
  }

  segmentTurnCount(character: string, idx: number): number {
    return this.#committedSegmentTurnCount(character, idx);
  }

  segmentStartForTurns(character: string, idx: number, end: number, turns: number): number {
    if (turns <= 0) return end;
    const row = this.#db
      .query(
        `SELECT m.display_seq
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1 AND m.is_user_turn = 1
           AND m.display_seq < ?3
         ORDER BY m.display_seq DESC
         LIMIT 1 OFFSET ?4`,
      )
      .get(character, idx, end, turns - 1) as { display_seq: number } | null;
    return row?.display_seq ?? 0;
  }

  archiveDigest(character: string): string {
    const row = this.#db
      .query("SELECT revision FROM history_archive_revision WHERE character = ?1")
      .get(character) as { revision: number } | null;
    return `rev:${row?.revision ?? 0}`;
  }

  entries(character: string): SegmentRecord[] {
    return this.#segmentRecords("ORDER BY s.idx", character);
  }

  entry(character: string, idx: number): SegmentRecord | undefined {
    return this.#segmentRecords("AND s.idx = ?2", character, idx)[0];
  }

  latestEntry(character: string): SegmentRecord | undefined {
    return this.#segmentRecords("ORDER BY s.idx DESC LIMIT 1", character)[0];
  }

  entryBefore(character: string, idx: number): SegmentRecord | undefined {
    return this.#segmentRecords("AND s.idx < ?2 ORDER BY s.idx DESC LIMIT 1", character, idx)[0];
  }

  entryAfter(character: string, idx: number): SegmentRecord | undefined {
    return this.#segmentRecords("AND s.idx > ?2 ORDER BY s.idx LIMIT 1", character, idx)[0];
  }

  #segmentRecords(clause: string, character: string, idx?: number): SegmentRecord[] {
    const query = this.#db.query(
      `SELECT s.idx, s.file, s.message_count, s.compacted_at, s.compaction_id,
              s.memory_before, s.memory_after, s.excluded, s.label, s.note,
              (SELECT m.timestamp FROM history_messages m
               WHERE m.character = s.character AND m.segment = s.idx
               ORDER BY m.ordinal ASC LIMIT 1) AS first_message_at,
              (SELECT m.timestamp FROM history_messages m
               WHERE m.character = s.character AND m.segment = s.idx
               ORDER BY m.ordinal DESC LIMIT 1) AS last_message_at
       FROM history_segments s
       WHERE s.character = ?1 AND s.committed = 1 ${clause}`,
    );
    const rows = (idx === undefined ? query.all(character) : query.all(character, idx)) as (Omit<SegmentRecord,
      "compaction_id" | "memory_before" | "memory_after" | "excluded" | "label" | "note"
    > & {
      compaction_id: string | null;
      memory_before: string | null;
      memory_after: string | null;
      excluded: number;
      label: string | null;
      note: string | null;
    })[];
    return rows.map((row) => ({
      idx: row.idx,
      file: row.file,
      message_count: row.message_count,
      compacted_at: row.compacted_at,
      first_message_at: row.first_message_at,
      last_message_at: row.last_message_at,
      ...(row.compaction_id === null ? {} : { compaction_id: row.compaction_id }),
      ...(row.memory_before === null ? {} : { memory_before: row.memory_before }),
      ...(row.memory_after === null ? {} : { memory_after: row.memory_after }),
      ...(row.excluded === 0 ? {} : { excluded: true }),
      ...(row.label === null ? {} : { label: row.label }),
      ...(row.note === null ? {} : { note: row.note }),
    }));
  }

  setExcluded(character: string, idx: number, excluded: boolean): boolean {
    return this.#db.query(
      `UPDATE history_segments SET excluded = ?3
       WHERE character = ?1 AND idx = ?2 AND committed = 1`,
    ).run(character, idx, excluded ? 1 : 0).changes > 0;
  }

  recordThreadFork(character: string, record: ThreadForkRecord): void {
    this.#db
      .query(
        `INSERT INTO history_thread_forks
             (character, fork_id, child, source, created_at, message_count, turn_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (character, fork_id) DO UPDATE SET
           child = excluded.child,
           source = excluded.source,
           created_at = excluded.created_at,
           message_count = excluded.message_count,
           turn_count = excluded.turn_count`,
      )
      .run(
        character,
        record.fork_id,
        record.child,
        record.source,
        record.created_at,
        record.message_count,
        record.turn_count,
      );
  }

  threadForks(character: string): ThreadForkRecord[] {
    return this.#db
      .query(
        `SELECT fork_id, child, source, created_at, message_count, turn_count
         FROM history_thread_forks WHERE character = ?1
         ORDER BY created_at, fork_id`,
      )
      .all(character) as ThreadForkRecord[];
  }

  forgetThreadFork(character: string, forkId: string): void {
    this.#db
      .query("DELETE FROM history_thread_forks WHERE character = ?1 AND fork_id = ?2")
      .run(character, forkId);
  }

  claimMemoryCoverage(
    character: string,
    path: MemoryPath,
    versions: readonly string[],
    claim: string,
    unit: string,
    nowMs: number,
    leaseMs: number,
    stamp = new Date(nowMs).toISOString(),
  ): string[] {
    if (versions.length === 0) return [];
    return this.#db.transaction(() => {
      this.expireMemoryClaims(character, path, nowMs - leaseMs);
      const insert = this.#db.query(
        `INSERT OR IGNORE INTO memory_coverage
             (character, path, version, state, unit, claim, claimed_at, updated_at)
         VALUES (?1, ?2, ?3, 'claimed', ?4, ?5, ?6, ?7)`,
      );
      const wanted = [...new Set(versions)];
      for (const version of wanted) {
        insert.run(character, path, version, unit, claim, nowMs, stamp);
      }
      const marks = wanted.map((_, index) => `?${String(index + 4)}`).join(", ");
      const rows = this.#db
        .query(
          `SELECT version FROM memory_coverage
           WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'
             AND version IN (${marks})`,
        )
        .all(character, path, claim, ...wanted) as { version: string }[];
      const held = new Set(rows.map((row) => row.version));
      return wanted.filter((version) => held.has(version));
    })();
  }

  coveredMemoryVersions(
    character: string,
    path: MemoryPath,
    versions: readonly string[],
  ): Set<string> {
    const wanted = [...new Set(versions)];
    if (wanted.length === 0) return new Set();
    const marks = wanted.map((_, index) => `?${String(index + 3)}`).join(", ");
    const rows = this.#db
      .query(
        `SELECT version FROM memory_coverage
         WHERE character = ?1 AND path = ?2 AND state = 'covered' AND version IN (${marks})`,
      )
      .all(character, path, ...wanted) as { version: string }[];
    return new Set(rows.map((row) => row.version));
  }

  commitMemoryCoverage(
    character: string,
    path: MemoryPath,
    claim: string,
    unit?: string,
    stamp?: string,
  ): number {
    return this.#db
      .query(
        `UPDATE memory_coverage
         SET state = 'covered', claim = NULL, claimed_at = 0, updated_at = ?4,
             unit = CASE WHEN ?5 IS NULL THEN unit ELSE ?5 END
         WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'`,
      )
      .run(character, path, claim, stamp ?? new Date().toISOString(), unit ?? null).changes;
  }

  releaseMemoryCoverage(character: string, path: MemoryPath, claim: string): number {
    return this.#db
      .query(
        `DELETE FROM memory_coverage
         WHERE character = ?1 AND path = ?2 AND claim = ?3 AND state = 'claimed'`,
      )
      .run(character, path, claim).changes;
  }

  expireMemoryClaims(character: string, path: MemoryPath, olderThanMs: number): number {
    return this.#db
      .query(
        `DELETE FROM memory_coverage
         WHERE character = ?1 AND path = ?2 AND state = 'claimed' AND claimed_at < ?3`,
      )
      .run(character, path, olderThanMs).changes;
  }

  archiveKeys(character: string): string[] {
    return (this.#db.query(
      `SELECT DISTINCT s.character FROM history_segments s
       WHERE ${CHARACTER_ARCHIVES_SQL} AND s.committed = 1 ORDER BY s.character`,
    ).all(character) as { character: string }[]).map((row) => row.character);
  }

  setLabel(character: string, idx: number, label: string | null): boolean {
    return this.#db
      .query(
        `UPDATE history_segments SET label = ?3
         WHERE character = ?1 AND idx = ?2 AND committed = 1`,
      )
      .run(character, idx, label).changes > 0;
  }

  setNote(character: string, idx: number, note: string | null): boolean {
    return this.#db
      .query(
        `UPDATE history_segments SET note = ?3
         WHERE character = ?1 AND idx = ?2 AND committed = 1`,
      )
      .run(character, idx, note).changes > 0;
  }

  readSegment(character: string, idx: number): Message[] {
    const rows = this.#db
      .query(
        `SELECT id, msg_id, role, timestamp, provider_key, model, origin, segment,
                alt_index, alt_count, images, blocks_hash, version
         FROM history_messages
         WHERE character = ?1 AND segment = ?2
           AND EXISTS (
             SELECT 1 FROM history_segments
             WHERE character = ?1 AND idx = ?2 AND committed = 1
           )
         ORDER BY ordinal`,
      )
      .all(character, idx) as MessageRow[];

    return this.#messagesFromRows(rows, character);
  }

  readSegmentOrdinals(character: string, idx: number, ordinals: readonly number[]): Map<number, Message> {
    const rows = this.#db
      .query(
        `SELECT id, msg_id, role, timestamp, provider_key, model, origin, segment, ordinal,
                alt_index, alt_count, images, blocks_hash, version
         FROM history_messages
         WHERE character = ?1 AND segment = ?2
           AND ordinal IN (SELECT value FROM json_each(?3))
           AND EXISTS (
             SELECT 1 FROM history_segments
             WHERE character = ?1 AND idx = ?2 AND committed = 1
           )`,
      )
      .all(character, idx, JSON.stringify(ordinals)) as (MessageRow & { ordinal: number })[];

    const messages = this.#messagesFromRows(rows, character);
    return new Map(rows.map((row, i) => [row.ordinal, required(messages[i])]));
  }

  readSegmentDisplayRange(character: string, idx: number, start: number, end: number): HistoryDisplaySlice {
    const metrics: HistoryReadMetrics = {
      segments_read: 0,
      rows_read: 0,
      decoded_body_bytes: 0,
    };
    if (end <= start) return { messages: [], metrics };

    const rows = this.#db
      .query(
        `SELECT m.id, m.msg_id, m.role, m.timestamp, m.provider_key, m.model, m.origin,
                m.segment, m.alt_index, m.alt_count, m.images, m.blocks_hash, m.version
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1
           AND m.display_seq >= ?3 AND m.display_seq < ?4
         ORDER BY m.ordinal`,
      )
      .all(character, idx, start, end) as MessageRow[];

    metrics.rows_read = rows.length;
    metrics.segments_read = rows.length === 0 ? 0 : 1;
    return { messages: this.#messagesFromRows(rows, character, metrics), metrics };
  }

  #messagesFromRows(rows: MessageRow[], character: string, metrics?: HistoryReadMetrics): Message[] {
    const altQuery = this.#db.query(
      `SELECT timestamp, provider_key, model, images, blocks_hash, version
       FROM history_alternatives WHERE message_id = ?1 ORDER BY ordinal`,
    );

    return rows.map((row) => {
      const { blocks, images, content } = this.#body(row, character, metrics);
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
      if (row.version !== null) message.version = row.version;

      const altRows = altQuery.all(row.id) as BodyRow[];
      if (altRows.length > 0) {
        message.alternatives = altRows.map((alt) => this.#alternative(alt, character, metrics));
      }
      return normalizeMessage(message);
    });
  }

  #insertMessage(character: string, segment: number, ordinal: number, message: Message): void {
    const blocksHash = this.#storeBlob(utf8.encode(JSON.stringify(this.#referenced(character, message.content_blocks))));
    const kind = displayKind(message);
    this.#db
      .query(
        `INSERT INTO history_messages
             (character, segment, ordinal, msg_id, role, timestamp,
              provider_key, model, origin, alt_index, alt_count, images, blocks_hash,
              display_kind, display_seq, is_user_turn, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?16)`,
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
        kind,
        message.role === "user" && kind !== DISPLAY_TOOL_RESULT ? 1 : 0,
        versionOf(message) ?? null,
      );

    if (message.alternatives === undefined || message.alternatives.length === 0) return;
    const messageId = (this.#db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
      .id;
    const insertAlt = this.#db.query(
      `INSERT INTO history_alternatives
           (message_id, ordinal, timestamp, provider_key, model, images, blocks_hash, version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    );
    message.alternatives.forEach((alternative, altOrdinal) => {
      insertAlt.run(
        messageId,
        altOrdinal,
        alternative.timestamp,
        alternative.provider_key ?? null,
        alternative.model ?? null,
        imagesColumn(alternative.images),
        this.#storeBlob(utf8.encode(JSON.stringify(this.#referenced(character, alternative.content_blocks)))),
        alternativeVersionOf(alternative) ?? null,
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
    const normalizedMessages = messages.map((message) => normalizeMessage(message));
    this.#deleteSegment(character, idx);
    this.#db
      .query(
        `INSERT INTO history_segments
             (character, idx, file, message_count, compacted_at, compaction_id, committed,
              memory_before, memory_after, excluded, label, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (character, idx) DO UPDATE SET
           file = excluded.file,
           message_count = excluded.message_count,
           compacted_at = excluded.compacted_at,
           compaction_id = excluded.compaction_id,
           committed = excluded.committed,
           memory_before = excluded.memory_before,
           memory_after = excluded.memory_after,
           excluded = excluded.excluded,
           label = excluded.label,
           note = excluded.note`,
      )
      .run(
        character,
        idx,
        entry.file,
        entry.message_count,
        entry.compacted_at,
        entry.compaction_id ?? null,
        committed ? 1 : 0,
        entry.memory_before ?? null,
        entry.memory_after ?? null,
        entry.excluded === true ? 1 : 0,
        entry.label ?? null,
        entry.note ?? null,
      );
    normalizedMessages.forEach((message, ordinal) => {
      this.#insertMessage(character, idx, ordinal, message);
    });
    reindexDisplayMetadata(this.#db, character, idx);
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

  #committedSegmentTurnCount(character: string, idx: number): number {
    const row = this.#db
      .query(
        `SELECT COUNT(*) AS n
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND m.segment = ?2 AND s.committed = 1
           AND m.is_user_turn = 1`,
      )
      .get(character, idx) as { n: number };
    return row.n;
  }

  #alternative(row: BodyRow, character: string, metrics?: HistoryReadMetrics): MessageAlternative {
    const body = this.#body(row, character, metrics);
    return {
      content: body.content,
      images: body.images,
      content_blocks: body.blocks,
      timestamp: row.timestamp,
      ...(row.provider_key === null ? {} : { provider_key: row.provider_key }),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.version === null ? {} : { version: row.version }),
    };
  }

  #body(
    row: BodyRow,
    character: string,
    metrics?: HistoryReadMetrics,
  ): { blocks: ContentBlock[]; images: ImageRef[]; content: string } {
    const bytes = this.#loadBlob(row.blocks_hash);
    if (bytes === null) throw new MissingBody(row.blocks_hash);
    if (metrics !== undefined) {
      metrics.decoded_body_bytes += bytes.byteLength;
      if (row.images !== null) metrics.decoded_body_bytes += utf8.encode(row.images).byteLength;
    }
    const blocks = withImageData(JSON.parse(decoder.decode(bytes)) as ContentBlock[], this.#blobs(character));
    const images = row.images === null ? [] : (JSON.parse(row.images) as ImageRef[]);
    return { blocks, images, content: deriveContentFromBlocks(blocks, true) };
  }

  #blobs(character: string): ImageBlobs | undefined {
    const cache = this.#data === undefined ? undefined : imageCacheFor(this.#data);
    return cache === undefined ? undefined : imageBlobs(cache, character, false);
  }

  #referenced(character: string, blocks: ContentBlock[]): ContentBlock[] {
    const blobs = this.#blobs(character);
    return blobs === undefined ? blocks : withImageReferences(blocks, blobs);
  }

  referenceInlineImages(cache: string): number {
    const hashes = (this.#db.query("SELECT hash FROM history_blobs ORDER BY hash").all() as { hash: string }[]).map((row) => row.hash);
    const replace = this.#db.transaction((hash: string) => this.#referenceBodyImages(hash, cache));
    const changed = hashes.filter((hash) => replace(hash)).length;
    if (changed > 0) this.#collectGarbage();
    return changed;
  }

  #referenceBodyImages(hash: string, cache: string): boolean {
    let blocks: unknown;
    try {
      const bytes = this.#loadBlob(hash);
      if (bytes === null) return false;
      blocks = JSON.parse(decoder.decode(bytes));
    } catch {
      return false;
    }
    const characters = this.#db
      .query(
        `SELECT character FROM history_messages WHERE blocks_hash = ?1
         UNION SELECT m.character FROM history_alternatives a
           JOIN history_messages m ON m.id = a.message_id WHERE a.blocks_hash = ?1`,
      )
      .all(hash) as { character: string }[];
    let referenced = blocks;
    for (const { character } of characters) referenced = withImageReferences(blocks, imageBlobs(cache, character, false));
    if (referenced === blocks) return false;
    const fresh = this.#storeBlob(utf8.encode(JSON.stringify(referenced)));
    this.#db.query("UPDATE history_messages SET blocks_hash = ?1 WHERE blocks_hash = ?2").run(fresh, hash);
    this.#db.query("UPDATE history_alternatives SET blocks_hash = ?1 WHERE blocks_hash = ?2").run(fresh, hash);
    return true;
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
    this.#db.run(`DELETE FROM history_blobs
                   WHERE hash NOT IN (
                     SELECT blocks_hash FROM history_messages
                     UNION SELECT blocks_hash FROM history_alternatives
                   )`);
  }
}

export function characterOfArchiveKey(archiveKey: string): string {
  const slash = archiveKey.indexOf("/");
  return slash === -1 ? archiveKey : archiveKey.slice(0, slash);
}

function imagesColumn(images: ImageRef[] | undefined): string | null {
  return images === undefined || images.length === 0 ? null : JSON.stringify(images);
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function displayKind(message: Pick<Message, "role" | "content_blocks">): number {
  if (
    message.role === "user" &&
    message.content_blocks.length > 0 &&
    message.content_blocks.every((block) => block.type === "tool_result")
  ) {
    return DISPLAY_TOOL_RESULT;
  }
  if (message.role !== "assistant") return DISPLAY_OTHER;
  return message.content_blocks.some((block) => block.type === "tool_use")
    ? DISPLAY_TOOL_ASSISTANT
    : DISPLAY_ASSISTANT;
}

type DisplayState = "none" | "after_tool_assistant" | "after_tool_result";

function reindexDisplayMetadata(db: Database, character: string, startSegment: number): void {
  const previous = db
    .query(
      `SELECT m.display_kind, m.display_seq
       FROM history_messages m
       JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
       WHERE m.character = ?1 AND s.idx < ?2
       ORDER BY s.idx DESC, m.ordinal DESC LIMIT 1`,
    )
    .get(character, startSegment) as { display_kind: number; display_seq: number | null } | null;
  const maximum = db
    .query(
      `SELECT MAX(m.display_seq) AS seq
       FROM history_messages m
       JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
       WHERE m.character = ?1 AND s.idx < ?2`,
    )
    .get(character, startSegment) as { seq: number | null };
  let sequence = maximum.seq ?? -1;
  let state = displayStateAfter(previous);
  const rows = db
    .query(
      `SELECT m.id, m.display_kind
       FROM history_messages m
       JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
       WHERE m.character = ?1 AND s.idx >= ?2
       ORDER BY s.idx, m.ordinal`,
    )
    .all(character, startSegment) as { id: number; display_kind: number }[];
  const update = db.query("UPDATE history_messages SET display_seq = ?2 WHERE id = ?1");

  for (const row of rows) {
    let displaySequence: number | null;
    if (row.display_kind === DISPLAY_TOOL_RESULT) {
      displaySequence = state === "after_tool_assistant" ? sequence : null;
      state = displaySequence === null ? "none" : "after_tool_result";
    } else if (row.display_kind === DISPLAY_TOOL_ASSISTANT) {
      if (state === "none") sequence += 1;
      displaySequence = sequence;
      state = "after_tool_assistant";
    } else if (row.display_kind === DISPLAY_ASSISTANT && state !== "none") {
      displaySequence = sequence;
      state = "none";
    } else {
      sequence += 1;
      displaySequence = sequence;
      state = "none";
    }
    update.run(row.id, displaySequence);
  }
}

function displayStateAfter(
  row: { display_kind: number; display_seq: number | null } | null,
): DisplayState {
  if (row?.display_seq === null || row === null) return "none";
  if (row.display_kind === DISPLAY_TOOL_ASSISTANT) return "after_tool_assistant";
  if (row.display_kind === DISPLAY_TOOL_RESULT) return "after_tool_result";
  return "none";
}

class MissingBody extends Error {
  constructor(hash: string) {
    super(`history blob ${hash} is missing`);
    this.name = "MissingBody";
  }
}

class PendingCompaction extends Error {
  constructor(character: string) {
    super(`history compaction is already pending for ${character}`);
    this.name = "PendingCompaction";
  }
}

class PendingCompactionConflict extends Error {
  constructor(character: string) {
    super(`cannot recover the pending history compaction for ${character}: active history changed`);
    this.name = "PendingCompactionConflict";
  }
}
