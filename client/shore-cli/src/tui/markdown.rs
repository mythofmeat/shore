use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub(crate) fn render_markdown_wrapped(text: &str, max_width: usize) -> Vec<Line<'static>> {
    let width_limit = (max_width > 0).then_some(max_width);
    render_markdown_inner(text, width_limit)
}

fn render_markdown_inner(text: &str, max_width: Option<usize>) -> Vec<Line<'static>> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut renderer = MarkdownRenderer::new(max_width);
    let mut previous_block_end = None;
    for (event, range) in Parser::new_ext(text, markdown_options()).into_offset_iter() {
        if starts_visual_block(&event)
            && let Some(end) = previous_block_end.take()
            && range.start > end
            && source_gap_has_blank_line(text.get(end..range.start).unwrap_or_default())
        {
            renderer.push_blank_line_if_needed();
        }

        let ends_block = ends_visual_block(&event);
        renderer.handle_event(event);
        if ends_block {
            previous_block_end = Some(block_gap_start(text, range.end));
        }
    }
    renderer.finish()
}

fn markdown_options() -> Options {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    options.insert(Options::ENABLE_GFM);
    options.insert(Options::ENABLE_DEFINITION_LIST);
    options.insert(Options::ENABLE_SUPERSCRIPT);
    options.insert(Options::ENABLE_SUBSCRIPT);
    options.insert(Options::ENABLE_WIKILINKS);
    options
}

fn starts_visual_block(event: &Event<'_>) -> bool {
    matches!(
        event,
        Event::Start(
            Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::BlockQuote(_)
                | Tag::CodeBlock(_)
                | Tag::HtmlBlock
                | Tag::List(_)
                | Tag::Item
                | Tag::FootnoteDefinition(_)
                | Tag::DefinitionList
                | Tag::DefinitionListTitle
                | Tag::DefinitionListDefinition
                | Tag::Table(_)
        ) | Event::Rule
            | Event::DisplayMath(_)
    )
}

fn ends_visual_block(event: &Event<'_>) -> bool {
    matches!(
        event,
        Event::End(
            TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::CodeBlock
                | TagEnd::HtmlBlock
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::FootnoteDefinition
                | TagEnd::DefinitionList
                | TagEnd::DefinitionListTitle
                | TagEnd::DefinitionListDefinition
                | TagEnd::Table
        ) | Event::Rule
            | Event::DisplayMath(_)
    )
}

fn source_gap_has_blank_line(gap: &str) -> bool {
    gap.bytes().filter(|byte| *byte == b'\n').count() >= 2
}

fn block_gap_start(text: &str, end: usize) -> usize {
    let bytes = text.as_bytes();
    let mut idx = end;
    while idx > 0
        && bytes
            .get(idx.saturating_sub(1))
            .is_some_and(|byte| matches!(byte, b'\n' | b'\r' | b' ' | b'\t'))
    {
        idx = idx.saturating_sub(1);
    }
    idx
}

struct LinkState {
    dest_url: String,
    visible: String,
}

#[derive(Clone, Copy)]
struct ListState {
    next: u64,
}

#[derive(Clone)]
struct ItemPrefixState {
    marker: String,
    continuation: String,
    used: bool,
}

impl ItemPrefixState {
    fn new(marker: String) -> Self {
        let continuation = " ".repeat(UnicodeWidthStr::width(marker.as_str()));
        Self {
            marker,
            continuation,
            used: false,
        }
    }
}

#[derive(Default)]
struct TableState {
    in_head: bool,
    cell_index: usize,
    last_cell_count: usize,
}

struct MarkdownRenderer {
    lines: Vec<Line<'static>>,
    current: Vec<Span<'static>>,
    style_stack: Vec<Style>,
    quote_depth: usize,
    list_stack: Vec<ListState>,
    item_prefix: Option<ItemPrefixState>,
    item_prefix_stack: Vec<Option<ItemPrefixState>>,
    link_stack: Vec<LinkState>,
    table: Option<TableState>,
    in_code_block: bool,
    max_width: Option<usize>,
}

impl MarkdownRenderer {
    fn new(max_width: Option<usize>) -> Self {
        Self {
            lines: Vec::new(),
            current: Vec::new(),
            style_stack: vec![Style::default()],
            quote_depth: 0,
            list_stack: Vec::new(),
            item_prefix: None,
            item_prefix_stack: Vec::new(),
            link_stack: Vec::new(),
            table: None,
            in_code_block: false,
            max_width,
        }
    }

