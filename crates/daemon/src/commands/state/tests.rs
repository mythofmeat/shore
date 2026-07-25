use super::*;
use crate::commands::CommandContext;
use crate::engine::ConversationEngine;
use serde_json::json;
use shore_common::config::app::{AutonomyConfig, CompactionConfig};
use shore_common::config::models::ModelCatalog;
use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::{ContentBlock, Message, Role};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tempfile::TempDir;
use tokio::sync::broadcast;

fn make_ctx(
    tmp: &TempDir,
) -> (
    ConversationEngine,
    CommandContext,
    broadcast::Receiver<ServerMessage>,
) {
    make_ctx_with_models(tmp, ModelCatalog::default())
}

fn make_ctx_with_models(
    tmp: &TempDir,
    models: ModelCatalog,
) -> (
    ConversationEngine,
    CommandContext,
    broadcast::Receiver<ServerMessage>,
) {
    make_ctx_with_config(tmp, shore_common::config::app::AppConfig::default(), models)
}

fn make_ctx_with_config(
    tmp: &TempDir,
    app: shore_common::config::app::AppConfig,
    models: ModelCatalog,
) -> (
    ConversationEngine,
    CommandContext,
    broadcast::Receiver<ServerMessage>,
) {
    let (push_tx, push_rx) = broadcast::channel(16);
    let data_dir = tmp.path().to_path_buf();
    let engine =
        ConversationEngine::new("TestChar".to_owned(), data_dir.clone(), push_tx.clone()).unwrap();

    let config = shore_common::config::LoadedConfig::new_for_test(
        app,
        models,
        shore_common::config::ShoreDirs {
            config: tmp.path().join("config"),
            data: data_dir.clone(),
            runtime: tmp.path().join("runtime"),
            cache: tmp.path().join("cache"),
        },
    );

    let (_tx, rx) = tokio::sync::watch::channel(());
    let autonomy = crate::autonomy::manager::AutonomyManager::new(
        AutonomyConfig::default(),
        CompactionConfig::default(),
        data_dir.clone(),
        rx,
    );

    let ctx = CommandContext {
        config_path: config.dirs.config.join("config.toml"),
        config,
        push_tx,
        data_dir: data_dir.clone(),
        character_name: Some("TestChar".into()),
        active_model: None,
        active_resolved_model: None,
        session_tokens: std::sync::Arc::new(std::sync::Mutex::new(
            crate::commands::SessionTokens::default(),
        )),
        autonomy,
        llm_client: crate::ledger::LedgerClient::new(
            crate::llm::LlmClient::try_new().unwrap(),
            &data_dir.join("ledger.db"),
        )
        .unwrap(),
        diagnostics: std::sync::Arc::new(std::sync::Mutex::new(
            shore_common::diagnostics::Diagnostics::default(),
        )),
    };
    (engine, ctx, push_rx)
}

#[test]
fn tools_reports_surface_ownership_and_warnings() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    // Enable a couple of tools on the main character + a sub-agent that owns
    // some tools, plus a dangling reference to exercise warnings.
    ctx.config.app.tools.enabled_tools = vec!["read".into(), "web_search".into()];
    ctx.config.app.tools.enabled_subagents = vec!["memory".into(), "ghost".into()];
    let _ = ctx.config.app.subagents.insert(
        "memory".into(),
        shore_common::config::app::SubagentConfig {
            description: "archivist".into(),
            prompt: "p".into(),
            tools: vec!["search".into(), "read".into(), "not_a_tool".into()],
            model: None,
            max_iterations: None,
        },
    );

    let out = tools(&ctx).unwrap();

    // `read` is enabled on main AND owned by the `memory` sub-agent.
    let read_row = out["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["tool"] == "read")
        .unwrap();
    assert_eq!(read_row["main"], true);
    assert_eq!(read_row["subagents"][0], "memory");

    // `search` is owned by `memory` but NOT enabled on main.
    let search_row = out["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["tool"] == "search")
        .unwrap();
    assert_eq!(search_row["main"], false);
    assert_eq!(search_row["subagents"][0], "memory");

    // The exec tool is gone, and so is the allowlist that described it.
    assert!(out.get("exec_allowlist").is_none());

    // Warnings flag the undefined sub-agent and the unknown tool reference.
    let warnings = out["warnings"].as_array().unwrap();
    assert!(warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("ghost")));
    assert!(warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("not_a_tool")));
}

fn sample_models() -> ModelCatalog {
    let toml_str = r#"
[anthropic.claude-sonnet]
model_id = "claude-sonnet-4-20250514"

[openrouter.gpt-4o]
model_id = "gpt-4o"
"#;
    let table: toml::Table = toml_str.parse().unwrap();
    ModelCatalog::from_sections(Some(&table), None, None).unwrap()
}

fn make_msg(id: &str, role: Role, content: &str) -> Message {
    Message {
        msg_id: id.to_owned(),
        origin: None,
        role,
        content: content.to_owned(),
        images: vec![],
        content_blocks: vec![],
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key: None,
        model: None,
        timestamp: "2026-01-01T00:00:00Z".to_owned(),
    }
}

fn tool_use_msg(id: &str) -> Message {
    Message {
        msg_id: id.to_owned(),
        origin: None,
        role: Role::Assistant,
        content: String::new(),
        images: vec![],
        content_blocks: vec![ContentBlock::ToolUse {
            id: "toolu_1".to_owned(),
            name: "roll_dice".to_owned(),
            input: json!({"notation": "2d6"}),
        }],
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key: None,
        model: None,
        timestamp: "2026-01-01T00:00:00Z".to_owned(),
    }
}

fn tool_result_msg(id: &str) -> Message {
    Message {
        msg_id: id.to_owned(),
        origin: None,
        role: Role::User,
        content: "ok".to_owned(),
        images: vec![],
        content_blocks: vec![ContentBlock::ToolResult {
            tool_use_id: "toolu_1".to_owned(),
            content: "ok".to_owned(),
            is_error: false,
        }],
        alt_index: None,
        alt_count: None,
        alternatives: vec![],
        provider_key: None,
        model: None,
        timestamp: "2026-01-01T00:00:00Z".to_owned(),
    }
}

#[test]
fn memory_dream_returns_useful_phase_json() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let tmp = TempDir::new().unwrap();

    rt.block_on(async {
        let (engine, ctx, _rx) = make_ctx(&tmp);
        let mem = shore_common::config::character_memory_dir(
            &ctx.config.dirs.config,
            engine.character_name(),
        );
        let workspace = shore_common::config::character_workspace_dir(
            &ctx.config.dirs.config,
            engine.character_name(),
        );
        tokio::fs::create_dir_all(&mem).await.unwrap();
        tokio::fs::write(
            mem.join("notes.md"),
            "- TestChar prefers careful memory reviews and remembers durable facts.\n",
        )
        .await
        .unwrap();

        let result = memory_dream(&engine, &ctx, &json!({ "dry_run": true, "force": true }))
            .await
            .unwrap();

        assert_eq!(result["dry_run"], true);
        assert!(result["candidate_count"].as_u64().unwrap() >= 1);
        assert!(result["indexed_count"].as_u64().unwrap() >= 1);
        assert!(result["promoted_count"].as_u64().unwrap() >= 1);
        assert!(result["rejected_count"].as_u64().is_some());
        assert_eq!(result["phase_summaries"].as_array().unwrap().len(), 3);
        assert!(result["would_write_paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path.as_str().unwrap().contains("dreams")));
        assert!(!mem.join("DREAMS.md").exists());
        assert!(!workspace.join("MEMORY.md").exists());
    });
}

#[test]
fn status_returns_state() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let tmp = TempDir::new().unwrap();

    rt.block_on(async {
        let (engine, mut ctx, _rx) = make_ctx(&tmp);
        ctx.active_model = Some("claude-sonnet".into());
        let _ = ctx.autonomy.ensure_state(engine.character_name());

        let result = status(&engine, &ctx).unwrap();
        assert_eq!(result["character"], "TestChar");
        assert_eq!(result["message_count"], 0);
        assert_eq!(result["active_model"], "claude-sonnet");
        assert_eq!(result["autonomy"]["heartbeat_state"], "Active");
    });
}

