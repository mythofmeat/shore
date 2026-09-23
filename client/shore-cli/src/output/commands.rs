#[cfg(test)]
use std::io;
use std::io::Write;

use crossterm::style::{Attribute, SetAttribute};
use shore_common::duration::format_duration_ms;

use super::transcript::{LogFilter, character_color, format_time, print_log};
use super::vocab::{COLOR_ERROR, Tone, indent_to, paint, wrap_line};
use super::{
    COLOR_RESULT, COLOR_SUBAGENT, COLOR_THINKING, COLOR_TOOL, SIGIL_ERROR, SIGIL_OK,
    SIGIL_SUBAGENT, SIGIL_THINKING, SIGIL_TOOL, abbreviate_model, format_tool_input,
    format_tool_output, parse_timestamp, primary_tool_arg, print_dim_line, term_width, use_color,
    write_dim, write_fg, write_process_body, write_row, write_row_colored, write_section_header,
    write_sigil_header, write_tool_body_plain,
};

const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_DAY: u64 = 86_400;

fn checked_div_u64(value: u64, divisor: u64) -> u64 {
    value.checked_div(divisor).unwrap_or_default()
}

fn checked_rem_u64(value: u64, divisor: u64) -> u64 {
    value.checked_rem(divisor).unwrap_or_default()
}

