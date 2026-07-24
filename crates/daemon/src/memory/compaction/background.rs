use super::parser::{DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM};
use super::types::{CompactionOutcome, ConversationMessage};
use super::CompactionManager;
use std::sync::Arc;
use tracing::{info, warn};

/// Result of loading conversation messages from the active JSONL file.
struct LoadedConversation {
    store: crate::engine::messages::MessageStore,
    character_dir: std::path::PathBuf,
    raw_content: String,
    messages: Vec<ConversationMessage>,
}

/// Load conversation messages from the active JSONL for a character.
fn load_messages_for_compaction(
    data_dir: &std::path::Path,
    character: &str,
) -> Result<LoadedConversation, Box<dyn std::error::Error + Send + Sync>> {
    use crate::engine::messages::MessageStore;
    use shore_common::config::{character_active_jsonl, character_data_dir};
    use shore_common::protocol::types::MessageOrigin;

    let character_dir = character_data_dir(data_dir, character);
    let active_path = character_active_jsonl(data_dir, character);
    // Single read: parse messages + capture raw bytes for segment archival.
    // Prior to this we did `MessageStore::load(...)` followed by a separate
    // `tokio::fs::read_to_string(...)`, which read the same potentially
    // multi-MB file twice and briefly blocked the runtime on the second
    // (sync) read inside `load`.
    let (store, content) = MessageStore::load_with_raw(active_path.clone())?;
    let messages: Vec<ConversationMessage> = store
        .messages()
        .iter()
        .map(|msg| ConversationMessage {
            role: format!("{:?}", msg.role).to_lowercase(),
            content: msg.content.clone(),
            timestamp: msg.timestamp.clone(),
            is_tool_result_only: msg.is_tool_result_only(),
            is_autonomous: msg.origin == Some(MessageOrigin::Autonomous),
        })
        .collect();

    Ok(LoadedConversation {
        store,
        character_dir,
        raw_content: content,
        messages,
    })
}

/// Resolved compaction dependencies (config, model, traits, manager).
struct CompactionDeps {
    effective: shore_common::config::LoadedConfig,
    system_template: String,
    prompt_template: String,
    llm: crate::memory::compaction_impls::RealCompactionLlm,
    conv_mgr: crate::memory::compaction_impls::RealConversationManager,
    mgr: CompactionManager,
    display_name: String,
    max_tool_iterations: Option<u32>,
}

/// Resolve effective config, templates, model, and trait implementations.
fn resolve_compaction_deps(
    config: &shore_common::config::LoadedConfig,
    character: &str,
    character_dir: &std::path::Path,
    llm_client: &crate::ledger::LedgerClient,
) -> Result<CompactionDeps, Box<dyn std::error::Error + Send + Sync>> {
    use crate::memory::compaction_impls::{RealCompactionLlm, RealConversationManager};
    use shore_common::config::{load_character_config, resolve_prompt_template};

    // Resolve effective config: merge per-character overrides over global.
    let effective = load_character_config(config, character)
        .ok()
        .flatten()
        .unwrap_or_else(|| config.clone());

    let system_template =
        resolve_prompt_template(&effective.dirs.config, character, "compact_system.md")
            .unwrap_or_else(|| DEFAULT_COMPACT_SYSTEM.to_owned());
    let prompt_template = resolve_prompt_template(&effective.dirs.config, character, "compact.md")
        .unwrap_or_else(|| DEFAULT_COMPACT_PROMPT.to_owned());

    let model = crate::preferences::resolve_background_model(
        &effective,
        shore_common::config::app::BackgroundTask::Compaction,
        character,
    )
    .ok_or("No model configured for background compaction")?;
    let max_tool_iterations = model.max_tool_iterations;

    let llm = RealCompactionLlm::new(
        llm_client.clone(),
        model,
        effective.providers.clone(),
        character.to_owned(),
    );
    let conv_mgr = RealConversationManager::new(character_dir);

    let mgr = CompactionManager::new(effective.app.memory.compaction.clone());

    let display_name = effective.app.defaults.resolve_display_name();

    Ok(CompactionDeps {
        effective,
        system_template,
        prompt_template,
        llm,
        conv_mgr,
        mgr,
        display_name,
        max_tool_iterations,
    })
}

