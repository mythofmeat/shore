use std::io::Write;

use super::parse_timestamp;
use super::transcript::format_time;
use super::vocab::{COLOR_ERROR, Tone, note, paint, write_row, write_section_header};

#[expect(
    clippy::float_arithmetic,
    reason = "the heatmap scales normalized densities onto eight block glyphs"
)]
pub(crate) fn density_to_block(normalized: f64) -> char {
    const BLOCKS: [char; 8] = [
        '\u{2581}', '\u{2582}', '\u{2583}', '\u{2584}', '\u{2585}', '\u{2586}', '\u{2587}',
        '\u{2588}',
    ];
    if normalized < 0.05 {
        '\u{2591}'
    } else {
        let level = (normalized.clamp(0.0, 1.0) * 7.0).round();
        let idx = match level {
            x if x <= 0.0 => 0,
            x if x <= 1.0 => 1,
            x if x <= 2.0 => 2,
            x if x <= 3.0 => 3,
            x if x <= 4.0 => 4,
            x if x <= 5.0 => 5,
            x if x <= 6.0 => 6,
            _ => 7,
        };
        BLOCKS.get(idx).copied().unwrap_or('\u{2588}')
    }
}

pub(crate) fn classification_color(class: &str) -> Tone {
    match class {
        "peak" => Tone::Active,
        "trough" => Tone::Muted,
        _ => Tone::Heading,
    }
}

#[expect(
    clippy::float_arithmetic,
    reason = "activity heatmap uses visual-only logarithmic scaling of normalized f64 densities"
)]
pub(crate) fn write_activity_section(out: &mut impl Write, activity: &serde_json::Value, width: usize) {
    let histogram: Vec<f64> = match activity["hour_histogram"].as_array() {
        Some(arr) => arr.iter().filter_map(serde_json::Value::as_f64).collect(),
        None => return,
    };
    if histogram.len() != 24 {
        return;
    }
    let classifications: Vec<String> = activity["hour_classifications"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if classifications.len() != 24 {
        return;
    }

    let turn_count = activity["turn_count"].as_u64().unwrap_or(0);
    if turn_count == 0 {
        write_section_header(out, "activity", "", width);
        note(
            out,
            "nothing recorded yet \u{00b7} activity is learned from your messages",
        );
        _ = writeln!(out);
        return;
    }

    let sufficient = activity["has_sufficient_heatmap"]
        .as_bool()
        .unwrap_or(false);
    let suffix = if sufficient { "" } else { "sparse" };
    write_section_header(out, "activity", suffix, width);

    let max_val = histogram.iter().copied().fold(0.0_f64, f64::max);
    paint(out, Tone::Muted, &format!("{:<15}", ""));
    for (&density, classification) in histogram.iter().zip(classifications.iter()) {
        let linear = if max_val > 0.0 {
            density / max_val
        } else {
            0.0
        };
        let normalized = (1.0 + linear * 9.0).ln() / 10.0_f64.ln();
        let ch = density_to_block(normalized);
        paint(out, classification_color(classification), &ch.to_string());
    }
    _ = writeln!(out);

    paint(out, Tone::Muted, &format!("  {:<13}0  3  6  9  12 15 18 21", ""));
    _ = writeln!(out);

    let engagement = activity["engagement_score"].as_f64().unwrap_or(0.0);
    let sessions = activity["sessions_per_day"].as_f64().unwrap_or(0.0);
    write_row(
        out,
        "engagement",
        &format!("{engagement:.2} \u{00b7} {sessions:.1} sessions/day \u{00b7} {turn_count} turns"),
    );

    _ = writeln!(out);
}

const SECONDS_PER_MINUTE: u64 = 60;

const SECONDS_PER_HOUR: u64 = 3_600;

const SECONDS_PER_DAY: u64 = 86_400;

fn checked_div_u64(value: u64, divisor: u64) -> u64 {
    value.checked_div(divisor).unwrap_or_default()
}

fn checked_rem_u64(value: u64, divisor: u64) -> u64 {
    value.checked_rem(divisor).unwrap_or_default()
}

fn format_duration_compact(secs: i64) -> String {
    let neg = secs < 0;
    let mut remaining_seconds = secs.unsigned_abs();
    let days = checked_div_u64(remaining_seconds, SECONDS_PER_DAY);
    remaining_seconds = checked_rem_u64(remaining_seconds, SECONDS_PER_DAY);
    let hours = checked_div_u64(remaining_seconds, SECONDS_PER_HOUR);
    remaining_seconds = checked_rem_u64(remaining_seconds, SECONDS_PER_HOUR);
    let minutes = checked_div_u64(remaining_seconds, SECONDS_PER_MINUTE);
    let seconds = checked_rem_u64(remaining_seconds, SECONDS_PER_MINUTE);

    let body = if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{seconds}s")
    };
    if neg { format!("-{body}") } else { body }
}

