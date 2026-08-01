pub mod conversation;
pub mod navigation;
pub mod providers;
pub mod state;
pub mod usage;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use shore_common::protocol::client_msg::Command;
use shore_common::protocol::error::ErrorCode;
use shore_common::protocol::server_msg::{CommandOutput, Error, ServerMessage};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use crate::autonomy::manager::AutonomyManager;
use crate::engine::{ConversationEngine, EngineError};
use crate::ledger::LedgerClient;
use shore_common::config::LoadedConfig;
use shore_common::diagnostics::Diagnostics;

/// Cumulative token usage tracked across the daemon session.
#[derive(Debug, Default)]
pub struct SessionTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// Shared state for command handlers (does not own the engine).
#[derive(Debug)]
pub struct CommandContext {
    /// Loaded configuration.
    pub config: LoadedConfig,
    /// Config file path used to load the daemon.
    pub config_path: PathBuf,
    /// Broadcast sender for push messages.
    pub push_tx: broadcast::Sender<ServerMessage>,
    /// Data directory (`$XDG_DATA_HOME/shore/`).
    pub data_dir: PathBuf,
    /// Resolved character name for this command, if any. `None` for
    /// characterless commands like `list_characters` / `list_models`.
    /// Used by Phase 3+ commands to locate per-character preferences.
    pub character_name: Option<String>,
    /// Currently active model name (resolved qualified_name).
    /// Phase 3+ this is sourced from preferences, not from
    /// `runtime_state.json`; the field is kept as a session-level cache.
    pub active_model: Option<String>,
    /// Pre-resolved active model paired with `active_model`. The dispatcher
    /// populates this from preferences so command handlers don't have to
    /// round-trip through `find_effective_model` — discovered models have
    /// a synthetic `qualified_name` that the resolver does not accept as
    /// input. `None` falls back to resolving by `active_model` string.
    pub active_resolved_model: Option<shore_common::config::models::ResolvedModel>,
    /// Cumulative token usage for the session (shared with generation tasks).
    pub session_tokens: Arc<Mutex<SessionTokens>>,
    /// Shared autonomy manager for scheduler state.
    pub autonomy: AutonomyManager,
    /// LLM client for commands that need model access.
    pub llm_client: LedgerClient,
    /// In-memory diagnostics ring buffers.
    pub diagnostics: Arc<Mutex<Diagnostics>>,
}

/// Convenience type for command handler results.
pub type CommandResult = Result<serde_json::Value, (ErrorCode, String)>;

