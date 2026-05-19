use ratatui::text::Line;
use shore_protocol::server_msg::ServerMessage;
use shore_protocol::types::{CharacterInfo, ImageRef, StreamMetadata, TokenCounts};
use shore_swp_client::audio::AudioPlayer;

use crate::images::ImageCache;

/// Cached output of `draw_conversation`'s line-building pass.
///
/// Building these lines walks every entry, runs markdown rendering, and
/// word-wraps everything — work proportional to total conversation size.
/// Without a cache, every keystroke pays that cost, so input latency grows
/// with conversation length. The cache hits when the cheap fingerprint
/// (entries length + last-entry summary + stream/toggle state + image cache
/// version + width) matches the previous build.
#[derive(Default)]
pub struct ConvCache {
    pub fingerprint: ConvFingerprint,
    pub lines: Vec<Line<'static>>,
    pub content_visual: u16,
}

/// Cheap snapshot of state that affects `draw_conversation`'s output.
///
/// Computed on every frame; if it equals the cached snapshot, the lines
/// are reused. Tracks lengths and counts rather than full string contents
/// because mutations almost always grow text or push entries — full
/// equality would defeat the purpose by being as expensive as the work
/// being cached.
#[derive(Default, PartialEq, Eq, Clone)]
pub struct ConvFingerprint {
    pub width: u16,
    pub entries_len: u32,
    pub last_entry: u64,
    pub second_last_entry: u64,
    /// Bumped whenever the entries vec is replaced wholesale (History resync,
    /// :edit, :delete). Counts/summaries can collide across replacements when
    /// only entries before the last two change, so a monotonic counter is the
    /// only reliable way to invalidate the cache for those edits.
    pub history_version: u64,
    pub stream_active: bool,
    pub stream_regen: bool,
    pub stream_blocks_len: u32,
    pub stream_last_block_len: u32,
    pub stream_phase_len: u32,
    pub stream_tool_name_len: i32,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    pub spinner_frame: u32,
    pub character_name_len: u32,
    pub image_cache_version: u64,
}

/// A single entry in the conversation log.
#[derive(Clone, Debug)]
pub enum ConversationEntry {
    User {
        content: String,
        images: Vec<ImageRef>,
        timestamp: String,
    },
    Assistant {
        #[allow(dead_code)] // captured from daemon; TUI currently only uses it for metadata attach
        msg_id: Option<String>,
        content: String,
        images: Vec<ImageRef>,
        timestamp: String,
        metadata: Option<StreamMetadata>,
    },
    System {
        content: String,
        /// Count of consecutive identical entries collapsed into this one.
        /// Starts at 1; incremented by `set_status` when the same message
        /// arrives repeatedly (e.g. a reconnect storm).
        count: u32,
        timestamp: String,
    },
    ArchiveBoundary {
        archived_count: usize,
    },
    Thinking {
        content: String,
    },
    ToolCall {
        #[allow(dead_code)] // stored for protocol fidelity; TUI renders by tool_name
        tool_id: String,
        tool_name: String,
        input: serde_json::Value,
    },
    ToolResult {
        #[allow(dead_code)] // stored for protocol fidelity; TUI renders by tool_name
        tool_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    },
}

#[derive(Clone, Debug)]
pub struct AltChoice {
    pub index: u32,
    pub position: u32,
    pub active: bool,
    pub content: String,
    pub images: Vec<ImageRef>,
    pub timestamp: String,
}

#[derive(Clone, Debug)]
pub struct AltPickerState {
    pub target_ref: Option<String>,
    pub msg_id: Option<String>,
    pub choices: Vec<AltChoice>,
    pub selected: usize,
    pub original_entries: Vec<ConversationEntry>,
    pub loading: bool,
}

/// A segment of streaming content, preserving interleaving order.
#[derive(Clone, Debug)]
pub enum StreamBlock {
    Thinking(String),
    Text(String),
}

/// Streaming state for in-progress responses.
#[derive(Default)]
pub struct StreamState {
    pub active: bool,
    pub regen: bool,
    pub blocks: Vec<StreamBlock>,
    pub phase: String,
    /// Name of the tool currently being called/executed.
    pub tool_name: Option<String>,
    // Accumulated across a multi-phase (tool-use) turn so the finalized
    // Assistant entry carries the full text and summed metadata rather than
    // just the first LLM call's partial slice. Cleared by reset().
    pub accumulated_text: String,
    pub accumulated_metadata: Option<StreamMetadata>,
}

impl StreamState {
    pub fn reset(&mut self) {
        self.active = false;
        self.regen = false;
        self.blocks.clear();
        self.phase.clear();
        self.tool_name = None;
        self.accumulated_text.clear();
        self.accumulated_metadata = None;
    }
}

/// Input editor mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputMode {
    Normal,
    Insert,
    Command,
}

/// Input editor state.
pub struct InputState {
    pub text: String,
    pub cursor: usize,
    pub mode: InputMode,
    /// Separate buffer for command palette input.
    pub cmd_text: String,
    pub cmd_cursor: usize,
}

impl Default for InputState {
    fn default() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
            mode: InputMode::Insert,
            cmd_text: String::new(),
            cmd_cursor: 0,
        }
    }
}

impl InputState {
    pub fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
    }

    pub fn insert_newline(&mut self) {
        self.insert_char('\n');
    }

    /// Insert a string at the cursor position (used for paste).
    pub fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let prev = self.text[..self.cursor]
                .char_indices()
                .next_back()
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.text.drain(prev..self.cursor);
            self.cursor = prev;
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let next = self.text[self.cursor..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.cursor + i)
                .unwrap_or(self.text.len());
            self.text.drain(self.cursor..next);
        }
    }

    pub fn backspace_word(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let before = &self.text[..self.cursor];
        // Skip trailing whitespace, then skip the word
        let after_ws = before.trim_end_matches(|c: char| c.is_whitespace());
        let after_word = after_ws.trim_end_matches(|c: char| !c.is_whitespace());
        let new_cursor = after_word.len();
        self.text.drain(new_cursor..self.cursor);
        self.cursor = new_cursor;
    }

    pub fn delete_word(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let after = &self.text[self.cursor..];
        // Skip leading whitespace, then skip the word
        let after_ws = after.trim_start_matches(|c: char| c.is_whitespace());
        let after_word = after_ws.trim_start_matches(|c: char| !c.is_whitespace());
        let delete_len = after.len() - after_word.len();
        self.text.drain(self.cursor..self.cursor + delete_len);
    }

    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor = self.text[..self.cursor]
                .char_indices()
                .next_back()
                .map(|(i, _)| i)
                .unwrap_or(0);
        }
    }

    pub fn move_right(&mut self) {
        if self.cursor < self.text.len() {
            self.cursor = self.text[self.cursor..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| self.cursor + i)
                .unwrap_or(self.text.len());
        }
    }

    pub fn move_home(&mut self) {
        // Move to start of current line
        let before = &self.text[..self.cursor];
        self.cursor = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    }

    pub fn move_end(&mut self) {
        // Move to end of current line
        let after = &self.text[self.cursor..];
        self.cursor = after
            .find('\n')
            .map(|i| self.cursor + i)
            .unwrap_or(self.text.len());
    }

    pub fn take_text(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        text
    }

    pub fn set_text(&mut self, text: String) {
        self.cursor = text.len();
        self.text = text;
    }

    #[cfg(test)]
    pub fn line_count(&self) -> usize {
        self.text.lines().count().max(1)
    }

    /// Visual line count accounting for word-wrap at the given content width.
    pub fn visual_line_count(&self, content_width: usize) -> usize {
        let starts = word_wrap_offsets(&self.text, content_width);
        let count = starts.len();

        // Add an extra line when the last visual line fills the width entirely,
        // so the cursor has room to sit on the next line at the boundary.
        if content_width > 0 && count > 0 {
            let last_start = starts[count - 1];
            let last_width: usize = self.text[last_start..]
                .chars()
                .take_while(|&c| c != '\n')
                .map(|c| unicode_width::UnicodeWidthChar::width(c).unwrap_or(0))
                .sum();
            if last_width >= content_width {
                return count + 1;
            }
        }

        count.max(1)
    }

    pub fn enter_command_mode(&mut self) {
        self.mode = InputMode::Command;
        self.cmd_text.clear();
        self.cmd_cursor = 0;
    }

    pub fn exit_command_mode(&mut self) {
        self.mode = InputMode::Normal;
        self.cmd_text.clear();
        self.cmd_cursor = 0;
    }

    pub fn cmd_insert_char(&mut self, c: char) {
        self.cmd_text.insert(self.cmd_cursor, c);
        self.cmd_cursor += c.len_utf8();
    }

    pub fn cmd_backspace(&mut self) {
        if self.cmd_cursor > 0 {
            let prev = self.cmd_text[..self.cmd_cursor]
                .char_indices()
                .next_back()
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.cmd_text.drain(prev..self.cmd_cursor);
            self.cmd_cursor = prev;
        }
    }

    pub fn take_cmd_text(&mut self) -> String {
        let text = std::mem::take(&mut self.cmd_text);
        self.cmd_cursor = 0;
        self.mode = InputMode::Normal;
        text
    }
}