#[test]
fn status_reports_dormant_heartbeat() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let tmp = TempDir::new().unwrap();

    rt.block_on(async {
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let _ = ctx.autonomy.ensure_state(engine.character_name());
        assert!(ctx.autonomy.heartbeat_set_dormant(engine.character_name()));

        let result = status(&engine, &ctx).unwrap();
        assert_eq!(result["autonomy"]["heartbeat_state"], "Dormant");
    });
}

#[test]
fn status_with_messages() {
    let tmp = TempDir::new().unwrap();
    let (mut engine, ctx, _rx) = make_ctx(&tmp);
    engine
        .append_message(make_msg("m1", Role::User, "Hi"))
        .unwrap();

    let result = status(&engine, &ctx).unwrap();
    assert_eq!(result["message_count"], 1);
    assert_eq!(result["turn_count"], 1);
}

#[test]
fn status_counts_turns_not_tool_loop_messages() {
    let tmp = TempDir::new().unwrap();
    let (mut engine, ctx, _rx) = make_ctx(&tmp);
    engine
        .append_message(make_msg("u1", Role::User, "Hi"))
        .unwrap();
    engine.append_message(tool_use_msg("a_tool")).unwrap();
    engine.append_message(tool_result_msg("u_tool")).unwrap();
    engine
        .append_message(make_msg("a1", Role::Assistant, "Done"))
        .unwrap();

    let result = status(&engine, &ctx).unwrap();
    assert_eq!(engine.message_count(), 4);
    assert_eq!(engine.turn_count(), 1);
    assert_eq!(result["message_count"], 1);
    assert_eq!(result["turn_count"], 1);
}

#[test]
fn list_models_empty() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx(&tmp);

    let result = list_models(&ctx).unwrap();
    assert!(result["models"].as_array().unwrap().is_empty());
    assert!(result["active"].is_null());
}

#[test]
fn list_models_with_profiles() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = list_models(&ctx).unwrap();
    let models = result["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["name"], "claude-sonnet");
    assert_eq!(models[1]["name"], "gpt-4o");
    assert_eq!(result["active"], "chat.anthropic.claude-sonnet");
}

#[test]
fn list_models_reports_config_default_as_active() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.config.app.defaults.model = Some("gpt-4o".into());

    let result = list_models(&ctx).unwrap();
    assert_eq!(result["active"], "chat.openrouter.gpt-4o");
}

#[test]
fn list_models_active_name_prefers_resolved_model_over_string() {
    // The active-model display name must come from the already-resolved model,
    // not from re-resolving the `active_model` string. A divergent
    // `active_model` string proves the resolved model is authoritative; the
    // resolved model carries the canonical `provider:model_id` qualified_name.
    use shore_common::config::models::{ModelConfigFields, ResolvedModel, Sdk};
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let resolved = ResolvedModel::from_parts(
        "anthropic/claude-opus-4.8".into(),
        "openrouter:anthropic/claude-opus-4.8".into(),
        "chat".into(),
        "openrouter".into(),
        "anthropic/claude-opus-4.8".into(),
        Sdk::Anthropic,
        ModelConfigFields::default(),
    );
    ctx.active_model = Some("claude-sonnet".into());
    ctx.active_resolved_model = Some(resolved);

    let result = list_models(&ctx).unwrap();
    assert_eq!(
        result["active"], "openrouter:anthropic/claude-opus-4.8",
        "active name should come from the resolved model, not the string"
    );
}

#[test]
fn switch_model_show_current() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);
    ctx.active_model = Some("claude-sonnet".into());

    let result = switch_model(&mut ctx, &json!({})).unwrap();
    assert_eq!(result["active"], "claude-sonnet");
}

#[test]
fn switch_model_valid() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = switch_model(&mut ctx, &json!({"name": "gpt-4o"})).unwrap();
    assert_eq!(result["active"], "gpt-4o");
    assert_eq!(result["changed"], true);
    assert_eq!(ctx.active_model.as_deref(), Some("gpt-4o"));
}

#[test]
fn switch_model_not_found() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = switch_model(&mut ctx, &json!({"name": "nonexistent"}));
    assert!(result.is_err());
    let (code, _msg) = result.unwrap_err();
    assert_eq!(code, shore_common::protocol::error::ErrorCode::NotFound);
}

#[test]
fn model_info_by_name() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = model_info(&ctx, &json!({"name": "claude-sonnet"})).unwrap();
    assert_eq!(result["name"], "claude-sonnet");
    assert_eq!(result["model_id"], "claude-sonnet-4-20250514");
    assert!(result["sdk"].is_string());
}

#[test]
fn model_info_uses_active_model() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let result = model_info(&ctx, &json!({})).unwrap();
    assert_eq!(result["name"], "gpt-4o");
}

#[test]
fn model_info_no_model() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx(&tmp);

    let result = model_info(&ctx, &json!({}));
    assert!(result.is_err());
    let (code, _msg) = result.unwrap_err();
    assert_eq!(
        code,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
}

#[test]
fn model_info_not_found() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = model_info(&ctx, &json!({"name": "nonexistent"}));
    assert!(result.is_err());
    let (code, _msg) = result.unwrap_err();
    assert_eq!(code, shore_common::protocol::error::ErrorCode::NotFound);
}

#[tokio::test]
async fn memory_status_no_files() {
    let tmp = TempDir::new().unwrap();
    let (engine, ctx, _rx) = make_ctx(&tmp);

    let result = memory(&engine, &ctx, &json!({})).await.unwrap();
    assert_eq!(result["character"], "TestChar");
    assert_eq!(result["entries"], 0);
    assert_eq!(result["curated_files"], 0);
    assert_eq!(result["daily_files"], 0);
    assert_eq!(result["image_files"], 0);
}

#[tokio::test]
async fn memory_status_with_markdown_files() {
    let tmp = TempDir::new().unwrap();
    let (engine, ctx, _rx) = make_ctx(&tmp);

    let memories = ctx
        .config
        .dirs
        .config
        .join("characters")
        .join("TestChar")
        .join("workspace")
        .join("memory");
    std::fs::create_dir_all(memories.join("people")).unwrap();
    std::fs::write(memories.join("people/test.md"), "# Test\n\n- likes tea\n").unwrap();

    let result = memory(&engine, &ctx, &json!({})).await.unwrap();
    assert_eq!(result["character"], "TestChar");
    assert_eq!(result["entries"], 1);
    assert_eq!(result["curated_files"], 1);
}

#[tokio::test]
async fn memory_status_null_query_is_status() {
    let tmp = TempDir::new().unwrap();
    let (engine, ctx, _rx) = make_ctx(&tmp);

    let result = memory(&engine, &ctx, &json!({"query": null}))
        .await
        .unwrap();
    assert_eq!(result["character"], "TestChar");
    assert!(result.get("entries").is_some());
}

