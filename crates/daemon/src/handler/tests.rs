use super::*;
use images::media_type_for_path;
use shore_common::config::app::{AutonomyConfig, CompactionConfig, NotificationsConfig};
use shore_common::protocol::client_msg::{Command, Regen};
use shore_common::protocol::error::ErrorCode;
use shore_common::protocol::server_msg::MessageOrigin;
use shore_common::protocol::types::{ContentBlock, ImageRef, Message, Role};
use std::collections::BTreeMap;
use tempfile::TempDir;

/// Build a `MessageHandler` backed by a tempdir with the given characters.
async fn make_handler(
    tmp: &TempDir,
    chars: &[&str],
) -> (
    MessageHandler,
    broadcast::Receiver<ServerMessage>,
    mpsc::Receiver<ServerMessage>,
) {
    make_basic_handler_with_models(
        tmp,
        chars,
        shore_common::config::models::ModelCatalog::default(),
    )
    .await
}

async fn make_basic_handler_with_models(
    tmp: &TempDir,
    chars: &[&str],
    models: shore_common::config::models::ModelCatalog,
) -> (
    MessageHandler,
    broadcast::Receiver<ServerMessage>,
    mpsc::Receiver<ServerMessage>,
) {
    let config_dir = tmp.path().join("config");
    let data_dir = tmp.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    for name in chars {
        let char_dir = config_dir.join("characters").join(name);
        std::fs::create_dir_all(&char_dir).unwrap();
        std::fs::write(
            char_dir.join("character.md"),
            format!("{name} system prompt"),
        )
        .unwrap();
    }

    let (push_tx, push_rx) = broadcast::channel(16);
    let (direct_tx, direct_rx) = mpsc::channel(16);
    let server = crate::swp_server::Server::new(crate::swp_server::ServerConfig {
        addr: "127.0.0.1:0".into(),
        allowed_hosts: vec![],
        server_name: "handler-test".into(),
        handshake: None,
    });
    let session_router = server.session_router();
    session_router
        .register_session(
            crate::swp_server::ClientInfo {
                id: 1,
                client_type: "test-client".into(),
                client_name: "test".into(),
                capabilities: vec!["streaming".into()],
                character: None,
            },
            direct_tx,
        )
        .await;

    let loaded_config = LoadedConfig::new_for_test(
        shore_common::config::app::AppConfig::default(),
        models,
        shore_common::config::ShoreDirs {
            config: config_dir.clone(),
            data: data_dir.clone(),
            runtime: tmp.path().join("runtime"),
            cache: tmp.path().join("cache"),
        },
    );

    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(());
    let autonomy = AutonomyManager::new(
        AutonomyConfig::default(),
        CompactionConfig::default(),
        data_dir.clone(),
        shutdown_rx,
    );

    let registry = CharacterRegistry::new(
        config_dir,
        data_dir.clone(),
        push_tx.clone(),
        loaded_config.clone(),
    );

    let ledger_client = LedgerClient::new(
        crate::llm::LlmClient::try_new().unwrap(),
        &data_dir.join("ledger.db"),
    )
    .unwrap();

    let cmd_ctx = CommandContext {
        config: loaded_config.clone(),
        config_path: loaded_config.dirs.config.join("config.toml"),
        push_tx: push_tx.clone(),
        data_dir: data_dir.clone(),
        character_name: None,
        active_model: None,
        active_resolved_model: None,
        session_tokens: Arc::new(std::sync::Mutex::new(SessionTokens::default())),
        autonomy: autonomy.clone(),
        llm_client: ledger_client.clone(),
        diagnostics: Arc::new(std::sync::Mutex::new(
            shore_common::diagnostics::Diagnostics::default(),
        )),
    };

    let (_control_tx, control_rx) = mpsc::channel(16);
    let handler = MessageHandler::new(MessageHandlerDeps {
        registry: Arc::new(Mutex::new(registry)),
        cmd_ctx,
        llm_client: ledger_client,
        push_tx: push_tx.clone(),
        session_router,
        autonomy,
        notifier: NotificationService::new(NotificationsConfig::default()),
        mcp_registry: Arc::new(crate::tools::mcp_registry::McpRegistry::default()),
        control_rx,
    });

    (handler, push_rx, direct_rx)
}

fn sample_models() -> shore_common::config::models::ModelCatalog {
    let toml_str = r#"
[anthropic.claude-sonnet]
model_id = "claude-sonnet-4-20250514"

[openrouter.gpt-4o]
model_id = "gpt-4o"
"#;
    let table: toml::Table = toml_str.parse().unwrap();
    shore_common::config::models::ModelCatalog::from_sections(Some(&table), None, None).unwrap()
}

fn test_request_meta(character: Option<&str>, rid: Option<&str>) -> RequestMeta {
    RequestMeta {
        session: crate::swp_server::SessionMeta {
            client_id: crate::swp_server::ClientId(1),
            session_id: SessionId(1),
            client_type: "test-client".into(),
            client_name: "test".into(),
            capabilities: vec!["streaming".into()],
            selected_character: character.map(str::to_owned),
        },
        rid: rid.map(str::to_owned),
        kind: crate::swp_server::RequestKind::Command,
    }
}

#[tokio::test]
async fn dispatch_command_valid_character() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let cmd = Command {
        rid: None,
        name: "status".into(),
        args: serde_json::json!({}),
    };

    let meta = test_request_meta(Some("Alice"), None);
    let result = handler.dispatch_command(&cmd, &meta).await;
    assert!(
        matches!(result, ServerMessage::CommandOutput(_)),
        "Expected CommandOutput, got {result:?}"
    );
}

