#![recursion_limit = "256"]

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Parser;

use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use shore_diagnostics::logging::HumanLogFormat;
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use shore_config::app::{EmbeddedConfig, MatrixConfig};
use shore_matrix::bot::{BotConfig, MatrixBot, MatrixEvent};
use shore_matrix::bridge::{
    format_user_mirror, input_to_swp, parse_matrix_input, parse_reaction, route_mirror,
    CollectorAction, MatrixInput, MirrorAction, PendingImage, ReactionControl, ResponseCollector,
    RoomTarget,
};
use shore_matrix::connection::{spawn_connection, ConnCommand, ConnEvent};
use shore_matrix::crypto;
use shore_matrix::event_map::{EventMap, EventOrigin, MappedEvent};
use shore_matrix::homeserver::{
    generate_token, wait_for_healthy, HomeserverConfig, HomeserverManager,
};
use shore_matrix::prefs::ViewPrefs;
use shore_matrix::provision::{
    check_room_exists, check_token, create_character_room, join_room, provision_admin,
    provision_character, wipe_embedded_state_and_characters, CharacterPaths, EmbeddedState,
    HomeserverPaths, ProvisionState, RoomStatus, TokenStatus,
};
use shore_matrix::render::render_command_output;
use shore_matrix::rooms::RoomManager;
use shore_protocol::client_msg::{ClientMessage, Command, Regen};
use shore_protocol::server_msg::ServerMessage;

#[derive(Parser)]
#[command(name = "shore-matrix", about = "Matrix bridge for Shore")]
struct Args {
    /// Matrix homeserver URL (external mode, overrides config)
    #[arg(long, env = "MATRIX_HOMESERVER")]
    homeserver: Option<String>,

    /// Matrix user ID (external mode, overrides config)
    #[arg(long, env = "MATRIX_USER_ID")]
    user_id: Option<String>,

    /// Matrix access token (external mode)
    #[arg(long, env = "MATRIX_ACCESS_TOKEN")]
    access_token: Option<String>,

    /// Matrix password (external mode)
    #[arg(long, env = "MATRIX_PASSWORD")]
    password: Option<String>,

    /// Matrix device ID
    #[arg(long, env = "MATRIX_DEVICE_ID")]
    device_id: Option<String>,

    /// Trusted user for automatic SAS verification
    #[arg(long, env = "MATRIX_TRUSTED_USER")]
    trusted_user: Option<String>,

    /// Daemon address (host:port)
    #[arg(long)]
    addr: Option<String>,

    /// Character to connect as on the daemon (external mode; ignored in embedded mode)
    #[arg(long, env = "SHORE_CHARACTER")]
    character: Option<String>,

    /// Shore config directory (for reading [connections.matrix] and daemon discovery)
    #[arg(long)]
    config: Option<String>,

    /// Path for Matrix state and crypto store (defaults to <shore-data-dir>/matrix-store)
    #[arg(long)]
    store_path: Option<String>,

    /// Run one-shot provisioning setup, then exit (used by `shore matrix setup`)
    #[arg(long, hide = true)]
    setup: bool,

    /// Register a user account on embedded Synapse, then exit
    #[arg(long, hide = true)]
    register: Option<String>,

    /// Password for --register
    #[arg(long, hide = true)]
    register_password: Option<String>,
}

const DEFAULT_LOG_FILTER: &str = "warn,shore_matrix=info,matrix_sdk_crypto::backups=error";

/// What a character's bound room receives from the daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MirrorMode {
    /// Full conversation mirror: every prompt and reply, whichever client
    /// drove it (other clients' prompts render as blockquotes).
    All,
    /// Only what concerns this room: replies to prompts sent from Matrix and
    /// the character's autonomous (heartbeat) messages. Messages already
    /// shown still sync in place when they change daemon-side.
    Replies,
    /// Legacy request/response routing through `ResponseCollector`; no
    /// conversation mirroring at all.
    Off,
}

impl MirrorMode {
    /// Whether this mode mirrors conversation state (event map, self-echo
    /// suppression, in-place sync).
    fn mirrors(self) -> bool {
        self != Self::Off
    }
}

#[derive(Debug)]
struct MatrixFileConfig {
    matrix: Option<MatrixConfig>,
    /// What bound rooms receive — see [`MirrorMode`]. Read here (and stripped
    /// before the typed parse) rather than off `MatrixConfig` so the bridge
    /// stays decoupled from the shore-config release that adds the typed
    /// fields — see `matrix_from_table`.
    mirror: MirrorMode,
    config_dir: PathBuf,
}

#[derive(Debug, Error)]
enum MatrixConfigError {
    #[error("failed to load Shore config files for Matrix bridge: {0}")]
    Load(#[source] Box<shore_config::ConfigError>),

    #[error("failed to parse [connections.matrix] for Matrix bridge: {0}")]
    Matrix(#[source] Box<toml::de::Error>),

    #[error(
        "invalid [connections.matrix].mirror value {0:?} (expected \"replies\", \"all\", or \"off\")"
    )]
    MirrorMode(String),
}

impl From<shore_config::ConfigError> for MatrixConfigError {
    fn from(error: shore_config::ConfigError) -> Self {
        Self::Load(Box::new(error))
    }
}

fn resolve_store_path(arg: &Option<String>) -> String {
    match arg {
        Some(p) => p.clone(),
        None => shore_config::data_dir()
            .join("matrix-store")
            .to_string_lossy()
            .into_owned(),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(DEFAULT_LOG_FILTER)),
        )
        .event_format(HumanLogFormat)
        .init();

    let args = Args::parse();

    // Load only [connections.matrix]. The bridge must not be coupled to
    // unrelated daemon config sections like [usage] or provider catalogs.
    let matrix_config = load_matrix_config(&args.config)?;
    let file_config = matrix_config.matrix;
    let mirror = matrix_config.mirror;
    let config_dir = matrix_config.config_dir;
    let daemon_config = daemon_config_selector(&args.config, &config_dir);

    // Determine mode
    if let Some(ref fc) = file_config {
        if !fc.enabled {
            return Err("[connections.matrix] is disabled".into());
        }

        if let Some(ref embedded) = fc.embedded {
            if fc.homeserver.is_some() {
                return Err(
                    "Cannot specify both 'homeserver' and 'embedded' in [connections.matrix]"
                        .into(),
                );
            }
            return run_embedded(embedded, fc, &args, &config_dir, daemon_config, mirror).await;
        }
    }

    // External mode: use CLI args, falling back to config file values
    run_external(&file_config, &args, &config_dir, daemon_config, mirror).await
}

/// Load only the Matrix-owned portion of Shore config.
fn load_matrix_config(config_flag: &Option<String>) -> Result<MatrixFileConfig, MatrixConfigError> {
    let config_path = config_flag.as_deref().map(config_file_from_arg);
    let raw = shore_config::load_raw_config_table(config_path.as_deref())?;
    let (matrix, mirror) = matrix_from_table(&raw.table)?;
    Ok(MatrixFileConfig {
        matrix,
        mirror,
        config_dir: raw.dirs.config,
    })
}

/// Parse `[connections.matrix]`, returning the typed config plus the mirror
/// mode.
///
/// Mode selection: `mirror = "replies" | "all" | "off"` (default `"replies"`),
/// with the older boolean `mirror_all` still honored when `mirror` is absent
/// (`true` → all, `false` → off).
///
/// We extract both keys ourselves and strip them before the typed parse: the
/// `MatrixConfig` from crates.io is `#[serde(deny_unknown_fields)]`, so leaving
/// them in would fail deserialization on a shore-config version that predates
/// the fields. Stripping keeps the bridge buildable on the current published
/// crate while still honoring the keys (the daemon parses the same config with
/// its own, field-aware shore-config).
fn matrix_from_table(
    table: &toml::Table,
) -> Result<(Option<MatrixConfig>, MirrorMode), MatrixConfigError> {
    let Some(connections) = table.get("connections").and_then(toml::Value::as_table) else {
        return Ok((None, MirrorMode::Replies));
    };
    let Some(matrix) = connections.get("matrix") else {
        return Ok((None, MirrorMode::Replies));
    };
    let mut matrix = matrix.clone();
    let mirror_key = matrix
        .as_table_mut()
        .and_then(|t| t.remove("mirror"))
        .and_then(|value| value.as_str().map(str::to_string));
    let mirror_all = matrix
        .as_table_mut()
        .and_then(|t| t.remove("mirror_all"))
        .and_then(|value| value.as_bool());
    let mirror = match mirror_key.as_deref() {
        Some("replies") => MirrorMode::Replies,
        Some("all") => MirrorMode::All,
        Some("off") => MirrorMode::Off,
        Some(other) => return Err(MatrixConfigError::MirrorMode(other.to_string())),
        None => match mirror_all {
            Some(true) => MirrorMode::All,
            Some(false) => MirrorMode::Off,
            None => MirrorMode::Replies,
        },
    };
    let parsed: MatrixConfig = matrix
        .try_into()
        .map_err(|e| MatrixConfigError::Matrix(Box::new(e)))?;
    Ok((Some(parsed), mirror))
}

