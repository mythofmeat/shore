use std::io::{self, Write};

use serde_json::Value;

use super::vocab::{
    Align, Meter, Rows, Table, Tone, blank, count, empty, money, note, section,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum View {
    Summary,
    CallType,
    Kind,
    ApiKey,
    Budgets,
    Cache,
    Anomalies,
    Limits,
}

impl View {
    fn title(self) -> &'static str {
        match self {
            Self::Summary => "usage",
            Self::CallType => "usage by call type",
            Self::Kind => "usage by kind",
            Self::ApiKey => "usage by api key",
            Self::Budgets => "budgets",
            Self::Cache => "cache",
            Self::Anomalies => "cache anomalies",
            Self::Limits => "provider limits",
        }
    }

    fn label_header(self) -> &'static str {
        match self {
            Self::CallType => "call type",
            Self::Kind => "kind",
            Self::ApiKey => "api key",
            Self::Summary
            | Self::Budgets
            | Self::Cache
            | Self::Anomalies
            | Self::Limits => "model",
        }
    }
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
    Some(period.to_owned())
}

fn spend_label(row: &Value, view: View) -> String {
    match view {
        View::CallType => text(row, "call_type").to_owned(),
        View::Kind => text(row, "usage_kind").to_owned(),
        View::ApiKey => format!("{} {}", text(row, "provider"), text(row, "api_key_name")),
        View::Summary | View::Budgets | View::Cache | View::Anomalies | View::Limits => {
            format!("{} {}", text(row, "provider"), text(row, "model"))
        }
    }
}