#[tokio::test]
async fn list_models_reports_effective_active_model_for_selected_character() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) =
        make_handler_with_models(&tmp, &["Alice"], sample_models()).await;

    let mut prefs = crate::preferences::ModelPreferences::default();
    prefs.selected.provider = Some("openrouter".into());
    prefs.selected.model_id = Some("gpt-4o".into());
    crate::preferences::save_preferences(
        &crate::preferences::character_preferences_path(&handler.cmd_ctx.data_dir, "Alice"),
        &prefs,
    )
    .unwrap();

    let cmd = Command {
        rid: None,
        name: "list_models".into(),
        args: serde_json::json!({}),
    };

    let result = handler
        .dispatch_command(&cmd, &test_request_meta(Some("Alice"), None))
        .await;
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.name, "list_models");
            assert_eq!(output.data["active"], "chat.openrouter.gpt-4o");
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }

    let session = handler.session_state_mut(SessionId(1));
    assert_eq!(
        session.active_model.as_deref(),
        Some("chat.openrouter.gpt-4o")
    );
}

#[tokio::test]
async fn history_snapshot_reports_effective_active_model_for_selected_character() {
    let tmp = TempDir::new().unwrap();
    let (handler, _rx, _direct_rx) =
        make_handler_with_models(&tmp, &["Alice"], sample_models()).await;

    let mut prefs = crate::preferences::ModelPreferences::default();
    prefs.selected.provider = Some("openrouter".into());
    prefs.selected.model_id = Some("gpt-4o".into());
    crate::preferences::save_preferences(
        &crate::preferences::character_preferences_path(&handler.cmd_ctx.data_dir, "Alice"),
        &prefs,
    )
    .unwrap();

    let snapshot = crate::handshake::build_session_history_snapshot(
        Arc::clone(&handler.registry),
        Some("Alice".into()),
        None,
    )
    .await;
    assert_eq!(snapshot.config["active_model"], "chat.openrouter.gpt-4o");
}

#[tokio::test]
async fn dispatch_command_invalid_character() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let cmd = Command {
        rid: None,
        name: "status".into(),
        args: serde_json::json!({}),
    };

    let meta = test_request_meta(Some("Bob"), None);
    let result = handler.dispatch_command(&cmd, &meta).await;
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match result {
        ServerMessage::Error(e) => {
            assert_eq!(e.code, ErrorCode::InvalidRequest);
            assert!(e.message.contains("Bob"));
        }
        other => panic!("Expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn dispatch_command_auto_select() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let cmd = Command {
        rid: None,
        name: "status".into(),
        args: serde_json::json!({}),
    };

    let meta = test_request_meta(None, None);
    let result = handler.dispatch_command(&cmd, &meta).await;
    assert!(
        matches!(result, ServerMessage::CommandOutput(_)),
        "Expected auto-select to succeed, got {result:?}"
    );
}

#[tokio::test]
async fn switch_character_pushes_authoritative_history_to_session() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, mut direct_rx) = make_handler(&tmp, &["Alice", "Bob"]).await;

    let bob_engine = {
        let mut registry = handler.registry.lock().await;
        registry.get_or_create("Bob").unwrap()
    };
    bob_engine
        .lock()
        .await
        .append_message(Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::Assistant,
            content: "hello from bob".into(),
            images: vec![],
            content_blocks: vec![ContentBlock::Text {
                text: "hello from bob".into(),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            provider_key: None,
            model: None,
            timestamp: "2026-01-01T00:00:00Z".into(),
        })
        .unwrap();

    let result = handler
        .dispatch_command(
            &Command {
                rid: None,
                name: "switch_character".into(),
                args: serde_json::json!({ "name": "Bob" }),
            },
            &test_request_meta(Some("Alice"), None),
        )
        .await;

    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.name, "switch_character");
            assert_eq!(output.data["character"], "Bob");
            assert_eq!(output.data["selected_character"], "Bob");
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }

    let history_msg = direct_rx.recv().await.unwrap();
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match history_msg {
        ServerMessage::History(history) => {
            assert_eq!(history.selected_character.as_deref(), Some("Bob"));
            assert_eq!(history.messages.len(), 1);
            assert_eq!(history.messages[0].content, "hello from bob");
        }
        other => panic!("Expected direct History, got {other:?}"),
    }
}

#[tokio::test]
async fn dispatch_command_ambiguous_character() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice", "Bob"]).await;

    let cmd = Command {
        rid: None,
        name: "status".into(),
        args: serde_json::json!({}),
    };

    let meta = test_request_meta(None, None);
    let result = handler.dispatch_command(&cmd, &meta).await;
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match result {
        ServerMessage::Error(e) => {
            assert_eq!(e.code, ErrorCode::InvalidRequest);
        }
        other => panic!("Expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn config_reset_refreshes_registry_runtime_state() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let alice_dir = tmp.path().join("config").join("characters").join("Alice");
    std::fs::write(
        alice_dir.join("config.toml"),
        "[defaults]\nstream = false\n",
    )
    .unwrap();

    {
        let mut registry = handler.registry.lock().await;
        assert!(!registry.effective_config("Alice").app.defaults.stream);
    }

    std::fs::create_dir_all(tmp.path().join("config").join("characters").join("Bob")).unwrap();
    std::fs::write(
        tmp.path()
            .join("config")
            .join("characters")
            .join("Bob")
            .join("character.md"),
        "Bob prompt",
    )
    .unwrap();
    std::fs::write(alice_dir.join("config.toml"), "[defaults]\nstream = true\n").unwrap();
    std::fs::write(
        tmp.path().join("config").join("config.toml"),
        "[defaults]\nstream = true\n",
    )
    .unwrap();

    let result = handler
        .dispatch_command(
            &Command {
                rid: None,
                name: "config_reset".into(),
                args: serde_json::json!({}),
            },
            &test_request_meta(Some("Alice"), None),
        )
        .await;

    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.name, "config_reset");
            assert_eq!(output.data["invalidated"]["character_discovery"], true);
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }

    {
        let mut registry = handler.registry.lock().await;
        assert!(registry.has_character("Bob"));
        assert!(registry.effective_config("Alice").app.defaults.stream);
    }
}