fn config_file_from_arg(raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_dir() || path.extension().is_none() {
        path.join("config.toml")
    } else {
        path
    }
}

#[cfg(test)]
fn config_dir_from_arg(raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_dir() || path.extension().is_none() {
        path
    } else {
        path.parent().unwrap_or(Path::new(".")).to_path_buf()
    }
}

fn daemon_config_selector(config_flag: &Option<String>, config_dir: &Path) -> Option<String> {
    config_flag
        .as_ref()
        .map(|_| config_dir.to_string_lossy().into_owned())
}

// ── External mode ───────────────────────────────────────────────────────

async fn run_external(
    file_config: &Option<MatrixConfig>,
    args: &Args,
    config_dir: &Path,
    daemon_config: Option<String>,
    mirror: MirrorMode,
) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve fields: CLI args take precedence over config file
    let homeserver = args
        .homeserver
        .clone()
        .or_else(|| file_config.as_ref()?.homeserver.clone())
        .ok_or("homeserver required (--homeserver or [connections.matrix].homeserver)")?;

    let user_id = args
        .user_id
        .clone()
        .or_else(|| file_config.as_ref()?.user_id.clone())
        .ok_or("user_id required (--user-id or [connections.matrix].user_id)")?;

    let trusted_user = args
        .trusted_user
        .clone()
        .or_else(|| file_config.as_ref()?.trusted_user.clone());

    let store_path = resolve_store_path(&args.store_path);
    let event_map = EventMap::load(&Path::new(&store_path).join("bridge-event-map.json"));
    let view_prefs = ViewPrefs::load(&Path::new(&store_path).join("bridge-view-prefs.json"));
    let bot_config = BotConfig {
        homeserver,
        user_id,
        access_token: args.access_token.clone(),
        password: args.password.clone(),
        device_id: args.device_id.clone(),
        store_path,
        config_dir: config_dir.to_path_buf(),
    };
    let (bot, matrix_rx) = MatrixBot::new(&bot_config).await?;

    if let Some(ref trusted) = trusted_user {
        crypto::setup_verification(&bot.client, trusted)?;
    }

    bot.start_sync();

    let (daemon_tx, daemon_rx) =
        spawn_connection(args.addr.clone(), daemon_config, args.character.clone());
    let room_manager = RoomManager::new();

    info!("shore-matrix bridge running (external mode)");
    let bridge = Bridge::new(bot, daemon_tx, room_manager, mirror, event_map, view_prefs);
    run_bridge_loop(bridge, matrix_rx, daemon_rx).await;
    Ok(())
}

// ── Embedded mode ───────────────────────────────────────────────────────

async fn run_embedded(
    embedded: &EmbeddedConfig,
    fc: &MatrixConfig,
    args: &Args,
    config_dir: &Path,
    daemon_config: Option<String>,
    mirror: MirrorMode,
) -> Result<(), Box<dyn std::error::Error>> {
    // 1. Resolve paths
    let hs_paths = match &embedded.data_dir {
        Some(dir) => HomeserverPaths::from_data_dir(dir),
        None => HomeserverPaths::new(),
    };

    // 2. Build HomeserverConfig (without registration_token yet — filled in
    //    after state load). We construct it early so `homeserver_url()` is the
    //    single source of truth for the local-bridge URL.
    let mut hs_config = HomeserverConfig {
        server_name: embedded.server_name.clone(),
        bind_address: embedded.bind_address.clone(),
        port: embedded.port,
        data_dir: hs_paths.server_dir.clone(),
        registration_token: String::new(),
        allow_federation: false,
    };
    let homeserver_url = hs_config.homeserver_url();

    // 3. Load or initialize embedded state
    let (mut embedded_state, mut first_run) =
        load_or_init_state(&hs_paths, embedded, &homeserver_url)?;
    hs_config.registration_token = embedded_state.registration_token.clone();

    // 4. Start homeserver
    let mut hs_manager = HomeserverManager::new(hs_config, embedded.binary.clone());
    hs_manager.start().await.map_err(|e| {
        format!(
            "Failed to start homeserver: {e}\n\
             Install a conduwuit-compatible Matrix homeserver:\n  \
             continuwuity: https://github.com/continuwuity/continuwuity\n  \
             tuwunel: https://github.com/matrix-construct/tuwunel"
        )
    })?;
    info!(
        "started {} (port {})",
        hs_manager.binary_name(),
        embedded.port
    );

    // 5. Wait for homeserver to be healthy
    let healthy = wait_for_healthy(&homeserver_url, Duration::from_secs(30)).await;
    if !healthy {
        hs_manager.stop().await.ok();
        return Err("homeserver failed to become healthy within 30s".into());
    }
    info!("homeserver is healthy at {homeserver_url}");

    // 5b. If we loaded existing embedded state, verify the admin token is
    //     still accepted. A 401 means the homeserver DB was wiped out from
    //     under us; every character's provision.json is now invalid by
    //     association. Preserve the registration_token (the running
    //     homeserver is configured with it) and re-provision everything.
    if !first_run {
        match check_token(&homeserver_url, &embedded_state.admin_access_token).await {
            TokenStatus::Valid { .. } => {}
            TokenStatus::Invalid => {
                warn!("admin token rejected (401) — homeserver DB appears wiped, re-provisioning");
                let wiped = wipe_embedded_state_and_characters(&hs_paths)
                    .await
                    .map_err(|e| format!("failed to wipe stale state: {e}"))?;
                if !wiped.is_empty() {
                    warn!(
                        "wiped stale provision state for characters: {}",
                        wiped.join(", ")
                    );
                }
                embedded_state.admin_user_id.clear();
                embedded_state.admin_access_token.clear();
                embedded_state.admin_device_id.clear();
                embedded_state
                    .save(&hs_paths.state_file)
                    .map_err(|e| format!("failed to save reset embedded state: {e}"))?;
                first_run = true;
            }
            TokenStatus::Unknown(err) => {
                hs_manager.stop().await.ok();
                return Err(format!("could not verify admin token: {err}").into());
            }
        }
    }

    // 6. Provision admin (first run only)
    if first_run {
        eprintln!("shore-matrix: first-run setup — provisioning embedded Matrix homeserver...");
        let admin_reg = provision_admin(
            &homeserver_url,
            &embedded_state.registration_token,
            &embedded.admin_user,
            &embedded_state.admin_password,
        )
        .await
        .map_err(|e| format!("Admin provisioning failed: {e}"))?;

        embedded_state.admin_user_id = admin_reg.user_id;
        embedded_state.admin_access_token = admin_reg.access_token;
        embedded_state.admin_device_id =
            admin_reg.device_id.unwrap_or_else(|| "SHORE_ADMIN".into());
        embedded_state
            .save(&hs_paths.state_file)
            .map_err(|e| format!("Failed to save embedded state: {e}"))?;
        info!("admin account provisioned");
    }

    // Handle --register (register a user account and exit)
    if let Some(ref username) = args.register {
        // The admin account was provisioned during setup using the configured
        // admin_user + admin_password. If the caller asks to register the same
        // username, there's nothing new to create — just print the existing
        // credentials so they can log into their Matrix client.
        if username == &embedded.admin_user {
            println!(
                "Admin account already provisioned — use these credentials in your Matrix client:"
            );
            println!("  User ID:    {}", embedded_state.admin_user_id);
            println!("  Password:   {}", embedded.admin_password);
            println!("  Homeserver: {homeserver_url}");
            hs_manager.stop().await.ok();
            return Ok(());
        }

        let password = args
            .register_password
            .clone()
            .unwrap_or_else(generate_token);
        let reg = shore_matrix::provision::register_account(
            &homeserver_url,
            &embedded_state.registration_token,
            username,
            &password,
        )
        .await
        .map_err(|e| format!("Registration failed: {e}"))?;

        println!("Account registered:");
        println!("  User ID:    {}", reg.user_id);
        println!("  Password:   {password}");
        println!("  Homeserver: {homeserver_url}");
        hs_manager.stop().await.ok();
        return Ok(());
    }

    // 7. Connect to daemon to discover characters (no character selected; we
    //    want the full character list via the handshake). In embedded mode the
    //    same connection is then reused for bridging, which means the daemon
    //    will route all messages to its default character — multi-character
    //    embedded bridging would need one connection per character.
    let (daemon_tx, mut daemon_rx) = spawn_connection(args.addr.clone(), daemon_config, None);

    info!("waiting for daemon connection to discover characters...");
    let characters = wait_for_characters(&mut daemon_rx).await?;
    info!("discovered {} character(s)", characters.len());

    // 8. Provision each character
    let mut character_states: Vec<ProvisionState> = Vec::new();
    for char_name in &characters {
        let paths = CharacterPaths::new(char_name);
        let password = generate_token();
        let state = provision_character(
            &homeserver_url,
            &embedded_state.registration_token,
            char_name,
            &password,
            &paths,
        )
        .await
        .map_err(|e| format!("Failed to provision character {char_name}: {e}"))?;
        character_states.push(state);
    }

    // 8b. Verify saved room_ids still exist on the homeserver. A character
    //     may have kept its token (still valid) but had its room manually
    //     deleted (or forgotten via /forget). Clear stale room_ids so the
    //     create-room branch below recreates them.
    for state in &mut character_states {
        let Some(room_id) = state.room_id.as_deref() else {
            continue;
        };
        match check_room_exists(&homeserver_url, room_id, &embedded_state.admin_access_token).await
        {
            RoomStatus::Exists => {}
            RoomStatus::Gone => {
                warn!(
                    "room {room_id} for character {} no longer exists, will recreate",
                    state.character
                );
                state.room_id = None;
                let paths = CharacterPaths::new(&state.character);
                state
                    .save_async(&paths.provision_file)
                    .await
                    .map_err(|e| format!("Failed to save provision state: {e}"))?;
            }
            RoomStatus::Unknown(err) => {
                warn!(
                    "could not verify room {room_id} for {}: {err} — assuming it exists",
                    state.character
                );
            }
        }
    }

    // 9. Create rooms for characters that don't have one
    let trusted_user = fc.trusted_user.as_deref();
    for state in &mut character_states {
        if state.room_id.is_none() {
            let room_id = create_character_room(
                &homeserver_url,
                &embedded_state.admin_access_token,
                &embedded_state.admin_user_id,
                &state.user_id,
                trusted_user,
                &state.character,
            )
            .await
            .map_err(|e| format!("Failed to create room for {}: {e}", state.character))?;

            // Have the character bot join
            join_room(&homeserver_url, &room_id, &state.access_token)
                .await
                .map_err(|e| format!("Failed to join room: {e}"))?;

            state.room_id = Some(room_id);
            let paths = CharacterPaths::new(&state.character);
            state
                .save_async(&paths.provision_file)
                .await
                .map_err(|e| format!("Failed to save provision state: {e}"))?;
        }
    }

    // Handle --setup (print summary and exit)
    if args.setup {
        println!("Embedded Matrix homeserver setup complete.\n");
        println!("  Homeserver:  {homeserver_url}");
        println!("  Server name: {}", embedded.server_name);
        println!("  Data dir:    {}\n", hs_paths.server_dir.display());
        println!("  Admin: {}", embedded_state.admin_user_id);
        println!();
        for state in &character_states {
            println!(
                "  {} → {} (room: {})",
                state.character,
                state.user_id,
                state.room_id.as_deref().unwrap_or("—")
            );
        }
        if let Some(trusted) = trusted_user {
            println!("\n  Trusted user: {trusted}");
        }
        println!(
            "\nTo register your Matrix client account:\n  shore matrix register --username <name>"
        );
        hs_manager.stop().await.ok();
        return Ok(());
    }

    // 10. Start the Matrix bot as the first character
    let primary = character_states.first().ok_or("No characters to bridge")?;

    let store_path = resolve_store_path(&args.store_path);
    let event_map = EventMap::load(&Path::new(&store_path).join("bridge-event-map.json"));
    let view_prefs = ViewPrefs::load(&Path::new(&store_path).join("bridge-view-prefs.json"));
    let bot_config = BotConfig {
        homeserver: homeserver_url.clone(),
        user_id: primary.user_id.clone(),
        access_token: Some(primary.access_token.clone()),
        password: None,
        device_id: Some(primary.device_id.clone()),
        store_path,
        config_dir: config_dir.to_path_buf(),
    };
    let (bot, matrix_rx) = MatrixBot::new(&bot_config).await?;

    if let Some(ref trusted) = fc.trusted_user {
        crypto::setup_verification(&bot.client, trusted)?;
    }

    for state in &character_states {
        bot.sync_avatar(&state.character).await;
    }

    bot.start_sync();

    // 11. Pre-populate room bindings
    let mut room_manager = RoomManager::new();
    for state in &character_states {
        if let Some(ref room_id) = state.room_id {
            room_manager.bind(room_id, &state.character);
        }
    }

    eprintln!(
        "shore-matrix: bridge starting ({} character(s), homeserver {homeserver_url})",
        character_states.len()
    );
    info!("shore-matrix bridge running (embedded mode)");
    let bridge = Bridge::new(bot, daemon_tx, room_manager, mirror, event_map, view_prefs);
    tokio::select! {
        _ = run_bridge_loop(bridge, matrix_rx, daemon_rx) => {}
        _ = shutdown_signal() => {
            info!("received shutdown signal, stopping homeserver");
        }
    }

    // 12. Cleanup
    hs_manager.stop().await.ok();
    Ok(())
}

