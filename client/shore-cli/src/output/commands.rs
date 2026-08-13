use std::io::{self, Write};

use crossterm::style::{Attribute, Color, ResetColor, SetAttribute, SetForegroundColor};

use super::transcript::{character_color, format_time};
use super::{
    abbreviate_model, parse_timestamp, print_dim_line, term_width, use_color, write_dim, write_fg,
    write_row, write_row_colored, write_section_header,
};

const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_DAY: u64 = 86_400;

// ---------------------------------------------------------------------------
// Status formatter -- human-readable dashboard
// ---------------------------------------------------------------------------

/// Translate a heartbeat state string to a human-readable description.
fn heartbeat_description(state: &str, ticks: u64, max_ticks: u64) -> String {
    match state {
        "Active" if ticks == 0 => "active \u{2014} in conversation".to_owned(),
        "Active" => format!("active \u{2014} idle {ticks}/{max_ticks} ticks"),
        "Dormant" => "dormant \u{2014} waiting for you".to_owned(),
        other => other.to_owned(),
    }
}

/// Map a normalized density (0.0-1.0) to a bar character.
///
/// Uses 8 Unicode block elements for non-zero values and a light shade for
/// effectively-zero values.
#[expect(
    clippy::float_arithmetic,
    reason = "heatmap rendering maps a normalized float density onto eight display glyphs"
)]
fn density_to_block(normalized: f64) -> char {
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

fn checked_div_u64(value: u64, divisor: u64) -> u64 {
    value.checked_div(divisor).unwrap_or_default()
}

fn checked_rem_u64(value: u64, divisor: u64) -> u64 {
    value.checked_rem(divisor).unwrap_or_default()
}

fn format_millis_as_seconds_one_decimal(millis: u64) -> String {
    let rounded_deciseconds = checked_div_u64(millis.saturating_add(50), 100);
    let whole_seconds = checked_div_u64(rounded_deciseconds, 10);
    let decimal_seconds = checked_rem_u64(rounded_deciseconds, 10);
    format!("{whole_seconds}.{decimal_seconds}")
}

#[expect(
    clippy::float_arithmetic,
    reason = "CLI usage summaries add daemon-provided f64 display costs for rounded totals only"
)]
fn add_display_cost(total: &mut f64, cost: f64) {
    *total += cost;
}

/// Color for an hour classification label.
fn classification_color(class: &str) -> Color {
    match class {
        "peak" => Color::Cyan,
        "trough" => Color::DarkGrey,
        _ => Color::White,
    }
}

/// Write the activity heatmap section into the status dashboard.
///
/// Renders a 24-character bar chart (one block per hour) with hour labels
/// underneath, plus engagement and session stats.
#[expect(
    clippy::float_arithmetic,
    reason = "activity heatmap uses visual-only logarithmic scaling of normalized f64 densities"
)]
fn write_activity_section(out: &mut impl Write, activity: &serde_json::Value, width: usize) {
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

    let sufficient = activity["has_sufficient_heatmap"]
        .as_bool()
        .unwrap_or(false);
    let suffix = if sufficient { "" } else { "sparse" };
    write_section_header(out, "Activity", suffix, width);

    // -- bar chart row --
    let max_val = histogram.iter().copied().fold(0.0_f64, f64::max);
    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    _ = write!(out, "  {:<13}", "");
    for (&density, classification) in histogram.iter().zip(classifications.iter()) {
        let linear = if max_val > 0.0 {
            density / max_val
        } else {
            0.0
        };
        // Log scale: ln(1 + x*k) / ln(1+k) -- spreads low values, compresses peaks.
        let normalized = (1.0 + linear * 9.0).ln() / 10.0_f64.ln();
        let ch = density_to_block(normalized);
        if use_color() {
            let color = classification_color(classification);
            _ = crossterm::execute!(out, SetForegroundColor(color));
        }
        _ = write!(out, "{ch}");
    }
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out);

    // -- hour labels row --
    //    0  3  6  9  12 15 18 21
    if use_color() {
        _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    _ = write!(out, "  {:<13}0  3  6  9  12 15 18 21", "");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out);

    // -- stats row --
    let engagement = activity["engagement_score"].as_f64().unwrap_or(0.0);
    let sessions = activity["sessions_per_day"].as_f64().unwrap_or(0.0);
    let turn_count = activity["turn_count"].as_u64().unwrap_or(0);
    write_row(
        out,
        "Engagement",
        &format!("{engagement:.2} \u{00b7} {sessions:.1} sessions/day \u{00b7} {turn_count} turns"),
    );

    _ = writeln!(out);
}

