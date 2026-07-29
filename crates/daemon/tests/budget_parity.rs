//! Generates the cross-language budget fixture, under a real timezone.
//!
//! This lives in its own integration-test binary for the same reason
//! `pace_dst.rs` does: it sets `TZ`, and `TZ` is process-global. Run alongside
//! the unit tests it would race every other test in that binary.
//!
//! A real zone is the point rather than an inconvenience. The budget's window
//! arithmetic is only interesting where wall-clock and instant disagree, so the
//! `now` values below straddle both US 2026 transitions — spring forward on
//! March 8 (02:00 EST → 03:00 EDT, an hour that does not exist) and fall back on
//! November 1 (01:00–02:00 EDT happens twice). A port that stepped in instant
//! space, or that resolved an ambiguous wall-clock to the later instant, passes
//! every UTC case and fails here.
//!
//! Regenerate with `SHORE_REGENERATE_FIXTURES=1 cargo test -p shore-daemon
//! --test budget_parity`.

use chrono::{DateTime, Utc};
use serde_json::json;
use shore_common::config::app::{
    BudgetWeekday, UsageBudgetAction, UsageBudgetConfig, UsageBudgetPeriod, UsageConfig,
    UsageSpikeWarningsConfig,
};
use shore_daemon::ledger::budget::{
    budget_statuses, enforce_budget_for_call, newly_crossed_budget_warnings, spike_warnings,
    BudgetCallContext,
};
use shore_daemon::ledger::client::CallType;
use shore_daemon::ledger::store::{CallRow, Ledger};

const TZ: &str = "America/New_York";

#[expect(
    clippy::expect_used,
    reason = "fixture-generator helper: a bad literal here is a broken generator, and panicking names it immediately"
)]
fn ts(rfc3339: &str) -> DateTime<Utc> {
    rfc3339.parse().expect("timestamp parses")
}

