use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crossterm::style::{Color, ResetColor, SetForegroundColor};
use shore_common::protocol::server_msg::{
    ConfigWarning, Phase, ProviderFallbackWarning, SendImage, ServerMessage, StreamChunk,
    StreamEnd, ToolCall, ToolResult, UsageWarning,
};
use shore_common::protocol::tool_display::{
    format_tool_input_with_limit, format_tool_output_with_limit,
};
use shore_common::protocol::types::ImageRef;

use super::{
    COLOR_RESULT, COLOR_SUBAGENT, COLOR_THINKING, COLOR_TOOL, MAX_TOOL_OUTPUT, SIGIL_ERROR,
    SIGIL_OK, SIGIL_SUBAGENT, SIGIL_THINKING, SIGIL_TOOL, abbreviate_model, primary_tool_arg,
    process_wrap_width, use_color, write_channel_rule, write_process_body, write_sigil_header,
    write_thinking_content_line,
};
use crate::images;

/// Running state for the stream, tracking enough to render the same cohesive
/// channel layout as the transcript: speech flush-left, and thinking/tool/result
/// as a dim inset "process" channel with blank lines between blocks.
#[expect(
    clippy::struct_excessive_bools,
    reason = "stream rendering state tracks independent cursor/channel flags"
)]
struct ChunkState {
    /// Whether the previous chunk was thinking content.
    was_thinking: bool,
    /// Whether anything has been printed this turn (the first block gets no
    /// leading blank line).
    has_emitted: bool,
    /// Whether the cursor is at the start of a line.
    at_line_start: bool,
    /// Whether the last block was a process block (thinking/tool/result) — used
    /// to decide when a blank-line separator is needed.
    last_was_process: bool,
    /// Buffer for the in-progress thinking logical line, accumulated across
    /// chunks until a `\n` completes it.
    thinking_line: String,
}

impl ChunkState {
    /// Initial state: nothing emitted, cursor at column 0 (the assistant header
    /// line ends with a newline before streaming begins).
    const INITIAL: Self = Self {
        was_thinking: false,
        has_emitted: false,
        at_line_start: true,
        last_was_process: false,
        thinking_line: String::new(),
    };
}

impl Default for ChunkState {
    fn default() -> Self {
        Self::INITIAL
    }
}

static CHUNK_STATE: Mutex<ChunkState> = Mutex::new(ChunkState::INITIAL);

fn lock_chunk_state() -> MutexGuard<'static, ChunkState> {
    CHUNK_STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Reset stream chunk state. Call once at the start of each turn (not per
/// tool-loop round) so blank-line separation survives across rounds.
pub(crate) fn reset_chunk_state() {
    *lock_chunk_state() = ChunkState::INITIAL;
}

/// Begin a new block, inserting a blank-line separator when either this block
/// or the previous one is a process block. The first block of the turn gets no
/// leading blank.
fn begin_block(out: &mut impl Write, state: &mut ChunkState, is_process: bool) {
    let had = state.has_emitted;
    state.has_emitted = true;
    let prev_process = state.last_was_process;
    state.last_was_process = is_process;
    if !had {
        return;
    }
    if !state.at_line_start {
        let _ignored = writeln!(out); // close the open content line
        state.at_line_start = true;
    }
    if prev_process && is_process {
        write_channel_rule(out); // keep the gutter unbroken between blocks
    } else if is_process || prev_process {
        let _ignored = writeln!(out); // channel ↔ speech boundary
    } else {
        // Speech ↔ speech: no separator needed.
    }
}

/// Print a stream chunk to stdout. Thinking renders as a dim, inset, sigil-led
/// process block; response text is written verbatim (flush-left, soft-wrapped).
pub(crate) fn print_chunk(chunk: &StreamChunk) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();
    print_chunk_to(&mut out, &mut state, chunk);
    let _ignored = out.flush();
}

/// Flush any buffered thinking that did not end in a newline. Emits the partial
/// line into the process channel, leaving the cursor at a fresh line start.
fn flush_thinking(out: &mut impl Write, state: &mut ChunkState) {
    if state.thinking_line.is_empty() {
        return;
    }
    let line = std::mem::take(&mut state.thinking_line);
    write_thinking_content_line(out, &line, process_wrap_width());
    state.at_line_start = true;
}

