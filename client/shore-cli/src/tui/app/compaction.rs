use std::time::{Duration, Instant};

use super::conversation::Block;

pub(crate) const COMPACTION_SUBAGENT: &str = "compaction";

const ROUND_PHASE_PREFIX: &str = "compacting round ";

pub(crate) fn compaction_round_from_phase(phase: &str) -> Option<u64> {
    phase.strip_prefix(ROUND_PHASE_PREFIX)?.trim().parse().ok()
}

#[derive(Debug)]
pub(crate) struct CompactionRun {
    pub(crate) round: u64,
    pub(crate) tool_name: Option<String>,
    pub(crate) blocks: Vec<Block>,
    pub(crate) text: String,
    pub(crate) thinking: String,
    pub(crate) started_at: Option<Instant>,
}

impl Default for CompactionRun {
    fn default() -> Self {
        Self {
            round: 0,
            tool_name: None,
            blocks: Vec::new(),
            text: String::new(),
            thinking: String::new(),
            started_at: Some(Instant::now()),
        }
    }
}

impl CompactionRun {
    pub(crate) fn elapsed(&self) -> Option<Duration> {
        self.started_at.map(|at| at.elapsed())
    }

    pub(crate) fn flush_text(&mut self) {
        if !self.text.is_empty() {
            self.blocks
                .push(Block::Text(std::mem::take(&mut self.text)));
        }
    }

    pub(crate) fn flush_thinking(&mut self) {
        if !self.thinking.is_empty() {
            self.blocks
                .push(Block::Thinking(std::mem::take(&mut self.thinking)));
        }
    }

    pub(crate) fn append_text(&mut self, text: &str) {
        self.flush_thinking();
        self.text.push_str(text);
    }

    pub(crate) fn append_thinking(&mut self, text: &str) {
        self.flush_text();
        self.thinking.push_str(text);
    }

    pub(crate) fn push_block(&mut self, block: Block) {
        self.flush_text();
        self.flush_thinking();
        if let Block::ToolUse { ref tool_name, .. } = block {
            self.tool_name = Some(tool_name.clone());
        }
        if matches!(block, Block::ToolResult { .. }) {
            self.tool_name = None;
        }
        self.blocks.push(block);
    }

    pub(crate) fn note_round(&mut self, round: u64) {
        self.flush_text();
        self.flush_thinking();
        self.round = round;
        self.tool_name = None;
    }
}

pub(crate) fn format_elapsed(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    if secs < 60 {
        return format!("{secs}s");
    }
    let minutes = secs.checked_div(60).unwrap_or(0);
    let remainder = secs.checked_rem(60).unwrap_or(0);
    format!("{minutes}m{remainder:02}s")
}
