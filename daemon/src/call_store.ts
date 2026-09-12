import { renameLegacyCaptureTables } from "./storage/legacy_schema.ts";
import { required } from "./util/required.ts";

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { splitJsonPayload } from "./payload_split.ts";
import { rateLimitSnapshot } from "./llm/retry_after.ts";

const ZSTD_LEVEL = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capture_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id           TEXT NOT NULL,
    ts                TEXT NOT NULL,
    ts_unix           INTEGER NOT NULL,
    call_type         TEXT,
    character         TEXT,
    model             TEXT,
    provider          TEXT,
    sdk               TEXT,
    rid               TEXT,
    finish_reason     TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    duration_ms        INTEGER,
    error             TEXT,
    request_zstd      BLOB,
    response_zstd     BLOB
);
CREATE INDEX IF NOT EXISTS idx_capture_calls_ts ON capture_calls (ts_unix);
CREATE INDEX IF NOT EXISTS idx_capture_calls_type ON capture_calls (call_type, ts_unix);

CREATE TABLE IF NOT EXISTS capture_transcripts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    ts_unix           INTEGER NOT NULL,
    source            TEXT NOT NULL,
    character         TEXT,
    call_type         TEXT,
    iteration         INTEGER,
    model             TEXT,
    provider          TEXT,
    finish_reason     TEXT,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    entry_zstd         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_transcripts_ts ON capture_transcripts (ts_unix);

CREATE TABLE IF NOT EXISTS capture_http_calls (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id               TEXT NOT NULL,
    seq                   INTEGER NOT NULL,
    ts                    TEXT NOT NULL,
    ts_unix               INTEGER NOT NULL,
    character             TEXT,
    call_type             TEXT,
    rid                   TEXT,
    method                TEXT NOT NULL,
    url                   TEXT NOT NULL,
    status                INTEGER,
    status_text           TEXT,
    duration_ms           INTEGER,
    error                 TEXT,
    request_headers_zstd  BLOB,
    request_body_zstd     BLOB,
    response_headers_zstd BLOB,
    response_body_zstd    BLOB
);
CREATE INDEX IF NOT EXISTS idx_capture_http_calls_call ON capture_http_calls (call_id, seq);
CREATE INDEX IF NOT EXISTS idx_capture_http_calls_ts ON capture_http_calls (ts_unix);

