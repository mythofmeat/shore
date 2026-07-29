//! Generates the cross-language `shore usage` fixture, under a real timezone.
//!
//! Its own integration-test binary for the reason `budget_parity.rs` and
//! `pace_dst.rs` are: it sets `TZ`, and `TZ` is process-global.
//!
//! What this pins that the query and budget fixtures do not:
//!
//!   - **`--last` parsing.** `today`/`week`/`month` floor to a calendar boundary
//!     in the configured zone; `4h`/`7d`/`2w` step back from now. Those bounds
//!     become a `ts >= ?` comparison against the ledger, so a boundary an hour
//!     out is a report over the wrong window.
//!   - **The payload envelopes.** `crates/cli/src/output/commands.rs` renders
//!     these objects by key, so `mode`, `period`, and the field names inside
//!     each row are protocol, not internals.
//!   - **The rules that live only in the command:** the anomaly view widening
//!     `today` to seven days, cache health recomputing state instead of reading
//!     the stored column, and CSV quoting.
//!
//! Not covered here: `recalculate` and `refresh_pricing`. Both drive the
//! `PricingEngine` — one fetches OpenRouter's catalog, the other empties a table
//! the daemon still owns — so neither is answerable from a ledger alone, and a
//! fixture that reached the network would not be a fixture. They are covered by
//! unit tests on each side instead.
//!
//! Regenerate with `SHORE_REGENERATE_FIXTURES=1 cargo test -p shore-daemon
//! --test usage_parity`.

use chrono::{DateTime, Utc};
use serde_json::json;
use shore_common::config::app::{
    UsageBudgetAction, UsageBudgetConfig, UsageBudgetPeriod, UsageConfig, UsageSpikeWarningsConfig,
};
use shore_daemon::commands::usage::{parse_last_period_at, usage_payload_at};
use shore_daemon::ledger::store::{CallRow, Ledger};

const TZ: &str = "America/New_York";

#[expect(
    clippy::expect_used,
    reason = "fixture-generator helper: a bad literal here is a broken generator, and panicking names it immediately"
)]
fn ts(rfc3339: &str) -> DateTime<Utc> {
    rfc3339.parse().expect("timestamp parses")
}

/// A ledger on disk, seeded with `rows`. See `budget_parity.rs` for why the
/// insert goes through raw `rusqlite` rather than `Ledger::insert`.
#[expect(
    clippy::expect_used,
    reason = "fixture-generator helper: a seed that will not insert is a broken generator, and panicking names it immediately"
)]
fn seeded_ledger(dir: &std::path::Path, rows: &[CallRow]) -> Ledger {
    let path = dir.join("usage-parity.db");
    let _ignored = std::fs::remove_file(&path);
    let ledger = Ledger::open(&path).expect("ledger opens");

    let conn = rusqlite::Connection::open(&path).expect("seed connection opens");
    for r in rows {
        let _inserted = conn
            .execute(
                "INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                 cache_ttl, reasoning_effort, total_ms, ttft_ms, finish_reason,
                 thinking_enabled, cache_state, cache_anomaly,
                 input_cost, output_cost, cache_read_cost, cache_write_cost,
                 cost_source, total_cost)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
                rusqlite::params![
                    r.ts,
                    r.character,
                    r.provider,
                    r.api_key_name,
                    r.model,
                    r.call_type,
                    r.input_tokens,
                    r.output_tokens,
                    r.cache_read_tokens,
                    r.cache_write_tokens,
                    r.cache_ttl,
                    r.reasoning_effort,
                    r.total_ms,
                    r.ttft_ms,
                    r.finish_reason,
                    i32::from(r.thinking_enabled),
                    r.cache_state,
                    r.cache_anomaly,
                    r.input_cost,
                    r.output_cost,
                    r.cache_read_cost,
                    r.cache_write_cost,
                    r.cost_source,
                    r.total_cost,
                ],
            )
            .expect("seed row inserts");
    }
    ledger
}

/// The instant every case is evaluated at. A Wednesday afternoon in EDT, so
/// `week` floors to a Monday two days back and `today` to a midnight four hours
/// behind UTC's — a UTC-only port agrees with neither.
fn now() -> DateTime<Utc> {
    ts("2026-05-13T16:20:00+00:00")
}

