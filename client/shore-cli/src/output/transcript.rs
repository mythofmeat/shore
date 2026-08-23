use std::io::{self, Write};

use chrono::{DateTime, Local};
use shore_common::protocol::server_msg::NewMessage;

use super::styling::{
    format_tool_input, format_tool_output, print_image_refs, write_tool_body_plain,
};
use super::vocab::{COLOR_ERROR, Tone, indent_to, paint};
use super::{
    COLOR_RESULT, COLOR_THINKING, COLOR_TOOL, SIGIL_ERROR, SIGIL_OK, SIGIL_THINKING, SIGIL_TOOL,
    parse_timestamp, primary_tool_arg, print_dim_line, process_wrap_width, term_width,
    write_channel_rule, write_process_body, write_section_header, write_sigil_header,
    write_thinking_content_line,
};

#[derive(Clone, Copy, Default)]
pub(crate) struct LogFilter {
    pub reasoning: bool,
    pub tools: bool,
    pub subagent_tools: bool,
}

impl LogFilter {
    #[cfg(test)]
    pub(crate) fn all() -> Self {
        Self {
            reasoning: true,
            tools: true,
            subagent_tools: true,
        }
    }

    fn block_renders(self, block: &serde_json::Value) -> bool {
        match block["type"].as_str().unwrap_or("text") {
            "text" => !block["text"].as_str().unwrap_or("").is_empty(),
            "thinking" => self.reasoning && !block["thinking"].as_str().unwrap_or("").is_empty(),
            "tool_use" | "tool_result" => self.tools,
            _ => false,
        }
    }
}

fn message_renders(
    content_blocks: Option<&Vec<serde_json::Value>>,
    content: &str,
    is_tool_result_msg: bool,
    images: Option<&Vec<serde_json::Value>>,
    filter: LogFilter,
) -> bool {
    if images.is_some_and(|imgs| !imgs.is_empty()) {
        return true;
    }
    match content_blocks {
        Some(blocks) if !blocks.is_empty() => blocks.iter().any(|b| filter.block_renders(b)),
        Some(_) => !content.is_empty(),
        None => !content.is_empty() || !is_tool_result_msg,
    }
}

pub(crate) fn character_color(name: &str) -> Tone {
    super::vocab::speaker_tone(name)
}

pub(crate) fn format_time(dt: &DateTime<Local>, prev_date: Option<&str>) -> String {
    let date = dt.format("%Y-%m-%d").to_string();
    let time = dt.format("%H:%M").to_string();
    match prev_date {
        Some(prev) if prev == date => time,
        None => time,
        Some(_) => dt.format("%b %d \u{00b7} %H:%M").to_string(),
    }
}

pub(crate) fn write_header(
    out: &mut impl Write,
    name: &str,
    time_str: &str,
    color: Tone,
    width: usize,
) {
    let prefix = format!("\u{2500}\u{2500} {name} \u{00b7} {time_str} ");
    let prefix_len = prefix.chars().count();
    let trail = width.saturating_sub(prefix_len);
    let rule: String = "\u{2500}".repeat(trail);

    paint(out, color, &format!("{prefix}{rule}"));
    _ = writeln!(out);
}

fn write_archive_boundary(out: &mut impl Write, width: usize, archived_turns: usize) {
    let label = if archived_turns == 1 {
        " 1 archived turn above · outside current context ".to_owned()
    } else {
        format!(" {archived_turns} archived turns above · outside current context ")
    };
    let label_width = label.chars().count();
    let line = if width > label_width {
        let extra_width = width.saturating_sub(label_width);
        let left: usize = extra_width.checked_div(2).unwrap_or_default();
        let right = width.saturating_sub(label_width.saturating_add(left));
        format!("{}{}{}", "─".repeat(left), label, "─".repeat(right))
    } else {
        label.trim().to_owned()
    };

    paint(out, Tone::Muted, &line);
    _ = writeln!(out);
    _ = writeln!(out);
}

fn is_tool_result_only_value(msg: &serde_json::Value) -> bool {
    msg["role"].as_str() == Some("user")
        && msg["content_blocks"].as_array().is_some_and(|blocks| {
            !blocks.is_empty()
                && blocks
                    .iter()
                    .all(|block| block["type"].as_str() == Some("tool_result"))
        })
}

