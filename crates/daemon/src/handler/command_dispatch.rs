use std::sync::Arc;

use serde_json::json;
use tokio::sync::mpsc;

use crate::swp_server::{RequestMeta, SessionId};
use shore_common::config::character_data_dir;
use shore_common::protocol::error::ErrorCode;
use shore_common::protocol::server_msg::{Error as SwpError, ServerMessage};
use tracing::{debug, info};

use crate::commands::{self, CommandContext};
use crate::handshake::build_session_history_snapshot;
use crate::preferences;
use crate::runtime_state::load_active_model;

use super::{GenContext, MessageHandler, RuntimeReloadSource};

impl MessageHandler {
    /// Cancel any active generation task and send a minimal StreamEnd.
    pub(super) async fn cancel_generation(
        &mut self,
        session_id: SessionId,
        rid: Option<String>,
        reason: &str,
    ) {
        if let Some(handle) = self.session_state_mut(session_id).generation_handle.take() {
            info!(reason, "Cancelling active generation");
            handle.abort();
            let _ignored = self
                .session_router
                .send_to_session(
                    session_id,
                    ServerMessage::StreamEnd(shore_common::protocol::server_msg::StreamEnd {
                        subagent: None,
                        rid: None,
                        msg_id: None,
                        revision: None,
                        content: String::new(),
                        metadata: shore_common::protocol::types::StreamMetadata {
                            tokens: shore_common::protocol::types::TokenCounts {
                                input: 0,
                                output: 0,
                                cache_read: 0,
                                cache_write: 0,
                            },
                            timing: shore_common::protocol::types::TimingInfo {
                                total_ms: 0,
                                ttft_ms: 0,
                            },
                            model: String::new(),
                        },
                        finish_reason: "cancelled".into(),
                        is_final: true,
                    })
                    .with_rid(rid),
                )
                .await;
        }
    }

    /// Build a GenContext from the current handler state.
    pub(super) fn gen_context(
        &mut self,
        session_id: SessionId,
        direct_tx: mpsc::Sender<ServerMessage>,
    ) -> GenContext {
        let session_tokens = Arc::clone(&self.session_state_mut(session_id).session_tokens);
        GenContext {
            registry: Arc::clone(&self.registry),
            llm_client: self.llm_client.clone(),
            event_tx: self.push_tx.clone(),
            direct_tx,
            autonomy: self.autonomy.clone(),
            session_tokens,
            diagnostics: Arc::clone(&self.cmd_ctx.diagnostics),
            notifier: self.notifier.clone(),
            mcp_registry: Arc::clone(&self.mcp_registry),
        }
    }

    /// Resolve the engine for a character and dispatch a command.
    pub(super) async fn dispatch_command(
        &mut self,
        cmd: &shore_common::protocol::client_msg::Command,
        meta: &RequestMeta,
    ) -> ServerMessage {
        debug!(
            command = %cmd.name,
            client_id = meta.session.client_id.0,
            session_id = meta.session.session_id.0,
            client_type = %meta.session.client_type,
            rid = meta.rid.as_deref().unwrap_or("-"),
            character = ?meta.session.selected_character,
            "dispatching command"
        );
        let session_id = meta.session.session_id;
        // `list_characters` reads from the global config and never touches
        // a character engine, so it bypasses character resolution. `list_models`
        // stays characterless only when no session character is selected; once
        // a character is selected, it must flow through the character-aware path
        // below so its `active` field matches preferences/default resolution.
        // This still lets `shore complete models` succeed on a multi-character
        // config before a character has been selected. Provider listing commands
        // (`list_providers`, `list_provider_models`) are similarly
        // characterless and sync.
        //
        // `refresh_provider_models` is also character-agnostic but async
        // (network I/O), so it gets its own bypass below.
        if cmd.name == "refresh_provider_models" {
            return self
                .run_refresh_provider_models(cmd, meta, session_id)
                .await;
        }

        let characterless_list_models =
            cmd.name == "list_models" && meta.session.selected_character.is_none();
        if cmd.name == "list_characters"
            || characterless_list_models
            || matches!(cmd.name.as_str(), "list_providers" | "list_provider_models")
        {
            return self.run_characterless_command(cmd, session_id);
        }

        let (char_name, engine_arc, effective_config) =
            match self.resolve_command_character(meta).await {
                Ok(resolved) => resolved,
                Err(err) => return err,
            };

        let mut cmd_ctx =
            self.build_character_command_context(&char_name, effective_config, session_id);

        let mut result = commands::dispatch(Arc::clone(&engine_arc), &mut cmd_ctx, cmd)
            .await
            .with_rid(meta.rid.clone());
        let runtime_config_set = cmd.name == "config"
            && cmd
                .args
                .get("value")
                .and_then(serde_json::Value::as_str)
                .is_some();
        // Phase 3: model selection persistence is owned by individual
        // commands that write to `<data_dir>/<char>/preferences/models.toml`.
        // The dispatcher only mirrors the post-command state into the
        // session cache.
        let active_model_after_command = cmd_ctx.active_model.clone();

        {
            let session = self.session_state_mut(session_id);
            session.active_model.clone_from(&active_model_after_command);
        }

        if runtime_config_set {
            self.post_process_runtime_config_set(&char_name, &cmd_ctx, &mut result)
                .await;
        }

        if cmd.name == "config_reset" {
            self.post_process_config_reset(&cmd_ctx, &mut result).await;
        }

        if cmd.name == "config_reload" {
            self.post_process_config_reload(&cmd_ctx, &mut result).await;
        }

        if cmd.name == "switch_character" {
            self.post_process_switch_character(meta, session_id, &mut result)
                .await;
        }

        result
    }