/// Compute visual line start byte-offsets for word-wrapped text.
///
/// Returns a `Vec<usize>` where each entry is the byte index where a visual
/// line begins. The first entry is always `0`. Breaks happen at word
/// boundaries (spaces) when possible; falls back to character wrapping for
/// words longer than `max_width`.
pub fn word_wrap_offsets(text: &str, max_width: usize) -> Vec<usize> {
    let mut starts = vec![0usize];

    if max_width == 0 {
        for (i, ch) in text.char_indices() {
            if ch == '\n' {
                starts.push(i + ch.len_utf8());
            }
        }
        return starts;
    }

    let mut col: usize = 0;
    // Byte offset AFTER the last space on the current visual line.
    let mut last_space_after: Option<usize> = None;
    // Column value at the byte after that space.
    let mut col_at_space_after: usize = 0;

    for (i, ch) in text.char_indices() {
        if ch == '\n' {
            starts.push(i + ch.len_utf8());
            col = 0;
            last_space_after = None;
            continue;
        }

        let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);

        if col + w > max_width {
            if ch == ' ' {
                // Space at the overflow point — consume it as a line break.
                starts.push(i + ch.len_utf8());
                col = 0;
                last_space_after = None;
            } else if let Some(brk) = last_space_after {
                // Break at the previous word boundary.
                starts.push(brk);
                col = col - col_at_space_after + w;
                // Rescan for spaces between `brk` and `i` on the new line.
                last_space_after = None;
                for (j, c) in text[brk..i].char_indices() {
                    if c == ' ' {
                        let after = brk + j + c.len_utf8();
                        last_space_after = Some(after);
                        col_at_space_after = text[brk..after]
                            .chars()
                            .map(|ch| unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0))
                            .sum();
                    }
                }
            } else {
                // No space on this line — fall back to character wrap.
                starts.push(i);
                col = w;
                last_space_after = None;
            }
        } else {
            if ch == ' ' {
                last_space_after = Some(i + ch.len_utf8());
                col_at_space_after = col + w;
            }
            col += w;
        }
    }

    starts
}

/// Connection status for the status bar.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
}

/// Whether the palette is showing the top-level command list, a child
/// picker scoped to a command, or a focused value editor.
#[derive(Default, Clone)]
pub enum PaletteMode {
    #[default]
    Top,
    Submenu(SubmenuState),
    ValueEditor(ValueEditorState),
}

/// Per-submenu state. `cmd_text` doubles as the live filter while in
/// submenu mode; saved fields restore the parent input on Esc.
#[derive(Clone)]
pub struct SubmenuState {
    pub parent: String,
    pub saved_cmd_text: String,
    pub saved_cmd_cursor: usize,
}

/// Per-value-editor state. The saved fields restore the parent command
/// input on Esc, matching submenu cancellation semantics.
#[derive(Clone)]
pub struct ValueEditorState {
    pub key: String,
    pub kind: ValueEditorKind,
    pub saved_cmd_text: String,
    pub saved_cmd_cursor: usize,
}

#[derive(Clone)]
pub enum ValueEditorKind {
    Slider {
        min: f64,
        max: f64,
        step: f64,
        current: f64,
        typed: Option<String>,
        dirty: bool,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EffectiveSamplerField {
    pub value: Option<String>,
    pub scope: Option<String>,
}

/// Effective sampler values plus their provenance scopes, as returned by
/// the daemon's `model_settings` command.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EffectiveSamplerSnapshot {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub temperature: EffectiveSamplerField,
    pub top_p: EffectiveSamplerField,
    pub reasoning_effort: EffectiveSamplerField,
    pub thinking_enabled: EffectiveSamplerField,
    pub budget_tokens: EffectiveSamplerField,
    pub max_tokens: EffectiveSamplerField,
    pub cache_ttl: EffectiveSamplerField,
}

impl EffectiveSamplerSnapshot {
    pub fn from_model_settings(data: &serde_json::Value) -> Option<Self> {
        let sampler = data.get("effective_sampler")?;
        let scopes = data.get("scopes");
        Some(Self {
            model: data
                .get("model")
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
            provider: data
                .get("provider")
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
            model_id: data
                .get("model_id")
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
            temperature: Self::field(sampler, scopes, "temperature"),
            top_p: Self::field(sampler, scopes, "top_p"),
            reasoning_effort: Self::field(sampler, scopes, "reasoning_effort"),
            thinking_enabled: Self::field(sampler, scopes, "thinking_enabled"),
            budget_tokens: Self::field(sampler, scopes, "budget_tokens"),
            max_tokens: Self::field(sampler, scopes, "max_tokens"),
            cache_ttl: Self::field(sampler, scopes, "cache_ttl"),
        })
    }

    fn field(
        sampler: &serde_json::Value,
        scopes: Option<&serde_json::Value>,
        key: &str,
    ) -> EffectiveSamplerField {
        EffectiveSamplerField {
            value: sampler
                .get(key)
                .map(Self::display_json_value)
                .or_else(|| Some("unset".into())),
            scope: scopes
                .and_then(|s| s.get(key))
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
        }
    }

    fn display_json_value(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::Null => "unset".into(),
            serde_json::Value::Bool(v) => v.to_string(),
            serde_json::Value::Number(v) => v.to_string(),
            serde_json::Value::String(v) => v.clone(),
            other => other.to_string(),
        }
    }

    pub fn field_for_key(&self, key: &str) -> Option<&EffectiveSamplerField> {
        match key {
            "temperature" => Some(&self.temperature),
            "top_p" => Some(&self.top_p),
            "reasoning_effort" => Some(&self.reasoning_effort),
            "thinking_enabled" => Some(&self.thinking_enabled),
            "budget_tokens" => Some(&self.budget_tokens),
            "max_tokens" => Some(&self.max_tokens),
            "cache_ttl" => Some(&self.cache_ttl),
            _ => None,
        }
    }

    pub fn display_value(&self, key: &str) -> Option<&str> {
        self.field_for_key(key).and_then(|f| f.value.as_deref())
    }

    pub fn scope(&self, key: &str) -> Option<&str> {
        self.field_for_key(key).and_then(|f| f.scope.as_deref())
    }

    pub fn numeric_value(&self, key: &str) -> Option<f64> {
        self.display_value(key)?.parse().ok()
    }
}

/// Completion state for the command palette.
#[derive(Default)]
pub struct CompletionState {
    /// Filtered candidates matching current input.
    pub candidates: Vec<String>,
    /// Currently selected index (None = no selection).
    pub selected: Option<usize>,
    /// Section header shown above candidates when completing arguments
    /// to a known command (e.g. "model", "setting key"). `None` for the
    /// top-level command list.
    pub header: Option<String>,
    /// Top vs. submenu picker.
    pub mode: PaletteMode,
}

impl CompletionState {
    /// Reset the menu to a hidden state.
    pub fn clear(&mut self) {
        self.candidates.clear();
        self.selected = None;
        self.header = None;
        self.mode = PaletteMode::Top;
    }
}

