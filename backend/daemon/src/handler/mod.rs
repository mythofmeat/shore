//! Message processing handler.
//!
//! Consumes routed messages from the SWP server and orchestrates the
//! engine -> prompt -> LLM -> tool loop -> persist pipeline.
//!
//! Generation (Message/Regen) runs in spawned tokio tasks so the handler loop
//! never blocks on LLM streaming. Commands (status, log, etc.) are processed
//! inline and always return immediately.

mod command_dispatch;
mod context;
mod generation;
mod images;
mod key_fallback;
mod persistence;
mod resize;
mod task;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) use context::{
    build_chat_shape_request_from_disk, prepare_chat_context, PrepareChatContextParams,
    PreparedChatContext,
};
pub(crate) use images::{
    build_content, embed_image_data, embed_messages_image_data, image_data_for_path,
};
pub(crate) use task::build_llm_messages;
use task::handle_generation;

use shore_protocol::client_msg::{ClientMessage, ClientMessageBody};
use shore_protocol::error::ErrorCode;
use shore_protocol::server_msg::{Error as SwpError, ServerMessage};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, error, info, warn};

use crate::autonomy::manager::AutonomyManager;
use crate::characters::CharacterRegistry;
use crate::commands::{CommandContext, SessionTokens};
use crate::memory::compaction_impls::ImageGenConfig;
use crate::notifications::{NotificationEvent, NotificationService};
use crate::tools::context::SharedToolContext;
use crate::tools::ToolContext;
use shore_config::app::SearchConfig;
use shore_config::{character_data_dir, discover_characters, load_character_config, LoadedConfig};
use shore_ledger::LedgerClient;
use shore_swp_server::{RequestMeta, RoutedMessage, SessionId, SessionRouter};

pub(super) struct HandlerToolContext {
    inner: SharedToolContext,
    autonomy_val: AutonomyManager,
}

impl ToolContext for HandlerToolContext {
    fn image_dir(&self) -> &str {
        self.inner.image_dir()
    }
    fn llm_client(&self) -> Option<&shore_llm::LlmClient> {
        self.inner.llm_client()
    }
    fn image_gen_config(&self) -> Option<&ImageGenConfig> {
        self.inner.image_gen_config()
    }
    fn search_config(&self) -> &SearchConfig {
        self.inner.search_config()
    }
    fn autonomy_manager(&self) -> Option<&AutonomyManager> {
        Some(&self.autonomy_val)
    }
    fn character_name(&self) -> &str {
        self.inner.character_name()
    }
    fn workspace_dir(&self) -> &str {
        self.inner.workspace_dir()
    }
    fn character_data_dir(&self) -> &str {
        self.inner.character_data_dir()
    }
    fn markdown_store(&self) -> Option<&crate::memory::markdown_store::MarkdownMemoryStore> {
        self.inner.markdown_store()
    }
    fn memory_retrieval_config(&self) -> &shore_config::app::RetrievalConfig {
        self.inner.memory_retrieval_config()
    }
    fn embedder(&self) -> Option<&dyn shore_llm::embed::Embedder> {
        self.inner.embedder()
    }
    fn memory_index_path(&self) -> Option<&std::path::Path> {
        self.inner.memory_index_path()
    }
    fn config_dir(&self) -> &str {
        self.inner.config_dir()
    }
    fn defer_edit(&self, path: &str) {
        self.inner.defer_edit(path);
    }
    fn run_subagent<'ctx>(
        &'ctx self,
        name: &'ctx str,
        query: &'ctx str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<serde_json::Value, crate::tools::ToolError>>
                + Send
                + 'ctx,
        >,
    > {
        self.inner.run_subagent(name, query)
    }
}

#[derive(Debug, Clone)]
struct GenContext {
    registry: Arc<Mutex<CharacterRegistry>>,
    llm_client: LedgerClient,
    event_tx: broadcast::Sender<ServerMessage>,
    direct_tx: mpsc::Sender<ServerMessage>,
    autonomy: AutonomyManager,
    session_tokens: Arc<std::sync::Mutex<SessionTokens>>,
    diagnostics: Arc<std::sync::Mutex<shore_diagnostics::Diagnostics>>,
    notifier: NotificationService,
    /// Live MCP connections, snapshotted for this generation. Empty when no
    /// `[mcp.*]` servers are configured.
    mcp_registry: Arc<crate::tools::mcp_registry::McpRegistry>,
}

