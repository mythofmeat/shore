use chrono::{DateTime, Local};
use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph, Wrap};
use shore_common::duration::format_duration_ms;
use shore_common::protocol::tool_display::{format_tool_input, format_tool_output};
use shore_common::protocol::types::Role;

use crate::tui::app::{
    AltChoice, App, Block as TurnBlock, ConversationEntry, InputMode, PaletteMode, Turn,
    ValueEditorKind,
};
use crate::tui::images;
use crate::tui::markdown;

fn usize_to_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

pub(crate) fn draw(frame: &mut Frame<'_>, app: &mut App) {
    let size = frame.area();

    let input_content_width = usize::from(size.width);
    let input_height = usize_to_u16(app.input.visual_line_count(input_content_width))
        .saturating_add(1)
        .min(8);

    let confirming = app.palette_confirmation.is_some();
    let show_value_editor =
        app.input.mode == InputMode::Command && !confirming && app.is_value_editor_open();
    let show_completions = app.input.mode == InputMode::Command
        && !confirming
        && !app.completion.candidates.is_empty();
    let show_alt_picker = app.alt_picker.is_some();
    let completion_height = if show_value_editor {
        4
    } else if show_completions {
        let header_lines = u16::from(app.completion.header.is_some());
        let n = usize_to_u16(app.completion.candidates.len());
        header_lines.saturating_add(n).min(15)
    } else {
        0
    };
    let alt_picker_height = if let Some(picker) = &app.alt_picker {
        if picker.loading {
            2
        } else {
            usize_to_u16(picker.choices.len()).saturating_add(1).min(12)
        }
    } else {
        0
    };

    let mut constraints = vec![Constraint::Min(3), Constraint::Length(input_height)];
    if show_value_editor || show_completions {
        constraints.push(Constraint::Length(completion_height));
    } else if show_alt_picker {
        constraints.push(Constraint::Length(alt_picker_height));
    } else {
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(size);

    let Some(conversation_area) = chunks.first().copied() else {
        return;
    };
    let Some(input_area) = chunks.get(1).copied() else {
        return;
    };

    draw_conversation(frame, &mut *app, conversation_area);

    draw_notifications(frame, app, conversation_area);

    draw_input(frame, app, input_area);

    if show_value_editor {
        if let Some(completion_area) = chunks.get(2).copied() {
            draw_value_editor(frame, app, completion_area);
        }
    } else if show_completions {
        if let Some(completion_area) = chunks.get(2).copied() {
            draw_completions_inline(frame, app, completion_area);
        }
    } else if show_alt_picker {
        if let Some(picker_area) = chunks.get(2).copied() {
            draw_alt_picker_inline(frame, app, picker_area);
        }
    } else {
    }

    if app.subagent_panel.is_some() {
        draw_subagent_panel(frame, app, size);
    }

    if app.show_help {
        draw_help(frame, app, size);
    }

    if app.fullscreen.is_some() {
        draw_fullscreen_image(frame, app, size);
    }
}

fn draw_notifications(frame: &mut Frame<'_>, app: &App, area: Rect) {
    const MAX_LINES: usize = 3;

    if app.notifications.is_empty() || area.width < 16 || area.height < 3 {
        return;
    }

    let margin = 1_u16;
    let box_w = area
        .width
        .checked_div(2)
        .unwrap_or(area.width)
        .clamp(24, 56)
        .min(area.width.saturating_sub(margin));
    let inner_w = usize::from(box_w.saturating_sub(3));
    let box_x = area
        .x
        .saturating_add(area.width)
        .saturating_sub(box_w)
        .saturating_sub(margin);

    let mut next_top = area.y;
    for notif in app.notifications.iter().rev() {
        let (icon, color) = match notif.level {
            crate::tui::app::NotificationLevel::Info => ("•", Color::Cyan),
            crate::tui::app::NotificationLevel::Warning => ("⚠", Color::Yellow),
            crate::tui::app::NotificationLevel::Error => ("✖", Color::Red),
        };

        let suffix = if notif.count > 1 {
            format!(" (×{})", notif.count)
        } else {
            String::new()
        };
        let body = format!("{}{}", notif.content, suffix);
        let wrap_w = inner_w.saturating_sub(2);
        let mut wrapped: Vec<String> = body
            .lines()
            .flat_map(|l| word_wrap(l, wrap_w.max(1)))
            .collect();
        if wrapped.is_empty() {
            wrapped.push(String::new());
        }
        if wrapped.len() > MAX_LINES {
            wrapped.truncate(MAX_LINES);
            if let Some(last) = wrapped.last_mut() {
                truncate_to_width(last, wrap_w.saturating_sub(1));
                last.push('…');
            }
        }

        let style = Style::default().fg(color);
        let lines: Vec<Line<'static>> = wrapped
            .into_iter()
            .enumerate()
            .map(|(i, text)| {
                if i == 0 {
                    Line::from(vec![
                        Span::styled(format!(" {icon} "), style.add_modifier(Modifier::BOLD)),
                        Span::styled(text, style),
                    ])
                } else {
                    Line::from(vec![Span::raw("   "), Span::styled(text, style)])
                }
            })
            .collect();

        let box_h = usize_to_u16(lines.len()).saturating_add(2);
        if next_top.saturating_add(box_h) > area.y.saturating_add(area.height) {
            break;
        }
        let box_y = next_top;
        let rect = Rect::new(box_x, box_y, box_w, box_h);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(style);
        frame.render_widget(Clear, rect);
        frame.render_widget(Paragraph::new(lines).block(block), rect);

        next_top = box_y.saturating_add(box_h);
    }
}

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
                Span::styled("  │ ".to_owned(), bar_style),
                Span::styled(wline, content_style),
            ]));
        }
    }
}

fn looks_like_token_stream(text: &str) -> bool {
    let mut non_empty = 0_usize;
    let mut leading_ws = 0_usize;
    for line in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if line.is_empty() {
            continue;
        }
        non_empty = non_empty.saturating_add(1);
        if line.chars().next().is_some_and(char::is_whitespace) {
            leading_ws = leading_ws.saturating_add(1);
        }
    }
    non_empty > 0 && leading_ws.saturating_mul(2) >= non_empty
}

