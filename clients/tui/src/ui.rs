use chrono::{DateTime, Local};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use shore_protocol::tool_display::{format_tool_input, format_tool_output};

use crate::app::{
    AltChoice, App, ConversationEntry, InputMode, PaletteMode, StreamBlock, ValueEditorKind,
};
use crate::images;
use crate::markdown;

/// Render the full TUI layout.
pub fn draw(frame: &mut Frame, app: &mut App) {
    let size = frame.area();

    // Main layout: conversation | input | picker (only when active)
    let input_content_width = size.width as usize;
    let input_height = (app.input.visual_line_count(input_content_width) as u16 + 1).min(8);

    let show_value_editor = app.input.mode == InputMode::Command && app.is_value_editor_open();
    let show_completions =
        app.input.mode == InputMode::Command && !app.completion.candidates.is_empty();
    let show_alt_picker = app.alt_picker.is_some();
    let completion_height = if show_value_editor {
        4
    } else if show_completions {
        let header_lines = if app.completion.header.is_some() {
            1
        } else {
            0
        };
        let n = app.completion.candidates.len() as u16;
        (header_lines + n).min(15)
    } else {
        0
    };
    let alt_picker_height = if let Some(picker) = &app.alt_picker {
        if picker.loading {
            2
        } else {
            (picker.choices.len() as u16 + 1).min(12)
        }
    } else {
        0
    };

    let mut constraints = vec![
        Constraint::Min(3),               // conversation
        Constraint::Length(input_height), // input
    ];
    if show_value_editor || show_completions {
        constraints.push(Constraint::Length(completion_height));
    } else if show_alt_picker {
        constraints.push(Constraint::Length(alt_picker_height));
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(size);

    draw_conversation(frame, &mut *app, chunks[0]);

    draw_input(frame, app, chunks[1]);

    if show_value_editor {
        draw_value_editor(frame, app, chunks[2]);
    } else if show_completions {
        draw_completions_inline(frame, app, chunks[2]);
    } else if show_alt_picker {
        draw_alt_picker_inline(frame, app, chunks[2]);
    }

    if app.show_help {
        draw_help(frame, size);
    }

    if app.fullscreen.is_some() {
        draw_fullscreen_image(frame, app, size);
    }
}

/// Word-wrap text and push it as bar-indented lines (`  │ content`).
fn push_bar_wrapped(
    lines: &mut Vec<Line<'static>>,
    text: &str,
    bar_style: Style,
    content_style: Style,
    text_width: usize,
) {
    for tline in text.lines() {
        for wline in word_wrap(tline, text_width) {
            lines.push(Line::from(vec![
                Span::styled("  │ ".to_string(), bar_style),
                Span::styled(wline, content_style),
            ]));
        }
    }
}

/// Render accumulated thinking blocks as dimmed text under the character name.
fn flush_thinking(
    lines: &mut Vec<Line<'static>>,
    pending: &mut Vec<String>,
    show: bool,
    wrap_width: u16,
) {
    if pending.is_empty() {
        return;
    }
    if !show {
        pending.clear();
        return;
    }
    let header_style = Style::default()
        .fg(Color::Magenta)
        .add_modifier(Modifier::BOLD);
    let content_style = Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::ITALIC);
    let bar_style = Style::default().fg(Color::DarkGray);
    lines.push(Line::from(Span::styled("  ◆ thinking", header_style)));
    let text_width = wrap_width.saturating_sub(4) as usize; // "  │ " = 4 cols
    for thought in pending.drain(..) {
        push_bar_wrapped(lines, &thought, bar_style, content_style, text_width);
    }
    lines.push(Line::from(""));
}

fn flush_tools(
    lines: &mut Vec<Line<'static>>,
    pending: &mut Vec<&ConversationEntry>,
    show: bool,
    wrap_width: u16,
) {
    if !show {
        pending.clear();
        return;
    }
    let bar_style = Style::default().fg(Color::DarkGray);
    let text_width = wrap_width.saturating_sub(4) as usize; // "  │ " = 4 cols
    for entry in pending.drain(..) {
        match entry {
            ConversationEntry::ToolCall {
                tool_name, input, ..
            } => {
                lines.push(Line::from(vec![
                    Span::styled("  ▶ ", Style::default().fg(Color::Magenta)),
                    Span::styled(
                        tool_name.clone(),
                        Style::default()
                            .fg(Color::Magenta)
                            .add_modifier(Modifier::BOLD),
                    ),
                ]));
                if let Some(input) = format_tool_input(input) {
                    push_bar_wrapped(
                        lines,
                        &input,
                        bar_style,
                        Style::default().fg(Color::DarkGray),
                        text_width,
                    );
                }
                lines.push(Line::from(""));
            }
            ConversationEntry::ToolResult {
                tool_name,
                output,
                is_error,
                ..
            } => {
                let header_color = if *is_error { Color::Red } else { Color::Cyan };
                lines.push(Line::from(vec![
                    Span::styled("  ◀ ", Style::default().fg(header_color)),
                    Span::styled(
                        tool_name.clone(),
                        Style::default()
                            .fg(header_color)
                            .add_modifier(Modifier::BOLD),
                    ),
                ]));
                let output = format_tool_output(output);
                push_bar_wrapped(
                    lines,
                    &output,
                    bar_style,
                    Style::default().fg(Color::DarkGray),
                    text_width,
                );
                lines.push(Line::from(""));
            }
            _ => {}
        }
    }
}

/// Squeeze runs of >1 consecutive blank lines down to at most 1.
fn squeeze_blank_lines(lines: &mut Vec<Line<'static>>) {
    let mut consecutive_blanks = 0u32;
    let mut squeezed = Vec::with_capacity(lines.len());

    for line in lines.drain(..) {
        if line.width() == 0 {
            consecutive_blanks += 1;
            if consecutive_blanks > 1 {
                continue;
            }
        } else {
            consecutive_blanks = 0;
        }
        squeezed.push(line);
    }

    *lines = squeezed;
}

fn visual_line_count(lines: &[Line<'static>], _width: u16) -> u16 {
    lines.len().min(u16::MAX as usize) as u16
}

/// Word-wrap a single line of text to fit within `max_width` columns.
fn word_wrap(text: &str, max_width: usize) -> Vec<String> {
    use unicode_width::UnicodeWidthStr;

    if max_width == 0 || UnicodeWidthStr::width(text) <= max_width {
        return vec![text.to_string()];
    }

    let mut result = Vec::new();
    let mut current = String::new();
    let mut current_width: usize = 0;

    for word in text.split_whitespace() {
        let w = UnicodeWidthStr::width(word);
        if current.is_empty() {
            current = word.to_string();
            current_width = w;
        } else if current_width + 1 + w <= max_width {
            current.push(' ');
            current.push_str(word);
            current_width += 1 + w;
        } else {
            result.push(std::mem::take(&mut current));
            current = word.to_string();
            current_width = w;
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}

/// Prepend 2-space indent to each line (for content under a name header).
fn indent_lines(src: Vec<Line<'static>>) -> Vec<Line<'static>> {
    src.into_iter()
        .map(|line| {
            if line.width() == 0 {
                return line;
            }
            let mut spans = vec![Span::raw("  ")];
            spans.extend(line.spans);
            Line::from(spans)
        })
        .collect()
}

/// Render the assistant name header for an in-progress streamed turn.
/// A single turn can span multiple phases (tool_use → final), so this
/// header is emitted exactly once by the caller.
fn render_streaming_header(lines: &mut Vec<Line<'static>>, app: &App) {
    let name = if app.character_name.is_empty() {
        "Assistant"
    } else {
        &app.character_name
    };

    if app.stream.regen {
        lines.push(Line::from(Span::styled(
            format!("{name} (regenerating)"),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD | Modifier::ITALIC),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            name.to_string(),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        )));
    }
    lines.push(Line::from(""));
}

/// Render the body of an in-progress stream: interleaved thinking/text
/// blocks followed by a compact spinner. Caller emits the header.
fn render_streaming_content(lines: &mut Vec<Line<'static>>, app: &App, content_width: u16) {
    // Render interleaved blocks inline
    let wrap_w = content_width.saturating_sub(2) as usize;
    let thinking_style = Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::ITALIC);
    let bar_style = Style::default().fg(Color::DarkGray);
    let header_style = Style::default()
        .fg(Color::Magenta)
        .add_modifier(Modifier::BOLD);
    let text_width = content_width.saturating_sub(4) as usize;

    for block in &app.stream.blocks {
        match block {
            StreamBlock::Thinking(s) => {
                if app.show_thinking && !s.is_empty() {
                    lines.push(Line::from(Span::styled("  ◆ thinking", header_style)));
                    push_bar_wrapped(lines, s, bar_style, thinking_style, text_width);
                    lines.push(Line::from(""));
                }
            }
            StreamBlock::Text(s) => {
                if !s.is_empty() {
                    lines.extend(indent_lines(markdown::render_markdown_wrapped(s, wrap_w)));
                    lines.push(Line::from(""));
                }
            }
        }
    }

    // Compact spinner — always visible during streaming
    let indicator_style = Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::ITALIC);

    let spinner = spinner_glyphs(app.spinner_frame);

    if let Some(ref tool) = app.stream.tool_name {
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled("▶ ", Style::default().fg(Color::Magenta)),
            Span::styled(
                tool.clone(),
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!(" {spinner}"), indicator_style),
        ]));
    } else {
        let label = match app.stream.phase.as_str() {
            "thinking" => format!("thinking {spinner}"),
            "tool_use" => format!("waiting for tool {spinner}"),
            "responding" => spinner.to_string(),
            _ => spinner.to_string(),
        };
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(label, indicator_style),
        ]));
    }
    lines.push(Line::from(""));
}

fn spinner_glyphs(frame: usize) -> &'static str {
    const FRAMES: [&str; 4] = ["···", "•··", "·•·", "··•"];
    FRAMES[frame % FRAMES.len()]
}

fn format_timestamp(timestamp: &str) -> Option<String> {
    let timestamp = timestamp.trim();
    if timestamp.is_empty() {
        return None;
    }

    match DateTime::parse_from_rfc3339(timestamp) {
        Ok(dt) => {
            let local = dt.with_timezone(&Local);
            if local.date_naive() == Local::now().date_naive() {
                Some(local.format("%H:%M").to_string())
            } else {
                Some(local.format("%Y-%m-%d %H:%M").to_string())
            }
        }
        Err(_) => Some(timestamp.to_string()),
    }
}

fn push_entry_header(
    lines: &mut Vec<Line<'static>>,
    label: String,
    color: Color,
    timestamp: &str,
    show_timestamp: bool,
) {
    let mut spans = vec![Span::styled(
        label,
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )];
    if show_timestamp {
        if let Some(display) = format_timestamp(timestamp) {
            spans.push(Span::styled(
                format!("  {display}"),
                Style::default().fg(Color::DarkGray),
            ));
        }
    }
    lines.push(Line::from(spans));
}

/// Render the scrollable conversation log.
///
/// Building the full line list from `app.entries` is expensive — markdown
/// rendering and word-wrap run for every text entry. To keep keystroke
/// latency flat as the conversation grows, the lines are cached in
/// `app.conv_cache` and reused on frames where a cheap fingerprint of
/// rendering-relevant state matches the previous build.
fn draw_conversation(frame: &mut Frame, app: &mut App, area: Rect) {
    let content_width = area.width;

    let fingerprint = app.conversation_fingerprint(content_width);
    if app.conv_cache.fingerprint != fingerprint {
        let (lines, image_index, content_visual) = build_conversation_lines(app, content_width);
        app.image_index = image_index;
        app.conv_cache.fingerprint = fingerprint;
        app.conv_cache.lines = lines;
        app.conv_cache.content_visual = content_visual;
    }

    let visible_height = area.height;
    let content_visual = app.conv_cache.content_visual;
    let total_visual = content_visual.max(visible_height);
    let max_scroll = total_visual.saturating_sub(visible_height);
    app.conversation_max_scroll = max_scroll;
    if app.scroll_offset > max_scroll {
        app.scroll_offset = max_scroll;
        if max_scroll == 0 {
            app.auto_scroll = true;
        }
    }
    let scroll = if app.auto_scroll {
        max_scroll
    } else {
        max_scroll.saturating_sub(app.scroll_offset)
    };

    // Bottom-anchor short conversations by shifting the render rect rather
    // than allocating padding lines — saves an O(n_lines) clone every frame
    // and keeps the cache reusable across resizes that fit inline.
    let render_area = if content_visual < visible_height {
        let top_pad = visible_height - content_visual;
        Rect {
            x: area.x,
            y: area.y + top_pad,
            width: area.width,
            height: content_visual,
        }
    } else {
        area
    };

    frame.render_widget(Clear, area);

    let paragraph = Paragraph::new(Text::from(app.conv_cache.lines.clone())).scroll((scroll, 0));

    frame.render_widget(paragraph, render_area);

    // Swap U+2800 stand-in → U+10EEEE kitty placeholder in rendered cells.
    if !app.image_index.is_empty() {
        images::fixup_placeholder_cells(frame.buffer_mut(), render_area);
    }
}

