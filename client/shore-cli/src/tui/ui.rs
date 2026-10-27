use chrono::{DateTime, Local};
use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph, Wrap};
use shore_common::duration::format_duration_ms;
use shore_common::protocol::tool_display::{format_tool_input, format_tool_output};
use shore_common::protocol::types::Role;

use crate::tui::app::{
    AltChoice, App, Block as TurnBlock, CompactionRun, ConversationEntry, InputMode, PaletteMode,
    SegmentView, Turn, ValueEditorKind, format_elapsed,
};
use crate::tui::images;
use crate::tui::keymap::Scope;
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
    let show_config_panel = config_panel_is_open(app);
    let show_completions = app.input.mode == InputMode::Command
        && !confirming
        && !show_config_panel
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

    if app.subagent_panel.is_some()
        || app.output_pager.is_some()
        || app.show_help
        || show_config_panel
    {
        recede(frame, conversation_area);
    }

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

    if show_config_panel {
        draw_config_panel(frame, app, conversation_area);
    }

    if app.subagent_panel.is_some() {
        draw_subagent_panel(frame, app, size);
    }

    if app.output_pager.is_some() {
        draw_output_pager(frame, app, size);
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

    let dismiss_hint = if matches!(app.input.mode, InputMode::Insert) {
        "esc esc to dismiss"
    } else {
        "esc to dismiss"
    };

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
        let mut lines: Vec<Line<'static>> = wrapped
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

        if notif.sticky {
            lines.push(Line::from(vec![
                Span::raw("   "),
                Span::styled(
                    dismiss_hint.to_owned(),
                    Style::default().fg(color).add_modifier(Modifier::DIM),
                ),
            ]));
        }

        let box_h = usize_to_u16(lines.len()).saturating_add(2);
        if next_top.saturating_add(box_h) > area.y.saturating_add(area.height) {
            break;
        }
        let box_y = next_top;
        let rect = Rect::new(box_x, box_y, box_w, box_h);

        let mut block = Block::default()
            .borders(Borders::ALL)
            .border_type(if notif.sticky {
                BorderType::Double
            } else {
                BorderType::Rounded
            })
            .border_style(if notif.sticky {
                style.add_modifier(Modifier::BOLD)
            } else {
                style
            });
        if notif.sticky {
            block = block.title(Span::styled(
                " generation failed ",
                style.add_modifier(Modifier::BOLD),
            ));
        }
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
        let prose = crate::output::reflow_reasoning(thought);
        push_bar_wrapped(lines, &prose, bar_style, content_style, text_width);
    }
    lines.push(Line::from(""));
}

const SUBAGENT_COLOR: Color = Color::Cyan;

struct ImageRenderer<'view> {
    cache: &'view images::ImageCache,
    show_inline: bool,
    index: &'view mut Vec<crate::tui::app::ImageEntry>,
}

impl ImageRenderer<'_> {
    fn render(
        &mut self,
        lines: &mut Vec<Line<'static>>,
        refs: &[shore_common::protocol::types::ImageRef],
    ) {
        render_images(lines, refs, self.cache, self.show_inline, self.index);
    }
}