fn count_user_turn_values(messages: &[serde_json::Value]) -> usize {
    messages
        .iter()
        .filter(|msg| msg["role"].as_str() == Some("user") && !is_tool_result_only_value(msg))
        .count()
}

fn write_thinking(out: &mut impl Write, thinking: &str) {
    write_sigil_header(out, SIGIL_THINKING, "Thinking", COLOR_THINKING);
    let width = process_wrap_width();
    for line in thinking.lines() {
        write_thinking_content_line(out, line, width);
    }
}

fn render_message_content(
    out: &mut impl Write,
    content_blocks: Option<&Vec<serde_json::Value>>,
    content: &str,
    is_tool_result_msg: bool,
    filter: LogFilter,
) {
    if let Some(blocks) = content_blocks {
        if blocks.is_empty() {
            if !content.is_empty() {
                let _ignored = writeln!(out, "{content}");
            }
        } else {
            let mut prev_process: Option<bool> = None;
            for block in blocks {
                let block_type = block["type"].as_str().unwrap_or("text");
                let is_process = block_type != "text";
                if !filter.block_renders(block) {
                    continue;
                }
                if let Some(prev) = prev_process {
                    if prev && is_process {
                        write_channel_rule(out);
                    } else if prev || is_process {
                        let _ignored = writeln!(out);
                    } else {
                    }
                }
                prev_process = Some(is_process);
                match block_type {
                    "text" => {
                        let text = block["text"].as_str().unwrap_or("");
                        if !text.is_empty() {
                            let _ignored = writeln!(out, "{text}");
                        }
                    }
                    "thinking" => {
                        let thinking = block["thinking"].as_str().unwrap_or("");
                        if !thinking.is_empty() {
                            write_thinking(out, thinking);
                        }
                    }
                    "tool_use" => {
                        let name = block["name"].as_str().unwrap_or("?");
                        let header = match primary_tool_arg(&block["input"]) {
                            Some(arg) => format!("{name} \u{00b7} {arg}"),
                            None => name.to_owned(),
                        };
                        write_sigil_header(out, SIGIL_TOOL, &header, COLOR_TOOL);
                        if let Some(input_str) = format_tool_input(&block["input"]) {
                            write_process_body(out, &input_str);
                        }
                    }
                    "tool_result" => {
                        let output = block["content"].as_str().unwrap_or("");
                        let is_error = block["is_error"].as_bool().unwrap_or(false);
                        let (sigil, label, color) = if is_error {
                            (SIGIL_ERROR, "error", COLOR_ERROR)
                        } else {
                            (SIGIL_OK, "result", COLOR_RESULT)
                        };
                        write_sigil_header(out, sigil, label, color);
                        let formatted = format_tool_output(output);
                        write_process_body(out, &formatted);
                    }
                    _ => {}
                }
            }
        }
    } else if !content.is_empty() || !is_tool_result_msg {
        let _ignored = writeln!(out, "{content}");
    } else {
    }
}

pub(crate) fn print_log(messages: &[serde_json::Value], character_name: &str, filter: LogFilter) {
    print_log_with_boundary(messages, 0, character_name, filter);
}

pub(crate) fn print_log_with_boundary(
    messages: &[serde_json::Value],
    active_start: usize,
    character_name: &str,
    filter: LogFilter,
) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    write_log_with_boundary(
        &mut out,
        messages,
        active_start,
        character_name,
        width,
        filter,
    );
}

