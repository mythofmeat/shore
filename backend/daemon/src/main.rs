// Panic-hygiene lock (see [workspace.lints] in root Cargo.toml): this binary is
// cleaned, so these can never regress.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::todo,
    clippy::unimplemented,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::as_conversions,
    clippy::allow_attributes,
    clippy::allow_attributes_without_reason,
    clippy::unwrap_in_result,
    clippy::panic_in_result_fn,
    clippy::let_underscore_must_use,
    clippy::clone_on_ref_ptr,
    clippy::dbg_macro,
    clippy::exit,
    clippy::mem_forget,
    clippy::match_wildcard_for_single_variants,
    clippy::wildcard_enum_match_arm,
    clippy::wildcard_imports,
    clippy::unseparated_literal_suffix,
    clippy::single_char_lifetime_names,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::modulo_arithmetic,
    clippy::float_arithmetic,
    clippy::string_slice,
    clippy::str_to_string,
    clippy::undocumented_unsafe_blocks,
    clippy::multiple_unsafe_ops_per_block,
    clippy::missing_assert_message,
    clippy::shadow_same,
    clippy::shadow_reuse,
    clippy::shadow_unrelated,
    clippy::else_if_without_else,
    clippy::impl_trait_in_params,
    unsafe_code,
    elided_lifetimes_in_paths,
    unused_qualifications
)]
// Tests index into fixtures freely: an out-of-bounds panic in a test is just an
// assertion failure (same rationale as the `allow-*-in-tests` clippy.toml
// settings). Production code stays locked by the `#![deny(...)]` above.
#![cfg_attr(
    test,
    expect(
        clippy::indexing_slicing,
        reason = "out-of-bounds indexing in tests is an assertion failure, not a service panic"
    )
)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::Parser;
use shore_config::{config_dir, load_config, ConfigError, LoadedConfig};
use shore_daemon::autonomy::manager::AutonomyManager;
use shore_daemon::characters::CharacterRegistry;
use shore_daemon::commands::{CommandContext, SessionTokens};
use shore_daemon::handler::{MessageHandler, MessageHandlerDeps};
use shore_daemon::handshake::build_handshake_provider;
use shore_daemon::notifications::NotificationService;
use shore_diagnostics::logging::HumanLogFormat;
use shore_diagnostics::Diagnostics;
use shore_ledger::LedgerClient;
use shore_llm::LlmClient;
use shore_protocol::server_msg::ServerMessage;
use shore_swp_server::registry::{InstanceInfo, Registry};
use shore_swp_server::{Server, ServerConfig};
use tokio::sync::broadcast;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

mod supervisor;

const DEFAULT_LOG_FILTER: &str =
    "warn,shore_daemon=info,shore_llm=info,shore_ledger=info,shore_swp_server=info";

/// Observability store retention window: rows older than this are pruned.
const CALL_STORE_RETENTION_DAYS: i64 = 14;
/// Observability store disk backstop (512 MiB): if 14 days of capture exceeds
/// this, the oldest calls are evicted. Compression keeps real usage well under.
const CALL_STORE_MAX_BYTES: u64 = 536_870_912;
/// How often the rotation task runs, in seconds (1 hour).
const CALL_STORE_ROTATE_SECS: u64 = 3600;

#[derive(Debug, Parser)]
#[command(name = "shore-daemon", about = "Shore daemon")]
struct Cli {
    /// Config file to load instead of $XDG_CONFIG_HOME/shore/config.toml.
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,

    /// TCP listen address for this process (overrides SHORE_ADDR and config).
    #[arg(long, value_name = "ADDR")]
    addr: Option<String>,

    /// Pin the registered instance ID in `instances.json`.
    ///
    /// When unset, a fresh UUID is generated on every startup. Set this
    /// to give the daemon a stable, discoverable ID — used by `shore-mcp`
    /// to rediscover a previously-spawned test daemon.
    #[arg(long, value_name = "ID")]
    instance_id: Option<String>,
}

#[derive(Debug)]
struct StartupConfig {
    loaded: LoadedConfig,
    config_path: PathBuf,
    bind_addr: String,
    bind_addr_source: StartupValueSource,
    remote_access_warnings: Vec<RemoteAccessWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteAccessWarning {
    addr: String,
    bind_addr_source: StartupValueSource,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupValueSource {
    Cli,
    Env,
    Config,
}

impl std::fmt::Display for StartupValueSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let label = match self {
            StartupValueSource::Cli => "--addr",
            StartupValueSource::Env => "SHORE_ADDR",
            StartupValueSource::Config => "[daemon].addr",
        };
        f.write_str(label)
    }
}

#[derive(Debug, thiserror::Error)]
enum StartupError {
    #[error("Invalid --config path {path}: {reason}")]
    InvalidConfigPath { path: PathBuf, reason: String },

    #[error("Failed to load Shore config from {path}: {source}")]
    LoadConfig {
        path: PathBuf,
        #[source]
        source: Box<ConfigError>,
    },