/// Run compaction for a single character (called from the background task).
/// Returns the number of retained turns on success.
///
/// `cached_request` is the live conversation's cached LLM request (typically
/// from `AutonomyManager::cached_last_request`). When `Some`, compaction
/// extends it with the compact-now tail and hits the cache chat seeded for
/// this conversation. When `None`, we rebuild the chat-shape request from
/// disk via `handler::build_chat_shape_request_from_disk` — same wire
/// shape chat would have sent, no separate "fresh" code path.
///
/// The data directory comes from `config.dirs.data` — callers should not
/// thread a separate `data_dir` argument; the two would have to stay
/// manually in sync.
pub async fn run_compaction(
    character: &str,
    config: &shore_common::config::LoadedConfig,
    llm_client: &crate::ledger::LedgerClient,
    notifier: &crate::notifications::NotificationService,
    cached_request: Option<crate::llm::types::LlmRequest>,
    keep_turns_override: Option<usize>,
    retain_trailing_autonomous: bool,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let data_dir = config.dirs.data.as_path();
    let _compaction_guard = super::try_begin_compaction(data_dir, character).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            format!("Compaction already running for {character}"),
        )
    })?;

    let loaded = load_messages_for_compaction(data_dir, character)?;

    if loaded.messages.is_empty() {
        info!(character = %character, "No messages to compact, skipping");
        return Ok(0);
    }

    let deps = resolve_compaction_deps(config, character, &loaded.character_dir, llm_client)?;

    // Open markdown memory store for existing-memory context and file writes.
    let markdown_store = crate::memory::markdown_store::MarkdownMemoryStore::open(
        shore_common::config::character_memory_dir(&deps.effective.dirs.config, character),
    )
    .await
    .ok();

    // Build the canonical SharedToolContext for the compaction tool loop.
    // Mirrors the heartbeat/librarian wiring so write/edit dispatch
    // resolves paths, queues prompt-visible refreshes, and routes search
    // through the configured embedder.
    let tool_ctx = build_compaction_tool_context(&deps.effective, data_dir, llm_client, character);

    // Resolve the chat-shape request compaction will extend. Prefer the
    // in-memory cached `last_request` — it's already warmed against the
    // provider's prompt cache. Fall back to rebuilding from disk via the
    // same path chat would have used, so the wire shape matches and a
    // subsequent chat call can still hit (or seed) the same cache prefix.
    let chat_request = resolve_compaction_chat_request(
        cached_request,
        character,
        &loaded.character_dir,
        &deps.effective,
        loaded.store.messages(),
    )?;

    let outcome = deps
        .mgr
        .compact(
            character,
            &loaded.messages,
            &loaded.raw_content,
            &deps.system_template,
            &deps.prompt_template,
            character,
            &deps.display_name,
            &deps.llm,
            &deps.conv_mgr,
            markdown_store.as_ref(),
            false,
            keep_turns_override,
            retain_trailing_autonomous,
            chat_request,
            Some(data_dir),
            tool_ctx.as_ref(),
            deps.max_tool_iterations,
        )
        .await?;

    // Opt-in, best-effort push of the workspace memory history after a
    // successful compaction (a failed push never undoes the archive).
    super::push_after_compaction(&deps.effective, character, &outcome).await;

    Ok(handle_compaction_outcome(character, notifier, outcome))
}

fn resolve_compaction_chat_request(
    cached_request_opt: Option<crate::llm::types::LlmRequest>,
    character: &str,
    character_dir: &std::path::Path,
    effective: &shore_common::config::LoadedConfig,
    messages: &[shore_common::protocol::types::Message],
) -> Result<crate::llm::types::LlmRequest, Box<dyn std::error::Error + Send + Sync>> {
    let Some(cached_request) = cached_request_opt else {
        let chat_model = crate::preferences::resolve_chat_model_for_character(effective, character)
            .ok_or("No chat model configured for compaction prefix rebuild")?;
        let has_prior_context = crate::engine::segments::SegmentReader::load(character_dir)
            .is_ok_and(|r| r.segment_count() > 0);
        return Ok(crate::handler::build_chat_shape_request_from_disk(
            character,
            character_dir,
            effective,
            &chat_model,
            messages,
            has_prior_context,
        )?);
    };
    Ok(cached_request)
}

