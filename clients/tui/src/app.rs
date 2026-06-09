use ratatui::text::Line;
use shore_protocol::types::{CharacterInfo, ImageRef, Role, StreamMetadata, TokenCounts};

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
    pub stream_phase_len: u32,
    pub stream_tool_name_len: i32,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub show_subagent: bool,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    pub spinner_frame: u32,
    pub character_name_len: u32,
    pub image_cache_version: u64,
}

/// A configured usage budget's current status, distilled from the daemon's
/// `usage {budget:true}` reply (and refreshed in-place by `UsageWarning`
/// pushes). Carries just the fields the on-screen usage chip needs.
#[derive(Clone, Debug, Default)]
pub struct UsageBudget {
    pub name: String,
    /// Fraction used, e.g. 0.8 for 80%.
    pub percent_used: f64,
    /// Warning thresholds already crossed this period, as fractions.
    pub crossed_warn_at: Vec<f64>,
    /// Whether spend has reached or exceeded the limit.
    pub over_limit: bool,
}

impl UsageBudget {
    /// True once any warning threshold has been crossed (or the budget is
    /// over limit) — the signal that gates warning styling and the
    /// "only past a warning level" visibility mode.
    pub fn in_warning(&self) -> bool {
        self.over_limit || !self.crossed_warn_at.is_empty()
    }
}

/// When the usage chip is shown on the input border.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UsageDisplay {
    /// Never show the chip; usage warnings fall back to a notification.
    #[default]
    Off,
    /// Always show the chip once budget data is known.
    Always,
    /// Only show the chip once a warning threshold has been crossed.
    Warn,
}

impl UsageDisplay {
    /// Canonical token used in the `:view usage <mode>` command and prefs.
    pub fn as_str(self) -> &'static str {
        match self {
            UsageDisplay::Off => "off",
            UsageDisplay::Always => "always",
            UsageDisplay::Warn => "warn",
        }
    }

    /// Parse a command/pref token. `on` is accepted as an alias for `always`
    /// so the boolean `:view` muscle-memory (and older prefs) keep working.
    pub fn from_token(token: &str) -> Option<Self> {
        match token {
            "off" => Some(UsageDisplay::Off),
            "always" | "on" => Some(UsageDisplay::Always),
            "warn" => Some(UsageDisplay::Warn),
            _ => None,
        }
    }

    /// Next mode in the off → always → warn → off cycle (submenu Enter / toggle).
    pub fn cycled(self) -> Self {
        match self {
            UsageDisplay::Off => UsageDisplay::Always,
            UsageDisplay::Always => UsageDisplay::Warn,
            UsageDisplay::Warn => UsageDisplay::Off,
        }
    }
}

/// A content block within a turn, mirroring the wire `ContentBlock`
/// (text / thinking / tool_use / tool_result). Blocks are ordered and
/// authoritative: rendering walks them in sequence, so interleaved
/// `text → tool_use → text` renders in true order under a single header.
///
/// Images are *not* a block — they live as a turn-level field, matching the
/// wire `Message.images` (which is separate from `content_blocks`).
#[derive(Clone, Debug)]
pub enum Block {
    Text(String),
    Thinking(String),
    ToolUse {
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
    /// Opens a nested sub-agent section: the daemon delegated to an
    /// `ask_<name>` loop and the blocks that follow (until the matching
    /// [`Block::SubagentEnd`]) are that sub-agent's thinking/text/tool frames.
    /// Streamed live for transparency and gated by `show_subagent`; not part of
    /// the persisted transcript, so a History rebuild collapses the section back
    /// to the primary `ask_<name>` tool call/result.
    SubagentBegin(String),
    /// Closes the section opened by [`Block::SubagentBegin`].
    SubagentEnd(String),
}

/// Whether a turn is finalized or still receiving streamed deltas.
///
/// The in-flight turn is simply the last `Turn` with `state: Streaming`;
/// streaming deltas mutate its blocks in place. `StreamEnd` flips it to
/// `Complete`. No separate streaming-text entry, no phase-boundary drop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnState {
    Complete,
    Streaming,
}

/// One conversational turn: a role header plus an ordered list of blocks,
/// mirroring the wire `Message { role, content_blocks }`. One header is
/// rendered per turn, then `blocks` in order.
#[derive(Clone, Debug)]
pub struct Turn {
    pub role: Role,
    #[allow(dead_code)] // used for msg_id-matched reconciliation and metadata attach
    pub msg_id: Option<String>,
    pub blocks: Vec<Block>,
    pub images: Vec<ImageRef>,
    pub timestamp: String,
    pub state: TurnState,
    pub metadata: Option<StreamMetadata>,
}

impl Turn {
    /// A completed turn carrying a single text block (the common case for
    /// user messages and plain assistant replies).
    pub fn text(
        role: Role,
        msg_id: Option<String>,
        content: String,
        images: Vec<ImageRef>,
        timestamp: String,
        metadata: Option<StreamMetadata>,
    ) -> Self {
        let blocks = if content.is_empty() {
            Vec::new()
        } else {
            vec![Block::Text(content)]
        };
        Self {
            role,
            msg_id,
            blocks,
            images,
            timestamp,
            state: TurnState::Complete,
            metadata,
        }
    }