fn base_row(ts: &str, character: &str, provider: &str, model: &str, call_type: &str) -> CallRow {
    CallRow {
        ts: ts.into(),
        character: character.into(),
        provider: provider.into(),
        api_key_name: Some("default".into()),
        model: model.into(),
        call_type: call_type.into(),
        input_tokens: 1_200,
        output_tokens: 340,
        cache_read_tokens: 900,
        cache_write_tokens: 120,
        cache_ttl: Some("1h".into()),
        reasoning_effort: None,
        total_ms: 4_100,
        ttft_ms: 380,
        finish_reason: "end_turn".into(),
        thinking_enabled: true,
        cache_state: Some("warm".into()),
        cache_anomaly: None,
        input_cost: Some(0.012),
        output_cost: Some(0.004),
        cache_read_cost: Some(0.000_15),
        cache_write_cost: Some(0.000_02),
        cost_source: Some("pricing_catalog".into()),
        total_cost: Some(0.016_17),
    }
}

/// Rows spread across the windows the `--last` values select.
///
/// Timestamps are relative to {@link now} (2026-05-13T16:20Z, a Wednesday):
/// local midnight that day is 04:00Z, the local week opened Monday the 11th at
/// 04:00Z, and the local month opened May 1 at 04:00Z.
fn seed() -> Vec<CallRow> {
    vec![
        // Before every window but `all`.
        base_row(
            "2026-03-02T11:00:00+00:00",
            "aria",
            "anthropic",
            "claude-opus-4-6",
            "message",
        ),
        // Inside the month, before the week.
        base_row(
            "2026-05-04T13:00:00+00:00",
            "aria",
            "openai",
            "gpt-5.5",
            "message",
        ),
        // Inside the week, before today. Anomalous, and inside the 7-day
        // anomaly lookback.
        CallRow {
            cache_state: Some("cold".into()),
            cache_anomaly: Some("keepalive_miss".into()),
            cache_read_tokens: 0,
            ..base_row(
                "2026-05-12T09:00:00+00:00",
                "aria",
                "anthropic",
                "claude-opus-4-6",
                "keepalive",
            )
        },
        // In the gap between UTC midnight and local midnight on the 13th: in
        // `today` for a UTC config, out of it for a local one. This row is the
        // whole reason both timezones are generated.
        base_row(
            "2026-05-13T02:00:00+00:00",
            "kai",
            "anthropic",
            "claude-opus-4-6",
            "heartbeat",
        ),
        // Today, both ways. A `message` that stopped at `tool_use`, so the
        // usage-kind collapse has a first-leg row to fold in.
        CallRow {
            finish_reason: "tool_use".into(),
            ..base_row(
                "2026-05-13T14:00:00+00:00",
                "aria",
                "anthropic",
                "claude-opus-4-6",
                "message",
            )
        },
        base_row(
            "2026-05-13T14:02:00+00:00",
            "aria",
            "anthropic",
            "claude-opus-4-6",
            "tool_loop",
        ),
        // Twenty minutes old, so cache health reads it as warm — and its
        // `cache_state` column says `cold`, which is what makes the recompute
        // visible rather than a no-op.
        CallRow {
            cache_state: Some("cold".into()),
            ..base_row(
                "2026-05-13T16:00:00+00:00",
                "leo",
                "openrouter",
                "anthropic/claude-opus-4.6",
                "message",
            )
        },
        // Over two hours old and past the TTL: cold now, whatever it recorded.
        CallRow {
            ..base_row(
                "2026-05-13T13:40:00+00:00",
                "nina",
                "anthropic",
                "claude-opus-4-6",
                "message",
            )
        },
        // A second anomaly, so the anomaly ordering (`id DESC`) is observable.
        CallRow {
            cache_anomaly: Some("unexpected_write".into()),
            cache_write_tokens: 40_000,
            ..base_row(
                "2026-05-13T15:00:00+00:00",
                "aria",
                "anthropic",
                "claude-opus-4-6",
                "message",
            )
        },
        // No key name — reads back as "unknown" in the by-api-key summary. A
        // comma and a quote in the character name so the CSV quoting rule has
        // something to quote, and a cost small enough to leave positional
        // notation behind in JavaScript but not in Rust.
        CallRow {
            api_key_name: None,
            character: "ren, \"the quiet one\"".into(),
            total_cost: Some(0.000_000_15),
            input_cost: None,
            output_cost: None,
            cache_read_cost: None,
            cache_write_cost: None,
            cost_source: None,
            ..base_row(
                "2026-05-13T15:30:00+00:00",
                "ren",
                "anthropic",
                "claude-opus-4-6",
                "dreaming",
            )
        },
    ]
}