fn write_log_with_boundary(
    out: &mut impl Write,
    messages: &[serde_json::Value],
    active_start_in: usize,
    character_name: &str,
    width: usize,
    filter: LogFilter,
) {
    let char_color = character_color(character_name);

    let mut prev_date: Option<String> = None;

    let active_start = active_start_in.min(messages.len());
    let archived = messages.get(..active_start).unwrap_or(messages);
    let archived_turns = count_user_turn_values(archived);
    for (index, msg) in messages.iter().enumerate() {
        if active_start > 0 && index == active_start {
            write_archive_boundary(out, width, archived_turns);
        }

        let role_str = msg["role"].as_str().unwrap_or("user");
        let content = msg["content"].as_str().unwrap_or("");
        let ts = msg["timestamp"].as_str().unwrap_or("");
        let images = msg["images"].as_array();
        let content_blocks = msg["content_blocks"].as_array();

        let is_tool_result_msg = role_str == "user"
            && content_blocks.is_some_and(|blocks| {
                !blocks.is_empty()
                    && blocks
                        .iter()
                        .all(|b| b["type"].as_str() == Some("tool_result"))
            });

        if !message_renders(content_blocks, content, is_tool_result_msg, images, filter) {
            continue;
        }

        let parsed_ts = parse_timestamp(ts);
        let time_str = parsed_ts
            .as_ref()
            .map(|dt| format_time(dt, prev_date.as_deref()))
            .unwrap_or_default();

        if let Some(dt) = &parsed_ts {
            prev_date = Some(dt.format("%Y-%m-%d").to_string());
        }

        if !is_tool_result_msg {
            match role_str {
                "user" => write_header(out, "You", &time_str, Tone::Active, width),
                "assistant" => write_header(out, character_name, &time_str, char_color, width),
                "system" => {
                    let prefix = format!("\u{2500}\u{2500} system \u{00b7} {time_str} ");
                    let prefix_len = prefix.chars().count();
                    let trail = width.saturating_sub(prefix_len);
                    paint(
                        out,
                        Tone::Muted,
                        &format!("{prefix}{}", "\u{2500}".repeat(trail)),
                    );
                    _ = writeln!(out);
                }
                _ => {}
            }
        }

        render_message_content(out, content_blocks, content, is_tool_result_msg, filter);

        if let Some(imgs) = images {
            for img in imgs {
                let label = img["caption"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| img["path"].as_str().and_then(|p| p.rsplit('/').next()))
                    .unwrap_or("image");

                indent_to(out, 0);
                paint(out, Tone::Warn, &format!("\u{1f4ce} {label}"));
                _ = writeln!(out);
            }
        }

        let _ignored = writeln!(out);
    }

    if active_start > 0 && active_start == messages.len() {
        write_archive_boundary(out, width, archived_turns);
    }
}

pub(crate) fn print_message_content(data: &serde_json::Value) {
    let content = data["content"].as_str().unwrap_or("");
    let content_blocks = data["content_blocks"].as_array();

    if let Some(blocks) = content_blocks
        && !blocks.is_empty()
    {
        for block in blocks {
            if block["type"].as_str() == Some("text") {
                let text = block["text"].as_str().unwrap_or("");
                if !text.is_empty() {
                    cli_out!("{text}");
                }
            }
        }
        return;
    }
    if !content.is_empty() {
        cli_out!("{content}");
    }
}

pub(crate) fn print_log_plain(
    messages: &[serde_json::Value],
    character_name: &str,
    filter: LogFilter,
) {
    print_log_plain_with_boundary(messages, 0, character_name, filter);
}

pub(crate) fn print_log_plain_with_boundary(
    messages: &[serde_json::Value],
    active_start: usize,
    character_name: &str,
    filter: LogFilter,
) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_log_plain_with_boundary(&mut out, messages, active_start, character_name, filter);
}

fn write_plain_message_content(
    out: &mut impl Write,
    content_blocks: Option<&Vec<serde_json::Value>>,
    content: &str,
    filter: LogFilter,
) {
    if let Some(blocks) = content_blocks {
        if !blocks.is_empty() {
            for block in blocks {
                match block["type"].as_str().unwrap_or("text") {
                    "text" => {
                        let text = block["text"].as_str().unwrap_or("");
                        if !text.is_empty() {
                            _ = writeln!(out, "{text}");
                        }
                    }
                    "thinking" if filter.reasoning => {
                        let t = block["thinking"].as_str().unwrap_or("");
                        if !t.is_empty() {
                            _ = writeln!(out, "[thinking] {t}");
                        }
                    }
                    "tool_use" if filter.tools => {
                        let tool_name = block["name"].as_str().unwrap_or("?");
                        _ = writeln!(out, "[tool: {tool_name}]");
                        if let Some(input_str) = format_tool_input(&block["input"]) {
                            write_tool_body_plain(out, &input_str);
                        }
                    }
                    "tool_result" if filter.tools => {
                        let output = block["content"].as_str().unwrap_or("");
                        let is_error = block["is_error"].as_bool().unwrap_or(false);
                        let label = if is_error { "error" } else { "result" };
                        _ = writeln!(out, "[{label}]");
                        let formatted = format_tool_output(output);
                        write_tool_body_plain(out, &formatted);
                    }
                    _ => {}
                }
            }
        } else if !content.is_empty() {
            _ = writeln!(out, "{content}");
        } else {
        }
    } else if !content.is_empty() {
        _ = writeln!(out, "{content}");
    } else {
    }
}