    #[error("Refusing startup for daemon address {addr} (from {bind_addr_source}): {message}")]
    RemoteAccessPolicy {
        addr: String,
        bind_addr_source: StartupValueSource,
        message: String,
    },

    #[error("Failed to create {kind} directory {path}: {source}")]
    CreateDir {
        kind: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to register daemon instance in {path}: {source}")]
    RegisterInstance {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Failed to start shore-daemon on {addr}: {source}")]
    ServerRun {
        addr: String,
        #[source]
        source: std::io::Error,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Sandbox-helper mode: when re-executed as `<exe> __sandbox-exec ...` by the
    // exec tool, apply the Landlock/seccomp sandbox and `execve` the real
    // program. This MUST run before the async runtime starts — the restrictions
    // are applied single-threaded, before any tokio worker threads exist.
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == shore_daemon::sandbox::HELPER_ARG)
    {
        // Only returns on failure (success replaces the process via execve).
        return Err(Box::new(shore_daemon::sandbox::run_sandbox_child()));
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_daemon())
}

async fn run_daemon() -> Result<(), Box<dyn std::error::Error>> {
    init_logging();

    let cli_parsed = Cli::parse();
    let instance_id_override = cli_parsed.instance_id.clone();
    let StartupConfig {
        loaded,
        config_path,
        bind_addr: addr,
        bind_addr_source,
        remote_access_warnings,
    } = resolve_startup(cli_parsed, startup_env_addr())?;
    info!(
        config_path = %config_path.display(),
        bind_addr = %addr,
        bind_addr_source = %bind_addr_source,
        "Startup configuration resolved"
    );

    create_runtime_dirs(&loaded)?;

    // Install the exec-tool sandbox policy before any tool can run.
    shore_daemon::sandbox::init_policy(loaded.app.tools.sandbox.clone());

    // ── Notification service ──────────────────────────────────────────
    let notifier = NotificationService::new(loaded.app.notifications.clone());

    let instance_id = instance_id_override.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    log_remote_access_warnings(&remote_access_warnings);

    let (listener, resolved_addr) = bind_resolved_listener(&addr, &loaded).await?;

    let server_config = ServerConfig {
        addr: resolved_addr.clone(),
        allowed_hosts: loaded.app.daemon.allowed_hosts.clone(),
        server_name: "shore-daemon".into(),
        handshake: None,
    };

    let registry = register_daemon_instance(&loaded, &resolved_addr, &instance_id)?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(());
    spawn_shutdown_signal_listener(shutdown_tx);

    let ServerAndHandler {
        server,
        llm_client,
        llm_sidecar_socket,
        autonomy,
        handler_handle,
        handler_control_tx,
    } = build_server_and_handler(server_config, &loaded, &config_path, notifier, &shutdown_rx)
        .await?;

    let services = spawn_background_services(
        &loaded,
        &config_path,
        handler_control_tx,
        &shutdown_rx,
        &llm_client,
        llm_sidecar_socket,
    );

    let result = run_server(server, listener, shutdown_rx, &resolved_addr).await;

    await_background_shutdown(services, handler_handle, autonomy).await;
    unregister_instance(&registry, &instance_id);
    info!("Daemon shut down cleanly");

    result?;
    Ok(())
}

/// Runtime components returned by [`build_server_and_handler`].
struct ServerAndHandler {
    server: Server,
    llm_client: LedgerClient,
    llm_sidecar_socket: Option<PathBuf>,
    autonomy: AutonomyManager,
    handler_handle: tokio::task::JoinHandle<()>,
    handler_control_tx: tokio::sync::mpsc::Sender<shore_daemon::handler::HandlerControl>,
}

/// Build the SWP server, character registry, LLM client, autonomy manager,
/// diagnostics, command context, and message handler. Returns the components
/// needed by the remaining startup and shutdown phases.
async fn build_server_and_handler(
    server_config: ServerConfig,
    loaded: &LoadedConfig,
    config_path: &Path,
    notifier: NotificationService,
    shutdown_rx: &tokio::sync::watch::Receiver<()>,
) -> Result<ServerAndHandler, Box<dyn std::error::Error>> {
    let mut server = Server::new(server_config);
    let push_tx = server.event_sender();
    let session_router = server.session_router();
    let route_rx = server.take_route_rx();

    let char_registry = Arc::new(tokio::sync::Mutex::new(CharacterRegistry::new(
        loaded.dirs.config.clone(),
        loaded.dirs.data.clone(),
        push_tx.clone(),
        loaded.clone(),
    )));
    server.set_handshake_provider(build_handshake_provider(Arc::clone(&char_registry)));

    let (llm_client, llm_sidecar_socket) = build_llm_client(loaded)?;

    spawn_call_store_rotation(&llm_client);

    // Connect configured MCP servers and snapshot their tool surface. Failures
    // are logged and skipped inside `from_config`; an empty `[mcp]` yields an
    // empty (cheap) registry. Built before the autonomy manager so background
    // ticks (heartbeat/dreaming) receive the same registry the chat path uses.
    let mcp_registry = Arc::new(
        shore_daemon::tools::mcp_registry::McpRegistry::from_config(
            &loaded.app.mcp,
            &shore_config::plugins_dir(&loaded.dirs.data),
        )
        .await,
    );

    // Autonomy manager: shared between handler, commands, and per-character ticks.
    let autonomy = build_autonomy_manager(
        loaded,
        shutdown_rx.clone(),
        &llm_client,
        &push_tx,
        &notifier,
        &char_registry,
        &mcp_registry,
    );

    // In-memory diagnostic ring buffers (API calls, tool calls, errors).
    // Writer: generation tasks (handler.rs). Reader: `status`/`diagnostics` commands.
    let diagnostics = Arc::new(std::sync::Mutex::new(Diagnostics::default()));
    // Accumulated token counts for the daemon's lifetime.
    // Writer: generation tasks after each API response. Reader: `status` command.
    let session_tokens = Arc::new(std::sync::Mutex::new(SessionTokens::default()));

    let cmd_ctx = build_command_context(
        loaded,
        config_path,
        &push_tx,
        &autonomy,
        &llm_client,
        Arc::clone(&session_tokens),
        Arc::clone(&diagnostics),
    );

    let (handler_control_tx, handler_control_rx) = tokio::sync::mpsc::channel(16);

    let mut msg_handler = MessageHandler::new(MessageHandlerDeps {
        registry: char_registry,
        cmd_ctx,
        llm_client: llm_client.clone(),
        push_tx,
        session_router,
        autonomy: autonomy.clone(),
        notifier,
        mcp_registry,
        control_rx: handler_control_rx,
    });

    let handler_handle = tokio::spawn(async move {
        msg_handler.run(route_rx).await;
    });

    Ok(ServerAndHandler {
        server,
        llm_client,
        llm_sidecar_socket,
        autonomy,
        handler_handle,
        handler_control_tx,
    })
}

/// Initialise human-readable tracing (journalctl already adds timestamps).
fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_FILTER)),
        )
        .event_format(HumanLogFormat)
        .init();
}