/// Render a single chunk to `out`. Thinking is buffered per logical line and
/// emitted dim + word-wrapped + sigil-led; transitions between thinking and
/// speech get a blank-line separator. Response text is written verbatim.
fn print_chunk_to(out: &mut impl Write, state: &mut ChunkState, chunk: &StreamChunk) {
    let is_thinking = chunk.content_type == "thinking";
    let first = !state.has_emitted;
    let transition = !first && state.was_thinking != is_thinking;

    if transition && state.was_thinking {
        flush_thinking(out, state); // commit the tail of the thinking block first
    }
    if first || transition {
        begin_block(out, state, is_thinking);
        if is_thinking {
            // Open the thinking block with its colored header; content follows.
            write_sigil_header(out, SIGIL_THINKING, "Thinking", COLOR_THINKING);
            state.at_line_start = true;
        }
    }
    state.was_thinking = is_thinking;

    if chunk.text.is_empty() {
        return;
    }

    if is_thinking {
        let width = process_wrap_width();
        for ch in chunk.text.chars() {
            if ch == '\n' {
                // A complete logical line (possibly empty) — emit it now.
                let line = std::mem::take(&mut state.thinking_line);
                write_thinking_content_line(out, &line, width);
                state.at_line_start = true;
            } else {
                state.thinking_line.push(ch);
            }
        }
    } else {
        let _ignored = write!(out, "{}", chunk.text);
        state.at_line_start = chunk.text.ends_with('\n');
    }
}

/// Open a sub-agent's nested section with a dim, sigil-led header
/// (`» <name> (sub-agent)`). The frames that follow — its thinking, tool calls,
/// results, and output — render in the process channel until [`print_subagent_end`].
pub(crate) fn print_subagent_begin(name: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();
    flush_thinking(&mut out, &mut state);
    begin_block(&mut out, &mut state, true);
    state.was_thinking = false;
    write_sigil_header(
        &mut out,
        SIGIL_SUBAGENT,
        &format!("{name} (sub-agent)"),
        COLOR_SUBAGENT,
    );
    state.at_line_start = true;
    let _ignored = out.flush();
}

/// Close a sub-agent's nested section (`» <name> done`).
pub(crate) fn print_subagent_end(name: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();
    flush_thinking(&mut out, &mut state);
    begin_block(&mut out, &mut state, true);
    state.was_thinking = false;
    write_sigil_header(
        &mut out,
        SIGIL_SUBAGENT,
        &format!("{name} done"),
        COLOR_SUBAGENT,
    );
    state.at_line_start = true;
    let _ignored = out.flush();
}

/// Render a sub-agent stream chunk. Both its thinking and its output text go to
/// the dim process channel (buffered per logical line like thinking), so the
/// whole nested section stays visually distinct from the primary model's
/// flush-left speech.
pub(crate) fn print_subagent_chunk(chunk: &StreamChunk) {
    if chunk.text.is_empty() {
        return;
    }
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();
    let width = process_wrap_width();
    for ch in chunk.text.chars() {
        if ch == '\n' {
            let line = std::mem::take(&mut state.thinking_line);
            write_thinking_content_line(&mut out, &line, width);
            state.at_line_start = true;
        } else {
            state.thinking_line.push(ch);
        }
    }
    // Treat the buffered tail as thinking so a transition back to primary
    // speech flushes it with a separator.
    state.was_thinking = true;
    let _ignored = out.flush();
}

/// Print stream metadata after stream_end.
pub(crate) fn print_stream_end(end: &StreamEnd) {
    let stdout = io::stdout();
    let mut out = stdout.lock();

    // Commit any buffered thinking that ended without a newline.
    {
        let mut state = lock_chunk_state();
        flush_thinking(&mut out, &mut state);
    }

    // Newline after streamed content
    let _ignored = writeln!(out);

    // Metadata line in dim
    let model = abbreviate_model(&end.metadata.model);
    if use_color() {
        _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    _ = write!(
        out,
        "[{} | in:{} out:{} cache_r:{} cache_w:{} | ttft:{}ms total:{}ms]",
        model,
        end.metadata.tokens.input,
        end.metadata.tokens.output,
        end.metadata.tokens.cache_read,
        end.metadata.tokens.cache_write,
        end.metadata.timing.ttft_ms,
        end.metadata.timing.total_ms,
    );
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out);

    // A reply that stopped at the token ceiling is cut off mid-sentence.
    // Without this the truncation is indistinguishable from a short answer.
    if matches!(end.finish_reason.as_str(), "max_tokens" | "length") {
        if use_color() {
            _ = crossterm::execute!(out, SetForegroundColor(Color::Yellow));
        }
        _ = write!(
            out,
            "[reply truncated: it reached the max_tokens ceiling and stops mid-sentence]"
        );
        if use_color() {
            _ = crossterm::execute!(out, ResetColor);
        }
        _ = writeln!(out);
    }

    _ = writeln!(out); // blank line after metadata
}

