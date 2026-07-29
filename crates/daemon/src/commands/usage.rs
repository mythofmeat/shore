use crate::ledger::query::QueryFilter;
use serde_json::json;
use shore_common::protocol::error::ErrorCode;
use tracing::debug;

use super::{CommandContext, CommandResult};

/// The `--last` window's lower bound, or `None` for no lower bound.
///
/// `None` covers `"all"` and anything unparseable alike: an argument we cannot
/// read means the whole ledger, not an error.
///
/// Public for `tests/usage_parity.rs`, which generates the cross-language
/// fixture from it.
pub fn parse_last_period_at(
    period: &str,
    now: chrono::DateTime<chrono::Utc>,
    timezone: &str,
) -> Option<String> {
    match period {
        "today" => Some(calendar_start(now, CalendarWindow::Day, timezone).to_rfc3339()),
        "week" | "this_week" => {
            Some(calendar_start(now, CalendarWindow::Week, timezone).to_rfc3339())
        }
        "month" | "this_month" => {
            Some(calendar_start(now, CalendarWindow::Month, timezone).to_rfc3339())
        }
        "all" => None,
        s if s.ends_with('h') => {
            let hours: i64 = s.trim_end_matches('h').parse().ok()?;
            now.checked_sub_signed(chrono::Duration::hours(hours))
                .map(|dt| dt.to_rfc3339())
        }
        s if s.ends_with('d') => {
            let days: i64 = s.trim_end_matches('d').parse().ok()?;
            now.checked_sub_signed(chrono::Duration::days(days))
                .map(|dt| dt.to_rfc3339())
        }
        s if s.ends_with('w') => {
            let weeks: i64 = s.trim_end_matches('w').parse().ok()?;
            now.checked_sub_signed(chrono::Duration::weeks(weeks))
                .map(|dt| dt.to_rfc3339())
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy)]
enum CalendarWindow {
    Day,
    Week,
    Month,
}

fn calendar_start_naive(date: chrono::NaiveDate, window: CalendarWindow) -> chrono::NaiveDateTime {
    use chrono::Datelike;
    let start_date = match window {
        CalendarWindow::Day => date,
        CalendarWindow::Week => date
            .checked_sub_signed(chrono::Duration::days(i64::from(
                date.weekday().num_days_from_monday(),
            )))
            .unwrap_or(date),
        CalendarWindow::Month => date
            .checked_sub_signed(chrono::Duration::days(i64::from(date.day0())))
            .unwrap_or(date),
    };
    start_date.and_time(chrono::NaiveTime::MIN)
}

fn calendar_start(
    now: chrono::DateTime<chrono::Utc>,
    window: CalendarWindow,
    timezone: &str,
) -> chrono::DateTime<chrono::Utc> {
    use chrono::TimeZone;
    if timezone == "utc" {
        let date = now.date_naive();
        let start = calendar_start_naive(date, window);
        return chrono::Utc.from_utc_datetime(&start);
    }

    let local_now = now.with_timezone(&chrono::Local);
    let date = local_now.date_naive();
    let start = calendar_start_naive(date, window);
    match chrono::Local.from_local_datetime(&start) {
        chrono::LocalResult::Single(dt) => dt.with_timezone(&chrono::Utc),
        chrono::LocalResult::Ambiguous(early, _) => early.with_timezone(&chrono::Utc),
        chrono::LocalResult::None => {
            let adjusted = start
                .checked_add_signed(chrono::Duration::hours(1))
                .unwrap_or(start);
            chrono::Local
                .from_local_datetime(&adjusted)
                .earliest()
                .map_or_else(
                    || chrono::Utc.from_utc_datetime(&start),
                    |dt| dt.with_timezone(&chrono::Utc),
                )
        }
    }
}

fn build_filter(
    args: &serde_json::Value,
    timezone: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> (QueryFilter, String) {
    let last = args
        .get("last")
        .and_then(|v| v.as_str())
        .unwrap_or("today")
        .to_owned();
    let since = parse_last_period_at(&last, now, timezone);
    let filter = QueryFilter {
        since,
        character: args
            .get("character")
            .and_then(|v| v.as_str())
            .map(String::from),
        provider: args
            .get("provider")
            .and_then(|v| v.as_str())
            .map(String::from),
        api_key_name: args
            .get("api_key")
            .and_then(|v| v.as_str())
            .map(String::from),
        model: args.get("model").and_then(|v| v.as_str()).map(String::from),
        call_type: args
            .get("call_type")
            .and_then(|v| v.as_str())
            .map(String::from),
        ..Default::default()
    };
    (filter, last)
}

fn budget_payload(
    ledger: &crate::ledger::Ledger,
    usage_config: &shore_common::config::app::UsageConfig,
    now: chrono::DateTime<chrono::Utc>,
) -> CommandResult {
    let budgets = crate::ledger::budget::budget_statuses(ledger, usage_config, now)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    let spike_warnings = crate::ledger::budget::spike_warnings(ledger, usage_config, now)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;

    Ok(json!({
        "mode": "budget",
        "timezone": usage_config.timezone.as_str(),
        "allow_compaction_over_budget": usage_config.allow_compaction_over_budget,
        "budgets": budgets,
        "spike_warnings": spike_warnings,
    }))
}

/// `true` when boolean arg `key` is explicitly set to `true`.
fn flag(args: &serde_json::Value, key: &str) -> bool {
    args.get(key).and_then(serde_json::Value::as_bool) == Some(true)
}

pub async fn usage(ctx: &CommandContext, args: &serde_json::Value) -> CommandResult {
    let ledger = ctx.llm_client.ledger();
    let now = chrono::Utc::now();

    if let Some(result) = usage_payload_at(ledger, &ctx.config.app.usage, args, now) {
        return result;
    }

    // The two modes that need the daemon's `PricingEngine` rather than just the
    // ledger, which is why `usage_payload_at` hands them back rather than
    // answering them.
    if flag(args, "refresh_pricing") {
        return usage_refresh_pricing(ctx);
    }
    usage_recalculate(ctx, ledger, args).await
}

/// Every `shore usage` mode that is answerable from the ledger alone, with the
/// clock supplied rather than read.
///
/// `None` means the mode needs the pricing engine — `refresh_pricing` or
/// `recalculate` — and is checked in the position the flag ladder gave it, so
/// which flag wins when several are set is unchanged.
///
/// Public, and taking `now`, for one reason: `tests/usage_parity.rs` generates
/// the cross-language fixture from it. The daemon calls it with `Utc::now()`.
pub fn usage_payload_at(
    ledger: &crate::ledger::Ledger,
    usage_config: &shore_common::config::app::UsageConfig,
    args: &serde_json::Value,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<CommandResult> {
    let timezone = usage_config.timezone.as_str();
    let (filter, last) = build_filter(args, timezone, now);
    debug!(period = %last, "Usage query started");

    if flag(args, "budget") {
        return Some(budget_payload(ledger, usage_config, now));
    }
    if flag(args, "export_tsv") {
        return Some(usage_export_tsv(ledger, &filter));
    }
    if flag(args, "export_csv") {
        return Some(usage_export_csv(ledger, &filter));
    }
    if flag(args, "by_kind") {
        return Some(usage_summary_by_kind(ledger, &filter, &last));
    }
    if flag(args, "by_api_key") {
        return Some(usage_summary_by_api_key(ledger, &filter, &last));
    }
    if flag(args, "by_call_type") {
        return Some(usage_summary_by_call_type(ledger, &filter, &last));
    }
    if flag(args, "anomalies") {
        return Some(usage_anomalies(ledger, filter, &last, timezone, now));
    }
    if flag(args, "refresh_pricing") || flag(args, "recalculate") {
        return None;
    }

    Some(usage_summary_default(
        ledger,
        usage_config,
        &filter,
        &last,
        timezone,
        now,
    ))
}

fn usage_export_tsv(ledger: &crate::ledger::Ledger, filter: &QueryFilter) -> CommandResult {
    let output = crate::ledger::query::export_tsv(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    Ok(json!({ "mode": "tsv", "data": output }))
}

fn usage_export_csv(ledger: &crate::ledger::Ledger, filter: &QueryFilter) -> CommandResult {
    let tsv = crate::ledger::query::export_tsv(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    let mut csv_lines = Vec::new();
    for line in tsv.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let csv_fields: Vec<String> = fields
            .iter()
            .map(|f| {
                if f.contains(',') || f.contains('"') || f.contains('\n') {
                    format!("\"{}\"", f.replace('"', "\"\""))
                } else {
                    f.to_string()
                }
            })
            .collect();
        csv_lines.push(csv_fields.join(","));
    }
    Ok(json!({ "mode": "csv", "data": csv_lines.join("\n") }))
}

fn usage_summary_by_kind(
    ledger: &crate::ledger::Ledger,
    filter: &QueryFilter,
    last: &str,
) -> CommandResult {
    let summary = crate::ledger::query::usage_summary_by_usage_kind(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    let rows: Vec<serde_json::Value> = summary
        .iter()
        .map(|s| {
            json!({
                "usage_kind": s.usage_kind,
                "call_count": s.call_count,
                "total_input": s.total_input,
                "total_output": s.total_output,
                "total_cache_read": s.total_cache_read,
                "total_cache_write": s.total_cache_write,
                "total_cost": s.total_cost,
            })
        })
        .collect();
    Ok(json!({
        "mode": "summary_by_usage_kind",
        "period": last,
        "summary": rows,
    }))
}

fn usage_summary_by_api_key(
    ledger: &crate::ledger::Ledger,
    filter: &QueryFilter,
    last: &str,
) -> CommandResult {
    let summary = crate::ledger::query::usage_summary_by_api_key(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    let rows: Vec<serde_json::Value> = summary
        .iter()
        .map(|s| {
            json!({
                "provider": s.provider,
                "api_key_name": s.api_key_name,
                "call_count": s.call_count,
                "total_input": s.total_input,
                "total_output": s.total_output,
                "total_cache_read": s.total_cache_read,
                "total_cache_write": s.total_cache_write,
                "total_cost": s.total_cost,
            })
        })
        .collect();
    Ok(json!({
        "mode": "summary_by_api_key",
        "period": last,
        "summary": rows,
    }))
}

fn usage_summary_by_call_type(
    ledger: &crate::ledger::Ledger,
    filter: &QueryFilter,
    last: &str,
) -> CommandResult {
    let summary = crate::ledger::query::usage_summary_by_call_type(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    let rows: Vec<serde_json::Value> = summary
        .iter()
        .map(|s| {
            json!({
                "call_type": s.call_type,
                "call_count": s.call_count,
                "total_input": s.total_input,
                "total_output": s.total_output,
                "total_cache_read": s.total_cache_read,
                "total_cache_write": s.total_cache_write,
                "total_cost": s.total_cost,
            })
        })
        .collect();
    Ok(json!({
        "mode": "summary_by_call_type",
        "period": last,
        "summary": rows,
    }))
}

fn usage_anomalies(
    ledger: &crate::ledger::Ledger,
    filter: QueryFilter,
    last: &str,
    timezone: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> CommandResult {
    let anomaly_filter = if last == "today" {
        QueryFilter {
            since: parse_last_period_at("7d", now, timezone),
            ..filter.clone()
        }
    } else {
        filter
    };
    let rows = crate::ledger::query::query_anomalies(ledger, &anomaly_filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    let anomalies: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "ts": r.ts,
                "character": r.character,
                "model": r.model,
                "call_type": r.call_type,
                "anomaly": r.cache_anomaly,
                "cache_read_tokens": r.cache_read_tokens,
                "cache_write_tokens": r.cache_write_tokens,
            })
        })
        .collect();
    Ok(json!({ "mode": "anomalies", "anomalies": anomalies }))
}

fn usage_refresh_pricing(ctx: &CommandContext) -> CommandResult {
    let pricing = ctx.llm_client.pricing();
    pricing
        .clear_cache()
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    Ok(json!({ "mode": "refresh_pricing" }))
}

async fn usage_recalculate(
    ctx: &CommandContext,
    ledger: &crate::ledger::Ledger,
    args: &serde_json::Value,
) -> CommandResult {
    let force = flag(args, "force");
    let rows = if force {
        crate::ledger::query::all_cost_rows(ledger)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?
    } else {
        crate::ledger::query::null_cost_rows(ledger)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?
    };
    if rows.is_empty() {
        return Ok(json!({ "mode": "recalculate", "updated": 0, "total": 0, "failures": [] }));
    }

    let pricing = ctx.llm_client.pricing();
    let mut models_fetched = std::collections::HashSet::new();
    let mut fetch_results: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();

    for row in &rows {
        let key = format!("{}/{}", row.provider, row.model);
        if models_fetched.insert(key.clone()) {
            let model_id = crate::ledger::pricing::to_openrouter_id(&row.provider, &row.model);
            if pricing
                .get_or_fetch(&row.provider, &row.model)
                .await
                .is_some()
            {
                let _ignored = fetch_results.insert(key, None);
            } else {
                tracing::warn!(model_id, "Pricing fetch returned no data for model");
                let _ignored =
                    fetch_results.insert(key, Some(format!("no pricing data for {model_id}")));
            }
        }
    }

    let mut updated = 0_u32;
    for row in &rows {
        if let Ok(Some(cost)) = pricing.calculate_cost(crate::ledger::pricing::CostRequest {
            provider: &row.provider,
            model: &row.model,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cache_read_tokens: row.cache_read_tokens,
            cache_write_tokens: row.cache_write_tokens,
            cache_ttl: row.cache_ttl.as_deref(),
        }) {
            if crate::ledger::query::update_costs(ledger, row.id, &cost).is_ok() {
                updated = updated.saturating_add(1);
            }
        }
    }

    let failures: Vec<serde_json::Value> = fetch_results
        .iter()
        .filter_map(|(key, reason)| {
            reason
                .as_ref()
                .map(|r| json!({ "model": key, "reason": r }))
        })
        .collect();

    debug!(
        updated,
        total = rows.len(),
        failures = failures.len(),
        "Recalculation complete"
    );
    Ok(json!({
        "mode": "recalculate",
        "updated": updated,
        "total": rows.len(),
        "failures": failures,
    }))
}

fn usage_summary_default(
    ledger: &crate::ledger::Ledger,
    usage_config: &shore_common::config::app::UsageConfig,
    filter: &QueryFilter,
    last: &str,
    timezone: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> CommandResult {
    let summary = crate::ledger::query::usage_summary(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;

    let summary_rows: Vec<serde_json::Value> = summary
        .iter()
        .map(|s| {
            json!({
                "provider": s.provider,
                "model": s.model,
                "call_count": s.call_count,
                "total_input": s.total_input,
                "total_output": s.total_output,
                "total_cache_read": s.total_cache_read,
                "total_cache_write": s.total_cache_write,
                "total_cost": s.total_cost,
            })
        })
        .collect();

    let characters = crate::ledger::query::active_anthropic_characters(ledger, filter)
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;

    let cache_health: Vec<serde_json::Value> = characters
        .iter()
        .map(|(char_name, last_row)| {
            let streak = crate::ledger::query::warm_streak(ledger, char_name).unwrap_or(0);
            // Recomputed rather than read off `last_row.cache_state`: that is
            // what was true when the call was made, and a prefix that has since
            // aged past its TTL is cold now.
            let state = crate::ledger::cache_tracker::reconstruct_state(
                &last_row.ts,
                last_row.cache_read_tokens,
                3600,
                now,
            )
            .as_str();
            json!({
                "character": char_name,
                "state": state,
                "streak": streak,
            })
        })
        .collect();

    let anomaly_filter = QueryFilter {
        since: parse_last_period_at("7d", now, timezone),
        ..Default::default()
    };
    let anomaly_count =
        crate::ledger::query::query_anomalies(ledger, &anomaly_filter).map_or(0, |r| r.len());

    debug!(
        period = %last,
        models = summary_rows.len(),
        characters = cache_health.len(),
        anomaly_count_7d = anomaly_count,
        "Usage summary complete"
    );
    Ok(json!({
        "mode": "summary",
        "period": last,
        "timezone": timezone,
        "summary": summary_rows,
        "cache_health": cache_health,
        "anomaly_count_7d": anomaly_count,
        "budgets": crate::ledger::budget::budget_statuses(ledger, usage_config, now)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?,
        "spike_warnings": crate::ledger::budget::spike_warnings(ledger, usage_config, now)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::NaiveDate::from_ymd_opt(2026, 5, 13)
            .unwrap()
            .and_hms_opt(12, 30, 0)
            .unwrap()
            .and_utc()
    }

    #[test]
    fn parse_last_period_accepts_hour_ranges() {
        assert_eq!(
            parse_last_period_at("4h", fixed_now(), "utc").as_deref(),
            Some("2026-05-13T08:30:00+00:00"),
        );
    }

    #[test]
    fn parse_last_period_keeps_day_ranges() {
        assert_eq!(
            parse_last_period_at("7d", fixed_now(), "utc").as_deref(),
            Some("2026-05-06T12:30:00+00:00"),
        );
    }

    #[test]
    fn parse_last_period_today_uses_utc_midnight() {
        assert_eq!(
            parse_last_period_at("today", fixed_now(), "utc").as_deref(),
            Some("2026-05-13T00:00:00+00:00"),
        );
    }

    #[test]
    fn parse_last_period_accepts_calendar_week() {
        assert_eq!(
            parse_last_period_at("week", fixed_now(), "utc").as_deref(),
            Some("2026-05-11T00:00:00+00:00"),
        );
    }

    #[test]
    fn parse_last_period_accepts_calendar_month() {
        assert_eq!(
            parse_last_period_at("month", fixed_now(), "utc").as_deref(),
            Some("2026-05-01T00:00:00+00:00"),
        );
    }
}