pub(crate) fn format_command(name: &str, data: &serde_json::Value) {
    match name {
        "character_info" => print_character_info(data),
        "export_character" => cli_out!(
            "Exported {} to {} ({} bytes).",
            data["character"].as_str().unwrap_or("character"),
            data["archive"].as_str().unwrap_or("archive"),
            data["bytes"].as_u64().unwrap_or(0),
        ),
        "import_character" => cli_out!(
            "Imported character {}.",
            data["character"].as_str().unwrap_or("?"),
        ),
        "switch_model" => print_model_switched(data),
        "favorite_model" => print_model_favorited(data),
        "reset_model" => print_model_reset(data),
        "set_model_setting" => print_set_model_setting(data),
        "refresh_provider_models" => print_provider_refresh(data),
        "refresh_all_provider_models" => print_provider_refresh_all(data),
        "compact" => print_compact_result(data),
        "segments" => print_segments(data),
        "clear" => print_clear_result(data),
        "config_reload" => print_config_reload(data),
        "edit" => print_edit_confirmation(data),
        "delete" => print_delete_confirmation(data),
        "alt" => print_alt_confirmation(data),
        "list_alternatives" => print_alt_list(data),
        "inject_system" => cli_out!("System instruction injected."),
        "error_log" => print_error_log(data),
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

fn print_segments(data: &serde_json::Value) {
    if let Some(segment) = data.get("segment") {
        print_segment_row(segment);
        if let Some(messages) = data.get("messages").and_then(serde_json::Value::as_array) {
            if messages.is_empty() {
                print_dim_line(
                    &mut crate::output::stdout().lock(),
                    "(no messages recorded)",
                );
            } else {
                cli_out!();
                print_log(
                    messages,
                    data["character"].as_str().unwrap_or("?"),
                    LogFilter::default(),
                );
            }
        }
        return;
    }
    let Some(segments) = data.get("segments").and_then(serde_json::Value::as_array) else {
        print_dim_line(
            &mut crate::output::stdout().lock(),
            "(no segments recorded)",
        );
        return;
    };
    if segments.is_empty() {
        print_dim_line(
            &mut crate::output::stdout().lock(),
            "(no segments recorded)",
        );
        return;
    }
    for segment in segments {
        print_segment_row(segment);
    }
}

fn print_segment_row(segment: &serde_json::Value) {
    let excluded = if segment["excluded"].as_bool().unwrap_or(false) {
        "  excluded"
    } else {
        ""
    };
    let label = segment["label"]
        .as_str()
        .map_or_else(String::new, |value| format!("  {value}"));
    cli_out!(
        "#{:<4} {} → {}  {} messages{}{}",
        segment["index"].as_u64().unwrap_or(0),
        segment["first_message_at"].as_str().unwrap_or("?"),
        segment["last_message_at"].as_str().unwrap_or("?"),
        segment["message_count"].as_u64().unwrap_or(0),
        excluded,
        label,
    );
    if let Some(note) = segment["note"].as_str() {
        cli_out!("      {note}");
    }
    match (
        segment["memory_before"].as_str(),
        segment["memory_after"].as_str(),
    ) {
        (Some(before), Some(after)) if before == after => {
            cli_out!("      memory: unchanged {after}")
        }
        (Some(before), Some(after)) => cli_out!("      memory: {before}..{after}"),
        (None, Some(after)) => cli_out!("      memory: root..{after}"),
        _ => {}
    }
}

fn print_clear_result(data: &serde_json::Value) {
    cli_out!(
        "Cleared {} messages into segment #{}.",
        data["message_count"].as_u64().unwrap_or(0),
        data.pointer("/segment/index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    );
}

const CALL_BODY_PREVIEW: usize = 4000;

fn print_call_log(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_call_log(&mut out, data, term_width());
}

pub(crate) fn write_call_log<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    if data.get("enabled").is_some_and(|v| v == false) {
        print_dim_line(out, "(call payload capture is disabled)");
        return;
    }

    if let Some(call) = data.get("call").filter(|c| !c.is_null()) {
        if let Some(diff) = data.get("diff").filter(|d| !d.is_null()) {
            print_call_diff(out, call, diff, width);
        } else {
            print_one_call(out, call, width);
        }
        print_wire_exchanges(out, data.get("wire"), width);
        return;
    }

    let Some(entries) = data["entries"].as_array().filter(|e| !e.is_empty()) else {
        print_dim_line(out, "(no calls recorded)");
        return;
    };
    let count = entries.len();
    let plural = if count == 1 { "call" } else { "calls" };
    write_section_header(out, "call log", &format!("{count} {plural}"), width);
    for entry in entries {
        let usage = &entry["usage"];
        write_fg(
            out,
            Tone::Muted,
            &format!("  #{:<6}", entry["id"].as_i64().unwrap_or(0)),
        );
        write_fg(
            out,
            Tone::Active,
            &format!("{:<18}", entry["call_type"].as_str().unwrap_or("?")),
        );
        write_fg(
            out,
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
            out,
            &format!(
                "          in={} out={} cache={}/{}  {}ms  {}B{}",
                usage["input_tokens"].as_u64().unwrap_or(0),
                usage["output_tokens"].as_u64().unwrap_or(0),
                usage["cache_read_tokens"].as_u64().unwrap_or(0),
                usage["cache_write_tokens"].as_u64().unwrap_or(0),
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
        out,
        "(shore trace calls <id> to dump one call; --json for raw)",
    );
}

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
            "  {}  {}/{}  {}  in={} out={} cache_read={} cache_write={}  {}ms",
            call["ts"].as_str().unwrap_or("?"),
            call["provider"].as_str().unwrap_or("?"),
            abbreviate_model(call["model"].as_str().unwrap_or("?")),
            call["call_type"].as_str().unwrap_or("?"),
            usage["input_tokens"].as_u64().unwrap_or(0),
            usage["output_tokens"].as_u64().unwrap_or(0),
            usage["cache_read_tokens"].as_u64().unwrap_or(0),
            usage["cache_write_tokens"].as_u64().unwrap_or(0),
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
            _ = writeln!(out, "{body}");
        }
        _ = writeln!(out);
    }
    if !exchanges.iter().any(has_wire_body) {
        print_dim_line(out, "(--wire for the request and response bodies)");
    }
}

fn has_wire_body(exchange: &serde_json::Value) -> bool {
    !exchange["request_body"].is_null() || !exchange["response_body"].is_null()
}

fn display_payload_body(body: &serde_json::Value) -> String {
    match body {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        value @ (serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::Array(_)
        | serde_json::Value::Object(_)) => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}

const DIFF_CHUNK_PREVIEW: usize = 1200;

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

fn print_transcript(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_trace_transcript(&mut out, data, term_width());
}

pub(crate) fn write_trace_transcript<W: Write>(
    out: &mut W,
    data: &serde_json::Value,
    width: usize,
) {
    let source = data["source"].as_str().unwrap_or("heartbeat");
    let char_name = data["character"].as_str().unwrap_or("?");
    write_section_header(out, &format!("{source} transcript"), char_name, width);

    if data.get("enabled").is_some_and(|v| v == false) {
        print_dim_line(out, "(payload capture is disabled)");
        return;
    }
    let Some(entries) = data["entries"].as_array().filter(|e| !e.is_empty()) else {
        print_dim_line(out, "(no transcript entries yet)");
        return;
    };
    let mut prev_date: Option<String> = None;
    for entry in entries {
        print_transcript_entry(out, entry, &mut prev_date);
    }
}

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
            "                {}  in={} out={} cache_read={} cache_write={}",
            entry["finish_reason"].as_str().unwrap_or(""),
            usage["input_tokens"].as_u64().unwrap_or(0),
            usage["output_tokens"].as_u64().unwrap_or(0),
            usage["cache_read_tokens"].as_u64().unwrap_or(0),
            usage["cache_write_tokens"].as_u64().unwrap_or(0),
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
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_subagent_trace(&mut out, data, term_width());
}

pub(crate) fn write_subagent_trace<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    let char_name = data["character"].as_str().unwrap_or("?");
    write_section_header(out, "sub-agent runs", char_name, width);

    let Some(entries) = data["entries"].as_array().filter(|e| !e.is_empty()) else {
        print_dim_line(out, &subagent_trace_empty_message(data));
        return;
    };
    let mut prev_date: Option<String> = None;
    for entry in entries {
        print_subagent_run(out, entry, &mut prev_date);
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
    let stdout = crate::output::stdout();
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
        let stdout = crate::output::stdout();
        let mut out = stdout.lock();
        write_fg(&mut out, Tone::Warn, warning);
        _ = writeln!(out);
    }
}

fn print_heartbeat_status_change(data: &serde_json::Value, status: &str) {
    let character = data["character"].as_str().unwrap_or("?");
    cli_out!("Heartbeat forced {status} for {character}.");
}

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
            cli_out!("Ping for {character}: COLD — read nothing, wrote {written} cache tokens.");
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

fn print_tool_definition(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_tool_definition(&mut out, data, term_width());
}

fn write_tool_definition<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    let tool = data["tool"].as_str().unwrap_or("?");
    let kind = data["kind"].as_str().unwrap_or("?");
    write_section_header(out, tool, kind, width);

    if data["enabled"].as_bool() == Some(false) {
        print_dim_line(
            out,
            "(not enabled for this character — it is not on the wire)",
        );
        _ = writeln!(out);
    }

    let description = data["description"].as_str().unwrap_or("");
    if description.is_empty() {
        print_dim_line(out, "(no description)");
    } else {
        for line in description.lines() {
            if line.trim().is_empty() {
                _ = writeln!(out);
                continue;
            }
            for wrapped in wrap_line(line, width.saturating_sub(4)) {
                indent_to(out, 0);
                _ = writeln!(out, "{wrapped}");
            }
        }
    }
    _ = writeln!(out);

    write_section_header(out, "input schema", "", width);
    let rendered = display_payload_body(&data["input_schema"]);
    for line in rendered.lines() {
        indent_to(out, 0);
        _ = writeln!(out, "{line}");
    }
}

fn print_run_tool(data: &serde_json::Value) {
    if data["mode"].as_str() == Some("tool_definition") {
        print_tool_definition(data);
        return;
    }
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_run_tool(&mut out, data, term_width());
}

