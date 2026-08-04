/**
 * Unified, compressed, queryable store for the daemon's observability records.
 *
 * Two kinds of record share one SQLite database:
 *
 * - **calls** — the raw provider request/response for *every* LLM call (chat,
 *   tool loops, heartbeat, dreaming, compaction, …). Each payload is stored as
 *   a zstd-compressed blob; the repeated prompt context across calls compresses
 *   away, so the on-disk footprint is a fraction of the raw bytes.
 * - **transcripts** — the curated, readable heartbeat/dreaming view (reasoning,
 *   tool I/O, the model/provider that served the call), stored as a compressed
 *   JSON blob.
 *
 * Retention is time-based ({@link CallStore.rotate} deletes rows older than a
 * cutoff) with a total-size backstop that evicts oldest-first. The store is
 * observability only — never authoritative conversation state — and lives in
 * the cache dir.
 *
 * The Rust this came from guards the connection with a mutex and recovers the
 * guard on poison. There is nothing to guard here: `bun:sqlite` is synchronous
 * and this process has one thread, so a statement cannot be interleaved with
 * another. `busy_timeout` still matters, because a *second process* — the
 * Rust CLI reading the same file — is a real writer.
 */

import { Database } from "bun:sqlite";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

/**
 * zstd compression level. Level 3 is the zstd default: strong ratio on
 * repetitive JSON at high throughput, so it stays cheap on the hot path.
 */
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

// ── records ─────────────────────────────────────────────────────────────────

/** Token counts for one call. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };

/** A raw LLM call to record. */
export interface CallRecord {
  call_id: string;
  /** The call's instant. Serialised as RFC 3339, and as unix seconds to sort by. */
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

/** A curated transcript entry to record (heartbeat/dreaming view). */
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
  /** Serialized JSON of the curated entry (reasoning, text, tool calls). */
  entry_json: string;
}

/** Metadata for one stored call (the index view; no payload bodies). */
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
  /** Compressed byte size of the stored request blob. */
  request_bytes: number;
  /** Compressed byte size of the stored response blob. */
  response_bytes: number;
}

/**
 * A stored call with its decompressed payload bodies.
 *
 * The Rust `#[serde(flatten)]`s the summary, so the wire shape is the summary's
 * fields with `request`/`response` alongside them, not nested under a key.
 */
export interface CallPayload extends CallSummary {
  request: string | null;
  response: string | null;
}

/** A stored transcript entry with its decompressed JSON. */
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
  /** The curated entry, parsed back to JSON. */
  entry: unknown;
}

/** Filter for {@link CallStore.queryCalls}. */
export interface CallFilter {
  call_type?: string | null;
  character?: string | null;
  /** `0` means no limit. */
  limit: number;
}

/** What {@link CallStore.rotate} removed. */
export interface RotateStats {
  /** Rows deleted for being older than the cutoff (calls + transcripts). */
  deleted_by_age: number;
  /** Call rows deleted by the total-size backstop. */
  deleted_by_size: number;
}

// ── the store ───────────────────────────────────────────────────────────────

/** A handle to the observability store. */
export class CallStore {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
    // auto_vacuum must be set before the schema is created to take effect on
    // a fresh DB; incremental_vacuum after rotation then reclaims space so
    // the size backstop is real on disk, not just logical.
    db.exec(`PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;`);
    db.exec(SCHEMA);
    migrate(db);
  }

  /** Open (or create) a file-backed store and apply the schema. */
  static open(path: string): CallStore {
    return new CallStore(new Database(path, { create: true, readwrite: true }));
  }

  /** Open an in-memory store — intended for tests. */
  static openInMemory(): CallStore {
    return new CallStore(new Database(":memory:"));
  }

  close(): void {
    this.#db.close();
  }

  /**
   * The open handle, for schema inspection. The store owns exactly one
   * connection per path, and a second `Database` on the same file would race
   * this one's WAL — so anything that needs to read `PRAGMA table_info` or
   * `sqlite_master` borrows this rather than opening its own.
   */
  get database(): Database {
    return this.#db;
  }

  /**
   * Record a raw LLM call. Request/response bodies are zstd-compressed.
   * Returns the new row id.
   */
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

  /** Record a curated transcript entry (heartbeat/dreaming view). */
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

  /**
   * Return call summaries (newest first) matching `filter`. A nullish field
   * matches everything; `limit === 0` means no limit.
   *
   * The `id DESC` tiebreak is deliberate and untestable. Two calls recorded in
   * the same second are common — a tool loop makes several — and without a
   * second sort key their relative order is whatever the query plan happens to
   * produce. Every plan SQLite picks here happens to produce descending rowid
   * already, so no test can tell the tiebreak from its absence; it is written
   * down because "whatever the plan happens to produce" is not a contract.
   */
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

  /** Fetch one call by id with its decompressed request/response bodies. */
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

  /**
   * Return transcript rows (newest first) for `source`, decompressed. A nullish
   * `character` matches every character; `limit === 0` means no limit.
   */
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

  /** Total number of stored call rows. */
  callCount(): number {
    const row = this.#db.query("SELECT COUNT(*) AS n FROM calls").get() as Row;
    return count(row["n"]);
  }

  /**
   * Prune rows older than `cutoff`, then evict oldest call rows until the total
   * compressed blob size is at or under `maxTotalBytes`. Reclaims freed pages so
   * the on-disk size actually shrinks. The newest call row is always kept, even
   * if it alone exceeds the cap (payloads are never truncated).
   */
  rotate(cutoff: Date, maxTotalBytes: number): RotateStats {
    const cutoffUnix = unixSeconds(cutoff);
    const agedCalls = this.#changes("DELETE FROM calls WHERE ts_unix < ?1", cutoffUnix);
    const agedTranscripts = this.#changes(
      "DELETE FROM transcripts WHERE ts_unix < ?1",
      cutoffUnix,
    );

    // Keep the newest rows whose cumulative compressed size stays within the
    // cap; delete the older overflow. The single newest row (highest
    // `(ts_unix, id)`) is excluded from the delete set so it is always kept,
    // even when it alone exceeds the cap.
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

  /**
   * Run a mutation and report how many rows it touched.
   *
   * `Statement.run` returns the change count, but `db.exec` does not, and
   * `changes` is per-connection state that the next statement overwrites — so
   * the count has to be read from the same call that produced it.
   */
  #changes(sql: string, ...values: (string | number | null)[]): number {
    return count(this.#db.query(sql).run(...values).changes);
  }

  #lastInsertRowid(): number {
    const row = this.#db.query("SELECT last_insert_rowid() AS id").get() as Row;
    return int(row["id"]);
  }
}

