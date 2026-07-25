//! Usage budget evaluation over the append-only ledger.

use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Timelike, Utc,
};
use rusqlite::params;
use serde::Serialize;
use serde_json::json;
use shore_common::config::app::{
    BudgetWeekday, UsageBudgetAction, UsageBudgetConfig, UsageBudgetPeriod, UsageConfig,
};
use tracing::warn;

use crate::ledger::client::CallType;
use crate::ledger::convert::i64_to_f64;
use crate::ledger::query::{usage_totals, usage_totals_on, QueryFilter};
use crate::ledger::store::Ledger;

#[derive(Debug, Clone)]
struct PeriodWindow {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    /// Wall-clock bounds in the budget's timezone. Pace sub-windows step
    /// through naive space so a `reset_hour = 6` boundary stays at 06:00 across
    /// a DST transition instead of drifting an hour off the budget's own reset.
    start_naive: NaiveDateTime,
    end_naive: NaiveDateTime,
    timezone: String,
}

/// Which limit a block or warning refers to: the budget's own period cap, or
/// the pace allowance for the current sub-window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetScope {
    Budget,
    Pace,
}

impl BudgetScope {
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetScope::Budget => "budget",
            BudgetScope::Pace => "pace",
        }
    }

    /// Prefix for the `usage_budget_warnings.threshold` dedup key.
    ///
    /// A pace and its budget can open at the same instant — a Wednesday-anchored
    /// weekly budget starts its first day-pace exactly at the week start — so
    /// `(budget_name, period_start)` alone would collide. Prefixing the
    /// threshold text keeps the existing `UNIQUE` constraint and leaves rows
    /// already recorded for budget-scope warnings untouched.
    fn threshold_prefix(self) -> &'static str {
        match self {
            BudgetScope::Budget => "",
            BudgetScope::Pace => "pace:",
        }
    }
}

/// Spend target for the current pace sub-window.
///
/// The allowance is `budget remaining when this sub-window opened / sub-windows
/// left in the period`, so an underspent sub-window raises the next allowance
/// and an overspent one lowers it, while the budget's own `cost_usd` stays the
/// real cap.
#[derive(Debug, Clone, Serialize)]
pub struct PaceStatus {
    pub period: UsageBudgetPeriod,
    pub window_start: String,
    pub window_end: String,
    pub allowance: f64,
    pub current_cost: f64,
    /// `allowance - current_cost`; negative once this sub-window is overspent.
    pub remaining: f64,
    pub percent_used: f64,
    /// Sub-windows left in the budget period, counting the current one.
    /// Fractional when the period doesn't divide evenly — a month is ~4.4 weeks.
    pub periods_remaining: f64,
    pub status: String,
    pub action: UsageBudgetAction,
    pub warning_thresholds: Vec<f64>,
    pub crossed_warn_at: Vec<f64>,
    pub over_limit: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetStatus {
    pub name: String,
    pub period: UsageBudgetPeriod,
    pub period_start: String,
    pub period_end: String,
    pub reset_at: String,
    pub timezone: String,
    pub current_cost: f64,
    pub cost_limit: f64,
    pub percent_used: f64,
    pub status: String,
    pub action: UsageBudgetAction,
    pub warning_thresholds: Vec<f64>,
    pub crossed_warn_at: Vec<f64>,
    pub over_limit: bool,
    pub compaction_allowed_over_budget: bool,
    pub filters: serde_json::Value,
    /// Present only when the budget configures `pace_period`. Omitted from the
    /// wire otherwise, so an unpaced budget serializes exactly as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pace: Option<PaceStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpikeWarning {
    pub period: UsageBudgetPeriod,
    pub period_start: String,
    pub previous_period_start: String,
    pub timezone: String,
    pub current_cost: f64,
    pub previous_cost: f64,
    pub multiplier: Option<f64>,
    pub threshold_multiplier: f64,
    pub min_cost_usd: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageBudgetWarningEvent {
    pub budget: String,
    pub message: String,
    pub current_cost: f64,
    pub cost_limit: f64,
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    pub period: UsageBudgetPeriod,
    pub period_start: String,
    pub reset_at: String,
    /// `reset_at` rendered in the daemon's local time as `YYYY-MM-DD HH:MM AM|PM`
    /// for clients that surface this string verbatim. The structured `reset_at`
    /// field stays RFC 3339 UTC for machine consumers.
    pub reset_at_display: String,
    /// Whether this warning is about the budget cap or its pace allowance.
    /// The cost/period/window fields describe whichever one tripped.
    pub scope: BudgetScope,
}

#[derive(Debug, Clone, Copy)]
pub struct BudgetCallContext<'ctx> {
    pub provider: &'ctx str,
    pub api_key_name: Option<&'ctx str>,
    pub model: &'ctx str,
    pub call_type: CallType,
    pub character: &'ctx str,
}

#[derive(Debug, Clone)]
pub struct BudgetBlock {
    pub budget_name: String,
    pub action: UsageBudgetAction,
    pub current_cost: f64,
    pub cost_limit: f64,
    /// Period of whichever limit tripped: the budget window for
    /// [`BudgetScope::Budget`], the pace sub-window for [`BudgetScope::Pace`].
    pub period: UsageBudgetPeriod,
    pub reset_at: String,
    pub scope: BudgetScope,
}

impl std::fmt::Display for BudgetBlock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.scope {
            BudgetScope::Budget => write!(
                f,
                "Shore usage budget \"{}\" is over limit (${:.2}/${:.2} for {:?}); action {:?}; resets at {}",
                self.budget_name,
                self.current_cost,
                self.cost_limit,
                self.period,
                self.action,
                self.reset_at
            ),
            BudgetScope::Pace => write!(
                f,
                "Shore usage budget \"{}\" {} pace is exhausted (${:.2}/${:.2}); action {:?}; pace resets at {}",
                self.budget_name,
                self.period.as_str(),
                self.current_cost,
                self.cost_limit,
                self.action,
                self.reset_at
            ),
        }
    }
}

impl std::error::Error for BudgetBlock {}

pub fn budget_statuses(
    ledger: &Ledger,
    config: &UsageConfig,
    now: DateTime<Utc>,
) -> Result<Vec<BudgetStatus>, rusqlite::Error> {
    config
        .budgets
        .iter()
        .enumerate()
        .map(|(idx, budget)| budget_status(ledger, config, budget, idx, now))
        .collect()
}

pub fn enforce_budget_for_call(
    ledger: &Ledger,
    config: &UsageConfig,
    call: BudgetCallContext<'_>,
    now: DateTime<Utc>,
) -> Result<(), BudgetBlock> {
    if config.budgets.is_empty() {
        return Ok(());
    }

    // Subscription-provider calls cost nothing at the margin, so no budget may
    // throttle them — mirrors the `$0`/`cost_source = "subscription"` row that
    // `build_call_row` records for these providers.
    if crate::ledger::is_subscription_provider(call.provider) {
        return Ok(());
    }

    for (idx, budget) in config.budgets.iter().enumerate() {
        if !budget_matches_call(budget, &call) {
            continue;
        }
        let status = match budget_status(ledger, config, budget, idx, now) {
            Ok(status) => status,
            Err(e) => {
                warn!(
                    budget = %budget_name(budget, idx),
                    error = %e,
                    "Usage budget query failed; allowing call"
                );
                continue;
            }
        };
        // The budget cap is checked first: it is the harder stop, and naming it
        // in the error is more useful than naming the pace that also tripped.
        if status.over_limit && should_block(config, budget, status.action, call.call_type) {
            return Err(BudgetBlock {
                budget_name: status.name,
                action: status.action,
                current_cost: status.current_cost,
                cost_limit: status.cost_limit,
                period: status.period,
                reset_at: status.reset_at,
                scope: BudgetScope::Budget,
            });
        }
        if let Some(pace) = status.pace {
            if pace.over_limit && should_block(config, budget, pace.action, call.call_type) {
                return Err(BudgetBlock {
                    budget_name: status.name,
                    action: pace.action,
                    current_cost: pace.current_cost,
                    cost_limit: pace.allowance,
                    period: pace.period,
                    reset_at: pace.window_end,
                    scope: BudgetScope::Pace,
                });
            }
        }
    }

    Ok(())
}