#[tokio::test]
async fn compact_empty_conversation_returns_error() {
    let tmp = TempDir::new().unwrap();
    let (mut engine, ctx, _rx) = make_ctx(&tmp);

    let result = compact(&mut engine, &ctx, &json!({})).await;
    assert!(result.is_err());
    let (code, msg) = result.unwrap_err();
    assert_eq!(
        code,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(msg.contains("No messages"));
}

#[tokio::test]
async fn config_check_empty_catalog() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx(&tmp);

    let result = config_check(&ctx).await.unwrap();
    assert!(!result["valid"].as_bool().unwrap());
    let warnings = result["warnings"].as_array().unwrap();
    assert!(warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("No chat models")));
    assert_eq!(result["chat_models"], 0);
}

#[tokio::test]
async fn config_check_with_models() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = config_check(&ctx).await.unwrap();
    assert_eq!(result["chat_models"], 2);
    let info = result["info"].as_array().unwrap();
    assert!(info
        .iter()
        .any(|i| i.as_str().unwrap().contains("2 chat model")));
}

#[test]
fn config_full() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    let result = config(&mut ctx, &json!({})).unwrap();
    assert!(result["config"].is_object());
}

#[test]
fn config_section() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    let result = config(&mut ctx, &json!({"key": "defaults"})).unwrap();
    assert_eq!(result["key"], "defaults");
}

#[test]
fn config_section_not_found() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    let result = config(&mut ctx, &json!({"key": "nonexistent"}));
    assert!(result.is_err());
    let (code, _msg) = result.unwrap_err();
    assert_eq!(code, shore_common::protocol::error::ErrorCode::NotFound);
}

#[test]
fn test_diagnostics_empty() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx(&tmp);

    let result = diagnostics(&ctx, &json!({})).unwrap();
    assert_eq!(result["api_calls"]["count"], 0);
    assert_eq!(result["tool_calls"]["count"], 0);
    assert_eq!(result["errors"]["count"], 0);
    assert!(result["api_calls"]["recent"].as_array().unwrap().is_empty());
}

#[test]
fn status_recovers_from_poisoned_session_tokens_mutex() {
    let tmp = TempDir::new().unwrap();
    let (engine, ctx, _rx) = make_ctx(&tmp);

    let result = catch_unwind(AssertUnwindSafe(|| {
        let _guard = ctx.session_tokens.lock().unwrap();
        panic!("poison command session tokens");
    }));
    assert!(result.is_err());

    let status_json = status(&engine, &ctx).unwrap();
    assert_eq!(status_json["tokens"]["input"], 0);
    assert_eq!(status_json["tokens"]["output"], 0);
}

#[test]
fn diagnostics_recovers_from_poisoned_mutex() {
    let tmp = TempDir::new().unwrap();
    let (_engine, ctx, _rx) = make_ctx(&tmp);

    let result = catch_unwind(AssertUnwindSafe(|| {
        let _guard = ctx.diagnostics.lock().unwrap();
        panic!("poison command diagnostics");
    }));
    assert!(result.is_err());

    let diag_json = diagnostics(&ctx, &json!({})).unwrap();
    assert_eq!(diag_json["errors"]["count"], 0);
}

#[test]
fn test_heartbeat_log_empty() {
    let tmp = TempDir::new().unwrap();
    let (engine, ctx, _rx) = make_ctx(&tmp);

    let result = heartbeat_log(&engine, &ctx, &json!({})).unwrap();
    assert!(result["events"].as_array().unwrap().is_empty());
}

#[test]
fn test_reset_model_clears_override() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    ctx.active_model = Some("custom-override".to_owned());
    let result = reset_model(&mut ctx).unwrap();

    assert_eq!(result["previous"], "custom-override");
    assert_eq!(result["reset_to"], "config default");
    assert!(ctx.active_model.is_none());
}

#[test]
fn config_reset_clears_active_model_and_reloads() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    std::fs::create_dir_all(tmp.path().join("config")).unwrap();
    std::fs::write(
        tmp.path().join("config").join("config.toml"),
        "[defaults]\nstream = false\n",
    )
    .unwrap();

    ctx.active_model = Some("custom-override".into());
    ctx.config.app.defaults.stream = true;

    let result = config_reset(&mut ctx).unwrap();

    assert_eq!(result["reset"], true);
    assert!(ctx.active_model.is_none(), "active_model should be cleared");
    assert!(
        !ctx.config.app.defaults.stream,
        "config should be reloaded from ctx.config.dirs.config"
    );
}

/// Seed a canonical workspace + active snapshot for TestChar, then edit the
/// workspace copy so a prompt delta is pending. Returns the character data dir.
fn seed_pending_prompt_edit(ctx: &CommandContext) -> std::path::PathBuf {
    let config_dir = ctx.config.dirs.config.clone();
    let char_data_dir = ctx.config.dirs.data.join("TestChar");
    let workspace = shore_common::config::character_workspace_dir(&config_dir, "TestChar");

    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join(shore_common::config::SOUL_FILE), "soul v1").unwrap();
    crate::memory::deferred_edits::ensure_active_prompt_snapshot(
        &char_data_dir,
        &config_dir,
        "TestChar",
    )
    .unwrap();
    std::fs::write(workspace.join(shore_common::config::SOUL_FILE), "soul v2").unwrap();
    char_data_dir
}

fn active_soul(char_data_dir: &std::path::Path) -> String {
    std::fs::read_to_string(crate::memory::deferred_edits::active_prompt_file(
        char_data_dir,
        shore_common::config::SOUL_FILE,
    ))
    .unwrap()
}

#[test]
fn config_reload_check_reports_changes_without_applying() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    std::fs::create_dir_all(tmp.path().join("config")).unwrap();
    std::fs::write(
        tmp.path().join("config").join("config.toml"),
        "[defaults]\nstream = false\n",
    )
    .unwrap();
    ctx.config.app.defaults.stream = true;
    let char_data_dir = seed_pending_prompt_edit(&ctx);

    let result = config_reload(&mut ctx, &json!({})).unwrap();

    assert_eq!(result["applied"], false);
    assert_eq!(result["changed_prompt_files"], json!(["SOUL.md"]));
    assert!(
        ctx.config.app.defaults.stream,
        "check phase must not adopt the on-disk config"
    );
    assert_eq!(
        active_soul(&char_data_dir),
        "soul v1",
        "check phase must not touch the active snapshot"
    );
}

#[test]
fn config_reload_apply_refreshes_prompts_and_keeps_overrides() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    std::fs::create_dir_all(tmp.path().join("config")).unwrap();
    std::fs::write(
        tmp.path().join("config").join("config.toml"),
        "[defaults]\nstream = false\n",
    )
    .unwrap();
    ctx.config.app.defaults.stream = true;
    ctx.active_model = Some("custom-override".into());
    let char_data_dir = seed_pending_prompt_edit(&ctx);

    let result =
        config_reload(&mut ctx, &json!({ "apply": true, "refresh_prompts": true })).unwrap();

    assert_eq!(result["applied"], true);
    assert_eq!(result["prompts_refreshed"], true);
    assert_eq!(result["changed_prompt_files"], json!(["SOUL.md"]));
    assert_eq!(active_soul(&char_data_dir), "soul v2");
    assert!(!ctx.config.app.defaults.stream, "config should be adopted");
    assert_eq!(
        ctx.active_model.as_deref(),
        Some("custom-override"),
        "reload preserves runtime overrides (unlike config_reset)"
    );
}

