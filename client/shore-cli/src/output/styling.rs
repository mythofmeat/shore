use std::io::{self, Write};
use std::sync::{Mutex, MutexGuard, PoisonError};

use shore_common::duration::format_duration_ms;
use shore_common::protocol::server_msg::{
    ConfigWarning, Phase, ProviderFallbackWarning, SendImage, ServerMessage, StreamChunk,
    StreamEnd, ToolCall, ToolResult, UsageWarning,
};
use shore_common::protocol::tool_display::{
    format_tool_input_with_limit, format_tool_output_with_limit,
};
use shore_common::protocol::types::ImageRef;

use super::vocab::{COLOR_ERROR, Tone, paint, paint_on_stderr};
use super::{
    COLOR_RESULT, COLOR_SUBAGENT, COLOR_THINKING, COLOR_TOOL, MAX_TOOL_OUTPUT, SIGIL_ERROR,
    SIGIL_OK, SIGIL_SUBAGENT, SIGIL_THINKING, SIGIL_TOOL, abbreviate_model, primary_tool_arg,
    process_wrap_width, settled_reasoning, write_channel_rule, write_process_body,
    write_sigil_header, write_thinking_content_line,
};
use crate::terminal_images;

#[expect(
    clippy::struct_excessive_bools,
    reason = "stream rendering state tracks independent cursor/channel flags"
)]
struct ChunkState {
    was_thinking: bool,
    has_emitted: bool,
    at_line_start: bool,
    last_was_process: bool,
    thinking_raw: String,
    thinking_written: usize,
}

impl ChunkState {
    const INITIAL: Self = Self {
        was_thinking: false,
        has_emitted: false,
        at_line_start: true,
        last_was_process: false,
        thinking_raw: String::new(),
        thinking_written: 0,
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

pub(crate) fn reset_chunk_state() {
    *lock_chunk_state() = ChunkState::INITIAL;
}

fn begin_block(out: &mut impl Write, state: &mut ChunkState, is_process: bool) {
    let had = state.has_emitted;
    state.has_emitted = true;
    let prev_process = state.last_was_process;
    state.last_was_process = is_process;
    if !had {
        return;
    }
    if !state.at_line_start {
        let _ignored = writeln!(out);
        state.at_line_start = true;
    }
    if prev_process && is_process {
        write_channel_rule(out);
    } else if is_process || prev_process {
        let _ignored = writeln!(out);
    } else {
    }
}

pub(crate) fn print_chunk(chunk: &StreamChunk) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();
    print_chunk_to(&mut out, &mut state, chunk);
    let _ignored = out.flush();
}

fn write_reasoning(out: &mut impl Write, state: &mut ChunkState, settled: &str, upto: usize) {
    if settled.is_empty() {
        return;
    }
    let width = process_wrap_width();
    for (index, line) in settled.split('\n').enumerate() {
        if index < state.thinking_written || index >= upto {
            continue;
        }
        write_thinking_content_line(out, line, width);
        state.thinking_written = index.saturating_add(1);
        state.at_line_start = true;
    }
}

fn stream_thinking(out: &mut impl Write, state: &mut ChunkState, text: &str) {
    state.thinking_raw.push_str(text);
    let settled = settled_reasoning(&state.thinking_raw);
    let decided = settled.split('\n').count().saturating_sub(1);
    write_reasoning(out, state, &settled, decided);
}

fn flush_thinking(out: &mut impl Write, state: &mut ChunkState) {
    if state.thinking_raw.is_empty() {
        return;
    }
    let settled = settled_reasoning(&state.thinking_raw);
    write_reasoning(out, state, &settled, usize::MAX);
    state.thinking_raw.clear();
    state.thinking_written = 0;
}

fn print_chunk_to(out: &mut impl Write, state: &mut ChunkState, chunk: &StreamChunk) {
    let is_thinking = chunk.content_type == "thinking";
    let first = !state.has_emitted;
    let transition = !first && state.was_thinking != is_thinking;

    if transition && state.was_thinking {
        flush_thinking(out, state);
    }
    if first || transition {
        begin_block(out, state, is_thinking);
        if is_thinking {
            write_sigil_header(out, SIGIL_THINKING, "Thinking", COLOR_THINKING);
            state.at_line_start = true;
        }
    }
    state.was_thinking = is_thinking;

    if chunk.text.is_empty() {
        return;
    }

    if is_thinking {
        stream_thinking(out, state, &chunk.text);
    } else {
        let _ignored = write!(out, "{}", chunk.text);
        state.at_line_start = chunk.text.ends_with('\n');
    }
}

pub(crate) fn print_subagent_begin(name: &str) {
    let stdout = crate::output::stdout();
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

pub(crate) fn print_subagent_end(name: &str) {
    let stdout = crate::output::stdout();
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

pub(crate) fn print_subagent_chunk(chunk: &StreamChunk) {
    if chunk.text.is_empty() {
        return;
    }
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();
    stream_thinking(&mut out, &mut state, &chunk.text);
    state.was_thinking = true;
    let _ignored = out.flush();
}

pub(crate) fn print_stream_end(end: &StreamEnd) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();

    {
        let mut state = lock_chunk_state();
        flush_thinking(&mut out, &mut state);
    }

    let _ignored = writeln!(out);

    let meta = format_stream_end_metadata(end);
    paint(&mut out, Tone::Muted, &meta);
    _ = writeln!(out);

    if matches!(end.finish_reason.as_str(), "max_tokens" | "length") {
        paint(
            &mut out,
            Tone::Warn,
            "[reply truncated: it reached the max_tokens ceiling and stops mid-sentence]",
        );
        _ = writeln!(out);
    }

    _ = writeln!(out);
}

fn format_stream_end_metadata(end: &StreamEnd) -> String {
    format!(
        "[{} | in:{} out:{} cache_r:{} cache_w:{} | ttft:{} total:{}]",
        abbreviate_model(&end.metadata.model),
        end.metadata.tokens.input,
        end.metadata.tokens.output,
        end.metadata.tokens.cache_read,
        end.metadata.tokens.cache_write,
        format_duration_ms(u64::from(end.metadata.timing.ttft_ms)),
        format_duration_ms(u64::from(end.metadata.timing.total_ms)),
    )
}

pub(crate) fn print_error(err: &dyn std::fmt::Display) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    paint_on_stderr(&mut out, Tone::Bad, "error");
    _ = writeln!(out, ": {err}");
}

pub(crate) fn print_provider_fallback_warning(w: &ProviderFallbackWarning) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    paint_on_stderr(&mut out, Tone::Warn, "warning");
    _ = writeln!(out, ": {}", w.message);
}

