pub mod background;
pub mod parser;
pub mod types;

pub use background::run_compaction;
pub use parser::{
    parse_compaction_response, MemoryFileOp, DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM,
};
pub use types::*;

use crate::llm::types::GenerateResponse;
use crate::memory::markdown_store::MarkdownMemoryStore;
use crate::tools::{self as tool_system, ToolContext};
use dashmap::DashMap;
use serde_json::{json, Value};
use shore_common::config::character_data_dir;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, Notify, OwnedMutexGuard};
use tokio::time::Duration;
use tracing::{debug, info, instrument, warn};

static COMPACTION_LOCKS: OnceLock<DashMap<PathBuf, Arc<Mutex<()>>>> = OnceLock::new();

/// Held while a character data root has a compaction pass in flight.
///
/// Manual and idle-triggered compaction both mutate the same active transcript,
/// segment manifest, markdown memory files, and prompt-refresh state. Keep them
/// single-flight per character data root so a slow provider response cannot
/// overlap with another compaction pass against the same pre-compaction active
/// window. Tests may host separate daemon instances for the same character
/// name in one process, so the character name alone is not a sufficient key.
#[derive(Debug)]
pub struct CompactionRunGuard {
    _guard: OwnedMutexGuard<()>,
}

pub fn try_begin_compaction(data_dir: &Path, character: &str) -> Option<CompactionRunGuard> {
    let locks = COMPACTION_LOCKS.get_or_init(DashMap::new);
    let lock = locks
        .entry(character_data_dir(data_dir, character))
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    lock.try_lock_owned()
        .ok()
        .map(|guard| CompactionRunGuard { _guard: guard })
}

// ---------------------------------------------------------------------------
// CompactionManager
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct CompactionManager {
    config: CompactionConfig,
    activity_notify: Arc<Notify>,
}

/// Inputs to the archive/finalize phase of compaction, threaded as one struct
/// to keep [`CompactionManager::archive_and_build_result`] within the argument
/// budget.
struct CompactionArchiveInputs<'inputs> {
    conversation_id: &'inputs str,
    active_content: &'inputs str,
    char_name: &'inputs str,
    workspace_dir: &'inputs str,
    data_dir: Option<&'inputs Path>,
    split_at: usize,
    compacted_turns: usize,
    retained: usize,
    retained_turns: usize,
    compaction_started: std::time::Instant,
}

/// Build the dry-run preview outcome (no archiving, no file writes).
fn build_dry_run_outcome(
    loop_state: ToolLoopState,
    split_at: usize,
    compacted_turns: usize,
    retained_count: usize,
    retained_turns: usize,
) -> CompactionOutcome {
    let markdown_preview: Vec<String> = loop_state
        .dry_run_previews
        .iter()
        .map(|op| op.path.clone())
        .collect();
    CompactionOutcome::DryRun(DryRunResult {
        would_write_files: loop_state.dry_run_previews.len(),
        file_ops_preview: loop_state.dry_run_previews,
        message_count: split_at,
        compacted_turns,
        retained_count,
        retained_turns,
        markdown_preview,
        tool_rounds: loop_state.tool_rounds,
        tools_called: loop_state.tools_called,
    })
}

/// Build the no-memory-writes outcome and warn that the active conversation was
/// left intact (issue #43 guard).
fn build_no_memory_writes_outcome(
    conversation_id: &str,
    loop_state: ToolLoopState,
    split_at: usize,
    compacted_turns: usize,
) -> CompactionOutcome {
    warn!(
        conversation_id,
        tool_rounds = loop_state.tool_rounds,
        rejected_paths = loop_state.rejected_paths.len(),
        max_rounds_hit = loop_state.max_rounds_hit,
        "compaction: zero memory writes; active conversation NOT archived"
    );
    CompactionOutcome::NoMemoryWrites(NoMemoryWritesResult {
        conversation_id: conversation_id.to_owned(),
        message_count: split_at,
        compacted_turns,
        tool_rounds: loop_state.tool_rounds,
        tools_called: loop_state.tools_called,
        rejected_paths: loop_state.rejected_paths,
        max_rounds_hit: loop_state.max_rounds_hit,
    })
}

/// Build the compaction system prompt + the single "compact now" user
/// message. `chat_request` carries chat's full prefix (`system`, `tools`,
/// `messages`); the LLM impl rebuilds it against the compaction model and
/// appends this one user turn plus the compaction system instruction as an
/// inline `role:"system"` entry at a fixed slot — see
/// `compaction_impls::COMPACTION_TAIL_ENTRY_COUNT`. The inline shape (instead
/// of `system_suffix`) is what keeps the compact-now slot byte-stable across
/// the compaction tool loop, so chat's cache prefix continues to extend
/// cleanly.
fn build_compact_llm_request(
    llm: &dyn CompactionLlm,
    system_template: &str,
    prompt_template: &str,
    char_name: &str,
    user_name: &str,
    chat_request: crate::llm::types::LlmRequest,
) -> Result<crate::llm::types::LlmRequest, CompactionError> {
    let system = CompactionManager::build_system(system_template, char_name, user_name);
    let final_msg = CompactionManager::build_final_message(prompt_template, char_name, user_name);
    let compact_now_user = json!({"role": "user", "content": final_msg});
    llm.build_initial_request(&system, compact_now_user, chat_request)
}

impl CompactionManager {
    pub fn new(config: CompactionConfig) -> Self {
        Self {
            config,
            activity_notify: Arc::new(Notify::new()),
        }
    }

    /// Check if a ConversationMessage is a tool-loop intermediate that
    /// should not be split from its context during compaction.
    fn is_tool_loop_message(msg: &ConversationMessage) -> bool {
        match msg.role.as_str() {
            "user" => msg.is_tool_result_only,
            "assistant" => {
                // Assistant messages in tool loops have empty text content
                // (all their content is tool_use blocks).
                msg.content.is_empty()
            }
            _ => false,
        }
    }

    /// Find the split index that retains `keep_turns` complete user turns
    /// at the tail.  Returns the index of the first retained message.
    /// Returns 0 if there aren't enough messages to compact anything.
    /// When `keep_turns == 0`, returns `messages.len()` so the caller
    /// retains nothing and compacts everything.
    fn find_turn_split(messages: &[ConversationMessage], keep_turns: usize) -> usize {
        if keep_turns == 0 {
            return messages.len();
        }
        let mut turns_seen = 0_usize;
        for (i, msg) in messages.iter().enumerate().rev() {
            if msg.role == "user" && !Self::is_tool_loop_message(msg) {
                turns_seen = turns_seen.saturating_add(1);
                if turns_seen >= keep_turns {
                    return i;
                }
            }
        }
        0
    }

    fn count_turns(messages: &[ConversationMessage]) -> usize {
        messages
            .iter()
            .filter(|msg| msg.role == "user" && !Self::is_tool_loop_message(msg))
            .count()
    }

    /// Compute the archive split index: retain `keep_turns` user turns at the
    /// tail, optionally clamped so a trailing run of unanswered autonomous
    /// messages stays in the active conversation. The clamp only matters for
    /// keep-0 splits — any keep >= 1 split already lands at or before the
    /// last real user turn, which precedes the trailing autonomous run.
    fn archive_split_index(
        messages: &[ConversationMessage],
        keep_turns: usize,
        retain_trailing_autonomous: bool,
    ) -> usize {
        let split_at = Self::find_turn_split(messages, keep_turns);
        if !retain_trailing_autonomous {
            return split_at;
        }
        let tail = Self::trailing_autonomous_len(messages);
        split_at.min(messages.len().saturating_sub(tail))
    }

    /// Length of the trailing run of autonomous assistant messages — heartbeat
    /// `<sendMessage>` output the user has not yet responded to (any user
    /// message after it would terminate the run). Deep-idle archiving keeps
    /// this tail in the active conversation so the user still sees the
    /// message when they return.
    pub fn trailing_autonomous_len(messages: &[ConversationMessage]) -> usize {
        messages
            .iter()
            .rev()
            .take_while(|msg| msg.role == "assistant" && msg.is_autonomous)
            .count()
    }

    /// Signal that a new message was received, resetting the idle timer.
    pub fn notify_activity(&self) {
        self.activity_notify.notify_one();
    }

    /// Check if forced compaction should trigger (max turns reached).
    pub fn should_force_compact(&self, turn_count: usize) -> bool {
        self.config.max_turns > 0
            && turn_count >= self.config.max_turns
            && self.has_enough_turns(turn_count)
    }

    /// Check minimum turn gating for any trigger.
    pub fn has_enough_turns(&self, turn_count: usize) -> bool {
        turn_count >= self.config.min_turns
    }

    /// Render the system prompt template, substituting `{{char}}` and `{{user}}`.
    pub fn build_system(template: &str, char_name: &str, user_name: &str) -> String {
        template
            .replace("{{char}}", char_name)
            .replace("{{user}}", user_name)
    }

    /// Render the final compaction user message. The template supports:
    /// - `{{char}}` / `{{user}}` — character and user names
    /// - legacy `{{#if recap}}...{{/if}}` and `{{recap}}` placeholders, which
    ///   are stripped (recaps are no longer generated).
    ///
    /// Existing memory is no longer inlined here: the model already has the
    /// `MEMORY.md` index in its system prompt and reaches full files via its
    /// `read`/`list_files`/`search` tools on demand.
    pub fn build_final_message(
        final_message_template: &str,
        char_name: &str,
        user_name: &str,
    ) -> String {
        let mut final_msg = final_message_template
            .replace("{{char}}", char_name)
            .replace("{{user}}", user_name);

        while let (Some(if_start), Some(endif_pos)) =
            (final_msg.find("{{#if recap}}"), final_msg.find("{{/if}}"))
        {
            final_msg = format!(
                "{}{}",
                final_msg.get(..if_start).unwrap_or(""),
                final_msg
                    .get(endif_pos.saturating_add("{{/if}}".len())..)
                    .unwrap_or(""),
            );
        }
        final_msg.replace("{{recap}}", "")
    }