pub(crate) fn write_run_tool<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    if data["mode"].as_str() == Some("tool_definition") {
        write_tool_definition(out, data, width);
        return;
    }
    let tool = data["tool"].as_str().unwrap_or("?");
    let ok = data["ok"].as_bool().unwrap_or(false);
    write_section_header(out, tool, run_tool_subtitle(data), width);

    write_fg(
        out,
        if ok { Tone::Good } else { COLOR_ERROR },
        if ok { "  ok" } else { "  failed" },
    );
    write_dim(
        out,
        &format!(
            "  in {}  \u{2022}  {} chars",
            format_duration_ms(data["duration_ms"].as_u64().unwrap_or(0)),
            data["result_chars"].as_u64().unwrap_or(0)
        ),
    );
    _ = writeln!(out);

    for note in run_tool_notes(data) {
        print_dim_line(out, &note);
    }

    print_run_tool_calls(out, data, width);

    _ = writeln!(out);
    let body = data["raw"]
        .as_str()
        .or_else(|| data["output"].as_str())
        .unwrap_or("");
    if body.is_empty() {
        print_dim_line(out, "(the tool returned nothing)");
    } else {
        write_tool_body_plain(out, &format_tool_output(body));
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
        write_fg(
            out,
            if ok { Tone::Good } else { COLOR_ERROR },
            "  \u{2022} ",
        );
        write_fg(out, Tone::Active, call["tool"].as_str().unwrap_or("?"));
        if let Some(agent) = call["subagent"].as_str() {
            write_dim(out, &format!("  (ask_{agent})"));
        }
        _ = writeln!(out);
        write_dim(
            out,
            &format!("      {}", call["input"].as_str().unwrap_or("")),
        );
        _ = writeln!(out);
        for line in call["output"].as_str().unwrap_or("").lines() {
            write_dim(out, &format!("      \u{2192} {line}"));
            _ = writeln!(out);
        }
    }
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
    match h["seconds_until_wake"].as_i64() {
        Some(secs) => format!("{state}, next wake in {}", format_duration_compact(secs)),
        None => format!("{state}, no wake scheduled"),
    }
}

fn print_edit_confirmation(data: &serde_json::Value) {
    let msg_ref = first_display_ref(data)
        .or_else(|| data["ref"].as_str())
        .unwrap_or("?");
    cli_out!("Edited message {msg_ref}");
}

fn first_display_ref(data: &serde_json::Value) -> Option<&str> {
    data["_display_refs"]
        .as_array()
        .and_then(|refs| refs.first())
        .and_then(serde_json::Value::as_str)
        .or_else(|| data["_display_ref"].as_str())
}

fn print_delete_confirmation(data: &serde_json::Value) {
    if let Some(refs) = data["_display_refs"].as_array() {
        let shown: Vec<&str> = refs.iter().filter_map(serde_json::Value::as_str).collect();
        match shown.as_slice() {
            [] => {}
            [one] => cli_out!("Deleted message {one}"),
            many => cli_out!("Deleted {} messages: {}", many.len(), many.join(", ")),
        }
        return;
    }
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
    }
}

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
            let stdout = crate::output::stdout();
            let mut out = stdout.lock();
            write_dim(&mut out, &format!("  {preview}\n"));
        }
    }
}

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

    let stdout = crate::output::stdout();
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

fn role_label(role: &str) -> String {
    if role == "background" {
        return "background tasks".to_owned();
    }
    role.strip_prefix("sub-agent: ")
        .map_or_else(|| role.to_owned(), |name| format!("sub-agent {name}"))
}

fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn print_model_switched(data: &serde_json::Value) {
    let model = data["active"].as_str().unwrap_or("(none)");
    let Some(role) = data["role"].as_str() else {
        cli_out!("Switched to model: {}", abbreviate_model(model));
        if let Some(thread) = data.get("shadowed_by_thread") {
            match thread.as_str() {
                Some(id) => cli_out!(
                    "  this thread ({id}) is pinned to its own model, so it keeps using that"
                ),
                None => {
                    cli_out!("  this thread is pinned to its own model, so it keeps using that")
                }
            }
        }
        return;
    };
    cli_out!(
        "Pinned {} to: {}",
        role_label(role),
        abbreviate_model(model)
    );
    let cleared = string_list(data, "cleared");
    if !cleared.is_empty() {
        cli_out!("  cleared {}", join_names(&cleared));
    }
}

fn print_model_favorited(data: &serde_json::Value) {
    let model = data["qualified_name"].as_str().unwrap_or("(none)");
    let favorite = data["favorite"].as_bool().unwrap_or(false);
    let changed = data["changed"].as_bool().unwrap_or(false);
    let name = abbreviate_model(model);
    match (favorite, changed) {
        (true, true) => cli_out!("Favorited {name}."),
        (true, false) => cli_out!("{name} is already a favorite."),
        (false, true) => cli_out!("Unfavorited {name}."),
        (false, false) => cli_out!("{name} was not a favorite."),
    }
}

fn print_model_reset(data: &serde_json::Value) {
    let model = data["active"].as_str().unwrap_or("(none)");
    let Some(role) = data["role"].as_str() else {
        cli_out!("Model reset to: {}", abbreviate_model(model));
        return;
    };
    let source = data["source"].as_str().unwrap_or("config default");
    cli_out!(
        "Unpinned {}; now {} ({source})",
        role_label(role),
        abbreviate_model(model)
    );
}

fn print_set_model_setting(data: &serde_json::Value) {
    let key = data["key"].as_str().unwrap_or("?");
    let scope = data["scope"].as_str().unwrap_or("?");
    let value = match data.get("value") {
        Some(v) if v.is_null() => "(cleared)".to_owned(),
        Some(v) => v.as_str().map_or_else(|| v.to_string(), String::from),
        None => "(cleared)".to_owned(),
    };
    let model = data["model"].as_str().unwrap_or("?");
    let also = string_list(data, "also_affects");
    if !also.is_empty() {
        let task = data["background_task"].as_str().unwrap_or("that task");
        cli_out!(
            "note: {} shares {model} with {} — {key} applies there too",
            role_label(task),
            join_names(&also)
        );
    }
    cli_out!("[{scope}] {key} = {value}  ({})", abbreviate_model(model));
    if let Some(warning) = data["warning"].as_str() {
        cli_out!("warning: {warning}");
    }
}

fn print_provider_refresh(data: &serde_json::Value) {
    let provider = data["provider"].as_str().unwrap_or("?");
    let count = data["model_count"].as_u64().unwrap_or(0);
    let fetched = data["fetched_at"].as_str().unwrap_or("?");
    cli_out!("Refreshed {provider}: {count} models (fetched {fetched})");
}