#[tokio::test]
async fn config_reload_check_is_side_effect_free_and_apply_propagates() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    std::fs::write(
        tmp.path().join("config").join("config.toml"),
        "[defaults]\nstream = false\n",
    )
    .unwrap();

    // Check phase: reports without adopting the new config.
    let check_result = handler
        .dispatch_command(
            &Command {
                rid: None,
                name: "config_reload".into(),
                args: serde_json::json!({}),
            },
            &test_request_meta(Some("Alice"), None),
        )
        .await;
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match check_result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.name, "config_reload");
            assert_eq!(output.data["applied"], false);
            assert_eq!(output.data["restart_required"], serde_json::json!([]));
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }
    assert!(
        handler.cmd_ctx.config.app.defaults.stream,
        "check phase must not adopt the on-disk config"
    );

    // Apply phase: adopts the config handler-wide.
    let apply_result = handler
        .dispatch_command(
            &Command {
                rid: None,
                name: "config_reload".into(),
                args: serde_json::json!({ "apply": true }),
            },
            &test_request_meta(Some("Alice"), None),
        )
        .await;
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match apply_result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.name, "config_reload");
            assert_eq!(output.data["applied"], true);
            assert_eq!(output.data["invalidated"]["merged_character_configs"], true);
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }
    assert!(
        !handler.cmd_ctx.config.app.defaults.stream,
        "apply phase must propagate the fresh config to the handler"
    );
}

#[tokio::test]
async fn hot_reload_refreshes_global_and_character_config() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let config_path = tmp.path().join("config").join("config.toml");
    std::fs::write(&config_path, "[defaults]\nstream = false\n").unwrap();
    handler
        .reload_config_from_disk(vec![config_path.clone()])
        .await;

    assert!(!handler.cmd_ctx.config.app.defaults.stream);

    let alice_config = tmp
        .path()
        .join("config")
        .join("characters")
        .join("Alice")
        .join("config.toml");
    std::fs::write(&alice_config, "[defaults]\nstream = true\n").unwrap();
    handler.reload_config_from_disk(vec![alice_config]).await;

    let mut registry = handler.registry.lock().await;
    assert!(registry.effective_config("Alice").app.defaults.stream);
}

#[tokio::test]
async fn hot_reload_keeps_previous_config_when_reload_fails() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    assert!(handler.cmd_ctx.config.app.defaults.stream);
    let config_path = tmp.path().join("config").join("config.toml");
    std::fs::write(&config_path, "[not_a_real_section]\nvalue = true\n").unwrap();

    handler
        .reload_config_from_disk(vec![config_path.clone()])
        .await;

    assert!(
        handler.cmd_ctx.config.app.defaults.stream,
        "invalid hot reload should keep the last valid runtime config"
    );
}

#[tokio::test]
async fn hot_reload_keeps_previous_config_when_character_overlay_is_invalid() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    // Establish a valid Alice overlay first.
    let alice_config = tmp
        .path()
        .join("config")
        .join("characters")
        .join("Alice")
        .join("config.toml");
    std::fs::write(&alice_config, "[defaults]\nstream = true\n").unwrap();
    handler
        .reload_config_from_disk(vec![alice_config.clone()])
        .await;
    {
        let mut registry = handler.registry.lock().await;
        assert!(registry.effective_config("Alice").app.defaults.stream);
    }

    // Now corrupt the overlay with invalid TOML and reload.
    std::fs::write(&alice_config, "this is = not valid TOML [[[").unwrap();
    handler.reload_config_from_disk(vec![alice_config]).await;

    let mut registry = handler.registry.lock().await;
    assert!(
        registry.effective_config("Alice").app.defaults.stream,
        "invalid character overlay should keep the previously merged character config"
    );
}

#[tokio::test]
async fn hot_reload_clears_router_character_when_removed() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let _ = handler
        .session_router
        .set_selected_character(SessionId(1), Some("Alice".into()))
        .await;

    let alice_dir = tmp.path().join("config").join("characters").join("Alice");
    std::fs::remove_dir_all(&alice_dir).unwrap();

    let config_path = tmp.path().join("config").join("config.toml");
    std::fs::write(&config_path, "[defaults]\nstream = false\n").unwrap();
    handler.reload_config_from_disk(vec![config_path]).await;

    let sessions = handler.session_router.sessions().await;
    let stored = sessions
        .into_iter()
        .find(|(id, _)| *id == SessionId(1))
        .map(|(_, c)| c);
    assert_eq!(
        stored,
        Some(None),
        "router should clear the selected character after it is removed"
    );
}