/// Dispatch a command to the appropriate handler.
pub async fn dispatch(
    engine_arc: Arc<tokio::sync::Mutex<ConversationEngine>>,
    ctx: &mut CommandContext,
    cmd: &Command,
) -> ServerMessage {
    info!(command = %cmd.name, "Dispatching command");

    let mut guard = engine_arc.lock().await;
    let engine = &mut *guard;

    let result = match cmd.name.as_str() {
        // Navigation
        "list_characters" => navigation::list_characters(engine, ctx),
        "switch_character" => navigation::switch_character(engine, ctx, &cmd.args),
        "character_info" => navigation::character_info(engine, ctx, &cmd.args),

        // Conversation
        "log" => conversation::log(engine, ctx, &cmd.args),
        "history_page" => conversation::history_page(engine, ctx, &cmd.args),
        "get" => conversation::get(engine, ctx, &cmd.args),
        "edit" => conversation::edit(engine, ctx, &cmd.args),
        "delete" => conversation::delete(engine, ctx, &cmd.args),
        "alt" => conversation::alt(engine, ctx, &cmd.args),
        "list_alternatives" => conversation::list_alternatives(engine, ctx, &cmd.args),
        "inject_system" => conversation::inject_system(engine, ctx, &cmd.args),

        // State
        "status" => state::status(engine, ctx),
        "list_models" => state::list_models_with_args(ctx, &cmd.args),
        "model_info" => state::model_info(ctx, &cmd.args),
        "switch_model" => state::switch_model(ctx, &cmd.args),
        "reset_model" => state::reset_model(ctx),
        "set_model_setting" => state::set_model_setting(ctx, &cmd.args),
        "model_settings" => state::model_settings(ctx, &cmd.args),
        "background_models" => state::background_models(ctx),
        "memory_changelog" => state::memory_changelog(engine, ctx, &cmd.args),
        "memory" => state::memory(engine, ctx, &cmd.args).await,
        "compact" => state::compact(engine, ctx, &cmd.args).await,
        "config" => state::config(ctx, &cmd.args),
        "tools" => state::tools(ctx),
        "config_check" => state::config_check(ctx).await,
        "config_reload" => state::config_reload(ctx, &cmd.args),
        "config_reset" => state::config_reset(ctx),
        "diagnostics" => state::diagnostics(ctx, &cmd.args),
        "heartbeat_log" => state::heartbeat_log(engine, ctx, &cmd.args),
        "call_log" => state::call_log(engine, ctx, &cmd.args),
        "transcript" => state::transcript(engine, ctx, &cmd.args),
        "heartbeat_tick_now" => state::heartbeat_tick_now(engine, ctx),
        "keepalive_ping_now" => state::keepalive_ping_now(engine, ctx).await,
        "heartbeat_set_dormant" => state::heartbeat_set_dormant(engine, ctx),
        "heartbeat_set_active" => state::heartbeat_set_active(engine, ctx),
        "usage" => usage::usage(ctx, &cmd.args).await,

        // Provider discovery
        "list_providers" => providers::list_providers(ctx),
        "refresh_provider_models" => providers::refresh_provider_models(ctx, &cmd.args).await,
        "refresh_all_provider_models" => providers::refresh_all_provider_models(ctx).await,
        "list_provider_models" => providers::list_provider_models(ctx, &cmd.args),

        _ => Err((
            ErrorCode::InvalidRequest,
            format!("Unknown command: {}", cmd.name),
        )),
    };

    match result {
        Ok(data) => ServerMessage::CommandOutput(CommandOutput {
            rid: None,
            name: cmd.name.clone(),
            data,
        }),
        Err((code, message)) => {
            warn!(command = %cmd.name, ?code, %message, "Command failed");
            ServerMessage::Error(Error {
                rid: None,
                code,
                message,
            })
        }
    }
}

/// Dispatch commands that don't require a character/engine (e.g. list_characters).
pub fn dispatch_characterless(ctx: &CommandContext, cmd: &Command) -> CommandResult {
    debug!(command = %cmd.name, "Dispatching characterless command");
    match cmd.name.as_str() {
        "list_characters" => navigation::list_characters_standalone(ctx),
        "list_models" => state::list_models_with_args(ctx, &cmd.args),
        "background_models" => state::background_models(ctx),
        "list_providers" => providers::list_providers(ctx),
        "list_provider_models" => providers::list_provider_models(ctx, &cmd.args),
        _ => Err((
            ErrorCode::InvalidRequest,
            format!("Command '{}' requires a character", cmd.name),
        )),
    }
}

