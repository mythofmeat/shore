use crate::llm::types::LlmRequest;
use serde_json::json;
use shore_common::protocol::error::ErrorCode;
use shore_common::protocol::types::Role;
use tracing::{debug, info};

use crate::engine::ConversationEngine;
use crate::memory::compaction::{
    CompactionError, CompactionManager, CompactionOutcome, CompactionResult, ConversationMessage,
    DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_SYSTEM,
};
use crate::memory::compaction_impls::{RealCompactionLlm, RealConversationManager};
use crate::memory::markdown_query;
use crate::memory::markdown_store::MarkdownMemoryStore;
use shore_common::config::character_memory_dir;
use shore_common::config::resolve_prompt_template;

use crate::commands::{CommandContext, CommandResult};
use crate::convert::u64_to_usize;

async fn open_markdown_store(
    ctx: &CommandContext,
    char_name: &str,
) -> Result<MarkdownMemoryStore, (ErrorCode, String)> {
    MarkdownMemoryStore::open(character_memory_dir(&ctx.config.dirs.config, char_name))
        .await
        .map_err(|e| {
            (
                ErrorCode::InternalError,
                format!("Failed to open markdown store: {e}"),
            )
        })
}

/// Show recent memory changelog entries.
pub fn memory_changelog(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let limit_raw = args
        .get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(20);
    let limit = usize::try_from(limit_raw.max(0)).unwrap_or(usize::MAX);

    let char_name = engine.character_name();
    let dreams_path = crate::memory::dreams_log::dreams_log_path(&ctx.config.dirs.data, char_name);
    if !dreams_path.exists() {
        return Ok(json!({ "changelog": [], "character": char_name }));
    }

    let content = std::fs::read_to_string(&dreams_path).map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("failed to read dreams log: {e}"),
        )
    })?;
    let mut sections = content
        .split("\n## ")
        .filter_map(|section| {
            let trimmed = section.trim();
            if trimmed.is_empty() || trimmed.starts_with("# Dreams") {
                return None;
            }
            let prefixed = if trimmed.starts_with("## ") {
                trimmed.to_owned()
            } else {
                format!("## {trimmed}")
            };
            let mut lines = prefixed.lines();
            let heading = lines.next()?.trim_start_matches("## ").trim();
            let description = lines.collect::<Vec<_>>().join("\n").trim().to_owned();
            let (timestamp, operation) = heading
                .strip_prefix("Dream Cycle - ")
                .map(|ts| (ts.to_owned(), "dream_cycle".to_owned()))
                .or_else(|| {
                    heading
                        .split_once(" - ")
                        .map(|(ts, op)| (ts.to_owned(), op.to_owned()))
                })
                .unwrap_or_else(|| (String::new(), heading.to_owned()));
            Some(json!({
                "timestamp": timestamp,
                "operation": operation,
                "description": description,
            }))
        })
        .collect::<Vec<_>>();
    sections.reverse();
    sections.truncate(limit);

    debug!(
        character = char_name,
        count = sections.len(),
        "Memory changelog queried"
    );
    Ok(json!({ "changelog": sections, "character": char_name }))
}

/// Print recent entries from the dreams audit log (data-dir-rooted).
pub fn memory_dreams(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let limit = args
        .get("limit")
        .and_then(serde_json::Value::as_u64)
        .map_or(10, u64_to_usize);
    let char_name = engine.character_name();
    let path = crate::memory::dreams_log::dreams_log_path(&ctx.config.dirs.data, char_name);
    if !path.exists() {
        return Ok(json!({
            "character": char_name,
            "entries": [],
            "path": path.display().to_string(),
            "exists": false,
        }));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("failed to read dreams log: {e}"),
        )
    })?;

    let mut sections = content
        .split("\n## ")
        .filter_map(|section| {
            let trimmed = section.trim();
            if trimmed.is_empty() || trimmed.starts_with("# Dreams") {
                None
            } else {
                Some(format!("## {trimmed}"))
            }
        })
        .collect::<Vec<_>>();
    sections.reverse();
    sections.truncate(limit);

    Ok(json!({
        "character": char_name,
        "entries": sections,
        "path": path.display().to_string(),
        "exists": true,
    }))
}