#[test]
fn config_reload_apply_without_refresh_leaves_snapshot_deferred() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    std::fs::create_dir_all(tmp.path().join("config")).unwrap();
    std::fs::write(tmp.path().join("config").join("config.toml"), "").unwrap();
    let char_data_dir = seed_pending_prompt_edit(&ctx);

    let result = config_reload(&mut ctx, &json!({ "apply": true })).unwrap();

    assert_eq!(result["applied"], true);
    assert_eq!(result["prompts_refreshed"], false);
    assert_eq!(result["changed_prompt_files"], json!(["SOUL.md"]));
    assert_eq!(
        active_soul(&char_data_dir),
        "soul v1",
        "prompt edits stay deferred when refresh was declined"
    );
}

#[test]
fn config_reload_aborts_on_invalid_config() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx(&tmp);

    std::fs::create_dir_all(tmp.path().join("config")).unwrap();
    std::fs::write(
        tmp.path().join("config").join("config.toml"),
        "this is not valid toml [",
    )
    .unwrap();
    let char_data_dir = seed_pending_prompt_edit(&ctx);
    ctx.config.app.defaults.stream = true;

    let err =
        config_reload(&mut ctx, &json!({ "apply": true, "refresh_prompts": true })).unwrap_err();

    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        ctx.config.app.defaults.stream,
        "invalid config must leave runtime config untouched"
    );
    assert_eq!(
        active_soul(&char_data_dir),
        "soul v1",
        "invalid config must abort before the prompt refresh"
    );
}

#[test]
fn rfc3339_comparison_handles_mixed_timezones() {
    let utc = "2026-01-01T00:00:00Z";
    let tokyo = "2026-01-01T09:00:00+09:00";

    let utc_dt = chrono::DateTime::parse_from_rfc3339(utc).unwrap();
    let tokyo_dt = chrono::DateTime::parse_from_rfc3339(tokyo).unwrap();

    assert_eq!(utc_dt, tokyo_dt, "Same instant in different timezones");

    assert_ne!(
        utc.cmp(tokyo),
        utc_dt.cmp(&tokyo_dt),
        "String comparison should disagree with chronological - this confirms string comparison is unreliable for RFC 3339"
    );

    let before = "2025-12-31T23:59:59Z";
    let before_dt = chrono::DateTime::parse_from_rfc3339(before).unwrap();
    assert!(
        before_dt < tokyo_dt,
        "An entry from before the cutoff should be < cutoff chronologically"
    );
}

// ── Phase 3: preferences-backed switch_model + sticky sampler ────────

#[test]
fn switch_model_persists_provider_and_model_id_to_preferences() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let result = switch_model(&mut ctx, &json!({"name": "gpt-4o"})).unwrap();
    assert_eq!(result["provider"], "openrouter");
    assert_eq!(result["model_id"], "gpt-4o");
    assert_eq!(result["qualified_name"], "chat.openrouter.gpt-4o");

    // File on disk reflects the selection by stable provider:model_id key.
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(prefs.selected.provider.as_deref(), Some("openrouter"));
    assert_eq!(prefs.selected.model_id.as_deref(), Some("gpt-4o"));
}

#[test]
fn switch_model_requires_attached_character() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.character_name = None;

    let err = switch_model(&mut ctx, &json!({"name": "gpt-4o"})).unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
}

#[test]
fn reset_model_clears_selection_in_preferences() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let _ = switch_model(&mut ctx, &json!({"name": "gpt-4o"})).unwrap();
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    assert!(crate::preferences::load_preferences(&path)
        .unwrap()
        .selected
        .is_set());

    let _ = reset_model(&mut ctx).unwrap();
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert!(!prefs.selected.is_set(), "[selected] should be cleared");
    assert!(ctx.active_model.is_none());
}

#[test]
fn set_model_setting_persists_per_model_sampler() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let result = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 0.8})).unwrap();
    assert_eq!(result["changed"], true);
    assert_eq!(result["scope"], "character");
    assert_eq!(result["key"], "temperature");
    assert_eq!(result["value"], 0.8);

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    let entry = prefs.model("openrouter", "gpt-4o").unwrap();
    assert_eq!(entry.sampler.temperature, Some(0.8));
}

#[test]
fn set_model_setting_global_scope_writes_global_file() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "top_p", "value": 0.9, "scope": "global"}),
    )
    .unwrap();

    let global = crate::preferences::load_preferences(
        &crate::preferences::global_preferences_path(&ctx.data_dir),
    )
    .unwrap();
    assert_eq!(
        global.model("openrouter", "gpt-4o").unwrap().sampler.top_p,
        Some(0.9)
    );

    // Character file untouched.
    let char_prefs = crate::preferences::load_preferences(
        &crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar"),
    )
    .unwrap();
    assert!(char_prefs.model("openrouter", "gpt-4o").is_none());
}

#[test]
fn set_model_setting_null_value_clears_field() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 0.7})).unwrap();
    let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": null})).unwrap();

    // Empty entries get pruned so the file stays tidy.
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert!(prefs.model("openrouter", "gpt-4o").is_none());
}

#[test]
fn set_model_setting_rejects_unknown_key() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let err = set_model_setting(&mut ctx, &json!({"key": "typo", "value": 0.5})).unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(err.1.contains("typo"));
}

#[test]
fn set_model_setting_moonshot_reasoning_off_vs_graded() {
    // Issue #164: Kimi/moonshot reasoning is on/off. `reasoning_effort = "off"`
    // disables thinking and must be accepted; a graded level is out of domain.
    let tmp = TempDir::new().unwrap();
    let toml_str = r#"
[moonshot.kimi]
model_id = "kimi-k2-thinking"
"#;
    let table: toml::Table = toml_str.parse().unwrap();
    let catalog = ModelCatalog::from_sections(Some(&table), None, None).unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, catalog);
    ctx.active_model = Some("kimi".into());

    // `off` is accepted and persisted.
    let result = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "off"}),
    )
    .unwrap();
    assert_eq!(result["changed"], true);
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("moonshot", "kimi-k2-thinking")
            .unwrap()
            .sampler
            .reasoning_effort
            .as_deref(),
        Some("off")
    );

    // A graded level is rejected at the capability boundary.
    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "high"}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
}

#[test]
fn set_model_setting_reasoning_off_gated_by_adapter_support() {
    // Issue #164 (CodeRabbit): `reasoning_effort = "off"` is only accepted where
    // an adapter actually disables reasoning. Native DeepSeek (Vercel AI SDK,
    // thinking.type=disabled) honors it; native Gemini has no disable path, so
    // `off` must be rejected rather than silently persisted.
    let tmp = TempDir::new().unwrap();
    let toml_str = r#"
[deepseek.r1]
model_id = "deepseek-reasoner"

[gemini.flash]
model_id = "gemini-2.5-flash"
"#;
    let table: toml::Table = toml_str.parse().unwrap();
    let catalog = ModelCatalog::from_sections(Some(&table), None, None).unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, catalog);

    // Native DeepSeek: `off` accepted (adapter disables thinking).
    ctx.active_model = Some("r1".into());
    let result = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "off"}),
    )
    .unwrap();
    assert_eq!(result["changed"], true);

    // Native Gemini: no off-switch → `off` rejected at the capability boundary.
    ctx.active_model = Some("flash".into());
    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "off"}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
}