fn render_tool_block(
    lines: &mut Vec<Line<'static>>,
    block: &TurnBlock,
    subagent: bool,
    wrap_width: u16,
    image_renderer: &mut ImageRenderer<'_>,
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
            images,
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
            image_renderer.render(lines, images);
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
    image_renderer: &mut ImageRenderer<'_>,
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
                    render_tool_block(lines, tool_block, in_subagent, wrap_width, image_renderer);
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

fn squeeze_blank_lines_from(lines: &mut Vec<Line<'static>>, from: usize) {
    let tail: Vec<_> = lines.drain(from..).collect();
    for line in tail {
        if line.width() == 0 && lines.last().is_some_and(|previous| previous.width() == 0) {
            continue;
        }
        lines.push(line);
    }
}

fn visual_line_count(lines: &[Line<'static>], _width: u16) -> usize {
    lines.len()
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

const COMPACTION_COLOR: Color = Color::Yellow;

pub(crate) fn compaction_status_text(run: &CompactionRun, spinner: &str) -> String {
    let mut parts = vec!["compacting".to_owned()];
    if run.round > 0 {
        parts.push(format!("round {}", run.round));
    }
    if let Some(ref tool) = run.tool_name {
        parts.push(tool.clone());
    }
    if let Some(elapsed) = run.elapsed() {
        parts.push(format_elapsed(elapsed));
    }
    format!("{} {spinner}", parts.join(" · "))
}

fn render_compaction(
    lines: &mut Vec<Line<'static>>,
    app: &App,
    content_width: u16,
    image_index: &mut Vec<crate::tui::app::ImageEntry>,
) {
    let mut image_renderer = ImageRenderer {
        cache: &app.image_cache,
        show_inline: app.show_images,
        index: image_index,
    };
    let Some(run) = app.compaction.as_ref() else {
        return;
    };

    if app.show_compaction {
        lines.push(Line::from(Span::styled(
            "Compaction",
            Style::default()
                .fg(COMPACTION_COLOR)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(""));
        for block in &run.blocks {
            match block {
                TurnBlock::Thinking(text) if app.show_thinking => {
                    push_bar_wrapped(
                        lines,
                        text,
                        Style::default().fg(Color::DarkGray),
                        Style::default()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::ITALIC),
                        usize::from(content_width.saturating_sub(4)),
                    );
                    lines.push(Line::from(""));
                }
                TurnBlock::Text(text) if !text.is_empty() => {
                    lines.extend(indent_lines(markdown::render_markdown_wrapped(
                        text,
                        usize::from(content_width.saturating_sub(2)),
                    )));
                    lines.push(Line::from(""));
                }
                TurnBlock::ToolUse { .. } | TurnBlock::ToolResult { .. } => {
                    render_tool_block(lines, block, true, content_width, &mut image_renderer);
                }
                TurnBlock::Text(_)
                | TurnBlock::Thinking(_)
                | TurnBlock::SubagentBegin(_)
                | TurnBlock::SubagentEnd(_) => {}
            }
        }
        if !run.thinking.is_empty() && app.show_thinking {
            push_bar_wrapped(
                lines,
                &run.thinking,
                Style::default().fg(Color::DarkGray),
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC),
                usize::from(content_width.saturating_sub(4)),
            );
            lines.push(Line::from(""));
        }
        if !run.text.is_empty() {
            lines.extend(indent_lines(markdown::render_markdown_wrapped(
                &run.text,
                usize::from(content_width.saturating_sub(2)),
            )));
            lines.push(Line::from(""));
        }
    }

    lines.push(Line::from(vec![
        Span::raw("  "),
        Span::styled(
            compaction_status_text(run, spinner_glyphs(app.spinner_frame)),
            Style::default()
                .fg(COMPACTION_COLOR)
                .add_modifier(Modifier::ITALIC),
        ),
    ]));
    lines.push(Line::from(""));
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
            app.scroll_offset = app
                .scroll_offset
                .saturating_add(content_visual)
                .saturating_sub(previous_content_visual);
        }
    }

    let visible_height = usize::from(area.height);
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
            y: area.y.saturating_add(usize_to_u16(top_pad)),
            width: area.width,
            height: usize_to_u16(content_visual),
        }
    } else {
        area
    };

    frame.render_widget(Clear, area);

    let visible = app
        .conv_cache
        .lines
        .get(
            scroll
                ..scroll
                    .saturating_add(visible_height)
                    .min(app.conv_cache.lines.len()),
        )
        .unwrap_or_default();
    let paragraph = Paragraph::new(Text::from(visible.to_vec()));

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
    let mut image_renderer = ImageRenderer {
        cache: &app.image_cache,
        show_inline: app.show_images,
        index: image_index,
    };
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
                &mut image_renderer,
            );
            image_renderer.render(lines, &turn.images);
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
                &with_picture_names(&turn.blocks, &turn.images),
                app.show_thinking,
                app.show_tools,
                app.show_subagent,
                content_width,
                &mut image_renderer,
            );
            image_renderer.render(lines, &turn.images);
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
                &mut image_renderer,
            );
        }
    }
}