/// Resolve when the process is asked to terminate (SIGTERM from a supervising
/// daemon/systemd, or Ctrl-C interactively), so we can stop the homeserver
/// instead of leaking it. SIGKILL cannot be caught — PR_SET_PDEATHSIG on the
/// child (see `homeserver::HomeserverManager::start`) covers that case.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn load_or_init_state(
    paths: &HomeserverPaths,
    embedded: &EmbeddedConfig,
    homeserver_url: &str,
) -> Result<(EmbeddedState, bool), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&paths.server_dir)?;

    if let Some(state) = EmbeddedState::load(&paths.state_file)? {
        Ok((state, false))
    } else {
        let reg_token = generate_token();
        let state = EmbeddedState {
            registration_token: reg_token,
            admin_user_id: String::new(),
            admin_access_token: String::new(),
            admin_device_id: String::new(),
            admin_password: embedded.admin_password.clone(),
            homeserver_url: homeserver_url.to_string(),
        };
        state.save(&paths.state_file)?;
        Ok((state, true))
    }
}

/// Wait for the daemon hello and return the list of character names.
async fn wait_for_characters(
    daemon_rx: &mut mpsc::Receiver<ConnEvent>,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    loop {
        match daemon_rx.recv().await {
            Some(ConnEvent::Connected { characters, .. }) => {
                return Ok(characters.iter().map(|c| c.name.clone()).collect());
            }
            Some(ConnEvent::Disconnected(reason)) => {
                warn!("daemon disconnected during setup: {reason}, retrying...");
                // The connection loop in spawn_connection auto-reconnects
            }
            None => return Err("daemon connection channel closed".into()),
            _ => {}
        }
    }
}

// ── Shared bridge loop ──────────────────────────────────────────────────

async fn run_bridge_loop(
    mut bridge: Bridge,
    mut matrix_rx: mpsc::Receiver<MatrixEvent>,
    mut daemon_rx: mpsc::Receiver<ConnEvent>,
) {
    loop {
        tokio::select! {
            biased;

            // Matrix events (user messages / edits / redactions / reactions)
            Some(event) = matrix_rx.recv() => bridge.handle_matrix_event(event).await,

            // Daemon events (responses from shore-daemon)
            Some(event) = daemon_rx.recv() => bridge.handle_daemon_event(event).await,
        }
    }
}

// ── Bridge state & routing ──────────────────────────────────────────────

const MAX_PENDING_SELF_INPUTS: usize = 8;

/// Minimum gap between progressive `m.replace` edits while streaming a reply.
/// Small enough to feel live, large enough to keep the event stream (and
/// clients replaying it) sane.
const STREAM_EDIT_INTERVAL: Duration = Duration::from_millis(1500);

/// Cursor appended to a partially streamed message.
const STREAM_CURSOR: &str = " ▌";

/// An in-flight reply being mirrored into a room via progressive edits.
///
/// Stream frames are session-private, so this is always a generation this
/// bridge requested. Persist-then-StreamEnd ordering means the reply's
/// `NewMessage` arrives while this is still live — `post_reply` adopts the
/// streamed event instead of posting a duplicate.
struct StreamMirror {
    room: OwnedRoomId,
    /// Event being progressively edited. Pre-seeded with the previous reply's
    /// event for regens (the room's latest reply rewrites in place); `None`
    /// until the first chunk posts otherwise.
    event_id: Option<String>,
    buffer: String,
    last_edit: std::time::Instant,
    /// Tool activity observed during this generation (session-private frames,
    /// so only bridge-originated generations have these).
    tools: Vec<ToolActivity>,
    /// Set once the reply's `NewMessage` adopts the streamed event — the
    /// exact decorated text last written, so `StreamEnd` can append the usage
    /// footer without losing the thinking/tools sections.
    final_text: Option<String>,
}

/// One tool invocation observed while streaming.
struct ToolActivity {
    id: String,
    name: String,
    done: bool,
    error: bool,
}

/// A `MirrorAction::Post` unpacked for [`Bridge::post_reply`].
struct ReplyToPost<'a> {
    msg_id: Option<String>,
    replaces_last: bool,
    autonomous: bool,
    /// The daemon's previous latest assistant msg_id for this character —
    /// the message a `replaces_last` reply actually displaced.
    prev_assistant: Option<String>,
    thinking: Option<&'a str>,
    text: &'a str,
    images: &'a [PendingImage],
}