#[test]
fn set_model_setting_validates_value_type() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    // temperature must be a number.
    let err =
        set_model_setting(&mut ctx, &json!({"key": "temperature", "value": "hot"})).unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
}

#[test]
fn sticky_sampler_per_model_across_switches() {
    // Phase 3 manual-test scenario captured as automation:
    //   set A.temp=0.7 → switch to B → set B.temp=1.2 → switch to A
    //   → A.temp must still be 0.7. Switch to B again → B.temp = 1.2.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

    let _ = switch_model(&mut ctx, &json!({"name": "claude-sonnet"})).unwrap();
    let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 0.7})).unwrap();

    let _ = switch_model(&mut ctx, &json!({"name": "gpt-4o"})).unwrap();
    let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 1.2})).unwrap();

    // Both samplers saved independently.
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("anthropic", "claude-sonnet-4-20250514")
            .unwrap()
            .sampler
            .temperature,
        Some(0.7)
    );
    assert_eq!(
        prefs
            .model("openrouter", "gpt-4o")
            .unwrap()
            .sampler
            .temperature,
        Some(1.2)
    );
}

#[test]
fn model_settings_returns_effective_sampler_with_scopes() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    // Write a global default and a character-level override.
    let mut global = crate::preferences::ModelPreferences::default();
    global.defaults.sampler.temperature = Some(1.0);
    crate::preferences::save_global_preferences(&ctx.data_dir, &global).unwrap();
    let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 0.8})).unwrap();

    let result = model_settings(&ctx, &json!({})).unwrap();
    assert_eq!(result["model"], "chat.openrouter.gpt-4o");
    assert_eq!(result["effective_sampler"]["temperature"], 0.8);
    assert_eq!(result["scopes"]["temperature"], "character_model");
}

#[test]
fn set_model_setting_sdk_persists_to_preferences() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(&mut ctx, &json!({"key": "sdk", "value": "anthropic"})).unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("openrouter", "gpt-4o")
            .unwrap()
            .sampler
            .sdk
            .as_deref(),
        Some("anthropic")
    );

    // model_settings should surface the override at character_model scope.
    let out = model_settings(&ctx, &json!({})).unwrap();
    assert_eq!(out["effective_sampler"]["sdk"], "anthropic");
    assert_eq!(out["scopes"]["sdk"], "character_model");
}

#[test]
fn set_model_setting_replay_prior_thinking_persists_and_surfaces() {
    // #129: per-model `replay_prior_thinking` override is user-controlled,
    // persists to the character preferences file, and surfaces through
    // model_settings at character_model scope.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "replay_prior_thinking", "value": false}),
    )
    .unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("openrouter", "gpt-4o")
            .unwrap()
            .sampler
            .replay_prior_thinking,
        Some(shore_common::config::app::ThinkingReplay::None)
    );

    let out = model_settings(&ctx, &json!({})).unwrap();
    assert_eq!(out["effective_sampler"]["replay_prior_thinking"], "none");
    assert_eq!(out["scopes"]["replay_prior_thinking"], "character_model");
}

#[test]
fn set_model_setting_replay_prior_thinking_rejects_unknown_value() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    // "yes" is not a tri-state value (the CLI coerces bool-words client-side;
    // the daemon only accepts all/last_turn/none or a literal bool).
    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "replay_prior_thinking", "value": "yes"}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(err.1.contains("last_turn"), "got: {}", err.1);
}

#[test]
fn set_model_setting_replay_prior_thinking_rejected_where_no_adapter_replays() {
    // The gemini adapter has no reasoning-replay wire surface, so the knob
    // would be a silent no-op there — the capability boundary rejects it
    // instead of persisting it (the rule: never expose a setting that cannot
    // do what it says).
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, vendor_models());
    ctx.active_model = Some("flash".into());

    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "replay_prior_thinking", "value": "all"}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        err.1.contains("replay_prior_thinking") && err.1.contains("not applicable"),
        "expected Inapplicable, got {:?}",
        err.1
    );
}

#[test]
fn set_model_setting_replay_prior_thinking_accepts_tristate_and_legacy_bool() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    for (input, expected) in [
        (json!("all"), shore_common::config::app::ThinkingReplay::All),
        (
            json!("last_turn"),
            shore_common::config::app::ThinkingReplay::LastTurn,
        ),
        (
            json!("none"),
            shore_common::config::app::ThinkingReplay::None,
        ),
        // Legacy bool back-compat: true → all, false → none.
        (json!(true), shore_common::config::app::ThinkingReplay::All),
        (
            json!(false),
            shore_common::config::app::ThinkingReplay::None,
        ),
    ] {
        let _ignored = set_model_setting(
            &mut ctx,
            &json!({"key": "replay_prior_thinking", "value": input}),
        )
        .unwrap();
        let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
        let prefs = crate::preferences::load_preferences(&path).unwrap();
        assert_eq!(
            prefs
                .model("openrouter", "gpt-4o")
                .unwrap()
                .sampler
                .replay_prior_thinking,
            Some(expected),
            "input {input}"
        );
    }
}

#[test]
fn set_model_setting_sdk_rejects_unknown_value() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let err = set_model_setting(&mut ctx, &json!({"key": "sdk", "value": "deepseek-fakery"}))
        .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        err.1.contains("anthropic") && err.1.contains("openai"),
        "error should list valid SDK values, got: {}",
        err.1
    );

    // The bad value must not have been persisted.
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    assert!(
        crate::preferences::load_preferences(&path)
            .unwrap()
            .model("openrouter", "gpt-4o")
            .is_none(),
        "rejected sdk write should not create a preference entry"
    );
}

#[test]
fn set_model_setting_sdk_null_clears_override() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(&mut ctx, &json!({"key": "sdk", "value": "anthropic"})).unwrap();
    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "sdk", "value": serde_json::Value::Null}),
    )
    .unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    // Clearing the only set field drops the per-model entry entirely.
    assert!(prefs.model("openrouter", "gpt-4o").is_none());

    // Effective sampler falls back to the catalog SDK. The `openrouter`
    // provider's hardcoded default is now the first-party OpenRouter SDK.
    let out = model_settings(&ctx, &json!({})).unwrap();
    assert_eq!(out["effective_sampler"]["sdk"], "openrouter");
    assert_eq!(out["scopes"]["sdk"], "static_default");
}

#[test]
fn set_model_setting_reasoning_effort_persists_to_preferences() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "high"}),
    )
    .unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("openrouter", "gpt-4o")
            .unwrap()
            .sampler
            .reasoning_effort
            .as_deref(),
        Some("high")
    );
}

#[test]
fn set_model_setting_reasoning_effort_off_stored_as_off_sentinel() {
    // "off" is the durable sentinel; the prefs resolver translates it to
    // a None reasoning_effort on the patched ResolvedModel so the
    // request builder omits the field.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "off"}),
    )
    .unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("openrouter", "gpt-4o")
            .unwrap()
            .sampler
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
}

#[test]
fn set_model_setting_rejects_inapplicable_key() {
    // `cache_ttl` only means anything on the Anthropic sdk; gpt-4o resolves to
    // the openrouter sdk, which ignores it → boundary rejection (#162).
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let err = set_model_setting(&mut ctx, &json!({"key": "cache_ttl", "value": "1h"})).unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        err.1.contains("cache_ttl") && err.1.contains("not applicable"),
        "expected Inapplicable message, got {:?}",
        err.1
    );

    // Nothing should have been persisted.
    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    assert!(crate::preferences::load_preferences(&path)
        .unwrap()
        .model("openrouter", "gpt-4o")
        .is_none());
}