#[expect(
    clippy::float_arithmetic,
    reason = "usage spike detection compares f64 USD totals as a ratio against a configured multiplier"
)]
pub fn spike_warnings(
    ledger: &Ledger,
    config: &UsageConfig,
    now: DateTime<Utc>,
) -> Result<Vec<SpikeWarning>, rusqlite::Error> {
    let spike = &config.spike_warnings;
    if !spike.enabled {
        return Ok(Vec::new());
    }

    let current = period_window(now, spike.period, &config.timezone, None);
    let previous_anchor = current
        .start
        .checked_sub_signed(Duration::seconds(1))
        .unwrap_or(current.start);
    let previous = period_window(previous_anchor, spike.period, &config.timezone, None);

    let current_cost = usage_totals(
        ledger,
        &QueryFilter {
            since: Some(current.start.to_rfc3339()),
            ..Default::default()
        },
    )?
    .total_cost;
    let previous_cost = usage_totals(
        ledger,
        &QueryFilter {
            since: Some(previous.start.to_rfc3339()),
            until: Some(current.start.to_rfc3339()),
            ..Default::default()
        },
    )?
    .total_cost;

    if current_cost < spike.min_cost_usd {
        return Ok(Vec::new());
    }

    let multiplier = if previous_cost > 0.0 {
        Some(current_cost / previous_cost)
    } else {
        None
    };
    let is_spike = multiplier.map_or(previous_cost == 0.0, |m| m >= spike.multiplier);
    if !is_spike {
        return Ok(Vec::new());
    }

    let message = match multiplier {
        Some(m) => format!(
            "Current {:?} spend is {:.1}x the previous {:?} (${:.2} vs ${:.2}).",
            spike.period, m, spike.period, current_cost, previous_cost
        ),
        None => format!(
            "Current {:?} spend is ${:.2}; the previous {:?} had no recorded cost.",
            spike.period, current_cost, spike.period
        ),
    };

    Ok(vec![SpikeWarning {
        period: spike.period,
        period_start: current.start.to_rfc3339(),
        previous_period_start: previous.start.to_rfc3339(),
        timezone: current.timezone,
        current_cost,
        previous_cost,
        multiplier,
        threshold_multiplier: spike.multiplier,
        min_cost_usd: spike.min_cost_usd,
        message,
    }])
}

/// Return newly crossed budget warning thresholds, recording each
/// budget/window/threshold so future checks don't repeat the same warning.
///
/// Once a budget is over its limit, the warning re-fires on every check
/// regardless of dedup — intermediate thresholds (50%, 80%) staying one-shot
/// is the right call for noise, but "still over budget" is an active signal
/// the operator needs to keep seeing as spend continues to accrue.
pub fn newly_crossed_budget_warnings(
    ledger: &Ledger,
    config: &UsageConfig,
    now: DateTime<Utc>,
) -> Result<Vec<UsageBudgetWarningEvent>, rusqlite::Error> {
    let statuses = budget_statuses(ledger, config, now)?;
    let mut events = Vec::new();

    for status in statuses {
        if let Some(event) = scope_warning(ledger, &budget_scope_view(&status), now)? {
            events.push(event);
        }
        if let Some(pace) = status.pace.as_ref() {
            if let Some(event) = scope_warning(ledger, &pace_scope_view(&status, pace), now)? {
                events.push(event);
            }
        }
    }

    Ok(events)
}

/// One limit's warning-relevant state, so budget-scope and pace-scope warnings
/// share a single threshold/dedup/re-fire implementation.
struct ScopeView<'view> {
    name: &'view str,
    scope: BudgetScope,
    period: UsageBudgetPeriod,
    window_start: &'view str,
    reset_at: &'view str,
    current_cost: f64,
    cost_limit: f64,
    percent_used: f64,
    crossed_warn_at: &'view [f64],
    over_limit: bool,
}

fn budget_scope_view(status: &BudgetStatus) -> ScopeView<'_> {
    ScopeView {
        name: &status.name,
        scope: BudgetScope::Budget,
        period: status.period,
        window_start: &status.period_start,
        reset_at: &status.reset_at,
        current_cost: status.current_cost,
        cost_limit: status.cost_limit,
        percent_used: status.percent_used,
        crossed_warn_at: &status.crossed_warn_at,
        over_limit: status.over_limit,
    }
}

fn pace_scope_view<'view>(
    status: &'view BudgetStatus,
    pace: &'view PaceStatus,
) -> ScopeView<'view> {
    ScopeView {
        name: &status.name,
        scope: BudgetScope::Pace,
        period: pace.period,
        window_start: &pace.window_start,
        reset_at: &pace.window_end,
        current_cost: pace.current_cost,
        cost_limit: pace.allowance,
        percent_used: pace.percent_used,
        crossed_warn_at: &pace.crossed_warn_at,
        over_limit: pace.over_limit,
    }
}

fn scope_warning(
    ledger: &Ledger,
    view: &ScopeView<'_>,
    now: DateTime<Utc>,
) -> Result<Option<UsageBudgetWarningEvent>, rusqlite::Error> {
    let mut newly_crossed = Vec::new();
    for threshold in view.crossed_warn_at {
        if record_budget_warning_threshold(
            ledger,
            view.name,
            view.scope,
            view.window_start,
            *threshold,
            now,
        )? {
            newly_crossed.push(*threshold);
        }
    }
    if newly_crossed.is_empty() && view.over_limit {
        newly_crossed.push(1.0);
    }
    if newly_crossed.is_empty() {
        return Ok(None);
    }

    let highest = newly_crossed.iter().copied().fold(0.0_f64, f64::max);
    let reset_display = format_local_ampm(view.reset_at);
    let message = match view.scope {
        BudgetScope::Budget => format!(
            "Usage budget \"{}\" reached {:.0}% (${:.2}/${:.2}); resets at {}.",
            view.name,
            fraction_to_percent(highest),
            view.current_cost,
            view.cost_limit,
            reset_display,
        ),
        BudgetScope::Pace => format!(
            "Usage budget \"{}\" {} pace reached {:.0}% (${:.2}/${:.2}); pace resets at {}.",
            view.name,
            view.period.as_str(),
            fraction_to_percent(highest),
            view.current_cost,
            view.cost_limit,
            reset_display,
        ),
    };

    Ok(Some(UsageBudgetWarningEvent {
        budget: view.name.to_owned(),
        message,
        current_cost: view.current_cost,
        cost_limit: view.cost_limit,
        percent_used: view.percent_used,
        crossed_warn_at: newly_crossed,
        period: view.period,
        period_start: view.window_start.to_owned(),
        reset_at: view.reset_at.to_owned(),
        reset_at_display: reset_display,
        scope: view.scope,
    }))
}

/// Render an RFC 3339 timestamp as `YYYY-MM-DD HH:MM AM|PM` in the daemon's
/// local time. Falls back to the raw input if it doesn't parse — better to
/// show something than nothing in a warning message.
fn format_local_ampm(rfc3339: &str) -> String {
    DateTime::parse_from_rfc3339(rfc3339).map_or_else(
        |_| rfc3339.to_owned(),
        |dt| {
            dt.with_timezone(&Local)
                .format("%Y-%m-%d %I:%M %p")
                .to_string()
        },
    )
}

#[expect(
    clippy::float_arithmetic,
    reason = "budget warning text renders configured f64 threshold fractions as percentages"
)]
fn fraction_to_percent(fraction: f64) -> f64 {
    fraction * 100.0
}