    /// Build a compaction prompt from a template and conversation messages.
    ///
    /// Legacy helper used by tests that check the flattened prompt string.
    /// Replaces `{{conversation}}` with formatted messages and substitutes
    /// `{{char}}` / `{{user}}` with the provided names.
    #[cfg(test)]
    #[expect(
        clippy::string_slice,
        reason = "byte offsets derive from find()/literal-len() on `result` itself, so every slice bound lands on a char boundary"
    )]
    pub fn build_prompt(
        template: &str,
        messages: &[ConversationMessage],
        char_name: &str,
        user_name: &str,
    ) -> String {
        use std::fmt::Write as _;

        let mut conversation_text = String::new();
        for msg in messages {
            let _ignored = writeln!(
                &mut conversation_text,
                "[{}] {}: {}",
                msg.timestamp, msg.role, msg.content
            );
        }

        let mut result = template.replace("{{conversation}}", &conversation_text);

        while let (Some(if_start), Some(endif_pos)) =
            (result.find("{{#if recap}}"), result.find("{{/if}}"))
        {
            result = format!(
                "{}{}",
                &result[..if_start],
                &result[endif_pos + "{{/if}}".len()..],
            );
        }
        result = result.replace("{{recap}}", "");

        result = result.replace("{{char}}", char_name);
        result = result.replace("{{user}}", user_name);

        result
    }

    pub(crate) fn write_allowed_path(path: &str) -> bool {
        let normalized = path.trim().trim_start_matches("./").replace('\\', "/");

        // Defense-in-depth: reject absolute paths and any `..` traversal
        // component outright. A path like `memory/../../secrets.md` would
        // otherwise satisfy the `memory/` prefix check below yet escape the
        // memory root. resolve_path enforces this again at write time, but
        // rejecting here keeps this documented compaction guard self-contained
        // and fails closed at the layer meant to keep writes inside the
        // workspace.
        for component in Path::new(&normalized).components() {
            match component {
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => return false,
                Component::CurDir | Component::Normal(_) => {}
            }
        }

        let lower = normalized.to_lowercase();

        // MEMORY.md (workspace root) is intentionally allowed: compaction's
        // job includes updating the conversational throughline.
        if lower == "memory.md" {
            return true;
        }

        // The other workspace-root prompt files (SOUL.md, USER.md, AGENTS.md,
        // TOOLS.md) are allowed too: the compaction prompt asks
        // the model to distill durable facts into them. These writes go
        // through the same deferred-edit queue as chat-turn edits, so they
        // only become prompt-active at the boundary this pass creates.
        if crate::memory::deferred_edits::is_prompt_visible_path(&normalized) {
            return true;
        }

        // All other compaction writes must live under memory/. This keeps
        // daemon-owned artifacts (DREAMS.md) and arbitrary workspace paths
        // out of compaction's reach.
        let Some(rest) = normalized.strip_prefix("memory/") else {
            return false;
        };
        if rest.is_empty() {
            return false;
        }

        // Block dreaming-generated artifacts so compaction doesn't stomp on
        // them. The filter applies to the path inside memory/.
        let rest_lower = rest.to_lowercase();
        !(rest_lower == "dreams.md"
            || rest_lower == "dreams"
            || rest_lower == "dreams/"
            || rest_lower.starts_with(".dreams/")
            || rest_lower.starts_with("dreaming/"))
    }

    fn workspace_dir_from_store(store: &MarkdownMemoryStore) -> Result<PathBuf, CompactionError> {
        store
            .base_dir()
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| {
                CompactionError::MarkdownStore(format!(
                    "memory store has no workspace parent: {}",
                    store.base_dir().display()
                ))
            })
    }

    /// Workspace dir for path resolution + previous-content snapshots.
    /// Prefers the markdown store's parent (canonical for production); falls
    /// back to `tool_ctx.workspace_dir()` for tests / dry runs without a
    /// store. Live passes commit their memory writes through the (git-gated)
    /// exec tool, so this also ensures the workspace is a git repository
    /// before the loop starts.
    async fn prepare_pass_workspace(
        markdown_store: Option<&MarkdownMemoryStore>,
        tool_ctx: &dyn ToolContext,
        char_name: &str,
        dry_run: bool,
    ) -> Result<String, CompactionError> {
        let workspace_dir = if let Some(store) = markdown_store {
            let from_store = Self::workspace_dir_from_store(store)?;
            // write/edit path resolution and git bootstrap/rollback use this
            // store-derived root, but the model's `exec` (git commits) runs
            // against `tool_ctx.workspace_dir()`. If those disagree the commit
            // would target a different tree than the one we bootstrap and roll
            // back. They are always the same in production; fail fast rather
            // than silently operate on two repos.
            let from_ctx = Path::new(tool_ctx.workspace_dir());
            let agree = match (from_store.canonicalize(), from_ctx.canonicalize()) {
                (Ok(a), Ok(b)) => a == b,
                _ => from_store.as_path() == from_ctx,
            };
            if !agree {
                return Err(CompactionError::MarkdownStore(format!(
                    "workspace root mismatch: store={} tool_ctx={}",
                    from_store.display(),
                    tool_ctx.workspace_dir()
                )));
            }
            from_store.to_string_lossy().into_owned()
        } else {
            tool_ctx.workspace_dir().to_owned()
        };
        if !dry_run {
            crate::tools::workspace::ensure_workspace_git_repo_best_effort(
                Path::new(&workspace_dir),
                char_name,
                "compaction",
            )
            .await;
        }
        Ok(workspace_dir)
    }

    async fn write_workspace_file(path: &Path, content: &str) -> Result<(), CompactionError> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| CompactionError::MarkdownStore(e.to_string()))?;
        }
        tokio::fs::write(path, content)
            .await
            .map_err(|e| CompactionError::MarkdownStore(e.to_string()))
    }

    /// Splits messages into a compacted portion (sent to LLM) and a retained
    /// portion (kept in active.jsonl). The compaction LLM runs a tool loop
    /// against `tool_ctx`; the `write`/`edit` tools persist memory files
    /// directly. Compaction archives the active conversation only when at
    /// least one allowed memory write actually occurred — a "zero writes"
    /// outcome returns [`CompactionOutcome::NoMemoryWrites`] and leaves
    /// `active.jsonl` untouched.
    ///
    /// If `dry_run` is true, write/edit tool calls are blocked at the
    /// dispatch wrapper; the intended paths are still recorded for the
    /// returned preview but no files are modified and the conversation is
    /// not archived.
    #[instrument(skip(self, messages, active_content, system_template, prompt_template, llm, conversation_mgr, markdown_store, chat_request, tool_ctx), fields(char = char_name, user = user_name, msg_count = messages.len(), dry_run))]
    #[expect(
        clippy::too_many_arguments,
        reason = "compaction boundary still carries storage, prompt, and tool-loop state"
    )]
    pub async fn compact(
        &self,
        conversation_id: &str,
        messages: &[ConversationMessage],
        active_content: &str,
        system_template: &str,
        prompt_template: &str,
        char_name: &str,
        user_name: &str,
        llm: &dyn CompactionLlm,
        conversation_mgr: &dyn ConversationManager,
        markdown_store: Option<&MarkdownMemoryStore>,
        dry_run: bool,
        keep_turns_override: Option<usize>,
        retain_trailing_autonomous: bool,
        chat_request: crate::llm::types::LlmRequest,
        data_dir: Option<&Path>,
        tool_ctx: &dyn ToolContext,
        max_tool_iterations: Option<u32>,
    ) -> Result<CompactionOutcome, CompactionError> {
        let compaction_started = std::time::Instant::now();
        info!(
            conversation_id,
            messages = messages.len(),
            char_name,
            user_name,
            dry_run,
            "Compaction started"
        );

        if messages.is_empty() {
            return Err(CompactionError::InsufficientMessages);
        }

        // Split messages: compact the older portion, retain the recent tail.
        let keep_turns = keep_turns_override.unwrap_or(self.config.keep_recent_turns);
        let split_at = Self::archive_split_index(messages, keep_turns, retain_trailing_autonomous);
        if split_at == 0 {
            return Err(CompactionError::InsufficientMessages);
        }
        debug!(
            compacted = split_at,
            retained = messages.len().saturating_sub(split_at),
            "Conversation split for compaction"
        );

        if !dry_run && markdown_store.is_none() {
            return Err(CompactionError::MarkdownStore(
                "markdown memory store not available".to_owned(),
            ));
        }

        let mut request = build_compact_llm_request(
            llm,
            system_template,
            prompt_template,
            char_name,
            user_name,
            chat_request,
        )?;

        let workspace_dir =
            Self::prepare_pass_workspace(markdown_store, tool_ctx, char_name, dry_run).await?;

        let compacted_turns = Self::count_turns(messages.get(..split_at).unwrap_or(messages));
        let retained_turns = Self::count_turns(messages.get(split_at..).unwrap_or(&[]));

        // Drive the tool loop. Tracks: real writes (for archive + rollback),
        // rejected writes (for NoMemoryWrites diagnostics), all tools called
        // (for forensics), and any intended writes during dry-run (for the
        // DryRun preview).
        // `None` = unlimited (the per-model default); the loop then ends only
        // when the model stops calling tools.
        let loop_started = std::time::Instant::now();
        let loop_state = run_compaction_tool_loop(
            llm,
            &mut request,
            tool_ctx,
            &workspace_dir,
            max_tool_iterations,
            dry_run,
        )
        .await?;
        debug!(
            elapsed = ?loop_started.elapsed(),
            tool_rounds = loop_state.tool_rounds,
            writes = loop_state.writes_applied.len(),
            rejected = loop_state.rejected_paths.len(),
            max_rounds_hit = loop_state.max_rounds_hit,
            "compaction: tool loop done"
        );

        self.try_complete_compact(
            dry_run,
            loop_state,
            conversation_id,
            conversation_mgr,
            tool_ctx,
            CompactionArchiveInputs {
                conversation_id,
                active_content,
                char_name,
                workspace_dir: &workspace_dir,
                data_dir,
                split_at,
                compacted_turns,
                retained: messages.len().saturating_sub(split_at),
                retained_turns,
                compaction_started,
            },
        )
        .await
    }

    /// Route the tool-loop result to the appropriate outcome: dry-run preview,
    /// no-memory-writes rejection, or archive+finalize via [`archive_and_build_result`].
    async fn try_complete_compact(
        &self,
        dry_run: bool,
        loop_state: ToolLoopState,
        conversation_id: &str,
        conversation_mgr: &dyn ConversationManager,
        tool_ctx: &dyn ToolContext,
        inputs: CompactionArchiveInputs<'_>,
    ) -> Result<CompactionOutcome, CompactionError> {
        if dry_run {
            return Ok(build_dry_run_outcome(
                loop_state,
                inputs.split_at,
                inputs.compacted_turns,
                inputs.retained,
                inputs.retained_turns,
            ));
        }
        // NoMemoryWrites: leave the active conversation intact. This is
        // the primary fix for issue #43 — the parser path used to fall
        // through to archive when the model emitted tool_use blocks
        // instead of an XML payload, silently clearing active.jsonl
        // without updating any memory file.
        if loop_state.writes_applied.is_empty() {
            return Ok(build_no_memory_writes_outcome(
                conversation_id,
                loop_state,
                inputs.split_at,
                inputs.compacted_turns,
            ));
        }
        self.archive_and_build_result(conversation_mgr, tool_ctx, loop_state, inputs)
            .await
    }

    /// Archive the compacted prefix, retain the recent tail, queue any
    /// MEMORY.md prompt refresh, append a dreams-log entry, and assemble the
    /// `Compacted` outcome. On archive failure the applied writes are rolled
    /// back.
    async fn archive_and_build_result(
        &self,
        conversation_mgr: &dyn ConversationManager,
        tool_ctx: &dyn ToolContext,
        loop_state: ToolLoopState,
        inputs: CompactionArchiveInputs<'_>,
    ) -> Result<CompactionOutcome, CompactionError> {
        let CompactionArchiveInputs {
            conversation_id,
            active_content,
            char_name,
            workspace_dir,
            data_dir,
            split_at,
            compacted_turns,
            retained,
            retained_turns,
            compaction_started,
        } = inputs;

        // Archive compacted messages and retain recent context.
        let archive_started = std::time::Instant::now();
        let new_conversation_id = archive_compact_prefix(
            conversation_mgr,
            conversation_id,
            retained,
            active_content,
            &loop_state.writes_applied,
            workspace_dir,
            char_name,
        )
        .await?;
        debug!(
            retained,
            elapsed = ?archive_started.elapsed(),
            "compaction: archive/retain done"
        );

        let markdown_paths: Vec<String> = loop_state
            .writes_applied
            .iter()
            .map(|write| write.display_path.clone())
            .collect();
        let memory_index_updated = loop_state
            .writes_applied
            .iter()
            .any(|write| write.memory_index_target);
        queue_memory_index_refresh(memory_index_updated, tool_ctx, data_dir, char_name);
        append_compaction_dream_log(
            data_dir,
            char_name,
            conversation_id,
            compacted_turns,
            &markdown_paths,
        )
        .await;

        info!(
            memory_files_written = markdown_paths.len(),
            markdown_files = markdown_paths.len(),
            conversation_id,
            retained,
            tool_rounds = loop_state.tool_rounds,
            elapsed = ?compaction_started.elapsed(),
            "Compaction complete"
        );
        Ok(CompactionOutcome::Compacted(CompactionResult {
            memory_files_written: markdown_paths.clone(),
            conversation_id: conversation_id.to_owned(),
            new_conversation_id,
            message_count: split_at,
            compacted_turns,
            retained_count: retained,
            retained_turns,
            markdown_paths,
            tool_rounds: loop_state.tool_rounds,
            tools_called: loop_state.tools_called,
        }))
    }

    /// Compensating-delete rollback for a failed compaction.
    ///
    /// Iterates the applied writes in reverse: restores prior content if
    /// the file existed before compaction, otherwise deletes the file.
    /// Errors during cleanup are logged at WARN level and skipped so
    /// rollback continues regardless of individual failures.
    async fn rollback_compaction(writes: &[AppliedCompactionWrite]) {
        for write in writes.iter().rev() {
            match &write.previous_content {
                Some(previous) => {
                    if let Err(e) = Self::write_workspace_file(&write.resolved_path, previous).await
                    {
                        warn!(
                            path = %write.resolved_path.display(),
                            display = %write.display_path,
                            error = %e,
                            "rollback: failed to restore compaction write"
                        );
                    }
                }
                None => match tokio::fs::remove_file(&write.resolved_path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        warn!(
                            path = %write.resolved_path.display(),
                            display = %write.display_path,
                            error = %e,
                            "rollback: failed to delete compaction write"
                        );
                    }
                },
            }
        }
    }

    /// Create an idle timer bound to this manager's activity signal.
    pub fn idle_timer(&self) -> IdleTimer {
        IdleTimer {
            idle_duration: self.config.idle_trigger.as_duration(),
            activity_notify: Arc::clone(&self.activity_notify),
        }
    }
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