#[test]
fn set_model_setting_accepts_applicable_key() {
    // `cache_ttl` on the anthropic sdk is honored.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("claude-sonnet".into());

    let _ = set_model_setting(&mut ctx, &json!({"key": "cache_ttl", "value": "5m"})).unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("anthropic", "claude-sonnet-4-20250514")
            .unwrap()
            .sampler
            .cache_ttl
            .as_deref(),
        Some("5m")
    );
}

#[test]
fn set_model_setting_rejects_out_of_domain_reasoning_effort() {
    // A bogus reasoning_effort is out of the openrouter sdk's value domain (#162).
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "turbo"}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        err.1.contains("out of domain"),
        "expected OutOfDomain message, got {:?}",
        err.1
    );
}

#[test]
fn set_model_setting_reasoning_off_sentinel_is_exempt_from_domain() {
    // "off" is the disable sentinel, intentionally absent from every domain;
    // it must still be accepted on an sdk that honors reasoning_effort.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "reasoning_effort", "value": "off"}),
    )
    .unwrap();
}

#[test]
fn model_settings_surfaces_applicability_and_domain() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());

    let out = model_settings(&ctx, &json!({})).unwrap();
    // openrouter sdk: cache_ttl is ignored, reasoning_effort honored, Shore-only
    // keys are always applicable.
    assert_eq!(out["applicability"]["cache_ttl"], "ignored");
    assert_eq!(out["applicability"]["reasoning_effort"], "honored");
    assert_eq!(out["applicability"]["sdk"], "always");
    // The accepted reasoning_effort value set for the sdk is surfaced. `max` is
    // the real OpenRouter ceiling (accepted, remapped per-model), above `xhigh`.
    let domain = out["reasoning_effort_domain"].as_array().unwrap();
    assert!(domain.iter().any(|v| v == "high"));
    assert!(domain.iter().any(|v| v == "xhigh"));
    assert!(domain.iter().any(|v| v == "max"));
}

/// A catalog with Z.AI and Gemini models (their providers resolve to the Zai /
/// Gemini sdks) for exercising the vendor knobs.
fn vendor_models() -> ModelCatalog {
    let toml_str = r#"
[zai.glm]
model_id = "glm-4.6"

[gemini.flash]
model_id = "gemini-2.5-flash"

[openrouter.gpt-4o]
model_id = "gpt-4o"
"#;
    let table: toml::Table = toml_str.parse().unwrap();
    ModelCatalog::from_sections(Some(&table), None, None).unwrap()
}

#[test]
fn set_model_setting_zai_clear_thinking_persists_on_zai_model() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, vendor_models());
    ctx.active_model = Some("glm".into());

    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "zai_clear_thinking", "value": false}),
    )
    .unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("zai", "glm-4.6")
            .unwrap()
            .sampler
            .zai_clear_thinking,
        Some(false)
    );
}

#[test]
fn set_model_setting_zai_clear_thinking_rejected_on_non_zai_model() {
    // gpt-4o resolves to the openrouter sdk, which ignores zai_clear_thinking.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, vendor_models());
    ctx.active_model = Some("gpt-4o".into());

    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "zai_clear_thinking", "value": true}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        err.1.contains("zai_clear_thinking") && err.1.contains("not applicable"),
        "expected Inapplicable, got {:?}",
        err.1
    );
}

#[test]
fn set_model_setting_openrouter_provider_rejects_scalar() {
    // The routing value must be an object, not a scalar.
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, vendor_models());
    ctx.active_model = Some("gpt-4o".into());

    let err = set_model_setting(
        &mut ctx,
        &json!({"key": "openrouter_provider", "value": "Anthropic"}),
    )
    .unwrap_err();
    assert_eq!(
        err.0,
        shore_common::protocol::error::ErrorCode::InvalidRequest
    );
    assert!(
        err.1.contains("routing object"),
        "expected object-required message, got {:?}",
        err.1
    );

    // An object is accepted.
    let _ = set_model_setting(
        &mut ctx,
        &json!({"key": "openrouter_provider", "value": {"order": ["Anthropic"]}}),
    )
    .unwrap();
}

#[test]
fn set_model_setting_gemini_generation_persists_on_gemini_model() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, vendor_models());
    ctx.active_model = Some("flash".into());

    let _ = set_model_setting(&mut ctx, &json!({"key": "gemini_generation", "value": 3})).unwrap();

    let path = crate::preferences::character_preferences_path(&ctx.data_dir, "TestChar");
    let prefs = crate::preferences::load_preferences(&path).unwrap();
    assert_eq!(
        prefs
            .model("gemini", "gemini-2.5-flash")
            .unwrap()
            .sampler
            .gemini_generation,
        Some(3)
    );
}

#[test]
fn model_settings_vendor_knob_applicability_per_sdk() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, vendor_models());
    ctx.active_model = Some("glm".into());

    let out = model_settings(&ctx, &json!({})).unwrap();
    // Z.AI sdk: its own knob is honored; another vendor's knob is ignored;
    // budget_tokens is ignored (only anthropic/gemini consume it).
    assert_eq!(out["applicability"]["zai_clear_thinking"], "honored");
    assert_eq!(out["applicability"]["gemini_generation"], "ignored");
    assert_eq!(out["applicability"]["budget_tokens"], "ignored");
    // Thinking replay is honored on zai (Preserved-Thinking carrier)…
    assert_eq!(out["applicability"]["replay_prior_thinking"], "honored");
    // Shore-only keys stay always-applicable.
    assert_eq!(out["applicability"]["max_tool_iterations"], "always");

    // …but ignored on gemini, whose adapter has no replay surface — clients
    // hide non-honored keys, so the setting disappears where it cannot work.
    ctx.active_model = Some("flash".into());
    ctx.active_resolved_model = None;
    let out_gemini = model_settings(&ctx, &json!({})).unwrap();
    assert_eq!(
        out_gemini["applicability"]["replay_prior_thinking"],
        "ignored"
    );
}

#[test]
fn model_info_includes_effective_sampler_for_active_character() {
    let tmp = TempDir::new().unwrap();
    let (_engine, mut ctx, _rx) = make_ctx_with_models(&tmp, sample_models());
    ctx.active_model = Some("gpt-4o".into());
    let _ = set_model_setting(&mut ctx, &json!({"key": "top_p", "value": 0.95})).unwrap();

    let result = model_info(&ctx, &json!({})).unwrap();
    assert_eq!(result["effective_sampler"]["top_p"], 0.95);
    assert_eq!(result["scopes"]["top_p"], "character_model");
}

// ── Phase 7: effective catalog (static + discovered) integration ────────

mod phase7 {
    use super::*;
    use crate::llm::discovery::{DiscoveredModel, ProviderModelsCache, CACHE_VERSION};
    use shore_common::config::providers::ProviderRegistry;

