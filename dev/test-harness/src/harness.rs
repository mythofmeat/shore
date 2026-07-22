use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use shore_config::{app::NotificationsConfig, LoadedConfig};
use shore_daemon::autonomy::manager::AutonomyManager;
use shore_daemon::characters::CharacterRegistry;
use shore_daemon::commands::{CommandContext, SessionTokens};
use shore_daemon::handler::{MessageHandler, MessageHandlerDeps};
use shore_daemon::handshake::build_handshake_provider;
use shore_ledger::LedgerClient;
use shore_llm::LlmClient;
use shore_protocol::server_msg::{ServerHello, ServerMessage};
use shore_swp_client::connection::{SWPConnection, ServerAddr};
use shore_swp_server::{Server, ServerConfig};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::info;

use crate::collected::CollectedResponse;
use crate::config::TestConfigBuilder;
use crate::mock_llm::MockLlmSidecar;

/// Timeout for collecting a full streamed response.
const COLLECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for command responses (local, no LLM call).
const CMD_TIMEOUT: Duration = Duration::from_secs(5);

/// Boots a real daemon in-process with a mock LLM backend and provides
/// a connected SWP client with send/collect helpers.
#[derive(Debug)]
pub struct TestHarness {
    pub conn: SWPConnection,
    pub mock_llm: MockLlmSidecar,
    pub tmp_dir: tempfile::TempDir,
    pub data_dir: PathBuf,
    pub addr: String,
    shutdown_tx: watch::Sender<()>,
    server_handle: JoinHandle<()>,
    handler_handle: JoinHandle<()>,
    pub config: LoadedConfig,
    /// Exposed so integration tests can drive heartbeat ticks deterministically
    /// (e.g. `autonomy.heartbeat_tick_now(character)` followed by a virtual-time
    /// advance to fire the tick loop).
    pub autonomy: AutonomyManager,
    // Stored for `trigger_compaction_now`.
    llm_client: LedgerClient,
    notifier: shore_daemon::notifications::NotificationService,
    /// In-memory diagnostics ring buffers — exposed so integration tests
    /// can assert on key-fallback events, API call records, etc.
    pub diagnostics: Arc<std::sync::Mutex<shore_diagnostics::Diagnostics>>,
}

impl TestHarness {
    /// Boot with default `TestConfigBuilder` settings.
    pub async fn boot() -> Self {
        Self::boot_with(TestConfigBuilder::new()).await
    }

    /// Boot with a custom `TestConfigBuilder`.
    ///
    /// Follows the exact wiring pattern from `backend/daemon/tests/e2e.rs`
    /// (`E2EHarness::start`), but replaces the real LLM service with a
    /// `MockLlmSidecar` whose HTTP `base_url` is injected into the model
    /// catalog for embeddings while chat/generate stream over its Unix socket.
    pub async fn boot_with(builder: TestConfigBuilder) -> Self {
        // Start mock LLM sidecar plus HTTP embedding endpoint.
        let mock_llm = MockLlmSidecar::start().await;

        // Create temp directory tree and build config.
        let tmp_dir = fail_fast(tempfile::tempdir(), "failed to create temp dir");
        let config = fail_fast(
            builder.try_build(tmp_dir.path(), &mock_llm.base_url()),
            "failed to build test config",
        );

        let addr = {
            let listener = fail_fast(
                std::net::TcpListener::bind("127.0.0.1:0"),
                "failed to bind ephemeral harness port",
            );
            let port = fail_fast(
                listener.local_addr(),
                "failed to inspect ephemeral harness port",
            )
            .port();
            format!("127.0.0.1:{port}")
        };
        let data_dir = config.dirs.data.clone();

        Self::wire_daemon(config, mock_llm, tmp_dir, data_dir, addr).await
    }