/// Archive the compacted message prefix, retaining the recent tail.
/// On failure, rolls back all applied writes and records a git revert
/// commit so history matches the restored tree.
async fn archive_compact_prefix(
    conversation_mgr: &dyn ConversationManager,
    conversation_id: &str,
    retained: usize,
    active_content: &str,
    writes_applied: &[AppliedCompactionWrite],
    workspace_dir: &str,
    char_name: &str,
) -> Result<String, CompactionError> {
    let new_conversation_id = match conversation_mgr
        .archive_and_retain(
            conversation_id,
            RetentionParams {
                keep_last_n: retained,
                active_content: active_content.to_owned(),
            },
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            CompactionManager::rollback_compaction(writes_applied).await;
            // The model may have committed its writes before the archive
            // failed; record the restoration so git history matches the
            // tree instead of silently diverging. Best-effort.
            match crate::tools::workspace::git_commit_all(
                Path::new(workspace_dir),
                char_name,
                "revert: compaction rolled back after archive failure",
            )
            .await
            {
                Ok(true) => info!("compaction: recorded rollback commit"),
                Ok(false) => {}
                Err(git_err) => warn!(
                    error = %git_err,
                    "compaction: failed to record rollback commit"
                ),
            }
            return Err(e);
        }
    };
    Ok(new_conversation_id)
}

// ---------------------------------------------------------------------------
// Tool-loop helpers
// ---------------------------------------------------------------------------

/// In-progress state for the compaction tool loop. Accumulates the
/// successful writes (with previous content for rollback), rejected paths,
/// dry-run previews, and run-wide counters.
struct ToolLoopState {
    writes_applied: Vec<AppliedCompactionWrite>,
    rejected_paths: Vec<String>,
    tools_called: Vec<String>,
    dry_run_previews: Vec<MemoryFileOp>,
    tool_rounds: u32,
    max_rounds_hit: bool,
    dry_run: bool,
}

impl ToolLoopState {
    fn new(dry_run: bool) -> Self {
        Self {
            writes_applied: Vec::new(),
            rejected_paths: Vec::new(),
            tools_called: Vec::new(),
            dry_run_previews: Vec::new(),
            tool_rounds: 0,
            max_rounds_hit: false,
            dry_run,
        }
    }
}

/// Push the assistant's response onto the request so the next tool-loop
/// round sees it. Mirrors the dreaming pattern: prefer the SDK-shaped
/// content blocks, fall back to plain text when nothing structured is
/// available.
pub(crate) fn push_assistant_response(
    request: &mut crate::llm::types::LlmRequest,
    resp: &GenerateResponse,
) {
    let assistant_content: Vec<Value> = resp
        .content_blocks
        .iter()
        .filter_map(|block| {
            crate::content_util::content_block_to_request_json_for_sdk(block, &request.sdk)
        })
        .collect();

    if !assistant_content.is_empty() {
        request
            .messages
            .push(json!({"role": "assistant", "content": assistant_content}));
    } else if !resp.content.trim().is_empty() {
        request
            .messages
            .push(json!({"role": "assistant", "content": resp.content.clone()}));
    } else {
        // Empty assistant turn: nothing to append.
    }
}

/// Drive the compaction tool loop: alternately `generate()` and dispatch tool
/// calls until the model ends cleanly or the round budget is hit, accumulating
/// applied/rejected writes and forensics into the returned [`ToolLoopState`].
async fn run_compaction_tool_loop(
    llm: &dyn CompactionLlm,
    request: &mut crate::llm::types::LlmRequest,
    tool_ctx: &dyn ToolContext,
    workspace_dir: &str,
    max_tool_iterations: Option<u32>,
    dry_run: bool,
) -> Result<ToolLoopState, CompactionError> {
    let mut loop_state = ToolLoopState::new(dry_run);

    loop {
        let resp = llm.generate(request).await?;
        push_assistant_response(request, &resp);

        let tool_uses = crate::content_util::extract_tool_uses(&resp.content_blocks);
        if tool_uses.is_empty() || resp.finish_reason != "tool_use" {
            // Model ended cleanly.
            break;
        }

        loop_state.tool_rounds = loop_state.tool_rounds.saturating_add(1);
        let mut tool_results = Vec::with_capacity(tool_uses.len());
        for (id, name, input) in tool_uses {
            loop_state.tools_called.push(name.clone());
            let (output, is_error) =
                dispatch_compaction_tool(&name, &input, tool_ctx, workspace_dir, &mut loop_state)
                    .await;
            tool_results.push(crate::content_util::build_tool_result_json(
                &id, &output, is_error,
            ));
        }
        request
            .messages
            .push(json!({"role": "user", "content": tool_results}));

        // `None` = unlimited: keep going until the model ends cleanly above.
        if let Some(max) = max_tool_iterations {
            if loop_state.tool_rounds >= max {
                loop_state.max_rounds_hit = true;
                break;
            }
        }
    }

    Ok(loop_state)
}

