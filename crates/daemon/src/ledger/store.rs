//! SQLite-backed append-only ledger for LLM call recording.

#[cfg(test)]
use crate::ledger::convert::{i64_to_u32, i64_to_u64, u64_to_i64};
use crate::ledger::sync::lock_or_recover;
#[cfg(test)]
use rusqlite::params;
use rusqlite::Connection;
#[cfg(test)]
use rusqlite::Result as SqlResult;
use std::path::Path;
use std::sync::Mutex;
#[cfg(test)]
use tracing::debug;
use tracing::info;

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS calls (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT    NOT NULL,
    character           TEXT    NOT NULL,
    provider            TEXT    NOT NULL,
    api_key_name        TEXT,
    model               TEXT    NOT NULL,
    call_type           TEXT    NOT NULL,
    input_tokens        INTEGER NOT NULL,
    output_tokens       INTEGER NOT NULL,
    cache_read_tokens   INTEGER NOT NULL,
    cache_write_tokens  INTEGER NOT NULL,
    cache_ttl           TEXT    DEFAULT '1h',
    reasoning_effort    TEXT,
    total_ms            INTEGER NOT NULL,
    ttft_ms             INTEGER NOT NULL,
    finish_reason       TEXT    NOT NULL,
    thinking_enabled    INTEGER NOT NULL,
    cache_state         TEXT,
    cache_anomaly       TEXT,
    input_cost          REAL,
    output_cost         REAL,
    cache_read_cost     REAL,
    cache_write_cost    REAL,
    cost_source         TEXT    DEFAULT 'pricing_catalog',
    total_cost          REAL
);

CREATE TABLE IF NOT EXISTS pricing (
    model_id              TEXT PRIMARY KEY,
    input_per_token       REAL NOT NULL,
    output_per_token      REAL NOT NULL,
    cache_read_per_token  REAL NOT NULL,
    cache_write_per_token REAL NOT NULL,
    fetched_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_budget_warnings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_name    TEXT NOT NULL,
    period_start   TEXT NOT NULL,
    threshold      TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (budget_name, period_start, threshold)
);

CREATE INDEX IF NOT EXISTS idx_calls_ts        ON calls (ts);
CREATE INDEX IF NOT EXISTS idx_calls_character ON calls (character);
CREATE INDEX IF NOT EXISTS idx_calls_provider  ON calls (provider);
CREATE INDEX IF NOT EXISTS idx_calls_anomaly   ON calls (cache_anomaly) WHERE cache_anomaly IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_budget_warnings_window
    ON usage_budget_warnings (budget_name, period_start);
";

// ── Data types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CallRow {
    pub ts: String,
    pub character: String,
    pub provider: String,
    pub api_key_name: Option<String>,
    pub model: String,
    pub call_type: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_ttl: Option<String>,
    /// Resolved effort for this call, or `"off"` when thinking was
    /// explicitly disabled. `None` for providers with no effort surface.
    ///
    /// Recorded because it participates in the Anthropic prompt-cache key:
    /// changing it invalidates every message-level breakpoint, so a row with a
    /// different effort than its predecessor explains a cache miss that would
    /// otherwise look like a bug.
    pub reasoning_effort: Option<String>,
    pub total_ms: u32,
    pub ttft_ms: u32,
    pub finish_reason: String,
    pub thinking_enabled: bool,
    pub cache_state: Option<String>,
    pub cache_anomaly: Option<String>,
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
    pub cache_read_cost: Option<f64>,
    pub cache_write_cost: Option<f64>,
    pub cost_source: Option<String>,
    pub total_cost: Option<f64>,
}

// ── Ledger ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Ledger {
    conn: Mutex<Connection>,
}

