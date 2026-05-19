#![recursion_limit = "256"]

use std::collections::HashMap;
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
    input_to_swp, parse_matrix_input, CollectorAction, MatrixInput, ResponseCollector,
};
use shore_matrix::connection::{spawn_connection, ConnCommand, ConnEvent};
use shore_matrix::crypto;
use shore_matrix::homeserver::{
    generate_token, wait_for_healthy, HomeserverConfig, HomeserverManager,
};
use shore_matrix::provision::{
    check_room_exists, check_token, create_character_room, join_room, provision_admin,
    provision_character, wipe_embedded_state_and_characters, CharacterPaths, EmbeddedState,
    HomeserverPaths, ProvisionState, RoomStatus, TokenStatus,
};
use shore_matrix::rooms::RoomManager;

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

#[derive(Debug)]
struct MatrixFileConfig {
    matrix: Option<MatrixConfig>,
    config_dir: PathBuf,
}

#[derive(Debug, Error)]
enum MatrixConfigError {
    #[error("failed to load Shore config files for Matrix bridge: {0}")]
    Load(#[source] Box<shore_config::ConfigError>),

    #[error("failed to parse [connections.matrix] for Matrix bridge: {0}")]
    Matrix(#[source] Box<toml::de::Error>),
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
            return run_embedded(embedded, fc, &args, &config_dir, daemon_config).await;
        }
    }

    // External mode: use CLI args, falling back to config file values
    run_external(&file_config, &args, &config_dir, daemon_config).await
}

/// Load only the Matrix-owned portion of Shore config.
fn load_matrix_config(config_flag: &Option<String>) -> Result<MatrixFileConfig, MatrixConfigError> {
    let config_path = config_flag.as_deref().map(config_file_from_arg);
    let raw = shore_config::load_raw_config_table(config_path.as_deref())?;
    let matrix = matrix_from_table(&raw.table)?;
    Ok(MatrixFileConfig {
        matrix,
        config_dir: raw.dirs.config,
    })
}

fn matrix_from_table(table: &toml::Table) -> Result<Option<MatrixConfig>, MatrixConfigError> {
    let Some(connections) = table.get("connections").and_then(toml::Value::as_table) else {
        return Ok(None);
    };
    let Some(matrix) = connections.get("matrix") else {
        return Ok(None);
    };
    let parsed: MatrixConfig = matrix
        .clone()
        .try_into()
        .map_err(|e| MatrixConfigError::Matrix(Box::new(e)))?;
    Ok(Some(parsed))
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

    let bot_config = BotConfig {
        homeserver,
        user_id,
        access_token: args.access_token.clone(),
        password: args.password.clone(),
        device_id: args.device_id.clone(),
        store_path: resolve_store_path(&args.store_path),
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
    run_bridge_loop(bot, matrix_rx, daemon_tx, daemon_rx, room_manager).await;
    Ok(())
}

// ── Embedded mode ───────────────────────────────────────────────────────

async fn run_embedded(
    embedded: &EmbeddedConfig,
    fc: &MatrixConfig,
    args: &Args,
    config_dir: &Path,
    daemon_config: Option<String>,
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

    let bot_config = BotConfig {
        homeserver: homeserver_url.clone(),
        user_id: primary.user_id.clone(),
        access_token: Some(primary.access_token.clone()),
        password: None,
        device_id: Some(primary.device_id.clone()),
        store_path: resolve_store_path(&args.store_path),
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
    run_bridge_loop(bot, matrix_rx, daemon_tx, daemon_rx, room_manager).await;

    // 12. Cleanup
    hs_manager.stop().await.ok();
    Ok(())
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
    bot: MatrixBot,
    mut matrix_rx: mpsc::Receiver<MatrixEvent>,
    daemon_tx: mpsc::Sender<ConnCommand>,
    mut daemon_rx: mpsc::Receiver<ConnEvent>,
    mut room_manager: RoomManager,
) {
    let mut collectors: HashMap<OwnedRoomId, ResponseCollector> = HashMap::new();
    let mut active_room: Option<OwnedRoomId> = None;
    let mut known_characters: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            biased;

            // Matrix events (user messages from rooms)
            Some(event) = matrix_rx.recv() => {
                match event {
                    MatrixEvent::Message { room_id, text, .. } => {
                        match parse_matrix_input(&text) {
                            MatrixInput::Bind { character } => {
                                handle_bind(
                                    &bot, &mut room_manager, &known_characters,
                                    &room_id, character.as_deref(),
                                ).await;
                            }
                            MatrixInput::LocalReply(reply) => {
                                bot.send_text(&room_id, &reply).await;
                            }
                            MatrixInput::Forward(msgs) => {
                                active_room = Some(room_id);
                                for msg in msgs {
                                    if daemon_tx.send(ConnCommand::Send(msg)).await.is_err() {
                                        error!("daemon connection dropped");
                                        break;
                                    }
                                }
                            }
                            input @ (MatrixInput::Text(_) | MatrixInput::Image { .. }) => {
                                active_room = Some(room_id);
                                if let Some(swp_msg) = input_to_swp(&input) {
                                    if daemon_tx.send(ConnCommand::Send(swp_msg)).await.is_err() {
                                        error!("daemon connection dropped");
                                    }
                                }
                            }
                        }
                    }
                    MatrixEvent::Image { room_id, path, body, .. } => {
                        active_room = Some(room_id);
                        let input = MatrixInput::Image {
                            path,
                            caption: Some(body),
                        };
                        if let Some(swp_msg) = input_to_swp(&input) {
                            if daemon_tx.send(ConnCommand::Send(swp_msg)).await.is_err() {
                                error!("daemon connection dropped");
                            }
                        }
                    }
                }
            }

            // Daemon events (responses from shore-daemon)
            Some(event) = daemon_rx.recv() => {
                match event {
                    ConnEvent::Connected { server_name, characters, .. } => {
                        info!("connected to daemon: {server_name}");
                        known_characters = characters.iter().map(|c| c.name.clone()).collect();

                        if let Some(first) = known_characters.first() {
                            bot.sync_avatar(first).await;
                        }
                    }
                    ConnEvent::Disconnected(reason) => {
                        info!("daemon disconnected: {reason}");
                    }
                    ConnEvent::Message(msg) => {
                        let target = if matches!(msg, shore_protocol::server_msg::ServerMessage::NewMessage(_)) {
                            push_target(&known_characters, &room_manager)
                                .or(active_room.clone())
                        } else {
                            active_room.clone()
                        };

                        if let Some(ref room_id) = target {
                            let collector = collectors
                                .entry(room_id.clone())
                                .or_default();
                            let action = collector.feed(&msg);
                            dispatch_action(&bot, room_id, action).await;
                        }
                    }
                }
            }
        }
    }
}

// ── Bridge helpers ──────────────────────────────────────────────────────

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
            let msg = format!("**{name}**\n```\n{data}\n```");
            bot.send_text(room_id, &msg).await;
        }
        CollectorAction::SendError(err) => {
            bot.send_text(room_id, &format!("Error: {err}")).await;
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
}