/// Queue a MEMORY.md prompt refresh when the compaction wrote the memory index
/// but the tool context did not already `defer_edit` it (e.g. test stubs).
/// Push the workspace memory history after a successful compaction, when
/// `[memory] git_push` is enabled. No-op for non-`Compacted` outcomes;
/// best-effort (a failed push never fails the pass). Shared by the background
/// and manual compaction paths.
pub(crate) async fn push_after_compaction(
    config: &shore_common::config::LoadedConfig,
    character: &str,
    outcome: &CompactionOutcome,
) {
    if config.app.memory.git_push && matches!(outcome, CompactionOutcome::Compacted(_)) {
        let workspace =
            shore_common::config::character_workspace_dir(&config.dirs.config, character);
        crate::tools::workspace::git_push_workspace_best_effort(
            &workspace,
            character,
            "compaction",
        )
        .await;
    }
}

fn queue_memory_index_refresh(
    memory_index_updated: bool,
    tool_ctx: &dyn ToolContext,
    data_dir: Option<&Path>,
    char_name: &str,
) {
    // dispatch_tool already calls `defer_edit` on prompt-visible writes
    // via `SharedToolContext`, so MEMORY.md is queued for refresh
    // automatically. The explicit fallback below covers tool contexts
    // that omit `defer_edit` (e.g. test stubs) so the queue stays
    // consistent with the previous behaviour.
    if memory_index_updated && tool_ctx.config_dir().is_empty() {
        if let Some(dir) = data_dir {
            if let Err(e) = crate::memory::deferred_edits::note_memory_index_deferred(
                &character_data_dir(dir, char_name),
            ) {
                warn!(
                    error = %e,
                    "compaction: failed to queue MEMORY.md prompt refresh"
                );
            }
        } else {
            warn!(
                "compaction: MEMORY.md updated but data_dir was unavailable for prompt refresh queue"
            );
        }
    }
}