/// Print an error in red to stderr.
pub(crate) fn print_error(err: &dyn std::fmt::Display) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Red));
    }
    let _ignored = write!(out, "error");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out, ": {err}");
}

/// Print a provider key fallback warning. Emitted when the daemon
/// rotates away from a credential-flagged key (e.g. an exhausted budget
/// key) so the user sees the rotation immediately.
pub(crate) fn print_provider_fallback_warning(w: &ProviderFallbackWarning) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Yellow));
    }
    let _ignored = write!(out, "warning");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out, ": {}", w.message);
}

/// Print a usage budget warning emitted after a threshold crossing.
pub(crate) fn print_usage_warning(w: &UsageWarning) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Yellow));
    }
    let _ignored = write!(out, "warning");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out, ": {}", w.message);
}

/// Print a config file the daemon read but would not adopt.
///
/// Named separately from [`print_usage_warning`] because the path matters as
/// much as the message: the point is to say *which* file on disk is not the one
/// the daemon is running on.
pub(crate) fn print_config_warning(w: &ConfigWarning) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Yellow));
    }
    let _ignored = write!(out, "config not applied");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    match w.character.as_deref() {
        Some(character) => _ = writeln!(out, " ({character}) {}: {}", w.path, w.message),
        None => _ = writeln!(out, " {}: {}", w.path, w.message),
    }
    _ = writeln!(
        out,
        "the daemon is still running the last config that loaded"
    );
}

/// Print whichever warning frame this is.
///
/// The three of them are handled together because the caller treats them the
/// same way — stop the spinner, say the thing, carry on with the turn — and
/// spelling that out three times is what pushed `recv_streaming_response` past
/// its line budget.
pub(crate) fn print_warning_frame(msg: &ServerMessage) {
    match msg {
        ServerMessage::ProviderFallbackWarning(w) => print_provider_fallback_warning(w),
        ServerMessage::UsageWarning(w) => print_usage_warning(w),
        ServerMessage::ConfigWarning(w) => print_config_warning(w),
        ServerMessage::Hello(_)
        | ServerMessage::History(_)
        | ServerMessage::Shutdown(_)
        | ServerMessage::Ping(_)
        | ServerMessage::CommandOutput(_)
        | ServerMessage::Error(_)
        | ServerMessage::StreamStart(_)
        | ServerMessage::StreamChunk(_)
        | ServerMessage::StreamEnd(_)
        | ServerMessage::Phase(_)
        | ServerMessage::NewMessage(_)
        | ServerMessage::ToolCall(_)
        | ServerMessage::ToolResult(_)
        | ServerMessage::SendImage(_)
        | ServerMessage::CacheWarning(_)
        | ServerMessage::Unknown => {}
    }
}

/// Print a server protocol error.
pub(crate) fn print_server_error(code: &str, message: &str) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::Red));
    }
    let _ignored = write!(out, "server error");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = writeln!(out, " [{code}]: {message}");
}

/// Render an inline image from a SendImage server message.
pub(crate) fn print_send_image(img: &SendImage) {
    images::render_image(&img.path, img.caption.as_deref(), img.data.as_deref());
}

/// Render inline images from a message's image references.
pub(crate) fn print_image_refs(refs: &[ImageRef]) {
    for img in refs {
        images::render_image(&img.path, img.caption.as_deref(), img.data.as_deref());
    }
}

/// Format a tool input value for display.
pub(crate) fn format_tool_input(input: &serde_json::Value) -> Option<String> {
    format_tool_input_with_limit(input, Some(MAX_TOOL_OUTPUT))
}

/// Format a tool result for display. Not truncated — results are shown in full.
pub(crate) fn format_tool_output(output: &str) -> String {
    format_tool_output_with_limit(output, None)
}

pub(crate) fn write_tool_body_plain(out: &mut impl Write, body: &str) {
    for line in body.lines() {
        let _ignored = writeln!(out, "  {line}");
    }
}

/// Print a tool call into the process channel: `→ name · arg` then its input.
pub(crate) fn print_tool_call(call: &ToolCall) {
    print_tool_call_styled(call, COLOR_TOOL);
}