fn record_budget_warning_threshold(
    ledger: &Ledger,
    budget_name: &str,
    scope: BudgetScope,
    period_start: &str,
    threshold: f64,
    now: DateTime<Utc>,
) -> Result<bool, rusqlite::Error> {
    let threshold_key = format!("{}{threshold:.6}", scope.threshold_prefix());
    ledger.with_conn(|conn| {
        let changed = conn.execute(
            r"INSERT OR IGNORE INTO usage_budget_warnings
               (budget_name, period_start, threshold, created_at)
               VALUES (?1, ?2, ?3, ?4)",
            params![budget_name, period_start, threshold_key, now.to_rfc3339()],
        )?;
        Ok(changed > 0)
    })
}

#[expect(
    clippy::float_arithmetic,
    reason = "budget status compares f64 USD totals against configured f64 limits and thresholds"
)]
fn budget_status(
    ledger: &Ledger,
    config: &UsageConfig,
    budget: &UsageBudgetConfig,
    idx: usize,
    now: DateTime<Utc>,
) -> Result<BudgetStatus, rusqlite::Error> {
    let anchors = BudgetAnchors::from_budget(budget);
    let window = period_window(now, budget.period, &config.timezone, Some(&anchors));
    let pace_window = budget
        .pace_period
        .and_then(|period| pace_window(&window, now, period).map(|w| (period, w)));

    // Both totals are read under one lock. `pace_status` derives spend before
    // the sub-window by subtracting the second from the first, so a call
    // committed between two separate reads would land in only one of them and
    // briefly overstate the allowance. One `with_conn` makes the pair a
    // consistent snapshot.
    let (current_cost, pace_cost) = ledger.with_conn(|conn| {
        let period = usage_totals_on(conn, &filter_for_budget(budget, window.start))?.total_cost;
        let pace = match pace_window.as_ref() {
            Some((_, pace)) => {
                Some(usage_totals_on(conn, &filter_for_budget(budget, pace.start))?.total_cost)
            }
            None => None,
        };
        Ok((period, pace))
    })?;

    let percent_used = current_cost / budget.cost_usd;
    let (warning_thresholds, crossed_warn_at) = crossed_thresholds(&budget.warn_at, percent_used);
    let over_limit = current_cost >= budget.cost_usd;
    let pace = match (pace_window, pace_cost) {
        (Some((pace_period, sub_window)), Some(cost)) => Some(pace_status(
            budget,
            pace_period,
            &sub_window,
            current_cost,
            cost,
        )),
        _ => None,
    };

    Ok(BudgetStatus {
        name: budget_name(budget, idx),
        period: budget.period,
        period_start: window.start.to_rfc3339(),
        period_end: window.end.to_rfc3339(),
        reset_at: window.end.to_rfc3339(),
        timezone: window.timezone,
        current_cost,
        cost_limit: budget.cost_usd,
        percent_used,
        status: level_name(over_limit, &crossed_warn_at).to_owned(),
        action: budget.limit,
        warning_thresholds,
        crossed_warn_at,
        over_limit,
        compaction_allowed_over_budget: compaction_allowed(config, budget),
        filters: budget_filters_json(budget),
        pace,
    })
}

/// Sort and de-duplicate configured thresholds, and pick out those `percent_used`
/// has reached. Shared by the budget cap and its pace so both warn identically.
#[expect(
    clippy::float_arithmetic,
    reason = "threshold de-duplication compares configured f64 fractions within an epsilon"
)]
fn crossed_thresholds(configured: &[f64], percent_used: f64) -> (Vec<f64>, Vec<f64>) {
    let mut thresholds = configured.to_vec();
    thresholds.sort_by(f64::total_cmp);
    thresholds.dedup_by(|a, b| (*a - *b).abs() < f64::EPSILON);
    let crossed = thresholds
        .iter()
        .copied()
        .filter(|threshold| percent_used >= *threshold)
        .collect();
    (thresholds, crossed)
}

fn level_name(over_limit: bool, crossed: &[f64]) -> &'static str {
    if over_limit {
        "over_limit"
    } else if crossed.is_empty() {
        "ok"
    } else {
        "warning"
    }
}

/// Build the pace target for the sub-window containing `now`.
///
/// `period_cost` is the budget's spend for the whole current window and
/// `current_cost` its spend within the sub-window; both come from the same
/// ledger snapshot in [`budget_status`]. Spend committed *before* this
/// sub-window opened is derived by subtracting the second from the first, which
/// saves a third ledger query and — more importantly — freezes the allowance
/// for the sub-window's duration. Deriving it from spend-up-to-now instead
/// would let spending eat its own allowance: a $2.17 Thursday would drop to
/// $2.00 after $1 of spend, reporting $1.00 left rather than $1.17.
#[expect(
    clippy::float_arithmetic,
    reason = "the pace allowance divides remaining f64 USD by the f64 count of sub-windows left"
)]
fn pace_status(
    budget: &UsageBudgetConfig,
    pace_period: UsageBudgetPeriod,
    pace: &PaceWindow,
    period_cost: f64,
    current_cost: f64,
) -> PaceStatus {
    let spend_before = (period_cost - current_cost).max(0.0);
    let remaining_budget = (budget.cost_usd - spend_before).max(0.0);
    // A trailing sub-window shorter than a whole period (a month leaves ~3
    // days after four weeks) must not inflate the allowance past what is
    // actually left, so the divisor floors at one.
    let allowance = remaining_budget / pace.periods_remaining.max(1.0);

    // `allowance` is zero exactly when the budget is already spent, in which
    // case the budget's own status is over limit too. Such a sub-window is
    // exhausted by definition — nothing may be spent against it — so it reports
    // 100% rather than the `$0.00/$0.00  0%  over_limit` a literal ratio of
    // zeroes would print.
    let percent_used = if allowance > 0.0 {
        current_cost / allowance
    } else {
        1.0
    };
    let (warning_thresholds, crossed_warn_at) =
        crossed_thresholds(budget.pace_warn_at(), percent_used);
    let over_limit = current_cost >= allowance;

    PaceStatus {
        period: pace_period,
        window_start: pace.start.to_rfc3339(),
        window_end: pace.end.to_rfc3339(),
        allowance,
        current_cost,
        remaining: allowance - current_cost,
        percent_used,
        periods_remaining: pace.periods_remaining,
        status: level_name(over_limit, &crossed_warn_at).to_owned(),
        action: budget.pace_action(),
        warning_thresholds,
        crossed_warn_at,
        over_limit,
    }
}

fn filter_for_budget(budget: &UsageBudgetConfig, since: DateTime<Utc>) -> QueryFilter {
    QueryFilter {
        since: Some(since.to_rfc3339()),
        character: budget.character.clone(),
        provider: budget.provider.clone(),
        api_key_name: budget.api_key.clone(),
        model: budget.model.clone(),
        call_type: budget.call_type.clone(),
        usage_kinds: budget.usage_kind.clone(),
        ..Default::default()
    }
}

fn budget_name(budget: &UsageBudgetConfig, idx: usize) -> String {
    let name = budget.name.trim();
    if name.is_empty() {
        let display_index = idx.saturating_add(1);
        format!("budget {display_index}")
    } else {
        name.to_owned()
    }
}

fn budget_filters_json(budget: &UsageBudgetConfig) -> serde_json::Value {
    json!({
        "character": budget.character,
        "provider": budget.provider,
        "api_key": budget.api_key,
        "model": budget.model,
        "call_type": budget.call_type,
        "usage_kind": budget.usage_kind,
    })
}