fn build_conversation_lines(
    app: &mut App,
    content_width: u16,
) -> (Vec<Line<'static>>, Vec<crate::tui::app::ImageEntry>, usize) {
    let settled_fingerprint = app.conversation_fingerprint(content_width).settled();
    let live = app.segment_view.is_none();
    let settled_entries = app
        .visible_entries()
        .iter()
        .enumerate()
        .position(|(index, entry)| {
            entry.as_turn().is_some_and(|turn| turn.is_streaming())
                || (live && app.replaced.hides(index, entry))
        })
        .unwrap_or(app.visible_entries().len());
    let reuse = app.conv_cache.settled_fingerprint == settled_fingerprint
        && app.conv_cache.settled_entries <= settled_entries;
    let first = if reuse {
        app.conv_cache.settled_entries
    } else {
        0
    };
    let mut lines = std::mem::take(&mut app.conv_cache.lines);
    lines.truncate(if reuse {
        app.conv_cache.settled_lines
    } else {
        0
    });
    let mut image_index = std::mem::take(&mut app.image_index);
    image_index.truncate(if reuse {
        app.conv_cache.settled_images
    } else {
        0
    });
    if !reuse {
        app.conv_cache.settled_entries = 0;
        app.conv_cache.settled_lines = 0;
        app.conv_cache.settled_images = 0;
    }
    app.conv_cache.settled_fingerprint = settled_fingerprint;

    if first == 0 {
        push_segment_header(&mut lines, app, content_width);
    }
    let entries = app
        .segment_view
        .as_ref()
        .map_or(&app.entries, |view| &view.entries);
    for (index, entry) in entries.iter().enumerate().skip(first) {
        if live && app.replaced.hides(index, entry) {
            continue;
        }
        let from = lines.len();
        match entry {
            ConversationEntry::Turn(turn) => {
                render_turn(&mut lines, app, turn, content_width, &mut image_index);
            }
            ConversationEntry::System {
                content,
                count,
                timestamp,
                ..
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
        }
        squeeze_blank_lines_from(&mut lines, from);
        if index.saturating_add(1) <= settled_entries {
            app.conv_cache.settled_entries = index.saturating_add(1);
            app.conv_cache.settled_lines = lines.len();
            app.conv_cache.settled_images = image_index.len();
        }
    }

    let trailing_streaming = matches!(
        app.entries.last().and_then(ConversationEntry::as_turn),
        Some(turn) if turn.is_streaming()
    );
    if live && app.stream.active && !trailing_streaming {
        render_streaming_header(&mut lines, app);
        render_streaming_content(&mut lines, app, content_width);
    }

    if live && app.compaction.is_some() {
        render_compaction(&mut lines, app, content_width, &mut image_index);
    }

    if let Some(view) = &app.segment_view {
        push_segment_footer(&mut lines, view, content_width);
    }

    if live && app.entries.is_empty() && !app.stream.active && app.compaction.is_none() {
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

    squeeze_blank_lines_from(&mut lines, app.conv_cache.settled_lines);

    let content_visual = visual_line_count(&lines, content_width);

    (lines, image_index, content_visual)
}

fn push_segment_header(lines: &mut Vec<Line<'static>>, app: &App, content_width: u16) {
    let now = Local::now();
    let muted = Style::default().fg(Color::DarkGray);
    match &app.segment_view {
        None => {
            let Some(previous) = &app.previous_segment else {
                return;
            };
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    format!(
                        "before this: {} \u{00b7} [ to view",
                        crate::output::segment_detail(previous, now)
                    ),
                    muted,
                ),
            ]));
            lines.push(centered_rule(" context starts here ", content_width));
        }
        Some(view) => {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    format!(
                        "viewing {}",
                        crate::output::segment_detail(&view.summary, now)
                    ),
                    Style::default().fg(Color::Yellow),
                ),
            ]));
            let above = if view.has_more_before {
                "scroll up for earlier messages in this segment".to_owned()
            } else {
                view.previous.as_ref().map_or_else(
                    || "start of the conversation".to_owned(),
                    |previous| {
                        format!(
                            "before this: {} \u{00b7} [ to view",
                            crate::output::segment_name(previous)
                        )
                    },
                )
            };
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(above, muted),
            ]));
            lines.push(centered_rule("", content_width));
        }
    }
    lines.push(Line::from(""));
}

