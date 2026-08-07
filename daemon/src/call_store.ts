import { Database } from "bun:sqlite";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_LEVEL = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
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
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    cache_read_tokens INTEGER,
    duration_ms       INTEGER,
    error             TEXT,
    request_zstd      BLOB,
    response_zstd     BLOB
);
CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls (ts_unix);
CREATE INDEX IF NOT EXISTS idx_calls_type ON calls (call_type, ts_unix);

CREATE TABLE IF NOT EXISTS transcripts (
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
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    cache_read_tokens INTEGER,
    entry_zstd        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_ts ON transcripts (ts_unix);
CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts (source, character, ts_unix);
`;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };

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

export interface CallSummary {
  id: number;
  call_id: string;
  ts: string;
  call_type: string | null;
  character: string | null;
  model: string | null;
  provider: string | null;
  finish_reason: string | null;
  usage: Usage;
  duration_ms: number | null;
  error: string | null;
  request_bytes: number;
  response_bytes: number;
}

export interface CallPayload extends CallSummary {
  request: string | null;
  response: string | null;
}

export interface TranscriptRow {
  id: number;
  ts: string;
  source: string;
  character: string | null;
  call_type: string | null;
  iteration: number;
  model: string | null;
  provider: string | null;
  finish_reason: string | null;
  usage: Usage;
  entry: unknown;
}

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
    db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;`);
    db.exec(SCHEMA);
    migrate(db);
  }

  static open(path: string): CallStore {
    return new CallStore(new Database(path, { create: true, readwrite: true }));
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

  recordCall(call: CallRecord): number {
    const requestBlob = zstdCompress(call.request_body);
    const responseBlob =
      call.response_body === undefined || call.response_body === null
        ? null
        : zstdCompress(call.response_body);
    this.#db
      .query(
        `INSERT INTO calls (
            call_id, ts, ts_unix, call_type, character, model, provider, sdk,
            rid, finish_reason, input_tokens, output_tokens, cache_read_tokens,
            duration_ms, error, request_zstd, response_zstd
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
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
        call.duration_ms ?? null,
        opt(call.error),
        requestBlob,
        responseBlob,
      );
    return this.#lastInsertRowid();
  }

  recordTranscript(entry: TranscriptRecord): number {
    this.#db
      .query(
        `INSERT INTO transcripts (
            ts, ts_unix, source, character, call_type, iteration, model, provider,
            finish_reason, input_tokens, output_tokens, cache_read_tokens, entry_zstd
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
        zstdCompress(entry.entry_json),
      );
    return this.#lastInsertRowid();
  }

  queryCalls(filter: CallFilter): CallSummary[] {
    const rows = this.#db
      .query(
        `SELECT id, call_id, ts, call_type, character, model, provider,
                finish_reason, input_tokens, output_tokens, cache_read_tokens,
                duration_ms, error,
                COALESCE(LENGTH(request_zstd), 0) AS request_bytes,
                COALESCE(LENGTH(response_zstd), 0) AS response_bytes
         FROM calls
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
                duration_ms, error,
                COALESCE(LENGTH(request_zstd), 0) AS request_bytes,
                COALESCE(LENGTH(response_zstd), 0) AS response_bytes,
                request_zstd, response_zstd
         FROM calls WHERE id = ?1`,
      )
      .get(id) as Row | null;
    if (row === null) return null;
    return {
      ...rowToSummary(row),
      request: blobToText(row["request_zstd"]),
      response: blobToText(row["response_zstd"]),
    };
  }

  queryTranscripts(source: string, character: string | null | undefined, limit: number): TranscriptRow[] {
    const rows = this.#db
      .query(
        `SELECT id, ts, source, character, call_type, iteration, model, provider,
                finish_reason, input_tokens, output_tokens, cache_read_tokens, entry_zstd
         FROM transcripts
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
    const row = this.#db.query("SELECT COUNT(*) AS n FROM calls").get() as Row;
    return count(row["n"]);
  }

  rotate(cutoff: Date, maxTotalBytes: number): RotateStats {
    const cutoffUnix = unixSeconds(cutoff);
    const agedCalls = this.#changes("DELETE FROM calls WHERE ts_unix < ?1", cutoffUnix);
    const agedTranscripts = this.#changes(
      "DELETE FROM transcripts WHERE ts_unix < ?1",
      cutoffUnix,
    );

    const sized = this.#changes(
      `DELETE FROM calls WHERE id IN (
           SELECT id FROM (
               SELECT id,
                      SUM(COALESCE(LENGTH(request_zstd), 0) + COALESCE(LENGTH(response_zstd), 0))
                          OVER (ORDER BY ts_unix DESC, id DESC
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
               FROM calls
           )
           WHERE running > ?1
             AND id != (SELECT id FROM calls ORDER BY ts_unix DESC, id DESC LIMIT 1)
       )`,
      maxTotalBytes,
    );

    this.#db.exec("PRAGMA incremental_vacuum;");

    return {
      deleted_by_age: agedCalls + agedTranscripts,
      deleted_by_size: sized,
    };
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
    request_bytes: count(row["request_bytes"]),
    response_bytes: count(row["response_bytes"]),
  };
}

function usageFrom(row: Row): Usage {
  return {
    input_tokens: count(row["input_tokens"]),
    output_tokens: count(row["output_tokens"]),
    cache_read_tokens: count(row["cache_read_tokens"]),
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
  if (!columnExists(db, "transcripts", "character")) {
    db.exec(
      `ALTER TABLE transcripts ADD COLUMN character TEXT;
       DROP INDEX IF EXISTS idx_transcripts_source;
       CREATE INDEX idx_transcripts_source
           ON transcripts (source, character, ts_unix);`,
    );
  }
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Row[];
  return rows.some((row) => row["name"] === column);
}