/// All bridge-loop state: Matrix bot, daemon channel, room bindings, and the
/// msg_id ↔ event_id map that powers Matrix-native edit/delete/reaction flows.
struct Bridge {
    bot: MatrixBot,
    daemon_tx: mpsc::Sender<ConnCommand>,
    room_manager: RoomManager,
    event_map: EventMap,
    mirror: MirrorMode,
    active_room: Option<OwnedRoomId>,
    known_characters: Vec<String>,
    /// Prompts this bridge forwarded — `(text, matrix event id)` per character.
    /// Used to suppress the daemon's echo of our own `UserInput` (the sender
    /// already sees their message) and to map the echo's msg_id back to the
    /// originating Matrix event. Prompts from other clients won't match and
    /// get mirrored.
    pending_self_inputs: HashMap<String, VecDeque<(String, String)>>,
    /// Reply currently being streamed into a room (mirror mode).
    stream: Option<StreamMirror>,
    /// Per-room display preferences (thinking / tools / usage).
    view_prefs: ViewPrefs,
    /// The daemon's latest assistant msg_id per character, whether or not it
    /// was shown in the room. Regen always targets *this* message, so 🔁 and
    /// regen-replacement edits must check against it — in `Replies` mode the
    /// room's latest shown reply can lag behind the daemon's.
    last_assistant: HashMap<String, String>,
    /// Legacy (`mirror = "off"`) streaming collectors.
    collectors: HashMap<OwnedRoomId, ResponseCollector>,
}

impl Bridge {
    fn new(
        bot: MatrixBot,
        daemon_tx: mpsc::Sender<ConnCommand>,
        room_manager: RoomManager,
        mirror: MirrorMode,
        event_map: EventMap,
        view_prefs: ViewPrefs,
    ) -> Self {
        Self {
            bot,
            daemon_tx,
            room_manager,
            event_map,
            mirror,
            active_room: None,
            known_characters: Vec::new(),
            pending_self_inputs: HashMap::new(),
            stream: None,
            view_prefs,
            last_assistant: HashMap::new(),
            collectors: HashMap::new(),
        }
    }

    /// The daemon's latest assistant msg_id for the character bound to `room`.
    fn last_assistant_for_room(&self, room_id: &str) -> Option<&str> {
        let character = self.room_manager.character_for_room(room_id)?;
        self.last_assistant.get(character).map(String::as_str)
    }

    async fn send_swp(&self, msg: ClientMessage) {
        if self.daemon_tx.send(ConnCommand::Send(msg)).await.is_err() {
            error!("daemon connection dropped");
        }
    }

    async fn send_command(&self, name: &str, args: serde_json::Value) {
        self.send_swp(ClientMessage::Command(Command {
            rid: None,
            name: name.into(),
            args,
        }))
        .await;
    }

    // ── Matrix → daemon ─────────────────────────────────────────────────

    async fn handle_matrix_event(&mut self, event: MatrixEvent) {
        match event {
            MatrixEvent::Message {
                room_id,
                event_id,
                text,
                ..
            } => match parse_matrix_input(&text) {
                MatrixInput::Bind { character } => {
                    self.handle_bind(&room_id, character.as_deref()).await;
                }
                MatrixInput::View { key, value } => {
                    let reply = match key {
                        None => {
                            let v = self.view_prefs.room(room_id.as_str());
                            format!(
                                "view — thinking: {}, tools: {}, usage: {}",
                                onoff(v.thinking),
                                onoff(v.tools),
                                onoff(v.usage),
                            )
                        }
                        Some(key) => match self.view_prefs.set(room_id.as_str(), &key, value) {
                            Some(enabled) => format!("view {key}: {}", onoff(enabled)),
                            None => format!(
                                "unknown view option `{key}` — expected {}",
                                ViewPrefs::KEYS.join("|"),
                            ),
                        },
                    };
                    self.bot.send_notice(&room_id, &reply).await;
                }
                MatrixInput::LocalReply(reply) => {
                    self.bot.send_notice(&room_id, &reply).await;
                }
                MatrixInput::Forward(msgs) => {
                    self.active_room = Some(room_id);
                    for msg in msgs {
                        self.send_swp(msg).await;
                    }
                }
                input @ (MatrixInput::Text(_) | MatrixInput::Image { .. }) => {
                    self.forward_user_input(&room_id, &event_id, &input).await;
                }
            },
            MatrixEvent::Image {
                room_id,
                event_id,
                path,
                data,
                mime_type,
                body,
                ..
            } => {
                let input = MatrixInput::Image {
                    path,
                    data,
                    mime_type,
                    caption: Some(body),
                };
                self.forward_user_input(&room_id, &event_id, &input).await;
            }
            MatrixEvent::Edit {
                room_id,
                target_event_id,
                new_text,
                ..
            } => {
                self.handle_matrix_edit(&room_id, target_event_id.as_str(), &new_text)
                    .await;
            }
            MatrixEvent::Redaction {
                room_id, redacts, ..
            } => {
                self.handle_matrix_redaction(&room_id, redacts.as_str())
                    .await;
            }
            MatrixEvent::Reaction {
                room_id,
                target_event_id,
                key,
                ..
            } => {
                self.handle_matrix_reaction(&room_id, target_event_id.as_str(), &key)
                    .await;
            }
        }
    }

    async fn forward_user_input(
        &mut self,
        room_id: &OwnedRoomId,
        event_id: &matrix_sdk::ruma::EventId,
        input: &MatrixInput,
    ) {
        if let Some(swp_msg) = input_to_swp(input) {
            if self.mirror.mirrors() {
                self.record_self_input(room_id, event_id.as_str(), &swp_msg);
            }
            self.send_swp(swp_msg).await;
        }
        self.active_room = Some(room_id.clone());
    }

    /// A user edited a Matrix message → daemon `edit` on the mapped msg_id.
    async fn handle_matrix_edit(&mut self, room_id: &OwnedRoomId, target: &str, new_text: &str) {
        let Some(entry) = self.event_map.by_event_id(target) else {
            self.bot
                .send_notice(
                    room_id,
                    "Can't apply that edit — the original message isn't tracked by the bridge.",
                )
                .await;
            return;
        };
        let msg_id = entry.msg_id.clone();
        self.active_room = Some(room_id.clone());
        // Update stored content up front so the resulting History broadcast
        // isn't mistaken for a daemon-side edit that needs mirroring back.
        self.event_map.update_content(&msg_id, new_text);
        self.send_command(
            "edit",
            serde_json::json!({ "ref": msg_id, "content": new_text }),
        )
        .await;
    }

    /// A user redacted a Matrix message → daemon `delete` on the mapped msg_id.
    async fn handle_matrix_redaction(&mut self, room_id: &OwnedRoomId, redacts: &str) {
        // Remove the mapping immediately: the Matrix side is already gone, so
        // no later daemon mutation should try to touch this event.
        let Some(entry) = self.event_map.remove_event(redacts) else {
            return;
        };
        self.active_room = Some(room_id.clone());
        self.send_command("delete", serde_json::json!({ "refs": entry.msg_id }))
            .await;
    }

    /// Reaction controls: 🔁 regen, 🗑 delete, ◀/▶ alternate responses.
    async fn handle_matrix_reaction(&mut self, room_id: &OwnedRoomId, target: &str, key: &str) {
        let Some(control) = parse_reaction(key) else {
            return;
        };
        let Some(entry) = self.event_map.by_event_id(target) else {
            self.bot
                .send_notice(room_id, "That message isn't tracked by the bridge.")
                .await;
            return;
        };
        let msg_id = entry.msg_id.clone();
        self.active_room = Some(room_id.clone());
        match control {
            ReactionControl::Regen => {
                // SWP regen always targets the daemon's latest reply; honor
                // the reaction only when it points there. (The room's latest
                // shown reply can lag the daemon's in `Replies` mode, so
                // check the tracked daemon-side id when we have it.)
                let is_latest = match self.last_assistant_for_room(room_id.as_str()) {
                    Some(last) => last == msg_id,
                    None => self
                        .event_map
                        .latest_reply_in_room(room_id.as_str())
                        .is_some_and(|e| e.msg_id == msg_id),
                };
                if is_latest {
                    self.send_swp(ClientMessage::Regen(Regen {
                        rid: None,
                        stream: true,
                        guidance: None,
                    }))
                    .await;
                } else {
                    self.bot
                        .send_notice(room_id, "🔁 regenerates only the latest reply.")
                        .await;
                }
            }
            ReactionControl::Delete => {
                self.send_command("delete", serde_json::json!({ "refs": msg_id }))
                    .await;
            }
            ReactionControl::AltPrev => {
                self.send_command(
                    "alt",
                    serde_json::json!({ "ref": msg_id, "direction": "prev" }),
                )
                .await;
            }
            ReactionControl::AltNext => {
                self.send_command(
                    "alt",
                    serde_json::json!({ "ref": msg_id, "direction": "next" }),
                )
                .await;
            }
        }
    }

