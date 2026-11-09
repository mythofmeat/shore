use super::Line;

#[derive(Default, PartialEq, Eq, Clone, Debug)]
pub(crate) struct CompactionFingerprint {
    pub round: u64,
    pub blocks: usize,
    pub last_block: usize,
    pub tool_name_len: Option<usize>,
    pub text_len: usize,
    pub thinking_len: usize,
    pub elapsed_secs: u64,
}

#[derive(Default, PartialEq, Eq, Clone, Copy, Debug)]
pub(crate) enum EntrySummary {
    #[default]
    Absent,
    Turn {
        assistant: bool,
        streaming: bool,
        metadata: bool,
        images: usize,
        blocks: usize,
        last_block: usize,
    },
    System {
        content_len: usize,
        count: u32,
    },
}

#[derive(Default)]
pub(crate) struct ConvCache {
    pub fingerprint: ConvFingerprint,
    pub lines: Vec<Line<'static>>,
    pub content_visual: usize,
    pub settled_fingerprint: ConvFingerprint,
    pub settled_entries: usize,
    pub settled_lines: usize,
    pub settled_images: usize,
}

#[derive(Default, PartialEq, Eq, Clone, Debug)]
pub(crate) struct ConvFingerprint {
    pub width: u16,
    pub entries_len: usize,
    pub last_entry: EntrySummary,
    pub second_last_entry: EntrySummary,
    pub history_version: u64,
    pub stream_active: bool,
    pub stream_regen: bool,
    pub stream_phase_len: usize,
    pub stream_tool_name_len: Option<usize>,
    pub show_thinking: bool,
    pub show_tools: bool,
    pub show_subagent: bool,
    pub show_compaction: bool,
    pub compaction: Option<CompactionFingerprint>,
    pub show_images: bool,
    pub show_timestamps: bool,
    pub show_metadata: bool,
    pub spinner_frame: usize,
    pub character_name_len: usize,
    pub image_cache_version: u64,
}

impl ConvFingerprint {
    pub(crate) fn settled(&self) -> Self {
        let mut result = self.clone();
        result.entries_len = 0;
        result.last_entry = EntrySummary::Absent;
        result.second_last_entry = EntrySummary::Absent;
        result.stream_active = false;
        result.stream_regen = false;
        result.stream_phase_len = 0;
        result.stream_tool_name_len = None;
        result.spinner_frame = 0;
        result.compaction = None;
        result
    }
}
