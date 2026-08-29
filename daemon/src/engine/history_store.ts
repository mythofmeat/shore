import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  deriveContentFromBlocks,
  normalizeMessage,
} from "./message_store.ts";
import type {
  ContentBlock,
  ImageRef,
  Message,
  MessageAlternative,
  MessageOrigin,
} from "./types.ts";

export const HISTORY_DB_FILE = "history.db";

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
    memory_before TEXT,
    memory_after  TEXT,
    excluded      INTEGER NOT NULL DEFAULT 0,
    memory_retain INTEGER NOT NULL DEFAULT 0,
    label         TEXT,
    note          TEXT,
    PRIMARY KEY (character, idx)
);

CREATE TABLE IF NOT EXISTS history_pending (
    character  TEXT PRIMARY KEY,
    segment    INTEGER NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_memory_retain (
    character          TEXT    NOT NULL,
    segment            INTEGER NOT NULL,
    status             TEXT    NOT NULL,
    remote_operation_id TEXT,
    attempts           INTEGER NOT NULL DEFAULT 0,
    next_attempt_at    INTEGER NOT NULL DEFAULT 0,
    last_error         TEXT,
    updated_at         TEXT    NOT NULL,
    PRIMARY KEY (character, segment)
);

CREATE INDEX IF NOT EXISTS idx_history_memory_retain_work
    ON history_memory_retain (character, status, next_attempt_at, segment);

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
    is_user_turn INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS history_metadata (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history_character_stats (
    character     TEXT PRIMARY KEY,
    display_count INTEGER NOT NULL,
    turn_count    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history_archive_revision (
    character TEXT PRIMARY KEY,
    revision  INTEGER NOT NULL
);
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
  retain?: boolean;
  label?: string;
  note?: string;
}

export interface SegmentRecord extends SegmentEntry {
  idx: number;
  first_message_at: string | null;
  last_message_at: string | null;
}

export type MemoryRetainStatus =
  | "pending"
  | "submitted"
  | "complete"
  | "delete_pending"
  | "skipped"
  | "excluded";

export interface MemoryRetainJob {
  character: string;
  segment: number;
  status: MemoryRetainStatus;
  remote_operation_id?: string;
  attempts: number;
  next_attempt_at: number;
  last_error?: string;
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

export interface HistoryDisplaySlice {
  messages: Message[];
  metrics: HistoryReadMetrics;
}

const DISPLAY_OTHER = 0;
const DISPLAY_ASSISTANT = 1;
const DISPLAY_TOOL_ASSISTANT = 2;
const DISPLAY_TOOL_RESULT = 3;
const DISPLAY_METADATA_VERSION = 2;

export class HistoryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    db.run(`PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;`);
    db.run(HISTORY_SCHEMA);
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
      const row = this.#db
        .query(
          `SELECT committed, excluded, memory_retain FROM history_segments
           WHERE character = ?1 AND idx = ?2`,
        )
        .get(character, idx) as
        | { committed: number; excluded: number; memory_retain: number }
        | null;
      this.#db
        .query("UPDATE history_segments SET committed = 1 WHERE character = ?1 AND idx = ?2")
        .run(character, idx);
      this.#db
        .query("DELETE FROM history_pending WHERE character = ?1 AND segment = ?2")
        .run(character, idx);
      if (row?.committed === 0) {
        this.#updateCharacterStats(character, this.#segmentTurnCount(character, idx));
      }
      if (row?.memory_retain === 1) {
        this.#enqueueMemoryRetain(character, idx, row.excluded === 1);
      }
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

  displayMessageCount(character: string): number {
    const row = this.#db
      .query("SELECT display_count FROM history_character_stats WHERE character = ?1")
      .get(character) as { display_count: number } | null;
    return row?.display_count ?? 0;
  }

  displayTurnCount(character: string): number {
    const row = this.#db
      .query("SELECT turn_count FROM history_character_stats WHERE character = ?1")
      .get(character) as { turn_count: number } | null;
    return row?.turn_count ?? 0;
  }

  displayStartForTurns(character: string, end: number, turns: number): number {
    if (turns <= 0) return end;
    const row = this.#db
      .query(
        `SELECT m.display_seq
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND s.committed = 1 AND m.is_user_turn = 1
           AND m.display_seq < ?2
         ORDER BY m.display_seq DESC
         LIMIT 1 OFFSET ?3`,
      )
      .get(character, end, turns - 1) as { display_seq: number } | null;
    return row?.display_seq ?? 0;
  }

  archiveDigest(character: string): string {
    const row = this.#db
      .query("SELECT revision FROM history_archive_revision WHERE character = ?1")
      .get(character) as { revision: number } | null;
    return `rev:${row?.revision ?? 0}`;
  }

  entries(character: string): SegmentRecord[] {
    const rows = this.#db
      .query(
        `SELECT s.idx, s.file, s.message_count, s.compacted_at, s.compaction_id,
                s.memory_before, s.memory_after, s.excluded, s.label, s.note,
                (SELECT m.timestamp FROM history_messages m
                 WHERE m.character = s.character AND m.segment = s.idx
                 ORDER BY m.ordinal ASC LIMIT 1) AS first_message_at,
                (SELECT m.timestamp FROM history_messages m
                 WHERE m.character = s.character AND m.segment = s.idx
                 ORDER BY m.ordinal DESC LIMIT 1) AS last_message_at
         FROM history_segments s
         WHERE s.character = ?1 AND s.committed = 1 ORDER BY s.idx`,
      )
      .all(character) as (Omit<SegmentRecord,
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

  setExcluded(
    character: string,
    idx: number,
    excluded: boolean,
    manageRetain = false,
  ): boolean {
    return this.#db.transaction(() => {
      const previous = this.#db
        .query(
          `SELECT memory_retain FROM history_segments
           WHERE character = ?1 AND idx = ?2 AND committed = 1`,
        )
        .get(character, idx) as { memory_retain: number } | null;
      const changed = this.#db
        .query(
          `UPDATE history_segments
           SET excluded = ?3,
               memory_retain = CASE WHEN ?4 = 1 THEN 1 ELSE memory_retain END
           WHERE character = ?1 AND idx = ?2 AND committed = 1`,
        )
        .run(character, idx, excluded ? 1 : 0, manageRetain ? 1 : 0).changes > 0;
      if (!changed) return false;
      const row = this.#db
        .query(
          `SELECT memory_retain FROM history_segments
           WHERE character = ?1 AND idx = ?2`,
        )
        .get(character, idx) as { memory_retain: number } | null;
      if (row?.memory_retain !== 1) return true;
      this.#enqueueMemoryRetain(character, idx, excluded);
      if (excluded) {
        this.#db
          .query(
            `UPDATE history_memory_retain
             SET status = CASE
                   WHEN ?3 = 0 THEN 'delete_pending'
                   WHEN status IN ('skipped', 'excluded') THEN 'excluded'
                   WHEN status = 'pending' AND attempts = 0 THEN 'excluded'
                   ELSE 'delete_pending'
                 END,
                 next_attempt_at = 0,
                 last_error = NULL,
                 updated_at = ?4
             WHERE character = ?1 AND segment = ?2`,
          )
          .run(character, idx, previous?.memory_retain ?? 0, new Date().toISOString());
      } else {
        this.#db
          .query(
            `UPDATE history_memory_retain
             SET status = 'pending', remote_operation_id = NULL, attempts = 0,
                 next_attempt_at = 0, last_error = NULL, updated_at = ?3
             WHERE character = ?1 AND segment = ?2`,
          )
          .run(character, idx, new Date().toISOString());
      }
      return true;
    })();
  }

  nextMemoryRetainJob(character: string, now: number): MemoryRetainJob | undefined {
    const row = this.#db
      .query(
        `SELECT q.character, q.segment, q.status, q.remote_operation_id,
                q.attempts, q.next_attempt_at, q.last_error
         FROM history_memory_retain q
         JOIN history_segments s
           ON s.character = q.character AND s.idx = q.segment
         WHERE q.character = ?1 AND s.committed = 1
           AND q.status IN ('pending', 'submitted', 'delete_pending')
           AND q.next_attempt_at <= ?2
           AND (
             q.status <> 'pending' OR NOT EXISTS (
               SELECT 1 FROM history_memory_retain active
               WHERE active.character = q.character AND active.status = 'submitted'
             )
           )
         ORDER BY CASE q.status
                    WHEN 'delete_pending' THEN 0
                    WHEN 'submitted' THEN 1
                    ELSE 2
                  END,
                  q.segment
         LIMIT 1`,
      )
      .get(character, now) as
      | {
          character: string;
          segment: number;
          status: MemoryRetainStatus;
          remote_operation_id: string | null;
          attempts: number;
          next_attempt_at: number;
          last_error: string | null;
        }
      | null;
    if (row === null) return undefined;
    return {
      character: row.character,
      segment: row.segment,
      status: row.status,
      attempts: row.attempts,
      next_attempt_at: row.next_attempt_at,
      ...(row.remote_operation_id === null
        ? {}
        : { remote_operation_id: row.remote_operation_id }),
      ...(row.last_error === null ? {} : { last_error: row.last_error }),
    };
  }

  markMemoryRetainSubmitted(
    character: string,
    segment: number,
    remoteOperationId: string,
    nextPollAt: number,
  ): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM history_segments
                 WHERE character = ?1 AND idx = ?2 AND excluded = 1
               ) THEN 'delete_pending'
               ELSE 'submitted'
             END,
             remote_operation_id = ?3, attempts = attempts + 1,
             next_attempt_at = ?4, last_error = NULL, updated_at = ?5
         WHERE character = ?1 AND segment = ?2 AND status IN ('pending', 'excluded')`,
      )
      .run(character, segment, remoteOperationId, nextPollAt, new Date().toISOString())
      .changes > 0;
  }

  markMemoryRetainPoll(
    character: string,
    segment: number,
    nextPollAt: number,
    error?: string,
  ): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET next_attempt_at = ?3, last_error = ?4,
             attempts = attempts + CASE WHEN ?4 IS NULL THEN 0 ELSE 1 END,
             updated_at = ?5
         WHERE character = ?1 AND segment = ?2 AND status = 'submitted'`,
      )
      .run(character, segment, nextPollAt, error ?? null, new Date().toISOString()).changes > 0;
  }

  markMemoryRetainComplete(character: string, segment: number): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM history_segments
                 WHERE character = ?1 AND idx = ?2 AND excluded = 1
               ) THEN 'delete_pending'
               ELSE 'complete'
             END,
             next_attempt_at = 0, last_error = NULL, updated_at = ?3
         WHERE character = ?1 AND segment = ?2 AND status = 'submitted'`,
      )
      .run(character, segment, new Date().toISOString()).changes > 0;
  }

  markMemoryRetainSkipped(character: string, segment: number): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM history_segments
                 WHERE character = ?1 AND idx = ?2 AND excluded = 1
               ) THEN 'excluded'
               ELSE 'skipped'
             END,
             attempts = attempts + 1, next_attempt_at = 0,
             last_error = NULL, updated_at = ?3
         WHERE character = ?1 AND segment = ?2 AND status IN ('pending', 'excluded')`,
      )
      .run(character, segment, new Date().toISOString()).changes > 0;
  }

  markMemoryRetainFailure(
    character: string,
    segment: number,
    error: string,
    retryAt: number,
  ): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM history_segments
                 WHERE character = ?1 AND idx = ?2 AND excluded = 1
               ) THEN 'delete_pending'
               ELSE 'pending'
             END,
             attempts = attempts + 1, next_attempt_at = ?4,
             last_error = ?3, remote_operation_id = NULL, updated_at = ?5
         WHERE character = ?1 AND segment = ?2`,
      )
      .run(character, segment, error, retryAt, new Date().toISOString()).changes > 0;
  }

  markMemoryDeleteComplete(character: string, segment: number): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM history_segments
                 WHERE character = ?1 AND idx = ?2 AND excluded = 0
               ) THEN 'pending'
               ELSE 'excluded'
             END,
             remote_operation_id = NULL, attempts = 0,
             next_attempt_at = 0, last_error = NULL, updated_at = ?3
         WHERE character = ?1 AND segment = ?2 AND status = 'delete_pending'`,
      )
      .run(character, segment, new Date().toISOString()).changes > 0;
  }

  markMemoryDeleteFailure(
    character: string,
    segment: number,
    error: string,
    retryAt: number,
  ): boolean {
    return this.#db
      .query(
        `UPDATE history_memory_retain
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM history_segments
                 WHERE character = ?1 AND idx = ?2 AND excluded = 0
               ) THEN 'pending'
               ELSE 'delete_pending'
             END,
             attempts = attempts + 1, next_attempt_at = ?4,
             last_error = ?3, updated_at = ?5
         WHERE character = ?1 AND segment = ?2`,
      )
      .run(character, segment, error, retryAt, new Date().toISOString()).changes > 0;
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
                alt_index, alt_count, images, blocks_hash
         FROM history_messages
         WHERE character = ?1 AND segment = ?2
           AND EXISTS (
             SELECT 1 FROM history_segments
             WHERE character = ?1 AND idx = ?2 AND committed = 1
           )
         ORDER BY ordinal`,
      )
      .all(character, idx) as MessageRow[];

    return this.#messagesFromRows(rows);
  }

  readDisplayRange(character: string, start: number, end: number): HistoryDisplaySlice {
    const metrics: HistoryReadMetrics = {
      segments_read: 0,
      rows_read: 0,
      decoded_body_bytes: 0,
    };
    if (end <= start) return { messages: [], metrics };

    const rows = this.#db
      .query(
        `SELECT m.id, m.msg_id, m.role, m.timestamp, m.provider_key, m.model, m.origin,
                m.segment, m.alt_index, m.alt_count, m.images, m.blocks_hash
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND s.committed = 1
           AND m.display_seq >= ?2 AND m.display_seq < ?3
         ORDER BY m.segment, m.ordinal`,
      )
      .all(character, start, end) as MessageRow[];

    metrics.rows_read = rows.length;
    metrics.segments_read = new Set(rows.map((row) => row.segment)).size;
    return { messages: this.#messagesFromRows(rows, metrics), metrics };
  }

  #messagesFromRows(rows: MessageRow[], metrics?: HistoryReadMetrics): Message[] {
    const altQuery = this.#db.query(
      `SELECT timestamp, provider_key, model, images, blocks_hash
       FROM history_alternatives WHERE message_id = ?1 ORDER BY ordinal`,
    );

    return rows.map((row) => {
      const { blocks, images, content } = this.#body(row, metrics);
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
        message.alternatives = altRows.map((alt) => this.#alternative(alt, metrics));
      }
      return normalizeMessage(message);
    });
  }

  #insertMessage(character: string, segment: number, ordinal: number, message: Message): void {
    const blocksHash = this.#storeBlob(utf8.encode(JSON.stringify(message.content_blocks)));
    const kind = displayKind(message);
    this.#db
      .query(
        `INSERT INTO history_messages
             (character, segment, ordinal, msg_id, role, timestamp,
              provider_key, model, origin, alt_index, alt_count, images, blocks_hash,
              display_kind, display_seq, is_user_turn)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15)`,
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
    const previousTurnCount = this.#committedSegmentTurnCount(character, idx);
    const normalizedMessages = messages.map((message) => normalizeMessage(message));
    this.#deleteSegment(character, idx);
    this.#db
      .query(
        `INSERT INTO history_segments
             (character, idx, file, message_count, compacted_at, compaction_id, committed,
              memory_before, memory_after, excluded, memory_retain, label, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (character, idx) DO UPDATE SET
           file = excluded.file,
           message_count = excluded.message_count,
           compacted_at = excluded.compacted_at,
           compaction_id = excluded.compaction_id,
           committed = excluded.committed,
           memory_before = excluded.memory_before,
           memory_after = excluded.memory_after,
           excluded = excluded.excluded,
           memory_retain = excluded.memory_retain,
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
        entry.retain === true ? 1 : 0,
        entry.label ?? null,
        entry.note ?? null,
      );
    normalizedMessages.forEach((message, ordinal) => {
      this.#insertMessage(character, idx, ordinal, message);
    });
    reindexDisplayMetadata(this.#db, character, idx);
    if (committed) {
      const nextTurnCount = normalizedMessages.filter(
        (message) => message.role === "user" && displayKind(message) !== DISPLAY_TOOL_RESULT,
      ).length;
      this.#updateCharacterStats(character, nextTurnCount - previousTurnCount);
    }
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
    this.#db
      .query("DELETE FROM history_memory_retain WHERE character = ?1 AND segment = ?2")
      .run(character, idx);
  }

  #enqueueMemoryRetain(character: string, segment: number, excluded: boolean): void {
    this.#db
      .query(
        `INSERT OR IGNORE INTO history_memory_retain
           (character, segment, status, remote_operation_id, attempts,
            next_attempt_at, last_error, updated_at)
         VALUES (?1, ?2, ?3, NULL, 0, 0, NULL, ?4)`,
      )
      .run(character, segment, excluded ? "excluded" : "pending", new Date().toISOString());
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

  #segmentTurnCount(character: string, idx: number): number {
    const row = this.#db
      .query(
        "SELECT COUNT(*) AS n FROM history_messages WHERE character = ?1 AND segment = ?2 AND is_user_turn = 1",
      )
      .get(character, idx) as { n: number };
    return row.n;
  }

  #updateCharacterStats(character: string, turnDelta: number): void {
    const display = this.#db
      .query(
        `SELECT COALESCE(MAX(m.display_seq) + 1, 0) AS n
         FROM history_messages m
         JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
         WHERE m.character = ?1 AND s.committed = 1`,
      )
      .get(character) as { n: number };
    const current = this.#db
      .query("SELECT turn_count FROM history_character_stats WHERE character = ?1")
      .get(character) as { turn_count: number } | null;
    let turns: number;
    if (current === null) {
      const row = this.#db
        .query(
          `SELECT COUNT(*) AS n
           FROM history_messages m
           JOIN history_segments s ON s.character = m.character AND s.idx = m.segment
           WHERE m.character = ?1 AND s.committed = 1 AND m.is_user_turn = 1`,
        )
        .get(character) as { n: number };
      turns = row.n;
    } else {
      turns = current.turn_count + turnDelta;
    }
    this.#db
      .query(
        `INSERT INTO history_character_stats (character, display_count, turn_count)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (character) DO UPDATE SET
           display_count = excluded.display_count,
           turn_count = excluded.turn_count`,
      )
      .run(character, display.n, turns);
  }

  #alternative(row: BodyRow, metrics?: HistoryReadMetrics): MessageAlternative {
    const body = this.#body(row, metrics);
    return {
      content: body.content,
      images: body.images,
      content_blocks: body.blocks,
      timestamp: row.timestamp,
      ...(row.provider_key === null ? {} : { provider_key: row.provider_key }),
      ...(row.model === null ? {} : { model: row.model }),
    };
  }

  #body(
    row: BodyRow,
    metrics?: HistoryReadMetrics,
  ): { blocks: ContentBlock[]; images: ImageRef[]; content: string } {
    const bytes = this.#loadBlob(row.blocks_hash);
    if (bytes === null) throw new MissingBody(row.blocks_hash);
    if (metrics !== undefined) {
      metrics.decoded_body_bytes += bytes.byteLength;
      if (row.images !== null) metrics.decoded_body_bytes += utf8.encode(row.images).byteLength;
    }
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
    this.#db.run(`DELETE FROM history_blobs
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
  const seeded = db
    .query("SELECT value FROM history_metadata WHERE key = 'archive_revision_seeded'")
    .get() as { value: number } | null;
  if (seeded === null) {
    db.transaction(() => {
      db.run(`INSERT OR IGNORE INTO history_archive_revision(character, revision)
               SELECT character, count(*) FROM history_messages GROUP BY character`);
      db.run("INSERT INTO history_metadata (key, value) VALUES ('archive_revision_seeded', 1)");
    })();
  }
  const columns = db.query("PRAGMA table_info(history_segments)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "compaction_id")) {
    db.run("ALTER TABLE history_segments ADD COLUMN compaction_id TEXT");
  }
  if (!columns.some((column) => column.name === "committed")) {
    db.run("ALTER TABLE history_segments ADD COLUMN committed INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.some((column) => column.name === "memory_before")) {
    db.run("ALTER TABLE history_segments ADD COLUMN memory_before TEXT");
  }
  if (!columns.some((column) => column.name === "memory_after")) {
    db.run("ALTER TABLE history_segments ADD COLUMN memory_after TEXT");
  }
  if (!columns.some((column) => column.name === "excluded")) {
    db.run("ALTER TABLE history_segments ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "memory_retain")) {
    db.run("ALTER TABLE history_segments ADD COLUMN memory_retain INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "label")) {
    db.run("ALTER TABLE history_segments ADD COLUMN label TEXT");
  }
  if (!columns.some((column) => column.name === "note")) {
    db.run("ALTER TABLE history_segments ADD COLUMN note TEXT");
  }
  const messageColumns = db.query("PRAGMA table_info(history_messages)").all() as {
    name: string;
  }[];
  if (!messageColumns.some((column) => column.name === "display_kind")) {
    db.run("ALTER TABLE history_messages ADD COLUMN display_kind INTEGER");
  }
  if (!messageColumns.some((column) => column.name === "display_seq")) {
    db.run("ALTER TABLE history_messages ADD COLUMN display_seq INTEGER");
  }
  if (!messageColumns.some((column) => column.name === "is_user_turn")) {
    db.run("ALTER TABLE history_messages ADD COLUMN is_user_turn INTEGER");
  }
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_history_segments_operation
           ON history_segments (character, compaction_id)
           WHERE compaction_id IS NOT NULL`);
  const oldBlobs = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blobs'")
    .get();
  if (oldBlobs !== null) {
    db.run(`INSERT OR IGNORE INTO history_blobs (hash, size, compressed, data)
             SELECT hash, size, compressed, data FROM blobs`);
  }
  const metadata = db
    .query("SELECT value FROM history_metadata WHERE key = 'display_version'")
    .get() as { value: number } | null;
  if (metadata?.value !== DISPLAY_METADATA_VERSION) {
    db.transaction(() => {
      const rows = db
        .query("SELECT id, role, blocks_hash FROM history_messages ORDER BY id")
        .all() as { id: number; role: Message["role"]; blocks_hash: string }[];
      const update = db.query(
        "UPDATE history_messages SET display_kind = ?2, is_user_turn = ?3 WHERE id = ?1",
      );
      for (const row of rows) {
        const blocks = loadBlocks(db, row.blocks_hash);
        const kind = displayKind({ role: row.role, content_blocks: blocks });
        const userTurn = row.role === "user" && kind !== DISPLAY_TOOL_RESULT ? 1 : 0;
        update.run(row.id, kind, userTurn);
      }
      const characters = db
        .query("SELECT DISTINCT character FROM history_segments ORDER BY character")
        .all() as { character: string }[];
      for (const { character } of characters) reindexDisplayMetadata(db, character, 0);
      db.run("DELETE FROM history_character_stats");
      db.run(
        `INSERT INTO history_character_stats (character, display_count, turn_count)
         SELECT s.character,
                COALESCE(MAX(m.display_seq) + 1, 0),
                COALESCE(SUM(CASE WHEN m.is_user_turn = 1 THEN 1 ELSE 0 END), 0)
         FROM history_segments s
         LEFT JOIN history_messages m ON m.character = s.character AND m.segment = s.idx
         WHERE s.committed = 1
         GROUP BY s.character`,
      );
      db.query(
        `INSERT INTO history_metadata (key, value) VALUES ('display_version', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(DISPLAY_METADATA_VERSION);
    })();
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_messages_display
           ON history_messages (character, display_seq, segment, ordinal)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_messages_turn
           ON history_messages (character, is_user_turn, display_seq)`);
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

function loadBlocks(db: Database, hash: string): ContentBlock[] {
  const row = db
    .query("SELECT size, compressed, data FROM history_blobs WHERE hash = ?1")
    .get(hash) as { size: number; compressed: number; data: Uint8Array } | null;
  if (row === null) throw new MissingBody(hash);
  const bytes = row.compressed === 0 ? row.data : zstdDecompressSync(row.data);
  if (bytes.byteLength !== row.size) throw new MissingBody(hash);
  return JSON.parse(decoder.decode(bytes)) as ContentBlock[];
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
