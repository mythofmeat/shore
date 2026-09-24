use std::io::Write;

use crossterm::style::{Color, ResetColor, SetForegroundColor};

use super::{term_width, use_color};

const SPEAKER_PALETTE: &[Color] = &[
    Color::Magenta,
    Color::Green,
    Color::DarkYellow,
    Color::Blue,
    Color::DarkCyan,
    Color::Red,
    Color::DarkMagenta,
    Color::DarkGreen,
];

pub(crate) fn speaker_tone(name: &str) -> Tone {
    let hash = name.bytes().fold(0_u32, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(u32::from(b))
    });
    let slot = hash
        .checked_rem(u32::try_from(SPEAKER_PALETTE.len()).unwrap_or(1))
        .unwrap_or(0);
    Tone::Speaker(u8::try_from(slot).unwrap_or(0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tone {
    Plain,
    Muted,
    Heading,
    Active,
    Good,
    Warn,
    Bad,
    Thinking,
    Speaker(u8),
}

impl Tone {
    fn color(self) -> Option<Color> {
        match self {
            Self::Plain => None,
            Self::Muted => Some(Color::DarkGrey),
            Self::Heading => Some(Color::White),
            Self::Active => Some(Color::Cyan),
            Self::Good => Some(Color::Green),
            Self::Warn => Some(Color::Yellow),
            Self::Bad => Some(Color::Red),
            Self::Thinking => Some(Color::Magenta),
            Self::Speaker(slot) => SPEAKER_PALETTE
                .get(
                    usize::from(slot)
                        .checked_rem(SPEAKER_PALETTE.len())
                        .unwrap_or(0),
                )
                .copied(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mark {
    None,
    Active,
    On,
    Off,
    Warn,
}

impl Mark {
    fn glyph(self) -> char {
        match self {
            Self::None => ' ',
            Self::Active => '*',
            Self::On => '\u{2713}',
            Self::Off => '\u{00b7}',
            Self::Warn => '!',
        }
    }

    fn tone(self) -> Tone {
        match self {
            Self::None => Tone::Plain,
            Self::Active => Tone::Active,
            Self::On => Tone::Good,
            Self::Off => Tone::Muted,
            Self::Warn => Tone::Warn,
        }
    }
}

pub(crate) const GUTTER: usize = 2;
const MARK_COLUMN: usize = 2;
const COLUMN_GAP: usize = 2;
const MIN_RULE: usize = 8;
const BAR_CELLS: usize = 20;
const OVER_CELLS: usize = 4;
const ZERO: &str = "\u{2014}";
const MAX_CELL: usize = 36;

pub(crate) fn ellipsize(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}\u{2026}")
}

pub(crate) fn paint<W: Write>(out: &mut W, tone: Tone, text: &str) {
    paint_when(use_color(), out, tone, text);
}

pub(crate) fn paint_on_stderr<W: Write>(out: &mut W, tone: Tone, text: &str) {
    paint_when(crate::output::use_color_on_stderr(), out, tone, text);
}

fn paint_when<W: Write>(colored: bool, out: &mut W, tone: Tone, text: &str) {
    match (colored, tone.color()) {
        (true, Some(color)) => {
            let _ignored = crossterm::execute!(out, SetForegroundColor(color));
            _ = write!(out, "{text}");
            _ = crossterm::execute!(out, ResetColor);
        }
        (true, None) | (false, _) => {
            let _ignored = write!(out, "{text}");
        }
    }
}

fn newline<W: Write>(out: &mut W) {
    let _ignored = writeln!(out);
}

fn indent<W: Write>(out: &mut W) {
    let _ignored = write!(out, "{}", " ".repeat(GUTTER));
}

pub(crate) fn section<W: Write>(out: &mut W, title: &str, qualifier: Option<&str>) {
    let label = match qualifier {
        Some(q) => format!("\u{2500}\u{2500} {title} \u{00b7} {q} "),
        None => format!("\u{2500}\u{2500} {title} "),
    };
    let trail = term_width()
        .saturating_sub(label.chars().count())
        .max(MIN_RULE);
    paint(
        out,
        Tone::Heading,
        &format!("{label}{}", "\u{2500}".repeat(trail)),
    );
    newline(out);
}

pub(crate) fn blank<W: Write>(out: &mut W) {
    newline(out);
}

pub(crate) fn empty<W: Write>(out: &mut W, what: &str) {
    indent(out);
    paint(out, Tone::Muted, &format!("({what})"));
    newline(out);
}

pub(crate) fn note<W: Write>(out: &mut W, text: &str) {
    indent(out);
    paint(out, Tone::Muted, text);
    newline(out);
}

pub(crate) fn warning<W: Write>(out: &mut W, text: &str) {
    indent(out);
    paint(out, Mark::Warn.tone(), &Mark::Warn.glyph().to_string());
    let _ignored = write!(out, " {text}");
    newline(out);
}

pub(crate) fn hidden<W: Write>(out: &mut W, count: usize, flag: &str) {
    if count == 0 {
        return;
    }
    note(out, &format!("{count} hidden \u{00b7} {flag} to include"));
}

pub(crate) fn print_index(title: &str, blurb: &str, entries: &[(&str, &str)]) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    section(&mut out, title, None);
    note(&mut out, blurb);
    blank(&mut out);
    let mut rows = Rows::new();
    for (command, what) in entries {
        rows.add(command, what);
    }
    rows.write(&mut out);
}

#[derive(Debug, Default)]
pub(crate) struct Rows {
    entries: Vec<Row>,
    depth: usize,
}

pub(crate) fn indent_to<W: Write>(out: &mut W, depth: usize) {
    let width = GUTTER.saturating_add(depth.saturating_mul(GUTTER));
    let _ignored = write!(out, "{}", " ".repeat(width));
}

pub(crate) fn key_line<W: Write>(out: &mut W, depth: usize, key: &str) {
    indent_to(out, depth);
    paint(out, Tone::Heading, key);
    let _ignored = write!(out, ":");
    newline(out);
}

#[derive(Debug)]
struct Row {
    mark: Mark,
    label: String,
    value: String,
    note: String,
    tone: Tone,
}

impl Row {
    fn label_tone(&self) -> Tone {
        match self.mark {
            Mark::None => Tone::Muted,
            Mark::Active | Mark::On | Mark::Off | Mark::Warn => self.tone,
        }
    }
}

impl Rows {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn at_depth(depth: usize) -> Self {
        Self {
            entries: Vec::new(),
            depth,
        }
    }

    pub(crate) fn add(&mut self, label: &str, value: &str) {
        self.push(Mark::None, label, value, Tone::Plain);
    }

    pub(crate) fn add_toned(&mut self, label: &str, value: &str, tone: Tone) {
        self.push(Mark::None, label, value, tone);
    }

    pub(crate) fn add_marked(&mut self, mark: Mark, label: &str, value: &str, tone: Tone) {
        self.push(mark, label, value, tone);
    }

    pub(crate) fn add_noted(&mut self, label: &str, value: &str, note: &str, tone: Tone) {
        self.add_marked_noted(Mark::None, label, value, note, tone);
    }

    pub(crate) fn add_marked_noted(
        &mut self,
        mark: Mark,
        label: &str,
        value: &str,
        note: &str,
        tone: Tone,
    ) {
        self.entries.push(Row {
            mark,
            label: label.to_owned(),
            value: value.to_owned(),
            note: note.to_owned(),
            tone,
        });
    }

    fn push(&mut self, mark: Mark, label: &str, value: &str, tone: Tone) {
        self.entries.push(Row {
            mark,
            label: label.to_owned(),
            value: value.to_owned(),
            note: String::new(),
            tone,
        });
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn any_marked(&self) -> bool {
        self.entries.iter().any(|r| r.mark != Mark::None)
    }

    fn label_width(&self) -> usize {
        self.entries
            .iter()
            .map(|r| r.label.chars().count())
            .max()
            .unwrap_or(0)
    }

    fn value_width(&self) -> usize {
        self.entries
            .iter()
            .filter(|r| !r.note.is_empty())
            .map(|r| r.value.chars().count())
            .max()
            .unwrap_or(0)
    }

    pub(crate) fn write<W: Write>(&self, out: &mut W) {
        let width = self.label_width();
        let notes = self.value_width();
        let marked = self.any_marked();
        for row in &self.entries {
            indent_to(out, self.depth);
            if marked {
                paint(out, row.mark.tone(), &row.mark.glyph().to_string());
                let _ignored = write!(out, "{}", " ".repeat(MARK_COLUMN.saturating_sub(1)));
            }
            paint(out, row.label_tone(), &row.label);
            if row.value.is_empty() {
                newline(out);
                continue;
            }
            let pad = width
                .saturating_sub(row.label.chars().count())
                .saturating_add(COLUMN_GAP);
            let _ignored = write!(out, "{}", " ".repeat(pad));
            paint(out, row.tone, &row.value);
            if !row.note.is_empty() {
                let gap = notes
                    .saturating_sub(row.value.chars().count())
                    .saturating_add(COLUMN_GAP);
                let _note_pad = write!(out, "{}", " ".repeat(gap));
                paint(out, Tone::Muted, &row.note);
            }
            newline(out);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Align {
    Left,
    Right,
}

#[derive(Debug)]
pub(crate) struct Table {
    headers: Vec<String>,
    aligns: Vec<Align>,
    rows: Vec<Vec<String>>,
    tones: Vec<Tone>,
    total: Option<Vec<String>>,
}

impl Table {
    pub(crate) fn new(headers: &[&str], aligns: &[Align]) -> Self {
        Self {
            headers: headers.iter().map(|h| (*h).to_owned()).collect(),
            aligns: aligns.to_vec(),
            rows: Vec::new(),
            tones: Vec::new(),
            total: None,
        }
    }

    pub(crate) fn row(&mut self, cells: &[String]) {
        self.row_toned(cells, Tone::Plain);
    }

    pub(crate) fn row_toned(&mut self, cells: &[String], tone: Tone) {
        self.rows
            .push(cells.iter().map(|c| ellipsize(c, MAX_CELL)).collect());
        self.tones.push(tone);
    }

    pub(crate) fn total(&mut self, cells: &[String]) {
        self.total = Some(cells.to_vec());
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    fn widths(&self) -> Vec<usize> {
        let mut widths: Vec<usize> = self.headers.iter().map(|h| h.chars().count()).collect();
        let all = self.rows.iter().chain(self.total.iter());
        for row in all {
            for (i, cell) in row.iter().enumerate() {
                let len = cell.chars().count();
                match widths.get_mut(i) {
                    Some(w) if *w < len => *w = len,
                    Some(_) | None => {}
                }
            }
        }
        widths
    }

    fn write_cells<W: Write>(&self, out: &mut W, cells: &[String], widths: &[usize], tone: Tone) {
        indent(out);
        let mut line = String::new();
        for (i, cell) in cells.iter().enumerate() {
            let width = widths.get(i).copied().unwrap_or(0);
            let align = self.aligns.get(i).copied().unwrap_or(Align::Left);
            let pad = width.saturating_sub(cell.chars().count());
            match align {
                Align::Left => {
                    line.push_str(cell);
                    if i.saturating_add(1) < cells.len() {
                        line.push_str(&" ".repeat(pad));
                    }
                }
                Align::Right => {
                    line.push_str(&" ".repeat(pad));
                    line.push_str(cell);
                }
            }
            if i.saturating_add(1) < cells.len() {
                line.push_str(&" ".repeat(COLUMN_GAP));
            }
        }
        paint(out, tone, line.trim_end());
        newline(out);
    }

    pub(crate) fn write<W: Write>(&self, out: &mut W) {
        let widths = self.widths();
        let headers: Vec<String> = self.headers.iter().map(|h| h.to_uppercase()).collect();
        self.write_cells(out, &headers, &widths, Tone::Muted);
        for (i, row) in self.rows.iter().enumerate() {
            let tone = self.tones.get(i).copied().unwrap_or(Tone::Plain);
            self.write_cells(out, row, &widths, tone);
        }
        if let Some(total) = self.total.as_ref() {
            self.write_cells(out, total, &widths, Tone::Muted);
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Meter {
    filled: usize,
    over: usize,
    percent: u64,
}

impl Meter {
    #[expect(
        clippy::float_arithmetic,
        reason = "a proportional bar is inherently a ratio of two measured amounts"
    )]
    pub(crate) fn new(current: f64, limit: f64) -> Self {
        if limit.is_nan() || limit <= 0.0 || !current.is_finite() {
            return Self {
                filled: 0,
                over: 0,
                percent: 0,
            };
        }
        let fraction = (current / limit).max(0.0);
        let cells = f64::from(u32::try_from(BAR_CELLS).unwrap_or(u32::MAX));
        let filled = scale(fraction.min(1.0) * cells);
        let over = scale((fraction - 1.0).max(0.0) * cells).min(OVER_CELLS);
        let percent = scale_u64(fraction * 100.0);
        Self {
            filled,
            over,
            percent,
        }
    }

    pub(crate) fn is_over(self) -> bool {
        self.over > 0 || self.percent >= 100
    }

    pub(crate) fn tone(self) -> Tone {
        if self.is_over() {
            Tone::Bad
        } else if self.percent >= 85 {
            Tone::Warn
        } else {
            Tone::Good
        }
    }

    #[cfg(test)]
    pub(crate) fn percent(self) -> u64 {
        self.percent
    }

    pub(crate) fn write_row<W: Write>(
        &self,
        out: &mut W,
        label: &str,
        label_width: usize,
        detail: &str,
    ) {
        indent(out);
        let pad = label_width
            .saturating_sub(label.chars().count())
            .saturating_add(COLUMN_GAP);
        paint(out, Tone::Muted, label);
        let _ignored = write!(out, "{}", " ".repeat(pad));
        self.write(out);
        _ = write!(out, "  {detail:>18}");
        paint(out, self.tone(), &format!("  {:>4}%", self.percent));
        newline(out);
    }

    pub(crate) fn write<W: Write>(&self, out: &mut W) {
        let filled = self.filled.min(BAR_CELLS);
        let bar = format!(
            "{}{}",
            "\u{2588}".repeat(filled),
            "\u{2591}".repeat(BAR_CELLS.saturating_sub(filled))
        );
        paint(out, self.tone(), &bar);
        if self.over > 0 {
            paint(out, Tone::Bad, &"\u{25b8}".repeat(self.over));
            let _ignored = write!(out, "{}", " ".repeat(OVER_CELLS.saturating_sub(self.over)));
        } else {
            let _ignored = write!(out, "{}", " ".repeat(OVER_CELLS));
        }
    }
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "bar cell counts are bounded by BAR_CELLS after clamping"
)]
fn scale(value: f64) -> usize {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.round().min(4096.0) as usize
}

#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "percent is clamped before conversion"
)]
fn scale_u64(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.round().min(9_999_999.0) as u64
}

#[expect(
    clippy::float_arithmetic,
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "token counts are rendered as human-scaled decimals"
)]
pub(crate) fn count(value: u64) -> String {
    if value == 0 {
        return ZERO.to_owned();
    }
    if value < 1_000 {
        return value.to_string();
    }
    if value < 1_000_000 {
        return format!("{:.1}K", (value as f64) / 1_000.0);
    }
    format!("{:.1}M", (value as f64) / 1_000_000.0)
}

pub(crate) fn money(value: f64) -> String {
    if !value.is_finite() {
        return "$0.00".to_owned();
    }
    if value > 0.0 && value < 0.01 {
        return "<$0.01".to_owned();
    }
    format!("${value:.2}")
}

pub(crate) const SIGIL_THINKING: char = '\u{25cc}';
pub(crate) const SIGIL_TOOL: char = '\u{2192}';
pub(crate) const SIGIL_OK: char = '\u{2713}';
pub(crate) const SIGIL_ERROR: char = '\u{2717}';
pub(crate) const SIGIL_SUBAGENT: char = '\u{00bb}';

pub(crate) const COLOR_THINKING: Tone = Tone::Thinking;
pub(crate) const COLOR_TOOL: Tone = Tone::Warn;
pub(crate) const COLOR_RESULT: Tone = Tone::Good;
pub(crate) const COLOR_SUBAGENT: Tone = Tone::Active;
pub(crate) const COLOR_ERROR: Tone = Tone::Bad;

pub(crate) const CHANNEL_BAR: char = '\u{2502}';
pub(crate) const PROCESS_INDENT_WIDTH: usize = 5;
pub(crate) const MIN_PROCESS_WIDTH: usize = 24;

pub(crate) fn process_wrap_width() -> usize {
    term_width()
        .saturating_sub(PROCESS_INDENT_WIDTH)
        .max(MIN_PROCESS_WIDTH)
}

fn write_gutter(out: &mut impl Write) {
    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    let _ignored = write!(out, " {CHANNEL_BAR} ");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
}

pub(crate) fn write_channel_rule(out: &mut impl Write) {
    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    let _ignored = writeln!(out, " {CHANNEL_BAR}");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
}

pub(crate) fn write_sigil_header(out: &mut impl Write, sigil: char, text: &str, tone: Tone) {
    write_gutter(out);
    paint(out, tone, &format!("{sigil} {text}"));
    let _ignored = writeln!(out);
}

const MIN_BODY_WRAP: usize = 16;

pub(crate) fn write_process_body(out: &mut impl Write, body: &str) {
    if body.is_empty() {
        return;
    }
    let base = process_wrap_width();
    for line in body.lines() {
        if line.trim().is_empty() {
            write_channel_rule(out);
            continue;
        }
        let indent_len = line.chars().take_while(|c| *c == ' ').count();
        let content = line.get(indent_len..).unwrap_or("");
        let avail = base.saturating_sub(indent_len).max(MIN_BODY_WRAP);
        let indent = " ".repeat(indent_len);
        if use_color() {
            let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
        }
        for wrapped in wrap_line(content, avail) {
            let _ignored = writeln!(out, " {CHANNEL_BAR}   {indent}{wrapped}");
        }
        if use_color() {
            let _ignored = crossterm::execute!(out, ResetColor);
        }
    }
}

pub(crate) fn write_thinking_content_line(out: &mut impl Write, line: &str, width: usize) {
    if line.trim().is_empty() {
        write_channel_rule(out);
        return;
    }
    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    for wrapped in wrap_line(line, width) {
        let _ignored = writeln!(out, " {CHANNEL_BAR}   {wrapped}");
    }
    if use_color() {
        let _ignored = crossterm::execute!(out, ResetColor);
    }
}

pub(crate) fn primary_tool_arg(input: &serde_json::Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "path",
        "file_path",
        "command",
        "cmd",
        "query",
        "pattern",
        "url",
        "name",
        "key",
    ];
    let obj = input.as_object()?;
    for key in KEYS {
        if let Some(raw) = obj.get(*key).and_then(|v| v.as_str()) {
            let s = raw.trim();
            if !s.is_empty() {
                return Some(truncate_chars(s, 60));
            }
        }
    }
    None
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let kept: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{kept}\u{2026}")
    }
}

pub(crate) fn wrap_line(text: &str, width_in: usize) -> Vec<String> {
    let width = width_in.max(1);
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0_usize;
    for word in text.split_whitespace() {
        let wlen = word.chars().count();
        if cur_len == 0 {
            cur.push_str(word);
            cur_len = wlen;
        } else if cur_len.saturating_add(1).saturating_add(wlen) <= width {
            cur.push(' ');
            cur.push_str(word);
            cur_len = cur_len.saturating_add(1).saturating_add(wlen);
        } else {
            lines.push(std::mem::take(&mut cur));
            cur.push_str(word);
            cur_len = wlen;
        }
    }
    lines.push(cur);
    lines
}

pub(crate) fn write_fg(out: &mut impl Write, color: Tone, text: &str) {
    paint(out, color, text);
}

pub(crate) fn write_dim(out: &mut impl Write, text: &str) {
    write_fg(out, Tone::Muted, text);
}

pub(crate) fn print_dim_line(out: &mut impl Write, text: &str) {
    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    let _ignored = writeln!(out, "  {text}");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
}

pub(crate) fn write_section_header(out: &mut impl Write, title: &str, suffix: &str, width: usize) {
    let prefix = if suffix.is_empty() {
        format!("\u{2500}\u{2500} {title} ")
    } else {
        format!("\u{2500}\u{2500} {title} ({suffix}) ")
    };
    let prefix_len = prefix.chars().count();
    let trail = width.saturating_sub(prefix_len);
    let rule: String = "\u{2500}".repeat(trail);

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::White));
    }
    let _ignored = write!(out, "{prefix}{rule}");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out);
}