#[tokio::test]
async fn hot_reload_preserves_session_overrides() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    {
        let session = handler.session_state_mut(SessionId(1));
        session.active_model = Some("manual-model".into());
    }

    let config_path = tmp.path().join("config").join("config.toml");
    std::fs::write(&config_path, "[defaults]\nstream = false\n").unwrap();
    handler.reload_config_from_disk(vec![config_path]).await;

    let session = handler.session_state_mut(SessionId(1));
    assert_eq!(session.active_model.as_deref(), Some("manual-model"));
}

#[tokio::test]
async fn hot_reload_does_not_activate_protected_prompt_edits() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let character_data_dir = tmp.path().join("data").join("Alice");
    let workspace_soul = tmp
        .path()
        .join("config")
        .join("characters")
        .join("Alice")
        .join("workspace")
        .join(shore_common::config::SOUL_FILE);
    let active_soul = crate::memory::deferred_edits::active_prompt_file(
        &character_data_dir,
        shore_common::config::SOUL_FILE,
    );

    assert_eq!(
        std::fs::read_to_string(&active_soul).unwrap(),
        "Alice system prompt"
    );
    std::fs::write(&workspace_soul, "edited soul").unwrap();

    let config_path = tmp.path().join("config").join("config.toml");
    std::fs::write(&config_path, "[defaults]\nstream = false\n").unwrap();
    handler.reload_config_from_disk(vec![config_path]).await;

    assert_eq!(
        std::fs::read_to_string(&active_soul).unwrap(),
        "Alice system prompt",
        "hot reload should not refresh protected active_prompt snapshots"
    );
}

#[tokio::test]
async fn config_set_runtime_override_survives_next_command() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;
    let meta = test_request_meta(Some("Alice"), None);

    let result = handler
        .dispatch_command(
            &Command {
                rid: None,
                name: "config".into(),
                args: serde_json::json!({
                    "key": "defaults.stream",
                    "value": "false",
                }),
            },
            &meta,
        )
        .await;

    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.data["set"], "defaults.stream");
            assert_eq!(output.data["value"], false);
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }

    let read_result = handler
        .dispatch_command(
            &Command {
                rid: None,
                name: "config".into(),
                args: serde_json::json!({
                    "key": "defaults",
                    "value": null,
                }),
            },
            &meta,
        )
        .await;

    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match read_result {
        ServerMessage::CommandOutput(output) => {
            assert_eq!(output.data["config"]["stream"], false);
        }
        other => panic!("Expected CommandOutput, got {other:?}"),
    }
}

#[tokio::test]
async fn handle_engine_message_regen_builds_empty_body() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let regen = ClientMessage::Regen(Regen {
        rid: Some("r1".into()),
        stream: false,
        guidance: None,
    });

    let (char_name, effective_config) = {
        let mut registry = handler.registry.lock().await;
        let char_name = registry.resolve_character(Some("Alice")).unwrap();
        let effective_config = registry.effective_config(&char_name).clone();
        (char_name, effective_config)
    };

    #[expect(
        clippy::wildcard_enum_match_arm,
        clippy::unreachable,
        reason = "exhaustive-by-panic test arm"
    )]
    let (body, is_regen) = match regen {
        ClientMessage::Regen(r) => {
            let body = ClientMessageBody {
                rid: r.rid,
                text: String::new(),
                stream: r.stream,
                images: vec![],
                image_data: vec![],
                absence_seconds: None,
                overrides: None,
            };
            (body, true)
        }
        _ => unreachable!(),
    };

    let direct_tx = handler
        .session_router
        .sender_for(SessionId(1))
        .await
        .unwrap();
    let gen_ctx = handler.gen_context(SessionId(1), direct_tx);
    let data_dir = handler.cmd_ctx.data_dir.clone();

    let result = Box::pin(handle_generation(
        gen_ctx,
        GenerationParams {
            request: RequestMeta {
                kind: crate::swp_server::RequestKind::Regen,
                ..test_request_meta(Some("Alice"), Some("r1"))
            },
            body,
            regen: is_regen,
            char_name,
            rid: None,
            effective_config,
            data_dir,
            active_model: None,
            sampler_overlay: crate::preferences::SamplerSettings::default(),
        },
    ))
    .await;

    assert!(result.is_err(), "Expected error due to no model configured");
}

#[tokio::test]
async fn run_cancel_route_aborts_active_generation() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, mut direct_rx) = make_handler(&tmp, &["Alice"]).await;
    let (route_tx, raw_route_rx) = mpsc::channel(4);
    let route_rx = Arc::new(Mutex::new(raw_route_rx));

    handler.session_state_mut(SessionId(1)).generation_handle = Some(tokio::spawn(async {
        tokio::time::sleep(Duration::from_mins(1)).await;
    }));

    let handler_task = tokio::spawn(async move {
        handler.run(route_rx).await;
    });

    route_tx
        .send(RoutedMessage::Engine {
            msg: ClientMessage::Cancel(shore_common::protocol::client_msg::Cancel {}),
            meta: RequestMeta {
                kind: crate::swp_server::RequestKind::Cancel,
                ..test_request_meta(Some("Alice"), None)
            },
        })
        .await
        .unwrap();
    drop(route_tx);

    let msg = direct_rx.recv().await.unwrap();
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "exhaustive-by-panic test arm"
    )]
    match msg {
        ServerMessage::StreamEnd(end) => assert_eq!(end.finish_reason, "cancelled"),
        other => panic!("Expected StreamEnd, got {other:?}"),
    }

    handler_task.await.unwrap();
}

