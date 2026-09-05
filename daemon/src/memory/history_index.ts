import { chunkText } from "./chunking.ts";
import { required } from "../util/required.ts";

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { deriveContentFromBlocks } from "../engine/message_store.ts";
import { versionOf } from "../engine/versions.ts";
import { compactionManifestIn, segmentsDirIn } from "../config/dirs.ts";
import { CharacterHistoryReader, type CharacterHistoryRef } from "../engine/character_history.ts";
import type { Message } from "../engine/types.ts";
import type { Embedder } from "../llm/embed.ts";

export const HISTORY_SEARCH_DB_FILE = "history_search.db";
export const HISTORY_SEARCH_SCHEMA_VERSION = 6;
export const HISTORY_CHUNK_CHARS = 1_200;
export const HISTORY_CHUNK_OVERLAP = 120;
export const HISTORY_EMBED_BATCH_ITEMS = 32;
export const HISTORY_EMBED_BATCH_CHARS = 96_000;

const HISTORY_VECTOR_CANDIDATES = 2_048;
const LSH_BANDS = 8;
const LSH_BITS_PER_BAND = 8;
const LSH_SAMPLES_PER_BIT = 32;

const EMBED_CURSOR = "embed_cursor";

const SCHEMA = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  locator TEXT NOT NULL UNIQUE,
  archive_key TEXT NOT NULL,
  segment INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  role TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  model TEXT,
  content_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  version TEXT
);
CREATE INDEX messages_chronology
  ON messages(archive_key, segment, ordinal);
CREATE INDEX messages_version ON messages(version);
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(message_id, ordinal)
);
CREATE INDEX chunks_hash ON chunks(content_hash);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='', contentless_delete=1);
CREATE TABLE embeddings (
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY(content_hash, model, dimensions)
);
CREATE TABLE embedding_lsh (
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  band INTEGER NOT NULL,
  code INTEGER NOT NULL,
  PRIMARY KEY(content_hash, model, dimensions, band)
);
CREATE INDEX embedding_lsh_lookup
  ON embedding_lsh(model, dimensions, band, code, content_hash);