    /// The turn's textual content — every `Text` block joined with newlines.
    /// Used for ref resolution (`:edit`) and tests, not rendering.
    pub fn joined_text(&self) -> String {
        let parts: Vec<&str> = self
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        parts.join("\n")
    }

    pub fn is_streaming(&self) -> bool {
        self.state == TurnState::Streaming
    }
}

/// A single entry in the conversation log. Real conversational turns are
/// `Turn`; `System` (TUI status / injected system messages) and
/// `ArchiveBoundary` are display-only markers that aren't wire turns.
#[derive(Clone, Debug)]
pub enum ConversationEntry {
    Turn(Turn),
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
}

impl ConversationEntry {
    /// Construct a completed user turn carrying a single text block.
    pub fn user(content: String, images: Vec<ImageRef>, timestamp: String) -> Self {
        ConversationEntry::Turn(Turn::text(
            Role::User,
            None,
            content,
            images,
            timestamp,
            None,
        ))
    }

    /// Construct a completed assistant turn carrying a single text block.
    pub fn assistant(
        msg_id: Option<String>,
        content: String,
        images: Vec<ImageRef>,
        timestamp: String,
        metadata: Option<StreamMetadata>,
    ) -> Self {
        ConversationEntry::Turn(Turn::text(
            Role::Assistant,
            msg_id,
            content,
            images,
            timestamp,
            metadata,
        ))
    }

    /// Borrow the inner `Turn`, if this entry is one.
    pub fn as_turn(&self) -> Option<&Turn> {
        match self {
            ConversationEntry::Turn(turn) => Some(turn),
            _ => None,
        }
    }

    /// Mutably borrow the inner `Turn`, if this entry is one.
    pub fn as_turn_mut(&mut self) -> Option<&mut Turn> {
        match self {
            ConversationEntry::Turn(turn) => Some(turn),
            _ => None,
        }
    }
}

/// Severity of a transient notification toast. Drives the toast's color and
/// whether the message is recorded to the session error log that is flushed
/// to stderr on exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}

/// A transient, auto-dismissing notification rendered as a floating toast over
/// the conversation. Unlike `ConversationEntry::System`, toasts are never part
/// of the conversation log — they don't reflow it, persist, or get saved. They
/// carry ephemeral chatter (command acks, connection state, errors); genuine
/// requested output (model lists, memory dumps) stays a `System` entry.
#[derive(Clone, Debug)]
pub struct Notification {
    pub content: String,
    pub level: NotificationLevel,
    /// Count of consecutive identical toasts collapsed into this one.
    pub count: u32,
    /// When the toast was (re)raised; drives auto-expiry.
    pub created: std::time::Instant,
}

/// How long a toast stays on screen before auto-dismissing.
pub const NOTIFICATION_TTL: std::time::Duration = std::time::Duration::from_secs(5);
/// Maximum simultaneously-stacked toasts; older ones are dropped.
const MAX_NOTIFICATIONS: usize = 4;
/// Cap on retained error-log lines flushed to stderr on exit.
const MAX_ERROR_LOG: usize = 200;

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

/// Cross-phase scalars for an in-progress response.
///
/// Streaming *content* lives directly in `App.entries` as the trailing
/// `Turn` with `state: Streaming` — its blocks are mutated in place by the
/// stream handlers. This struct only holds the scalars that drive the
/// streaming header/footer (spinner, phase label, regen marker) and don't
/// belong to any one block. Accumulated text and metadata are no longer
/// tracked here: text is the turn's blocks, metadata accumulates on the turn.
#[derive(Default)]
pub struct StreamState {
    pub active: bool,
    pub regen: bool,
    pub phase: String,
    /// Name of the tool currently being called/executed.
    pub tool_name: Option<String>,
    /// Name of the sub-agent whose nested `ask_<name>` loop is currently
    /// streaming, if any. Drives sub-agent section bracketing — a tag
    /// transition pushes [`Block::SubagentBegin`]/[`Block::SubagentEnd`].
    pub subagent: Option<String>,
}

