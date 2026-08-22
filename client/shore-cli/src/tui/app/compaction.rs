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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_round_phase_is_recognised_and_anything_else_is_left_alone() {
        assert_eq!(compaction_round_from_phase("compacting round 3"), Some(3));
        assert_eq!(compaction_round_from_phase("compacting round 12"), Some(12));
        assert_eq!(compaction_round_from_phase("thinking"), None);
        assert_eq!(compaction_round_from_phase("responding"), None);
        assert_eq!(compaction_round_from_phase("compacting round"), None);
        assert_eq!(compaction_round_from_phase("compacting round x"), None);
    }

    #[test]
    fn streamed_text_and_thinking_never_interleave_into_one_block() {
        let mut run = CompactionRun::default();
        run.append_thinking("weighing ");
        run.append_thinking("the options");
        run.append_text("writing it down");
        run.flush_text();

        assert_eq!(run.blocks.len(), 2);
        assert!(
            matches!(run.blocks.first(), Some(Block::Thinking(t)) if t == "weighing the options")
        );
        assert!(matches!(run.blocks.get(1), Some(Block::Text(t)) if t == "writing it down"));
    }

    #[test]
    fn a_tool_call_becomes_the_current_activity_until_its_result_lands() {
        let mut run = CompactionRun::default();
        run.push_block(Block::ToolUse {
            tool_id: "t1".into(),
            tool_name: "edit".into(),
            input: serde_json::json!({ "path": "memory/notes.md" }),
        });
        assert_eq!(run.tool_name.as_deref(), Some("edit"));

        run.push_block(Block::ToolResult {
            tool_id: "t1".into(),
            tool_name: "edit".into(),
            output: "written".into(),
            is_error: false,
        });
        assert_eq!(run.tool_name, None);
    }

    #[test]
    fn a_new_round_clears_the_tool_and_commits_what_was_streamed() {
        let mut run = CompactionRun::default();
        run.append_text("partial");
        run.tool_name = Some("read".into());
        run.note_round(4);

        assert_eq!(run.round, 4);
        assert_eq!(run.tool_name, None);
        assert!(matches!(run.blocks.first(), Some(Block::Text(t)) if t == "partial"));
    }

    #[test]
    fn elapsed_reads_as_a_clock_not_a_float() {
        assert_eq!(format_elapsed(Duration::from_secs(9)), "9s");
        assert_eq!(format_elapsed(Duration::from_secs(59)), "59s");
        assert_eq!(format_elapsed(Duration::from_secs(60)), "1m00s");
        assert_eq!(format_elapsed(Duration::from_secs(252)), "4m12s");
    }
}