    // ── Daemon → Matrix ─────────────────────────────────────────────────

    async fn handle_daemon_event(&mut self, event: ConnEvent) {
        match event {
            ConnEvent::Connected {
                server_name,
                characters,
                history,
                selected_character,
                ..
            } => {
                info!("connected to daemon: {server_name}");
                self.known_characters = characters.iter().map(|c| c.name.clone()).collect();

                if let Some(first) = self.known_characters.first() {
                    self.bot.sync_avatar(first).await;
                }

                // Catch up on mutations that happened while the bridge was
                // down: the handshake history is a full snapshot, same shape
                // as a History broadcast.
                if self.mirror.mirrors() {
                    self.sync_history(selected_character.as_deref(), &history)
                        .await;
                }
            }
            ConnEvent::Disconnected(reason) => {
                info!("daemon disconnected: {reason}");
            }
            ConnEvent::Message(msg) => {
                if self.mirror.mirrors() {
                    self.dispatch_mirror(&msg).await;
                } else {
                    self.dispatch_legacy(&msg).await;
                }
            }
        }
    }

    /// Route one daemon message in `mirror_all` mode: each NewMessage goes to
    /// its character's bound room; stream/command/error frames ride the active
    /// room.
    async fn dispatch_mirror(&mut self, msg: &ServerMessage) {
        // Frames that need structured data or stream state are intercepted
        // before the pure route_mirror translation (which only carries
        // display strings). Subagent-tagged stream frames fall through — they
        // only drive the typing indicator.
        match msg {
            ServerMessage::CommandOutput(out) => {
                if self.handle_mutation_output(out).await {
                    return;
                }
            }
            ServerMessage::History(h) => {
                self.sync_history(h.selected_character.as_deref(), &h.messages)
                    .await;
                return;
            }
            ServerMessage::StreamStart(s) if s.subagent.is_none() => {
                self.stream_start(s.regen).await;
                return;
            }
            ServerMessage::StreamChunk(c) if c.subagent.is_none() => {
                self.stream_chunk(&c.text, &c.content_type).await;
                return;
            }
            ServerMessage::StreamEnd(e) if e.subagent.is_none() => {
                self.stream_end(&e.content, e.msg_id.as_deref(), &e.metadata)
                    .await;
                return;
            }
            // Tool frames are session-private — they only occur during our
            // own generations. Track them for `!view tools`.
            ServerMessage::ToolCall(tc) if tc.subagent.is_none() => {
                if let Some(stream) = &mut self.stream {
                    stream.tools.push(ToolActivity {
                        id: tc.tool_id.clone(),
                        name: tc.tool_name.clone(),
                        done: false,
                        error: false,
                    });
                    let room = stream.room.clone();
                    self.bot.set_typing(&room, true).await;
                }
                return;
            }
            ServerMessage::ToolResult(tr) if tr.subagent.is_none() => {
                if let Some(stream) = &mut self.stream {
                    if let Some(t) = stream.tools.iter_mut().rev().find(|t| t.id == tr.tool_id) {
                        t.done = true;
                        t.error = tr.is_error;
                    }
                }
                return;
            }
            _ => {}
        }

        // Track the daemon's latest assistant message per character (shown in
        // the room or not) — the reference point for regen targeting.
        let mut prev_assistant = None;
        if let ServerMessage::NewMessage(nm) = msg {
            if nm.message.origin != Some(shore_protocol::types::MessageOrigin::UserInput)
                && !nm.message.msg_id.is_empty()
            {
                let character = nm.character.clone().unwrap_or_default();
                prev_assistant = self.last_assistant.get(&character).cloned();
                self.last_assistant
                    .insert(character, nm.message.msg_id.clone());
            }
        }

        let route = route_mirror(msg);
        let character = match &route.target {
            RoomTarget::Character(character) => character.clone(),
            RoomTarget::Active => None,
        };
        let room = match &route.target {
            RoomTarget::Active => self.active_room.clone(),
            RoomTarget::Character(character) => {
                resolve_character_room(&self.room_manager, character.as_deref())
                    .or_else(|| self.active_room.clone())
            }
        };
        let Some(room) = room else {
            return;
        };

        match route.action {
            MirrorAction::StartTyping => self.bot.set_typing(&room, true).await,
            MirrorAction::StopTyping => self.bot.set_typing(&room, false).await,
            MirrorAction::Post {
                msg_id,
                replaces_last,
                autonomous,
                thinking,
                text,
                images,
            } => {
                self.post_reply(
                    &room,
                    ReplyToPost {
                        msg_id,
                        replaces_last,
                        autonomous,
                        prev_assistant,
                        thinking: thinking.as_deref(),
                        text: &text,
                        images: &images,
                    },
                )
                .await;
            }
            MirrorAction::UserPrompt { msg_id, content } => {
                match self.consume_self_echo(character.as_deref(), &content) {
                    // Our own echo: the user already sees their Matrix message;
                    // just map it so edits/redactions/reactions can target it.
                    Some(event_id) => {
                        if let Some(msg_id) = msg_id {
                            self.event_map.record(MappedEvent {
                                msg_id,
                                room_id: room.to_string(),
                                event_id,
                                origin: EventOrigin::MatrixUser,
                                content,
                            });
                        }
                    }
                    // Another client's prompt: mirror it as the bot — but
                    // only in full-mirror mode. In `Replies` mode other
                    // clients' conversations stay out of the room.
                    None => {
                        if self.mirror != MirrorMode::All {
                            return;
                        }
                        let posted = self
                            .bot
                            .send_text(&room, &format_user_mirror(&content))
                            .await;
                        if let (Some(msg_id), Some(event_id)) = (msg_id, posted) {
                            self.event_map.record(MappedEvent {
                                msg_id,
                                room_id: room.to_string(),
                                event_id: event_id.to_string(),
                                origin: EventOrigin::MirroredUser,
                                content,
                            });
                        }
                    }
                }
            }
            MirrorAction::CommandOutput { name, data } => {
                self.bot
                    .send_text(&room, &render_command_output(&name, &data))
                    .await;
            }
            MirrorAction::Error(err) => {
                self.bot.send_notice(&room, &format!("Error: {err}")).await;
            }
            MirrorAction::Notice(text) => {
                self.bot.send_notice(&room, &text).await;
            }
            MirrorAction::None => {}
        }
    }

    // ── Progressive streaming (mirror mode) ─────────────────────────────

    /// A generation this bridge requested is starting: stream it into the
    /// room by progressively editing one message.
    async fn stream_start(&mut self, regen: bool) {
        let Some(room) = self.active_room.clone() else {
            return;
        };
        self.bot.set_typing(&room, true).await;
        // Regens rewrite the room's latest reply in place instead of posting
        // a fresh message — but only when that reply really is the daemon's
        // latest (the regen target). Otherwise stream as a new message.
        let event_id = if regen {
            self.event_map
                .latest_reply_in_room(room.as_str())
                .filter(|e| match self.last_assistant_for_room(room.as_str()) {
                    Some(last) => last == e.msg_id,
                    None => true,
                })
                .map(|e| e.event_id.clone())
        } else {
            None
        };
        self.stream = Some(StreamMirror {
            room,
            event_id,
            buffer: String::new(),
            last_edit: std::time::Instant::now(),
            tools: Vec::new(),
            final_text: None,
        });
    }

    async fn stream_chunk(&mut self, text: &str, content_type: &str) {
        // take/put-back keeps the borrow checker happy across the awaits.
        let Some(mut stream) = self.stream.take() else {
            return;
        };
        // Once the reply's NewMessage has adopted the event, its content is
        // final — a straggling chunk must not clobber it with stale buffer.
        if stream.final_text.is_some() {
            self.stream = Some(stream);
            return;
        }
        if content_type == "text" {
            stream.buffer.push_str(text);
        }
        if stream.buffer.trim().is_empty() {
            // Nothing visible yet (e.g. thinking chunks) — keep typing alive.
            self.bot.set_typing(&stream.room, true).await;
            self.stream = Some(stream);
            return;
        }
        let display = format!("{}{STREAM_CURSOR}", stream.buffer);
        match &stream.event_id {
            None => {
                // First visible content: the growing message replaces the
                // typing indicator.
                self.bot.set_typing(&stream.room, false).await;
                if let Some(event_id) = self.bot.send_text(&stream.room, &display).await {
                    stream.event_id = Some(event_id.to_string());
                }
                stream.last_edit = std::time::Instant::now();
            }
            Some(event_id) => {
                if stream.last_edit.elapsed() >= STREAM_EDIT_INTERVAL {
                    let event_id = event_id.clone();
                    self.edit_mapped(&stream.room, &event_id, &display).await;
                    stream.last_edit = std::time::Instant::now();
                }
            }
        }
        self.stream = Some(stream);
    }