fn print_provider_refresh_all(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
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
                    paint(&mut out, Tone::Good, "  ok  ");
                } else {
                    indent_to(&mut out, 0);
                    _ = write!(out, "ok  ");
                }
                _ = writeln!(out, "{provider}: {count} models (fetched {fetched})");
            } else {
                fail_count = fail_count.saturating_add(1);
                let err = r["error"].as_str().unwrap_or("unknown error");
                if use_color() {
                    paint(&mut out, COLOR_ERROR, "  FAIL");
                } else {
                    indent_to(&mut out, 0);
                    _ = write!(out, "FAIL");
                }
                _ = writeln!(out, " {provider}: {err}");
            }
        }
    }

    if let Some(skipped) = data["skipped"].as_array()
        && !skipped.is_empty()
    {
        _ = writeln!(out);
        write_section_header(&mut out, "Skipped", "", width);
        for s in skipped {
            let provider = s["provider"].as_str().unwrap_or("?");
            let reason = s["reason"].as_str().unwrap_or("?");
            paint(&mut out, Tone::Muted, &format!("  {provider}: {reason}"));
            _ = writeln!(out);
        }
    }

    _ = writeln!(out);
    _ = writeln!(
        out,
        "Refreshed {ok_count} provider(s); {fail_count} failed."
    );
}

fn print_character_info(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
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

    if let Some(overrides) = data["prompt_overrides"].as_array()
        && !overrides.is_empty()
    {
        let names: Vec<&str> = overrides.iter().filter_map(|v| v.as_str()).collect();
        write_row(&mut out, "Prompts", &names.join(", "));
    }

    if let Some(dir) = data["data_dir"].as_str() {
        write_row(&mut out, "Data", dir);
    }

    if let Some(preview) = data["definition_preview"].as_str()
        && !preview.is_empty()
    {
        _ = writeln!(out);
        write_section_header(&mut out, "Preview", "", width);
        for line in preview.lines().take(8) {
            paint(&mut out, Tone::Muted, &format!("  {line}"));
            _ = writeln!(out);
        }
        if false {}
    }
    _ = writeln!(out);
}

fn print_compact_result(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_compact_result(&mut out, data, term_width());
}

fn planned_turns(data: &serde_json::Value) -> u64 {
    data["compacted_turns"]
        .as_u64()
        .or_else(|| data["turn_count"].as_u64())
        .unwrap_or(0)
}

fn string_list(data: &serde_json::Value, key: &str) -> Vec<String> {
    data[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn pause_reason_text(data: &serde_json::Value) -> String {
    let reason = data["reason"].as_str().unwrap_or("unknown");
    let detail = data["detail"].as_str().filter(|d| !d.is_empty());
    if reason == "workspace_conflict" {
        return match detail {
            Some(path) => format!("{path} changed since the pass wrote it"),
            None => "memory files changed since the pass wrote them".to_owned(),
        };
    }
    let named = match reason {
        "source_conflict" => "the conversation changed since the pass started",
        "iteration_limit" => "hit its tool-round ceiling",
        "budget" => "blocked by a usage budget",
        "provider" => "the model provider failed",
        other => other,
    };
    match detail {
        Some(extra) => format!("{named} ({extra})"),
        None => named.to_owned(),
    }
}

fn write_resume_rows(out: &mut impl Write, rounds: u64) {
    if rounds == 0 {
        write_row(out, "Resume", "shore compact");
        write_row(out, "Start over", "shore compact --restart");
        return;
    }
    let plural = if rounds == 1 { "" } else { "s" };
    write_row_colored(
        out,
        "Resume",
        &format!("shore compact — continues from the {rounds} round{plural} already paid for"),
        Tone::Good,
    );
    write_row_colored(
        out,
        "Start over",
        &format!("shore compact --restart — discards {rounds} round{plural} and pays again"),
        Tone::Warn,
    );
}

fn kept_row(out: &mut impl Write, data: &serde_json::Value) {
    let turns = planned_turns(data);
    write_row(
        out,
        "Turns",
        &format!("{turns} planned, all still in the conversation"),
    );
}

pub(crate) fn write_compact_result<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    let status = data["status"].as_str().unwrap_or("?");
    let suffix = match status {
        "dry_run" => "dry run",
        "compacted" => "",
        "rotated" => "archive-only",
        "paused" => "paused",
        "truncated" => "cut off",
        other => other,
    };
    write_section_header(out, "Compaction", suffix, width);

    let char_name = data["character"].as_str().unwrap_or("?");
    write_row(out, "Character", char_name);

    match status {
        "dry_run" => {
            let would = data["would_write_files"].as_u64().unwrap_or(0);
            write_row(out, "Would write", &format!("{would} files"));
            let retained_turns = data["retained_turns"].as_u64().unwrap_or(0);
            write_row(
                out,
                "Turns",
                &format!(
                    "{} compacted, {retained_turns} retained",
                    planned_turns(data)
                ),
            );
        }
        "compacted" => {
            let files = data["memory_files_written"].as_array().map_or(0, Vec::len);
            write_row(out, "Memory files", &format!("{files} written"));
            let retained_turns = data["retained_turns"].as_u64().unwrap_or(0);
            write_row(
                out,
                "Turns",
                &format!(
                    "{} compacted, {retained_turns} retained",
                    planned_turns(data)
                ),
            );
        }
        "rotated" => {
            let archived = data["archived_messages"].as_u64().unwrap_or(0);
            let dry = data["dry_run"].as_bool().unwrap_or(false);
            write_row(
                out,
                "Memory files",
                "none written (memory.compaction.write_memory = false)",
            );
            write_row(
                out,
                "Messages",
                &format!(
                    "{} {archived} into history",
                    if dry { "would archive" } else { "archived" }
                ),
            );
            let retained_turns = data["retained_turns"].as_u64().unwrap_or(0);
            write_row(
                out,
                "Turns",
                &format!(
                    "{} archived, {retained_turns} retained",
                    planned_turns(data)
                ),
            );
        }
        "paused" => {
            write_row_colored(out, "Outcome", "nothing archived", Tone::Warn);
            write_row(out, "Reason", &pause_reason_text(data));
            let rounds = data["tool_rounds"].as_u64().unwrap_or(0);
            let id = data["checkpoint_id"].as_str().unwrap_or("?");
            write_row(out, "Checkpoint", &format!("{id} ({rounds} tool rounds)"));
            if let Some(resume_at) = data["resume_at"].as_str() {
                write_row(out, "Retry after", resume_at);
            }
            kept_row(out, data);
            write_resume_rows(out, rounds);
        }
        "truncated" => {
            write_row_colored(
                out,
                "Outcome",
                "cut off at the token ceiling, so nothing was archived",
                Tone::Warn,
            );
            let truncated = data["truncated_turns"].as_u64().unwrap_or(0);
            let plural = if truncated == 1 { "" } else { "s" };
            write_row(out, "Truncated", &format!("{truncated} model turn{plural}"));
            let partial = string_list(data, "partial_writes");
            if !partial.is_empty() {
                write_row(out, "Partial", &partial.join(", "));
            }
            kept_row(out, data);
        }
        _ => {
            write_row_colored(out, "Outcome", status, Tone::Warn);
            kept_row(out, data);
        }
    }

    _ = writeln!(out);
}

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
    }

    if let Some(sections) = data["restart_required"].as_array()
        && !sections.is_empty()
    {
        let list: Vec<&str> = sections.iter().filter_map(|s| s.as_str()).collect();
        cli_out!(
            "Restart shore-daemon to apply startup-owned changes: {}",
            list.join(", ")
        );
    }
}