fn write_log_plain_with_boundary(
    out: &mut impl Write,
    messages: &[serde_json::Value],
    active_start_in: usize,
    character_name: &str,
    filter: LogFilter,
) {
    let active_start = active_start_in.min(messages.len());
    let archived = messages.get(..active_start).unwrap_or(messages);
    let archived_turns = count_user_turn_values(archived);
    for (index, msg) in messages.iter().enumerate() {
        if active_start > 0 && index == active_start {
            let _ignored = writeln!(
                out,
                "--- {archived_turns} archived turn(s) above; outside current context ---\n"
            );
        }

        let role_str = msg["role"].as_str().unwrap_or("user");
        let content = msg["content"].as_str().unwrap_or("");
        let ts = msg["timestamp"].as_str().unwrap_or("");
        let images = msg["images"].as_array();
        let content_blocks = msg["content_blocks"].as_array();

        let is_tool_result_msg = role_str == "user"
            && content_blocks.is_some_and(|blocks| {
                !blocks.is_empty()
                    && blocks
                        .iter()
                        .all(|b| b["type"].as_str() == Some("tool_result"))
            });

        if !message_renders(content_blocks, content, is_tool_result_msg, images, filter) {
            continue;
        }

        let name = match role_str {
            "user" => "you",
            "assistant" => character_name,
            other => other,
        };

        let time_str = parse_timestamp(ts)
            .map(|dt| dt.format("%H:%M").to_string())
            .unwrap_or_default();

        let _ignored = writeln!(out, "{name} [{time_str}]:");

        write_plain_message_content(out, content_blocks, content, filter);

        _ = writeln!(out);
    }

    if active_start > 0 && active_start == messages.len() {
        let _ignored = writeln!(
            out,
            "--- {archived_turns} archived turn(s) above; outside current context ---\n"
        );
    }
}

pub(crate) fn print_new_message(msg: &NewMessage, character_name: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let time_str = parse_timestamp(&msg.message.timestamp)
        .map(|dt| dt.format("%H:%M").to_string())
        .unwrap_or_default();

    let speaker = match msg.message.role {
        shore_common::protocol::types::Role::User => Speaker {
            drawn: "You",
            flat: "you",
            tone: Tone::Active,
        },
        shore_common::protocol::types::Role::Assistant => Speaker {
            drawn: character_name,
            flat: character_name,
            tone: character_color(character_name),
        },
        shore_common::protocol::types::Role::System => Speaker {
            drawn: "system",
            flat: "system",
            tone: Tone::Muted,
        },
    };

    write_speaker_line(&mut out, &speaker, &time_str, width);
    let _ignored = writeln!(out, "{}", msg.message.content);
    _ = writeln!(out);

    print_image_refs(&msg.message.images);
}

pub(crate) fn print_follow_stream_start(character_name: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let width = term_width();
    let time_str = Local::now().format("%H:%M").to_string();
    let speaker = Speaker {
        drawn: character_name,
        flat: character_name,
        tone: character_color(character_name),
    };
    write_speaker_line(&mut out, &speaker, &time_str, width);
}

struct Speaker<'name> {
    drawn: &'name str,
    flat: &'name str,
    tone: Tone,
}

fn write_speaker_line(out: &mut impl Write, speaker: &Speaker<'_>, time_str: &str, width: usize) {
    if crate::output::use_decoration() {
        write_header(out, speaker.drawn, time_str, speaker.tone, width);
    } else {
        let _ignored = writeln!(out, "{} [{time_str}]:", speaker.flat);
    }
}