fn push_thinking_reflowed(
    lines: &mut Vec<Line<'static>>,
    text: &str,
    bar_style: Style,
    content_style: Style,
    text_width: usize,
) {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if line.is_empty() {
            if !current.is_empty() {
                paragraphs.push(std::mem::take(&mut current));
            }
        } else {
            current.push_str(line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }

    for (i, paragraph) in paragraphs.iter().enumerate() {
        if i > 0 {
            lines.push(Line::from(Span::styled("  │ ".to_owned(), bar_style)));
        }
        for wline in word_wrap(paragraph, text_width) {
            lines.push(Line::from(vec![
                Span::styled("  │ ".to_owned(), bar_style),
                Span::styled(wline, content_style),
            ]));
        }
    }
}

fn render_thinking_group(lines: &mut Vec<Line<'static>>, thoughts: &[String], wrap_width: u16) {
    if thoughts.is_empty() {
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
    let text_width = usize::from(wrap_width.saturating_sub(4));
    for thought in thoughts {
        if looks_like_token_stream(thought) {
            push_thinking_reflowed(lines, thought, bar_style, content_style, text_width);
        } else {
            push_bar_wrapped(lines, thought, bar_style, content_style, text_width);
        }
    }
    lines.push(Line::from(""));
}

const SUBAGENT_COLOR: Color = Color::Cyan;

fn render_tool_block(
    lines: &mut Vec<Line<'static>>,
    block: &TurnBlock,
    subagent: bool,
    wrap_width: u16,
) {
    let bar_style = Style::default().fg(Color::DarkGray);
    let text_width = usize::from(wrap_width.saturating_sub(4));
    match block {
        TurnBlock::ToolUse {
            tool_name, input, ..
        } => {
            let call_color = if subagent {
                SUBAGENT_COLOR
            } else {
                Color::Magenta
            };
            lines.push(Line::from(vec![
                Span::styled("  ▶ ", Style::default().fg(call_color)),
                Span::styled(
                    tool_name.clone(),
                    Style::default().fg(call_color).add_modifier(Modifier::BOLD),
                ),
            ]));
            if let Some(formatted_input) = format_tool_input(input) {
                push_bar_wrapped(
                    lines,
                    &formatted_input,
                    bar_style,
                    Style::default().fg(Color::DarkGray),
                    text_width,
                );
            }
            lines.push(Line::from(""));
        }
        TurnBlock::ToolResult {
            tool_name,
            output,
            is_error,
            ..
        } => {
            let header_color = if *is_error {
                Color::Red
            } else if subagent {
                SUBAGENT_COLOR
            } else {
                Color::Cyan
            };
            lines.push(Line::from(vec![
                Span::styled("  ◀ ", Style::default().fg(header_color)),
                Span::styled(
                    tool_name.clone(),
                    Style::default()
                        .fg(header_color)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            let formatted_output = format_tool_output(output);
            push_bar_wrapped(
                lines,
                &formatted_output,
                bar_style,
                Style::default().fg(Color::DarkGray),
                text_width,
            );
            lines.push(Line::from(""));
        }
        TurnBlock::Text(_)
        | TurnBlock::Thinking(_)
        | TurnBlock::SubagentBegin(_)
        | TurnBlock::SubagentEnd(_) => {}
    }
}

fn render_blocks(
    lines: &mut Vec<Line<'static>>,
    blocks: &[TurnBlock],
    show_thinking: bool,
    show_tools: bool,
    show_subagent: bool,
    wrap_width: u16,
) {
    let mut in_subagent = false;
    let mut i = 0;
    while i < blocks.len() {
        let Some(block) = blocks.get(i) else {
            break;
        };
        match block {
            TurnBlock::SubagentBegin(name) => {
                in_subagent = true;
                if show_subagent {
                    lines.push(Line::from(Span::styled(
                        format!("  » {name} (sub-agent)"),
                        Style::default()
                            .fg(SUBAGENT_COLOR)
                            .add_modifier(Modifier::BOLD),
                    )));
                } else {
                    let tools =
                        section_tool_count(blocks.get(i.saturating_add(1)..).unwrap_or_default());
                    lines.push(Line::from(Span::styled(
                        format!("  » {name} · {tools} tool{} (press s)", plural(tools)),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
                i = i.saturating_add(1);
            }
            TurnBlock::SubagentEnd(name) => {
                if show_subagent && in_subagent {
                    lines.push(Line::from(Span::styled(
                        format!("  » {name} done"),
                        Style::default()
                            .fg(SUBAGENT_COLOR)
                            .add_modifier(Modifier::ITALIC),
                    )));
                    lines.push(Line::from(""));
                }
                in_subagent = false;
                i = i.saturating_add(1);
            }
            TurnBlock::Thinking(_) => {
                let start = i;
                while blocks
                    .get(i)
                    .is_some_and(|candidate| matches!(candidate, TurnBlock::Thinking(_)))
                {
                    i = i.saturating_add(1);
                }
                let visible = if in_subagent {
                    show_subagent
                } else {
                    show_thinking
                };
                if visible {
                    let thoughts: Vec<String> = blocks
                        .get(start..i)
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|b| match b {
                            TurnBlock::Thinking(content) => Some(content.clone()),
                            TurnBlock::Text(_)
                            | TurnBlock::ToolUse { .. }
                            | TurnBlock::ToolResult { .. }
                            | TurnBlock::SubagentBegin(_)
                            | TurnBlock::SubagentEnd(_) => None,
                        })
                        .collect();
                    render_thinking_group(lines, &thoughts, wrap_width);
                }
            }
            TurnBlock::Text(content) => {
                let visible = if in_subagent { show_subagent } else { true };
                if visible && !content.is_empty() {
                    let wrap_w = usize::from(wrap_width.saturating_sub(2));
                    lines.extend(indent_lines(markdown::render_markdown_wrapped(
                        content, wrap_w,
                    )));
                    lines.push(Line::from(""));
                }
                i = i.saturating_add(1);
            }
            TurnBlock::ToolUse { .. } | TurnBlock::ToolResult { .. } => {
                let visible = if in_subagent {
                    show_subagent
                } else {
                    show_tools
                };
                if visible && let Some(tool_block) = blocks.get(i) {
                    render_tool_block(lines, tool_block, in_subagent, wrap_width);
                }
                i = i.saturating_add(1);
            }
        }
    }
}

fn section_tool_count(rest: &[TurnBlock]) -> usize {
    rest.iter()
        .take_while(|b| !matches!(b, TurnBlock::SubagentEnd(_)))
        .filter(|b| matches!(b, TurnBlock::ToolUse { .. }))
        .count()
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn squeeze_blank_lines(lines: &mut Vec<Line<'static>>) {
    let mut consecutive_blanks = 0_u32;
    let mut squeezed = Vec::with_capacity(lines.len());

    for line in lines.drain(..) {
        if line.width() == 0 {
            consecutive_blanks = consecutive_blanks.saturating_add(1);
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
    usize_to_u16(lines.len())
}

fn truncate_to_width(s: &mut String, max_width: usize) {
    use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

    if UnicodeWidthStr::width(s.as_str()) <= max_width {
        return;
    }
    let mut width = 0_usize;
    let mut end = 0_usize;
    for (idx, ch) in s.char_indices() {
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if width.saturating_add(w) > max_width {
            break;
        }
        width = width.saturating_add(w);
        end = idx.saturating_add(ch.len_utf8());
    }
    s.truncate(end);
}

fn word_wrap(text: &str, max_width: usize) -> Vec<String> {
    use unicode_width::UnicodeWidthStr;

    if max_width == 0 || UnicodeWidthStr::width(text) <= max_width {
        return vec![text.to_owned()];
    }

    let mut result = Vec::new();
    let mut current = String::new();
    let mut current_width: usize = 0;

    for word in text.split_whitespace() {
        let w = UnicodeWidthStr::width(word);
        if current.is_empty() {
            current = word.to_owned();
            current_width = w;
        } else if current_width.saturating_add(1).saturating_add(w) <= max_width {
            current.push(' ');
            current.push_str(word);
            current_width = current_width.saturating_add(1).saturating_add(w);
        } else {
            result.push(std::mem::take(&mut current));
            current = word.to_owned();
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
            name.to_owned(),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        )));
    }
    lines.push(Line::from(""));
}

fn render_streaming_content(lines: &mut Vec<Line<'static>>, app: &App, _content_width: u16) {
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
            "responding" => spinner.to_owned(),
            _ => spinner.to_owned(),
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
    FRAMES
        .get(frame.checked_rem(FRAMES.len()).unwrap_or_default())
        .copied()
        .unwrap_or_default()
}

fn format_timestamp(timestamp: &str) -> Option<String> {
    let trimmed_timestamp = timestamp.trim();
    if trimmed_timestamp.is_empty() {
        return None;
    }

    match DateTime::parse_from_rfc3339(trimmed_timestamp) {
        Ok(dt) => {
            let local = dt.with_timezone(&Local);
            if local.date_naive() == Local::now().date_naive() {
                Some(local.format("%H:%M").to_string())
            } else {
                Some(local.format("%Y-%m-%d %H:%M").to_string())
            }
        }
        Err(_) => Some(trimmed_timestamp.to_owned()),
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
    if show_timestamp && let Some(display) = format_timestamp(timestamp) {
        spans.push(Span::styled(
            format!("  {display}"),
            Style::default().fg(Color::DarkGray),
        ));
    }
    lines.push(Line::from(spans));
}

fn draw_conversation(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let content_width = area.width;

    let fingerprint = app.conversation_fingerprint(content_width);
    if app.conv_cache.fingerprint != fingerprint {
        let same_width = app.conv_cache.fingerprint.width == content_width;
        let previous_content_visual = app.conv_cache.content_visual;
        let (lines, image_index, content_visual) = build_conversation_lines(app, content_width);
        app.image_index = image_index;
        app.conv_cache.fingerprint = fingerprint;
        app.conv_cache.lines = lines;
        app.conv_cache.content_visual = content_visual;

        let grew_above = std::mem::take(&mut app.grew_above_viewport);
        if !app.auto_scroll && same_width && !grew_above {
            let added_below_viewport =
                i32::from(content_visual).saturating_sub(i32::from(previous_content_visual));
            app.scroll_offset = u16::try_from(
                i32::from(app.scroll_offset)
                    .saturating_add(added_below_viewport)
                    .clamp(0, i32::from(u16::MAX)),
            )
            .unwrap_or_default();
        }
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

    let render_area = if content_visual < visible_height {
        let top_pad = visible_height.saturating_sub(content_visual);
        Rect {
            x: area.x,
            y: area.y.saturating_add(top_pad),
            width: area.width,
            height: content_visual,
        }
    } else {
        area
    };

    frame.render_widget(Clear, area);

    let paragraph = Paragraph::new(Text::from(app.conv_cache.lines.clone())).scroll((scroll, 0));

    frame.render_widget(paragraph, render_area);

    if !app.image_index.is_empty() {
        images::fixup_placeholder_cells(frame.buffer_mut(), render_area);
    }
}

fn render_turn(
    lines: &mut Vec<Line<'static>>,
    app: &App,
    turn: &Turn,
    content_width: u16,
    image_index: &mut Vec<crate::tui::app::ImageEntry>,
) {
    match turn.role {
        Role::User => {
            push_entry_header(
                lines,
                "You".to_owned(),
                Color::Blue,
                &turn.timestamp,
                app.show_timestamps,
            );
            lines.push(Line::from(""));
            render_blocks(
                lines,
                &turn.blocks,
                app.show_thinking,
                app.show_tools,
                app.show_subagent,
                content_width,
            );
            render_images(
                lines,
                &turn.images,
                &app.image_cache,
                app.show_images,
                image_index,
            );
            lines.push(Line::from(""));
        }
        Role::Assistant => {
            if turn.is_streaming() {
                render_streaming_header(lines, app);
            } else {
                let name = if app.character_name.is_empty() {
                    "Assistant".to_owned()
                } else {
                    app.character_name.clone()
                };
                push_entry_header(
                    lines,
                    name,
                    Color::Green,
                    &turn.timestamp,
                    app.show_timestamps,
                );
                lines.push(Line::from(""));
            }
            render_blocks(
                lines,
                &turn.blocks,
                app.show_thinking,
                app.show_tools,
                app.show_subagent,
                content_width,
            );
            render_images(
                lines,
                &turn.images,
                &app.image_cache,
                app.show_images,
                image_index,
            );
            if turn.is_streaming() {
                render_streaming_content(lines, app, content_width);
            } else {
                if app.show_metadata
                    && let Some(meta) = &turn.metadata
                {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "  [{} | in:{} out:{} cache:{} | {}]",
                            meta.model,
                            meta.tokens.input,
                            meta.tokens.output,
                            meta.tokens.cache_read,
                            format_duration_ms(u64::from(meta.timing.total_ms)),
                        ),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
                lines.push(Line::from(""));
            }
        }
        Role::System => {
            render_blocks(
                lines,
                &turn.blocks,
                app.show_thinking,
                app.show_tools,
                app.show_subagent,
                content_width,
            );
        }
    }
}

fn build_conversation_lines(
    app: &App,
    content_width: u16,
) -> (Vec<Line<'static>>, Vec<crate::tui::app::ImageEntry>, u16) {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut image_index: Vec<crate::tui::app::ImageEntry> = Vec::new();

    for entry in &app.entries {
        match entry {
            ConversationEntry::Turn(turn) => {
                render_turn(&mut lines, app, turn, content_width, &mut image_index);
            }
            ConversationEntry::System {
                content,
                count,
                timestamp,
            } => {
                let header = if *count > 1 {
                    format!("System (×{count})")
                } else {
                    "System".to_owned()
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
                let sys_wrap_w = usize::from(content_width.saturating_sub(2));
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
            ConversationEntry::ArchiveBoundary { archived_count } => {
                push_archive_boundary(&mut lines, content_width, *archived_count);
            }
        }
    }

    let trailing_streaming = matches!(
        app.entries.last().and_then(ConversationEntry::as_turn),
        Some(turn) if turn.is_streaming()
    );
    if app.stream.active && !trailing_streaming {
        render_streaming_header(&mut lines, app);
        render_streaming_content(&mut lines, app, content_width);
    }

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
        " 1 archived turn above · outside current context ".to_owned()
    } else {
        format!(" {archived_turns} archived turns above · outside current context ")
    };
    let width = usize::from(content_width);
    let label_width = unicode_width::UnicodeWidthStr::width(label.as_str());

    let text = if width > label_width {
        let left = width
            .saturating_sub(label_width)
            .checked_div(2)
            .unwrap_or_default();
        let right = width.saturating_sub(label_width.saturating_add(left));
        format!("{}{}{}", "─".repeat(left), label, "─".repeat(right))
    } else {
        label.trim().to_owned()
    };

    lines.push(Line::from(Span::styled(
        text,
        Style::default().fg(Color::DarkGray),
    )));
    lines.push(Line::from(""));
}

fn draw_fullscreen_image(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let idx = match app.fullscreen {
        Some(i) if i < app.image_index.len() => i,
        _ => return,
    };
    let Some(entry) = app.image_index.get(idx) else {
        return;
    };
    let Some(transmitted) = app.image_cache.get(&entry.path) else {
        return;
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(area);

    let Some(img_area) = chunks.first().copied() else {
        return;
    };
    let Some(status_area) = chunks.get(1).copied() else {
        return;
    };

    let (fs_cols, fs_rows) = app.image_cache.calculate_cells(
        transmitted.pw,
        transmitted.ph,
        img_area.width,
        img_area.height,
    );

    let v_pad = img_area
        .height
        .saturating_sub(fs_rows)
        .checked_div(2)
        .unwrap_or_default();
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

    let total = app.image_index.len();
    let status_text = format!(
        "  {}/{} \u{2014} {}",
        idx.saturating_add(1),
        total,
        entry.display_name
    );
    let status = Paragraph::new(Line::from(Span::styled(
        status_text,
        Style::default().fg(Color::DarkGray),
    )));
    frame.render_widget(status, status_area);

    images::fixup_placeholder_cells(frame.buffer_mut(), img_area);
}

fn render_images(
    lines: &mut Vec<Line<'static>>,
    img_refs: &[shore_common::protocol::types::ImageRef],
    cache: &images::ImageCache,
    show_inline: bool,
    index: &mut Vec<crate::tui::app::ImageEntry>,
) {
    if img_refs.is_empty() {
        return;
    }

    lines.push(Line::from(""));

    for img in img_refs {
        let display = img.caption.as_deref().unwrap_or_else(|| {
            std::path::Path::new(&img.path)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(&img.path)
        });

        if show_inline && let Some(transmitted) = cache.get(&img.path) {
            lines.push(Line::from(Span::styled(
                format!("  [{display}]"),
                Style::default().fg(Color::Magenta),
            )));
            let img_start_line = lines.len();
            lines.extend(images::placeholder_lines(transmitted));
            index.push(crate::tui::app::ImageEntry {
                path: img.path.clone(),
                display_name: display.to_owned(),
                line: img_start_line,
            });
            continue;
        }

        lines.push(Line::from(Span::styled(
            format!("  [image: {display}]"),
            Style::default().fg(Color::Magenta),
        )));
    }
}

#[expect(
    clippy::arithmetic_side_effects,
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::float_arithmetic,
    reason = "the bounded ten-cell usage gauge converts a clamped percentage to discrete cells"
)]
fn usage_chip(
    budget: &crate::tui::app::UsageBudget,
    focus: &crate::tui::app::BudgetFocus,
) -> (String, Color) {
    const CELLS: usize = 10;
    let level = budget.level(focus.scope);
    let prefix = if budget.level_is_pace(focus.scope) {
        "pace "
    } else {
        ""
    };
    let filled = ((level.percent_used.clamp(0.0, 1.0)) * CELLS as f64).round() as usize;
    let bar: String = "█".repeat(filled) + &"░".repeat(CELLS - filled);
    let pct = (level.percent_used * 100.0).round() as i64;
    let color = if level.over_limit {
        Color::Red
    } else if budget.in_warning() {
        Color::Yellow
    } else {
        Color::DarkGray
    };
    (format!("{prefix}[{bar}] {pct}%"), color)
}

fn draw_input(frame: &mut Frame<'_>, app: &App, area: Rect) {
    if app.input.mode == InputMode::Command {
        if let Some(confirmation) = &app.palette_confirmation {
            let block = Block::default()
                .borders(Borders::TOP)
                .title(" [CONFIRM] ")
                .border_style(Style::default().fg(Color::Yellow));
            let display = format!("{}  Enter: run · Esc: cancel", confirmation.prompt);
            frame.render_widget(Paragraph::new(display).block(block), area);
            return;
        }
        let (title, prefix): (String, &str) = match (&app.completion.mode, app.completion.scope) {
            (_, crate::cli::PaletteScope::Shortcuts) => (" [SHORTCUT] ".to_owned(), "/"),
            (PaletteMode::Submenu(s), crate::cli::PaletteScope::Config) if s.parent == "config" => {
                (" [CONFIG] ".to_owned(), "")
            }
            (PaletteMode::Top, _) => (" [COMMAND] ".to_owned(), ":"),
            (PaletteMode::Submenu(s), _) => (format!(" [{}] ", s.parent), ""),
            (PaletteMode::ValueEditor(s), _) => (format!(" [{}] ", s.key), ""),
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

        let prefix_w = usize_to_u16(unicode_width::UnicodeWidthStr::width(prefix));
        let cursor_x =
            prefix_w.saturating_add(usize_to_u16(unicode_width::UnicodeWidthStr::width(
                app.input
                    .cmd_text
                    .get(..app.input.cmd_cursor)
                    .unwrap_or_default(),
            )));
        frame.set_cursor_position((area.x.saturating_add(cursor_x), area.y.saturating_add(1)));
        return;
    }

    let content_width = usize::from(area.width);
    let line_starts = crate::tui::app::word_wrap_offsets(&app.input.text, content_width);

    let cy_idx = line_starts
        .partition_point(|&s| s <= app.input.cursor)
        .saturating_sub(1);
    let cy = usize_to_u16(cy_idx);
    let line_start = line_starts.get(cy_idx).copied().unwrap_or_default();
    let mut cx: usize = app
        .input
        .text
        .get(line_start..app.input.cursor)
        .unwrap_or_default()
        .chars()
        .map(|c| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0))
        .sum();

    let cursor_row = if content_width > 0 && cx >= content_width {
        cx = 0;
        cy.saturating_add(1)
    } else {
        cy
    };

    let content_height = area.height.saturating_sub(1);
    let input_scroll = if cursor_row >= content_height {
        cursor_row.saturating_sub(content_height).saturating_add(1)
    } else {
        0
    };

    let show_placeholder = app.input.text.is_empty() && app.input.mode == InputMode::Insert;
    let input_content: Text<'_> = if show_placeholder {
        Text::from(Line::from(Span::styled(
            "Type a message...",
            Style::default().fg(Color::DarkGray),
        )))
    } else {
        let text = &app.input.text;
        let lines: Vec<String> = line_starts
            .iter()
            .enumerate()
            .map(|(idx, &start)| {
                let end = line_starts
                    .get(idx.saturating_add(1))
                    .copied()
                    .unwrap_or(text.len());
                let slice = text.get(start..end).unwrap_or_default();
                slice.strip_suffix('\n').unwrap_or(slice).to_owned()
            })
            .collect();
        Text::from(lines.into_iter().map(Line::from).collect::<Vec<_>>())
    };

    let (mode_label, border_color) = if app.editing_ref.is_some() {
        (" [EDIT] ".to_owned(), Color::Yellow)
    } else {
        match app.input.mode {
            InputMode::Insert => (" [INSERT] ".to_owned(), Color::Cyan),
            InputMode::Normal => (" [NORMAL] ".to_owned(), Color::DarkGray),
            InputMode::Command => (" [COMMAND] ".to_owned(), Color::Cyan),
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
                "1 image".to_owned()
            } else {
                format!("{img_count} images")
            },
            Color::Magenta,
        ));
    }
    let running_subagents = app.running_subagent_count();
    if running_subagents > 0 {
        indicators.push((
            format!(
                "{running_subagents} sub-agent{} running \u{2014} press S",
                if running_subagents == 1 { "" } else { "s" }
            ),
            SUBAGENT_COLOR,
        ));
    }
    if let Some(budget) = app.focused_budget() {
        let show = match app.usage_display {
            crate::tui::app::UsageDisplay::Off => false,
            crate::tui::app::UsageDisplay::Always => true,
            crate::tui::app::UsageDisplay::Warn => budget.in_warning(),
        };
        if show {
            indicators.push(usage_chip(budget, &app.budget_focus));
        }
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

    if app.input.mode == InputMode::Insert {
        frame.set_cursor_position((
            area.x.saturating_add(usize_to_u16(cx)),
            area.y
                .saturating_add(1)
                .saturating_add(cy)
                .saturating_sub(input_scroll),
        ));
    }
}

fn subagent_status_glyph(task: &crate::tui::app::SubagentTaskView) -> (&'static str, Color) {
    match task.status.as_str() {
        "done" => ("\u{2713}", Color::Green),
        "running" => ("\u{25cf}", Color::Yellow),
        _ => ("\u{2716}", Color::Red),
    }
}

fn draw_subagent_panel(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let Some(selected) = app.subagent_panel else {
        return;
    };
    if app.subagent_tasks.is_empty() {
        return;
    }

    let running = app.running_subagent_count();
    let title = if running == 0 {
        format!(" Sub-agents ({}) ", app.subagent_tasks.len())
    } else {
        format!(
            " Sub-agents ({} of {} running) ",
            running,
            app.subagent_tasks.len()
        )
    };
    let outer = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(title)
        .border_style(Style::default().fg(SUBAGENT_COLOR));
    let inner = outer.inner(area);
    frame.render_widget(Clear, area);
    frame.render_widget(outer, area);

    if inner.height < 4 || inner.width < 8 {
        return;
    }

    let visible_rows = usize::from(inner.height)
        .checked_div(3)
        .unwrap_or_default()
        .clamp(1, 8)
        .min(app.subagent_tasks.len());
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(usize_to_u16(visible_rows)),
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

    let window_start =
        completion_window_start(Some(selected), visible_rows, app.subagent_tasks.len());
    let mut selector_lines: Vec<Line<'static>> = Vec::new();
    for (idx, task) in app
        .subagent_tasks
        .iter()
        .enumerate()
        .skip(window_start)
        .take(visible_rows)
    {
        let (glyph, color) = subagent_status_glyph(task);
        let is_selected = idx == selected;
        let marker = if is_selected { " \u{25b8} " } else { "   " };
        let label_style = if is_selected {
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };
        let budget = usize::from(inner.width.saturating_sub(7));
        selector_lines.push(Line::from(vec![
            Span::styled(marker.to_owned(), Style::default().fg(SUBAGENT_COLOR)),
            Span::styled(format!("{glyph} "), Style::default().fg(color)),
            Span::styled(
                truncate_display(&task.selector_label(), budget),
                label_style,
            ),
        ]));
    }
    let Some(selector_area) = chunks.first().copied() else {
        return;
    };
    frame.render_widget(Paragraph::new(Text::from(selector_lines)), selector_area);

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "\u{2500}".repeat(usize::from(inner.width)),
            Style::default().fg(Color::DarkGray),
        ))),
        chunks.get(1).copied().unwrap_or(inner),
    );

    let Some(body_area) = chunks.get(2).copied() else {
        return;
    };
    let mut lines: Vec<Line<'static>> = Vec::new();
    let Some(task) = app.subagent_tasks.get(selected) else {
        return;
    };
    if !task.query.is_empty() {
        let wrap_w = usize::from(body_area.width.saturating_sub(2));
        for chunk in wrap_plain(&task.query, wrap_w) {
            lines.push(Line::from(Span::styled(
                format!("  {chunk}"),
                Style::default()
                    .fg(SUBAGENT_COLOR)
                    .add_modifier(Modifier::ITALIC),
            )));
        }
        lines.push(Line::from(""));
    }
    render_blocks(&mut lines, &task.blocks, true, true, true, body_area.width);
    if !task.is_running()
        && let Some(detail) = &task.detail
    {
        lines.push(Line::from(Span::styled(
            format!("  {} result", task.status),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )));
        let wrap_w = usize::from(body_area.width.saturating_sub(2));
        for chunk in wrap_plain(detail, wrap_w) {
            lines.push(Line::from(Span::styled(
                format!("  {chunk}"),
                Style::default().fg(Color::Gray),
            )));
        }
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            "  waiting for the sub-agent to report",
            Style::default().fg(Color::DarkGray),
        )));
    }

    let total = usize_to_u16(lines.len());
    let max_scroll = total.saturating_sub(body_area.height);
    let Some(selected_task) = app.subagent_tasks.get_mut(selected) else {
        return;
    };
    if selected_task.follow {
        selected_task.scroll = max_scroll;
    } else {
        selected_task.scroll = selected_task.scroll.min(max_scroll);
        if selected_task.scroll == max_scroll {
            selected_task.follow = true;
        }
    }
    let scroll = selected_task.scroll;

    frame.render_widget(
        Paragraph::new(Text::from(lines)).scroll((scroll, 0)),
        body_area,
    );

    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "  Tab/h/l switch  j/k scroll  G bottom  Esc close",
            Style::default().fg(Color::DarkGray),
        ))),
        chunks.get(3).copied().unwrap_or(inner),
    );
}

