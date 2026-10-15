use std::io::Write;

use serde_json::Value;

use super::vocab::{Align, Meter, Rows, Table, Tone, blank, count, empty, money, note, section};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum View {
    Summary,
    By,
    Budgets,
    Cache,
    Anomalies,
    Limits,
}

impl View {
    fn title(self) -> &'static str {
        match self {
            Self::Summary => "usage",
            Self::By => "usage by",
            Self::Budgets => "budgets",
            Self::Cache => "cache",
            Self::Anomalies => "cache anomalies",
            Self::Limits => "provider limits",
        }
    }
}

fn dimension_of(data: &Value) -> String {
    text(data, "dimension").replace('_', " ")
}

fn text<'value>(row: &'value Value, key: &str) -> &'value str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(row: &Value, key: &str) -> u64 {
    row.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn decimal(row: &Value, key: &str) -> f64 {
    row.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn rows_of<'data>(data: &'data Value, key: &str) -> &'data [Value] {
    data.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn period_of(data: &Value) -> Option<String> {
    let period = data.get("period").and_then(Value::as_str)?;
    if period != "budget" {
        return Some(period.to_owned());
    }
    let since = data.get("period_since").and_then(Value::as_str)?;
    Some(format!("since {}", short_when(since)))
}

fn spend_label(row: &Value, view: View) -> String {
    match view {
        View::By => text(row, "group").to_owned(),
        View::Summary | View::Budgets | View::Cache | View::Anomalies | View::Limits => {
            format!("{} {}", text(row, "provider"), text(row, "model"))
        }
    }
}

#[expect(
    clippy::float_arithmetic,
    reason = "the total is the sum of the per-row costs the ledger reported"
)]
fn write_spend_table<W: Write>(out: &mut W, data: &Value, view: View, label: &str) -> bool {
    let summary = rows_of(data, "summary");
    if summary.is_empty() {
        empty(out, "nothing recorded in this period");
        return false;
    }
    let mut table = Table::new(
        &[label, "calls", "in", "out", "cache r", "cache w", "cost"],
        &[
            Align::Left,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
        ],
    );
    let mut total = 0.0_f64;
    let mut calls = 0_u64;
    let mut input = 0_u64;
    let mut output = 0_u64;
    let mut cache_read = 0_u64;
    let mut cache_write = 0_u64;
    for row in summary {
        let cost = decimal(row, "total_cost");
        let row_calls = number(row, "call_count");
        let row_input = number(row, "total_input");
        let row_output = number(row, "total_output");
        let row_cache_read = number(row, "total_cache_read");
        let row_cache_write = number(row, "total_cache_write");
        total += cost;
        calls = calls.saturating_add(row_calls);
        input = input.saturating_add(row_input);
        output = output.saturating_add(row_output);
        cache_read = cache_read.saturating_add(row_cache_read);
        cache_write = cache_write.saturating_add(row_cache_write);
        table.row(&[
            spend_label(row, view),
            count(row_calls),
            count(row_input),
            count(row_output),
            count(row_cache_read),
            count(row_cache_write),
            money(cost),
        ]);
    }
    table.total(&[
        "total".to_owned(),
        count(calls),
        count(input),
        count(output),
        count(cache_read),
        count(cache_write),
        money(total),
    ]);
    table.write(out);
    true
}

fn add_cache_rows(rows: &mut Rows, data: &Value) {
    let health = rows_of(data, "cache_health");
    if !health.is_empty() {
        let states: Vec<String> = health
            .iter()
            .map(|row| format!("{} {}", text(row, "character"), text(row, "state")))
            .collect();
        let cold = health.iter().any(|row| text(row, "state") == "cold");
        let tone = if cold { Tone::Warn } else { Tone::Good };
        rows.add_toned("cache", &states.join(" \u{00b7} "), tone);
    }
    let anomalies = number(data, "anomaly_count_7d");
    if anomalies > 0 {
        rows.add_toned(
            "anomalies",
            &format!("{anomalies} in the last 7d"),
            Tone::Warn,
        );
    }
}

