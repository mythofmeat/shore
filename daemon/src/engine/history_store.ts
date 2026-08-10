import type { Database } from "bun:sqlite";

import { loadBlob, storeBlob } from "../call_store.ts";
import { deriveContentFromBlocks, normalizeMessage } from "./message_store.ts";
import type {
  ContentBlock,
  ImageRef,
  Message,
  MessageAlternative,
  MessageOrigin,
} from "./types.ts";

export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
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
    PRIMARY KEY (character, idx)
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
}

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
    db.exec(HISTORY_SCHEMA);
  }

  putSegment(character: string, idx: number, entry: SegmentEntry, messages: Message[]): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT OR REPLACE INTO history_segments
               (character, idx, file, message_count, compacted_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .run(character, idx, entry.file, entry.message_count, entry.compacted_at);

      const stale = this.#db
        .query("SELECT id FROM history_messages WHERE character = ?1 AND segment = ?2")
        .all(character, idx) as { id: number }[];
      const dropAlts = this.#db.query("DELETE FROM history_alternatives WHERE message_id = ?1");
      for (const row of stale) dropAlts.run(row.id);
      this.#db
        .query("DELETE FROM history_messages WHERE character = ?1 AND segment = ?2")
        .run(character, idx);

      messages.forEach((message, ordinal) => {
        this.#insertMessage(character, idx, ordinal, message);
      });
    })();
  }

  #imagesColumn(images: ImageRef[] | undefined): string | null {
    return images === undefined || images.length === 0 ? null : JSON.stringify(images);
  }

  #insertMessage(character: string, segment: number, ordinal: number, message: Message): void {
    const blocksHash = storeBlob(this.#db, utf8.encode(JSON.stringify(message.content_blocks)));

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
        this.#imagesColumn(message.images),
        blocksHash,
      );

    if (message.alternatives === undefined) return;
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
        this.#imagesColumn(alternative.images),
        storeBlob(this.#db, utf8.encode(JSON.stringify(alternative.content_blocks))),
      );
    });
  }

  segmentCount(character: string): number {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM history_segments WHERE character = ?1")
      .get(character) as { n: number };
    return Number(row.n);
  }

  totalMessageCount(character: string): number {
    const row = this.#db
      .query(
        "SELECT COALESCE(SUM(message_count), 0) AS n FROM history_segments WHERE character = ?1",
      )
      .get(character) as { n: number };
    return Number(row.n);
  }

  entries(character: string): SegmentEntry[] {
    return this.#db
      .query(
        `SELECT file, message_count, compacted_at FROM history_segments
         WHERE character = ?1 ORDER BY idx`,
      )
      .all(character) as SegmentEntry[];
  }

  readSegment(character: string, idx: number): Message[] {
    const rows = this.#db
      .query(
        `SELECT id, msg_id, role, timestamp, provider_key, model, origin,
                alt_index, alt_count, images, blocks_hash
         FROM history_messages
         WHERE character = ?1 AND segment = ?2 ORDER BY ordinal`,
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
        message.alternatives = altRows.map((alt) => {
          const body = this.#body(alt);
          const alternative: MessageAlternative = {
            content: body.content,
            images: body.images,
            content_blocks: body.blocks,
            timestamp: alt.timestamp,
          };
          if (alt.provider_key !== null) alternative.provider_key = alt.provider_key;
          if (alt.model !== null) alternative.model = alt.model;
          return alternative;
        });
      }
      return normalizeMessage(message);
    });
  }

  liveHashes(): string[] {
    const rows = this.#db
      .query(
        `SELECT blocks_hash AS hash FROM history_messages
         UNION SELECT blocks_hash AS hash FROM history_alternatives`,
      )
      .all() as { hash: string }[];
    return rows.map((row) => row.hash);
  }

  #body(row: BodyRow): { blocks: ContentBlock[]; images: ImageRef[]; content: string } {
    const bytes = loadBlob(this.#db, row.blocks_hash);
    if (bytes === null) throw new MissingBody(row.blocks_hash);
    const blocks = JSON.parse(decoder.decode(bytes)) as ContentBlock[];
    const images = row.images === null ? [] : (JSON.parse(row.images) as ImageRef[]);
    return { blocks, images, content: deriveContentFromBlocks(blocks, true) };
  }
}

export class MissingBody extends Error {
  constructor(hash: string) {
    super(`history blob ${hash} is missing`);
    this.name = "MissingBody";
  }
}