fn budget_matches_call(budget: &UsageBudgetConfig, call: &BudgetCallContext<'_>) -> bool {
    if budget
        .character
        .as_deref()
        .is_some_and(|v| v != call.character)
    {
        return false;
    }
    if budget
        .provider
        .as_deref()
        .is_some_and(|v| v != call.provider)
    {
        return false;
    }
    if budget.model.as_deref().is_some_and(|v| v != call.model) {
        return false;
    }
    if budget
        .call_type
        .as_deref()
        .is_some_and(|v| v != call.call_type.as_str())
    {
        return false;
    }
    if let Some(api_key) = budget.api_key.as_deref() {
        let actual = call.api_key_name.unwrap_or("unknown");
        if api_key != actual {
            return false;
        }
    }
    if !budget.usage_kind.is_empty()
        && !budget
            .usage_kind
            .iter()
            .any(|kind| call_type_matches_usage_kind(call.call_type, kind))
    {
        return false;
    }

    true
}

fn call_type_matches_usage_kind(call_type: CallType, usage_kind: &str) -> bool {
    match call_type {
        CallType::Message => {
            usage_kind == "message"
                || usage_kind == "message_no_tools"
                || usage_kind == "message_with_tools"
        }
        CallType::ToolLoop => usage_kind == "message_with_tools" || usage_kind == "tool_loop",
        CallType::HeartbeatToolLoop | CallType::Heartbeat => usage_kind == "heartbeat",
        CallType::Keepalive => usage_kind == "keepalive",
        CallType::Compaction => usage_kind == "compaction",
        CallType::Dreaming => usage_kind == "dreaming",
        CallType::MemoryQuery => usage_kind == "memory_query",
        CallType::Subagent => usage_kind == "subagent",
    }
}

/// Whether `action` stops this call. Taken as a parameter rather than read off
/// the budget so the pace can enforce its own action with identical semantics.
fn should_block(
    config: &UsageConfig,
    budget: &UsageBudgetConfig,
    action: UsageBudgetAction,
    call_type: CallType,
) -> bool {
    if matches!(call_type, CallType::Compaction) && compaction_allowed(config, budget) {
        return false;
    }

    match action {
        UsageBudgetAction::Warn => false,
        UsageBudgetAction::Block => true,
        UsageBudgetAction::PauseBackground => is_background_call(call_type),
    }
}

fn compaction_allowed(config: &UsageConfig, budget: &UsageBudgetConfig) -> bool {
    budget
        .allow_compaction_over_budget
        .unwrap_or(config.allow_compaction_over_budget)
}

fn is_background_call(call_type: CallType) -> bool {
    matches!(
        call_type,
        CallType::Heartbeat
            | CallType::HeartbeatToolLoop
            | CallType::Keepalive
            | CallType::Compaction
            | CallType::Dreaming
            | CallType::MemoryQuery
    )
}

#[derive(Debug, Clone, Copy)]
struct BudgetAnchors {
    /// Hour-of-day (0-23) at which day/week/month windows reset.
    hour: u32,
    /// 0 = Monday .. 6 = Sunday. Used only for week windows.
    day_of_week: u32,
    /// Day-of-month (1-31). Clamped to the last day on short months.
    day_of_month: u32,
}

impl Default for BudgetAnchors {
    fn default() -> Self {
        Self {
            hour: 0,
            day_of_week: 0,
            day_of_month: 1,
        }
    }
}

impl BudgetAnchors {
    fn from_budget(budget: &UsageBudgetConfig) -> Self {
        Self {
            hour: budget.reset_hour.unwrap_or(0),
            day_of_week: budget
                .reset_day_of_week
                .map_or(0, BudgetWeekday::num_days_from_monday),
            day_of_month: budget.reset_day_of_month.unwrap_or(1),
        }
    }
}

fn period_window(
    now: DateTime<Utc>,
    period: UsageBudgetPeriod,
    timezone: &str,
    anchors: Option<&BudgetAnchors>,
) -> PeriodWindow {
    match timezone {
        "utc" => period_window_utc(now, period, anchors),
        _ => period_window_local(now, period, anchors),
    }
}

fn period_window_utc(
    now: DateTime<Utc>,
    period: UsageBudgetPeriod,
    anchors: Option<&BudgetAnchors>,
) -> PeriodWindow {
    let now_naive = now.naive_utc();
    let start_naive = period_start_naive(now_naive, period, anchors);
    let end_naive = period_end_naive(start_naive, period, anchors);
    PeriodWindow {
        start: Utc.from_utc_datetime(&start_naive),
        end: Utc.from_utc_datetime(&end_naive),
        start_naive,
        end_naive,
        timezone: "utc".into(),
    }
}

fn period_window_local(
    now: DateTime<Utc>,
    period: UsageBudgetPeriod,
    anchors: Option<&BudgetAnchors>,
) -> PeriodWindow {
    let local_now = now.with_timezone(&Local);
    let now_naive = local_now.naive_local();
    let start_naive = period_start_naive(now_naive, period, anchors);
    let end_naive = period_end_naive(start_naive, period, anchors);
    PeriodWindow {
        start: resolve_local(start_naive).with_timezone(&Utc),
        end: resolve_local(end_naive).with_timezone(&Utc),
        start_naive,
        end_naive,
        timezone: "local".into(),
    }
}

#[derive(Debug, Clone)]
struct PaceWindow {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    periods_remaining: f64,
}

/// Fixed length of a pace period.
///
/// `None` for `month`, which has no fixed length and can never be a pace:
/// config validation requires the pace to rank strictly shorter than the
/// budget period, and `month` is the longest. Returning `None` degrades an
/// impossible config to "no pace" instead of inventing a 30-day month.
fn pace_step(pace: UsageBudgetPeriod) -> Option<Duration> {
    match pace {
        UsageBudgetPeriod::Hour => Some(Duration::hours(1)),
        UsageBudgetPeriod::Day => Some(Duration::days(1)),
        UsageBudgetPeriod::Week => Some(Duration::days(7)),
        UsageBudgetPeriod::Month => None,
    }
}

/// The pace sub-window containing `now`, stepped from the budget window's own
/// start so sub-windows tile the period exactly and inherit its reset anchor.
///
/// Stepping happens in wall-clock (naive) space: across a DST transition a
/// `reset_hour = 6` day-pace stays anchored to 06:00 local rather than sliding
/// to 05:00 or 07:00. Only the final resolution back to instants is
/// zone-aware.
fn pace_window(
    window: &PeriodWindow,
    now: DateTime<Utc>,
    pace: UsageBudgetPeriod,
) -> Option<PaceWindow> {
    let step = pace_step(pace)?;
    let now_naive = match window.timezone.as_str() {
        "utc" => now.naive_utc(),
        _ => now.with_timezone(&Local).naive_local(),
    };
    let bounds = pace_bounds_naive(window, now_naive, step)?;

    Some(PaceWindow {
        start: resolve_in_zone(bounds.start, &window.timezone),
        end: resolve_in_zone(bounds.end, &window.timezone),
        periods_remaining: bounds.periods_remaining,
    })
}

/// Wall-clock bounds of the sub-window containing `now_naive`.
#[derive(Debug, Clone, Copy)]
struct PaceBounds {
    start: NaiveDateTime,
    end: NaiveDateTime,
    periods_remaining: f64,
}

/// The DST-relevant half of [`pace_window`], split out so it can be tested
/// directly.
///
/// Stepping in wall-clock space is what holds a `reset_hour = 6` boundary at
/// 06:00 through a transition: a naive clock has no transitions to slide
/// across. Pinned twice — `pace_steps_hold_the_wall_clock_hour_across_a_dst_week`
/// covers this arithmetic in isolation, and `tests/pace_dst.rs` drives the
/// whole zone-aware path (`period_window_local` and `resolve_in_zone`'s local
/// arm) under a real `TZ`. That one lives in its own test binary because `TZ`
/// is process-global.
#[expect(
    clippy::float_arithmetic,
    reason = "sub-windows remaining is a ratio of two second counts and is deliberately fractional"
)]
fn pace_bounds_naive(
    window: &PeriodWindow,
    now_naive: NaiveDateTime,
    step: Duration,
) -> Option<PaceBounds> {
    let step_secs = step.num_seconds();
    if step_secs <= 0 {
        return None;
    }

    let elapsed = now_naive
        .signed_duration_since(window.start_naive)
        .num_seconds()
        .max(0);
    let offset_secs = elapsed
        .checked_div(step_secs)?
        .checked_mul(step_secs)
        .unwrap_or(0);
    let start = window
        .start_naive
        .checked_add_signed(Duration::seconds(offset_secs))?;
    let end = start
        .checked_add_signed(step)
        .map_or(window.end_naive, |end| end.min(window.end_naive));

    let remaining_secs = window
        .end_naive
        .signed_duration_since(start)
        .num_seconds()
        .max(0);

    Some(PaceBounds {
        start,
        end,
        periods_remaining: i64_to_f64(remaining_secs) / i64_to_f64(step_secs),
    })
}

