//! Pace sub-windows across a DST transition, in the budget's *local* timezone.
//!
//! This lives in its own integration-test binary because it sets `TZ`, and
//! `TZ` is process-global: run alongside the unit tests it would race every
//! other test in that binary. One test per binary, set before the first
//! `Local` call, is the only safe way to pin the zone-aware path — which is
//! the whole reason `PeriodWindow` carries naive bounds and `pace_window`
//! steps through them.

use shore_config::app::{
    BudgetWeekday, UsageBudgetAction, UsageBudgetConfig, UsageBudgetPeriod, UsageConfig,
};
use shore_ledger::budget::budget_statuses;
use shore_ledger::ledger::Ledger;

/// US spring-forward 2026 is Sunday March 8 (02:00 EST -> 03:00 EDT). A weekly
/// budget anchored to Wednesday 06:00 straddles it: the week opens Wed March 4
/// at 06:00 EST (`11:00Z`) and closes Wed March 11 at 06:00 EDT (`10:00Z`).
///
/// Every day-pace boundary inside that week must sit at 06:00 *local*. Stepping
/// in instant space instead would keep every boundary at `11:00Z` — 07:00 EDT
/// after the transition, an hour off the budget's own reset hour, which is
/// exactly the drift the naive stepping exists to prevent.
#[test]
#[expect(
    clippy::print_stderr,
    reason = "a skipped test must say why on the test harness's own output stream"
)]
fn day_pace_holds_the_local_reset_hour_across_spring_forward() {
    std::env::set_var("TZ", "America/New_York");

    // chrono reads `TZ` through the host tz database. On a machine without
    // tzdata `Local` silently stays UTC, which would make the assertions below
    // meaningless rather than failing — so check, and say so, instead of
    // asserting something the environment can't support.
    let probe = "2026-03-09T16:00:00+00:00"
        .parse::<chrono::DateTime<chrono::Utc>>()
        .expect("probe timestamp parses")
        .with_timezone(&chrono::Local)
        .to_rfc3339();
    if !probe.starts_with("2026-03-09T12:00:00-04:00") {
        eprintln!("skipping: host has no America/New_York tzdata (Local resolved to {probe})");
        return;
    }

    let ledger = Ledger::open_in_memory().expect("in-memory ledger opens");
    let config = UsageConfig {
        // Anything but "utc" selects the local path.
        timezone: "local".into(),
        budgets: vec![paced_weekly_budget()],
        ..UsageConfig::default()
    };

    // Monday March 9, 12:00 EDT — the day after the transition.
    let now = "2026-03-09T16:00:00+00:00"
        .parse()
        .expect("timestamp parses");
    let statuses = budget_statuses(&ledger, &config, now).expect("budget query succeeds");
    let pace = statuses
        .first()
        .expect("one budget configured")
        .pace
        .as_ref()
        .expect("budget configures a pace");

    // 06:00 EDT on the 9th and the 10th, i.e. 10:00Z — not the 11:00Z that
    // instant-space stepping from the pre-transition week start would give.
    assert_eq!(
        pace.window_start, "2026-03-09T10:00:00+00:00",
        "the day-pace opens at 06:00 local, post-transition"
    );
    assert_eq!(
        pace.window_end, "2026-03-10T10:00:00+00:00",
        "and closes at 06:00 local the next day"
    );

    // The week is 7 days of wall clock but only 167 hours of elapsed time.
    // `periods_remaining` counts wall-clock days, so Monday sees a clean 2 days
    // left (itself and Tuesday) — no fractional smear from the lost hour, which
    // an elapsed-seconds count over instants would produce.
    assert!(
        (pace.periods_remaining - 2.0).abs() < 1e-9,
        "2 whole days left in the week, got {}",
        pace.periods_remaining
    );
}

fn paced_weekly_budget() -> UsageBudgetConfig {
    UsageBudgetConfig {
        name: "weekly".into(),
        period: UsageBudgetPeriod::Week,
        cost_usd: 14.0,
        warn_at: vec![0.8, 1.0],
        limit: UsageBudgetAction::Warn,
        character: None,
        provider: None,
        api_key: None,
        model: None,
        call_type: None,
        usage_kind: Vec::new(),
        allow_compaction_over_budget: None,
        reset_hour: Some(6),
        reset_day_of_week: Some(BudgetWeekday::Wednesday),
        reset_day_of_month: None,
        pace_period: Some(UsageBudgetPeriod::Day),
        pace_action: None,
        pace_warn_at: None,
    }
}