struct GenerationParams {
    request: RequestMeta,
    body: ClientMessageBody,
    regen: bool,
    char_name: String,
    rid: Option<String>,
    effective_config: LoadedConfig,
    data_dir: PathBuf,
    /// Pre-resolved active model, threaded through from preference
    /// resolution. Carrying the `ResolvedModel` directly (rather than
    /// just a name string) avoids a re-resolve in `task.rs` — important
    /// because discovered-only models have a synthetic `qualified_name`
    /// (`chat.<provider>.<model_id>`) that `find_effective_model` does
    /// not accept as input. `None` means fall back to the configured
    /// default at generation time.
    active_model: Option<shore_config::models::ResolvedModel>,
    /// Phase 3+: per-model sampler overlay derived from the merged
    /// global+character preferences for the active `(provider, model_id)`.
    /// Empty `SamplerSettings` means "no preference overrides apply".
    sampler_overlay: crate::preferences::SamplerSettings,
}

#[derive(Debug, Default)]
struct SessionState {
    active_model: Option<String>,
    session_tokens: Arc<std::sync::Mutex<SessionTokens>>,
    generation_handle: Option<tokio::task::JoinHandle<()>>,
}

/// Per-character record of the most recent client session to send a real
/// `Message` (not Regen / Cancel / Command). Used to fan out streaming
/// generation output to that client even when generation is triggered by a
/// different session, so frontends stay in sync.
#[derive(Debug, Clone, Copy)]
struct LastUserLease {
    session_id: SessionId,
    expires_at: Instant,
}

const LEASE_TTL: Duration = Duration::from_hours(1);

/// Internal daemon control messages handled on the same task as SWP commands.
#[derive(Debug)]
pub enum HandlerControl {
    ReloadConfig { changed_paths: Vec<PathBuf> },
}

#[derive(Debug, Clone, Copy)]
pub(super) enum RuntimeReloadSource {
    ManualReset,
    HotReload,
}

/// The message processing handler.
///
/// Routes commands inline (fast path) and spawns tokio tasks for generation
/// (Message/Regen), so the handler loop is never blocked by LLM streaming.
#[derive(Debug)]
pub struct MessageHandler {
    pub registry: Arc<Mutex<CharacterRegistry>>,
    pub cmd_ctx: CommandContext,
    pub llm_client: LedgerClient,
    pub push_tx: broadcast::Sender<ServerMessage>,
    pub session_router: SessionRouter,
    pub autonomy: AutonomyManager,
    pub notifier: NotificationService,
    /// Live MCP connections. Swapped wholesale on config hot-reload; cloned
    /// (Arc) into each `GenContext` so in-flight generations keep their snapshot.
    mcp_registry: Arc<crate::tools::mcp_registry::McpRegistry>,
    control_rx: mpsc::Receiver<HandlerControl>,
    sessions: HashMap<SessionId, SessionState>,
    last_user_session: HashMap<String, LastUserLease>,
}

#[derive(Debug)]
pub struct MessageHandlerDeps {
    pub registry: Arc<Mutex<CharacterRegistry>>,
    pub cmd_ctx: CommandContext,
    pub llm_client: LedgerClient,
    pub push_tx: broadcast::Sender<ServerMessage>,
    pub session_router: SessionRouter,
    pub autonomy: AutonomyManager,
    pub notifier: NotificationService,
    pub mcp_registry: Arc<crate::tools::mcp_registry::McpRegistry>,
    pub control_rx: mpsc::Receiver<HandlerControl>,
}

impl MessageHandler {
    pub fn new(deps: MessageHandlerDeps) -> Self {
        Self {
            registry: deps.registry,
            cmd_ctx: deps.cmd_ctx,
            llm_client: deps.llm_client,
            push_tx: deps.push_tx,
            session_router: deps.session_router,
            autonomy: deps.autonomy,
            notifier: deps.notifier,
            mcp_registry: deps.mcp_registry,
            control_rx: deps.control_rx,
            sessions: HashMap::new(),
            last_user_session: HashMap::new(),
        }
    }

    fn session_state_mut(&mut self, session_id: SessionId) -> &mut SessionState {
        self.sessions.entry(session_id).or_default()
    }