/// A ledger on disk, seeded with `rows`.
///
/// `Ledger::insert` is `#[cfg(test)]`, so it does not exist for an integration
/// test binary. Opening the file the daemon's own `Ledger::open` just created
/// and inserting through `rusqlite` keeps the schema authored in exactly one
/// place while still letting this seed it.
#[expect(
    clippy::expect_used,
    reason = "fixture-generator helper: a seed that will not insert is a broken generator, and panicking names it immediately"
)]
fn seeded_ledger(dir: &std::path::Path, case: usize, rows: &[CallRow]) -> Ledger {
    let path = dir.join(format!("budget-parity-{case}.db"));
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

/// A priced row. Only the fields the budget reads matter; the rest mirror a
/// realistic call so the seed is legible.
fn row(ts: &str, character: &str, call_type: &str, cost: f64) -> CallRow {
    CallRow {
        ts: ts.into(),
        character: character.into(),
        provider: "anthropic".into(),
        api_key_name: Some("default".into()),
        model: "claude-opus-4-6".into(),
        call_type: call_type.into(),
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 80,
        cache_write_tokens: 20,
        cache_ttl: None,
        reasoning_effort: None,
        total_ms: 1200,
        ttft_ms: 150,
        finish_reason: "end_turn".into(),
        thinking_enabled: true,
        cache_state: Some("warm".into()),
        cache_anomaly: None,
        input_cost: Some(cost),
        output_cost: Some(0.0),
        cache_read_cost: Some(0.0),
        cache_write_cost: Some(0.0),
        cost_source: Some("pricing_catalog".into()),
        total_cost: Some(cost),
    }
}

/// Spend spread across both DST transitions and the days around them.
fn seed() -> Vec<CallRow> {
    vec![
        // The DST week: budget week opens Wed Mar 4 06:00 EST (11:00Z).
        row("2026-03-04T12:00:00+00:00", "aria", "message", 1.5),
        row("2026-03-06T15:00:00+00:00", "aria", "tool_loop", 2.25),
        // Inside the spring-forward day itself.
        row("2026-03-08T06:30:00+00:00", "aria", "message", 0.75),
        row("2026-03-08T08:00:00+00:00", "kai", "heartbeat", 0.4),
        // The day after the transition, inside the Monday day-pace.
        row("2026-03-09T13:00:00+00:00", "aria", "message", 3.1),
        row("2026-03-09T18:00:00+00:00", "aria", "keepalive", 0.2),
        // Fall-back weekend: 01:30 local happens twice on Nov 1.
        row("2026-11-01T05:30:00+00:00", "aria", "message", 2.0),
        row("2026-11-01T06:30:00+00:00", "aria", "message", 1.0),
        row("2026-11-02T14:00:00+00:00", "aria", "compaction", 0.5),
        // No configured key name, so it reads back as "unknown" — the only way
        // the `api_key = "unknown"` budget below matches anything.
        CallRow {
            api_key_name: None,
            ..row("2026-03-05T12:00:00+00:00", "aria", "message", 0.8)
        },
    ]
}

fn budget(name: &str, period: UsageBudgetPeriod, cost_usd: f64) -> UsageBudgetConfig {
    UsageBudgetConfig {
        name: name.into(),
        period,
        cost_usd,
        warn_at: vec![0.5, 0.805, 1.0],
        limit: UsageBudgetAction::Warn,
        character: None,
        provider: None,
        api_key: None,
        model: None,
        call_type: None,
        usage_kind: Vec::new(),
        allow_compaction_over_budget: None,
        reset_hour: None,
        reset_day_of_week: None,
        reset_day_of_month: None,
        pace_period: None,
        pace_action: None,
        pace_warn_at: None,
    }
}

/// The configs evaluated at every `now`. Names double as fixture keys and must
/// match the TypeScript side's table.
fn configs() -> Vec<(&'static str, UsageConfig)> {
    // The weekly budget from `pace_dst.rs`: Wednesday 06:00 anchor, day pace.
    let paced_weekly = UsageBudgetConfig {
        reset_hour: Some(6),
        reset_day_of_week: Some(BudgetWeekday::Wednesday),
        pace_period: Some(UsageBudgetPeriod::Day),
        ..budget("weekly", UsageBudgetPeriod::Week, 14.0)
    };
    // Blocks, and paces by hour, so enforcement has something to refuse.
    let blocking_day = UsageBudgetConfig {
        limit: UsageBudgetAction::Block,
        reset_hour: Some(6),
        pace_period: Some(UsageBudgetPeriod::Hour),
        pace_action: Some(UsageBudgetAction::PauseBackground),
        ..budget("daily-block", UsageBudgetPeriod::Day, 2.0)
    };
    // Filtered by usage kind, so `budget_matches_call`'s kind arm matters.
    let filtered = UsageBudgetConfig {
        character: Some("aria".into()),
        usage_kind: vec!["message_with_tools".into()],
        limit: UsageBudgetAction::Warn,
        ..budget("aria-tools", UsageBudgetPeriod::Month, 5.0)
    };
    // Over limit, and pausing only background work: a foreground call must be
    // allowed through while a keepalive on the same character is refused.
    // Without both halves, "pause_background blocks everything" reads as
    // correct.
    let background_pause = UsageBudgetConfig {
        character: Some("aria".into()),
        limit: UsageBudgetAction::PauseBackground,
        ..budget("aria-background", UsageBudgetPeriod::Month, 2.0)
    };
    // Spend lands exactly on the limit: kai's single 0.40 heartbeat against a
    // $0.40 cap. `over_limit` is `>=`, so this is the case that decides whether
    // the call that reaches the limit is the last one allowed or the first one
    // refused.
    let exact_limit = UsageBudgetConfig {
        character: Some("kai".into()),
        limit: UsageBudgetAction::Block,
        ..budget("kai-exact", UsageBudgetPeriod::Month, 0.4)
    };
    // Matches only calls with no configured key name, which read as "unknown".
    let unknown_key = UsageBudgetConfig {
        api_key: Some("unknown".into()),
        limit: UsageBudgetAction::Block,
        ..budget("unknown-key", UsageBudgetPeriod::Month, 0.5)
    };
    // Month anchored to the 31st, which clamps on short months.
    let clamped_month = UsageBudgetConfig {
        reset_day_of_month: Some(31),
        reset_hour: Some(9),
        pace_period: Some(UsageBudgetPeriod::Week),
        ..budget("month-31", UsageBudgetPeriod::Month, 20.0)
    };

    let spike = UsageSpikeWarningsConfig {
        enabled: true,
        period: UsageBudgetPeriod::Day,
        multiplier: 1.5,
        min_cost_usd: 0.5,
    };

    vec![
        (
            "local_paced_weekly",
            UsageConfig {
                timezone: "local".into(),
                budgets: vec![paced_weekly.clone()],
                spike_warnings: spike.clone(),
                ..UsageConfig::default()
            },
        ),
        (
            "utc_paced_weekly",
            UsageConfig {
                timezone: "utc".into(),
                budgets: vec![paced_weekly],
                spike_warnings: spike.clone(),
                ..UsageConfig::default()
            },
        ),
        (
            "local_mixed",
            UsageConfig {
                timezone: "local".into(),
                budgets: vec![blocking_day, filtered, clamped_month],
                spike_warnings: spike,
                ..UsageConfig::default()
            },
        ),
        (
            "local_edges",
            UsageConfig {
                timezone: "local".into(),
                budgets: vec![background_pause, exact_limit, unknown_key],
                ..UsageConfig::default()
            },
        ),
    ]
}

/// Instants chosen to sit on either side of, and inside, both transitions.
fn nows() -> Vec<(&'static str, DateTime<Utc>)> {
    vec![
        ("before_spring_forward", ts("2026-03-06T15:00:00+00:00")),
        ("spring_forward_hour", ts("2026-03-08T07:30:00+00:00")),
        ("after_spring_forward", ts("2026-03-09T16:00:00+00:00")),
        ("fall_back_first_pass", ts("2026-11-01T05:30:00+00:00")),
        ("fall_back_second_pass", ts("2026-11-01T06:30:00+00:00")),
        ("ordinary_midweek", ts("2026-04-15T18:20:00+00:00")),
        ("month_end_clamp", ts("2026-02-28T14:00:00+00:00")),
        // Late in a month-with-week-pace window, where the trailing sub-window
        // is shorter than a whole week: `periods_remaining` drops below 1 and
        // the divisor's floor is what stops the allowance being inflated past
        // what is actually left.
        ("trailing_partial_pace", ts("2026-03-30T12:00:00+00:00")),
    ]
}

/// Call contexts run through enforcement at every `now`.
fn calls() -> Vec<(&'static str, BudgetCallContext<'static>)> {
    let base = |call_type, character| BudgetCallContext {
        provider: "anthropic",
        api_key_name: Some("default"),
        model: "claude-opus-4-6",
        call_type,
        character,
    };
    vec![
        ("foreground_aria", base(CallType::Message, "aria")),
        ("tool_loop_aria", base(CallType::ToolLoop, "aria")),
        ("heartbeat_kai", base(CallType::Heartbeat, "kai")),
        ("keepalive_aria", base(CallType::Keepalive, "aria")),
        ("compaction_aria", base(CallType::Compaction, "aria")),
        (
            "subscription_provider",
            BudgetCallContext {
                provider: "opencode-go",
                api_key_name: None,
                model: "kimi-k3",
                call_type: CallType::Message,
                character: "aria",
            },
        ),
        // No key name, which `budget_matches_call` reads as "unknown".
        (
            "no_key_name",
            BudgetCallContext {
                api_key_name: None,
                ..base(CallType::Message, "aria")
            },
        ),
    ]
}

fn enforce_json(config: &UsageConfig, ledger: &Ledger, now: DateTime<Utc>) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for (name, call) in calls() {
        let decision = match enforce_budget_for_call(ledger, config, call, now) {
            Ok(()) => json!({ "allowed": true }),
            Err(block) => json!({
                "allowed": false,
                "budget_name": block.budget_name,
                "action": block.action,
                "current_cost": block.current_cost,
                "cost_limit": block.cost_limit,
                "period": block.period,
                "reset_at": block.reset_at,
                "scope": block.scope,
                "message": block.to_string(),
            }),
        };
        let _ignored = out.insert(name.to_owned(), decision);
    }
    serde_json::Value::Object(out)
}