pub async fn memory_dream(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let status = args
        .get("status")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let dry_run = args
        .get("dry_run")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let force = args
        .get("force")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let char_name = engine.character_name();
    let cfg = &ctx.config.app.memory.dreaming;

    if status {
        let status_report = crate::memory::dreaming::dream_status(
            &ctx.data_dir,
            &ctx.config.dirs.config,
            char_name,
            cfg,
        )
        .await
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
        return Ok(json!(status_report));
    }

    let cached_request = ctx.autonomy.cached_last_request(char_name);
    let result = match crate::memory::dreaming::run_librarian_sweep(
        &ctx.config,
        &ctx.data_dir,
        &ctx.llm_client,
        char_name,
        cached_request.as_ref(),
        dry_run,
        force,
    )
    .await
    {
        Ok(result) => result,
        Err(crate::memory::dreaming::DreamingError::Config(_)) if dry_run => {
            crate::memory::dreaming::run_legacy_diagnostic_sweep(
                &ctx.data_dir,
                &ctx.config.dirs.config,
                char_name,
                cfg,
                dry_run,
                force,
            )
            .await
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?
        }
        Err(e) => return Err((ErrorCode::InternalError, e.to_string())),
    };
    match result {
        Some(report) => Ok(json!(report)),
        None => Ok(json!({
            "character": char_name,
            "status": "not_due",
            "enabled": cfg.enabled,
            "frequency": cfg.frequency,
        })),
    }
}

/// Memory command: status (no query) or direct markdown search (with query).
pub async fn memory(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    match query {
        None => memory_status(engine, ctx).await,
        Some(q) => {
            debug!(
                character = engine.character_name(),
                query_len = q.len(),
                "Memory query requested"
            );
            memory_query(engine, ctx, q).await
        }
    }
}

/// Return markdown memory file counts for the current character.
async fn memory_status(engine: &ConversationEngine, ctx: &CommandContext) -> CommandResult {
    let char_name = engine.character_name();
    let store = open_markdown_store(ctx, char_name).await?;
    let status = markdown_query::memory_status(&store)
        .await
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;

    debug!(
        character = char_name,
        entries = status.total_files,
        daily = status.daily_files,
        images = status.image_files,
        "Memory status queried"
    );
    Ok(json!({
        "character": char_name,
        "entries": status.total_files,
        "curated_files": status.topic_files,
        "daily_files": status.daily_files,
        "image_files": status.image_files,
    }))
}

/// Run a memory query against markdown files.
async fn memory_query(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    query: &str,
) -> CommandResult {
    let char_name = engine.character_name();
    let store = open_markdown_store(ctx, char_name).await?;
    let hits = store.search_text(query).await.map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("Memory query failed: {e}"),
        )
    })?;
    let result = markdown_query::format_direct_response(query, &hits);

    Ok(json!({
        "character": char_name,
        "query": query,
        "result": result,
    }))
}

/// Run compaction on the current character's conversation.
pub async fn compact(
    engine: &mut ConversationEngine,
    ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let dry_run = args
        .get("dry_run")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let keep_turns_override = args
        .get("keep_turns")
        .and_then(serde_json::Value::as_u64)
        .map(u64_to_usize);

    let char_name = engine.character_name().to_owned();
    let _compaction_guard =
        crate::memory::compaction::try_begin_compaction(&ctx.config.dirs.data, &char_name)
            .ok_or_else(|| {
                (
                    ErrorCode::Busy,
                    format!("Compaction already running for {char_name}"),
                )
            })?;

    let messages: Vec<ConversationMessage> = engine
        .messages()
        .iter()
        .map(|m| ConversationMessage {
            role: match m.role {
                Role::User => "user".to_owned(),
                Role::Assistant => "assistant".to_owned(),
                Role::System => "system".to_owned(),
            },
            content: m.content.clone(),
            timestamp: m.timestamp.clone(),
            is_tool_result_only: m.is_tool_result_only(),
            is_autonomous: m.origin
                == Some(shore_common::protocol::types::MessageOrigin::Autonomous),
        })
        .collect();

    if messages.is_empty() {
        return Err((
            ErrorCode::InvalidRequest,
            "No messages to compact".to_owned(),
        ));
    }

    let outcome = prepare_and_run_compaction(
        engine,
        ctx,
        &char_name,
        &messages,
        dry_run,
        keep_turns_override,
    )
    .await?;

    build_compaction_response(engine, ctx, &char_name, outcome)
}

