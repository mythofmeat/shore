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