    /// Finalize a streamed reply. Usually the reply's `NewMessage` has already
    /// adopted the streamed event (persist happens before StreamEnd), leaving
    /// only the usage footer; the un-adopted path covers cancelled/failed
    /// generations and daemons that broadcast nothing.
    async fn stream_end(
        &mut self,
        content: &str,
        msg_id: Option<&str>,
        metadata: &shore_protocol::types::StreamMetadata,
    ) {
        let Some(stream) = self.stream.take() else {
            return;
        };
        self.bot.set_typing(&stream.room, false).await;
        let Some(event_id) = stream.event_id else {
            return;
        };
        let view = self.view_prefs.room(stream.room.as_str());

        if let Some(final_text) = stream.final_text {
            // Adopted — everything but the footer is already in the room.
            if view.usage {
                let footed = format!("{final_text}{}", usage_footer(metadata));
                self.edit_mapped(&stream.room, &event_id, &footed).await;
            }
            return;
        }

        if content.is_empty() {
            // Cancelled/failed with nothing persisted — freeze whatever
            // partial text streamed, minus the cursor.
            if !stream.buffer.trim().is_empty() {
                let buffer = stream.buffer.clone();
                self.edit_mapped(&stream.room, &event_id, &buffer).await;
            }
            return;
        }
        let tools = (view.tools && !stream.tools.is_empty()).then(|| render_tools(&stream.tools));
        let mut text = decorate_reply(content, None, tools);
        if view.usage {
            text.push_str(&usage_footer(metadata));
        }
        self.edit_mapped(&stream.room, &event_id, &text).await;
        if let Some(msg_id) = msg_id {
            self.event_map.record(MappedEvent {
                msg_id: msg_id.to_string(),
                room_id: stream.room.to_string(),
                event_id,
                origin: EventOrigin::Assistant,
                content: content.to_string(),
            });
        }
    }

    /// Post an assistant/autonomous message, editing in place when the daemon
    /// message replaces one already shown (a streamed reply, a regen, or a
    /// re-broadcast).
    async fn post_reply(&mut self, room: &OwnedRoomId, reply: ReplyToPost<'_>) {
        let ReplyToPost {
            msg_id,
            replaces_last,
            autonomous,
            prev_assistant,
            thinking,
            text,
            images,
        } = reply;
        self.bot.set_typing(room, false).await;

        // A generation this bridge requested (stream frames are
        // session-private, so an in-flight stream for this room is ours).
        let ours = self.stream.as_ref().is_some_and(|s| s.room == *room);

        let view = self.view_prefs.room(room.as_str());
        let shown_thinking = thinking.filter(|_| view.thinking);

        // A reply this bridge streamed arrives as NewMessage *before*
        // StreamEnd (the daemon persists first) — adopt the streamed event
        // instead of posting a duplicate. Autonomous pushes are never the
        // product of our stream, so they must not hijack it.
        if !autonomous {
            // Adopt at most once: a multi-message generation broadcasts
            // several NewMessages before StreamEnd, and only the first may
            // claim the streamed event (the rest append normally).
            let adoptable = self
                .stream
                .as_ref()
                .is_some_and(|s| s.room == *room && s.event_id.is_some() && s.final_text.is_none());
            if adoptable {
                let stream = self.stream.as_mut().expect("checked above");
                let event_id = stream.event_id.clone().expect("checked above");
                let tools =
                    (view.tools && !stream.tools.is_empty()).then(|| render_tools(&stream.tools));
                let decorated = decorate_reply(text, shown_thinking, tools);
                // Keep the stream (with the exact posted text) so StreamEnd
                // can append the usage footer.
                stream.final_text = Some(decorated.clone());
                self.edit_mapped(room, &event_id, &decorated).await;
                for img in images {
                    self.bot
                        .send_image(room, &img.path, img.caption.as_deref())
                        .await;
                }
                if let Some(msg_id) = msg_id {
                    self.event_map.record(MappedEvent {
                        msg_id,
                        room_id: room.to_string(),
                        event_id,
                        origin: EventOrigin::Assistant,
                        content: text.to_string(),
                    });
                }
                return;
            }
        }

        // Same msg_id already shown → refresh its content in place.
        if let Some(id) = &msg_id {
            if let Some(entry) = self.event_map.by_msg_id(id) {
                if entry.room_id == room.as_str() {
                    if entry.content != text {
                        let event_id = entry.event_id.clone();
                        self.edit_mapped(room, &event_id, text).await;
                        self.event_map.update_content(id, text);
                    }
                    return;
                }
            }
        }

        // Regen replacement → rewrite the previous reply instead of appending.
        // Only when the displaced daemon message is the one this room shows
        // last — in `Replies` mode the daemon's latest reply may be a message
        // the room never saw, and its regen must not overwrite an unrelated
        // shown reply.
        if replaces_last {
            let prev = self
                .event_map
                .latest_reply_in_room(room.as_str())
                .filter(|prev| prev_assistant.as_deref() == Some(prev.msg_id.as_str()));
            if let Some(prev) = prev {
                let prev_msg_id = prev.msg_id.clone();
                let prev_event_id = prev.event_id.clone();
                let decorated = decorate_reply(text, shown_thinking, None);
                if self.edit_mapped(room, &prev_event_id, &decorated).await {
                    for img in images {
                        self.bot
                            .send_image(room, &img.path, img.caption.as_deref())
                            .await;
                    }
                    self.event_map.remove_msg(&prev_msg_id);
                    if let Some(msg_id) = msg_id {
                        self.event_map.record(MappedEvent {
                            msg_id,
                            room_id: room.to_string(),
                            event_id: prev_event_id,
                            origin: EventOrigin::Assistant,
                            content: text.to_string(),
                        });
                    }
                    return;
                }
            }
        }

        // Normal append. In `Replies` mode the room only receives what
        // concerns it: replies to prompts sent from Matrix (`ours`) and the
        // character's autonomous messages — other clients' conversations
        // stay out.
        if self.mirror != MirrorMode::All && !autonomous && !ours {
            return;
        }
        for img in images {
            self.bot
                .send_image(room, &img.path, img.caption.as_deref())
                .await;
        }
        if !text.is_empty() {
            let decorated = decorate_reply(text, shown_thinking, None);
            let posted = self.bot.send_text(room, &decorated).await;
            if let (Some(msg_id), Some(event_id)) = (msg_id, posted) {
                self.event_map.record(MappedEvent {
                    msg_id,
                    room_id: room.to_string(),
                    event_id: event_id.to_string(),
                    origin: EventOrigin::Assistant,
                    content: text.to_string(),
                });
            }
        }
    }

    /// Edit a mapped event's content in place. Returns false when the stored
    /// event id doesn't parse or the send fails.
    async fn edit_mapped(&self, room: &RoomId, event_id: &str, text: &str) -> bool {
        match <&matrix_sdk::ruma::EventId>::try_from(event_id) {
            Ok(eid) => self.bot.edit_text(room, eid, text).await,
            Err(_) => false,
        }
    }

    /// Mirror daemon-side mutations from `delete` / `alt` / `edit` command
    /// outputs. Returns true when the output is fully reflected in the room
    /// (so the raw command output must not be posted).
    async fn handle_mutation_output(
        &mut self,
        out: &shore_protocol::server_msg::CommandOutput,
    ) -> bool {
        match out.name.as_str() {
            "delete" => {
                let Some(deleted) = out.data.get("deleted").and_then(|v| v.as_array()) else {
                    return false;
                };
                for msg_id in deleted.iter().filter_map(|v| v.as_str()) {
                    let Some(entry) = self.event_map.remove_msg(msg_id) else {
                        continue;
                    };
                    if let (Ok(room), Ok(event_id)) = (
                        <&RoomId>::try_from(entry.room_id.as_str()),
                        <&matrix_sdk::ruma::EventId>::try_from(entry.event_id.as_str()),
                    ) {
                        self.bot
                            .redact(room, event_id, Some("deleted from conversation"))
                            .await;
                    }
                }
                true
            }
            "alt" => {
                let (Some(msg_id), Some(content)) = (
                    out.data.get("ref").and_then(|v| v.as_str()),
                    out.data.get("content").and_then(|v| v.as_str()),
                ) else {
                    return false;
                };
                let Some(entry) = self.event_map.by_msg_id(msg_id) else {
                    return false;
                };
                if entry.origin.bot_editable() && entry.content != content {
                    let (room_id, event_id) = (entry.room_id.clone(), entry.event_id.clone());
                    if let Ok(room) = <&RoomId>::try_from(room_id.as_str()) {
                        self.edit_mapped(room, &event_id, content).await;
                    }
                    self.event_map.update_content(msg_id, content);
                }
                // The in-place edit is the visible result; suppress the dump.
                true
            }
            // `{ref, edited: true}` — the room already shows the change
            // (the user's own Matrix edit, or the History-diff mirror).
            "edit" => out.data.get("edited").is_some(),
            _ => false,
        }
    }