fn push_segment_footer(lines: &mut Vec<Line<'static>>, view: &SegmentView, content_width: u16) {
    let after = view.next.as_ref().map_or_else(
        || "after this: the current context \u{00b7} ] to return".to_owned(),
        |next| {
            format!(
                "after this: {} \u{00b7} ] to view",
                crate::output::segment_name(next)
            )
        },
    );
    lines.push(centered_rule("", content_width));
    lines.push(Line::from(vec![
        Span::raw("  "),
        Span::styled(after, Style::default().fg(Color::DarkGray)),
    ]));
}

fn centered_rule(label: &str, content_width: u16) -> Line<'static> {
    let width = usize::from(content_width);
    let label_width = unicode_width::UnicodeWidthStr::width(label);
    let text = if width > label_width {
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
    Line::from(Span::styled(text, Style::default().fg(Color::DarkGray)))
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

fn embed_name(embed: &str) -> &str {
    let inner = embed
        .strip_prefix("![[")
        .and_then(|rest| rest.strip_suffix("]]"))
        .or_else(|| {
            embed
                .rsplit_once("](")
                .and_then(|(_, rest)| rest.strip_suffix(')'))
        })
        .unwrap_or(embed);
    let target = inner.split(['|', '#']).next().unwrap_or(inner).trim();
    target
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(target)
}

fn with_picture_names<'blocks>(
    blocks: &'blocks [TurnBlock],
    images: &[shore_common::protocol::types::ImageRef],
) -> std::borrow::Cow<'blocks, [TurnBlock]> {
    let names: Vec<(&str, String)> = images
        .iter()
        .filter_map(|image| {
            let embed = image.embed.as_deref()?;
            Some((
                embed,
                match (&image.problem, &image.name) {
                    (None, Some(name)) => format!("[picture: {name}]"),
                    _ => format!("[picture not sent: {}]", embed_name(embed)),
                },
            ))
        })
        .collect();
    if names.is_empty() {
        return std::borrow::Cow::Borrowed(blocks);
    }
    std::borrow::Cow::Owned(
        blocks
            .iter()
            .map(|block| {
                if let TurnBlock::Text(text) = block {
                    TurnBlock::Text(names.iter().fold(text.clone(), |shown, (embed, name)| {
                        shown.replace(embed, name)
                    }))
                } else {
                    block.clone()
                }
            })
            .collect(),
    )
}

