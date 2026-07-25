//! Aggregation and filter queries for the CLI.

use crate::convert::{i64_to_u32, i64_to_u64};
use crate::ledger::{row_from_sqlite, CallRow, Ledger};
use rusqlite::params_from_iter;

// ── Filter ───────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
pub struct QueryFilter {
    pub since: Option<String>,
    pub until: Option<String>,
    pub character: Option<String>,
    pub provider: Option<String>,
    pub api_key_name: Option<String>,
    pub model: Option<String>,
    pub call_type: Option<String>,
    pub usage_kinds: Vec<String>,
}

const USAGE_KIND_EXPR: &str = r"CASE
    WHEN call_type = 'heartbeat_tool_loop' THEN 'heartbeat'
    WHEN call_type = 'message' AND finish_reason = 'tool_use' THEN 'message_with_tools'
    WHEN call_type = 'tool_loop' THEN 'message_with_tools'
    WHEN call_type = 'message' THEN 'message_no_tools'
    ELSE call_type
END";

/// Collects WHERE clause fragments and their bound values from a `QueryFilter`.
fn build_where(filter: &QueryFilter) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref v) = filter.since {
        clauses.push(format!("ts >= ?{}", next_param_index(&values)));
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = filter.until {
        clauses.push(format!("ts <= ?{}", next_param_index(&values)));
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = filter.character {
        clauses.push(format!("character = ?{}", next_param_index(&values)));
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = filter.provider {
        clauses.push(format!("provider = ?{}", next_param_index(&values)));
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = filter.api_key_name {
        clauses.push(format!(
            "COALESCE(api_key_name, 'unknown') = ?{}",
            next_param_index(&values)
        ));
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = filter.model {
        clauses.push(format!("model = ?{}", next_param_index(&values)));
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = filter.call_type {
        clauses.push(format!("call_type = ?{}", next_param_index(&values)));
        values.push(Box::new(v.clone()));
    }
    if !filter.usage_kinds.is_empty() {
        let placeholders: Vec<String> = filter
            .usage_kinds
            .iter()
            .map(|v| {
                values.push(Box::new(v.clone()));
                format!("?{}", values.len())
            })
            .collect();
        clauses.push(format!(
            "({USAGE_KIND_EXPR}) IN ({})",
            placeholders.join(", ")
        ));
    }

    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (sql, values)
}

fn next_param_index(values: &[Box<dyn rusqlite::types::ToSql>]) -> usize {
    values.len().saturating_add(1)
}

// ── Summary ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct UsageSummary {
    pub provider: String,
    pub model: String,
    pub call_count: u32,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Default)]
pub struct UsageTotals {
    pub call_count: u32,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
    pub total_cost: f64,
}

/// Sums calls matching the filter without grouping.
pub fn usage_totals(ledger: &Ledger, filter: &QueryFilter) -> Result<UsageTotals, rusqlite::Error> {
    ledger.with_conn(|conn| usage_totals_on(conn, filter))
}

/// [`usage_totals`] against an already-held connection, so a caller running
/// several totals queries can take the ledger lock once and read them as one
/// consistent snapshot.
pub(crate) fn usage_totals_on(
    conn: &rusqlite::Connection,
    filter: &QueryFilter,
) -> Result<UsageTotals, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!(
        r"SELECT COUNT(*) as call_count,
                  COALESCE(SUM(input_tokens), 0) as total_input,
                  COALESCE(SUM(output_tokens), 0) as total_output,
                  COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
                  COALESCE(SUM(cache_write_tokens), 0) as total_cache_write,
                  TOTAL(total_cost) as total_cost
             FROM calls
             {where_clause}",
    );

    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params_from_iter(values.iter()), |row| {
        Ok(UsageTotals {
            call_count: i64_to_u32(row.get::<_, i64>(0)?),
            total_input: i64_to_u64(row.get::<_, i64>(1)?),
            total_output: i64_to_u64(row.get::<_, i64>(2)?),
            total_cache_read: i64_to_u64(row.get::<_, i64>(3)?),
            total_cache_write: i64_to_u64(row.get::<_, i64>(4)?),
            total_cost: row.get::<_, f64>(5)?,
        })
    })
}

/// Groups calls by provider + model, sums token counts and cost.
/// Orders by total_cost DESC (nulls last).
pub fn usage_summary(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<UsageSummary>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!(
        r"SELECT provider, model,
                  COUNT(*) as call_count,
                  SUM(input_tokens) as total_input,
                  SUM(output_tokens) as total_output,
                  SUM(cache_read_tokens) as total_cache_read,
                  SUM(cache_write_tokens) as total_cache_write,
                  TOTAL(total_cost) as total_cost
             FROM calls
             {where_clause}
            GROUP BY provider, model
            ORDER BY total_cost DESC",
    );

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            Ok(UsageSummary {
                provider: row.get(0)?,
                model: row.get(1)?,
                call_count: i64_to_u32(row.get::<_, i64>(2)?),
                total_input: i64_to_u64(row.get::<_, i64>(3)?),
                total_output: i64_to_u64(row.get::<_, i64>(4)?),
                total_cache_read: i64_to_u64(row.get::<_, i64>(5)?),
                total_cache_write: i64_to_u64(row.get::<_, i64>(6)?),
                total_cost: row.get::<_, f64>(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── Summary by call type ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CallTypeSummary {
    pub call_type: String,
    pub call_count: u32,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
    pub total_cost: f64,
}

/// Groups calls by `call_type`. Ordered by total_cost DESC, then call_count DESC.
pub fn usage_summary_by_call_type(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<CallTypeSummary>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!(
        r"SELECT call_type,
                  COUNT(*) as call_count,
                  SUM(input_tokens) as total_input,
                  SUM(output_tokens) as total_output,
                  SUM(cache_read_tokens) as total_cache_read,
                  SUM(cache_write_tokens) as total_cache_write,
                  TOTAL(total_cost) as total_cost
             FROM calls
             {where_clause}
            GROUP BY call_type
            ORDER BY total_cost DESC, call_count DESC",
    );

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            Ok(CallTypeSummary {
                call_type: row.get(0)?,
                call_count: i64_to_u32(row.get::<_, i64>(1)?),
                total_input: i64_to_u64(row.get::<_, i64>(2)?),
                total_output: i64_to_u64(row.get::<_, i64>(3)?),
                total_cache_read: i64_to_u64(row.get::<_, i64>(4)?),
                total_cache_write: i64_to_u64(row.get::<_, i64>(5)?),
                total_cost: row.get::<_, f64>(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── Model usage history ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ModelUsageRow {
    pub model: String,
    pub provider: String,
    pub call_type: String,
    pub first_ts: String,
    pub last_ts: String,
    pub call_count: u32,
}

/// Per-(model, provider, call_type) usage over the filtered window: first and
/// last call timestamps plus call count, ordered by first appearance. Backs
/// the `model_history` character tool ("which models generated my words, and
/// when").
pub fn model_usage_summary(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<ModelUsageRow>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!(
        r"SELECT model,
                  provider,
                  call_type,
                  MIN(ts) as first_ts,
                  MAX(ts) as last_ts,
                  COUNT(*) as call_count
             FROM calls
             {where_clause}
            GROUP BY model, provider, call_type
            ORDER BY first_ts ASC",
    );

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            Ok(ModelUsageRow {
                model: row.get(0)?,
                provider: row.get(1)?,
                call_type: row.get(2)?,
                first_ts: row.get(3)?,
                last_ts: row.get(4)?,
                call_count: i64_to_u32(row.get::<_, i64>(5)?),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── Summary by usage kind ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct UsageKindSummary {
    pub usage_kind: String,
    pub call_count: u32,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
    pub total_cost: f64,
}

/// Groups calls by a higher-level usage kind. This keeps raw call types
/// available while surfacing product concepts such as message-with-tools.
pub fn usage_summary_by_usage_kind(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<UsageKindSummary>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!(
        r"SELECT usage_kind,
                  COUNT(*) as call_count,
                  SUM(input_tokens) as total_input,
                  SUM(output_tokens) as total_output,
                  SUM(cache_read_tokens) as total_cache_read,
                  SUM(cache_write_tokens) as total_cache_write,
                  TOTAL(total_cost) as total_cost
             FROM (
                 SELECT {USAGE_KIND_EXPR} as usage_kind,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_write_tokens, total_cost
                   FROM calls
                  {where_clause}
             )
            GROUP BY usage_kind
            ORDER BY total_cost DESC, call_count DESC",
    );

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            Ok(UsageKindSummary {
                usage_kind: row.get(0)?,
                call_count: i64_to_u32(row.get::<_, i64>(1)?),
                total_input: i64_to_u64(row.get::<_, i64>(2)?),
                total_output: i64_to_u64(row.get::<_, i64>(3)?),
                total_cache_read: i64_to_u64(row.get::<_, i64>(4)?),
                total_cache_write: i64_to_u64(row.get::<_, i64>(5)?),
                total_cost: row.get::<_, f64>(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── Summary by API key ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ApiKeySummary {
    pub provider: String,
    pub api_key_name: String,
    pub call_count: u32,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_write: u64,
    pub total_cost: f64,
}

/// Groups calls by provider + friendly configured API key name.
pub fn usage_summary_by_api_key(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<ApiKeySummary>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!(
        r"SELECT provider,
                  COALESCE(api_key_name, 'unknown') as api_key_name,
                  COUNT(*) as call_count,
                  SUM(input_tokens) as total_input,
                  SUM(output_tokens) as total_output,
                  SUM(cache_read_tokens) as total_cache_read,
                  SUM(cache_write_tokens) as total_cache_write,
                  TOTAL(total_cost) as total_cost
             FROM calls
             {where_clause}
            GROUP BY provider, COALESCE(api_key_name, 'unknown')
            ORDER BY total_cost DESC, call_count DESC",
    );

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            Ok(ApiKeySummary {
                provider: row.get(0)?,
                api_key_name: row.get(1)?,
                call_count: i64_to_u32(row.get::<_, i64>(2)?),
                total_input: i64_to_u64(row.get::<_, i64>(3)?),
                total_output: i64_to_u64(row.get::<_, i64>(4)?),
                total_cache_read: i64_to_u64(row.get::<_, i64>(5)?),
                total_cache_write: i64_to_u64(row.get::<_, i64>(6)?),
                total_cost: row.get::<_, f64>(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── Anomalies ────────────────────────────────────────────────────────────────

/// Returns rows where `cache_anomaly IS NOT NULL`, ordered by id DESC.
pub fn query_anomalies(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<CallRow>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);

    // If filter already produced a WHERE, append with AND; otherwise start one.
    let anomaly_clause = if where_clause.is_empty() {
        " WHERE cache_anomaly IS NOT NULL".to_owned()
    } else {
        format!("{where_clause} AND cache_anomaly IS NOT NULL")
    };

    let sql = format!("SELECT * FROM calls{anomaly_clause} ORDER BY id DESC");

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), row_from_sqlite)?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── TSV export ───────────────────────────────────────────────────────────────

const TSV_HEADER: &str = "ts\tcharacter\tprovider\tapi_key_name\tmodel\tcall_type\t\
    input_tokens\toutput_tokens\tcache_read_tokens\tcache_write_tokens\tcache_ttl\t\
    total_ms\tttft_ms\tfinish_reason\tthinking_enabled\t\
    cache_state\tcache_anomaly\t\
    input_cost\toutput_cost\tcache_read_cost\tcache_write_cost\tcost_source\ttotal_cost";

fn opt_str(v: Option<&String>) -> &str {
    v.map_or("", String::as_str)
}

fn opt_f64(v: Option<f64>) -> String {
    match v {
        Some(f) => f.to_string(),
        None => String::new(),
    }
}

fn row_to_tsv(r: &CallRow) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        r.ts,
        r.character,
        r.provider,
        opt_str(r.api_key_name.as_ref()),
        r.model,
        r.call_type,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        opt_str(r.cache_ttl.as_ref()),
        r.total_ms,
        r.ttft_ms,
        r.finish_reason,
        r.thinking_enabled,
        opt_str(r.cache_state.as_ref()),
        opt_str(r.cache_anomaly.as_ref()),
        opt_f64(r.input_cost),
        opt_f64(r.output_cost),
        opt_f64(r.cache_read_cost),
        opt_f64(r.cache_write_cost),
        opt_str(r.cost_source.as_ref()),
        opt_f64(r.total_cost),
    )
}

/// Tab-separated header + all matching rows (all 23 CallRow columns).
pub fn export_tsv(ledger: &Ledger, filter: &QueryFilter) -> Result<String, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);
    let sql = format!("SELECT * FROM calls{where_clause} ORDER BY id ASC");

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), row_from_sqlite)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut out = String::from(TSV_HEADER);
        for r in &rows {
            out.push('\n');
            out.push_str(&row_to_tsv(r));
        }
        Ok(out)
    })
}

// ── Active Anthropic characters ──────────────────────────────────────────────

/// Returns distinct characters with recent Anthropic calls and their last call row.
/// Used for cache health display.
pub fn active_anthropic_characters(
    ledger: &Ledger,
    filter: &QueryFilter,
) -> Result<Vec<(String, CallRow)>, rusqlite::Error> {
    let (where_clause, values) = build_where(filter);

    // Match either native anthropic or OpenRouter-routed anthropic (model_id
    // resolved to `anthropic/...` regardless of the custom provider key).
    // Mirrors `pricing::is_anthropic_pricing`.
    let anthropic_cond = "(provider = 'anthropic' OR model LIKE 'anthropic/%')";
    let provider_cond = if where_clause.is_empty() {
        format!(" WHERE {anthropic_cond}")
    } else {
        format!("{where_clause} AND {anthropic_cond}")
    };

    // Subquery: for each character, find the max id among matching Anthropic rows.
    let sql = format!(
        r"SELECT c.* FROM calls c
           INNER JOIN (
               SELECT character, MAX(id) as max_id
               FROM calls
               {provider_cond}
               GROUP BY character
           ) latest ON c.id = latest.max_id
           ORDER BY c.id DESC",
    );

    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
            let call = row_from_sqlite(row)?;
            let character = call.character.clone();
            Ok((character, call))
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

// ── Warm streak ──────────────────────────────────────────────────────────────

/// Counts consecutive warm calls from most recent backwards for `character`.
/// Bounded to prevent loading unbounded rows for high-volume characters.
pub fn warm_streak(ledger: &Ledger, character: &str) -> Result<u32, rusqlite::Error> {
    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cache_state FROM calls WHERE character = ?1 ORDER BY id DESC LIMIT 10000",
        )?;
        let mut rows = stmt.query_map([character], |row| row.get::<_, Option<String>>(0))?;

        let mut count = 0_u32;
        while let Some(Ok(state)) = rows.next() {
            if state.as_deref() == Some("warm") {
                count = count.saturating_add(1);
            } else {
                break;
            }
        }
        Ok(count)
    })
}

// ── Recalculate ─────────────────────────────────────────────────────────────

/// Row with NULL costs that needs recalculation.
#[derive(Debug)]
pub struct CostRow {
    pub id: i64,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_ttl: Option<String>,
}

/// Find all rows with NULL total_cost.
pub fn null_cost_rows(ledger: &Ledger) -> Result<Vec<CostRow>, rusqlite::Error> {
    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_ttl FROM calls WHERE total_cost IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CostRow {
                id: row.get(0)?,
                provider: row.get(1)?,
                model: row.get(2)?,
                input_tokens: i64_to_u64(row.get::<_, i64>(3)?),
                output_tokens: i64_to_u64(row.get::<_, i64>(4)?),
                cache_read_tokens: i64_to_u64(row.get::<_, i64>(5)?),
                cache_write_tokens: i64_to_u64(row.get::<_, i64>(6)?),
                cache_ttl: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

/// Find all rows (for force recalculation).
pub fn all_cost_rows(ledger: &Ledger) -> Result<Vec<CostRow>, rusqlite::Error> {
    ledger.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_ttl FROM calls WHERE COALESCE(cost_source, 'pricing_catalog') != 'provider_reported'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CostRow {
                id: row.get(0)?,
                provider: row.get(1)?,
                model: row.get(2)?,
                input_tokens: i64_to_u64(row.get::<_, i64>(3)?),
                output_tokens: i64_to_u64(row.get::<_, i64>(4)?),
                cache_read_tokens: i64_to_u64(row.get::<_, i64>(5)?),
                cache_write_tokens: i64_to_u64(row.get::<_, i64>(6)?),
                cache_ttl: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    })
}

/// Update costs for a single row by id.
pub fn update_costs(
    ledger: &Ledger,
    id: i64,
    cost: &crate::pricing::CostBreakdown,
) -> Result<(), rusqlite::Error> {
    ledger.with_conn(|conn| {
        let _ignored = conn.execute(
            "UPDATE calls SET input_cost=?1, output_cost=?2, cache_read_cost=?3, cache_write_cost=?4, cost_source='pricing_catalog', total_cost=?5 WHERE id=?6",
            rusqlite::params![cost.input, cost.output, cost.cache_read, cost.cache_write, cost.total, id],
        )?;
        Ok(())
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{CallRow, Ledger};

    fn first_item<T>(items: &[T]) -> &T {
        items.first().expect("expected at least one item")
    }

    fn populated_ledger() -> Ledger {
        let ledger = Ledger::open_in_memory().unwrap();
        let base = CallRow {
            ts: "2026-04-05T10:00:00Z".into(),
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
            total_ms: 1500,
            ttft_ms: 200,
            finish_reason: "tool_use".into(),
            thinking_enabled: true,
            cache_state: Some("warm".into()),
            cache_anomaly: None,
            input_cost: Some(0.0015),
            output_cost: Some(0.00375),
            cache_read_cost: Some(0.00012),
            cache_write_cost: Some(0.000_375),
            cost_source: Some("pricing_catalog".into()),
            total_cost: Some(0.005_745),
        };
        _ = ledger.insert(&base).unwrap();

        let mut row2 = base.clone();
        row2.ts = "2026-04-05T10:01:00Z".into();
        row2.call_type = "tool_loop".into();
        row2.api_key_name = Some("overflow".into());
        row2.input_tokens = 200;
        row2.total_cost = Some(0.01);
        _ = ledger.insert(&row2).unwrap();

        let mut row3 = base.clone();
        row3.ts = "2026-04-05T10:02:00Z".into();
        row3.provider = "openai".into();
        row3.model = "gpt-4o".into();
        row3.cache_read_tokens = 0;
        row3.cache_write_tokens = 0;
        row3.cache_state = None;
        row3.finish_reason = "end_turn".into();
        row3.total_cost = Some(0.002);
        _ = ledger.insert(&row3).unwrap();

        ledger
    }

    #[test]
    fn model_usage_summary_groups_and_orders_by_first_seen() {
        let ledger = populated_ledger();
        let rows = model_usage_summary(&ledger, &QueryFilter::default()).unwrap();
        // (claude-opus-4-6, anthropic, message), (claude-opus-4-6, anthropic,
        // tool_loop), (gpt-4o, openai, message) — ordered by first appearance.
        let [opus_message, opus_tool_loop, gpt] = &rows[..] else {
            panic!("expected 3 rows, got {rows:?}");
        };
        assert_eq!(opus_message.model, "claude-opus-4-6");
        assert_eq!(opus_message.call_type, "message");
        assert_eq!(opus_message.call_count, 1);
        assert_eq!(opus_message.first_ts, "2026-04-05T10:00:00Z");
        assert_eq!(opus_tool_loop.call_type, "tool_loop");
        assert_eq!(gpt.model, "gpt-4o");
        assert_eq!(gpt.provider, "openai");

        // Character + time filters compose through build_where.
        let filtered = model_usage_summary(
            &ledger,
            &QueryFilter {
                character: Some("aria".into()),
                since: Some("2026-04-05T10:02:00Z".into()),
                ..QueryFilter::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(first_item(&filtered).model, "gpt-4o");

        let nobody = model_usage_summary(
            &ledger,
            &QueryFilter {
                character: Some("nobody".into()),
                ..QueryFilter::default()
            },
        )
        .unwrap();
        assert!(nobody.is_empty());
    }

    #[test]
    fn summary_groups_by_call_type() {
        let ledger = populated_ledger();
        let summary = usage_summary_by_call_type(&ledger, &QueryFilter::default()).unwrap();
        // Populated ledger has two call types: "message" (2 rows) and
        // "tool_loop" (1 row).
        assert_eq!(summary.len(), 2);
        let by_type: std::collections::HashMap<_, _> = summary
            .iter()
            .map(|s| (s.call_type.clone(), s.call_count))
            .collect();
        assert_eq!(by_type.get("message"), Some(&2));
        assert_eq!(by_type.get("tool_loop"), Some(&1));
    }

    #[test]
    fn summary_groups_by_usage_kind() {
        let ledger = populated_ledger();
        let summary = usage_summary_by_usage_kind(&ledger, &QueryFilter::default()).unwrap();
        let by_kind: std::collections::HashMap<_, _> = summary
            .iter()
            .map(|s| (s.usage_kind.clone(), s.call_count))
            .collect();
        assert_eq!(by_kind.get("message_no_tools"), Some(&1));
        assert_eq!(by_kind.get("message_with_tools"), Some(&2));
    }

    #[test]
    fn summary_groups_by_api_key() {
        let ledger = populated_ledger();
        let summary = usage_summary_by_api_key(&ledger, &QueryFilter::default()).unwrap();
        let by_key: std::collections::HashMap<_, _> = summary
            .iter()
            .map(|s| ((s.provider.clone(), s.api_key_name.clone()), s.call_count))
            .collect();
        assert_eq!(
            by_key.get(&("anthropic".to_owned(), "default".to_owned())),
            Some(&1)
        );
        assert_eq!(
            by_key.get(&("anthropic".to_owned(), "overflow".to_owned())),
            Some(&1)
        );
        assert_eq!(
            by_key.get(&("openai".to_owned(), "default".to_owned())),
            Some(&1)
        );
    }

    #[test]
    fn summary_groups_by_provider_model() {
        let ledger = populated_ledger();
        let summary = usage_summary(&ledger, &QueryFilter::default()).unwrap();
        assert_eq!(summary.len(), 2); // anthropic/opus + openai/gpt-4o
        let anthropic = summary.iter().find(|s| s.provider == "anthropic").unwrap();
        assert_eq!(anthropic.call_count, 2);
    }

    #[test]
    fn filter_by_provider() {
        let ledger = populated_ledger();
        let filter = QueryFilter {
            provider: Some("anthropic".into()),
            ..Default::default()
        };
        let summary = usage_summary(&ledger, &filter).unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(first_item(&summary).call_count, 2);
    }

    #[test]
    fn filter_by_api_key() {
        let ledger = populated_ledger();
        let filter = QueryFilter {
            api_key_name: Some("overflow".into()),
            ..Default::default()
        };
        let summaries = usage_summary(&ledger, &filter).unwrap();
        assert_eq!(summaries.len(), 1);
        let summary = first_item(&summaries);
        assert_eq!(summary.call_count, 1);
        assert_eq!(summary.total_input, 200);
    }

    #[test]
    fn anomalies_query() {
        let ledger = Ledger::open_in_memory().unwrap();
        let mut row = CallRow {
            ts: "2026-04-05T10:00:00Z".into(),
            character: "aria".into(),
            provider: "anthropic".into(),
            api_key_name: Some("default".into()),
            model: "claude-opus-4-6".into(),
            call_type: "message".into(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_write_tokens: 500,
            cache_ttl: None,
            total_ms: 1500,
            ttft_ms: 200,
            finish_reason: "end_turn".into(),
            thinking_enabled: true,
            cache_state: Some("cold".into()),
            cache_anomaly: Some("unexpected_read".into()),
            input_cost: None,
            output_cost: None,
            cache_read_cost: None,
            cache_write_cost: None,
            cost_source: Some("pricing_catalog".into()),
            total_cost: None,
        };
        _ = ledger.insert(&row).unwrap();
        row.cache_anomaly = None;
        _ = ledger.insert(&row).unwrap();
        let anomalies = query_anomalies(&ledger, &QueryFilter::default()).unwrap();
        assert_eq!(anomalies.len(), 1);
    }

    #[test]
    fn export_tsv_format() {
        let ledger = populated_ledger();
        let tsv = export_tsv(&ledger, &QueryFilter::default()).unwrap();
        let lines: Vec<&str> = tsv.lines().collect();
        let header = first_item(&lines);
        assert!(header.contains("ts\t"));
        assert!(header.contains("\tcost_source\t"));
        assert_eq!(lines.len(), 4); // header + 3 rows
    }

    #[test]
    fn all_cost_rows_skips_provider_reported_totals() {
        let ledger = populated_ledger();
        let mut provider_reported = ledger.recent(1).unwrap().remove(0);
        provider_reported.ts = "2026-04-05T10:03:00Z".into();
        provider_reported.input_cost = None;
        provider_reported.output_cost = None;
        provider_reported.cache_read_cost = None;
        provider_reported.cache_write_cost = None;
        provider_reported.cost_source = Some("provider_reported".into());
        provider_reported.total_cost = Some(0.1234);
        _ = ledger.insert(&provider_reported).unwrap();

        let rows = all_cost_rows(&ledger).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| row.id != 4));
    }

    #[test]
    fn active_anthropic_characters_includes_routed_provider() {
        // Custom provider name (sdk = "anthropic", base_url = OpenRouter)
        // with model_id resolved to `anthropic/...` must show up in cache
        // health alongside native-anthropic rows.
        let ledger = Ledger::open_in_memory().unwrap();
        let base = CallRow {
            ts: "2026-04-05T10:00:00Z".into(),
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
            total_ms: 1500,
            ttft_ms: 200,
            finish_reason: "end_turn".into(),
            thinking_enabled: true,
            cache_state: Some("warm".into()),
            cache_anomaly: None,
            input_cost: None,
            output_cost: None,
            cache_read_cost: None,
            cache_write_cost: None,
            cost_source: Some("pricing_catalog".into()),
            total_cost: None,
        };
        _ = ledger.insert(&base).unwrap();

        let mut routed = base.clone();
        routed.ts = "2026-04-05T10:01:00Z".into();
        routed.character = "kai".into();
        routed.provider = "openrouter-anthropic".into();
        routed.model = "anthropic/claude-opus-4.6".into();
        _ = ledger.insert(&routed).unwrap();

        let mut other = base.clone();
        other.ts = "2026-04-05T10:02:00Z".into();
        other.character = "leo".into();
        other.provider = "openai".into();
        other.model = "gpt-4o".into();
        _ = ledger.insert(&other).unwrap();

        let result = active_anthropic_characters(&ledger, &QueryFilter::default()).unwrap();
        let chars: std::collections::HashSet<_> = result.iter().map(|(c, _)| c.clone()).collect();
        assert!(chars.contains("aria"));
        assert!(chars.contains("kai"));
        assert!(!chars.contains("leo"));
    }

    #[test]
    fn warm_streak_counts_consecutive() {
        let ledger = Ledger::open_in_memory().unwrap();
        let base = CallRow {
            ts: "2026-04-05T10:00:00Z".into(),
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
            total_ms: 1000,
            ttft_ms: 100,
            finish_reason: "end_turn".into(),
            thinking_enabled: true,
            cache_state: Some("cold".into()),
            cache_anomaly: None,
            input_cost: None,
            output_cost: None,
            cache_read_cost: None,
            cache_write_cost: None,
            cost_source: Some("pricing_catalog".into()),
            total_cost: None,
        };
        _ = ledger.insert(&base).unwrap();
        let mut warm = base.clone();
        warm.cache_state = Some("warm".into());
        warm.ts = "2026-04-05T10:01:00Z".into();
        _ = ledger.insert(&warm).unwrap();
        warm.ts = "2026-04-05T10:02:00Z".into();
        _ = ledger.insert(&warm).unwrap();
        warm.ts = "2026-04-05T10:03:00Z".into();
        _ = ledger.insert(&warm).unwrap();
        assert_eq!(warm_streak(&ledger, "aria").unwrap(), 3);
    }
}