fn truncate_display(text: &str, budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    if unicode_width::UnicodeWidthStr::width(text) <= budget {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0_usize;
    for ch in text.chars() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if used.saturating_add(w).saturating_add(1) > budget {
            break;
        }
        used = used.saturating_add(w);
        out.push(ch);
    }
    out.push('\u{2026}');
    out
}

fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    for raw in text.lines() {
        let mut current = String::new();
        for word in raw.split_whitespace() {
            let candidate_len = unicode_width::UnicodeWidthStr::width(current.as_str())
                .saturating_add(usize::from(!current.is_empty()))
                .saturating_add(unicode_width::UnicodeWidthStr::width(word));
            if !current.is_empty() && candidate_len > width {
                out.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        out.push(current);
    }
    out
}

#[cfg(test)]
mod subagent_panel_tests {
    use super::scenario_tests::Harness;
    use crossterm::event::{KeyCode, KeyModifiers};
    use shore_common::protocol::server_msg::{ServerMessage, StreamChunk, ToolCall, ToolResult};

    fn asking(h: &mut Harness, task_id: &str, name: &str, query: &str) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                rid: None,
                tool_id: task_id.into(),
                tool_name: format!("ask_{name}"),
                input: serde_json::json!({ "query": query }),
                subagent: None,
                task_id: None,
            }),
        );
    }

    fn failed(h: &mut Harness, task_id: &str, name: &str) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolResult(ToolResult {
                rid: None,
                tool_id: task_id.into(),
                tool_name: format!("ask_{name}"),
                output: format!("{name} reported back"),
                is_error: true,
                subagent: None,
                task_id: None,
            }),
        );
    }

    fn answered(h: &mut Harness, task_id: &str, name: &str) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolResult(ToolResult {
                rid: None,
                tool_id: task_id.into(),
                tool_name: format!("ask_{name}"),
                output: format!("{name} reported back"),
                is_error: false,
                subagent: None,
                task_id: None,
            }),
        );
    }

    fn open_panel(h: &mut Harness) {
        h.press(KeyCode::Esc);
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char('S'));
    }

    fn chunk(h: &mut Harness, task_id: &str, name: &str, text: &str) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                rid: None,
                text: text.into(),
                content_type: "text".into(),
                subagent: Some(name.into()),
                task_id: Some(task_id.into()),
            }),
        );
    }

    fn tool(h: &mut Harness, task_id: &str, name: &str, tool_name: &str) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                rid: None,
                tool_id: "t1".into(),
                tool_name: tool_name.into(),
                input: serde_json::json!({"query": "tide tables"}),
                subagent: Some(name.into()),
                task_id: Some(task_id.into()),
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolResult(ToolResult {
                rid: None,
                tool_id: "t1".into(),
                tool_name: tool_name.into(),
                output: "high tide at 14:05".into(),
                is_error: false,
                subagent: Some(name.into()),
                task_id: Some(task_id.into()),
            }),
        );
    }

    #[test]
    fn a_running_task_never_lands_in_the_conversation() {
        let mut h = Harness::new();
        asking(&mut h, "tu_1", "research", "find the tide tables");
        chunk(&mut h, "tu_1", "research", "checking the almanac");
        tool(&mut h, "tu_1", "research", "web_search");

        assert_eq!(h.app.subagent_tasks.len(), 1);
        assert_eq!(
            h.app
                .subagent_tasks
                .first()
                .expect("subagent task")
                .blocks
                .len(),
            3
        );
        let blocks = &h
            .app
            .entries
            .last()
            .and_then(|e| e.as_turn())
            .unwrap()
            .blocks;
        assert_eq!(
            blocks.len(),
            1,
            "only the ask_ call itself belongs in the conversation: {blocks:?}"
        );
    }

    #[test]
    fn the_input_border_says_how_many_are_running() {
        let mut h = Harness::new();
        asking(&mut h, "tu_1", "research", "find the tide tables");
        let one_running = h.render("one running");
        assert!(
            one_running.contains("1 sub-agent running"),
            "frame: {one_running}"
        );
        assert!(one_running.contains("press S"), "frame: {one_running}");

        asking(&mut h, "tu_2", "cook", "plan dinner");
        let two_running = h.render("two running");
        assert!(
            two_running.contains("2 sub-agents running"),
            "frame: {two_running}"
        );

        answered(&mut h, "tu_1", "research");
        let one_settled = h.render("one settled");
        assert!(
            one_settled.contains("1 sub-agent running"),
            "frame: {one_settled}"
        );
    }

    #[test]
    fn the_panel_opens_on_shift_s_and_shows_the_selected_task() {
        let mut h = Harness::new();
        asking(&mut h, "tu_1", "research", "find the tide tables");
        chunk(&mut h, "tu_1", "research", "checking the almanac");
        tool(&mut h, "tu_1", "research", "web_search");

        open_panel(&mut h);
        assert_eq!(h.app.subagent_panel, Some(0));

        let frame = h.render("panel open");
        assert!(frame.contains("Sub-agents"), "frame: {frame}");
        assert!(frame.contains("research"), "frame: {frame}");
        assert!(frame.contains("find the tide tables"), "frame: {frame}");
        assert!(frame.contains("checking the almanac"), "frame: {frame}");
        assert!(frame.contains("web_search"), "frame: {frame}");

        h.press(KeyCode::Esc);
        assert_eq!(h.app.subagent_panel, None);
    }

    #[test]
    fn shift_s_with_no_tasks_says_so_instead_of_opening_an_empty_panel() {
        let mut h = Harness::new();
        open_panel(&mut h);
        assert_eq!(h.app.subagent_panel, None);
    }

    #[test]
    fn tab_switches_between_tasks_by_name_and_query() {
        let mut h = Harness::new();
        asking(&mut h, "tu_1", "research", "find the tide tables");
        chunk(&mut h, "tu_1", "research", "checking the almanac");
        asking(&mut h, "tu_2", "cook", "plan dinner for six");
        chunk(&mut h, "tu_2", "cook", "counting the plates");

        open_panel(&mut h);
        let first_task = h.render("first task selected");
        assert!(
            first_task.contains("checking the almanac"),
            "frame: {first_task}"
        );
        assert!(
            !first_task.contains("counting the plates"),
            "frame: {first_task}"
        );

        h.press(KeyCode::Tab);
        assert_eq!(h.app.subagent_panel, Some(1));
        let second_task = h.render("second task selected");
        assert!(
            second_task.contains("counting the plates"),
            "frame: {second_task}"
        );
        assert!(
            second_task.contains("plan dinner for six"),
            "frame: {second_task}"
        );

        h.press(KeyCode::Tab);
        assert_eq!(h.app.subagent_panel, Some(0), "selection wraps around");
    }

    #[test]
    fn a_settled_task_shows_its_status_and_result() {
        let mut h = Harness::new();
        asking(&mut h, "tu_1", "research", "find the tide tables");
        failed(&mut h, "tu_1", "research");

        open_panel(&mut h);
        let frame = h.render("errored task");
        assert!(frame.contains("error result"), "frame: {frame}");
        assert!(frame.contains("research reported back"), "frame: {frame}");
        assert_eq!(h.app.running_subagent_count(), 0);
    }

    #[test]
    fn a_frame_that_beats_its_ask_call_still_creates_the_task() {
        let mut h = Harness::new();
        chunk(&mut h, "tu_9", "research", "arriving before the call did");

        assert_eq!(h.app.subagent_tasks.len(), 1);
        assert_eq!(
            h.app.subagent_tasks.first().expect("subagent task").name,
            "research"
        );
        assert!(h.app.entries.is_empty());

        asking(&mut h, "tu_9", "research", "the late query");
        assert_eq!(
            h.app.subagent_tasks.len(),
            1,
            "the ask_ call upserts, it does not append"
        );
        assert_eq!(
            h.app.subagent_tasks.first().expect("subagent task").query,
            "the late query"
        );
    }

    fn untagged_chunk(h: &mut Harness, name: &str, text: &str) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                rid: None,
                text: text.into(),
                content_type: "text".into(),
                subagent: Some(name.into()),
                task_id: None,
            }),
        );
    }

    #[test]
    fn an_untagged_subagent_frame_lands_in_the_panel_under_its_name() {
        let mut h = Harness::new();
        untagged_chunk(&mut h, "research", "no task id on this one");

        assert!(
            h.app.entries.is_empty(),
            "no sub-agent output belongs in the conversation"
        );
        assert_eq!(h.app.subagent_tasks.len(), 1);
        let task = h.app.subagent_tasks.first().expect("subagent task");
        assert_eq!(task.name, "research");
        assert_eq!(task.blocks.len(), 1);
    }

    fn ask_call(h: &mut Harness, tool_id: &str, name: &str, output: &str, is_error: bool) {
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                rid: None,
                tool_id: tool_id.into(),
                tool_name: format!("ask_{name}"),
                input: serde_json::json!({"query": "what is the weather"}),
                subagent: None,
                task_id: None,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolResult(ToolResult {
                rid: None,
                tool_id: tool_id.into(),
                tool_name: format!("ask_{name}"),
                output: output.into(),
                is_error,
                subagent: None,
                task_id: None,
            }),
        );
    }

    #[test]
    fn a_refused_ask_still_shows_why() {
        let mut h = Harness::new();
        h.app.connection_status = crate::tui::app::ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        ask_call(
            &mut h,
            "p1",
            "ghost",
            "ask_ghost is not available in this build",
            true,
        );

        let frame = h.render("refused ask");
        assert!(
            frame.contains("not available in this build"),
            "a refused ask_ must say why:\n{frame}"
        );
    }

    #[test]
    fn three_at_once_do_not_spam_the_conversation() {
        let mut h = Harness::new();
        let running = [("tu_1", "internet"), ("tu_2", "music"), ("tu_3", "memory")];
        for (task_id, name) in running {
            asking(&mut h, task_id, name, "what is the weather");
        }
        for round in 0..4 {
            for (task_id, name) in running {
                chunk(&mut h, task_id, name, &format!("{name} said {round}. "));
            }
        }

        let blocks = &h
            .app
            .entries
            .last()
            .and_then(|e| e.as_turn())
            .unwrap()
            .blocks;
        assert_eq!(
            blocks.len(),
            3,
            "the three ask_ calls, and nothing the sub-agents said: {blocks:?}"
        );
        assert_eq!(h.app.subagent_tasks.len(), 3);
        for task in &h.app.subagent_tasks {
            assert_eq!(
                task.blocks.len(),
                1,
                "{} kept one text block, not one per frame",
                task.name
            );
        }

        let frame = h.render("three running");
        assert!(frame.contains("3 sub-agents running"), "frame: {frame}");
        assert!(
            !frame.contains("(press s)"),
            "no collapsed section markers belong here:\n{frame}"
        );
    }

    #[test]
    fn three_untagged_at_once_do_not_spam_either() {
        let mut h = Harness::new();
        for round in 0..4 {
            for name in ["internet", "music", "memory"] {
                untagged_chunk(&mut h, name, &format!("{name} said {round}. "));
            }
        }

        assert!(h.app.entries.is_empty());
        assert_eq!(h.app.subagent_tasks.len(), 3);
        let frame = h.render("three untagged");
        assert!(
            !frame.contains("(press s)"),
            "the old inline path opened a section per frame:\n{frame}"
        );
    }

    #[test]
    fn scrolling_stops_following_and_g_resumes_it() {
        let mut h = Harness::new();
        asking(&mut h, "tu_1", "research", "find the tide tables");
        for i in 0..60 {
            chunk(&mut h, "tu_1", "research", &format!("line {i}\n"));
        }

        open_panel(&mut h);
        let _ = h.render("following the tail");
        assert!(h.app.subagent_tasks.first().expect("subagent task").follow);
        assert!(
            h.app.subagent_tasks.first().expect("subagent task").scroll > 0,
            "the tail is scrolled to"
        );

        h.press(KeyCode::Char('k'));
        let _ = h.render("scrolled up");
        assert!(!h.app.subagent_tasks.first().expect("subagent task").follow);

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char('G'));
        let _ = h.render("back to the tail");
        assert!(h.app.subagent_tasks.first().expect("subagent task").follow);
    }
}

fn draw_help(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let heading = |text: &str| {
        Line::from(vec![Span::styled(
            format!("  {text}"),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )])
    };
    let row = |left: &str, right: &str| {
        Line::from(vec![
            Span::styled(format!("    {left:<16}"), Style::default().fg(Color::White)),
            Span::styled(right.to_owned(), Style::default().fg(Color::Gray)),
        ])
    };

    let mut lines = vec![Line::from(""), heading("Your keys")];
    if app.keymap.bindings().is_empty() {
        lines.push(Line::from(Span::styled(
            "    nothing is bound; edit tui.toml or use `ui bind`",
            Style::default().fg(Color::DarkGray),
        )));
    }
    for (key, binding) in app.keymap.bindings() {
        lines.push(row(key, &binding.written));
    }

    lines.push(Line::from(""));
    lines.push(heading("Always"));
    lines.push(row("Esc", "normal mode, or dismiss a notice"));
    lines.push(row(":", "command palette"));
    lines.push(row("Ctrl+C", "quit"));
    lines.push(row("Enter", "send message"));
    lines.push(row("Shift+Enter", "newline"));

    lines.push(Line::from(""));
    lines.push(heading("Rebinding"));
    for hint in [
        "    :ui bind <key> <command>      :ui unbind <key>",
        "    e.g. :ui bind 1 \"model use kimi-k3\"",
        "    Anything the : prompt takes can be bound. Tab completes it.",
        "    Or edit tui.toml directly; it is read at startup.",
    ] {
        lines.push(Line::from(Span::styled(
            hint.to_owned(),
            Style::default().fg(Color::DarkGray),
        )));
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  Press any key to close",
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    )));
    lines.push(Line::from(""));

    let height = usize_to_u16(lines.len()).saturating_add(2).min(area.height);
    let width = 68_u16.min(area.width);
    let x = area.x.saturating_add(
        area.width
            .saturating_sub(width)
            .checked_div(2)
            .unwrap_or_default(),
    );
    let y = area.y.saturating_add(
        area.height
            .saturating_sub(height)
            .checked_div(2)
            .unwrap_or_default(),
    );
    let popup_area = Rect::new(x, y, width, height);

    let popup = Paragraph::new(Text::from(lines))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Keyboard Shortcuts ")
                .border_style(Style::default().fg(Color::Yellow)),
        )
        .style(Style::default().bg(Color::Rgb(20, 20, 30)));

    frame.render_widget(Clear, popup_area);
    frame.render_widget(popup, popup_area);
}

fn completion_window_start(
    selected: Option<usize>,
    visible_rows: usize,
    total_rows: usize,
) -> usize {
    if visible_rows == 0 || total_rows <= visible_rows {
        return 0;
    }
    selected
        .map_or(0, |idx| idx.saturating_add(1).saturating_sub(visible_rows))
        .min(total_rows.saturating_sub(visible_rows))
}