    /// Reconcile a history snapshot (broadcast or handshake) with the room:
    /// prune mappings for messages that left the active history, and mirror
    /// content changes made from other clients (TUI `:edit`, `:alt`) onto the
    /// bot's Matrix events.
    async fn sync_history(
        &mut self,
        selected_character: Option<&str>,
        messages: &[shore_protocol::types::Message],
    ) {
        // Seed/refresh the regen reference point from the snapshot's tail so
        // it's correct after restarts and across other clients' activity.
        if let Some(character) = selected_character {
            if let Some(last) = messages
                .iter()
                .rev()
                .find(|m| m.role == shore_protocol::types::Role::Assistant)
            {
                self.last_assistant
                    .insert(character.to_string(), last.msg_id.clone());
            }
        }

        let room = resolve_character_room(&self.room_manager, selected_character)
            .or_else(|| self.active_room.clone());
        let Some(room) = room else {
            return;
        };

        // A message can leave the active history through deletion *or*
        // compaction, and the two look identical here — so only forget the
        // mapping, never redact. Targeted redaction rides the `delete`
        // command output instead.
        let live: HashSet<&str> = messages.iter().map(|m| m.msg_id.as_str()).collect();
        self.event_map.prune_missing(room.as_str(), &live);

        let changes: Vec<(String, String, EventOrigin, String)> = messages
            .iter()
            .filter_map(|m| {
                let entry = self.event_map.by_msg_id(&m.msg_id)?;
                (entry.room_id == room.as_str() && entry.content != m.content).then(|| {
                    (
                        m.msg_id.clone(),
                        entry.event_id.clone(),
                        entry.origin,
                        m.content.clone(),
                    )
                })
            })
            .collect();
        for (msg_id, event_id, origin, content) in changes {
            if origin.bot_editable() {
                // Mirrored prompts carry display formatting the raw daemon
                // content doesn't; re-apply it on edit.
                let rendered = match origin {
                    EventOrigin::MirroredUser => format_user_mirror(&content),
                    _ => content.clone(),
                };
                self.edit_mapped(&room, &event_id, &rendered).await;
            }
            // MatrixUser events can't be edited by the bot; just remember the
            // new content so future diffs don't re-fire.
            self.event_map.update_content(&msg_id, &content);
        }
    }

    /// Legacy routing (`mirror_all = false`): NewMessage goes to the first
    /// bound room (or the active room); everything else rides the active room,
    /// assembled through the streaming `ResponseCollector`.
    async fn dispatch_legacy(&mut self, msg: &ServerMessage) {
        let target = if matches!(msg, ServerMessage::NewMessage(_)) {
            push_target(&self.known_characters, &self.room_manager)
                .or_else(|| self.active_room.clone())
        } else {
            self.active_room.clone()
        };

        if let Some(ref room_id) = target {
            let collector = self.collectors.entry(room_id.clone()).or_default();
            let action = collector.feed(msg);
            dispatch_action(&self.bot, room_id, action).await;
        }
    }

    fn record_self_input(&mut self, room_id: &RoomId, event_id: &str, swp_msg: &ClientMessage) {
        record_self_input(
            &mut self.pending_self_inputs,
            &self.room_manager,
            room_id,
            event_id,
            swp_msg,
        );
    }

    fn consume_self_echo(&mut self, character: Option<&str>, content: &str) -> Option<String> {
        consume_self_echo(&mut self.pending_self_inputs, character, content)
    }

    async fn handle_bind(&mut self, room_id: &OwnedRoomId, character: Option<&str>) {
        handle_bind(
            &self.bot,
            &mut self.room_manager,
            &self.known_characters,
            room_id,
            character,
        )
        .await;
    }
}

fn onoff(v: bool) -> &'static str {
    if v {
        "on"
    } else {
        "off"
    }
}

/// Escape text destined for the inside of a raw-HTML `<details>` block, so
/// model output can't inject tags into the rendered message.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A collapsed section rendered by Element (details/summary are in its
/// allowed-tag list); other clients show the raw text fallback.
fn details_block(summary: &str, body: &str) -> String {
    format!("\n\n<details><summary>{summary}</summary>\n\n{body}\n\n</details>")
}

/// Assemble a reply's visible text: the content plus collapsed thinking /
/// tool-activity sections per the room's `!view` preferences.
fn decorate_reply(text: &str, thinking: Option<&str>, tools: Option<String>) -> String {
    let mut out = text.to_string();
    if let Some(thinking) = thinking {
        out.push_str(&details_block("💭 thinking", &escape_html(thinking)));
    }
    if let Some(tools) = tools {
        out.push_str(&details_block("🔧 tool calls", &tools));
    }
    out
}