impl Ledger {
    /// Open (or create) a file-backed database and apply the schema.
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// Open an in-memory database — intended for tests only.
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, rusqlite::Error> {
        // The call store has set these since it was written; the ledger never
        // did, and got away with it because one process opens this file and an
        // in-process `Mutex` serializes every access. That stops being true as
        // soon as anything else opens it: in the default rollback-journal mode
        // a writer locks out readers and a reader locks out the writer, so a
        // `shore usage` query landing at the same moment as a call is a
        // `database is locked` error rather than a wait. WAL lets readers run
        // while a write is in flight, and the timeout makes writer-vs-writer
        // block briefly instead of failing.
        //
        // `journal_mode` is a no-op on the in-memory databases tests use, which
        // report `memory` and carry on.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;",
        )?;
        conn.execute_batch(SCHEMA)?;
        Self::migrate(&conn)?;
        info!("Ledger schema initialized");
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Best-effort migrations for columns added after the initial schema.
    /// SQLite's ADD COLUMN is a no-op if the column already exists (we catch
    /// the "duplicate column" error and ignore it).
    fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
        let add_if_missing = |sql: &str| -> Result<(), rusqlite::Error> {
            match conn.execute_batch(sql) {
                Ok(()) => Ok(()),
                Err(e) if e.to_string().contains("duplicate column") => Ok(()),
                Err(e) => Err(e),
            }
        };

        // v2: cache_ttl on calls
        add_if_missing("ALTER TABLE calls ADD COLUMN cache_ttl TEXT DEFAULT '1h'")?;
        // v3: friendly provider key name for per-key spend attribution.
        add_if_missing("ALTER TABLE calls ADD COLUMN api_key_name TEXT")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_calls_api_key ON calls (provider, api_key_name)",
        )?;
        // v4: provenance for cost totals. Rows with provider-supplied totals
        // must not be replaced by catalog estimates during forced recalculation.
        add_if_missing("ALTER TABLE calls ADD COLUMN cost_source TEXT DEFAULT 'pricing_catalog'")?;
        conn.execute_batch(
            r"UPDATE calls
                  SET cost_source = 'provider_reported'
                WHERE total_cost IS NOT NULL
                  AND input_cost IS NULL
                  AND output_cost IS NULL
                  AND cache_read_cost IS NULL
                  AND cache_write_cost IS NULL",
        )?;
        // v5: de-duplication state for budget threshold warnings.
        conn.execute_batch(
            r"CREATE TABLE IF NOT EXISTS usage_budget_warnings (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                budget_name    TEXT NOT NULL,
                period_start   TEXT NOT NULL,
                threshold      TEXT NOT NULL,
                created_at     TEXT NOT NULL,
                UNIQUE (budget_name, period_start, threshold)
            );
            CREATE INDEX IF NOT EXISTS idx_usage_budget_warnings_window
                ON usage_budget_warnings (budget_name, period_start);",
        )?;
        // v6: resolved reasoning effort. Part of the Anthropic prompt-cache
        // key, so a change between rows explains an otherwise-inexplicable
        // message-level cache miss. Null on pre-v6 rows — unknown, not "off".
        add_if_missing("ALTER TABLE calls ADD COLUMN reasoning_effort TEXT")?;

        Ok(())
    }

    /// Insert a call row, returning its autoincrement ID.
    /// Insert one call row.
    ///
    /// Test-only: the production writer is `llm-sidecar/src/ledger/store.ts`.
    /// This exists so the Rust readers' tests can seed fixtures, and is gated
    /// so a future schema change cannot be made here in the belief that the
    /// daemon still writes rows.
    #[cfg(test)]
    pub fn insert(&self, row: &CallRow) -> Result<i64, rusqlite::Error> {
        let started = std::time::Instant::now();
        let row_id = self.with_conn(|conn| {
            let _ignored = conn.execute(
                r"INSERT INTO calls (
                    ts, character, provider, api_key_name, model, call_type,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    cache_ttl, reasoning_effort,
                    total_ms, ttft_ms, finish_reason, thinking_enabled,
                    cache_state, cache_anomaly,
                    input_cost, output_cost, cache_read_cost, cache_write_cost, cost_source, total_cost
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6,
                    ?7, ?8, ?9, ?10,
                    ?11, ?12,
                    ?13, ?14, ?15, ?16,
                    ?17, ?18,
                    ?19, ?20, ?21, ?22, ?23, ?24
                )",
                params![
                    row.ts,
                    row.character,
                    row.provider,
                    row.api_key_name,
                    row.model,
                    row.call_type,
                    u64_to_i64(row.input_tokens),
                    u64_to_i64(row.output_tokens),
                    u64_to_i64(row.cache_read_tokens),
                    u64_to_i64(row.cache_write_tokens),
                    row.cache_ttl,
                    row.reasoning_effort,
                    row.total_ms,
                    row.ttft_ms,
                    row.finish_reason,
                    i64::from(row.thinking_enabled),
                    row.cache_state,
                    row.cache_anomaly,
                    row.input_cost,
                    row.output_cost,
                    row.cache_read_cost,
                    row.cache_write_cost,
                    row.cost_source,
                    row.total_cost,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })?;
        debug!(
            character = row.character,
            call_type = row.call_type,
            input_tokens = row.input_tokens,
            output_tokens = row.output_tokens,
            elapsed = ?started.elapsed(),
            "Ledger row inserted"
        );
        Ok(row_id)
    }

    /// Return the `limit` most recent rows, newest first.
    /// Test-only: reads back rows a test seeded. See [`Self::insert`].
    #[cfg(test)]
    pub fn recent(&self, limit: u32) -> Result<Vec<CallRow>, rusqlite::Error> {
        let started = std::time::Instant::now();
        let rows = self.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM calls ORDER BY id DESC LIMIT ?1")?;
            let rows = stmt.query_map(params![limit], row_from_sqlite)?;
            rows.collect::<SqlResult<Vec<_>>>()
        })?;
        debug!(count = rows.len(), limit, elapsed = ?started.elapsed(), "Ledger recent query");
        Ok(rows)
    }

    pub(crate) fn with_conn<T>(
        &self,
        op: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, rusqlite::Error> {
        let conn = lock_or_recover("ledger sqlite connection", &self.conn);
        op(&conn)
    }
}