fn format_threshold(secs: u64) -> String {
    if secs >= SECONDS_PER_HOUR && secs.is_multiple_of(SECONDS_PER_HOUR) {
        format!("{}h", checked_div_u64(secs, SECONDS_PER_HOUR))
    } else if secs >= SECONDS_PER_MINUTE && secs.is_multiple_of(SECONDS_PER_MINUTE) {
        format!("{}m", checked_div_u64(secs, SECONDS_PER_MINUTE))
    } else if secs >= SECONDS_PER_HOUR {
        let hours = checked_div_u64(secs, SECONDS_PER_HOUR);
        let remaining_minutes =
            checked_div_u64(checked_rem_u64(secs, SECONDS_PER_HOUR), SECONDS_PER_MINUTE);
        format!("{hours}h {remaining_minutes}m")
    } else if secs >= SECONDS_PER_MINUTE {
        let minutes = checked_div_u64(secs, SECONDS_PER_MINUTE);
        let seconds = checked_rem_u64(secs, SECONDS_PER_MINUTE);
        format!("{minutes}m {seconds}s")
    } else {
        format!("{secs}s")
    }
}

pub(crate) fn format_local_timestamp(rfc3339: &str) -> String {
    parse_timestamp(rfc3339).map_or_else(
        || rfc3339.to_owned(),
        |dt| dt.format("%Y-%m-%d %H:%M").to_string(),
    )
}

pub(crate) fn write_autonomy_section(out: &mut impl Write, autonomy: &serde_json::Value, width: usize) {
    let paused = autonomy["paused"].as_bool().unwrap_or(false);
    let suffix = if paused { "paused" } else { "" };
    write_section_header(out, "autonomy", suffix, width);

    let int_state = autonomy["heartbeat_state"].as_str().unwrap_or("Active");
    let ticks = autonomy["ticks_without_user"].as_u64().unwrap_or(0);
    let max_ticks = autonomy["dormant_after_heartbeat_turns"]
        .as_u64()
        .unwrap_or(0);
    let description = heartbeat_description(int_state, ticks, max_ticks);

    paint(out, Tone::Muted, &format!("  {:<13}", "heartbeat"));
    _ = write!(out, "{description}  ");
    paint(out, Tone::Muted, &format!("({int_state})"));
    _ = writeln!(out);

    write_autonomy_schedule(out, autonomy, ticks, max_ticks);
    write_autonomy_events(out, autonomy);
}

fn write_autonomy_schedule(
    out: &mut impl Write,
    autonomy: &serde_json::Value,
    ticks: u64,
    max_ticks: u64,
) {
    if let Some(eff) = autonomy["effective_interval_secs"].as_u64() {
        write_row(out, "interval", &format_threshold(eff));
    }

    if let Some(secs) = autonomy["seconds_until_wake"].as_i64() {
        let abs_label = autonomy["next_wake_at"]
            .as_str()
            .map(format_local_timestamp)
            .unwrap_or_default();
        let rel = if secs >= 0 {
            format!("in {}", format_duration_compact(secs))
        } else {
            format!("{} overdue", format_duration_compact(secs.saturating_neg()))
        };
        let detail = if abs_label.is_empty() {
            rel
        } else {
            format!("{rel}  ({abs_label})")
        };
        write_row(out, "next wake", &detail);
    } else {
        write_row(out, "next wake", "(none scheduled)");
    }

    if let Some(secs) = autonomy["seconds_since_user"].as_i64() {
        let abs_label = autonomy["last_user_at"]
            .as_str()
            .map(format_local_timestamp)
            .unwrap_or_default();
        let rel = format!("{} ago", format_duration_compact(secs));
        let detail = if abs_label.is_empty() {
            rel
        } else {
            format!("{rel}  ({abs_label})")
        };
        write_row(out, "last user", &detail);
    }

    write_row(out, "idle ticks", &format!("{ticks} / {max_ticks}"));

    if let Some(secs) = autonomy["minimum_heartbeat_latency_secs"].as_u64() {
        write_row(out, "min latency", &format_threshold(secs));
    }
    if let Some(secs) = autonomy["dormant_after_idle_time_secs"].as_u64() {
        write_row(out, "idle limit", &format_threshold(secs));
    }
}

