use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use crate::llm::types::{GenerateResponse, LlmRequest};

// ---------------------------------------------------------------------------
// Configuration — re-exported from shore-common (single source of truth)
// ---------------------------------------------------------------------------

pub use shore_common::config::app::CompactionConfig;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A message from a conversation, used as input to compaction.
#[derive(Debug, Clone)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
    pub timestamp: String,
    /// True when a user message's content_blocks are ALL ToolResult
    /// (i.e. a tool-loop intermediate, not a real user turn).
    pub is_tool_result_only: bool,
    /// True when the message was sent autonomously (heartbeat
    /// `<sendMessage>`), i.e. `Message::origin == Some(Autonomous)`.
    /// Deep-idle archiving keeps a trailing run of these visible.
    pub is_autonomous: bool,
}

/// Outcome of a compaction operation.
#[derive(Debug)]
pub enum CompactionOutcome {
    Compacted(CompactionResult),
    DryRun(DryRunResult),
    /// The compaction LLM ran but produced zero allowed memory writes. The
    /// active conversation was NOT archived; the caller should leave the
    /// transcript in place and retry on the next trigger.
    ///
    /// This exists to make it impossible to silently archive without writing
    /// memory — the failure mode the tool-loop redesign is meant to kill.
    NoMemoryWrites(NoMemoryWritesResult),
}

/// Result of an actual compaction.
#[derive(Debug)]
pub struct CompactionResult {
    pub memory_files_written: Vec<String>,
    pub conversation_id: String,
    pub new_conversation_id: String,
    pub message_count: usize,
    pub compacted_turns: usize,
    pub retained_count: usize,
    pub retained_turns: usize,
    /// Paths of markdown files written during compaction.
    pub markdown_paths: Vec<String>,
    /// Number of tool-use rounds the compaction LLM ran.
    pub tool_rounds: u32,
    /// Names of tools the compaction LLM called, in order. Useful for
    /// forensics when the model used read-only tools alongside writes.
    pub tools_called: Vec<String>,
}

/// Result of a dry-run compaction.
#[derive(Debug)]
pub struct DryRunResult {
    pub would_write_files: usize,
    pub file_ops_preview: Vec<crate::memory::compaction::parser::MemoryFileOp>,
    pub message_count: usize,
    pub compacted_turns: usize,
    pub retained_count: usize,
    pub retained_turns: usize,
    /// Paths of markdown files that would be written.
    pub markdown_preview: Vec<String>,
    /// Number of tool-use rounds the compaction LLM ran during the dry
    /// pass. Writes are blocked but read-only tool calls still count.
    pub tool_rounds: u32,
    /// Names of tools the model attempted to call.
    pub tools_called: Vec<String>,
}

/// Diagnostics for a compaction pass that produced no allowed memory writes.
#[derive(Debug)]
pub struct NoMemoryWritesResult {
    pub conversation_id: String,
    /// Number of messages that would have been archived if the pass had
    /// produced writes.
    pub message_count: usize,
    pub compacted_turns: usize,
    pub tool_rounds: u32,
    pub tools_called: Vec<String>,
    /// Paths the model attempted to write to but were rejected by the
    /// compaction path filter (e.g. SOUL.md, DREAMS.md, paths outside
    /// memory/). Empty when the model wrote nothing at all.
    pub rejected_paths: Vec<String>,
    /// True if the loop terminated because it hit the per-model
    /// `max_tool_iterations` cap rather than the model ending cleanly. Always
    /// false when the cap is unlimited (the default).
    pub max_rounds_hit: bool,
}

/// Parameters for archiving with message retention.
#[derive(Debug)]
pub struct RetentionParams {
    /// Number of messages to keep from the end of active.jsonl.
    pub keep_last_n: usize,
    /// Pre-read content of active.jsonl at the time messages were parsed.
    /// Eliminates the TOCTOU race where the file could change between
    /// message analysis and the archive-and-retain write.
    pub active_content: String,
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CompactionError {
    #[error("llm: {0}")]
    Llm(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("insufficient messages")]
    InsufficientMessages,
    #[error("conversation: {0}")]
    ConversationManager(String),
    #[error("markdown store: {0}")]
    MarkdownStore(String),
}

// ---------------------------------------------------------------------------
// Traits for external dependencies
// ---------------------------------------------------------------------------

/// LLM client for compaction.
///
/// The compaction manager drives the tool loop itself (it owns the path
/// filter, rollback list, and the "no writes → no archive" guard). The LLM
/// trait is therefore split into two small pieces:
///
/// 1. [`CompactionLlm::build_initial_request`] — produce the first
///    `LlmRequest` for a pass by extending a chat-shape request with the
///    compaction tail.
/// 2. [`CompactionLlm::generate`] — run a single round against an
///    already-built (possibly extended) request.
///
/// `chat_request` carries chat's `(system, tools, messages)` — either pulled
/// from `AutonomyState::last_request` (the warm-cache path) or rebuilt from
/// disk via `handler::build_chat_shape_request_from_disk` (the cold path).
/// Either way the wire shape is identical to what chat's next turn would
/// send. The implementation rebuilds against the compaction model and
/// appends the "compact now" user message plus an inline `role:"system"`
/// entry carrying the compaction instruction at a fixed slot — see
/// `compaction_impls::COMPACTION_TAIL_ENTRY_COUNT` for why this is the only
/// shape safe across the tool loop.
pub trait CompactionLlm: Send + Sync {
    fn build_initial_request(
        &self,
        system: &str,
        compact_now_user: serde_json::Value,
        chat_request: LlmRequest,
    ) -> Result<LlmRequest, CompactionError>;

    fn generate<'src>(
        &'src self,
        request: &'src mut LlmRequest,
    ) -> Pin<Box<dyn Future<Output = Result<GenerateResponse, CompactionError>> + Send + 'src>>;
}

/// Conversation lifecycle management — archive old messages and retain recent ones.
pub trait ConversationManager: Send + Sync {
    fn archive_and_retain(
        &self,
        conversation_id: &str,
        params: RetentionParams,
    ) -> Pin<Box<dyn Future<Output = Result<String, CompactionError>> + Send + '_>>;
}

// ---------------------------------------------------------------------------
// Tool-loop bookkeeping
// ---------------------------------------------------------------------------

/// A single workspace memory write that was applied during the compaction
/// tool loop. Stored on the manager's rollback list so a downstream archive
/// failure can restore the previous content (or delete the file).
#[derive(Debug)]
pub struct AppliedCompactionWrite {
    /// Path the model passed to `write`/`edit` (display form, e.g.
    /// `memory/people/foo.md` or `MEMORY.md`).
    pub display_path: String,
    /// Resolved absolute path on disk.
    pub resolved_path: PathBuf,
    /// Previous file content captured before the write. `None` if the file
    /// did not exist.
    pub previous_content: Option<String>,
    /// True when the target was the workspace-root `MEMORY.md` (or its
    /// normalized form). Tracked for diagnostics; the dispatch layer's
    /// `defer_edit` hook is what actually queues the prompt refresh.
    pub memory_index_target: bool,
}
