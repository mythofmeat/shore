#[cfg(test)]
use std::io;
use std::io::Write;

use chrono::{DateTime, Datelike, Local};
use shore_common::protocol::operations::{ConversationPage, SegmentSummary};
use shore_common::protocol::server_msg::NewMessage;
use shore_common::protocol::types::{Message, Role};

use super::styling::{
    format_tool_input, format_tool_output, print_image_refs, write_tool_body_plain,
};
use super::vocab::{COLOR_ERROR, Tone, indent_to, paint};
use super::{
    COLOR_RESULT, COLOR_THINKING, COLOR_TOOL, SIGIL_ERROR, SIGIL_OK, SIGIL_THINKING, SIGIL_TOOL,
    parse_timestamp, primary_tool_arg, print_dim_line, process_wrap_width, reflow_reasoning,
    term_width, write_channel_rule, write_process_body, write_section_header, write_sigil_header,
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

pub(crate) struct SegmentFrame {
    title: String,
    older: Option<String>,
    newer: Option<String>,
    empty: &'static str,
}

impl SegmentFrame {
    pub(crate) fn of_page(page: &ConversationPage, now: DateTime<Local>) -> Self {
        let shown = count_user_turns(&page.messages);
        let mut title = Vec::new();
        match &page.segment {
            None => {
                title.push("current context".to_owned());
                title.push(turns(page.total_turns));
                if !page.has_more_before
                    && let Some(since) = page
                        .messages
                        .first()
                        .and_then(|message| parse_timestamp(&message.timestamp))
                {
                    title.push(format!("since {}", since.format("%b %-d %H:%M")));
                }
            }
            Some(segment) => title.push(segment_detail(segment, now)),
        }
        if page.has_more_before {
            title.push(format!("last {} shown", turns(shown)));
        }
        let older = page.previous_segment.as_ref().map(|previous| {
            let mut hint = vec![format!("before this: {}", segment_name(previous))];
            if page.segment.is_none() {
                hint.extend(segment_dates(previous, now));
                hint.push(message_count(previous.message_count));
            }
            hint.push(format!("shore log --segment {}", previous.index));
            hint.join(" \u{00b7} ")
        });
        let newer = page.segment.as_ref().map(|_| {
            page.next_segment.as_ref().map_or_else(
                || "after this: the current context \u{00b7} shore log".to_owned(),
                |next| {
                    format!(
                        "after this: {} \u{00b7} shore log --segment {}",
                        segment_name(next),
                        next.index
                    )
                },
            )
        });
        Self {
            title: title.join(" \u{00b7} "),
            older,
            newer,
            empty: if page.segment.is_none() {
                "(no messages in the current context yet)"
            } else {
                "(no messages in this segment)"
            },
        }
    }
}

pub(crate) fn segment_detail(segment: &SegmentSummary, now: DateTime<Local>) -> String {
    let mut parts = vec![segment_name(segment)];
    parts.extend(segment_dates(segment, now));
    parts.push(message_count(segment.message_count));
    if segment.excluded {
        parts.push("excluded from search".to_owned());
    }
    parts.join(" \u{00b7} ")
}

pub(crate) fn segment_name(segment: &SegmentSummary) -> String {
    segment.label.as_ref().map_or_else(
        || format!("segment {}", segment.index),
        |label| format!("segment {} \"{label}\"", segment.index),
    )
}

fn segment_dates(segment: &SegmentSummary, now: DateTime<Local>) -> Option<String> {
    let day = |value: Option<&String>| {
        value.and_then(|text| parse_timestamp(text)).map(|date| {
            if date.year() == now.year() {
                date.format("%b %-d").to_string()
            } else {
                date.format("%b %-d %Y").to_string()
            }
        })
    };
    match (
        day(segment.first_message_at.as_ref()),
        day(segment.last_message_at.as_ref()),
    ) {
        (Some(first), Some(last)) if first == last => Some(first),
        (Some(first), Some(last)) => Some(format!("{first} \u{2013} {last}")),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

fn turns(count: usize) -> String {
    if count == 1 {
        "1 turn".to_owned()
    } else {
        format!("{count} turns")
    }
}

fn message_count(count: usize) -> String {
    if count == 1 {
        "1 message".to_owned()
    } else {
        format!("{count} messages")
    }
}

fn count_user_turns(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|message| message.role == Role::User && !message.is_tool_result_only())
        .count()
}

fn write_frame_title(out: &mut impl Write, width: usize, title: &str) {
    let prefix = format!("\u{2500}\u{2500} {title} ");
    let trail = width.saturating_sub(prefix.chars().count());
    paint(
        out,
        Tone::Muted,
        &format!("{prefix}{}", "\u{2500}".repeat(trail)),
    );
    _ = writeln!(out);
}

fn write_frame_hint(out: &mut impl Write, hint: &str) {
    paint(out, Tone::Muted, hint);
    _ = writeln!(out);
}

pub(crate) fn print_segment_boundary(index: u64) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_segment_boundary(
        &mut out,
        term_width(),
        index,
        crate::output::use_decoration(),
    );
}

fn write_segment_boundary(out: &mut impl Write, width: usize, index: u64, decorated: bool) {
    let label =
        format!(" earlier messages are now segment {index} \u{00b7} new context starts here ");
    if !decorated {
        _ = writeln!(out, "---{label}---\n");
        return;
    }
    let label_width = label.chars().count();
    let line = if width > label_width {
        let left = width
            .saturating_sub(label_width)
            .checked_div(2)
            .unwrap_or_default();
        let right = width.saturating_sub(label_width.saturating_add(left));
        format!(
            "{}{}{}",
            "\u{2500}".repeat(left),
            label,
            "\u{2500}".repeat(right)
        )
    } else {
        label.trim().to_owned()
    };
    paint(out, Tone::Muted, &line);
    _ = writeln!(out);
    _ = writeln!(out);
}

fn write_thinking(out: &mut impl Write, thinking: &str) {
    write_sigil_header(out, SIGIL_THINKING, "Thinking", COLOR_THINKING);
    let width = process_wrap_width();
    for line in reflow_reasoning(thinking).lines() {
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
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_log(
        &mut out,
        messages,
        None,
        character_name,
        term_width(),
        filter,
    );
}

pub(crate) fn print_log_framed(
    messages: &[serde_json::Value],
    frame: &SegmentFrame,
    character_name: &str,
    filter: LogFilter,
) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_log(
        &mut out,
        messages,
        Some(frame),
        character_name,
        term_width(),
        filter,
    );
}

fn write_log(
    out: &mut impl Write,
    messages: &[serde_json::Value],
    frame: Option<&SegmentFrame>,
    character_name: &str,
    width: usize,
    filter: LogFilter,
) {
    let char_color = character_color(character_name);

    let mut prev_date: Option<String> = None;

    if let Some(header) = frame {
        write_frame_title(out, width, &header.title);
        if let Some(older) = &header.older {
            write_frame_hint(out, older);
        }
        _ = writeln!(out);
        if messages.is_empty() {
            write_frame_hint(out, header.empty);
            _ = writeln!(out);
        }
    }
    for msg in messages {
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

    if let Some(newer) = frame.and_then(|header| header.newer.as_ref()) {
        write_frame_hint(out, newer);
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
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_log_plain(&mut out, messages, None, character_name, filter);
}

pub(crate) fn print_log_plain_framed(
    messages: &[serde_json::Value],
    frame: &SegmentFrame,
    character_name: &str,
    filter: LogFilter,
) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_log_plain(&mut out, messages, Some(frame), character_name, filter);
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

fn write_log_plain(
    out: &mut impl Write,
    messages: &[serde_json::Value],
    frame: Option<&SegmentFrame>,
    character_name: &str,
    filter: LogFilter,
) {
    if let Some(header) = frame {
        _ = writeln!(out, "--- {} ---", header.title);
        if let Some(older) = &header.older {
            _ = writeln!(out, "--- {older} ---");
        }
        _ = writeln!(out);
        if messages.is_empty() {
            _ = writeln!(out, "{}\n", header.empty);
        }
    }
    for msg in messages {
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

    if let Some(newer) = frame.and_then(|header| header.newer.as_ref()) {
        _ = writeln!(out, "--- {newer} ---");
    }
}

pub(crate) fn print_new_message(msg: &NewMessage, character_name: &str) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    let width = term_width();

    let time_str = parse_timestamp(&msg.message.timestamp)
        .map(|dt| dt.format("%H:%M").to_string())
        .unwrap_or_default();

    let speaker = match msg.message.role {
        Role::User => Speaker {
            drawn: "You",
            flat: "you",
            tone: Tone::Active,
        },
        Role::Assistant => Speaker {
            drawn: character_name,
            flat: character_name,
            tone: character_color(character_name),
        },
        Role::System => Speaker {
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
    let stdout = crate::output::stdout();
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
    let stdout = crate::output::stdout();
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
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh log"]
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

    fn summary(index: u64, label: Option<&str>) -> SegmentSummary {
        SegmentSummary {
            index,
            first_message_at: Some("2026-09-28T12:00:00+00:00".into()),
            last_message_at: Some("2026-10-01T12:00:00+00:00".into()),
            compacted_at: "2026-10-01T13:00:00+00:00".into(),
            message_count: 340,
            excluded: false,
            label: label.map(str::to_owned),
            note: None,
            memory_before: None,
            memory_after: None,
        }
    }

    fn page(
        segment: Option<SegmentSummary>,
        previous: Option<SegmentSummary>,
        next: Option<SegmentSummary>,
        has_more_before: bool,
    ) -> ConversationPage {
        ConversationPage {
            messages: vec![],
            cursor: 0,
            next_before: 0,
            has_more_before,
            total_turns: 23,
            segment,
            previous_segment: previous,
            next_segment: next,
        }
    }

    fn noon() -> DateTime<Local> {
        parse_timestamp("2026-10-02T12:00:00+00:00").unwrap()
    }

    fn snapshot_frame() -> SegmentFrame {
        let mut current = page(None, Some(summary(12, Some("harbor"))), None, true);
        current.messages = transcript_snapshot_messages()
            .into_iter()
            .map(|message| serde_json::from_value(message).unwrap())
            .collect();
        SegmentFrame::of_page(&current, noon())
    }

    #[test]
    fn a_current_page_is_titled_by_its_turns_and_points_at_the_segment_before_it() {
        let mut current = page(None, Some(summary(12, None)), None, false);
        current.messages = vec![
            serde_json::from_value(serde_json::json!({
                "msg_id": "u1", "role": "user", "content": "hi", "images": [], "content_blocks": [],
                "timestamp": "2026-10-02T09:14:00+00:00"
            }))
            .unwrap(),
        ];
        let frame = SegmentFrame::of_page(&current, noon());
        let since = parse_timestamp("2026-10-02T09:14:00+00:00")
            .unwrap()
            .format("%b %-d %H:%M");
        assert_eq!(
            frame.title,
            format!("current context \u{b7} 23 turns \u{b7} since {since}")
        );
        assert_eq!(
            frame.older.as_deref(),
            Some(
                "before this: segment 12 \u{b7} Sep 28 \u{2013} Oct 1 \u{b7} 340 messages \u{b7} shore log --segment 12"
            )
        );
        assert!(frame.newer.is_none());
        assert_eq!(frame.empty, "(no messages in the current context yet)");

        current.has_more_before = true;
        let truncated = SegmentFrame::of_page(&current, noon());
        assert_eq!(
            truncated.title,
            "current context \u{b7} 23 turns \u{b7} last 1 turn shown"
        );

        let fresh = SegmentFrame::of_page(&page(None, None, None, false), noon());
        assert_eq!(fresh.title, "current context \u{b7} 23 turns");
        assert!(fresh.older.is_none());
    }

    #[test]
    fn an_archived_page_names_itself_and_both_neighbours() {
        let mut archived = summary(12, Some("harbor"));
        archived.excluded = true;
        let frame = SegmentFrame::of_page(
            &page(
                Some(archived),
                Some(summary(11, None)),
                Some(summary(13, None)),
                false,
            ),
            noon(),
        );
        assert_eq!(
            frame.title,
            "segment 12 \"harbor\" \u{b7} Sep 28 \u{2013} Oct 1 \u{b7} 340 messages \u{b7} excluded from search"
        );
        assert_eq!(
            frame.older.as_deref(),
            Some("before this: segment 11 \u{b7} shore log --segment 11")
        );
        assert_eq!(
            frame.newer.as_deref(),
            Some("after this: segment 13 \u{b7} shore log --segment 13")
        );
        assert_eq!(frame.empty, "(no messages in this segment)");

        let mut one = summary(3, None);
        one.message_count = 1;
        one.last_message_at.clone_from(&one.first_message_at);
        let newest = SegmentFrame::of_page(&page(Some(one), None, None, true), noon());
        assert_eq!(
            newest.title,
            "segment 3 \u{b7} Sep 28 \u{b7} 1 message \u{b7} last 0 turns shown"
        );
        assert!(newest.older.is_none());
        assert_eq!(
            newest.newer.as_deref(),
            Some("after this: the current context \u{b7} shore log")
        );
    }

    #[test]
    fn segment_dates_show_the_year_only_when_it_differs_and_skip_what_is_missing() {
        let mut old = summary(1, None);
        old.first_message_at = Some("2025-12-30T12:00:00+00:00".into());
        old.last_message_at = None;
        assert_eq!(segment_dates(&old, noon()).as_deref(), Some("Dec 30 2025"));
        old.first_message_at = None;
        old.last_message_at = Some("not a date".into());
        assert_eq!(segment_dates(&old, noon()), None);
        old.last_message_at = Some("2026-10-01T12:00:00+00:00".into());
        assert_eq!(segment_dates(&old, noon()).as_deref(), Some("Oct 1"));
    }

    #[test]
    fn an_empty_framed_log_says_so_and_a_new_segment_is_announced() {
        set_color_enabled(false);
        let frame = SegmentFrame::of_page(&page(None, Some(summary(4, None)), None, false), noon());
        let mut rich_bytes = Vec::new();
        write_log(
            &mut rich_bytes,
            &[],
            Some(&frame),
            "Sable",
            60,
            LogFilter::default(),
        );
        let rich = String::from_utf8(rich_bytes).unwrap();
        assert!(
            rich.starts_with("\u{2500}\u{2500} current context \u{b7} 23 turns "),
            "{rich}"
        );
        assert!(
            rich.contains("(no messages in the current context yet)"),
            "{rich}"
        );
        let mut plain_bytes = Vec::new();
        write_log_plain(
            &mut plain_bytes,
            &[],
            Some(&frame),
            "Sable",
            LogFilter::default(),
        );
        let plain = String::from_utf8(plain_bytes).unwrap();
        assert!(
            plain
                .starts_with("--- current context \u{b7} 23 turns ---\n--- before this: segment 4"),
            "{plain}"
        );

        let mut boundary_bytes = Vec::new();
        write_segment_boundary(&mut boundary_bytes, 70, 13, true);
        let boundary = String::from_utf8(boundary_bytes).unwrap();
        assert!(
            boundary
                .contains(" earlier messages are now segment 13 \u{b7} new context starts here "),
            "{boundary}"
        );
        assert!(boundary.starts_with('\u{2500}'), "{boundary}");
        let mut flat = Vec::new();
        write_segment_boundary(&mut flat, 70, 13, false);
        assert_eq!(
            String::from_utf8(flat).unwrap(),
            "--- earlier messages are now segment 13 \u{b7} new context starts here ---\n\n"
        );
    }

    #[test]
    fn rich_transcript_render_snapshot() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_log(
            &mut buf,
            &transcript_snapshot_messages(),
            Some(&snapshot_frame()),
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
        write_log_plain(
            &mut buf,
            &transcript_snapshot_messages(),
            Some(&snapshot_frame()),
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
    fn a_stored_token_stream_block_reads_back_as_prose() {
        set_color_enabled(false);
        let blocks = vec![serde_json::json!({
            "type": "thinking",
            "thinking": "He's\n wrapping\n up\n,\n budget\n dying\n.\n Keep\n it\n SHORT\n."
        })];
        let mut buf = Vec::new();
        render_message_content(&mut buf, Some(&blocks), "", false, LogFilter::all());
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   He's wrapping up, budget dying. Keep it SHORT.\n"
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
        write_log(&mut buf, &messages, None, "Sable", 72, LogFilter::default());
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
        set_color_enabled(true);
        let mut buf = Vec::new();
        write_header(&mut buf, "heidi", "14:30", character_color("heidi"), 40);
        set_color_enabled(false);
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(
            out.contains('\u{1b}'),
            "a speaker header must carry its colour: {out:?}"
        );
    }

    #[test]
    fn the_flat_speaker_line_matches_what_the_batch_renderer_writes() {
        crate::output::set_decoration_enabled(false);

        let mut batch_bytes = Vec::new();
        write_log_plain(
            &mut batch_bytes,
            &[serde_json::json!({
                "role": "user",
                "content": "hi",
                "timestamp": "2026-01-01T14:30:00+00:00",
            })],
            None,
            "heidi",
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