pub(crate) fn print_error_log(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_error_log(&mut out, data);
}

pub(crate) fn write_error_log<W: Write>(out: &mut W, data: &serde_json::Value) {
    let width = term_width();

    print_error_log_section(out, "Errors", &data["errors"], width, |w, err| {
        let etype = err["error_type"].as_str().unwrap_or("?");
        let msg = err["message"].as_str().unwrap_or("?");
        let context = err["context"].as_str().unwrap_or("");

        write_fg(w, COLOR_ERROR, &format!("{etype:<12}"));
        _ = write!(w, "{msg}");
        if !context.is_empty() {
            write_dim(w, &format!("  {context}"));
        }
        _ = writeln!(w);
    });

    print_error_log_section(
        out,
        "Key fallbacks",
        &data["key_fallbacks"],
        width,
        |w, event| {
            let from = event["from_key"].as_str().unwrap_or("?");
            let kind = event["kind"].as_str().unwrap_or("?");
            let reason = event["reason"].as_str().unwrap_or("?");

            if let Some(to) = event["to_key"].as_str() {
                _ = write!(w, "{from} -> {to}");
            } else {
                _ = write!(w, "{from} -> ");
                write_fg(w, COLOR_ERROR, "nothing");
            }
            write_dim(w, &format!("  {kind}"));
            if let Some(status) = event["status"].as_u64() {
                write_dim(w, &format!(" {status}"));
            }
            write_dim(w, &format!("  {reason}"));
            _ = writeln!(w);
        },
    );
}