/// Ensure the persistent and cache/runtime directories exist before anything
/// writes to them.
fn create_runtime_dirs(loaded: &LoadedConfig) -> Result<(), StartupError> {
    std::fs::create_dir_all(&loaded.dirs.data).map_err(|source| StartupError::CreateDir {
        kind: "data",
        path: loaded.dirs.data.clone(),
        source,
    })?;
    // `<data>/plugins/` is the root relative `[mcp.*]` paths resolve against.
    // Create it up front so it's discoverable without reading the docs.
    let plugins = shore_config::plugins_dir(&loaded.dirs.data);
    std::fs::create_dir_all(&plugins).map_err(|source| StartupError::CreateDir {
        kind: "plugins",
        path: plugins,
        source,
    })?;
    std::fs::create_dir_all(&loaded.dirs.cache).map_err(|source| StartupError::CreateDir {
        kind: "cache",
        path: loaded.dirs.cache.clone(),
        source,
    })?;
    std::fs::create_dir_all(&loaded.dirs.runtime).map_err(|source| StartupError::CreateDir {
        kind: "runtime",
        path: loaded.dirs.runtime.clone(),
        source,
    })?;
    Ok(())
}

/// Log any non-loopback remote-access warnings surfaced during startup.
fn log_remote_access_warnings(warnings: &[RemoteAccessWarning]) {
    for warning in warnings {
        warn!(
            addr = %warning.addr,
            bind_addr_source = %warning.bind_addr_source,
            warning = %warning.message,
            "Daemon remote access warning"
        );
    }
}

/// Pre-bind the TCP listener so port-zero binds (e.g. `--addr 127.0.0.1:0`)
/// resolve to a real port before it is recorded in the instance registry —
/// otherwise the registry holds the literal `:0` and discovery clients connect
/// to a port that was never opened. Returns the listener and resolved address.
async fn bind_resolved_listener(
    addr: &str,
    loaded: &LoadedConfig,
) -> Result<(tokio::net::TcpListener, String), StartupError> {
    let pre_bind_config = ServerConfig {
        addr: addr.to_owned(),
        allowed_hosts: loaded.app.daemon.allowed_hosts.clone(),
        server_name: "shore-daemon".into(),
        handshake: None,
    };
    let pre_bind_server = Server::new(pre_bind_config);
    let listener = pre_bind_server
        .bind()
        .await
        .map_err(|source| StartupError::ServerRun {
            addr: addr.to_owned(),
            source,
        })?;
    let resolved_addr = listener
        .local_addr()
        .map_or_else(|_| addr.to_owned(), |a| a.to_string());
    drop(pre_bind_server);
    Ok((listener, resolved_addr))
}