/// Append a compaction entry to the character's dreams log summarising the
/// archived turns and updated memory files.
async fn append_compaction_dream_log(
    data_dir: Option<&Path>,
    char_name: &str,
    conversation_id: &str,
    compacted_turns: usize,
    markdown_paths: &[String],
) {
    let dream_body = format!(
        "Compacted {} turns from `{conversation_id}`.\n\nUpdated memory files:\n{}",
        compacted_turns,
        markdown_paths
            .iter()
            .map(|path| format!("- `{path}`"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    if let Some(dir) = data_dir {
        if let Err(e) = crate::memory::dreams_log::append_dream_entry(
            dir,
            char_name,
            chrono::Local::now().fixed_offset(),
            "compaction",
            &dream_body,
        )
        .await
        {
            warn!(error = %e, "compaction: failed to append dreams log entry");
        }
    }
}

/// Extract the model's intended path (and whole-file content, if the call
/// carries any) from a tool input value. Returns `None` if the input is
/// malformed; the dispatch wrapper surfaces that as a tool error.
///
/// Only `edit`'s `content` form names the resulting file outright. Its `edits`
/// form describes replacements against the file on disk, so a dry run — which
/// by definition hasn't applied them — can preview the path but not the result.
fn extract_memory_write_intent(input: &Value) -> Option<(String, Option<String>)> {
    let path = input.get("path").and_then(|v| v.as_str())?.to_owned();
    let content = input
        .get("content")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    Some((path, content))
}

/// Dispatch a single tool call from the compaction tool loop. Wraps the
/// canonical `tool_system::dispatch_tool`:
///
/// * `delete` is always blocked from compaction. `git` is allowed so the pass
///   can commit its memory writes; the tool is git-only by construction, so
///   compaction no longer has to inspect a command line to know that.
/// * In dry-run mode, `edit` is blocked but the intended path is still
///   recorded in `dry_run_previews` for the returned outcome.
/// * For a live `edit`, the compaction path filter
///   ([`CompactionManager::write_allowed_path`]) rejects writes outside
///   `memory/*` and the workspace-root prompt files, and the resolved
///   file's previous content is snapshotted so a downstream archive
///   failure can roll the writes back.
async fn dispatch_compaction_tool(
    name: &str,
    input: &Value,
    tool_ctx: &dyn ToolContext,
    workspace_dir: &str,
    state: &mut ToolLoopState,
) -> (String, bool) {
    // Always-blocked tools.
    if name == "delete" {
        return (format!("{name} is not available during compaction"), true);
    }
    if name == "git" && state.dry_run {
        return (
            "git blocked: dry-run compaction does not run commands".to_owned(),
            true,
        );
    }

    let is_write_like = name == "edit";

    // Dry-run mode blocks writes but records the intent so the manager
    // can return a useful preview.
    if state.dry_run && is_write_like {
        if let Some((path, content)) = extract_memory_write_intent(input) {
            if CompactionManager::write_allowed_path(&path) {
                state.dry_run_previews.push(MemoryFileOp {
                    path,
                    content: content.unwrap_or_else(|| {
                        format!("<{name}: in-place edits, no preview available>")
                    }),
                });
            } else {
                state.rejected_paths.push(path);
            }
        }
        return (
            format!("{name} blocked: dry-run compaction does not modify files"),
            true,
        );
    }

    if is_write_like {
        let Some((display_path, _)) = extract_memory_write_intent(input) else {
            return (
                format!("{name} blocked: missing required 'path' field"),
                true,
            );
        };
        if !CompactionManager::write_allowed_path(&display_path) {
            warn!(
                path = %display_path,
                tool = name,
                "compaction: refusing to write disallowed path"
            );
            state.rejected_paths.push(display_path.clone());
            return (
                format!(
                    "{name} blocked: compaction may only write under memory/* or to the workspace-root prompt files (MEMORY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md) (got: {display_path})"
                ),
                true,
            );
        }

        // Resolve display path to disk so we can snapshot previous
        // content for rollback. Errors here mean the path was malformed
        // (traversal attempt, symlink escape, etc.) — surface to the
        // model as a tool error and record as rejected.
        let resolved = match crate::tools::workspace::resolve_path(workspace_dir, &display_path) {
            Ok(p) => p,
            Err(e) => {
                state.rejected_paths.push(display_path.clone());
                return (format!("{name} blocked: {e}"), true);
            }
        };
        let previous_content = match tokio::fs::read_to_string(&resolved).await {
            Ok(c) => Some(c),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return (format!("{name} failed to read existing file: {e}"), true);
            }
        };

        let result = tool_system::dispatch_tool(name, input.clone(), tool_ctx).await;
        let (output, is_error) = crate::content_util::dispatch_result_to_output(result);
        if !is_error {
            let memory_index_target =
                crate::memory::deferred_edits::normalize_prompt_visible_path(&display_path)
                    .as_deref()
                    == Some(crate::memory::deferred_edits::MEMORY_INDEX_DEFERRED_PATH);
            state.writes_applied.push(AppliedCompactionWrite {
                display_path,
                resolved_path: resolved,
                previous_content,
                memory_index_target,
            });
        }
        return (output, is_error);
    }

    // Read-only and miscellaneous tools pass through unchanged.
    crate::content_util::dispatch_result_to_output(
        tool_system::dispatch_tool(name, input.clone(), tool_ctx).await,
    )
}

// ---------------------------------------------------------------------------
// IdleTimer
// ---------------------------------------------------------------------------

/// A timer that waits for an idle period to elapse without activity.
/// Activity notifications (via `CompactionManager::notify_activity`) reset it.
#[derive(Debug)]
pub struct IdleTimer {
    idle_duration: Duration,
    activity_notify: Arc<Notify>,
}

impl IdleTimer {
    /// Wait until the full idle period elapses without any activity.
    /// Returns when compaction should be triggered.
    pub async fn wait_for_idle(&self) {
        loop {
            tokio::select! {
                () = tokio::time::sleep(self.idle_duration) => {
                    debug!("Idle period elapsed, compaction ready");
                    return;
                }
                () = self.activity_notify.notified() => {
                    // Activity detected — reset timer by restarting loop.
                    debug!("Idle timer reset by activity");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Local;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::oneshot;

    /// Whether a `git` binary is on PATH. Git-history behavior is best-effort
    /// without git, so tests that shell out skip cleanly on minimal hosts.
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    #[test]
    fn compaction_run_guard_serializes_per_character_data_root() {
        let data_dir = PathBuf::from(format!("/guard-data-{}", uuid::Uuid::new_v4()));
        let other_data_dir = PathBuf::from(format!("/guard-data-{}", uuid::Uuid::new_v4()));
        let character = "TestChar";
        let other_character = "OtherChar";

        let first = try_begin_compaction(&data_dir, character).expect("first guard should acquire");
        assert!(
            try_begin_compaction(&data_dir, character).is_none(),
            "second guard for same character data root must be rejected"
        );
        assert!(
            try_begin_compaction(&data_dir, other_character).is_some(),
            "different characters in one data dir may compact independently"
        );
        assert!(
            try_begin_compaction(&other_data_dir, character).is_some(),
            "same character name in another data dir may compact independently"
        );

        drop(first);
        assert!(
            try_begin_compaction(&data_dir, character).is_some(),
            "guard should release when dropped"
        );
    }

    // -- Test helpers --------------------------------------------------------

    use crate::llm::types::{LlmRequest, Timing, Usage};
    use shore_common::protocol::types::ContentBlock;

    fn make_messages(count: usize) -> Vec<ConversationMessage> {
        (0..count)
            .map(|i| ConversationMessage {
                role: if i % 2 == 0 {
                    "user".to_owned()
                } else {
                    "assistant".to_owned()
                },
                content: format!("Message {i}"),
                timestamp: Local::now().to_rfc3339(),
                is_tool_result_only: false,
                is_autonomous: false,
            })
            .collect()
    }

    fn make_config_with_keep(keep_recent_turns: usize) -> CompactionConfig {
        CompactionConfig {
            keep_recent_turns,
            ..Default::default()
        }
    }

    /// Build a synthetic chat-shape `LlmRequest` for tests. Mirrors what
    /// `handler::build_chat_shape_request_from_disk` would have produced
    /// for the same conversation — we don't go through the full disk path
    /// in unit tests, we just hand the compaction code a representative
    /// stub so it has the chat prefix to extend.
    fn make_chat_request(messages: &[ConversationMessage]) -> LlmRequest {
        let llm_messages: Vec<Value> = messages
            .iter()
            .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
            .collect();
        LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "mock-chat-model".into(),
            api_key: String::new(),
            api_key_name: None,
            base_url: None,
            messages: llm_messages,
            system: Some(serde_json::json!("mock chat system")),
            tools: Some(Vec::new()),
            max_tokens: 1024,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        }
    }

    /// Build a single tool-use round that calls `edit` in whole-file mode once
    /// per `(path, content)` pair, then ends the loop with `end_turn`.
    fn tool_use_round(entries: &[(&str, &str)]) -> GenerateResponse {
        let blocks = entries
            .iter()
            .enumerate()
            .map(|(i, (path, content))| ContentBlock::ToolUse {
                id: format!("call_{i}"),
                name: "edit".into(),
                input: json!({
                    "path": path,
                    "content": content,
                }),
            })
            .collect();
        GenerateResponse {
            content: String::new(),
            content_blocks: blocks,
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            model: "mock".into(),
        }
    }

    fn end_turn(text: &str) -> GenerateResponse {
        GenerateResponse {
            content: text.into(),
            content_blocks: if text.is_empty() {
                Vec::new()
            } else {
                vec![ContentBlock::Text { text: text.into() }]
            },
            finish_reason: "end_turn".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            model: "mock".into(),
        }
    }

    /// Read-only tool-use round (a bare `read`, which lists the workspace
    /// root) used to exercise the no-memory-writes path: the model engaged
    /// tools but never persisted anything.
    fn read_only_round() -> GenerateResponse {
        GenerateResponse {
            content: String::new(),
            content_blocks: vec![ContentBlock::ToolUse {
                id: "call_ro".into(),
                name: "read".into(),
                input: json!({}),
            }],
            finish_reason: "tool_use".into(),
            usage: Usage::default(),
            timing: Timing::default(),
            model: "mock".into(),
        }
    }

    // -- Mock LLM ------------------------------------------------------------

    /// Scripted `CompactionLlm`: each `generate` call pops the next
    /// canned response. Captures the initial-request shape so cache-path
    /// invariants can be asserted.
    struct ScriptedLlm {
        responses: StdMutex<Vec<GenerateResponse>>,
        /// Number of messages in the built request, including the appended
        /// compact-now tail. Equals `chat_request.messages.len() + 1`.
        captured_built_message_count: StdMutex<Option<usize>>,
        /// Number of messages in the chat prefix the caller passed in.
        captured_chat_prefix_len: StdMutex<Option<usize>>,
        captured_last_user_text: StdMutex<Option<String>>,
    }

    impl ScriptedLlm {
        fn new(responses: Vec<GenerateResponse>) -> Self {
            Self {
                responses: StdMutex::new(responses),
                captured_built_message_count: StdMutex::new(None),
                captured_chat_prefix_len: StdMutex::new(None),
                captured_last_user_text: StdMutex::new(None),
            }
        }

        fn writing(entries: &[(&str, &str)]) -> Self {
            Self::new(vec![tool_use_round(entries), end_turn("done")])
        }

        fn last_user_text(&self) -> Option<String> {
            self.captured_last_user_text.lock().unwrap().clone()
        }

        fn built_message_count(&self) -> Option<usize> {
            *self.captured_built_message_count.lock().unwrap()
        }

        fn chat_prefix_len(&self) -> Option<usize> {
            *self.captured_chat_prefix_len.lock().unwrap()
        }
    }

    impl CompactionLlm for ScriptedLlm {
        fn build_initial_request(
            &self,
            system: &str,
            compact_now_user: Value,
            chat_request: LlmRequest,
        ) -> Result<LlmRequest, CompactionError> {
            // Tests now always pass a chat-shape request — there's no
            // fresh-vs-cached branching in the production code either.
            // We capture the chat prefix size for assertions and extend
            // with the single compact-now user turn.
            *self
                .captured_chat_prefix_len
                .lock()
                .map_err(|_| CompactionError::Llm("scripted LLM state mutex poisoned".into()))? =
                Some(chat_request.messages.len());
            *self
                .captured_built_message_count
                .lock()
                .map_err(|_| CompactionError::Llm("scripted LLM state mutex poisoned".into()))? =
                Some(chat_request.messages.len() + 1);
            *self
                .captured_last_user_text
                .lock()
                .map_err(|_| CompactionError::Llm("scripted LLM state mutex poisoned".into()))? =
                compact_now_user
                    .get("content")
                    .and_then(|c| c.as_str())
                    .map(str::to_owned);
            let mut combined = chat_request.messages.clone();
            combined.push(compact_now_user);
            let mut request = LlmRequest {
                sdk: chat_request.sdk,
                model: chat_request.model,
                api_key: chat_request.api_key,
                api_key_name: chat_request.api_key_name,
                base_url: chat_request.base_url,
                messages: combined,
                system: chat_request.system,
                tools: chat_request.tools,
                max_tokens: chat_request.max_tokens,
                temperature: chat_request.temperature,
                top_p: chat_request.top_p,
                provider_options: chat_request.provider_options,
                provider_key: chat_request.provider_key,
                rid: None,
                forensic_character: None,
                retain_long: true,
                keepalive_interval: None,
            };
            // Mirror production: the compaction instruction is pinned at a
            // fixed inline `role:"system"` slot, never the moving tail.
            request.push_inline_system(system);
            Ok(request)
        }

        fn generate<'src>(
            &'src self,
            _request: &'src mut LlmRequest,
        ) -> Pin<Box<dyn Future<Output = Result<GenerateResponse, CompactionError>> + Send + 'src>>
        {
            let next = {
                let mut guard = self.responses.lock().unwrap();
                if guard.is_empty() {
                    None
                } else {
                    Some(guard.remove(0))
                }
            };
            Box::pin(async move {
                next.ok_or_else(|| CompactionError::Llm("scripted LLM exhausted".into()))
            })
        }
    }

    // -- Conversation manager mocks ------------------------------------------

    struct MockConversationMgr {
        archived: StdMutex<Vec<(String, usize)>>,
        next_id: String,
    }

    impl MockConversationMgr {
        fn new(next_id: &str) -> Self {
            Self {
                archived: StdMutex::new(Vec::new()),
                next_id: next_id.to_owned(),
            }
        }

        fn archived_calls(&self) -> Vec<(String, usize)> {
            self.archived.lock().unwrap().clone()
        }
    }

    impl ConversationManager for MockConversationMgr {
        fn archive_and_retain(
            &self,
            conversation_id: &str,
            params: RetentionParams,
        ) -> Pin<Box<dyn Future<Output = Result<String, CompactionError>> + Send + '_>> {
            self.archived
                .lock()
                .unwrap()
                .push((conversation_id.to_owned(), params.keep_last_n));
            let next_id = self.next_id.clone();
            Box::pin(async move { Ok(next_id) })
        }
    }

    struct BlockingConversationMgr {
        entered_tx: StdMutex<Option<oneshot::Sender<()>>>,
        release_rx: StdMutex<Option<mpsc::Receiver<()>>>,
        next_id: String,
    }

    impl BlockingConversationMgr {
        fn new(next_id: &str) -> (Self, oneshot::Receiver<()>, mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = oneshot::channel();
            let (release_tx, release_rx) = mpsc::channel();
            (
                Self {
                    entered_tx: StdMutex::new(Some(entered_tx)),
                    release_rx: StdMutex::new(Some(release_rx)),
                    next_id: next_id.to_owned(),
                },
                entered_rx,
                release_tx,
            )
        }
    }

    impl ConversationManager for BlockingConversationMgr {
        fn archive_and_retain(
            &self,
            _conversation_id: &str,
            _params: RetentionParams,
        ) -> Pin<Box<dyn Future<Output = Result<String, CompactionError>> + Send + '_>> {
            let entered_tx = self.entered_tx.lock().unwrap().take();
            let release_rx = self
                .release_rx
                .lock()
                .unwrap()
                .take()
                .expect("test setup should install a release receiver");
            let next_id = self.next_id.clone();

            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    if let Some(tx) = entered_tx {
                        let _ignored = tx.send(());
                    }
                    release_rx.recv().map_err(|_| {
                        CompactionError::ConversationManager(
                            "test release signal dropped before archive completed".to_owned(),
                        )
                    })?;
                    Ok(next_id)
                })
                .await
                .map_err(|err| {
                    CompactionError::ConversationManager(format!(
                        "blocking archive task failed: {err}"
                    ))
                })?
            })
        }
    }

    struct FailingConversationMgr;

    impl ConversationManager for FailingConversationMgr {
        fn archive_and_retain(
            &self,
            _conversation_id: &str,
            _params: RetentionParams,
        ) -> Pin<Box<dyn Future<Output = Result<String, CompactionError>> + Send + '_>> {
            Box::pin(async {
                Err(CompactionError::ConversationManager(
                    "simulated archive failure".to_owned(),
                ))
            })
        }
    }

    // -- Local tool context --------------------------------------------------

    /// Minimal `ToolContext` for unit tests. Tool dispatch only needs
    /// `workspace_dir` populated for `write`/`edit` path resolution; the
    /// rest fall back to the trait's defaults.
    struct TestCtx {
        workspace_dir: String,
        retrieval_config: shore_common::config::app::RetrievalConfig,
        search_config: shore_common::config::app::SearchConfig,
    }

    impl TestCtx {
        fn new(workspace_dir: String) -> Self {
            Self {
                workspace_dir,
                retrieval_config: shore_common::config::app::RetrievalConfig::default(),
                search_config: shore_common::config::app::SearchConfig::default(),
            }
        }
    }

    impl ToolContext for TestCtx {
        fn image_dir(&self) -> &'static str {
            ""
        }
        fn llm_client(&self) -> Option<&crate::llm::LlmClient> {
            None
        }
        fn image_gen_config(&self) -> Option<&crate::memory::compaction_impls::ImageGenConfig> {
            None
        }
        fn search_config(&self) -> &shore_common::config::app::SearchConfig {
            &self.search_config
        }
        fn workspace_dir(&self) -> &str {
            &self.workspace_dir
        }
        fn memory_retrieval_config(&self) -> &shore_common::config::app::RetrievalConfig {
            &self.retrieval_config
        }
    }

    // -- Tests: prompt building ----------------------------------------------

    #[test]
    fn test_build_prompt_no_recap() {
        let messages = vec![
            ConversationMessage {
                role: "user".to_owned(),
                content: "Hello!".to_owned(),
                timestamp: "2026-03-25T10:00:00Z".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "assistant".to_owned(),
                content: "Hi there!".to_owned(),
                timestamp: "2026-03-25T10:00:01Z".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
        ];

        let prompt = CompactionManager::build_prompt(
            "Template:\n{{conversation}}",
            &messages,
            "Char",
            "User",
        );
        assert!(prompt.contains("[2026-03-25T10:00:00Z] user: Hello!"));
        assert!(prompt.contains("[2026-03-25T10:00:01Z] assistant: Hi there!"));
        assert!(!prompt.contains("{{conversation}}"));
    }

    #[test]
    fn test_build_prompt_strips_legacy_recap_block() {
        let messages = make_messages(2);
        let template = "Before\n{{#if recap}}RECAP: {{recap}}{{/if}}\nAfter\n{{conversation}}";

        let prompt = CompactionManager::build_prompt(template, &messages, "Char", "User");
        assert!(!prompt.contains("RECAP"));
        assert!(!prompt.contains("{{#if recap}}"));
        assert!(!prompt.contains("{{/if}}"));
        assert!(prompt.contains("Before"));
        assert!(prompt.contains("After"));
    }

    // -- Tests: helper methods -----------------------------------------------

    #[test]
    fn test_write_allowed_path_accepts_memory_and_index() {
        assert!(CompactionManager::write_allowed_path("MEMORY.md"));
        assert!(CompactionManager::write_allowed_path("./MEMORY.md"));
        assert!(CompactionManager::write_allowed_path(
            "memory/daily/2026-03-25.md"
        ));
        assert!(CompactionManager::write_allowed_path(
            "memory/preferences/tea.md"
        ));
    }

    #[test]
    fn test_write_allowed_path_accepts_root_prompt_files() {
        assert!(CompactionManager::write_allowed_path("SOUL.md"));
        assert!(CompactionManager::write_allowed_path("USER.md"));
        assert!(CompactionManager::write_allowed_path("AGENTS.md"));
        assert!(CompactionManager::write_allowed_path("TOOLS.md"));
        assert!(CompactionManager::write_allowed_path("workspace/SOUL.md"));
        assert!(CompactionManager::write_allowed_path("./USER.md"));
    }

    #[test]
    fn test_write_allowed_path_rejects_retired_heartbeat_file() {
        // HEARTBEAT.md is no longer a prompt file: carry-forward notes belong in
        // MEMORY.md. A leftover copy in an existing workspace is an ordinary
        // file, and compaction has no business writing to it.
        assert!(!CompactionManager::write_allowed_path("HEARTBEAT.md"));
    }

    #[test]
    fn test_write_allowed_path_rejects_traversal_and_absolute() {
        // `..` escapes that would otherwise satisfy the memory/ prefix.
        assert!(!CompactionManager::write_allowed_path(
            "memory/../../SOUL.md"
        ));
        assert!(!CompactionManager::write_allowed_path("memory/../USER.md"));
        assert!(!CompactionManager::write_allowed_path("../SOUL.md"));
        assert!(!CompactionManager::write_allowed_path(
            "memory/sub/../../escape.md"
        ));
        // Backslash-normalized traversal.
        assert!(!CompactionManager::write_allowed_path(
            "memory\\..\\..\\SOUL.md"
        ));
        // Absolute paths.
        assert!(!CompactionManager::write_allowed_path("/etc/passwd"));
        assert!(!CompactionManager::write_allowed_path("/SOUL.md"));
    }

    #[test]
    fn test_write_allowed_path_rejects_outside_memory() {
        assert!(!CompactionManager::write_allowed_path("DREAMS.md"));
        assert!(!CompactionManager::write_allowed_path("notes.md"));
        assert!(!CompactionManager::write_allowed_path("topics/foo.md"));
        assert!(!CompactionManager::write_allowed_path("memory/dreams.md"));
        assert!(!CompactionManager::write_allowed_path("memory/"));
    }

    #[test]
    fn test_should_force_compact() {
        let mgr = CompactionManager::new(CompactionConfig {
            max_turns: 60,
            min_turns: 20,
            keep_recent_turns: 2,
            ..Default::default()
        });

        assert!(!mgr.should_force_compact(0));
        assert!(!mgr.should_force_compact(19));
        assert!(!mgr.should_force_compact(59));
        assert!(mgr.should_force_compact(60));
        assert!(mgr.should_force_compact(100));
    }

    #[test]
    fn test_should_force_compact_disabled() {
        let mgr = CompactionManager::new(CompactionConfig {
            max_turns: 0,
            ..Default::default()
        });
        assert!(!mgr.should_force_compact(1000));
    }

    #[test]
    fn test_has_enough_turns() {
        let mgr = CompactionManager::new(CompactionConfig {
            min_turns: 20,
            keep_recent_turns: 2,
            ..Default::default()
        });

        assert!(!mgr.has_enough_turns(0));
        assert!(!mgr.has_enough_turns(19));
        assert!(mgr.has_enough_turns(20));
        assert!(mgr.has_enough_turns(100));
    }

    // -- Tests: find_turn_split with tool-result messages --------------------

    #[test]
    fn test_find_turn_split_skips_tool_result_messages() {
        let messages = vec![
            ConversationMessage {
                role: "user".to_owned(),
                content: "Hello".to_owned(),
                timestamp: "t0".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "assistant".to_owned(),
                content: String::new(),
                timestamp: "t1".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "user".to_owned(),
                content: "tool output here".to_owned(),
                timestamp: "t2".to_owned(),
                is_tool_result_only: true,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "assistant".to_owned(),
                content: "Based on the tool result...".to_owned(),
                timestamp: "t3".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "user".to_owned(),
                content: "Thanks!".to_owned(),
                timestamp: "t4".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "assistant".to_owned(),
                content: "You're welcome!".to_owned(),
                timestamp: "t5".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
        ];

        assert_eq!(CompactionManager::find_turn_split(&messages, 1), 4);
        assert_eq!(CompactionManager::find_turn_split(&messages, 2), 0);
    }

    #[test]
    fn test_find_turn_split_keep_zero_returns_full_length() {
        let all_user = vec![
            ConversationMessage {
                role: "user".to_owned(),
                content: "a".to_owned(),
                timestamp: "t0".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "user".to_owned(),
                content: "b".to_owned(),
                timestamp: "t1".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
        ];
        assert_eq!(CompactionManager::find_turn_split(&all_user, 0), 2);

        let empty: Vec<ConversationMessage> = vec![];
        assert_eq!(CompactionManager::find_turn_split(&empty, 0), 0);
    }

    #[test]
    fn test_find_turn_split_all_tool_results_returns_zero() {
        let messages = vec![
            ConversationMessage {
                role: "user".to_owned(),
                content: "tool output".to_owned(),
                timestamp: "t0".to_owned(),
                is_tool_result_only: true,
                is_autonomous: false,
            },
            ConversationMessage {
                role: "assistant".to_owned(),
                content: "response".to_owned(),
                timestamp: "t1".to_owned(),
                is_tool_result_only: false,
                is_autonomous: false,
            },
        ];

        assert_eq!(CompactionManager::find_turn_split(&messages, 1), 0);
    }

    // -- Tests: compaction tool loop ----------------------------------------

    #[tokio::test]
    async fn test_tool_loop_writes_memory_files_and_archives() {
        // Tool-use response with two valid writes drives one archive +
        // memory-files-written outcome.
        let llm = ScriptedLlm::writing(&[
            (
                "memory/daily/2026-03-25.md",
                "# Daily\n- discussed their day",
            ),
            (
                "memory/preferences/beverages.md",
                "# Beverages\n- tea over coffee",
            ),
        ]);
        let conv_mgr = MockConversationMgr::new("new-conv-1");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let data_dir = tmp.path().join("data");
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-1",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                Some(&data_dir),
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.memory_files_written.len(), 2);
                assert_eq!(r.new_conversation_id, "new-conv-1");
                assert_eq!(r.compacted_turns, 3);
                assert_eq!(r.retained_count, 4);
                assert_eq!(r.retained_turns, 2);
                assert_eq!(r.tool_rounds, 1);
                assert!(r.tools_called.iter().all(|n| n == "edit"));
            }


        );

        assert!(store.read("daily/2026-03-25.md").await.is_ok());
        assert!(store.read("preferences/beverages.md").await.is_ok());
        let dreams = crate::memory::dreams_log::read_dreams_log(&data_dir, "TestChar")
            .await
            .unwrap()
            .expect("dreams log should be written by compaction");
        assert!(dreams.contains("Compacted 3 turns"));
    }

    #[tokio::test]
    async fn test_tool_loop_no_writes_returns_no_memory_writes() {
        // Issue #43: the model responds with only read-only tool calls
        // and never persists anything. The active conversation must NOT
        // be archived.
        let llm = ScriptedLlm::new(vec![
            read_only_round(),
            end_turn("nothing to remember today"),
        ]);
        let conv_mgr = MockConversationMgr::new("must-not-be-used");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let data_dir = tmp.path().join("data");
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-no-writes",
                &make_messages(10),
                "active content untouched",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                Some(&data_dir),
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::NoMemoryWrites(r) => {
                assert_eq!(r.conversation_id, "conv-no-writes");
                assert!(r.tool_rounds >= 1);
                assert!(r.rejected_paths.is_empty());
                assert!(!r.max_rounds_hit);
                assert!(r.tools_called.iter().any(|n| n == "read"));
            }


        );

        // archive_and_retain must not have been called.
        assert!(
            conv_mgr.archived_calls().is_empty(),
            "active conversation must not be archived on zero-writes outcome"
        );
    }

    #[tokio::test]
    async fn test_tool_loop_disallowed_paths_do_not_count_as_writes() {
        // The model attempts to write daemon-owned or out-of-scope paths
        // only. None of them should count toward "writes_applied", so the
        // outcome is NoMemoryWrites with `rejected_paths` populated.
        let llm = ScriptedLlm::new(vec![
            tool_use_round(&[
                ("DREAMS.md", "should be blocked"),
                ("notes.md", "should be blocked"),
                ("memory/dreaming/log.md", "should be blocked"),
                ("memory/.dreams/notes.md", "should be blocked"),
                ("topics/foo.md", "missing memory/ prefix"),
            ]),
            end_turn("done"),
        ]);
        let conv_mgr = MockConversationMgr::new("must-not-be-used");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-rejected",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::NoMemoryWrites(r) => {
                assert_eq!(r.rejected_paths.len(), 5);
                assert!(r.rejected_paths.iter().any(|p| p == "DREAMS.md"));
                assert!(r.rejected_paths.iter().any(|p| p == "notes.md"));
                assert!(r
                    .rejected_paths
                    .iter()
                    .any(|p| p == "memory/.dreams/notes.md"));
            }


        );

        assert!(
            conv_mgr.archived_calls().is_empty(),
            "rejected writes must not trigger archive"
        );
        // No blocked files were touched.
        assert!(!tmp.path().join("DREAMS.md").exists());
        assert!(!tmp.path().join("notes.md").exists());
    }

    #[tokio::test]
    async fn test_dispatch_allows_git_but_not_in_dry_run() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_string_lossy().into_owned();
        let ctx = TestCtx::new(ws.clone());

        // Dry run runs no commands at all, git included.
        let mut dry_state = ToolLoopState::new(true);
        let (dry_msg, dry_is_error) = dispatch_compaction_tool(
            "git",
            &json!({"subcommand": "status"}),
            &ctx,
            &ws,
            &mut dry_state,
        )
        .await;
        assert!(dry_is_error);
        assert!(dry_msg.contains("dry-run"));

        // Live git reaches the real handler.
        let mut state = ToolLoopState::new(false);
        let _created = crate::tools::workspace::ensure_workspace_git_repo(tmp.path(), "test")
            .await
            .unwrap();
        let (out, is_error) = dispatch_compaction_tool(
            "git",
            &json!({"subcommand": "status"}),
            &ctx,
            &ws,
            &mut state,
        )
        .await;
        assert!(!is_error, "git should dispatch: {out}");
        assert!(out.contains("\"exit_code\""));

        // Git calls never count as memory writes.
        assert!(state.writes_applied.is_empty());
    }

    /// `delete` stays blocked, and the tools that used to need argv-sniffing
    /// to keep out of compaction are simply gone from the surface.
    #[tokio::test]
    async fn test_dispatch_blocks_delete_and_retired_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().to_string_lossy().into_owned();
        let ctx = TestCtx::new(ws.clone());
        let mut state = ToolLoopState::new(false);

        let (msg, is_error) = dispatch_compaction_tool(
            "delete",
            &json!({"path": "memory/x.md"}),
            &ctx,
            &ws,
            &mut state,
        )
        .await;
        assert!(is_error);
        assert!(msg.contains("not available during compaction"));

        let (exec_msg, exec_is_error) =
            dispatch_compaction_tool("exec", &json!({"command": "ls -la"}), &ctx, &ws, &mut state)
                .await;
        assert!(exec_is_error, "exec must not dispatch: {exec_msg}");
    }

    #[tokio::test]
    async fn test_tool_loop_mixed_writes_only_allowed_paths_count() {
        // A mix of allowed + rejected writes: the allowed ones should
        // archive normally and the rejected ones should land on
        // rejected_paths but still let the loop proceed.
        let llm = ScriptedLlm::new(vec![
            tool_use_round(&[
                ("MEMORY.md", "# Memory Index\n\n## Throughline\n- ongoing"),
                ("SOUL.md", "# Soul\n\n- root prompt files are writable"),
                ("DREAMS.md", "blocked"),
                ("memory/notes/ok.md", "# OK\n- accepted"),
            ]),
            end_turn("done"),
        ]);
        let conv_mgr = MockConversationMgr::new("new-conv-mixed");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let data_dir = tmp.path().join("data");
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let outcome = mgr
            .compact(
                "conv-mixed",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                Some(&data_dir),
                &ctx,
                None,
            )
            .await
            .unwrap();

        let result = assert_variant!(
            outcome,
            CompactionOutcome::Compacted(r) => r,
        );
        assert_eq!(result.memory_files_written.len(), 3);
        assert!(result.memory_files_written.iter().any(|p| p == "MEMORY.md"));
        assert!(result.memory_files_written.iter().any(|p| p == "SOUL.md"));
        assert!(result
            .memory_files_written
            .iter()
            .any(|p| p == "memory/notes/ok.md"));

        // MEMORY.md and SOUL.md land at the workspace root,
        // memory/notes/ok.md inside memory/. DREAMS.md stays blocked.
        let mem = std::fs::read_to_string(tmp.path().join("MEMORY.md")).unwrap();
        assert!(mem.contains("Throughline"));
        let soul = std::fs::read_to_string(tmp.path().join("SOUL.md")).unwrap();
        assert!(soul.contains("writable"));
        assert!(store.read("notes/ok.md").await.is_ok());
        assert!(!tmp.path().join("DREAMS.md").exists());
    }

    #[tokio::test]
    async fn test_tool_loop_dry_run_blocks_writes_but_records_preview() {
        // Dry-run mode must surface the would-write paths in the
        // preview without actually creating any files and without
        // archiving.
        let llm = ScriptedLlm::new(vec![
            tool_use_round(&[
                ("memory/notes/preview.md", "# Preview\n- never written"),
                ("MEMORY.md", "# Preview index"),
            ]),
            end_turn("dry-run done"),
        ]);
        let conv_mgr = MockConversationMgr::new("must-not-be-used");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-dry",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                true,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::DryRun(r) => {
                assert_eq!(r.would_write_files, 2);
                assert_eq!(r.file_ops_preview.len(), 2);
                assert!(r
                    .file_ops_preview
                    .iter()
                    .any(|op| op.path == "memory/notes/preview.md"));
                assert!(r.tool_rounds >= 1);
            }


        );

        assert!(store.read("notes/preview.md").await.is_err());
        assert!(!tmp.path().join("MEMORY.md").exists());
        assert!(conv_mgr.archived_calls().is_empty());
    }

    #[tokio::test]
    async fn test_compact_archives_with_retention() {
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# X\n- a note")]);
        let conv_mgr = MockConversationMgr::new("new-conv-2");
        let mgr = CompactionManager::new(make_config_with_keep(3));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "old-conv",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.new_conversation_id, "new-conv-2");
                assert_eq!(r.retained_count, 6);
            }


        );

        let calls = conv_mgr.archived_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "old-conv");
        assert_eq!(calls[0].1, 6);
    }

    #[tokio::test]
    async fn test_compact_with_keep_turns_zero_retains_nothing() {
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# x")]);
        let conv_mgr = MockConversationMgr::new("new-conv-zero");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-1",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                Some(0),
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.message_count, 10);
                assert_eq!(r.compacted_turns, 5);
                assert_eq!(r.retained_count, 0);
                assert_eq!(r.retained_turns, 0);
                assert_eq!(r.memory_files_written.len(), 1);
            }


        );
    }

    #[tokio::test]
    async fn test_compact_keep_turns_override_beats_config() {
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# x")]);
        let conv_mgr = MockConversationMgr::new("new-conv-override");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-1",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                Some(3),
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.retained_count, 6);
                assert_eq!(r.retained_turns, 3);
            }


        );
    }

    fn autonomous_msg(i: usize) -> ConversationMessage {
        ConversationMessage {
            role: "assistant".to_owned(),
            content: format!("Autonomous {i}"),
            timestamp: Local::now().to_rfc3339(),
            is_tool_result_only: false,
            is_autonomous: true,
        }
    }

    #[test]
    fn test_trailing_autonomous_len() {
        let mut messages = make_messages(4);
        assert_eq!(CompactionManager::trailing_autonomous_len(&messages), 0);

        messages.push(autonomous_msg(0));
        messages.push(autonomous_msg(1));
        assert_eq!(CompactionManager::trailing_autonomous_len(&messages), 2);

        // A user message after the autonomous run terminates the tail.
        messages.extend(make_messages(1));
        assert_eq!(CompactionManager::trailing_autonomous_len(&messages), 0);
    }

    #[tokio::test]
    async fn test_compact_keep_zero_retains_autonomous_tail() {
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# x")]);
        let conv_mgr = MockConversationMgr::new("new-conv-deep");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        // 3 user turns, then 2 unanswered autonomous messages.
        let mut messages = make_messages(6);
        messages.push(autonomous_msg(0));
        messages.push(autonomous_msg(1));

        let result = mgr
            .compact(
                "conv-1",
                &messages,
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                Some(0),
                true,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.compacted_turns, 3);
                assert_eq!(r.retained_count, 2);
                assert_eq!(r.retained_turns, 0);
            }


        );

        // The archive call must keep exactly the autonomous tail.
        let calls = conv_mgr.archived_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, 2);
    }

    #[tokio::test]
    async fn test_compact_keep_zero_without_retain_archives_everything() {
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# x")]);
        let conv_mgr = MockConversationMgr::new("new-conv-full");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let mut messages = make_messages(6);
        messages.push(autonomous_msg(0));

        let result = mgr
            .compact(
                "conv-1",
                &messages,
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                Some(0),
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_variant!(


            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.retained_count, 0);
            }


        );
    }

    #[tokio::test]
    async fn test_compact_only_autonomous_tail_is_insufficient() {
        // Nothing but unanswered autonomous messages: with tail retention
        // there is nothing to archive, so the pass must refuse instead of
        // burning an LLM call.
        let llm = ScriptedLlm::new(vec![]);
        let conv_mgr = MockConversationMgr::new("must-not-be-used");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let messages = vec![autonomous_msg(0), autonomous_msg(1)];

        let result = mgr
            .compact(
                "conv-1",
                &messages,
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                Some(0),
                true,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await;

        assert!(matches!(result, Err(CompactionError::InsufficientMessages)));
        assert!(conv_mgr.archived_calls().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_compaction_archive_boundary_keeps_executor_responsive() {
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# x")]);
        let (conv_mgr, entered_rx, release_tx) = BlockingConversationMgr::new("new-conv-3");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let workspace_dir = tmp.path().to_string_lossy().into_owned();

        let compaction = tokio::spawn(async move {
            let ctx = TestCtx::new(workspace_dir);
            mgr.compact(
                "conv-1",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await
        });

        tokio::time::timeout(Duration::from_millis(500), entered_rx)
            .await
            .expect("blocking archive boundary should start promptly")
            .expect("blocking archive boundary should signal entry");

        let sibling_ran = Arc::new(AtomicBool::new(false));
        let sibling_ran_clone = Arc::clone(&sibling_ran);
        let sibling_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            sibling_ran_clone.store(true, Ordering::SeqCst);
        });

        tokio::time::timeout(Duration::from_millis(250), sibling_task)
            .await
            .expect("sibling task should stay responsive during compaction")
            .unwrap();
        assert!(sibling_ran.load(Ordering::SeqCst));

        release_tx.send(()).unwrap();

        let result = compaction.await.unwrap().unwrap();
        assert_variant!(

            result,
            CompactionOutcome::Compacted(r) => {
                assert_eq!(r.new_conversation_id, "new-conv-3");
                assert_eq!(r.memory_files_written.len(), 1);
            }

        );
    }

    #[tokio::test]
    async fn test_compact_empty_messages() {
        let llm = ScriptedLlm::new(vec![end_turn("never called")]);
        let conv_mgr = MockConversationMgr::new("must-not-be-used");
        let mgr = CompactionManager::new(CompactionConfig::default());
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-1",
                &[],
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await;

        assert!(matches!(result, Err(CompactionError::InsufficientMessages)));
    }

    #[tokio::test]
    async fn test_compact_fewer_than_keep_recent_turns() {
        let llm = ScriptedLlm::new(vec![end_turn("never called")]);
        let conv_mgr = MockConversationMgr::new("must-not-be-used");
        let mgr = CompactionManager::new(make_config_with_keep(10));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let result = mgr
            .compact(
                "conv-1",
                &make_messages(5),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await;

        assert!(matches!(result, Err(CompactionError::InsufficientMessages)));
    }

    // -- Tests: cache-tail invariant ----------------------------------------

    #[tokio::test]
    async fn test_compact_extends_chat_prefix_with_exactly_one_trailing_user_turn() {
        // The cache-tail invariant: the chat prefix (system, tools,
        // messages) passes through verbatim, and exactly one user message
        // is appended (the compaction prompt). This is the wire-shape
        // contract — same whether the chat request came from
        // `last_request` or was rebuilt from disk via
        // `handler::build_chat_shape_request_from_disk`.
        let llm = ScriptedLlm::writing(&[("memory/notes/x.md", "# x")]);
        let conv_mgr = MockConversationMgr::new("new-conv-cached");
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let messages = make_messages(10);
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let chat_request = LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "test-model".into(),
            api_key: "k".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![
                json!({"role": "user", "content": "hi"}),
                json!({"role": "assistant", "content": "hello"}),
            ],
            system: Some(json!("sys")),
            tools: None,
            max_tokens: 1024,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        };

        let _ignored = mgr
            .compact(
                "conv-cached",
                &messages,
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                chat_request,
                None,
                &ctx,
                None,
            )
            .await
            .unwrap();

        assert_eq!(
            llm.chat_prefix_len(),
            Some(2),
            "chat prefix must pass through verbatim — 2 messages in, 2 messages observed"
        );
        assert_eq!(
            llm.built_message_count(),
            Some(3),
            "exactly one trailing user message must be appended to the chat prefix"
        );
        let user_text = llm.last_user_text().expect("captured final user prompt");
        assert!(user_text.contains("The conversation above is now complete"));
    }

    // -- Tests: idle timer scheduling logic ----------------------------------

    #[tokio::test]
    async fn test_idle_timer_fires_after_duration() {
        tokio::time::pause();

        let mgr = CompactionManager::new(CompactionConfig {
            idle_trigger: shore_common::config::ConfigDuration::from_secs(300),
            ..Default::default()
        });

        let timer = mgr.idle_timer();
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = Arc::clone(&fired);

        let handle = tokio::spawn(async move {
            timer.wait_for_idle().await;
            fired_clone.store(true, Ordering::SeqCst);
        });

        tokio::time::advance(Duration::from_mins(4)).await;
        tokio::task::yield_now().await;
        assert!(!fired.load(Ordering::SeqCst));

        tokio::time::advance(Duration::from_mins(1)).await;
        handle.await.unwrap();
        assert!(fired.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_idle_timer_resets_on_activity() {
        tokio::time::pause();

        let mgr = CompactionManager::new(CompactionConfig {
            idle_trigger: shore_common::config::ConfigDuration::from_secs(300),
            ..Default::default()
        });

        let timer = mgr.idle_timer();
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = Arc::clone(&fired);

        let handle = tokio::spawn(async move {
            timer.wait_for_idle().await;
            fired_clone.store(true, Ordering::SeqCst);
        });

        tokio::time::advance(Duration::from_mins(4)).await;
        tokio::task::yield_now().await;
        assert!(!fired.load(Ordering::SeqCst));

        mgr.notify_activity();
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_mins(4)).await;
        tokio::task::yield_now().await;
        assert!(!fired.load(Ordering::SeqCst));

        tokio::time::advance(Duration::from_mins(1)).await;
        handle.await.unwrap();
        assert!(fired.load(Ordering::SeqCst));
    }

    // -- Tests: rollback on failure -----------------------------------------

    #[tokio::test]
    async fn test_compact_rollback_restores_overwritten_markdown() {
        let llm =
            ScriptedLlm::writing(&[("memory/preferences/beverages.md", "# Beverages\n- new note")]);
        let conv_mgr = FailingConversationMgr;
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        let original = "# Beverage Preferences\n\n- User prefers coffee on weekends\n";
        store
            .write("preferences/beverages.md", original)
            .await
            .unwrap();

        let result = mgr
            .compact(
                "conv-1",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await;

        assert!(matches!(
            result,
            Err(CompactionError::ConversationManager(_))
        ));

        let restored = store.read("preferences/beverages.md").await.unwrap();
        assert_eq!(restored.content, original);
    }

    #[tokio::test]
    async fn test_compact_rollback_records_git_revert_commit() {
        if !git_available() {
            return;
        }
        let llm = ScriptedLlm::writing(&[("memory/notes/today.md", "# Today\n- new note")]);
        let conv_mgr = FailingConversationMgr;
        let mgr = CompactionManager::new(make_config_with_keep(2));
        let tmp = tempfile::tempdir().unwrap();
        let store = MarkdownMemoryStore::open(tmp.path().join("memory"))
            .await
            .unwrap();
        let ctx = TestCtx::new(tmp.path().to_string_lossy().into_owned());

        // Pre-existing (never committed) content; the rollback restores it,
        // so the tree differs from the empty history and the daemon records
        // a revert commit.
        store
            .write("notes/today.md", "# Today\n- original note\n")
            .await
            .unwrap();

        let result = mgr
            .compact(
                "conv-1",
                &make_messages(10),
                "",
                DEFAULT_COMPACT_SYSTEM,
                DEFAULT_COMPACT_PROMPT,
                "TestChar",
                "TestUser",
                &llm,
                &conv_mgr,
                Some(&store),
                false,
                None,
                false,
                make_chat_request(&[]),
                None,
                &ctx,
                None,
            )
            .await;
        assert!(matches!(
            result,
            Err(CompactionError::ConversationManager(_))
        ));

        // The pass bootstrapped a repo, and the rollback recorded a commit so
        // history matches the restored tree.
        assert!(tmp.path().join(".git").exists());
        let log = std::process::Command::new("git")
            .args(["log", "--format=%s"])
            .current_dir(tmp.path())
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout)
            .contains("revert: compaction rolled back after archive failure"));
    }
}