fn resolve_in_zone(naive: NaiveDateTime, timezone: &str) -> DateTime<Utc> {
    match timezone {
        "utc" => Utc.from_utc_datetime(&naive),
        _ => resolve_local(naive).with_timezone(&Utc),
    }
}

fn period_start_naive(
    now: NaiveDateTime,
    period: UsageBudgetPeriod,
    anchors_opt: Option<&BudgetAnchors>,
) -> NaiveDateTime {
    let anchors = anchors_opt.copied().unwrap_or_default();
    let date = now.date();
    match period {
        UsageBudgetPeriod::Hour => at_hour(date, now.hour()),
        UsageBudgetPeriod::Day => {
            let today_reset = at_hour(date, anchors.hour);
            if now >= today_reset {
                today_reset
            } else {
                let yesterday = date.pred_opt().unwrap_or(date);
                at_hour(yesterday, anchors.hour)
            }
        }
        UsageBudgetPeriod::Week => {
            let today_dow = date.weekday().num_days_from_monday();
            let days_back = today_dow
                .saturating_add(7)
                .saturating_sub(anchors.day_of_week)
                .checked_rem(7)
                .unwrap_or(0);
            let candidate_date = date
                .checked_sub_signed(Duration::days(i64::from(days_back)))
                .unwrap_or(date);
            let candidate = at_hour(candidate_date, anchors.hour);
            if now >= candidate {
                candidate
            } else {
                let previous_week = candidate_date
                    .checked_sub_signed(Duration::days(7))
                    .unwrap_or(candidate_date);
                at_hour(previous_week, anchors.hour)
            }
        }
        UsageBudgetPeriod::Month => {
            let this_month = month_anchor_naive(date.year(), date.month(), &anchors);
            if now >= this_month {
                this_month
            } else {
                let (prev_year, prev_month) = if date.month() == 1 {
                    (date.year().saturating_sub(1), 12)
                } else {
                    (date.year(), date.month().saturating_sub(1))
                };
                month_anchor_naive(prev_year, prev_month, &anchors)
            }
        }
    }
}

fn period_end_naive(
    start: NaiveDateTime,
    period: UsageBudgetPeriod,
    anchors_opt: Option<&BudgetAnchors>,
) -> NaiveDateTime {
    let anchors = anchors_opt.copied().unwrap_or_default();
    match period {
        UsageBudgetPeriod::Hour => start
            .checked_add_signed(Duration::hours(1))
            .unwrap_or(start),
        UsageBudgetPeriod::Day => start.checked_add_signed(Duration::days(1)).unwrap_or(start),
        UsageBudgetPeriod::Week => start.checked_add_signed(Duration::days(7)).unwrap_or(start),
        UsageBudgetPeriod::Month => {
            let (next_year, next_month) = if start.month() == 12 {
                (start.year().saturating_add(1), 1)
            } else {
                (start.year(), start.month().saturating_add(1))
            };
            month_anchor_naive(next_year, next_month, &anchors)
        }
    }
}

fn month_anchor_naive(year: i32, month: u32, anchors: &BudgetAnchors) -> NaiveDateTime {
    let max_day = days_in_month(year, month);
    let day = anchors.day_of_month.clamp(1, max_day);
    // `month` originates from a valid `NaiveDate` (1..=12) and `day` is clamped
    // into range, so construction succeeds; fall back to the first of the month
    // (always valid) rather than panic if a caller ever passes a bad month.
    let date = NaiveDate::from_ymd_opt(year, month, day)
        .or_else(|| NaiveDate::from_ymd_opt(year, month, 1))
        .unwrap_or_default();
    at_hour(date, anchors.hour)
}

/// Datetime at `hour:00:00` on `date`. `hour` is clamped into 0..=23 and
/// [`NaiveDate::and_time`] is total, so this never panics.
fn at_hour(date: NaiveDate, hour: u32) -> NaiveDateTime {
    let time = NaiveTime::from_hms_opt(hour.min(23), 0, 0).unwrap_or_default();
    date.and_time(time)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year.saturating_add(1), 1)
    } else {
        (year, month.saturating_add(1))
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|d| d.pred_opt())
        .map_or(28, |d| d.day())
}