/// As [`print_tool_call`], but for a sub-agent's nested loop — rendered in the
/// sub-agent color so a nested tool call reads differently from the primary
/// model's.
pub(crate) fn print_subagent_tool_call(call: &ToolCall) {
    print_tool_call_styled(call, COLOR_SUBAGENT);
}

fn print_tool_call_styled(call: &ToolCall, color: Color) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();

    flush_thinking(&mut out, &mut state); // commit any buffered thinking first
    begin_block(&mut out, &mut state, true);
    state.was_thinking = false;

    let header = match primary_tool_arg(&call.input) {
        Some(arg) => format!("{} \u{00b7} {arg}", call.tool_name),
        None => call.tool_name.clone(),
    };
    write_sigil_header(&mut out, SIGIL_TOOL, &header, color);
    if let Some(input) = format_tool_input(&call.input) {
        write_process_body(&mut out, &input);
    }
    state.at_line_start = true;
}

/// Print a tool result into the process channel: `✓ result` / `✗ error` then
/// the (truncated) output.
pub(crate) fn print_tool_result(result: &ToolResult) {
    print_tool_result_styled(result, COLOR_RESULT);
}

/// As [`print_tool_result`], but for a sub-agent's nested loop — a successful
/// result uses the sub-agent color; errors stay red.
pub(crate) fn print_subagent_tool_result(result: &ToolResult) {
    print_tool_result_styled(result, COLOR_SUBAGENT);
}

fn print_tool_result_styled(result: &ToolResult, ok_color: Color) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();

    flush_thinking(&mut out, &mut state);
    begin_block(&mut out, &mut state, true);
    state.was_thinking = false;

    let (sigil, label, color) = if result.is_error {
        (SIGIL_ERROR, "error", Color::Red)
    } else {
        (SIGIL_OK, "result", ok_color)
    };
    write_sigil_header(&mut out, sigil, label, color);
    // Body stays dim; the colored header carries the status.
    let body = format_tool_output(&result.output);
    write_process_body(&mut out, &body);
    state.at_line_start = true;
}

/// Print the "thinking..." indicator when streaming starts.
pub(crate) fn print_stream_start(regen: bool) {
    if !regen {
        return;
    }
    let stdout = io::stdout();
    let mut out = stdout.lock();

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    let _ignored = write!(out, "(regenerating...) ");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = out.flush();
}