CREATE TABLE IF NOT EXISTS capture_blobs (
    hash       TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    compressed INTEGER NOT NULL,
    data       BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_payloads (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256   TEXT NOT NULL,
    size     INTEGER NOT NULL,
    stored   INTEGER NOT NULL,
    chunks   INTEGER NOT NULL,
    manifest BLOB NOT NULL
);
`;

const HASH_BYTES = 16;
const BLOB_RAW_UNDER = 256;
const MAX_PAYLOAD_BYTES = 33_554_432;

export type Usage = import("./protocol/DiagnosticUsage.ts").DiagnosticUsage;

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

export interface CallRecord {
  call_id: string;
  ts: Date;
  call_type?: string | null;
  character?: string | null;
  model?: string | null;
  provider?: string | null;
  sdk?: string | null;
  rid?: string | null;
  finish_reason?: string | null;
  usage: Usage;
  duration_ms?: number | null;
  error?: string | null;
  request_body: string;
  response_body?: string | null;
}

export interface TranscriptRecord {
  ts: Date;
  source: string;
  character?: string | null;
  call_type?: string | null;
  iteration: number;
  model?: string | null;
  provider?: string | null;
  finish_reason?: string | null;
  usage: Usage;
  entry_json: string;
}

export type CallSummary = import("./protocol/CallSummary.ts").CallSummary;

export interface CallPayload extends CallSummary {
  request: string | null;
  response: string | null;
}

export type TranscriptRow = import("./protocol/TranscriptRow.ts").TranscriptRow;

export interface HttpExchangeRecord {
  call_id: string;
  seq: number;
  ts: Date;
  character?: string | null;
  call_type?: string | null;
  rid?: string | null;
  method: string;
  url: string;
  status?: number | null;
  status_text?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  request_headers: [string, string][];
  request_body: Uint8Array | null;
  response_headers: [string, string][] | null;
  response_body: Uint8Array | null;
}

export interface HttpExchangeRow {
  id: number;
  call_id: string;
  seq: number;
  ts: string;
  character: string | null;
  call_type: string | null;
  rid: string | null;
  method: string;
  url: string;
  status: number | null;
  status_text: string | null;
  duration_ms: number | null;
  error: string | null;
  request_headers: [string, string][];
  request_body: string | null;
  response_headers: [string, string][];
  response_body: string | null;
  request_bytes: number;
  response_bytes: number;
}

export type RateLimitReading = import("./protocol/UsageRateLimitReading.ts").UsageRateLimitReading;

export interface PayloadChunk {
  hash: string;
  bytes: number;
  text: string | null;
}

export type DiffOp = import("./protocol/PayloadDiffOperation.ts").PayloadDiffOperation;

export type PayloadDiffEntry = import("./protocol/PayloadDiffEntry.ts").PayloadDiffEntry;

export interface PayloadDiff {
  from_payload: number;
  to_payload: number;
  chunks: Record<DiffOp, number>;
  bytes: Record<DiffOp, number>;
  entries: PayloadDiffEntry[];
}

export type CallDiff = import("./protocol/CallDiff.ts").CallDiff;

export interface CallFilter {
  call_type?: string | null;
  character?: string | null;
  limit: number;
}

export interface RotateStats {
  deleted_by_age: number;
  deleted_by_size: number;
}

export class CallStore {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
    renameLegacyCaptureTables(db);
    db.run(`PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;`);
    db.run(SCHEMA);
    migrate(db);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_capture_transcripts_source
           ON capture_transcripts (source, character, ts_unix);`,
    );
  }

  static open(path: string): CallStore {
    const store = new CallStore(new Database(path, { create: true, readwrite: true }));
    restrictToOwner(path);
    return store;
  }

  static openInMemory(): CallStore {
    return new CallStore(new Database(":memory:"));
  }

  close(): void {
    this.#db.close();
  }

  get database(): Database {
    return this.#db;
  }

  storePayload(data: Uint8Array | string): number {
    const bytes = capturedBytes(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const chunks = chunkPayload(bytes);
    const manifest = new Uint8Array(chunks.length * HASH_BYTES);

    const insertBlob = this.#db.query(
      "INSERT OR IGNORE INTO capture_blobs (hash, size, compressed, data) VALUES (?1, ?2, ?3, ?4)",
    );
    const counted = new Set<string>();
    let stored = 0;
    chunks.forEach((chunk, index) => {
      const hash = chunkHash(chunk);
      manifest.set(hash, index * HASH_BYTES);
      const packed = packBlob(chunk);
      const hex = hexOf(hash);
      insertBlob.run(hex, chunk.byteLength, packed.compressed ? 1 : 0, packed.data);
      if (counted.has(hex)) return;
      counted.add(hex);
      stored += packed.data.byteLength;
    });

    const manifestBlob = required(zstdCompressBytes(manifest));
    this.#db
      .query(
        "INSERT INTO capture_payloads (sha256, size, stored, chunks, manifest) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(
        sha256,
        bytes.byteLength,
        stored + manifestBlob.byteLength,
        chunks.length,
        manifestBlob,
      );
    return this.#lastInsertRowid();
  }

  loadPayload(id: number): Uint8Array | null {
    const row = this.#db.query("SELECT manifest, size FROM capture_payloads WHERE id = ?1").get(id) as
      | Row
      | null;
    if (row === null) return null;
    const manifest = row["manifest"];
    if (!(manifest instanceof Uint8Array)) return null;

    const hashes = unpackManifest(zstdDecompressSync(manifest));
    const select = this.#db.query("SELECT size, compressed, data FROM capture_blobs WHERE hash = ?1");
    const out = new Uint8Array(count(row["size"]));
    let offset = 0;
    for (const hash of hashes) {
      const blob = select.get(hash) as Row | null;
      if (blob === null) return null;
      const chunk = unpackBlob(blob);
      if (chunk === null) return null;
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return offset === out.byteLength ? out : null;
  }

  payloadChunks(payloadId: number): PayloadChunk[] | null {
    const hashes = this.#manifestOf(payloadId);
    if (hashes === null) return null;
    const select = this.#db.query("SELECT size, compressed, data FROM capture_blobs WHERE hash = ?1");
    return hashes.map((hash) => {
      const blob = select.get(hash) as Row | null;
      const bytes = blob === null ? null : unpackBlob(blob);
      return {
        hash,
        bytes: bytes?.byteLength ?? 0,
        text: bytes === null ? null : decodeLossy(bytes),
      };
    });
  }

  diffPayloads(fromPayload: number, toPayload: number): PayloadDiff | null {
    const before = this.payloadChunks(fromPayload);
    const after = this.payloadChunks(toPayload);
    if (before === null || after === null) return null;

    const entries = diffChunks(before, after);
    const chunks: Record<DiffOp, number> = { equal: 0, added: 0, removed: 0 };
    const bytes: Record<DiffOp, number> = { equal: 0, added: 0, removed: 0 };
    for (const entry of entries) {
      chunks[entry.op] += 1;
      bytes[entry.op] += entry.bytes;
    }
    return { from_payload: fromPayload, to_payload: toPayload, chunks, bytes, entries };
  }

  previousCallId(id: number): number | null {
    const row = this.#db
      .query(
        `SELECT id FROM capture_calls
         WHERE (ts_unix, id) < (SELECT ts_unix, id FROM capture_calls WHERE id = ?1)
           AND character IS (SELECT character FROM capture_calls WHERE id = ?1)
         ORDER BY ts_unix DESC, id DESC LIMIT 1`,
      )
      .get(id) as Row | null;
    return row === null ? null : int(row["id"]);
  }

  diffCalls(fromCall: number, toCall: number): CallDiff | null {
    const from = this.#requestPayloadOf(fromCall);
    const to = this.#requestPayloadOf(toCall);
    if (from === null || to === null) return null;
    if (from.source !== to.source) return null;

    const diff = this.diffPayloads(from.payload, to.payload);
    if (diff === null) return null;
    return { ...diff, from_call: fromCall, to_call: toCall, source: from.source };
  }

  #requestPayloadOf(callId: number): { payload: number; source: "wire" | "internal" } | null {
    const row = this.#db.query("SELECT call_id, request_payload_id FROM capture_calls WHERE id = ?1").get(
      callId,
    ) as Row | null;
    if (row === null) return null;

    const wire = this.#db
      .query(
        `SELECT request_payload_id FROM capture_http_calls
         WHERE call_id = ?1 AND request_payload_id IS NOT NULL
         ORDER BY seq LIMIT 1`,
      )
      .get(text(row["call_id"])) as Row | null;
    if (wire !== null && typeof wire["request_payload_id"] === "number") {
      return { payload: wire["request_payload_id"], source: "wire" };
    }

    const internal = row["request_payload_id"];
    return typeof internal === "number" ? { payload: internal, source: "internal" } : null;
  }

  #manifestOf(payloadId: number): string[] | null {
    const row = this.#db.query("SELECT manifest FROM capture_payloads WHERE id = ?1").get(payloadId) as
      | Row
      | null;
    if (row === null) return null;
    const manifest = row["manifest"];
    if (!(manifest instanceof Uint8Array)) return null;
    return unpackManifest(zstdDecompressSync(manifest));
  }

  recordCall(call: CallRecord): number {
    const requestPayload = this.storePayload(call.request_body);
    const responsePayload =
      call.response_body === undefined || call.response_body === null
        ? null
        : this.storePayload(call.response_body);
    this.#db
      .query(
        `INSERT INTO capture_calls (
            call_id, ts, ts_unix, call_type, character, model, provider, sdk,
            rid, finish_reason, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, duration_ms, error, request_payload_id, response_payload_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      )
      .run(
        call.call_id,
        rfc3339(call.ts),
        unixSeconds(call.ts),
        opt(call.call_type),
        opt(call.character),
        opt(call.model),
        opt(call.provider),
        opt(call.sdk),
        opt(call.rid),
        opt(call.finish_reason),
        call.usage.input_tokens,
        call.usage.output_tokens,
        call.usage.cache_read_tokens,
        call.usage.cache_write_tokens,
        call.duration_ms ?? null,
        opt(call.error),
        requestPayload,
        responsePayload,
      );
    return this.#lastInsertRowid();
  }

  recordTranscript(entry: TranscriptRecord): number {
    this.#db
      .query(
        `INSERT INTO capture_transcripts (
            ts, ts_unix, source, character, call_type, iteration, model, provider,
            finish_reason, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, entry_zstd
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .run(
        rfc3339(entry.ts),
        unixSeconds(entry.ts),
        entry.source,
        opt(entry.character),
        opt(entry.call_type),
        entry.iteration,
        opt(entry.model),
        opt(entry.provider),
        opt(entry.finish_reason),
        entry.usage.input_tokens,
        entry.usage.output_tokens,
        entry.usage.cache_read_tokens,
        entry.usage.cache_write_tokens,
        zstdCompress(entry.entry_json),
      );
    return this.#lastInsertRowid();
  }

  recordHttpCall(exchange: HttpExchangeRecord): number {
    this.#db
      .query(
        `INSERT INTO capture_http_calls (
            call_id, seq, ts, ts_unix, character, call_type, rid, method, url,
            status, status_text, duration_ms, error,
            request_headers_zstd, request_payload_id,
            response_headers_zstd, response_payload_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .run(
        exchange.call_id,
        exchange.seq,
        rfc3339(exchange.ts),
        unixSeconds(exchange.ts),
        opt(exchange.character),
        opt(exchange.call_type),
        opt(exchange.rid),
        exchange.method,
        exchange.url,
        exchange.status ?? null,
        opt(exchange.status_text),
        exchange.duration_ms ?? null,
        opt(exchange.error),
        zstdCompress(JSON.stringify(exchange.request_headers)),
        exchange.request_body === null ? null : this.storePayload(exchange.request_body),
        exchange.response_headers === null
          ? null
          : zstdCompress(JSON.stringify(exchange.response_headers)),
        exchange.response_body === null ? null : this.storePayload(exchange.response_body),
      );
    return this.#lastInsertRowid();
  }

  httpCallsFor(call_id: string): HttpExchangeRow[] {
    const rows = this.#db
      .query(
        `SELECT id, call_id, seq, ts, character, call_type, rid, method, url,
                status, status_text, duration_ms, error,
                request_headers_zstd, request_body_zstd, request_payload_id,
                response_headers_zstd, response_body_zstd, response_payload_id,
                (SELECT size FROM capture_payloads WHERE id = request_payload_id) AS request_size,
                (SELECT size FROM capture_payloads WHERE id = response_payload_id) AS response_size
         FROM capture_http_calls WHERE call_id = ?1 ORDER BY seq`,
      )
      .all(call_id) as Row[];
    return rows.map((row) => ({
      id: int(row["id"]),
      call_id: text(row["call_id"]),
      seq: count(row["seq"]),
      ts: text(row["ts"]),
      character: optText(row["character"]),
      call_type: optText(row["call_type"]),
      rid: optText(row["rid"]),
      method: text(row["method"]),
      url: text(row["url"]),
      status: optCount(row["status"]),
      status_text: optText(row["status_text"]),
      duration_ms: optCount(row["duration_ms"]),
      error: optText(row["error"]),
      request_headers: headersFrom(row["request_headers_zstd"]),
      request_body: this.#bodyText(row["request_payload_id"], row["request_body_zstd"]),
      response_headers: headersFrom(row["response_headers_zstd"]),
      response_body: this.#bodyText(row["response_payload_id"], row["response_body_zstd"]),
      request_bytes: uncompressedBytes(row["request_size"], row["request_body_zstd"]),
      response_bytes: uncompressedBytes(row["response_size"], row["response_body_zstd"]),
    }));
  }

  latestRateLimits(limitPerHost = 40): RateLimitReading[] {
    const rows = this.#db
      .query(
        `SELECT url, ts, response_headers_zstd
           FROM capture_http_calls
          WHERE status IS NOT NULL AND response_headers_zstd IS NOT NULL
          ORDER BY id DESC LIMIT ?1`,
      )
      .all(limitPerHost) as Row[];

    const byHost = new Map<string, RateLimitReading>();
    for (const row of rows) {
      const url = text(row["url"]);
      const host = hostOf(url);
      if (host === undefined || byHost.has(host)) continue;
      const snapshot = rateLimitSnapshot(headersFrom(row["response_headers_zstd"]));
      if (snapshot === undefined) continue;
      byHost.set(host, { host, observed_at: text(row["ts"]), ...snapshot });
    }
    return [...byHost.values()];
  }

  httpCallCount(): number {
    const row = this.#db.query("SELECT COUNT(*) AS n FROM capture_http_calls").get() as Row;
    return count(row["n"]);
  }

  queryCalls(filter: CallFilter): CallSummary[] {
    const rows = this.#db
      .query(
        `SELECT id, call_id, ts, call_type, character, model, provider,
                finish_reason, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, duration_ms, error,
                (SELECT size FROM capture_payloads WHERE id = request_payload_id) AS request_size,
                (SELECT size FROM capture_payloads WHERE id = response_payload_id) AS response_size,
                request_zstd, response_zstd
         FROM capture_calls
         WHERE (?1 IS NULL OR call_type = ?1)
           AND (?2 IS NULL OR character = ?2)
         ORDER BY ts_unix DESC, id DESC
         LIMIT ?3`,
      )
      .all(opt(filter.call_type), opt(filter.character), bound(filter.limit)) as Row[];
    return rows.map(rowToSummary);
  }

  getCall(id: number): CallPayload | null {
    const row = this.#db
      .query(
        `SELECT id, call_id, ts, call_type, character, model, provider,
                finish_reason, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, duration_ms, error,
                (SELECT size FROM capture_payloads WHERE id = request_payload_id) AS request_size,
                (SELECT size FROM capture_payloads WHERE id = response_payload_id) AS response_size,
                request_zstd, response_zstd,
                request_payload_id, response_payload_id
         FROM capture_calls WHERE id = ?1`,
      )
      .get(id) as Row | null;
    if (row === null) return null;
    return {
      ...rowToSummary(row),
      request: this.#bodyText(row["request_payload_id"], row["request_zstd"]),
      response: this.#bodyText(row["response_payload_id"], row["response_zstd"]),
    };
  }

  #bodyText(payloadId: unknown, legacy: unknown): string | null {
    if (typeof payloadId === "number") {
      const bytes = this.loadPayload(payloadId);
      if (bytes !== null) return new TextDecoder("utf-8").decode(bytes);
    }
    return blobToText(legacy);
  }

  queryTranscripts(source: string, character: string | null | undefined, limit: number): TranscriptRow[] {
    const rows = this.#db
      .query(
        `SELECT id, ts, source, character, call_type, iteration, model, provider,
                finish_reason, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, entry_zstd
         FROM capture_transcripts
         WHERE source = ?1 AND (?2 IS NULL OR character = ?2)
         ORDER BY ts_unix DESC, id DESC
         LIMIT ?3`,
      )
      .all(source, opt(character), bound(limit)) as Row[];
    return rows.map((row) => ({
      id: int(row["id"]),
      ts: text(row["ts"]),
      source: text(row["source"]),
      character: optText(row["character"]),
      call_type: optText(row["call_type"]),
      iteration: count(row["iteration"]),
      model: optText(row["model"]),
      provider: optText(row["provider"]),
      finish_reason: optText(row["finish_reason"]),
      usage: usageFrom(row),
      entry: parseEntry(blobToText(row["entry_zstd"]) ?? ""),
    }));
  }

  callCount(): number {
    const row = this.#db.query("SELECT COUNT(*) AS n FROM capture_calls").get() as Row;
    return count(row["n"]);
  }

  forgetCharacter(character: string): number {
    const removed =
      this.#changes("DELETE FROM capture_calls WHERE character = ?1", character) +
      this.#changes("DELETE FROM capture_transcripts WHERE character = ?1", character) +
      this.#changes("DELETE FROM capture_http_calls WHERE character = ?1", character);
    this.#collectGarbage();
    return removed;
  }

  expireBefore(cutoff: Date): number {
    const cutoffUnix = unixSeconds(cutoff);
    return this.#db.transaction(() => {
      let removed = 0;
      for (const table of ["capture_calls", "capture_transcripts", "capture_http_calls"]) {
        removed += this.#changes(`DELETE FROM ${table} WHERE ts_unix < ?1`, cutoffUnix);
      }
      if (removed > 0) this.#collectGarbage();
      return removed;
    })();
  }

  rotate(cutoff: Date, maxTotalBytes: number): RotateStats {
    const cutoffUnix = unixSeconds(cutoff);
    const agedCalls = this.#changes("DELETE FROM capture_calls WHERE ts_unix < ?1", cutoffUnix);
    const agedTranscripts = this.#changes(
      "DELETE FROM capture_transcripts WHERE ts_unix < ?1",
      cutoffUnix,
    );

    const agedHttp = this.#changes("DELETE FROM capture_http_calls WHERE ts_unix < ?1", cutoffUnix);

    const sized = this.#changes(
      `DELETE FROM capture_calls WHERE id IN (
           SELECT id FROM (
               SELECT id,
                      SUM(COALESCE(request_stored, LENGTH(request_zstd), 0)
                          + COALESCE(response_stored, LENGTH(response_zstd), 0)
                          + COALESCE(wire.bytes, 0))
                          OVER (ORDER BY ts_unix DESC, id DESC
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
               FROM (
                   SELECT capture_calls.*,
                          (SELECT stored FROM capture_payloads WHERE id = request_payload_id)
                              AS request_stored,
                          (SELECT stored FROM capture_payloads WHERE id = response_payload_id)
                              AS response_stored
                   FROM capture_calls
               ) AS capture_calls
               LEFT JOIN (
                   SELECT call_id,
                          SUM(COALESCE(LENGTH(request_headers_zstd), 0)
                              + COALESCE(LENGTH(response_headers_zstd), 0)
                              + COALESCE(
                                  (SELECT stored FROM capture_payloads WHERE id = request_payload_id),
                                  LENGTH(request_body_zstd), 0)
                              + COALESCE(
                                  (SELECT stored FROM capture_payloads WHERE id = response_payload_id),
                                  LENGTH(response_body_zstd), 0)) AS bytes
                   FROM capture_http_calls GROUP BY call_id
               ) AS wire ON wire.call_id = capture_calls.call_id
           )
           WHERE running > ?1
             AND id != (SELECT id FROM capture_calls ORDER BY ts_unix DESC, id DESC LIMIT 1)
       )`,
      maxTotalBytes,
    );

    const orphaned = this.#changes(
      "DELETE FROM capture_http_calls WHERE call_id NOT IN (SELECT call_id FROM capture_calls)",
    );
    this.#collectGarbage();

    return {
      deleted_by_age: agedCalls + agedTranscripts + agedHttp,
      deleted_by_size: sized + orphaned,
    };
  }

  databaseBytes(): number {
    const row = this.#db
      .query("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()")
      .get() as Row;
    return count(row["bytes"]);
  }

  blobCount(): number {
    const row = this.#db.query("SELECT COUNT(*) AS n FROM capture_blobs").get() as Row;
    return count(row["n"]);
  }

  collectUnusedPayloads(): void {
    this.#collectGarbage();
  }

  #collectGarbage(): void {
    this.#changes(
      `DELETE FROM capture_payloads WHERE id NOT IN (
           SELECT request_payload_id FROM capture_calls WHERE request_payload_id IS NOT NULL
           UNION SELECT response_payload_id FROM capture_calls WHERE response_payload_id IS NOT NULL
           UNION SELECT request_payload_id FROM capture_http_calls WHERE request_payload_id IS NOT NULL
           UNION SELECT response_payload_id FROM capture_http_calls WHERE response_payload_id IS NOT NULL
       )`,
    );

    this.#db.run("CREATE TEMP TABLE IF NOT EXISTS live_hashes (hash TEXT PRIMARY KEY)");
    this.#db.run("DELETE FROM live_hashes");
    const remember = this.#db.query("INSERT OR IGNORE INTO live_hashes (hash) VALUES (?1)");
    for (const row of this.#db.query("SELECT manifest FROM capture_payloads").iterate() as Iterable<Row>) {
      const manifest = row["manifest"];
      if (!(manifest instanceof Uint8Array)) continue;
      for (const hash of unpackManifest(zstdDecompressSync(manifest))) remember.run(hash);
    }
    this.#changes("DELETE FROM capture_blobs WHERE hash NOT IN (SELECT hash FROM live_hashes)");
    this.#db.run("DELETE FROM live_hashes");
    this.#db.run("PRAGMA incremental_vacuum;");
  }

  #changes(sql: string, ...values: (string | number | null)[]): number {
    return count(this.#db.query(sql).run(...values).changes);
  }

  #lastInsertRowid(): number {
    const row = this.#db.query("SELECT last_insert_rowid() AS id").get() as Row;
    return int(row["id"]);
  }
}

type Row = Record<string, unknown>;

function rowToSummary(row: Row): CallSummary {
  return {
    id: int(row["id"]),
    call_id: text(row["call_id"]),
    ts: text(row["ts"]),
    call_type: optText(row["call_type"]),
    character: optText(row["character"]),
    model: optText(row["model"]),
    provider: optText(row["provider"]),
    finish_reason: optText(row["finish_reason"]),
    usage: usageFrom(row),
    duration_ms: optCount(row["duration_ms"]),
    error: optText(row["error"]),
    request_bytes: uncompressedBytes(row["request_size"], row["request_zstd"]),
    response_bytes: uncompressedBytes(row["response_size"], row["response_zstd"]),
  };
}

function uncompressedBytes(size: unknown, legacy: unknown): number {
  if (typeof size === "number") return size;
  if (!(legacy instanceof Uint8Array)) return 0;
  return zstdDecompressSync(legacy).byteLength;
}

function usageFrom(row: Row): Usage {
  return {
    input_tokens: count(row["input_tokens"]),
    output_tokens: count(row["output_tokens"]),
    cache_read_tokens: count(row["cache_read_tokens"]),
    cache_write_tokens: count(row["cache_write_tokens"]),
  };
}

function parseEntry(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function zstdCompress(data: string): Uint8Array {
  return zstdCompressSync(Buffer.from(data, "utf8"), {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 0,
    },
  });
}

function diffChunks(before: PayloadChunk[], after: PayloadChunk[]): PayloadDiffEntry[] {
  const rows = before.length;
  const cols = after.length;
  const lengths: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: cols + 1 }, () => 0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      required(lengths[i])[j] =
        required(before[i]).hash === required(after[j]).hash
          ? required(required(lengths[i + 1])[j + 1]) + 1
          : Math.max(required(required(lengths[i + 1])[j]), required(required(lengths[i])[j + 1]));
    }
  }

  const entries: PayloadDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (required(before[i]).hash === required(after[j]).hash) {
      entries.push(entryOf("equal", required(after[j])));
      i++;
      j++;
    } else if (required(required(lengths[i + 1])[j]) >= required(required(lengths[i])[j + 1])) {
      entries.push(entryOf("removed", required(before[i])));
      i++;
    } else {
      entries.push(entryOf("added", required(after[j])));
      j++;
    }
  }
  while (i < rows) entries.push(entryOf("removed", required(before[i++])));
  while (j < cols) entries.push(entryOf("added", required(after[j++])));
  return entries;
}

function entryOf(op: DiffOp, chunk: PayloadChunk): PayloadDiffEntry {
  return { op, hash: chunk.hash, bytes: chunk.bytes, text: op === "equal" ? null : chunk.text };
}

function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function capturedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength <= MAX_PAYLOAD_BYTES) return bytes;
  const notice = Buffer.from(
    `\n\n[shore: payload truncated, kept ${String(MAX_PAYLOAD_BYTES)} of ${String(bytes.byteLength)} bytes]`,
    "utf8",
  );
  const out = new Uint8Array(MAX_PAYLOAD_BYTES + notice.byteLength);
  out.set(bytes.subarray(0, MAX_PAYLOAD_BYTES), 0);
  out.set(notice, MAX_PAYLOAD_BYTES);
  return out;
}

function chunkPayload(bytes: Uint8Array): Uint8Array[] {
  const decoded = decodeUtf8(bytes);
  if (decoded === null) return [bytes];
  const parts = splitJsonPayload(decoded);
  if (parts === null) return [bytes];

  const chunks = parts.map((part) => Buffer.from(part, "utf8") as Uint8Array);
  const rebuilt = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (rebuilt !== bytes.byteLength) return [bytes];
  return chunks;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function chunkHash(chunk: Uint8Array): Uint8Array {
  return createHash("sha256").update(chunk).digest().subarray(0, HASH_BYTES);
}

function hexOf(hash: Uint8Array): string {
  return Buffer.from(hash).toString("hex");
}

function packBlob(chunk: Uint8Array): { data: Uint8Array; compressed: boolean } {
  if (chunk.byteLength < BLOB_RAW_UNDER) return { data: chunk, compressed: false };
  const packed = required(zstdCompressBytes(chunk));
  return packed.byteLength < chunk.byteLength
    ? { data: packed, compressed: true }
    : { data: chunk, compressed: false };
}

function unpackBlob(row: Row): Uint8Array | null {
  const data = row["data"];
  if (!(data instanceof Uint8Array)) return null;
  return count(row["compressed"]) === 1 ? zstdDecompressSync(data) : data;
}

function unpackManifest(manifest: Uint8Array): string[] {
  const hashes: string[] = [];
  for (let offset = 0; offset + HASH_BYTES <= manifest.byteLength; offset += HASH_BYTES) {
    hashes.push(hexOf(manifest.subarray(offset, offset + HASH_BYTES)));
  }
  return hashes;
}

function zstdCompressBytes(data: Uint8Array | null): Uint8Array | null {
  if (data === null) return null;
  return zstdCompressSync(data, {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 0,
    },
  });
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function headersFrom(blob: unknown): [string, string][] {
  const json = blobToText(blob);
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as [string, string][]) : [];
  } catch {
    return [];
  }
}

function restrictToOwner(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch {
    }
  }
}

function blobToText(blob: unknown): string | null {
  if (!(blob instanceof Uint8Array)) return null;
  return new TextDecoder("utf-8").decode(zstdDecompressSync(blob));
}

function rfc3339(ts: Date): string {
  const iso = ts.toISOString();
  return `${iso.replace(/\.000Z$/, "").replace(/Z$/, "")}+00:00`;
}

function unixSeconds(ts: Date): number {
  return Math.floor(ts.getTime() / 1000);
}

function bound(limit: number): number {
  return limit === 0 ? -1 : limit;
}

function opt(value: string | null | undefined): string | null {
  return value ?? null;
}

function int(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optText(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function optCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(v, 0) : null;
}

function migrate(db: Database): void {
  addIntegerColumns(db, [
    ["capture_calls", "request_payload_id"],
    ["capture_calls", "response_payload_id"],
    ["capture_http_calls", "request_payload_id"],
    ["capture_http_calls", "response_payload_id"],
  ]);

  if (!columnExists(db, "capture_transcripts", "character")) {
    db.run(
      `DROP INDEX IF EXISTS idx_capture_transcripts_source;
       ALTER TABLE capture_transcripts ADD COLUMN character TEXT;`,
    );
  }

  addIntegerColumns(db, [
    ["capture_calls", "cache_write_tokens"],
    ["capture_transcripts", "cache_write_tokens"],
  ]);
}

function addIntegerColumns(db: Database, columns: readonly (readonly [string, string])[]): void {
  for (const [table, column] of columns) {
    if (!columnExists(db, table, column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
    }
  }
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Row[];
  return rows.some((row) => row["name"] === column);
}