    /// Build a context with a provider registry, optional static chat
    /// catalog, and a populated discovery cache for `provider`.
    fn make_ctx_with_discovery(
        tmp: &TempDir,
        providers_toml: &str,
        chat_toml: &str,
        provider: &str,
        cached_ids: &[&str],
        visible_pattern: Option<&[&str]>,
    ) -> (
        ConversationEngine,
        CommandContext,
        broadcast::Receiver<ServerMessage>,
    ) {
        let catalog = if chat_toml.is_empty() {
            ModelCatalog::default()
        } else {
            let table: toml::Table = chat_toml.parse().unwrap();
            ModelCatalog::from_sections(table.get("chat").and_then(|v| v.as_table()), None, None)
                .unwrap()
        };

        // Always enable discovery for `provider` — caches in production only
        // exist after a successful refresh, which requires discovery.enabled.
        // Tests that write a cache should mirror that invariant.
        let providers_toml_full = match visible_pattern {
            Some(pats) => {
                let pats_lit = pats
                    .iter()
                    .map(|p| format!("  {p:?}"))
                    .collect::<Vec<_>>()
                    .join(",\n");
                format!(
                    "{providers_toml}\n[providers.{provider}.discovery]\nenabled = true\nignore = [\n{pats_lit}\n]\n"
                )
            }
            None => format!("{providers_toml}\n[providers.{provider}.discovery]\nenabled = true\n"),
        };

        let providers = if providers_toml_full.trim().is_empty() {
            ProviderRegistry::default()
        } else {
            let table: toml::Table = providers_toml_full.parse().unwrap();
            ProviderRegistry::from_section(table.get("providers").and_then(|v| v.as_table()))
                .unwrap()
        };

        let (_discarded_engine, mut ctx, push_rx) = make_ctx_with_models(tmp, catalog);
        ctx.config.providers = providers;
        // Reattach an engine that matches the existing make_ctx_with_models
        // engine pattern (we discard the original since we mutated config).
        let engine = ConversationEngine::new(
            "TestChar".to_owned(),
            ctx.data_dir.clone(),
            ctx.push_tx.clone(),
        )
        .unwrap();

        // Write the discovery cache for the requested provider.
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: provider.into(),
            fetched_at: "2026-04-29T00:00:00Z".into(),
            base_url: Some("https://example.test/v1".into()),
            models: cached_ids
                .iter()
                .map(|id| DiscoveredModel {
                    provider_key: provider.into(),
                    model_id: (*id).into(),
                    display_name: None,
                    sdk: "openai".into(),
                    base_url: Some("https://example.test/v1".into()),
                    created_at: None,
                    owned_by: None,
                    description: None,
                    context_length: Some(200_000),
                    max_output_tokens: Some(8192),
                    supports_tools: None,
                    supports_images: None,
                    supports_reasoning: None,
                    supports_prompt_cache: None,
                    raw_provider_metadata: serde_json::Value::Null,
                    discovered_at: "2026-04-29T00:00:00Z".into(),
                })
                .collect(),
        };
        let path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, provider);
        crate::llm::discovery::write_cache(&path, &cache).unwrap();

        (engine, ctx, push_rx)
    }

    // ── Validation: discovered model can be selected ────────────────────

    #[test]
    fn discovered_model_can_be_selected_via_switch_model() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["anthropic/claude-sonnet-4.5"],
            None,
        );

        let out =
            switch_model(&mut ctx, &json!({ "name": "anthropic/claude-sonnet-4.5" })).unwrap();
        assert_eq!(out["changed"], true);
        assert_eq!(out["provider"], "openrouter");
        assert_eq!(out["model_id"], "anthropic/claude-sonnet-4.5");
        assert_eq!(
            ctx.active_model.as_deref(),
            Some("anthropic/claude-sonnet-4.5")
        );
    }

    #[test]
    fn discovered_model_selectable_with_provider_prefix() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["anthropic/claude-sonnet-4.5"],
            None,
        );
        let out = switch_model(
            &mut ctx,
            &json!({ "name": "openrouter:anthropic/claude-sonnet-4.5" }),
        )
        .unwrap();
        assert_eq!(out["provider"], "openrouter");
        assert_eq!(out["model_id"], "anthropic/claude-sonnet-4.5");
    }

    // ── Validation: static alias still resolves ────────────────────────

    #[test]
    fn static_alias_still_selectable_with_discovery_present() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.openrouter.sonnet]