/// Print the status dashboard.
pub(crate) fn print_status(data: &serde_json::Value, character_name: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    // -- Status --
    write_section_header(&mut out, "Status", "", width);

    // Prefer the character name from the daemon response over the CLI fallback.
    let effective_name = data["character"].as_str().unwrap_or(character_name);
    let char_color = character_color(effective_name);
    write_row_colored(&mut out, "Character", effective_name, char_color);

    let model = data["active_model"].as_str().unwrap_or("(none)");
    write_row(&mut out, "Model", abbreviate_model(model));

    if let Some(count) = data["turn_count"].as_u64() {
        write_row(&mut out, "Turns", &count.to_string());
    }

    let pending_deferred_edit_count = data["pending_deferred_edit_count"].as_u64().unwrap_or(0);
    if pending_deferred_edit_count > 0 {
        let paths: Vec<&str> = data["pending_deferred_edits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|path| path.as_str())
            .collect();
        let label = if pending_deferred_edit_count == 1 {
            "1 pending".to_owned()
        } else {
            format!("{pending_deferred_edit_count} pending")
        };
        let detail = if paths.is_empty() {
            label
        } else {
            format!("{label}: {}", paths.join(", "))
        };
        write_row(&mut out, "Prompt Edits", &detail);
    }

    _ = writeln!(out);

    // -- Clients --
    if let Some(clients) = data.get("clients").and_then(|c| c.as_array()) {
        if !clients.is_empty() {
            write_section_header(&mut out, "Clients", "", width);
            for client in clients {
                let ctype = client["client_type"].as_str().unwrap_or("?");
                let cname = client["client_name"].as_str().unwrap_or("?");
                write_row(&mut out, ctype, cname);
            }
            _ = writeln!(out);
        }
    }

    // -- Autonomy --
    if let Some(autonomy) = data.get("autonomy") {
        if !autonomy.is_null() {
            write_autonomy_section(&mut out, autonomy, width);
        }
    }

    // -- Activity --
    if let Some(activity) = data.get("activity") {
        if !activity.is_null() {
            let turn_count = activity["turn_count"].as_u64().unwrap_or(0);
            if turn_count > 0 {
                write_activity_section(&mut out, activity, width);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Command-specific formatters
// ---------------------------------------------------------------------------

/// Dispatch a command response to the appropriate formatter.
/// Falls back to generic JSON output for unknown command names.
pub(crate) fn format_command(name: &str, data: &serde_json::Value) {
    match name {
        "character_info" => print_character_info(data),
        "list_models" => print_model_list(data),
        "background_models" => print_background_models(data),
        "switch_model" => print_model_switched(data),
        "reset_model" => print_model_reset(data),
        "model_info" => print_model_info(data),
        "model_settings" => print_model_settings(data),
        "set_model_setting" => print_set_model_setting(data),
        "list_providers" => print_provider_list(data),
        "list_provider_models" => print_provider_models(data),
        "refresh_provider_models" => print_provider_refresh(data),
        "refresh_all_provider_models" => print_provider_refresh_all(data),
        "memory" => print_memory(data),
        "compact" => print_compact_result(data),
        "config" => print_config(data, false),
        "tools" => print_tools(data),
        "config_check" => print_config_check(data),
        "config_reload" => print_config_reload(data),
        "config_reset" => print_config_reset(data),
        "edit" => print_edit_confirmation(data),
        "delete" => print_delete_confirmation(data),
        "alt" => print_alt_confirmation(data),
        "list_alternatives" => print_alt_list(data),
        "inject_system" => cli_out!("System instruction injected."),
        "diagnostics" => print_diagnostics(data),
        "usage" => print_usage(data),
        "heartbeat_log" => super::transcript::print_heartbeat_log(data),
        "call_log" => print_call_log(data),
        "transcript" => print_transcript(data),
        "heartbeat_tick_now" => print_heartbeat_tick_now(data),
        "heartbeat_set_dormant" => print_heartbeat_status_change(data, "dormant"),
        "heartbeat_set_active" => print_heartbeat_status_change(data, "active"),
        "session_activate" => print_session_activate(data),
        _ => print_command_output_fallback(name, data),
    }
}

/// Max characters of a stored payload body shown when dumping one call. The
/// full body is always available via `--json`.
const CALL_BODY_PREVIEW: usize = 4000;

/// Render the raw call-payload store: either an index of recent calls or, when
/// `data.call` is present, one call's decompressed request/response.
fn print_call_log(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    if data.get("enabled").is_some_and(|v| v == false) {
        print_dim_line(&mut out, "(call payload capture is disabled)");
        return;
    }

    if let Some(call) = data.get("call").filter(|c| !c.is_null()) {
        if let Some(diff) = data.get("diff").filter(|d| !d.is_null()) {
            print_call_diff(&mut out, call, diff, width);
        } else {
            print_one_call(&mut out, call, width);
        }
        print_wire_exchanges(&mut out, data.get("wire"), width);
        return;
    }

    let Some(entries) = data["entries"].as_array().filter(|e| !e.is_empty()) else {
        print_dim_line(&mut out, "(no calls recorded)");
        return;
    };
    write_section_header(
        &mut out,
        "call log",
        &format!("{} calls", entries.len()),
        width,
    );
    for entry in entries {
        let usage = &entry["usage"];
        write_fg(
            &mut out,
            Color::DarkGrey,
            &format!("  #{:<6}", entry["id"].as_i64().unwrap_or(0)),
        );
        write_fg(
            &mut out,
            Color::Blue,
            &format!("{:<18}", entry["call_type"].as_str().unwrap_or("?")),
        );
        write_fg(
            &mut out,
            Color::Magenta,
            &format!(
                "{}/{}",
                entry["provider"].as_str().unwrap_or("?"),
                abbreviate_model(entry["model"].as_str().unwrap_or("?"))
            ),
        );
        _ = writeln!(out);
        let err = entry["error"]
            .as_str()
            .map_or_else(String::new, |e| format!("  ERROR: {e}"));
        write_dim(
            &mut out,
            &format!(
                "          in={} out={} cache={}  {}ms  {}B{}",
                usage["input_tokens"].as_u64().unwrap_or(0),
                usage["output_tokens"].as_u64().unwrap_or(0),
                usage["cache_read_tokens"].as_u64().unwrap_or(0),
                entry["duration_ms"].as_u64().unwrap_or(0),
                entry["request_bytes"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(entry["response_bytes"].as_u64().unwrap_or(0)),
                err,
            ),
        );
        _ = writeln!(out);
    }
    print_dim_line(
        &mut out,
        "(shore log --api <id> to dump one call; --json for raw)",
    );
}

/// Dump one stored call's metadata and decompressed request/response bodies.
fn print_one_call(out: &mut impl Write, call: &serde_json::Value, width: usize) {
    write_section_header(
        out,
        "call payload",
        call["call_id"].as_str().unwrap_or("?"),
        width,
    );
    let usage = &call["usage"];
    write_dim(
        out,
        &format!(
            "  {}  {}/{}  {}  in={} out={} cache_read={}  {}ms",
            call["ts"].as_str().unwrap_or("?"),
            call["provider"].as_str().unwrap_or("?"),
            abbreviate_model(call["model"].as_str().unwrap_or("?")),
            call["call_type"].as_str().unwrap_or("?"),
            usage["input_tokens"].as_u64().unwrap_or(0),
            usage["output_tokens"].as_u64().unwrap_or(0),
            usage["cache_read_tokens"].as_u64().unwrap_or(0),
            call["duration_ms"].as_u64().unwrap_or(0),
        ),
    );
    _ = writeln!(out);
    for (label, key) in [("request", "request"), ("response", "response")] {
        write_fg(out, Color::Cyan, &format!("  {label}:\n"));
        let body = call[key].as_str().unwrap_or("");
        _ = writeln!(out, "{}", truncate_display(body, CALL_BODY_PREVIEW));
        _ = writeln!(out);
    }
    print_dim_line(out, "(--json for the full, untruncated payload)");
}

fn print_wire_exchanges(out: &mut impl Write, wire: Option<&serde_json::Value>, width: usize) {
    let Some(exchanges) = wire.and_then(serde_json::Value::as_array) else {
        return;
    };
    if exchanges.is_empty() {
        print_dim_line(out, "(no raw HTTP exchange recorded for this call)");
        return;
    }

    write_section_header(
        out,
        "wire",
        &format!("{} HTTP exchange(s)", exchanges.len()),
        width,
    );
    for exchange in exchanges {
        let status = exchange["status"]
            .as_u64()
            .map_or_else(|| "-".to_owned(), |s| s.to_string());
        write_fg(
            out,
            Color::Magenta,
            &format!(
                "  #{} {} {}",
                exchange["seq"].as_u64().unwrap_or(0),
                exchange["method"].as_str().unwrap_or("?"),
                exchange["url"].as_str().unwrap_or("?"),
            ),
        );
        _ = writeln!(out);
        let err = exchange["error"]
            .as_str()
            .map_or_else(String::new, |e| format!("  ERROR: {e}"));
        write_dim(
            out,
            &format!(
                "     -> {} {}  {}ms  {}B up / {}B down{}\n",
                status,
                exchange["status_text"].as_str().unwrap_or(""),
                exchange["duration_ms"].as_u64().unwrap_or(0),
                exchange["request_bytes"].as_u64().unwrap_or(0),
                exchange["response_bytes"].as_u64().unwrap_or(0),
                err,
            ),
        );
        for (label, key) in [
            ("wire request", "request_body"),
            ("wire response", "response_body"),
        ] {
            let Some(body) = exchange[key].as_str().filter(|b| !b.is_empty()) else {
                continue;
            };
            write_fg(out, Color::Cyan, &format!("  {label}:\n"));
            _ = writeln!(out, "{}", truncate_display(body, CALL_BODY_PREVIEW));
        }
        _ = writeln!(out);
    }
    print_dim_line(out, "(--json for the untruncated wire bytes and headers)");
}

/// Max characters of a single changed chunk shown in a diff.
const DIFF_CHUNK_PREVIEW: usize = 1200;

/// Render one call as what changed since an earlier call: the unchanged
/// prefix collapsed to a count, every added or removed chunk shown in full.
fn print_call_diff(
    out: &mut impl Write,
    call: &serde_json::Value,
    diff: &serde_json::Value,
    width: usize,
) {
    write_section_header(
        out,
        "call diff",
        &format!(
            "#{} -> #{}",
            diff["from_call"].as_i64().unwrap_or(0),
            diff["to_call"].as_i64().unwrap_or(0)
        ),
        width,
    );

    let chunks = &diff["chunks"];
    let bytes = &diff["bytes"];
    write_dim(
        out,
        &format!(
            "  {}  {}  source={}\n",
            call["ts"].as_str().unwrap_or("?"),
            call["call_type"].as_str().unwrap_or("?"),
            diff["source"].as_str().unwrap_or("?"),
        ),
    );
    write_dim(
        out,
        &format!(
            "  unchanged {} chunks / {}B   added {} / {}B   removed {} / {}B\n\n",
            chunks["equal"].as_u64().unwrap_or(0),
            bytes["equal"].as_u64().unwrap_or(0),
            chunks["added"].as_u64().unwrap_or(0),
            bytes["added"].as_u64().unwrap_or(0),
            chunks["removed"].as_u64().unwrap_or(0),
            bytes["removed"].as_u64().unwrap_or(0),
        ),
    );

    let empty = Vec::new();
    let entries = diff["entries"].as_array().unwrap_or(&empty);
    let mut unchanged_run = 0_u64;
    for entry in entries {
        let op = entry["op"].as_str().unwrap_or("equal");
        let body = entry["text"].as_str().unwrap_or("");
        // A chunk that is only the punctuation between two array elements
        // carries no information; `--json` still has it.
        if op != "equal" && body.trim_matches([',', '[', ']', ' ', '\n']).is_empty() {
            continue;
        }
        if op == "equal" {
            unchanged_run = unchanged_run.saturating_add(1);
            continue;
        }
        if unchanged_run > 0 {
            write_dim(out, &format!("   … {unchanged_run} unchanged\n"));
            unchanged_run = 0;
        }
        let (color, sign) = if op == "added" {
            (Color::Green, '+')
        } else {
            (Color::Red, '-')
        };
        for line in truncate_display(body, DIFF_CHUNK_PREVIEW).lines() {
            write_fg(out, color, &format!("  {sign} {line}\n"));
        }
    }
    if unchanged_run > 0 {
        write_dim(out, &format!("   … {unchanged_run} unchanged\n"));
    }

    _ = writeln!(out);
    print_dim_line(
        out,
        "(shore log --api <id> for the call in full; --json for the raw diff)",
    );
}

/// Render the curated heartbeat transcript: per call, the model/provider
/// and usage, the reasoning, visible text, and each tool call with its result.
fn print_transcript(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    let source = data["source"].as_str().unwrap_or("heartbeat");
    let char_name = data["character"].as_str().unwrap_or("?");
    write_section_header(&mut out, &format!("{source} transcript"), char_name, width);

    if data.get("enabled").is_some_and(|v| v == false) {
        print_dim_line(&mut out, "(payload capture is disabled)");
        return;
    }
    let Some(entries) = data["entries"].as_array().filter(|e| !e.is_empty()) else {
        print_dim_line(&mut out, "(no transcript entries yet)");
        return;
    };
    let mut prev_date: Option<String> = None;
    for entry in entries {
        print_transcript_entry(&mut out, entry, &mut prev_date);
    }
}

/// Render one transcript row: header (time, call type, provider/model, usage),
/// reasoning, visible text, and tool calls with truncated outputs.
fn print_transcript_entry(
    out: &mut impl Write,
    entry: &serde_json::Value,
    prev_date: &mut Option<String>,
) {
    let ts = entry["ts"].as_str().unwrap_or("");
    let time_str = parse_timestamp(ts).map_or_else(
        || ts.chars().take(16).collect::<String>(),
        |dt| {
            let formatted = format_time(&dt, prev_date.as_deref());
            *prev_date = Some(dt.format("%Y-%m-%d").to_string());
            formatted
        },
    );
    let usage = &entry["usage"];
    write_fg(out, Color::DarkGrey, &format!("  {time_str:<14}"));
    write_fg(
        out,
        Color::Blue,
        &format!(
            "{}#{}",
            entry["call_type"].as_str().unwrap_or("?"),
            entry["iteration"].as_u64().unwrap_or(0)
        ),
    );
    write_fg(
        out,
        Color::Magenta,
        &format!(
            "  {}/{}",
            entry["provider"].as_str().unwrap_or("?"),
            abbreviate_model(entry["model"].as_str().unwrap_or("?"))
        ),
    );
    _ = writeln!(out);
    write_dim(
        out,
        &format!(
            "                {}  in={} out={} cache_read={}",
            entry["finish_reason"].as_str().unwrap_or(""),
            usage["input_tokens"].as_u64().unwrap_or(0),
            usage["output_tokens"].as_u64().unwrap_or(0),
            usage["cache_read_tokens"].as_u64().unwrap_or(0),
        ),
    );
    _ = writeln!(out);
    let inner = &entry["entry"];
    if let Some(reasoning) = inner["reasoning"].as_array() {
        for block in reasoning.iter().filter_map(serde_json::Value::as_str) {
            write_fg(out, Color::DarkCyan, "                reasoning: ");
            _ = writeln!(out, "{}", block.trim());
        }
    }
    let text = inner["text"].as_str().unwrap_or("");
    if !text.trim().is_empty() {
        write_fg(out, Color::White, "                text: ");
        _ = writeln!(out, "{}", text.trim());
    }
    if let Some(tools) = inner["tool_calls"].as_array() {
        for tool in tools {
            let is_error = tool["is_error"].as_bool().unwrap_or(false);
            let color = if is_error { Color::Red } else { Color::Cyan };
            let tag = if is_error { " (error)" } else { "" };
            write_fg(
                out,
                color,
                &format!(
                    "                tool {}{tag}: ",
                    tool["name"].as_str().unwrap_or("?")
                ),
            );
            _ = writeln!(out, "{}", truncate_display(&tool["input"].to_string(), 200));
            write_dim(
                out,
                &format!(
                    "                  → {}",
                    truncate_display(tool["output"].as_str().unwrap_or(""), 600)
                ),
            );
            _ = writeln!(out);
        }
    }
    _ = writeln!(out);
}

/// Truncate `s` to at most `max` chars, flattening newlines, with a dropped
/// count suffix when it overflows.
fn truncate_display(s: &str, max: usize) -> String {
    let flat = s.replace('\n', " ");
    let count = flat.chars().count();
    if count <= max {
        return flat;
    }
    let kept: String = flat.chars().take(max).collect();
    format!("{kept}… (+{} chars)", count.saturating_sub(max))
}

fn print_command_output_fallback(name: &str, data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if use_color() {
        let _ignored = crossterm::execute!(out, SetAttribute(Attribute::Bold));
    }
    _ = write!(out, "{name}");
    if use_color() {
        _ = crossterm::execute!(out, SetAttribute(Attribute::Reset));
    }
    _ = writeln!(out);
    if let Ok(pretty) = serde_json::to_string_pretty(data) {
        _ = writeln!(out, "{pretty}");
    }
}

fn print_heartbeat_tick_now(data: &serde_json::Value) {
    let character = data["character"].as_str().unwrap_or("?");
    cli_out!("Tick scheduled for {character}.");
    if let Some(warning) = data["warning"].as_str() {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        write_fg(&mut out, Color::Yellow, warning);
        _ = writeln!(out);
    }
}

fn print_heartbeat_status_change(data: &serde_json::Value, status: &str) {
    let character = data["character"].as_str().unwrap_or("?");
    cli_out!("Heartbeat forced {status} for {character}.");
}

/// One line per clock: what the keepalive did, and where the heartbeat stands.
/// The `primed` case names the cache write it just paid for, because that
/// spend is the whole reason activation is a deliberate command.
fn print_session_activate(data: &serde_json::Value) {
    let character = data["character"].as_str().unwrap_or("?");
    if data["registered"].as_bool().unwrap_or(false) {
        cli_out!("Activated {character}.");
    } else {
        cli_out!("{character} was already active.");
    }
    cli_out!(
        "  Keepalive: {}",
        session_activate_keepalive(&data["keepalive"])
    );
    cli_out!(
        "  Heartbeat: {}",
        session_activate_heartbeat(&data["heartbeat"])
    );
}

fn session_activate_keepalive(k: &serde_json::Value) -> String {
    let until = |v: &serde_json::Value| {
        format_duration_compact(v["seconds_until_ping"].as_i64().unwrap_or(0))
    };
    match k["status"].as_str().unwrap_or("?") {
        "primed" => {
            let written = k["cache_creation_tokens"].as_u64().unwrap_or(0);
            let read = k["cache_read_tokens"].as_u64().unwrap_or(0);
            let paid = if written > 0 {
                format!("wrote {written} cache tokens")
            } else {
                format!("read {read} cache tokens, no write")
            };
            format!("primed — {paid}; next ping in {}", until(k))
        }
        "resumed" => format!("already warm; next ping in {}", until(k)),
        "off" => "off — this character's model sets cache_keepalive = off".to_owned(),
        "unavailable" => format!(
            "not armed — {}",
            k["detail"]
                .as_str()
                .unwrap_or("no cached or rebuildable request")
        ),
        "skipped" => format!("not armed — {}", k["detail"].as_str().unwrap_or("skipped")),
        "failed" => format!(
            "priming call failed — {}",
            k["detail"].as_str().unwrap_or("")
        ),
        other => other.to_owned(),
    }
}

fn session_activate_heartbeat(h: &serde_json::Value) -> String {
    let Some(state) = h["state"].as_str() else {
        return "no state (registration failed)".to_owned();
    };
    let paused = if h["paused"].as_bool().unwrap_or(false) {
        ", paused"
    } else {
        ""
    };
    match h["seconds_until_wake"].as_i64() {
        Some(secs) => format!(
            "{state}{paused}, next wake in {}",
            format_duration_compact(secs)
        ),
        None => format!("{state}{paused}, no wake scheduled"),
    }
}

/// Print edit confirmation.
fn print_edit_confirmation(data: &serde_json::Value) {
    let msg_ref = data["ref"].as_str().unwrap_or("?");
    cli_out!("Edited message {msg_ref}");
}

/// Print delete confirmation.
fn print_delete_confirmation(data: &serde_json::Value) {
    if let Some(arr) = data["deleted"].as_array() {
        let n = arr.len();
        if n == 1 {
            let id = arr
                .first()
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            cli_out!("Deleted entry {id}");
        } else {
            cli_out!("Deleted {n} entries");
        }
    } else if let Some(id) = data["deleted"].as_str() {
        cli_out!("Deleted entry {id}");
    } else {
        // No recognized deletion payload: nothing to report.
    }
}

/// Print alternate-response selection confirmation.
fn print_alt_confirmation(data: &serde_json::Value) {
    let msg_ref = data["ref"].as_str().unwrap_or("?");
    let position = data["position"].as_u64().unwrap_or(0);
    let count = data["alt_count"].as_u64().unwrap_or(0);
    cli_out!("Selected alternate {position}/{count} for {msg_ref}");
}

fn alt_preview(content: &str, max_width: usize) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() <= max_width {
        return compact;
    }
    let end = compact
        .char_indices()
        .take_while(|(idx, _)| *idx <= max_width.saturating_sub(3))
        .last()
        .map_or(0, |(idx, ch)| idx.saturating_add(ch.len_utf8()));
    let preview = compact.get(..end).unwrap_or("");
    format!("{preview}...")
}

/// Print alternate-response list.
fn print_alt_list(data: &serde_json::Value) {
    let msg_ref = data["ref"].as_str().unwrap_or("?");
    let alternatives: &[serde_json::Value] =
        data["alternatives"].as_array().map_or(&[], Vec::as_slice);
    if alternatives.is_empty() {
        cli_out!("No alternate responses for {msg_ref}.");
        return;
    }

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    write_section_header(&mut out, "Alternates", msg_ref, width);
    let preview_width = width.saturating_sub(14).max(24);
    for alt in alternatives {
        let position = alt["position"].as_u64().unwrap_or(0);
        let count = data["alt_count"]
            .as_u64()
            .unwrap_or_else(|| u64::try_from(alternatives.len()).unwrap_or(u64::MAX));
        let marker = if alt["active"].as_bool().unwrap_or(false) {
            "*"
        } else {
            " "
        };
        let preview = alt_preview(alt["content"].as_str().unwrap_or(""), preview_width);
        _ = writeln!(out, "  {marker} {position}/{count}  {preview}");
    }
    _ = writeln!(out);
}

/// Print model list.
///
/// Phase 8: rows include the source tag (`static`/`discovered`) so users
/// can tell aliases from upstream-discovered ids at a glance, and an
/// optional `hidden_count` footer points them at `--all` when filtered
/// models exist.
fn print_model_list(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let active = data["active"].as_str().unwrap_or("");
    let include_hidden = data["include_hidden"].as_bool().unwrap_or(false);
    let suffix = if include_hidden { "all" } else { "" };
    write_section_header(&mut out, "Models", suffix, width);

    if let Some(models) = data["models"].as_array() {
        // Size columns to the widest value so rows stay visually separated
        // even when names like `arcee-ai/trinity-large-thinking:free` or
        // providers like `openrouter-anthropic` blow past fixed defaults.
        let name_w = models
            .iter()
            .map(|m| m["name"].as_str().unwrap_or("?").chars().count())
            .max()
            .unwrap_or(0)
            .max(24);
        let provider_w = models
            .iter()
            .map(|m| m["provider"].as_str().unwrap_or("?").chars().count())
            .max()
            .unwrap_or(0)
            .max(10);

        for m in models {
            let name = m["name"].as_str().unwrap_or("?");
            let provider = m["provider"].as_str().unwrap_or("?");
            let source = m["source"].as_str().unwrap_or("");
            let hidden = m["hidden"].as_bool().unwrap_or(false);
            let is_active = name == active || m["qualified_name"].as_str() == Some(active);

            let marker = if is_active { "*" } else { " " };

            if use_color() && is_active {
                let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Cyan));
            } else if use_color() {
                let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
            } else {
                // No color: leave the default terminal foreground.
            }
            _ = write!(out, "  {marker} ");
            if use_color() {
                _ = crossterm::execute!(out, ResetColor);
            }
            _ = write!(out, "{name:<name_w$}  ");
            if use_color() {
                _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
            }
            _ = write!(out, "{provider:<provider_w$}  ");
            // Tag like `static` / `discovered`. Hidden rows (only seen
            // with `--all`) carry an extra `hidden` so users can spot
            // why their default list filtered them.
            if !source.is_empty() {
                let tag = if hidden {
                    format!("{source}, hidden")
                } else {
                    source.to_owned()
                };
                _ = write!(out, "[{tag}]");
            }
            if use_color() {
                _ = crossterm::execute!(out, ResetColor);
            }
            _ = writeln!(out);
        }
    }

    // Hint about hidden models the user is not currently seeing.
    let hidden_count = data["hidden_count"].as_u64().unwrap_or(0);
    if !include_hidden && hidden_count > 0 {
        _ = writeln!(out);
        write_dim(
            &mut out,
            &format!("  ({hidden_count} hidden — use `shore model --all` to include them)"),
        );
        _ = writeln!(out);
    }
    _ = writeln!(out);
}

/// Print the model resolved for each background task, with its source.
fn print_background_models(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    write_section_header(&mut out, "Background models", "", width);

    if let Some(rows) = data["background"].as_array() {
        let task_w = rows
            .iter()
            .map(|r| r["task"].as_str().unwrap_or("?").chars().count())
            .max()
            .unwrap_or(0)
            .max(10);
        let model_w = rows
            .iter()
            .map(|r| r["model"].as_str().unwrap_or("?").chars().count())
            .max()
            .unwrap_or(0)
            .max(20);

        for r in rows {
            let task = r["task"].as_str().unwrap_or("?");
            let model = r["model"].as_str().unwrap_or("?");
            let source = r["source"].as_str().unwrap_or("");
            _ = write!(out, "  {task:<task_w$}  {model:<model_w$}  ");
            if use_color() {
                _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
            }
            if !source.is_empty() {
                _ = write!(out, "[{source}]");
            }
            if use_color() {
                _ = crossterm::execute!(out, ResetColor);
            }
            _ = writeln!(out);
        }
    }
    _ = writeln!(out);
}

/// Print model switch confirmation.
fn print_model_switched(data: &serde_json::Value) {
    let model = data["active"].as_str().unwrap_or("(none)");
    cli_out!("Switched to model: {}", abbreviate_model(model));
}

/// Print model reset confirmation.
fn print_model_reset(data: &serde_json::Value) {
    let model = data["active"].as_str().unwrap_or("(none)");
    cli_out!("Model reset to: {}", abbreviate_model(model));
}

/// Print detailed model info.
fn print_model_info(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let name = data["name"].as_str().unwrap_or("?");
    write_section_header(&mut out, "Model", name, width);

    if let Some(qn) = data["qualified_name"].as_str() {
        write_row(&mut out, "Qualified", qn);
    }
    if let Some(mid) = data["model_id"].as_str() {
        write_row(&mut out, "Model ID", mid);
    }
    if let Some(sdk) = data["sdk"].as_str() {
        write_row(&mut out, "SDK", sdk);
    }
    if let Some(pk) = data["provider_key"].as_str() {
        write_row(&mut out, "Provider", pk);
    }
    if let Some(url) = data["base_url"].as_str() {
        write_row(&mut out, "Base URL", url);
    }
    if let Some(key) = data["api_key_env"].as_str() {
        write_row(&mut out, "API key env", &format!("${key}"));
    }

    // Cache settings
    if let Some(ttl) = data["cache_ttl_secs"].as_u64() {
        if ttl > 0 {
            write_row(&mut out, "Cache TTL", &format!("{ttl}s"));
        }
    }
    if let Some(depth) = data["cache_depth"].as_u64() {
        if depth > 0 {
            write_row(&mut out, "Cache depth", &depth.to_string());
        }
    }
    if let Some(re) = data["reasoning_effort"].as_str() {
        write_row(&mut out, "Reasoning", re);
    }
    if let Some(mt) = data["max_output_tokens"].as_u64() {
        write_row(&mut out, "Max output tokens", &mt.to_string());
    }
    _ = writeln!(out);
}

/// Print effective sampler settings + which scope set each value.
/// Keys to display in `model_settings`, hiding those the model's resolved sdk
/// ignores/rejects (#162). A key is shown when its `applicability` label is
/// `"honored"` or `"always"`, or when no label is present — older daemons omit
/// the `applicability` map, in which case every key is shown (forward/backward
/// compatible).
fn visible_setting_keys<'src>(
    all_keys: &[&'src str],
    applicability: &serde_json::Value,
) -> Vec<&'src str> {
    all_keys
        .iter()
        .copied()
        .filter(
            |key| match applicability.get(*key).and_then(|v| v.as_str()) {
                Some(label) => label == "honored" || label == "always",
                None => true,
            },
        )
        .collect()
}

/// One rendered row of `print_model_settings`, collected before drawing so the
/// value and scope columns can be width-aligned.
struct SettingRow<'key> {
    key: &'key str,
    value: String,
    scope: String,
    domain: Option<String>,
}

fn print_model_settings(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let model = data["model"].as_str().unwrap_or("?");
    write_section_header(&mut out, "Model Settings", model, width);

    let sampler = data.get("effective_sampler").cloned().unwrap_or_default();
    let scopes = data.get("scopes").cloned().unwrap_or_default();
    let applicability = data.get("applicability").cloned().unwrap_or_default();
    let all_keys = [
        "temperature",
        "top_p",
        "reasoning_effort",
        "budget_tokens",
        "max_output_tokens",
        "cache_ttl",
        "cache_keepalive",
        "sdk",
        "replay_prior_thinking",
        "max_tool_iterations",
        "openrouter_provider",
        "gemini_generation",
        "zai_clear_thinking",
        "zai_subscription",
    ];
    // Capability matrix (#162): show only keys the resolved sdk honors (or
    // Shore-only keys it always applies).
    let keys = visible_setting_keys(&all_keys, &applicability);

    // Accepted `reasoning_effort` value set for this model's sdk, if provided.
    let effort_domain: Vec<&str> = data
        .get("reasoning_effort_domain")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    // Collect rows up front so value/scope columns can be aligned.
    let rows: Vec<SettingRow<'_>> = keys
        .iter()
        .map(|&key| {
            let value = match sampler.get(key) {
                Some(v) if v.is_null() => "(unset)".to_owned(),
                Some(v) => v.as_str().map_or_else(|| v.to_string(), String::from),
                None => "(unset)".to_owned(),
            };
            let scope = scopes
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("(default)")
                .to_owned();
            let domain = (key == "reasoning_effort" && !effort_domain.is_empty())
                .then(|| effort_domain.join(", "));
            SettingRow {
                key,
                value,
                scope,
                domain,
            }
        })
        .collect();

    let label_width = rows.iter().map(|r| r.key.len()).max().unwrap_or(0);
    let value_width = rows.iter().map(|r| r.value.len()).max().unwrap_or(0);
    for row in &rows {
        // `  <label>   <value>   [scope]   {domain}`, columns aligned, with the
        // label/scope/domain dimmed and the live value at full brightness.
        write_dim(&mut out, &format!("  {:<label_width$}   ", row.key));
        write_fg(
            &mut out,
            Color::White,
            &format!("{:<value_width$}", row.value),
        );
        write_dim(&mut out, &format!("   [{}]", row.scope));
        if let Some(domain) = &row.domain {
            write_dim(&mut out, &format!("   {{{domain}}}"));
        }
        _ = writeln!(out);
    }
    _ = writeln!(out);
}

/// Print confirmation after `set_model_setting`.
fn print_set_model_setting(data: &serde_json::Value) {
    let key = data["key"].as_str().unwrap_or("?");
    let scope = data["scope"].as_str().unwrap_or("?");
    let value = match data.get("value") {
        Some(v) if v.is_null() => "(cleared)".to_owned(),
        Some(v) => v.as_str().map_or_else(|| v.to_string(), String::from),
        None => "(cleared)".to_owned(),
    };
    let model = data["model"].as_str().unwrap_or("?");
    cli_out!("[{scope}] {key} = {value}  ({})", abbreviate_model(model));
}

/// Print the configured provider list with key + cache status.
fn print_provider_list(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    write_section_header(&mut out, "Providers", "", width);

    let providers = match data["providers"].as_array() {
        Some(p) if !p.is_empty() => p,
        _ => {
            print_dim_line(&mut out, "(no providers configured)");
            _ = writeln!(out);
            return;
        }
    };

    for p in providers {
        let name = p["name"].as_str().unwrap_or("?");
        let enabled = p["enabled"].as_bool().unwrap_or(true);
        let sdk = p["sdk"].as_str().unwrap_or("?");
        let base_url = p["base_url"].as_str().unwrap_or("");
        let discovery = p["discovery_enabled"].as_bool().unwrap_or(false);

        // Header line: bold provider name + sdk tag, dim base_url.
        if use_color() {
            let _ignored = crossterm::execute!(out, SetAttribute(Attribute::Bold));
        }
        _ = write!(out, "  {name}");
        if use_color() {
            _ = crossterm::execute!(out, SetAttribute(Attribute::Reset));
        }
        if !enabled {
            write_fg(&mut out, Color::Yellow, "  [disabled]");
        }
        if discovery {
            write_dim(&mut out, "  [discovery]");
        }
        _ = writeln!(out);

        write_row(&mut out, "SDK", sdk);
        if !base_url.is_empty() {
            write_row(&mut out, "Base URL", base_url);
        }

        if let Some(keys) = p["keys"].as_array() {
            if keys.is_empty() {
                write_row(&mut out, "Keys", "(none configured)");
            } else {
                let mut parts: Vec<String> = Vec::new();
                for k in keys {
                    let kn = k["name"].as_str().unwrap_or("?");
                    let env_set = k["env_set"].as_bool().unwrap_or(false);
                    let warn = k["warn_on_fallback"].as_bool().unwrap_or(false);
                    let mark = if env_set { "set" } else { "missing" };
                    let warn_tag = if warn { "*" } else { "" };
                    parts.push(format!("{kn}{warn_tag}={mark}"));
                }
                write_row(&mut out, "Keys", &parts.join(", "));
            }
        }

        let cache = &p["cache"];
        if cache["present"].as_bool().unwrap_or(false) {
            let total = cache["models"].as_u64().unwrap_or(0);
            let visible = cache["visible"].as_u64().unwrap_or(total);
            let hidden = cache["hidden"].as_u64().unwrap_or(0);
            let fetched = cache["fetched_at"].as_str().unwrap_or("?");
            let summary = if hidden > 0 {
                format!("{visible} visible / {hidden} hidden / {total} total · fetched {fetched}")
            } else {
                format!("{total} models · fetched {fetched}")
            };
            write_row(&mut out, "Cache", &summary);
        } else {
            write_row(
                &mut out,
                "Cache",
                "(empty — `shore provider refresh <name>`)",
            );
        }
        _ = writeln!(out);
    }
}

/// Print discovered + static models for a single provider.
fn print_provider_models(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let provider = data["provider"].as_str().unwrap_or("?");
    let include_hidden = data["include_hidden"].as_bool().unwrap_or(false);
    let suffix = if include_hidden { "all" } else { "" };
    write_section_header(&mut out, &format!("Provider — {provider}"), suffix, width);

    let static_models = data["static"].as_array().cloned().unwrap_or_default();
    if !static_models.is_empty() {
        write_dim(&mut out, "  static\n");
        for m in &static_models {
            let name = m["name"].as_str().unwrap_or("?");
            let id = m["model_id"].as_str().unwrap_or("?");
            _ = writeln!(out, "    {name:<28}{id}");
        }
        _ = writeln!(out);
    }

    let discovered = data["discovered"].as_array().cloned().unwrap_or_default();
    if !discovered.is_empty() {
        write_dim(&mut out, "  discovered\n");
        for m in &discovered {
            let id = m["model_id"].as_str().unwrap_or("?");
            let display = m["display_name"].as_str().unwrap_or("");
            if display.is_empty() {
                _ = writeln!(out, "    {id}");
            } else {
                _ = writeln!(out, "    {id:<48}{display}");
            }
        }
        _ = writeln!(out);
    }

    let hidden = data["hidden"].as_array().cloned().unwrap_or_default();
    if !hidden.is_empty() {
        write_dim(
            &mut out,
            &format!("  hidden ({} — pass --all to include)\n", hidden.len()),
        );
        for m in &hidden {
            let id = m["model_id"].as_str().unwrap_or("?");
            _ = writeln!(out, "    {id}");
        }
        _ = writeln!(out);
    }

    if static_models.is_empty() && discovered.is_empty() && hidden.is_empty() {
        print_dim_line(
            &mut out,
            "no models — run `shore provider refresh <name>` if discovery is configured",
        );
        _ = writeln!(out);
    }

    if let Some(cache) = data.get("cache") {
        if let Some(fetched) = cache["fetched_at"].as_str() {
            write_dim(&mut out, &format!("  cache fetched {fetched}\n"));
        }
    }
}

/// Print the result of `shore provider refresh <name>`.
fn print_provider_refresh(data: &serde_json::Value) {
    let provider = data["provider"].as_str().unwrap_or("?");
    let count = data["model_count"].as_u64().unwrap_or(0);
    let fetched = data["fetched_at"].as_str().unwrap_or("?");
    cli_out!("Refreshed {provider}: {count} models (fetched {fetched})");
}

/// Print the result of `shore provider refresh` (no name) — one row per
/// provider with ok/FAIL status, plus a `skipped` section listing every
/// provider that was excluded with a reason.
fn print_provider_refresh_all(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    write_section_header(&mut out, "Provider refresh", "all", width);

    let mut ok_count: u64 = 0;
    let mut fail_count: u64 = 0;

    if let Some(results) = data["results"].as_array() {
        for r in results {
            let provider = r["provider"].as_str().unwrap_or("?");
            let ok = r["ok"].as_bool().unwrap_or(false);
            if ok {
                ok_count = ok_count.saturating_add(1);
                let count = r["model_count"].as_u64().unwrap_or(0);
                let fetched = r["fetched_at"].as_str().unwrap_or("?");
                if use_color() {
                    let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Green));
                    _ = write!(out, "  ok  ");
                    _ = crossterm::execute!(out, ResetColor);
                } else {
                    _ = write!(out, "  ok  ");
                }
                _ = writeln!(out, "{provider}: {count} models (fetched {fetched})");
            } else {
                fail_count = fail_count.saturating_add(1);
                let err = r["error"].as_str().unwrap_or("unknown error");
                if use_color() {
                    let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Red));
                    _ = write!(out, "  FAIL");
                    _ = crossterm::execute!(out, ResetColor);
                } else {
                    _ = write!(out, "  FAIL");
                }
                _ = writeln!(out, " {provider}: {err}");
            }
        }
    }

    if let Some(skipped) = data["skipped"].as_array() {
        if !skipped.is_empty() {
            _ = writeln!(out);
            write_section_header(&mut out, "Skipped", "", width);
            for s in skipped {
                let provider = s["provider"].as_str().unwrap_or("?");
                let reason = s["reason"].as_str().unwrap_or("?");
                if use_color() {
                    _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
                }
                _ = writeln!(out, "  {provider}: {reason}");
                if use_color() {
                    _ = crossterm::execute!(out, ResetColor);
                }
            }
        }
    }

    _ = writeln!(out);
    _ = writeln!(
        out,
        "Refreshed {ok_count} provider(s); {fail_count} failed."
    );
}