/// Register this daemon instance in the shared registry.
fn register_daemon_instance(
    loaded: &LoadedConfig,
    resolved_addr: &str,
    instance_id: &str,
) -> Result<Registry, StartupError> {
    let registry = Registry::default_path();
    let instance_info = InstanceInfo {
        id: instance_id.to_owned(),
        pid: std::process::id(),
        addr: resolved_addr.to_owned(),
        started_at: epoch_timestamp(),
        data_dir: Some(loaded.dirs.data.display().to_string()),
        config_dir: Some(loaded.dirs.config.display().to_string()),
    };
    registry
        .register(instance_info)
        .map_err(|source| StartupError::RegisterInstance {
            path: registry.path().to_path_buf(),
            source,
        })?;
    info!(
        instance_id = %instance_id,
        registry_path = %registry.path().display(),
        addr = %resolved_addr,
        data_dir = %loaded.dirs.data.display(),
        "Registered daemon instance"
    );
    Ok(registry)
}

/// Spawn the OS-signal listener that trips the shutdown watch channel on
/// SIGINT/SIGTERM (Ctrl+C on non-unix).
fn spawn_shutdown_signal_listener(shutdown_tx: tokio::sync::watch::Sender<()>) {
    let _ignored = tokio::spawn(async move {
        let ctrl_c = tokio::signal::ctrl_c();

        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            match signal(SignalKind::terminate()) {
                Ok(mut sigterm) => {
                    tokio::select! {
                        result = ctrl_c => match result {
                            Ok(()) => info!("Received SIGINT"),
                            Err(error) => error!(error = %error, "Failed to listen for SIGINT"),
                        },
                        _ = sigterm.recv() => info!("Received SIGTERM"),
                    }
                }
                Err(error) => {
                    error!(error = %error, "Failed to listen for SIGTERM; falling back to SIGINT only");
                    match ctrl_c.await {
                        Ok(()) => info!("Received SIGINT"),
                        Err(sigint_error) => {
                            error!(error = %sigint_error, "Failed to listen for SIGINT");
                        }
                    }
                }
            }
        }

        #[cfg(not(unix))]
        {
            match ctrl_c.await {
                Ok(()) => info!("Received shutdown signal"),
                Err(error) => error!(error = %error, "Failed to listen for Ctrl+C"),
            }
        }

        let _ignored = shutdown_tx.send(());
    });
}