`;

export interface HistoryIndexDiagnostics {
  indexed_chunks: number;
  total_chunks: number;
  pending_chunks: number;
}

export interface IndexedMessage {
  id: number;
  archive_key: string;
  segment: number;
  ordinal: number;
  msg_id: string;
  role: Message["role"];
  timestamp: string;
  model: string | null;
  content_hash: string;
  version: string | null;
}

interface CanonicalMessage {
  locator: string;
  archive_key: string;
  segment: number;
  ordinal: number;
  msgId: string;
  role: Message["role"];
  timestamp: string;
  model: string | undefined;
  version: string | undefined;
  text: string;
}

interface CanonicalCorpus {
  messages: CanonicalMessage[];
  selectedCount: number;
  distinctCount: number;
}

export interface HistoryIndexOpenOptions {
  conversationDir: string;
  character: string;
  dbPath: string;
  path?: string;
}

export function historyIndexPath(cacheDir: string, character: string): string {
  return join(cacheDir, "characters", character, HISTORY_SEARCH_DB_FILE);
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

export class HistorySearchIndex {
  readonly path: string;
  readonly conversationDir: string;
  readonly ref: CharacterHistoryRef;
  #db: Database;

  private constructor(options: HistoryIndexOpenOptions, db: Database) {
    this.path = options.path ?? join(options.conversationDir, HISTORY_SEARCH_DB_FILE);
    this.conversationDir = options.conversationDir;
    this.ref = {
      mainConversationDir: options.conversationDir,
      dbPath: options.dbPath,
      character: options.character,
    };
    this.#db = db;
  }

  static open(options: HistoryIndexOpenOptions): HistorySearchIndex {
    const path = options.path ?? join(options.conversationDir, HISTORY_SEARCH_DB_FILE);
    mkdirSync(dirname(path), { recursive: true });
    let db: Database | undefined;
    try {
      db = new Database(path, { create: true, readwrite: true });
      const version =
        (db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ??
        0;
      if (version !== HISTORY_SEARCH_SCHEMA_VERSION) {
        db.close();
        db = undefined;
        removeCacheFiles(path);
        db = new Database(path, { create: true, readwrite: true });
        db.run(SCHEMA);
        db.run(`PRAGMA user_version = ${HISTORY_SEARCH_SCHEMA_VERSION}`);
      }
      db.run("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      chmodSync(path, 0o600);
      return new HistorySearchIndex({ ...options, path }, db);
    } catch {
      try { db?.close(); } catch {}
      removeCacheFiles(path);
      const rebuilt = new Database(path, { create: true, readwrite: true });
      rebuilt.run(SCHEMA);
      rebuilt.run(`PRAGMA user_version = ${HISTORY_SEARCH_SCHEMA_VERSION}`);
      rebuilt.run("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      try { chmodSync(path, 0o600); } catch {}
      return new HistorySearchIndex({ ...options, path }, rebuilt);
    }
  }

  close(): void {
    this.#db.close();
  }

  async reconcile(force = false): Promise<void> {
    const before = await sourceFingerprint(this.ref);
    if (!force && this.#metadata("source_fingerprint") === before) return;

    const { corpus, fingerprint: after } = await readStableCanonicalCorpus(this.ref, before);
    this.#db.transaction(() => {
      const existing = this.#db.query(
        "SELECT id, locator, content_hash FROM messages",
      ).all() as { id: number; locator: string; content_hash: string }[];
      const unchanged = new Map(
        existing.map((row) => [`${row.locator}\0${row.content_hash}`, row.id]),
      );
      const desired = new Set(
        corpus.messages.map((item) => `${item.locator}\0${contentHash(item.text)}`),
      );
      const stale = existing.filter((row) => !desired.has(`${row.locator}\0${row.content_hash}`));
      if (stale.length > 0) {
        const dropFts = this.#db.query(
          "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE message_id = ?1)",
        );
        const dropChunks = this.#db.query("DELETE FROM chunks WHERE message_id = ?1");
        const dropMessage = this.#db.query("DELETE FROM messages WHERE id = ?1");
        for (const row of stale) {
          dropFts.run(row.id);
          dropChunks.run(row.id);
          dropMessage.run(row.id);
        }
      }
      const putMessage = this.#db.query(
        `INSERT INTO messages
           (locator, segment, ordinal, msg_id, role, timestamp, model, content_hash, chunk_count,
            archive_key, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      );
      const putChunk = this.#db.query(
        "INSERT INTO chunks(message_id, ordinal, content_hash) VALUES (?1, ?2, ?3)",
      );
      const putFts = this.#db.query("INSERT INTO chunks_fts(rowid, text) VALUES (?1, ?2)");

      for (const item of corpus.messages) {
        const chunks = chunkVisibleText(item.text);
        const hash = contentHash(item.text);
        const existingId = unchanged.get(`${item.locator}\0${hash}`);
        if (existingId !== undefined) {
          this.#db.query(
            `UPDATE messages SET msg_id = ?1, role = ?2, timestamp = ?3, model = ?4, version = ?5
             WHERE id = ?6`,
          ).run(
            item.msgId,
            item.role,
            item.timestamp,
            item.model ?? null,
            item.version ?? null,
            existingId,
          );
          continue;
        }
        putMessage.run(
          item.locator,
          item.segment,
          item.ordinal,
          item.msgId,
          item.role,
          item.timestamp,
          item.model ?? null,
          hash,
          chunks.length,
          item.archive_key,
          item.version ?? null,
        );
        const messageId = (
          this.#db.query("SELECT last_insert_rowid() AS id").get() as { id: number }
        ).id;
        chunks.forEach((text, ordinal) => {
          putChunk.run(messageId, ordinal, contentHash(text));
          const chunkId = (
            this.#db.query("SELECT last_insert_rowid() AS id").get() as { id: number }
          ).id;
          putFts.run(chunkId, text);
        });
      }
      this.#setMetadata("source_fingerprint", after);
      this.#setMetadata("selected_message_count", String(corpus.selectedCount));
      this.#setMetadata("distinct_message_count", String(corpus.distinctCount));
    })();
  }

  selectedMessageCount(): number {
    return Number(this.#metadata("selected_message_count") ?? 0);
  }

  distinctMessageCount(): number {
    return Number(this.#metadata("distinct_message_count") ?? this.selectedMessageCount());
  }

  lexicalRows(query: string): { row: IndexedMessage; rank: number }[] {
    const expression = ftsExpression(query);
    if (expression === undefined) return [];
    const rows = this.#db.query(
      `SELECT m.id, m.archive_key, m.segment, m.ordinal, m.msg_id, m.role,
              m.timestamp, m.model, m.content_hash, m.version,
              bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN messages m ON m.id = c.message_id
       WHERE chunks_fts MATCH ?1
       ORDER BY score, m.segment, m.ordinal`,
    ).all(expression) as (IndexedMessage & { score: number })[];

    const best = new Map<number, { row: IndexedMessage; score: number }>();
    for (const row of rows) {
      const previous = best.get(row.id);
      if (previous === undefined || row.score < previous.score) best.set(row.id, { row, score: row.score });
    }
    return [...best.values()]
      .sort((a, b) => a.score - b.score || compareLocator(a.row, b.row))
      .map((entry, rank) => ({ row: entry.row, rank: rank + 1 }));
  }

  allRows(): IndexedMessage[] {
    return this.#db.query(
      `SELECT id, archive_key, segment, ordinal, msg_id, role, timestamp, model, content_hash,
              version
       FROM messages ORDER BY segment, ordinal`,
    ).all() as IndexedMessage[];
  }

  timestampBounds(): { oldestMs: number; newestMs: number } | undefined {
    const rows = this.#db.query("SELECT timestamp FROM messages").all() as { timestamp: string }[];
    let oldestMs: number | undefined;
    let newestMs: number | undefined;
    for (const { timestamp } of rows) {
      const ms = Date.parse(timestamp);
      if (Number.isNaN(ms)) continue;
      if (oldestMs === undefined || ms < oldestMs) oldestMs = ms;
      if (newestMs === undefined || ms > newestMs) newestMs = ms;
    }
    if (oldestMs === undefined || newestMs === undefined) return undefined;
    return { oldestMs, newestMs };
  }

  rowsByIds(ids: readonly number[]): IndexedMessage[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    return this.#db.query(
      `SELECT id, archive_key, segment, ordinal, msg_id, role, timestamp, model, content_hash,
              version
       FROM messages WHERE id IN (${marks})`,
    ).all(...ids) as IndexedMessage[];
  }

  neighbor(row: IndexedMessage, direction: -1 | 1): IndexedMessage | undefined {
    const op = direction < 0 ? "<" : ">";
    const order = direction < 0 ? "DESC" : "ASC";
    const neighbor = this.#db.query(
      `SELECT id, archive_key, segment, ordinal, msg_id, role, timestamp, model, content_hash,
              version
       FROM messages
       WHERE archive_key = ?3 AND (segment ${op} ?1 OR (segment = ?1 AND ordinal ${op} ?2))
       ORDER BY segment ${order}, ordinal ${order} LIMIT 1`,
    ).get(row.segment, row.ordinal, row.archive_key) as IndexedMessage | null;
    if (neighbor === null || Math.abs(neighbor.segment - row.segment) > 1) return undefined;
    return neighbor;
  }

  diagnostics(embedder: Embedder | undefined): HistoryIndexDiagnostics {
    const total = (this.#db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    if (embedder === undefined) return { indexed_chunks: 0, total_chunks: total, pending_chunks: total };
    const identity = embeddingIdentity(embedder);
    const indexed = (
      this.#db
        .query(
          `SELECT COUNT(*) AS n FROM chunks c WHERE EXISTS (
         SELECT 1 FROM embeddings e
         WHERE e.content_hash = c.content_hash AND e.model = ?1
           AND (?2 IS NULL OR e.dimensions = ?2)
       )`,
        )
        .get(identity, embedder.dimensions ?? null) as { n: number }
    ).n;
    return { indexed_chunks: indexed, total_chunks: total, pending_chunks: total - indexed };
  }

  vectorRows(queryVector: readonly number[], embedder: Embedder): { row: IndexedMessage; rank: number; score: number }[] {
    const identity = embeddingIdentity(embedder);
    const probes = lshProbes(queryVector);
    if (probes.length === 0) return [];
    const values = probes.map(() => "(?, ?, ?)").join(", ");
    const args: (number | string)[] = probes.flatMap((probe) => [
      probe.band,
      probe.code,
      probe.weight,
    ]);
    args.push(identity, queryVector.length, HISTORY_VECTOR_CANDIDATES);
    const rows = this.#db.query(
      `WITH probes(band, code, weight) AS (VALUES ${values}),
       candidates AS (
         SELECT c.id AS chunk_id, SUM(p.weight) AS lsh_score
         FROM probes p
         JOIN embedding_lsh l ON l.band = p.band AND l.code = p.code
         JOIN chunks c ON c.content_hash = l.content_hash
         WHERE l.model = ? AND l.dimensions = ?
         GROUP BY c.id
         ORDER BY lsh_score DESC, c.id
         LIMIT ?
       )
       SELECT m.id, m.archive_key, m.segment, m.ordinal, m.msg_id, m.role,
              m.timestamp, m.model, m.content_hash, m.version, e.vector
       FROM candidates candidate
       JOIN chunks c ON c.id = candidate.chunk_id
       JOIN messages m ON m.id = c.message_id
       JOIN embeddings e ON e.content_hash = c.content_hash
                            AND e.model = ?${String(args.length - 2)}
                            AND e.dimensions = ?${String(args.length - 1)}`,
    ).all(...args) as (IndexedMessage & { vector: Uint8Array })[];
    const best = new Map<number, { row: IndexedMessage; score: number }>();
    for (const row of rows) {
      const score = cosineSimilarity(queryVector, bytesToVector(row.vector));
      const previous = best.get(row.id);
      if (previous === undefined || score > previous.score) best.set(row.id, { row, score });
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score || compareLocator(b.row, a.row))
      .map((entry, rank) => ({ ...entry, rank: rank + 1 }));
  }

  async embedPending(embedder: Embedder): Promise<number> {
    const identity = embeddingIdentity(embedder);
    const invalidated = this.#db.query(
      "DELETE FROM embeddings WHERE model <> ?1 OR (?2 IS NOT NULL AND dimensions <> ?2)",
    ).run(identity, embedder.dimensions ?? null);
    this.#db.query(
      "DELETE FROM embedding_lsh WHERE model <> ?1 OR (?2 IS NOT NULL AND dimensions <> ?2)",
    ).run(identity, embedder.dimensions ?? null);
    if (invalidated.changes > 0) this.#setMetadata(EMBED_CURSOR, "0");
    const cursor = Number(this.#metadata(EMBED_CURSOR) ?? 0);
    const batchCandidates = this.#db.query(
      `SELECT c.id AS chunk_id, c.ordinal AS chunk_ordinal, c.content_hash,
              m.id, m.archive_key, m.segment, m.ordinal, m.msg_id, m.role,
              m.timestamp, m.model, m.version
       FROM chunks c JOIN messages m ON m.id = c.message_id
       WHERE c.id > ?3 AND NOT EXISTS (
         SELECT 1 FROM embeddings e
         WHERE e.content_hash = c.content_hash AND e.model = ?1
           AND (?2 IS NULL OR e.dimensions = ?2)
       ) ORDER BY c.id LIMIT ?4`,
    ).all(
      identity,
      embedder.dimensions ?? null,
      cursor,
      HISTORY_EMBED_BATCH_ITEMS,
    ) as (IndexedMessage & {
      chunk_id: number;
      chunk_ordinal: number;
    })[];
    if (batchCandidates.length === 0) {
      if (cursor > 0) this.#setMetadata(EMBED_CURSOR, "0");
      return 0;
    }

    const chosen: typeof batchCandidates = [];
    const texts: string[] = [];
    let chars = 0;
    let lastAttempted = cursor;
    const loaded = await loadMessageTexts(this.ref, batchCandidates);
    for (const row of batchCandidates) {
      const full = loaded.get(row.id);
      const text = full === undefined ? undefined : chunkVisibleText(full)[row.chunk_ordinal];
      if (text !== undefined && contentHash(text) === row.content_hash) {
        if (chosen.length > 0 && chars + text.length > HISTORY_EMBED_BATCH_CHARS) break;
        chosen.push(row);
        texts.push(text);
        chars += text.length;
      }
      lastAttempted = row.chunk_id;
    }
    if (texts.length === 0) {
      this.#setMetadata(EMBED_CURSOR, String(lastAttempted));
      return 0;
    }
    const vectors = await embedder.embed(texts);
    if (vectors.length !== texts.length) {
      throw new Error(`embedding count mismatch: got ${vectors.length}, expected ${texts.length}`);
    }
    if (embedder.dimensions !== undefined) {
      const wrong = vectors.find((vector) => vector.length !== embedder.dimensions);
      if (wrong !== undefined) {
        throw new Error(
          `embedding dimension mismatch: got ${wrong.length}, expected ${embedder.dimensions}`,
        );
      }
    }
    const put = this.#db.query(
      `INSERT OR REPLACE INTO embeddings(content_hash, model, dimensions, vector)
       VALUES (?1, ?2, ?3, ?4)`,
    );
    const putLsh = this.#db.query(
      `INSERT OR REPLACE INTO embedding_lsh(content_hash, model, dimensions, band, code)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    );
    this.#db.transaction(() => {
      vectors.forEach((vector, i) => {
        const hash = required(chosen[i]).content_hash;
        put.run(hash, identity, vector.length, vectorToBytes(vector));
        lshBands(vector).forEach((code, band) => {
          putLsh.run(hash, identity, vector.length, band, code);
        });
      });
      this.#setMetadata(EMBED_CURSOR, String(lastAttempted));
    })();
    return vectors.length;
  }

  #metadata(key: string): string | undefined {
    const row = this.#db.query("SELECT value FROM metadata WHERE key = ?1").get(key) as { value: string } | null;
    return row?.value;
  }

  #setMetadata(key: string, value: string): void {
    this.#db.query(
      "INSERT INTO metadata(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, value);
  }
}

export function chunkVisibleText(text: string): string[] {
  return chunkText(text, HISTORY_CHUNK_CHARS, HISTORY_CHUNK_OVERLAP);
}

export async function loadMessageTexts(
  ref: CharacterHistoryRef,
  rows: readonly IndexedMessage[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const groups = new Map<string, IndexedMessage[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.archive_key, row.segment]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const reader = await CharacterHistoryReader.load(ref);
  try {
    for (const group of groups.values()) {
      const first = required(group[0]);
      const messages = await reader.readSegment(first.archive_key, first.segment);
      for (const row of group) {
        const message = messages[row.ordinal];
        if (message === undefined) continue;
        const text = visibleText(message);
        if (text !== undefined) out.set(row.id, text);
      }
    }
  } finally {
    reader.close();
  }
  return out;
}

export async function loadCanonicalTexts(
  ref: CharacterHistoryRef,
  rows: readonly IndexedMessage[],
): Promise<Map<number, string>> {
  const loaded = await loadMessageTexts(ref, rows);
  const out = new Map<number, string>();
  for (const row of rows) {
    const text = loaded.get(row.id);
    if (text !== undefined && contentHash(text) === row.content_hash) out.set(row.id, text);
  }
  return out;
}

async function readCanonicalCorpus(ref: CharacterHistoryRef): Promise<CanonicalCorpus> {
  const messages: CanonicalMessage[] = [];
  const distinct = new Set<string>();
  let selectedCount = 0;
  const reader = await CharacterHistoryReader.load(ref);
  try {
    for (const entry of reader.entries()) {
      if (entry.excluded === true) continue;
      const archived = await reader.readSegment(entry.archiveKey, entry.idx);
      appendCanonical(messages, archived, entry.archiveKey, entry.idx);
      archived.forEach((message, ordinal) => {
        distinct.add(
          versionOf(message) ?? `occurrence:${entry.archiveKey}:${String(entry.idx)}:${String(ordinal)}`,
        );
      });
      selectedCount += archived.length;
    }
  } finally {
    reader.close();
  }
  return { messages, selectedCount, distinctCount: distinct.size };
}

async function readStableCanonicalCorpus(
  ref: CharacterHistoryRef,
  initialFingerprint: string,
): Promise<{ corpus: CanonicalCorpus; fingerprint: string }> {
  let before = initialFingerprint;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const corpus = await readCanonicalCorpus(ref);
    const after = await sourceFingerprint(ref);
    if (before === after) return { corpus, fingerprint: after };
    before = after;
  }
  throw new Error("history archive changed repeatedly while the search index was reconciling");
}

function appendCanonical(out: CanonicalMessage[], messages: readonly Message[], archiveKey: string, segment: number): void {
  messages.forEach((message, ordinal) => {
    const selected = visibleText(message);
    if (selected === undefined) return;
    out.push({
      locator: JSON.stringify([archiveKey, segment, ordinal]), archive_key: archiveKey, segment, ordinal,
      msgId: message.msg_id, role: message.role, timestamp: message.timestamp,
      model: message.model, version: versionOf(message), text: selected,
    });
  });
}

function visibleText(value: Message | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = deriveContentFromBlocks(value.content_blocks, false);
  return text === "" ? undefined : text;
}

function ftsExpression(query: string): string | undefined {
  const terms = query.toLocaleLowerCase().match(/[\p{Alphabetic}\p{Number}\p{Mark}_]+/gu) ?? [];
  const usable = terms.filter((term) => Buffer.byteLength(term, "utf8") >= 2);
  if (usable.length === 0) return undefined;
  return [...new Set(usable)].map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function sourceFingerprint(ref: CharacterHistoryRef): Promise<string> {
  const reader = await CharacterHistoryReader.load(ref);
  let digest: string;
  try {
    digest = reader.archiveDigest();
  } finally {
    reader.close();
  }
  const legacy = [
    compactionManifestIn(ref.mainConversationDir),
    segmentsDirIn(ref.mainConversationDir),
  ].map((path) => {
    try {
      const s = statSync(path, { bigint: true });
      return `${path}:${s.size}:${s.mtimeNs}`;
    } catch {
      return `${path}:-`;
    }
  }).join("|");
  return `${digest}|${legacy}`;
}

function embeddingIdentity(embedder: Embedder): string {
  return embedder.identity ?? `${embedder.modelId}:${embedder.dimensions ?? "native"}`;
}

function vectorToBytes(vector: readonly number[]): Uint8Array {
  let max = 0;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const scale = max === 0 ? 0 : 127 / max;
  const quantized = new Int8Array(vector.length);
  vector.forEach((value, i) => {
    quantized[i] = Math.max(-127, Math.min(127, Math.round(value * scale)));
  });
  return new Uint8Array(quantized.buffer.slice(0));
}

function bytesToVector(bytes: Uint8Array): Int8Array {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Int8Array(copy);
}

interface LshProbe {
  band: number;
  code: number;
  weight: number;
}

function lshProbes(vector: readonly number[]): LshProbe[] {
  if (vector.length === 0) return [];
  return lshBands(vector).flatMap((code, band) => [
    { band, code, weight: 2 },
    ...Array.from({ length: LSH_BITS_PER_BAND }, (_, bit) => ({
      band,
      code: code ^ (1 << bit),
      weight: 1,
    })),
  ]);
}

function lshBands(vector: readonly number[]): number[] {
  if (vector.length === 0) return [];
  return Array.from({ length: LSH_BANDS }, (_, band) => {
    let code = 0;
    for (let bitInBand = 0; bitInBand < LSH_BITS_PER_BAND; bitInBand += 1) {
      const bit = band * LSH_BITS_PER_BAND + bitInBand;
      let sum = 0;
      for (let sample = 0; sample < LSH_SAMPLES_PER_BIT; sample += 1) {
        const mixed = mix32(Math.imul(bit + 1, 0x9e3779b1) ^ Math.imul(sample + 1, 0x85ebca6b));
        const index = (mixed >>> 1) % vector.length;
        sum += required(vector[index]) * ((mixed & 1) === 0 ? -1 : 1);
      }
      if (sum >= 0) code |= 1 << bitInBand;
    }
    return code;
  });
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += required(a[i]) * required(b[i]);
    aa += required(a[i]) * required(a[i]);
    bb += required(b[i]) * required(b[i]);
  }
  return aa === 0 || bb === 0 ? Number.NEGATIVE_INFINITY : dot / Math.sqrt(aa * bb);
}

function compareLocator(a: IndexedMessage, b: IndexedMessage): number {
  return a.archive_key.localeCompare(b.archive_key) || a.segment - b.segment || a.ordinal - b.ordinal;
}

function removeCacheFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try { unlinkSync(candidate); } catch {}
  }
}