/// Print a phase indicator (e.g. "thinking...") during streaming.
pub(crate) fn print_phase(phase: &Phase) {
    let stdout = io::stdout();
    let mut out = stdout.lock();

    let label = match phase.phase.as_str() {
        "thinking" => "thinking...",
        other => other,
    };

    if use_color() {
        let _ignored = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
    }
    let _ignored = write!(out, "({label}) ");
    if use_color() {
        _ = crossterm::execute!(out, ResetColor);
    }
    _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;

    #[test]
    fn print_error_does_not_panic() {
        print_error(&"test error");
    }

    #[test]
    fn print_server_error_does_not_panic() {
        print_server_error("busy", "engine is busy");
    }

    // ── format_tool_input content assertions ────────────────────────

    #[test]
    fn format_tool_input_empty_object_returns_none() {
        let input = serde_json::json!({});
        assert!(format_tool_input(&input).is_none());
    }

    #[test]
    fn format_tool_input_simple_object() {
        let input = serde_json::json!({"query": "weather"});
        let result = format_tool_input(&input).unwrap();
        assert!(result.contains("query"));
        assert!(result.contains("weather"));
    }

    #[test]
    fn format_tool_input_truncates_large_input() {
        let big = "x".repeat(MAX_TOOL_OUTPUT + 100);
        let input = serde_json::json!({"data": big});
        let result = format_tool_input(&input).unwrap();
        assert!(
            result.contains("truncated"),
            "large input should include a truncation notice"
        );
        assert!(
            result.contains("bytes total"),
            "large input should report the original display size"
        );
        assert!(
            result.len() <= MAX_TOOL_OUTPUT + 50,
            "truncated output should be bounded"
        );
    }

    #[test]
    fn format_tool_input_small_input_not_truncated() {
        let input = serde_json::json!({"key": "value", "num": 42});
        let result = format_tool_input(&input).unwrap();
        assert!(
            !result.ends_with("..."),
            "small input should not be truncated"
        );
        assert!(result.contains("42"));
    }

    // ── reset_chunk_state ───────────────────────────────────────────

    #[test]
    fn reset_chunk_state_clears_thinking() {
        set_color_enabled(false);
        {
            let mut s = CHUNK_STATE.lock().unwrap();
            s.was_thinking = true;
            s.has_emitted = true;
            s.at_line_start = false;
        }
        reset_chunk_state();
        let s = CHUNK_STATE.lock().unwrap();
        assert!(!s.was_thinking);
        assert!(!s.has_emitted);
        assert!(s.at_line_start);
    }

    fn chunk(content_type: &str, text: &str) -> StreamChunk {
        StreamChunk {
            subagent: None,
            rid: None,
            text: text.into(),
            content_type: content_type.into(),
        }
    }

    /// Visual preview harness (not an assertion). Streams interleaved thinking
    /// token-by-token through the real chunk renderer, color ON, and dumps the
    /// raw bytes so a terminal shows it exactly as live streaming would.
    ///
    /// Run it: `cargo test -p shore-cli render_preview_stream
    ///          -- --ignored --nocapture --test-threads=1`
    /// (or via `.claude/skills/run-shore-cli/preview.sh`).
    #[test]
    #[ignore = "visual preview; run explicitly with --ignored --nocapture"]
    fn render_preview_stream() {
        set_color_enabled(true);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        // A long thinking paragraph (streamed in fragments) to show wrapping.
        for c in [
            "Let me reason about this carefully — the user's query ",
            "spans more than the wrap width, so the gutter bar has to ",
            "continue down every wrapped row instead of only marking the ",
            "first line of the paragraph.",
        ] {
            print_chunk_to(&mut buf, &mut state, &chunk("thinking", c));
        }
        for c in ["Here's ", "the first ", "answer."] {
            print_chunk_to(&mut buf, &mut state, &chunk("text", c));
        }
        for c in [
            "Now reconsidering, ",
            "having seen the result, I can refine it.",
        ] {
            print_chunk_to(&mut buf, &mut state, &chunk("thinking", c));
        }
        for c in ["And ", "the refined ", "conclusion."] {
            print_chunk_to(&mut buf, &mut state, &chunk("text", c));
        }
        set_color_enabled(false);
        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"\n----- STREAMING RENDER (live tokens) -----\n");
        _ = stdout.write_all(&buf);
        _ = stdout.write_all(b"\n----- end -----\n");
        _ = stdout.flush();
    }

    #[test]
    fn streaming_interleaved_thinking_header_both_directions() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        // thinking -> text -> thinking -> text, each as a single chunk.
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "T1"));
        print_chunk_to(&mut buf, &mut state, &chunk("text", "A1"));
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "T2"));
        print_chunk_to(&mut buf, &mut state, &chunk("text", "A2"));
        let output = String::from_utf8(buf).unwrap();

        // Each thinking block opens with a `◌ Thinking` header; a blank line
        // straddles every thinking/speech transition.
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   T1\n\nA1\n\n \u{2502} \u{25cc} Thinking\n \u{2502}   T2\n\nA2"
        );
    }

    #[test]
    fn streaming_thinking_buffers_logical_lines_across_chunks() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        // A logical line is split across chunks (the newline lands mid-chunk,
        // and a word straddles the boundary). The header is emitted at block
        // start; each completed content line is inset. The trailing partial
        // line waits for a flush.
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "line one\nli"));
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "ne two"));
        flush_thinking(&mut buf, &mut state); // simulate stream end
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   line one\n \u{2502}   line two\n"
        );
    }

    #[test]
    fn streaming_thinking_flushed_before_tool_call() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        // The header is emitted as soon as the block opens; the content line
        // (no trailing newline) waits for the flush before a ToolCall/StreamEnd.
        print_chunk_to(
            &mut buf,
            &mut state,
            &chunk("thinking", "deciding to call a tool"),
        );
        assert_eq!(
            String::from_utf8(buf.clone()).unwrap(),
            " \u{2502} \u{25cc} Thinking\n",
            "header is emitted, content is still buffered"
        );
        flush_thinking(&mut buf, &mut state);
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   deciding to call a tool\n"
        );
    }

    #[test]
    fn streaming_consecutive_same_type_chunks_not_separated() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        print_chunk_to(&mut buf, &mut state, &chunk("text", "Hello "));
        print_chunk_to(&mut buf, &mut state, &chunk("text", "world"));
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(output, "Hello world");
    }
}