fn write_autonomy_events(out: &mut impl Write, autonomy: &serde_json::Value) {
    let events: Vec<serde_json::Value> = autonomy
        .get("recent_events")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if events.is_empty() {
        _ = writeln!(out);
        return;
    }

    _ = writeln!(out);
    paint(out, Tone::Muted, "  Recent events:");

    let _ignored = writeln!(out);
    let mut prev_date: Option<String> = None;
    for event in events.iter().rev() {
        let ts = event["timestamp"].as_str().unwrap_or("");
        let kind = event["kind"].as_str().unwrap_or("?");
        let detail = event["detail"].as_str().unwrap_or("");
        let time_str = parse_timestamp(ts).map_or_else(
            || ts.chars().take(8).collect(),
            |dt| {
                let formatted = format_time(&dt, prev_date.as_deref());
                prev_date = Some(dt.format("%Y-%m-%d").to_string());
                formatted
            },
        );
        let kind_color = match kind {
            "tick_fired" => Tone::Active,
            "message_sent" | "wake" => Tone::Good,
            "message_skipped" => Tone::Muted,
            "tool_use" => Tone::Active,
            "dormant" => COLOR_ERROR,
            "dormant_ping" => Tone::Thinking,
            "timeout" => Tone::Warn,
            _ => Tone::Heading,
        };
        paint(out, Tone::Muted, &format!("    {time_str:<16}"));
        paint(out, kind_color, &format!("{kind:<17}"));
        _ = writeln!(out, "{detail}");
    }
    _ = writeln!(out);
}

fn heartbeat_description(state: &str, ticks: u64, max_ticks: u64) -> String {
    match state {
        "Active" if ticks == 0 => "active \u{2014} in conversation".to_owned(),
        "Active" => format!("active \u{2014} idle {ticks}/{max_ticks} ticks"),
        "Dormant" => "dormant \u{2014} waiting for you".to_owned(),
        other => other.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_color_maps_correctly() {
        assert!(matches!(classification_color("peak"), Tone::Active));
        assert!(matches!(classification_color("trough"), Tone::Muted));
        assert!(matches!(classification_color("normal"), Tone::Heading));
        assert!(matches!(classification_color("unknown"), Tone::Heading));
    }

    #[test]
    fn density_to_block_ranges() {
        assert_eq!(density_to_block(0.0), '\u{2591}');
        assert_eq!(density_to_block(0.04), '\u{2591}');
        assert_eq!(density_to_block(0.06), '\u{2581}');
        assert_eq!(density_to_block(0.5), '\u{2585}');
        assert_eq!(density_to_block(1.0), '\u{2588}');
    }

    #[test]
    fn heartbeat_description_maps_states() {
        assert_eq!(
            heartbeat_description("Active", 0, 3),
            "active \u{2014} in conversation"
        );
        assert_eq!(
            heartbeat_description("Active", 2, 3),
            "active \u{2014} idle 2/3 ticks"
        );
        assert_eq!(
            heartbeat_description("Dormant", 4, 3),
            "dormant \u{2014} waiting for you"
        );
    }

    #[test]
    fn heartbeat_description_unknown_state() {
        assert_eq!(heartbeat_description("CustomState", 0, 8), "CustomState");
    }
}