/// An image in the conversation, with its position in the rendered line list.
#[derive(Clone, Debug)]
pub struct ImageEntry {
    /// Cache key (image path).
    pub path: String,
    /// Display name for the status bar.
    pub display_name: String,
    /// Line index in the conversation lines vec where this image starts.
    pub line: usize,
}

/// Main application state.
pub struct App {
    pub entries: Vec<ConversationEntry>,
    pub stream: StreamState,
    pub input: InputState,
    pub completion: CompletionState,
    pub alt_picker: Option<AltPickerState>,
    pub scroll_offset: u16,
    pub connection_status: ConnectionStatus,
    pub character_name: String,
    pub characters: Vec<CharacterInfo>,
    pub model_names: Vec<String>,
    pub active_model_names: Vec<String>,
    pub show_model_list: bool,
    pub model: String,
    pub effective_sampler: Option<EffectiveSamplerSnapshot>,
    pub sampler_settings_loading: bool,
    pub pending_sampler_settings_rid: Option<String>,
    pub sampler_settings_request_seq: u64,
    pub tokens: TokenCounts,
    pub is_private: bool,
    pub should_quit: bool,
    /// Set when quit was triggered by a SIGINT-equivalent (Ctrl+C keybind or
    /// external SIGINT). The shutdown path exits with code 130 afterward so
    /// supervisors see the conventional interrupt exit.
    pub interrupt: bool,
    pub auto_scroll: bool,
    /// Last known maximum conversation scroll offset, updated by the renderer.
    pub conversation_max_scroll: u16,
    /// Cursor for the next older archived history page.
    pub history_next_before: Option<usize>,
    pub history_has_more_before: bool,
    pub history_page_loading: bool,
    pub image_cache: ImageCache,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    pub show_help: bool,
    /// Images queued for attachment to the next outgoing message.
    pub pending_images: Vec<String>,
    /// Temp-file paths for paste-origin images, removed on TUI shutdown.
    pub paste_temp_paths: Vec<std::path::PathBuf>,
    /// When editing a message, holds the ref (e.g. "last", "-1") being edited.
    pub editing_ref: Option<String>,
    /// Index of all rendered images with their line positions, rebuilt each frame.
    pub image_index: Vec<ImageEntry>,
    /// When set, the fullscreen image viewer is active showing this image index.
    pub fullscreen: Option<usize>,
    /// TTS audio player; opened lazily on first AudioStart.
    pub audio_player: Option<AudioPlayer>,
    /// Whether live-speak mode is enabled in this session.
    pub live_speak: bool,
    /// Animation frame for transient progress indicators.
    pub spinner_frame: usize,
    /// Cached lines from the last `draw_conversation` rebuild. Reused on
    /// frames where the fingerprint of conversation-affecting state hasn't
    /// changed — the common case while the user is just typing.
    pub conv_cache: ConvCache,
    /// Bumped on every wholesale entries replacement so the conv cache
    /// fingerprint changes even when entry counts and last-two summaries
    /// happen to match.
    pub history_version: u64,
}

impl Default for App {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            stream: StreamState::default(),
            input: InputState::default(),
            completion: CompletionState::default(),
            alt_picker: None,
            scroll_offset: 0,
            connection_status: ConnectionStatus::Disconnected,
            character_name: String::new(),
            characters: Vec::new(),
            model_names: Vec::new(),
            active_model_names: Vec::new(),
            show_model_list: false,
            model: String::new(),
            effective_sampler: None,
            sampler_settings_loading: false,
            pending_sampler_settings_rid: None,
            sampler_settings_request_seq: 0,
            tokens: TokenCounts {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
            is_private: false,
            should_quit: false,
            interrupt: false,
            auto_scroll: true,
            conversation_max_scroll: 0,
            history_next_before: None,
            history_has_more_before: false,
            history_page_loading: false,
            image_cache: ImageCache::new(),
            show_thinking: true,
            show_tools: true,
            show_images: true,
            show_timestamps: false,
            show_metadata: true,
            show_help: false,
            pending_images: Vec::new(),
            paste_temp_paths: Vec::new(),
            editing_ref: None,
            image_index: Vec::new(),
            fullscreen: None,
            audio_player: None,
            live_speak: false,
            spinner_frame: 0,
            conv_cache: ConvCache::default(),
            history_version: 0,
        }
    }
}

impl App {
    /// Snapshot the state that affects `draw_conversation`'s output.
    ///
    /// Used as the cache key for the rendered conversation lines. The
    /// fingerprint stays cheap by hashing lengths, counts, and flags
    /// rather than full string contents — mutations to entry text grow
    /// `content.len()`, so a length match plus an `entries.len()` match
    /// is a tight enough proxy for "no change" without scanning bodies.
    pub fn conversation_fingerprint(&self, width: u16) -> ConvFingerprint {
        let entry_summary = |e: &ConversationEntry| -> u64 {
            // Pack a kind tag plus a content-size signature into a u64.
            // Different variants distinguish themselves via the high tag
            // byte; mutations within a variant change the lower bits.
            match e {
                ConversationEntry::User {
                    content, images, ..
                } => (1u64 << 56) | ((content.len() as u64) << 16) | (images.len() as u64),
                ConversationEntry::Assistant {
                    content,
                    images,
                    metadata,
                    ..
                } => {
                    (2u64 << 56)
                        | ((content.len() as u64) << 16)
                        | ((images.len() as u64) << 4)
                        | (metadata.is_some() as u64)
                }
                ConversationEntry::System { content, count, .. } => {
                    (3u64 << 56) | ((content.len() as u64) << 24) | (*count as u64)
                }
                ConversationEntry::ArchiveBoundary { archived_count } => {
                    (7u64 << 56) | (*archived_count as u64)
                }
                ConversationEntry::Thinking { content } => (4u64 << 56) | (content.len() as u64),
                ConversationEntry::ToolCall {
                    tool_name, input, ..
                } => {
                    (5u64 << 56)
                        | ((tool_name.len() as u64) << 24)
                        | (input.to_string().len() as u64)
                }
                ConversationEntry::ToolResult {
                    tool_name,
                    output,
                    is_error,
                    ..
                } => {
                    (6u64 << 56)
                        | ((tool_name.len() as u64) << 24)
                        | ((output.len() as u64) << 1)
                        | (*is_error as u64)
                }
            }
        };

        let last_entry = self.entries.last().map(entry_summary).unwrap_or(0);
        let second_last_entry = if self.entries.len() >= 2 {
            entry_summary(&self.entries[self.entries.len() - 2])
        } else {
            0
        };

        let (stream_blocks_len, stream_last_block_len) = match self.stream.blocks.last() {
            Some(StreamBlock::Thinking(s)) | Some(StreamBlock::Text(s)) => {
                (self.stream.blocks.len() as u32, s.len() as u32)
            }
            None => (0, 0),
        };

        ConvFingerprint {
            width,
            entries_len: self.entries.len() as u32,
            last_entry,
            second_last_entry,
            history_version: self.history_version,
            stream_active: self.stream.active,
            stream_regen: self.stream.regen,
            stream_blocks_len,
            stream_last_block_len,
            stream_phase_len: self.stream.phase.len() as u32,
            stream_tool_name_len: self
                .stream
                .tool_name
                .as_ref()
                .map(|s| s.len() as i32)
                .unwrap_or(-1),
            show_thinking: self.show_thinking,
            show_tools: self.show_tools,
            show_images: self.show_images,
            show_timestamps: self.show_timestamps,
            show_metadata: self.show_metadata,
            spinner_frame: self.spinner_frame as u32,
            character_name_len: self.character_name.len() as u32,
            image_cache_version: self.image_cache.version(),
        }
    }

    pub fn scroll_up(&mut self, amount: u16) {
        self.scroll_offset = self.scroll_offset.saturating_add(amount);
        self.auto_scroll = false;
    }