    /// Resolve the active lease holder's `direct_tx` for a character if the
    /// lease is fresh, points at a connected session different from the
    /// issuer, and has not expired. Lazily evicts stale entries.
    async fn resolve_lease_tx(
        &mut self,
        issuer_session: SessionId,
        char_name: &str,
    ) -> Option<mpsc::Sender<ServerMessage>> {
        let lease = *self.last_user_session.get(char_name)?;
        if lease.session_id == issuer_session {
            return None;
        }
        if Instant::now() >= lease.expires_at {
            let _ignored = self.last_user_session.remove(char_name);
            return None;
        }
        let Some(tx) = self.session_router.sender_for(lease.session_id).await else {
            let _ignored = self.last_user_session.remove(char_name);
            return None;
        };
        Some(tx)
    }

    /// Build a fanout `direct_tx` that forwards every server message to both
    /// the issuing session and the per-character lease holder (the most
    /// recent client to send a real user message). When there is no eligible
    /// lease holder, the returned sender is effectively just the issuer's.
    async fn build_fanout_tx(
        &mut self,
        issuer_session: SessionId,
        char_name: &str,
        issuer_tx: mpsc::Sender<ServerMessage>,
    ) -> mpsc::Sender<ServerMessage> {
        let lease_tx = self.resolve_lease_tx(issuer_session, char_name).await;
        let (fan_tx, mut fan_rx) = mpsc::channel::<ServerMessage>(256);
        let _ignored = tokio::spawn(async move {
            while let Some(msg) = fan_rx.recv().await {
                if let Some(ref lease) = lease_tx {
                    let _ignored = lease.send(msg.clone()).await;
                }
                let _ignored = issuer_tx.send(msg).await;
            }
        });
        fan_tx
    }

    /// Run the message processing loop. Blocks until the route channel closes.
    ///
    /// Commands are processed inline (no LLM I/O, always fast).
    /// Engine messages (Message/Regen) are spawned as independent tokio tasks,
    /// so this loop never blocks on LLM streaming.
    pub async fn run(&mut self, route_rx: Arc<Mutex<mpsc::Receiver<RoutedMessage>>>) {
        info!("message handler started");
        let mut rx = route_rx.lock().await;
        let mut control_open = true;
        loop {
            tokio::select! {
                routed = rx.recv() => {
                    let Some(msg) = routed else {
                        break;
                    };
                    self.handle_routed_message(msg).await;
                }
                control = self.control_rx.recv(), if control_open => {
                    match control {
                        Some(ctrl) => self.handle_control(ctrl).await,
                        None => control_open = false,
                    }
                }
            }
        }
        info!("Message handler shutting down (route channel closed)");
    }

    async fn handle_routed_message(&mut self, msg: RoutedMessage) {
        match msg {
            RoutedMessage::Command { cmd, meta } => {
                debug!(
                    client_id = meta.session.client_id.0,
                    session_id = meta.session.session_id.0,
                    client_type = %meta.session.client_type,
                    rid = meta.rid.as_deref().unwrap_or("-"),
                    character = ?meta.session.selected_character,
                    "handling command"
                );
                let result = self.dispatch_command(&cmd, &meta).await;
                let _ignored = self
                    .session_router
                    .send_to_session(meta.session.session_id, result)
                    .await;
            }
            RoutedMessage::Engine {
                msg: engine_msg,
                meta,
            } => {
                self.handle_engine_message(engine_msg, meta).await;
            }
            RoutedMessage::AllClientsDisconnected => {
                let session_ids: Vec<SessionId> = self.sessions.keys().copied().collect();
                for session_id in session_ids {
                    self.cancel_generation(session_id, None, "all clients disconnected")
                        .await;
                }
                self.last_user_session.clear();
            }
        }
    }