fn render_images(
    lines: &mut Vec<Line<'static>>,
    img_refs: &[shore_common::protocol::types::ImageRef],
    cache: &images::ImageCache,
    show_inline: bool,
    index: &mut Vec<crate::tui::app::ImageEntry>,
) {
    let shown: Vec<_> = img_refs
        .iter()
        .filter(|img| img.problem.is_none() && !img.path.is_empty())
        .collect();
    if shown.is_empty() {
        return;
    }

    lines.push(Line::from(""));

    for img in shown {
        let display = img
            .caption
            .as_deref()
            .or(img.name.as_deref())
            .unwrap_or_else(|| {
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
fn usage_gauge(percent_used: f64) -> String {
    const CELLS: usize = 10;
    let filled = ((percent_used.clamp(0.0, 1.0)) * CELLS as f64).round() as usize;
    let bar: String = "█".repeat(filled) + &"░".repeat(CELLS - filled);
    let pct = (percent_used * 100.0).round() as i64;
    format!("[{bar}] {pct}%")
}

fn usage_chip(
    budget: &crate::tui::app::UsageBudget,
    focus: &crate::tui::app::BudgetFocus,
) -> (String, Color) {
    let level = budget.level(focus.scope);
    let prefix = if budget.level_is_pace(focus.scope) {
        "pace "
    } else {
        ""
    };
    let color = if level.over_limit {
        Color::Red
    } else if budget.in_warning() {
        Color::Yellow
    } else {
        Color::DarkGray
    };
    (
        format!("{prefix}{}", usage_gauge(level.percent_used)),
        color,
    )
}

fn plan_chip(limit: &crate::tui::app::PlanLimit) -> (String, Color) {
    let color = if limit.level.over_limit {
        Color::Red
    } else if limit.level.in_warning() {
        Color::Yellow
    } else {
        Color::DarkGray
    };
    (
        format!(
            "{} {}",
            limit.window.label(),
            usage_gauge(limit.level.percent_used)
        ),
        color,
    )
}

fn usage_shown(display: crate::tui::app::UsageDisplay, in_warning: bool) -> bool {
    match display {
        crate::tui::app::UsageDisplay::Off => false,
        crate::tui::app::UsageDisplay::Always => true,
        crate::tui::app::UsageDisplay::Warn => in_warning,
    }
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
    if let Some(view) = &app.segment_view {
        let fresh = if app.live_moved_on() {
            " \u{00b7} new messages"
        } else {
            ""
        };
        block = block.title(Span::styled(
            format!(" segment {} (read-only){fresh} ", view.summary.index),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ));
    }
    if app.in_side_thread() {
        block = block.title(Span::styled(
            format!(" \u{2387} {} ", app.thread_name),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ));
    }
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
    let unread = app.unread_elsewhere();
    if !unread.is_empty() {
        let shown = unread
            .iter()
            .take(3)
            .map(|(thread, count)| format!("{thread} {count}"))
            .collect::<Vec<_>>()
            .join(" \u{b7} ");
        let more = if unread.len() > 3 {
            format!(" +{}", unread.len().saturating_sub(3))
        } else {
            String::new()
        };
        let key = app
            .keymap
            .key_for_command("ui thread unread")
            .map_or_else(String::new, |key| format!(" \u{2014} {key}"));
        indicators.push((format!("\u{25cf} {shown}{more}{key}"), Color::LightGreen));
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
    match &app.plan_limits {
        Some(limits) => indicators.extend(
            limits
                .iter()
                .filter(|limit| usage_shown(app.usage_display, limit.level.in_warning()))
                .map(plan_chip),
        ),
        None => {
            if let Some(budget) = app
                .focused_budget()
                .filter(|budget| usage_shown(app.usage_display, budget.in_warning()))
            {
                indicators.push(usage_chip(budget, &app.budget_focus));
            }
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
    let mut panel_images = Vec::new();
    let mut image_renderer = ImageRenderer {
        cache: &app.image_cache,
        show_inline: app.show_images,
        index: &mut panel_images,
    };
    render_blocks(
        &mut lines,
        &task.blocks,
        true,
        true,
        true,
        body_area.width,
        &mut image_renderer,
    );
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
    if !panel_images.is_empty() {
        images::fixup_placeholder_cells(frame.buffer_mut(), body_area);
    }

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

fn recede(frame: &mut Frame<'_>, area: Rect) {
    let dimmed = Style::default()
        .fg(Color::DarkGray)
        .bg(Color::Reset)
        .remove_modifier(Modifier::BOLD | Modifier::ITALIC | Modifier::REVERSED)
        .add_modifier(Modifier::DIM);
    let buffer = frame.buffer_mut();
    for y in area.y..area.y.saturating_add(area.height) {
        for x in area.x..area.x.saturating_add(area.width) {
            if let Some(cell) = buffer.cell_mut((x, y)) {
                let _restyled = cell.set_style(dimmed);
            }
        }
    }
}

const PAGER_CHROME: u16 = 4;

pub(crate) fn output_pager_layout(area: Rect, line_count: usize) -> (Rect, u16) {
    let width = area.width.saturating_sub(4).max(1);
    let ceiling = area
        .height
        .saturating_sub(4)
        .max(PAGER_CHROME.saturating_add(1));
    let wanted = usize_to_u16(line_count).saturating_add(PAGER_CHROME);
    let height = wanted.clamp(PAGER_CHROME.saturating_add(1), ceiling);
    let x = area
        .x
        .saturating_add(area.width.saturating_sub(width).checked_div(2).unwrap_or(0));
    let y = area.y.saturating_add(
        area.height
            .saturating_sub(height)
            .checked_div(2)
            .unwrap_or(0),
    );
    (
        Rect::new(x, y, width, height),
        height.saturating_sub(PAGER_CHROME),
    )
}

fn draw_output_pager(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    let Some(pager) = &mut app.output_pager else {
        return;
    };

    let total = pager.lines.len();
    let (popup_area, viewport) = output_pager_layout(area, total);
    pager.viewport = viewport;
    pager.scroll = pager
        .scroll
        .min(total.saturating_sub(usize::from(viewport.max(1))));
    let first_shown = pager.scroll.saturating_add(1).min(total);
    let last_shown = pager
        .scroll
        .saturating_add(usize::from(viewport))
        .min(total);
    let position = if total == 0 {
        "empty".to_owned()
    } else {
        format!("{first_shown}-{last_shown} of {total}")
    };

    let visible = pager
        .lines
        .get(pager.scroll..last_shown)
        .unwrap_or_default();
    let body = Paragraph::new(Text::from(visible.to_vec())).block(
        Block::default()
            .borders(Borders::ALL)
            .padding(Padding::vertical(1))
            .title_top(Line::from(format!(" output · :{} ", pager.command)).right_aligned())
            .title_bottom(
                Line::from(format!(" j/k scroll · Esc close   {position} ")).right_aligned(),
            )
            .border_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::DIM)),
    );

    frame.render_widget(Clear, popup_area);
    frame.render_widget(body, popup_area);
}

fn draw_help(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
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

    let mut lines = vec![Line::from(""), heading("Normal mode")];
    if app.keymap.bindings(Scope::Normal).is_empty() {
        lines.push(Line::from(Span::styled(
            "    nothing is bound; edit tui.toml or use `ui bind`",
            Style::default().fg(Color::DarkGray),
        )));
    }
    for (key, binding) in app.keymap.bindings(Scope::Normal) {
        lines.push(row(key, &binding.written));
    }

    lines.push(Line::from(""));
    lines.push(heading("Every mode"));
    for (key, binding) in app.keymap.bindings(Scope::Global) {
        lines.push(row(key, &binding.written));
    }

    lines.push(Line::from(""));
    lines.push(heading("Reserved"));
    lines.push(row("Esc", "normal mode, or dismiss a notice"));
    lines.push(row(":", "command palette"));
    lines.push(row("Ctrl+C", "quit"));
    lines.push(row("Enter", "send message"));
    lines.push(row("Shift+Enter", "newline"));
    lines.push(row("q", "close an overlay"));

    lines.push(Line::from(""));
    lines.push(heading("Input box (insert mode, not bindable)"));
    lines.push(row("Ctrl+Z / Ctrl+Y", "undo / redo your typing"));
    lines.push(row("Ctrl+G", "rewrite the box in $EDITOR"));
    lines.push(row("Ctrl+A / Ctrl+E", "start / end of line"));
    lines.push(row("Alt+Backspace", "delete the word behind the cursor"));
    lines.push(Line::from(Span::styled(
        "    Unsent drafts come back next time you open shore.".to_owned(),
        Style::default().fg(Color::DarkGray),
    )));

    lines.push(Line::from(""));
    lines.push(heading("Rebinding"));
    for hint in [
        "    :ui bind <key> <command>      add --global for every mode",
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

    let total = lines.len();
    let height = usize_to_u16(total).saturating_add(2).min(area.height);
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

    let visible = usize::from(height.saturating_sub(2));
    app.help_scroll = help_scroll_offset(app.help_scroll, total, visible);
    let offset = app.help_scroll;
    let title = if total > visible {
        format!(
            " Keyboard Shortcuts  ({}-{} of {total}, ↑↓ to scroll) ",
            offset.saturating_add(1),
            offset.saturating_add(visible).min(total),
        )
    } else {
        " Keyboard Shortcuts ".to_owned()
    };

    let popup = Paragraph::new(Text::from(lines))
        .scroll((usize_to_u16(offset), 0))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(title)
                .border_style(Style::default().fg(Color::Yellow)),
        )
        .style(Style::default().bg(Color::Rgb(20, 20, 30)));

    frame.render_widget(Clear, popup_area);
    frame.render_widget(popup, popup_area);
}

pub(crate) fn help_scroll_offset(requested: usize, total: usize, visible: usize) -> usize {
    requested.min(total.saturating_sub(visible))
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

const CONFIG_PANEL_CHROME: u16 = 4;

pub(crate) fn config_panel_is_open(app: &App) -> bool {
    app.input.mode == InputMode::Command
        && app.palette_confirmation.is_none()
        && app.completion.scope == crate::cli::PaletteScope::Config
        && app.is_submenu_open("config")
}

fn config_group_of(row: &str) -> &'static str {
    let key = App::view_key_from_row(row);
    if matches!(key, "model" | "character") {
        "Session"
    } else if App::is_view_key(key) {
        "Display"
    } else if key == "reset" {
        "Actions"
    } else {
        "Model settings"
    }
}

fn config_origin(app: &App, row: &str) -> Option<String> {
    let key = App::setting_key_from_row(row);
    let scope = app.setting_origin(key)?;
    Some(match scope {
        "static_default" => "default".to_owned(),
        other => other
            .strip_suffix("_model")
            .unwrap_or(other)
            .replace('_', " "),
    })
}

struct ConfigRow {
    index: usize,
    group: &'static str,
    key: String,
    value: Option<String>,
    origin: Option<String>,
}

fn config_rows(app: &App) -> Vec<ConfigRow> {
    app.completion
        .candidates
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let group = config_group_of(row);
            let (key, shown) = match row.split_once(" = ") {
                Some((key, shown)) => (key.to_owned(), Some(shown.to_owned())),
                None => (row.clone(), None),
            };
            let origin = if group == "Actions" {
                Some("clear a saved setting".to_owned())
            } else {
                config_origin(app, row)
            };
            ConfigRow {
                index,
                group,
                key,
                value: shown.filter(|text| text != "unset"),
                origin,
            }
        })
        .collect()
}

fn draw_config_panel(frame: &mut Frame<'_>, app: &App, area: Rect) {
    let rows = config_rows(app);
    let key_width = rows
        .iter()
        .map(|row| unicode_width::UnicodeWidthStr::width(row.key.as_str()))
        .max()
        .unwrap_or(0)
        .clamp(8, 24);
    let value_width = rows
        .iter()
        .filter_map(|row| row.value.as_deref())
        .map(unicode_width::UnicodeWidthStr::width)
        .max()
        .unwrap_or(0)
        .clamp(5, 22);

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut selected_line: Option<usize> = None;
    let mut group_shown: Option<&'static str> = None;

    for row in &rows {
        let ConfigRow {
            index,
            group,
            key,
            value,
            origin,
        } = row;
        if group_shown != Some(*group) {
            if group_shown.is_some() {
                lines.push(Line::from(""));
            }
            lines.push(Line::from(Span::styled(
                format!("  {group}"),
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )));
            group_shown = Some(*group);
        }

        let selected = app.completion.selected == Some(*index);
        if selected {
            selected_line = Some(lines.len());
        }

        if key.contains(' ') && value.is_none() {
            lines.push(Line::from(Span::styled(
                format!("   {key}"),
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC),
            )));
            continue;
        }

        let inherited = origin.as_deref() == Some("default");
        let key_cell = format!("   {key:key_width$}  ");
        let value_cell = match (value, *group) {
            (Some(shown), _) => format!("{shown:value_width$}  "),
            (None, "Actions") => format!("{:value_width$}  ", ""),
            (None, _) => format!("{:value_width$}  ", "—"),
        };
        let origin_cell = origin.clone().unwrap_or_default();

        if selected {
            lines.push(Line::from(Span::styled(
                format!("{key_cell}{value_cell}{origin_cell}"),
                Style::default().fg(Color::Black).bg(Color::Yellow),
            )));
        } else {
            let value_style = if value.is_none() {
                Style::default().fg(Color::DarkGray)
            } else if inherited {
                Style::default().fg(Color::Gray).add_modifier(Modifier::DIM)
            } else {
                Style::default().fg(Color::White)
            };
            lines.push(Line::from(vec![
                Span::styled(key_cell, Style::default().fg(Color::White)),
                Span::styled(value_cell, value_style),
                Span::styled(
                    origin_cell,
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::DIM),
                ),
            ]));
        }
    }

    let ceiling = area
        .height
        .saturating_sub(4)
        .max(CONFIG_PANEL_CHROME.saturating_add(1));
    let height = usize_to_u16(lines.len())
        .saturating_add(CONFIG_PANEL_CHROME)
        .clamp(CONFIG_PANEL_CHROME.saturating_add(1), ceiling);
    let viewport = usize::from(height.saturating_sub(CONFIG_PANEL_CHROME));
    let width = area.width.saturating_sub(4).max(1);
    let x = area
        .x
        .saturating_add(area.width.saturating_sub(width).checked_div(2).unwrap_or(0));
    let y = area.y.saturating_add(
        area.height
            .saturating_sub(height)
            .checked_div(2)
            .unwrap_or(0),
    );

    let scroll = usize_to_u16(completion_window_start(
        selected_line,
        viewport,
        lines.len(),
    ));

    let hint = " type to filter · Enter to change · Esc to close ";

    let panel = Paragraph::new(Text::from(lines)).scroll((scroll, 0)).block(
        Block::default()
            .borders(Borders::ALL)
            .padding(Padding::vertical(1))
            .title_top(Line::from(" config ").right_aligned())
            .title_bottom(Line::from(hint).right_aligned())
            .border_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::DIM)),
    );

    frame.render_widget(Clear, Rect::new(x, y, width, height));
    frame.render_widget(panel, Rect::new(x, y, width, height));
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
            PaletteMode::Submenu(s) if s.parent == "thread" => {
                !app.thread_name.is_empty() && App::thread_id_from_row(c) == app.thread_name
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

        let is_favorite = match &app.completion.mode {
            PaletteMode::Submenu(s) if s.parent == "model" => app.is_favorite_model_candidate(c),
            PaletteMode::Top | PaletteMode::Submenu(_) | PaletteMode::ValueEditor(_) => false,
        };

        let is_subscription = match &app.completion.mode {
            PaletteMode::Submenu(s) if s.parent == "model" => {
                app.is_subscription_model_candidate(c)
            }
            PaletteMode::Top | PaletteMode::Submenu(_) | PaletteMode::ValueEditor(_) => false,
        };

        let favorite_marker = if is_favorite { '\u{2605}' } else { ' ' };
        let subscription_marker = if is_subscription { '\u{25c6}' } else { ' ' };
        let name_text = format!(" {favorite_marker}{subscription_marker} {c}");
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
    use crate::tui::app::{App, ConnectionStatus, ConversationEntry};

    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    pub(crate) struct Harness {
        terminal: Terminal<TestBackend>,
        pub(crate) app: App,
        frames: Vec<String>,
    }

    impl Harness {
        fn with_size(w: u16, h: u16) -> Self {
            let backend = TestBackend::new(w, h);
            let terminal = Terminal::new(backend).unwrap();
            Self {
                terminal,
                app: App::default(),
                frames: Vec::new(),
            }
        }

        pub(crate) fn render_quiet(&mut self) -> String {
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
            text
        }

        pub(crate) fn render(&mut self, label: &str) -> String {
            let text = self.render_quiet();
            eprintln!("═══ {label} ═══\n{text}");
            text
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
}