fn render_tools(tools: &[ToolActivity]) -> String {
    tools
        .iter()
        .map(|t| {
            let marker = match (t.done, t.error) {
                (false, _) => "⏳",
                (true, false) => "✓",
                (true, true) => "✗",
            };
            format!("- {marker} `{}`", escape_html(&t.name))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Small per-reply metadata line for `!view usage on`.
fn usage_footer(m: &shore_protocol::types::StreamMetadata) -> String {
    format!(
        "\n\n<sub>{} · {}→{} tok · {:.1}s</sub>",
        m.model,
        m.tokens.input,
        m.tokens.output,
        m.timing.total_ms as f64 / 1000.0,
    )
}

/// Resolve the Matrix room bound to a character, if any.
fn resolve_character_room(
    room_manager: &RoomManager,
    character: Option<&str>,
) -> Option<OwnedRoomId> {
    let character = character?;
    let room_str = room_manager.room_for_character(character)?;
    <&RoomId>::try_from(room_str).ok().map(RoomId::to_owned)
}

/// Record a prompt this bridge forwarded — `(text, matrix event id)` — so the
/// daemon's `UserInput` echo for it can be suppressed and mapped back to the
/// originating Matrix event.
fn record_self_input(
    pending: &mut HashMap<String, VecDeque<(String, String)>>,
    room_manager: &RoomManager,
    room_id: &RoomId,
    event_id: &str,
    swp_msg: &ClientMessage,
) {
    let ClientMessage::Message(body) = swp_msg else {
        return;
    };
    let Some(character) = room_manager.character_for_room(room_id.as_str()) else {
        return;
    };
    let queue = pending.entry(character.to_string()).or_default();
    queue.push_back((body.text.clone(), event_id.to_string()));
    while queue.len() > MAX_PENDING_SELF_INPUTS {
        queue.pop_front();
    }
}

/// Consume a matching pending self-input. Returns the originating Matrix event
/// id if `content` was this bridge's own echo for `character` (which then must
/// not be re-posted).
fn consume_self_echo(
    pending: &mut HashMap<String, VecDeque<(String, String)>>,
    character: Option<&str>,
    content: &str,
) -> Option<String> {
    let character = character?;
    let queue = pending.get_mut(character)?;
    let pos = queue.iter().position(|(c, _)| c == content)?;
    queue.remove(pos).map(|(_, event_id)| event_id)
}

async fn handle_bind(
    bot: &MatrixBot,
    room_manager: &mut RoomManager,
    known_characters: &[String],
    room_id: &OwnedRoomId,
    character: Option<&str>,
) {
    let char_name = character.unwrap_or("").trim();

    if char_name.is_empty() {
        let mut lines = vec!["**Room bindings:**".to_string()];
        let mut any = false;
        for (character, bound_room) in room_manager.bindings() {
            lines.push(format!("- **{character}** → `{bound_room}`"));
            any = true;
        }
        if !any {
            lines.push("_No rooms bound yet._".into());
        }
        if !known_characters.is_empty() {
            lines.push(format!(
                "\nAvailable characters: {}",
                known_characters.join(", ")
            ));
        }
        bot.send_text(room_id, &lines.join("\n")).await;
        return;
    }

    if known_characters.is_empty() {
        bot.send_text(room_id, "Not connected to daemon yet").await;
        return;
    }

    if known_characters.iter().any(|c| c == char_name) {
        room_manager.bind(room_id.as_str(), char_name);
        bot.send_text(room_id, &format!("Bound this room to **{char_name}**"))
            .await;
    } else {
        let available = known_characters.join(", ");
        bot.send_text(
            room_id,
            &format!("Unknown character `{char_name}`. Available: {available}"),
        )
        .await;
    }
}

fn push_target(known_characters: &[String], room_manager: &RoomManager) -> Option<OwnedRoomId> {
    for char_name in known_characters {
        if let Some(room_str) = room_manager.room_for_character(char_name) {
            if let Ok(room_id) = <&RoomId>::try_from(room_str) {
                return Some(room_id.to_owned());
            }
        }
    }
    None
}

async fn dispatch_action(bot: &MatrixBot, room_id: &OwnedRoomId, action: CollectorAction) {
    match action {
        CollectorAction::StartTyping => {
            bot.set_typing(room_id, true).await;
        }
        CollectorAction::SendMessage { text, images } => {
            bot.set_typing(room_id, false).await;
            for img in &images {
                bot.send_image(room_id, &img.path, img.caption.as_deref())
                    .await;
            }
            bot.send_text(room_id, &text).await;
        }
        CollectorAction::SendCommandOutput { name, data } => {
            bot.send_text(room_id, &render_command_output(&name, &data))
                .await;
        }
        CollectorAction::SendError(err) => {
            bot.send_notice(room_id, &format!("Error: {err}")).await;
        }
        CollectorAction::SendPush(text) => {
            bot.send_text(room_id, &text).await;
        }
        CollectorAction::None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{config_dir_from_arg, config_file_from_arg, load_matrix_config};
    use std::path::PathBuf;

    #[test]
    fn config_directory_arg_loads_config_toml_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("shore-config");
        std::fs::create_dir_all(&config_dir).unwrap();

        let raw = config_dir.to_string_lossy();

        assert_eq!(config_file_from_arg(&raw), config_dir.join("config.toml"));
        assert_eq!(config_dir_from_arg(&raw), config_dir);
    }

    #[test]
    fn config_file_arg_keeps_file_and_selects_parent_dir() {
        let raw = "/etc/shore/custom.toml";

        assert_eq!(config_file_from_arg(raw), PathBuf::from(raw));
        assert_eq!(config_dir_from_arg(raw), PathBuf::from("/etc/shore"));
    }

    #[test]
    fn matrix_config_ignores_unrelated_future_daemon_sections() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path();
        std::fs::write(
            config_dir.join("config.toml"),
            r#"
[future_daemon_only]
enabled = true

[connections.telegram]
future_field = "ignored by shore-matrix"
"#,
        )
        .unwrap();
        std::fs::create_dir_all(config_dir.join("conf.d")).unwrap();
        std::fs::write(
            config_dir.join("conf.d/matrix.toml"),
            r#"
[connections.matrix.embedded]
admin_password = "secret"
"#,
        )
        .unwrap();

        let raw = config_dir.to_string_lossy().into_owned();
        let config = load_matrix_config(&Some(raw)).unwrap();
        let matrix = config.matrix.expect("matrix config should load");
        let embedded = matrix.embedded.expect("embedded matrix config");

        assert!(matrix.enabled);
        assert_eq!(embedded.admin_password, "secret");
        assert_eq!(embedded.server_name, "localhost");
    }

    #[test]
    fn matrix_config_rejects_matrix_owned_errors() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path();
        std::fs::write(
            config_dir.join("config.toml"),
            r#"
[connections.matrix]
homeserver = "https://matrix.example.com"
bogus = true
"#,
        )
        .unwrap();

        let raw = config_dir.to_string_lossy().into_owned();
        let err = load_matrix_config(&Some(raw)).unwrap_err().to_string();

        assert!(err.contains("[connections.matrix]"));
        assert!(err.contains("bogus"));
    }

    // ── mirror mode + self-echo routing ───────────────────────────────────

    use super::{consume_self_echo, record_self_input, resolve_character_room, MirrorMode};
    use matrix_sdk::ruma::RoomId;
    use shore_matrix::rooms::RoomManager;
    use shore_protocol::client_msg::{ClientMessage, ClientMessageBody};
    use std::collections::{HashMap, VecDeque};

    fn user_message(text: &str) -> ClientMessage {
        ClientMessage::Message(ClientMessageBody {
            rid: None,
            text: text.into(),
            stream: true,
            images: vec![],
            image_data: vec![],
            absence_seconds: None,
            overrides: None,
        })
    }

    fn config_with(body: &str) -> super::MatrixFileConfig {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.toml"),
            format!("[connections.matrix]\nhomeserver = \"https://m.example.com\"\n{body}"),
        )
        .unwrap();
        let raw = dir.path().to_string_lossy().into_owned();
        load_matrix_config(&Some(raw)).unwrap()
    }

    #[test]
    fn mirror_defaults_to_replies_when_absent() {
        assert_eq!(config_with("").mirror, MirrorMode::Replies);
    }

    #[test]
    fn mirror_key_selects_mode_and_strips() {
        // Key read, and the typed MatrixConfig still parsed (stripped before
        // the deny_unknown_fields deserialize).
        let cfg = config_with("mirror = \"all\"\n");
        assert_eq!(cfg.mirror, MirrorMode::All);
        assert!(cfg.matrix.is_some());

        assert_eq!(
            config_with("mirror = \"replies\"\n").mirror,
            MirrorMode::Replies
        );
        assert_eq!(config_with("mirror = \"off\"\n").mirror, MirrorMode::Off);
    }

    #[test]
    fn mirror_invalid_value_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.toml"),
            "[connections.matrix]\nhomeserver = \"https://m.example.com\"\nmirror = \"loud\"\n",
        )
        .unwrap();
        let raw = dir.path().to_string_lossy().into_owned();
        let err = load_matrix_config(&Some(raw)).unwrap_err().to_string();
        assert!(err.contains("loud"), "{err}");
        assert!(err.contains("replies"), "{err}");
    }

    #[test]
    fn legacy_mirror_all_flag_still_honored() {
        let cfg = config_with("mirror_all = false\n");
        assert_eq!(cfg.mirror, MirrorMode::Off);
        assert!(cfg.matrix.is_some());

        assert_eq!(config_with("mirror_all = true\n").mirror, MirrorMode::All);

        // Explicit `mirror` wins over the legacy boolean.
        assert_eq!(
            config_with("mirror = \"replies\"\nmirror_all = true\n").mirror,
            MirrorMode::Replies
        );
    }

    #[test]
    fn self_echo_suppresses_only_matching_input() {
        let mut mgr = RoomManager::new();
        mgr.bind("!room:example.com", "Alice");
        let room = RoomId::parse("!room:example.com").unwrap();

        let mut pending: HashMap<String, VecDeque<(String, String)>> = HashMap::new();
        record_self_input(
            &mut pending,
            &mgr,
            &room,
            "$event1:example.com",
            &user_message("hello from matrix"),
        );

        // The matching echo is suppressed and yields the originating event id…
        assert_eq!(
            consume_self_echo(&mut pending, Some("Alice"), "hello from matrix"),
            Some("$event1:example.com".to_string())
        );
        // …exactly once.
        assert_eq!(
            consume_self_echo(&mut pending, Some("Alice"), "hello from matrix"),
            None
        );
        // A prompt from another client (no pending entry) is not suppressed.
        assert_eq!(
            consume_self_echo(&mut pending, Some("Alice"), "from the cli"),
            None
        );
    }

    #[test]
    fn self_input_not_recorded_for_unbound_room() {
        let mgr = RoomManager::new(); // no bindings
        let room = RoomId::parse("!room:example.com").unwrap();
        let mut pending: HashMap<String, VecDeque<(String, String)>> = HashMap::new();
        record_self_input(&mut pending, &mgr, &room, "$e:x.com", &user_message("hi"));
        assert!(pending.is_empty());
    }

    #[test]
    fn decorate_reply_respects_sections() {
        use super::{decorate_reply, render_tools, ToolActivity};

        // No extras → text passes through untouched.
        assert_eq!(super::decorate_reply("hi", None, None), "hi");

        // Thinking is collapsed and HTML-escaped.
        let out = decorate_reply("hi", Some("a <b> & c"), None);
        assert!(out.starts_with("hi\n\n<details><summary>💭 thinking</summary>"));
        assert!(out.contains("a &lt;b&gt; &amp; c"));

        // Tool checklist markers.
        let tools = vec![
            ToolActivity {
                id: "1".into(),
                name: "web_search".into(),
                done: true,
                error: false,
            },
            ToolActivity {
                id: "2".into(),
                name: "run_code".into(),
                done: true,
                error: true,
            },
            ToolActivity {
                id: "3".into(),
                name: "pending".into(),
                done: false,
                error: false,
            },
        ];
        let rendered = render_tools(&tools);
        assert!(rendered.contains("✓ `web_search`"));
        assert!(rendered.contains("✗ `run_code`"));
        assert!(rendered.contains("⏳ `pending`"));

        let out = decorate_reply("hi", None, Some(rendered));
        assert!(out.contains("<summary>🔧 tool calls</summary>"));
    }

    #[test]
    fn usage_footer_formats_metadata() {
        use shore_protocol::types::{StreamMetadata, TimingInfo, TokenCounts};
        let footer = super::usage_footer(&StreamMetadata {
            tokens: TokenCounts {
                input: 1200,
                output: 340,
                cache_read: 0,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 12345,
                ttft_ms: 800,
            },
            model: "claude-sonnet-5".into(),
        });
        assert_eq!(
            footer,
            "\n\n<sub>claude-sonnet-5 · 1200→340 tok · 12.3s</sub>"
        );
    }

    #[test]
    fn resolve_character_room_maps_via_bindings() {
        let mut mgr = RoomManager::new();
        mgr.bind("!alice:example.com", "Alice");
        assert_eq!(
            resolve_character_room(&mgr, Some("Alice")).map(|r| r.to_string()),
            Some("!alice:example.com".to_string())
        );
        assert_eq!(resolve_character_room(&mgr, Some("Bob")), None);
        assert_eq!(resolve_character_room(&mgr, None), None);
    }
}