#[test]
fn media_type_for_path_supported() {
    assert_eq!(media_type_for_path("photo.jpg"), Some("image/jpeg"));
    assert_eq!(media_type_for_path("photo.jpeg"), Some("image/jpeg"));
    assert_eq!(media_type_for_path("photo.JPG"), Some("image/jpeg"));
    assert_eq!(media_type_for_path("photo.png"), Some("image/png"));
    assert_eq!(media_type_for_path("photo.gif"), Some("image/gif"));
    assert_eq!(media_type_for_path("photo.webp"), Some("image/webp"));
}

#[test]
fn media_type_for_path_unsupported() {
    assert_eq!(media_type_for_path("photo.bmp"), None);
    assert_eq!(media_type_for_path("photo.tiff"), None);
    assert_eq!(media_type_for_path("file.txt"), None);
    assert_eq!(media_type_for_path("noext"), None);
}

#[test]
fn build_content_text_only() {
    let result = build_content("hello", &[], 0, std::path::Path::new("/tmp"));
    assert_eq!(result, serde_json::json!("hello"));
}

#[test]
fn build_content_with_image() {
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("test.png");
    std::fs::write(&img_path, b"\x89PNG\r\n\x1a\n").unwrap();

    let images = vec![ImageRef {
        path: img_path.to_str().unwrap().to_owned(),
        caption: None,
        data: None,
    }];

    let result = build_content("describe this", &images, 0, tmp.path());
    let blocks = result.as_array().expect("Should be a JSON array");
    assert_eq!(blocks.len(), 2);

    assert_eq!(blocks[0]["type"], "image");
    assert_eq!(blocks[0]["source"]["type"], "base64");
    assert_eq!(blocks[0]["source"]["media_type"], "image/png");
    assert!(!blocks[0]["source"]["data"].as_str().unwrap().is_empty());

    assert_eq!(blocks[1]["type"], "text");
    assert_eq!(blocks[1]["text"], "describe this");
}

#[test]
fn build_content_image_only_omits_blank_text_block() {
    // An image-only message (empty text) must not carry a blank text block —
    // Anthropic rejects `{"type":"text","text":""}` with "text content blocks
    // must be non-empty". Image-only messages persist with empty content_blocks
    // (see build_autonomous_message), so they route through build_content here.
    let tmp = TempDir::new().unwrap();
    let img_path = tmp.path().join("test.png");
    std::fs::write(&img_path, b"\x89PNG\r\n\x1a\n").unwrap();

    let images = vec![ImageRef {
        path: img_path.to_str().unwrap().to_owned(),
        caption: None,
        data: None,
    }];

    let result = build_content("", &images, 0, tmp.path());
    let blocks = result.as_array().expect("Should be a JSON array");
    assert_eq!(blocks.len(), 1, "image-only message carries only the image");
    assert_eq!(blocks[0]["type"], "image");
}

#[test]
fn build_content_skips_unsupported_and_missing() {
    let tmp = TempDir::new().unwrap();
    let images = vec![
        ImageRef {
            path: tmp.path().join("file.bmp").to_str().unwrap().to_owned(),
            caption: None,
            data: None,
        },
        ImageRef {
            path: tmp.path().join("ghost.png").to_str().unwrap().to_owned(),
            caption: None,
            data: None,
        },
    ];

    let result = build_content("text", &images, 0, tmp.path());
    let blocks = result.as_array().expect("Should be a JSON array");
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["type"], "text");
}

fn sse_text_response(text: &str) -> String {
    format!(
        "event: message_start\n\
         data: {{\"type\":\"message_start\",\"message\":{{\"model\":\"test\",\"usage\":{{\"input_tokens\":20}}}}}}\n\n\
         event: content_block_start\n\
         data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n\
         event: content_block_delta\n\
         data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n\
         event: content_block_stop\n\
         data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
         event: message_delta\n\
         data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}},\"usage\":{{\"output_tokens\":10}}}}\n\n\
         event: message_stop\n\
         data: {{\"type\":\"message_stop\"}}\n\n"
    )
}

async fn mock_sse_server(sse_body: String) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{port}");

    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (mut reader, mut writer) = stream.split();
        let mut buf = vec![0_u8; 16384];
        #[expect(
            clippy::let_underscore_must_use,
            reason = "probe read drains the socket; result intentionally ignored"
        )]
        let _ = tokio::io::AsyncReadExt::read(&mut reader, &mut buf).await;

        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: text/event-stream\r\n\
             \r\n\
             {sse_body}"
        );
        writer.write_all(response.as_bytes()).await.unwrap();
        writer.shutdown().await.unwrap();
    });

    (base_url, handle)
}

fn mock_model_catalog(base_url: &str) -> shore_common::config::models::ModelCatalog {
    use shore_common::config::models::{ModelCatalog, ResolvedModel, Sdk};

    let model = ResolvedModel {
        name: "test".into(),
        qualified_name: "anthropic:claude-test".into(),
        category: "chat".into(),
        provider_key: "anthropic".into(),
        sdk: Sdk::Anthropic,
        model_id: "claude-test".into(),
        api_key_env: None,
        base_url: Some(base_url.to_owned()),
        max_context_tokens: None,
        max_output_tokens: Some(4096),
        temperature: Some(0.7),
        top_p: None,
        reasoning_effort: None,
        budget_tokens: None,
        cache_ttl: None,
        cache_keepalive: None,
        openrouter_provider: None,
        vertex_project: None,
        vertex_location: None,
        gemini_generation: None,
        gemini_web_search: None,
        zai_clear_thinking: None,
        zai_subscription: None,
        replay_prior_thinking: None,
        max_tool_iterations: None,
    };

    let mut chat = BTreeMap::new();
    let _ = chat.insert("test".into(), model);
    ModelCatalog {
        chat,
        ..Default::default()
    }
}

