use std::io::{self, Write};

use crossterm::style::{Attribute, SetAttribute};

use super::transcript::{character_color, format_time};
use super::vocab::{COLOR_ERROR, Tone, indent_to, paint};
use super::{
    COLOR_RESULT, COLOR_SUBAGENT, COLOR_THINKING, COLOR_TOOL, SIGIL_ERROR, SIGIL_OK,
    SIGIL_SUBAGENT, SIGIL_THINKING, SIGIL_TOOL, abbreviate_model, format_tool_input,
    format_tool_output, parse_timestamp, primary_tool_arg, print_dim_line, term_width, use_color,
    write_dim, write_fg, write_process_body, write_row, write_row_colored, write_section_header,
    write_sigil_header,
};

const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_DAY: u64 = 86_400;

// ---------------------------------------------------------------------------
// Status formatter -- human-readable dashboard
// ---------------------------------------------------------------------------

/// Map a normalized density (0.0-1.0) to a bar character.
///
/// Uses 8 Unicode block elements for non-zero values and a light shade for
/// effectively-zero values.
#[expect(
    clippy::float_arithmetic,
    reason = "heatmap rendering maps a normalized float density onto eight display glyphs"
)]
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
/// Write the activity heatmap section into the status dashboard.
///
/// Renders a 24-character bar chart (one block per hour) with hour labels
/// underneath, plus engagement and session stats.
#[expect(
    clippy::float_arithmetic,
    reason = "activity heatmap uses visual-only logarithmic scaling of normalized f64 densities"
)]
// ---------------------------------------------------------------------------
// Command-specific formatters
// ---------------------------------------------------------------------------