fn handle_compaction_outcome(
    character: &str,
    notifier: &crate::notifications::NotificationService,
    outcome: CompactionOutcome,
) -> usize {
    use crate::notifications::NotificationEvent;

    match outcome {
        CompactionOutcome::Compacted(result) => {
            info!(
                character = %character,
                entries = result.memory_files_written.len(),
                compacted_turns = result.compacted_turns,
                retained_turns = result.retained_turns,
                tool_rounds = result.tool_rounds,
                "Background compaction completed"
            );

            notifier.notify(
                NotificationEvent::CompactionComplete,
                &format!("Shore — {character}"),
                &format!(
                    "Compaction complete: {} entries from {} turns",
                    result.memory_files_written.len(),
                    result.compacted_turns
                ),
            );

            result.retained_turns
        }
        CompactionOutcome::NoMemoryWrites(result) => {
            // Compaction ran but the model produced no allowed memory
            // writes. Leave active.jsonl intact and surface diagnostics
            // so an operator can investigate (often: a model that
            // ignored the tool prompt, hit max rounds, or only tried
            // disallowed paths). The next idle/forced trigger will
            // retry.
            warn!(
                character = %character,
                tool_rounds = result.tool_rounds,
                rejected = result.rejected_paths.len(),
                max_rounds_hit = result.max_rounds_hit,
                tools_called = ?result.tools_called,
                "Background compaction produced no memory writes — conversation NOT archived"
            );
            notifier.notify(
                NotificationEvent::CompactionComplete,
                &format!("Shore — {character}"),
                &format!(
                    "Compaction ran but wrote no memory ({} tool round{}). Conversation kept; will retry on next trigger.",
                    result.tool_rounds,
                    if result.tool_rounds == 1 { "" } else { "s" },
                ),
            );
            0
        }
        CompactionOutcome::DryRun(_) => {
            // Should not happen in background mode (dry_run is hard-coded
            // to false above), but harmless.
            0
        }
    }
}

/// Build the canonical `SharedToolContext` for the compaction tool loop.
/// Pulls the same dependencies the heartbeat/librarian wiring relies on so
/// that compaction sees an identical view of the workspace, memory store,
/// embedder, and image-gen config. Returned as `Arc` so the caller can
/// hand out a `&dyn ToolContext` whose lifetime is bound to the function.
fn build_compaction_tool_context(
    effective: &shore_common::config::LoadedConfig,
    data_dir: &std::path::Path,
    llm_client: &crate::ledger::LedgerClient,
    character: &str,
) -> Arc<crate::tools::context::SharedToolContext> {
    use shore_common::config::{character_data_dir, character_memory_dir, character_workspace_dir};

    let character_data_dir_path = character_data_dir(data_dir, character);
    let image_gen_config = crate::memory::compaction_impls::resolve_image_gen_config(
        effective.app.defaults.image_generation.as_deref(),
        &effective.models.image_generation,
        &effective.providers,
    )
    .ok();
    let embedder = crate::memory::retrieval::resolve_embedder(
        effective.app.defaults.embedding.as_deref(),
        &effective.models.embedding,
        &effective.providers,
        llm_client.inner().http_client(),
    )
    .ok();

    Arc::new(crate::tools::context::SharedToolContext {
        image_dir: character_data_dir_path
            .join("images")
            .to_string_lossy()
            .into_owned(),
        llm_client: llm_client.inner().clone(),
        image_gen_config,
        search_config: effective.app.tools.web_search.clone(),
        character_name: character.to_owned(),
        workspace_dir: character_workspace_dir(&effective.dirs.config, character)
            .to_string_lossy()
            .into_owned(),
        markdown_store: crate::memory::markdown_store::MarkdownMemoryStore::open_sync(
            character_memory_dir(&effective.dirs.config, character),
        )
        .ok(),
        memory_retrieval_config: effective.app.memory.retrieval.clone(),
        embedder,
        memory_index_path: crate::memory::workspace_index::index_path(
            &effective.dirs.cache,
            character,
        ),
        config_dir: effective.dirs.config.to_string_lossy().into_owned(),
        character_data_dir: character_data_dir_path.to_string_lossy().into_owned(),
        subagent_runtime: None,
        mcp_registry: None,
    })
}
