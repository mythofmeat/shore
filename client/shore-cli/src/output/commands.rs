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
        "compact_watch" | "compact_cancel" => print_compaction_watch(data),
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
    for line in model_reset_lines(data) {
        cli_out!("{line}");
    }
}

fn model_reset_lines(data: &serde_json::Value) -> Vec<String> {
    let model = data["active"].as_str().unwrap_or("(none)");
    let Some(role) = data["role"].as_str() else {
        return vec![format!("Model reset to: {}", abbreviate_model(model))];
    };
    let roles = data["roles"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let diverged = roles
        .iter()
        .any(|each| each["model"] != data["active"] || each["source"] != data["source"]);
    if !diverged {
        let source = data["source"].as_str().unwrap_or("config default");
        return vec![format!(
            "Unpinned {}; now {} ({source})",
            role_label(role),
            abbreviate_model(model)
        )];
    }
    let mut lines = vec![format!(
        "Unpinned {}; each now uses its own default:",
        role_label(role)
    )];
    lines.extend(roles.iter().map(|each| {
        format!(
            "  {}: {} ({})",
            each["role"].as_str().unwrap_or("?"),
            abbreviate_model(each["model"].as_str().unwrap_or("(none)")),
            each["source"].as_str().unwrap_or("config default")
        )
    }));
    lines
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

fn print_compaction_watch(data: &serde_json::Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    super::compaction::write_watch_result(&mut out, data, term_width());
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

pub(crate) fn pause_reason_text(data: &serde_json::Value) -> String {
    let reason = data["reason"].as_str().unwrap_or("unknown");
    let detail = data["detail"].as_str().filter(|d| !d.is_empty());
    if reason == "workspace_conflict" {
        return match detail {
            Some(path) => format!("{path} changed since the pass wrote it"),
            None => "memory files changed since the pass wrote them".to_owned(),
        };
    }
    if reason == "cancelled" {
        return detail.unwrap_or("cancelled").to_owned();
    }
    if reason == "refusal" {
        return detail.unwrap_or("the model refused to go on").to_owned();
    }
    let named = match reason {
        "source_conflict" => "the conversation changed since the pass started",
        "iteration_limit" => "hit its tool-round ceiling",
        "budget" => "blocked by a usage limit",
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
        "segment" => "segment",
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
        "segment" => {
            let index = data["segment"].as_u64().unwrap_or(0);
            let files = data["memory_files_written"].as_array().map_or(0, Vec::len);
            write_row(
                out,
                "Segment",
                &format!("{index}, {} turns read again", planned_turns(data)),
            );
            write_row(out, "Memory files", &format!("{files} written"));
            write_row(out, "History", "unchanged: nothing archived or retained");
        }
        "paused" => {
            write_row_colored(out, "Outcome", "nothing archived", Tone::Warn);
            write_row(out, "Reason", &pause_reason_text(data));
            if data["reason"].as_str() == Some("refusal") {
                write_row_colored(
                    out,
                    "Hold",
                    "automatic compaction waits until you retry",
                    Tone::Warn,
                );
            }
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