/// Build the ledger-wrapped LLM client: payload logging, the optional LLM
/// sidecar transport, cache forensics, usage config, and per-character cache
/// reconstruction. Returns the client and the resolved sidecar socket path.
/// Spawn the detached observability-store rotation task (14-day window + size
/// backstop), reaching the store through the llm client. No-op when capture is
/// disabled. `interval`'s first tick fires immediately, so a prune runs at
/// startup.
fn spawn_call_store_rotation(client: &LedgerClient) {
    let Some(store_ref) = client.inner().call_store() else {
        return;
    };
    let store = Arc::clone(store_ref);
    let _rotate = tokio::spawn(async move {
        let mut tick =
            tokio::time::interval(std::time::Duration::from_secs(CALL_STORE_ROTATE_SECS));
        loop {
            _ = tick.tick().await;
            let Some(cutoff) = chrono::Utc::now()
                .checked_sub_signed(chrono::Duration::days(CALL_STORE_RETENTION_DAYS))
            else {
                continue;
            };
            // `rotate` runs synchronous SQLite maintenance (incremental_vacuum
            // over a DB up to the size cap); keep it off the async worker.
            let rotate_store = Arc::clone(&store);
            let rotate_result = tokio::task::spawn_blocking(move || {
                rotate_store.rotate(cutoff, CALL_STORE_MAX_BYTES)
            })
            .await;
            match rotate_result {
                Ok(Ok(stats)) if stats.deleted_by_age > 0 || stats.deleted_by_size > 0 => {
                    info!(
                        deleted_by_age = stats.deleted_by_age,
                        deleted_by_size = stats.deleted_by_size,
                        "Call store rotation pruned rows"
                    );
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => warn!(error = %e, "Call store rotation failed"),
                Err(e) => warn!(error = %e, "Call store rotation task panicked"),
            }
        }
    });
}

fn build_llm_client(
    loaded: &LoadedConfig,
) -> Result<(LedgerClient, Option<PathBuf>), Box<dyn std::error::Error>> {
    let mut raw_llm_client = LlmClient::try_new()?;
    // Payload capture is always on: every LLM call is recorded to the
    // compressed, bounded observability store. Best-effort — a store that fails
    // to open disables capture but never blocks the daemon.
    let call_store_path = loaded.dirs.cache.join("calls.db");
    match shore_call_store::CallStore::open(&call_store_path) {
        Ok(store) => {
            raw_llm_client.set_call_store(Arc::new(store));
            info!(path = %call_store_path.display(), "Call payload store enabled");
        }
        Err(e) => {
            warn!(error = %e, path = %call_store_path.display(), "Failed to open call store; payload capture disabled");
        }
    }
    let llm_sidecar_socket = loaded.app.advanced.llm_sidecar.enabled.then(|| {
        loaded
            .app
            .advanced
            .llm_sidecar
            .socket_path
            .clone()
            .unwrap_or_else(|| loaded.dirs.runtime.join("llm.sock"))
    });
    if let Some(socket_path) = &llm_sidecar_socket {
        raw_llm_client.set_sidecar_socket(socket_path.clone());
        info!(
            socket = %socket_path.display(),
            "LLM sidecar transport enabled"
        );
    }

    let cache_forensics_path = loaded.dirs.cache.join("cache_forensics.jsonl");
    if loaded.app.advanced.cache_forensics {
        shore_llm::cache_forensics::enable(loaded.dirs.cache.clone());
        info!(
            path = %cache_forensics_path.display(),
            "Cache forensics enabled"
        );
    } else {
        info!(
            path = %cache_forensics_path.display(),
            "Cache forensics disabled; set [advanced].cache_forensics = true to enable"
        );
    }

    let llm_client = LedgerClient::new(raw_llm_client, &loaded.dirs.data.join("ledger.db"))?;
    llm_client.set_usage_config(loaded.app.usage.clone());
    llm_client.set_cache_keepalive_ceiling(
        loaded
            .app
            .behavior
            .autonomy
            .cache_keepalive_max
            .as_duration(),
    );

    // Reconstruct cache tracker state from the ledger for each known character.
    // This prevents false-positive anomalies when the cache is still warm from
    // before the restart.
    for character in shore_config::discover_characters(&loaded.dirs.config) {
        llm_client.reconstruct_cache_state(&character, 3600);
    }

    Ok((llm_client, llm_sidecar_socket))
}

/// Create the autonomy manager and wire its heartbeat/keepalive resources and
/// the character registry.
fn build_autonomy_manager(
    loaded: &LoadedConfig,
    shutdown_rx: tokio::sync::watch::Receiver<()>,
    llm_client: &LedgerClient,
    push_tx: &broadcast::Sender<ServerMessage>,
    notifier: &NotificationService,
    char_registry: &Arc<tokio::sync::Mutex<CharacterRegistry>>,
    mcp_registry: &Arc<shore_daemon::tools::mcp_registry::McpRegistry>,
) -> AutonomyManager {
    let mut autonomy = AutonomyManager::new(
        loaded.app.behavior.autonomy.clone(),
        loaded.app.memory.compaction.clone(),
        loaded.dirs.data.clone(),
        shutdown_rx,
    );
    autonomy.set_resources(
        llm_client.clone(),
        push_tx.clone(),
        loaded.clone(),
        notifier.clone(),
    );
    autonomy.set_registry(Arc::clone(char_registry));
    autonomy.set_mcp_registry(Arc::clone(mcp_registry));
    autonomy
}

/// Build the daemon-global (characterless) command context.
fn build_command_context(
    loaded: &LoadedConfig,
    config_path: &Path,
    push_tx: &broadcast::Sender<ServerMessage>,
    autonomy: &AutonomyManager,
    llm_client: &LedgerClient,
    session_tokens: Arc<std::sync::Mutex<SessionTokens>>,
    diagnostics: Arc<std::sync::Mutex<Diagnostics>>,
) -> CommandContext {
    CommandContext {
        config: loaded.clone(),
        config_path: config_path.to_path_buf(),
        push_tx: push_tx.clone(),
        data_dir: loaded.dirs.data.clone(),
        character_name: None,
        active_model: None,
        active_resolved_model: None,
        session_tokens,
        autonomy: autonomy.clone(),
        llm_client: llm_client.clone(),
        diagnostics,
    }
}

/// Run the SWP server to completion, then drop it so its `route_tx` is released
/// and the message handler can drain.
async fn run_server(
    server: Server,
    listener: tokio::net::TcpListener,
    shutdown_rx: tokio::sync::watch::Receiver<()>,
    resolved_addr: &str,
) -> Result<(), StartupError> {
    let result = server
        .run_with_listener(listener, shutdown_rx)
        .await
        .map_err(|source| StartupError::ServerRun {
            addr: resolved_addr.to_owned(),
            source,
        });
    if let Err(error) = &result {
        error!(addr = %resolved_addr, error = %error, "Daemon server exited with error");
    }
    // Drop the server so its route_tx is released, unblocking the handler.
    drop(server);
    result
}

/// Long-lived background tasks spawned alongside the server: config hot-reload,
/// provider auto-discovery, and the optional LLM-sidecar / Matrix supervisors.
struct BackgroundServices {
    hot_reload_handle: Option<tokio::task::JoinHandle<()>>,
    auto_discovery_handle: tokio::task::JoinHandle<()>,
    llm_sidecar_supervisor: Option<supervisor::LlmSidecarSupervisor>,
    matrix_supervisor: Option<supervisor::MatrixSupervisor>,
}

/// Spawn the daemon's background services (config watcher, auto-discovery, and
/// the LLM-sidecar / Matrix supervisors when configured).
fn spawn_background_services(
    loaded: &LoadedConfig,
    config_path: &Path,
    handler_control_tx: tokio::sync::mpsc::Sender<shore_daemon::handler::HandlerControl>,
    shutdown_rx: &tokio::sync::watch::Receiver<()>,
    llm_client: &LedgerClient,
    llm_sidecar_socket: Option<PathBuf>,
) -> BackgroundServices {
    let hot_reload_handle = shore_daemon::hot_reload::spawn_config_watcher(
        config_path.to_path_buf(),
        loaded.dirs.config.clone(),
        handler_control_tx,
        shutdown_rx.clone(),
    );

    // ── Spawn provider auto-discovery loop ───────────────────────────
    let auto_discovery_handle = shore_daemon::auto_discovery::spawn(
        loaded.clone(),
        loaded.dirs.cache.clone(),
        llm_client.clone(),
        shore_llm::discovery::REFRESH_INTERVAL,
        shutdown_rx.clone(),
    );

    // ── Spawn LLM sidecar supervisor (if configured) ─────────────────
    let llm_sidecar_supervisor = llm_sidecar_socket
        .and_then(|socket_path| supervisor::spawn_llm_sidecar(socket_path, shutdown_rx.clone()));

    // ── Spawn Matrix bridge supervisor (if configured) ───────────────
    let matrix_supervisor = loaded
        .app
        .connections
        .matrix
        .as_ref()
        .filter(|m| m.enabled)
        .and_then(|_| supervisor::spawn(shutdown_rx.clone()));

    BackgroundServices {
        hot_reload_handle,
        auto_discovery_handle,
        llm_sidecar_supervisor,
        matrix_supervisor,
    }
}

/// Wait (bounded) for the background supervisors, watchers, handler, and
/// autonomy tasks to finish after the server stops.
async fn await_background_shutdown(
    services: BackgroundServices,
    handler_handle: tokio::task::JoinHandle<()>,
    autonomy: AutonomyManager,
) {
    let shutdown_timeout = std::time::Duration::from_secs(10);
    let BackgroundServices {
        hot_reload_handle,
        auto_discovery_handle,
        llm_sidecar_supervisor,
        matrix_supervisor,
    } = services;

    if let Some(sup) = llm_sidecar_supervisor {
        sup.shutdown(std::time::Duration::from_secs(6)).await;
    }

    if let Some(sup) = matrix_supervisor {
        sup.shutdown(std::time::Duration::from_secs(6)).await;
    }

    if let Some(handle) = hot_reload_handle {
        _ = tokio::time::timeout(shutdown_timeout, handle).await;
    }
    _ = tokio::time::timeout(shutdown_timeout, auto_discovery_handle).await;
    _ = tokio::time::timeout(shutdown_timeout, handler_handle).await;
    _ = tokio::time::timeout(shutdown_timeout, autonomy.shutdown()).await;
}

/// Remove this daemon instance from the shared registry.
fn unregister_instance(registry: &Registry, instance_id: &str) {
    if let Err(e) = registry.unregister(instance_id) {
        error!(
            instance_id = %instance_id,
            registry_path = %registry.path().display(),
            error = %e,
            "Failed to unregister daemon instance"
        );
    } else {
        info!(
            instance_id = %instance_id,
            registry_path = %registry.path().display(),
            "Unregistered daemon instance"
        );
    }
}

fn resolve_startup(cli: Cli, env_addr: Option<String>) -> Result<StartupConfig, StartupError> {
    let explicit_config_path = resolve_explicit_config_path(cli.config.as_deref())?;
    let config_path_for_errors = explicit_config_path
        .clone()
        .unwrap_or_else(default_config_path);
    let loaded = load_config(explicit_config_path.as_deref()).map_err(|source| {
        StartupError::LoadConfig {
            path: config_path_for_errors.clone(),
            source: Box::new(source),
        }
    })?;
    let (bind_addr, bind_addr_source) = resolve_listen_addr(cli.addr, env_addr, &loaded);
    let remote_access_warnings: Vec<RemoteAccessWarning> = validate_remote_access_policy(
        &bind_addr,
        loaded.app.daemon.unsafe_allow_remote_access,
        &loaded.app.daemon.allowed_hosts,
    )
    .map_err(|message| StartupError::RemoteAccessPolicy {
        addr: bind_addr.clone(),
        bind_addr_source,
        message,
    })?
    .into_iter()
    .map(|message| RemoteAccessWarning {
        addr: bind_addr.clone(),
        bind_addr_source,
        message,
    })
    .collect();

    Ok(StartupConfig {
        loaded,
        config_path: explicit_config_path.unwrap_or_else(default_config_path),
        bind_addr,
        bind_addr_source,
        remote_access_warnings,
    })
}

fn resolve_explicit_config_path(
    config_path: Option<&Path>,
) -> Result<Option<PathBuf>, StartupError> {
    let Some(path) = config_path else {
        return Ok(None);
    };

    if !path.exists() {
        return Err(StartupError::InvalidConfigPath {
            path: path.to_path_buf(),
            reason: String::from("file does not exist"),
        });
    }

    if path.is_dir() {
        return Err(StartupError::InvalidConfigPath {
            path: path.to_path_buf(),
            reason: String::from("expected a config.toml file, not a directory"),
        });
    }

    Ok(Some(path.to_path_buf()))
}

fn resolve_listen_addr(
    cli_addr: Option<String>,
    env_addr: Option<String>,
    loaded: &LoadedConfig,
) -> (String, StartupValueSource) {
    if let Some(addr) = cli_addr {
        return (addr, StartupValueSource::Cli);
    }

    if let Some(addr) = env_addr.filter(|value| !value.trim().is_empty()) {
        return (addr, StartupValueSource::Env);
    }

    (loaded.app.daemon.addr.clone(), StartupValueSource::Config)
}

fn startup_env_addr() -> Option<String> {
    std::env::var("SHORE_ADDR")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn default_config_path() -> PathBuf {
    config_dir().join("config.toml")
}

fn validate_remote_access_policy(
    addr: &str,
    unsafe_allow_remote_access: bool,
    allowed_hosts: &[String],
) -> Result<Vec<String>, String> {
    if bind_addr_is_loopback(addr)? {
        return Ok(Vec::new());
    }

    if !unsafe_allow_remote_access {
        return Err(format!(
            "Refusing to bind shore-daemon to non-loopback address {addr}. \
Set [daemon].unsafe_allow_remote_access = true to acknowledge unauthenticated remote TCP exposure. \
[daemon].allowed_hosts is only an IP allowlist and does not provide authentication or TLS."
        ));
    }

    let mut warnings = vec![String::from(
        "Remote TCP access is enabled. Shore does not provide authentication or TLS. Restrict Shore to trusted private or overlay networks; [daemon].allowed_hosts only narrows peer IPs and is not a complete security boundary.",
    )];
    if allowed_hosts.is_empty() {
        warnings.push(String::from(
            "Remote TCP access is enabled with an empty [daemon].allowed_hosts list; any host that can reach the port may connect.",
        ));
    }

    Ok(warnings)
}

fn bind_addr_is_loopback(addr: &str) -> Result<bool, String> {
    if let Ok(socket_addr) = addr.parse::<std::net::SocketAddr>() {
        return Ok(socket_addr.ip().is_loopback());
    }

    let host = extract_bind_host(addr).ok_or_else(|| {
        format!("Invalid daemon listen address {addr:?}. Expected HOST:PORT or [IPv6]:PORT.")
    })?;

    Ok(matches!(host, "localhost" | "127.0.0.1" | "::1"))
}

fn extract_bind_host(addr: &str) -> Option<&str> {
    if let Some(rest) = addr.strip_prefix('[') {
        let (host, suffix) = rest.split_once(']')?;
        if suffix.starts_with(':') && !host.is_empty() {
            return Some(host);
        }
        return None;
    }

    let (host, port) = addr.rsplit_once(':')?;
    if host.is_empty() || port.is_empty() {
        return None;
    }
    Some(host)
}

/// Registry timestamps use RFC3339 for human-readable diagnostics.
fn epoch_timestamp() -> String {
    chrono::Local::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        epoch_timestamp, resolve_explicit_config_path, resolve_listen_addr, resolve_startup,
        validate_remote_access_policy, Cli, StartupError, StartupValueSource,
    };
    use clap::Parser;
    use tempfile::TempDir;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    #[test]
    fn loopback_bind_does_not_require_remote_opt_in() {
        let warnings = validate_remote_access_policy("127.0.0.1:7320", false, &[]).unwrap();
        assert!(warnings.is_empty());
    }

    #[test]
    fn remote_bind_requires_explicit_opt_in() {
        let err = validate_remote_access_policy("0.0.0.0:7320", false, &[])
            .expect_err("remote bind without opt-in should fail");
        assert!(err.contains("unsafe_allow_remote_access"));
        assert!(err.contains("allowed_hosts"));
    }

    #[test]
    fn opted_in_remote_bind_warns_when_acl_is_empty() {
        let warnings = validate_remote_access_policy("0.0.0.0:7320", true, &[]).unwrap();
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("does not provide authentication or TLS"));
        assert!(warnings[1].contains("any host that can reach the port may connect"));
    }

    #[test]
    fn opted_in_remote_bind_with_acl_only_warns_about_thin_security() {
        let warnings =
            validate_remote_access_policy("0.0.0.0:7320", true, &[String::from("10.0.0.5")])
                .unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("trusted private or overlay networks"));
    }

    #[test]
    fn localhost_name_is_treated_as_loopback() {
        let warnings = validate_remote_access_policy("localhost:7320", false, &[]).unwrap();
        assert!(warnings.is_empty());
    }

    #[test]
    fn invalid_bind_address_fails_validation() {
        let err = validate_remote_access_policy("not-an-address", false, &[])
            .expect_err("invalid address should fail validation");
        assert!(err.contains("Invalid daemon listen address"));
    }

    #[test]
    fn registry_timestamp_uses_rfc3339() {
        let timestamp = epoch_timestamp();
        assert!(
            chrono::DateTime::parse_from_rfc3339(&timestamp).is_ok(),
            "registry timestamps should use RFC3339, got: {timestamp}"
        );
    }

    #[test]
    fn cli_parses_startup_flags() {
        let cli = Cli::try_parse_from([
            "shore-daemon",
            "--config",
            "/tmp/shore/config.toml",
            "--addr",
            "127.0.0.1:9000",
        ])
        .unwrap();

        assert_eq!(cli.config, Some(PathBuf::from("/tmp/shore/config.toml")));
        assert_eq!(cli.addr.as_deref(), Some("127.0.0.1:9000"));
    }

    #[test]
    fn cli_parses_instance_id_flag() {
        let cli = Cli::try_parse_from(["shore-daemon", "--instance-id", "shore-mcp-test"]).unwrap();
        assert_eq!(cli.instance_id.as_deref(), Some("shore-mcp-test"));
    }

    #[test]
    fn cli_instance_id_defaults_to_none() {
        let cli = Cli::try_parse_from(["shore-daemon"]).unwrap();
        assert!(cli.instance_id.is_none());
    }

    #[test]
    fn explicit_config_path_must_exist() {
        let err = resolve_explicit_config_path(Some(Path::new("/definitely/missing.toml")))
            .expect_err("missing explicit config path should fail");
        assert!(matches!(err, StartupError::InvalidConfigPath { .. }));
        assert!(err.to_string().contains("does not exist"));
    }

    #[test]
    fn explicit_config_path_rejects_directories() {
        let tmp = TempDir::new().unwrap();
        let err = resolve_explicit_config_path(Some(tmp.path()))
            .expect_err("directory should not be accepted as config file");
        assert!(matches!(err, StartupError::InvalidConfigPath { .. }));
        assert!(err.to_string().contains("expected a config.toml file"));
    }

    #[test]
    fn listen_addr_precedence_is_cli_then_env_then_config() {
        let tmp = TempDir::new().unwrap();
        let loaded = shore_config::LoadedConfig::new_for_test(
            shore_config::app::AppConfig::default(),
            shore_config::models::ModelCatalog::default(),
            shore_config::ShoreDirs {
                config: tmp.path().join("config"),
                data: tmp.path().join("data"),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );

        let (addr, source) = resolve_listen_addr(
            Some("127.0.0.1:9000".into()),
            Some("127.0.0.1:8000".into()),
            &loaded,
        );
        assert_eq!(addr, "127.0.0.1:9000");
        assert_eq!(source, StartupValueSource::Cli);

        let (env_addr, env_source) =
            resolve_listen_addr(None, Some("127.0.0.1:8000".into()), &loaded);
        assert_eq!(env_addr, "127.0.0.1:8000");
        assert_eq!(env_source, StartupValueSource::Env);

        let (config_addr, config_source) = resolve_listen_addr(None, None, &loaded);
        assert_eq!(config_addr, "127.0.0.1:7320");
        assert_eq!(config_source, StartupValueSource::Config);
    }

    #[test]
    fn resolve_startup_uses_single_precedence_model() {
        let tmp = TempDir::new().unwrap();
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config_path = config_dir.join("config.toml");
        std::fs::write(
            &config_path,
            r#"
[daemon]
addr = "127.0.0.1:7000"
unsafe_allow_remote_access = true
"#,
        )
        .unwrap();

        let startup = resolve_startup(
            Cli {
                config: Some(config_path.clone()),
                addr: Some("0.0.0.0:9000".into()),
                instance_id: None,
            },
            Some("127.0.0.1:8000".into()),
        )
        .unwrap();

        assert_eq!(startup.config_path, config_path);
        assert_eq!(startup.bind_addr, "0.0.0.0:9000");
        assert_eq!(startup.bind_addr_source, StartupValueSource::Cli);
        assert!(!startup.remote_access_warnings.is_empty());
    }

    #[test]
    fn resolve_startup_reports_env_remote_access_source() {
        let tmp = TempDir::new().unwrap();
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config_path = config_dir.join("config.toml");
        std::fs::write(&config_path, "").unwrap();

        let err = resolve_startup(
            Cli {
                config: Some(config_path),
                addr: None,
                instance_id: None,
            },
            Some("0.0.0.0:9000".into()),
        )
        .expect_err("non-loopback SHORE_ADDR should still enforce remote-access policy");

        assert_variant!(


            err,
            StartupError::RemoteAccessPolicy {
                bind_addr_source, ..
            } => {
                assert_eq!(bind_addr_source, StartupValueSource::Env);
            }


        );
    }
}
