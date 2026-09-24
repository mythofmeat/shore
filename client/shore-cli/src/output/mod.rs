pub(crate) mod autonomy;
pub(crate) mod catalog;
pub(crate) mod commands;
pub(crate) mod config;
pub(crate) mod history;
pub(crate) mod reasoning;
pub(crate) mod spinner;
pub(crate) mod status;
pub(crate) mod styling;
pub(crate) mod tools;
pub(crate) mod transcript;
pub(crate) mod usage;
pub(crate) mod vocab;
pub(crate) mod workspace;

pub(crate) use commands::*;
pub(crate) use reasoning::{reflow_reasoning, settled_reasoning};
pub(crate) use spinner::*;
pub(crate) use styling::*;
pub(crate) use transcript::*;
pub(crate) use vocab::{
    COLOR_RESULT, COLOR_SUBAGENT, COLOR_THINKING, COLOR_TOOL, SIGIL_ERROR, SIGIL_OK,
    SIGIL_SUBAGENT, SIGIL_THINKING, SIGIL_TOOL, primary_tool_arg, print_dim_line,
    process_wrap_width, write_channel_rule, write_dim, write_fg, write_process_body, write_row,
    write_row_colored, write_section_header, write_sigil_header, write_thinking_content_line,
};

use std::fmt;
use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, FixedOffset, Local};

static STDOUT_ERROR: std::sync::Mutex<Option<io::Error>> = std::sync::Mutex::new(None);

pub(crate) struct OutputWriter<W>(W);

fn record_output_error<T>(result: io::Result<T>) -> io::Result<T> {
    if let Err(error) = &result {
        let mut first = STDOUT_ERROR
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if first.is_none() {
            *first = Some(io::Error::new(error.kind(), error.to_string()));
        }
    }
    result
}

impl<W: Write> Write for OutputWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        record_output_error(self.0.write(buf))
    }

    fn flush(&mut self) -> io::Result<()> {
        record_output_error(self.0.flush())
    }
}

impl OutputWriter<io::Stdout> {
    pub(crate) fn lock(&self) -> OutputWriter<io::StdoutLock<'static>> {
        OutputWriter(self.0.lock())
    }
}

impl<W: IsTerminal> OutputWriter<W> {
    pub(crate) fn is_terminal(&self) -> bool {
        self.0.is_terminal()
    }
}

pub(crate) fn stdout() -> OutputWriter<io::Stdout> {
    OutputWriter(io::stdout())
}

pub(crate) fn finish_stdout() -> io::Result<()> {
    let _flush = stdout().flush();
    let recorded = STDOUT_ERROR
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    match recorded {
        Some(error) if error.kind() != io::ErrorKind::BrokenPipe => Err(error),
        Some(_) | None => Ok(()),
    }
}

static COLOR_STDOUT: AtomicBool = AtomicBool::new(true);
static COLOR_STDERR: AtomicBool = AtomicBool::new(true);
static DECORATE_STDOUT: AtomicBool = AtomicBool::new(true);

#[cfg(test)]
thread_local! {
    static COLOR_FOR_THIS_TEST_THREAD: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
    static DECORATION_FOR_THIS_TEST_THREAD: std::cell::Cell<Option<bool>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_color_enabled(enabled: bool) {
    COLOR_FOR_THIS_TEST_THREAD.with(|forced| forced.set(Some(enabled)));
}

#[cfg(test)]
fn color_override() -> Option<bool> {
    COLOR_FOR_THIS_TEST_THREAD.with(std::cell::Cell::get)
}

#[cfg(not(test))]
const fn color_override() -> Option<bool> {
    None
}

#[cfg(test)]
fn decoration_override() -> Option<bool> {
    DECORATION_FOR_THIS_TEST_THREAD.with(std::cell::Cell::get)
}

#[cfg(not(test))]
const fn decoration_override() -> Option<bool> {
    None
}

pub(crate) fn detect_color() {
    let vetoed = env_flag_set("NO_COLOR");
    let forced = env_flag_set("FORCE_COLOR");
    let stdout_is_screen = forced || stdout().is_terminal();
    COLOR_STDOUT.store(
        color_for_stream(vetoed, forced, stdout().is_terminal()),
        Ordering::Relaxed,
    );
    COLOR_STDERR.store(
        color_for_stream(vetoed, forced, io::stderr().is_terminal()),
        Ordering::Relaxed,
    );
    DECORATE_STDOUT.store(stdout_is_screen, Ordering::Relaxed);
}

fn env_flag_set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty())
}