/// The `--last` values run through every mode, plus the ones that only
/// `parse_last_period_at` sees.
fn periods() -> Vec<&'static str> {
    vec![
        "today",
        "week",
        "this_week",
        "month",
        "this_month",
        "all",
        "4h",
        "7d",
        "2w",
        "0d",
        "-1d",
        // `trim_end_matches` strips *every* trailing unit char, so this is four
        // hours rather than a parse failure. Nothing sends it; it is here
        // because it is the one input that tells the two implementations apart
        // if one reaches for "drop the last character".
        "4hh",
        // Unparseable: no lower bound at all, rather than an error.
        "banana",
        "",
        "d",
    ]
}

/// The mode flags, as the CLI sends them.
fn modes() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("summary", json!({})),
        ("budget", json!({ "budget": true })),
        ("tsv", json!({ "export_tsv": true })),
        ("csv", json!({ "export_csv": true })),
        ("by_kind", json!({ "by_kind": true })),
        ("by_api_key", json!({ "by_api_key": true })),
        ("by_call_type", json!({ "by_call_type": true })),
        ("anomalies", json!({ "anomalies": true })),
    ]
}

/// Filter arguments, applied on top of a mode.
fn filters() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("none", json!({})),
        ("character", json!({ "character": "aria" })),
        ("provider", json!({ "provider": "anthropic" })),
        ("api_key_unknown", json!({ "api_key": "unknown" })),
        ("model", json!({ "model": "gpt-5.5" })),
        ("call_type", json!({ "call_type": "tool_loop" })),
    ]
}

fn config(timezone: &str) -> UsageConfig {
    UsageConfig {
        timezone: timezone.into(),
        allow_compaction_over_budget: false,
        budgets: vec![UsageBudgetConfig {
            name: "daily".into(),
            period: UsageBudgetPeriod::Day,
            cost_usd: 0.05,
            warn_at: vec![0.5, 1.0],
            limit: UsageBudgetAction::Warn,
            character: None,
            provider: None,
            api_key: None,
            model: None,
            call_type: None,
            usage_kind: Vec::new(),
            allow_compaction_over_budget: None,
            reset_hour: Some(6),
            reset_day_of_week: None,
            reset_day_of_month: None,
            pace_period: None,
            pace_action: None,
            pace_warn_at: None,
        }],
        spike_warnings: UsageSpikeWarningsConfig {
            enabled: true,
            period: UsageBudgetPeriod::Day,
            multiplier: 1.5,
            min_cost_usd: 0.001,
        },
    }
}

/// Merge `extra`'s keys into a fresh args object alongside `last`.
fn args_for(last: &str, mode: &serde_json::Value, filter: &serde_json::Value) -> serde_json::Value {
    let mut args = serde_json::Map::new();
    let _last_set = args.insert("last".into(), json!(last));
    for source in [mode, filter] {
        if let Some(obj) = source.as_object() {
            for (k, v) in obj {
                let _flag_set = args.insert(k.clone(), v.clone());
            }
        }
    }
    serde_json::Value::Object(args)
}

/// One mode's payload, or the error string the daemon would have surfaced.
#[expect(
    clippy::expect_used,
    reason = "fixture-generator helper: a mode that returns None here is one this generator was not written for, and panicking names it immediately"
)]
fn payload(
    ledger: &Ledger,
    usage_config: &UsageConfig,
    args: &serde_json::Value,
    at: DateTime<Utc>,
) -> serde_json::Value {
    match usage_payload_at(ledger, usage_config, args, at).expect("mode is ledger-answerable") {
        Ok(value) => value,
        Err((code, message)) => json!({ "error": format!("{code:?}"), "message": message }),
    }
}