impl StreamState {
    pub fn reset(&mut self) {
        self.active = false;
        self.regen = false;
        self.phase.clear();
        self.tool_name = None;
        self.subagent = None;
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
    pub budget_tokens: EffectiveSamplerField,
    pub max_output_tokens: EffectiveSamplerField,
    pub cache_ttl: EffectiveSamplerField,
    pub sdk: EffectiveSamplerField,
    pub replay_prior_thinking: EffectiveSamplerField,
    pub openrouter_provider: EffectiveSamplerField,
    pub vertex_project: EffectiveSamplerField,
    pub vertex_location: EffectiveSamplerField,
    pub gemini_generation: EffectiveSamplerField,
    pub gemini_web_search: EffectiveSamplerField,
    pub zai_clear_thinking: EffectiveSamplerField,
    pub zai_subscription: EffectiveSamplerField,
    /// Per-key capability label from the daemon's matrix
    /// (`honored`/`ignored`/`rejected`/`always`). Empty when the daemon
    /// didn't send `applicability` (older daemon) — callers then show all keys.
    pub applicability: std::collections::BTreeMap<String, String>,
    /// Accepted `reasoning_effort` values for the active model's sdk, as
    /// reported by the daemon. Empty falls back to the built-in preset list.
    pub reasoning_effort_domain: Vec<String>,
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
            budget_tokens: Self::field(sampler, scopes, "budget_tokens"),
            max_output_tokens: Self::field(sampler, scopes, "max_output_tokens"),
            cache_ttl: Self::field(sampler, scopes, "cache_ttl"),
            sdk: Self::field(sampler, scopes, "sdk"),
            replay_prior_thinking: Self::field(sampler, scopes, "replay_prior_thinking"),
            openrouter_provider: Self::field(sampler, scopes, "openrouter_provider"),
            vertex_project: Self::field(sampler, scopes, "vertex_project"),
            vertex_location: Self::field(sampler, scopes, "vertex_location"),
            gemini_generation: Self::field(sampler, scopes, "gemini_generation"),
            gemini_web_search: Self::field(sampler, scopes, "gemini_web_search"),
            zai_clear_thinking: Self::field(sampler, scopes, "zai_clear_thinking"),
            zai_subscription: Self::field(sampler, scopes, "zai_subscription"),
            applicability: data
                .get("applicability")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
            reasoning_effort_domain: data
                .get("reasoning_effort_domain")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    /// Whether the active model's resolved sdk honors `key` — mirrors the
    /// daemon's capability matrix and the CLI's `visible_setting_keys`. A key
    /// absent from `applicability` (no opinion, or an older daemon that didn't
    /// send the map) is treated as visible.
    pub fn key_honored(&self, key: &str) -> bool {
        match self.applicability.get(key).map(String::as_str) {
            Some(label) => label == "honored" || label == "always",
            None => true,
        }
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
            "budget_tokens" => Some(&self.budget_tokens),
            "max_output_tokens" => Some(&self.max_output_tokens),
            "cache_ttl" => Some(&self.cache_ttl),
            "sdk" => Some(&self.sdk),
            "replay_prior_thinking" => Some(&self.replay_prior_thinking),
            "openrouter_provider" => Some(&self.openrouter_provider),
            "vertex_project" => Some(&self.vertex_project),
            "vertex_location" => Some(&self.vertex_location),
            "gemini_generation" => Some(&self.gemini_generation),
            "gemini_web_search" => Some(&self.gemini_web_search),
            "zai_clear_thinking" => Some(&self.zai_clear_thinking),
            "zai_subscription" => Some(&self.zai_subscription),
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
    pub show_subagent: bool,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    /// When the usage-budget chip is shown on the input border.
    pub usage_display: UsageDisplay,
    pub show_help: bool,
    /// Latest known usage-budget statuses, refreshed by the `usage` query and
    /// `UsageWarning` pushes. Empty until the first reply arrives.
    pub usage_budgets: Vec<UsageBudget>,
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
    /// Active transient notification toasts, newest last. Rendered as a
    /// floating overlay over the conversation; expired entries are pruned by
    /// the event loop via `expire_notifications`.
    pub notifications: Vec<Notification>,
    /// Error/warning messages recorded this session, flushed to stderr on exit
    /// so they survive in terminal scrollback for copy/paste debugging.
    pub error_log: Vec<String>,
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
            show_subagent: true,
            show_images: true,
            show_timestamps: false,
            show_metadata: true,
            usage_display: UsageDisplay::Off,
            show_help: false,
            usage_budgets: Vec::new(),
            pending_images: Vec::new(),
            paste_temp_paths: Vec::new(),
            editing_ref: None,
            image_index: Vec::new(),
            fullscreen: None,
            spinner_frame: 0,
            conv_cache: ConvCache::default(),
            history_version: 0,
            notifications: Vec::new(),
            error_log: Vec::new(),
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
            //
            // For a `Turn`, only the *last* block mutates during streaming
            // (text/thinking appends), and new blocks change the block count —
            // so block-count + last-block length capture every in-place edit.
            // Wholesale replacements (reconcile, :edit) bump `history_version`,
            // which covers collisions among earlier-than-last-two entries.
            match e {
                ConversationEntry::Turn(turn) => {
                    let block_len = |b: &Block| -> u64 {
                        match b {
                            Block::Text(s) | Block::Thinking(s) => s.len() as u64,
                            Block::ToolUse { tool_name, .. } => tool_name.len() as u64,
                            Block::ToolResult {
                                tool_name, output, ..
                            } => (tool_name.len() + output.len()) as u64,
                            Block::SubagentBegin(name) | Block::SubagentEnd(name) => {
                                name.len() as u64
                            }
                        }
                    };
                    let role_bit = matches!(turn.role, Role::Assistant) as u64;
                    let last_len = turn.blocks.last().map(block_len).unwrap_or(0);
                    (1u64 << 56)
                        | (role_bit << 55)
                        | ((turn.is_streaming() as u64) << 54)
                        | ((turn.metadata.is_some() as u64) << 53)
                        | (((turn.images.len() as u64) & 0x1FF) << 44)
                        | (((turn.blocks.len() as u64) & 0xFFF) << 32)
                        | (last_len & 0xFFFF_FFFF)
                }
                ConversationEntry::System { content, count, .. } => {
                    (3u64 << 56) | ((content.len() as u64) << 24) | (*count as u64)
                }
                ConversationEntry::ArchiveBoundary { archived_count } => {
                    (7u64 << 56) | (*archived_count as u64)
                }
            }
        };

        let last_entry = self.entries.last().map(entry_summary).unwrap_or(0);
        let second_last_entry = if self.entries.len() >= 2 {
            entry_summary(&self.entries[self.entries.len() - 2])
        } else {
            0
        };

        ConvFingerprint {
            width,
            entries_len: self.entries.len() as u32,
            last_entry,
            second_last_entry,
            history_version: self.history_version,
            stream_active: self.stream.active,
            stream_regen: self.stream.regen,
            stream_phase_len: self.stream.phase.len() as u32,
            stream_tool_name_len: self
                .stream
                .tool_name
                .as_ref()
                .map(|s| s.len() as i32)
                .unwrap_or(-1),
            show_thinking: self.show_thinking,
            show_tools: self.show_tools,
            show_subagent: self.show_subagent,
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

    /// Borrow the in-flight streaming turn, opening one if the tail isn't
    /// already a `Streaming` turn. The in-flight turn is always a trailing
    /// assistant `Turn` whose blocks the stream handlers mutate in place.
    /// Public so `StreamEnd` can attach metadata to (or open) the turn even
    /// when a tool-use phase ends before any content has streamed.
    pub fn ensure_streaming_turn(&mut self) -> &mut Turn {
        let needs_new = !matches!(
            self.entries.last(),
            Some(ConversationEntry::Turn(turn)) if turn.is_streaming()
        );
        if needs_new {
            self.entries.push(ConversationEntry::Turn(Turn {
                role: Role::Assistant,
                msg_id: None,
                blocks: Vec::new(),
                images: Vec::new(),
                timestamp: String::new(),
                state: TurnState::Streaming,
                metadata: None,
            }));
        }
        self.entries
            .last_mut()
            .and_then(ConversationEntry::as_turn_mut)
            .expect("just ensured a trailing streaming turn")
    }

    /// Bracket nested sub-agent activity by comparing the incoming frame's
    /// sub-agent tag to the section currently open. On a transition, close the
    /// old section and/or open the new one by pushing the marker blocks into the
    /// in-flight turn — exactly mirroring the CLI's tag-transition bracketing.
    ///
    /// A no-op (and no turn is forced into existence) when the tag is unchanged,
    /// which is every frame of an ordinary, sub-agent-free generation.
    pub fn sync_subagent_section(&mut self, tag: Option<&str>) {
        if self.stream.subagent.as_deref() == tag {
            return;
        }
        if let Some(prev) = self.stream.subagent.take() {
            self.ensure_streaming_turn()
                .blocks
                .push(Block::SubagentEnd(prev));
        }
        if let Some(name) = tag {
            self.ensure_streaming_turn()
                .blocks
                .push(Block::SubagentBegin(name.to_string()));
            self.stream.subagent = Some(name.to_string());
        }
    }

    /// Append a live thinking delta to the in-flight turn. Merges into the
    /// trailing `Thinking` block when the previous block was also thinking,
    /// otherwise opens a new one — preserving interleaving with tool calls.
    pub fn stream_append_thinking(&mut self, text: &str) {
        let turn = self.ensure_streaming_turn();
        match turn.blocks.last_mut() {
            Some(Block::Thinking(content)) => content.push_str(text),
            _ => turn.blocks.push(Block::Thinking(text.to_string())),
        }
    }

    /// Append a live response-text delta to the in-flight turn. Merges into the
    /// trailing `Text` block, otherwise opens a new one. Because text is just
    /// another block, pre-tool text streams live and stays interleaved — no
    /// phase-boundary drop, no single-header constraint.
    pub fn stream_append_text(&mut self, text: &str) {
        let turn = self.ensure_streaming_turn();
        match turn.blocks.last_mut() {
            Some(Block::Text(content)) => content.push_str(text),
            _ => turn.blocks.push(Block::Text(text.to_string())),
        }
    }

    /// Append a tool-call block to the in-flight turn.
    pub fn stream_push_tool_call(
        &mut self,
        tool_id: String,
        tool_name: String,
        input: serde_json::Value,
    ) {
        self.ensure_streaming_turn().blocks.push(Block::ToolUse {
            tool_id,
            tool_name,
            input,
        });
    }

    /// Append a tool-result block to the in-flight turn.
    pub fn stream_push_tool_result(
        &mut self,
        tool_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    ) {
        self.ensure_streaming_turn().blocks.push(Block::ToolResult {
            tool_id,
            tool_name,
            output,
            is_error,
        });
    }

    /// Abort an in-flight stream (disconnect / error / cancel): discard the
    /// optimistic, unconfirmed turn entirely and clear the stream scalars. A
    /// reconnect's History rebuild reconciles the authoritative turn, so
    /// dropping the whole in-flight turn (tool blocks included) is safe.
    pub fn abort_stream(&mut self) {
        if matches!(
            self.entries.last(),
            Some(ConversationEntry::Turn(turn)) if turn.is_streaming()
        ) {
            self.entries.pop();
        }
        self.stream.reset();
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
        // Filter to finalized User/Assistant turns (what the daemon considers
        // messages). The in-flight streaming turn is an optimistic partial, not
        // a ref target — exclude it so `:edit last` targets the last committed
        // turn, not the reply currently being generated.
        let messages: Vec<&Turn> = self
            .entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .filter(|turn| {
                matches!(turn.role, Role::User | Role::Assistant) && !turn.is_streaming()
            })
            .collect();

        let turn = match raw_ref {
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

        turn.map(Turn::joined_text)
    }

    /// Raise an informational toast. The bulk of status chatter (command
    /// acks, connection state) flows through here.
    pub fn set_status(&mut self, msg: impl Into<String>) {
        self.notify(NotificationLevel::Info, msg);
    }

    /// Raise a warning-level toast (yellow).
    pub fn set_warning(&mut self, msg: impl Into<String>) {
        self.notify(NotificationLevel::Warning, msg);
    }

    /// Raise an error-level toast (red) and record it to the session error log
    /// so it is reprinted to stderr on exit for copy/paste debugging.
    pub fn set_error(&mut self, msg: impl Into<String>) {
        let msg = msg.into();
        tracing::error!("{msg}");
        if self.error_log.len() >= MAX_ERROR_LOG {
            self.error_log.remove(0);
        }
        self.error_log.push(msg.clone());
        self.notify(NotificationLevel::Error, msg);
    }

    /// Core toast raise: dedupes against the newest toast (a reconnect storm
    /// bumps a `×N` count instead of stacking), caps the stack, and refreshes
    /// the dismissal timer.
    pub fn notify(&mut self, level: NotificationLevel, msg: impl Into<String>) {
        let msg = msg.into();
        if let Some(last) = self.notifications.last_mut() {
            if last.content == msg && last.level == level {
                last.count = last.count.saturating_add(1);
                last.created = std::time::Instant::now();
                return;
            }
        }
        self.notifications.push(Notification {
            content: msg,
            level,
            count: 1,
            created: std::time::Instant::now(),
        });
        if self.notifications.len() > MAX_NOTIFICATIONS {
            let overflow = self.notifications.len() - MAX_NOTIFICATIONS;
            self.notifications.drain(0..overflow);
        }
    }

    /// Drop toasts whose lifetime has elapsed. Returns true if any were
    /// removed, so the event loop can trigger a redraw.
    pub fn expire_notifications(&mut self, now: std::time::Instant) -> bool {
        let before = self.notifications.len();
        self.notifications
            .retain(|n| now.duration_since(n.created) < NOTIFICATION_TTL);
        self.notifications.len() != before
    }

    /// Immediately clear all toasts (e.g. on a fresh user turn).
    pub fn dismiss_notifications(&mut self) {
        self.notifications.clear();
    }

    /// Dismiss the newest toast — the one drawn at the top of the stack.
    /// Returns whether a toast was removed, so the caller can decide whether
    /// the keypress was consumed.
    pub fn dismiss_latest_notification(&mut self) -> bool {
        self.notifications.pop().is_some()
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
        let is_assistant = |entry: &ConversationEntry| matches!(entry.as_turn(), Some(t) if matches!(t.role, Role::Assistant) && !t.is_streaming());
        let target_idx = msg_id
            .as_deref()
            .and_then(|target| {
                self.entries.iter().position(|entry| {
                    matches!(
                        entry.as_turn(),
                        Some(Turn { role: Role::Assistant, msg_id: Some(id), .. }) if id == target
                    )
                })
            })
            .or_else(|| self.entries.iter().rposition(is_assistant));

        if let Some(turn) = target_idx.and_then(|idx| self.entries[idx].as_turn_mut()) {
            turn.blocks = if choice.content.is_empty() {
                Vec::new()
            } else {
                vec![Block::Text(choice.content)]
            };
            turn.images = choice.images;
            turn.timestamp = choice.timestamp;
            turn.metadata = None;
            turn.state = TurnState::Complete;
            self.history_version = self.history_version.wrapping_add(1);
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
        let equivalent = match (current, next) {
            (Some(current), Some(next)) => Self::model_identifier_matches(current, next),
            (None, None) => true,
            _ => false,
        };

        if equivalent {
            // Same model in a different surface form (e.g. bare upstream id from
            // stream metadata vs. provider-qualified name or alias). Keep the
            // existing `self.model` — the daemon's `model_settings` resolver
            // expects the form it originally handed us, and a bare upstream id
            // often isn't resolvable on its own. Track the new form too so
            // snapshot-matching still works against it.
            if let Some(next) = next {
                if !self.active_model_names.iter().any(|n| n == next) {
                    self.active_model_names.push(next.to_string());
                }
            }
            return;
        }

        self.effective_sampler = None;
        self.sampler_settings_loading = false;
        self.pending_sampler_settings_rid = None;

        match next {
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

    /// Register the identifiers from an authoritative `model_settings`
    /// snapshot as active-model match keys, without disturbing `self.model`
    /// (which must keep the resolver-friendly form the daemon originally
    /// handed us). Lets later unsolicited pushes and the model-list marker
    /// recognise the active model even when the daemon labels it differently
    /// than the surface form we currently track.
    pub fn note_active_model_from_snapshot(&mut self, snapshot: &EffectiveSamplerSnapshot) {
        let mut keys = Vec::new();
        if let Some(model) = snapshot.model.as_deref() {
            keys.push(model.to_string());
        }
        if let Some(model_id) = snapshot.model_id.as_deref() {
            if let Some(provider) = snapshot.provider.as_deref() {
                keys.push(format!("{provider}:{model_id}"));
            }
            keys.push(model_id.to_string());
        }
        for key in keys {
            if !key.is_empty() && !self.active_model_names.iter().any(|n| n == &key) {
                self.active_model_names.push(key);
            }
        }
    }

    pub fn begin_sampler_settings_refresh(&mut self) -> String {
        self.sampler_settings_request_seq = self.sampler_settings_request_seq.wrapping_add(1);
        let rid = format!("tui_sampler_settings_{}", self.sampler_settings_request_seq);
        self.sampler_settings_loading = true;
        self.pending_sampler_settings_rid = Some(rid.clone());
        rid
    }

    pub fn sampler_settings_rid_matches(&self, rid: Option<&str>) -> bool {
        match (self.pending_sampler_settings_rid.as_deref(), rid) {
            (Some(pending), Some(rid)) => pending == rid,
            _ => false,
        }
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
        ("compact", "Summarize and shrink the conversation"),
        ("delete", "Delete a message by reference"),
        ("edit", "Edit a previous message"),
        ("help", "Show keyboard shortcuts"),
        ("image", "Attach an image to the next message"),
        ("model", "Switch the active model"),
        ("regen", "Regenerate the last assistant reply"),
        ("setting", "View or change sampler settings"),
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
    /// daemon's `SAMPLER_KEYS` constant. The trailing vendor knobs are gated
    /// per-model by the daemon's capability matrix — see [`Self::visible_setting_keys`].
    const SETTING_KEYS: &'static [&'static str] = &[
        "temperature",
        "top_p",
        "reasoning_effort",
        "budget_tokens",
        "max_output_tokens",
        "cache_ttl",
        "sdk",
        "replay_prior_thinking",
        "openrouter_provider",
        "vertex_project",
        "vertex_location",
        "gemini_generation",
        "gemini_web_search",
        "zai_clear_thinking",
        "zai_subscription",
    ];

    fn is_setting_key(key: &str) -> bool {
        Self::SETTING_KEYS.contains(&key)
    }

    /// `SETTING_KEYS` filtered to those the active model's sdk honors, per the
    /// daemon's `applicability` matrix (mirrors the CLI's `visible_setting_keys`).
    /// Before a snapshot arrives, every key is shown.
    fn visible_setting_keys(&self) -> Vec<&'static str> {
        Self::SETTING_KEYS
            .iter()
            .copied()
            .filter(|key| {
                self.effective_sampler
                    .as_ref()
                    .is_none_or(|snapshot| snapshot.key_honored(key))
            })
            .collect()
    }

    const VIEW_KEYS: &'static [&'static str] = &[
        "timestamps",
        "thinking",
        "tools",
        "subagent",
        "images",
        "metadata",
        "usage",
    ];

    pub fn is_view_key(key: &str) -> bool {
        Self::VIEW_KEYS.contains(&key)
    }

    pub fn view_enabled(&self, key: &str) -> Option<bool> {
        match key {
            "timestamps" => Some(self.show_timestamps),
            "thinking" => Some(self.show_thinking),
            "tools" => Some(self.show_tools),
            "subagent" => Some(self.show_subagent),
            "images" => Some(self.show_images),
            "metadata" => Some(self.show_metadata),
            // Value-typed: "active" means anything other than Off (drives the
            // submenu's on/off marker). The exact mode is shown by the row label.
            "usage" => Some(self.usage_display != UsageDisplay::Off),
            _ => None,
        }
    }

    /// Set the usage chip's visibility mode (`:view usage <mode>` / prefs).
    pub fn set_usage_display(&mut self, mode: UsageDisplay) {
        self.usage_display = mode;
    }

    /// Advance the usage chip mode through off → always → warn (submenu Enter
    /// and `:view usage toggle`), returning the new mode.
    pub fn cycle_usage_display(&mut self) -> UsageDisplay {
        self.usage_display = self.usage_display.cycled();
        self.usage_display
    }

    /// The budget to surface in the usage chip: the one nearest (or past) its
    /// limit, so the most pressing constraint is always what's shown.
    pub fn most_urgent_budget(&self) -> Option<&UsageBudget> {
        self.usage_budgets
            .iter()
            .max_by(|a, b| a.percent_used.total_cmp(&b.percent_used))
    }

    /// Replace cached budget statuses from a `usage {budget:true}` reply's
    /// `budgets` array. Missing fields default sensibly so a partial reply
    /// never panics.
    pub fn apply_usage_budgets(&mut self, data: &serde_json::Value) {
        let Some(arr) = data.get("budgets").and_then(|v| v.as_array()) else {
            return;
        };
        self.usage_budgets = arr
            .iter()
            .map(|b| UsageBudget {
                name: b
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                percent_used: b
                    .get("percent_used")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
                crossed_warn_at: b
                    .get("crossed_warn_at")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect())
                    .unwrap_or_default(),
                over_limit: b
                    .get("over_limit")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
            .collect();
    }

    /// Fold a `UsageWarning` push into the cached budget set for instant chip
    /// feedback (the next `usage` poll supersedes it with authoritative data).
    /// `over_limit` is inferred from `percent_used` since the push omits it.
    pub fn apply_usage_warning(&mut self, budget: UsageBudget) {
        if let Some(existing) = self
            .usage_budgets
            .iter_mut()
            .find(|b| b.name == budget.name)
        {
            *existing = budget;
        } else {
            self.usage_budgets.push(budget);
        }
    }

    pub fn set_view_option(&mut self, key: &str, enabled: bool) -> bool {
        match key {
            "timestamps" => self.show_timestamps = enabled,
            "thinking" => self.show_thinking = enabled,
            "tools" => self.show_tools = enabled,
            "subagent" => self.show_subagent = enabled,
            "images" => self.show_images = enabled,
            "metadata" => self.show_metadata = enabled,
            // Boolean on/off maps onto the always/off ends of the tri-state so
            // `:view usage on|off` keeps working; `warn` needs the explicit word.
            "usage" => {
                self.usage_display = if enabled {
                    UsageDisplay::Always
                } else {
                    UsageDisplay::Off
                };
            }
            _ => return false,
        }
        true
    }

    pub fn toggle_view_option(&mut self, key: &str) -> Option<bool> {
        // Usage is value-typed: cycle through its three modes rather than
        // flipping a boolean (which would skip `warn`).
        if key == "usage" {
            return Some(self.cycle_usage_display() != UsageDisplay::Off);
        }
        let next = !self.view_enabled(key)?;
        self.set_view_option(key, next);
        Some(next)
    }

    fn view_row_label(&self, key: &str) -> String {
        if key == "usage" {
            return format!("usage = {}", self.usage_display.as_str());
        }
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
                        let visible = self.visible_setting_keys();
                        let mut candidates: Vec<String> = visible
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

        if parent == "setting" || parent.starts_with("setting:") {
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
                let visible = self.visible_setting_keys();
                let mut candidates: Vec<String> = visible
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
                // Prefer the per-sdk domain the daemon reported (e.g. OpenAI
                // accepts `minimal` and rejects `max`); fall back to the full
                // Anthropic set before any snapshot has arrived.
                let domain: Vec<&str> = self
                    .effective_sampler
                    .as_ref()
                    .filter(|s| !s.reasoning_effort_domain.is_empty())
                    .map(|s| {
                        s.reasoning_effort_domain
                            .iter()
                            .map(String::as_str)
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["low", "medium", "high", "xhigh", "max"]);
                let mut presets = domain;
                presets.push("off");
                presets.push("reset");
                self.completion.candidates = Self::filtered_presets(&presets, &filter);
            }
            "setting:replay_prior_thinking" => {
                self.completion.candidates =
                    Self::filtered_presets(&["all", "last_turn", "none", "reset"], &filter);
            }
            "setting:gemini_web_search"
            | "setting:zai_clear_thinking"
            | "setting:zai_subscription" => {
                self.completion.candidates =
                    Self::filtered_presets(&["true", "false", "reset"], &filter);
            }
            "setting:gemini_generation" => {
                let mut candidates = Self::filtered_presets(&["1", "2", "3", "reset"], &filter);
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:openrouter_provider"
            | "setting:vertex_project"
            | "setting:vertex_location" => {
                // Free-form values — offer only `reset` plus whatever the user
                // is typing as a custom entry.
                let mut candidates = Self::filtered_presets(&["reset"], &filter);
                if !raw_filter.is_empty() && !raw_filter.eq_ignore_ascii_case("reset") {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:cache_ttl" => {
                let mut candidates = Self::filtered_presets(&["5m", "1h", "reset"], &filter);
                if !raw_filter.is_empty() && !raw_filter.eq_ignore_ascii_case("off") {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:max_output_tokens" | "setting:budget_tokens" => {
                let mut candidates = Self::filtered_presets(
                    &["1024", "2048", "4096", "8192", "16384", "32768", "reset"],
                    &filter,
                );
                if raw_filter.parse::<u32>().is_ok() {
                    candidates.push(format!("Custom: {raw_filter}"));
                }
                self.completion.candidates = candidates;
            }
            "setting:sdk" => {
                self.completion.candidates = Self::filtered_presets(
                    &["anthropic", "openai", "gemini", "zai", "reset"],
                    &filter,
                );
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
            p if p.starts_with("setting:") && p != "setting:reset" => {
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
            if key == "usage" {
                let mode = self.cycle_usage_display();
                self.set_status(format!("view usage: {}", mode.as_str()));
            } else {
                let enabled = self.toggle_view_option(&key)?;
                self.set_status(format!(
                    "view {key}: {}",
                    if enabled { "on" } else { "off" }
                ));
            }
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
    fn visible_setting_keys_honors_daemon_applicability() {
        let snapshot = EffectiveSamplerSnapshot::from_model_settings(&serde_json::json!({
            "effective_sampler": { "temperature": 0.7 },
            "reasoning_effort_domain": ["minimal", "low", "medium", "high", "xhigh"],
            "applicability": {
                "temperature": "honored",
                "reasoning_effort": "honored",
                "sdk": "always",
                "replay_prior_thinking": "always",
                "budget_tokens": "ignored",
                "zai_clear_thinking": "rejected",
                // `vertex_project` deliberately omitted — "no opinion" must
                // still be shown.
            },
        }))
        .expect("snapshot");

        // Domain parsed through.
        assert_eq!(
            snapshot.reasoning_effort_domain,
            vec!["minimal", "low", "medium", "high", "xhigh"]
        );

        let app = App {
            effective_sampler: Some(snapshot),
            ..App::default()
        };
        let visible = app.visible_setting_keys();

        assert!(visible.contains(&"temperature"));
        assert!(visible.contains(&"sdk")); // "always"
        assert!(visible.contains(&"vertex_project")); // no opinion → shown
        assert!(!visible.contains(&"budget_tokens")); // ignored → hidden
        assert!(!visible.contains(&"zai_clear_thinking")); // rejected → hidden
    }

    #[test]
    fn visible_setting_keys_shows_all_without_snapshot() {
        let app = App::default();
        assert_eq!(app.visible_setting_keys(), App::SETTING_KEYS.to_vec());
    }

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
    fn set_active_model_does_not_downgrade_to_less_qualified_form() {
        // The daemon's `model_settings` resolver expects the alias or
        // provider-qualified name handed to us by switch_model / History.
        // A subsequent `set_active_model` carrying the bare upstream id
        // (e.g. from StreamEnd metadata) must not overwrite the qualified
        // form, or the next `:setting` request will 404.
        let mut app = App::default();
        app.set_active_model(Some("openrouter:anthropic/claude-4.6-opus-20260205"));
        app.effective_sampler = Some(EffectiveSamplerSnapshot {
            model: Some("openrouter:anthropic/claude-4.6-opus-20260205".into()),
            ..EffectiveSamplerSnapshot::default()
        });

        app.set_active_model(Some("anthropic/claude-4.6-opus-20260205"));

        assert_eq!(app.model, "openrouter:anthropic/claude-4.6-opus-20260205");
        assert!(app.effective_sampler.is_some());
        assert!(
            app.active_model_names
                .iter()
                .any(|n| n == "anthropic/claude-4.6-opus-20260205"),
            "the bare form should still be tracked as a match key"
        );
    }

    #[test]
    fn set_active_model_to_genuinely_different_model_resets_sampler() {
        let mut app = App::default();
        app.set_active_model(Some("openrouter:anthropic/claude-4.6-opus-20260205"));
        app.effective_sampler = Some(EffectiveSamplerSnapshot::default());

        app.set_active_model(Some("anthropic/claude-sonnet-4.5"));

        assert_eq!(app.model, "anthropic/claude-sonnet-4.5");
        assert!(app.effective_sampler.is_none());
        assert_eq!(app.active_model_names, vec!["anthropic/claude-sonnet-4.5"]);
    }

    #[test]
    fn set_status_dedupes_consecutive_identical() {
        let mut app = App::default();
        app.set_status("reconnecting: connection lost");
        app.set_status("reconnecting: connection lost");
        app.set_status("reconnecting: connection lost");
        assert_eq!(app.notifications.len(), 1);
        assert_eq!(
            app.notifications[0].content,
            "reconnecting: connection lost"
        );
        assert_eq!(app.notifications[0].count, 3);
    }

    #[test]
    fn set_status_does_not_dedupe_different_content() {
        let mut app = App::default();
        app.set_status("x");
        app.set_status("y");
        assert_eq!(app.notifications.len(), 2);
    }

    #[test]
    fn set_status_does_not_touch_conversation_entries() {
        let mut app = App::default();
        app.entries
            .push(ConversationEntry::user("hi".into(), vec![], String::new()));
        app.set_status("connected");
        // Toasts live outside the conversation log entirely.
        assert_eq!(app.entries.len(), 1);
        assert_eq!(app.notifications.len(), 1);
    }

    #[test]
    fn notification_stack_is_capped() {
        let mut app = App::default();
        for i in 0..10 {
            app.set_status(format!("msg {i}"));
        }
        assert_eq!(app.notifications.len(), MAX_NOTIFICATIONS);
        // Oldest dropped; newest retained.
        assert_eq!(app.notifications.last().unwrap().content, "msg 9");
    }

    #[test]
    fn expired_notifications_are_pruned() {
        let mut app = App::default();
        app.set_status("hi");
        let now = app.notifications[0].created;
        // Just before TTL: still present.
        assert!(
            !app.expire_notifications(now + NOTIFICATION_TTL - std::time::Duration::from_millis(1))
        );
        assert_eq!(app.notifications.len(), 1);
        // After TTL: pruned, returns true.
        assert!(app.expire_notifications(now + NOTIFICATION_TTL));
        assert!(app.notifications.is_empty());
    }

    #[test]
    fn set_error_records_to_error_log() {
        let mut app = App::default();
        app.set_error("error: rate_limit - too many requests");
        assert_eq!(app.notifications.len(), 1);
        assert_eq!(app.notifications[0].level, NotificationLevel::Error);
        assert_eq!(app.error_log.len(), 1);
        assert!(app.error_log[0].contains("rate_limit"));
    }

    #[test]
    fn alt_picker_previews_and_cancels() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::assistant(
            Some("a1".into()),
            "first".into(),
            vec![],
            "t1".into(),
            None,
        ));

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
            app.entries[0].as_turn(),
            Some(t) if t.joined_text() == "second"
        ));

        app.cancel_alt_picker();
        assert!(matches!(
            app.entries[0].as_turn(),
            Some(t) if t.joined_text() == "first"
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