model_id = "anthropic/claude-sonnet-4.5"
cache_ttl = "1h"
max_output_tokens = 16384
"#,
            "openrouter",
            &["anthropic/claude-sonnet-4.5"],
            None,
        );
        let out = switch_model(&mut ctx, &json!({ "name": "sonnet" })).unwrap();
        // Static qualified_name wins.
        assert_eq!(out["qualified_name"], "chat.openrouter.sonnet");
        assert_eq!(out["model_id"], "anthropic/claude-sonnet-4.5");
    }

    // ── Validation: saved sampler settings apply to discovered model ────

    #[test]
    fn saved_sampler_settings_apply_to_discovered_model() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["anthropic/claude-sonnet-4.5"],
            None,
        );
        // Select the discovered model, then set a sampler value.
        let _ = switch_model(&mut ctx, &json!({"name": "anthropic/claude-sonnet-4.5"})).unwrap();
        let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 0.4})).unwrap();

        // Verify model_settings reflects the saved value via preference resolution.
        let out = model_settings(&ctx, &json!({})).unwrap();
        assert_eq!(out["effective_sampler"]["temperature"], 0.4);
        assert_eq!(out["scopes"]["temperature"], "character_model");
        assert_eq!(out["model_id"], "anthropic/claude-sonnet-4.5");
        assert_eq!(out["provider"], "openrouter");
    }

    // ── Validation: character-specific saved sampler ────────────────────

    #[test]
    fn character_scope_overrides_global_for_discovered_model() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["anthropic/claude-sonnet-4.5"],
            None,
        );
        let _ = switch_model(&mut ctx, &json!({"name": "anthropic/claude-sonnet-4.5"})).unwrap();
        // Global value first.
        let _ = set_model_setting(
            &mut ctx,
            &json!({"key": "temperature", "value": 0.9, "scope": "global"}),
        )
        .unwrap();
        // Character-scope override.
        let _ = set_model_setting(
            &mut ctx,
            &json!({"key": "temperature", "value": 0.2, "scope": "character"}),
        )
        .unwrap();

        let out = model_settings(&ctx, &json!({})).unwrap();
        assert_eq!(
            out["effective_sampler"]["temperature"], 0.2,
            "character_model should win over global_model"
        );
        assert_eq!(out["scopes"]["temperature"], "character_model");
    }

    // ── Regression: cross-session reload for a discovered selection ─────

    /// Simulate the dispatcher's per-command setup: load preferences,
    /// resolve the active model, and populate BOTH `ctx.active_model`
    /// (as the synthetic `qualified_name`) and `ctx.active_resolved_model`
    /// (as the pre-resolved `ResolvedModel`). Before the fix, the
    /// `model_settings` handler re-resolved the synthetic name via
    /// `find_effective_model` and failed NotFound — pinned by
    /// `effective_catalog::tests::synthetic_discovered_qualified_name_is_not_a_resolver_input`.
    #[test]
    fn model_settings_works_after_dispatcher_reload_for_discovered_model() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["anthropic/claude-opus-4.6"],
            None,
        );
        // First connection: user picks the discovered model.
        let _ = switch_model(&mut ctx, &json!({"name": "anthropic/claude-opus-4.6"})).unwrap();

        // Simulate a fresh connection: dispatcher rebuilds ctx from
        // preferences. `active_model` becomes the canonical
        // `provider:model_id` qualified_name (#139), and
        // `active_resolved_model` carries the real `ResolvedModel`.
        let (global, char_prefs) =
            crate::preferences::load_for_character(&ctx.data_dir, "TestChar").unwrap();
        let resolved = crate::preferences::resolve_active_for_character(
            &ctx.config,
            &ctx.data_dir,
            &global,
            &char_prefs,
            None,
            ctx.config.app.defaults.model.as_deref(),
        )
        .expect("preferences resolve to a discovered model");
        ctx.active_model = Some(resolved.qualified_name.clone());
        ctx.active_resolved_model = Some(resolved.clone());

        // `model_settings` must succeed with the canonical `provider:model_id`
        // string in `active_model`.
        let out = model_settings(&ctx, &json!({})).unwrap();
        assert_eq!(out["model"], "openrouter:anthropic/claude-opus-4.6");
        assert_eq!(out["provider"], "openrouter");
        assert_eq!(out["model_id"], "anthropic/claude-opus-4.6");

        // `set_model_setting` exercises the same resolver path; it
        // also failed before the fix.
        let _ = set_model_setting(&mut ctx, &json!({"key": "temperature", "value": 0.5})).unwrap();
        let out_after = model_settings(&ctx, &json!({})).unwrap();
        assert_eq!(out_after["effective_sampler"]["temperature"], 0.5);
    }

    // ── Validation: hidden discovered models gated ──────────────────────

    #[test]
    fn hidden_discovered_model_cannot_be_selected_by_default() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["meta-llama/llama-3-70b"],
            Some(&["meta-llama/*"]),
        );
        let err = switch_model(&mut ctx, &json!({"name": "meta-llama/llama-3-70b"})).unwrap_err();
        let (code, msg) = err;
        assert_eq!(code, shore_common::protocol::error::ErrorCode::NotFound);
        assert!(
            msg.contains("hidden") && msg.contains("include_hidden"),
            "error must explain how to include hidden models, got: {msg}"
        );
    }

    #[test]
    fn hidden_discovered_model_selectable_with_include_hidden() {
        let tmp = TempDir::new().unwrap();
        let (_e, mut ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["meta-llama/llama-3-70b"],
            Some(&["meta-llama/*"]),
        );
        let out = switch_model(
            &mut ctx,
            &json!({ "name": "meta-llama/llama-3-70b", "include_hidden": true }),
        )
        .unwrap();
        assert_eq!(out["model_id"], "meta-llama/llama-3-70b");
    }

    // ── list_models surfaces the merged catalog ─────────────────────────

    #[test]
    fn list_models_surfaces_static_and_discovered_with_source_tag() {
        let tmp = TempDir::new().unwrap();
        let (_e, ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-7"
"#,
            "openrouter",
            &["anthropic/claude-sonnet-4.5"],
            None,
        );
        let out = list_models_with_args(&ctx, &json!({})).unwrap();
        let models = out["models"].as_array().unwrap();
        let by_source: std::collections::BTreeMap<&str, &str> = models
            .iter()
            .map(|m| {
                (
                    m["model_id"].as_str().unwrap(),
                    m["source"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(by_source.get("claude-opus-4-7"), Some(&"static"));
        assert_eq!(
            by_source.get("anthropic/claude-sonnet-4.5"),
            Some(&"discovered")
        );
    }

    #[test]
    fn list_models_drops_hidden_unless_include_hidden_requested() {
        let tmp = TempDir::new().unwrap();
        let (_e, ctx, _rx) = make_ctx_with_discovery(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
            "openrouter",
            &["meta-llama/llama-3-70b", "anthropic/claude-sonnet-4.5"],
            Some(&["meta-llama/*"]),
        );
        let visible = list_models_with_args(&ctx, &json!({})).unwrap();
        let names: Vec<&str> = visible["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["model_id"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"anthropic/claude-sonnet-4.5"));
        assert!(!names.contains(&"meta-llama/llama-3-70b"));
        assert_eq!(visible["hidden_count"], 1);

        let with_hidden = list_models_with_args(&ctx, &json!({"include_hidden": true})).unwrap();
        assert_eq!(with_hidden["models"].as_array().unwrap().len(), 2);
    }

    fn app_with_background(
        blanket: Option<&str>,
        heartbeat: Option<&str>,
        compaction: Option<&str>,
        dreaming: Option<&str>,
    ) -> shore_common::config::app::AppConfig {
        let mut app = shore_common::config::app::AppConfig::default();
        app.defaults.background.model = blanket.map(str::to_owned);
        app.defaults.background.heartbeat = heartbeat.map(str::to_owned);
        app.defaults.background.compaction = compaction.map(str::to_owned);
        app.defaults.background.dreaming = dreaming.map(str::to_owned);
        app
    }

    #[test]
    fn background_models_reports_per_task_and_blanket_sources() {
        let tmp = TempDir::new().unwrap();
        // Blanket pins everything; compaction overrides it with a per-task pin.
        let app = app_with_background(Some("claude-sonnet"), None, Some("gpt-4o"), None);
        let (_engine, ctx, _rx) = make_ctx_with_config(&tmp, app, sample_models());

        let out = background_models(&ctx).unwrap();
        let rows = out["background"].as_array().unwrap();
        let by_task = |task: &str| rows.iter().find(|r| r["task"] == task).unwrap().clone();

        assert_eq!(by_task("heartbeat")["source"], "config: background.model");
        assert_eq!(
            by_task("compaction")["source"],
            "config: background.compaction"
        );
        assert_eq!(by_task("dreaming")["source"], "config: background.model");
        // The per-task pin resolves to a different model than the blanket.
        assert_ne!(
            by_task("compaction")["model"],
            by_task("heartbeat")["model"]
        );
    }

    #[test]
    fn background_models_inherits_chat_when_unset() {
        let tmp = TempDir::new().unwrap();
        let (_engine, ctx, _rx) = make_ctx_with_models(&tmp, sample_models());

        let out = background_models(&ctx).unwrap();
        for row in out["background"].as_array().unwrap() {
            assert_eq!(row["source"], "inherited: active chat model");
        }
    }

    #[test]
    fn model_settings_background_compaction_targets_pinned_model() {
        let tmp = TempDir::new().unwrap();
        let app = app_with_background(None, None, Some("gpt-4o"), None);
        let (_engine, ctx, _rx) = make_ctx_with_config(&tmp, app, sample_models());

        let out = model_settings(&ctx, &json!({ "background_task": "compaction" })).unwrap();
        assert!(out["model"].as_str().unwrap().contains("gpt-4o"));
    }

    #[test]
    fn model_settings_background_all_errors_when_models_diverge() {
        let tmp = TempDir::new().unwrap();
        // compaction pinned to gpt-4o; the rest inherit the chat model → divergent.
        let app = app_with_background(None, None, Some("gpt-4o"), None);
        let (_engine, ctx, _rx) = make_ctx_with_config(&tmp, app, sample_models());

        let err = model_settings(&ctx, &json!({ "background_task": "all" })).unwrap_err();
        assert_eq!(
            err.0,
            shore_common::protocol::error::ErrorCode::InvalidRequest
        );
        assert!(err.1.contains("different models"), "got: {}", err.1);
    }

    #[test]
    fn model_settings_background_all_ok_when_models_agree() {
        let tmp = TempDir::new().unwrap();
        // Blanket pin makes every task resolve to the same model.
        let app = app_with_background(Some("gpt-4o"), None, None, None);
        let (_engine, ctx, _rx) = make_ctx_with_config(&tmp, app, sample_models());

        let out = model_settings(&ctx, &json!({ "background_task": "all" })).unwrap();
        assert!(out["model"].as_str().unwrap().contains("gpt-4o"));
    }
}