pub(crate) fn write_summary<W: Write>(out: &mut W, data: &Value) {
    section(out, View::Summary.title(), period_of(data).as_deref());
    let _spent = write_spend_table(out, data, View::Summary, "model");
    let budgets = rows_of(data, "budgets");
    if !budgets.is_empty() {
        blank(out);
        for budget in budgets {
            write_budget_meters(out, budget);
        }
    }

    if let Some(subscription) = data
        .get("nanogpt_subscription")
        .filter(|value| value.is_object())
    {
        blank(out);
        write_nanogpt_subscription(out, subscription);
    }

    if let Some(plan) = claude_plan_of(data) {
        blank(out);
        write_claude_plan(out, plan);
    }

    let mut headline = Rows::new();
    add_cache_rows(&mut headline, data);
    if !headline.is_empty() {
        blank(out);
        headline.write(out);
    }
}

fn write_nanogpt_subscription<W: Write>(out: &mut W, subscription: &Value) {
    let state = text(subscription, "state");
    let tone = match state {
        "active" => Tone::Good,
        "grace" => Tone::Warn,
        _ => Tone::Muted,
    };
    let weekly = subscription.get("weeklyInputTokens");
    let reset = weekly.map_or("", |value| text(value, "resetAt"));
    let value = if reset.is_empty() {
        state.to_owned()
    } else {
        format!("{state} · resets {}", short_when(reset))
    };
    let mut header = Rows::new();
    header.add_toned("NanoGPT subscription", &value, tone);
    header.write(out);
    if let Some(row) = weekly {
        let mut rows = Rows::new();
        quota(&mut rows, row, "weekly input", "remaining", "limit");
        rows.write(out);
    }
}

fn claude_plan_of(data: &Value) -> Option<&Value> {
    data.get("claude_plan_limits")
        .filter(|value| value.is_object())
}

fn plan_window_label(window: &str) -> &str {
    match window {
        "five_hour" => "5-hour",
        "seven_day" => "weekly",
        other => other,
    }
}

#[expect(
    clippy::float_arithmetic,
    reason = "a plan limit is a fraction shown as a whole percentage"
)]
fn whole_percent(fraction: f64) -> f64 {
    (fraction * 100.0).round()
}

fn write_claude_plan<W: Write>(out: &mut W, plan: &Value) {
    let subscription = text(plan, "subscription_type");
    let mut header = Rows::new();
    header.add(
        "Claude plan",
        if subscription.is_empty() {
            "subscription"
        } else {
            subscription
        },
    );
    header.write(out);

    let windows = rows_of(plan, "windows");
    let width = windows
        .iter()
        .map(|window| plan_window_label(text(window, "window")).chars().count())
        .max()
        .unwrap_or(0);
    for window in windows {
        let label = plan_window_label(text(window, "window"));
        let reset = text(window, "resets_at");
        let detail = if reset.is_empty() {
            String::new()
        } else {
            format!("resets {}", short_when(reset))
        };
        Meter::new(decimal(window, "percent_used"), 1.0).write_row(out, label, width, &detail);
    }
    for window in windows.iter().filter(|window| {
        window
            .get("over_limit")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }) {
        note(
            out,
            &format!(
                "{} is past its {}% limit and {}",
                plan_window_label(text(window, "window")),
                whole_percent(decimal(window, "limit_at")),
                plan_action_phrase(text(window, "action"))
            ),
        );
    }
}

fn plan_action_phrase(action: &str) -> String {
    match action {
        "block" => "blocks Claude calls".to_owned(),
        "warn" => "only warns".to_owned(),
        "pause_heartbeat" => "pauses the heartbeat".to_owned(),
        "pause_background" => "pauses background work".to_owned(),
        other => other.replace('_', " "),
    }
}