async fn make_handler_with_models(
    tmp: &TempDir,
    chars: &[&str],
    models: shore_common::config::models::ModelCatalog,
) -> (
    MessageHandler,
    broadcast::Receiver<ServerMessage>,
    mpsc::Receiver<ServerMessage>,
) {
    let config_dir = tmp.path().join("config");
    let data_dir = tmp.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    for name in chars {
        let char_dir = config_dir.join("characters").join(name);
        std::fs::create_dir_all(&char_dir).unwrap();
        std::fs::write(
            char_dir.join("character.md"),
            format!("You are {name}. Keep responses very short."),
        )
        .unwrap();
    }

    let (push_tx, push_rx) = broadcast::channel(64);
    let (direct_tx, direct_rx) = mpsc::channel(64);
    let server = crate::swp_server::Server::new(crate::swp_server::ServerConfig {
        addr: "127.0.0.1:0".into(),
        allowed_hosts: vec![],
        server_name: "handler-test".into(),
        handshake: None,
    });
    let session_router = server.session_router();
    session_router
        .register_session(
            crate::swp_server::ClientInfo {
                id: 1,
                client_type: "test-client".into(),
                client_name: "test".into(),
                capabilities: vec!["streaming".into()],
                character: None,
            },
            direct_tx,
        )
        .await;

    let mut app_config = shore_common::config::app::AppConfig::default();
    app_config.defaults.model = Some("test".into());
    // Tools are opt-in: the default empty allowlist already disables them.

    let loaded_config = LoadedConfig::new_for_test(
        app_config,
        models,
        shore_common::config::ShoreDirs {
            config: config_dir.clone(),
            data: data_dir.clone(),
            runtime: tmp.path().join("runtime"),
            cache: tmp.path().join("cache"),
        },
    );

    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(());
    let autonomy = AutonomyManager::new(
        AutonomyConfig::default(),
        CompactionConfig::default(),
        data_dir.clone(),
        shutdown_rx,
    );

    let registry = CharacterRegistry::new(
        config_dir,
        data_dir.clone(),
        push_tx.clone(),
        loaded_config.clone(),
    );

    let ledger_client = LedgerClient::new(
        crate::llm::LlmClient::try_new().unwrap(),
        &data_dir.join("ledger.db"),
    )
    .unwrap();

    let cmd_ctx = CommandContext {
        config: loaded_config.clone(),
        config_path: loaded_config.dirs.config.join("config.toml"),
        push_tx: push_tx.clone(),
        data_dir: data_dir.clone(),
        character_name: None,
        active_model: None,
        active_resolved_model: None,
        session_tokens: Arc::new(std::sync::Mutex::new(SessionTokens::default())),
        autonomy: autonomy.clone(),
        llm_client: ledger_client.clone(),
        diagnostics: Arc::new(std::sync::Mutex::new(
            shore_common::diagnostics::Diagnostics::default(),
        )),
    };

    let (_control_tx, control_rx) = mpsc::channel(16);
    let handler = MessageHandler::new(MessageHandlerDeps {
        registry: Arc::new(Mutex::new(registry)),
        cmd_ctx,
        llm_client: ledger_client,
        push_tx: push_tx.clone(),
        session_router,
        autonomy,
        notifier: NotificationService::new(NotificationsConfig::default()),
        mcp_registry: Arc::new(crate::tools::mcp_registry::McpRegistry::default()),
        control_rx,
    });

    (handler, push_rx, direct_rx)
}