/// Dispatch a command response to the appropriate formatter.
/// Falls back to generic JSON output for unknown command names.
pub(crate) fn format_command(name: &str, data: &serde_json::Value) {
    match name {
        "character_info" => print_character_info(data),
        "switch_model" => print_model_switched(data),
        "reset_model" => print_model_reset(data),
        "set_model_setting" => print_set_model_setting(data),
        "refresh_provider_models" => print_provider_refresh(data),
        "refresh_all_provider_models" => print_provider_refresh_all(data),
        "memory" => print_memory(data),
        "compact" => print_compact_result(data),
        "config_reload" => print_config_reload(data),
        "config_reset" => print_config_reset(data),
        "edit" => print_edit_confirmation(data),
        "delete" => print_delete_confirmation(data),
        "alt" => print_alt_confirmation(data),
        "list_alternatives" => print_alt_list(data),
        "inject_system" => cli_out!("System instruction injected."),
        "diagnostics" => print_diagnostics(data),
        "heartbeat_log" => super::transcript::print_heartbeat_log(data),
        "call_log" => print_call_log(data),
        "transcript" => print_transcript(data),
        "subagent_trace" => print_subagent_trace(data),
        "heartbeat_tick_now" => print_heartbeat_tick_now(data),
        "heartbeat_set_dormant" => print_heartbeat_status_change(data, "dormant"),
        "heartbeat_set_active" => print_heartbeat_status_change(data, "active"),
        "session_activate" => print_session_activate(data),
        "keepalive_ping_now" => print_keepalive_ping(data),
        "run_tool" => print_run_tool(data),
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
    let count = entries.len();
    let plural = if count == 1 { "call" } else { "calls" };
    write_section_header(&mut out, "call log", &format!("{count} {plural}"), width);
    for entry in entries {
        let usage = &entry["usage"];
        write_fg(
            &mut out,
            Tone::Muted,
            &format!("  #{:<6}", entry["id"].as_i64().unwrap_or(0)),
        );
        write_fg(
            &mut out,
            Tone::Active,
            &format!("{:<18}", entry["call_type"].as_str().unwrap_or("?")),
        );
        write_fg(
            &mut out,
            Tone::Thinking,
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
        "(shore trace calls <id> to dump one call; --json for raw)",
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
        write_fg(out, Tone::Active, &format!("  {label}:\n"));
        let body = display_payload_body(&call[key]);
        let formatted = if key == "response" {
            format_stream_payload(&body)
        } else {
            format_json_payload(&body)
        };
        _ = writeln!(out, "{}", truncate_payload(&formatted, CALL_BODY_PREVIEW));
        _ = writeln!(out);
    }
    print_dim_line(out, "(--json for the full, untruncated payload)");
}

fn format_json_payload(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body).map_or_else(
        |_| body.to_owned(),
        |value| serde_json::to_string_pretty(&value).unwrap_or_else(|_| body.to_owned()),
    )
}

fn format_stream_payload(body: &str) -> String {
    let mut events = Vec::new();
    for parsed in serde_json::Deserializer::from_str(body).into_iter::<serde_json::Value>() {
        let Ok(value) = parsed else {
            return body.to_owned();
        };
        if events
            .last_mut()
            .is_some_and(|previous| merge_stream_delta(previous, &value))
        {
            continue;
        }
        events.push(value);
    }
    if events.is_empty() {
        return body.to_owned();
    }
    events
        .iter()
        .map(|event| serde_json::to_string_pretty(event).unwrap_or_else(|_| event.to_string()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn merge_stream_delta(previous: &mut serde_json::Value, next: &serde_json::Value) -> bool {
    let Some(kind) = next["type"].as_str() else {
        return false;
    };
    if previous["type"].as_str() != Some(kind) {
        return false;
    }
    let field = match kind {
        "text" | "thinking" => "text",
        "reasoning_content" => "reasoning",
        _ => return false,
    };
    let (Some(left), Some(right)) = (previous[field].as_str(), next[field].as_str()) else {
        return false;
    };
    let merged = format!("{left}{right}");
    previous[field] = serde_json::Value::String(merged);
    true
}

fn truncate_payload(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_owned();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}… (+{} chars)", count.saturating_sub(max))
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
            Tone::Thinking,
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
            let body = display_payload_body(&exchange[key]);
            if body.is_empty() {
                continue;
            }
            write_fg(out, Tone::Active, &format!("  {label}:\n"));
            _ = writeln!(out, "{}", truncate_display(&body, CALL_BODY_PREVIEW));
        }
        _ = writeln!(out);
    }
    print_dim_line(out, "(--json for the untruncated wire bytes and headers)");
}

fn display_payload_body(body: &serde_json::Value) -> String {
    match body {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        value @ serde_json::Value::Bool(_)
        | value @ serde_json::Value::Number(_)
        | value @ serde_json::Value::Array(_)
        | value @ serde_json::Value::Object(_) => {
            serde_json::to_string_pretty(value).unwrap_or_default()
        }
    }
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
            (Tone::Good, '+')
        } else {
            (COLOR_ERROR, '-')
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
        "(shore trace calls <id> for the call in full; --json for the raw diff)",
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
    write_fg(out, Tone::Muted, &format!("  {time_str:<14}"));
    write_fg(
        out,
        Tone::Active,
        &format!(
            "{}#{}",
            entry["call_type"].as_str().unwrap_or("?"),
            entry["iteration"].as_u64().unwrap_or(0)
        ),
    );
    write_fg(
        out,
        Tone::Thinking,
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
            write_fg(out, Tone::Active, "                reasoning: ");
            _ = writeln!(out, "{}", block.trim());
        }
    }
    let text = inner["text"].as_str().unwrap_or("");
    if !text.trim().is_empty() {
        write_fg(out, Tone::Heading, "                text: ");
        _ = writeln!(out, "{}", text.trim());
    }
    if let Some(tools) = inner["tool_calls"].as_array() {
        for tool in tools {
            let is_error = tool["is_error"].as_bool().unwrap_or(false);
            let color = if is_error { COLOR_ERROR } else { Tone::Active };
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

fn print_subagent_trace(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    let char_name = data["character"].as_str().unwrap_or("?");
    write_section_header(&mut out, "sub-agent runs", char_name, width);

    let Some(entries) = data["entries"].as_array().filter(|e| !e.is_empty()) else {
        print_dim_line(&mut out, &subagent_trace_empty_message(data));
        return;
    };
    let mut prev_date: Option<String> = None;
    for entry in entries {
        print_subagent_run(&mut out, entry, &mut prev_date);
    }
}

fn subagent_trace_empty_message(data: &serde_json::Value) -> String {
    match data["requested_ids"].as_array().and_then(|ids| ids.first()) {
        Some(id) => format!(
            "(no sub-agent run with id {} — `shore trace subagent` lists what is stored)",
            id.as_str().unwrap_or("?")
        ),
        None => "(no sub-agent runs recorded yet)".to_owned(),
    }
}

fn print_subagent_run(
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
    write_fg(out, Tone::Muted, &format!("  {time_str:<14}"));
    write_fg(
        out,
        Tone::Active,
        &format!("ask_{}", entry["subagent"].as_str().unwrap_or("?")),
    );
    write_fg(
        out,
        Tone::Thinking,
        &format!(
            "  {}",
            abbreviate_model(entry["model"].as_str().unwrap_or("?"))
        ),
    );
    _ = writeln!(out);
    write_dim(
        out,
        &format!(
            "                {}",
            entry["parent_tool_use_id"].as_str().unwrap_or("?")
        ),
    );
    _ = writeln!(out);

    if let Some(messages) = entry["messages"].as_array() {
        for msg in messages {
            let Some(blocks) = msg["content_blocks"].as_array() else {
                continue;
            };
            for block in blocks {
                print_subagent_block(out, block);
            }
        }
    }

    match (entry["error"].as_str(), entry["result"].as_str()) {
        (Some(error), _) => {
            write_fg(out, COLOR_ERROR, "                failed: ");
            _ = writeln!(out, "{}", truncate_display(error, 600));
        }
        (None, Some(result)) => {
            write_fg(out, Tone::Heading, "                answer: ");
            _ = writeln!(out, "{}", truncate_display(result, 600));
        }
        (None, None) => {}
    }
    _ = writeln!(out);
}

fn print_subagent_block(out: &mut impl Write, block: &serde_json::Value) {
    match block["type"].as_str().unwrap_or("") {
        "thinking" => {
            let thinking = block["thinking"].as_str().unwrap_or("");
            if thinking.trim().is_empty() {
                return;
            }
            write_sigil_header(out, SIGIL_THINKING, "Thinking", COLOR_THINKING);
            write_process_body(out, thinking.trim());
        }
        "text" => {
            let text = block["text"].as_str().unwrap_or("");
            if text.trim().is_empty() {
                return;
            }
            write_sigil_header(out, SIGIL_SUBAGENT, "answer", COLOR_SUBAGENT);
            write_process_body(out, text.trim());
        }
        "tool_use" => {
            let name = block["name"].as_str().unwrap_or("?");
            let header = match primary_tool_arg(&block["input"]) {
                Some(arg) => format!("{name} \u{00b7} {arg}"),
                None => name.to_owned(),
            };
            write_sigil_header(out, SIGIL_TOOL, &header, COLOR_TOOL);
            if let Some(input) = format_tool_input(&block["input"]) {
                write_process_body(out, &input);
            }
        }
        "tool_result" => {
            let is_error = block["is_error"].as_bool().unwrap_or(false);
            let (sigil, label, color) = if is_error {
                (SIGIL_ERROR, "error", COLOR_ERROR)
            } else {
                (SIGIL_OK, "result", COLOR_RESULT)
            };
            write_sigil_header(out, sigil, label, color);
            let body = block["content"]
                .as_str()
                .map_or_else(|| block["content"].to_string(), str::to_owned);
            write_process_body(out, &format_tool_output(&body));
        }
        _ => {}
    }
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
        write_fg(&mut out, Tone::Warn, warning);
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

fn print_keepalive_ping(data: &serde_json::Value) {
    let character = data["character"].as_str().unwrap_or("?");
    let status = data["status"].as_str().unwrap_or("?");
    let read = data["cache_read_tokens"].as_u64().unwrap_or(0);
    let written = data["cache_creation_tokens"].as_u64().unwrap_or(0);

    match status {
        "warm" => cli_out!("Ping for {character}: warm — read {read} cached tokens."),
        "cold" => {
            cli_out!("Ping for {character}: COLD — read nothing, wrote {written} cache tokens.")
        }
        other => cli_out!("Ping for {character}: {other}."),
    }
    if let Some(source) = data["source"].as_str() {
        cli_out!("  Sent from: {source}");
    }
    if let Some(note) = data["note"].as_str() {
        cli_out!("  {note}");
    }
    if let Some(err) = data["error"].as_str() {
        cli_out!("  {err}");
    }
}

fn print_run_tool(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let tool = data["tool"].as_str().unwrap_or("?");
    let ok = data["ok"].as_bool().unwrap_or(false);
    write_section_header(&mut out, tool, run_tool_subtitle(data), width);

    write_fg(
        &mut out,
        if ok { Tone::Good } else { COLOR_ERROR },
        if ok { "  ok" } else { "  failed" },
    );
    write_dim(
        &mut out,
        &format!(
            "  in {}  \u{2022}  {} chars",
            format_duration_ms(data["duration_ms"].as_u64().unwrap_or(0)),
            data["result_chars"].as_u64().unwrap_or(0)
        ),
    );
    _ = writeln!(out);

    for note in run_tool_notes(data) {
        print_dim_line(&mut out, &note);
    }

    print_run_tool_calls(&mut out, data, width);

    _ = writeln!(out);
    let body = data["raw"]
        .as_str()
        .or_else(|| data["output"].as_str())
        .unwrap_or("");
    if body.is_empty() {
        print_dim_line(&mut out, "(the tool returned nothing)");
    } else {
        _ = writeln!(out, "{body}");
    }
}

fn run_tool_subtitle(data: &serde_json::Value) -> &str {
    match data["kind"].as_str().unwrap_or("") {
        "subagent" => "sub-agent",
        "mcp" => "mcp",
        _ => "",
    }
}

fn run_tool_notes(data: &serde_json::Value) -> Vec<String> {
    let mut notes = Vec::new();

    if data["rejected"].as_bool().unwrap_or(false) {
        notes.push("refused before dispatch \u{2014} nothing ran, nothing changed".to_owned());
    }

    if data["truncated"].as_bool().unwrap_or(false) {
        let shown = data["output"].as_str().map_or(0, |s| s.chars().count());
        let total = data["result_chars"].as_u64().unwrap_or(0);
        let tail = if data["raw"].is_string() {
            " (--raw shown below)"
        } else {
            " (--raw for the rest)"
        };
        notes.push(format!(
            "truncated \u{2014} the model would see {shown} of {total} chars{tail}"
        ));
    }

    if !data["enabled"].as_bool().unwrap_or(true) {
        notes.push(
            "not on this character's tool surface \u{2014} it ran here, but the model \
             cannot call it (`shore tools`)"
                .to_owned(),
        );
    }

    notes
}

fn print_run_tool_calls(out: &mut impl Write, data: &serde_json::Value, width: usize) {
    let Some(calls) = data["calls"].as_array().filter(|c| !c.is_empty()) else {
        return;
    };

    _ = writeln!(out);
    write_section_header(out, "nested calls", &format!("{}", calls.len()), width);
    for call in calls {
        let ok = call["ok"].as_bool().unwrap_or(false);
        write_fg(out, if ok { Tone::Good } else { COLOR_ERROR }, "  \u{2022} ");
        write_fg(out, Tone::Active, call["tool"].as_str().unwrap_or("?"));
        if let Some(agent) = call["subagent"].as_str() {
            write_dim(out, &format!("  (ask_{agent})"));
        }
        _ = writeln!(out);
        write_dim(out, &format!("      {}", call["input"].as_str().unwrap_or("")));
        _ = writeln!(out);
        for line in call["output"].as_str().unwrap_or("").lines() {
            write_dim(out, &format!("      \u{2192} {line}"));
            _ = writeln!(out);
        }
    }
}

const MILLIS_PER_SECOND: u64 = 1_000;
const MILLIS_PER_TENTH: u64 = 100;

fn format_duration_ms(ms: u64) -> String {
    if ms < MILLIS_PER_SECOND {
        return format!("{ms}ms");
    }
    let seconds = checked_div_u64(ms, MILLIS_PER_SECOND);
    let tenths = checked_div_u64(checked_rem_u64(ms, MILLIS_PER_SECOND), MILLIS_PER_TENTH);
    format!("{seconds}.{tenths}s")
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
    let msg_ref = data["_display_ref"]
        .as_str()
        .or_else(|| data["ref"].as_str())
        .unwrap_or("?");
    cli_out!("Edited message {msg_ref}");
}

/// Print delete confirmation.
fn print_delete_confirmation(data: &serde_json::Value) {
    if let Some(display_ref) = data["_display_ref"].as_str() {
        cli_out!("Deleted message {display_ref}");
        return;
    }
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
    let msg_ref = data["_display_ref"]
        .as_str()
        .or_else(|| data["ref"].as_str())
        .unwrap_or("?");
    let position = data["position"].as_u64().unwrap_or(0);
    let count = data["alt_count"].as_u64().unwrap_or(0);
    cli_out!("Selected alternate {position}/{count} for {msg_ref}");
    if let Some(content) = data["content"].as_str() {
        let preview = first_line_preview(content, ALT_PREVIEW_CHARS);
        if !preview.is_empty() {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            write_dim(&mut out, &format!("  {preview}\n"));
        }
    }
}

/// Characters of the newly selected alternate echoed back as confirmation.
const ALT_PREVIEW_CHARS: usize = 160;

fn first_line_preview(content: &str, max: usize) -> String {
    let line = content
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() <= max {
        return line.to_owned();
    }
    let kept: String = line.chars().take(max).collect();
    format!("{kept}…")
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
    let msg_ref = data["_display_ref"]
        .as_str()
        .or_else(|| data["ref"].as_str())
        .unwrap_or("?");
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
        indent_to(&mut out, 0);
        _ = writeln!(out, "{marker} {position}/{count}  {preview}");
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
                    paint(&mut out, Tone::Good, &format!("  ok  "));
                } else {
                    indent_to(&mut out, 0);
                    _ = write!(out, "ok  ");
                }
                _ = writeln!(out, "{provider}: {count} models (fetched {fetched})");
            } else {
                fail_count = fail_count.saturating_add(1);
                let err = r["error"].as_str().unwrap_or("unknown error");
                if use_color() {
                    paint(&mut out, COLOR_ERROR, &format!("  FAIL"));
                } else {
                    indent_to(&mut out, 0);
                    _ = write!(out, "FAIL");
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
                paint(&mut out, Tone::Muted, &format!("  {provider}: {reason}"));
                _ = writeln!(out);
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
        write_row_colored(&mut out, "Active", "yes", Tone::Good);
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
        write_row_colored(&mut out, "Config override", "yes", Tone::Warn);
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
            for line in preview.lines().take(8) {
                paint(&mut out, Tone::Muted, &format!("  {line}"));
                _ = writeln!(out);
            }
            if false {
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
            if let Some(sub) = call["subagent"].as_str() {
                write_dim(w, &format!("  via {sub}"));
            }

            if let Some(err) = call.get("error").filter(|v| !v.is_null()) {
                write_fg(
                    w,
                    COLOR_ERROR,
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
            if let Some(sub) = call["subagent"].as_str() {
                write_dim(w, &format!("via {sub}  "));
            }
            let (marker_color, marker_text) = if ok {
                (Tone::Good, "ok")
            } else {
                (COLOR_ERROR, "FAIL")
            };
            write_fg(w, marker_color, marker_text);
            _ = writeln!(w);
        },
    );

    // -- Errors --
    print_diagnostics_section(&mut out, "Errors", &data["errors"], width, |w, err| {
        let etype = err["error_type"].as_str().unwrap_or("?");
        let msg = err["message"].as_str().unwrap_or("?");

        write_fg(w, COLOR_ERROR, &format!("{etype:<12}"));
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
    if neg { format!("-{body}") } else { body }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;

    #[test]
    fn call_request_payload_is_pretty_printed() {
        let formatted = format_json_payload(r#"{"sdk":"openai","messages":[]}"#);

        assert_eq!(
            formatted,
            "{\n  \"sdk\": \"openai\",\n  \"messages\": []\n}"
        );
    }

    #[test]
    fn call_response_payload_coalesces_stream_deltas() {
        let body = concat!(
            "{\"type\":\"start\",\"model\":\"kimi-k3\"}\n",
            "{\"type\":\"text\",\"text\":\"you\"}\n",
            "{\"type\":\"text\",\"text\":\" know\"}\n",
            "{\"type\":\"text\",\"text\":\" what?\"}\n",
            "{\"type\":\"done\",\"finish_reason\":\"stop\"}"
        );
        let formatted = format_stream_payload(body);

        assert_eq!(formatted.matches("\"type\": \"text\"").count(), 1);
        assert!(formatted.contains("\"text\": \"you know what?\""));
        assert!(formatted.contains("\"model\": \"kimi-k3\""));
        assert!(formatted.contains("\"finish_reason\": \"stop\""));
    }

    #[test]
    fn malformed_call_payload_is_left_alone() {
        let body = "not json\nand still useful";

        assert_eq!(format_json_payload(body), body);
        assert_eq!(format_stream_payload(body), body);
    }

    #[test]
    fn call_payload_truncation_preserves_newlines() {
        assert_eq!(truncate_payload("one\ntwo", 5), "one\nt… (+2 chars)");
    }

    fn sample_subagent_run() -> serde_json::Value {
        serde_json::json!({
            "ts": "2026-08-12T23:00:56.613+10:00",
            "subagent": "researcher",
            "parent_tool_use_id": "toolu_01A",
            "rid": "r-1",
            "model": "anthropic/claude-haiku-4-5",
            "messages": [
                {
                    "role": "assistant",
                    "content_blocks": [
                        {"type": "thinking", "thinking": "She asked when the flatmate left. Memory first, then the workspace."},
                        {"type": "tool_use", "name": "search_memory", "input": {"query": "flatmate moved out"}},
                    ],
                },
                {
                    "role": "user",
                    "content_blocks": [
                        {"type": "tool_result", "tool_use_id": "t1", "content": "MEMORY.md: June — Sam took the smaller room.", "is_error": false},
                    ],
                },
                {
                    "role": "assistant",
                    "content_blocks": [
                        {"type": "tool_use", "name": "read", "input": {"path": "notes/house.md"}},
                    ],
                },
                {
                    "role": "user",
                    "content_blocks": [
                        {"type": "tool_result", "tool_use_id": "t2", "content": "file unreadable: notes/house.md", "is_error": true},
                    ],
                },
            ],
            "result": "Sam moved out in June and took the smaller room with them.",
        })
    }

    #[test]
    fn subagent_run_renders_tools_and_the_answer() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        print_subagent_run(&mut buf, &sample_subagent_run(), &mut None);
        let rendered = String::from_utf8(buf).expect("utf8");

        assert!(rendered.contains("ask_researcher"));
        assert!(rendered.contains("toolu_01A"));
        assert!(rendered.contains("Sam took the smaller room"));
        assert!(rendered.contains("Sam moved out in June"));

        assert!(
            rendered.contains("\u{2192} search_memory"),
            "a tool call must use the shared call sigil: {rendered}"
        );
        assert!(
            rendered.contains("\u{2717} error"),
            "a failed result must use the shared error sigil: {rendered}"
        );
        for line in rendered.lines().filter(|l| l.contains("search_memory")) {
            assert!(
                line.trim_start().starts_with('\u{2502}'),
                "every channel line keeps the gutter: {line:?}"
            );
        }
    }

    fn with_error(mut entry: serde_json::Value, message: &str) -> serde_json::Value {
        if let Some(obj) = entry.as_object_mut() {
            _ = obj.insert("error".to_owned(), serde_json::json!(message));
        }
        entry
    }

    #[test]
    fn a_failed_subagent_run_shows_the_error_instead_of_an_answer() {
        set_color_enabled(false);
        let entry = with_error(sample_subagent_run(), "budget exhausted for subagent");
        let mut buf = Vec::new();
        print_subagent_run(&mut buf, &entry, &mut None);
        let rendered = String::from_utf8(buf).expect("utf8");

        assert!(rendered.contains("failed: budget exhausted"));
        assert!(!rendered.contains("answer:"));
    }

    #[test]
    fn an_id_that_matched_nothing_does_not_claim_the_store_is_empty() {
        let asked = serde_json::json!({
            "character": "ada",
            "requested_ids": ["toolu_absent"],
            "entries": [],
        });
        let bare = serde_json::json!({ "character": "ada", "entries": [] });

        assert!(subagent_trace_empty_message(&asked).contains("toolu_absent"));
        assert_eq!(
            subagent_trace_empty_message(&bare),
            "(no sub-agent runs recorded yet)",
        );
    }

    #[test]
    fn a_label_wider_than_the_column_keeps_a_space_before_its_value() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_row(&mut buf, "Max output tokens", "8192");
        let rendered = String::from_utf8(buf).expect("utf8");

        assert_eq!(rendered, "  Max output tokens 8192\n");
    }

    /// Visual preview of `shore trace subagent` rendering. Run with:
    /// `cargo test -p shore-cli render_preview_subagent -- --ignored --nocapture --test-threads=1`
    #[test]
    #[ignore = "visual preview"]
    fn render_preview_subagent() {
        set_color_enabled(true);
        let mut buf = Vec::new();
        print_subagent_run(&mut buf, &sample_subagent_run(), &mut None);
        let failed = with_error(sample_subagent_run(), "upstream returned 529 overloaded");
        print_subagent_run(&mut buf, &failed, &mut Some("2026-08-12".to_owned()));
        set_color_enabled(false);

        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"\n----- SUBAGENT RUNS (shore trace subagent) -----\n");
        _ = stdout.write_all(&buf);
        _ = stdout.write_all(b"----- end -----\n");
        _ = stdout.flush();
    }

    #[test]
    fn payload_json_is_pretty_printed_without_string_escaping() {
        let body = serde_json::json!({"messages": [{"role": "user", "content": "hello"}]});
        let rendered = display_payload_body(&body);
        assert!(rendered.contains("\"messages\": ["));
        assert!(!rendered.contains("\\\"messages\\\""));
    }

    #[test]
    fn non_json_payload_text_is_preserved() {
        let body = serde_json::Value::String("event: message_start\n".into());
        assert_eq!(display_payload_body(&body), "event: message_start\n");
    }





    // ── classification_color ─────────────────────────────────────────


    // ── heartbeat_description edge cases ──────────────────────────


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
    fn run_tool_notes_are_silent_when_the_call_was_ordinary() {
        let data = serde_json::json!({
            "ok": true,
            "rejected": false,
            "truncated": false,
            "enabled": true,
        });
        assert!(run_tool_notes(&data).is_empty());
    }

    #[test]
    fn run_tool_notes_say_a_rejected_call_never_ran() {
        let data = serde_json::json!({
            "ok": false,
            "rejected": true,
            "truncated": false,
            "enabled": true,
        });
        let notes = run_tool_notes(&data);
        assert_eq!(notes.len(), 1);
        assert!(notes.join(" ").contains("nothing ran"));
    }

    #[test]
    fn run_tool_notes_compare_what_the_model_would_see_against_the_whole_result() {
        let data = serde_json::json!({
            "ok": true,
            "rejected": false,
            "truncated": true,
            "output": "abcde",
            "result_chars": 900,
            "raw": serde_json::Value::Null,
            "enabled": true,
        });
        let notes = run_tool_notes(&data).join(" ");
        assert!(notes.contains("5 of 900"));
        assert!(notes.contains("--raw for the rest"));
    }

    #[test]
    fn run_tool_notes_flag_a_tool_the_model_cannot_reach() {
        let data = serde_json::json!({
            "ok": true,
            "rejected": false,
            "truncated": false,
            "enabled": false,
        });
        assert!(
            run_tool_notes(&data)
                .join(" ")
                .contains("not on this character's tool surface")
        );
    }

    #[test]
    fn format_duration_ms_switches_to_seconds_past_a_second() {
        assert_eq!(format_duration_ms(0), "0ms");
        assert_eq!(format_duration_ms(999), "999ms");
        assert_eq!(format_duration_ms(1_000), "1.0s");
        assert_eq!(format_duration_ms(8_240), "8.2s");
    }

    #[test]
    fn print_run_tool_renders_a_subagent_run_with_its_nested_calls() {
        set_color_enabled(false);
        format_command(
            "run_tool",
            &serde_json::json!({
                "tool": "ask_librarian",
                "character": "ada",
                "kind": "subagent",
                "enabled": true,
                "input": { "query": "what did we decide" },
                "ok": true,
                "rejected": false,
                "duration_ms": 8_240,
                "output": "we decided on a 1h TTL",
                "truncated": false,
                "result_chars": 22,
                "raw": serde_json::Value::Null,
                "calls": [{
                    "tool": "read",
                    "subagent": "librarian",
                    "ok": true,
                    "input": "{\"path\":\"notes.md\"}",
                    "output": "the tide came in",
                }],
            }),
        );
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

}