// ── Row deserializer ──────────────────────────────────────────────────────────

/// Test-only, with [`Ledger::recent`]: nothing in the daemon reads rows back
/// any more. The sidecar's `rowFromSqlite` is the live one.
#[cfg(test)]
pub(crate) fn row_from_sqlite(row: &rusqlite::Row<'_>) -> SqlResult<CallRow> {
    // Use column names, not positions. Migrations (e.g. adding `cache_ttl`)
    // append columns to the end of the table on existing databases, which
    // makes positional indexing return the wrong column on migrated rows.
    Ok(CallRow {
        ts: row.get("ts")?,
        character: row.get("character")?,
        provider: row.get("provider")?,
        api_key_name: row.get("api_key_name")?,
        model: row.get("model")?,
        call_type: row.get("call_type")?,
        input_tokens: i64_to_u64(row.get::<_, i64>("input_tokens")?),
        output_tokens: i64_to_u64(row.get::<_, i64>("output_tokens")?),
        cache_read_tokens: i64_to_u64(row.get::<_, i64>("cache_read_tokens")?),
        cache_write_tokens: i64_to_u64(row.get::<_, i64>("cache_write_tokens")?),
        cache_ttl: row.get("cache_ttl")?,
        reasoning_effort: row.get("reasoning_effort")?,
        total_ms: i64_to_u32(row.get::<_, i64>("total_ms")?),
        ttft_ms: i64_to_u32(row.get::<_, i64>("ttft_ms")?),
        finish_reason: row.get("finish_reason")?,
        thinking_enabled: row.get::<_, i64>("thinking_enabled")? != 0,
        cache_state: row.get("cache_state")?,
        cache_anomaly: row.get("cache_anomaly")?,
        input_cost: row.get("input_cost")?,
        output_cost: row.get("output_cost")?,
        cache_read_cost: row.get("cache_read_cost")?,
        cache_write_cost: row.get("cache_write_cost")?,
        cost_source: row.get("cost_source")?,
        total_cost: row.get("total_cost")?,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn test_ledger() -> Ledger {
        Ledger::open_in_memory().unwrap()
    }

    fn first_item<T>(items: &[T]) -> &T {
        items.first().expect("expected at least one item")
    }

    /// A file-backed ledger runs in WAL.
    ///
    /// Load-bearing once a second process opens this file: the default
    /// rollback journal makes a read and a write at the same moment a
    /// `database is locked` error rather than a wait. Asserted against a real
    /// file because `journal_mode` is a no-op in memory, where every other
    /// test here runs — this reports `delete` without the pragma.
    #[test]
    fn a_file_backed_ledger_runs_in_wal() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ledger = Ledger::open(&tmp.path().join("ledger.db")).expect("open");
        let mode: String = ledger
            .with_conn(|conn| conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)))
            .expect("read journal_mode");
        assert_eq!(mode.to_lowercase(), "wal");
    }

    fn sample_row() -> CallRow {
        CallRow {
            ts: "2026-04-05T12:00:00Z".into(),
            character: "aria".into(),
            provider: "anthropic".into(),
            api_key_name: Some("default".into()),
            model: "claude-opus-4-6".into(),
            call_type: "message".into(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 80,
            cache_write_tokens: 20,
            cache_ttl: None,
            reasoning_effort: None,
            total_ms: 1500,
            ttft_ms: 200,
            finish_reason: "end_turn".into(),
            thinking_enabled: true,
            cache_state: Some("warm".into()),
            cache_anomaly: None,
            input_cost: Some(0.0015),
            output_cost: Some(0.00075),
            cache_read_cost: Some(0.0004),
            cache_write_cost: Some(0.0005),
            cost_source: Some("pricing_catalog".into()),
            total_cost: Some(0.00315),
        }
    }

    #[test]
    fn create_and_insert() {
        let ledger = test_ledger();
        let id = ledger.insert(&sample_row()).unwrap();
        assert_eq!(id, 1);
    }

    #[test]
    fn insert_and_read_back() {
        let ledger = test_ledger();
        _ = ledger.insert(&sample_row()).unwrap();
        let rows = ledger.recent(1).unwrap();
        assert_eq!(rows.len(), 1);
        let row = first_item(&rows);
        assert_eq!(row.character, "aria");
        assert_eq!(row.api_key_name.as_deref(), Some("default"));
        assert_eq!(row.input_tokens, 100);
        assert_eq!(row.cache_read_tokens, 80);
        assert!(row.cache_anomaly.is_none());
    }

    #[test]
    fn null_costs_when_pricing_unavailable() {
        let ledger = test_ledger();
        let mut row = sample_row();
        row.input_cost = None;
        row.output_cost = None;
        row.cache_read_cost = None;
        row.cache_write_cost = None;
        row.total_cost = None;
        _ = ledger.insert(&row).unwrap();
        let rows = ledger.recent(1).unwrap();
        assert!(first_item(&rows).total_cost.is_none());
    }

    #[test]
    fn migrated_pre_v2_db_is_readable() {
        // Regression: older databases predate the `cache_ttl` column. The
        // migration appends it to the end of the table, which changes column
        // ordering relative to a freshly-created schema. Reading those rows
        // via positional indexes produces "Invalid column type Integer at
        // index: 10, name: total_ms" errors in production. Names, not
        // positions, must drive deserialization.
        let conn = Connection::open_in_memory().unwrap();
        // Pre-v2 schema: no cache_ttl column.
        conn.execute_batch(
            r"
            CREATE TABLE calls (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                ts                  TEXT    NOT NULL,
                character           TEXT    NOT NULL,
                provider            TEXT    NOT NULL,
                model               TEXT    NOT NULL,
                call_type           TEXT    NOT NULL,
                input_tokens        INTEGER NOT NULL,
                output_tokens       INTEGER NOT NULL,
                cache_read_tokens   INTEGER NOT NULL,
                cache_write_tokens  INTEGER NOT NULL,
                total_ms            INTEGER NOT NULL,
                ttft_ms             INTEGER NOT NULL,
                finish_reason       TEXT    NOT NULL,
                thinking_enabled    INTEGER NOT NULL,
                cache_state         TEXT,
                cache_anomaly       TEXT,
                input_cost          REAL,
                output_cost         REAL,
                cache_read_cost     REAL,
                cache_write_cost    REAL,
                total_cost          REAL
            );
            INSERT INTO calls (
                ts, character, provider, model, call_type,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                total_ms, ttft_ms, finish_reason, thinking_enabled,
                cache_state, cache_anomaly,
                input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost
            ) VALUES (
                '2026-04-05T12:00:00Z', 'aria', 'anthropic', 'claude-opus-4-6', 'message',
                100, 50, 80, 20,
                1500, 200, 'end_turn', 1,
                'warm', 'unexpected_read',
                0.0015, 0.00075, 0.0004, 0.0005, 0.00315
            );
            ",
        )
        .unwrap();

        // Run migrate to add the new column — appended at the end.
        Ledger::migrate(&conn).unwrap();
        let ledger = Ledger {
            conn: Mutex::new(conn),
        };

        let rows = ledger.recent(1).unwrap();
        assert_eq!(rows.len(), 1);
        let row = first_item(&rows);
        assert_eq!(row.character, "aria");
        assert_eq!(row.total_ms, 1500);
        // Pre-v2 rows are backfilled with the cache_ttl column default and
        // have no friendly key name.
        assert_eq!(row.cache_ttl.as_deref(), Some("1h"));
        assert!(row.api_key_name.is_none());
        // The effort a pre-v6 row ran at is unrecoverable, so it stays null.
        // It must NOT default to a value — "unknown" and "off" are different
        // answers when reading a cache miss off an old row.
        assert!(row.reasoning_effort.is_none());
        assert_eq!(row.cost_source.as_deref(), Some("pricing_catalog"));
        assert_eq!(row.cache_anomaly.as_deref(), Some("unexpected_read"));

        // And that the column `shore usage --anomalies` selects on is what the
        // migration left behind. The query itself lives in the sidecar now
        // (`llm-sidecar/src/ledger/query.ts`), so this asserts the predicate it
        // uses rather than running it: the migration is what is under test.
        let anomalous: i64 = ledger
            .with_conn(|db| {
                db.query_row(
                    "SELECT COUNT(*) FROM calls WHERE cache_anomaly IS NOT NULL",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(anomalous, 1);
    }

    #[test]
    fn migration_backfills_provider_reported_cost_source() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r"
            CREATE TABLE calls (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                ts                  TEXT    NOT NULL,
                character           TEXT    NOT NULL,
                provider            TEXT    NOT NULL,
                model               TEXT    NOT NULL,
                call_type           TEXT    NOT NULL,
                input_tokens        INTEGER NOT NULL,
                output_tokens       INTEGER NOT NULL,
                cache_read_tokens   INTEGER NOT NULL,
                cache_write_tokens  INTEGER NOT NULL,
                total_ms            INTEGER NOT NULL,
                ttft_ms             INTEGER NOT NULL,
                finish_reason       TEXT    NOT NULL,
                thinking_enabled    INTEGER NOT NULL,
                cache_state         TEXT,
                cache_anomaly       TEXT,
                input_cost          REAL,
                output_cost         REAL,
                cache_read_cost     REAL,
                cache_write_cost    REAL,
                total_cost          REAL
            );
            INSERT INTO calls (
                ts, character, provider, model, call_type,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                total_ms, ttft_ms, finish_reason, thinking_enabled,
                cache_state, cache_anomaly,
                input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost
            ) VALUES (
                '2026-04-05T12:00:00Z', 'aria', 'openrouter', 'claude-sonnet-4-5', 'message',
                100, 50, 0, 0,
                1500, 200, 'end_turn', 1,
                NULL, NULL,
                NULL, NULL, NULL, NULL, 0.0042
            );
            ",
        )
        .unwrap();

        Ledger::migrate(&conn).unwrap();
        let ledger = Ledger {
            conn: Mutex::new(conn),
        };

        let rows = ledger.recent(1).unwrap();
        assert_eq!(
            first_item(&rows).cost_source.as_deref(),
            Some("provider_reported")
        );
    }

    #[test]
    fn poisoned_connection_mutex_is_recovered() {
        let ledger = test_ledger();

        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = ledger.conn.lock().unwrap();
            panic!("poison ledger sqlite connection");
        }));
        assert!(result.is_err());

        let row_id = ledger.insert(&sample_row()).unwrap();
        assert!(row_id > 0);
    }
}