    /// Build a characterless `CommandContext` and run the async,
    /// character-agnostic `refresh_provider_models` command.
    async fn run_refresh_provider_models(
        &mut self,
        cmd: &shore_common::protocol::client_msg::Command,
        meta: &RequestMeta,
        session_id: SessionId,
    ) -> ServerMessage {
        let ctx = CommandContext {
            config: self.cmd_ctx.config.clone(),
            config_path: self.cmd_ctx.config_path.clone(),
            push_tx: self.push_tx.clone(),
            data_dir: self.cmd_ctx.data_dir.clone(),
            character_name: None,
            active_model: None,
            active_resolved_model: None,
            session_tokens: Arc::clone(&self.session_state_mut(session_id).session_tokens),
            autonomy: self.cmd_ctx.autonomy.clone(),
            llm_client: self.cmd_ctx.llm_client.clone(),
            diagnostics: Arc::clone(&self.cmd_ctx.diagnostics),
        };
        match commands::providers::refresh_provider_models(&ctx, &cmd.args).await {
            Ok(data) => {
                ServerMessage::CommandOutput(shore_common::protocol::server_msg::CommandOutput {
                    rid: None,
                    name: cmd.name.clone(),
                    data,
                })
            }
            Err((code, msg)) => ServerMessage::Error(SwpError {
                rid: None,
                code,
                message: msg,
            }),
        }
        .with_rid(meta.rid.clone())
    }

    /// Run a characterless command (`list_characters`, characterless
    /// `list_models`, `list_providers`, `list_provider_models`) and mirror the
    /// resolved active model back into the session cache.
    fn run_characterless_command(
        &mut self,
        cmd: &shore_common::protocol::client_msg::Command,
        session_id: SessionId,
    ) -> ServerMessage {
        let (active_model, session_tokens) = {
            let session = self.session_state_mut(session_id);
            (
                session.active_model.clone(),
                Arc::clone(&session.session_tokens),
            )
        };
        let ctx = CommandContext {
            config: self.cmd_ctx.config.clone(),
            config_path: self.cmd_ctx.config_path.clone(),
            push_tx: self.push_tx.clone(),
            data_dir: self.cmd_ctx.data_dir.clone(),
            character_name: None,
            active_model,
            active_resolved_model: None,
            session_tokens,
            autonomy: self.cmd_ctx.autonomy.clone(),
            llm_client: self.cmd_ctx.llm_client.clone(),
            diagnostics: Arc::clone(&self.cmd_ctx.diagnostics),
        };
        let result = commands::dispatch_characterless(&ctx, cmd);
        {
            let session = self.session_state_mut(session_id);
            session.active_model.clone_from(&ctx.active_model);
        }
        match result {
            Ok(data) => {
                ServerMessage::CommandOutput(shore_common::protocol::server_msg::CommandOutput {
                    rid: None,
                    name: cmd.name.clone(),
                    data,
                })
            }
            Err((code, msg)) => ServerMessage::Error(SwpError {
                rid: None,
                code,
                message: msg,
            }),
        }
    }