const ROW_LABEL_WIDTH: usize = 13;

pub(crate) fn write_row_with(out: &mut impl Write, label: &str, value: &str, color: Option<Tone>) {
    let gap = if label.chars().count() >= ROW_LABEL_WIDTH {
        " "
    } else {
        ""
    };
    write_dim(out, &format!("  {label:<ROW_LABEL_WIDTH$}{gap}"));
    match color {
        Some(c) => write_fg(out, c, value),
        None => {
            let _ignored = write!(out, "{value}");
        }
    }
    let _ignored = writeln!(out);
}

pub(crate) fn write_row(out: &mut impl Write, label: &str, value: &str) {
    write_row_with(out, label, value, None);
}

pub(crate) fn write_row_colored(out: &mut impl Write, label: &str, value: &str, color: Tone) {
    write_row_with(out, label, value, Some(color));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;

    fn render<F: FnOnce(&mut Vec<u8>)>(f: F) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        f(&mut buf);
        String::from_utf8(buf).unwrap_or_default()
    }

    #[test]
    fn rows_measure_the_label_column_instead_of_truncating_it() {
        let out = render(|buf| {
            let mut rows = Rows::new();
            rows.add("SDK", "deepseek");
            rows.add("Max output tokens", "8192");
            rows.add("Provider", "deepseek");
            rows.write(buf);
        });
        let value_columns: Vec<usize> = out
            .lines()
            .filter_map(|line| line.rfind("  ").map(|i| i.saturating_add(2)))
            .collect();
        assert!(
            value_columns.windows(2).all(|w| w.first() == w.get(1)),
            "every value must start at the same column regardless of label length: {out:?}"
        );
        assert!(
            out.starts_with("  SDK                deepseek\n"),
            "the column is measured from the widest label, not a fixed width: {out:?}"
        );
    }

    #[test]
    fn rows_without_marks_do_not_reserve_a_mark_column() {
        let out = render(|buf| {
            let mut rows = Rows::new();
            rows.add("model", "kimi-k3");
            rows.write(buf);
        });
        assert_eq!(out, "  model  kimi-k3\n");
    }

    #[test]
    fn one_marked_row_gives_every_row_the_same_mark_column() {
        let out = render(|buf| {
            let mut rows = Rows::new();
            rows.add_marked(Mark::Active, "heidi", "active", Tone::Active);
            rows.add_marked(Mark::None, "Yuna", "", Tone::Plain);
            rows.write(buf);
        });
        assert_eq!(
            out, "  * heidi  active\n    Yuna\n",
            "names must align whether or not the row carries a mark, \
             and a valueless row must not pad out to nothing"
        );
    }

    #[test]
    fn a_marked_row_paints_its_name_the_way_the_mark_does() {
        set_color_enabled(true);
        let mut buf = Vec::new();
        let mut rows = Rows::new();
        rows.add_marked(Mark::Active, "heidi", "", Tone::Active);
        rows.add_marked(Mark::None, "Yuna", "", Tone::Plain);
        rows.write(&mut buf);
        set_color_enabled(false);

        let out = String::from_utf8(buf).unwrap_or_default();
        let mut lines = out.lines();
        let active = lines.next().unwrap_or_default();
        let inactive = lines.next().unwrap_or_default();
        let muted = format!("{}", SetForegroundColor(Tone::Muted.color().unwrap()));
        let cyan = format!("{}", SetForegroundColor(Tone::Active.color().unwrap()));

        assert_ne!(Tone::Active.color(), Tone::Muted.color());
        if cyan == muted {
            return;
        }

        assert!(
            active.contains(&format!("{cyan}heidi")),
            "the active name must carry the mark's colour: {active:?}"
        );
        assert!(
            !active.contains(&format!("{muted}heidi")),
            "the active name must not also be dimmed: {active:?}"
        );
        assert!(
            inactive.contains(&format!("{muted}Yuna")),
            "an unmarked name stays dim: {inactive:?}"
        );
    }

    #[test]
    fn no_row_emits_trailing_whitespace_after_its_value() {
        let out = render(|buf| {
            let mut rows = Rows::new();
            rows.add("daemon", "up 29m");
            rows.write(buf);
        });
        for line in out.lines() {
            assert!(
                !line.ends_with(' '),
                "row must not ship trailing whitespace: {line:?}"
            );
        }
    }

    #[test]
    fn table_right_aligns_numeric_columns_and_trims_the_line() {
        let out = render(|buf| {
            let mut table = Table::new(
                &["model", "calls", "cost"],
                &[Align::Left, Align::Right, Align::Right],
            );
            table.row(&[
                "claude-opus-5".to_owned(),
                "35".to_owned(),
                "$2.75".to_owned(),
            ]);
            table.row(&["glm-5.2".to_owned(), "7".to_owned(), "$0.00".to_owned()]);
            table.write(buf);
        });
        assert_eq!(
            out,
            "  MODEL          CALLS   COST\n  \
               claude-opus-5     35  $2.75\n  \
               glm-5.2            7  $0.00\n"
        );
        for line in out.lines() {
            assert!(!line.ends_with(' '), "table line has trailing space");
        }
    }

    #[test]
    fn a_meter_under_the_limit_leaves_the_overflow_zone_blank() {
        let out = render(|buf| Meter::new(5.16, 15.00).write(buf));
        assert_eq!(
            out,
            "\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}    "
        );
    }

    #[test]
    fn a_meter_over_the_limit_spills_past_the_bar() {
        let meter = Meter::new(3.50, 2.63);
        assert!(meter.is_over(), "133% must read as over");
        assert_eq!(meter.percent(), 133);
        let out = render(|buf| meter.write(buf));
        assert!(
            out.contains('\u{25b8}'),
            "an over-limit meter must render overflow markers, not just a full bar"
        );
        assert_ne!(
            out,
            render(|buf| Meter::new(2.63, 2.63).write(buf)),
            "133% must not look identical to 100%"
        );
    }

    #[test]
    fn a_meter_with_no_limit_does_not_divide_by_zero() {
        let meter = Meter::new(10.0, 0.0);
        assert_eq!(meter.percent(), 0);
        assert!(!meter.is_over());
    }

    #[test]
    fn counts_render_zero_as_a_dash_not_a_digit() {
        assert_eq!(count(0), "\u{2014}");
        assert_eq!(count(35), "35");
        assert_eq!(count(8_042), "8.0K");
        assert_eq!(count(1_400_000), "1.4M");
    }

    #[test]
    fn money_never_reports_a_real_cost_as_zero() {
        assert_eq!(money(3.18), "$3.18");
        assert_eq!(money(0.0), "$0.00");
        assert_eq!(
            money(0.000_053_8),
            "<$0.01",
            "a nonzero cost must not round to $0.00"
        );
    }

    #[test]
    fn hidden_says_nothing_when_nothing_is_hidden() {
        let silent = render(|buf| hidden(buf, 0, "--all"));
        assert_eq!(silent, "");
        let stated = render(|buf| hidden(buf, 440, "--all"));
        assert_eq!(stated, "  440 hidden \u{00b7} --all to include\n");
    }

    fn source_files() -> Vec<(String, String)> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_some_and(|e| e == "rs") {
                    let rel = path
                        .strip_prefix(&root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .into_owned();
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        found.push((rel, text));
                    }
                }
            }
        }
        found
    }

    #[test]
    fn only_the_vocabulary_is_allowed_to_emit_color() {
        let mut offenders = Vec::new();
        for (name, text) in source_files() {
            if name == "output/vocab.rs" {
                continue;
            }
            for (i, line) in text.lines().enumerate() {
                if line.contains("SetForegroundColor") || line.contains("crossterm::style::Color") {
                    offenders.push(format!("{name}:{}", i.saturating_add(1)));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "color must come from output::vocab, not raw crossterm calls. \
             Offenders: {offenders:?}"
        );
    }

    #[test]
    fn only_the_vocabulary_is_allowed_to_hardcode_indentation() {
        let mut offenders = Vec::new();
        for (name, text) in source_files() {
            if name == "output/vocab.rs" {
                continue;
            }
            for (i, line) in text.lines().enumerate() {
                let writes = line.contains("write!") || line.contains("writeln!");
                if writes && line.contains("\"  ") {
                    offenders.push(format!("{name}:{}", i.saturating_add(1)));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "indentation must come from output::vocab, not literal spaces. \
             Offenders: {offenders:?}"
        );
    }

    #[test]
    fn a_runaway_cell_is_truncated_instead_of_blowing_out_the_column() {
        let out = render(|buf| {
            let mut table = Table::new(&["model", "cost"], &[Align::Left, Align::Right]);
            table.row(&["x".repeat(200), "$1.00".to_owned()]);
            table.row(&["short".to_owned(), "$2.00".to_owned()]);
            table.write(buf);
        });
        for line in out.lines() {
            assert!(
                line.chars().count() < 60,
                "one runaway name must not widen every row: {line:?}"
            );
        }
        assert!(
            out.contains('\u{2026}'),
            "truncation must be visible: {out}"
        );
    }

    #[test]
    fn meter_tone_warns_before_it_fails() {
        assert_eq!(Meter::new(5.0, 100.0).tone(), Tone::Good);
        assert_eq!(
            Meter::new(90.0, 100.0).tone(),
            Tone::Warn,
            "past the warn threshold but under the limit must read as warning"
        );
        assert_eq!(Meter::new(100.0, 100.0).tone(), Tone::Bad);
        assert_eq!(Meter::new(133.0, 100.0).tone(), Tone::Bad);
    }

    #[test]
    fn a_toned_write_actually_emits_colour_when_colour_is_on() {
        set_color_enabled(true);
        let mut buf = Vec::new();
        paint(&mut buf, Tone::Active, "hello");
        set_color_enabled(false);
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(
            out.contains('\u{1b}'),
            "a toned write must emit an escape sequence, not silently drop the colour: {out:?}"
        );
        assert!(out.contains("hello"), "{out:?}");
    }

    #[test]
    fn every_tone_except_plain_resolves_to_a_colour() {
        for tone in [
            Tone::Muted,
            Tone::Heading,
            Tone::Active,
            Tone::Good,
            Tone::Warn,
            Tone::Bad,
            Tone::Thinking,
            Tone::Speaker(0),
        ] {
            assert!(
                tone.color().is_some(),
                "{tone:?} must resolve to a colour or it is a silent no-op"
            );
        }
        assert!(
            Tone::Plain.color().is_none(),
            "Plain is deliberately uncoloured"
        );
    }

    #[test]
    fn every_mark_has_exactly_one_glyph_and_one_tone() {
        let marks = [Mark::Active, Mark::On, Mark::Off, Mark::Warn];
        let glyphs: Vec<char> = marks.iter().map(|m| m.glyph()).collect();
        let mut unique = glyphs.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            glyphs.len(),
            unique.len(),
            "two marks share a glyph, so one screen's meaning teaches the wrong thing on the next"
        );
    }
}