/// Print character info.
fn print_character_info(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let name = data["name"].as_str().unwrap_or("?");
    let char_color = character_color(name);

    write_section_header(&mut out, "Character", "", width);
    write_row_colored(&mut out, "Name", name, char_color);

    let active = data["active"].as_bool().unwrap_or(false);
    if active {
        write_row_colored(&mut out, "Active", "yes", Color::Green);
    }

    if let Some(dir) = data["config_dir"].as_str() {
        write_row(&mut out, "Config", dir);
    }

    let has_def = data["has_definition"].as_bool().unwrap_or(false);
    let has_user = data["has_user_definition"].as_bool().unwrap_or(false);
    write_row(&mut out, "Definition", if has_def { "yes" } else { "no" });
    if has_user {
        write_row(&mut out, "User def", "yes");
    }

    if data["has_config_override"].as_bool().unwrap_or(false) {
        write_row_colored(&mut out, "Config override", "yes", Color::Yellow);
    }

    if let Some(overrides) = data["prompt_overrides"].as_array() {
        if !overrides.is_empty() {
            let names: Vec<&str> = overrides.iter().filter_map(|v| v.as_str()).collect();
            write_row(&mut out, "Prompts", &names.join(", "));
        }
    }

    if let Some(dir) = data["data_dir"].as_str() {
        write_row(&mut out, "Data", dir);
    }

    // Definition preview
    if let Some(preview) = data["definition_preview"].as_str() {
        if !preview.is_empty() {
            _ = writeln!(out);
            write_section_header(&mut out, "Preview", "", width);
            // Show first few lines, dimmed
            if use_color() {
                _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
            }
            for line in preview.lines().take(8) {
                _ = writeln!(out, "  {line}");
            }
            if use_color() {
                _ = crossterm::execute!(out, ResetColor);
            }
        }
    }
    _ = writeln!(out);
}