fn color_for_stream(vetoed: bool, forced: bool, is_terminal: bool) -> bool {
    !vetoed && (forced || is_terminal)
}

pub(crate) fn use_color() -> bool {
    color_override().unwrap_or_else(|| COLOR_STDOUT.load(Ordering::Relaxed))
}

pub(crate) fn use_color_on_stderr() -> bool {
    color_override().unwrap_or_else(|| COLOR_STDERR.load(Ordering::Relaxed))
}

pub(crate) fn use_decoration() -> bool {
    decoration_override().unwrap_or_else(|| DECORATE_STDOUT.load(Ordering::Relaxed))
}

#[cfg(test)]
pub(crate) fn set_decoration_enabled(enabled: bool) {
    DECORATION_FOR_THIS_TEST_THREAD.with(|forced| forced.set(Some(enabled)));
}

pub(crate) fn write_stdout_line(args: fmt::Arguments<'_>) {
    let stdout = stdout();
    let mut out = stdout.lock();
    let _ignored = writeln!(out, "{args}");
}

pub(crate) fn write_stdout(args: fmt::Arguments<'_>) {
    let stdout = stdout();
    let mut out = stdout.lock();
    let _ignored = write!(out, "{args}");
}

pub(crate) fn write_stderr_line(args: fmt::Arguments<'_>) {
    let stderr = io::stderr();
    let mut out = stderr.lock();
    let _ignored = writeln!(out, "{args}");
}

pub(crate) fn abbreviate_model(model_id: &str) -> &str {
    if let Some(i) = model_id.rfind('-') {
        let suffix = i.checked_add(1).and_then(|start| model_id.get(start..));
        if suffix.is_some_and(|s| s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit())) {
            return model_id.get(..i).unwrap_or(model_id);
        }
    }
    model_id
}

pub(crate) fn models_by_provider(data: &serde_json::Value) -> Vec<serde_json::Value> {
    let Some(groups) = data.get("models").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (provider, models) in groups {
        for model in models.as_array().map_or(&[][..], Vec::as_slice) {
            let mut entry = model.clone();
            if let Some(fields) = entry.as_object_mut() {
                let _replaced = fields.insert(
                    "provider".to_owned(),
                    serde_json::Value::String(provider.clone()),
                );
            }
            out.push(entry);
        }
    }
    out.sort_by_key(|entry| {
        u8::from(
            !entry
                .get("favorite")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        )
    });
    out
}

pub(crate) const MAX_TOOL_OUTPUT: usize = 500;

pub(crate) fn term_width() -> usize {
    if cfg!(test) {
        return 80;
    }
    crossterm::terminal::size().map_or(80, |(w, _)| usize::from(w))
}