/// Resolve the chat-shape request compaction will extend. Prefer the
/// in-memory cached `last_request`; fall back to rebuilding from disk via the
/// same path chat would have used. The wire shape — system, tools, messages —
/// is identical either way; only the source differs. (A sibling of the
/// background task's `resolve_compaction_chat_request`, plumbed through
/// `CommandContext` and command error codes.)
fn resolve_command_chat_request(
    ctx: &CommandContext,
    engine: &ConversationEngine,
    char_name: &str,
) -> Result<LlmRequest, (ErrorCode, String)> {
    if let Some(req) = ctx.autonomy.cached_last_request(char_name) {
        return Ok(req);
    }
    let chat_model = crate::preferences::resolve_chat_model_for_character(&ctx.config, char_name)
        .ok_or_else(|| {
        (
            ErrorCode::InternalError,
            "No chat model configured for compaction prefix rebuild".to_owned(),
        )
    })?;
    let character_dir = engine.character_dir().clone();
    let has_prior_context = crate::engine::segments::SegmentReader::load(&character_dir)
        .is_ok_and(|r| r.segment_count() > 0);
    crate::handler::build_chat_shape_request_from_disk(
        char_name,
        &character_dir,
        &ctx.config,
        &chat_model,
        engine.messages(),
        has_prior_context,
    )
    .map_err(|e| (ErrorCode::InternalError, e.to_string()))
}

/// Assemble the compaction inputs (templates, model, LLM/conversation managers,
/// active conversation, chat-shape prefix request, tool context) and run the
/// compaction loop. Returns the raw outcome for the caller to render.
async fn prepare_and_run_compaction(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    char_name: &str,
    messages: &[ConversationMessage],
    dry_run: bool,
    keep_turns_override: Option<usize>,
) -> Result<CompactionOutcome, (ErrorCode, String)> {
    info!(character = %char_name, message_count = messages.len(), dry_run, "Compaction started");

    let system_template =
        resolve_prompt_template(&ctx.config.dirs.config, char_name, "compact_system.md")
            .unwrap_or_else(|| DEFAULT_COMPACT_SYSTEM.to_owned());
    let prompt_template = resolve_prompt_template(&ctx.config.dirs.config, char_name, "compact.md")
        .unwrap_or_else(|| DEFAULT_COMPACT_PROMPT.to_owned());

    let model = crate::preferences::resolve_background_model(
        &ctx.config,
        shore_common::config::app::BackgroundTask::Compaction,
        char_name,
    )
    .ok_or_else(|| (ErrorCode::InternalError, "No model configured".to_owned()))?;
    let max_tool_iterations = model.max_tool_iterations;

    let llm = RealCompactionLlm::new(
        ctx.llm_client.clone(),
        model,
        ctx.config.providers.clone(),
        char_name.to_owned(),
    );
    let conv_mgr = RealConversationManager::new(engine.character_dir());

    let mgr = CompactionManager::new(ctx.config.app.memory.compaction.clone());

    let active_content = std::fs::read_to_string(
        engine
            .character_dir()
            .join(shore_common::config::ACTIVE_JSONL_FILE),
    )
    .map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("failed to read active.jsonl: {e}"),
        )
    })?;

    let display_name = ctx.config.app.defaults.resolve_display_name();

    let markdown_store =
        MarkdownMemoryStore::open(character_memory_dir(&ctx.config.dirs.config, char_name))
            .await
            .ok();

    let chat_request = resolve_command_chat_request(ctx, engine, char_name)?;

    // Build the canonical tool context for the compaction loop. Mirrors
    // the background-task wiring so manual `swp memory_compact` and the
    // idle-trigger path see an identical workspace/markdown-store/embedder
    // view.
    let tool_ctx = build_swp_compaction_tool_context(ctx, char_name);

    let outcome = mgr
        .compact(
            char_name,
            messages,
            &active_content,
            &system_template,
            &prompt_template,
            char_name,
            &display_name,
            &llm,
            &conv_mgr,
            markdown_store.as_ref(),
            dry_run,
            keep_turns_override,
            false,
            chat_request,
            Some(&ctx.config.dirs.data),
            tool_ctx.as_ref(),
            max_tool_iterations,
        )
        .await
        .map_err(|e| compaction_err(&e))?;

    // Opt-in, best-effort push after a successful manual compaction. Resolve
    // the character-effective config (per-character overlays merged over
    // global) so a per-character `[memory] git_push` override is honored here
    // exactly as it is on the background path.
    let push_config = shore_common::config::load_character_config(&ctx.config, char_name)
        .ok()
        .flatten()
        .unwrap_or_else(|| ctx.config.clone());
    crate::memory::compaction::push_after_compaction(&push_config, char_name, &outcome).await;

    Ok(outcome)
}