    /// Resolve the session's selected character to its engine and effective
    /// config, returning a ready-to-send error `ServerMessage` on failure.
    async fn resolve_command_character(
        &mut self,
        meta: &RequestMeta,
    ) -> Result<
        (
            String,
            Arc<tokio::sync::Mutex<crate::engine::ConversationEngine>>,
            shore_common::config::LoadedConfig,
        ),
        ServerMessage,
    > {
        let mut registry = self.registry.lock().await;

        let char_name = match registry.resolve_character(meta.session.selected_character.as_deref())
        {
            Ok(name) => name,
            Err(e) => {
                return Err(ServerMessage::Error(SwpError {
                    rid: None,
                    code: ErrorCode::InvalidRequest,
                    message: e.to_string(),
                })
                .with_rid(meta.rid.clone()));
            }
        };

        let effective_config = registry.effective_config(&char_name).clone();

        let engine_arc = match registry.get_or_create(&char_name) {
            Ok(arc) => arc,
            Err(e) => {
                return Err(ServerMessage::Error(SwpError {
                    rid: None,
                    code: ErrorCode::InternalError,
                    message: e.to_string(),
                })
                .with_rid(meta.rid.clone()));
            }
        };

        Ok((char_name, engine_arc, effective_config))
    }

    /// Build the character-scoped `CommandContext`, resolving the persisted
    /// active model from preferences (with a one-release legacy fallback).
    fn build_character_command_context(
        &mut self,
        char_name: &str,
        effective_config: shore_common::config::LoadedConfig,
        session_id: SessionId,
    ) -> CommandContext {
        let character_data_dir = character_data_dir(&self.cmd_ctx.data_dir, char_name);
        // Phase 3: preferences are the durable source of truth for the
        // active model. Legacy `runtime_state.json` is read as a one-
        // release migration fallback so users who haven't written
        // preferences yet keep their selection across this upgrade.
        let persisted_active_resolved = {
            let data_dir = &self.cmd_ctx.data_dir;
            let (global_prefs, char_prefs) = preferences::load_for_character(data_dir, char_name)
                .unwrap_or_else(|e| {
                    tracing::warn!(error = %e, character = %char_name, "Failed to load preferences; using empty defaults");
                    (
                        preferences::ModelPreferences::default(),
                        preferences::ModelPreferences::default(),
                    )
                });
            let legacy = load_active_model(&character_data_dir);
            preferences::resolve_active_for_character(
                &effective_config,
                data_dir,
                &global_prefs,
                &char_prefs,
                legacy.as_deref(),
                effective_config.app.defaults.model.as_deref(),
            )
        };
        let persisted_active_model = persisted_active_resolved
            .as_ref()
            .map(|m| m.qualified_name.clone());

        let session_tokens = Arc::clone(&self.session_state_mut(session_id).session_tokens);

        CommandContext {
            config: effective_config,
            config_path: self.cmd_ctx.config_path.clone(),
            push_tx: self.push_tx.clone(),
            data_dir: self.cmd_ctx.data_dir.clone(),
            character_name: Some(char_name.to_owned()),
            active_model: persisted_active_model,
            active_resolved_model: persisted_active_resolved,
            session_tokens,
            autonomy: self.cmd_ctx.autonomy.clone(),
            llm_client: self.cmd_ctx.llm_client.clone(),
            diagnostics: Arc::clone(&self.cmd_ctx.diagnostics),
        }
    }