/// Print memory status or query result.
fn print_memory(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    // If there's a "result" field, this is a query response.
    if let Some(result) = data["result"].as_str() {
        _ = writeln!(out, "{result}");
        return;
    }

    // Otherwise it's a status response.
    let char_name = data["character"].as_str().unwrap_or("?");
    write_section_header(&mut out, "Memory", char_name, width);

    let files = data["entries"].as_u64().unwrap_or(0);
    let curated = data["curated_files"].as_u64().unwrap_or(0);
    let daily = data["daily_files"].as_u64().unwrap_or(0);
    let images = data["image_files"].as_u64().unwrap_or(0);

    write_row(&mut out, "Files", &files.to_string());
    if files > 0 {
        write_row(
            &mut out,
            "Breakdown",
            &format!("{curated} curated, {daily} daily, {images} images"),
        );
    }
    _ = writeln!(out);
}

/// Print compaction result.
fn print_compact_result(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let status = data["status"].as_str().unwrap_or("?");
    let suffix = if status == "dry_run" { "dry run" } else { "" };
    write_section_header(&mut out, "Compaction", suffix, width);

    let char_name = data["character"].as_str().unwrap_or("?");
    write_row(&mut out, "Character", char_name);

    if status == "dry_run" {
        let would = data["would_write_files"].as_u64().unwrap_or(0);
        write_row(&mut out, "Would write", &format!("{would} files"));
        let turns = data["compacted_turns"]
            .as_u64()
            .or_else(|| data["turn_count"].as_u64())
            .unwrap_or(0);
        let retained_turns = data["retained_turns"].as_u64().unwrap_or(0);
        write_row(
            &mut out,
            "Turns",
            &format!("{turns} compacted, {retained_turns} retained"),
        );
    } else {
        let files = data["memory_files_written"].as_array().map_or(0, Vec::len);
        write_row(&mut out, "Memory files", &format!("{files} written"));
        let turns = data["compacted_turns"]
            .as_u64()
            .or_else(|| data["turn_count"].as_u64())
            .unwrap_or(0);
        let retained_turns = data["retained_turns"].as_u64().unwrap_or(0);
        write_row(
            &mut out,
            "Turns",
            &format!("{turns} compacted, {retained_turns} retained"),
        );
    }

    _ = writeln!(out);
}

/// Print config display.
pub(crate) fn print_config(data: &serde_json::Value, show_all: bool) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    // Config set confirmation: { "set": "key", "value": ... }
    if let Some(key) = data["set"].as_str() {
        let value = &data["value"];
        _ = writeln!(out, "Set {key} = {value}");
        return;
    }

    // Section view: { "key": "name", "config": { ... }, "defaults": { ... } }
    if let Some(key) = data["key"].as_str() {
        // The daemon scopes `defaults` to the section for us.
        let section_default = data.get("defaults");
        write_section_header(&mut out, "Config", key, width);
        print_config_section(&mut out, &data["config"], section_default, 1, show_all);
        _ = writeln!(out);
        return;
    }

    // Full config: { "config": { ... }, "defaults": { ... } }
    if let Some(config) = data.get("config") {
        let defaults = data.get("defaults");
        write_section_header(&mut out, "Config", "", width);
        print_config_section(&mut out, config, defaults, 1, show_all);
        _ = writeln!(out);
    }
}

/// Render a scalar value to its display string (matches the original formatter).
fn render_config_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Array(arr) if arr.is_empty() => "(none)".to_owned(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .map(|i| i.as_str().map_or_else(|| i.to_string(), String::from))
            .collect::<Vec<_>>()
            .join(", "),
        serde_json::Value::Null | serde_json::Value::Object(_) => v.to_string(),
    }
}

/// Returns true if `value` contains at least one leaf that differs from its
/// corresponding entry in `defaults` (or has no default to compare against).
/// Used to decide whether a subtable header is worth showing when defaults
/// are hidden.
fn has_non_defaults(value: &serde_json::Value, defaults: Option<&serde_json::Value>) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Object(map) => map.iter().any(|(k, v)| {
            let d = defaults.and_then(|dd| dd.get(k));
            has_non_defaults(v, d)
        }),
        leaf @ (serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_)
        | serde_json::Value::Array(_)) => defaults.is_none_or(|d| d != leaf),
    }
}

/// Recursively print config as indented key-value pairs.
///
/// Column width is computed per parent table from the visible scalar keys, so
/// each section aligns its own values without bleeding into sibling sections.
/// When `show_all` is false, leaves that equal the default are skipped and
/// subtables with no non-default descendants are collapsed.
fn print_config_section(
    out: &mut impl Write,
    value: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
    depth: usize,
    show_all: bool,
) {
    let indent = "  ".repeat(depth);
    let serde_json::Value::Object(map) = value else {
        // `render_config_value`, not `{value}`: a dotted read lands here with a
        // bare leaf, and serde's Display would print a string in quotes and an
        // array as JSON — neither of which is how the same leaf renders one
        // line up inside its section.
        _ = writeln!(out, "{indent}{}", render_config_value(value));
        return;
    };

    // First pass: filter to entries we'll actually render and classify them.
    let mut visible: Vec<(
        &str,
        &serde_json::Value,
        Option<&serde_json::Value>,
        bool,
        bool,
    )> = Vec::new();
    for (k, v) in map {
        let d = defaults.and_then(|dd| dd.get(k));
        match v {
            serde_json::Value::Null => {}
            serde_json::Value::Object(_) => {
                if show_all || has_non_defaults(v, d) {
                    visible.push((k.as_str(), v, d, true, false));
                }
            }
            serde_json::Value::Array(items) if is_table_array(items) => {
                if show_all || has_non_defaults(v, d) {
                    visible.push((k.as_str(), v, d, true, false));
                }
            }
            serde_json::Value::Bool(_)
            | serde_json::Value::Number(_)
            | serde_json::Value::String(_)
            | serde_json::Value::Array(_) => {
                let is_default = d.is_some_and(|dd| dd == v);
                if !show_all && is_default {
                    continue;
                }
                visible.push((k.as_str(), v, d, false, is_default));
            }
        }
    }

    // Per-section column: max scalar key length + 1 space. Subtable headers
    // ("key:") don't share a column with scalar rows.
    let scalar_width = visible
        .iter()
        .filter(|(_, _, _, is_sub, _)| !is_sub)
        .map(|(k, _, _, _, _)| k.len())
        .max()
        .map_or(0, |m| m.saturating_add(1));

    for (k, v, d, is_subtable, is_default) in visible {
        if is_subtable {
            if use_color() {
                let _ignored = crossterm::execute!(out, SetForegroundColor(Color::White));
            }
            _ = writeln!(out, "{indent}{k}:");
            if use_color() {
                _ = crossterm::execute!(out, ResetColor);
            }
            if let serde_json::Value::Array(items) = v {
                print_config_table_array(out, items, depth.saturating_add(1), show_all);
            } else {
                print_config_section(out, v, d, depth.saturating_add(1), show_all);
            }
        } else {
            // Default rows (only reachable with show_all): whole line dimmed.
            // Non-default rows: key dimmed, value in the default terminal color
            // so customizations visually pop.
            if use_color() {
                let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
            }
            _ = write!(out, "{indent}{k:<scalar_width$}");
            if use_color() && !is_default {
                _ = crossterm::execute!(out, ResetColor);
            }
            _ = writeln!(out, "{}", render_config_value(v));
            if use_color() && is_default {
                _ = crossterm::execute!(out, ResetColor);
            }
        }
    }
}

/// True for a non-empty array whose every element is an object -- TOML's array
/// of tables, e.g. `[[usage.budgets]]`.
fn is_table_array(items: &[serde_json::Value]) -> bool {
    !items.is_empty() && items.iter().all(serde_json::Value::is_object)
}