pub(crate) fn print_usage_warning(w: &UsageWarning) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    paint_on_stderr(&mut out, Tone::Warn, "warning");
    _ = writeln!(out, ": {}", w.message);
}

pub(crate) fn print_config_warning(w: &ConfigWarning) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    paint_on_stderr(&mut out, Tone::Warn, "config not applied");
    match w.character.as_deref() {
        Some(character) => _ = writeln!(out, " ({character}) {}: {}", w.path, w.message),
        None => _ = writeln!(out, " {}: {}", w.path, w.message),
    }
    _ = writeln!(
        out,
        "the daemon is still running the last config that loaded"
    );
}

pub(crate) fn print_warning_frame(msg: &ServerMessage) {
    match msg {
        ServerMessage::ProviderWarning(w) => {
            let stderr = io::stderr();
            let mut out = stderr.lock();
            paint_on_stderr(&mut out, Tone::Warn, "warning");
            _ = writeln!(out, ": {}", w.message);
        }
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
        | ServerMessage::RequestAccepted(_)
        | ServerMessage::RequestFinished(_)
        | ServerMessage::Unknown => {}
    }
}

pub(crate) fn print_server_error(code: &str, message: &str) {
    let stderr = io::stderr();
    let mut out = stderr.lock();

    paint_on_stderr(&mut out, Tone::Bad, "server error");
    _ = writeln!(out, " [{code}]: {message}");
}

pub(crate) fn print_send_image(img: &SendImage) {
    terminal_images::render_image(&img.path, img.caption.as_deref(), img.data.as_deref());
}

pub(crate) fn print_image_refs(refs: &[ImageRef]) {
    for img in refs {
        terminal_images::render_image(&img.path, img.caption.as_deref(), img.data.as_deref());
    }
}

pub(crate) fn format_tool_input(input: &serde_json::Value) -> Option<String> {
    format_tool_input_with_limit(input, Some(MAX_TOOL_OUTPUT))
}

pub(crate) fn format_tool_output(output: &str) -> String {
    format_tool_output_with_limit(output, None)
}

pub(crate) fn write_tool_body_plain(out: &mut impl Write, body: &str) {
    for line in body.lines() {
        super::vocab::indent_to(out, 0);
        let _ignored = writeln!(out, "{line}");
    }
}

pub(crate) fn print_tool_call(call: &ToolCall) {
    print_tool_call_styled(call, COLOR_TOOL);
}

pub(crate) fn print_subagent_tool_call(call: &ToolCall) {
    print_tool_call_styled(call, COLOR_SUBAGENT);
}

fn print_tool_call_styled(call: &ToolCall, color: Tone) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();

    flush_thinking(&mut out, &mut state);
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

pub(crate) fn print_tool_result(result: &ToolResult) {
    print_tool_result_styled(result, COLOR_RESULT);
}

pub(crate) fn print_subagent_tool_result(result: &ToolResult) {
    print_tool_result_styled(result, COLOR_SUBAGENT);
}