fn draw_completions_inline(frame: &mut Frame<'_>, app: &App, area: Rect) {
    const ACTIVE_MARKER: &str = "  ● active";

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

    let candidate_rows = usize::from(area.height).saturating_sub(lines.len());
    let row_width = usize::from(area.width);
    let name_col: usize = 18;

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
        let i = window_start.saturating_add(offset);
        let selected = app.completion.selected == Some(i);
        let desc = app.command_description(c);
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
            PaletteMode::Top | PaletteMode::Submenu(_) | PaletteMode::ValueEditor(_) => false,
        };

        let name_text = format!("   {c}");
        let name_w = unicode_width::UnicodeWidthStr::width(name_text.as_str());

        let (gap, desc_text) = if let Some(d) = &desc {
            let gap = name_col.saturating_sub(name_w).max(2);
            (" ".repeat(gap), d.clone())
        } else if is_active {
            (String::new(), ACTIVE_MARKER.to_owned())
        } else {
            (String::new(), String::new())
        };

        let used = name_w
            .saturating_add(unicode_width::UnicodeWidthStr::width(gap.as_str()))
            .saturating_add(unicode_width::UnicodeWidthStr::width(desc_text.as_str()));
        let trailing = if used < row_width {
            " ".repeat(row_width.saturating_sub(used))
        } else {
            String::new()
        };

        if selected {
            let full = format!("{name_text}{gap}{desc_text}{trailing}");
            lines.push(Line::from(Span::styled(
                full,
                Style::default().fg(Color::Black).bg(Color::Yellow),
            )));
        } else if desc.is_some() {
            lines.push(Line::from(vec![
                Span::styled(name_text, Style::default().fg(Color::White)),
                Span::raw(gap),
                Span::styled(desc_text, Style::default().fg(Color::DarkGray)),
                Span::raw(trailing),
            ]));
        } else if is_active {
            lines.push(Line::from(vec![
                Span::styled(name_text, Style::default().fg(Color::White)),
                Span::styled(desc_text, Style::default().fg(Color::DarkGray)),
                Span::raw(trailing),
            ]));
        } else {
            lines.push(Line::from(Span::styled(
                format!("{name_text}{trailing}"),
                Style::default().fg(Color::White),
            )));
        }
    }

    let paragraph = Paragraph::new(Text::from(lines));
    frame.render_widget(paragraph, area);
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::float_arithmetic,
    reason = "the slider maps a clamped floating-point sampler range onto a bounded terminal rail"
)]
fn draw_value_editor(frame: &mut Frame<'_>, app: &App, area: Rect) {
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
            let row_width = usize::from(area.width);
            let rail_width = row_width
                .saturating_sub(value_width.saturating_add(8))
                .clamp(8, 48);
            let ratio = if max > min {
                ((*current - *min) / (*max - *min)).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let thumb = ((rail_width.saturating_sub(1)) as f64 * ratio).round() as usize;
            let mut rail = String::with_capacity(rail_width.saturating_add(2));
            rail.push('[');
            for idx in 0..rail_width {
                rail.push(if idx == thumb { '●' } else { '─' });
            }
            rail.push(']');

            let rail_width_with_brackets = unicode_width::UnicodeWidthStr::width(rail.as_str());
            let gap = row_width
                .saturating_sub(
                    2_usize
                        .saturating_add(rail_width_with_brackets)
                        .saturating_add(value_width),
                )
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
                    .saturating_add(unicode_width::UnicodeWidthStr::width(max_label.as_str())),
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
        .take(usize::from(area.height))
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
    let mut width = 0_usize;
    for ch in compact.chars() {
        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if width.saturating_add(w) > max_width.saturating_sub(3) {
            out.push_str("...");
            return out;
        }
        out.push(ch);
        width = width.saturating_add(w);
    }
    out
}

fn draw_alt_picker_inline(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let Some(picker) = &app.alt_picker else {
        return;
    };
    if area.height == 0 {
        return;
    }

    let row_width = usize::from(area.width);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let title = picker
        .msg_id
        .as_deref()
        .or(picker.target_ref.as_deref())
        .map_or_else(
            || "  alternates".to_owned(),
            |msg_id| format!("  alternates for {msg_id}"),
        );
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

    let visible_rows = usize::from(area.height).saturating_sub(1);
    let window_start =
        completion_window_start(Some(picker.selected), visible_rows, picker.choices.len());

    for (offset, choice) in picker
        .choices
        .iter()
        .skip(window_start)
        .take(visible_rows)
        .enumerate()
    {
        let i = window_start.saturating_add(offset);
        let selected = i == picker.selected;
        let active = if choice.active { "*" } else { " " };
        let prefix = format!("  {active} {:>2}  ", choice.position);
        let prefix_width = unicode_width::UnicodeWidthStr::width(prefix.as_str());
        let preview_width = row_width.saturating_sub(prefix_width).max(8);
        let preview = alt_preview_text(choice, preview_width);
        let used =
            prefix_width.saturating_add(unicode_width::UnicodeWidthStr::width(preview.as_str()));
        let trailing = if used < row_width {
            " ".repeat(row_width.saturating_sub(used))
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

#[cfg(test)]
pub(crate) mod scenario_tests {
    #![expect(
        clippy::print_stderr,
        reason = "these scenarios dump rendered frames and diffs for `cargo test -- --nocapture`"
    )]

    use super::*;
    use crate::tui::app::{
        App, Block, ConnectionStatus, ConversationEntry, InputMode, Turn, TurnState,
    };

    #[test]
    fn truncate_to_width_leaves_room_and_keeps_graphemes() {
        let mut s = "abcdef".to_owned();
        truncate_to_width(&mut s, 3);
        assert_eq!(s, "abc");
        let mut w = "古池や".to_owned();
        truncate_to_width(&mut w, 3);
        assert_eq!(w, "古");
        let mut short = "hi".to_owned();
        truncate_to_width(&mut short, 10);
        assert_eq!(short, "hi");
    }
    use crate::tui::connection::ConnCommand;
    use crate::tui::input;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use shore_common::protocol::client_msg::ClientMessage;
    use shore_common::protocol::server_msg::{CommandOutput, ServerMessage};
    use shore_common::protocol::types::{
        CharacterInfo, Role, StreamMetadata, TimingInfo, TokenCounts,
    };

    const W: u16 = 80;
    const H: u16 = 30;

    fn assistant_turn(blocks: Vec<Block>) -> ConversationEntry {
        ConversationEntry::Turn(Turn {
            role: Role::Assistant,
            msg_id: None,
            blocks,
            images: vec![],
            timestamp: "t".into(),
            state: TurnState::Complete,
            metadata: None,
        })
    }

    fn tool_use(id: &str, name: &str, input: serde_json::Value) -> Block {
        Block::ToolUse {
            tool_id: id.into(),
            tool_name: name.into(),
            input,
        }
    }

    fn tool_result(id: &str, name: &str, output: &str, is_error: bool) -> Block {
        Block::ToolResult {
            tool_id: id.into(),
            tool_name: name.into(),
            output: output.into(),
            is_error,
        }
    }

    pub(crate) struct Harness {
        terminal: Terminal<TestBackend>,
        pub(crate) app: App,
        frames: Vec<String>,
    }

    impl Harness {
        pub(crate) fn new() -> Self {
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

        pub(crate) fn render(&mut self, label: &str) -> String {
            let _ = self
                .terminal
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
                let trimmed_len = text.trim_end().len();
                text.truncate(trimmed_len);
                text.push('\n');
            }
            self.frames.push(text.clone());
            eprintln!("═══ {label} ═══\n{text}");
            text
        }

        fn render_with_blank_rows(&mut self, label: &str) -> String {
            let _ = self
                .terminal
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

        pub(crate) fn press(&mut self, code: KeyCode) {
            let _ = self.press_action(code);
        }

        fn press_action(&mut self, code: KeyCode) -> input::Action {
            self.press_mod_action(KeyModifiers::NONE, code)
        }

        pub(crate) fn press_mod(&mut self, mods: KeyModifiers, code: KeyCode) {
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

        fn stream_start(&mut self) {
            self.app.stream.reset();
            self.app.stream.active = true;
        }

        fn stream_chunk(&mut self, text: &str) {
            self.app.stream_append_text(text);
            self.app.stream.phase = "responding".into();
            if self.app.auto_scroll {
                self.app.scroll_to_bottom();
            }
        }

        fn thinking_chunk(&mut self, text: &str) {
            self.app.stream_append_thinking(text);
            self.app.stream.phase = "thinking".into();
        }

        fn stream_end(&mut self, content: &str) {
            let finalized = self
                .app
                .entries
                .last_mut()
                .and_then(ConversationEntry::as_turn_mut)
                .filter(|t| t.is_streaming())
                .map(|turn| {
                    turn.blocks.retain(|b| !matches!(b, TurnBlock::Text(_)));
                    if !content.is_empty() {
                        turn.blocks.push(TurnBlock::Text(content.to_owned()));
                    }
                    turn.state = TurnState::Complete;
                })
                .is_some();
            if !finalized {
                self.app.entries.push(ConversationEntry::assistant(
                    None,
                    content.to_owned(),
                    vec![],
                    String::new(),
                    None,
                ));
            }
            self.app.stream.reset();
        }

        fn changed_lines(&self) -> Vec<(usize, String, String)> {
            if self.frames.len() < 2 {
                return vec![];
            }
            let prev: Vec<&str> = self
                .frames
                .get(self.frames.len().saturating_sub(2))
                .expect("previous frame")
                .lines()
                .collect();
            let curr: Vec<&str> = self.frames.last().expect("current frame").lines().collect();
            prev.iter()
                .zip(curr.iter())
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .map(|(i, (a, b))| (i, a.to_string(), b.to_string()))
                .collect()
        }

        fn rows(&self, from: usize, to: usize) -> String {
            self.frames
                .last()
                .unwrap()
                .lines()
                .skip(from)
                .take(to.saturating_sub(from))
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
                    "budget_tokens": 2048,
                    "max_output_tokens": 4096,
                    "cache_ttl": "1h"
                },
                "scopes": {
                    "temperature": "character_model",
                    "top_p": "static_default",
                    "reasoning_effort": "static_default",
                    "budget_tokens": "static_default",
                    "max_output_tokens": "static_default",
                    "cache_ttl": "static_default"
                }
            }),
        })
    }

    fn sent_command(action: input::Action) -> shore_common::protocol::client_msg::Command {
        let input::Action::Send(ConnCommand::Send(ClientMessage::Command(command))) = action else {
            panic!("expected command send");
        };
        command
    }

    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "only the two sending actions carry commands to inspect"
    )]
    fn sent_commands(action: input::Action) -> Vec<shore_common::protocol::client_msg::Command> {
        let conns = match action {
            input::Action::Send(conn) => vec![conn],
            input::Action::SendMulti(conns) => conns,
            _ => panic!("expected at least one command send"),
        };
        conns
            .into_iter()
            .filter_map(|conn| match conn {
                ConnCommand::Send(ClientMessage::Command(command)) => Some(command),
                ConnCommand::Send(_) | ConnCommand::Shutdown => None,
            })
            .collect()
    }

    fn open_config_palette(h: &mut Harness) -> Vec<shore_common::protocol::client_msg::Command> {
        sent_commands(h.press_mod_action(KeyModifiers::CONTROL, KeyCode::Char('p')))
    }

    fn open_setting_menu_with_snapshot(h: &mut Harness) {
        let sent = sent_commands(h.press_mod_action(KeyModifiers::CONTROL, KeyCode::Char('p')));
        assert!(
            sent.iter().any(|command| command.name == "model_settings"),
            "opening the config palette should fetch the live settings: {:?}",
            sent.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        let _ = crate::tui::handle_server_message(&mut h.app, sampler_settings_output());
    }

    fn assert_set_model_setting(action: input::Action, key: &str, value: &serde_json::Value) {
        let cmd = sent_command(action);
        assert_eq!(cmd.name, "set_model_setting");
        assert_eq!(cmd.args.get("key"), Some(&serde_json::json!(key)));
        assert_eq!(cmd.args.get("value"), Some(value));
        assert_eq!(cmd.args.get("scope"), Some(&serde_json::json!("character")));
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

    #[test]
    fn scenario_empty_state() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.model = "gpt-4".into();
        h.app.character_name = "Alice".into();

        let f = h.render("empty state: connected, no messages");

        assert!(f.contains("[INSERT]"), "default mode is INSERT");
        assert!(
            !f.contains("model:"),
            "active model should stay out of the input border"
        );
    }

    #[test]
    fn scenario_full_message_cycle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Narrator".into();
        h.app.model = "claude-3".into();

        let _ = h.render("initial");

        h.type_str("Hello, world!");
        let after_typing = h.render("after typing");
        assert!(
            after_typing.contains("Hello, world!"),
            "typed text visible in input"
        );

        h.press(KeyCode::Enter);
        h.app.entries.push(ConversationEntry::user(
            "Hello, world!".into(),
            vec![],
            "t1".into(),
        ));
        let after_send = h.render("after send");
        assert!(
            !h.rows(
                usize::from(H).saturating_sub(4),
                usize::from(H).saturating_sub(1)
            )
            .contains("Hello, world!"),
            "input area should be cleared after send"
        );
        assert!(after_send.contains("You"), "user label visible");
        assert!(
            after_send.contains("Hello, world!"),
            "user message in conversation"
        );

        h.stream_start();
        let _ = h.render("stream started");

        h.stream_chunk("Hi there");
        let first_chunk = h.render("first chunk");
        assert!(first_chunk.contains("Hi there"), "streamed text visible");
        assert!(first_chunk.contains("Narrator"), "assistant name visible");

        h.stream_chunk(", how are you today?");
        let more_chunks = h.render("more chunks");
        assert!(
            more_chunks.contains("Hi there, how are you today?"),
            "accumulated text visible"
        );

        let diffs = h.changed_lines();
        eprintln!("Lines changed from chunk 1→2: {}", diffs.len());
        for (i, prev, curr) in &diffs {
            eprintln!("  L{i}: {prev:?} → {curr:?}");
        }

        h.stream_end("Hi there, how are you today?");
        let stream_ended = h.render("stream ended");
        assert!(
            !stream_ended.contains("[streaming...]"),
            "streaming indicator gone after end"
        );
        assert!(
            stream_ended.contains("Hi there, how are you today?"),
            "final response visible"
        );
    }

    #[test]
    fn scenario_history_marks_archived_boundary() {
        use shore_common::protocol::server_msg::History;
        use shore_common::protocol::types::{ContentBlock, Message, Role};

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
                provider_key: None,
                model: None,
                origin: None,
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
                provider_key: None,
                model: None,
                origin: None,
            },
        ];

        let _ = crate::tui::handle_server_message(
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

    #[test]
    fn scenario_thinking_toggle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Think about this".into(),
            vec![],
            "t1".into(),
        ));
        h.stream_start();
        h.thinking_chunk("Let me consider...\nFirst, I need to...\nThen...");
        h.stream_chunk("Here's my answer");

        let f1 = h.render("thinking visible inline");
        assert!(f1.contains("thinking"), "inline thinking header visible");
        assert!(f1.contains("Here's my answer"), "streaming text visible");

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

        h.app.show_thinking = true;
        let f3 = h.render("thinking re-enabled");
        assert!(
            f3.contains("thinking"),
            "inline thinking back after re-toggle"
        );
    }

    #[test]
    fn scenario_token_stream_thinking_reflows_to_prose() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.show_thinking = true;

        h.app
            .entries
            .push(ConversationEntry::user("hi".into(), vec![], "t1".into()));
        h.app.entries.push(assistant_turn(vec![Block::Thinking(
            "Ren is\n in\n a\n playful, sleepy\n, affectionate mode\n.\n\nKeep\n it\n short\n."
                .into(),
        )]));

        let f = h.render("token-stream thinking");
        assert!(
            f.contains("playful, sleepy, affectionate mode."),
            "token-stream thinking must reflow to prose:\n{f}"
        );
        assert!(
            f.contains("Keep it short."),
            "paragraph break must be preserved:\n{f}"
        );
        assert!(
            !f.contains("│ ,"),
            "token boundaries must not render as lines:\n{f}"
        );
    }

    #[test]
    fn looks_like_token_stream_detects_bpe_fragments() {
        assert!(looks_like_token_stream("Ren is\n in\n a\n playful"));
        assert!(!looks_like_token_stream(
            "Let me consider...\nFirst, I need to...\nThen..."
        ));
        assert!(!looks_like_token_stream("plain prose\n\nparagraph break"));
        assert!(!looks_like_token_stream(""));
        assert!(!looks_like_token_stream("single line"));
    }

    #[test]
    fn scenario_timestamp_toggle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.entries.push(ConversationEntry::user(
            "time check".into(),
            vec![],
            "2026-01-15T10:30:00Z".into(),
        ));

        let expected =
            format_timestamp("2026-01-15T10:30:00Z").expect("test timestamp should format");

        let hidden = h.render("timestamps hidden by default");
        assert!(
            !hidden.contains(&expected),
            "timestamps should start hidden; frame:\n{hidden}"
        );

        h.app.show_timestamps = true;
        let visible = h.render("timestamps visible");
        assert!(
            visible.contains(&expected),
            "formatted timestamp should render when enabled; expected {expected:?}; frame:\n{visible}"
        );
    }

    #[test]
    fn scenario_metadata_toggle() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.entries.push(ConversationEntry::assistant(
            Some("m1".into()),
            "hello".into(),
            vec![],
            "2026-01-15T10:30:00Z".into(),
            Some(metadata("test-model")),
        ));

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

    #[test]
    fn a_slow_turn_reads_in_minutes_rather_than_five_digits_of_milliseconds() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        let mut meta = metadata("glm-5.3");
        meta.tokens = TokenCounts {
            input: 48,
            output: 3319,
            cache_read: 18304,
            cache_write: 0,
        };
        meta.timing.total_ms = 60_499;
        h.app.entries.push(ConversationEntry::assistant(
            Some("m1".into()),
            "hello".into(),
            vec![],
            "2026-01-15T10:30:00Z".into(),
            Some(meta),
        ));

        let f = h.render("a slow turn");
        let line = f
            .lines()
            .find(|l| l.contains("glm-5.3"))
            .expect("the metadata line is on screen");
        assert!(
            line.contains("| 1.00m]"),
            "a minute-long turn must read in minutes: {line}"
        );
        assert!(
            !line.contains("60499"),
            "the raw millisecond reading is what this replaced: {line}"
        );
    }

    #[test]
    fn a_quick_turn_still_reads_in_milliseconds() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.entries.push(ConversationEntry::assistant(
            Some("m1".into()),
            "hello".into(),
            vec![],
            "2026-01-15T10:30:00Z".into(),
            Some(metadata("test-model")),
        ));

        let f = h.render("a quick turn");
        let line = f
            .lines()
            .find(|l| l.contains("test-model"))
            .expect("the metadata line is on screen");
        assert!(line.contains("| 44ms]"), "{line}");
    }

    #[test]
    fn scenario_command_palette() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        let _ = h.render("normal mode");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        let palette_open = h.render("command palette open");
        assert!(
            palette_open.contains("COMMAND"),
            "command mode title visible"
        );

        h.type_str("mod");
        let typing_model = h.render("typing 'mod'");
        assert!(typing_model.contains(":mod"), "command text visible");
        assert!(typing_model.contains("model"), "model completion visible");

        let cmd_line = typing_model
            .lines()
            .position(|l| l.contains("[COMMAND]"))
            .expect("command line present");
        let cand_line = typing_model
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

        h.press(KeyCode::Tab);
        let after_completion = h.render("after tab completion");
        assert_eq!(
            h.app.input.cmd_text, "model ",
            "Tab completes the word and stays in the grammar"
        );
        assert!(
            after_completion.contains("model use"),
            "and offers the subcommands next; frame:\n{after_completion}"
        );

        h.press(KeyCode::Esc);
        let after_second_escape = h.render("after second escape");
        assert!(
            !after_second_escape.contains("COMMAND"),
            "command palette hidden after escape"
        );
    }

    #[test]
    fn scenario_command_palette_input_returns_to_bottom() {
        fn input_row(h: &mut Harness, label: &str) -> u16 {
            let _ = h.terminal.draw(|frame| draw(frame, &mut h.app)).unwrap();
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

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        for i in 0..20 {
            h.app.entries.push(ConversationEntry::user(
                format!("hello {i}"),
                vec![],
                format!("t{i}"),
            ));
        }

        let baseline = input_row(&mut h, "baseline normal mode");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("mod");
        let raised = input_row(&mut h, "command mode with candidates");
        assert!(
            raised < baseline,
            "input row should be raised when completions visible \
             (raised={raised}, baseline={baseline})"
        );

        h.press(KeyCode::Esc);
        let restored = input_row(&mut h, "after esc");
        assert_eq!(
            restored, baseline,
            "input row should return to the bottom after menu closes"
        );
    }

    #[test]
    fn scenario_command_palette_navigation_keys() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        let _ = h.render("palette open");
        let total = h.app.completion.candidates.len();
        assert!(total >= 3, "need >=3 candidates for cycle test");

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('j'));
        assert_eq!(h.app.completion.selected, Some(0));
        assert!(
            h.app.input.cmd_text.is_empty(),
            "moving the selection must not rewrite the command"
        );

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('j'));
        assert_eq!(h.app.completion.selected, Some(1));

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('k'));
        assert_eq!(h.app.completion.selected, Some(0));

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('k'));
        assert_eq!(h.app.completion.selected, Some(total - 1));

        h.press(KeyCode::Down);
        assert_eq!(h.app.completion.selected, Some(0));

        h.press(KeyCode::Up);
        assert_eq!(h.app.completion.selected, Some(total - 1));
    }

    #[test]
    fn scenario_command_palette_descriptions() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        let palette_frame = h.render("palette open");

        for (cmd, desc) in [
            (
                "compact",
                "Summarize the conversation into memory and shorten the active",
            ),
            ("msg", "Send or change messages"),
            ("model", "List models, switch the active one"),
        ] {
            let row = palette_frame
                .lines()
                .find(|l| l.contains(cmd) && l.contains(desc))
                .unwrap_or_else(|| {
                    panic!("expected row with `{cmd}` + `{desc}`; full frame:\n{palette_frame}")
                });
            let cmd_pos = row.find(cmd).unwrap();
            let desc_pos = row.find(desc).unwrap();
            assert!(
                desc_pos > cmd_pos,
                "description should follow command name on row: {row}"
            );
        }

        h.app.model_names = vec!["alpha-1".into(), "beta-2".into()];
        h.press_mod(KeyModifiers::NONE, KeyCode::Backspace);
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model use ");
        let model_submenu = h.render("model submenu");
        assert!(
            model_submenu.contains("alpha-1") || model_submenu.contains("model use alpha-1"),
            "model candidate visible"
        );
        assert!(
            !model_submenu.contains("Switch the active model"),
            "argument candidates should not carry parent-command desc"
        );
    }

    #[test]
    fn scenario_command_palette_submenu_enter() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = vec!["alpha-1".into(), "beta-2".into()];

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('p'));
        h.press(KeyCode::Down);
        h.press(KeyCode::Enter);
        let f = h.render("model submenu open");

        assert!(
            matches!(h.app.completion.mode, PaletteMode::Submenu(_)),
            "completion mode should be Submenu after Enter"
        );
        assert!(
            f.contains("[model]"),
            "input title should show [model] breadcrumb; frame:\n{f}"
        );
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

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("timestamps");
        let f = h.render("display options in the config palette");

        let PaletteMode::Submenu(submenu) = &h.app.completion.mode else {
            panic!("expected the config palette");
        };
        assert_eq!(submenu.parent, "config");
        assert!(f.contains("[CONFIG]"), "config palette title visible");
        assert!(
            f.contains("timestamps = off"),
            "timestamp row should show current state; frame:\n{f}"
        );

        h.press(KeyCode::Down);
        h.press(KeyCode::Enter);
        assert!(
            h.app.show_timestamps,
            "Enter toggles the selected display option"
        );
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
    fn usage_chip_shows_on_input_border_when_enabled() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Insert;
        h.app.usage_budgets = vec![crate::tui::app::UsageBudget {
            name: "monthly".into(),
            percent_used: 0.82,
            crossed_warn_at: vec![0.8],
            over_limit: false,
            pace: None,
        }];

        let hidden = h.render("usage off");
        assert!(
            !hidden.contains("82%"),
            "chip should be hidden while usage_display is Off; frame:\n{hidden}"
        );

        h.app.usage_display = crate::tui::app::UsageDisplay::Always;
        let shown = h.render("usage always");
        assert!(
            shown.contains("82%"),
            "chip percent should be visible; frame:\n{shown}"
        );
        assert!(
            shown.contains('█') && shown.contains('░'),
            "chip should render a partial progress bar; frame:\n{shown}"
        );
    }

    #[test]
    fn usage_chip_warn_mode_only_shows_past_a_threshold() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Insert;
        h.app.usage_display = crate::tui::app::UsageDisplay::Warn;

        h.app.usage_budgets = vec![crate::tui::app::UsageBudget {
            name: "monthly".into(),
            percent_used: 0.23,
            crossed_warn_at: vec![],
            over_limit: false,
            pace: None,
        }];
        let calm = h.render("warn mode, calm");
        assert!(
            !calm.contains("23%"),
            "warn mode hides the chip before a threshold; frame:\n{calm}"
        );

        h.app.usage_budgets = vec![crate::tui::app::UsageBudget {
            name: "monthly".into(),
            percent_used: 0.82,
            crossed_warn_at: vec![0.8],
            over_limit: false,
            pace: None,
        }];
        let warned = h.render("warn mode, crossed");
        assert!(
            warned.contains("82%"),
            "warn mode reveals the chip past a threshold; frame:\n{warned}"
        );

        h.app.usage_budgets = vec![crate::tui::app::UsageBudget {
            name: "weekly".into(),
            percent_used: 0.6,
            crossed_warn_at: vec![],
            over_limit: false,
            pace: Some(crate::tui::app::UsageLevel {
                percent_used: 0.55,
                crossed_warn_at: vec![0.5],
                over_limit: false,
            }),
        }];
        let paced = h.render("warn mode, pace crossed");
        assert!(
            paced.contains("55%"),
            "a pace-only warning reveals the chip; frame:\n{paced}"
        );
    }

    #[test]
    fn usage_chip_follows_the_pinned_budget_focus() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Insert;
        h.app.usage_display = crate::tui::app::UsageDisplay::Always;
        h.app.usage_budgets = vec![crate::tui::app::UsageBudget {
            name: "brainwife".into(),
            percent_used: 0.71,
            crossed_warn_at: vec![],
            over_limit: false,
            pace: Some(crate::tui::app::UsageLevel {
                percent_used: 0.24,
                crossed_warn_at: vec![],
                over_limit: false,
            }),
        }];

        let auto = h.render("focus auto");
        assert!(
            auto.contains("71%") && !auto.contains("pace"),
            "auto follows the leading limit; frame:\n{auto}"
        );

        h.app.budget_focus = crate::tui::app::BudgetFocus {
            name: None,
            scope: Some(crate::tui::app::UsageScope::Pace),
        };
        let paced = h.render("focus pace");
        assert!(
            paced.contains("24%") && paced.contains("pace"),
            "pinned pace shows the pace figure; frame:\n{paced}"
        );

        h.app.budget_focus = crate::tui::app::BudgetFocus {
            name: Some("gone".into()),
            scope: None,
        };
        let missing = h.render("focus unknown name");
        assert!(
            !missing.contains("71%") && !missing.contains("24%"),
            "an unmatched pin hides the chip; frame:\n{missing}"
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
        let active_model_frame = h.render("active model marker");
        assert!(
            active_model_frame
                .lines()
                .any(|l| l.contains("beta") && l.contains("active")),
            "active model row should be marked like the active character; frame:\n{active_model_frame}"
        );

        h.app.characters = vec![CharacterInfo::new("Alice"), CharacterInfo::new("Bob")];
        h.app.character_name = "Alice".into();
        h.app.enter_submenu("character");
        let active_character_frame = h.render("active character marker");
        assert!(
            active_character_frame
                .lines()
                .any(|l| l.contains("Alice") && l.contains("active")),
            "active character row should still be marked; frame:\n{active_character_frame}"
        );
    }

    #[test]
    fn scenario_command_palette_submenu_scrolls_selected_item_into_view() {
        let mut h = Harness::with_size(60, 20);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = (0..20).map(|i| format!("model-{i:02}")).collect();

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('p'));
        h.press(KeyCode::Down);
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

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('p'));
        h.press(KeyCode::Down);
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

    #[test]
    fn scenario_command_palette_space_browses_cli_subcommands() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = vec!["foo".into()];

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        h.press_mod(KeyModifiers::NONE, KeyCode::Char(' '));
        let _ = h.render("after space");

        assert!(
            matches!(h.app.completion.mode, PaletteMode::Top),
            "Space keeps the palette at the CLI command level"
        );
        assert!(
            h.app.input.cmd_text == "model ",
            "Space should open the nested CLI command path"
        );
        assert!(
            h.app
                .completion
                .candidates
                .iter()
                .any(|candidate| candidate == "model use"),
            "current model subcommands should be discoverable"
        );
    }

    #[test]
    fn scenario_command_palette_submenu_filter_and_esc() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app.model_names = vec!["alpha-1".into(), "beta-2".into(), "alpha-2".into()];

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('p'));
        h.press(KeyCode::Down);
        h.press(KeyCode::Enter);
        let _ = h.render("submenu opened");

        h.type_str("alpha");
        let _ = h.render("filtered");

        let names: Vec<&str> = h
            .app
            .completion
            .candidates
            .iter()
            .map(String::as_str)
            .collect();
        assert!(
            names
                .iter()
                .all(|n| n.starts_with("alpha") || *n == "reset"),
            "filter should keep only alpha-prefixed model names (+synthetic reset if matching); got {names:?}"
        );
        assert!(
            names.contains(&"alpha-1") && names.contains(&"alpha-2"),
            "both alpha-* models survive the filter"
        );

        h.press(KeyCode::Esc);
        let _ = h.render("after esc");
        assert!(
            matches!(h.app.completion.mode, PaletteMode::Top),
            "Esc should pop submenu back to Top"
        );
        assert_eq!(
            h.app.input.cmd_text, "",
            "Esc returns to the config list, which starts unfiltered"
        );
    }

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
        assert!(app.completion.candidates.contains(&"gpt-4o".to_owned()));
        app.next_completion();
        let chosen = app
            .completion
            .selected
            .and_then(|selected| app.completion.candidates.get(selected))
            .expect("selected completion")
            .clone();

        let cmd = app.apply_submenu().expect("apply_submenu yields a command");
        assert_eq!(cmd, format!("model {chosen}"));
        assert!(app.completion.candidates.is_empty());
        assert!(matches!(app.completion.mode, PaletteMode::Top));
        assert_ne!(app.input.mode, InputMode::Command, "command mode exited");
    }

    #[test]
    fn scenario_command_palette_submenu_header() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        let _opened = open_config_palette(&mut h);
        let f = h.render("config palette while settings load");

        assert!(
            f.contains("what to change"),
            "config header visible above candidates"
        );
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

        assert!(matches!(h.app.completion.mode, PaletteMode::Submenu(_)));
        assert!(f.contains("what to change"), "config header visible");
        assert!(
            f.contains("temperature = 0.7"),
            "effective temperature should render next to its key; frame:\n{f}"
        );
    }

    #[test]
    fn setting_submenu_request_does_not_pin_model_name() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;
        h.app
            .set_active_model(Some("anthropic/claude-4.6-opus-20260205"));

        let sent = open_config_palette(&mut h);
        let settings = sent
            .iter()
            .find(|command| {
                command.name == "model_settings" && command.args == serde_json::json!({})
            })
            .expect("the config palette asks for settings without naming a model");
        assert_eq!(settings.args, serde_json::json!({}));
    }

    #[test]
    fn setting_reasoning_effort_opens_value_submenu_preselected() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("reasoning");
        h.press(KeyCode::Enter);

        let PaletteMode::Submenu(reasoning_submenu) = &h.app.completion.mode else {
            panic!("expected reasoning_effort submenu");
        };
        assert_eq!(reasoning_submenu.parent, "setting:reasoning_effort");
        let selected = h.app.completion.selected.expect("current value selected");
        assert_eq!(
            h.app
                .completion
                .candidates
                .get(selected)
                .map(String::as_str),
            Some("medium")
        );
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

        assert!(matches!(h.app.completion.mode, PaletteMode::ValueEditor(_)));
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

        assert_set_model_setting(action, "temperature", &serde_json::json!(1.25));
    }

    #[test]
    fn setting_temperature_waits_for_snapshot_before_slider_apply() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        let sent = open_config_palette(&mut h);
        assert!(sent.iter().any(|command| command.name == "model_settings"));

        h.type_str("temperature");
        let blocked = h.press_action(KeyCode::Enter);
        assert!(
            matches!(blocked, input::Action::Redraw),
            "Enter should not dispatch before sampler settings load"
        );
        let PaletteMode::Submenu(loading_submenu) = &h.app.completion.mode else {
            panic!("expected to stay in the config palette while loading");
        };
        assert_eq!(loading_submenu.parent, "config");

        let _ = crate::tui::handle_server_message(&mut h.app, sampler_settings_output());
        h.press(KeyCode::Enter);
        assert!(matches!(h.app.completion.mode, PaletteMode::ValueEditor(_)));
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "temperature", &serde_json::json!(0.7));
    }

    #[test]
    fn setting_reasoning_effort_waits_for_snapshot_before_submenu() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        let sent = open_config_palette(&mut h);
        assert!(sent.iter().any(|command| command.name == "model_settings"));

        h.type_str("reasoning");
        let blocked = h.press_action(KeyCode::Enter);
        assert!(matches!(blocked, input::Action::Redraw));
        let PaletteMode::Submenu(loading_submenu) = &h.app.completion.mode else {
            panic!("expected to stay in the config palette while loading");
        };
        assert_eq!(loading_submenu.parent, "config");

        let _ = crate::tui::handle_server_message(&mut h.app, sampler_settings_output());
        h.press(KeyCode::Enter);
        let PaletteMode::Submenu(reasoning_submenu) = &h.app.completion.mode else {
            panic!("expected reasoning_effort submenu after settings load");
        };
        assert_eq!(reasoning_submenu.parent, "setting:reasoning_effort");
        let selected = h.app.completion.selected.expect("current value selected");
        assert_eq!(
            h.app
                .completion
                .candidates
                .get(selected)
                .map(String::as_str),
            Some("medium")
        );
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

        assert_set_model_setting(action, "cache_ttl", &serde_json::json!("15m"));
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
    fn setting_sdk_picker_dispatches_command() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("sdk");
        h.press(KeyCode::Enter);
        let PaletteMode::Submenu(submenu) = &h.app.completion.mode else {
            panic!("expected setting sdk submenu");
        };
        assert_eq!(submenu.parent, "setting:sdk");
        h.type_str("anthropic");
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "sdk", &serde_json::json!("anthropic"));
    }

    #[test]
    fn setting_sdk_picker_offers_every_daemon_sdk() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("sdk");
        h.press(KeyCode::Enter);

        for sdk in [
            "anthropic",
            "openai",
            "openrouter",
            "gemini",
            "zai",
            "deepseek",
            "moonshot",
        ] {
            assert!(
                h.app
                    .completion
                    .candidates
                    .iter()
                    .any(|candidate| candidate == sdk),
                "sdk picker is missing {sdk}; it must list every variant in SDK_VARIANTS \
                 in daemon/src/config/models.ts"
            );
        }
    }

    #[test]
    fn setting_sdk_picker_dispatches_moonshot() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        open_setting_menu_with_snapshot(&mut h);
        h.type_str("sdk");
        h.press(KeyCode::Enter);
        h.type_str("moonshot");
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "sdk", &serde_json::json!("moonshot"));
    }

    #[test]
    fn the_config_palette_lists_settings_and_display_options_together() {
        let mut h = Harness::with_size(80, 40);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('p'));
        let _ = crate::tui::handle_server_message(&mut h.app, sampler_settings_output());

        let frame = h.render("config palette");
        assert!(frame.contains("[CONFIG]"), "{frame}");
        assert!(
            frame.contains("temperature"),
            "settings are listed: {frame}"
        );
        assert!(frame.contains("thinking"), "view options too: {frame}");
    }

    #[test]
    fn a_display_option_toggles_in_place_in_the_config_palette() {
        let mut h = Harness::with_size(80, 40);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('p'));
        let _ = crate::tui::handle_server_message(&mut h.app, sampler_settings_output());
        h.type_str("thinking");

        let before = h.app.show_thinking;
        h.press(KeyCode::Down);
        h.press(KeyCode::Enter);
        assert_ne!(h.app.show_thinking, before, "enter should toggle the row");
        assert_eq!(
            h.app.input.mode,
            InputMode::Command,
            "the palette stays open so more can be toggled"
        );
    }

    #[test]
    fn the_full_palette_runs_a_command_instead_of_opening_a_picker() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char(':'));
        h.type_str("model");
        let cmd = sent_command(h.press_action(KeyCode::Enter));
        assert_eq!(
            cmd.name, "list_models",
            "`:model` should run the command, not open a submenu"
        );
        assert_eq!(h.app.input.mode, InputMode::Normal);
    }

    #[test]
    fn the_shortcuts_palette_lists_shortcuts_with_their_keys() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press(KeyCode::Char('/'));
        let frame = h.render("shortcuts palette");
        assert!(frame.contains("[SHORTCUT]"), "{frame}");
        assert!(frame.contains("regen"), "{frame}");
        assert!(
            frame.contains('r'),
            "a shortcut whose command is on a key should show it: {frame}"
        );

        h.type_str("us");
        let filtered = h.render("shortcuts filtered to us");
        assert!(filtered.contains("usage"), "{filtered}");
        assert!(!filtered.contains("compact"), "{filtered}");
    }

    #[test]
    fn choosing_a_complete_shortcut_runs_it() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press(KeyCode::Char('/'));
        h.type_str("regen");
        let action = h.press_action(KeyCode::Enter);
        assert!(
            matches!(
                action,
                input::Action::Send(ConnCommand::Send(ClientMessage::Regen(_)))
            ),
            "the regen shortcut should send a regen"
        );
        assert_eq!(h.app.input.mode, InputMode::Normal);
    }

    #[test]
    fn choosing_a_shortcut_that_needs_an_argument_loads_the_line() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = InputMode::Normal;

        h.press(KeyCode::Char('/'));
        h.type_str("edit");
        let _opened = h.press_action(KeyCode::Enter);

        assert_eq!(h.app.input.mode, InputMode::Command);
        assert_eq!(h.app.input.cmd_text, "msg edit ");
        assert_eq!(h.app.completion.scope, crate::cli::PaletteScope::Full);
        let frame = h.render("edit loaded into the full palette");
        assert!(frame.contains("msg edit"), "{frame}");
    }

    #[test]
    fn the_help_overlay_lists_the_live_keymap() {
        let mut h = Harness::with_size(90, 50);
        h.app.keymap.bind("1", "model use kimi-k3").unwrap();
        h.app.keymap.bind("shift+f", "view thinking").unwrap();
        let _dropped = h.app.keymap.unbind("o").unwrap();
        h.app.show_help = true;

        let frame = h.render("help overlay");
        assert!(
            frame.contains("model use kimi-k3"),
            "a rebound key should show its command: {frame}"
        );
        assert!(
            frame.contains("ui scroll down 1"),
            "the defaults should still be listed: {frame}"
        );
        assert!(
            !frame.contains("fullscreen image viewer"),
            "the overlay should not describe a key that was unbound: {frame}"
        );
        assert!(
            frame.contains("Ctrl+C"),
            "reserved keys are not in the keymap, so the overlay states them: {frame}"
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
        let PaletteMode::Submenu(submenu) = &h.app.completion.mode else {
            panic!("expected setting reset submenu");
        };
        assert_eq!(submenu.parent, "setting:reset");
        h.type_str("temperature");
        let action = h.press_action(KeyCode::Enter);

        assert_set_model_setting(action, "temperature", &serde_json::Value::Null);
    }

    #[test]
    fn scenario_scroll_during_stream() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        for i in 0..20 {
            h.app.entries.push(ConversationEntry::user(
                format!("Message {i}"),
                vec![],
                format!("t{i}"),
            ));
            h.app.entries.push(ConversationEntry::assistant(
                None,
                format!("Reply {i}"),
                vec![],
                format!("r{i}"),
                None,
            ));
        }

        let _ = h.render("many messages - auto scroll");

        h.stream_start();
        h.stream_chunk("New streaming response...");
        let streaming_frame = h.render("streaming with auto_scroll");
        assert!(
            streaming_frame.contains("New streaming response"),
            "latest content visible with auto_scroll"
        );

        h.press_mod(KeyModifiers::CONTROL, KeyCode::Char('u'));
        let _ = h.render("scrolled up");
        assert!(!h.app.auto_scroll, "auto_scroll disabled after scroll up");

        h.stream_chunk(" More text arrives.");
        let _f = h.render("chunk while scrolled up");

        h.app.input.mode = InputMode::Normal;
        h.press_mod(KeyModifiers::SHIFT, KeyCode::Char('G'));
        let bottom_frame = h.render("back to bottom");
        assert!(h.app.auto_scroll, "auto_scroll re-enabled");
        assert!(
            bottom_frame.contains("More text arrives"),
            "latest content visible after re-scroll"
        );
    }

    fn top_rows(frame: &str, count: usize) -> Vec<&str> {
        frame.lines().take(count).collect()
    }

    #[test]
    fn scenario_scrolled_up_viewport_holds_while_stream_appends() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        for i in 0..20 {
            h.app.entries.push(ConversationEntry::user(
                format!("Message {i}"),
                vec![],
                format!("t{i}"),
            ));
            h.app.entries.push(ConversationEntry::assistant(
                None,
                format!("Reply {i}"),
                vec![],
                format!("r{i}"),
                None,
            ));
        }

        h.stream_start();
        h.stream_chunk("First chunk of the answer.");
        let _ = h.render("streaming pinned to bottom");

        h.app.scroll_up(10);
        let before = h.render_with_blank_rows("scrolled up mid-stream");
        let reach_before = h.app.conversation_max_scroll;

        h.stream_chunk("\nsecond line\nthird line\nfourth line\nfifth line");
        let after = h.render_with_blank_rows("stream appended while scrolled up");

        assert!(
            h.app.conversation_max_scroll > reach_before,
            "the appended chunk should have made the conversation taller"
        );
        assert_eq!(
            top_rows(&before, 20),
            top_rows(&after, 20),
            "text under a scrolled-up viewport should not move when the stream appends\nbefore:\n{before}\nafter:\n{after}"
        );

        let reach_after_text = h.app.conversation_max_scroll;
        h.app.stream_push_tool_call(
            "call-1".into(),
            "read_file".into(),
            serde_json::json!({"path": "/tmp/notes.txt"}),
        );
        h.app.stream_push_tool_result(
            "call-1".into(),
            "read_file".into(),
            "line one\nline two\nline three".into(),
            false,
        );
        let after_tools = h.render_with_blank_rows("tool loop advanced while scrolled up");

        assert!(
            h.app.conversation_max_scroll > reach_after_text,
            "the tool call and result should have made the conversation taller"
        );
        assert_eq!(
            top_rows(&before, 20),
            top_rows(&after_tools, 20),
            "a tool call and its result should not move a scrolled-up viewport either\nbefore:\n{before}\nafter:\n{after_tools}"
        );
    }

    #[test]
    fn scenario_scrolled_up_viewport_holds_when_stream_completes() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        for i in 0..20 {
            h.app.entries.push(ConversationEntry::user(
                format!("Message {i}"),
                vec![],
                format!("t{i}"),
            ));
            h.app.entries.push(ConversationEntry::assistant(
                None,
                format!("Reply {i}"),
                vec![],
                format!("r{i}"),
                None,
            ));
        }

        h.stream_start();
        h.stream_chunk("First chunk of the answer.");
        let _ = h.render("streaming pinned to bottom");

        h.app.scroll_up(10);
        let before = h.render_with_blank_rows("scrolled up mid-stream");

        h.stream_chunk("\nsecond line\nthird line");
        let _ = h.render_with_blank_rows("stream appended while scrolled up");

        h.stream_end("final content of the answer");
        let after = h.render_with_blank_rows("stream completed while scrolled up");

        assert_eq!(
            top_rows(&before, 20),
            top_rows(&after, 20),
            "text under a scrolled-up viewport should not move when the stream completes\nbefore:\n{before}\nafter:\n{after}"
        );
    }

    #[test]
    fn scenario_scrolled_up_viewport_holds_when_older_history_is_prepended() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        for i in 0..20 {
            h.app.entries.push(ConversationEntry::user(
                format!("Message {i}"),
                vec![],
                format!("t{i}"),
            ));
            h.app.entries.push(ConversationEntry::assistant(
                None,
                format!("Reply {i}"),
                vec![],
                format!("r{i}"),
                None,
            ));
        }

        let _ = h.render("bottom anchored");
        h.app.scroll_up(500);
        let before = h.render_with_blank_rows("scrolled to the top");

        let page: Vec<serde_json::Value> = (0..6)
            .map(|i| {
                serde_json::json!({
                    "msg_id": format!("old{i}"),
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("Older {i}"),
                    "timestamp": format!("o{i}"),
                })
            })
            .collect();
        crate::tui::prepend_history_page(
            &mut h.app,
            &serde_json::json!({
                "messages": page,
                "has_more_before": false,
            }),
        );

        let after = h.render_with_blank_rows("older page prepended");

        assert_eq!(
            top_rows(&before, 20),
            top_rows(&after, 20),
            "loading older history should push content in above the viewport, not move it\nbefore:\n{before}\nafter:\n{after}"
        );
        assert!(
            !h.app.grew_above_viewport,
            "the prepend marker should be consumed by the redraw that follows it"
        );
    }

    #[test]
    fn scenario_mode_switching() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        let insert_frame = h.render("insert mode");
        assert!(insert_frame.contains("[INSERT]"), "starts in INSERT mode");

        h.press(KeyCode::Esc);
        let normal_frame = h.render("normal mode");
        assert!(normal_frame.contains("[NORMAL]"), "shows NORMAL after Esc");
        assert!(!normal_frame.contains("[INSERT]"), "INSERT label gone");

        h.press(KeyCode::Char('i'));
        let restored_insert_frame = h.render("back to insert");
        assert!(
            restored_insert_frame.contains("[INSERT]"),
            "shows INSERT after 'i'"
        );

        let diffs = h.changed_lines();
        assert!(
            diffs
                .iter()
                .all(|(_, _, curr)| curr.contains("INSERT") || curr.contains("Type a message")),
            "mode switch should only change the input area"
        );
    }

    #[test]
    fn scenario_connection_states() {
        let mut h = Harness::new();

        h.app.connection_status = ConnectionStatus::Disconnected;
        let _ = h.render("disconnected");

        h.app.connection_status = ConnectionStatus::Connecting;
        let _ = h.render("connecting");

        h.app.connection_status = ConnectionStatus::Connected;
        let _ = h.render("connected");
    }

    #[test]
    fn scenario_long_message_wrapping() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        let long_msg = "This is a very long message that should wrap properly across multiple lines in the conversation area without clipping or causing layout issues.";
        h.app.entries.push(ConversationEntry::user(
            long_msg.into(),
            vec![],
            "t1".into(),
        ));

        let long_message_frame = h.render("long message");
        assert!(
            long_message_frame.contains("This is a very long message"),
            "start of message visible"
        );

        h.type_str("Another really long input message that should cause the input area to grow taller as the text wraps to accommodate");
        let long_input_frame = h.render("long input");
        assert!(
            long_input_frame.lines().any(|l| l.contains("taller")),
            "word 'taller' should stay intact on one visual line"
        );
    }

    #[test]
    fn scenario_tool_calls() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Search for foo".into(),
            vec![],
            "t1".into(),
        ));

        h.app.entries.push(assistant_turn(vec![
            tool_use(
                "tc1",
                "web_search",
                serde_json::json!({"query": "foo bar baz"}),
            ),
            tool_result(
                "tc1",
                "web_search",
                "Found 3 results for foo bar baz",
                false,
            ),
        ]));

        let f = h.render("tool call + result");
        assert!(f.contains("▶"), "tool call arrow present");
        assert!(f.contains("web_search"), "tool name present");
        assert!(f.contains("◀"), "tool result arrow present");
    }

    #[test]
    fn scenario_tool_calls_under_assistant_name() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();

        h.app.entries.push(ConversationEntry::user(
            "Search for foo".into(),
            vec![],
            "t1".into(),
        ));
        h.app.entries.push(assistant_turn(vec![
            tool_use("tc1", "web_search", serde_json::json!({"query": "foo"})),
            tool_result("tc1", "web_search", "Result: foo page", false),
            Block::Text("I found foo.".into()),
        ]));

        let f = h.render("tools under assistant name");

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

    #[test]
    fn scenario_subagent_section_visible() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.show_subagent = true;
        h.app.show_tools = false;

        h.app.entries.push(ConversationEntry::user(
            "delegate".into(),
            vec![],
            "t1".into(),
        ));
        h.app.entries.push(assistant_turn(vec![
            Block::SubagentBegin("research".into()),
            Block::Thinking("nested thought".into()),
            tool_use("s1", "web_search", serde_json::json!({"q": "x"})),
            tool_result("s1", "web_search", "nested result", false),
            Block::SubagentEnd("research".into()),
            Block::Text("primary answer".into()),
        ]));

        let f = h.render("subagent visible");
        assert!(
            f.contains("research (sub-agent)"),
            "open header missing:\n{f}"
        );
        assert!(f.contains("research done"), "close header missing:\n{f}");
        assert!(
            f.contains("web_search"),
            "nested tool must show under show_subagent even with show_tools off:\n{f}"
        );
        assert!(f.contains("primary answer"), "primary text missing:\n{f}");
    }

    #[test]
    fn scenario_subagent_section_hidden() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.show_subagent = false;
        h.app.show_tools = true;
        h.app.show_thinking = true;

        h.app.entries.push(assistant_turn(vec![
            Block::SubagentBegin("research".into()),
            Block::Thinking("nested thought".into()),
            tool_use("s1", "web_search", serde_json::json!({"q": "x"})),
            tool_result("s1", "web_search", "nested result", false),
            Block::SubagentEnd("research".into()),
            Block::Text("primary answer".into()),
        ]));

        let f = h.render("subagent hidden");
        assert!(
            !f.contains("(sub-agent)"),
            "open header must be hidden:\n{f}"
        );
        assert!(
            !f.contains("research done"),
            "close header must be hidden:\n{f}"
        );
        assert!(
            !f.contains("nested thought"),
            "nested thinking must hide despite show_thinking:\n{f}"
        );
        assert!(
            !f.contains("web_search"),
            "nested tool must hide despite show_tools:\n{f}"
        );
        assert!(
            f.contains("research · 1 tool (press s)"),
            "collapsed marker must name the sub-agent and its tool count:\n{f}"
        );
        assert!(
            f.contains("primary answer"),
            "primary text must remain:\n{f}"
        );
    }

    #[test]
    fn collapsed_marker_counts_one_section() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.show_subagent = false;
        h.app.show_tools = true;

        h.app.entries.push(assistant_turn(vec![
            tool_use("p1", "ask_research", serde_json::json!({"query": "x"})),
            Block::SubagentBegin("research".into()),
            tool_use("s1", "web_search", serde_json::json!({"q": "x"})),
            tool_result("s1", "web_search", "a", false),
            tool_use("s2", "read", serde_json::json!({"path": "b"})),
            tool_result("s2", "read", "b", false),
            Block::SubagentEnd("research".into()),
            tool_result("p1", "ask_research", "answer", false),
            tool_use("p2", "roll_dice", serde_json::json!({"notation": "1d6"})),
        ]));

        let f = h.render("collapsed marker count");
        assert!(
            f.contains("research · 2 tools (press s)"),
            "marker must count the section's tools, not the turn's:\n{f}"
        );
    }

    #[test]
    fn scenario_thinking_tools_interleaved_order() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.show_thinking = true;
        h.app.show_tools = true;

        h.app.entries.push(ConversationEntry::user(
            "do the thing".into(),
            vec![],
            "t1".into(),
        ));
        h.app.entries.push(assistant_turn(vec![
            Block::Thinking("FIRST_THOUGHT".into()),
            tool_use("tc1", "ALPHA_TOOL", serde_json::json!({"q": "x"})),
            tool_result("tc1", "ALPHA_TOOL", "alpha done", false),
            Block::Thinking("SECOND_THOUGHT".into()),
            tool_use("tc2", "BETA_TOOL", serde_json::json!({"q": "y"})),
            tool_result("tc2", "BETA_TOOL", "beta done", false),
            Block::Text("FINAL_ANSWER".into()),
        ]));

        let f = h.render("interleaved thinking and tools");
        let lines: Vec<&str> = f.lines().collect();
        let pos = |needle: &str| {
            lines
                .iter()
                .position(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("{needle:?} must appear\n{f}"))
        };

        let order = [
            pos("FIRST_THOUGHT"),
            pos("ALPHA_TOOL"),
            pos("SECOND_THOUGHT"),
            pos("BETA_TOOL"),
            pos("FINAL_ANSWER"),
        ];
        assert!(
            order
                .windows(2)
                .all(|window| matches!(window, [first, second] if first < second)),
            "thinking/tool/text must render in interleaved source order, got positions {order:?}\n{f}"
        );
    }

    #[test]
    fn scenario_streaming_thinking_committed_before_tool_call() {
        use shore_common::protocol::server_msg::{
            ServerMessage, StreamChunk, StreamEnd, StreamStart, ToolCall,
        };
        use shore_common::protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

        let meta = StreamMetadata {
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

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();
        h.app.show_thinking = true;
        h.app.show_tools = true;
        h.app
            .entries
            .push(ConversationEntry::user("hi".into(), vec![], "t1".into()));

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: "PHASE1_THOUGHT".into(),
                content_type: "thinking".into(),
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: String::new(),
                metadata: meta.clone(),
                finish_reason: "tool_use".into(),
                is_final: false,
            }),
        );

        assert!(
            h.app
                .entries
                .iter()
                .filter_map(ConversationEntry::as_turn)
                .any(|t| t
                    .blocks
                    .iter()
                    .any(|b| matches!(b, Block::Thinking(c) if c == "PHASE1_THOUGHT"))),
            "phase-1 thinking must be committed on tool_use phase end"
        );

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                subagent: None,
                task_id: None,
                rid: None,
                tool_id: "tc1".into(),
                tool_name: "memory_search".into(),
                input: serde_json::json!({"query": "x"}),
            }),
        );

        let f = h.render("mid tool-use turn");
        let lines: Vec<&str> = f.lines().collect();
        assert_eq!(
            lines
                .iter()
                .filter(|l| l.contains("PHASE1_THOUGHT"))
                .count(),
            1,
            "thinking must render exactly once (no duplication)\n{f}"
        );
        let think_line = lines
            .iter()
            .position(|l| l.contains("PHASE1_THOUGHT"))
            .expect("thinking must appear");
        let tool_line = lines
            .iter()
            .position(|l| l.contains("memory_search"))
            .expect("tool call must appear");
        assert!(
            think_line < tool_line,
            "phase-1 thinking must render above the tool call\n{f}"
        );
    }

    #[test]
    fn scenario_tool_use_multi_phase_single_header() {
        use shore_common::protocol::server_msg::{
            ServerMessage, StreamChunk, StreamEnd, StreamStart, ToolCall, ToolResult,
        };
        use shore_common::protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

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

        h.app.entries.push(ConversationEntry::user(
            "hi qifei.".into(),
            vec![],
            "t1".into(),
        ));

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: String::new(),
                metadata: meta_phase_1.clone(),
                finish_reason: "tool_use".into(),
                is_final: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                subagent: None,
                task_id: None,
                rid: None,
                tool_id: "tc1".into(),
                tool_name: "memory_search".into(),
                input: serde_json::json!({"query": "Ren"}),
            }),
        );

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

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolResult(ToolResult {
                subagent: None,
                task_id: None,
                rid: None,
                tool_id: "tc1".into(),
                tool_name: "memory_search".into(),
                output: "{}".into(),
                is_error: false,
            }),
        );

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: "hey! what's up?".into(),
                content_type: "text".into(),
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
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

        let header_count = f.lines().filter(|l| l.trim_end() == "qifei").count();
        assert_eq!(
            header_count, 1,
            "exactly one 'qifei' header after turn; got {header_count}\n{f}"
        );

        assert!(
            f.contains("hey! what's up?"),
            "final response text missing\n{f}"
        );

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
        let timing_expected = format_duration_ms(u64::from(expected_total_ms));
        assert!(
            f.contains(&timing_expected),
            "expected summed timing '{timing_expected}' in frame\n{f}"
        );

        assert!(
            !h.app.stream.active,
            "stream must be inactive after end_turn"
        );
        let last_turn = h
            .app
            .entries
            .iter()
            .rev()
            .find_map(ConversationEntry::as_turn)
            .expect("an assistant turn must exist");
        assert!(
            !last_turn.is_streaming(),
            "turn must be Complete after end_turn"
        );
        assert_eq!(
            last_turn.metadata.as_ref().map(|m| m.tokens.input),
            Some(expected_input),
            "finalized turn must carry summed input tokens"
        );
    }

    #[test]
    fn scenario_interleaved_text_tool_text_single_header() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();

        h.app
            .entries
            .push(ConversationEntry::user("do it".into(), vec![], "t1".into()));
        h.app.entries.push(assistant_turn(vec![
            Block::Text("PRETOOL_TEXT".into()),
            tool_use("tc1", "do_tool", serde_json::json!({"x": 1})),
            tool_result("tc1", "do_tool", "ok", false),
            Block::Text("POSTTOOL_TEXT".into()),
        ]));

        let f = h.render("text → tool → text");
        let lines: Vec<&str> = f.lines().collect();
        let pos = |n: &str| {
            lines
                .iter()
                .position(|l| l.contains(n))
                .unwrap_or_else(|| panic!("{n:?} must appear\n{f}"))
        };
        assert_eq!(
            lines.iter().filter(|l| l.trim_end() == "Alice").count(),
            1,
            "exactly one header for the whole turn\n{f}"
        );
        let order = [
            pos("Alice"),
            pos("PRETOOL_TEXT"),
            pos("do_tool"),
            pos("POSTTOOL_TEXT"),
        ];
        assert!(
            order
                .windows(2)
                .all(|window| matches!(window, [first, second] if first < second)),
            "text→tool→text must render in source order under one header, got {order:?}\n{f}"
        );
    }

    #[test]
    fn scenario_pre_tool_text_streams_live_and_persists() {
        use shore_common::protocol::server_msg::{
            ServerMessage, StreamChunk, StreamEnd, StreamStart, ToolCall,
        };
        use shore_common::protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

        let meta = StreamMetadata {
            model: "m".into(),
            tokens: TokenCounts {
                input: 1,
                output: 1,
                cache_read: 0,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 1,
                ttft_ms: 1,
            },
        };

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app
            .entries
            .push(ConversationEntry::user("hi".into(), vec![], "t1".into()));

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: "PRETOOL_LIVE".into(),
                content_type: "text".into(),
            }),
        );
        let f1 = h.render("pre-tool streaming text");
        assert!(
            f1.contains("PRETOOL_LIVE"),
            "pre-tool text must stream live\n{f1}"
        );

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: String::new(),
                metadata: meta.clone(),
                finish_reason: "tool_use".into(),
                is_final: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::ToolCall(ToolCall {
                subagent: None,
                task_id: None,
                rid: None,
                tool_id: "tc1".into(),
                tool_name: "do_tool".into(),
                input: serde_json::json!({}),
            }),
        );

        let f2 = h.render("after tool call");
        let lines: Vec<&str> = f2.lines().collect();
        let text_line = lines
            .iter()
            .position(|l| l.contains("PRETOOL_LIVE"))
            .unwrap_or_else(|| panic!("pre-tool text must persist past the phase boundary\n{f2}"));
        let tool_line = lines
            .iter()
            .position(|l| l.contains("do_tool"))
            .expect("tool call must appear");
        assert!(
            text_line < tool_line,
            "pre-tool text must stay above the tool call\n{f2}"
        );
    }

    #[test]
    fn scenario_narrow_terminal() {
        let mut h = Harness::with_size(40, 20);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.model = "claude-3-opus".into();

        h.app.entries.push(ConversationEntry::user(
            "Hi there!".into(),
            vec![],
            "t1".into(),
        ));

        let f = h.render("narrow terminal");
        assert!(f.contains("You"), "user label visible in narrow");
        assert!(f.contains("Hi there!"), "message visible in narrow");
    }

    #[test]
    fn scenario_zero_sized_terminal() {
        for (width, height) in [(0, 0), (0, 1), (1, 0)] {
            let mut harness = Harness::with_size(width, height);
            let frame = harness.render("zero-sized terminal axis");

            assert_eq!(frame.lines().count(), usize::from(height));
        }
    }

    #[test]
    fn scenario_stream_to_final_transition() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Tell me a story".into(),
            vec![],
            "t1".into(),
        ));

        h.stream_start();
        h.stream_chunk("Once upon a time, there was a brave knight.");
        let f_streaming = h.render("during stream");

        h.stream_end("Once upon a time, there was a brave knight.");
        let f_final = h.render("after stream end");

        let story_line_streaming = f_streaming
            .lines()
            .enumerate()
            .find(|(_, l)| l.contains("Once upon a time"));
        let story_line_final = f_final
            .lines()
            .enumerate()
            .find(|(_, l)| l.contains("Once upon a time"));

        if let (Some((ls, _)), Some((lf, _))) = (story_line_streaming, story_line_final) {
            let jump = ls.abs_diff(lf);
            eprintln!("Story line position: streaming=L{ls}, final=L{lf}, jump={jump}");
            assert!(
                jump <= 1,
                "content should not jump more than 1 line during stream→final transition (jumped {jump})"
            );
        }
    }

    #[test]
    fn scenario_history_then_stream_end_no_duplicate() {
        use shore_common::protocol::server_msg::{
            History, ServerMessage, StreamChunk, StreamEnd, StreamStart,
        };
        use shore_common::protocol::types::{
            ContentBlock, Message, Role, StreamMetadata, TimingInfo, TokenCounts,
        };

        let reply = "the sea is calm tonight.";

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();
        h.app.entries.push(ConversationEntry::user(
            "describe the sea".into(),
            vec![],
            "t1".into(),
        ));

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: reply.into(),
                content_type: "text".into(),
            }),
        );

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
            provider_key: None,
            model: None,
            origin: None,
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
                provider_key: None,
                model: None,
                origin: None,
            },
            persisted_assistant,
        ];
        let _ = crate::tui::handle_server_message(
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
        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
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
            .filter(|e| matches!(e.as_turn(), Some(t) if t.role == Role::Assistant))
            .count();
        assert_eq!(
            assistant_count, 1,
            "History-then-StreamEnd must leave exactly one Assistant entry, got {assistant_count}: {:#?}",
            h.app.entries
        );

        let attached_meta = h
            .app
            .entries
            .iter()
            .rev()
            .find_map(ConversationEntry::as_turn)
            .filter(|t| t.role == Role::Assistant)
            .and_then(|t| t.metadata.clone());
        assert!(
            attached_meta.is_some(),
            "StreamEnd metadata must be attached to the assistant entry"
        );
        let attached = attached_meta.unwrap();
        assert_eq!(attached.tokens.input, meta.tokens.input);
        assert_eq!(attached.tokens.output, meta.tokens.output);

        let f = h.render("after history + stream_end");
        assert_eq!(
            f.matches(reply).count(),
            1,
            "reply text must appear exactly once on screen\n{f}"
        );
    }

    #[test]
    fn scenario_history_during_stream_does_not_reopen_prior_reply() {
        use shore_common::protocol::server_msg::{History, ServerMessage, StreamStart};
        use shore_common::protocol::types::{ContentBlock, Message, Role};

        let msg = |id: &str, role: Role, text: &str| Message {
            msg_id: id.into(),
            role,
            content: text.into(),
            images: vec![],
            content_blocks: vec![ContentBlock::Text { text: text.into() }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            timestamp: "t".into(),
            provider_key: None,
            model: None,
            origin: None,
        };

        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "qifei".into();

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::History(History {
                rid: None,
                messages: vec![
                    msg("m_0", Role::User, "first question"),
                    msg("m_1", Role::Assistant, "PRIOR_REPLY"),
                    msg("m_2", Role::User, "second question"),
                ],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: None,
                revision: 1,
            }),
        );

        let prior = h
            .app
            .entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .find(|t| t.msg_id.as_deref() == Some("m_1"))
            .expect("prior assistant turn present");
        assert!(
            !prior.is_streaming(),
            "the previous completed reply must not be reopened as the in-flight turn"
        );
        assert!(
            h.app
                .entries
                .iter()
                .filter_map(ConversationEntry::as_turn)
                .all(|t| !t.is_streaming()),
            "no committed turn should be marked Streaming"
        );
        assert!(h.app.stream.active, "the stream is still in flight");
    }

    #[test]
    fn scenario_history_then_stream_end_long_reply_stays_bottom_anchored() {
        use shore_common::protocol::server_msg::{
            History, ServerMessage, StreamChunk, StreamEnd, StreamStart,
        };
        use shore_common::protocol::types::{
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
        h.app.entries.push(ConversationEntry::user(
            "write a long answer".into(),
            vec![],
            "t1".into(),
        ));

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
        );
        for chunk in reply.as_bytes().chunks(96) {
            let _ = crate::tui::handle_server_message(
                &mut h.app,
                ServerMessage::StreamChunk(StreamChunk {
                    subagent: None,
                    task_id: None,
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
                provider_key: None,
                model: None,
                origin: None,
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
                provider_key: None,
                model: None,
                origin: None,
            },
        ];
        let _ = crate::tui::handle_server_message(
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

        let _ = crate::tui::handle_server_message(
            &mut h.app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
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
        h.app.entries.push(ConversationEntry::user(
            "run a tool and summarize".into(),
            vec![],
            "t1".into(),
        ));
        h.app.entries.push(ConversationEntry::Turn(Turn {
            role: Role::Assistant,
            msg_id: None,
            blocks: vec![
                Block::ToolUse {
                    tool_id: "toolu_1".into(),
                    tool_name: "long_tool".into(),
                    input: serde_json::json!({
                        "path": "/tmp/0123456789abcdef0123456789abcdef0123456789abcdef"
                    }),
                },
                Block::ToolResult {
                    tool_id: "toolu_1".into(),
                    tool_name: "long_tool".into(),
                    output: long_tool_output,
                    is_error: false,
                },
                Block::Text(format!("summary line\n{tail}")),
            ],
            images: vec![],
            timestamp: "t2".into(),
            state: TurnState::Complete,
            metadata: None,
        }));

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

    #[test]
    fn scenario_send_to_stream_latency() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.type_str("Quick question");
        h.press(KeyCode::Enter);
        h.app.entries.push(ConversationEntry::user(
            "Quick question".into(),
            vec![],
            "t1".into(),
        ));
        let f_sent = h.render("just sent");

        assert!(
            f_sent.contains("···"),
            "typing indicator should appear immediately after send"
        );

        h.stream_start();
        let _ = h.render("stream started, no text yet");

        h.stream_chunk("The answer is...");
        let _f_first = h.render("first chunk arrives");

        let diffs = h.changed_lines();
        eprintln!("Lines changed on first chunk arrival: {}", diffs.len());
        for (i, _prev, curr) in &diffs {
            eprintln!("  L{i}: → {curr:?}");
        }
    }

    #[test]
    fn scenario_input_growth() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.type_str("line 1");
        let _ = h.render("1 line input");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 2");
        let _ = h.render("2 line input");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 3");
        let _ = h.render("3 line input");

        for i in 4..=7 {
            h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
            h.type_str(&format!("line {i}"));
        }
        let _near_max_frame = h.render("7 line input (near max)");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 8");
        let _max_frame = h.render("8 line input (at max)");

        h.press_mod(KeyModifiers::SHIFT, KeyCode::Enter);
        h.type_str("line 9");
        let f = h.render("9 line input (past max)");

        assert!(
            f.contains("Press i"),
            "conversation still visible at max input height"
        );
    }

    #[test]
    fn scenario_empty_state_welcome() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        let welcome_frame = h.render("empty with welcome");
        assert!(
            welcome_frame.contains("Press i to start typing"),
            "welcome hint should appear when no messages"
        );
        assert!(
            welcome_frame.contains("for commands"),
            "command hint should appear"
        );

        h.app
            .entries
            .push(ConversationEntry::user("Hello".into(), vec![], "t1".into()));
        let message_frame = h.render("with message");
        assert!(
            !message_frame.contains("Press i to start typing"),
            "welcome hint should disappear once there are messages"
        );
    }

    #[test]
    fn scenario_scroll_indicator() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();

        for i in 0..20 {
            h.app.entries.push(ConversationEntry::user(
                format!("Msg {i}"),
                vec![],
                format!("t{i}"),
            ));
        }

        let bottom_frame = h.render("at bottom");
        assert!(
            bottom_frame.contains("Msg 19"),
            "latest message visible at bottom"
        );

        h.app.scroll_up(5);
        let scrolled_frame = h.render("scrolled up");
        assert!(
            !scrolled_frame.contains("Msg 19"),
            "latest message not visible when scrolled up"
        );

        h.app.scroll_to_bottom();
        let restored_bottom_frame = h.render("back at bottom");
        assert!(
            restored_bottom_frame.contains("Msg 19"),
            "latest message visible after scrolling back"
        );
    }

    #[test]
    fn scenario_line_by_line_scroll_repaints_unique_rows() {
        fn visible_unique_rows(frame: &str) -> Vec<String> {
            frame
                .lines()
                .filter_map(|line| line.trim().strip_prefix("unique row "))
                .map(str::to_owned)
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

        let mut h = Harness::with_size(48, 16);
        h.app.connection_status = ConnectionStatus::Connected;

        for i in 0..45 {
            h.app.entries.push(ConversationEntry::user(
                format!("unique row {i:02}"),
                vec![],
                format!("t{i}"),
            ));
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

    #[test]
    fn scenario_input_placeholder() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        let empty_insert_frame = h.render("empty insert mode");
        assert!(
            empty_insert_frame.contains("Type a message"),
            "placeholder should show when input is empty"
        );

        h.type_str("h");
        let typed_frame = h.render("after typing one char");
        assert!(
            !typed_frame.contains("Type a message"),
            "placeholder should disappear when typing"
        );

        h.press(KeyCode::Backspace);
        h.press(KeyCode::Esc);
        let empty_normal_frame = h.render("normal mode empty");
        assert!(
            !empty_normal_frame.contains("Type a message"),
            "placeholder should not show in normal mode"
        );
    }

    #[test]
    fn scenario_phase_display() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.stream_start();
        let empty_stream_frame = h.render("streaming, no phase");
        assert!(
            empty_stream_frame.contains("···"),
            "typing indicator visible during stream"
        );

        h.stream_chunk("Hello!");
        let text_stream_frame = h.render("streaming with text");
        assert!(
            text_stream_frame.contains("Hello!"),
            "streamed text visible"
        );
    }

    #[test]
    fn scenario_very_short_terminal() {
        let mut h = Harness::with_size(60, 10);
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Bob".into();

        h.app
            .entries
            .push(ConversationEntry::user("Hello".into(), vec![], "t1".into()));
        h.app.entries.push(ConversationEntry::assistant(
            None,
            "Hi there!".into(),
            vec![],
            "t2".into(),
            None,
        ));

        let short_message_frame = h.render("short terminal with messages");
        assert!(
            short_message_frame.contains("Bob"),
            "character name in assistant entry"
        );
        assert!(
            short_message_frame.contains("[INSERT]"),
            "input mode indicator visible"
        );

        h.stream_start();
        h.stream_chunk("Response text");
        let short_stream_frame = h.render("streaming in short terminal");
        assert!(
            short_stream_frame.contains("Response"),
            "streamed content visible in short terminal"
        );
    }

    #[test]
    fn scenario_multiple_tool_calls() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Search and summarize".into(),
            vec![],
            "t1".into(),
        ));

        h.app.entries.push(assistant_turn(vec![
            tool_use(
                "tc1",
                "web_search",
                serde_json::json!({"query": "rust tui frameworks"}),
            ),
            tool_result(
                "tc1",
                "web_search",
                "Found: ratatui, cursive, tui-rs",
                false,
            ),
            tool_use(
                "tc2",
                "read_page",
                serde_json::json!({"url": "https://ratatui.rs"}),
            ),
            tool_result(
                "tc2",
                "read_page",
                "Ratatui is a Rust library for building terminal UIs",
                false,
            ),
            tool_use(
                "tc3",
                "read_page",
                serde_json::json!({"url": "https://404.example.com"}),
            ),
            tool_result("tc3", "read_page", "404 Not Found", true),
        ]));

        let f = h.render("multiple tool calls");
        assert!(f.contains("web_search"), "first tool call visible");
        assert!(f.contains("read_page"), "second tool call visible");
        assert!(f.contains("404 Not Found"), "error result visible");
        let arrow_count = f.matches('▶').count();
        assert_eq!(arrow_count, 3, "should have 3 tool call arrows");
        let result_count = f.matches('◀').count();
        assert_eq!(result_count, 3, "should have 3 result arrows");
    }

    #[test]
    fn scenario_cursor_wrapping() {
        let mut h = Harness::with_size(30, 15);
        h.app.connection_status = ConnectionStatus::Connected;

        h.type_str("abcdefghijklmnopqrstuvwxyz12345678");
        let f = h.render("wrapped input text");

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

    #[test]
    fn scenario_cursor_at_exact_boundary() {
        let mut h = Harness::with_size(30, 15);
        h.app.connection_status = ConnectionStatus::Connected;

        let exact_line = "a".repeat(30);
        h.type_str(&exact_line);
        let _f = h.render("cursor at exact boundary");

        h.type_str("x");
        let f = h.render("one char past boundary");
        let has_wrapped_x = f.lines().any(|l| l.starts_with('x'));
        assert!(
            has_wrapped_x,
            "character after boundary should appear on new wrapped line"
        );
    }

    #[test]
    fn scenario_optimistic_user_echo() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.type_str("hello world");
        h.press(KeyCode::Enter);
        let f = h.render("after send");

        assert!(
            f.contains("hello world"),
            "user's message should be visible immediately after send"
        );
        assert!(f.contains("You"), "user label should be visible");
        assert!(
            f.contains("···"),
            "typing indicator should show alongside user message"
        );
    }

    #[test]
    fn scenario_thinking_not_duplicated() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Alice".into();
        h.app.show_thinking = true;

        h.app
            .entries
            .push(ConversationEntry::user("hi".into(), vec![], "t1".into()));

        h.stream_start();
        h.thinking_chunk("thinking about ");
        h.thinking_chunk("response");

        let thinking_blocks = h
            .app
            .entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .flat_map(|t| t.blocks.iter())
            .filter(|b| matches!(b, Block::Thinking(_)))
            .count();
        assert_eq!(
            thinking_blocks, 1,
            "thinking deltas must merge into one block"
        );

        let f = h.render("streaming thinking");
        let occurrences = f.matches("thinking about response").count();
        assert_eq!(
            occurrences, 1,
            "streamed thinking must render exactly once, found {occurrences}\n{f}"
        );
    }

    #[test]
    fn scenario_regeneration() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Tell me a joke".into(),
            vec![],
            "t1".into(),
        ));
        h.app.entries.push(ConversationEntry::assistant(
            None,
            "Why did the chicken cross the road?".into(),
            vec![],
            "t2".into(),
            None,
        ));

        let before_regen = h.render("before regen");
        assert!(
            before_regen.contains("chicken"),
            "original response visible"
        );

        h.app.stream.reset();
        h.app.stream.active = true;
        h.app.stream.regen = true;
        if let Some(pos) = h
            .app
            .entries
            .iter()
            .rposition(|e| matches!(e.as_turn(), Some(t) if t.role == Role::Assistant))
        {
            h.app.entries.truncate(pos);
        }

        let regen_started = h.render("regen started");
        assert!(
            !regen_started.contains("chicken"),
            "original response should be removed during regen"
        );

        h.stream_chunk("A better joke: ");
        let regen_streaming = h.render("regen streaming");
        assert!(
            regen_streaming.contains("(regenerating)"),
            "should show regen indicator"
        );
        assert!(
            regen_streaming.contains("A better joke"),
            "new response streaming"
        );

        h.stream_end("A better joke: Why do programmers prefer dark mode?");
        let regen_complete = h.render("regen complete");
        assert!(
            regen_complete.contains("dark mode"),
            "regenerated response visible"
        );
        assert!(
            !regen_complete.contains("regenerating"),
            "regen indicator gone after completion"
        );
    }

    #[test]
    fn scenario_code_blocks() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::assistant(None, "Here's some code:\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\nThat should work.".into(), vec![], "t1".into(), None));

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

        h.app.entries.push(ConversationEntry::assistant(
            None,
            "First paragraph.\n\nSecond paragraph.".into(),
            vec![],
            "t1".into(),
            None,
        ));

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
            first.saturating_add(2),
            "paragraphs should have one visible blank row between them\n{f}"
        );
        assert!(
            rows.get(first.saturating_add(1))
                .is_some_and(|row| row.trim().is_empty()),
            "row between paragraphs should be visually blank\n{f}"
        );
    }

    #[test]
    fn scenario_reported_markdown_elements_render() {
        let mut h = Harness::with_size(44, 24);
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::assistant(
            None,
            concat!(
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
            vec![],
            "t1".into(),
            None,
        ));

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

        let mut h2 = Harness::with_size(50, 20);
        h2.app = App {
            connection_status: ConnectionStatus::Connected,
            character_name: "Alice".into(),
            ..App::default()
        };
        h2.app.set_status("loaded");
        let _ = h2.render("narrow terminal with status");
    }

    #[test]
    fn scenario_dynamic_title() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.character_name = "Luna".into();
        h.app.entries.push(ConversationEntry::assistant(
            None,
            "Hello!".into(),
            vec![],
            "t1".into(),
            None,
        ));
        let f = h.render("with character");
        assert!(
            f.contains("Luna"),
            "character name shown in assistant entry"
        );
    }

    #[test]
    fn scenario_system_messages() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::System {
            content: "Memory updated: user prefers dark themes".into(),
            count: 1,
            timestamp: "t1".into(),
        });
        h.app.entries.push(ConversationEntry::user(
            "Thanks".into(),
            vec![],
            "t2".into(),
        ));

        let f = h.render("system message");
        assert!(f.contains("System"), "system label visible");
        assert!(f.contains("Memory updated"), "system content visible");
        assert!(f.contains("You"), "user message after system");
    }

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

    #[test]
    fn scenario_notification_toast_overlay() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.entries.push(ConversationEntry::assistant(
            None,
            "Here is a long answer that fills the conversation area.".into(),
            vec![],
            "t1".into(),
            None,
        ));

        h.app.set_error("error: rate_limit - too many requests");
        let f = h.render("error toast");
        assert!(f.contains("rate_limit"), "toast content visible");
        assert!(f.contains('✖'), "error icon visible");
        assert!(f.contains("long answer"), "conversation still visible");
    }

    #[test]
    fn scenario_notification_toast_shows_dedupe_count() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.set_status("reconnecting: connection lost");
        h.app.set_status("reconnecting: connection lost");
        h.app.set_status("reconnecting: connection lost");

        let f = h.render("deduped toast");
        assert!(f.contains("reconnecting"), "toast content visible");
        assert!(f.contains("(×3)"), "repeated toast shows a ×N count");
    }

    #[test]
    fn scenario_escape_dismisses_one_toast_at_a_time_in_normal_mode() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.input.mode = crate::tui::app::InputMode::Normal;
        h.app.set_status("first notice");
        h.app.set_error("error: second notice");
        assert_eq!(h.app.notifications.len(), 2);

        let first_escape = h.press_action(KeyCode::Esc);
        assert!(matches!(first_escape, input::Action::Redraw));
        assert_eq!(h.app.notifications.len(), 1);
        let f = h.render("after first esc");
        assert!(f.contains("first notice"), "older toast still visible");
        assert!(!f.contains("second notice"), "newest toast dismissed");

        h.press(KeyCode::Esc);
        assert!(h.app.notifications.is_empty(), "all toasts dismissed");

        let final_escape = h.press_action(KeyCode::Esc);
        assert!(matches!(final_escape, input::Action::None));
    }

    #[test]
    fn scenario_escape_in_insert_mode_leaves_toasts_alone() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        assert_eq!(h.app.input.mode, crate::tui::app::InputMode::Insert);
        h.app.set_error("error: second notice");
        assert_eq!(h.app.notifications.len(), 1);

        h.press(KeyCode::Esc);
        assert_eq!(h.app.input.mode, crate::tui::app::InputMode::Normal);
        assert_eq!(
            h.app.notifications.len(),
            1,
            "toast untouched by insert-mode Esc"
        );
    }

    #[test]
    fn scenario_error_during_stream() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Do something".into(),
            vec![],
            "t1".into(),
        ));

        h.stream_start();
        h.stream_chunk("Starting to respond...");
        let _ = h.render("streaming");

        h.app.abort_stream();
        h.app.set_status("error: rate_limit - Too many requests");

        let f = h.render("after error");
        assert!(
            !f.contains("[streaming...]"),
            "streaming indicator gone after error"
        );
        assert!(f.contains("rate_limit"), "error visible as system entry");
        assert!(
            !f.contains("Starting to respond"),
            "partial stream text gone after reset"
        );
    }

    #[test]
    fn scenario_reconnect_during_stream() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;

        h.app.entries.push(ConversationEntry::user(
            "Long question".into(),
            vec![],
            "t1".into(),
        ));

        h.stream_start();
        h.stream_chunk("Partial response that gets cut off because");
        let _ = h.render("streaming before disconnect");

        h.app.connection_status = ConnectionStatus::Connecting;
        h.app.abort_stream();
        h.app.set_status("reconnecting: connection lost");

        let f = h.render("disconnected while streaming");
        assert!(
            f.contains("reconnecting"),
            "reconnection status visible as system entry"
        );
        assert!(
            !f.contains("[streaming...]"),
            "streaming indicator cleared on disconnect"
        );
        assert!(
            !f.contains("Partial response"),
            "partial stream text cleared on disconnect"
        );
    }

    #[test]
    fn scenario_rapid_exchange() {
        let mut h = Harness::new();
        h.app.connection_status = ConnectionStatus::Connected;
        h.app.character_name = "Bot".into();

        for i in 0..5 {
            h.app.entries.push(ConversationEntry::user(
                format!("Q{i}: What about this?"),
                vec![],
                format!("u{i}"),
            ));
            h.app.entries.push(ConversationEntry::assistant(
                None,
                format!("A{i}: Here's my answer to that particular question."),
                vec![],
                format!("a{i}"),
                None,
            ));
        }

        let f = h.render("rapid exchange");
        assert!(f.contains("Q4"), "most recent user message visible");
        assert!(f.contains("A4"), "most recent response visible");

        let _f2 = h.render("same state re-render");
        let diffs = h.changed_lines();
        assert_eq!(
            diffs.len(),
            0,
            "re-rendering same state should produce identical frame"
        );
    }
}