/// Render a compaction outcome into the command's JSON result. On a successful
/// compaction this reloads the engine and applies any deferred self-edits.
fn build_compaction_response(
    engine: &mut ConversationEngine,
    ctx: &CommandContext,
    char_name: &str,
    outcome: CompactionOutcome,
) -> CommandResult {
    match outcome {
        CompactionOutcome::Compacted(result) => {
            info!(
                character = %char_name,
                memory_files_written = result.memory_files_written.len(),
                message_count = result.message_count,
                retained_count = result.retained_count,
                "Compaction complete"
            );
            complete_compaction(engine, ctx, char_name, &result)
        }
        CompactionOutcome::NoMemoryWrites(result) => {
            tracing::warn!(
                character = %char_name,
                tool_rounds = result.tool_rounds,
                rejected = result.rejected_paths.len(),
                max_rounds_hit = result.max_rounds_hit,
                "Compaction produced no memory writes — conversation NOT archived"
            );
            Ok(json!({
                "status": "no_memory_writes",
                "character": char_name,
                "message_count": result.message_count,
                "turn_count": result.compacted_turns,
                "compacted_turns": result.compacted_turns,
                "tool_rounds": result.tool_rounds,
                "tools_called": result.tools_called,
                "rejected_paths": result.rejected_paths,
                "max_rounds_hit": result.max_rounds_hit,
            }))
        }
        CompactionOutcome::DryRun(result) => {
            let previews: Vec<serde_json::Value> = result
                .file_ops_preview
                .iter()
                .map(|op| {
                    json!({
                        "path": op.path,
                        "content_preview": op.content.chars().take(200).collect::<String>(),
                    })
                })
                .collect();

            Ok(json!({
                "status": "dry_run",
                "character": char_name,
                "would_write_files": result.would_write_files,
                "file_ops_preview": previews,
                "message_count": result.message_count,
                "turn_count": result.compacted_turns,
                "compacted_turns": result.compacted_turns,
                "retained_count": result.retained_count,
                "retained_turns": result.retained_turns,
                "tool_rounds": result.tool_rounds,
                "tools_called": result.tools_called,
            }))
        }
    }
}

/// Complete a successful compaction: reload the engine, apply
/// deferred edits, notify autonomy, and build the JSON response.
fn complete_compaction(
    engine: &mut ConversationEngine,
    ctx: &CommandContext,
    char_name: &str,
    result: &CompactionResult,
) -> CommandResult {
    engine
        .reload()
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;

    // Apply deferred character self-edits now that the cache has
    // been bust by the engine reload.
    let character_data_dir = ctx.config.dirs.data.join(char_name);
    if let Err(e) = crate::memory::deferred_edits::apply_deferred_edits(
        &character_data_dir,
        &ctx.config.dirs.config,
        char_name,
    ) {
        tracing::warn!(
            character = %char_name,
            error = %e,
            "Failed to apply deferred edits after compaction"
        );
    }

    // Same post-compaction bookkeeping as the handler and idle-tick
    // paths: invalidates the cached pre-compaction LLM request,
    // records memory coverage of the retained turns, and resets the
    // compaction trigger flags.
    ctx.autonomy
        .notify_compaction_complete(char_name, result.retained_turns);

    Ok(json!({
        "status": "compacted",
        "character": char_name,
        "memory_files_written": result.memory_files_written,
        "message_count": result.message_count,
        "turn_count": result.compacted_turns,
        "compacted_turns": result.compacted_turns,
        "retained_count": result.retained_count,
        "retained_turns": result.retained_turns,
        "new_conversation_id": result.new_conversation_id,
        "tool_rounds": result.tool_rounds,
        "tools_called": result.tools_called,
    }))
}