#[expect(
    clippy::float_arithmetic,
    reason = "the total is the sum of the per-row costs the ledger reported"
)]
fn write_spend_table<W: Write>(out: &mut W, data: &Value, view: View) -> bool {
    let summary = rows_of(data, "summary");
    if summary.is_empty() {
        empty(out, "nothing recorded in this period");
        return false;
    }
    let mut table = Table::new(
        &[
            view.label_header(),
            "calls",
            "in",
            "out",
            "cache r",
            "cache w",
            "cost",
        ],
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
    for row in summary {
        let cost = decimal(row, "total_cost");
        total += cost;
        table.row(&[
            spend_label(row, view),
            count(number(row, "call_count")),
            count(number(row, "total_input")),
            count(number(row, "total_output")),
            count(number(row, "total_cache_read")),
            count(number(row, "total_cache_write")),
            money(cost),
        ]);
    }
    table.total(&[
        "total".to_owned(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
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
    let any = write_spend_table(out, data, View::Summary);
    if !any {
        return;
    }
    let budgets = rows_of(data, "budgets");
    if !budgets.is_empty() {
        blank(out);
        for budget in budgets {
            write_budget_meters(out, budget);
        }
    }

    let mut headline = Rows::new();
    add_cache_rows(&mut headline, data);
    if !headline.is_empty() {
        blank(out);
        headline.write(out);
    }
}

pub(crate) fn write_breakdown<W: Write>(out: &mut W, data: &Value, view: View) {
    section(out, view.title(), period_of(data).as_deref());
    let _ignored = write_spend_table(out, data, view);
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
    write_meter_row(out, period, width, Meter::new(current, limit), current, limit);

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

#[expect(
    clippy::float_arithmetic,
    reason = "the pace allowance is stated as a base plus rollover minus debt"
)]
pub(crate) fn write_budgets<W: Write>(out: &mut W, data: &Value) {
    let budgets = rows_of(data, "budgets");
    section(out, View::Budgets.title(), period_of(data).as_deref());
    if budgets.is_empty() {
        empty(out, "no budgets configured");
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
        let mut table = Table::new(&["served", "why", "calls", "read", "write"], &[
            Align::Left,
            Align::Left,
            Align::Right,
            Align::Right,
            Align::Right,
        ]);
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
            let tone = if state == "cold" { Tone::Warn } else { Tone::Good };
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
    super::parse_timestamp(ts).map_or_else(
        || ts.to_owned(),
        |dt| dt.format("%a %-I:%M %p").to_string(),
    )
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

fn quota<W: Write>(rows: &mut Rows, row: &Value, label: &str, remaining: &str, limit: &str) {
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
        header.add(text(row, "host"), &format!(
            "resets {}",
            short_when(text(row, "resets_at"))
        ));
        header.write(out);
        let mut rows = Rows::new();
        quota::<W>(
            &mut rows,
            row,
            "requests",
            "requests_remaining",
            "requests_limit",
        );
        quota::<W>(
            &mut rows,
            row,
            "input",
            "input_tokens_remaining",
            "input_tokens_limit",
        );
        quota::<W>(
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

pub(crate) fn write_recalculate<W: Write>(out: &mut W, data: &Value) {
    section(out, "recalculate", None);
    let total = number(data, "total");
    if total == 0 {
        note(out, "every row already had a cost");
        return;
    }
    let updated = number(data, "updated");
    let missing = total.saturating_sub(updated);
    let mut rows = Rows::new();
    rows.add("rows updated", &format!("{updated} of {total}"));
    if missing > 0 {
        _ = rows.add_toned(
            "still unpriced",
            &missing.to_string(),
            Tone::Warn,
        );
    }
    rows.write(out);
    let failures = rows_of(data, "failures");
    if failures.is_empty() {
        return;
    }
    blank(out);
    let mut table = Table::new(&["model", "reason"], &[Align::Left, Align::Left]);
    for failure in failures {
        _ = table.row(&[
            text(failure, "model").to_owned(),
            text(failure, "reason").to_owned(),
        ]);
    }
    table.write(out);
}

pub(crate) fn print(data: &Value, view: View) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    match data.get("mode").and_then(Value::as_str).unwrap_or("") {
        "csv" | "tsv" => {
            if let Some(body) = data.get("data").and_then(Value::as_str) {
                let _ignored = write!(out, "{body}");
            }
        }
        "refresh_pricing" => {
            section(&mut out, "refresh pricing", None);
            note(&mut out, "cleared; the next call re-fetches prices");
        }
        "recalculate" => write_recalculate(&mut out, data),
        _ => match view {
            View::Summary => write_summary(&mut out, data),
            View::CallType | View::Kind | View::ApiKey => write_breakdown(&mut out, data, view),
            View::Budgets => write_budgets(&mut out, data),
            View::Cache => write_cache(&mut out, data),
            View::Anomalies => write_anomalies(&mut out, data),
            View::Limits => write_limits(&mut out, data),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;
    use serde_json::json;

    fn render<F: FnOnce(&mut Vec<u8>)>(f: F) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        f(&mut buf);
        String::from_utf8(buf).unwrap_or_default()
    }

    fn summary_payload() -> Value {
        json!({
            "mode": "summary",
            "period": "today",
            "summary": [
                {"provider": "anthropic", "model": "claude-opus-5", "call_count": 35,
                 "total_input": 8007, "total_output": 34100, "total_cache_read": 1400000,
                 "total_cache_write": 113300, "total_cost": 2.75},
                {"provider": "opencode-go", "model": "glm-5.2", "call_count": 17,
                 "total_input": 279600, "total_output": 12400, "total_cache_read": 425000,
                 "total_cache_write": 0, "total_cost": 0.0}
            ],
            "cache_health": [{"character": "qifei", "state": "cold", "streak": 3}],
            "anomaly_count_7d": 6,
            "budgets": [{
                "name": "brainwife", "period": "week", "current_cost": 5.16, "cost_limit": 15.0,
                "effective_action": "block",
                "pace": {"period": "day", "current_cost": 3.50, "allowance": 2.63,
                         "base_allowance": 2.14, "rollover": 0.49, "debt_adjustment": 0}
            }]
        })
    }

    #[test]
    fn the_summary_leads_with_spend() {
        let out = render(|buf| write_summary(buf, &summary_payload()));
        assert!(out.starts_with("\u{2500}\u{2500} usage \u{00b7} today "), "{out}");
        assert!(out.contains("$2.75"), "spend must be visible: {out}");
    }

    #[test]
    fn the_summary_says_the_budget_is_blown_without_being_asked() {
        let out = render(|buf| write_summary(buf, &summary_payload()));
        assert!(
            out.contains("133%"),
            "an over-limit pace must surface in the summary: {out}"
        );
        assert!(out.contains("34%"), "{out}");
    }

    #[test]
    fn the_summary_draws_the_same_meters_the_budgets_view_does() {
        let summary = render(|buf| write_summary(buf, &summary_payload()));
        let budgets = render(|buf| write_budgets(buf, &summary_payload()));
        for line in ["week", "day"] {
            let meter_in_budgets = budgets
                .lines()
                .find(|l| l.trim_start().starts_with(line))
                .expect("the budgets view draws a meter per period");
            assert!(
                summary.contains(meter_in_budgets.trim()),
                "`{line}` must read the same in both views\n  summary: {summary}\n  budgets: {budgets}"
            );
        }
    }

    #[test]
    fn the_summary_reports_a_cold_cache_and_pending_anomalies() {
        let out = render(|buf| write_summary(buf, &summary_payload()));
        assert!(out.contains("qifei cold"), "{out}");
        assert!(out.contains("6 in the last 7d"), "{out}");
    }

    #[test]
    fn a_zero_cost_row_still_shows_its_token_counts() {
        let out = render(|buf| write_summary(buf, &summary_payload()));
        assert!(
            out.contains("279.6K"),
            "a free model still spent tokens worth seeing: {out}"
        );
    }

    #[test]
    fn an_empty_period_says_so_instead_of_printing_an_empty_table() {
        let payload = json!({"mode": "summary", "period": "today", "summary": []});
        let out = render(|buf| write_summary(buf, &payload));
        assert!(out.contains("(nothing recorded in this period)"), "{out}");
        assert!(
            !out.contains("CALLS"),
            "an empty period must not print a bare header row: {out}"
        );
    }

    #[test]
    fn a_breakdown_names_the_dimension_in_both_title_and_column() {
        let payload = json!({
            "mode": "summary_by_call_type",
            "period": "today",
            "summary": [{"call_type": "compaction", "call_count": 17, "total_input": 30600,
                         "total_output": 22400, "total_cache_read": 837000,
                         "total_cache_write": 25500, "total_cost": 0.82}]
        });
        let out = render(|buf| write_breakdown(buf, &payload, View::CallType));
        assert!(out.contains("usage by call type"), "{out}");
        assert!(out.contains("CALL TYPE"), "{out}");
        assert!(out.contains("compaction"), "{out}");
    }

    #[test]
    fn budgets_render_the_pace_basis_rather_than_a_bare_number() {
        let out = render(|buf| write_budgets(buf, &summary_payload()));
        assert!(out.contains("blocks at limit"), "{out}");
        assert!(
            out.contains("allowance $2.14 + $0.49 rollover - $0.00 debt"),
            "the pace allowance must state where it came from: {out}"
        );
    }

    #[test]
    fn an_over_limit_budget_is_visibly_different_from_a_full_one() {
        let over = render(|buf| write_budgets(buf, &summary_payload()));
        let exact = json!({
            "period": "today",
            "budgets": [{"name": "b", "period": "week", "current_cost": 15.0,
                         "cost_limit": 15.0, "effective_action": "block"}]
        });
        let full = render(|buf| write_budgets(buf, &exact));
        assert!(over.contains('\u{25b8}'), "133% must spill past the bar: {over}");
        assert!(!full.contains('\u{25b8}'), "100% must not spill: {full}");
    }

    #[test]
    fn anomalies_list_every_row_with_when_and_which_model() {
        let payload = json!({
            "mode": "anomalies",
            "period": "today",
            "anomalies": [{"ts": "2026-08-13T01:43:00+00:00", "character": "qifei",
                           "model": "claude-opus-4-6", "call_type": "message",
                           "anomaly": "unexpected_write", "cache_read_tokens": 0,
                           "cache_write_tokens": 18200}]
        });
        let out = render(|buf| write_anomalies(buf, &payload));
        assert!(out.contains("unexpected write"), "{out}");
        assert!(out.contains("18.2K"), "{out}");
        assert!(
            out.contains('\u{2014}'),
            "a zero read must read as a dash, not 0: {out}"
        );
    }

    #[test]
    fn cache_says_which_period_the_anomaly_count_actually_covers() {
        let out = render(|buf| write_cache(buf, &summary_payload()));
        assert!(
            out.contains("last 7d"),
            "the 7d anomaly window must not masquerade as the report period: {out}"
        );
    }

    #[test]
    fn limits_report_what_is_left_not_a_raw_pair() {
        let payload = json!({
            "rate_limits": [{"host": "api.anthropic.com",
                             "resets_at": "2026-08-15T04:05:00+00:00",
                             "requests_remaining": 9999, "requests_limit": 10000,
                             "input_tokens_remaining": 10000000, "input_tokens_limit": 10000000,
                             "output_tokens_remaining": 2000000, "output_tokens_limit": 2000000}]
        });
        let out = render(|buf| write_limits(buf, &payload));
        assert!(out.contains("api.anthropic.com"), "{out}");
        assert!(out.contains("left of"), "{out}");
    }

    #[test]
    fn the_action_in_force_beats_the_configured_one() {
        let payload = json!({
            "period": "today",
            "budgets": [{"name": "b", "period": "week", "current_cost": 1.0,
                         "cost_limit": 10.0, "action": "block",
                         "effective_action": "pause_heartbeat"}]
        });
        let out = render(|buf| write_budgets(buf, &payload));
        assert!(
            out.contains("pauses the heartbeat at limit"),
            "the effective action is what will actually happen: {out}"
        );
    }

    #[test]
    fn an_older_daemon_without_effective_action_still_reports_one() {
        let payload = json!({
            "period": "today",
            "budgets": [{"name": "b", "period": "week", "current_cost": 1.0,
                         "cost_limit": 10.0, "action": "warn"}]
        });
        let out = render(|buf| write_budgets(buf, &payload));
        assert!(
            out.contains("warns at limit"),
            "a payload predating effective_action must fall back, not go blank: {out}"
        );
    }

    #[test]
    fn no_usage_surface_emits_trailing_whitespace() {
        let surfaces = [
            render(|buf| write_summary(buf, &summary_payload())),
            render(|buf| write_budgets(buf, &summary_payload())),
            render(|buf| write_cache(buf, &summary_payload())),
        ];
        for out in &surfaces {
            for line in out.lines() {
                assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
            }
        }
    }
}
