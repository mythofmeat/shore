use super::*;

/// Cached output of `draw_conversation`'s line-building pass.
///
/// Building these lines walks every entry, runs markdown rendering, and
/// word-wraps everything — work proportional to total conversation size.
/// Without a cache, every keystroke pays that cost, so input latency grows
/// with conversation length. The cache hits when the cheap fingerprint
/// (entries length + last-entry summary + stream/toggle state + image cache
/// version + width) matches the previous build.
#[derive(Default)]
pub(crate) struct ConvCache {
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
pub(crate) struct ConvFingerprint {
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
