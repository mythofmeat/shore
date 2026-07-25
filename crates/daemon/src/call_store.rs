//! Unified, compressed, queryable store for the daemon's observability records.
//!
//! Two kinds of record share one SQLite database:
//!
//! - **calls** — the raw provider request/response for *every* LLM call (chat,
//!   tool loops, heartbeat, dreaming, compaction, …). Each payload is stored as
//!   a zstd-compressed blob; the repeated prompt context across calls compresses
//!   away, so the on-disk footprint is a fraction of the raw bytes.
//! - **transcripts** — the curated, readable heartbeat/dreaming view (reasoning,
//!   tool I/O, the model/provider that served the call), stored as a compressed
//!   JSON blob.
//!
//! Retention is time-based ([`rotate`](CallStore::rotate) deletes rows older
//! than a cutoff) with a total-size backstop that evicts oldest-first. The store
//! is observability only — never authoritative conversation state — and lives in
//! the cache dir.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;

/// zstd compression level. Level 3 is the zstd default: strong ratio on
/// repetitive JSON at high throughput, so it stays cheap on the hot path.
const ZSTD_LEVEL: i32 = 3;

const SCHEMA: &str = r"
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
";

/// Errors from the call store.
#[derive(Debug, thiserror::Error)]
pub enum CallStoreError {
    /// Underlying SQLite failure.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// zstd compress/decompress failure (an `io::Error`).
    #[error("compression: {0}")]
    Compression(#[from] std::io::Error),
}

type Result<T> = std::result::Result<T, CallStoreError>;

/// Token counts for one call.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
}

/// A raw LLM call to record. Borrows its large payload strings so the caller
/// does not copy multi-megabyte bodies before they are compressed.
#[derive(Debug)]
pub struct CallRecord<'rec> {
    pub call_id: &'rec str,
    pub ts: DateTime<Utc>,
    pub call_type: Option<&'rec str>,
    pub character: Option<&'rec str>,
    pub model: Option<&'rec str>,
    pub provider: Option<&'rec str>,
    pub sdk: Option<&'rec str>,
    pub rid: Option<&'rec str>,
    pub finish_reason: Option<&'rec str>,
    pub usage: Usage,
    pub duration_ms: Option<u64>,
    pub error: Option<&'rec str>,
    pub request_body: &'rec str,
    pub response_body: Option<&'rec str>,
}

/// A curated transcript entry to record (heartbeat/dreaming view).
#[derive(Debug)]
pub struct TranscriptRecord<'rec> {
    pub ts: DateTime<Utc>,
    pub source: &'rec str,
    pub character: Option<&'rec str>,
    pub call_type: Option<&'rec str>,
    pub iteration: u32,
    pub model: Option<&'rec str>,
    pub provider: Option<&'rec str>,
    pub finish_reason: Option<&'rec str>,
    pub usage: Usage,
    /// Serialized JSON of the curated entry (reasoning, text, tool calls).
    pub entry_json: &'rec str,
}

/// Metadata for one stored call (the index view; no payload bodies).
#[derive(Debug, Clone, Serialize)]
pub struct CallSummary {
    pub id: i64,
    pub call_id: String,
    pub ts: String,
    pub call_type: Option<String>,
    pub character: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub finish_reason: Option<String>,
    pub usage: Usage,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    /// Compressed byte size of the stored request blob.
    pub request_bytes: u64,
    /// Compressed byte size of the stored response blob.
    pub response_bytes: u64,
}

/// A stored call with its decompressed payload bodies.
#[derive(Debug, Clone, Serialize)]
pub struct CallPayload {
    #[serde(flatten)]
    pub summary: CallSummary,
    pub request: Option<String>,
    pub response: Option<String>,
}

/// A stored transcript entry with its decompressed JSON.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptRow {
    pub id: i64,
    pub ts: String,
    pub source: String,
    pub character: Option<String>,
    pub call_type: Option<String>,
    pub iteration: u32,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub finish_reason: Option<String>,
    pub usage: Usage,
    /// The curated entry, parsed back to JSON.
    pub entry: serde_json::Value,
}

/// Filter for [`CallStore::query_calls`].
#[derive(Debug, Clone, Default)]
pub struct CallFilter {
    pub call_type: Option<String>,
    pub character: Option<String>,
    pub limit: usize,
}

/// What [`CallStore::rotate`] removed.
#[derive(Debug, Clone, Copy, Default)]
pub struct RotateStats {
    /// Rows deleted for being older than the cutoff (calls + transcripts).
    pub deleted_by_age: u64,
    /// Call rows deleted by the total-size backstop.
    pub deleted_by_size: u64,
}