    pub fn scroll_down(&mut self, amount: u16) {
        self.scroll_offset = self.scroll_offset.saturating_sub(amount);
        if self.scroll_offset == 0 {
            self.auto_scroll = true;
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
        self.auto_scroll = true;
    }

    /// Optimistically transition into the "regenerating" UI state before the
    /// daemon's StreamStart arrives, so the spinner and (regenerating) label
    /// appear immediately. Mirrors what StreamStart does on receipt, so it is
    /// idempotent when the real StreamStart lands.
    //
    // Keep the previous assistant visible while the replacement streams.
    // The daemon now makes regeneration non-destructive by storing the old
    // reply as an alternate response; the History refresh after persistence
    // swaps the active visible response.
    pub fn begin_regen_optimistic(&mut self) {
        self.stream.reset();
        self.stream.active = true;
        self.stream.regen = true;
        self.spinner_frame = 0;
        self.scroll_to_bottom();
    }

    /// Resolve a ref (e.g. "last", "-1", "-2") to the content of a
    /// User or Assistant entry for local editing preview.
    pub fn resolve_ref_content(&self, raw_ref: &str) -> Option<String> {
        // Filter to only User/Assistant entries (what the daemon considers messages).
        let messages: Vec<&ConversationEntry> = self
            .entries
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    ConversationEntry::User { .. } | ConversationEntry::Assistant { .. }
                )
            })
            .collect();

        let entry = match raw_ref {
            "last" => messages.last().copied(),
            s if s.starts_with('-') => {
                let n: usize = s[1..].parse().ok()?;
                if n == 0 || n > messages.len() {
                    return None;
                }
                Some(messages[messages.len() - n])
            }
            _ => None,
        };

        entry.and_then(|e| match e {
            ConversationEntry::User { content, .. }
            | ConversationEntry::Assistant { content, .. } => Some(content.clone()),
            _ => None,
        })
    }

    /// Dispatch an audio-related server message into the TTS playback pipeline.
    pub fn handle_audio_message(&mut self, msg: &ServerMessage) {
        match msg {
            ServerMessage::AudioStart(start) => {
                if self.audio_player.is_none() {
                    match AudioPlayer::new() {
                        Ok(p) => self.audio_player = Some(p),
                        Err(e) => {
                            self.set_status(format!("audio unavailable: {e}"));
                            return;
                        }
                    }
                }
                if let Some(ref mut player) = self.audio_player {
                    player.start(start.sample_rate, start.channels);
                }
            }
            ServerMessage::AudioChunk(chunk) => {
                if let Some(ref player) = self.audio_player {
                    player.feed(&chunk.data);
                }
            }
            ServerMessage::AudioEnd(_) => {
                if let Some(ref player) = self.audio_player {
                    player.finish();
                }
            }
            ServerMessage::AudioError(err) => {
                self.set_status(format!("TTS error: {}", err.message));
            }
            _ => {}
        }
    }

    pub fn set_status(&mut self, msg: impl Into<String>) {
        let msg = msg.into();
        // Dedupe consecutive identical system messages (e.g. a reconnect
        // storm emitting the same reason over and over). If the tail entry
        // is already a matching System, bump its count in place instead of
        // appending a new entry.
        if let Some(ConversationEntry::System { content, count, .. }) = self.entries.last_mut() {
            if *content == msg {
                *count = count.saturating_add(1);
                if self.auto_scroll {
                    self.scroll_to_bottom();
                }
                return;
            }
        }
        self.entries.push(ConversationEntry::System {
            content: msg,
            count: 1,
            timestamp: String::new(),
        });
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    /// Remove every System entry from the conversation log. Invoked by
    /// `:clear` and automatically at the moment the user sends a new
    /// message (fresh turn = clean slate).
    pub fn clear_system_entries(&mut self) {
        self.entries
            .retain(|e| !matches!(e, ConversationEntry::System { .. }));
    }

    pub fn start_alt_picker(&mut self, target_ref: Option<String>) {
        if self.alt_picker.is_some() {
            self.cancel_alt_picker();
        }
        self.alt_picker = Some(AltPickerState {
            target_ref,
            msg_id: None,
            choices: Vec::new(),
            selected: 0,
            original_entries: self.entries.clone(),
            loading: true,
        });
    }

    pub fn populate_alt_picker(&mut self, msg_id: Option<String>, choices: Vec<AltChoice>) {
        if choices.is_empty() {
            if let Some(picker) = self.alt_picker.take() {
                self.entries = picker.original_entries;
                self.history_version = self.history_version.wrapping_add(1);
            }
            self.set_status("no alternate responses");
            return;
        }

        if self.alt_picker.is_none() {
            self.alt_picker = Some(AltPickerState {
                target_ref: msg_id.clone(),
                msg_id: msg_id.clone(),
                choices: Vec::new(),
                selected: 0,
                original_entries: self.entries.clone(),
                loading: false,
            });
        }

        if let Some(picker) = self.alt_picker.as_mut() {
            picker.msg_id = msg_id;
            picker.selected = choices.iter().position(|alt| alt.active).unwrap_or(0);
            picker.choices = choices;
            picker.loading = false;
        }
        self.preview_alt_selection();
    }

    pub fn next_alt(&mut self) {
        let Some(picker) = self.alt_picker.as_mut() else {
            return;
        };
        if picker.loading || picker.choices.is_empty() {
            return;
        }
        picker.selected = (picker.selected + 1) % picker.choices.len();
        self.preview_alt_selection();
    }

    pub fn prev_alt(&mut self) {
        let Some(picker) = self.alt_picker.as_mut() else {
            return;
        };
        if picker.loading || picker.choices.is_empty() {
            return;
        }
        picker.selected = match picker.selected {
            0 => picker.choices.len() - 1,
            n => n - 1,
        };
        self.preview_alt_selection();
    }

    pub fn cancel_alt_picker(&mut self) {
        if let Some(picker) = self.alt_picker.take() {
            self.entries = picker.original_entries;
            self.history_version = self.history_version.wrapping_add(1);
        }
    }

    pub fn selected_alt_command_args(&self) -> Option<serde_json::Value> {
        let picker = self.alt_picker.as_ref()?;
        if picker.loading {
            return None;
        }
        let choice = picker.choices.get(picker.selected)?;
        let mut args = serde_json::Map::new();
        args.insert("index".into(), serde_json::json!(choice.index));
        if let Some(msg_id) = picker.msg_id.as_deref().or(picker.target_ref.as_deref()) {
            args.insert("ref".into(), serde_json::json!(msg_id));
        }
        Some(serde_json::Value::Object(args))
    }

    pub fn close_alt_picker_after_confirm(&mut self) {
        self.alt_picker = None;
    }

    fn preview_alt_selection(&mut self) {
        let Some(picker) = self.alt_picker.as_ref() else {
            return;
        };
        if picker.loading {
            return;
        }
        let Some(choice) = picker.choices.get(picker.selected).cloned() else {
            return;
        };
        let msg_id = picker.msg_id.clone();
        let original_entries = picker.original_entries.clone();

        self.entries = original_entries;
        let target_idx = msg_id
            .as_deref()
            .and_then(|target| {
                self.entries.iter().position(|entry| {
                    matches!(
                        entry,
                        ConversationEntry::Assistant {
                            msg_id: Some(id),
                            ..
                        } if id == target
                    )
                })
            })
            .or_else(|| {
                self.entries
                    .iter()
                    .rposition(|entry| matches!(entry, ConversationEntry::Assistant { .. }))
            });

        if let Some(idx) = target_idx {
            if let ConversationEntry::Assistant {
                content,
                images,
                timestamp,
                metadata,
                ..
            } = &mut self.entries[idx]
            {
                *content = choice.content;
                *images = choice.images;
                *timestamp = choice.timestamp;
                *metadata = None;
                self.history_version = self.history_version.wrapping_add(1);
            }
        }
    }

    /// Canonical parent name for commands whose arguments are picked
    /// via a submenu rather than typed inline.
    pub fn canonical_submenu_parent(name: &str) -> Option<&'static str> {
        match name {
            "model" => Some("model"),
            "character" | "characters" => Some("character"),
            "setting" => Some("setting"),
            "view" => Some("view"),
            _ => None,
        }
    }

    pub fn is_submenu_open(&self, parent: &str) -> bool {
        matches!(&self.completion.mode, PaletteMode::Submenu(s) if s.parent == parent)
    }

    pub fn is_setting_palette_open(&self) -> bool {
        matches!(
            &self.completion.mode,
            PaletteMode::Submenu(s) if s.parent == "setting" || s.parent.starts_with("setting:")
        ) || matches!(&self.completion.mode, PaletteMode::ValueEditor(s) if Self::is_setting_key(&s.key))
    }

    pub fn is_value_editor_open(&self) -> bool {
        matches!(self.completion.mode, PaletteMode::ValueEditor(_))
    }

    pub fn set_active_model(&mut self, model: Option<&str>) {
        let next = model.filter(|m| !m.is_empty());
        let current = (!self.model.is_empty()).then_some(self.model.as_str());
        let changed = match (current, next) {
            (Some(current), Some(next)) => !Self::model_identifier_matches(current, next),
            (None, None) => false,
            _ => true,
        };
        if changed {
            self.effective_sampler = None;
            self.sampler_settings_loading = false;
            self.pending_sampler_settings_rid = None;
        }

        match model.filter(|m| !m.is_empty()) {
            Some(model) => {
                self.model = model.to_string();
                self.active_model_names = vec![model.to_string()];
            }
            None => {
                self.model.clear();
                self.active_model_names.clear();
            }
        }
    }

    pub fn sampler_snapshot_matches_active_model(
        &self,
        snapshot: &EffectiveSamplerSnapshot,
    ) -> bool {
        if self.model.is_empty() {
            return true;
        }
        if snapshot.model.is_none() && snapshot.model_id.is_none() && snapshot.provider.is_none() {
            return true;
        }

        snapshot
            .model
            .as_deref()
            .is_some_and(|model| self.is_active_model_candidate(model))
            || snapshot
                .model_id
                .as_deref()
                .is_some_and(|model_id| self.is_active_model_candidate(model_id))
            || snapshot
                .provider
                .as_deref()
                .zip(snapshot.model_id.as_deref())
                .is_some_and(|(provider, model_id)| {
                    self.is_active_model_candidate(&format!("{provider}:{model_id}"))
                })
    }

    pub fn begin_sampler_settings_refresh(&mut self) -> String {
        self.sampler_settings_request_seq = self.sampler_settings_request_seq.wrapping_add(1);
        let rid = format!("tui_sampler_settings_{}", self.sampler_settings_request_seq);
        self.sampler_settings_loading = true;
        self.pending_sampler_settings_rid = Some(rid.clone());
        rid
    }

    pub fn sampler_settings_rid_matches(&self, rid: Option<&str>) -> bool {
        self.pending_sampler_settings_rid
            .as_deref()
            .is_none_or(|pending| rid == Some(pending))
    }

    pub fn finish_sampler_settings_refresh(&mut self) {
        self.sampler_settings_loading = false;
        self.pending_sampler_settings_rid = None;
    }

    pub fn model_identifier_matches(active: &str, candidate: &str) -> bool {
        if active == candidate {
            return true;
        }
        active.ends_with(&format!(".{candidate}"))
            || active.ends_with(&format!(":{candidate}"))
            || active.ends_with(&format!("/{candidate}"))
            || candidate.ends_with(&format!(".{active}"))
            || candidate.ends_with(&format!(":{active}"))
            || candidate.ends_with(&format!("/{active}"))
    }

    pub fn is_active_model_candidate(&self, candidate: &str) -> bool {
        self.active_model_names
            .iter()
            .any(|active| Self::model_identifier_matches(active, candidate))
            || (!self.model.is_empty() && Self::model_identifier_matches(&self.model, candidate))
    }

    /// Static commands and their descriptions, shown in the palette.
    const COMMANDS: &'static [(&'static str, &'static str)] = &[
        ("cancel", "Stop the current generation"),
        ("character", "Switch active character"),
        ("clear", "Clear system messages from view"),
        ("compact", "Summarize and shrink the conversation"),
        ("delete", "Delete a message by reference"),
        ("edit", "Edit a previous message"),
        ("help", "Show keyboard shortcuts"),
        ("image", "Attach an image to the next message"),
        ("memory", "Search saved memory entries"),
        ("model", "Switch the active model"),
        ("quit", "Exit the TUI"),
        ("regen", "Regenerate the last assistant reply"),
        ("setting", "View or change sampler settings"),
        ("speak", "Toggle TTS or replay the last message"),
        ("alt", "Choose an alternate response"),
        ("sys", "Inject a system instruction"),
        ("view", "Configure TUI display options"),
    ];

    /// Look up the description for a top-level command. Returns `None`
    /// for argument candidates (e.g. `model gpt-4o`).
    pub fn command_description(name: &str) -> Option<&'static str> {
        Self::COMMANDS
            .iter()
            .find_map(|(n, d)| (*n == name).then_some(*d))
    }

    /// Sampler keys accepted by `:setting <key> <value>`. Mirrors the
    /// daemon's `SAMPLER_KEYS` constant.
    const SETTING_KEYS: &'static [&'static str] = &[
        "temperature",
        "top_p",
        "reasoning_effort",
        "thinking_enabled",
        "budget_tokens",
        "max_tokens",
        "cache_ttl",
    ];

    fn is_setting_key(key: &str) -> bool {
        Self::SETTING_KEYS.contains(&key)
    }

    const VIEW_KEYS: &'static [&'static str] =
        &["timestamps", "thinking", "tools", "images", "metadata"];

    pub fn is_view_key(key: &str) -> bool {
        Self::VIEW_KEYS.contains(&key)
    }

    pub fn view_enabled(&self, key: &str) -> Option<bool> {
        match key {
            "timestamps" => Some(self.show_timestamps),
            "thinking" => Some(self.show_thinking),
            "tools" => Some(self.show_tools),
            "images" => Some(self.show_images),
            "metadata" => Some(self.show_metadata),
            _ => None,
        }
    }

    pub fn set_view_option(&mut self, key: &str, enabled: bool) -> bool {
        match key {
            "timestamps" => self.show_timestamps = enabled,
            "thinking" => self.show_thinking = enabled,
            "tools" => self.show_tools = enabled,
            "images" => self.show_images = enabled,
            "metadata" => self.show_metadata = enabled,
            _ => return false,
        }
        true
    }

    pub fn toggle_view_option(&mut self, key: &str) -> Option<bool> {
        let next = !self.view_enabled(key)?;
        self.set_view_option(key, next);
        Some(next)
    }

    fn view_row_label(&self, key: &str) -> String {
        let state = if self.view_enabled(key).unwrap_or(false) {
            "on"
        } else {
            "off"
        };
        format!("{key} = {state}")
    }

    pub fn view_key_from_row(row: &str) -> &str {
        row.split_once(" = ").map(|(key, _)| key).unwrap_or(row)
    }

    fn setting_row_label(&self, key: &str) -> String {
        match self
            .effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.display_value(key))
        {
            Some(value) => format!("{key} = {value}"),
            None => key.to_string(),
        }
    }

    fn setting_key_from_row(row: &str) -> &str {
        row.split_once(" = ").map(|(key, _)| key).unwrap_or(row)
    }

    fn setting_scope_is_override(&self, key: &str) -> bool {
        self.effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.scope(key))
            .is_some_and(|scope| scope != "static_default")
    }

    fn setting_editor_blocked_row(&self) -> Option<&'static str> {
        if self.sampler_settings_loading {
            Some("loading sampler settings...")
        } else if self.effective_sampler.is_none() {
            Some("sampler settings unavailable")
        } else {
            None
        }
    }

    fn setting_editors_ready(&self) -> bool {
        self.setting_editor_blocked_row().is_none()
    }

    pub fn is_effective_setting_candidate(&self, key: &str, candidate: &str) -> bool {
        let Some(current) = self
            .effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.display_value(key))
        else {
            return false;
        };
        if candidate == "reset" {
            return false;
        }
        let value = candidate
            .strip_prefix("Custom: ")
            .unwrap_or(candidate)
            .trim();
        current == value
    }

    fn current_slider_value(&self, key: &str, fallback: f64) -> f64 {
        self.effective_sampler
            .as_ref()
            .and_then(|snapshot| snapshot.numeric_value(key))
            .unwrap_or(fallback)
    }

    fn slider_kind_for_setting(&self, key: &str) -> Option<ValueEditorKind> {
        match key {
            "temperature" => Some(ValueEditorKind::Slider {
                min: 0.0,
                max: 2.0,
                step: 0.1,
                current: Self::quantize_slider_value(
                    0.0,
                    2.0,
                    0.1,
                    self.current_slider_value("temperature", 1.0),
                ),
                typed: None,
                dirty: false,
            }),
            "top_p" => Some(ValueEditorKind::Slider {
                min: 0.0,
                max: 1.0,
                step: 0.05,
                current: Self::quantize_slider_value(
                    0.0,
                    1.0,
                    0.05,
                    self.current_slider_value("top_p", 0.95),
                ),
                typed: None,
                dirty: false,
            }),
            _ => None,
        }
    }

    fn refresh_value_editor_from_effective_sampler(&mut self) {
        let (key, should_refresh) = match &self.completion.mode {
            PaletteMode::ValueEditor(state) => match &state.kind {
                ValueEditorKind::Slider { dirty, .. } => (state.key.clone(), !*dirty),
            },
            _ => return,
        };

        if !should_refresh {
            return;
        }

        if let Some(kind) = self.slider_kind_for_setting(&key) {
            if let PaletteMode::ValueEditor(state) = &mut self.completion.mode {
                state.kind = kind;
            }
        }
    }

    pub fn format_slider_number(value: f64) -> String {
        let mut text = format!("{value:.2}");
        while text.contains('.') && text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.push('0');
        }
        text
    }

    fn quantize_slider_value(min: f64, max: f64, step: f64, value: f64) -> f64 {
        let clamped = value.clamp(min, max);
        if step <= 0.0 {
            return clamped;
        }
        let steps = ((clamped - min) / step).round();
        (min + steps * step).clamp(min, max)
    }

    /// Update completion candidates based on current command input.
    pub fn update_completions(&mut self) {
        self.completion.selected = None;
        self.completion.header = None;

        if matches!(self.completion.mode, PaletteMode::Submenu(_)) {
            self.update_submenu_candidates();
            return;
        }
        if matches!(self.completion.mode, PaletteMode::ValueEditor(_)) {
            self.refresh_value_editor_from_effective_sampler();
            self.completion.candidates.clear();
            return;
        }

        let input = &self.input.cmd_text;

        if input.is_empty() {
            // Show all commands
            self.completion.candidates =
                Self::COMMANDS.iter().map(|(n, _)| n.to_string()).collect();
            return;
        }

        let mut parts = input.splitn(2, ' ');
        let cmd = parts.next().unwrap_or("");
        let has_space = parts.next().is_some();

        if !has_space {
            // Completing the command name
            self.completion.candidates = Self::COMMANDS
                .iter()
                .filter(|(n, _)| n.starts_with(cmd))
                .map(|(n, _)| n.to_string())
                .collect();
        } else {
            // Completing arguments
            let arg = input.split_once(' ').map(|x| x.1).unwrap_or("").trim();
            match cmd {
                "character" => {
                    self.completion.header = Some("character".into());
                    self.completion.candidates = self
                        .characters
                        .iter()
                        .map(|c| c.name.clone())
                        .filter(|n| {
                            arg.is_empty() || n.to_lowercase().starts_with(&arg.to_lowercase())
                        })
                        .map(|n| format!("character {n}"))
                        .collect();
                }
                "model" => {
                    self.completion.header = Some("model".into());
                    let mut candidates: Vec<String> = self
                        .model_names
                        .iter()
                        .filter(|n| {
                            arg.is_empty() || n.to_lowercase().starts_with(&arg.to_lowercase())
                        })
                        .map(|n| format!("model {n}"))
                        .collect();
                    if "reset".starts_with(&arg.to_lowercase()) {
                        candidates.push("model reset".into());
                    }
                    self.completion.candidates = candidates;
                }
                "image" => {
                    self.completion.header = Some("image action".into());
                    self.completion.candidates = ["clear"]
                        .iter()
                        .filter(|s| s.starts_with(&arg.to_lowercase()))
                        .map(|s| format!("image {s}"))
                        .collect();
                }
                "setting" => {
                    // First word completes either a sampler key or `reset`.
                    // After a space we leave value entry to the user.
                    let (head, has_second) = match arg.split_once(' ') {
                        Some((h, _)) => (h, true),
                        None => (arg, false),
                    };
                    if has_second {
                        // `:setting reset <key>` — complete the key list.
                        if head == "reset" {
                            self.completion.header = Some("setting key".into());
                            let key_arg = arg.split_once(' ').map(|x| x.1).unwrap_or("").trim();
                            self.completion.candidates = Self::SETTING_KEYS
                                .iter()
                                .filter(|k| {
                                    key_arg.is_empty()
                                        || k.to_lowercase().starts_with(&key_arg.to_lowercase())
                                })
                                .map(|k| format!("setting reset {k}"))
                                .collect();
                        } else {
                            // Value position — no canned suggestions.
                            self.completion.candidates.clear();
                        }
                    } else {
                        self.completion.header = Some("setting key".into());
                        let mut candidates: Vec<String> = Self::SETTING_KEYS
                            .iter()
                            .filter(|k| {
                                head.is_empty()
                                    || k.to_lowercase().starts_with(&head.to_lowercase())
                            })
                            .map(|k| format!("setting {k}"))
                            .collect();
                        if "reset".starts_with(&head.to_lowercase()) {
                            candidates.push("setting reset".into());
                        }
                        self.completion.candidates = candidates;
                    }
                }
                "view" => {
                    self.completion.header = Some("view option".into());
                    let (head, has_second) = match arg.split_once(' ') {
                        Some((h, _)) => (h, true),
                        None => (arg, false),
                    };
                    if has_second {
                        let value_arg = arg.split_once(' ').map(|x| x.1).unwrap_or("").trim();
                        self.completion.candidates =
                            Self::filtered_presets(&["on", "off", "toggle"], value_arg)
                                .into_iter()
                                .map(|value| format!("view {head} {value}"))
                                .collect();
                    } else {
                        self.completion.candidates = Self::VIEW_KEYS
                            .iter()
                            .filter(|key| {
                                head.is_empty()
                                    || key.to_lowercase().starts_with(&head.to_lowercase())
                            })
                            .map(|key| format!("view {key}"))
                            .collect();
                    }
                }
                _ => {
                    self.completion.candidates.clear();
                }
            }
        }
    }

    /// Apply the currently selected completion to the command input.
    /// In submenu mode this is a no-op — candidates are bare names that
    /// shouldn't be spliced into the filter on Tab.
    pub fn apply_completion(&mut self) {
        if !matches!(self.completion.mode, PaletteMode::Top) {
            return;
        }
        if let Some(idx) = self.completion.selected {
            if let Some(text) = self.completion.candidates.get(idx) {
                self.input.cmd_text = text.clone();
                self.input.cmd_cursor = text.len();
                // If completing a command name (no space), add a space
                if !text.contains(' ') {
                    self.input.cmd_text.push(' ');
                    self.input.cmd_cursor += 1;
                }
            }
        }
    }

    /// Build candidates for a submenu picker. Reads the parent name out
    /// of `completion.mode` and uses `cmd_text` as a case-insensitive
    /// prefix filter.
    fn update_submenu_candidates(&mut self) {
        let parent = match &self.completion.mode {
            PaletteMode::Submenu(s) => s.parent.clone(),
            _ => return,
        };
        let raw_filter = self.input.cmd_text.trim();
        let filter = raw_filter.to_lowercase();
        self.completion.header = match parent.as_str() {
            "setting" | "setting:reset" => Some("setting key".into()),
            parent if parent.starts_with("setting:") => Some("setting value".into()),
            "view" => Some("view option".into()),
            _ => None,
        };

        if matches!(
            parent.as_str(),
            "setting"
                | "setting:reasoning_effort"
                | "setting:thinking_enabled"
                | "setting:cache_ttl"
                | "setting:max_tokens"
                | "setting:budget_tokens"
                | "setting:reset"
        ) {
            if let Some(row) = self.setting_editor_blocked_row() {
                self.completion.candidates = vec![row.to_string()];
                self.completion.selected = None;
                return;
            }
        }

        match parent.as_str() {
            "model" => {
                let mut candidates: Vec<String> = self
                    .model_names
                    .iter()
                    .filter(|n| filter.is_empty() || n.to_lowercase().starts_with(&filter))
                    .cloned()
                    .collect();
                if filter.is_empty() || "reset".starts_with(&filter) {
                    candidates.push("reset".into());
                }
                self.completion.candidates = candidates;
            }
            "character" => {
                self.completion.candidates = self
                    .characters
                    .iter()
                    .filter(|c| filter.is_empty() || c.name.to_lowercase().starts_with(&filter))
                    .map(|c| c.name.clone())
                    .collect();
            }
            "setting" => {
                let mut candidates: Vec<String> = Self::SETTING_KEYS
                    .iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .map(|key| self.setting_row_label(key))
                    .collect();
                if filter.is_empty() || "reset".starts_with(&filter) {
                    candidates.push("reset".into());
                }
                self.completion.candidates = candidates;
            }
            "setting:reasoning_effort" => {
                self.completion.candidates = Self::filtered_presets(
                    &["low", "medium", "high", "xhigh", "max", "off", "reset"],
                    &filter,
                );
            }
            "setting:thinking_enabled" => {
                self.completion.candidates =
                    Self::filtered_presets(&["true", "false", "reset"], &filter);
            }
            "setting:cache_ttl" => {
                let mut candidates = Self::filtered_presets(&["5m", "1h", "reset"], &filter);
                if !raw_filter.is_empty() && !raw_filter.eq_ignore_ascii_case("off") {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:max_tokens" | "setting:budget_tokens" => {
                let mut candidates = Self::filtered_presets(
                    &["1024", "2048", "4096", "8192", "16384", "32768", "reset"],
                    &filter,
                );
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:reset" => {
                self.completion.candidates = Self::SETTING_KEYS
                    .iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .map(|key| (*key).to_string())
                    .collect();
            }
            "view" => {
                self.completion.candidates = Self::VIEW_KEYS
                    .iter()
                    .filter(|key| filter.is_empty() || key.starts_with(&filter))
                    .map(|key| self.view_row_label(key))
                    .collect();
            }
            _ => self.completion.candidates.clear(),
        }

        self.completion.selected = match parent.as_str() {
            "model" => self
                .completion
                .candidates
                .iter()
                .position(|c| self.is_active_model_candidate(c)),
            "character" => self
                .completion
                .candidates
                .iter()
                .position(|c| !self.character_name.is_empty() && c == &self.character_name),
            "setting" => self.completion.candidates.iter().position(|c| {
                let key = Self::setting_key_from_row(c);
                self.setting_scope_is_override(key)
            }),
            "setting:reasoning_effort"
            | "setting:thinking_enabled"
            | "setting:cache_ttl"
            | "setting:max_tokens"
            | "setting:budget_tokens" => {
                let key = parent.strip_prefix("setting:").unwrap_or_default();
                self.completion
                    .candidates
                    .iter()
                    .position(|c| self.is_effective_setting_candidate(key, c))
            }
            _ => None,
        };
    }

    fn filtered_presets(presets: &[&str], filter: &str) -> Vec<String> {
        presets
            .iter()
            .filter(|preset| filter.is_empty() || preset.starts_with(filter))
            .map(|preset| (*preset).to_string())
            .collect()
    }

    /// Enter a submenu picker for the given parent command. Saves the
    /// current `cmd_text`/cursor for restoration on Esc, clears the
    /// input so the filter starts empty, and rebuilds candidates.
    pub fn enter_submenu(&mut self, parent: &str) {
        if parent == "setting" {
            self.sampler_settings_loading = true;
        }
        let saved_cmd_text = self.input.cmd_text.clone();
        let saved_cmd_cursor = self.input.cmd_cursor;
        self.completion.mode = PaletteMode::Submenu(SubmenuState {
            parent: parent.to_string(),
            saved_cmd_text,
            saved_cmd_cursor,
        });
        self.input.cmd_text.clear();
        self.input.cmd_cursor = 0;
        self.update_completions();
    }

    fn saved_palette_input(&self) -> (String, usize) {
        match &self.completion.mode {
            PaletteMode::Submenu(s) => (s.saved_cmd_text.clone(), s.saved_cmd_cursor),
            PaletteMode::ValueEditor(s) => (s.saved_cmd_text.clone(), s.saved_cmd_cursor),
            PaletteMode::Top => (self.input.cmd_text.clone(), self.input.cmd_cursor),
        }
    }

    pub fn switch_submenu(&mut self, parent: &str) {
        let (saved_cmd_text, saved_cmd_cursor) = self.saved_palette_input();
        self.completion.mode = PaletteMode::Submenu(SubmenuState {
            parent: parent.to_string(),
            saved_cmd_text,
            saved_cmd_cursor,
        });
        self.input.cmd_text.clear();
        self.input.cmd_cursor = 0;
        self.update_completions();
    }

    pub fn enter_value_editor(&mut self, key: &str, kind: ValueEditorKind) {
        let (saved_cmd_text, saved_cmd_cursor) = self.saved_palette_input();
        self.completion.mode = PaletteMode::ValueEditor(ValueEditorState {
            key: key.to_string(),
            kind,
            saved_cmd_text,
            saved_cmd_cursor,
        });
        self.input.cmd_text.clear();
        self.input.cmd_cursor = 0;
        self.update_completions();
    }

    /// Pop a submenu picker back to the top-level command list,
    /// restoring the parent input text.
    pub fn exit_submenu(&mut self) {
        if let PaletteMode::Submenu(s) = std::mem::take(&mut self.completion.mode) {
            self.input.cmd_text = s.saved_cmd_text;
            self.input.cmd_cursor = s.saved_cmd_cursor;
        }
        self.update_completions();
    }

    pub fn exit_value_editor(&mut self) {
        if let PaletteMode::ValueEditor(s) = std::mem::take(&mut self.completion.mode) {
            self.input.cmd_text = s.saved_cmd_text;
            self.input.cmd_cursor = s.saved_cmd_cursor;
        }
        self.update_completions();
    }

    pub fn adjust_value_editor(&mut self, direction: f64) {
        let PaletteMode::ValueEditor(state) = &mut self.completion.mode else {
            return;
        };
        match &mut state.kind {
            ValueEditorKind::Slider {
                min,
                max,
                step,
                current,
                typed,
                dirty,
            } => {
                *current =
                    Self::quantize_slider_value(*min, *max, *step, *current + *step * direction);
                *typed = None;
                *dirty = true;
            }
        }
    }

    pub fn type_value_editor_char(&mut self, c: char) {
        let PaletteMode::ValueEditor(state) = &mut self.completion.mode else {
            return;
        };
        match &mut state.kind {
            ValueEditorKind::Slider { typed, dirty, .. } => {
                typed.get_or_insert_with(String::new).push(c);
                *dirty = true;
            }
        }
    }

    pub fn backspace_value_editor(&mut self) {
        let PaletteMode::ValueEditor(state) = &mut self.completion.mode else {
            return;
        };
        match &mut state.kind {
            ValueEditorKind::Slider { typed, dirty, .. } => {
                if let Some(value) = typed {
                    value.pop();
                    if value.is_empty() {
                        *typed = None;
                    }
                    *dirty = true;
                }
            }
        }
    }

    pub fn apply_value_editor(&mut self) -> Option<String> {
        let state = match &self.completion.mode {
            PaletteMode::ValueEditor(state) => state.clone(),
            _ => return None,
        };
        if Self::is_setting_key(&state.key) && !self.setting_editors_ready() {
            return None;
        }
        let value = match state.kind {
            ValueEditorKind::Slider {
                min,
                max,
                current,
                typed,
                ..
            } => {
                if let Some(typed) = typed {
                    let parsed = typed.parse::<f64>().ok()?;
                    if !(min..=max).contains(&parsed) {
                        return None;
                    }
                    typed
                } else {
                    Self::format_slider_number(current)
                }
            }
        };
        self.completion.clear();
        self.input.exit_command_mode();
        Some(format!("setting {} {value}", state.key))
    }

    /// Apply the currently selected submenu candidate. Returns the full
    /// command string (e.g. `"model gpt-4o"`) for the caller to feed
    /// into `parse_command`. Most command-producing selections clear
    /// completion state and exit command mode; local-only palettes may
    /// instead apply in place and return `None`.
    pub fn apply_submenu(&mut self) -> Option<String> {
        let parent = match &self.completion.mode {
            PaletteMode::Submenu(s) => s.parent.clone(),
            _ => return None,
        };
        let idx = self.completion.selected?;
        let chosen = self.completion.candidates.get(idx)?.clone();
        if parent == "setting" {
            if !self.setting_editors_ready() {
                return None;
            }
            let key = Self::setting_key_from_row(&chosen).to_string();
            if key == "reset" {
                self.switch_submenu("setting:reset");
                return None;
            }
            if let Some(kind) = self.slider_kind_for_setting(&key) {
                self.enter_value_editor(&key, kind);
                return None;
            }
            self.switch_submenu(&format!("setting:{key}"));
            return None;
        }

        if parent == "setting:reset" {
            if !self.setting_editors_ready() {
                return None;
            }
            self.completion.clear();
            self.input.exit_command_mode();
            return Some(format!("setting reset {chosen}"));
        }

        if let Some(key) = parent.strip_prefix("setting:") {
            if !self.setting_editors_ready() {
                return None;
            }
            let value = chosen
                .strip_prefix("Custom: ")
                .unwrap_or(chosen.as_str())
                .trim();
            self.completion.clear();
            self.input.exit_command_mode();
            if value == "reset" {
                return Some(format!("setting reset {key}"));
            }
            return Some(format!("setting {key} {value}"));
        }

        if parent == "view" {
            let key = Self::view_key_from_row(&chosen).to_string();
            if !Self::is_view_key(&key) {
                return None;
            }
            let enabled = self.toggle_view_option(&key)?;
            self.set_status(format!(
                "view {key}: {}",
                if enabled { "on" } else { "off" }
            ));
            self.update_completions();
            if idx < self.completion.candidates.len() {
                self.completion.selected = Some(idx);
            }
            return None;
        }

        self.completion.clear();
        self.input.exit_command_mode();
        Some(format!("{parent} {chosen}"))
    }

    /// Cycle to the next completion candidate.
    pub fn next_completion(&mut self) {
        if self.completion.candidates.is_empty() {
            return;
        }
        self.completion.selected = Some(match self.completion.selected {
            Some(i) => (i + 1) % self.completion.candidates.len(),
            None => 0,
        });
        self.apply_completion();
    }

    /// Cycle to the previous completion candidate.
    pub fn prev_completion(&mut self) {
        let len = self.completion.candidates.len();
        if len == 0 {
            return;
        }
        self.completion.selected = Some(match self.completion.selected {
            Some(0) | None => len - 1,
            Some(i) => i - 1,
        });
        self.apply_completion();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_insert_and_backspace() {
        let mut input = InputState::default();
        input.insert_char('h');
        input.insert_char('i');
        assert_eq!(input.text, "hi");
        assert_eq!(input.cursor, 2);
        input.backspace();
        assert_eq!(input.text, "h");
        assert_eq!(input.cursor, 1);
    }

    #[test]
    fn input_newline() {
        let mut input = InputState::default();
        input.insert_char('a');
        input.insert_newline();
        input.insert_char('b');
        assert_eq!(input.text, "a\nb");
        assert_eq!(input.line_count(), 2);
    }

    #[test]
    fn input_navigation() {
        let mut input = InputState::default();
        for c in "hello".chars() {
            input.insert_char(c);
        }
        assert_eq!(input.cursor, 5);
        input.move_left();
        assert_eq!(input.cursor, 4);
        input.move_right();
        assert_eq!(input.cursor, 5);
        input.move_home();
        assert_eq!(input.cursor, 0);
        input.move_end();
        assert_eq!(input.cursor, 5);
    }

    #[test]
    fn input_take_text() {
        let mut input = InputState::default();
        for c in "message".chars() {
            input.insert_char(c);
        }
        let text = input.take_text();
        assert_eq!(text, "message");
        assert_eq!(input.text, "");
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn input_delete() {
        let mut input = InputState::default();
        for c in "abc".chars() {
            input.insert_char(c);
        }
        input.move_home();
        input.delete();
        assert_eq!(input.text, "bc");
    }

    #[test]
    fn scroll_up_down() {
        let mut app = App::default();
        assert!(app.auto_scroll);
        app.scroll_up(5);
        assert_eq!(app.scroll_offset, 5);
        assert!(!app.auto_scroll);
        app.scroll_down(3);
        assert_eq!(app.scroll_offset, 2);
        app.scroll_down(10);
        assert_eq!(app.scroll_offset, 0);
        assert!(app.auto_scroll);
    }

    #[test]
    fn set_status_dedupes_consecutive_identical() {
        let mut app = App::default();
        app.set_status("reconnecting: connection lost");
        app.set_status("reconnecting: connection lost");
        app.set_status("reconnecting: connection lost");
        assert_eq!(app.entries.len(), 1);
        match &app.entries[0] {
            ConversationEntry::System { content, count, .. } => {
                assert_eq!(content, "reconnecting: connection lost");
                assert_eq!(*count, 3);
            }
            _ => panic!("expected a single System entry"),
        }
    }

    #[test]
    fn set_status_does_not_dedupe_when_interrupted() {
        let mut app = App::default();
        app.set_status("x");
        app.entries.push(ConversationEntry::User {
            content: "hi".into(),
            images: vec![],
            timestamp: String::new(),
        });
        app.set_status("x");
        let system_entries: Vec<_> = app
            .entries
            .iter()
            .filter(|e| matches!(e, ConversationEntry::System { .. }))
            .collect();
        assert_eq!(system_entries.len(), 2);
        for e in system_entries {
            if let ConversationEntry::System { count, .. } = e {
                assert_eq!(*count, 1);
            }
        }
    }

    #[test]
    fn set_status_does_not_dedupe_different_content() {
        let mut app = App::default();
        app.set_status("x");
        app.set_status("y");
        assert_eq!(app.entries.len(), 2);
    }

    #[test]
    fn clear_system_entries_preserves_other_entries() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::User {
            content: "hello".into(),
            images: vec![],
            timestamp: String::new(),
        });
        app.set_status("reconnecting");
        app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "hi".into(),
            images: vec![],
            timestamp: String::new(),
            metadata: None,
        });
        app.set_status("cache warning");
        app.clear_system_entries();
        assert_eq!(app.entries.len(), 2);
        assert!(matches!(app.entries[0], ConversationEntry::User { .. }));
        assert!(matches!(
            app.entries[1],
            ConversationEntry::Assistant { .. }
        ));
    }

    #[test]
    fn alt_picker_previews_and_cancels() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::Assistant {
            msg_id: Some("a1".into()),
            content: "first".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });

        app.start_alt_picker(None);
        app.populate_alt_picker(
            Some("a1".into()),
            vec![
                AltChoice {
                    index: 0,
                    position: 1,
                    active: true,
                    content: "first".into(),
                    images: vec![],
                    timestamp: "t1".into(),
                },
                AltChoice {
                    index: 1,
                    position: 2,
                    active: false,
                    content: "second".into(),
                    images: vec![],
                    timestamp: "t2".into(),
                },
            ],
        );
        app.next_alt();
        assert!(matches!(
            &app.entries[0],
            ConversationEntry::Assistant { content, .. } if content == "second"
        ));

        app.cancel_alt_picker();
        assert!(matches!(
            &app.entries[0],
            ConversationEntry::Assistant { content, .. } if content == "first"
        ));
    }

    #[test]
    fn alt_picker_command_uses_selected_index() {
        let mut app = App::default();
        app.start_alt_picker(Some("last".into()));
        app.populate_alt_picker(
            Some("a1".into()),
            vec![AltChoice {
                index: 3,
                position: 4,
                active: false,
                content: "fourth".into(),
                images: vec![],
                timestamp: "t4".into(),
            }],
        );

        let args = app.selected_alt_command_args().unwrap();
        assert_eq!(args["index"], 3);
        assert_eq!(args["ref"], "a1");
    }
}