/// Build the full Vec<Line> for the conversation pane from `app.entries`,
/// the live stream state, and the active image cache. Returns the lines,
/// the rebuilt image index, and the visual line count.
fn build_conversation_lines(
    app: &App,
    content_width: u16,
) -> (Vec<Line<'static>>, Vec<crate::app::ImageEntry>, u16) {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut image_index: Vec<crate::app::ImageEntry> = Vec::new();

    // During streaming, skip trailing Thinking entries — they duplicate
    // what's already being shown from the live stream blocks.
    let entry_count = if app.stream.active {
        let trailing_thinking = app
            .entries
            .iter()
            .rev()
            .take_while(|e| matches!(e, ConversationEntry::Thinking { .. }))
            .count();
        app.entries.len() - trailing_thinking
    } else {
        app.entries.len()
    };

    // Thinking and tool entries are deferred so they render under the assistant
    // name, not floating above it as if they're part of the user's message.
    let mut pending_thinking: Vec<String> = Vec::new();
    let mut pending_tools: Vec<&ConversationEntry> = Vec::new();

    for entry in app.entries[..entry_count].iter() {
        match entry {
            ConversationEntry::Thinking { content } => {
                pending_thinking.push(content.clone());
                continue;
            }
            ConversationEntry::ToolCall { .. } | ConversationEntry::ToolResult { .. } => {
                pending_tools.push(entry);
                continue;
            }
            ConversationEntry::ArchiveBoundary { archived_count } => {
                flush_thinking(
                    &mut lines,
                    &mut pending_thinking,
                    app.show_thinking,
                    content_width,
                );
                flush_tools(
                    &mut lines,
                    &mut pending_tools,
                    app.show_tools,
                    content_width,
                );
                push_archive_boundary(&mut lines, content_width, *archived_count);
                continue;
            }
            _ => {}
        }

        match entry {
            ConversationEntry::User {
                content,
                images,
                timestamp,
            } => {
                flush_thinking(
                    &mut lines,
                    &mut pending_thinking,
                    app.show_thinking,
                    content_width,
                );
                flush_tools(
                    &mut lines,
                    &mut pending_tools,
                    app.show_tools,
                    content_width,
                );
                push_entry_header(
                    &mut lines,
                    "You".to_string(),
                    Color::Blue,
                    timestamp,
                    app.show_timestamps,
                );
                lines.push(Line::from(""));
                let wrap_w = content_width.saturating_sub(2) as usize;
                lines.extend(indent_lines(markdown::render_markdown_wrapped(
                    content, wrap_w,
                )));
                render_images(
                    &mut lines,
                    images,
                    &app.image_cache,
                    app.show_images,
                    &mut image_index,
                );
                lines.push(Line::from(""));
            }
            ConversationEntry::Assistant {
                content,
                metadata,
                images,
                timestamp,
                ..
            } => {
                let name = if app.character_name.is_empty() {
                    "Assistant".to_string()
                } else {
                    app.character_name.clone()
                };
                push_entry_header(
                    &mut lines,
                    name,
                    Color::Green,
                    timestamp,
                    app.show_timestamps,
                );
                lines.push(Line::from(""));
                // Render thinking and tool calls under the character name
                flush_thinking(
                    &mut lines,
                    &mut pending_thinking,
                    app.show_thinking,
                    content_width,
                );
                flush_tools(
                    &mut lines,
                    &mut pending_tools,
                    app.show_tools,
                    content_width,
                );
                let wrap_w = content_width.saturating_sub(2) as usize;
                lines.extend(indent_lines(markdown::render_markdown_wrapped(
                    content, wrap_w,
                )));
                render_images(
                    &mut lines,
                    images,
                    &app.image_cache,
                    app.show_images,
                    &mut image_index,
                );
                if app.show_metadata {
                    if let Some(meta) = metadata {
                        lines.push(Line::from(Span::styled(
                            format!(
                                "  [{} | in:{} out:{} cache:{} | {}ms]",
                                meta.model,
                                meta.tokens.input,
                                meta.tokens.output,
                                meta.tokens.cache_read,
                                meta.timing.total_ms,
                            ),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                }
                lines.push(Line::from(""));
            }
            ConversationEntry::System {
                content,
                count,
                timestamp,
            } => {
                flush_thinking(
                    &mut lines,
                    &mut pending_thinking,
                    app.show_thinking,
                    content_width,
                );
                flush_tools(
                    &mut lines,
                    &mut pending_tools,
                    app.show_tools,
                    content_width,
                );
                let header = if *count > 1 {
                    format!("System (×{count})")
                } else {
                    "System".to_string()
                };
                push_entry_header(
                    &mut lines,
                    header,
                    Color::Yellow,
                    timestamp,
                    app.show_timestamps,
                );
                lines.push(Line::from(""));
                let sys_style = Style::default().fg(Color::Yellow);
                let sys_wrap_w = content_width.saturating_sub(2) as usize;
                for sline in content.lines() {
                    for wline in word_wrap(sline, sys_wrap_w) {
                        lines.push(Line::from(vec![
                            Span::raw("  "),
                            Span::styled(wline, sys_style),
                        ]));
                    }
                }
                lines.push(Line::from(""));
            }
            ConversationEntry::Thinking { .. }
            | ConversationEntry::ArchiveBoundary { .. }
            | ConversationEntry::ToolCall { .. }
            | ConversationEntry::ToolResult { .. } => unreachable!(),
        }
    }

    // When streaming, emit a single assistant header and flush any pending
    // thinking/tool entries underneath it before rendering live content.
    // Otherwise, flush orphans without a header (shouldn't normally occur).
    if app.stream.active {
        render_streaming_header(&mut lines, app);
        flush_thinking(
            &mut lines,
            &mut pending_thinking,
            app.show_thinking,
            content_width,
        );
        flush_tools(
            &mut lines,
            &mut pending_tools,
            app.show_tools,
            content_width,
        );
        render_streaming_content(&mut lines, app, content_width);
    } else {
        flush_thinking(
            &mut lines,
            &mut pending_thinking,
            app.show_thinking,
            content_width,
        );
        flush_tools(
            &mut lines,
            &mut pending_tools,
            app.show_tools,
            content_width,
        );
    }

    // Empty state: show a welcome hint
    if lines.is_empty() && !app.stream.active {
        let hint_style = Style::default().fg(Color::DarkGray);
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled("Press i to start typing, Enter to send", hint_style),
        ]));
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled("Esc for normal mode · : for commands", hint_style),
        ]));
    }

    // Squeeze runs of blank lines (max 2 consecutive)
    squeeze_blank_lines(&mut lines);

    let content_visual = visual_line_count(&lines, content_width);

    (lines, image_index, content_visual)
}

fn push_archive_boundary(
    lines: &mut Vec<Line<'static>>,
    content_width: u16,
    archived_turns: usize,
) {
    if archived_turns == 0 {
        return;
    }

    lines.push(Line::from(""));

    let label = if archived_turns == 1 {
        " 1 archived turn above · outside current context ".to_string()
    } else {
        format!(" {archived_turns} archived turns above · outside current context ")
    };
    let width = content_width as usize;
    let label_width = unicode_width::UnicodeWidthStr::width(label.as_str());

    let text = if width > label_width {
        let left = (width - label_width) / 2;
        let right = width.saturating_sub(label_width + left);
        format!("{}{}{}", "─".repeat(left), label, "─".repeat(right))
    } else {
        label.trim().to_string()
    };

    lines.push(Line::from(Span::styled(
        text,
        Style::default().fg(Color::DarkGray),
    )));
    lines.push(Line::from(""));
}

/// Render the fullscreen image viewer overlay.
fn draw_fullscreen_image(frame: &mut Frame, app: &App, area: Rect) {
    let idx = match app.fullscreen {
        Some(i) if i < app.image_index.len() => i,
        _ => return,
    };
    let entry = &app.image_index[idx];
    let transmitted = match app.image_cache.get(&entry.path) {
        Some(t) => t,
        None => return,
    };

    // Layout: image area + 1-row status bar
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),    // image
            Constraint::Length(1), // status bar
        ])
        .split(area);

    let img_area = chunks[0];
    let status_area = chunks[1];

    // Compute fullscreen cell dimensions preserving aspect ratio
    let (fs_cols, fs_rows) = app.image_cache.calculate_cells(
        transmitted.pw,
        transmitted.ph,
        img_area.width,
        img_area.height,
    );

    // Center the image vertically in the image area
    let v_pad = img_area.height.saturating_sub(fs_rows) / 2;
    let mut img_lines: Vec<Line<'static>> = Vec::new();
    for _ in 0..v_pad {
        img_lines.push(Line::from(""));
    }
    img_lines.extend(images::placeholder_lines_at(
        transmitted.id,
        fs_cols,
        fs_rows,
    ));

    let paragraph = Paragraph::new(Text::from(img_lines));
    frame.render_widget(paragraph, img_area);

    // Status bar: "  3/7 — filename.png"
    let total = app.image_index.len();
    let status_text = format!("  {}/{} \u{2014} {}", idx + 1, total, entry.display_name);
    let status = Paragraph::new(Line::from(Span::styled(
        status_text,
        Style::default().fg(Color::DarkGray),
    )));
    frame.render_widget(status, status_area);

    // Fix up placeholder cells in the image area
    images::fixup_placeholder_cells(frame.buffer_mut(), img_area);
}

/// Render image entries — kitty placeholders when available, text fallback otherwise.
/// Populates `index` with the line position of each transmitted image.
fn render_images(
    lines: &mut Vec<Line<'static>>,
    img_refs: &[shore_protocol::types::ImageRef],
    cache: &images::ImageCache,
    show_inline: bool,
    index: &mut Vec<crate::app::ImageEntry>,
) {
    if img_refs.is_empty() {
        return;
    }

    // Blank line before images for visual separation
    lines.push(Line::from(""));

    for img in img_refs {
        // Extract display name: caption, filename, or full path
        let display = img.caption.as_deref().unwrap_or_else(|| {
            std::path::Path::new(&img.path)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(&img.path)
        });

        if show_inline {
            if let Some(transmitted) = cache.get(&img.path) {
                lines.push(Line::from(Span::styled(
                    format!("  [{display}]"),
                    Style::default().fg(Color::Magenta),
                )));
                let img_start_line = lines.len();
                lines.extend(images::placeholder_lines(transmitted));
                index.push(crate::app::ImageEntry {
                    path: img.path.clone(),
                    display_name: display.to_string(),
                    line: img_start_line,
                });
                continue;
            }
        }

        // Text fallback (no kitty, or inline images toggled off)
        lines.push(Line::from(Span::styled(
            format!("  [image: {display}]"),
            Style::default().fg(Color::Magenta),
        )));
    }
}

/// Render the input area.
fn draw_input(frame: &mut Frame, app: &App, area: Rect) {
    if app.input.mode == InputMode::Command {
        // Top vs. submenu: title and prefix differ.
        let (title, prefix): (String, &str) = match &app.completion.mode {
            PaletteMode::Top => (" [COMMAND] ".to_string(), ":"),
            PaletteMode::Submenu(s) => (format!(" [{}] ", s.parent), ""),
            PaletteMode::ValueEditor(s) => (format!(" [{}] ", s.key), ""),
        };
        let display = format!("{prefix}{}", app.input.cmd_text);
        let block = Block::default()
            .borders(Borders::TOP)
            .title(title)
            .border_style(Style::default().fg(Color::Yellow));
        let paragraph = Paragraph::new(display.as_str())
            .block(block)
            .wrap(Wrap { trim: false });

        frame.render_widget(paragraph, area);

        // Cursor after the prefix + cmd_cursor.
        let prefix_w = unicode_width::UnicodeWidthStr::width(prefix) as u16;
        let cursor_x = prefix_w
            + unicode_width::UnicodeWidthStr::width(&app.input.cmd_text[..app.input.cmd_cursor])
                as u16;
        frame.set_cursor_position((area.x + cursor_x, area.y + 1));
        return;
    }

    // Word-wrap the input text — shared offsets drive rendering AND cursor calc.
    let content_width = area.width as usize;
    let line_starts = crate::app::word_wrap_offsets(&app.input.text, content_width);

    // Cursor visual position: find which visual line it lands on.
    let cy_idx = line_starts
        .partition_point(|&s| s <= app.input.cursor)
        .saturating_sub(1);
    let cy: u16 = cy_idx as u16;
    let line_start = line_starts[cy_idx];
    let mut cx: usize = app.input.text[line_start..app.input.cursor]
        .chars()
        .map(|c| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0))
        .sum();

    // If cursor lands exactly at the right edge, wrap to next line
    let cy = if content_width > 0 && cx >= content_width {
        cx = 0;
        cy + 1
    } else {
        cy
    };

    // Scroll input so cursor line is always visible
    let content_height = area.height.saturating_sub(1);
    let input_scroll = if cy >= content_height {
        cy - content_height + 1
    } else {
        0
    };

    // Show placeholder when input is empty in insert mode
    let show_placeholder = app.input.text.is_empty() && app.input.mode == InputMode::Insert;
    let input_content: Text = if show_placeholder {
        Text::from(Line::from(Span::styled(
            "Type a message...",
            Style::default().fg(Color::DarkGray),
        )))
    } else {
        // Build visual lines from the word-wrap offsets.
        let text = &app.input.text;
        let lines: Vec<String> = line_starts
            .iter()
            .enumerate()
            .map(|(idx, &start)| {
                let end = line_starts.get(idx + 1).copied().unwrap_or(text.len());
                let slice = &text[start..end];
                slice.strip_suffix('\n').unwrap_or(slice).to_string()
            })
            .collect();
        Text::from(lines.into_iter().map(Line::from).collect::<Vec<_>>())
    };

    let (mode_label, border_color) = if app.editing_ref.is_some() {
        (" [EDIT] ".to_string(), Color::Yellow)
    } else {
        match app.input.mode {
            InputMode::Insert => (" [INSERT] ".to_string(), Color::Cyan),
            InputMode::Normal => (" [NORMAL] ".to_string(), Color::DarkGray),
            InputMode::Command => unreachable!(),
        }
    };
    let img_count = app.pending_images.len();
    let mut block = Block::default()
        .borders(Borders::TOP)
        .title(mode_label)
        .border_style(Style::default().fg(border_color));
    let mut indicators: Vec<(String, Color)> = Vec::new();
    if img_count > 0 {
        indicators.push((
            if img_count == 1 {
                "1 image".to_string()
            } else {
                format!("{img_count} images")
            },
            Color::Magenta,
        ));
    }
    if app.live_speak {
        indicators.push(("TTS".to_string(), Color::Cyan));
    }
    if !indicators.is_empty() {
        let mut spans = vec![Span::raw(" ")];
        for (i, (label, color)) in indicators.into_iter().enumerate() {
            if i > 0 {
                spans.push(Span::styled(" | ", Style::default().fg(Color::DarkGray)));
            }
            spans.push(Span::styled(label, Style::default().fg(color)));
        }
        spans.push(Span::raw(" "));
        block = block.title(Line::from(spans).right_aligned());
    }
    let paragraph = Paragraph::new(input_content)
        .block(block)
        .scroll((input_scroll, 0));

    frame.render_widget(paragraph, area);

    // Show cursor in insert mode
    if app.input.mode == InputMode::Insert {
        frame.set_cursor_position((area.x + cx as u16, area.y + 1 + cy - input_scroll));
    }
}