/// A handle to the observability store.
#[derive(Debug)]
pub struct CallStore {
    conn: Mutex<Connection>,
}

impl CallStore {
    /// Open (or create) a file-backed store and apply the schema.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// Open an in-memory store — intended for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self> {
        // auto_vacuum must be set before the schema is created to take effect on
        // a fresh DB; incremental_vacuum after rotation then reclaims space so
        // the size backstop is real on disk, not just logical.
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;",
        )?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        // Recover the guard on poison rather than panicking: a poisoned lock
        // means a prior writer panicked mid-operation, but the DB itself is
        // transactionally consistent, so continuing is safe.
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Record a raw LLM call. Request/response bodies are zstd-compressed.
    /// Returns the new row id.
    pub fn record_call(&self, call: &CallRecord<'_>) -> Result<i64> {
        let request_blob = zstd_compress(call.request_body)?;
        let response_blob = match call.response_body {
            Some(body) => Some(zstd_compress(body)?),
            None => None,
        };
        let conn = self.lock_conn();
        let _ = conn.execute(
            "INSERT INTO calls (
                call_id, ts, ts_unix, call_type, character, model, provider, sdk,
                rid, finish_reason, input_tokens, output_tokens, cache_read_tokens,
                duration_ms, error, request_zstd, response_zstd
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
            )",
            params![
                call.call_id,
                call.ts.to_rfc3339(),
                call.ts.timestamp(),
                call.call_type,
                call.character,
                call.model,
                call.provider,
                call.sdk,
                call.rid,
                call.finish_reason,
                u64_to_i64(call.usage.input_tokens),
                u64_to_i64(call.usage.output_tokens),
                u64_to_i64(call.usage.cache_read_tokens),
                call.duration_ms.map(u64_to_i64),
                call.error,
                request_blob,
                response_blob,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Record a curated transcript entry (heartbeat/dreaming view).
    pub fn record_transcript(&self, entry: &TranscriptRecord<'_>) -> Result<i64> {
        let entry_blob = zstd_compress(entry.entry_json)?;
        let conn = self.lock_conn();
        let _ = conn.execute(
            "INSERT INTO transcripts (
                ts, ts_unix, source, character, call_type, iteration, model, provider,
                finish_reason, input_tokens, output_tokens, cache_read_tokens, entry_zstd
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                entry.ts.to_rfc3339(),
                entry.ts.timestamp(),
                entry.source,
                entry.character,
                entry.call_type,
                entry.iteration,
                entry.model,
                entry.provider,
                entry.finish_reason,
                u64_to_i64(entry.usage.input_tokens),
                u64_to_i64(entry.usage.output_tokens),
                u64_to_i64(entry.usage.cache_read_tokens),
                entry_blob,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Return call summaries (newest first) matching `filter`. A `None` field
    /// matches everything; `limit == 0` means no limit.
    pub fn query_calls(&self, filter: &CallFilter) -> Result<Vec<CallSummary>> {
        let limit = if filter.limit == 0 {
            -1_i64
        } else {
            usize_to_i64(filter.limit)
        };
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, call_id, ts, call_type, character, model, provider,
                    finish_reason, input_tokens, output_tokens, cache_read_tokens,
                    duration_ms, error,
                    COALESCE(LENGTH(request_zstd), 0), COALESCE(LENGTH(response_zstd), 0)
             FROM calls
             WHERE (?1 IS NULL OR call_type = ?1)
               AND (?2 IS NULL OR character = ?2)
             ORDER BY ts_unix DESC, id DESC
             LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(
                params![filter.call_type, filter.character, limit],
                row_to_summary,
            )?
            .collect::<rusqlite::Result<Vec<CallSummary>>>()?;
        Ok(rows)
    }

    /// Fetch one call by id with its decompressed request/response bodies.
    pub fn get_call(&self, id: i64) -> Result<Option<CallPayload>> {
        // Pull the row (summary + compressed blobs) under the lock, then release
        // it before decompressing so writes are not serialized behind zstd work.
        let row_data = {
            let conn = self.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT id, call_id, ts, call_type, character, model, provider,
                        finish_reason, input_tokens, output_tokens, cache_read_tokens,
                        duration_ms, error,
                        COALESCE(LENGTH(request_zstd), 0), COALESCE(LENGTH(response_zstd), 0),
                        request_zstd, response_zstd
                 FROM calls WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![id])?;
            match rows.next()? {
                Some(row) => {
                    let summary = row_to_summary(row)?;
                    let request_blob: Option<Vec<u8>> = row.get(15)?;
                    let response_blob: Option<Vec<u8>> = row.get(16)?;
                    Some((summary, request_blob, response_blob))
                }
                None => None,
            }
        };
        let Some((summary, request_blob, response_blob)) = row_data else {
            return Ok(None);
        };
        let request = match request_blob {
            Some(blob) => Some(zstd_decompress(&blob)?),
            None => None,
        };
        let response = match response_blob {
            Some(blob) => Some(zstd_decompress(&blob)?),
            None => None,
        };
        Ok(Some(CallPayload {
            summary,
            request,
            response,
        }))
    }

    /// Return transcript rows (newest first) for `source`, decompressed. A
    /// `None` `character` matches every character; `limit == 0` means no limit.
    pub fn query_transcripts(
        &self,
        source: &str,
        character: Option<&str>,
        limit: usize,
    ) -> Result<Vec<TranscriptRow>> {
        let bound = if limit == 0 {
            -1_i64
        } else {
            usize_to_i64(limit)
        };
        // Collect the compressed rows under the lock, then release it before
        // decompressing so writes are not serialized behind zstd work.
        let blobs = {
            let conn = self.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT id, ts, source, character, call_type, iteration, model, provider,
                        finish_reason, input_tokens, output_tokens, cache_read_tokens, entry_zstd
                 FROM transcripts
                 WHERE source = ?1 AND (?2 IS NULL OR character = ?2)
                 ORDER BY ts_unix DESC, id DESC
                 LIMIT ?3",
            )?;
            let collected = stmt
                .query_map(params![source, character, bound], row_to_transcript_blob)?
                .collect::<rusqlite::Result<Vec<TranscriptBlobRow>>>()?;
            collected
        };
        let mut out = Vec::with_capacity(blobs.len());
        for blob in blobs {
            let json = zstd_decompress(&blob.entry_zstd)?;
            let entry = serde_json::from_str(&json)
                .unwrap_or_else(|_| serde_json::Value::String(json.clone()));
            out.push(TranscriptRow {
                id: blob.id,
                ts: blob.ts,
                source: blob.source,
                character: blob.character,
                call_type: blob.call_type,
                iteration: blob.iteration,
                model: blob.model,
                provider: blob.provider,
                finish_reason: blob.finish_reason,
                usage: blob.usage,
                entry,
            });
        }
        Ok(out)
    }

    /// Total number of stored call rows.
    pub fn call_count(&self) -> Result<u64> {
        let conn = self.lock_conn();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM calls", [], |row| row.get(0))?;
        Ok(i64_to_u64(count))
    }

    /// Prune rows older than `cutoff` (by unix seconds), then evict oldest call
    /// rows until the total compressed blob size is at or under
    /// `max_total_bytes`. Reclaims freed pages so the on-disk size actually
    /// shrinks. The newest call row is always kept, even if it alone exceeds the
    /// cap (payloads are never truncated).
    pub fn rotate(&self, cutoff: DateTime<Utc>, max_total_bytes: u64) -> Result<RotateStats> {
        let cutoff_unix = cutoff.timestamp();
        let cap = u64_to_i64(max_total_bytes);
        let conn = self.lock_conn();

        let aged_calls =
            conn.execute("DELETE FROM calls WHERE ts_unix < ?1", params![cutoff_unix])?;
        let aged_tx = conn.execute(
            "DELETE FROM transcripts WHERE ts_unix < ?1",
            params![cutoff_unix],
        )?;

        // Keep the newest rows whose cumulative compressed size stays within the
        // cap; delete the older overflow. The single newest row (highest
        // `(ts_unix, id)`) is excluded from the delete set so it is always kept,
        // even when it alone exceeds the cap.
        let sized = conn.execute(
            "DELETE FROM calls WHERE id IN (
                 SELECT id FROM (
                     SELECT id,
                            SUM(COALESCE(LENGTH(request_zstd), 0) + COALESCE(LENGTH(response_zstd), 0))
                                OVER (ORDER BY ts_unix DESC, id DESC
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
                     FROM calls
                 )
                 WHERE running > ?1
                   AND id != (SELECT id FROM calls ORDER BY ts_unix DESC, id DESC LIMIT 1)
             )",
            params![cap],
        )?;

        conn.execute_batch("PRAGMA incremental_vacuum;")?;

        Ok(RotateStats {
            deleted_by_age: usize_to_u64(aged_calls).saturating_add(usize_to_u64(aged_tx)),
            deleted_by_size: usize_to_u64(sized),
        })
    }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<CallSummary> {
    Ok(CallSummary {
        id: row.get(0)?,
        call_id: row.get(1)?,
        ts: row.get(2)?,
        call_type: row.get(3)?,
        character: row.get(4)?,
        model: row.get(5)?,
        provider: row.get(6)?,
        finish_reason: row.get(7)?,
        usage: Usage {
            input_tokens: i64_to_u64(row.get(8)?),
            output_tokens: i64_to_u64(row.get(9)?),
            cache_read_tokens: i64_to_u64(row.get(10)?),
        },
        duration_ms: row.get::<usize, Option<i64>>(11)?.map(i64_to_u64),
        error: row.get(12)?,
        request_bytes: i64_to_u64(row.get(13)?),
        response_bytes: i64_to_u64(row.get(14)?),
    })
}

struct TranscriptBlobRow {
    id: i64,
    ts: String,
    source: String,
    character: Option<String>,
    call_type: Option<String>,
    iteration: u32,
    model: Option<String>,
    provider: Option<String>,
    finish_reason: Option<String>,
    usage: Usage,
    entry_zstd: Vec<u8>,
}

fn row_to_transcript_blob(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptBlobRow> {
    Ok(TranscriptBlobRow {
        id: row.get(0)?,
        ts: row.get(1)?,
        source: row.get(2)?,
        character: row.get(3)?,
        call_type: row.get(4)?,
        iteration: row.get(5)?,
        model: row.get(6)?,
        provider: row.get(7)?,
        finish_reason: row.get(8)?,
        usage: Usage {
            input_tokens: i64_to_u64(row.get(9)?),
            output_tokens: i64_to_u64(row.get(10)?),
            cache_read_tokens: i64_to_u64(row.get(11)?),
        },
        entry_zstd: row.get(12)?,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn zstd_compress(data: &str) -> Result<Vec<u8>> {
    Ok(zstd::encode_all(data.as_bytes(), ZSTD_LEVEL)?)
}

fn zstd_decompress(blob: &[u8]) -> Result<String> {
    let bytes = zstd::decode_all(blob)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Bring an existing on-disk schema up to current.
///
/// `CREATE TABLE IF NOT EXISTS` never alters a table that already exists, so a
/// column added to [`SCHEMA`] after a DB was first created stays invisible to
/// that DB forever — both reads and writes that name the column then fail. Each
/// step here is idempotent: a fresh DB built straight from `SCHEMA` already has
/// these columns, so the guards make migration a no-op. Add future column
/// additions here, not just to `SCHEMA`.
fn migrate(conn: &Connection) -> Result<()> {
    // `transcripts.character` landed one commit after the table first shipped
    // (foundation DBs lack it). Without it, every transcript insert and the
    // heartbeat/dreaming queries fail with "no such column: character".
    if !column_exists(conn, "transcripts", "character")? {
        conn.execute_batch(
            // Adding the column also lets us restore the covering index to its
            // intended shape so a migrated DB matches a fresh install.
            "ALTER TABLE transcripts ADD COLUMN character TEXT;
             DROP INDEX IF EXISTS idx_transcripts_source;
             CREATE INDEX idx_transcripts_source
                 ON transcripts (source, character, ts_unix);",
        )?;
    }
    Ok(())
}

/// Whether `table` has a column named `column`. `table` is always a hardcoded
/// schema identifier here, never user input, so interpolating it into the
/// `PRAGMA` (which cannot bind identifiers) is safe.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn u64_to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn usize_to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn i64_to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn sample_call<'rec>(
        call_id: &'rec str,
        ts: DateTime<Utc>,
        call_type: &'rec str,
        request: &'rec str,
    ) -> CallRecord<'rec> {
        CallRecord {
            call_id,
            ts,
            call_type: Some(call_type),
            character: Some("poppy"),
            model: Some("claude-x"),
            provider: Some("anthropic"),
            sdk: Some("anthropic"),
            rid: Some("rid_1"),
            finish_reason: Some("end_turn"),
            usage: Usage {
                input_tokens: 100,
                output_tokens: 20,
                cache_read_tokens: 80,
            },
            duration_ms: Some(1234),
            error: None,
            request_body: request,
            response_body: Some("the response body"),
        }
    }

    #[test]
    fn record_and_get_roundtrips_payloads() {
        let store = CallStore::open_in_memory().unwrap();
        // A large repetitive request compresses well and must round-trip exactly.
        let big_request = "context ".repeat(10_000);
        let id = store
            .record_call(&sample_call("c1", Utc::now(), "heartbeat", &big_request))
            .unwrap();

        let got = store.get_call(id).unwrap().expect("row exists");
        assert_eq!(
            got.request.as_deref(),
            Some(big_request.as_str()),
            "request body must round-trip through compression"
        );
        assert_eq!(
            got.response.as_deref(),
            Some("the response body"),
            "response body must round-trip"
        );
        assert_eq!(
            got.summary.call_type.as_deref(),
            Some("heartbeat"),
            "metadata preserved"
        );
        assert!(
            got.summary.request_bytes < usize_to_u64(big_request.len()),
            "stored blob ({} B) must be smaller than the raw body ({} B)",
            got.summary.request_bytes,
            big_request.len()
        );
    }

    #[test]
    fn query_filters_by_call_type_newest_first() {
        let store = CallStore::open_in_memory().unwrap();
        let base = Utc::now();
        let _ = store
            .record_call(&sample_call("c1", base, "message", "a"))
            .unwrap();
        let _ = store
            .record_call(&sample_call(
                "c2",
                base.checked_add_signed(Duration::seconds(1)).unwrap(),
                "heartbeat",
                "b",
            ))
            .unwrap();
        let _ = store
            .record_call(&sample_call(
                "c3",
                base.checked_add_signed(Duration::seconds(2)).unwrap(),
                "heartbeat",
                "c",
            ))
            .unwrap();

        let hb = store
            .query_calls(&CallFilter {
                call_type: Some("heartbeat".to_owned()),
                character: None,
                limit: 0,
            })
            .unwrap();
        let ids: Vec<&str> = hb.iter().map(|s| s.call_id.as_str()).collect();
        assert_eq!(ids, vec!["c3", "c2"], "only heartbeat rows, newest first");

        let all = store.query_calls(&CallFilter::default()).unwrap();
        assert_eq!(all.len(), 3, "no filter returns every row");
    }

    #[test]
    fn transcripts_record_and_query() {
        let store = CallStore::open_in_memory().unwrap();
        let entry = serde_json::json!({"reasoning": ["let me think"], "text": "hi"});
        let json = entry.to_string();
        let _ = store
            .record_transcript(&TranscriptRecord {
                ts: Utc::now(),
                source: "dreaming",
                character: Some("poppy"),
                call_type: Some("dreaming"),
                iteration: 0,
                model: Some("deepseek"),
                provider: Some("deepseek"),
                finish_reason: Some("end_turn"),
                usage: Usage::default(),
                entry_json: &json,
            })
            .unwrap();

        let rows = store.query_transcripts("dreaming", None, 0).unwrap();
        assert_eq!(rows.len(), 1, "one dreaming row");
        let row = rows.first().expect("row present");
        assert_eq!(row.entry, entry, "entry JSON round-trips parsed");
        assert_eq!(
            row.character.as_deref(),
            Some("poppy"),
            "character recorded"
        );
        assert!(
            store
                .query_transcripts("dreaming", Some("other"), 0)
                .unwrap()
                .is_empty(),
            "character filter isolates rows"
        );
        assert!(
            store
                .query_transcripts("heartbeat", None, 0)
                .unwrap()
                .is_empty(),
            "source filter isolates rows"
        );
    }

    /// A DB created by the foundation build (transcripts without `character`,
    /// index over `(source, ts_unix)`) must migrate cleanly: the column gets
    /// added so inserts and character-filtered queries work again.
    #[test]
    fn migrates_foundation_transcripts_missing_character() {
        let conn = Connection::open_in_memory().unwrap();
        // Reproduce the exact foundation-era schema (pre-`character`).
        conn.execute_batch(
            "CREATE TABLE transcripts (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                ts                TEXT NOT NULL,
                ts_unix           INTEGER NOT NULL,
                source            TEXT NOT NULL,
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
            CREATE INDEX idx_transcripts_source ON transcripts (source, ts_unix);",
        )
        .unwrap();

        // init() runs SCHEMA (a no-op against the existing table) then migrate().
        let store = CallStore::init(conn).unwrap();

        let entry = serde_json::json!({"text": "hi"});
        let json = entry.to_string();
        // Writing with a character would have failed pre-migration.
        let _ = store
            .record_transcript(&TranscriptRecord {
                ts: Utc::now(),
                source: "dreaming",
                character: Some("poppy"),
                call_type: Some("dreaming"),
                iteration: 0,
                model: Some("deepseek"),
                provider: Some("deepseek"),
                finish_reason: Some("end_turn"),
                usage: Usage::default(),
                entry_json: &json,
            })
            .unwrap();

        let rows = store
            .query_transcripts("dreaming", Some("poppy"), 0)
            .unwrap();
        assert_eq!(rows.len(), 1, "migrated DB stores and filters by character");
    }

    /// Migration must be idempotent: running it on an already-current DB (the
    /// common case) changes nothing and never errors.
    #[test]
    fn migrate_is_noop_on_current_schema() {
        let store = CallStore::open_in_memory().unwrap();
        let conn = store.lock_conn();
        migrate(&conn).expect("re-migrating a current schema is a no-op");
    }

    #[test]
    fn rotate_prunes_by_age() {
        let store = CallStore::open_in_memory().unwrap();
        let now = Utc::now();
        let old = now.checked_sub_signed(Duration::days(20)).unwrap();
        let _ = store
            .record_call(&sample_call("old", old, "message", "x"))
            .unwrap();
        let _ = store
            .record_call(&sample_call("new", now, "message", "y"))
            .unwrap();

        let cutoff = now.checked_sub_signed(Duration::days(14)).unwrap();
        let stats = store.rotate(cutoff, u64::MAX).unwrap();
        assert_eq!(stats.deleted_by_age, 1, "the 20-day-old row is pruned");

        let remaining = store.query_calls(&CallFilter::default()).unwrap();
        assert_eq!(remaining.len(), 1, "only the fresh row remains");
        assert_eq!(
            remaining.first().expect("row").call_id,
            "new",
            "kept the newest"
        );
    }

    #[test]
    fn rotate_size_backstop_evicts_oldest() {
        let store = CallStore::open_in_memory().unwrap();
        let base = Utc::now();
        // Distinct large bodies so each compressed blob is non-trivial.
        for (idx, marker) in ['a', 'b', 'c', 'd'].into_iter().enumerate() {
            let body = marker.to_string().repeat(20_000);
            let id = format!("c{idx}");
            let ts = base
                .checked_add_signed(Duration::seconds(usize_to_i64(idx)))
                .unwrap();
            let _ = store
                .record_call(&sample_call(&id, ts, "message", &body))
                .unwrap();
        }
        let before = store.query_calls(&CallFilter::default()).unwrap();
        let one_blob = before
            .iter()
            .map(|s| s.request_bytes.saturating_add(s.response_bytes))
            .max()
            .expect("rows exist");

        // Cap that fits ~2 rows: forces eviction of the oldest, keeps newest.
        // Cap that fits ~2 of the (near-equal) blobs, forcing the older rows out.
        let cap = one_blob.saturating_mul(2);
        let stats = store
            .rotate(base.checked_sub_signed(Duration::days(1)).unwrap(), cap)
            .unwrap();
        assert!(
            stats.deleted_by_size >= 1,
            "at least one oldest row evicted by size"
        );

        let remaining = store.query_calls(&CallFilter::default()).unwrap();
        assert!(
            remaining.iter().any(|s| s.call_id == "c3"),
            "newest row (c3) is always retained"
        );
        assert!(
            !remaining.iter().any(|s| s.call_id == "c0"),
            "oldest row (c0) is evicted"
        );
    }

    #[test]
    fn rotate_keeps_newest_row_even_when_it_exceeds_cap() {
        let store = CallStore::open_in_memory().unwrap();
        let base = Utc::now();
        let small = store
            .record_call(&sample_call("old", base, "message", "tiny"))
            .unwrap();
        // The newest row alone is far larger than the cap below.
        let big_ts = base.checked_add_signed(Duration::seconds(1)).unwrap();
        let _ = store
            .record_call(&sample_call("new", big_ts, "message", &"z".repeat(50_000)))
            .unwrap();
        let _ = small;

        // Cap of 1 byte: every row's running total exceeds it, yet the newest
        // row must survive (payloads are never truncated).
        let stats = store
            .rotate(base.checked_sub_signed(Duration::days(1)).unwrap(), 1)
            .unwrap();
        assert!(stats.deleted_by_size >= 1, "the older row is evicted");

        let remaining = store.query_calls(&CallFilter::default()).unwrap();
        assert_eq!(remaining.len(), 1, "exactly the newest row is kept");
        let kept = remaining.first().expect("one row remains");
        assert_eq!(kept.call_id, "new", "newest row survives the cap");
    }
}