pub(crate) fn write_breakdown<W: Write>(out: &mut W, data: &Value) {
    section(
        out,
        &format!("usage by {}", dimension_of(data)),
        period_of(data).as_deref(),
    );
    let _ignored = write_spend_table(out, data, View::By, &dimension_of(data));
}

fn acting_now(scope: &Value) -> &str {
    let effective = text(scope, "effective_action");
    if effective.is_empty() {
        text(scope, "action")
    } else {
        effective
    }
}

fn action_phrase(action: &str) -> String {
    match action {
        "block" => "blocks at limit".to_owned(),
        "warn" => "warns at limit".to_owned(),
        "pause_heartbeat" => "pauses the heartbeat at limit".to_owned(),
        "pause_background" => "pauses background work at limit".to_owned(),
        other => format!("{} at limit", other.replace('_', " ")),
    }
}

fn write_meter_row<W: Write>(
    out: &mut W,
    label: &str,
    width: usize,
    meter: Meter,
    current: f64,
    limit: f64,
) {
    meter.write_row(
        out,
        label,
        width,
        &format!("{} / {}", money(current), money(limit)),
    );
}

fn write_budget_meters<W: Write>(out: &mut W, budget: &Value) {
    let period = text(budget, "period");
    let pace_period = budget.get("pace").map_or("", |pace| text(pace, "period"));
    let width = period.chars().count().max(pace_period.chars().count());

    let current = decimal(budget, "current_cost");
    let limit = decimal(budget, "cost_limit");
    write_meter_row(
        out,
        period,
        width,
        Meter::new(current, limit),
        current,
        limit,
    );

    if let Some(pace) = budget.get("pace") {
        let spent = decimal(pace, "current_cost");
        let allowance = decimal(pace, "allowance");
        write_meter_row(
            out,
            pace_period,
            width,
            Meter::new(spent, allowance),
            spent,
            allowance,
        );
    }
}

pub(crate) fn write_budgets<W: Write>(out: &mut W, data: &Value) {
    let budgets = rows_of(data, "budgets");
    section(out, View::Budgets.title(), period_of(data).as_deref());
    let plan = claude_plan_of(data);
    if let Some(claude) = plan {
        write_claude_plan(out, claude);
        blank(out);
    }
    if budgets.is_empty() {
        if plan.is_none() {
            empty(out, "no budgets configured");
        }
        return;
    }
    for budget in budgets {
        let reset = text(budget, "reset_at");
        let summary = if reset.is_empty() {
            action_phrase(acting_now(budget))
        } else {
            format!(
                "{} \u{00b7} resets {}",
                action_phrase(acting_now(budget)),
                short_when(reset)
            )
        };
        let mut header = Rows::new();
        header.add(text(budget, "name"), &summary);
        header.write(out);

        write_budget_meters(out, budget);

        if let Some(pace) = budget.get("pace") {
            let base = decimal(pace, "base_allowance");
            let rollover = decimal(pace, "rollover");
            let debt = decimal(pace, "debt_adjustment");
            note(
                out,
                &format!(
                    "allowance {} + {} rollover - {} debt",
                    money(base),
                    money(rollover),
                    money(debt.abs())
                ),
            );
        }
        blank(out);
    }
}

pub(crate) fn write_cache<W: Write>(out: &mut W, data: &Value) {
    section(out, View::Cache.title(), period_of(data).as_deref());

    let coverage = rows_of(data, "cache_coverage");
    if coverage.is_empty() {
        empty(out, "no calls in this period");
    } else {
        let mut table = Table::new(
            &["served", "why", "calls", "read", "write"],
            &[
                Align::Left,
                Align::Left,
                Align::Right,
                Align::Right,
                Align::Right,
            ],
        );
        for row in coverage {
            table.row(&[
                text(row, "state").to_owned(),
                text(row, "reason").replace('_', " "),
                count(number(row, "calls")),
                count(number(row, "cache_read_tokens")),
                count(number(row, "cache_write_tokens")),
            ]);
        }
        table.write(out);
    }

    let health = rows_of(data, "cache_health");
    if !health.is_empty() {
        blank(out);
        note(out, "keepalive, per character");
        let mut rows = Rows::new();
        for row in health {
            let state = text(row, "state");
            let tone = if state == "cold" {
                Tone::Warn
            } else {
                Tone::Good
            };
            let streak = number(row, "streak");
            let value = if streak > 0 {
                format!("{state} \u{00b7} {streak} in a row")
            } else {
                state.to_owned()
            };
            rows.add_toned(text(row, "character"), &value, tone);
        }
        rows.write(out);
    }

    let anomalies = number(data, "anomaly_count_7d");
    if anomalies > 0 {
        blank(out);
        note(out, &format!("{anomalies} anomalies in the last 7d"));
    }
}