// ── row mapping ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * Map by column name rather than position. A migration appends its column to
 * the end of the table on an existing DB, which makes positional indexing read
 * the wrong column on a migrated row.
 */
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

/** A stored entry that is not valid JSON comes back as the raw text. */
function parseEntry(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function zstdCompress(data: string): Uint8Array {
  // `contentSizeFlag: 0` matches the frame the Rust writes. Nothing reads the
  // frame header — but with the flag on, every frame carries an extra size
  // field, which would make `request_bytes` differ from the Rust's for *every*
  // row rather than for the occasional payload where the two libzstd builds
  // genuinely disagree.
  return zstdCompressSync(Buffer.from(data, "utf8"), {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 0,
    },
  });
}

/** Decompress a stored blob, or `null` when the column held no blob. */
function blobToText(blob: unknown): string | null {
  if (!(blob instanceof Uint8Array)) return null;
  // Lossy, matching `String::from_utf8_lossy`: a corrupt blob is worth showing
  // with replacement characters, not worth failing a whole query over.
  return new TextDecoder("utf-8").decode(zstdDecompressSync(blob));
}

/**
 * The stored `ts`, spelled the way `DateTime<Utc>::to_rfc3339` spells it.
 *
 * Two differences from `toISOString`, and both are visible in `call_log`
 * output because the string is stored verbatim and handed back unparsed. The
 * offset is `+00:00` rather than `Z`. And the fraction is omitted when it is
 * zero and printed otherwise — chrono's `AutoSi` picks 0, 3, 6 or 9 digits,
 * and a `Date` only ever has 3, so matching it means dropping `.000` and
 * keeping everything else.
 */
function rfc3339(ts: Date): string {
  const iso = ts.toISOString();
  return `${iso.replace(/\.000Z$/, "").replace(/Z$/, "")}+00:00`;
}

function unixSeconds(ts: Date): number {
  return Math.floor(ts.getTime() / 1000);
}

/** `limit === 0` means no limit, which SQLite spells `-1`. */
function bound(limit: number): number {
  return limit === 0 ? -1 : limit;
}

/** `undefined` and `null` are the same absent value to SQLite. */
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

/** A count column, clamping anything outside the non-negative domain to 0. */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function optCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(v, 0) : null;
}

// ── migration ───────────────────────────────────────────────────────────────

/**
 * Bring an existing on-disk schema up to current.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters a table that already exists, so a
 * column added to {@link SCHEMA} after a DB was first created stays invisible to
 * that DB forever — both reads and writes that name the column then fail. Each
 * step here is idempotent: a fresh DB built straight from `SCHEMA` already has
 * these columns, so the guards make migration a no-op. Add future column
 * additions here, not just to `SCHEMA`.
 */
function migrate(db: Database): void {
  // `transcripts.character` landed one commit after the table first shipped
  // (foundation DBs lack it). Without it, every transcript insert and the
  // heartbeat/dreaming queries fail with "no such column: character".
  if (!columnExists(db, "transcripts", "character")) {
    db.exec(
      // Adding the column also lets us restore the covering index to its
      // intended shape so a migrated DB matches a fresh install.
      `ALTER TABLE transcripts ADD COLUMN character TEXT;
       DROP INDEX IF EXISTS idx_transcripts_source;
       CREATE INDEX idx_transcripts_source
           ON transcripts (source, character, ts_unix);`,
    );
  }
}

/**
 * Whether `table` has a column named `column`. `table` is always a hardcoded
 * schema identifier here, never user input, so interpolating it into the
 * `PRAGMA` (which cannot bind identifiers) is safe.
 */
function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Row[];
  return rows.some((row) => row["name"] === column);
}
