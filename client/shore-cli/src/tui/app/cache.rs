use super::Line;

#[derive(Default, PartialEq, Eq, Clone)]
pub(crate) struct CompactionFingerprint {
    pub round: u64,
    pub blocks: u32,
    pub last_block: u64,
    pub tool_name_len: i32,
    pub text_len: u32,
    pub thinking_len: u32,
    pub elapsed_secs: u64,
}

#[derive(Default)]
pub(crate) struct ConvCache {
    pub fingerprint: ConvFingerprint,
    pub lines: Vec<Line<'static>>,
    pub content_visual: u16,
}

#[derive(Default, PartialEq, Eq, Clone)]
pub(crate) struct ConvFingerprint {
    pub width: u16,
    pub entries_len: u32,
    pub last_entry: u64,
    pub second_last_entry: u64,
    pub history_version: u64,
    pub stream_active: bool,
    pub stream_regen: bool,
    pub stream_phase_len: u32,
    pub stream_tool_name_len: i32,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub show_subagent: bool,
    pub show_compaction: bool,
    pub compaction: Option<CompactionFingerprint>,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    pub spinner_frame: u32,
    pub character_name_len: u32,
    pub image_cache_version: u64,
}