/// Build the compaction tool context for a manual `swp memory_compact`
/// call. Mirrors the background-task wiring exactly so both code paths
/// see the same workspace, markdown store, embedder, and image-gen
/// config.
fn build_swp_compaction_tool_context(
    ctx: &CommandContext,
    char_name: &str,
) -> std::sync::Arc<crate::tools::context::SharedToolContext> {
    use shore_common::config::{character_data_dir, character_memory_dir, character_workspace_dir};

    let character_data_dir_path = character_data_dir(&ctx.config.dirs.data, char_name);
    let image_gen_config = crate::memory::compaction_impls::resolve_image_gen_config(
        ctx.config.app.defaults.image_generation.as_deref(),
        &ctx.config.models.image_generation,
        &ctx.config.providers,
    )
    .ok();
    let embedder = crate::memory::retrieval::resolve_embedder(
        ctx.config.app.defaults.embedding.as_deref(),
        &ctx.config.models.embedding,
        &ctx.config.providers,
        ctx.llm_client.inner().http_client(),
    )
    .ok();

    std::sync::Arc::new(crate::tools::context::SharedToolContext {
        image_dir: character_data_dir_path
            .join("images")
            .to_string_lossy()
            .into_owned(),
        llm_client: ctx.llm_client.inner().clone(),
        image_gen_config,
        search_config: ctx.config.app.tools.web_search.clone(),
        character_name: char_name.to_owned(),
        workspace_dir: character_workspace_dir(&ctx.config.dirs.config, char_name)
            .to_string_lossy()
            .into_owned(),
        markdown_store: MarkdownMemoryStore::open_sync(character_memory_dir(
            &ctx.config.dirs.config,
            char_name,
        ))
        .ok(),
        memory_retrieval_config: ctx.config.app.memory.retrieval.clone(),
        embedder,
        memory_index_path: crate::memory::workspace_index::index_path(
            &ctx.config.dirs.cache,
            char_name,
        ),
        config_dir: ctx.config.dirs.config.to_string_lossy().into_owned(),
        character_data_dir: character_data_dir_path.to_string_lossy().into_owned(),
        subagent_runtime: None,
        mcp_registry: None,
    })
}

fn compaction_err(e: &CompactionError) -> (ErrorCode, String) {
    match e {
        CompactionError::InsufficientMessages => (ErrorCode::InvalidRequest, e.to_string()),
        CompactionError::Llm(_)
        | CompactionError::Parse(_)
        | CompactionError::ConversationManager(_)
        | CompactionError::MarkdownStore(_) => (ErrorCode::InternalError, e.to_string()),
    }
}

#[cfg(test)]
mod resolver_tests {
    //! Regression tests for compaction model resolution via
    //! [`crate::preferences::resolve_background_model`].
    //!
    //! Compaction is a background task and follows the
    //! `defaults.background.compaction → defaults.background.model →
    //! defaults.model → first chat model` chain. The per-character
    //! active chat model is **not** consulted, so a runtime
    //! `switch_model` does not move the compaction model.
    use crate::preferences::resolve_background_model;
    use shore_common::config::app::{
        AppConfig, BackgroundDefaultsConfig, BackgroundTask, DefaultsConfig,
    };
    use shore_common::config::models::ModelCatalog;
    use shore_common::config::{LoadedConfig, ShoreDirs};

    fn resolve(config: &LoadedConfig) -> Option<shore_common::config::models::ResolvedModel> {
        resolve_background_model(config, BackgroundTask::Compaction, "test-char")
    }