/// Render an array of tables as one labelled block per element.
///
/// Without this each element fell through `render_config_value`'s array arm,
/// which stringifies a non-string element -- so a `[[usage.budgets]]` entry
/// printed as a single line of raw JSON, every null field included, in a
/// section where nothing else looks remotely like that.
///
/// The label is the element's `name` where it has one, since that is what the
/// same budget is called everywhere else, and its index otherwise.
fn print_config_table_array(
    out: &mut impl Write,
    items: &[serde_json::Value],
    depth: usize,
    show_all: bool,
) {
    let indent = "  ".repeat(depth);
    for (i, item) in items.iter().enumerate() {
        let label = item["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map_or_else(|| format!("[{i}]"), String::from);
        if use_color() {
            let _ignored = crossterm::execute!(out, SetForegroundColor(Color::White));
        }
        _ = writeln!(out, "{indent}{label}:");
        if use_color() {
            _ = crossterm::execute!(out, ResetColor);
        }
        let named = item["name"].as_str().is_some_and(|s| s == label);
        let body = if named {
            let mut rest = item.clone();
            if let Some(map) = rest.as_object_mut() {
                _ = map.shift_remove("name");
            }
            rest
        } else {
            item.clone()
        };
        print_config_section(out, &body, None, depth.saturating_add(1), show_all);
    }
}

/// Print config check results.
/// Render the `shore tools` surface: per-tool main-character enablement, the
/// sub-agent roster and the tools each owns, the `exec` allowlist, and any
/// dangling-config warnings, all from the SWP `tools` query payload.
fn print_tools(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    write_section_header(&mut out, "Tools", "surface", width);

    // Per-tool: enablement on the main character + sub-agent owners.
    if let Some(tools) = data["tools"].as_array() {
        for t in tools {
            let name = t["tool"].as_str().unwrap_or("?");
            let main = t["main"].as_bool().unwrap_or(false);
            let owners: Vec<&str> = t["subagents"]
                .as_array()
                .map(|a| a.iter().filter_map(|s| s.as_str()).collect())
                .unwrap_or_default();

            if use_color() {
                _ = crossterm::execute!(
                    out,
                    SetForegroundColor(if main { Color::Green } else { Color::DarkGrey })
                );
            }
            _ = write!(out, "  {} ", if main { "✓" } else { "·" });
            if use_color() {
                _ = crossterm::execute!(out, ResetColor);
            }
            let owners_str = if owners.is_empty() {
                String::new()
            } else {
                format!("  ← {}", owners.join(", "))
            };
            _ = writeln!(out, "{name:<20}{owners_str}");
        }
    }
    _ = writeln!(out);

    // Sub-agent roster.
    if let Some(subs) = data["subagents"].as_array() {
        if !subs.is_empty() {
            write_row(&mut out, "Sub-agents", "");
            for s in subs {
                let name = s["name"].as_str().unwrap_or("?");
                let enabled = s["enabled"].as_bool().unwrap_or(false);
                let tools: Vec<&str> = s["tools"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
                    .unwrap_or_default();
                let model = s["model"].as_str().unwrap_or("(default)");
                let mark = if enabled { "ask_" } else { "(disabled) " };
                _ = writeln!(out, "  {mark}{name}  [{}]  {model}", tools.join(", "));
            }
            _ = writeln!(out);
        }
    }

    // Dangling references.
    if let Some(warnings) = data["warnings"].as_array() {
        for w in warnings {
            if let Some(msg) = w.as_str() {
                if use_color() {
                    _ = crossterm::execute!(out, SetForegroundColor(Color::DarkYellow));
                }
                _ = write!(out, "  ! ");
                if use_color() {
                    _ = crossterm::execute!(out, ResetColor);
                }
                _ = writeln!(out, "{msg}");
            }
        }
    }
    _ = writeln!(out);
}

fn print_config_check(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let valid = data["valid"].as_bool().unwrap_or(false);
    let suffix = if valid { "valid" } else { "warnings" };
    write_section_header(&mut out, "Config Check", suffix, width);

    if let Some(dir) = data["config_dir"].as_str() {
        write_row(&mut out, "Config dir", dir);
    }
    if let Some(dir) = data["data_dir"].as_str() {
        write_row(&mut out, "Data dir", dir);
    }

    let chat = data["chat_models"].as_u64().unwrap_or(0);
    let embed = data["embedding_models"].as_u64().unwrap_or(0);
    write_row(
        &mut out,
        "Models",
        &format!("{chat} chat, {embed} embedding"),
    );

    _ = writeln!(out);

    // Warnings
    if let Some(warnings) = data["warnings"].as_array() {
        for w in warnings {
            if let Some(msg) = w.as_str() {
                if use_color() {
                    _ = crossterm::execute!(out, SetForegroundColor(Color::DarkYellow));
                }
                _ = write!(out, "  ! ");
                if use_color() {
                    _ = crossterm::execute!(out, ResetColor);
                }
                _ = writeln!(out, "{msg}");
            }
        }
    }

    // Info
    if let Some(info) = data["info"].as_array() {
        for i in info {
            if let Some(msg) = i.as_str() {
                if use_color() {
                    _ = crossterm::execute!(out, SetForegroundColor(Color::Green));
                }
                _ = write!(out, "  ");
                if use_color() {
                    _ = crossterm::execute!(out, ResetColor);
                }
                _ = writeln!(out, "{msg}");
            }
        }
    }
    _ = writeln!(out);
}

/// Print config reload result: what was reloaded, whether system prompt
/// edits were activated, and any sections that still need a daemon restart.
fn print_config_reload(data: &serde_json::Value) {
    let path = data["config_path"].as_str().unwrap_or("config");
    cli_out!("Configuration reloaded from {path}");

    let changed: Vec<&str> = data["changed_prompt_files"]
        .as_array()
        .map(|files| files.iter().filter_map(|f| f.as_str()).collect())
        .unwrap_or_default();
    if data["prompts_refreshed"].as_bool().unwrap_or(false) {
        cli_out!(
            "System prompt refreshed: {} (next message pays a one-time cache write)",
            changed.join(", ")
        );
    } else if !changed.is_empty() {
        cli_out!(
            "System prompt files left inactive: {} (activate with `shore config reload --yes` or at the next compaction)",
            changed.join(", ")
        );
    } else {
        // No pending prompt edits — nothing to report.
    }

    if let Some(sections) = data["restart_required"].as_array() {
        if !sections.is_empty() {
            let list: Vec<&str> = sections.iter().filter_map(|s| s.as_str()).collect();
            cli_out!(
                "Restart shore-daemon to apply startup-owned changes: {}",
                list.join(", ")
            );
        }
    }
}

/// Print config reset confirmation.
fn print_config_reset(data: &serde_json::Value) {
    let msg = data["message"]
        .as_str()
        .unwrap_or("Configuration reloaded from disk");
    cli_out!("{msg}");
}

/// Print diagnostics from ring buffers.
pub(crate) fn print_diagnostics(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    // -- API Calls --
    print_diagnostics_section(
        &mut out,
        "API Calls",
        &data["api_calls"],
        width,
        |w, call| {
            let model = abbreviate_model(call["model"].as_str().unwrap_or("?"));
            let input = call["input_tokens"].as_u64().unwrap_or(0);
            let output_t = call["output_tokens"].as_u64().unwrap_or(0);
            let cr = call["cache_read_tokens"].as_u64().unwrap_or(0);
            let cw = call["cache_write_tokens"].as_u64().unwrap_or(0);
            let total = call["total_ms"].as_u64().unwrap_or(0);
            let secs = format_millis_as_seconds_one_decimal(total);

            _ = write!(w, "{model:<24}");
            write_dim(
                w,
                &format!("in:{input:<5} out:{output_t:<5} cache:{cr}/{cw}  {secs}s"),
            );

            if let Some(err) = call.get("error").filter(|v| !v.is_null()) {
                write_fg(
                    w,
                    Color::Red,
                    &format!("  ERR: {}", err.as_str().unwrap_or("?")),
                );
            }
            _ = writeln!(w);
        },
    );

    // -- Tool Calls --
    print_diagnostics_section(
        &mut out,
        "Tool Calls",
        &data["tool_calls"],
        width,
        |w, call| {
            let name = call["tool_name"].as_str().unwrap_or("?");
            let dur = call["duration_ms"].as_u64().unwrap_or(0);
            let ok = call["success"].as_bool().unwrap_or(true);

            _ = write!(w, "{name:<24}");
            write_dim(w, &format!("{dur}ms  "));
            let (marker_color, marker_text) = if ok {
                (Color::Green, "ok")
            } else {
                (Color::Red, "FAIL")
            };
            write_fg(w, marker_color, marker_text);
            _ = writeln!(w);
        },
    );

    // -- Errors --
    print_diagnostics_section(&mut out, "Errors", &data["errors"], width, |w, err| {
        let etype = err["error_type"].as_str().unwrap_or("?");
        let msg = err["message"].as_str().unwrap_or("?");

        write_fg(w, Color::Red, &format!("{etype:<12}"));
        _ = writeln!(w, "{msg}");
    });
}

/// Print a diagnostics section with a header, shared timestamp formatting,
/// and a per-entry formatter.
fn print_diagnostics_section<W: Write>(
    out: &mut W,
    title: &str,
    section: &serde_json::Value,
    width: usize,
    mut format_row: impl FnMut(&mut W, &serde_json::Value),
) {
    let count = section["count"].as_u64().unwrap_or(0);
    write_section_header(out, title, &format!("{count} total"), width);

    if let Some(entries) = section["recent"].as_array() {
        if entries.is_empty() {
            print_dim_line(out, "(none)");
        } else {
            for entry in entries {
                let ts = entry["timestamp"].as_str().unwrap_or("");
                let time = parse_timestamp(ts).map_or_else(
                    || ts.chars().take(8).collect(),
                    |dt| dt.format("%H:%M:%S").to_string(),
                );

                write_dim(out, &format!("  {time}  "));
                format_row(out, entry);
            }
        }
    }
    _ = writeln!(out);
}

fn format_k(tokens: u64) -> String {
    if tokens == 0 {
        "\u{2014}".into()
    } else if tokens < 1000 {
        tokens.to_string()
    } else {
        let rounded_tenths = checked_div_u64(tokens.saturating_add(50), 100);
        let whole = checked_div_u64(rounded_tenths, 10);
        let decimal = checked_rem_u64(rounded_tenths, 10);
        format!("{whole}.{decimal}K")
    }
}

/// Truncate `s` so it fits in `max_width` display columns, appending `…` when
/// truncation occurs. Width is counted in chars (the table columns assume
/// monospace single-width glyphs).
fn ellipsize(s: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    let count = s.chars().count();
    if count <= max_width {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max_width.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

/// Render an RFC 3339 timestamp as the user's local clock time in
/// `YYYY-MM-DD HH:MM AM|PM` form (e.g. `2026-05-23 10:00 AM`). The raw daemon
/// payload is always UTC; converting to local with AM/PM makes the value
/// match the configured anchor at a glance.
fn format_local_ampm(rfc3339: &str) -> String {
    parse_timestamp(rfc3339).map_or_else(
        || rfc3339.to_owned(),
        |dt| dt.format("%Y-%m-%d %I:%M %p").to_string(),
    )
}

/// Time columns match the width of `format_local_ampm`'s output
/// (`YYYY-MM-DD HH:MM AM` = 19 chars); raw-string fallbacks are ellipsized
/// to the same width so the divider always spans the table. `Started`
/// shows when the current window opened (so a user with `reset_hour=10`
/// can see why the budget total isn't the same as today's summary).
const TIME_W: usize = 19;

/// Width of a pace row's label so its `Spend` column starts where the budget
/// row's does: the budget row's name+period fields span `24 + 1 + 6 + 1 = 32`
/// columns, and the pace row spends 4 on its `└ ` prefix plus 1 on the trailing
/// separator.
const PACE_LABEL_W: usize = 27;

fn print_budget_table(data: &serde_json::Value) {
    let budgets = data["budgets"].as_array();
    if budgets.is_none_or(Vec::is_empty) {
        cli_out!("  No usage budgets configured.");
        return;
    }

    let table_w = 24 + 1 + 6 + 1 + 11 + 1 + 7 + 2 + 15 + 1 + 16 + 1 + TIME_W + 1 + TIME_W;

    cli_out!(
        "{:<24} {:<6} {:>11} {:>7}  {:<15} {:<16} {:<TIME_W$} {:<TIME_W$}",
        "Budget",
        "Period",
        "Spend",
        "Used",
        "Status",
        "Action",
        "Started",
        "Resets"
    );
    cli_out!("{}", "-".repeat(table_w));
    if let Some(rows) = budgets {
        for budget in rows {
            let current = budget["current_cost"].as_f64().unwrap_or(0.0);
            let limit = budget["cost_limit"].as_f64().unwrap_or(0.0);
            #[expect(
                clippy::float_arithmetic,
                reason = "budget payload stores used share as f64; CLI scales it for percent display"
            )]
            let percent = budget["percent_used"].as_f64().unwrap_or(0.0) * 100.0;
            let started = budget["period_start"]
                .as_str()
                .map(format_local_ampm)
                .map_or_else(|| "?".into(), |s| ellipsize(&s, TIME_W));
            let reset = budget["reset_at"]
                .as_str()
                .map(format_local_ampm)
                .map_or_else(|| "?".into(), |s| ellipsize(&s, TIME_W));
            cli_out!(
                "{:<24} {:<6} {:>5.2}/{:<5.2} {:>6.0}%  {:<15} {:<16} {started:<TIME_W$} {reset:<TIME_W$}",
                budget["name"].as_str().unwrap_or("budget"),
                budget["period"].as_str().unwrap_or("day"),
                current,
                limit,
                percent,
                budget["status"].as_str().unwrap_or("ok"),
                acting_now(budget),
            );
            if let Some(row) = pace_row(budget) {
                cli_out!("{row}");
            }
        }
    }
}

/// Continuation line for a budget that configures a pace, or `None` when it
/// doesn't.
///
/// Rendered under its budget rather than as extra columns: the table is already
/// ~104 wide, and the pace's "spend against today's allowance" is a different
/// measurement from the period totals above it.
fn pace_row(budget: &serde_json::Value) -> Option<String> {
    let pace = &budget["pace"];
    if !pace.is_object() {
        return None;
    }

    let current = pace["current_cost"].as_f64().unwrap_or(0.0);
    let allowance = pace["allowance"].as_f64().unwrap_or(0.0);
    #[expect(
        clippy::float_arithmetic,
        reason = "pace payload stores used share as f64; CLI scales it for percent display"
    )]
    let percent = pace["percent_used"].as_f64().unwrap_or(0.0) * 100.0;
    let started = pace["window_start"]
        .as_str()
        .map(format_local_ampm)
        .map_or_else(|| "?".into(), |s| ellipsize(&s, TIME_W));
    let resets = pace["window_end"]
        .as_str()
        .map(format_local_ampm)
        .map_or_else(|| "?".into(), |s| ellipsize(&s, TIME_W));

    let row = format!(
        "  \u{2514} {:<PACE_LABEL_W$} {:>5.2}/{:<5.2} {:>6.0}%  {:<15} {:<16} {started:<TIME_W$} {resets:<TIME_W$}",
        format!("{} pace", pace["period"].as_str().unwrap_or("day")),
        current,
        allowance,
        percent,
        pace["status"].as_str().unwrap_or("ok"),
        acting_now(pace),
    );
    let Some(base) = pace["base_allowance"].as_f64() else {
        return Some(row);
    };
    let rollover = pace["rollover"].as_f64().unwrap_or(0.0);
    let debt = pace["debt_adjustment"].as_f64().unwrap_or(0.0);
    Some(format!(
        "{row}\n      base ${base:.2}  + rollover ${rollover:.2}  - debt adjustment ${debt:.2}"
    ))
}

/// The action in force at the current spend, for the `Action` column.
///
/// `action` is what happens at the *limit*. A budget in `warning` has not
/// reached its limit, so a row that printed `action` claimed `warn` while a
/// configured `warn_action` or `pace_warn_action` was already pausing
/// heartbeats. `effective_action` is the daemon resolving the two; the fallback
/// keeps this readable against an older daemon that doesn't send it.
fn acting_now(status: &serde_json::Value) -> &str {
    status["effective_action"]
        .as_str()
        .or_else(|| status["action"].as_str())
        .unwrap_or("warn")
}

fn usage_display_date(data: &serde_json::Value) -> String {
    if data["timezone"].as_str() == Some("utc") {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    } else {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    }
}

/// Render the per-provider/model summary table for `shore usage`.
///
/// Column widths for `Provider` and `Model` are computed from the rendered
/// rows so that an oversized name (e.g. `openrouter-anthropic`) can no longer
/// shove every subsequent value under the wrong header. Values that exceed
/// the per-column cap are truncated with `…`.
fn write_usage_summary_table(out: &mut impl Write, data: &serde_json::Value) -> io::Result<()> {
    const PROVIDER_HEADER: &str = "Provider";
    const MODEL_HEADER: &str = "Model";
    // Caps keep one freakishly long name from blowing the table out across
    // the terminal; anything longer is truncated with `…`.
    const MAX_PROVIDER_W: usize = 28;
    const MAX_MODEL_W: usize = 40;

    let period = data["period"].as_str().unwrap_or("today");
    let today = usage_display_date(data);
    writeln!(out, "Shore Usage \u{2014} {today} (period: {period})\n")?;

    let summary = data["summary"].as_array();

    let mut provider_w = PROVIDER_HEADER.chars().count();
    let mut model_w = MODEL_HEADER.chars().count();
    if let Some(rows) = summary {
        for s in rows {
            if let Some(p) = s["provider"].as_str() {
                provider_w = provider_w.max(p.chars().count());
            }
            if let Some(m) = s["model"].as_str() {
                model_w = model_w.max(m.chars().count());
            }
        }
    }
    provider_w = provider_w.min(MAX_PROVIDER_W);
    model_w = model_w.min(MAX_MODEL_W);

    writeln!(
        out,
        "{:<provider_w$} {:<model_w$} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
        PROVIDER_HEADER, MODEL_HEADER, "Calls", "Input", "Output", "Cache R", "Cache W", "Cost"
    )?;

    let total_w = [provider_w, 1, model_w, 1, 5, 2, 9, 2, 9, 2, 9, 2, 9, 2, 8]
        .into_iter()
        .fold(0_usize, usize::saturating_add);
    writeln!(out, "{}", "-".repeat(total_w))?;

    let mut grand_total = 0.0_f64;
    if let Some(rows) = summary {
        for s in rows {
            let cost_str = s["total_cost"].as_f64().map_or_else(
                || "\u{2014}".into(),
                |c| {
                    add_display_cost(&mut grand_total, c);
                    format!("${c:.2}")
                },
            );
            let provider = ellipsize(s["provider"].as_str().unwrap_or(""), provider_w);
            let model = ellipsize(s["model"].as_str().unwrap_or(""), model_w);
            writeln!(
                out,
                "{provider:<provider_w$} {model:<model_w$} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
                s["call_count"].as_u64().unwrap_or(0),
                format_k(s["total_input"].as_u64().unwrap_or(0)),
                format_k(s["total_output"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_read"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_write"].as_u64().unwrap_or(0)),
                cost_str,
            )?;
        }
        if rows.is_empty() {
            writeln!(out, "  No usage data for this period.")?;
        } else {
            // "Total:" sits in the column space before Cost; the dollar amount
            // right-aligns inside the 8-char Cost column so it lines up with
            // the per-row costs above it.
            let label_w = total_w.saturating_sub(9);
            let total_str = format!("${grand_total:.2}");
            writeln!(out, "{:>label_w$} {total_str:>8}", "Total:")?;
        }
    }
    Ok(())
}