fn short_when(ts: &str) -> String {
    super::parse_timestamp(ts)
        .map_or_else(|| ts.to_owned(), |dt| dt.format("%a %-I:%M %p").to_string())
}

pub(crate) fn write_anomalies<W: Write>(out: &mut W, data: &Value) {
    section(out, View::Anomalies.title(), period_of(data).as_deref());
    let anomalies = rows_of(data, "anomalies");
    if anomalies.is_empty() {
        empty(out, "no anomalies in this period");
        return;
    }
    let mut table = Table::new(
        &["when", "character", "model", "anomaly", "read", "write"],
        &[
            Align::Left,
            Align::Left,
            Align::Left,
            Align::Left,
            Align::Right,
            Align::Right,
        ],
    );
    for row in anomalies {
        table.row_toned(
            &[
                short_when(text(row, "ts")),
                text(row, "character").to_owned(),
                text(row, "model").to_owned(),
                text(row, "anomaly").replace('_', " "),
                count(number(row, "cache_read_tokens")),
                count(number(row, "cache_write_tokens")),
            ],
            Tone::Plain,
        );
    }
    table.write(out);
}

fn quota(rows: &mut Rows, row: &Value, label: &str, remaining: &str, limit: &str) {
    let left = number(row, remaining);
    let total = number(row, limit);
    if total == 0 {
        return;
    }
    let meter = Meter::new(
        f64::from(u32::try_from(total.saturating_sub(left)).unwrap_or(u32::MAX)),
        f64::from(u32::try_from(total).unwrap_or(u32::MAX)),
    );
    rows.add_toned(
        label,
        &format!("{} left of {}", count(left), count(total)),
        meter.tone(),
    );
}

pub(crate) fn write_limits<W: Write>(out: &mut W, data: &Value) {
    section(out, View::Limits.title(), None);
    let limits = rows_of(data, "rate_limits");
    if limits.is_empty() {
        empty(out, "no provider has reported a rate limit yet");
        return;
    }
    for row in limits {
        let mut header = Rows::new();
        header.add(
            text(row, "host"),
            &format!("resets {}", short_when(text(row, "resets_at"))),
        );
        header.write(out);
        let mut rows = Rows::new();
        quota(
            &mut rows,
            row,
            "requests",
            "requests_remaining",
            "requests_limit",
        );
        quota(
            &mut rows,
            row,
            "input",
            "input_tokens_remaining",
            "input_tokens_limit",
        );
        quota(
            &mut rows,
            row,
            "output",
            "output_tokens_remaining",
            "output_tokens_limit",
        );
        rows.write(out);
        blank(out);
    }
}

pub(crate) fn print(data: &Value, view: View) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    match data.get("mode").and_then(Value::as_str).unwrap_or("") {
        "csv" | "tsv" => {
            if let Some(body) = data.get("data").and_then(Value::as_str) {
                let _ignored = write!(out, "{body}");
            }
        }
        _ => match view {
            View::Summary => write_summary(&mut out, data),
            View::By => write_breakdown(&mut out, data),
            View::Budgets => write_budgets(&mut out, data),
            View::Cache => write_cache(&mut out, data),
            View::Anomalies => write_anomalies(&mut out, data),
            View::Limits => write_limits(&mut out, data),
        },
    }
}