    fn catalog_with_chat_and_tools() -> ModelCatalog {
        let chat: toml::Table = toml::from_str(
            r#"
[anthropic.primary]
model_id = "claude-primary"

[anthropic.bg]
model_id = "claude-bg"
"#,
        )
        .unwrap();
        ModelCatalog::from_sections(Some(&chat), None, None).unwrap()
    }

    fn make_config(defaults: DefaultsConfig) -> LoadedConfig {
        let tmp = tempfile::tempdir().expect("tempdir");
        let app = AppConfig {
            defaults,
            ..AppConfig::default()
        };
        LoadedConfig::new_for_test(
            app,
            catalog_with_chat_and_tools(),
            ShoreDirs {
                config: tmp.path().join("config"),
                data: tmp.path().join("data"),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        )
    }

    #[test]
    fn compaction_prefers_per_task_override() {
        let config = make_config(DefaultsConfig {
            model: Some("primary".to_owned()),
            background: BackgroundDefaultsConfig {
                model: Some("primary".to_owned()),
                compaction: Some("bg".to_owned()),
                ..BackgroundDefaultsConfig::default()
            },
            ..DefaultsConfig::default()
        });
        let model = resolve(&config).expect("resolved");
        assert_eq!(model.name, "bg");
    }

    #[test]
    fn compaction_falls_back_to_background_model() {
        let config = make_config(DefaultsConfig {
            model: Some("primary".to_owned()),
            background: BackgroundDefaultsConfig {
                model: Some("bg".to_owned()),
                ..BackgroundDefaultsConfig::default()
            },
            ..DefaultsConfig::default()
        });
        let model = resolve(&config).expect("resolved");
        assert_eq!(model.name, "bg");
    }

    #[test]
    fn compaction_falls_back_to_chat_default_when_background_unset() {
        let config = make_config(DefaultsConfig {
            model: Some("primary".to_owned()),
            ..DefaultsConfig::default()
        });
        let model = resolve(&config).expect("resolved");
        assert_eq!(model.name, "primary");
    }

    #[test]
    fn compaction_falls_back_to_first_chat_model_when_nothing_set() {
        let config = make_config(DefaultsConfig::default());
        let model = resolve(&config).expect("resolved");
        // first_chat_model returns the first BTreeMap entry: "bg" sorts before "primary".
        assert_eq!(model.name, "bg");
    }

    #[test]
    fn compaction_returns_none_with_empty_catalog() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let app = AppConfig {
            defaults: DefaultsConfig::default(),
            ..AppConfig::default()
        };
        let config = LoadedConfig::new_for_test(
            app,
            ModelCatalog::default(),
            ShoreDirs {
                config: tmp.path().join("config"),
                data: tmp.path().join("data"),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );
        assert!(resolve(&config).is_none());
    }

    #[test]
    fn compaction_pin_resolves_provider_prefixed_with_zero_statics() {
        // #139: a `defaults.background.*` pin written as `provider:model_id`
        // must resolve through the effective catalog's trusted path even with
        // no static `[chat.*]` entry — mirroring `app.defaults.model`.
        use shore_common::config::providers::ProviderRegistry;

        let tmp = tempfile::tempdir().expect("tempdir");
        let app = AppConfig {
            defaults: DefaultsConfig {
                background: BackgroundDefaultsConfig {
                    compaction: Some("openrouter:anthropic/claude-sonnet-4.5".to_owned()),
                    ..BackgroundDefaultsConfig::default()
                },
                ..DefaultsConfig::default()
            },
            ..AppConfig::default()
        };
        let mut config = LoadedConfig::new_for_test(
            app,
            ModelCatalog::default(),
            ShoreDirs {
                config: tmp.path().join("config"),
                data: tmp.path().join("data"),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );
        let providers_table: toml::Table = toml::from_str(
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = false
"#,
        )
        .unwrap();
        config.providers = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let model = resolve(&config).expect("provider:model_id pin resolves with zero statics");
        assert_eq!(model.provider_key, "openrouter");
        assert_eq!(model.model_id, "anthropic/claude-sonnet-4.5");
        assert_eq!(
            model.qualified_name,
            "openrouter:anthropic/claude-sonnet-4.5"
        );
    }
}