#[tokio::test]
#[ignore = "live pipeline test requires an explicit mock/provider run"]
async fn pipeline_user_message_to_persisted_response() {
    let (base_url, _server) = mock_sse_server(sse_text_response("Hello from the mock LLM!")).await;
    let models = mock_model_catalog(&base_url);

    let tmp = TempDir::new().unwrap();
    let (mut handler, mut push_rx, _direct_rx) =
        make_handler_with_models(&tmp, &["Alice"], models).await;

    let (char_name, effective_config) = {
        let mut registry = handler.registry.lock().await;
        let char_name = registry.resolve_character(Some("Alice")).unwrap();
        let effective_config = registry.effective_config(&char_name).clone();
        (char_name, effective_config)
    };

    let body = ClientMessageBody {
        rid: Some("test-rid".into()),
        text: "Hello, Alice!".into(),
        stream: true,
        images: vec![],
        image_data: vec![],
        absence_seconds: None,
        overrides: None,
    };

    let direct_tx = handler
        .session_router
        .sender_for(SessionId(1))
        .await
        .unwrap();
    let gen_ctx = handler.gen_context(SessionId(1), direct_tx);
    let data_dir = handler.cmd_ctx.data_dir.clone();

    let result = Box::pin(handle_generation(
        gen_ctx,
        GenerationParams {
            request: RequestMeta {
                kind: crate::swp_server::RequestKind::Message,
                ..test_request_meta(Some("Alice"), Some("test-rid"))
            },
            body,
            regen: false,
            char_name: char_name.clone(),
            rid: Some("test-rid".into()),
            effective_config,
            data_dir: data_dir.clone(),
            active_model: None,
            sampler_overlay: crate::preferences::SamplerSettings::default(),
        },
    ))
    .await;

    assert!(
        result.is_ok(),
        "Pipeline should succeed: {:?}",
        result.err()
    );

    let engine_arc = {
        let mut registry = handler.registry.lock().await;
        registry.get_or_create(&char_name).unwrap()
    };
    let engine = engine_arc.lock().await;
    let messages = engine.messages();
    assert_eq!(
        messages.len(),
        2,
        "Should have user + assistant messages, got {}",
        messages.len()
    );
    assert_eq!(messages[0].role, Role::User);
    assert_eq!(messages[0].content, "Hello, Alice!");
    assert_eq!(messages[1].role, Role::Assistant);
    assert!(
        messages[1].content.contains("Hello from the mock LLM!"),
        "Assistant content should contain mock response, got: {}",
        messages[1].content
    );

    let active_path = data_dir.join(&char_name).join("active.jsonl");
    assert!(active_path.exists(), "active.jsonl should exist");
    let line_count = std::fs::read_to_string(&active_path)
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty())
        .count();
    assert_eq!(
        line_count, 2,
        "active.jsonl should have 2 lines (user + assistant)"
    );

    let mut new_messages = Vec::new();
    while let Ok(msg) = push_rx.try_recv() {
        if let ServerMessage::NewMessage(new_message) = msg {
            new_messages.push(new_message);
        }
    }
    assert!(
        !new_messages.is_empty(),
        "Should have broadcast at least one NewMessage"
    );
    assert!(new_messages.iter().any(|msg| {
        msg.character.as_deref() == Some("Alice")
            && msg.message.origin == Some(MessageOrigin::UserInput)
    }));
    assert!(new_messages.iter().any(|msg| {
        msg.character.as_deref() == Some("Alice")
            && msg.message.origin == Some(MessageOrigin::AssistantReply)
    }));
}

// ── Stream-fanout / per-character last-user-message lease ──────────────

async fn register_extra_session(
    handler: &MessageHandler,
    id: u64,
) -> mpsc::Receiver<ServerMessage> {
    let (tx, rx) = mpsc::channel(16);
    handler
        .session_router
        .register_session(
            crate::swp_server::ClientInfo {
                id,
                client_type: "test-client".into(),
                client_name: format!("test-{id}"),
                capabilities: vec!["streaming".into()],
                character: None,
            },
            tx,
        )
        .await;
    rx
}

fn meta_for_session(character: Option<&str>, session_id: u64) -> RequestMeta {
    RequestMeta {
        session: crate::swp_server::SessionMeta {
            client_id: crate::swp_server::ClientId(session_id),
            session_id: SessionId(session_id),
            client_type: "test-client".into(),
            client_name: format!("test-{session_id}"),
            capabilities: vec!["streaming".into()],
            selected_character: character.map(str::to_owned),
        },
        rid: None,
        kind: crate::swp_server::RequestKind::Message,
    }
}

fn abort_generation(handler: &mut MessageHandler, session_id: u64) {
    if let Some(handle) = handler
        .session_state_mut(SessionId(session_id))
        .generation_handle
        .take()
    {
        handle.abort();
    }
}

#[tokio::test]
async fn lease_set_on_user_message() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let body = ClientMessageBody {
        rid: Some("r1".into()),
        text: "hi".into(),
        stream: false,
        images: vec![],
        image_data: vec![],
        absence_seconds: None,
        overrides: None,
    };
    handler
        .handle_engine_message(
            ClientMessage::Message(body),
            test_request_meta(Some("Alice"), Some("r1")),
        )
        .await;

    let lease = handler
        .last_user_session
        .get("Alice")
        .copied()
        .expect("user message must seed the lease");
    assert_eq!(lease.session_id, SessionId(1));

    abort_generation(&mut handler, 1);
}

#[tokio::test]
async fn lease_not_updated_by_regen() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let regen = ClientMessage::Regen(Regen {
        rid: Some("r1".into()),
        stream: false,
        guidance: None,
    });
    handler
        .handle_engine_message(regen, test_request_meta(Some("Alice"), Some("r1")))
        .await;

    assert!(
        !handler.last_user_session.contains_key("Alice"),
        "Regen alone must not create a lease"
    );

    abort_generation(&mut handler, 1);
}

#[tokio::test]
async fn resolve_lease_skips_self() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let _ = handler.last_user_session.insert(
        "Alice".into(),
        LastUserLease {
            session_id: SessionId(1),
            expires_at: Instant::now() + LEASE_TTL,
        },
    );

    assert!(
        handler
            .resolve_lease_tx(SessionId(1), "Alice")
            .await
            .is_none(),
        "Same-session lease must not fan out to itself"
    );
}

#[tokio::test]
async fn resolve_lease_evicts_expired() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let _rx_b = register_extra_session(&handler, 2).await;
    let _ = handler.last_user_session.insert(
        "Alice".into(),
        LastUserLease {
            session_id: SessionId(2),
            expires_at: Instant::now().checked_sub(Duration::from_secs(1)).unwrap(),
        },
    );

    assert!(
        handler
            .resolve_lease_tx(SessionId(1), "Alice")
            .await
            .is_none(),
        "Expired lease must not be used"
    );
    assert!(
        !handler.last_user_session.contains_key("Alice"),
        "Expired lease must be evicted lazily"
    );
}