#[test]
#[expect(
    clippy::print_stderr,
    reason = "a skipped test must say why on the test harness's own output stream"
)]
fn budget_results_match_shared_fixture() {
    std::env::set_var("TZ", TZ);

    // chrono reads `TZ` through the host tz database. On a machine without
    // tzdata `Local` silently stays UTC, which would make this fixture describe
    // a zone the generator never actually used — worse than failing.
    let probe = ts("2026-03-09T16:00:00+00:00")
        .with_timezone(&chrono::Local)
        .to_rfc3339();
    if !probe.starts_with("2026-03-09T12:00:00-04:00") {
        eprintln!("skipping: host has no {TZ} tzdata (Local resolved to {probe})");
        return;
    }

    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/ledger_budget_parity.json"
    );

    let seed_rows = seed();
    let dir = std::env::temp_dir().join("shore-budget-parity");
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let mut cases = Vec::new();
    let mut case_index = 0_usize;
    for (config_name, config) in configs() {
        for (now_name, now) in nows() {
            // A fresh ledger per case: `newly_crossed_budget_warnings` writes
            // dedup rows, and a shared one would make each case depend on the
            // order of the ones before it.
            case_index = case_index.saturating_add(1);
            let ledger = seeded_ledger(&dir, case_index, &seed_rows);

            let statuses = budget_statuses(&ledger, &config, now).expect("statuses");
            let spikes = spike_warnings(&ledger, &config, now).expect("spikes");
            // Called twice: the second call must return only the "still over
            // budget" re-fires, because the intermediate thresholds have been
            // recorded. That dedup is a stateful rule, and a port can get the
            // first call right and the second wrong.
            let warnings_first =
                newly_crossed_budget_warnings(&ledger, &config, now).expect("warnings");
            let warnings_second =
                newly_crossed_budget_warnings(&ledger, &config, now).expect("warnings again");

            cases.push(json!({
                "config": config_name,
                "now_name": now_name,
                "now": now.to_rfc3339(),
                "statuses": statuses,
                "spike_warnings": spikes,
                "warnings_first": warnings_first,
                "warnings_second": warnings_second,
                "enforce": enforce_json(&config, &ledger, now),
            }));
        }
    }

    let doc = json!({
        "_comment": [
            "Generated. Do not hand-edit — see `budget_results_match_shared_fixture`",
            "in crates/daemon/tests/budget_parity.rs.",
            "Generated with TZ=America/New_York so the local-timezone path is real:",
            "the `now` values straddle both 2026 US transitions. Replayed by",
            "llm-sidecar/tests/ledger_budget_parity.test.ts against the TypeScript",
            "port, which sets the same zone."
        ],
        "timezone": TZ,
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
        "cases": cases,
    });
    let rendered = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());

    if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
        std::fs::write(path, &rendered).unwrap();
        return;
    }

    let on_disk = std::fs::read_to_string(path).unwrap_or_default();
    assert_eq!(
        rendered, on_disk,
        "budget results changed. Regenerate with SHORE_REGENERATE_FIXTURES=1 \
         and update llm-sidecar/src/ledger/budget.ts to match."
    );
}