    async fn handle_engine_message(&mut self, msg: ClientMessage, meta: RequestMeta) {
        let msg_kind = match &msg {
            ClientMessage::Message(_) => "message",
            ClientMessage::Regen(_) => "regen",
            ClientMessage::Cancel(_) => "cancel",
            ClientMessage::Hello(_) | ClientMessage::Command(_) => "other",
        };
        debug!(
            client_id = meta.session.client_id.0,
            session_id = meta.session.session_id.0,
            client_type = %meta.session.client_type,
            rid = meta.rid.as_deref().unwrap_or("-"),
            character = ?meta.session.selected_character,
            kind = msg_kind,
            "handling engine message"
        );

        if matches!(msg, ClientMessage::Cancel(_)) {
            info!(
                client_id = meta.session.client_id.0,
                session_id = meta.session.session_id.0,
                rid = meta.rid.as_deref().unwrap_or("-"),
                "cancelling generation from routed cancel request"
            );
            self.cancel_generation(meta.session.session_id, meta.rid.clone(), "user cancelled")
                .await;
            return;
        }

        let Some((char_name, effective_config)) =
            self.resolve_engine_message_character(&meta).await
        else {
            return;
        };

        let (body, regen) = match msg {
            ClientMessage::Message(body) => (body, false),
            ClientMessage::Regen(regen) => {
                let body = ClientMessageBody {
                    rid: regen.rid,
                    text: String::new(),
                    stream: regen.stream,
                    images: vec![],
                    image_data: vec![],
                    absence_seconds: None,
                    overrides: None,
                };
                (body, true)
            }
            ClientMessage::Hello(_) | ClientMessage::Command(_) | ClientMessage::Cancel(_) => {
                return;
            }
        };

        if !regen {
            let now = Instant::now();
            let _ignored = self.last_user_session.insert(
                char_name.clone(),
                LastUserLease {
                    session_id: meta.session.session_id,
                    expires_at: now.checked_add(LEASE_TTL).unwrap_or(now),
                },
            );
        }

        self.launch_generation(meta, body, regen, char_name, effective_config)
            .await;
    }

    /// Wire up and spawn the generation task for a normalized engine message:
    /// sanitize the rid, resolve the session's direct sender (bailing if the
    /// session vanished), build the fanout, and hand the assembled
    /// [`GenerationParams`] to the generation task.
    async fn launch_generation(
        &mut self,
        meta: RequestMeta,
        body: ClientMessageBody,
        regen: bool,
        char_name: String,
        effective_config: LoadedConfig,
    ) {
        let rid = body
            .rid
            .clone()
            .filter(|r| r.is_ascii() && !r.contains('\0'));
        let Some(direct_tx) = self
            .session_router
            .sender_for(meta.session.session_id)
            .await
        else {
            return;
        };
        let (active_model, sampler_overlay) =
            self.resolve_active_model_and_overlay(&char_name, &effective_config);
        let fanout_tx = self
            .build_fanout_tx(meta.session.session_id, &char_name, direct_tx)
            .await;
        let gen_ctx = self.gen_context(meta.session.session_id, fanout_tx.clone());
        let notifier = self.notifier.clone();
        let params = GenerationParams {
            request: meta.clone(),
            body,
            regen,
            char_name,
            rid,
            effective_config,
            data_dir: self.cmd_ctx.data_dir.clone(),
            active_model,
            sampler_overlay,
        };

        self.spawn_generation_task(
            meta.session.session_id,
            gen_ctx,
            params,
            fanout_tx,
            notifier,
        );
    }

    /// Resolve the session's selected character and effective config for an
    /// engine message, sending an error to the session and returning `None`
    /// when resolution fails.
    async fn resolve_engine_message_character(
        &mut self,
        meta: &RequestMeta,
    ) -> Option<(String, LoadedConfig)> {
        let mut registry = self.registry.lock().await;
        let char_name = match registry.resolve_character(meta.session.selected_character.as_deref())
        {
            Ok(name) => name,
            Err(e) => {
                let _ignored = self
                    .session_router
                    .send_to_session(
                        meta.session.session_id,
                        ServerMessage::Error(SwpError {
                            rid: None,
                            code: ErrorCode::InvalidRequest,
                            message: e.to_string(),
                        })
                        .with_rid(meta.rid.clone()),
                    )
                    .await;
                return None;
            }
        };
        let effective_config = registry.effective_config(&char_name).clone();
        Some((char_name, effective_config))
    }