fn resolve_local(naive: NaiveDateTime) -> DateTime<Local> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(early, _) => early,
        LocalResult::None => Local
            .from_local_datetime(
                &naive
                    .checked_add_signed(Duration::hours(1))
                    .unwrap_or(naive),
            )
            .earliest()
            .unwrap_or_else(|| Utc.from_utc_datetime(&naive).with_timezone(&Local)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::store::{CallRow, Ledger};
    use crate::llm::types::Timing;

    fn first_item<T>(items: &[T]) -> &T {
        items.first().expect("expected at least one item")
    }

    fn insert_call(ledger: &Ledger, ts: &str, cost: f64, call_type: &str) {
        let _ignored = ledger
            .insert(&CallRow {
                ts: ts.into(),
                character: "Alice".into(),
                provider: "openrouter".into(),
                api_key_name: Some("default".into()),
                model: "model".into(),
                call_type: call_type.into(),
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cache_ttl: None,
                total_ms: Timing::default().total_ms,
                ttft_ms: Timing::default().time_to_first_token_ms,
                finish_reason: "end_turn".into(),
                thinking_enabled: false,
                cache_state: None,
                cache_anomaly: None,
                input_cost: None,
                output_cost: None,
                cache_read_cost: None,
                cache_write_cost: None,
                cost_source: Some("provider_reported".into()),
                total_cost: Some(cost),
            })
            .unwrap();
    }

    #[test]
    fn utc_day_budget_sums_matching_rows() {
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 4.0, "message");
        insert_call(&ledger, "2026-05-17T23:00:00+00:00", 8.0, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-05-18T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let status = first_item(&statuses);
        #[expect(clippy::float_cmp, reason = "sum of four $1.00 rows is exact in f64")]
        {
            assert_eq!(status.current_cost, 4.0);
        }
        assert_eq!(status.status, "ok");
    }

    #[test]
    fn block_budget_blocks_matching_call() {
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 11.0, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                limit: UsageBudgetAction::Block,
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let result = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "openrouter",
                api_key_name: Some("default"),
                model: "model",
                call_type: CallType::Message,
                character: "Alice",
            },
            "2026-05-18T12:00:00+00:00".parse().unwrap(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn subscription_provider_call_is_never_blocked() {
        // An unfiltered block budget is over limit from metered providers, but a
        // flat-rate subscription call must still pass — it accrues no cost.
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 11.0, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                limit: UsageBudgetAction::Block,
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let result = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "opencode-go",
                api_key_name: Some("default"),
                model: "kimi-k2.6",
                call_type: CallType::Message,
                character: "Alice",
            },
            "2026-05-18T12:00:00+00:00".parse().unwrap(),
        );
        assert!(result.is_ok(), "subscription calls bypass usage budgets");
    }

    #[test]
    fn compaction_can_bypass_block_budget() {
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 11.0, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            allow_compaction_over_budget: true,
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                limit: UsageBudgetAction::Block,
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let result = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "openrouter",
                api_key_name: Some("default"),
                model: "model",
                call_type: CallType::Compaction,
                character: "Alice",
            },
            "2026-05-18T12:00:00+00:00".parse().unwrap(),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn budget_can_filter_by_usage_kind() {
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 3.0, "heartbeat");
        insert_call(&ledger, "2026-05-18T04:00:00+00:00", 9.0, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "heartbeat".into(),
                cost_usd: 10.0,
                usage_kind: vec!["heartbeat".into()],
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-05-18T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let status = first_item(&statuses);
        #[expect(clippy::float_cmp, reason = "sum of three $1.00 rows is exact in f64")]
        {
            assert_eq!(status.current_cost, 3.0);
        }
    }

    #[test]
    fn day_budget_respects_reset_hour() {
        // Before the reset hour, the window starts yesterday at reset_hour.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                period: UsageBudgetPeriod::Day,
                cost_usd: 10.0,
                reset_hour: Some(6),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let before = budget_statuses(
            &ledger,
            &config,
            "2026-05-20T03:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let before_status = first_item(&before);
        assert_eq!(before_status.period_start, "2026-05-19T06:00:00+00:00");
        assert_eq!(before_status.reset_at, "2026-05-20T06:00:00+00:00");

        let after = budget_statuses(
            &ledger,
            &config,
            "2026-05-20T09:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let after_status = first_item(&after);
        assert_eq!(after_status.period_start, "2026-05-20T06:00:00+00:00");
        assert_eq!(after_status.reset_at, "2026-05-21T06:00:00+00:00");
    }

    #[test]
    fn week_budget_respects_reset_day_and_hour() {
        // 2026-05-20 is a Wednesday. With reset_day_of_week=thursday and
        // reset_hour=3, the most recent Thursday 03:00 is 2026-05-14T03:00.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "weekly".into(),
                period: UsageBudgetPeriod::Week,
                cost_usd: 50.0,
                reset_day_of_week: Some(BudgetWeekday::Thursday),
                reset_hour: Some(3),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-05-20T14:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let status = first_item(&statuses);
        assert_eq!(status.period_start, "2026-05-14T03:00:00+00:00");
        assert_eq!(status.reset_at, "2026-05-21T03:00:00+00:00");
    }

    #[test]
    fn week_budget_resets_today_when_past_anchor_hour() {
        // 2026-05-21 is a Thursday. Past 03:00, the window starts today at 03:00.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "weekly".into(),
                period: UsageBudgetPeriod::Week,
                cost_usd: 50.0,
                reset_day_of_week: Some(BudgetWeekday::Thursday),
                reset_hour: Some(3),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-05-21T10:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let status = first_item(&statuses);
        assert_eq!(status.period_start, "2026-05-21T03:00:00+00:00");
        assert_eq!(status.reset_at, "2026-05-28T03:00:00+00:00");
    }

    #[test]
    fn month_budget_respects_reset_day_of_month() {
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "billing".into(),
                period: UsageBudgetPeriod::Month,
                cost_usd: 200.0,
                reset_day_of_month: Some(15),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        // Before the 15th: window started on the prior 15th.
        let before = budget_statuses(
            &ledger,
            &config,
            "2026-05-10T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let before_status = first_item(&before);
        assert_eq!(before_status.period_start, "2026-04-15T00:00:00+00:00");
        assert_eq!(before_status.reset_at, "2026-05-15T00:00:00+00:00");

        // After the 15th: window started this month.
        let after = budget_statuses(
            &ledger,
            &config,
            "2026-05-20T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let after_status = first_item(&after);
        assert_eq!(after_status.period_start, "2026-05-15T00:00:00+00:00");
        assert_eq!(after_status.reset_at, "2026-06-15T00:00:00+00:00");
    }

    #[test]
    fn month_anchor_clamps_to_short_months() {
        // reset_day_of_month=31, now is mid-February: clamp to Feb 28 (non-leap).
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "monthly".into(),
                period: UsageBudgetPeriod::Month,
                cost_usd: 100.0,
                reset_day_of_month: Some(31),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        // 2026 is not a leap year. Mid-Feb is before Feb 28 anchor.
        let mid_feb = budget_statuses(
            &ledger,
            &config,
            "2026-02-15T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let mid_feb_status = first_item(&mid_feb);
        assert_eq!(mid_feb_status.period_start, "2026-01-31T00:00:00+00:00");
        assert_eq!(mid_feb_status.reset_at, "2026-02-28T00:00:00+00:00");

        // Past the clamped Feb anchor: window starts on Feb 28.
        let late_feb = budget_statuses(
            &ledger,
            &config,
            "2026-02-28T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let late_feb_status = first_item(&late_feb);
        assert_eq!(late_feb_status.period_start, "2026-02-28T00:00:00+00:00");
        assert_eq!(late_feb_status.reset_at, "2026-03-31T00:00:00+00:00");
    }

    #[test]
    fn month_anchor_clamps_across_year_boundary() {
        // reset_day_of_month=31, now is early January: previous anchor is Dec 31.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "monthly".into(),
                period: UsageBudgetPeriod::Month,
                cost_usd: 100.0,
                reset_day_of_month: Some(31),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-01-10T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let status = first_item(&statuses);
        assert_eq!(status.period_start, "2025-12-31T00:00:00+00:00");
        assert_eq!(status.reset_at, "2026-01-31T00:00:00+00:00");
    }

    #[test]
    fn unanchored_day_budget_matches_legacy_behavior() {
        // No anchor fields: the window starts at local/UTC midnight, matching
        // the previous fixed-boundary semantics.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                period: UsageBudgetPeriod::Day,
                cost_usd: 10.0,
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-05-20T15:30:00+00:00".parse().unwrap(),
        )
        .unwrap();
        let status = first_item(&statuses);
        assert_eq!(status.period_start, "2026-05-20T00:00:00+00:00");
        assert_eq!(status.reset_at, "2026-05-21T00:00:00+00:00");
    }

    #[test]
    fn newly_crossed_budget_warnings_are_deduped() {
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 8.5, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                warn_at: vec![0.5, 0.8],
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };
        let now = "2026-05-18T12:00:00+00:00".parse().unwrap();

        let first = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first_item(&first).crossed_warn_at, vec![0.5, 0.8]);

        let second = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert!(second.is_empty());
    }

    #[test]
    fn over_limit_warning_refires_each_call() {
        let ledger = Ledger::open_in_memory().unwrap();
        insert_call(&ledger, "2026-05-18T03:00:00+00:00", 12.0, "message");
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                warn_at: vec![0.5, 0.8],
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };
        let now = "2026-05-18T12:00:00+00:00".parse().unwrap();

        let first = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert_eq!(first.len(), 1);
        // First call records 0.5 and 0.8 as newly crossed; over_limit doesn't
        // need to synthesize anything yet.
        assert_eq!(first_item(&first).crossed_warn_at, vec![0.5, 0.8]);

        let second = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert_eq!(second.len(), 1, "over-limit warning should re-fire");
        let second_warning = first_item(&second);
        assert_eq!(second_warning.crossed_warn_at, vec![1.0]);
        assert!(second_warning.current_cost >= second_warning.cost_limit);

        // And again — every subsequent call while over budget.
        let third = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert_eq!(third.len(), 1);
        assert_eq!(first_item(&third).crossed_warn_at, vec![1.0]);
    }

    /// 2026-05-20 is a Wednesday. A `$14`/week budget anchored to Wednesday
    /// 06:00 with a day pace is the reference scenario for pace reallocation.
    fn weekly_paced_config(cost_usd: f64) -> UsageConfig {
        config_with(weekly_paced_budget(cost_usd))
    }

    fn weekly_paced_budget(cost_usd: f64) -> UsageBudgetConfig {
        UsageBudgetConfig {
            name: "weekly".into(),
            period: UsageBudgetPeriod::Week,
            cost_usd,
            reset_day_of_week: Some(BudgetWeekday::Wednesday),
            reset_hour: Some(6),
            pace_period: Some(UsageBudgetPeriod::Day),
            ..usage_budget()
        }
    }

    fn config_with(budget: UsageBudgetConfig) -> UsageConfig {
        UsageConfig {
            timezone: "utc".into(),
            budgets: vec![budget],
            ..UsageConfig::default()
        }
    }

    fn item_at<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item at index")
    }

    fn pace_at(ledger: &Ledger, config: &UsageConfig, ts: &str) -> PaceStatus {
        let statuses = budget_statuses(ledger, config, ts.parse().unwrap()).unwrap();
        first_item(&statuses)
            .pace
            .clone()
            .expect("budget configures a pace")
    }

    #[expect(
        clippy::float_arithmetic,
        reason = "pace allowances are non-terminating ratios ($13/6); equality needs a tolerance"
    )]
    fn assert_close(actual: f64, expected: f64, what: &str) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "{what}: expected {expected}, got {actual}"
        );
    }

    #[test]
    fn pace_reallocates_remaining_budget_across_the_week() {
        // $14/week from Wednesday 06:00, paced daily. A cheap Wednesday raises
        // Thursday's target; an expensive Thursday lowers Friday's.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = weekly_paced_config(14.0);

        let wed = pace_at(&ledger, &config, "2026-05-20T12:00:00+00:00");
        assert_eq!(wed.window_start, "2026-05-20T06:00:00+00:00");
        assert_eq!(wed.window_end, "2026-05-21T06:00:00+00:00");
        assert_close(wed.periods_remaining, 7.0, "days left on Wednesday");
        assert_close(wed.allowance, 2.0, "Wednesday allowance");

        insert_call(&ledger, "2026-05-20T12:00:00+00:00", 1.0, "message");

        let thu = pace_at(&ledger, &config, "2026-05-21T12:00:00+00:00");
        assert_close(thu.periods_remaining, 6.0, "days left on Thursday");
        assert_close(thu.allowance, 13.0 / 6.0, "Thursday allowance after $1 Wed");
        assert_close(thu.current_cost, 0.0, "Thursday spend so far");

        insert_call(&ledger, "2026-05-21T18:00:00+00:00", 4.0, "message");

        let fri = pace_at(&ledger, &config, "2026-05-22T12:00:00+00:00");
        assert_close(fri.periods_remaining, 5.0, "days left on Friday");
        assert_close(fri.allowance, 1.8, "Friday allowance after $5 spent");
        assert!(!fri.over_limit, "Friday has spent nothing yet");
    }

    #[test]
    fn pace_allowance_is_frozen_within_its_sub_window() {
        // Spending inside a sub-window must not shrink that window's own
        // allowance — otherwise spend eats its own target and the remaining
        // figure is understated.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = weekly_paced_config(14.0);
        insert_call(&ledger, "2026-05-20T12:00:00+00:00", 1.0, "message");

        let before = pace_at(&ledger, &config, "2026-05-21T08:00:00+00:00");
        insert_call(&ledger, "2026-05-21T09:00:00+00:00", 0.5, "message");
        let after = pace_at(&ledger, &config, "2026-05-21T10:00:00+00:00");

        assert_close(after.allowance, before.allowance, "allowance held steady");
        assert_close(after.current_cost, 0.5, "sub-window spend");
        assert_close(after.remaining, (13.0 / 6.0) - 0.5, "remaining today");
    }

    #[test]
    fn pace_window_follows_the_budget_reset_hour() {
        // The pace inherits the budget's anchor: days run 06:00 -> 06:00, so
        // 03:00 Thursday still belongs to Wednesday's pace window.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = weekly_paced_config(14.0);

        let late = pace_at(&ledger, &config, "2026-05-21T03:00:00+00:00");
        assert_eq!(late.window_start, "2026-05-20T06:00:00+00:00");
        assert_eq!(late.window_end, "2026-05-21T06:00:00+00:00");
    }

    #[test]
    fn pace_allowance_floors_at_zero_when_the_budget_is_spent() {
        // Blowing the whole week early leaves nothing to pace with; the
        // allowance must clamp rather than go negative.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = weekly_paced_config(14.0);
        insert_call(&ledger, "2026-05-20T12:00:00+00:00", 20.0, "message");

        let thu = pace_at(&ledger, &config, "2026-05-21T12:00:00+00:00");
        assert_close(thu.allowance, 0.0, "nothing left to allocate");
        assert!(thu.over_limit, "a zero allowance is over limit");
        // An exhausted allowance reports 100%, not the 0% a literal $0/$0
        // ratio would give — `status` and `percent_used` must agree.
        assert_close(thu.percent_used, 1.0, "exhausted allowance reads as full");
        assert_eq!(thu.status, "over_limit");
    }

    #[test]
    fn pace_steps_hold_the_wall_clock_hour_across_a_dst_week() {
        // The sub-window arithmetic runs in naive space precisely so a
        // transition inside the budget period can't drag the boundary off the
        // budget's own reset hour. 2026-03-08 is US spring-forward; a
        // Wednesday 06:00 weekly window straddles it. Stepping day-by-day must
        // land on 06:00 every time, including the day that loses an hour.
        //
        // This covers the arithmetic in isolation; `tests/pace_dst.rs` drives
        // the same week through the zone-aware path under a real `TZ`.
        let start_naive: NaiveDateTime = "2026-03-04T06:00:00".parse().unwrap();
        let end_naive: NaiveDateTime = "2026-03-11T06:00:00".parse().unwrap();
        let window = PeriodWindow {
            start: Utc.from_utc_datetime(&start_naive),
            end: Utc.from_utc_datetime(&end_naive),
            start_naive,
            end_naive,
            timezone: "local".into(),
        };

        for (day, expected_start, expected_days_left) in [
            ("2026-03-07T12:00:00", "2026-03-07T06:00:00", 4.0),
            // Spring-forward day: 02:00 -> 03:00 locally.
            ("2026-03-08T12:00:00", "2026-03-08T06:00:00", 3.0),
            ("2026-03-09T12:00:00", "2026-03-09T06:00:00", 2.0),
        ] {
            let bounds =
                pace_bounds_naive(&window, day.parse().unwrap(), Duration::days(1)).unwrap();
            assert_eq!(
                bounds.start.to_string(),
                expected_start.replace('T', " "),
                "sub-window on {day} stays anchored to 06:00"
            );
            assert_eq!(bounds.start.hour(), 6, "boundary hour never drifts");
            assert_eq!(bounds.end.hour(), 6, "and neither does the close");
            assert_close(
                bounds.periods_remaining,
                expected_days_left,
                &format!("days left on {day}"),
            );
        }
    }

    #[test]
    fn pace_warn_at_falls_back_to_the_budget_warn_at() {
        // Documented default: a budget that sets no `pace_warn_at` warns its
        // pace on the same fractions as its cap.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = config_with(UsageBudgetConfig {
            warn_at: vec![0.6, 0.9],
            pace_warn_at: None,
            ..weekly_paced_budget(14.0)
        });
        // Wednesday's allowance is $2.00; $1.30 is 65% of it.
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 1.3, "message");

        let wed = pace_at(&ledger, &config, "2026-05-20T12:00:00+00:00");
        assert_eq!(
            wed.warning_thresholds,
            vec![0.6, 0.9],
            "the pace inherits the budget's thresholds"
        );
        assert_eq!(wed.crossed_warn_at, vec![0.6]);
        assert_eq!(wed.status, "warning");
    }

    #[test]
    fn pace_pause_background_stops_only_background_calls() {
        // The third pace action: an overspent sub-window sheds heartbeats and
        // dreaming while the user's own messages keep going.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = config_with(UsageBudgetConfig {
            limit: UsageBudgetAction::Warn,
            pace_action: Some(UsageBudgetAction::PauseBackground),
            allow_compaction_over_budget: Some(false),
            ..weekly_paced_budget(14.0)
        });
        // $3 against Wednesday's $2 allowance, well under the $14 week.
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 3.0, "message");
        let now = "2026-05-20T12:00:00+00:00".parse().unwrap();

        let call_of = |call_type| BudgetCallContext {
            provider: "openrouter",
            api_key_name: Some("default"),
            model: "model",
            call_type,
            character: "Alice",
        };

        let err = enforce_budget_for_call(&ledger, &config, call_of(CallType::Heartbeat), now)
            .expect_err("background calls stop on an overspent pace");
        assert_eq!(err.scope, BudgetScope::Pace);
        assert_eq!(err.action, UsageBudgetAction::PauseBackground);

        assert!(
            enforce_budget_for_call(&ledger, &config, call_of(CallType::Message), now).is_ok(),
            "foreground messages are untouched"
        );
    }

    #[test]
    fn month_budget_paced_by_week_divides_fractionally() {
        // May has 31 days: 4.43 weeks, not 4. The divisor is the real ratio.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "monthly".into(),
                period: UsageBudgetPeriod::Month,
                cost_usd: 100.0,
                pace_period: Some(UsageBudgetPeriod::Week),
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let first = pace_at(&ledger, &config, "2026-05-01T12:00:00+00:00");
        assert_close(first.periods_remaining, 31.0 / 7.0, "weeks in May");
        assert_close(first.allowance, 100.0 / (31.0 / 7.0), "first week's share");

        // The trailing stub (May 29 -> Jun 1) is under a week. Its divisor
        // floors at 1 so the allowance is the whole remainder, not an inflated
        // remainder/0.43.
        let stub = pace_at(&ledger, &config, "2026-05-30T12:00:00+00:00");
        assert_eq!(stub.window_start, "2026-05-29T00:00:00+00:00");
        assert_eq!(stub.window_end, "2026-06-01T00:00:00+00:00");
        assert_close(stub.periods_remaining, 3.0 / 7.0, "partial trailing week");
        assert_close(stub.allowance, 100.0, "stub gets the whole remainder");
    }

    #[test]
    fn pace_can_block_while_the_budget_cap_still_allows() {
        // $3 on a $2 Wednesday pace: nowhere near the $14 weekly cap, but the
        // pace action is `block`, so the call stops.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = config_with(UsageBudgetConfig {
            limit: UsageBudgetAction::Warn,
            pace_action: Some(UsageBudgetAction::Block),
            ..weekly_paced_budget(14.0)
        });
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 3.0, "message");

        let err = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "openrouter",
                api_key_name: Some("default"),
                model: "model",
                call_type: CallType::Message,
                character: "Alice",
            },
            "2026-05-20T12:00:00+00:00".parse().unwrap(),
        )
        .expect_err("pace block stops the call");
        assert_eq!(err.scope, BudgetScope::Pace);
        assert_close(err.cost_limit, 2.0, "blocked against the pace allowance");
    }

    #[test]
    fn a_block_pace_under_a_warn_cap_stops_calls_once_the_budget_is_spent() {
        // The sharp edge documented in CONFIGURATION.md: these two settings
        // combine into something stronger than either alone. A spent budget
        // leaves a $0 allowance that every later sub-window is instantly over,
        // so an advisory cap still ends up hard-blocking through its pace.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = config_with(UsageBudgetConfig {
            limit: UsageBudgetAction::Warn,
            pace_action: Some(UsageBudgetAction::Block),
            ..weekly_paced_budget(14.0)
        });
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 20.0, "message");

        let err = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "openrouter",
                api_key_name: Some("default"),
                model: "model",
                call_type: CallType::Message,
                character: "Alice",
            },
            // A fresh sub-window that has spent nothing of its own.
            "2026-05-22T12:00:00+00:00".parse().unwrap(),
        )
        .expect_err("a zero allowance blocks even an unspent sub-window");
        assert_eq!(
            err.scope,
            BudgetScope::Pace,
            "the advisory cap defers, the pace stops the call"
        );
        assert_close(err.cost_limit, 0.0, "nothing left to allocate");
    }

    #[test]
    fn pace_warn_does_not_block() {
        // The default pace action is advisory; only the budget cap stops calls.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = weekly_paced_config(14.0);
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 3.0, "message");

        let result = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "openrouter",
                api_key_name: Some("default"),
                model: "model",
                call_type: CallType::Message,
                character: "Alice",
            },
            "2026-05-20T12:00:00+00:00".parse().unwrap(),
        );
        assert!(result.is_ok(), "an overspent pace warns but does not block");
    }

    #[test]
    fn budget_cap_block_takes_precedence_over_pace() {
        let ledger = Ledger::open_in_memory().unwrap();
        let config = config_with(UsageBudgetConfig {
            limit: UsageBudgetAction::Block,
            pace_action: Some(UsageBudgetAction::Block),
            ..weekly_paced_budget(14.0)
        });
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 15.0, "message");

        let err = enforce_budget_for_call(
            &ledger,
            &config,
            BudgetCallContext {
                provider: "openrouter",
                api_key_name: Some("default"),
                model: "model",
                call_type: CallType::Message,
                character: "Alice",
            },
            "2026-05-20T12:00:00+00:00".parse().unwrap(),
        )
        .expect_err("both limits are over");
        assert_eq!(
            err.scope,
            BudgetScope::Budget,
            "the harder stop is the one reported"
        );
    }

    #[test]
    fn pace_and_budget_warnings_dedup_independently() {
        // On the budget's own reset day the week window and the first day-pace
        // window open at the same instant, so a shared dedup key would let one
        // scope's threshold swallow the other's.
        let ledger = Ledger::open_in_memory().unwrap();
        let config = config_with(UsageBudgetConfig {
            warn_at: vec![0.5],
            pace_warn_at: Some(vec![0.5]),
            ..weekly_paced_budget(14.0)
        });
        insert_call(&ledger, "2026-05-20T08:00:00+00:00", 7.1, "message");
        let now = "2026-05-20T12:00:00+00:00".parse().unwrap();

        let first = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert_eq!(first.len(), 2, "both scopes warn on the same window start");
        let cap_warning = item_at(&first, 0);
        let pace_warning = item_at(&first, 1);
        assert_eq!(cap_warning.scope, BudgetScope::Budget);
        assert_eq!(pace_warning.scope, BudgetScope::Pace);
        assert_eq!(cap_warning.period_start, pace_warning.period_start);

        // The budget's 0.5 is one-shot; the pace is over limit so it re-fires,
        // matching the existing over-limit behavior.
        let second = newly_crossed_budget_warnings(&ledger, &config, now).unwrap();
        assert_eq!(second.len(), 1, "only the over-limit pace re-fires");
        assert_eq!(first_item(&second).scope, BudgetScope::Pace);
        assert_eq!(first_item(&second).crossed_warn_at, vec![1.0]);
    }

    #[test]
    fn budget_without_pace_reports_no_pace_status() {
        let ledger = Ledger::open_in_memory().unwrap();
        let config = UsageConfig {
            timezone: "utc".into(),
            budgets: vec![UsageBudgetConfig {
                name: "daily".into(),
                cost_usd: 10.0,
                ..usage_budget()
            }],
            ..UsageConfig::default()
        };

        let statuses = budget_statuses(
            &ledger,
            &config,
            "2026-05-18T12:00:00+00:00".parse().unwrap(),
        )
        .unwrap();
        assert!(first_item(&statuses).pace.is_none());
        let json = serde_json::to_value(first_item(&statuses)).unwrap();
        assert!(
            json.get("pace").is_none(),
            "an unpaced budget stays wire-identical"
        );
    }

    fn usage_budget() -> UsageBudgetConfig {
        UsageBudgetConfig {
            name: String::new(),
            period: UsageBudgetPeriod::Day,
            cost_usd: 1.0,
            warn_at: vec![0.8, 1.0],
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
}