fn print_tool_result_styled(result: &ToolResult, ok_color: Tone) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    let mut state = lock_chunk_state();

    flush_thinking(&mut out, &mut state);
    begin_block(&mut out, &mut state, true);
    state.was_thinking = false;

    let (sigil, label, color) = if result.is_error {
        (SIGIL_ERROR, "error", COLOR_ERROR)
    } else {
        (SIGIL_OK, "result", ok_color)
    };
    write_sigil_header(&mut out, sigil, label, color);
    let body = format_tool_output(&result.output);
    write_process_body(&mut out, &body);
    state.at_line_start = true;
}

pub(crate) fn print_stream_start(regen: bool) {
    if !regen {
        return;
    }
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();

    paint(&mut out, Tone::Muted, "(regenerating...) ");
    _ = out.flush();
}

pub(crate) fn print_phase(phase: &Phase) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();

    let label = match phase.phase.as_str() {
        "thinking" => "thinking...",
        other => other,
    };

    paint(&mut out, Tone::Muted, &format!("({label}) "));
    _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;
    use shore_common::protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

    #[test]
    fn print_error_does_not_panic() {
        print_error(&"test error");
    }

    #[test]
    fn print_server_error_does_not_panic() {
        print_server_error("busy", "engine is busy");
    }

    #[test]
    fn stream_end_metadata_uses_compact_durations() {
        let end = StreamEnd {
            rid: None,
            msg_id: None,
            revision: None,
            content: String::new(),
            terminal_content_blocks: None,
            metadata: StreamMetadata {
                tokens: TokenCounts {
                    input: 66_605,
                    output: 4_196,
                    cache_read: 132_800,
                    cache_write: 0,
                },
                timing: TimingInfo {
                    ttft_ms: 5_677,
                    total_ms: 915_369,
                },
                model: "glm-5.3".into(),
            },
            finish_reason: "stop".into(),
            is_final: true,
            subagent: None,
            task_id: None,
        };

        assert_eq!(
            format_stream_end_metadata(&end),
            "[glm-5.3 | in:66605 out:4196 cache_r:132800 cache_w:0 | ttft:5.6s total:15.25m]"
        );
    }

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

    fn chunk(content_type: &str, text: &str) -> StreamChunk {
        StreamChunk {
            subagent: None,
            task_id: None,
            rid: None,
            text: text.into(),
            content_type: content_type.into(),
        }
    }

    #[test]
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh stream"]
    fn render_preview_stream() {
        set_color_enabled(true);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
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
    fn streaming_thinking_reflows_a_newline_per_token_upstream() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        for delta in [
            "He",
            "'s",
            "\n",
            " wrapping",
            "\n",
            " up",
            ",\n",
            " budget",
            "\n",
            " dying",
            ".\n",
            " Keep",
            "\n",
            " it",
            "\n",
            " SHORT",
            ".",
        ] {
            print_chunk_to(&mut buf, &mut state, &chunk("thinking", delta));
        }
        flush_thinking(&mut buf, &mut state);
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   He's wrapping up, budget dying. Keep it SHORT.\n"
        );
    }

    #[test]
    fn streaming_thinking_holds_a_line_until_the_break_is_settled() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "first thought"));
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "\n"));
        assert_eq!(
            String::from_utf8(buf.clone()).unwrap(),
            " \u{2502} \u{25cc} Thinking\n",
            "a break nothing follows yet is not a line break yet"
        );
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "Second thought"));
        flush_thinking(&mut buf, &mut state);
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            " \u{2502} \u{25cc} Thinking\n \u{2502}   first thought\n \u{2502}   Second thought\n"
        );
    }

    #[test]
    fn streaming_thinking_keeps_a_paragraph_break_the_model_wrote() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "Weighing it up."));
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "\n\n"));
        print_chunk_to(
            &mut buf,
            &mut state,
            &chunk("thinking", "So: keep it short."),
        );
        flush_thinking(&mut buf, &mut state);
        let output = String::from_utf8(buf).unwrap();
        assert_eq!(
            output,
            " \u{2502} \u{25cc} Thinking\n \u{2502}   Weighing it up.\n \u{2502}\n \u{2502}   So: keep it short.\n"
        );
    }

    #[test]
    fn streaming_interleaved_thinking_header_both_directions() {
        set_color_enabled(false);
        let mut state = ChunkState::default();
        let mut buf = Vec::new();
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "T1"));
        print_chunk_to(&mut buf, &mut state, &chunk("text", "A1"));
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "T2"));
        print_chunk_to(&mut buf, &mut state, &chunk("text", "A2"));
        let output = String::from_utf8(buf).unwrap();

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
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "line one\nli"));
        print_chunk_to(&mut buf, &mut state, &chunk("thinking", "ne two"));
        flush_thinking(&mut buf, &mut state);
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