pub(crate) fn print_usage(data: &serde_json::Value) {
    let mode = data["mode"].as_str().unwrap_or("summary");

    match mode {
        "tsv" | "csv" => {
            if let Some(d) = data["data"].as_str() {
                cli_write!("{d}");
            }
        }
        "summary_by_call_type" => print_usage_by_call_type(data),
        "summary_by_usage_kind" => print_usage_by_kind(data),
        "summary_by_api_key" => print_usage_by_api_key(data),
        "budget" => {
            let today = usage_display_date(data);
            let timezone = data["timezone"].as_str().unwrap_or("local");
            cli_out!("Shore Usage Budgets - {today} (timezone: {timezone})\n");
            print_budget_table(data);
        }
        "anomalies" => print_usage_anomalies(data),
        "refresh_pricing" => {
            cli_out!("Pricing cache cleared. Prices will be re-fetched on next daemon use.");
        }
        "recalculate" => print_usage_recalculate(data),
        _ => print_usage_summary(data),
    }
}

/// Render the `usage --by-call-type` breakdown table.
fn print_usage_by_call_type(data: &serde_json::Value) {
    let period = data["period"].as_str().unwrap_or("today");
    let today = usage_display_date(data);
    cli_out!("Shore Usage by Call Type \u{2014} {today} (period: {period})\n");
    cli_out!(
        "{:<18} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
        "Call Type",
        "Calls",
        "Input",
        "Output",
        "Cache R",
        "Cache W",
        "Cost"
    );
    cli_out!("{}", "-".repeat(78));
    let summary = data["summary"].as_array();
    let mut grand_total = 0.0_f64;
    if let Some(rows) = summary {
        for s in rows {
            let cost_str = s["total_cost"].as_f64().map_or_else(
                || "\u{2014}".into(),
                |c| {
                    add_display_cost(&mut grand_total, c);
                    format!("${c:.2}")
                },
            );
            cli_out!(
                "{:<18} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
                s["call_type"].as_str().unwrap_or(""),
                s["call_count"].as_u64().unwrap_or(0),
                format_k(s["total_input"].as_u64().unwrap_or(0)),
                format_k(s["total_output"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_read"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_write"].as_u64().unwrap_or(0)),
                cost_str,
            );
        }
        if rows.is_empty() {
            cli_out!("  No usage data for this period.");
        } else {
            cli_out!("{:>70} ${grand_total:.2}", "Total:");
        }
    }
}

/// Render the `usage --by-kind` breakdown table.
fn print_usage_by_kind(data: &serde_json::Value) {
    let period = data["period"].as_str().unwrap_or("today");
    let today = usage_display_date(data);
    cli_out!("Shore Usage by Kind - {today} (period: {period})\n");
    cli_out!(
        "{:<20} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
        "Usage Kind",
        "Calls",
        "Input",
        "Output",
        "Cache R",
        "Cache W",
        "Cost"
    );
    cli_out!("{}", "-".repeat(80));
    let summary = data["summary"].as_array();
    let mut grand_total = 0.0_f64;
    if let Some(rows) = summary {
        for s in rows {
            let cost_str = s["total_cost"].as_f64().map_or_else(
                || "\u{2014}".into(),
                |c| {
                    add_display_cost(&mut grand_total, c);
                    format!("${c:.2}")
                },
            );
            cli_out!(
                "{:<20} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
                s["usage_kind"].as_str().unwrap_or(""),
                s["call_count"].as_u64().unwrap_or(0),
                format_k(s["total_input"].as_u64().unwrap_or(0)),
                format_k(s["total_output"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_read"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_write"].as_u64().unwrap_or(0)),
                cost_str,
            );
        }
        if rows.is_empty() {
            cli_out!("  No usage data for this period.");
        } else {
            cli_out!("{:>72} ${grand_total:.2}", "Total:");
        }
    }
}