pub(crate) fn print_single_message(
    data: &serde_json::Value,
    character_name: &str,
    filter: LogFilter,
) {
    print_log(std::slice::from_ref(data), character_name, filter);
}

pub(crate) fn print_heartbeat_log(data: &serde_json::Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_heartbeat_log(&mut out, data, term_width());
}

pub(crate) fn write_heartbeat_log<W: Write>(out: &mut W, data: &serde_json::Value, width: usize) {
    let events: &[serde_json::Value] = data["events"].as_array().map_or(&[], Vec::as_slice);
    if events.is_empty() {
        write_section_header(out, "heartbeat events", "", width);
        print_dim_line(out, "(no heartbeat events)");
        return;
    }

    write_section_header(
        out,
        "heartbeat events",
        &format!("{} events", events.len()),
        width,
    );

    let mut prev_date: Option<String> = None;
    for event in events {
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
            "message_sent" | "wake" | "recap_written" => Tone::Good,
            "message_skipped" => Tone::Muted,
            "tool_use" => Tone::Active,
            "dormant" | "call_failed" => COLOR_ERROR,
            "recap_missing" | "budget_paused" => Tone::Warn,
            _ => Tone::Heading,
        };

        paint(out, Tone::Muted, &format!("  {time_str:<16}"));
        paint(out, kind_color, &format!("{kind:<18}"));
        let _ignored = writeln!(out, "{detail}");
    }
    let _ignored = writeln!(out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;

    #[test]
    #[ignore = "visual preview; run explicitly with --ignored --nocapture"]
    fn render_preview_log() {
        set_color_enabled(true);
        let blocks = vec![
            serde_json::json!({"type": "thinking", "thinking": "Let me reason about this first. The user asked about a long-standing issue, and this paragraph is deliberately long so it wraps and shows the gutter bar continuing down every wrapped row.\nA second paragraph confirms blank-line handling between thoughts."}),
            serde_json::json!({"type": "text", "text": "Here's the first part of my answer."}),
            serde_json::json!({"type": "tool_use", "name": "edit", "input": {"path": "src/main.rs", "new_string": "a deliberately long replacement line so the tool body has to word-wrap and we can see the gutter bar continue down every wrapped row of the body too"}}),
            serde_json::json!({"type": "tool_result", "content": "fn main() { ... }", "is_error": false}),
            serde_json::json!({"type": "redacted_thinking", "data": "AAAA"}),
            serde_json::json!({"type": "thinking", "thinking": "Now that I've read the file, I can refine my answer with the concrete details I just learned."}),
            serde_json::json!({"type": "text", "text": "And here's the refined conclusion."}),
        ];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        set_color_enabled(false);
        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"\n----- LOG RENDER (shore log / shore get) -----\n");
        _ = stdout.write_all(&buf);
        _ = stdout.write_all(b"----- end -----\n");
        _ = stdout.flush();
    }

    fn transcript_snapshot_messages() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({
                "msg_id": "m1",
                "role": "user",
                "content": "Please patch the config loader.",
                "content_blocks": [
                    {"type": "text", "text": "Please patch the config loader."}
                ],
                "images": [
                    {"path": "/tmp/config-error.png", "caption": "failing config"}
                ],
                "timestamp": ""
            }),
            serde_json::json!({
                "msg_id": "m2",
                "role": "assistant",
                "content": "I'll inspect the loader and patch it.",
                "content_blocks": [
                    {"type": "thinking", "thinking": "The loader probably rejects an alias. I should verify the schema before changing behavior."},
                    {"type": "text", "text": "I'll inspect the loader and patch it."},
                    {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {"path": "crates/common/src/config/app.rs"}},
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "found DefaultsConfig", "is_error": false},
                    {"type": "redacted_thinking", "data": "opaque"},
                    {"type": "text", "text": "The fix belongs in the alias migration."}
                ],
                "images": [],
                "timestamp": ""
            }),
            serde_json::json!({
                "msg_id": "m3",
                "role": "user",
                "content": "patched",
                "content_blocks": [
                    {"type": "tool_result", "tool_use_id": "toolu_2", "content": "apply_patch ok", "is_error": false}
                ],
                "images": [],
                "timestamp": ""
            }),
            serde_json::json!({
                "msg_id": "m4",
                "role": "assistant",
                "content": "Done.",
                "content_blocks": [
                    {"type": "text", "text": "Done."}
                ],
                "images": [],
                "timestamp": ""
            }),
        ]
    }

    #[test]
    fn rich_transcript_render_snapshot() {
        let _guard = crate::output::COLOR_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_log_with_boundary(
            &mut buf,
            &transcript_snapshot_messages(),
            2,
            "Sable",
            72,
            LogFilter::all(),
        );
        let output = String::from_utf8(buf).unwrap();
        insta::assert_snapshot!("rich_transcript_render", output);
    }

    #[test]
    fn plain_transcript_render_snapshot() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_log_plain_with_boundary(
            &mut buf,
            &transcript_snapshot_messages(),
            2,
            "Sable",
            LogFilter::all(),
        );
        let output = String::from_utf8(buf).unwrap();
        insta::assert_snapshot!("plain_transcript_render", output);
    }

    #[test]
    fn interleaved_thinking_header_both_directions() {
        set_color_enabled(false);
        let blocks = vec![
            serde_json::json!({"type": "thinking", "thinking": "T1"}),
            serde_json::json!({"type": "text", "text": "A1"}),
            serde_json::json!({"type": "thinking", "thinking": "T2"}),
            serde_json::json!({"type": "text", "text": "A2"}),
        ];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();

        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   T1\n\nA1\n\n \u{2502} \u{25cc} Thinking\n \u{2502}   T2\n\nA2\n"
        );
    }

    #[test]
    fn thinking_header_then_indented_content() {
        set_color_enabled(false);
        let blocks =
            vec![serde_json::json!({"type": "thinking", "thinking": "line one\nline two"})];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   line one\n \u{2502}   line two\n"
        );
    }

    #[test]
    fn no_breathing_room_before_first_thinking_block() {
        set_color_enabled(false);
        let blocks = vec![
            serde_json::json!({"type": "thinking", "thinking": "T1"}),
            serde_json::json!({"type": "text", "text": "A1"}),
        ];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   T1\n\nA1\n"
        );
    }

    #[test]
    fn adjacent_process_blocks_joined_by_bar_rule() {
        set_color_enabled(false);
        let blocks = vec![
            serde_json::json!({"type": "thinking", "thinking": "T1"}),
            serde_json::json!({"type": "text", "text": ""}),
            serde_json::json!({"type": "thinking", "thinking": "T2"}),
        ];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   T1\n \u{2502}\n \u{2502} \u{25cc} Thinking\n \u{2502}   T2\n"
        );
    }

    #[test]
    fn tool_call_and_result_render_with_sigils_and_separators() {
        set_color_enabled(false);
        let blocks = vec![
            serde_json::json!({"type": "text", "text": "let me check"}),
            serde_json::json!({"type": "tool_use", "name": "edit", "input": {"path": "a.md"}}),
            serde_json::json!({"type": "tool_result", "content": "done", "is_error": false}),
            serde_json::json!({"type": "text", "text": "fixed"}),
        ];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            "let me check\n\n \u{2502} \u{2192} edit \u{00b7} a.md\n \u{2502}   path: a.md\n \u{2502}\n \u{2502} \u{2713} result\n \u{2502}   done\n\nfixed\n"
        );
    }

    #[test]
    fn redacted_thinking_is_hidden() {
        set_color_enabled(false);
        let blocks = vec![
            serde_json::json!({"type": "text", "text": "A1"}),
            serde_json::json!({"type": "redacted_thinking", "data": "AAAA"}),
            serde_json::json!({"type": "text", "text": "A2"}),
        ];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(output, "A1\nA2\n");
    }

    fn mixed_blocks() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({"type": "thinking", "thinking": "reasoning"}),
            serde_json::json!({"type": "text", "text": "before"}),
            serde_json::json!({"type": "tool_use", "name": "read", "input": {"path": "a.rs"}}),
            serde_json::json!({"type": "tool_result", "content": "ok", "is_error": false}),
            serde_json::json!({"type": "text", "text": "after"}),
        ]
    }

    #[test]
    fn default_filter_shows_only_text() {
        set_color_enabled(false);
        let blocks = mixed_blocks();
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::default());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(output, "before\nafter\n");
    }

    #[test]
    fn reasoning_flag_shows_thinking_not_tools() {
        set_color_enabled(false);
        let blocks = mixed_blocks();
        let filter = LogFilter {
            reasoning: true,
            ..LogFilter::default()
        };
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, filter);
        let output = String::from_utf8(buf).unwrap();
        assert!(output.contains("Thinking"), "thinking shown: {output:?}");
        assert!(
            output.contains("reasoning"),
            "thought text shown: {output:?}"
        );
        assert!(!output.contains("read"), "tool call hidden: {output:?}");
        assert!(!output.contains("result"), "tool result hidden: {output:?}");
    }

    #[test]
    fn tools_flag_shows_tools_not_thinking() {
        set_color_enabled(false);
        let blocks = mixed_blocks();
        let filter = LogFilter {
            tools: true,
            ..LogFilter::default()
        };
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, filter);
        let output = String::from_utf8(buf).unwrap();
        assert!(output.contains("read"), "tool call shown: {output:?}");
        assert!(output.contains("result"), "tool result shown: {output:?}");
        assert!(!output.contains("Thinking"), "thinking hidden: {output:?}");
    }

    #[test]
    fn tool_result_only_turn_skipped_when_tools_hidden() {
        set_color_enabled(false);
        let messages = vec![
            serde_json::json!({
                "role": "assistant",
                "content_blocks": [{"type": "text", "text": "hi"}],
                "timestamp": "",
            }),
            serde_json::json!({
                "role": "user",
                "content_blocks": [{"type": "tool_result", "content": "ok", "is_error": false}],
                "timestamp": "",
            }),
        ];
        let mut buf = Vec::new();
        write_log_with_boundary(&mut buf, &messages, 0, "Sable", 72, LogFilter::default());
        let output = String::from_utf8(buf).unwrap();
        assert!(
            output.contains("Sable"),
            "assistant header shown: {output:?}"
        );
        assert!(output.contains("hi"), "speech shown: {output:?}");
        assert!(!output.contains("result"), "tool result hidden: {output:?}");
        assert_eq!(
            output.matches('\u{2502}').count(),
            0,
            "no process gutter: {output:?}"
        );
        assert!(
            output.ends_with("hi\n\n"),
            "single trailing gap: {output:?}"
        );
    }

    #[test]
    fn character_color_is_deterministic() {
        let c1 = character_color("Sable");
        let c2 = character_color("Sable");
        assert_eq!(format!("{c1:?}"), format!("{c2:?}"));
    }

    #[test]
    fn character_color_varies_by_name() {
        let c1 = character_color("Sable");
        let c2 = character_color("Atlas");
        assert_ne!(format!("{c1:?}"), format!("{c2:?}"));
    }

    #[test]
    fn format_time_same_day_shows_hhmm() {
        let dt = Local::now();
        let date = dt.format("%Y-%m-%d").to_string();
        let result = format_time(&dt, Some(&date));
        assert!(result.len() <= 5, "expected HH:MM, got: {result}");
    }

    #[test]
    fn format_time_first_message_shows_hhmm() {
        let dt = Local::now();
        let result = format_time(&dt, None);
        assert!(result.len() <= 5, "expected HH:MM, got: {result}");
    }

    #[test]
    fn format_time_different_day_shows_date() {
        let dt = Local::now();
        let result = format_time(&dt, Some("1999-01-01"));
        assert!(result.len() > 5, "expected date + time, got: {result}");
    }

    #[test]
    fn parse_timestamp_handles_rfc3339() {
        let ts = "2026-01-15T10:30:00Z";
        assert!(parse_timestamp(ts).is_some());
    }

    #[test]
    fn parse_timestamp_handles_invalid() {
        assert!(parse_timestamp("not a date").is_none());
    }

    #[test]
    fn write_header_contains_name_and_time() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_header(&mut buf, "Alice", "14:30", Tone::Active, 40);
        let output = String::from_utf8(buf).unwrap();

        assert!(
            output.contains("Alice"),
            "header should contain character name"
        );
        assert!(output.contains("14:30"), "header should contain time");
        assert!(
            output.contains("\u{00b7}"),
            "header should contain middle dot separator"
        );
        assert!(
            output.contains("\u{2500}"),
            "header should contain box-drawing chars"
        );
    }

    #[test]
    fn write_header_is_coloured_by_speaker() {
        let _guard = crate::output::COLOR_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_color_enabled(true);
        let mut buf = Vec::new();
        write_header(&mut buf, "qifei", "14:30", character_color("qifei"), 40);
        set_color_enabled(false);
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(
            out.contains('\u{1b}'),
            "a speaker header must carry its colour: {out:?}"
        );
    }

    #[test]
    fn the_flat_speaker_line_matches_what_the_batch_renderer_writes() {
        let _guard = crate::output::COLOR_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::output::set_decoration_enabled(false);

        let mut batch_bytes = Vec::new();
        write_log_plain_with_boundary(
            &mut batch_bytes,
            &[serde_json::json!({
                "role": "user",
                "content": "hi",
                "timestamp": "2026-01-01T14:30:00+00:00",
            })],
            0,
            "qifei",
            LogFilter::default(),
        );
        let batch = String::from_utf8(batch_bytes).unwrap_or_default();
        let batch_header = batch.lines().next().unwrap_or_default().to_owned();

        let time_str = batch_header.split(['[', ']']).nth(1).unwrap_or_default();

        let mut live_bytes = Vec::new();
        write_speaker_line(
            &mut live_bytes,
            &Speaker {
                drawn: "You",
                flat: "you",
                tone: Tone::Active,
            },
            time_str,
            40,
        );

        crate::output::set_decoration_enabled(true);

        let live = String::from_utf8(live_bytes).unwrap_or_default();
        assert_eq!(live.trim_end(), batch_header);
        assert!(!live.contains('\u{2500}'), "a pipe gets no rule: {live:?}");
    }

    #[test]
    fn a_terminal_still_gets_the_drawn_rule() {
        let _guard = crate::output::COLOR_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_speaker_line(
            &mut buf,
            &Speaker {
                drawn: "You",
                flat: "you",
                tone: Tone::Active,
            },
            "14:30",
            40,
        );
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(out.contains('\u{2500}'), "terminal keeps the rule: {out:?}");
        assert!(out.contains("You"));
    }

    #[test]
    fn write_header_pads_to_width() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_header(&mut buf, "X", "00:00", Tone::Active, 60);
        let output = String::from_utf8(buf).unwrap();
        let line = output.trim_end_matches('\n');
        assert!(
            line.chars().count() >= 50,
            "header should pad to fill width, got {} chars",
            line.chars().count()
        );
    }

    #[test]
    fn format_time_date_boundary() {
        let dt = Local::now();
        let result = format_time(&dt, Some("2020-01-01"));
        assert!(
            result.contains("\u{00b7}"),
            "cross-day format should contain middle dot"
        );
    }

    #[test]
    fn print_log_does_not_panic() {
        set_color_enabled(false);
        let messages = vec![
            serde_json::json!({
                "msg_id": "m1",
                "role": "user",
                "content": "Hello!",
                "images": [],
                "timestamp": "2026-01-15T10:30:00Z"
            }),
            serde_json::json!({
                "msg_id": "m2",
                "role": "assistant",
                "content": "Hi there!",
                "images": [],
                "timestamp": "2026-01-15T10:30:45Z"
            }),
            serde_json::json!({
                "msg_id": "m3",
                "role": "system",
                "content": "[compaction] Compacted 42 -> 12 turns",
                "images": [],
                "timestamp": "2026-01-15T10:45:00Z"
            }),
        ];
        print_log(&messages, "Sable", LogFilter::all());
    }

    #[test]
    fn print_log_with_images_does_not_panic() {
        set_color_enabled(false);
        let messages = vec![serde_json::json!({
            "msg_id": "m1",
            "role": "user",
            "content": "Check this out",
            "images": [
                { "path": "/tmp/sunset.png", "caption": "A beautiful sunset" },
                { "path": "/tmp/photo.jpg" }
            ],
            "timestamp": "2026-01-15T10:30:00Z"
        })];
        print_log(&messages, "Sable", LogFilter::all());
    }
}