/// Convert an EngineError to a command error tuple.
pub fn engine_err(e: EngineError) -> (ErrorCode, String) {
    match e {
        EngineError::MessageNotFound(message) => {
            (ErrorCode::NotFound, format!("message not found: {message}"))
        }
        EngineError::CharacterNotFound(character) => (
            ErrorCode::NotFound,
            format!("character not found: {character}"),
        ),
        EngineError::InvalidAlt(message) => (ErrorCode::InvalidRequest, message),
        other @ (EngineError::Io { .. }
        | EngineError::JsonParse { .. }
        | EngineError::JsonSerialize { .. }) => (ErrorCode::InternalError, other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shore_common::config::app::{AutonomyConfig, CompactionConfig};
    use shore_common::protocol::client_msg::Command;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    fn make_ctx(
        tmp: &tempfile::TempDir,
    ) -> (
        ConversationEngine,
        CommandContext,
        broadcast::Receiver<ServerMessage>,
    ) {
        let (push_tx, push_rx) = broadcast::channel(16);
        let data_dir = tmp.path().to_path_buf();
        let engine =
            ConversationEngine::new("TestChar".to_owned(), data_dir.clone(), push_tx.clone())
                .unwrap();

        let config = LoadedConfig::new_for_test(
            shore_common::config::app::AppConfig::default(),
            shore_common::config::models::ModelCatalog::default(),
            shore_common::config::ShoreDirs {
                config: tmp.path().join("config"),
                data: data_dir.clone(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );

        let (_tx, rx) = tokio::sync::watch::channel(());
        let autonomy = AutonomyManager::new(
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
            session_tokens: Arc::new(Mutex::new(SessionTokens::default())),
            autonomy,
            llm_client: LedgerClient::new(
                crate::llm::LlmClient::try_new().unwrap(),
                &data_dir.join("ledger.db"),
            )
            .unwrap(),
            diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
        };
        (engine, ctx, push_rx)
    }

    #[tokio::test]
    async fn unknown_command_returns_invalid_request() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, mut ctx, _rx) = make_ctx(&tmp);
        let engine_arc = Arc::new(tokio::sync::Mutex::new(engine));

        let cmd = Command {
            rid: None,
            name: "bogus_command".into(),
            args: serde_json::json!({}),
        };

        let result = dispatch(engine_arc, &mut ctx, &cmd).await;
        assert_variant!(
            result,
            ServerMessage::Error(e) => {
                assert_eq!(e.code, ErrorCode::InvalidRequest);
                assert!(e.message.contains("bogus_command"));
            }
        );
    }

    #[tokio::test]
    async fn dispatch_returns_command_output_with_name() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, mut ctx, _rx) = make_ctx(&tmp);
        let engine_arc = Arc::new(tokio::sync::Mutex::new(engine));

        let cmd = Command {
            rid: None,
            name: "status".into(),
            args: serde_json::json!({}),
        };

        let result = dispatch(engine_arc, &mut ctx, &cmd).await;
        assert_variant!(

            result,
            ServerMessage::CommandOutput(output) => {
                assert_eq!(output.name, "status");
                assert!(output.data.is_object());
            }

        );
    }

    // ── dispatch_characterless ───────────────────────────────────────────

    #[test]
    fn dispatch_characterless_list_characters() {
        let tmp = tempfile::tempdir().unwrap();

        // Create a character directory so list_characters finds something.
        let char_dir = tmp.path().join("config").join("characters").join("alice");
        let workspace_dir = char_dir.join("workspace");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::write(workspace_dir.join("SOUL.md"), "Alice").unwrap();

        // Data-only directories are cache/runtime state, not character
        // definitions, and should not leak into connector menus.
        std::fs::create_dir_all(tmp.path().join("debug")).unwrap();

        let (_engine, ctx, _rx) = make_ctx(&tmp);

        let cmd = Command {
            rid: None,
            name: "list_characters".into(),
            args: serde_json::json!({}),
        };

        let result = dispatch_characterless(&ctx, &cmd);
        assert!(result.is_ok());
        let data = result.unwrap();
        let names: Vec<&str> = data["characters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["alice"]);
    }

    #[test]
    fn dispatch_characterless_rejects_unknown_command() {
        let tmp = tempfile::tempdir().unwrap();
        let (_engine, ctx, _rx) = make_ctx(&tmp);

        let cmd = Command {
            rid: None,
            name: "status".into(),
            args: serde_json::json!({}),
        };

        let result = dispatch_characterless(&ctx, &cmd);
        assert!(result.is_err());
        let (code, msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
        assert!(msg.contains("requires a character"));
    }
}