pub(crate) fn parse_timestamp(ts: &str) -> Option<DateTime<Local>> {
    DateTime::<FixedOffset>::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&Local))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::vocab::wrap_line;
    use super::*;

    #[test]
    fn a_terminal_gets_colour_and_a_pipe_does_not() {
        assert!(color_for_stream(false, false, true));
        assert!(!color_for_stream(false, false, false));
    }

    #[test]
    fn force_color_overrides_the_pipe_and_no_color_overrides_everything() {
        assert!(color_for_stream(false, true, false));
        assert!(!color_for_stream(true, false, true));
        assert!(!color_for_stream(true, true, true));
    }

    #[test]
    fn abbreviate_strips_date_suffix() {
        assert_eq!(
            abbreviate_model("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5"
        );
        assert_eq!(
            abbreviate_model("claude-sonnet-4-20250514"),
            "claude-sonnet-4"
        );
    }

    #[test]
    fn abbreviate_preserves_short_names() {
        assert_eq!(abbreviate_model("test-model"), "test-model");
        assert_eq!(abbreviate_model("opus"), "opus");
    }

    #[test]
    fn abbreviate_preserves_non_date_suffix() {
        assert_eq!(abbreviate_model("model-latest"), "model-latest");
        assert_eq!(abbreviate_model("model-v2"), "model-v2");
    }

    #[test]
    fn wrap_line_breaks_at_word_boundaries() {
        assert_eq!(
            wrap_line("the quick brown fox jumps", 10),
            vec!["the quick", "brown fox", "jumps"]
        );
    }

    #[test]
    fn wrap_line_short_input_is_single_line() {
        assert_eq!(wrap_line("hello world", 80), vec!["hello world"]);
    }

    #[test]
    fn wrap_line_long_word_is_not_split() {
        assert_eq!(
            wrap_line("a supercalifragilistic b", 8),
            vec!["a", "supercalifragilistic", "b"]
        );
    }

    #[test]
    fn wrap_line_collapses_whitespace() {
        assert_eq!(wrap_line("  spaced   out  ", 80), vec!["spaced out"]);
        assert_eq!(wrap_line("", 80), vec![""]);
    }

    #[test]
    fn write_thinking_content_line_wraps_and_gutters() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_thinking_content_line(&mut buf, "the quick brown fox jumps", 10);
        let out = String::from_utf8(buf).unwrap();
        assert_eq!(
            out,
            " \u{2502}   the quick\n \u{2502}   brown fox\n \u{2502}   jumps\n"
        );
    }

    #[test]
    fn write_thinking_content_line_blank_is_bar_only() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_thinking_content_line(&mut buf, "   ", 80);
        let out = String::from_utf8(buf).unwrap();
        assert_eq!(out, " \u{2502}\n");
    }

    #[test]
    fn write_sigil_header_gutters_then_sigil_and_label() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_sigil_header(&mut buf, SIGIL_THINKING, "Thinking", COLOR_THINKING);
        let out = String::from_utf8(buf).unwrap();
        assert_eq!(out, " \u{2502} \u{25cc} Thinking\n");
    }

    #[test]
    fn write_channel_rule_is_bar_only() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_channel_rule(&mut buf);
        assert_eq!(String::from_utf8(buf).unwrap(), " \u{2502}\n");
    }

    #[test]
    fn process_body_wraps_long_lines_keeping_the_gutter() {
        set_color_enabled(false);
        let long = "word ".repeat(80);
        let mut buf = Vec::new();
        write_process_body(&mut buf, &format!("  {}", long.trim_end()));
        let out = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines.len() > 1, "a very long line must wrap to many rows");
        for l in &lines {
            assert!(l.starts_with(" \u{2502}   "), "row lost the gutter: {l:?}");
        }
    }

    #[test]
    fn primary_tool_arg_picks_known_key() {
        let input = serde_json::json!({"path": "src/main.rs", "edits": []});
        assert_eq!(primary_tool_arg(&input).as_deref(), Some("src/main.rs"));
        let unknown_input = serde_json::json!({"foo": "bar"});
        assert_eq!(primary_tool_arg(&unknown_input), None);
    }

    #[test]
    fn primary_tool_arg_truncates_long_values() {
        let long = "a".repeat(100);
        let input = serde_json::json!({ "command": long });
        let arg = primary_tool_arg(&input).unwrap();
        assert_eq!(arg.chars().count(), 60);
        assert!(arg.ends_with('\u{2026}'));
    }
}