    /// Resolve the active model and its per-model sampler overlay from merged
    /// global + character preferences (with a one-release legacy fallback).
    fn resolve_active_model_and_overlay(
        &self,
        char_name: &str,
        effective_config: &LoadedConfig,
    ) -> (
        Option<shore_config::models::ResolvedModel>,
        crate::preferences::SamplerSettings,
    ) {
        // Phase 3: preferences are authoritative. Legacy
        // `runtime_state.json` remains as a migration fallback for one
        // release; it is read but never written by Phase 3+ code paths.
        let character_data_dir = character_data_dir(&self.cmd_ctx.data_dir, char_name);
        let (global_prefs, char_prefs) =
            crate::preferences::load_for_character(&self.cmd_ctx.data_dir, char_name)
                .unwrap_or_else(|e| {
                    tracing::warn!(error = %e, character = %char_name, "Failed to load preferences; using empty defaults");
                    (
                        crate::preferences::ModelPreferences::default(),
                        crate::preferences::ModelPreferences::default(),
                    )
                });
        let legacy = crate::runtime_state::load_active_model(&character_data_dir);
        let resolved = crate::preferences::resolve_active_for_character(
            effective_config,
            &self.cmd_ctx.data_dir,
            &global_prefs,
            &char_prefs,
            legacy.as_deref(),
            effective_config.app.defaults.model.as_deref(),
        );
        let overlay = match resolved.as_ref() {
            // None for static_default: the chat path layers the
            // static catalog by patching the resolved model directly
            // via `apply_sampler_overlay`. Including it here would
            // double-count.
            Some(m) => crate::preferences::resolve_sampler_settings(
                &global_prefs,
                Some(&char_prefs),
                &m.provider_key,
                &m.model_id,
                None,
            ),
            None => crate::preferences::SamplerSettings::default(),
        };
        (resolved, overlay)
    }

    /// Spawn the generation task for this engine message, aborting any prior
    /// in-flight generation on the session and reporting errors to the client.
    fn spawn_generation_task(
        &mut self,
        session_id: SessionId,
        gen_ctx: GenContext,
        params: GenerationParams,
        fanout_tx: mpsc::Sender<ServerMessage>,
        notifier: NotificationService,
    ) {
        let session = self.session_state_mut(session_id);
        if let Some(prev) = session.generation_handle.take() {
            info!("Aborting previous generation (superseded by new request)");
            prev.abort();
        }
        session.generation_handle = Some(tokio::spawn(async move {
            let notify_name = params.char_name.clone();
            let request_rid = params.rid.clone();
            if let Err(e) = Box::pin(handle_generation(gen_ctx, params)).await {
                error!(error = %e, "Error processing engine message");
                let err_msg = e.to_string();
                let _ignored = fanout_tx
                    .send(
                        ServerMessage::Error(SwpError {
                            rid: None,
                            code: ErrorCode::InternalError,
                            message: err_msg.clone(),
                        })
                        .with_rid(request_rid),
                    )
                    .await;
                notifier.notify(
                    NotificationEvent::Error,
                    &format!("Shore - {notify_name}"),
                    &err_msg,
                );
            }
        }));
    }

    async fn handle_control(&mut self, control: HandlerControl) {
        match control {
            HandlerControl::ReloadConfig { changed_paths } => {
                self.reload_config_from_disk(changed_paths).await;
            }
        }
    }

    pub(super) async fn reload_config_from_disk(&mut self, changed_paths: Vec<PathBuf>) {
        let config_path = self.cmd_ctx.config_path.clone();
        let config = match shore_config::load_config(Some(&config_path)) {
            Ok(config) => config,
            Err(e) => {
                warn!(
                    path = %config_path.display(),
                    changed_paths = ?changed_paths,
                    error = %e,
                    "Configuration hot reload failed; keeping previous runtime config"
                );
                return;
            }
        };

        // Validate per-character overlays against the new global config before
        // committing. `load_config` only parses the global config, so a broken
        // `characters/<name>/config.toml` would otherwise silently invalidate
        // the cached merged config and fall back to the global config.
        let candidate_chars = discover_characters(&config.dirs.config);
        for name in &candidate_chars {
            if let Err(e) = load_character_config(&config, name) {
                warn!(
                    path = %config_path.display(),
                    changed_paths = ?changed_paths,
                    character = %name,
                    error = %e,
                    "Configuration hot reload failed; keeping previous runtime config"
                );
                return;
            }
        }

        let summary = self
            .apply_reloaded_config(config, RuntimeReloadSource::HotReload)
            .await;
        info!(
            path = %config_path.display(),
            changed_paths = ?changed_paths,
            character_discovery_changed = summary.character_discovery_changed,
            dropped_engines = summary.dropped_engines,
            "Configuration hot-reloaded from disk"
        );
    }