/// Render the keyboard shortcuts help overlay.
fn draw_help(frame: &mut Frame, area: Rect) {
    let lines = vec![
        Line::from(""),
        Line::from(vec![Span::styled(
            "  Navigation",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(Span::styled(
            "    j / k           scroll down / up",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    d / u           scroll down / up (10 lines)",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    G               jump to bottom",
            Style::default().fg(Color::White),
        )),
        Line::from(""),
        Line::from(vec![Span::styled(
            "  Input",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(Span::styled(
            "    i / a / I / A   enter insert mode",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    Enter           send message",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    Shift+Enter     newline",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    Ctrl+G          open input in $EDITOR",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    Esc             normal mode",
            Style::default().fg(Color::White),
        )),
        Line::from(""),
        Line::from(vec![Span::styled(
            "  Toggles",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(Span::styled(
            "    t               toggle thinking blocks",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    T               toggle tool-use blocks",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    p               toggle inline images",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    o               fullscreen image viewer",
            Style::default().fg(Color::White),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled(
                "  Commands  ",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled("(press : to open)", Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(Span::styled(
            "    :help           this screen",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :character      switch character",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :model          switch model (`:model all` includes hidden)",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :setting        view/set sampler settings (picker on Enter)",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :view           toggle TUI display preferences",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :image          attach image (picker)",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :edit <ref>     edit message (last, -1, -2)",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :alt           choose alternate response",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :quit           exit",
            Style::default().fg(Color::White),
        )),
        Line::from(Span::styled(
            "    :memory  :compact  :regen",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "  Press any key to close",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )),
        Line::from(""),
    ];

    let height = lines.len() as u16 + 2;
    let width = 56u16.min(area.width);
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    let popup_area = Rect::new(x, y, width, height);

    let popup = Paragraph::new(Text::from(lines))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Keyboard Shortcuts ")
                .border_style(Style::default().fg(Color::Yellow)),
        )
        .style(Style::default().bg(Color::Rgb(20, 20, 30)));

    frame.render_widget(ratatui::widgets::Clear, popup_area);
    frame.render_widget(popup, popup_area);
}

/// Render completion candidates inline in their own layout chunk below
/// the input. Uses the chunk's full width; selected row gets a yellow
/// highlight; an optional dim header labels the current submenu context
/// (e.g. "model", "setting key").
fn completion_window_start(
    selected: Option<usize>,
    visible_rows: usize,
    total_rows: usize,
) -> usize {
    if visible_rows == 0 || total_rows <= visible_rows {
        return 0;
    }
    selected
        .map(|idx| idx.saturating_add(1).saturating_sub(visible_rows))
        .unwrap_or(0)
        .min(total_rows - visible_rows)
}

fn draw_completions_inline(frame: &mut Frame, app: &App, area: Rect) {
    if area.height == 0 || app.completion.candidates.is_empty() {
        return;
    }

    let mut lines: Vec<Line<'static>> = Vec::new();

    if let Some(header) = &app.completion.header {
        lines.push(Line::from(Span::styled(
            format!("  {header}"),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )));
    }

    // Two-column layout: name left-aligned to `name_col`, optional
    // description after a >=2-space gap. Width pads to area.width so
    // the selected-row highlight reaches the right edge.
    let candidate_rows = (area.height as usize).saturating_sub(lines.len());
    let row_width = area.width as usize;
    // 3-space prefix + longest command name (9: "character") + 6-space gap.
    // Keeps descriptions in a single column aligned across all rows.
    let name_col: usize = 18;

    // In a submenu picker, the candidate matching the daemon's active
    // model / character gets a dim "(active)" marker so the user can
    // see what's currently in effect.
    const ACTIVE_MARKER: &str = "  ● active";

    let window_start = completion_window_start(
        app.completion.selected,
        candidate_rows,
        app.completion.candidates.len(),
    );

    for (offset, c) in app
        .completion
        .candidates
        .iter()
        .skip(window_start)
        .take(candidate_rows)
        .enumerate()
    {
        let i = window_start + offset;
        let selected = app.completion.selected == Some(i);
        let desc = App::command_description(c);
        let is_active = match &app.completion.mode {
            PaletteMode::Submenu(s) if s.parent == "model" => app.is_active_model_candidate(c),
            PaletteMode::Submenu(s) if s.parent == "character" => {
                !app.character_name.is_empty() && app.character_name == *c
            }
            PaletteMode::Submenu(s) if s.parent.starts_with("setting:") => s
                .parent
                .strip_prefix("setting:")
                .is_some_and(|key| app.is_effective_setting_candidate(key, c)),
            PaletteMode::Submenu(s) if s.parent == "view" => {
                app.view_enabled(App::view_key_from_row(c)).unwrap_or(false)
            }
            _ => false,
        };

        let name_text = format!("   {c}");
        let name_w = unicode_width::UnicodeWidthStr::width(name_text.as_str());

        let (gap, desc_text) = if let Some(d) = desc {
            let gap = name_col.saturating_sub(name_w).max(2);
            (" ".repeat(gap), d.to_string())
        } else if is_active {
            (String::new(), ACTIVE_MARKER.to_string())
        } else {
            (String::new(), String::new())
        };

        let used = name_w
            + unicode_width::UnicodeWidthStr::width(gap.as_str())
            + unicode_width::UnicodeWidthStr::width(desc_text.as_str());
        let trailing = if used < row_width {
            " ".repeat(row_width - used)
        } else {
            String::new()
        };

        if selected {
            // One span so the yellow bg fills the entire row uniformly.
            let full = format!("{name_text}{gap}{desc_text}{trailing}");
            lines.push(Line::from(Span::styled(
                full,
                Style::default().fg(Color::Black).bg(Color::Yellow),
            )));
        } else if desc.is_some() {
            // Two-tone: bright name, dim description.
            lines.push(Line::from(vec![
                Span::styled(name_text, Style::default().fg(Color::White)),
                Span::raw(gap),
                Span::styled(desc_text, Style::default().fg(Color::DarkGray)),
                Span::raw(trailing),
            ]));
        } else if is_active {
            // Submenu candidate that matches the active value — dim marker.
            lines.push(Line::from(vec![
                Span::styled(name_text, Style::default().fg(Color::White)),
                Span::styled(desc_text, Style::default().fg(Color::DarkGray)),
                Span::raw(trailing),
            ]));
        } else {
            // Argument candidate (no description) — single span.
            lines.push(Line::from(Span::styled(
                format!("{name_text}{trailing}"),
                Style::default().fg(Color::White),
            )));
        }
    }

    let paragraph = Paragraph::new(Text::from(lines));
    frame.render_widget(paragraph, area);
}

fn draw_value_editor(frame: &mut Frame, app: &App, area: Rect) {
    if area.height == 0 {
        return;
    }
    let PaletteMode::ValueEditor(state) = &app.completion.mode else {
        return;
    };

    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(Span::styled(
        format!("  {}", state.key),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    )));

    match &state.kind {
        ValueEditorKind::Slider {
            min,
            max,
            current,
            typed,
            ..
        } => {
            let value_text = typed
                .clone()
                .unwrap_or_else(|| App::format_slider_number(*current));
            let value_width = unicode_width::UnicodeWidthStr::width(value_text.as_str());
            let row_width = area.width as usize;
            let rail_width = row_width.saturating_sub(value_width + 8).clamp(8, 48);
            let ratio = if max > min {
                ((*current - *min) / (*max - *min)).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let thumb = ((rail_width.saturating_sub(1)) as f64 * ratio).round() as usize;
            let mut rail = String::with_capacity(rail_width + 2);
            rail.push('[');
            for idx in 0..rail_width {
                rail.push(if idx == thumb { '●' } else { '─' });
            }
            rail.push(']');

            let rail_width_with_brackets = unicode_width::UnicodeWidthStr::width(rail.as_str());
            let gap = row_width
                .saturating_sub(2 + rail_width_with_brackets + value_width)
                .max(1);
            let value_style = if typed.is_some() {
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::ITALIC)
            } else {
                Style::default().fg(Color::Yellow)
            };
            lines.push(Line::from(vec![
                Span::raw(format!("  {rail}")),
                Span::raw(" ".repeat(gap)),
                Span::styled(value_text, value_style),
            ]));

            let min_label = App::format_slider_number(*min);
            let max_label = App::format_slider_number(*max);
            let label_gap = rail_width.saturating_sub(
                unicode_width::UnicodeWidthStr::width(min_label.as_str())
                    + unicode_width::UnicodeWidthStr::width(max_label.as_str()),
            );
            lines.push(Line::from(Span::styled(
                format!("  {min_label}{}{}", "─".repeat(label_gap.max(1)), max_label),
                Style::default().fg(Color::DarkGray),
            )));
        }
    }

    lines.push(Line::from(Span::styled(
        "  ←/→ adjust · type to set · Enter apply · Esc cancel",
        Style::default().fg(Color::DarkGray),
    )));

    let visible = lines
        .into_iter()
        .take(area.height as usize)
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(Text::from(visible)), area);
}

fn alt_preview_text(choice: &AltChoice, max_width: usize) -> String {
    let compact = choice
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        return "(empty)".into();
    }
    let mut out = String::new();
    let mut width = 0usize;
    for ch in compact.chars() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if width + w > max_width.saturating_sub(3) {
            out.push_str("...");
            return out;
        }
        out.push(ch);
        width += w;
    }
    out
}

fn draw_alt_picker_inline(frame: &mut Frame, app: &App, area: Rect) {
    let Some(picker) = &app.alt_picker else {
        return;
    };
    if area.height == 0 {
        return;
    }

    let row_width = area.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    let title = picker
        .msg_id
        .as_deref()
        .or(picker.target_ref.as_deref())
        .map(|msg_id| format!("  alternates for {msg_id}"))
        .unwrap_or_else(|| "  alternates".to_string());
    lines.push(Line::from(Span::styled(
        title,
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    )));

    if picker.loading {
        lines.push(Line::from(Span::styled(
            "  loading alternates...",
            Style::default().fg(Color::White),
        )));
        frame.render_widget(Paragraph::new(Text::from(lines)), area);
        return;
    }

    let visible_rows = (area.height as usize).saturating_sub(1);
    let window_start =
        completion_window_start(Some(picker.selected), visible_rows, picker.choices.len());

    for (offset, choice) in picker
        .choices
        .iter()
        .skip(window_start)
        .take(visible_rows)
        .enumerate()
    {
        let i = window_start + offset;
        let selected = i == picker.selected;
        let active = if choice.active { "*" } else { " " };
        let prefix = format!("  {active} {:>2}  ", choice.position);
        let prefix_width = unicode_width::UnicodeWidthStr::width(prefix.as_str());
        let preview_width = row_width.saturating_sub(prefix_width).max(8);
        let preview = alt_preview_text(choice, preview_width);
        let used = prefix_width + unicode_width::UnicodeWidthStr::width(preview.as_str());
        let trailing = if used < row_width {
            " ".repeat(row_width - used)
        } else {
            String::new()
        };
        let row = format!("{prefix}{preview}{trailing}");

        if selected {
            lines.push(Line::from(Span::styled(
                row,
                Style::default().fg(Color::Black).bg(Color::Yellow),
            )));
        } else {
            lines.push(Line::from(Span::styled(
                row,
                Style::default().fg(Color::White),
            )));
        }
    }

    frame.render_widget(Paragraph::new(Text::from(lines)), area);
}

// ── Test harness ────────────────────────────────────────────────────────────

#[cfg(test)]
mod scenario_tests {
    use super::*;
    use crate::app::{App, ConnectionStatus, ConversationEntry, InputMode};
    use crate::connection::ConnCommand;
    use crate::input;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use shore_protocol::client_msg::ClientMessage;
    use shore_protocol::server_msg::{CommandOutput, ServerMessage};
    use shore_protocol::types::{CharacterInfo, StreamMetadata, TimingInfo, TokenCounts};

    const W: u16 = 80;
    const H: u16 = 30;

    // ── Harness ─────────────────────────────────────────────────────────────

    struct Harness {
        terminal: Terminal<TestBackend>,
        app: App,
        frames: Vec<String>,
    }

    impl Harness {
        fn new() -> Self {
            Self::with_size(W, H)
        }

        fn with_size(w: u16, h: u16) -> Self {
            let backend = TestBackend::new(w, h);
            let terminal = Terminal::new(backend).unwrap();
            Self {
                terminal,
                app: App::default(),
                frames: Vec::new(),
            }
        }

        /// Render current app state and return the frame as text.
        fn render(&mut self, label: &str) -> String {
            self.terminal
                .draw(|frame| draw(frame, &mut self.app))
                .unwrap();
            let buf = self.terminal.backend().buffer();
            let area = buf.area;
            let mut text = String::new();
            for y in 0..area.height {
                for x in 0..area.width {
                    let cell = &buf[(x, y)];
                    text.push_str(cell.symbol());
                }
                // trim trailing whitespace per line for readability
                let trimmed_len = text.trim_end().len();
                text.truncate(trimmed_len);
                text.push('\n');
            }
            self.frames.push(text.clone());
            eprintln!("═══ {label} ═══\n{text}");
            text
        }

        /// Render current app state and preserve empty rows in the frame text.
        fn render_with_blank_rows(&mut self, label: &str) -> String {
            self.terminal
                .draw(|frame| draw(frame, &mut self.app))
                .unwrap();
            let buf = self.terminal.backend().buffer();
            let area = buf.area;
            let mut text = String::new();
            for y in 0..area.height {
                let mut row = String::new();
                for x in 0..area.width {
                    let cell = &buf[(x, y)];
                    row.push_str(cell.symbol());
                }
                text.push_str(row.trim_end());
                text.push('\n');
            }
            self.frames.push(text.clone());
            eprintln!("═══ {label} ═══\n{text}");
            text
        }

        /// Press a key with no modifiers.
        fn press(&mut self, code: KeyCode) {
            let _ = self.press_action(code);
        }

        fn press_action(&mut self, code: KeyCode) -> input::Action {
            self.press_mod_action(KeyModifiers::NONE, code)
        }

        /// Press a key with modifiers.
        fn press_mod(&mut self, mods: KeyModifiers, code: KeyCode) {
            let _ = self.press_mod_action(mods, code);
        }

        fn press_mod_action(&mut self, mods: KeyModifiers, code: KeyCode) -> input::Action {
            let ev = Event::Key(KeyEvent {
                code,
                modifiers: mods,
                kind: KeyEventKind::Press,
                state: KeyEventState::NONE,
            });
            input::handle_event(&mut self.app, ev)
        }

        /// Type a string (handles shift for uppercase automatically).
        fn type_str(&mut self, s: &str) {
            for c in s.chars() {
                let mods = if c.is_ascii_uppercase() {
                    KeyModifiers::SHIFT
                } else {
                    KeyModifiers::NONE
                };
                self.press_mod(mods, KeyCode::Char(c));
            }
        }

        /// Simulate StreamStart.
        fn stream_start(&mut self) {
            self.app.stream.reset();
            self.app.stream.active = true;
        }

        /// Simulate a text StreamChunk.
        fn stream_chunk(&mut self, text: &str) {
            match self.app.stream.blocks.last_mut() {
                Some(StreamBlock::Text(ref mut s)) => s.push_str(text),
                _ => self
                    .app
                    .stream
                    .blocks
                    .push(StreamBlock::Text(text.to_string())),
            }
            self.app.stream.phase = "responding".into();
            if self.app.auto_scroll {
                self.app.scroll_to_bottom();
            }
        }

        /// Simulate a thinking StreamChunk.
        fn thinking_chunk(&mut self, text: &str) {
            match self.app.stream.blocks.last_mut() {
                Some(StreamBlock::Thinking(ref mut s)) => s.push_str(text),
                _ => self
                    .app
                    .stream
                    .blocks
                    .push(StreamBlock::Thinking(text.to_string())),
            }
            self.app.stream.phase = "thinking".into();
        }

        /// Simulate StreamEnd (finalise response into entries).
        fn stream_end(&mut self, content: &str) {
            self.app.entries.push(ConversationEntry::Assistant {
                msg_id: None,
                content: content.to_string(),
                images: vec![],
                timestamp: String::new(),
                metadata: None,
            });
            self.app.stream.reset();
        }

        /// Lines changed between the last two frames.
        fn changed_lines(&self) -> Vec<(usize, String, String)> {
            if self.frames.len() < 2 {
                return vec![];
            }
            let prev: Vec<&str> = self.frames[self.frames.len() - 2].lines().collect();
            let curr: Vec<&str> = self.frames[self.frames.len() - 1].lines().collect();
            prev.iter()
                .zip(curr.iter())
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .map(|(i, (a, b))| (i, a.to_string(), b.to_string()))
                .collect()
        }

        /// Get a horizontal slice of the last rendered frame (row range).
        fn rows(&self, from: usize, to: usize) -> String {
            self.frames
                .last()
                .unwrap()
                .lines()
                .skip(from)
                .take(to - from)
                .collect::<Vec<_>>()
                .join("\n")
        }
    }

    fn sampler_settings_output() -> ServerMessage {
        ServerMessage::CommandOutput(CommandOutput {
            rid: None,
            name: "model_settings".into(),
            data: serde_json::json!({
                "model": "test/provider-model",
                "provider": "test",
                "model_id": "provider-model",
                "effective_sampler": {
                    "temperature": 0.7,
                    "top_p": 0.95,
                    "reasoning_effort": "medium",
                    "thinking_enabled": true,
                    "budget_tokens": 2048,
                    "max_tokens": 4096,
                    "cache_ttl": "1h"
                },
                "scopes": {
                    "temperature": "character_model",
                    "top_p": "static_default",
                    "reasoning_effort": "static_default",
                    "thinking_enabled": "static_default",
                    "budget_tokens": "static_default",
                    "max_tokens": "static_default",
                    "cache_ttl": "static_default"
                }
            }),
        })
    }

    fn sent_command(action: input::Action) -> shore_protocol::client_msg::Command {
        match action {
            input::Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => cmd,
            _ => panic!("expected command send"),
        }
    }

    fn open_setting_menu_with_snapshot(h: &mut Harness) {
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("setting");
        let cmd = sent_command(h.press_action(KeyCode::Enter));
        assert_eq!(cmd.name, "model_settings");
        crate::handle_server_message(&mut h.app, sampler_settings_output());
    }

    fn assert_set_model_setting(action: input::Action, key: &str, value: serde_json::Value) {
        let cmd = sent_command(action);
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args["key"], key);
        assert_eq!(cmd.args["value"], value);
        assert_eq!(cmd.args["scope"], "character");
    }

    fn metadata(model: &str) -> StreamMetadata {
        StreamMetadata {
            model: model.into(),
            tokens: TokenCounts {
                input: 11,
                output: 22,
                cache_read: 33,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 44,
                ttft_ms: 5,
            },
        }
    }

    // ── Scenario: empty state ───────────────────────────────────────────────

    #[test]
    fn scenario_empty_state() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.model = "gpt-4".into();
        h.app.character_name = "Alice".into();

        let f = h.render("empty state: connected, no messages");

        // Input area shows INSERT mode
        assert!(f.contains("[INSERT]"), "default mode is INSERT");
        assert!(
            !f.contains("model:"),
            "active model should stay out of the input border"
        );
    }

    // ── Scenario: type, send, stream, complete ──────────────────────────────

    #[test]
    fn scenario_full_message_cycle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Narrator".into();
        h.app.model = "claude-3".into();

        // 1. Initial
        h.render("initial");

        // 2. Type a message
        h.type_str("Hello, world!");
        let f = h.render("after typing");
        assert!(f.contains("Hello, world!"), "typed text visible in input");

        // 3. Send (Enter)
        h.press(KeyCode::Enter);
        // Manually add the user entry (normally the daemon echoes it back)
        h.app.entries.push(ConversationEntry::User {
            content: "Hello, world!".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        let f = h.render("after send");
        // Input should be cleared
        assert!(
            !h.rows(H as usize - 4, H as usize - 1)
                .contains("Hello, world!"),
            "input area should be cleared after send"
        );
        // User message should appear in conversation
        assert!(f.contains("You"), "user label visible");
        assert!(f.contains("Hello, world!"), "user message in conversation");

        // 4. Stream starts
        h.stream_start();
        h.render("stream started");

        // 5. First chunk
        h.stream_chunk("Hi there");
        let f = h.render("first chunk");
        assert!(f.contains("Hi there"), "streamed text visible");
        assert!(f.contains("Narrator"), "assistant name visible");

        // 6. More chunks
        h.stream_chunk(", how are you today?");
        let f = h.render("more chunks");
        assert!(
            f.contains("Hi there, how are you today?"),
            "accumulated text visible"
        );

        // Check layout stability: only conversation content should change,
        // not the input area or status bar structure
        let diffs = h.changed_lines();
        eprintln!("Lines changed from chunk 1→2: {}", diffs.len());
        for (i, prev, curr) in &diffs {
            eprintln!("  L{i}: {prev:?} → {curr:?}");
        }

        // 7. Stream ends
        h.stream_end("Hi there, how are you today?");
        let f = h.render("stream ended");
        assert!(
            !f.contains("[streaming...]"),
            "streaming indicator gone after end"
        );
        assert!(
            f.contains("Hi there, how are you today?"),
            "final response visible"
        );
    }

    #[test]
    fn scenario_history_marks_archived_boundary() {
        use shore_protocol::server_msg::History;
        use shore_protocol::types::{ContentBlock, Message, Role};

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Sable".into();

        let history_msgs = vec![
            Message {
                msg_id: "m_old".into(),
                role: Role::User,
                content: "old context".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "old context".into(),
                }],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "t1".into(),
            },
            Message {
                msg_id: "m_new".into(),
                role: Role::Assistant,
                content: "active reply".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "active reply".into(),
                }],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "t2".into(),
            },
        ];

        crate::handle_server_message(
            &mut h.app,
            ServerMessage::History(History {
                rid: None,
                messages: history_msgs,
                active_start: 1,
                config: serde_json::json!({}),
                selected_character: None,
                revision: 1,
            }),
        );

        let f = h.render("archived boundary");
        assert!(f.contains("old context"));
        assert!(f.contains("active reply"));
        assert!(f.contains("archived"));
        assert!(f.contains("outside current context"));
    }

    // ── Scenario: inline thinking toggle ────────────────────────────────────

    #[test]
    fn scenario_thinking_toggle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Start a stream with thinking then text
        h.app.entries.push(ConversationEntry::User {
            content: "Think about this".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        h.stream_start();
        h.thinking_chunk("Let me consider...\nFirst, I need to...\nThen...");
        h.stream_chunk("Here's my answer");

        // Render with thinking visible (show_thinking defaults to true)
        let f1 = h.render("thinking visible inline");
        assert!(f1.contains("thinking"), "inline thinking header visible");
        assert!(f1.contains("Here's my answer"), "streaming text visible");

        // Toggle thinking off via show_thinking (t key in normal mode)
        h.app.show_thinking = false;
        let f2 = h.render("thinking hidden");
        assert!(
            !f2.contains("Let me consider"),
            "thinking content hidden after toggle"
        );
        assert!(
            f2.contains("Here's my answer"),
            "streaming text still visible after toggle"
        );

        // Toggle back
        h.app.show_thinking = true;
        let f3 = h.render("thinking re-enabled");
        assert!(
            f3.contains("thinking"),
            "inline thinking back after re-toggle"
        );
    }

    #[test]
    fn scenario_timestamp_toggle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.entries.push(ConversationEntry::User {
            content: "time check".into(),
            images: vec![],
            timestamp: "2026-01-15T10:30:00Z".into(),
        });

        let hidden = h.render("timestamps hidden by default");
        assert!(
            !hidden.contains("2026-01-15"),
            "timestamps should start hidden; frame:\n{hidden}"
        );

        h.app.show_timestamps = true;
        let visible = h.render("timestamps visible");
        assert!(
            visible.contains("2026-01-15"),
            "timestamp date should render when enabled; frame:\n{visible}"
        );
    }

    #[test]
    fn scenario_metadata_toggle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: Some("m1".into()),
            content: "hello".into(),
            images: vec![],
            timestamp: "2026-01-15T10:30:00Z".into(),
            metadata: Some(metadata("test-model")),
        });

        let visible = h.render("metadata visible by default");
        assert!(
            visible.contains("test-model"),
            "metadata should start visible; frame:\n{visible}"
        );

        h.app.show_metadata = false;
        let hidden = h.render("metadata hidden");
        assert!(
            !hidden.contains("test-model"),
            "metadata should hide when disabled; frame:\n{hidden}"
        );
    }

    // ── Scenario: command palette ───────────────────────────────────────────

    #[test]
    fn scenario_command_palette() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.render("normal mode");

        // Open command palette with ':'
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        let f = h.render("command palette open");
        assert!(f.contains("COMMAND"), "command mode title visible");

        // Type a partial command
        h.type_str("mod");
        let f = h.render("typing 'mod'");
        assert!(f.contains(":mod"), "command text visible");
        // Should show completion for 'model'
        assert!(f.contains("model"), "model completion visible");

        // The input row should sit *above* the candidate row — i.e.
        // [COMMAND] line index < line containing the "model" candidate.
        let cmd_line = f
            .lines()
            .position(|l| l.contains("[COMMAND]"))
            .expect("command line present");
        let cand_line = f
            .lines()
            .enumerate()
            .skip(cmd_line + 1)
            .find(|(_, l)| l.contains("model"))
            .map(|(i, _)| i)
            .expect("model candidate present below input");
        assert!(
            cand_line > cmd_line,
            "completion list renders below input row"
        );

        // Tab completes a submenu parent by entering the picker directly.
        h.press(KeyCode::Tab);
        let f = h.render("after tab completion");
        assert!(f.contains("[model]"), "model submenu opened");

        // Escape first pops back to the top-level command palette.
        h.press(KeyCode::Esc);
        let f = h.render("after escape");
        assert!(
            f.contains("[COMMAND]"),
            "top-level command palette restored"
        );
        assert!(f.contains(":model"), "parent command restored");

        // Escape again cancels command mode.
        h.press(KeyCode::Esc);
        let f = h.render("after second escape");
        assert!(
            !f.contains("COMMAND"),
            "command palette hidden after escape"
        );
    }

    /// When the menu closes, the input area must return to the bottom of
    /// the terminal (collapse back to the 2-chunk layout).
    #[test]
    fn scenario_command_palette_input_returns_to_bottom() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        // Fill conversation so blank rows aren't trimmed by the harness —
        // we need stable row indices to compare layout positions.
        for i in 0..20 {
            h.app.entries.push(ConversationEntry::User {
                content: format!("hello {i}"),
                images: vec![],
                timestamp: format!("t{i}"),
            });
        }

        // Read the underlying backend buffer directly so empty rows
        // remain enumerable. We look for the row containing the input
        // border title on the right side.
        fn input_row(h: &mut Harness, label: &str) -> u16 {
            h.terminal.draw(|frame| draw(frame, &mut h.app)).unwrap();
            let buf = h.terminal.backend().buffer();
            let area = buf.area;
            for y in 0..area.height {
                let mut row = String::new();
                for x in 0..area.width {
                    row.push_str(buf[(x, y)].symbol());
                }
                if row.contains("[COMMAND]") || row.contains("[INSERT]") || row.contains("[NORMAL]")
                {
                    eprintln!("{label}: input border at row {y}: {row}");
                    return y;
                }
            }
            panic!("{label}: no input border row found");
        }

        let baseline = input_row(&mut h, "baseline normal mode");

        // Open command mode and type to populate candidates.
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("mod");
        let raised = input_row(&mut h, "command mode with candidates");
        assert!(
            raised < baseline,
            "input row should be raised when completions visible \
             (raised={raised}, baseline={baseline})"
        );

        // Close with Esc — input should snap back to baseline row.
        h.press(KeyCode::Esc);
        let restored = input_row(&mut h, "after esc");
        assert_eq!(
            restored, baseline,
            "input row should return to the bottom after menu closes"
        );
    }

    /// Ctrl+J / Ctrl+K (and Down / Up) cycle the candidate selection
    /// forward and backward.
    #[test]
    fn scenario_command_palette_navigation_keys() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.render("palette open");
        let total = h.app.completion.candidates.len();
        assert!(total >= 3, "need >=3 candidates for cycle test");

        // Ctrl+J advances forward (None → 0).
        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('j'));
        assert_eq!(h.app.completion.selected, Some(0));

        // Ctrl+J again → 1.
        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('j'));
        assert_eq!(h.app.completion.selected, Some(1));

        // Ctrl+K reverses → 0.
        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('k'));
        assert_eq!(h.app.completion.selected, Some(0));

        // Ctrl+K from 0 wraps to the last candidate.
        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('k'));
        assert_eq!(h.app.completion.selected, Some(total - 1));

        // Down acts like Ctrl+J (wraps back to 0 from last).
        h.press(KeyCode::Down);
        assert_eq!(h.app.completion.selected, Some(0));

        // Up acts like Ctrl+K.
        h.press(KeyCode::Up);
        assert_eq!(h.app.completion.selected, Some(total - 1));
    }

    /// Each top-level command renders alongside its description; the
    /// argument candidates (e.g. `model` submenu) do NOT pick up a
    /// description because they aren't top-level command names.
    #[test]
    fn scenario_command_palette_descriptions() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        // Open palette — every top-level command appears with its desc.
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        let f = h.render("palette open");

        // Spot-check several commands have both name and description on
        // the same row of the framebuffer.
        for (cmd, desc) in [
            ("compact", "Summarize and shrink the conversation"),
            ("regen", "Regenerate the last assistant reply"),
            ("quit", "Exit the TUI"),
            ("help", "Show keyboard shortcuts"),
        ] {
            let row = f
                .lines()
                .find(|l| l.contains(cmd) && l.contains(desc))
                .unwrap_or_else(|| {
                    panic!("expected row with `{cmd}` + `{desc}`; full frame:\n{f}")
                });
            // Description should appear after the command name on the row.
            let cmd_pos = row.find(cmd).unwrap();
            let desc_pos = row.find(desc).unwrap();
            assert!(
                desc_pos > cmd_pos,
                "description should follow command name on row: {row}"
            );
        }

        // Now switch into the model submenu — argument candidates should
        // NOT carry a description (e.g. nothing like "Switch the active
        // model" appearing next to the candidate text).
        h.app.model_names = vec!["alpha-1".into(), "beta-2".into()];
        h.press_mod(KeyModifiers::NONE, KeyCode::Backspace); // close
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model ");
        let f = h.render("model submenu");
        assert!(
            f.contains("alpha-1") || f.contains("model alpha-1"),
            "model candidate visible"
        );
        assert!(
            !f.contains("Switch the active model"),
            "argument candidates should not carry parent-command desc"
        );
    }

    /// Pressing Enter on `:model` opens the model submenu picker:
    /// title becomes `[model]`, candidates are bare model names with
    /// no `model ` prefix, and cmd_text is empty (filter starts fresh).
    #[test]
    fn scenario_command_palette_submenu_enter() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = vec!["alpha-1".into(), "beta-2".into()];

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        h.press(KeyCode::Enter);
        let f = h.render("model submenu open");

        assert!(
            matches!(h.app.completion.mode, crate::app::PaletteMode::Submenu(_)),
            "completion mode should be Submenu after Enter"
        );
        assert!(
            f.contains("[model]"),
            "input title should show [model] breadcrumb; frame:\n{f}"
        );
        // Candidates are bare names — no "model " prefix.
        assert!(
            h.app.completion.candidates.iter().any(|c| c == "alpha-1"),
            "submenu candidates contain bare model name"
        );
        assert!(
            !h.app
                .completion
                .candidates
                .iter()
                .any(|c| c.starts_with("model ")),
            "submenu candidates should not carry the parent prefix"
        );
        assert!(
            h.app.input.cmd_text.is_empty(),
            "filter starts empty; current cmd_text = {:?}",
            h.app.input.cmd_text
        );
    }

    #[test]
    fn scenario_view_submenu_toggles_local_preferences() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("view");
        h.press(KeyCode::Enter);
        let f = h.render("view submenu open");

        match &h.app.completion.mode {
            crate::app::PaletteMode::Submenu(s) => assert_eq!(s.parent, "view"),
            _ => panic!("expected view submenu"),
        }
        assert!(f.contains("[view]"), "view submenu title visible");
        assert!(
            f.contains("timestamps = off"),
            "timestamp row should show current state; frame:\n{f}"
        );

        h.press(KeyCode::Enter);
        assert!(h.app.show_timestamps, "Enter toggles selected view option");
        assert_eq!(h.app.input.mode, InputMode::Command);
        assert!(
            h.app
                .completion
                .candidates
                .iter()
                .any(|c| c == "timestamps = on"),
            "view submenu should refresh in place"
        );
    }

    #[test]
    fn scenario_command_palette_submenu_active_markers() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.enter_command_mode();
        h.app.model_names = vec!["alpha".into(), "beta".into()];
        h.app.set_active_model(Some("chat.anthropic.beta"));

        h.app.enter_submenu("model");
        let f = h.render("active model marker");
        assert!(
            f.lines()
                .any(|l| l.contains("beta") && l.contains("active")),
            "active model row should be marked like the active character; frame:\n{f}"
        );

        h.app.characters = vec![CharacterInfo::new("Alice"), CharacterInfo::new("Bob")];
        h.app.character_name = "Alice".into();
        h.app.enter_submenu("character");
        let f = h.render("active character marker");
        assert!(
            f.lines()
                .any(|l| l.contains("Alice") && l.contains("active")),
            "active character row should still be marked; frame:\n{f}"
        );
    }

    #[test]
    fn scenario_command_palette_submenu_scrolls_selected_item_into_view() {
        let mut h = Harness::with_size(60, 20);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = (0..20).map(|i| format!("model-{i:02}")).collect();

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        h.press(KeyCode::Enter);

        for _ in 0..18 {
            h.press(KeyCode::Down);
        }
        assert_eq!(h.app.completion.selected, Some(17));

        let f = h.render("submenu scrolled to selected model");
        assert!(
            f.contains("model-17"),
            "selected item should be visible after scrolling; frame:\n{f}"
        );
        assert!(
            !f.contains("model-00"),
            "top rows should scroll out once selection moves below the viewport; frame:\n{f}"
        );
    }

    #[test]
    fn scenario_model_submenu_opens_on_active_model_even_when_offscreen() {
        let mut h = Harness::with_size(60, 20);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = (0..20).map(|i| format!("model-{i:02}")).collect();
        h.app.set_active_model(Some("chat.provider.model-17"));

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        h.press(KeyCode::Enter);

        assert_eq!(h.app.completion.selected, Some(17));
        let f = h.render("submenu opened on active model");
        assert!(
            f.lines()
                .any(|l| l.contains("model-17") && l.contains("active")),
            "active model should be selected and visible immediately; frame:\n{f}"
        );
        assert!(
            !f.contains("model-00"),
            "picker should scroll away from the top to show the active model; frame:\n{f}"
        );
    }

    /// Space on a parent name also opens the submenu (does not insert
    /// a literal space into cmd_text).
    #[test]
    fn scenario_command_palette_submenu_space_trigger() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = vec!["foo".into()];

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        h.press_mod(KeyModifiers::NONE, KeyCode::Char(' '));
        h.render("after space");

        assert!(
            matches!(h.app.completion.mode, crate::app::PaletteMode::Submenu(_)),
            "Space on `:model` should open submenu, not insert a space"
        );
        assert!(
            h.app.input.cmd_text.is_empty(),
            "Space should not have been inserted into cmd_text"
        );
    }

    /// Inside a submenu, typing filters candidates; Esc pops back to
    /// Top with cmd_text restored to the parent command name.
    #[test]
    fn scenario_command_palette_submenu_filter_and_esc() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = vec!["alpha-1".into(), "beta-2".into(), "alpha-2".into()];

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        h.press(KeyCode::Enter);
        h.render("submenu opened");

        // Filter to "alpha".
        h.type_str("alpha");
        h.render("filtered");

        let names: Vec<&str> = h
            .app
            .completion
            .candidates
            .iter()
            .map(|s| s.as_str())
            .collect();
        assert!(
            names.iter().all(|n| n.starts_with("alpha") || *n == "reset"),
            "filter should keep only alpha-prefixed model names (+synthetic reset if matching); got {names:?}"
        );
        assert!(
            names.contains(&"alpha-1") && names.contains(&"alpha-2"),
            "both alpha-* models survive the filter"
        );

        // Esc → pop back to Top, cmd_text restored to "model".
        h.press(KeyCode::Esc);
        h.render("after esc");
        assert!(
            matches!(h.app.completion.mode, crate::app::PaletteMode::Top),
            "Esc should pop submenu back to Top"
        );
        assert_eq!(
            h.app.input.cmd_text, "model",
            "parent cmd_text should be restored after Esc"
        );
    }

    /// `apply_submenu` returns the full command string for a selected
    /// candidate and resets palette state.
    #[test]
    fn submenu_apply_returns_full_command() {
        let mut app = App {
            model_names: vec!["gpt-4o".into(), "claude-sonnet-4-6".into()],
            ..App::default()
        };

        app.input.enter_command_mode();
        app.input.cmd_text = "model".into();
        app.input.cmd_cursor = 5;

        app.enter_submenu("model");
        // Pre: candidates rebuilt to bare model names + reset.
        assert!(app.completion.candidates.contains(&"gpt-4o".to_string()));
        // Cycle to first candidate.
        app.next_completion();
        let chosen = app.completion.candidates[app.completion.selected.unwrap()].clone();

        let cmd = app.apply_submenu().expect("apply_submenu yields a command");
        assert_eq!(cmd, format!("model {chosen}"));
        assert!(app.completion.candidates.is_empty());
        assert!(matches!(app.completion.mode, crate::app::PaletteMode::Top));
        assert_ne!(app.input.mode, InputMode::Command, "command mode exited");
    }

    /// Argument-completion contexts render a dim header above the
    /// candidate list so the user knows what they're picking.
    #[test]
    fn scenario_command_palette_submenu_header() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        // Type `:setting ` (with trailing space) → header "setting key".
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("setting ");
        let f = h.render("setting submenu");

        assert!(
            f.contains("setting key"),
            "submenu header 'setting key' visible above candidates"
        );
        // The request has not returned yet, so the picker stays disabled.
        assert!(
            f.contains("loading sampler settings..."),
            "loading row visible until settings arrive"
        );
    }

    #[test]
    fn setting_enter_opens_submenu_and_model_settings_refreshes_rows() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        let f = h.render("setting submenu with values");

        assert!(matches!(
            h.app.completion.mode,
            crate::app::PaletteMode::Submenu(_)
        ));
        assert!(f.contains("setting key"), "setting header visible");
        assert!(
            f.contains("temperature = 0.7"),
            "effective temperature should render next to its key; frame:\n{f}"
        );
    }

    #[test]
    fn setting_reasoning_effort_opens_value_submenu_preselected() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("reasoning");
        h.press(KeyCode::Enter);

        match &h.app.completion.mode {
            crate::app::PaletteMode::Submenu(s) => {
                assert_eq!(s.parent, "setting:reasoning_effort");
            }
            _ => panic!("expected reasoning_effort submenu"),
        }
        let selected = h.app.completion.selected.expect("current value selected");
        assert_eq!(h.app.completion.candidates[selected], "medium");
    }

    #[test]
    fn setting_temperature_opens_slider_at_effective_value() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("temperature");
        h.press(KeyCode::Enter);
        let f = h.render("temperature slider");

        assert!(matches!(
            h.app.completion.mode,
            crate::app::PaletteMode::ValueEditor(_)
        ));
        assert!(f.contains("temperature"));
        assert!(f.contains("●"), "slider thumb should render; frame:\n{f}");
        assert!(
            f.contains("0.7"),
            "effective value should render; frame:\n{f}"
        );
    }

    #[test]
    fn setting_temperature_slider_right_increments() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("temperature");
        h.press(KeyCode::Enter);
        h.press(KeyCode::Right);
        let f = h.render("temperature slider incremented");

        assert!(
            f.contains("0.8"),
            "Right should increment by 0.1; frame:\n{f}"
        );
    }

    #[test]
    fn setting_temperature_typed_value_dispatches_command() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("temperature");
        h.press(KeyCode::Enter);
        h.type_str("1.25");
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "temperature", serde_json::json!(1.25));
    }

    #[test]
    fn setting_temperature_waits_for_snapshot_before_slider_apply() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("setting");
        let cmd = sent_command(h.press_action(KeyCode::Enter));
        assert_eq!(cmd.name, "model_settings");

        h.type_str("temperature");
        let blocked = h.press_action(KeyCode::Enter);
        assert!(
            matches!(blocked, input::Action::Redraw),
            "Enter should not dispatch before sampler settings load"
        );
        match &h.app.completion.mode {
            crate::app::PaletteMode::Submenu(s) => assert_eq!(s.parent, "setting"),
            _ => panic!("expected to stay in setting submenu while loading"),
        }

        crate::handle_server_message(&mut h.app, sampler_settings_output());
        h.press(KeyCode::Enter);
        assert!(matches!(
            h.app.completion.mode,
            crate::app::PaletteMode::ValueEditor(_)
        ));
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "temperature", serde_json::json!(0.7));
    }

    #[test]
    fn setting_reasoning_effort_waits_for_snapshot_before_submenu() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("setting");
        let cmd = sent_command(h.press_action(KeyCode::Enter));
        assert_eq!(cmd.name, "model_settings");

        h.type_str("reasoning");
        let blocked = h.press_action(KeyCode::Enter);
        assert!(matches!(blocked, input::Action::Redraw));
        match &h.app.completion.mode {
            crate::app::PaletteMode::Submenu(s) => assert_eq!(s.parent, "setting"),
            _ => panic!("expected to stay in setting submenu while loading"),
        }

        crate::handle_server_message(&mut h.app, sampler_settings_output());
        h.press(KeyCode::Enter);
        match &h.app.completion.mode {
            crate::app::PaletteMode::Submenu(s) => {
                assert_eq!(s.parent, "setting:reasoning_effort");
            }
            _ => panic!("expected reasoning_effort submenu after settings load"),
        }
        let selected = h.app.completion.selected.expect("current value selected");
        assert_eq!(h.app.completion.candidates[selected], "medium");
    }

    #[test]
    fn setting_cache_ttl_custom_value_dispatches_command() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("cache");
        h.press(KeyCode::Enter);
        h.type_str("15m");
        assert!(
            h.app
                .completion
                .candidates
                .iter()
                .any(|candidate| candidate == "Custom: 15m"),
            "custom cache TTL row should appear"
        );
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "cache_ttl", serde_json::json!("15m"));
    }

    #[test]
    fn setting_cache_ttl_picker_does_not_offer_off() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("cache");
        h.press(KeyCode::Enter);

        assert!(
            !h.app
                .completion
                .candidates
                .iter()
                .any(|candidate| candidate == "off"),
            "cache_ttl picker should use reset to clear overrides, not an off TTL"
        );

        h.type_str("off");
        assert!(
            !h.app
                .completion
                .candidates
                .iter()
                .any(|candidate| candidate == "Custom: off"),
            "cache_ttl picker should not offer off as a custom TTL"
        );
    }

    #[test]
    fn setting_reset_picker_dispatches_reset_command() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("reset");
        h.press(KeyCode::Enter);
        match &h.app.completion.mode {
            crate::app::PaletteMode::Submenu(s) => assert_eq!(s.parent, "setting:reset"),
            _ => panic!("expected setting reset submenu"),
        }
        h.type_str("temperature");
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "temperature", serde_json::Value::Null);
    }

    // ── Scenario: scroll during stream ──────────────────────────────────────

    #[test]
    fn scenario_scroll_during_stream() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Fill with enough messages to require scrolling
        for i in 0..20 {
            h.app.entries.push(ConversationEntry::User {
                content: format!("Message {i}"),
                images: vec![],
                timestamp: format!("t{i}"),
            });
            h.app.entries.push(ConversationEntry::Assistant {
                msg_id: None,
                content: format!("Reply {i}"),
                images: vec![],
                timestamp: format!("r{i}"),
                metadata: None,
            });
        }

        h.render("many messages - auto scroll");

        // Start streaming
        h.stream_start();
        h.stream_chunk("New streaming response...");
        let f = h.render("streaming with auto_scroll");
        assert!(
            f.contains("New streaming response"),
            "latest content visible with auto_scroll"
        );

        // Scroll up (exit auto_scroll)
        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('u'));
        h.render("scrolled up");
        assert!(!h.app.auto_scroll, "auto_scroll disabled after scroll up");

        // New chunk arrives while scrolled up
        h.stream_chunk(" More text arrives.");
        let _f = h.render("chunk while scrolled up");
        // The viewport should NOT jump — the user scrolled away intentionally
        // (The content is still being buffered, just not forced into view)

        // Shift+G to go back to bottom
        h.app.input.mode = InputMode::Normal;
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char('G'));
        let f = h.render("back to bottom");
        assert!(h.app.auto_scroll, "auto_scroll re-enabled");
        assert!(
            f.contains("More text arrives"),
            "latest content visible after re-scroll"
        );
    }

    // ── Scenario: mode switching ────────────────────────────────────────────

    #[test]
    fn scenario_mode_switching() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Default is Insert
        let f = h.render("insert mode");
        assert!(f.contains("[INSERT]"), "starts in INSERT mode");

        // Esc → Normal
        h.press(KeyCode::Esc);
        let f = h.render("normal mode");
        assert!(f.contains("[NORMAL]"), "shows NORMAL after Esc");
        assert!(!f.contains("[INSERT]"), "INSERT label gone");

        // i → back to Insert
        h.press(KeyCode::Char('i'));
        let f = h.render("back to insert");
        assert!(f.contains("[INSERT]"), "shows INSERT after 'i'");

        // The only changes should be the mode label and placeholder.
        let diffs = h.changed_lines();
        assert!(
            diffs
                .iter()
                .all(|(_, _, curr)| curr.contains("INSERT") || curr.contains("Type a message")),
            "mode switch should only change the input area"
        );
    }

    // ── Scenario: connection status changes ─────────────────────────────────

    #[test]
    fn scenario_connection_states() {
        // Connection status indicators were in the removed status bar.
        // Just verify the layout renders without panic across all states.
        let mut h = Harness::new();

        h.app.connection_status = ConnectionStatus::Disconnected;
        h.render("disconnected");

        h.app.connection_status = ConnectionStatus::Connecting;
        h.render("connecting");

        h.app.connection_status = ConnectionStatus::Connected;
        h.render("connected");
    }

    // ── Scenario: long message wrapping ─────────────────────────────────────

    #[test]
    fn scenario_long_message_wrapping() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Add a message longer than terminal width
        let long_msg = "This is a very long message that should wrap properly across multiple lines in the conversation area without clipping or causing layout issues.";
        h.app.entries.push(ConversationEntry::User {
            content: long_msg.into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        let f = h.render("long message");
        // The message should be present (may be split across lines)
        assert!(
            f.contains("This is a very long message"),
            "start of message visible"
        );

        // Type a long input — word wrap should keep words intact
        h.type_str("Another really long input message that should cause the input area to grow taller as the text wraps to accommodate");
        let f = h.render("long input");
        // "taller" must NOT be split across lines (word-level wrap)
        assert!(
            f.lines().any(|l| l.contains("taller")),
            "word 'taller' should stay intact on one visual line"
        );
    }

    // ── Scenario: tool call display ─────────────────────────────────────────

    #[test]
    fn scenario_tool_calls() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::User {
            content: "Search for foo".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        h.app.entries.push(ConversationEntry::ToolCall {
            tool_id: "tc1".into(),
            tool_name: "web_search".into(),
            input: serde_json::json!({"query": "foo bar baz"}),
        });

        h.app.entries.push(ConversationEntry::ToolResult {
            tool_id: "tc1".into(),
            tool_name: "web_search".into(),
            output: "Found 3 results for foo bar baz".into(),
            is_error: false,
        });

        let f = h.render("tool call + result");
        assert!(f.contains("▶"), "tool call arrow present");
        assert!(f.contains("web_search"), "tool name present");
        assert!(f.contains("◀"), "tool result arrow present");
    }

    // ── Scenario: tool calls render under assistant name ─────────────────────

    #[test]
    fn scenario_tool_calls_under_assistant_name() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();

        h.app.entries.push(ConversationEntry::User {
            content: "Search for foo".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        // Tool entries come before the Assistant entry (as expand_msg produces them)
        h.app.entries.push(ConversationEntry::ToolCall {
            tool_id: "tc1".into(),
            tool_name: "web_search".into(),
            input: serde_json::json!({"query": "foo"}),
        });
        h.app.entries.push(ConversationEntry::ToolResult {
            tool_id: "tc1".into(),
            tool_name: "web_search".into(),
            output: "Result: foo page".into(),
            is_error: false,
        });
        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "I found foo.".into(),
            images: vec![],
            timestamp: "t2".into(),
            metadata: None,
        });

        let f = h.render("tools under assistant name");

        // Find line positions
        let lines: Vec<&str> = f.lines().collect();
        let alice_line = lines
            .iter()
            .position(|l| l.contains("Alice"))
            .expect("Alice name must appear");
        let tool_line = lines
            .iter()
            .position(|l| l.contains("▶"))
            .expect("tool call arrow must appear");
        let result_line = lines
            .iter()
            .position(|l| l.contains("◀"))
            .expect("tool result arrow must appear");
        let content_line = lines
            .iter()
            .position(|l| l.contains("I found foo"))
            .expect("assistant content must appear");

        assert!(
            tool_line > alice_line,
            "tool call must appear after assistant name"
        );
        assert!(
            result_line > tool_line,
            "tool result must appear after tool call"
        );
        assert!(
            content_line > result_line,
            "assistant text must appear after tool result"
        );
    }

    // ── Scenario: multi-phase tool-use stream ───────────────────────────────
    //
    // Regression for the bug where an intermediate StreamEnd(finish_reason="tool_use")
    // would push a premature empty Assistant entry with per-call metadata, producing
    // a duplicate character header and a misleading stats line mid-turn.
    //
    // Real sequence (per backend/daemon/tests/suite/pipeline.rs):
    //   StreamStart → StreamEnd(tool_use) → ToolCall → ToolResult
    //   → StreamStart → chunks → StreamEnd(end_turn)

    #[test]
    fn scenario_tool_use_multi_phase_single_header() {
        use shore_protocol::server_msg::{
            ServerMessage, StreamChunk, StreamEnd, StreamStart, ToolCall, ToolResult,
        };
        use shore_protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

        let meta_phase_1 = StreamMetadata {
            model: "anthropic/claude-haiku-4-5".into(),
            tokens: TokenCounts {
                input: 100,
                output: 20,
                cache_read: 10,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 500,
                ttft_ms: 100,
            },
        };
        let meta_phase_2 = StreamMetadata {
            model: "anthropic/claude-haiku-4-5".into(),
            tokens: TokenCounts {
                input: 200,
                output: 40,
                cache_read: 80,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 1000,
                ttft_ms: 120,
            },
        };

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();

        h.app.entries.push(ConversationEntry::User {
            content: "hi qifei.".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        // Phase 1: the model decides to call a tool; no text chunks.
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
            }),
        );
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: None,
                revision: None,
                content: String::new(),
                metadata: meta_phase_1.clone(),
                finish_reason: "tool_use".into(),
                is_final: false,
            }),
        );
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                rid: None,
                tool_id: "tc1".into(),
                tool_name: "memory_search".into(),
                input: serde_json::json!({"query": "Ren"}),
            }),
        );

        // Mid-turn frame: exactly one "qifei" header, no premature stats line.
        // Headers are flush-left; the user's "hi qifei." is indented by two spaces.
        let f_mid = h.render("mid tool-use turn");
        let mid_header_count = f_mid.lines().filter(|l| l.trim_end() == "qifei").count();
        assert_eq!(
            mid_header_count, 1,
            "exactly one 'qifei' header mid-turn; got {mid_header_count}\n{f_mid}"
        );
        assert!(
            !f_mid.contains("in:100"),
            "intermediate per-call stats must not appear mid-turn\n{f_mid}"
        );

        crate::handle_server_message(
            &mut h.app,
            ServerMessage::ToolResult(ToolResult {
                rid: None,
                tool_id: "tc1".into(),
                tool_name: "memory_search".into(),
                output: "{}".into(),
                is_error: false,
            }),
        );

        // Phase 2: model emits the real response.
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
            }),
        );
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                rid: None,
                text: "hey! what's up?".into(),
                content_type: "text".into(),
            }),
        );
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: None,
                revision: None,
                content: "hey! what's up?".into(),
                metadata: meta_phase_2.clone(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let f = h.render("after multi-phase turn");

        // Exactly one "qifei" header for the whole turn.
        let header_count = f.lines().filter(|l| l.trim_end() == "qifei").count();
        assert_eq!(
            header_count, 1,
            "exactly one 'qifei' header after turn; got {header_count}\n{f}"
        );

        // Final content present.
        assert!(
            f.contains("hey! what's up?"),
            "final response text missing\n{f}"
        );

        // Stats line: tokens summed across both phases.
        let expected_input = meta_phase_1.tokens.input + meta_phase_2.tokens.input;
        let expected_output = meta_phase_1.tokens.output + meta_phase_2.tokens.output;
        let expected_cache = meta_phase_1.tokens.cache_read + meta_phase_2.tokens.cache_read;
        let expected_total_ms = meta_phase_1.timing.total_ms + meta_phase_2.timing.total_ms;
        let stats_expected =
            format!("in:{expected_input} out:{expected_output} cache:{expected_cache}");
        assert!(
            f.contains(&stats_expected),
            "expected summed stats '{stats_expected}' in frame\n{f}"
        );
        assert!(
            f.contains(&format!("{expected_total_ms}ms")),
            "expected summed timing '{expected_total_ms}ms' in frame\n{f}"
        );

        // Stream should be idle after end_turn.
        assert!(
            !h.app.stream.active,
            "stream must be inactive after end_turn"
        );
        assert!(
            h.app.stream.accumulated_text.is_empty(),
            "accumulator must be cleared on finalise"
        );
        assert!(
            h.app.stream.accumulated_metadata.is_none(),
            "metadata accumulator must be cleared on finalise"
        );
    }

    // ── Scenario: narrow terminal ───────────────────────────────────────────

    #[test]
    fn scenario_narrow_terminal() {
        let mut h = Harness::with_size(40, 20);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.model = "claude-3-opus".into();

        h.app.entries.push(ConversationEntry::User {
            content: "Hi there!".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        let f = h.render("narrow terminal");
        // Everything should still be visible, just tighter
        assert!(f.contains("You"), "user label visible in narrow");
        assert!(f.contains("Hi there!"), "message visible in narrow");
        // Status bar might truncate but shouldn't crash
    }

    // ── Scenario: stream→end content consistency ────────────────────────────

    #[test]
    fn scenario_stream_to_final_transition() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::User {
            content: "Tell me a story".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        h.stream_start();
        h.stream_chunk("Once upon a time, there was a brave knight.");
        let f_streaming = h.render("during stream");

        // End stream with same content
        h.stream_end("Once upon a time, there was a brave knight.");
        let f_final = h.render("after stream end");

        // The conversation content should be visually identical
        // (minus the [streaming...] indicator)
        // Check that the story text is in the same position
        let story_line_streaming = f_streaming
            .lines()
            .enumerate()
            .find(|(_, l)| l.contains("Once upon a time"));
        let story_line_final = f_final
            .lines()
            .enumerate()
            .find(|(_, l)| l.contains("Once upon a time"));

        if let (Some((ls, _)), Some((lf, _))) = (story_line_streaming, story_line_final) {
            let jump = (ls as i32 - lf as i32).unsigned_abs();
            eprintln!("Story line position: streaming=L{ls}, final=L{lf}, jump={jump}");
            assert!(
                jump <= 1,
                "content should not jump more than 1 line during stream→final transition (jumped {jump})"
            );
        }
    }

    // ── Scenario: History-before-StreamEnd must not duplicate the reply ─────
    //
    // Regression for the bug where the daemon's `History` broadcast (emitted
    // by `engine.append_message` during `persist_and_notify`) arrives at the
    // TUI *before* the deferred `StreamEnd` (see `task.rs` — StreamEnd is held
    // until after persistence). The History handler rebuilds `app.entries`
    // from the persisted message, and the StreamEnd handler used to push the
    // assistant reply a second time, producing an in-memory duplicate that
    // vanished on reconnect. Fix: StreamEnd now annotates the existing
    // assistant entry with streaming metadata instead of pushing a new one.
    #[test]
    fn scenario_history_then_stream_end_no_duplicate() {
        use shore_protocol::server_msg::{
            History, ServerMessage, StreamChunk, StreamEnd, StreamStart,
        };
        use shore_protocol::types::{
            ContentBlock, Message, Role, StreamMetadata, TimingInfo, TokenCounts,
        };

        let reply = "the sea is calm tonight.";

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();
        h.app.entries.push(ConversationEntry::User {
            content: "describe the sea".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
            }),
        );
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                rid: None,
                text: reply.into(),
                content_type: "text".into(),
            }),
        );

        // Daemon persists the assistant turn, which broadcasts History BEFORE
        // the deferred StreamEnd lands at the client.
        let persisted_assistant = Message {
            msg_id: "m_1".into(),
            role: Role::Assistant,
            content: reply.into(),
            images: vec![],
            content_blocks: vec![ContentBlock::Text { text: reply.into() }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            timestamp: "t2".into(),
        };
        let history_msgs = vec![
            Message {
                msg_id: "m_0".into(),
                role: Role::User,
                content: "describe the sea".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "describe the sea".into(),
                }],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "t1".into(),
            },
            persisted_assistant,
        ];
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::History(History {
                rid: None,
                messages: history_msgs,
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: None,
                revision: 1,
            }),
        );

        let meta = StreamMetadata {
            model: "anthropic/claude-haiku-4-5".into(),
            tokens: TokenCounts {
                input: 100,
                output: 10,
                cache_read: 0,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 400,
                ttft_ms: 80,
            },
        };
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: Some("m_1".into()),
                revision: Some(1),
                content: reply.into(),
                metadata: meta.clone(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let assistant_count = h
            .app
            .entries
            .iter()
            .filter(|e| matches!(e, ConversationEntry::Assistant { .. }))
            .count();
        assert_eq!(
            assistant_count, 1,
            "History-then-StreamEnd must leave exactly one Assistant entry, got {assistant_count}: {:#?}",
            h.app.entries
        );

        // The StreamEnd metadata should be attached to the History-rendered entry.
        let attached_meta = h
            .app
            .entries
            .iter()
            .rev()
            .find_map(|e| match e {
                ConversationEntry::Assistant { metadata, .. } => Some(metadata.clone()),
                _ => None,
            })
            .flatten();
        assert!(
            attached_meta.is_some(),
            "StreamEnd metadata must be attached to the assistant entry"
        );
        let attached = attached_meta.unwrap();
        assert_eq!(attached.tokens.input, meta.tokens.input);
        assert_eq!(attached.tokens.output, meta.tokens.output);

        // And only one copy of the text is rendered on screen.
        let f = h.render("after history + stream_end");
        assert_eq!(
            f.matches(reply).count(),
            1,
            "reply text must appear exactly once on screen\n{f}"
        );
    }

    #[test]
    fn scenario_history_then_stream_end_long_reply_stays_bottom_anchored() {
        use shore_protocol::server_msg::{
            History, ServerMessage, StreamChunk, StreamEnd, StreamStart,
        };
        use shore_protocol::types::{
            ContentBlock, Message, Role, StreamMetadata, TimingInfo, TokenCounts,
        };

        let tail = "TAIL MARKER final response words";
        let mut reply_lines: Vec<String> = (0..36)
            .map(|i| format!("line {i:02}: a long streamed response keeps moving"))
            .collect();
        reply_lines.push(tail.into());
        let reply = reply_lines.join("\n");

        let mut h = Harness::with_size(64, 16);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();
        h.app.entries.push(ConversationEntry::User {
            content: "write a long answer".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
            }),
        );
        for chunk in reply.as_bytes().chunks(96) {
            crate::handle_server_message(
                &mut h.app,
                ServerMessage::StreamChunk(StreamChunk {
                    rid: None,
                    text: std::str::from_utf8(chunk).unwrap().into(),
                    content_type: "text".into(),
                }),
            );
        }

        let history_msgs = vec![
            Message {
                msg_id: "m_0".into(),
                role: Role::User,
                content: "write a long answer".into(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: "write a long answer".into(),
                }],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "t1".into(),
            },
            Message {
                msg_id: "m_1".into(),
                role: Role::Assistant,
                content: reply.clone(),
                images: vec![],
                content_blocks: vec![ContentBlock::Text {
                    text: reply.clone(),
                }],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                timestamp: "t2".into(),
            },
        ];
        crate::handle_server_message(
            &mut h.app,
            ServerMessage::History(History {
                rid: None,
                messages: history_msgs,
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: None,
                revision: 1,
            }),
        );

        crate::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: Some("m_1".into()),
                revision: Some(1),
                content: reply,
                metadata: StreamMetadata {
                    model: "anthropic/claude-haiku-4-5".into(),
                    tokens: TokenCounts {
                        input: 100,
                        output: 200,
                        cache_read: 0,
                        cache_write: 0,
                    },
                    timing: TimingInfo {
                        total_ms: 800,
                        ttft_ms: 120,
                    },
                },
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let f = h.render("long history + stream_end");
        assert!(h.app.auto_scroll, "auto_scroll remains enabled");
        assert_eq!(h.app.scroll_offset, 0, "viewport remains bottom-anchored");
        assert!(
            f.contains(tail),
            "final rendered frame should include the tail of the response\n{f}"
        );
        assert!(
            !f.contains("line 00:"),
            "long final response should be scrolled to its tail, not its head\n{f}"
        );
    }

    #[test]
    fn scenario_tool_toggle_keeps_bottom_anchored() {
        let tail = "FINAL TAIL remains visible after tool toggle";
        let long_tool_output = (0..28)
            .map(|i| {
                format!(
                    "tool row {i:02}: {}",
                    "0123456789abcdef0123456789abcdef0123456789abcdef"
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let mut h = Harness::with_size(64, 16);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();
        h.app.entries.push(ConversationEntry::User {
            content: "run a tool and summarize".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        h.app.entries.push(ConversationEntry::ToolCall {
            tool_id: "toolu_1".into(),
            tool_name: "long_tool".into(),
            input: serde_json::json!({
                "path": "/tmp/0123456789abcdef0123456789abcdef0123456789abcdef"
            }),
        });
        h.app.entries.push(ConversationEntry::ToolResult {
            tool_id: "toolu_1".into(),
            tool_name: "long_tool".into(),
            output: long_tool_output,
            is_error: false,
        });
        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: format!("summary line\n{tail}"),
            images: vec![],
            timestamp: "t2".into(),
            metadata: None,
        });

        let f_tools_on = h.render("tools visible");
        assert!(h.app.auto_scroll, "auto_scroll starts enabled");
        assert!(
            f_tools_on.contains(tail),
            "tail should be visible with tools shown\n{f_tools_on}"
        );

        h.app.show_tools = false;
        let f_tools_off = h.render("tools hidden");
        assert!(
            f_tools_off.contains(tail),
            "tail should stay visible after hiding tools\n{f_tools_off}"
        );

        h.app.show_tools = true;
        let f_tools_back_on = h.render("tools visible again");
        assert!(
            f_tools_back_on.contains(tail),
            "tail should stay visible after showing tools again\n{f_tools_back_on}"
        );
    }

    // ── Scenario: rapid send + stream (the "popin" feel) ────────────────────

    #[test]
    fn scenario_send_to_stream_latency() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Type and send
        h.type_str("Quick question");
        h.press(KeyCode::Enter);
        h.app.entries.push(ConversationEntry::User {
            content: "Quick question".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        let f_sent = h.render("just sent");

        // The typing indicator (···) should appear immediately after send,
        // before StreamStart arrives from the daemon.
        assert!(
            f_sent.contains("···"),
            "typing indicator should appear immediately after send"
        );

        // Stream starts (but no text yet)
        h.stream_start();
        h.render("stream started, no text yet");

        // First chunk arrives
        h.stream_chunk("The answer is...");
        let _f_first = h.render("first chunk arrives");

        // Check the transition from "stream started, no text" to "first chunk"
        let diffs = h.changed_lines();
        eprintln!("Lines changed on first chunk arrival: {}", diffs.len());
        for (i, _prev, curr) in &diffs {
            eprintln!("  L{i}: → {curr:?}");
        }
    }

    // ── Scenario: multi-line input growth ───────────────────────────────────

    #[test]
    fn scenario_input_growth() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Single line
        h.type_str("line 1");
        h.render("1 line input");

        // Add lines
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 2");
        h.render("2 line input");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 3");
        h.render("3 line input");

        // The input area should have grown, eating into conversation space

        // Keep adding lines up to the max (8 - 2 borders = 6 content lines)
        for i in 4..=7 {
            h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
            h.type_str(&format!("line {i}"));
        }
        let _f = h.render("7 line input (near max)");

        // Add one more — should cap at 8 total height
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 8");
        let _f = h.render("8 line input (at max)");

        // And another — shouldn't grow past 8
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 9");
        let f = h.render("9 line input (past max)");

        // The input area should be capped at 8 rows total
        // Conversation area must still have at least 3 rows (Min constraint)
        assert!(
            f.contains("Press i"),
            "conversation still visible at max input height"
        );
    }

    // ── Scenario: empty state welcome ───────────────────────────────────────

    #[test]
    fn scenario_empty_state_welcome() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        let f = h.render("empty with welcome");
        assert!(
            f.contains("Press i to start typing"),
            "welcome hint should appear when no messages"
        );
        assert!(f.contains("for commands"), "command hint should appear");

        // Hint should disappear once we have messages
        h.app.entries.push(ConversationEntry::User {
            content: "Hello".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        let f = h.render("with message");
        assert!(
            !f.contains("Press i to start typing"),
            "welcome hint should disappear once there are messages"
        );
    }

    // ── Scenario: scrolling ──────────────────────────────────────────────────

    #[test]
    fn scenario_scroll_indicator() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();

        // Fill conversation
        for i in 0..20 {
            h.app.entries.push(ConversationEntry::User {
                content: format!("Msg {i}"),
                images: vec![],
                timestamp: format!("t{i}"),
            });
        }

        // At bottom — latest messages visible
        let f = h.render("at bottom");
        assert!(f.contains("Msg 19"), "latest message visible at bottom");

        // Scroll up — earlier messages visible
        h.app.scroll_up(5);
        let f = h.render("scrolled up");
        assert!(
            !f.contains("Msg 19"),
            "latest message not visible when scrolled up"
        );

        // Scroll back to bottom
        h.app.scroll_to_bottom();
        let f = h.render("back at bottom");
        assert!(
            f.contains("Msg 19"),
            "latest message visible after scrolling back"
        );
    }

    #[test]
    fn scenario_line_by_line_scroll_repaints_unique_rows() {
        let mut h = Harness::with_size(48, 16);
        h.app.connection_status = ConnectionStatus::Connected;

        for i in 0..45 {
            h.app.entries.push(ConversationEntry::User {
                content: format!("unique row {i:02}"),
                images: vec![],
                timestamp: format!("t{i}"),
            });
        }

        fn visible_unique_rows(frame: &str) -> Vec<String> {
            frame
                .lines()
                .filter_map(|line| line.trim().strip_prefix("unique row "))
                .map(|suffix| suffix.to_string())
                .collect()
        }

        fn assert_no_duplicate_rows(frame: &str) {
            let rows = visible_unique_rows(frame);
            for (idx, row) in rows.iter().enumerate() {
                assert_eq!(
                    rows.iter().filter(|candidate| *candidate == row).count(),
                    1,
                    "visible row {idx} duplicated after repaint:\n{frame}"
                );
            }
        }

        assert_no_duplicate_rows(&h.render("scroll repaint at bottom"));

        for step in 0..5 {
            h.app.scroll_up(1);
            assert_no_duplicate_rows(&h.render(&format!("scroll repaint up {step}")));
        }

        for step in 0..3 {
            h.app.scroll_down(1);
            assert_no_duplicate_rows(&h.render(&format!("scroll repaint down {step}")));
        }

        h.app.scroll_up(10);
        assert_no_duplicate_rows(&h.render("scroll repaint page up"));
        h.app.scroll_down(10);
        assert_no_duplicate_rows(&h.render("scroll repaint page down"));
    }

    // ── Scenario: input placeholder ─────────────────────────────────────────

    #[test]
    fn scenario_input_placeholder() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Empty insert mode shows placeholder
        let f = h.render("empty insert mode");
        assert!(
            f.contains("Type a message"),
            "placeholder should show when input is empty"
        );

        // Typing removes placeholder
        h.type_str("h");
        let f = h.render("after typing one char");
        assert!(
            !f.contains("Type a message"),
            "placeholder should disappear when typing"
        );

        // Normal mode with empty input — no placeholder
        h.press(KeyCode::Backspace);
        h.press(KeyCode::Esc);
        let f = h.render("normal mode empty");
        assert!(
            !f.contains("Type a message"),
            "placeholder should not show in normal mode"
        );
    }

    // ── Scenario: phase display ─────────────────────────────────────────────

    #[test]
    fn scenario_phase_display() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Stream with no phase — typing indicator visible
        h.stream_start();
        let f = h.render("streaming, no phase");
        assert!(f.contains("···"), "typing indicator visible during stream");

        // Stream text appears
        h.stream_chunk("Hello!");
        let f = h.render("streaming with text");
        assert!(f.contains("Hello!"), "streamed text visible");
    }

    // ── Scenario: very short terminal ───────────────────────────────────────

    #[test]
    fn scenario_very_short_terminal() {
        let mut h = Harness::with_size(60, 10);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Bob".into();

        h.app.entries.push(ConversationEntry::User {
            content: "Hello".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "Hi there!".into(),
            images: vec![],
            timestamp: "t2".into(),
            metadata: None,
        });

        let f = h.render("short terminal with messages");
        // Should not panic and should show something useful
        assert!(f.contains("Bob"), "character name in assistant entry");
        assert!(f.contains("[INSERT]"), "input mode indicator visible");

        // Streaming in short terminal
        h.stream_start();
        h.stream_chunk("Response text");
        let f = h.render("streaming in short terminal");
        assert!(
            f.contains("Response"),
            "streamed content visible in short terminal"
        );
    }

    // ── Scenario: multiple tool calls ───────────────────────────────────────

    #[test]
    fn scenario_multiple_tool_calls() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::User {
            content: "Search and summarize".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        // First tool call + result
        h.app.entries.push(ConversationEntry::ToolCall {
            tool_id: "tc1".into(),
            tool_name: "web_search".into(),
            input: serde_json::json!({"query": "rust tui frameworks"}),
        });
        h.app.entries.push(ConversationEntry::ToolResult {
            tool_id: "tc1".into(),
            tool_name: "web_search".into(),
            output: "Found: ratatui, cursive, tui-rs".into(),
            is_error: false,
        });

        // Second tool call + result
        h.app.entries.push(ConversationEntry::ToolCall {
            tool_id: "tc2".into(),
            tool_name: "read_page".into(),
            input: serde_json::json!({"url": "https://ratatui.rs"}),
        });
        h.app.entries.push(ConversationEntry::ToolResult {
            tool_id: "tc2".into(),
            tool_name: "read_page".into(),
            output: "Ratatui is a Rust library for building terminal UIs".into(),
            is_error: false,
        });

        // Error result
        h.app.entries.push(ConversationEntry::ToolCall {
            tool_id: "tc3".into(),
            tool_name: "read_page".into(),
            input: serde_json::json!({"url": "https://404.example.com"}),
        });
        h.app.entries.push(ConversationEntry::ToolResult {
            tool_id: "tc3".into(),
            tool_name: "read_page".into(),
            output: "404 Not Found".into(),
            is_error: true,
        });

        let f = h.render("multiple tool calls");
        // All tool calls should be visible
        assert!(f.contains("web_search"), "first tool call visible");
        assert!(f.contains("read_page"), "second tool call visible");
        // Error should be distinguishable (we can't check color, but content is there)
        assert!(f.contains("404 Not Found"), "error result visible");
        // Tool calls should have the arrows
        let arrow_count = f.matches('▶').count();
        assert_eq!(arrow_count, 3, "should have 3 tool call arrows");
        let result_count = f.matches('◀').count();
        assert_eq!(result_count, 3, "should have 3 result arrows");
    }

    // ── Scenario: cursor position with wrapping ─────────────────────────────

    #[test]
    fn scenario_cursor_wrapping() {
        // Use a narrow terminal to force wrapping
        let mut h = Harness::with_size(30, 15);
        h.app.connection_status = ConnectionStatus::Connected;

        // Type enough text to cause wrapping (28 content chars per line)
        h.type_str("abcdefghijklmnopqrstuvwxyz12345678");
        let f = h.render("wrapped input text");

        // The text should visually wrap across multiple lines.
        // With 30-wide terminal and no side borders, 34 chars wraps after col 30:
        //   line 1: "abcdefghijklmnopqrstuvwxyz1234" (30 chars)
        //   line 2: "5678" (4 chars)
        let input_lines: Vec<&str> = f
            .lines()
            .filter(|l| l.contains("abcdef") || l.contains("5678"))
            .collect();
        assert!(
            input_lines.len() >= 2,
            "long input should wrap to multiple visual lines, got {} lines: {:?}",
            input_lines.len(),
            input_lines
        );
    }

    // ── Scenario: cursor at exact boundary ────────────────────────────────

    #[test]
    fn scenario_cursor_at_exact_boundary() {
        // Use 30-wide terminal → input content_width = 30 (Borders::TOP has no side borders)
        let mut h = Harness::with_size(30, 15);
        h.app.connection_status = ConnectionStatus::Connected;

        // Type exactly 30 characters to fill the first line
        let exact_line = "a".repeat(30);
        h.type_str(&exact_line);
        let _f = h.render("cursor at exact boundary");

        // Type one more character — it should appear on its own wrapped line
        h.type_str("x");
        let f = h.render("one char past boundary");
        let has_wrapped_x = f.lines().any(|l| l.starts_with('x'));
        assert!(
            has_wrapped_x,
            "character after boundary should appear on new wrapped line"
        );
    }

    // ── Scenario: optimistic user message echo ──────────────────────────────

    #[test]
    fn scenario_optimistic_user_echo() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Type and send a message
        h.type_str("hello world");
        h.press(KeyCode::Enter);
        let f = h.render("after send");

        // User's message should appear immediately in conversation
        assert!(
            f.contains("hello world"),
            "user's message should be visible immediately after send"
        );
        assert!(f.contains("You"), "user label should be visible");
        // Typing indicator should also show
        assert!(
            f.contains("···"),
            "typing indicator should show alongside user message"
        );
    }

    // ── Scenario: thinking deduplication during streaming ───────────────────

    #[test]
    fn scenario_thinking_not_duplicated() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();

        // Add a user message
        h.app.entries.push(ConversationEntry::User {
            content: "hi".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        // Add thinking entry (as if from History rebuild during streaming)
        h.app.entries.push(ConversationEntry::Thinking {
            content: "thinking about response".into(),
        });

        // Start streaming with same thinking text
        h.stream_start();
        h.thinking_chunk("thinking about response");

        let f = h.render("streaming with thinking entries");

        // Thinking text should appear ONLY in the thinking panel, not in conversation
        let thinking_occurrences = f.matches("thinking about response").count();
        assert_eq!(
            thinking_occurrences, 1,
            "thinking text should appear exactly once (in thinking panel), not duplicated in conversation. Found {} occurrences",
            thinking_occurrences
        );
    }

    // ── Scenario: regeneration flow ─────────────────────────────────────────

    #[test]
    fn scenario_regeneration() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // Set up a conversation
        h.app.entries.push(ConversationEntry::User {
            content: "Tell me a joke".into(),
            images: vec![],
            timestamp: "t1".into(),
        });
        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "Why did the chicken cross the road?".into(),
            images: vec![],
            timestamp: "t2".into(),
            metadata: None,
        });

        let f = h.render("before regen");
        assert!(f.contains("chicken"), "original response visible");

        // Simulate regeneration: remove last assistant, start stream
        h.app.stream.reset();
        h.app.stream.active = true;
        h.app.stream.regen = true;
        // Remove last assistant entry (as StreamStart handler does)
        if let Some(pos) = h
            .app
            .entries
            .iter()
            .rposition(|e| matches!(e, ConversationEntry::Assistant { .. }))
        {
            h.app.entries.truncate(pos);
        }

        let f = h.render("regen started");
        assert!(
            !f.contains("chicken"),
            "original response should be removed during regen"
        );

        // New response streams in
        h.stream_chunk("A better joke: ");
        let f = h.render("regen streaming");
        assert!(f.contains("(regenerating)"), "should show regen indicator");
        assert!(f.contains("A better joke"), "new response streaming");

        // Complete regen
        h.stream_end("A better joke: Why do programmers prefer dark mode?");
        let f = h.render("regen complete");
        assert!(f.contains("dark mode"), "regenerated response visible");
        assert!(
            !f.contains("regenerating"),
            "regen indicator gone after completion"
        );
    }

    // ── Scenario: markdown code block in conversation ───────────────────────

    #[test]
    fn scenario_code_blocks() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
                content: "Here's some code:\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\nThat should work.".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });

        let f = h.render("code block");
        assert!(f.contains("fn main()"), "code content visible");
        assert!(f.contains("rust"), "language hint visible");
        assert!(
            f.contains("That should work"),
            "text after code block visible"
        );
    }

    #[test]
    fn scenario_markdown_blank_line_between_paragraphs() {
        let mut h = Harness::with_size(60, 18);
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "First paragraph.\n\nSecond paragraph.".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });

        let f = h.render_with_blank_rows("markdown paragraph spacing");
        let rows: Vec<&str> = f.lines().collect();
        let first = rows
            .iter()
            .position(|row| row.contains("First paragraph."))
            .expect("first paragraph visible");
        let second = rows
            .iter()
            .position(|row| row.contains("Second paragraph."))
            .expect("second paragraph visible");

        assert_eq!(
            second,
            first + 2,
            "paragraphs should have one visible blank row between them\n{f}"
        );
        assert!(
            rows[first + 1].trim().is_empty(),
            "row between paragraphs should be visually blank\n{f}"
        );
    }

    #[test]
    fn scenario_reported_markdown_elements_render() {
        let mut h = Harness::with_size(44, 24);
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: concat!(
                "review:\n\n",
                "`inline code wraps across the pane`\n\n",
                "```rust\n",
                "fn main() {\n",
                "    println!(\"hello\");\n",
                "}\n",
                "```\n\n",
                "1. numbered list item wraps across the pane\n",
                "2. second item\n",
                "- bullet list item wraps too\n",
                "- [x] task item"
            )
            .into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });

        let f = h.render("reported markdown elements");
        assert!(
            f.contains("inline code"),
            "inline code content visible\n{f}"
        );
        assert!(f.contains("fn main()"), "code block content visible\n{f}");
        assert!(
            f.contains("1. numbered list item"),
            "numbered list marker visible\n{f}"
        );
        assert!(
            f.contains("2. second item"),
            "second list marker visible\n{f}"
        );
        assert!(f.contains("- bullet list"), "bullet marker visible\n{f}");
        assert!(f.contains("[x] task item"), "task marker visible\n{f}");
        assert!(
            !f.contains("```"),
            "code fences should not render literally\n{f}"
        );
    }

    // ── Scenario: status messages appear as system entries ──────────────────────

    #[test]
    fn scenario_status_bar_populated() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.set_status("conversation loaded");

        let f = h.render("with status message");
        assert!(
            f.contains("conversation loaded"),
            "status message visible as system entry"
        );

        // Narrow terminal — should not panic
        let mut h2 = Harness::with_size(50, 20);
        h2.app = App {
            connection_status: ConnectionStatus::Connected,
            character_name: "Alice".into(),
            ..App::default()
        };
        h2.app.set_status("loaded");
        h2.render("narrow terminal with status");
    }

    // ── Scenario: character name shows in assistant responses ─────────────────

    #[test]
    fn scenario_dynamic_title() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        // With character name set, assistant entries use it
        h.app.character_name = "Luna".into();
        h.app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "Hello!".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });
        let f = h.render("with character");
        assert!(
            f.contains("Luna"),
            "character name shown in assistant entry"
        );
    }

    // ── Scenario: system messages ───────────────────────────────────────────

    #[test]
    fn scenario_system_messages() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::System {
            content: "Memory updated: user prefers dark themes".into(),
            count: 1,
            timestamp: "t1".into(),
        });
        h.app.entries.push(ConversationEntry::User {
            content: "Thanks".into(),
            images: vec![],
            timestamp: "t2".into(),
        });

        let f = h.render("system message");
        assert!(f.contains("System"), "system label visible");
        assert!(f.contains("Memory updated"), "system content visible");
        assert!(f.contains("You"), "user message after system");
    }

    // ── Scenario: deduped system messages show (×N) in header ───────────────

    #[test]
    fn scenario_system_message_count_suffix() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::System {
            content: "reconnecting: connection lost".into(),
            count: 7,
            timestamp: "t1".into(),
        });

        let f = h.render("deduped system");
        assert!(f.contains("reconnecting"), "content still visible");
        assert!(
            f.contains("(×7)"),
            "header should show count suffix for deduped messages"
        );
    }

    // ── Scenario: error in streaming ────────────────────────────────────────

    #[test]
    fn scenario_error_during_stream() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::User {
            content: "Do something".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        // Stream starts
        h.stream_start();
        h.stream_chunk("Starting to respond...");
        h.render("streaming");

        // Error arrives — stream resets, error in status
        h.app.stream.reset();
        h.app.set_status("error: rate_limit - Too many requests");

        let f = h.render("after error");
        assert!(
            !f.contains("[streaming...]"),
            "streaming indicator gone after error"
        );
        assert!(f.contains("rate_limit"), "error visible as system entry");
        // The partial response is lost — this is the current behavior
        assert!(
            !f.contains("Starting to respond"),
            "partial stream text gone after reset"
        );
    }

    // ── Scenario: reconnection during streaming ─────────────────────────────

    #[test]
    fn scenario_reconnect_during_stream() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::User {
            content: "Long question".into(),
            images: vec![],
            timestamp: "t1".into(),
        });

        h.stream_start();
        h.stream_chunk("Partial response that gets cut off because");
        h.render("streaming before disconnect");

        // Connection drops — stream state is cleared by disconnect handler
        h.app.connection_status = ConnectionStatus::Connecting;
        h.app.stream.reset();
        h.app.set_status("reconnecting: connection lost");

        let f = h.render("disconnected while streaming");
        assert!(
            f.contains("reconnecting"),
            "reconnection status visible as system entry"
        );
        // Streaming indicator should be gone (stream was reset)
        assert!(
            !f.contains("[streaming...]"),
            "streaming indicator cleared on disconnect"
        );
        // Partial stream text is lost on disconnect
        assert!(
            !f.contains("Partial response"),
            "partial stream text cleared on disconnect"
        );
    }

    // ── Scenario: rapid message exchange ────────────────────────────────────

    #[test]
    fn scenario_rapid_exchange() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Bot".into();

        // Simulate rapid back-and-forth
        for i in 0..5 {
            h.app.entries.push(ConversationEntry::User {
                content: format!("Q{i}: What about this?"),
                images: vec![],
                timestamp: format!("u{i}"),
            });
            h.app.entries.push(ConversationEntry::Assistant {
                msg_id: None,
                content: format!("A{i}: Here's my answer to that particular question."),
                images: vec![],
                timestamp: format!("a{i}"),
                metadata: None,
            });
        }

        let f = h.render("rapid exchange");
        // Most recent messages should be visible (bottom-anchored)
        assert!(f.contains("Q4"), "most recent user message visible");
        assert!(f.contains("A4"), "most recent response visible");

        // Check layout stability: render again, nothing should change
        let _f2 = h.render("same state re-render");
        let diffs = h.changed_lines();
        assert_eq!(
            diffs.len(),
            0,
            "re-rendering same state should produce identical frame"
        );
    }
}