    /// Post-process a runtime `config` set: push the merged config into the
    /// registry + autonomy managers and annotate the response's `invalidated`
    /// map.
    async fn post_process_runtime_config_set(
        &mut self,
        char_name: &str,
        cmd_ctx: &CommandContext,
        result: &mut ServerMessage,
    ) {
        if let ServerMessage::CommandOutput(output) = result {
            let runtime_config = cmd_ctx.config.clone();
            {
                let mut registry = self.registry.lock().await;
                registry.set_runtime_effective_config(char_name, runtime_config.clone());
            }
            self.autonomy.reload_runtime_config(runtime_config.clone());
            self.cmd_ctx
                .autonomy
                .reload_runtime_config(runtime_config.clone());

            if let Some(data) = output.data.as_object_mut() {
                if !data
                    .get("invalidated")
                    .is_some_and(serde_json::Value::is_object)
                {
                    let _ignored = data.insert("invalidated".into(), json!({}));
                }
                if let Some(inv) = data
                    .get_mut("invalidated")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    let _ignored = inv.insert("merged_character_configs".into(), json!(true));
                }
            }
        }
    }

    /// Post-process a `config_reset`: reload the on-disk config and annotate the
    /// response's `invalidated` map with discovery/engine changes.
    async fn post_process_config_reset(
        &mut self,
        cmd_ctx: &CommandContext,
        result: &mut ServerMessage,
    ) {
        if let ServerMessage::CommandOutput(output) = result {
            let reloaded_config = cmd_ctx.config.clone();
            self.cmd_ctx.active_model = None;
            let summary = self
                .apply_reloaded_config(reloaded_config, RuntimeReloadSource::ManualReset)
                .await;

            if let Some(data) = output.data.as_object_mut() {
                if !data
                    .get("invalidated")
                    .is_some_and(serde_json::Value::is_object)
                {
                    let _ignored = data.insert("invalidated".into(), json!({}));
                }
                if let Some(inv) = data
                    .get_mut("invalidated")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    let _ignored = inv.insert(
                        "character_discovery".into(),
                        json!(summary.character_discovery_changed),
                    );
                    _ = inv.insert("merged_character_configs".into(), json!(true));
                    _ = inv.insert(
                        "removed_character_engines".into(),
                        json!(summary.dropped_engines),
                    );
                }
            }
        }
    }

    /// Post-process a `config_reload`: annotate `restart_required` (computed
    /// global-to-global against the handler's pre-reload config — the command
    /// context only sees the character-merged config) and, for applied
    /// reloads, propagate the fresh config to handler-owned runtime state
    /// (registry, MCP, autonomy) same as hot reload. Unlike `config_reset`,
    /// the session's runtime overrides are preserved.
    async fn post_process_config_reload(
        &mut self,
        cmd_ctx: &CommandContext,
        result: &mut ServerMessage,
    ) {
        if let ServerMessage::CommandOutput(output) = result {
            let applied = output
                .data
                .get("applied")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);

            // On apply the command context already holds the fresh global
            // config; on check it still holds the merged config, so re-read
            // the (just-validated) file. A racing edit that breaks it now
            // just drops the annotation.
            let maybe_fresh = if applied {
                Some(cmd_ctx.config.clone())
            } else {
                shore_common::config::load_config(Some(&self.cmd_ctx.config_path)).ok()
            };
            if let Some(fresh) = maybe_fresh {
                let restart_required =
                    super::restart_required_changes(&self.cmd_ctx.config, &fresh);
                if let Some(data) = output.data.as_object_mut() {
                    let _ignored = data.insert("restart_required".into(), json!(restart_required));
                }
                if applied {
                    let summary = self
                        .apply_reloaded_config(fresh, RuntimeReloadSource::ManualReload)
                        .await;
                    if let Some(data) = output.data.as_object_mut() {
                        let _ignored = data.insert(
                            "invalidated".into(),
                            json!({
                                "character_discovery": summary.character_discovery_changed,
                                "merged_character_configs": true,
                                "removed_character_engines": summary.dropped_engines,
                            }),
                        );
                    }
                }
            }
        }
    }

    /// Post-process a `switch_character`: update the session's selected
    /// character, fold the new character's snapshot into the response, and push
    /// a fresh `History` to the session.
    async fn post_process_switch_character(
        &mut self,
        meta: &RequestMeta,
        session_id: SessionId,
        result: &mut ServerMessage,
    ) {
        if let ServerMessage::CommandOutput(output) = result {
            let selected_opt = output
                .data
                .get("character")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if let Some(selected) = selected_opt {
                let _ignored = self
                    .session_router
                    .set_selected_character(session_id, Some(selected.clone()))
                    .await;

                let snapshot = build_session_history_snapshot(
                    Arc::clone(&self.registry),
                    Some(selected.clone()),
                    None,
                )
                .await;

                if let Some(data) = output.data.as_object_mut() {
                    _ = data.insert(
                        "selected_character".into(),
                        serde_json::Value::String(selected.clone()),
                    );
                    _ = data.insert(
                        "active_model".into(),
                        snapshot
                            .config
                            .get("active_model")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    );
                }

                _ = self
                    .session_router
                    .send_to_session(
                        session_id,
                        ServerMessage::History(shore_common::protocol::server_msg::History {
                            rid: None,
                            messages: snapshot.messages,
                            active_start: snapshot.active_start,
                            config: snapshot.config,
                            selected_character: snapshot.selected_character,
                            revision: snapshot.revision,
                        })
                        .with_rid(meta.rid.clone()),
                    )
                    .await;
            }
        }
    }
}