fn print_error_log_section<W: Write>(
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
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh errors"]
    fn render_preview_errors() {
        set_color_enabled(true);
        let data = serde_json::json!({
            "errors": {
                "count": 2,
                "recent": [
                    {
                        "timestamp": "2026-08-15T04:26:05+00:00",
                        "error_type": "llm",
                        "message": "connection reset by peer",
                        "context": "character=qifei"
                    },
                    {
                        "timestamp": "2026-08-15T04:31:44+00:00",
                        "error_type": "tool",
                        "message": "beets database is unreachable",
                        "context": "tool=ask_librarian"
                    }
                ]
            },
            "key_fallbacks": {
                "count": 2,
                "recent": [
                    {
                        "timestamp": "2026-08-15T04:28:16+00:00",
                        "provider": "opencode-go",
                        "model": "glm-5.3",
                        "character": "qifei",
                        "from_key": "primary",
                        "to_key": "backup",
                        "kind": "quota",
                        "status": 429,
                        "reason": "rate limited"
                    },
                    {
                        "timestamp": "2026-08-15T04:44:02+00:00",
                        "provider": "anthropic",
                        "model": "claude-opus-5",
                        "character": "qifei",
                        "from_key": "only",
                        "kind": "missing",
                        "reason": "no key configured"
                    }
                ]
            }
        });
        let mut buf = Vec::new();
        write_error_log(&mut buf, &data);
        set_color_enabled(false);
        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"\n----- ERROR LOG (shore trace errors) -----\n");
        _ = stdout.write_all(&buf);
        _ = stdout.write_all(b"----- end -----\n");
        _ = stdout.flush();
    }

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

    fn rendered_run_tool(body: &str) -> String {
        set_color_enabled(false);
        let data = serde_json::json!({
            "tool": "search",
            "kind": "builtin",
            "enabled": true,
            "ok": true,
            "rejected": false,
            "duration_ms": 2,
            "result_chars": body.len(),
            "output": body,
            "raw": null,
        });
        let mut buf = Vec::new();
        write_run_tool(&mut buf, &data, 100);
        String::from_utf8(buf).expect("utf8")
    }

    #[test]
    fn a_tool_result_reaches_the_terminal_through_the_shared_formatter() {
        let json_body = r##"{"query":"test","results":[{"path":"memory/notes/rhia.md","line":1,"excerpt":"# rhia","lexical_score":146}],"count":1}"##;
        let rendered = rendered_run_tool(json_body);

        assert!(
            !rendered.contains(json_body),
            "`debug tool` must not dump the result verbatim: {rendered}"
        );
        assert!(rendered.contains("query: test"), "{rendered}");
        assert!(
            rendered.contains("path: memory/notes/rhia.md"),
            "{rendered}"
        );
        assert_eq!(
            rendered.matches("lexical_score: 146").count(),
            1,
            "every field survives the reformat: {rendered}"
        );
    }

    #[test]
    fn a_tool_result_that_is_not_json_reaches_the_terminal_unchanged() {
        let rendered = rendered_run_tool("the tide came in\nand went out again");
        assert!(rendered.contains("the tide came in"), "{rendered}");
        assert!(rendered.contains("and went out again"), "{rendered}");
    }

    #[test]
    fn a_tool_result_is_laid_out_the_way_the_transcript_lays_it_out() {
        let json_body = r##"{"query":"test","results":[{"path":"memory/notes/rhia.md","line":1,"excerpt":"# rhia","lexical_score":146}],"count":1}"##;
        let formatted = format_tool_output(json_body);

        assert!(
            formatted.lines().count() > 1,
            "a JSON result must not print as one line: {formatted}"
        );
        assert!(formatted.contains("query: test"), "{formatted}");
        assert!(
            formatted.contains("path: memory/notes/rhia.md"),
            "{formatted}"
        );
        assert!(
            !formatted.contains(r#""excerpt":"#),
            "the quoting and braces are what makes it unreadable: {formatted}"
        );
    }

    #[test]
    fn a_tool_result_that_is_not_json_is_left_exactly_as_it_came() {
        let plain = "the tide came in\nand went out again";
        assert_eq!(format_tool_output(plain), plain);
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
    #[ignore = "visual preview"]
    fn render_preview_wire() {
        let wire = serde_json::json!([{
            "seq": 0,
            "method": "POST",
            "url": "https://api.z.ai/api/paas/v4/chat/completions",
            "status": 200,
            "status_text": "OK",
            "duration_ms": 8412,
            "request_bytes": 48213,
            "response_bytes": 91044,
            "request_body": {
                "model": "glm-5.3",
                "stream": true,
                "messages": [{"role": "user", "content": "how long can this go on"}]
            },
            "response_body": {
                "stream": "sse",
                "model": "glm-5.3",
                "content": " allowed to say the word \"done\" at least once before you find the next wall to chew.",
                "finish_reason": "stop",
                "usage": {
                    "prompt_tokens": 14241,
                    "completion_tokens": 1288,
                    "total_tokens": 15529,
                    "prompt_tokens_details": {"cached_tokens": 12480},
                    "completion_tokens_details": {"reasoning_tokens": 797}
                },
                "chunk_count": 812
            }
        }]);

        let mut bare = wire.clone();
        for exchange in bare.as_array_mut().expect("array") {
            let fields = exchange.as_object_mut().expect("object");
            _ = fields.remove("request_headers");
            _ = fields.remove("request_body");
            _ = fields.remove("response_headers");
            _ = fields.remove("response_body");
        }

        let call = serde_json::json!({
            "id": 9012,
            "call_id": "20260815T042808877-0004",
            "ts": "2026-08-15T04:28:08.877+00:00",
            "call_type": "message",
            "character": "qifei",
            "model": "glm-5.3",
            "provider": "opencode-go",
            "finish_reason": "end_turn",
            "usage": {
                "input_tokens": 1388,
                "output_tokens": 196,
                "cache_read_tokens": 9344,
                "cache_write_tokens": 0
            },
            "duration_ms": 7799,
            "error": null,
            "request_bytes": 45843,
            "response_bytes": 6842,
            "request": {
                "sdk": "openai",
                "model": "glm-5.3",
                "api_key": "[redacted]",
                "messages": [{"role": "user", "content": "how long can this go on"}],
                "replay_prior_thinking": "all"
            },
            "response": {
                "stream": "events",
                "model": "glm-5.3",
                "content": "Not much longer.",
                "finish_reason": "end_turn",
                "chunk_count": 214
            },
        });

        set_color_enabled(true);
        let mut stdout = io::stdout();
        _ = stdout.write_all(b"\n----- shore trace calls 9012 -----\n");
        print_call_log(&serde_json::json!({
            "enabled": true, "call": call, "wire": bare,
        }));
        _ = stdout.write_all(b"----- shore trace calls 9012 --wire -----\n");
        print_call_log(&serde_json::json!({
            "enabled": true, "call": call, "wire": wire,
        }));
        set_color_enabled(false);
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
    fn wire_bodies_keep_their_line_breaks() {
        let wire = serde_json::json!([{
            "seq": 0,
            "method": "POST",
            "url": "https://example.test/v1",
            "status": 200,
            "request_body": {"model": "glm-5.3"},
            "response_body": {"content": "hi", "finish_reason": "stop"},
        }]);
        let mut buf = Vec::new();
        print_wire_exchanges(&mut buf, Some(&wire), 80);
        let rendered = String::from_utf8(buf).expect("utf8");

        assert!(rendered.contains("{\n  \"model\": \"glm-5.3\"\n}"));
        assert!(rendered.contains("\"finish_reason\": \"stop\""));
        assert!(!rendered.contains("{   \"model\""));
    }

    #[test]
    fn an_exchange_without_bodies_keeps_its_status_line_and_points_at_the_flag() {
        set_color_enabled(false);
        let wire = serde_json::json!([{
            "seq": 0,
            "method": "POST",
            "url": "https://example.test/v1",
            "status": 200,
            "status_text": "OK",
            "duration_ms": 8412,
            "request_bytes": 45768,
            "response_bytes": 37208,
        }]);
        let mut buf = Vec::new();
        print_wire_exchanges(&mut buf, Some(&wire), 80);
        let rendered = String::from_utf8(buf).expect("utf8");

        assert!(
            rendered.contains("POST https://example.test/v1"),
            "{rendered}"
        );
        assert!(rendered.contains("45768B up / 37208B down"), "{rendered}");
        assert!(!rendered.contains("wire request"), "{rendered}");
        assert!(rendered.contains("--wire"), "{rendered}");
    }

    #[test]
    fn a_body_that_arrived_prints_in_full_and_stops_advertising_the_flag() {
        set_color_enabled(false);
        let long = "x".repeat(CALL_BODY_PREVIEW * 2);
        let wire = serde_json::json!([{
            "seq": 0,
            "method": "POST",
            "url": "https://example.test/v1",
            "status": 200,
            "request_body": {"prompt": long},
            "response_body": null,
        }]);
        let mut buf = Vec::new();
        print_wire_exchanges(&mut buf, Some(&wire), 80);
        let rendered = String::from_utf8(buf).expect("utf8");

        assert!(rendered.contains(&long), "the body must not be truncated");
        assert!(!rendered.contains("chars)"), "{rendered}");
        assert!(!rendered.contains("--wire"), "{rendered}");
    }

    #[test]
    fn non_json_payload_text_is_preserved() {
        let body = serde_json::Value::String("event: message_start\n".into());
        assert_eq!(display_payload_body(&body), "event: message_start\n");
    }

    #[test]
    fn format_command_dispatches_known_commands() {
        set_color_enabled(false);
        format_command("config_reload", &serde_json::json!({"applied": true}));
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
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh roles"]
    fn render_preview_model_roles() {
        let cases: [(&str, fn()); 7] = [
            ("shore model use --background=heartbeat kimi-k3", || {
                print_model_switched(&serde_json::json!({
                    "active": "openrouter:moonshotai/kimi-k3",
                    "role": "heartbeat",
                    "config_key": "defaults.background.heartbeat",
                    "cleared": [],
                }));
            }),
            ("shore model use --background claude-opus-5", || {
                print_model_switched(&serde_json::json!({
                    "active": "anthropic:claude-opus-5",
                    "role": "background",
                    "config_key": "defaults.background.model",
                    "cleared": ["defaults.background.heartbeat"],
                }));
            }),
            ("shore model reset --background=heartbeat", || {
                print_model_reset(&serde_json::json!({
                    "active": "anthropic:claude-opus-4-6",
                    "role": "heartbeat",
                    "cleared": ["defaults.background.heartbeat"],
                    "source": "inherits chat",
                }));
            }),
            (
                "shore model setting --background=heartbeat temperature 0",
                || {
                    print_set_model_setting(&serde_json::json!({
                        "key": "temperature",
                        "scope": "character",
                        "value": "0",
                        "model": "anthropic:claude-opus-4-6",
                        "background_task": "heartbeat",
                        "also_affects": ["chat", "sub-agents"],
                    }));
                },
            ),
            ("shore model use --subagent=music kimi-k3", || {
                print_model_switched(&serde_json::json!({
                    "active": "openrouter:moonshotai/kimi-k3",
                    "role": "sub-agent: music",
                    "config_key": "subagents.music.model",
                    "cleared": [],
                }));
            }),
            ("shore model use --subagent claude-haiku-4-5", || {
                print_model_switched(&serde_json::json!({
                    "active": "anthropic:claude-haiku-4-5",
                    "role": "sub-agents",
                    "config_key": "defaults.subagent_model",
                    "cleared": ["subagents.music.model"],
                }));
            }),
            ("shore model use claude-opus-5", || {
                print_model_switched(&serde_json::json!({"active": "anthropic:claude-opus-5"}));
            }),
        ];

        for (label, render) in cases {
            cli_out!("----- {label} -----");
            set_color_enabled(true);
            render();
            set_color_enabled(false);
            cli_out!("----- end -----");
        }
    }

    #[test]
    fn a_pinned_role_reads_differently_from_a_chat_switch() {
        set_color_enabled(false);
        print_model_switched(&serde_json::json!({"active": "anthropic:claude-opus-5"}));
        print_model_switched(&serde_json::json!({
            "active": "anthropic:claude-opus-5",
            "role": "heartbeat",
        }));
    }

    #[test]
    fn joining_names_reads_as_a_sentence() {
        assert_eq!(join_names(&[]), "");
        assert_eq!(join_names(&["chat".to_owned()]), "chat");
        assert_eq!(
            join_names(&["chat".to_owned(), "sub-agents".to_owned()]),
            "chat and sub-agents"
        );
        assert_eq!(
            join_names(&[
                "chat".to_owned(),
                "compaction".to_owned(),
                "sub-agents".to_owned()
            ]),
            "chat, compaction and sub-agents"
        );
    }

    #[test]
    fn the_blanket_role_is_named_in_words() {
        assert_eq!(role_label("background"), "background tasks");
        assert_eq!(role_label("heartbeat"), "heartbeat");
    }

    #[test]
    fn format_command_fallback_for_unknown() {
        set_color_enabled(false);
        format_command("totally_unknown", &serde_json::json!({"key": "val"}));
    }

    #[test]
    fn print_delete_confirmation_single_and_multiple() {
        set_color_enabled(false);
        print_delete_confirmation(&serde_json::json!({"deleted": ["msg_1"]}));
        print_delete_confirmation(&serde_json::json!({"deleted": ["msg_1", "msg_2", "msg_3"]}));
        print_delete_confirmation(&serde_json::json!({"deleted": "msg_42"}));
    }

    #[test]
    fn print_model_switched_shows_abbreviated_name() {
        set_color_enabled(false);
        print_model_switched(&serde_json::json!({"active": "claude-sonnet-4-20250514"}));
    }

    #[test]
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh compact"]
    fn render_preview_compaction_result() {
        let cases = [
            (
                "COMPACTED (shore compact)",
                serde_json::json!({
                    "status": "compacted",
                    "character": "qifei",
                    "memory_files_written": ["MEMORY.md", "USER.md", "memory/keepsakes.md"],
                    "compacted_turns": 13,
                    "retained_count": 8,
                    "retained_turns": 4,
                    "tool_rounds": 3,
                }),
            ),
            (
                "ARCHIVE-ONLY ROTATION (write_memory = false)",
                serde_json::json!({
                    "status": "rotated",
                    "character": "qifei",
                    "dry_run": false,
                    "memory_files_written": [],
                    "archived_messages": 22,
                    "compacted_turns": 11,
                    "retained_count": 4,
                    "retained_turns": 2,
                }),
            ),
            (
                "PAUSED ON A WEDGED CHECKPOINT (shore compact 0)",
                serde_json::json!({
                    "status": "paused",
                    "character": "qifei",
                    "checkpoint_id": "29e55e7b-155b-49cc-ac03-ab3a3a130f07",
                    "compacted_turns": 13,
                    "tool_rounds": 2,
                    "reason": "workspace_conflict",
                    "detail": "memory/core/the_wipe.md",
                    "resume_at": null,
                }),
            ),
            (
                "PAUSED BY THE PROVIDER (shore compact)",
                serde_json::json!({
                    "status": "paused",
                    "character": "qifei",
                    "checkpoint_id": "29e55e7b-155b-49cc-ac03-ab3a3a130f07",
                    "compacted_turns": 13,
                    "tool_rounds": 2,
                    "reason": "429 Monthly usage limit reached. Resets in 10 days.",
                    "detail": null,
                    "resume_at": "2026-08-26T00:00:00Z",
                }),
            ),
            (
                "CUT OFF (shore compact)",
                serde_json::json!({
                    "status": "truncated",
                    "character": "qifei",
                    "compacted_turns": 13,
                    "tool_rounds": 2,
                    "truncated_turns": 1,
                    "partial_writes": ["MEMORY.md"],
                }),
            ),
            (
                "DRY RUN",
                serde_json::json!({
                    "status": "dry_run",
                    "character": "qifei",
                    "would_write_files": 3,
                    "compacted_turns": 13,
                    "retained_count": 8,
                    "retained_turns": 4,
                    "tool_rounds": 2,
                }),
            ),
        ];

        let mut stdout = io::stdout();
        for (label, data) in cases {
            set_color_enabled(true);
            let mut buf = Vec::new();
            write_compact_result(&mut buf, &data, 78);
            set_color_enabled(false);
            let _ignored = stdout.write_all(format!("\n----- {label} -----\n").as_bytes());
            _ = stdout.write_all(&buf);
            _ = stdout.write_all(b"----- end -----\n");
        }
        _ = stdout.flush();
    }

    fn rendered_compaction(data: &serde_json::Value) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_compact_result(&mut buf, data, 80);
        String::from_utf8(buf).expect("utf8")
    }

    #[test]
    fn an_archive_only_rotation_says_no_memory_files_were_written() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "rotated",
            "character": "qifei",
            "dry_run": false,
            "memory_files_written": [],
            "archived_messages": 22,
            "compacted_turns": 11,
            "retained_count": 4,
            "retained_turns": 2,
        }));
        assert!(rendered.contains("archive-only"), "{rendered}");
        assert!(rendered.contains("write_memory = false"), "{rendered}");
        assert!(rendered.contains("archived 22 into history"), "{rendered}");
        assert!(rendered.contains("11 archived, 2 retained"), "{rendered}");
    }

    #[test]
    fn a_rotation_dry_run_says_it_would_archive() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "rotated",
            "character": "qifei",
            "dry_run": true,
            "archived_messages": 22,
            "compacted_turns": 11,
            "retained_turns": 2,
        }));
        assert!(
            rendered.contains("would archive 22 into history"),
            "{rendered}"
        );
    }

    #[test]
    fn a_completed_compaction_reports_what_it_wrote_and_kept() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "compacted",
            "character": "qifei",
            "memory_files_written": ["MEMORY.md", "memory/keepsakes.md"],
            "compacted_turns": 13,
            "retained_count": 8,
            "retained_turns": 4,
            "tool_rounds": 3,
        }));

        assert!(rendered.contains("2 written"), "{rendered}");
        assert!(rendered.contains("13 compacted, 4 retained"), "{rendered}");
        assert!(
            !rendered.contains("still in the conversation"),
            "a real compaction must not claim its turns were kept: {rendered}"
        );
    }

    #[test]
    fn a_paused_compaction_says_nothing_was_archived_and_how_to_recover() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "paused",
            "character": "qifei",
            "checkpoint_id": "29e55e7b-155b-49cc-ac03-ab3a3a130f07",
            "message_count": 34,
            "compacted_turns": 13,
            "tool_rounds": 2,
            "tools_called": ["read", "edit"],
            "reason": "workspace_conflict",
            "detail": "memory/core/the_wipe.md",
            "resume_at": null,
        }));

        assert!(rendered.contains("paused"), "{rendered}");
        assert!(rendered.contains("nothing archived"), "{rendered}");
        assert!(
            rendered.contains("memory/core/the_wipe.md changed since the pass wrote it"),
            "{rendered}"
        );
        assert!(
            rendered.contains("13 planned, all still in the conversation"),
            "a paused pass reports its plan as a plan: {rendered}"
        );
        assert!(
            rendered.contains("shore compact — continues from the 2 rounds already paid for"),
            "the cheap recovery must come first: {rendered}"
        );
        assert!(
            rendered.contains("shore compact --restart — discards 2 rounds and pays again"),
            "the destructive option must say what it costs: {rendered}"
        );
        let resume_at = rendered.find("Resume").expect("a Resume row");
        let restart_at = rendered.find("Start over").expect("a Start over row");
        assert!(resume_at < restart_at, "resume is listed first: {rendered}");
        assert!(
            !rendered.contains("compacted, "),
            "a paused pass must never read as a completed one: {rendered}"
        );
        assert!(
            !rendered.contains("Memory files"),
            "a paused pass has no written-file count to report: {rendered}"
        );
    }

    #[test]
    fn a_truncated_pass_names_the_token_ceiling() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "truncated",
            "character": "qifei",
            "message_count": 34,
            "compacted_turns": 13,
            "tool_rounds": 2,
            "tools_called": ["edit"],
            "truncated_turns": 1,
            "partial_writes": ["MEMORY.md"],
        }));

        assert!(rendered.contains("token ceiling"), "{rendered}");
        assert!(rendered.contains("1 model turn"), "{rendered}");
        assert!(rendered.contains("MEMORY.md"), "{rendered}");
        assert!(
            rendered.contains("13 planned, all still in the conversation"),
            "{rendered}"
        );
    }

    #[test]
    fn a_provider_failure_keeps_the_provider_message() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "paused",
            "character": "qifei",
            "checkpoint_id": "29e55e7b",
            "compacted_turns": 13,
            "tool_rounds": 2,
            "reason": "429 Monthly usage limit reached. Resets in 10 days.",
            "detail": null,
            "resume_at": "2026-08-26T00:00:00Z",
        }));

        assert!(
            rendered.contains("Monthly usage limit reached"),
            "{rendered}"
        );
        assert!(rendered.contains("2026-08-26T00:00:00Z"), "{rendered}");
    }

    #[test]
    fn a_dry_run_still_reads_as_a_preview() {
        let rendered = rendered_compaction(&serde_json::json!({
            "status": "dry_run",
            "character": "qifei",
            "would_write_files": 3,
            "compacted_turns": 13,
            "retained_count": 8,
            "retained_turns": 4,
            "tool_rounds": 2,
        }));

        assert!(rendered.contains("dry run"), "{rendered}");
        assert!(rendered.contains("3 files"), "{rendered}");
        assert!(rendered.contains("13 compacted, 4 retained"), "{rendered}");
    }
}