#[test]
#[expect(
    clippy::print_stderr,
    reason = "a skipped test must say why on the test harness's own output stream"
)]
fn usage_payloads_match_shared_fixture() {
    std::env::set_var("TZ", TZ);

    // chrono reads `TZ` through the host tz database. Without tzdata `Local`
    // silently stays UTC, which would make this fixture describe a zone the
    // generator never used — worse than failing.
    let probe = now().with_timezone(&chrono::Local).to_rfc3339();
    if !probe.starts_with("2026-05-13T12:20:00-04:00") {
        eprintln!("skipping: host has no {TZ} tzdata (Local resolved to {probe})");
        return;
    }

    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/ledger_usage_parity.json"
    );

    let seed_rows = seed();
    let dir = std::env::temp_dir().join("shore-usage-parity");
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let ledger = seeded_ledger(&dir, &seed_rows);

    let at = now();
    let mut period_cases = Vec::new();
    let mut payload_cases = Vec::new();

    for timezone in ["utc", "local"] {
        let usage_config = config(timezone);

        for last in periods() {
            period_cases.push(json!({
                "timezone": timezone,
                "last": last,
                "since": parse_last_period_at(last, at, timezone),
            }));
        }

        // Every mode over every `--last`, unfiltered: the windows are where the
        // timezone shows up.
        for (mode_name, mode) in modes() {
            for last in periods() {
                payload_cases.push(json!({
                    "timezone": timezone,
                    "mode": mode_name,
                    "last": last,
                    "filter": "none",
                    "payload": payload(&ledger, &usage_config, &args_for(last, &mode, &json!({})), at),
                }));
            }
            // Then every filter at one window, which is enough to pin how the
            // filter reaches the query without squaring the case count.
            for (filter_name, filter) in filters() {
                if filter_name == "none" {
                    continue;
                }
                payload_cases.push(json!({
                    "timezone": timezone,
                    "mode": mode_name,
                    "last": "all",
                    "filter": filter_name,
                    "payload": payload(&ledger, &usage_config, &args_for("all", &mode, &filter), at),
                }));
            }
        }
    }

    let doc = json!({
        "_comment": [
            "Generated. Do not hand-edit — see `usage_payloads_match_shared_fixture`",
            "in crates/daemon/tests/usage_parity.rs.",
            "Generated with TZ=America/New_York and a fixed `now`, so the local-zone",
            "calendar boundaries are real and the seed straddles them. Replayed by",
            "llm-sidecar/tests/ledger_usage_parity.test.ts against the TypeScript port,",
            "which sets the same zone and the same `now`."
        ],
        "timezone": TZ,
        "now": at.to_rfc3339(),
        "seed": seed_rows.iter().map(|r| json!({
            "ts": r.ts, "character": r.character, "provider": r.provider,
            "api_key_name": r.api_key_name, "model": r.model, "call_type": r.call_type,
            "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
            "cache_read_tokens": r.cache_read_tokens,
            "cache_write_tokens": r.cache_write_tokens,
            "cache_ttl": r.cache_ttl, "reasoning_effort": r.reasoning_effort,
            "total_ms": r.total_ms, "ttft_ms": r.ttft_ms,
            "finish_reason": r.finish_reason,
            "thinking_enabled": i32::from(r.thinking_enabled),
            "cache_state": r.cache_state, "cache_anomaly": r.cache_anomaly,
            "input_cost": r.input_cost, "output_cost": r.output_cost,
            "cache_read_cost": r.cache_read_cost, "cache_write_cost": r.cache_write_cost,
            "cost_source": r.cost_source, "total_cost": r.total_cost,
        })).collect::<Vec<_>>(),
        "periods": period_cases,
        "payloads": payload_cases,
    });
    let rendered = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());

    if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
        std::fs::write(path, &rendered).unwrap();
        return;
    }

    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        rendered, on_disk,
        "usage payloads changed. Regenerate with SHORE_REGENERATE_FIXTURES=1 \
         and update llm-sidecar/src/ledger/usage.ts to match."
    );
}