    /// Internal: wire up daemon components and connect a SWP client.
    ///
    /// Called by both `boot_with` (fresh start) and `CrashedHarness::reboot`
    /// (restart from existing state on disk).
    #[expect(
        clippy::too_many_lines,
        reason = "test harness daemon wiring split is tracked in #109"
    )]
    pub(crate) async fn wire_daemon(
        config: LoadedConfig,
        mock_llm: MockLlmSidecar,
        tmp_dir: tempfile::TempDir,
        data_dir: PathBuf,
        addr: String,
    ) -> Self {
        let (shutdown_tx, shutdown_rx) = watch::channel(());

        // ── SWP Server ────────────────────────────────────────────────
        let server_config = ServerConfig {
            addr: addr.clone(),
            allowed_hosts: vec![],
            server_name: "shore-test-harness".into(),
            handshake: None,
        };
        let mut server = Server::new(server_config);
        let push_tx = server.event_sender();
        let session_router = server.session_router();
        let route_rx = server.take_route_rx();

        // ── Character Registry ────────────────────────────────────────
        let char_registry = Arc::new(tokio::sync::Mutex::new(CharacterRegistry::new(
            config.dirs.config.clone(),
            config.dirs.data.clone(),
            push_tx.clone(),
            config.clone(),
        )));
        server.set_handshake_provider(build_handshake_provider(Arc::clone(&char_registry)));

        // ── Autonomy Manager ──────────────────────────────────────────
        let mut autonomy = AutonomyManager::new(
            config.app.behavior.autonomy.clone(),
            config.app.memory.compaction.clone(),
            config.dirs.data.clone(),
            shutdown_rx.clone(),
        );

        // ── Ledger-wrapped LLM Client ────────────────────────────────
        let mut raw_llm_client = fail_fast(LlmClient::try_new(), "failed to create LlmClient");
        // Mirror production: the call store is always-on, not gated on the
        // deprecated `api_payload_logging` flag, so tests exercise the same
        // observability path as the daemon.
        fail_fast(
            std::fs::create_dir_all(&config.dirs.cache),
            "failed to create call-store cache dir",
        );
        let store = fail_fast(
            shore_call_store::CallStore::open(&config.dirs.cache.join("calls.db")),
            "failed to open harness call store",
        );
        raw_llm_client.set_call_store(Arc::new(store));
        raw_llm_client.set_sidecar_socket(mock_llm.socket_path().to_path_buf());
        let llm_client = fail_fast(
            LedgerClient::new(raw_llm_client, &config.dirs.data.join("ledger.db")),
            "failed to create LedgerClient",
        );
        llm_client.set_usage_config(config.app.usage.clone());

        let notifier =
            shore_daemon::notifications::NotificationService::new(NotificationsConfig::default());

        // Connect any configured MCP servers (mirrors main.rs). Empty `[mcp]`
        // yields a cheap empty registry; a `[mcp.*]` table makes the harness
        // exercise real MCP tool discovery.
        let mcp_registry = Arc::new(
            shore_daemon::tools::mcp_registry::McpRegistry::from_config(
                &config.app.mcp,
                &shore_config::plugins_dir(&config.dirs.data),
            )
            .await,
        );

        // Wire up autonomy with LLM resources (mirrors main.rs wiring).
        autonomy.set_resources(
            llm_client.clone(),
            push_tx.clone(),
            config.clone(),
            notifier.clone(),
        );
        autonomy.set_registry(Arc::clone(&char_registry));
        autonomy.set_mcp_registry(Arc::clone(&mcp_registry));

        // ── Command Context ──────────────────────────────────────────
        let diagnostics = Arc::new(std::sync::Mutex::new(
            shore_diagnostics::Diagnostics::default(),
        ));
        let cmd_ctx = CommandContext {
            config: config.clone(),
            config_path: config.dirs.config.join("config.toml"),
            push_tx: push_tx.clone(),
            data_dir: config.dirs.data.clone(),
            character_name: None,
            active_model: config.app.defaults.model.clone(),
            active_resolved_model: None,
            session_tokens: Arc::new(std::sync::Mutex::new(SessionTokens::default())),
            autonomy: autonomy.clone(),
            llm_client: llm_client.clone(),
            diagnostics: Arc::clone(&diagnostics),
        };

        // Clone for storage in TestHarness (before ownership is moved into msg_handler).
        let stored_llm_client = llm_client.clone();
        let stored_notifier = notifier.clone();
        let stored_autonomy = autonomy.clone();

        // ── Message Handler ──────────────────────────────────────────
        let (_control_tx, control_rx) = tokio::sync::mpsc::channel(16);
        let mut msg_handler = MessageHandler::new(MessageHandlerDeps {
            registry: char_registry,
            cmd_ctx,
            llm_client,
            push_tx: push_tx.clone(),
            session_router,
            autonomy,
            notifier,
            mcp_registry,
            control_rx,
        });

        // Spawn handler loop.
        let handler_handle = tokio::spawn(async move {
            msg_handler.run(route_rx).await;
        });

        // Spawn server loop.
        let server_shutdown_rx = shutdown_rx.clone();
        let server_handle = tokio::spawn(async move {
            if let Err(error) = server.run(server_shutdown_rx).await {
                info!(error = %error, "TestHarness server exited with error");
            }
        });

        // Give the server time to bind the socket.
        tokio::time::sleep(Duration::from_millis(200)).await;

        // ── SWP Client Connection ────────────────────────────────────
        let (conn, server_hello) = connect_client(&addr, "harness", None).await;

        assert_eq!(
            server_hello.v,
            shore_protocol::SWP_V1,
            "SWP protocol version mismatch"
        );
        info!(
            server_name = %server_hello.server_name,
            "TestHarness booted"
        );

        Self {
            conn,
            mock_llm,
            tmp_dir,
            data_dir,
            addr,
            shutdown_tx,
            server_handle,
            handler_handle,
            config,
            autonomy: stored_autonomy,
            llm_client: stored_llm_client,
            notifier: stored_notifier,
            diagnostics,
        }
    }

    /// Directly trigger compaction for a character, bypassing the 30-second
    /// autonomy tick.  Useful in tests where you don't want to wait 30s.
    ///
    /// Pulls the cached last-request from the autonomy manager (the same
    /// hand-off the production scheduler uses), so this drives the
    /// cache-preserving compaction path whenever a chat call has run
    /// before this trigger fires. Tests that need the fresh path can
    /// reset the autonomy state first, but most callers will get the
    /// production-shaped path automatically.
    ///
    /// Enqueue mock responses (compaction LLM call + embedding calls) BEFORE
    /// calling this method.
    pub async fn trigger_compaction_now(&self, character: &str) {
        let cached_request = self.autonomy.cached_last_request(character);
        match shore_daemon::memory::compaction::run_compaction(
            character,
            &self.config,
            &self.llm_client,
            &self.notifier,
            cached_request,
            None,
            false,
        )
        .await
        {
            Ok(retained) => {
                info!(
                    character,
                    retained, "trigger_compaction_now: compaction complete"
                );
            }
            Err(e) => {
                info!(character, error = %e, "trigger_compaction_now: compaction failed");
            }
        }
    }

    /// Directly trigger a dreaming librarian sweep for a character with
    /// `force=true`, bypassing the cadence gate.
    ///
    /// Enqueue mock responses (the librarian-call request body + any tool
    /// follow-ups) BEFORE calling this method. Mirrors
    /// [`Self::trigger_compaction_now`] for the dreaming pathway.
    pub async fn trigger_dreaming_now(&self, character: &str) {
        match shore_daemon::memory::dreaming::run_librarian_sweep(
            &self.config,
            &self.config.dirs.data,
            &self.llm_client,
            character,
            None,
            false,
            true,
        )
        .await
        {
            Ok(result) => {
                info!(
                    character,
                    fired = result.is_some(),
                    "trigger_dreaming_now: sweep complete"
                );
            }
            Err(e) => {
                info!(character, error = %e, "trigger_dreaming_now: sweep failed");
            }
        }
    }

    /// Simulate a crash: abort server and handler tasks without graceful shutdown,
    /// and return a `CrashedHarness` for rebooting.
    pub async fn crash(self) -> crate::chaos::CrashedHarness {
        // Drop shutdown_tx without sending — no graceful shutdown signal.
        drop(self.shutdown_tx);

        // Abort both tasks immediately.
        self.server_handle.abort();
        self.handler_handle.abort();

        // Wait briefly so the port is released before the next bind.
        tokio::time::sleep(Duration::from_millis(50)).await;

        crate::chaos::CrashedHarness {
            tmp_dir: self.tmp_dir,
            mock_llm: self.mock_llm,
            data_dir: self.data_dir,
            addr: self.addr,
        }
    }

    /// Send a user message and collect the full streamed response.
    ///
    /// Enqueues nothing on the mock — caller must call `mock_llm.enqueue_text()`
    /// (or similar) before calling this method.
    pub async fn send_and_collect(&mut self, text: &str) -> CollectedResponse {
        let _ignored = fail_fast(
            self.conn.send_message(text, true).await,
            "failed to send message",
        );
        self.collect_stream().await
    }

    /// Collect server messages until `StreamEnd` or `Error`, with a 30s timeout.
    pub async fn collect_stream(&mut self) -> CollectedResponse {
        let mut collected = CollectedResponse::new();
        let now = tokio::time::Instant::now();
        let deadline = now.checked_add(COLLECT_TIMEOUT).unwrap_or(now);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                fail_harness(format_args!(
                    "collect_stream timed out after {:?}; collected {} messages so far",
                    COLLECT_TIMEOUT,
                    collected.raw_messages.len(),
                ));
            }

            let recv_result = fail_fast(
                timeout(remaining, self.conn.recv()).await,
                "collect_stream timed out waiting for message",
            );
            let msg = fail_fast(recv_result, "failed to recv server message");

            if collected.push(msg) {
                return collected;
            }
        }
    }

    /// Send a slash command and collect responses until `CommandOutput` or timeout.
    pub async fn send_command(&mut self, cmd: &str) -> Vec<ServerMessage> {
        self.send_command_with_args(cmd, json!({})).await
    }

    /// Send a slash command with explicit args and collect responses until
    /// `CommandOutput` or timeout. Used by Phase 10 E2E coverage where the
    /// command needs structured arguments (e.g. `set_model_setting`).
    pub async fn send_command_with_args(
        &mut self,
        cmd: &str,
        args: serde_json::Value,
    ) -> Vec<ServerMessage> {
        let _ignored = fail_fast(
            self.conn.send_command(cmd, args).await,
            "failed to send command",
        );

        let mut messages = Vec::new();
        let now = tokio::time::Instant::now();
        let deadline = now.checked_add(CMD_TIMEOUT).unwrap_or(now);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }

            match timeout(remaining, self.conn.recv()).await {
                Ok(Ok(msg)) => {
                    let is_terminal = matches!(
                        &msg,
                        ServerMessage::CommandOutput(_) | ServerMessage::Error(_)
                    );
                    messages.push(msg);
                    if is_terminal {
                        break;
                    }
                }
                Ok(Err(_)) | Err(_) => break,
            }
        }

        messages
    }

    /// Read all persisted JSONL messages from the data directory.
    ///
    /// Walks `{data_dir}/{character}/active.jsonl` files and parses each line.
    pub fn read_persisted_messages(&self) -> Vec<serde_json::Value> {
        let mut messages = Vec::new();

        let Ok(entries) = std::fs::read_dir(&self.data_dir) else {
            return messages;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let jsonl_path = path.join("active.jsonl");
            if !jsonl_path.exists() {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&jsonl_path) else {
                continue;
            };
            for line in content.lines() {
                if line.is_empty() {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                    messages.push(val);
                }
            }
        }

        messages
    }

    /// Read all ledger entries from the SQLite database at `{data_dir}/ledger.db`.
    ///
    /// Returns each row from the `calls` table as a `serde_json::Value` object.
    /// The caller should give the daemon time to flush (e.g. a short sleep) before
    /// calling this, as ledger writes happen synchronously but may lag slightly.
    pub fn read_ledger_entries(&self) -> Vec<serde_json::Value> {
        let db_path = self.data_dir.join("ledger.db");
        let Ok(conn) = rusqlite::Connection::open(&db_path) else {
            return Vec::new();
        };

        let Ok(mut stmt) = conn.prepare(
            "SELECT id, ts, character, provider, model, call_type, \
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, \
             cache_ttl, total_ms, ttft_ms, finish_reason, thinking_enabled, \
             cache_state, cache_anomaly, input_cost, output_cost, \
             cache_read_cost, cache_write_cost, total_cost \
             FROM calls ORDER BY id ASC",
        ) else {
            return Vec::new();
        };

        let rows = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id":                 row.get::<_, i64>(0)?,
                "ts":                 row.get::<_, String>(1)?,
                "character":          row.get::<_, String>(2)?,
                "provider":           row.get::<_, String>(3)?,
                "model":              row.get::<_, String>(4)?,
                "call_type":          row.get::<_, String>(5)?,
                "input_tokens":       row.get::<_, i64>(6)?,
                "output_tokens":      row.get::<_, i64>(7)?,
                "cache_read_tokens":  row.get::<_, i64>(8)?,
                "cache_write_tokens": row.get::<_, i64>(9)?,
                "cache_ttl":          row.get::<_, Option<String>>(10)?,
                "total_ms":           row.get::<_, i64>(11)?,
                "ttft_ms":            row.get::<_, i64>(12)?,
                "finish_reason":      row.get::<_, String>(13)?,
                "thinking_enabled":   row.get::<_, i64>(14)? != 0,
                "cache_state":        row.get::<_, Option<String>>(15)?,
                "cache_anomaly":      row.get::<_, Option<String>>(16)?,
                "input_cost":         row.get::<_, Option<f64>>(17)?,
                "output_cost":        row.get::<_, Option<f64>>(18)?,
                "cache_read_cost":    row.get::<_, Option<f64>>(19)?,
                "cache_write_cost":   row.get::<_, Option<f64>>(20)?,
                "total_cost":         row.get::<_, Option<f64>>(21)?,
            }))
        });

        let Ok(iter) = rows else {
            return Vec::new();
        };
        iter.filter_map(Result::ok).collect()
    }

    /// Connect an additional SWP client to the same daemon.
    pub async fn connect_second_client(&self) -> SWPConnection {
        let (conn, _hello) = connect_client(&self.addr, "second-client", None).await;
        conn
    }

    /// Connect an additional SWP client with a specific selected character.
    /// Used by Phase 10 per-character preference tests where each
    /// connection drives commands against its own character workspace.
    pub async fn connect_as_character(&self, character: &str) -> SWPConnection {
        let (conn, _hello) =
            connect_client(&self.addr, character, Some(character.to_owned())).await;
        conn
    }

    /// Send a command on an arbitrary SWP connection (e.g. a per-character
    /// connection from `connect_as_character`) and collect responses until
    /// `CommandOutput`/`Error` or timeout. Mirrors `send_command_with_args`
    /// but accepts the connection explicitly.
    pub async fn send_command_on(
        conn: &mut SWPConnection,
        cmd: &str,
        args: serde_json::Value,
    ) -> Vec<ServerMessage> {
        let _ignored = fail_fast(conn.send_command(cmd, args).await, "failed to send command");

        let mut messages = Vec::new();
        let now = tokio::time::Instant::now();
        let deadline = now.checked_add(CMD_TIMEOUT).unwrap_or(now);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match timeout(remaining, conn.recv()).await {
                Ok(Ok(msg)) => {
                    let is_terminal = matches!(
                        &msg,
                        ServerMessage::CommandOutput(_) | ServerMessage::Error(_)
                    );
                    messages.push(msg);
                    if is_terminal {
                        break;
                    }
                }
                Ok(Err(_)) | Err(_) => break,
            }
        }
        messages
    }

    /// Graceful shutdown: signal the server and handler, then await both tasks.
    pub async fn shutdown(self) {
        _ = self.shutdown_tx.send(());
        _ = self.server_handle.await;
        _ = self.handler_handle.await;
    }
}

async fn connect_client(
    addr: &str,
    client_name: &str,
    selected_character: Option<String>,
) -> (SWPConnection, ServerHello) {
    match SWPConnection::connect(
        &ServerAddr(addr.to_owned()),
        "test",
        client_name,
        selected_character,
    )
    .await
    {
        Ok((conn, hello, _history)) => (conn, hello),
        Err(error) => fail_harness(format_args!("failed to connect {client_name}: {error}")),
    }
}

fn fail_fast<T, E: std::fmt::Display>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => fail_harness(format_args!("{context}: {error}")),
    }
}

#[expect(
    clippy::panic,
    reason = "test harness helper APIs preserve fail-fast setup semantics"
)]
fn fail_harness(message: std::fmt::Arguments<'_>) -> ! {
    panic!("{message}")
}