    pub(super) async fn apply_reloaded_config(
        &mut self,
        reloaded_config: LoadedConfig,
        source: RuntimeReloadSource,
    ) -> crate::characters::RuntimeReloadSummary {
        let restart_required = restart_required_changes(&self.cmd_ctx.config, &reloaded_config);
        if matches!(source, RuntimeReloadSource::HotReload) && !restart_required.is_empty() {
            warn!(
                restart_required = ?restart_required,
                "Config hot reload saw startup-owned changes; restart shore-daemon to apply them"
            );
        }

        self.cmd_ctx.config = reloaded_config.clone();
        self.cmd_ctx
            .llm_client
            .set_usage_config(reloaded_config.app.usage.clone());
        self.cmd_ctx.llm_client.set_cache_keepalive_ceiling(
            reloaded_config
                .app
                .behavior
                .autonomy
                .cache_keepalive_max
                .as_duration(),
        );
        self.cmd_ctx
            .autonomy
            .reload_runtime_config(reloaded_config.clone());
        self.autonomy.reload_runtime_config(reloaded_config.clone());

        // Reconnect MCP servers only when the `[mcp]` section actually changed,
        // so unrelated config edits don't churn live connections. In-flight
        // generations keep their snapshot (Arc clone); the old registry is shut
        // down here if uniquely owned, else cleaned up on Drop when they finish.
        if !self.mcp_registry.matches_config(&reloaded_config.app.mcp) {
            let new_registry = Arc::new(
                crate::tools::mcp_registry::McpRegistry::from_config(&reloaded_config.app.mcp)
                    .await,
            );
            let old = std::mem::replace(&mut self.mcp_registry, Arc::clone(&new_registry));
            // Hand the new registry to autonomy too, so future heartbeat ticks
            // (and their keepalive rebuilds) use the same surface as chat. Both
            // autonomy handles are updated, mirroring `reload_runtime_config`.
            // Running ticks keep their snapshot until restart (documented).
            self.autonomy.set_mcp_registry(Arc::clone(&new_registry));
            self.cmd_ctx.autonomy.set_mcp_registry(new_registry);
            if let Ok(registry) = Arc::try_unwrap(old) {
                registry.shutdown().await;
            }
            info!("MCP servers reconnected after config hot-reload");
        }

        let summary = {
            let mut registry = self.registry.lock().await;
            registry.reload_runtime_state(reloaded_config)
        };

        self.push_session_history_snapshots().await;
        summary
    }

    async fn push_session_history_snapshots(&self) {
        let sessions = self.session_router.sessions().await;
        for (session_id, selected_character) in sessions {
            let snapshot = crate::handshake::build_session_history_snapshot(
                Arc::clone(&self.registry),
                selected_character.clone(),
                None,
            )
            .await;

            // If the session's selected character was removed by this reload,
            // clear the router's stored character so subsequent requests don't
            // route with a stale name (e.g. switch_character would otherwise
            // fail to resolve the dead selection).
            if snapshot.selected_character != selected_character {
                let _ignored = self
                    .session_router
                    .set_selected_character(session_id, snapshot.selected_character.clone())
                    .await;
            }

            let _ignored = self
                .session_router
                .send_to_session(
                    session_id,
                    ServerMessage::History(shore_protocol::server_msg::History {
                        rid: None,
                        messages: snapshot.messages,
                        active_start: snapshot.active_start,
                        config: snapshot.config,
                        selected_character: snapshot.selected_character,
                        revision: snapshot.revision,
                    }),
                )
                .await;
        }
    }
}

fn restart_required_changes(old: &LoadedConfig, new: &LoadedConfig) -> Vec<&'static str> {
    let mut changes = Vec::new();
    if old.app.daemon != new.app.daemon {
        changes.push("[daemon]");
    }
    if old.app.connections.matrix != new.app.connections.matrix {
        changes.push("[connections.matrix]");
    }
    if old.app.notifications != new.app.notifications {
        changes.push("[notifications]");
    }
    if old.app.advanced.api_payload_logging != new.app.advanced.api_payload_logging {
        changes.push("[advanced].api_payload_logging");
    }
    if old.app.advanced.cache_forensics != new.app.advanced.cache_forensics {
        changes.push("[advanced].cache_forensics");
    }
    if old.app.advanced.llm_sidecar != new.app.advanced.llm_sidecar {
        changes.push("[advanced].llm_sidecar");
    }
    changes
}