    fn handle_event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start_tag(tag),
            Event::End(tag) => self.end_tag(tag),
            Event::Text(text) => self.push_text(text.as_ref(), self.current_style()),
            Event::Code(code) => {
                self.push_text(code.as_ref(), self.current_style().fg(Color::Yellow));
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                self.push_text(html.as_ref(), self.current_style().fg(Color::DarkGray));
            }
            Event::FootnoteReference(label) => {
                self.push_text(
                    &format!("[^{}]", label.as_ref()),
                    self.current_style().fg(Color::Cyan),
                );
            }
            Event::SoftBreak | Event::HardBreak => self.flush_current(),
            Event::Rule => {
                self.flush_current();
                let width = self.max_width.unwrap_or(24).clamp(3, 48);
                self.lines.push(Line::from(Span::styled(
                    "-".repeat(width),
                    Style::default().fg(Color::DarkGray),
                )));
            }
            Event::TaskListMarker(checked) => {
                let marker = if checked { "[x] " } else { "[ ] " };
                self.push_text(marker, self.current_style().fg(Color::DarkGray));
            }
            Event::InlineMath(math) => {
                self.push_text(
                    &format!("${}$", math.as_ref()),
                    self.current_style().fg(Color::Yellow),
                );
            }
            Event::DisplayMath(math) => {
                self.flush_current();
                for line in math.lines() {
                    self.lines.push(Line::from(Span::styled(
                        format!("$$ {line}"),
                        Style::default().fg(Color::Yellow),
                    )));
                }
            }
        }
    }

    fn start_tag(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {}
            Tag::Heading { level, .. } => {
                self.flush_current();
                let mut style = Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD);
                if level == HeadingLevel::H1 {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                self.push_style(style);
            }
            Tag::BlockQuote(kind) => {
                self.flush_current();
                self.quote_depth = self.quote_depth.saturating_add(1);
                if let Some(quote_kind) = kind {
                    self.push_text(
                        &format!("[{quote_kind:?}] "),
                        self.current_style()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::BOLD),
                    );
                }
            }
            Tag::CodeBlock(kind) => {
                self.flush_current();
                self.in_code_block = true;
                if let CodeBlockKind::Fenced(lang) = kind {
                    let language = lang.trim();
                    if !language.is_empty() {
                        self.lines.push(Line::from(Span::styled(
                            format!("-- {language} --"),
                            Style::default().fg(Color::DarkGray),
                        )));
                    }
                }
            }
            Tag::HtmlBlock => {
                self.flush_current();
                self.push_style(self.current_style().fg(Color::DarkGray));
            }
            Tag::List(start) => {
                self.flush_current();
                self.list_stack.push(ListState {
                    next: start.unwrap_or(0),
                });
            }
            Tag::Item => {
                self.flush_current();
                let prior = self.item_prefix.take();
                self.item_prefix_stack.push(prior);
                self.item_prefix = Some(ItemPrefixState::new(self.next_item_prefix()));
            }
            Tag::FootnoteDefinition(label) => {
                self.flush_current();
                let prior = self.item_prefix.take();
                self.item_prefix_stack.push(prior);
                self.item_prefix = Some(ItemPrefixState::new(format!("[^{}]: ", label.as_ref())));
            }
            Tag::DefinitionList => self.flush_current(),
            Tag::DefinitionListTitle => {
                self.flush_current();
                self.push_style(self.current_style().add_modifier(Modifier::BOLD));
            }
            Tag::DefinitionListDefinition => {
                self.flush_current();
                let prior = self.item_prefix.take();
                self.item_prefix_stack.push(prior);
                self.item_prefix = Some(ItemPrefixState::new(": ".to_owned()));
            }
            Tag::Table(_) => {
                self.flush_current();
                self.table = Some(TableState::default());
            }
            Tag::TableHead => {
                if let Some(table) = &mut self.table {
                    table.in_head = true;
                }
                self.push_style(self.current_style().add_modifier(Modifier::BOLD));
            }
            Tag::TableRow => {
                self.flush_current();
                if let Some(table) = &mut self.table {
                    table.cell_index = 0;
                }
            }
            Tag::TableCell => {
                let needs_separator = self
                    .table
                    .as_ref()
                    .is_some_and(|table| table.cell_index > 0);
                if needs_separator {
                    self.push_text(" | ", Style::default().fg(Color::DarkGray));
                }
                if let Some(table) = &mut self.table {
                    table.cell_index = table.cell_index.saturating_add(1);
                }
            }
            Tag::Emphasis => self.push_style(self.current_style().add_modifier(Modifier::ITALIC)),
            Tag::Strong => self.push_style(self.current_style().add_modifier(Modifier::BOLD)),
            Tag::Strikethrough => {
                self.push_style(self.current_style().add_modifier(Modifier::CROSSED_OUT));
            }
            Tag::Superscript => {
                self.push_text("^", self.current_style().fg(Color::DarkGray));
                self.push_style(self.current_style().add_modifier(Modifier::DIM));
            }
            Tag::Subscript => {
                self.push_text("~", self.current_style().fg(Color::DarkGray));
                self.push_style(self.current_style().add_modifier(Modifier::DIM));
            }
            Tag::Link { dest_url, .. } => {
                self.link_stack.push(LinkState {
                    dest_url: dest_url.to_string(),
                    visible: String::new(),
                });
                self.push_style(
                    self.current_style()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::UNDERLINED),
                );
            }
            Tag::Image { dest_url, .. } => {
                self.push_text("[image", self.current_style().fg(Color::Magenta));
                if !dest_url.is_empty() {
                    self.push_text(": ", self.current_style().fg(Color::Magenta));
                    self.push_text(dest_url.as_ref(), self.current_style().fg(Color::Magenta));
                }
                self.push_text("]", self.current_style().fg(Color::Magenta));
            }
            Tag::MetadataBlock(_) => {
                self.flush_current();
                self.push_style(self.current_style().fg(Color::DarkGray));
            }
        }
    }

    fn end_tag(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => self.flush_current(),
            TagEnd::Heading(_) => {
                self.pop_style();
                self.flush_current();
            }
            TagEnd::BlockQuote(_) => {
                self.flush_current();
                self.quote_depth = self.quote_depth.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                self.flush_current();
                self.in_code_block = false;
            }
            TagEnd::HtmlBlock => {
                self.pop_style();
                self.flush_current();
            }
            TagEnd::List(_) => {
                self.flush_current();
                let _ = self.list_stack.pop();
            }
            TagEnd::Item | TagEnd::FootnoteDefinition | TagEnd::DefinitionListDefinition => {
                self.flush_current();
                self.item_prefix = self.item_prefix_stack.pop().unwrap_or(None);
            }
            TagEnd::DefinitionList => self.flush_current(),
            TagEnd::DefinitionListTitle => {
                self.pop_style();
                self.flush_current();
            }
            TagEnd::Table => {
                self.flush_current();
                self.table = None;
            }
            TagEnd::TableHead => {
                self.pop_style();
                let cols = self.table.as_ref().map_or(0, |t| t.last_cell_count);
                if cols > 0 {
                    self.lines.push(Line::from(Span::styled(
                        std::iter::repeat_n("---", cols)
                            .collect::<Vec<_>>()
                            .join("-+-"),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
                if let Some(table) = &mut self.table {
                    table.in_head = false;
                }
            }
            TagEnd::TableRow => {
                let cell_count = self.table.as_ref().map_or(0, |t| t.cell_index);
                self.flush_current();
                if let Some(table) = &mut self.table {
                    table.last_cell_count = cell_count;
                }
            }
            TagEnd::TableCell => {}
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.pop_style();
            }
            TagEnd::Superscript => {
                self.pop_style();
                self.push_text("^", self.current_style().fg(Color::DarkGray));
            }
            TagEnd::Subscript => {
                self.pop_style();
                self.push_text("~", self.current_style().fg(Color::DarkGray));
            }
            TagEnd::Link => {
                self.pop_style();
                if let Some(link) = self.link_stack.pop()
                    && !link.dest_url.is_empty()
                    && link.dest_url != link.visible
                {
                    self.push_text(
                        &format!(" ({})", link.dest_url),
                        self.current_style().fg(Color::DarkGray),
                    );
                }
            }
            TagEnd::Image | TagEnd::MetadataBlock(_) => {}
        }
    }

    fn finish(mut self) -> Vec<Line<'static>> {
        self.flush_current();
        self.lines
    }

    fn current_style(&self) -> Style {
        *self.style_stack.last().unwrap_or(&Style::default())
    }

    fn push_style(&mut self, style: Style) {
        self.style_stack.push(style);
    }

    fn pop_style(&mut self) {
        if self.style_stack.len() > 1 {
            let _ = self.style_stack.pop();
        }
    }

    fn next_item_prefix(&mut self) -> String {
        let depth = self.list_stack.len().saturating_sub(1);
        let indent = "  ".repeat(depth);
        if let Some(list) = self.list_stack.last_mut()
            && list.next > 0
        {
            let n = list.next;
            list.next = list.next.saturating_add(1);
            return format!("{indent}{n}. ");
        }

        let marker = match depth % 3 {
            0 => "- ",
            1 => "* ",
            _ => "+ ",
        };
        format!("{indent}{marker}")
    }

    fn push_text(&mut self, text: &str, style: Style) {
        if text.is_empty() {
            return;
        }

        if self.in_code_block {
            for (idx, line) in text.lines().enumerate() {
                if idx > 0 {
                    self.flush_current();
                }
                if line.is_empty() {
                    self.flush_blank_line();
                } else {
                    self.push_wrapped_code_segment(line, Style::default().fg(Color::Green));
                }
            }
            return;
        }

        for (idx, line) in text.split('\n').enumerate() {
            if idx > 0 {
                self.flush_current();
            }
            self.push_wrapped_segment(line, style);
            if let Some(link) = self.link_stack.last_mut() {
                link.visible.push_str(line);
            }
        }
    }

    fn push_wrapped_segment(&mut self, mut text: &str, style: Style) {
        while !text.is_empty() {
            self.ensure_prefix();

            let Some(max_width) = self.max_width else {
                self.current.push(Span::styled(text.to_owned(), style));
                return;
            };

            let line_width = self.current_width();
            if line_width.saturating_add(UnicodeWidthStr::width(text)) <= max_width {
                self.current.push(Span::styled(text.to_owned(), style));
                return;
            }

            let available = max_width.saturating_sub(line_width).max(1);
            let split = split_at_width(text, available);
            let (head, tail) = text.split_at(split);
            let trimmed_head = head.trim_end_matches(char::is_whitespace);
            if !trimmed_head.is_empty() {
                self.current
                    .push(Span::styled(trimmed_head.to_owned(), style));
            }
            self.flush_current();
            self.ensure_continuation_prefix();
            text = tail.trim_start_matches(char::is_whitespace);
        }
    }

    fn push_wrapped_code_segment(&mut self, mut text: &str, style: Style) {
        while !text.is_empty() {
            self.ensure_prefix();

            let Some(max_width) = self.max_width else {
                self.current.push(Span::styled(text.to_owned(), style));
                return;
            };

            let line_width = self.current_width();
            if line_width.saturating_add(UnicodeWidthStr::width(text)) <= max_width {
                self.current.push(Span::styled(text.to_owned(), style));
                return;
            }

            let available = max_width.saturating_sub(line_width).max(1);
            let split = split_at_width_hard(text, available);
            let (head, tail) = text.split_at(split);
            self.current.push(Span::styled(head.to_owned(), style));
            self.flush_current();
            self.ensure_continuation_prefix();
            text = tail;
        }
    }

    fn ensure_prefix(&mut self) {
        if !self.current.is_empty() {
            return;
        }

        for _ in 0..self.quote_depth {
            self.current.push(Span::styled(
                "> ".to_owned(),
                Style::default().fg(Color::DarkGray),
            ));
        }

        if let Some(prefix) = &mut self.item_prefix {
            if prefix.used {
                self.current.push(Span::raw(prefix.continuation.clone()));
            } else {
                prefix.used = true;
                self.current.push(Span::styled(
                    prefix.marker.clone(),
                    Style::default().fg(Color::DarkGray),
                ));
            }
        }
    }

    fn flush_current(&mut self) {
        if self.current.is_empty() {
            return;
        }

        self.lines
            .push(Line::from(std::mem::take(&mut self.current)));
    }

    fn flush_blank_line(&mut self) {
        self.ensure_prefix();
        if self.current.is_empty() {
            self.lines.push(Line::from(""));
        } else {
            self.flush_current();
        }
    }

    fn push_blank_line_if_needed(&mut self) {
        self.flush_current();
        if self.lines.last().is_none_or(|line| line.width() > 0) {
            self.lines.push(Line::from(""));
        }
    }

    fn ensure_continuation_prefix(&mut self) {
        if self.quote_depth == 0 && self.item_prefix.is_none() {
            return;
        }

        for _ in 0..self.quote_depth {
            self.current.push(Span::styled(
                "> ".to_owned(),
                Style::default().fg(Color::DarkGray),
            ));
        }

        if let Some(prefix) = &mut self.item_prefix {
            prefix.used = true;
            self.current.push(Span::raw(prefix.continuation.clone()));
        }
    }

    fn current_width(&self) -> usize {
        self.current
            .iter()
            .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
            .sum()
    }
}

fn split_at_width(text: &str, max_width: usize) -> usize {
    let mut width: usize = 0;
    let mut last_whitespace = None;
    let mut last_fit = 0;

    for (idx, ch) in text.char_indices() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if width.saturating_add(ch_width) > max_width {
            return last_whitespace.filter(|&i| i > 0).unwrap_or_else(|| {
                if last_fit > 0 {
                    last_fit
                } else {
                    idx.saturating_add(ch.len_utf8())
                }
            });
        }
        width = width.saturating_add(ch_width);
        let next = idx.saturating_add(ch.len_utf8());
        last_fit = next;
        if ch.is_whitespace() {
            last_whitespace = Some(next);
        }
    }

    text.len()
}

fn split_at_width_hard(text: &str, max_width: usize) -> usize {
    let mut width: usize = 0;
    let mut last_fit = 0;

    for (idx, ch) in text.char_indices() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if width.saturating_add(ch_width) > max_width {
            return if last_fit > 0 {
                last_fit
            } else {
                idx.saturating_add(ch.len_utf8())
            };
        }
        width = width.saturating_add(ch_width);
        last_fit = idx.saturating_add(ch.len_utf8());
    }

    text.len()
}