#[tokio::test]
async fn resolve_lease_evicts_disconnected_session() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;

    let _ = handler.last_user_session.insert(
        "Alice".into(),
        LastUserLease {
            session_id: SessionId(99),
            expires_at: Instant::now() + LEASE_TTL,
        },
    );

    assert!(
        handler
            .resolve_lease_tx(SessionId(1), "Alice")
            .await
            .is_none(),
        "Lease pointing at unknown session must yield None"
    );
    assert!(
        !handler.last_user_session.contains_key("Alice"),
        "Stale lease must be evicted lazily"
    );
}

#[tokio::test]
async fn fanout_forwards_to_lease_holder_when_different_session() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, mut rx_a) = make_handler(&tmp, &["Alice"]).await;
    let mut rx_b = register_extra_session(&handler, 2).await;

    let _ = handler.last_user_session.insert(
        "Alice".into(),
        LastUserLease {
            session_id: SessionId(2),
            expires_at: Instant::now() + LEASE_TTL,
        },
    );

    let issuer_tx = handler
        .session_router
        .sender_for(SessionId(1))
        .await
        .unwrap();
    let fan_tx = handler
        .build_fanout_tx(SessionId(1), "Alice", issuer_tx)
        .await;

    let probe = ServerMessage::CommandOutput(shore_common::protocol::server_msg::CommandOutput {
        rid: None,
        name: "probe".into(),
        data: serde_json::json!({"ok": true}),
    });
    fan_tx.send(probe).await.unwrap();

    let from_a = rx_a.recv().await.unwrap();
    let from_b = rx_b.recv().await.unwrap();
    assert!(matches!(from_a, ServerMessage::CommandOutput(ref o) if o.name == "probe"));
    assert!(matches!(from_b, ServerMessage::CommandOutput(ref o) if o.name == "probe"));
}

#[tokio::test]
async fn fanout_skips_lease_when_issuer_is_lease_holder() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, mut rx_a) = make_handler(&tmp, &["Alice"]).await;
    let mut rx_b = register_extra_session(&handler, 2).await;

    let _ = handler.last_user_session.insert(
        "Alice".into(),
        LastUserLease {
            session_id: SessionId(1),
            expires_at: Instant::now() + LEASE_TTL,
        },
    );

    let issuer_tx = handler
        .session_router
        .sender_for(SessionId(1))
        .await
        .unwrap();
    let fan_tx = handler
        .build_fanout_tx(SessionId(1), "Alice", issuer_tx)
        .await;

    let probe = ServerMessage::CommandOutput(shore_common::protocol::server_msg::CommandOutput {
        rid: None,
        name: "probe".into(),
        data: serde_json::json!({}),
    });
    fan_tx.send(probe).await.unwrap();

    let from_a = rx_a.recv().await.unwrap();
    assert!(matches!(from_a, ServerMessage::CommandOutput(_)));
    assert!(
        rx_b.try_recv().is_err(),
        "Other session must not receive when issuer == lease holder"
    );
}

#[tokio::test]
async fn cross_session_user_message_transfers_lease() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _rx_a) = make_handler(&tmp, &["Alice"]).await;
    let _rx_b = register_extra_session(&handler, 2).await;

    let body_a = ClientMessageBody {
        rid: Some("ra".into()),
        text: "from a".into(),
        stream: false,
        images: vec![],
        image_data: vec![],
        absence_seconds: None,
        overrides: None,
    };
    handler
        .handle_engine_message(
            ClientMessage::Message(body_a),
            test_request_meta(Some("Alice"), Some("ra")),
        )
        .await;
    abort_generation(&mut handler, 1);

    let body_b = ClientMessageBody {
        rid: Some("rb".into()),
        text: "from b".into(),
        stream: false,
        images: vec![],
        image_data: vec![],
        absence_seconds: None,
        overrides: None,
    };
    handler
        .handle_engine_message(
            ClientMessage::Message(body_b),
            meta_for_session(Some("Alice"), 2),
        )
        .await;
    abort_generation(&mut handler, 2);

    let lease = handler
        .last_user_session
        .get("Alice")
        .copied()
        .expect("lease should still be set");
    assert_eq!(
        lease.session_id,
        SessionId(2),
        "Lease should transfer to the most recent user-message sender"
    );
}

#[tokio::test]
async fn all_clients_disconnected_clears_leases() {
    let tmp = TempDir::new().unwrap();
    let (mut handler, _push_rx, _direct_rx) = make_handler(&tmp, &["Alice"]).await;
    let (route_tx, raw_route_rx) = mpsc::channel(4);
    let route_rx = Arc::new(Mutex::new(raw_route_rx));

    let _ = handler.last_user_session.insert(
        "Alice".into(),
        LastUserLease {
            session_id: SessionId(1),
            expires_at: Instant::now() + LEASE_TTL,
        },
    );

    let leases_clear: Arc<std::sync::Mutex<Option<bool>>> = Arc::new(std::sync::Mutex::new(None));
    let probe = Arc::clone(&leases_clear);

    let handler_task = tokio::spawn(async move {
        handler.run(route_rx).await;
        *probe.lock().unwrap() = Some(handler.last_user_session.is_empty());
    });

    route_tx
        .send(RoutedMessage::AllClientsDisconnected)
        .await
        .unwrap();
    drop(route_tx);

    handler_task.await.unwrap();
    assert_eq!(
        *leases_clear.lock().unwrap(),
        Some(true),
        "AllClientsDisconnected should clear all leases"
    );
}