/// Render the `usage --by-api-key` breakdown table.
fn print_usage_by_api_key(data: &serde_json::Value) {
    let period = data["period"].as_str().unwrap_or("today");
    let today = usage_display_date(data);
    cli_out!("Shore Usage by API Key - {today} (period: {period})\n");
    cli_out!(
        "{:<22} {:<18} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
        "Provider",
        "API Key",
        "Calls",
        "Input",
        "Output",
        "Cache R",
        "Cache W",
        "Cost"
    );
    cli_out!("{}", "-".repeat(102));
    let summary = data["summary"].as_array();
    let mut grand_total = 0.0_f64;
    if let Some(rows) = summary {
        for s in rows {
            let cost_str = s["total_cost"].as_f64().map_or_else(
                || "\u{2014}".into(),
                |c| {
                    add_display_cost(&mut grand_total, c);
                    format!("${c:.2}")
                },
            );
            cli_out!(
                "{:<22} {:<18} {:>5}  {:>9}  {:>9}  {:>9}  {:>9}  {:>8}",
                s["provider"].as_str().unwrap_or(""),
                s["api_key_name"].as_str().unwrap_or("unknown"),
                s["call_count"].as_u64().unwrap_or(0),
                format_k(s["total_input"].as_u64().unwrap_or(0)),
                format_k(s["total_output"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_read"].as_u64().unwrap_or(0)),
                format_k(s["total_cache_write"].as_u64().unwrap_or(0)),
                cost_str,
            );
        }
        if rows.is_empty() {
            cli_out!("  No usage data for this period.");
        } else {
            cli_out!("{:>94} ${grand_total:.2}", "Total:");
        }
    }
}

/// Render the `usage --anomalies` listing.
fn print_usage_anomalies(data: &serde_json::Value) {
    let Some(anomalies) = data["anomalies"].as_array() else {
        cli_out!("No cache anomalies found.");
        return;
    };
    if anomalies.is_empty() {
        cli_out!("No cache anomalies found.");
    } else {
        cli_out!("Cache Anomalies:\n");
        for r in anomalies {
            cli_out!(
                "  {} {} {} {} \u{2014} {} (read: {}, write: {})",
                r["ts"].as_str().unwrap_or("?"),
                r["character"].as_str().unwrap_or("?"),
                r["model"].as_str().unwrap_or("?"),
                r["call_type"].as_str().unwrap_or("?"),
                r["anomaly"].as_str().unwrap_or("?"),
                r["cache_read_tokens"].as_u64().unwrap_or(0),
                r["cache_write_tokens"].as_u64().unwrap_or(0),
            );
        }
        cli_out!("\nTotal: {} anomalies", anomalies.len());
    }
}

/// Render the `usage --recalculate` summary.
fn print_usage_recalculate(data: &serde_json::Value) {
    let updated = data["updated"].as_u64().unwrap_or(0);
    let total = data["total"].as_u64().unwrap_or(0);
    if total == 0 {
        cli_out!("All rows already have costs calculated.");
    } else {
        cli_out!(
            "Updated {updated}/{total} rows. {} still missing pricing data.",
            total.saturating_sub(updated)
        );
        if let Some(failures) = data["failures"].as_array() {
            if !failures.is_empty() {
                cli_out!("\nFailed models:");
                for f in failures {
                    cli_out!(
                        "  {} — {}",
                        f["model"].as_str().unwrap_or("?"),
                        f["reason"].as_str().unwrap_or("unknown")
                    );
                }
            }
        }
    }
}

/// Render the default usage summary (table + cache health + budgets).
fn print_usage_summary(data: &serde_json::Value) {
    let mut stdout = io::stdout().lock();
    let _ignored = write_usage_summary_table(&mut stdout, data);
    drop(stdout);

    if let Some(health) = data["cache_health"].as_array() {
        if !health.is_empty() {
            cli_out!("\nCache Health (anthropic):");
            for entry in health {
                let char_name = entry["character"].as_str().unwrap_or("?");
                let state = entry["state"].as_str().unwrap_or("cold");
                let streak = entry["streak"].as_u64().unwrap_or(0);
                let state_str = if state == "warm" {
                    format!("Warm (streak: {streak} calls)")
                } else {
                    "Cold".into()
                };
                cli_out!("  {char_name:<8} \u{2014} {state_str}");
            }
        }
    }

    if let Some(budgets) = data["budgets"].as_array() {
        if !budgets.is_empty() {
            cli_out!("\nBudgets:");
            print_budget_table(data);
        }
    }
    let anomaly_count = data["anomaly_count_7d"].as_u64().unwrap_or(0);
    cli_out!("\nAnomalies (last 7d): {anomaly_count}");
    print_anomaly_breakdown(data);
    print_cache_coverage(data);
    print_rate_limits(data);
}

/// Break the anomaly total down by kind. A bare count says something is wrong;
/// which kind says what, and a keepalive that misses is pure waste.
fn print_anomaly_breakdown(data: &serde_json::Value) {
    let Some(rows) = data["anomaly_counts_7d"].as_array() else {
        return;
    };
    for row in rows {
        let kind = row["anomaly"].as_str().unwrap_or("?");
        let calls = row["calls"].as_u64().unwrap_or(0);
        let writes = row["cache_write_tokens"].as_u64().unwrap_or(0);
        cli_out!("  {kind:<24} {calls:>6}  cache write {writes}");
    }
}

/// Render how many calls the cache tracker could classify, and why the rest
/// could not. Unclassified calls are invisible to any warm/cold percentage, so
/// showing them keeps the denominator honest.
fn print_cache_coverage(data: &serde_json::Value) {
    let Some(rows) = data["cache_coverage"].as_array() else {
        return;
    };
    if rows.is_empty() {
        return;
    }
    cli_out!("\nCache coverage:");
    for row in rows {
        let state = row["state"].as_str().unwrap_or("?");
        let calls = row["calls"].as_u64().unwrap_or(0);
        let reads = row["cache_read_tokens"].as_u64().unwrap_or(0);
        let writes = row["cache_write_tokens"].as_u64().unwrap_or(0);
        let label = match row["reason"].as_str() {
            Some(reason) => format!("{state} ({reason})"),
            None => state.to_string(),
        };
        cli_out!("  {label:<40} {calls:>6} calls  read {reads}  write {writes}");
    }
}

/// Render the provider quota headroom captured on the most recent response
/// from each provider host.
fn print_rate_limits(data: &serde_json::Value) {
    let Some(rows) = data["rate_limits"].as_array() else {
        return;
    };
    if rows.is_empty() {
        return;
    }
    cli_out!("\nProvider quota (as of the last response):");
    for row in rows {
        let host = row["host"].as_str().unwrap_or("?");
        let requests = quota_fraction(row, "requests");
        let input = quota_fraction(row, "input_tokens");
        let output = quota_fraction(row, "output_tokens");
        let resets = row["resets_at"].as_str().unwrap_or("?");
        cli_out!("  {host:<24} requests {requests}  input {input}  output {output}  resets {resets}");
    }
}

fn quota_fraction(row: &serde_json::Value, field: &str) -> String {
    let remaining = row[format!("{field}_remaining")].as_u64();
    let limit = row[format!("{field}_limit")].as_u64();
    match (remaining, limit) {
        (Some(r), Some(l)) => format!("{r}/{l}"),
        (Some(r), None) => format!("{r}"),
        _ => "-".into(),
    }
}

// ---------------------------------------------------------------------------
// Autonomy section — rendered inside `shore status`
// ---------------------------------------------------------------------------

/// Format a duration in seconds into a compact label like "1h 8m" or "32m".
/// Negative inputs render with a leading "-".
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
    if neg {
        format!("-{body}")
    } else {
        body
    }
}

/// Format a duration in seconds for "threshold" rows like "100m" or "48h".
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

/// Format an RFC3339 timestamp as "YYYY-MM-DD HH:MM" in local time, or the
/// raw string on parse failure.
fn format_local_timestamp(rfc3339: &str) -> String {
    parse_timestamp(rfc3339).map_or_else(
        || rfc3339.to_owned(),
        |dt| dt.format("%Y-%m-%d %H:%M").to_string(),
    )
}

/// Render the autonomy block of `shore status`. Reads the `AutonomyStatus`
/// JSON snapshot from the daemon and renders state, schedule, thresholds,
/// and the most recent heartbeat events.
fn write_autonomy_section(out: &mut impl Write, autonomy: &serde_json::Value, width: usize) {
    let paused = autonomy["paused"].as_bool().unwrap_or(false);
    let suffix = if paused { "paused" } else { "" };
    write_section_header(out, "Autonomy", suffix, width);

    let int_state = autonomy["heartbeat_state"].as_str().unwrap_or("Active");
    let ticks = autonomy["ticks_without_user"].as_u64().unwrap_or(0);
    let max_ticks = autonomy["dormant_after_heartbeat_turns"]
        .as_u64()
        .unwrap_or(0);
    let description = heartbeat_description(int_state, ticks, max_ticks);

    // Heartbeat row: description + state label.
    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    _ = write!(out, "  {:<13}", "Heartbeat");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = write!(out, "{description}  ");
    if use_color() {
        _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    _ = write!(out, "({int_state})");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out);

    write_autonomy_schedule(out, autonomy, ticks, max_ticks);
    write_autonomy_events(out, autonomy);
}

/// Render the autonomy schedule rows (interval, next wake, last user, idle
/// ticks, latency thresholds).
fn write_autonomy_schedule(
    out: &mut impl Write,
    autonomy: &serde_json::Value,
    ticks: u64,
    max_ticks: u64,
) {
    if let Some(eff) = autonomy["effective_interval_secs"].as_u64() {
        let mins = checked_div_u64(eff, SECONDS_PER_MINUTE);
        let secs = checked_rem_u64(eff, SECONDS_PER_MINUTE);
        let label = if secs == 0 {
            format!("{mins}m")
        } else {
            format!("{mins}m{secs}s")
        };
        write_row(out, "Interval", &label);
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
        write_row(out, "Next Wake", &detail);
    } else {
        write_row(out, "Next Wake", "(none scheduled)");
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
        write_row(out, "Last User", &detail);
    }

    write_row(out, "Idle Ticks", &format!("{ticks} / {max_ticks}"));

    if let Some(secs) = autonomy["minimum_heartbeat_latency_secs"].as_u64() {
        write_row(out, "Min Latency", &format_threshold(secs));
    }
    if let Some(secs) = autonomy["dormant_after_idle_time_secs"].as_u64() {
        write_row(out, "Idle Limit", &format_threshold(secs));
    }
}

/// Render the recent autonomy events list. Emits nothing beyond a blank line
/// when the daemon included no events — the schedule rows already tell the
/// story.
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
    if use_color() {
        _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    _ = writeln!(out, "  Recent events:");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    let mut prev_date: Option<String> = None;
    for event in &events {
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
            "tick_fired" => Color::Blue,
            "message_sent" | "wake" => Color::Green,
            "message_skipped" => Color::DarkGrey,
            "tool_use" => Color::Cyan,
            "dormant" => Color::Red,
            "dormant_ping" => Color::Magenta,
            "timeout" => Color::Yellow,
            _ => Color::White,
        };
        if use_color() {
            _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
        }
        _ = write!(out, "    {time_str:<12}");
        if use_color() {
            _ = crossterm::execute!(out, SetForegroundColor(kind_color));
        }
        _ = write!(out, "{kind:<17}");
        if use_color() {
            _ = crossterm::execute!(out, ResetColor);
        }
        _ = writeln!(out, "{detail}");
    }
    _ = writeln!(out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;

    fn line<'src>(lines: &'src [&str], index: usize) -> &'src str {
        lines.get(index).copied().expect("expected rendered line")
    }

    /// Visual preview of `shore tools` rendering. Run with:
    /// `cargo test -p shore-cli render_preview_tools -- --ignored --nocapture --test-threads=1`
    #[test]
    #[ignore = "visual preview"]
    fn render_preview_tools() {
        set_color_enabled(true);
        let data = serde_json::json!({
            "tools": [
                { "tool": "read", "main": true, "subagents": ["memory"] },
                { "tool": "search", "main": false, "subagents": ["memory"] },
                { "tool": "web_search", "main": true, "subagents": [] },
                { "tool": "edit", "main": false, "subagents": [] },
                { "tool": "git", "main": true, "subagents": [] },
            ],
            "subagents": [
                { "name": "memory", "enabled": true, "tools": ["search", "read"], "model": "anthropic:claude-haiku-4-5" },
                { "name": "research", "enabled": false, "tools": ["web_search", "fetch_url"], "model": null },
            ],
            "warnings": ["subagent 'research' references unknown tool 'crawl'"],
        });
        format_command("tools", &data);
        set_color_enabled(false);
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
    fn print_status_does_not_panic() {
        set_color_enabled(false);
        let data = serde_json::json!({
            "character": "Sable",
            "message_count": 142,
            "turn_count": 142,
            "active_model": "claude-sonnet-4-20250514",
            "pending_deferred_edit_count": 2,
            "pending_deferred_edits": ["SOUL.md", "TOOLS.md"],
            "tokens": {
                "input": 12450,
                "output": 3218,
                "cache_read": 8100,
                "cache_write": 1024,
            },
            "autonomy": {
                "paused": false,
                "heartbeat_state": "Active",
                "ticks_without_user": 1,
                "dormant_after_heartbeat_turns": 3,
                "effective_interval_secs": 3540,
            }
        });
        print_status(&data, "Sable");
    }

    #[test]
    fn print_status_minimal_does_not_panic() {
        set_color_enabled(false);
        let data = serde_json::json!({
            "character": "Sable",
            "message_count": 5,
            "turn_count": 5,
            "active_model": null,
        });
        print_status(&data, "Sable");
    }

    #[test]
    fn print_status_paused_does_not_panic() {
        set_color_enabled(false);
        let data = serde_json::json!({
            "character": "Sable",
            "message_count": 50,
            "turn_count": 50,
            "active_model": "test-model",
            "autonomy": {
                "paused": true,
                "heartbeat_state": "Active",
                "ticks_without_user": 0,
                "dormant_after_heartbeat_turns": 3,
                "effective_interval_secs": 3600,
            }
        });
        print_status(&data, "Sable");
    }

    #[test]
    fn print_status_with_activity_does_not_panic() {
        set_color_enabled(false);
        // Simulate a realistic hour histogram: busier in afternoon/evening.
        let histogram: Vec<f64> = (0..24)
            .map(|h| match h {
                0..=5 => 0.01,
                6..=8 => 0.04,
                9..=11 => 0.06,
                12..=14 => 0.08,
                15..=17 => 0.05,
                18..=21 => 0.10,
                _ => 0.02,
            })
            .collect();
        let classifications: Vec<&str> = (0..24)
            .map(|h| match h {
                0..=5 => "trough",
                18..=21 => "peak",
                _ => "normal",
            })
            .collect();

        let data = serde_json::json!({
            "character": "Sable",
            "message_count": 200,
            "turn_count": 200,
            "active_model": "claude-sonnet-4-20250514",
            "tokens": { "input": 5000, "output": 1200, "cache_read": 0, "cache_write": 0 },
            "activity": {
                "hour_histogram": histogram,
                "hour_classifications": classifications,
                "has_sufficient_heatmap": true,
                "engagement_score": 0.72,
                "sessions_per_day": 2.3,
                "message_count": 200,
                "turn_count": 200,
            }
        });
        print_status(&data, "Sable");
    }

    #[test]
    fn print_status_sparse_activity_does_not_panic() {
        set_color_enabled(false);
        let data = serde_json::json!({
            "character": "Sable",
            "message_count": 3,
            "turn_count": 3,
            "active_model": "test-model",
            "activity": {
                "hour_histogram": vec![0.0_f64; 24],
                "hour_classifications": vec!["normal"; 24],
                "has_sufficient_heatmap": false,
                "engagement_score": 0.0,
                "sessions_per_day": 0.0,
                "message_count": 3,
                "turn_count": 3,
            }
        });
        print_status(&data, "Sable");
    }

    // ── classification_color ─────────────────────────────────────────

    #[test]
    fn classification_color_maps_correctly() {
        assert!(matches!(classification_color("peak"), Color::Cyan));
        assert!(matches!(classification_color("trough"), Color::DarkGrey));
        assert!(matches!(classification_color("normal"), Color::White));
        assert!(matches!(classification_color("unknown"), Color::White));
    }

    // ── heartbeat_description edge cases ──────────────────────────

    #[test]
    fn heartbeat_description_unknown_state() {
        // Unknown states pass through as-is.
        assert_eq!(heartbeat_description("CustomState", 0, 8), "CustomState");
    }

    // ── format_command dispatch ─────────────────────────────────────

    #[test]
    fn format_command_dispatches_known_commands() {
        set_color_enabled(false);
        // These should all run without panic and hit their formatters.
        format_command("config_reset", &serde_json::json!({"message": "reloaded"}));
        format_command("inject_system", &serde_json::json!({}));
        format_command("edit", &serde_json::json!({"ref": "m42"}));
    }

    #[test]
    fn visible_setting_keys_hides_ignored_and_rejected() {
        let all = [
            "temperature",
            "reasoning_effort",
            "cache_ttl",
            "sdk",
            "replay_prior_thinking",
        ];
        // openrouter-shaped: cache_ttl ignored, temperature honored, Shore keys always.
        let applicability = serde_json::json!({
            "temperature": "honored",
            "reasoning_effort": "honored",
            "cache_ttl": "ignored",
            "sdk": "always",
            "replay_prior_thinking": "always",
        });
        let visible = visible_setting_keys(&all, &applicability);
        assert!(visible.contains(&"temperature"));
        assert!(visible.contains(&"reasoning_effort"));
        assert!(visible.contains(&"sdk"));
        assert!(
            !visible.contains(&"cache_ttl"),
            "ignored key must be hidden"
        );
    }

    #[test]
    fn visible_setting_keys_falls_back_when_absent() {
        // Older daemon without the applicability map → show everything.
        let all = ["temperature", "cache_ttl"];
        let visible = visible_setting_keys(&all, &serde_json::Value::Null);
        assert_eq!(visible, vec!["temperature", "cache_ttl"]);
    }

    #[test]
    fn print_model_settings_renders_filtered_with_domain() {
        set_color_enabled(false);
        // Exercises the filter + reasoning_effort domain branches without panic.
        print_model_settings(&serde_json::json!({
            "model": "chat.openrouter.gpt-4o",
            "effective_sampler": {"reasoning_effort": "high"},
            "scopes": {"reasoning_effort": "character_model"},
            "applicability": {"reasoning_effort": "honored", "cache_ttl": "ignored"},
            "reasoning_effort_domain": ["minimal", "low", "medium", "high", "xhigh", "max"],
        }));
    }

    /// Visual preview of `shore model setting` (the user-reported scenario).
    /// Run with: cargo test -p shore-cli render_preview_model_settings --
    ///   --ignored --nocapture --test-threads=1
    #[test]
    #[ignore = "visual preview; run explicitly with --ignored --nocapture"]
    fn render_preview_model_settings() {
        set_color_enabled(true);
        print_model_settings(&serde_json::json!({
            "model": "anthropic:claude-opus-4-8",
            "effective_sampler": {
                "reasoning_effort": "high",
                "max_output_tokens": 8192,
                "cache_ttl": "1h",
                "sdk": "anthropic",
                "replay_prior_thinking": "none",
            },
            "scopes": {
                "reasoning_effort": "character_model",
                "max_output_tokens": "static_default",
                "cache_ttl": "static_default",
                "sdk": "static_default",
                "replay_prior_thinking": "character_model",
            },
            "applicability": {
                "reasoning_effort": "honored",
                "max_output_tokens": "honored",
                "cache_ttl": "honored",
                "sdk": "always",
                "replay_prior_thinking": "honored",
            },
            "reasoning_effort_domain": ["adaptive", "low", "medium", "high", "xhigh", "max"],
        }));
        set_color_enabled(false);
    }

    #[test]
    fn format_command_fallback_for_unknown() {
        set_color_enabled(false);
        // Unknown commands should use fallback (JSON pretty print), not panic.
        format_command("totally_unknown", &serde_json::json!({"key": "val"}));
    }

    #[test]
    fn print_delete_confirmation_single_and_multiple() {
        set_color_enabled(false);
        // Single deletion.
        print_delete_confirmation(&serde_json::json!({"deleted": ["msg_1"]}));
        // Multiple deletions.
        print_delete_confirmation(&serde_json::json!({"deleted": ["msg_1", "msg_2", "msg_3"]}));
        // String form.
        print_delete_confirmation(&serde_json::json!({"deleted": "msg_42"}));
    }

    #[test]
    fn print_model_switched_shows_abbreviated_name() {
        set_color_enabled(false);
        // Should not panic and should abbreviate the date suffix.
        print_model_switched(&serde_json::json!({"active": "claude-sonnet-4-20250514"}));
    }

    #[test]
    fn format_k_correctness() {
        // Regression for SHA 31f20cb: verify correct formatting across boundary.
        // 0 maps to em-dash (—), not a number.
        assert_eq!(format_k(0), "\u{2014}");
        // Numbers < 1000 display without K suffix.
        assert_eq!(format_k(1), "1");
        assert_eq!(format_k(500), "500");
        assert_eq!(format_k(999), "999");
        // 1000 is the first value that rounds to K.
        assert_eq!(format_k(1000), "1.0K");
        // 1500 → "1.5K"
        assert_eq!(format_k(1500), "1.5K");
        // 10000 → "10.0K"
        assert_eq!(format_k(10000), "10.0K");
    }

    #[test]
    fn format_local_ampm_renders_user_facing_format() {
        // UTC midnight should render as the local equivalent in
        // `YYYY-MM-DD HH:MM AM|PM` form (19 chars), regardless of the test
        // runner's timezone.
        let rendered = format_local_ampm("2026-05-23T00:00:00+00:00");
        assert_eq!(rendered.len(), 19, "unexpected length: {rendered:?}");
        // Raw RFC 3339 form contained 'T' which we drop.
        assert!(
            !rendered.contains('T'),
            "should not contain 'T': {rendered:?}"
        );
        assert!(
            rendered.ends_with(" AM") || rendered.ends_with(" PM"),
            "should end with AM/PM marker: {rendered:?}"
        );
        // Malformed input falls back to the raw string.
        assert_eq!(format_local_ampm("not-a-timestamp"), "not-a-timestamp");
    }

    /// Visual preview of the budget table with and without a pace. Skipped by
    /// default; run it to eyeball column alignment after touching either row:
    ///
    /// ```sh
    /// cargo test -p shore-cli render_preview_budget_table \
    ///   -- --ignored --nocapture --test-threads=1
    /// ```
    #[test]
    #[ignore = "visual preview"]
    fn render_preview_budget_table() {
        let data = serde_json::json!({
            "budgets": [
                {
                    "name": "weekly", "period": "week",
                    "current_cost": 5.0, "cost_limit": 14.0, "percent_used": 0.357,
                    "status": "ok", "action": "block",
                    "period_start": "2026-05-20T06:00:00+00:00",
                    "reset_at": "2026-05-27T06:00:00+00:00",
                    "pace": {
                        "period": "day",
                        "window_start": "2026-05-22T06:00:00+00:00",
                        "window_end": "2026-05-23T06:00:00+00:00",
                        "allowance": 1.8, "current_cost": 0.0, "remaining": 1.8,
                        "percent_used": 0.0, "periods_remaining": 5.0,
                        "status": "ok", "action": "warn",
                        "warning_thresholds": [0.8, 1.0], "crossed_warn_at": [],
                        "over_limit": false
                    }
                },
                {
                    "name": "background", "period": "day",
                    "current_cost": 1.9, "cost_limit": 2.0, "percent_used": 0.95,
                    "status": "warning", "action": "pause_background",
                    "period_start": "2026-05-22T00:00:00+00:00",
                    "reset_at": "2026-05-23T00:00:00+00:00"
                }
            ]
        });
        // `print_budget_table` writes straight to stdout via `cli_out!`, so the
        // banners go the same way rather than through `println!` (denied here).
        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"----- budget table -----\n");
        let _flushed = stdout.flush();
        print_budget_table(&data);
        let _ignored_end = stdout.write_all(b"----- end -----\n");
        let _flushed_end = stdout.flush();
    }

    #[test]
    fn pace_row_omitted_without_a_pace() {
        let budget = serde_json::json!({ "name": "weekly", "period": "week" });
        assert!(
            pace_row(&budget).is_none(),
            "an unpaced budget gets no continuation line"
        );
    }

    /// Field names here mirror a real `budget_statuses` payload (the daemon's ledger module's
    /// `PaceStatus`), since this renderer reads the JSON untyped and would
    /// silently print zeros if a key were ever renamed on the producer side.
    #[test]
    fn pace_row_renders_spend_against_allowance() {
        let budget = serde_json::json!({
            "name": "weekly",
            "period": "week",
            "current_cost": 5.0,
            "cost_limit": 14.0,
            "pace": {
                "period": "day",
                "window_start": "2026-05-21T06:00:00+00:00",
                "window_end": "2026-05-22T06:00:00+00:00",
                "allowance": 2.166_666_666_666_666_5,
                "base_allowance": 2.0,
                "rollover": 0.25,
                "debt_adjustment": 0.083_333_333_333_333_33,
                "current_cost": 1.0,
                "remaining": 1.166_666_666_666_666_5,
                "percent_used": 0.461_538_461_538_461_56,
                "periods_remaining": 6.0,
                "status": "ok",
                "action": "warn",
                "warning_thresholds": [0.8, 1.0],
                "crossed_warn_at": [],
                "over_limit": false
            }
        });
        let row = pace_row(&budget).expect("paced budget renders a row");
        assert!(row.contains("day pace"), "row names the pace period: {row}");
        assert!(
            row.contains("1.00/2.17"),
            "row shows spend against allowance: {row}"
        );
        assert!(row.contains("46%"), "row shows the used share: {row}");
        assert!(
            row.contains("base $2.00  + rollover $0.25  - debt adjustment $0.08"),
            "row explains how the allowance was formed: {row}"
        );
        assert!(
            row.contains("2026-05-22"),
            "row shows the pace sub-window bounds: {row}"
        );
        // The pace row sits under the budget row's columns, so the two read
        // down a single axis. 37 is where `{:<24} {:<6} {:>5.2}` puts the
        // budget row's spend separator. Counted in chars, not bytes — the
        // `└` prefix is three bytes wide but occupies one column.
        assert_eq!(
            row.chars().position(|c| c == '/'),
            Some(37),
            "pace spend column must line up with the budget row's: {row}"
        );
    }

    #[test]
    fn ellipsize_pads_and_truncates() {
        assert_eq!(ellipsize("short", 10), "short");
        assert_eq!(ellipsize("exactly10!", 10), "exactly10!");
        // Truncated values end with U+2026 and fit exactly in `max_width` chars.
        let truncated = ellipsize("openrouter-anthropic", 12);
        assert_eq!(truncated.chars().count(), 12);
        assert!(truncated.ends_with('\u{2026}'));
        assert!(truncated.starts_with("openrouter-"));
    }

    #[test]
    #[expect(
        clippy::string_slice,
        reason = "test slices a fixed ASCII table row at a find()-derived offset, so the bounds are char boundaries"
    )]
    fn usage_summary_table_keeps_columns_aligned_with_long_provider() {
        // Regression for issue #32: an over-long provider name used to push
        // every subsequent value one column to the right.
        let data = serde_json::json!({
            "mode": "summary",
            "period": "today",
            "timezone": "local",
            "summary": [
                {
                    "provider": "openrouter-anthropic",
                    "model": "anthropic/claude-opus-4.6",
                    "call_count": 96,
                    "total_input": 189_900,
                    "total_output": 52_000,
                    "total_cache_read": 2_513_200,
                    "total_cache_write": 246_300,
                    "total_cost": 5.11,
                },
                {
                    "provider": "anthropic",
                    "model": "claude-sonnet-4.6",
                    "call_count": 12,
                    "total_input": 1_200,
                    "total_output": 800,
                    "total_cache_read": 0,
                    "total_cache_write": 0,
                    "total_cost": 0.42,
                },
            ],
        });
        let mut buf: Vec<u8> = Vec::new();
        write_usage_summary_table(&mut buf, &data).expect("write");
        let rendered = String::from_utf8(buf).expect("utf8");
        let lines: Vec<&str> = rendered.lines().collect();
        // Layout: title, blank, header, separator, two rows, total.
        let header = line(&lines, 2);
        let separator = line(&lines, 3);
        let row1 = line(&lines, 4);
        let row2 = line(&lines, 5);

        // Every body line shares the same width as the separator, so no row
        // can shift columns relative to the header.
        assert_eq!(
            row1.chars().count(),
            separator.chars().count(),
            "row1 width"
        );
        assert_eq!(
            row2.chars().count(),
            separator.chars().count(),
            "row2 width"
        );
        assert_eq!(
            header.chars().count(),
            separator.chars().count(),
            "header width"
        );

        // The Cost column right-aligns to the table edge — `$5.11` must end
        // at the last column of the separator.
        assert!(row1.ends_with("$5.11"));
        assert!(row2.ends_with("$0.42"));

        // The grand-total line's cost must end at the same column as the
        // per-row cost (i.e. share the table's right edge). Before the fix
        // the dollar amount sat ~3 columns left of the Cost column.
        let total_line = line(&lines, 6);
        assert!(
            total_line.ends_with("$5.53"),
            "total line should right-align with Cost column: {total_line:?}"
        );
        assert_eq!(
            total_line.chars().count(),
            separator.chars().count(),
            "total line width should equal table width"
        );

        // The Calls column ("Calls" header is 5 wide) must contain the number
        // at the same byte offset on both rows.
        let calls_idx_header = header.find("Calls").expect("Calls header present");
        let calls_end = calls_idx_header + "Calls".len();
        assert_eq!(&row1[calls_end - 2..calls_end], "96");
        assert_eq!(&row2[calls_end - 2..calls_end], "12");
    }

    #[test]
    fn usage_summary_table_truncates_runaway_provider_names() {
        // A provider name longer than MAX_PROVIDER_W should be ellipsized so
        // the column width stays bounded.
        let absurd = "a".repeat(80);
        let data = serde_json::json!({
            "mode": "summary",
            "period": "today",
            "summary": [{
                "provider": absurd,
                "model": "m",
                "call_count": 1,
                "total_input": 0,
                "total_output": 0,
                "total_cache_read": 0,
                "total_cache_write": 0,
                "total_cost": 0.01,
            }],
        });
        let mut buf: Vec<u8> = Vec::new();
        write_usage_summary_table(&mut buf, &data).expect("write");
        let rendered = String::from_utf8(buf).expect("utf8");
        assert!(
            rendered.contains('\u{2026}'),
            "expected ellipsis for runaway provider"
        );
        for line in rendered.lines().skip(2) {
            // Sanity: no line should exceed a reasonable cap width.
            assert!(line.chars().count() <= 120, "line too wide: {line:?}");
        }
    }

    #[test]
    fn density_to_block_ranges() {
        assert_eq!(density_to_block(0.0), '\u{2591}'); // below threshold
        assert_eq!(density_to_block(0.04), '\u{2591}'); // below threshold
        assert_eq!(density_to_block(0.06), '\u{2581}'); // 0.06 * 7 = 0.42 -> round 0 -> first block
        assert_eq!(density_to_block(0.5), '\u{2585}'); // 0.5 * 7 = 3.5 -> round 4 -> fifth block
        assert_eq!(density_to_block(1.0), '\u{2588}'); // 1.0 * 7 = 7.0 -> index 7 -> full block
    }

    #[test]
    fn print_config_section_aligns_per_table_to_longest_key() {
        // Regression for #73: keys used to butt up against values because the
        // column was a fixed 24. Now the column is computed per-section from
        // the longest visible scalar key. The longest key here is
        // `allow_compaction_over_budget` (28 chars) -> column = 29.
        set_color_enabled(false);
        let data = serde_json::json!({
            "addr": "0.0.0.0:1112",
            "allow_compaction_over_budget": true,
            "max_embed_chars_per_file": 4000,
        });
        let mut buf: Vec<u8> = Vec::new();
        print_config_section(&mut buf, &data, None, 0, true);
        let rendered = String::from_utf8(buf).expect("utf8");
        assert!(
            !rendered.contains("accesstrue"),
            "long key bled into value:\n{rendered}"
        );
        assert!(
            !rendered.contains("file4000"),
            "boundary key bled into value:\n{rendered}"
        );
        // All rows should align to column 27 (longest key + 1 space).
        assert!(
            rendered.contains(&format!("addr{:25}0.0.0.0:1112", "")),
            "short key not padded to section column:\n{rendered}"
        );
        assert!(
            rendered.contains("allow_compaction_over_budget true"),
            "longest key should get a single trailing space:\n{rendered}"
        );
        assert!(
            rendered.contains(&format!("max_embed_chars_per_file{:5}4000", "")),
            "mid-length key not padded to section column:\n{rendered}"
        );
    }

    #[test]
    fn print_config_section_renders_budgets_as_blocks_not_json() {
        // The reported shape: `[[usage.budgets]]` used to print as one line of
        // raw JSON, nulls and all, inside a section of aligned key/value rows.
        set_color_enabled(false);
        let config = serde_json::json!({
            "usage": {
                "budgets": [{
                    "name": "brainwife",
                    "period": "week",
                    "cost_usd": 15,
                    "warn_at": [0.85, 1],
                    "limit": "warn",
                    "character": serde_json::Value::Null,
                    "pace_period": "day",
                    "pace_action": serde_json::Value::Null,
                    "pace_warn_at": [0.5],
                    "pace_warn_action": "pause_heartbeat",
                }],
            },
        });
        let mut buf: Vec<u8> = Vec::new();
        print_config_section(&mut buf, &config, None, 0, true);
        let rendered = String::from_utf8(buf).expect("utf8");
        assert!(
            !rendered.contains('{'),
            "budget still rendered as raw JSON:\n{rendered}"
        );
        assert!(
            rendered.contains("    brainwife:"),
            "budget not labelled by its name:\n{rendered}"
        );
        assert!(
            rendered.contains("pace_warn_action pause_heartbeat"),
            "budget fields not rendered as rows:\n{rendered}"
        );
        assert!(
            rendered.contains("warn_at          0.85, 1"),
            "list-valued field should render like any other list:\n{rendered}"
        );
        assert!(
            !rendered.contains("character"),
            "null field should be skipped like any other null:\n{rendered}"
        );
    }

    #[test]
    fn budget_action_column_reports_the_action_in_force() {
        // A pace in `warning` with a `pace_warn_action` set: the column used to
        // read `action` (the limit's) and print `warn` while the daemon was
        // already pausing heartbeats.
        let budget = serde_json::json!({
            "status": "ok",
            "action": "warn",
            "effective_action": "warn",
            "pace": {
                "status": "warning",
                "action": "warn",
                "effective_action": "pause_heartbeat",
            },
        });
        assert_eq!(acting_now(&budget), "warn");
        assert_eq!(acting_now(&budget["pace"]), "pause_heartbeat");
    }

    #[test]
    fn session_activate_names_the_cache_write_it_paid_for() {
        let primed = serde_json::json!({
            "status": "primed",
            "cache_creation_tokens": 5000,
            "cache_read_tokens": 0,
            "seconds_until_ping": 3300,
        });
        assert_eq!(
            session_activate_keepalive(&primed),
            "primed — wrote 5000 cache tokens; next ping in 55m"
        );
    }

    #[test]
    fn session_activate_distinguishes_resumed_from_off() {
        let resumed = serde_json::json!({ "status": "resumed", "seconds_until_ping": 1800 });
        assert_eq!(
            session_activate_keepalive(&resumed),
            "already warm; next ping in 30m"
        );

        let off = serde_json::json!({ "status": "off" });
        assert_eq!(
            session_activate_keepalive(&off),
            "off — this character's model sets cache_keepalive = off"
        );
    }

    #[test]
    fn session_activate_heartbeat_reports_the_wake_it_has() {
        let scheduled =
            serde_json::json!({ "state": "Active", "paused": false, "seconds_until_wake": 7200 });
        assert_eq!(
            session_activate_heartbeat(&scheduled),
            "Active, next wake in 2h 0m"
        );

        let unscheduled = serde_json::json!({ "state": "Dormant", "paused": false });
        assert_eq!(
            session_activate_heartbeat(&unscheduled),
            "Dormant, no wake scheduled"
        );
    }

    #[test]
    fn budget_action_column_falls_back_for_an_older_daemon() {
        let budget = serde_json::json!({ "status": "ok", "action": "block" });
        assert_eq!(acting_now(&budget), "block");
        assert_eq!(acting_now(&serde_json::json!({})), "warn");
    }

    #[test]
    fn print_config_section_hides_defaults_when_show_all_is_false() {
        set_color_enabled(false);
        let config = serde_json::json!({
            "stream": true,
            "model": "claude-haiku-4-5",
        });
        let defaults = serde_json::json!({
            "stream": true,
            "model": "claude-sonnet-4-5",
        });
        let mut buf: Vec<u8> = Vec::new();
        print_config_section(&mut buf, &config, Some(&defaults), 0, false);
        let rendered = String::from_utf8(buf).expect("utf8");
        assert!(
            !rendered.contains("stream"),
            "default-valued key should be hidden:\n{rendered}"
        );
        assert!(
            rendered.contains("model"),
            "non-default key should still be shown:\n{rendered}"
        );
    }

    #[test]
    fn print_config_section_realistic_shape_renders_cleanly() {
        // Mirrors the bug report in issue #73, where long keys collided with
        // their values. Confirms the per-section column
        // produces consistent alignment on a realistic payload.
        set_color_enabled(false);
        let config = serde_json::json!({
            "usage": {
                "timezone": "local",
                "allow_compaction_over_budget": true,
                "budgets": ["a", "b"],
            },
        });
        let mut buf: Vec<u8> = Vec::new();
        print_config_section(&mut buf, &config, None, 0, true);
        let rendered = String::from_utf8(buf).expect("utf8");
        let daemon_lines: Vec<&str> = rendered
            .lines()
            .filter(|l| l.starts_with("  ") && !l.ends_with(':'))
            .collect();
        assert!(
            !daemon_lines.is_empty(),
            "expected scalar rows under the section"
        );
        // Every scalar row in the section must start at the same column for
        // the value (i.e. consistent indent + matching pad column).
        let value_columns: Vec<usize> = daemon_lines
            .iter()
            .map(|l| l.find(|c: char| !c.is_whitespace()).unwrap_or(0))
            .collect();
        assert!(
            value_columns
                .windows(2)
                .all(|w| matches!(w, [a, b] if a == b)),
            "scalar rows indented inconsistently: {daemon_lines:?}"
        );
    }

    #[test]
    fn print_config_section_collapses_all_default_subtables() {
        set_color_enabled(false);
        let config = serde_json::json!({
            "outer": {
                "nested": { "a": 1, "b": 2 },
                "kept": "user-value",
            }
        });
        let defaults = serde_json::json!({
            "outer": {
                "nested": { "a": 1, "b": 2 },
                "kept": "default-value",
            }
        });
        let mut buf: Vec<u8> = Vec::new();
        print_config_section(&mut buf, &config, Some(&defaults), 0, false);
        let rendered = String::from_utf8(buf).expect("utf8");
        assert!(
            !rendered.contains("nested:"),
            "subtable with no non-default descendants should be elided:\n{rendered}"
        );
        assert!(
            rendered.contains("outer:") && rendered.contains("kept"),
            "outer header and non-default leaf should be shown:\n{rendered}"
        );
    }
}
