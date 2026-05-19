mod app;
mod clipboard;
mod connection;
mod images;
mod input;
mod markdown;
mod ui;

use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use crossterm::event::{DisableBracketedPaste, EnableBracketedPaste, EventStream};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, DisableLineWrap, EnableLineWrap, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use futures_util::StreamExt;
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::buffer::Buffer;
use ratatui::Terminal;
use shore_protocol::client_msg::{ClientMessage, Command};
use shore_protocol::server_msg::ServerMessage;
use shore_protocol::types::{ContentBlock, Message, Role};
use tracing::{info, instrument};
use tracing_subscriber::EnvFilter;

use app::{
    AltChoice, App, ConnectionStatus, ConversationEntry, EffectiveSamplerSnapshot, InputState,
    StreamBlock,
};
use connection::{ConnCommand, ConnEvent};
use input::Action;

const STREAM_FRAME_INTERVAL: Duration = Duration::from_millis(200);
const ENV_TUI_FIXTURE: &str = "SHORE_TUI_FIXTURE";
const ENV_TUI_FIXTURE_ROLE: &str = "SHORE_TUI_FIXTURE_ROLE";
const ENV_TUI_FIXTURE_REPEAT: &str = "SHORE_TUI_FIXTURE_REPEAT";
const ENV_TUI_FIXTURE_SCROLL: &str = "SHORE_TUI_FIXTURE_SCROLL";
const ENV_TUI_FIXTURE_CHARACTER: &str = "SHORE_TUI_FIXTURE_CHARACTER";
const ENV_TUI_FIXTURE_RENDER: &str = "SHORE_TUI_FIXTURE_RENDER";
const ENV_TUI_RENDER_SIZE: &str = "SHORE_TUI_RENDER_SIZE";
const ENV_TUI_DEBUG_FRAMES: &str = "SHORE_TUI_DEBUG_FRAMES";
const ENV_TUI_DEBUG_NO_IMAGE_PROBE: &str = "SHORE_TUI_DEBUG_NO_IMAGE_PROBE";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RedrawEffect {
    None,
    Immediate,
    ImmediateFull,
    DeferredStream,
}

pub(crate) struct UiEffect {
    cmds: Vec<ConnCommand>,
    redraw: RedrawEffect,
}

impl UiEffect {
    fn redraw(redraw: RedrawEffect) -> Self {
        Self {
            cmds: vec![],
            redraw,
        }
    }

    fn none() -> Self {
        Self::redraw(RedrawEffect::None)
    }
}

#[derive(Parser)]
#[command(name = "shore-tui", about = "Shore terminal UI")]
struct Cli {
    /// TCP address of the daemon
    #[arg(long)]
    addr: Option<String>,

    /// Config path to select daemon instance
    #[arg(long)]
    config: Option<String>,

    /// Character to connect as
    #[arg(short, long)]
    character: Option<String>,
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();
    let debug = TuiDebugConfig::from_env()?;

    if let Some((width, height)) = debug.render_size {
        let mut app = debug.build_app()?;
        let frame = render_app_to_string(&mut app, width, height)?;
        print!("{frame}");
        return Ok(());
    }

    if !debug.fixture_enabled() {
        init_logging();
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");

    rt.block_on(run_tui(cli, debug))
}

fn init_logging() {
    // TUI owns the terminal, so log to a file instead of stdout/stderr.
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let log_dir = std::path::Path::new(&runtime_dir).join("shore");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("tui.log"))
        .expect("failed to open tui.log");
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(true)
        .with_ansi(false)
        .with_writer(std::sync::Mutex::new(log_file))
        .init();
}

#[derive(Clone, Debug, Default)]
struct TuiDebugConfig {
    fixture: Option<TuiFixtureConfig>,
    render_size: Option<(u16, u16)>,
    frame_dump_path: Option<PathBuf>,
    no_image_probe: bool,
}

#[derive(Clone, Debug)]
struct TuiFixtureConfig {
    path: PathBuf,
    role: FixtureRole,
    repeat: usize,
    scroll_offset: u16,
    character_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FixtureRole {
    Assistant,
    User,
    System,
}

impl TuiDebugConfig {
    fn from_env() -> io::Result<Self> {
        Self::from_lookup(env_nonempty)
    }

    fn from_lookup<F>(mut lookup: F) -> io::Result<Self>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let fixture = match lookup(ENV_TUI_FIXTURE) {
            Some(path) => Some(TuiFixtureConfig {
                path: PathBuf::from(path),
                role: parse_fixture_role(
                    lookup(ENV_TUI_FIXTURE_ROLE)
                        .as_deref()
                        .unwrap_or("assistant"),
                )?,
                repeat: parse_usize_env(
                    lookup(ENV_TUI_FIXTURE_REPEAT).as_deref(),
                    ENV_TUI_FIXTURE_REPEAT,
                    1,
                )?,
                scroll_offset: parse_u16_env(
                    lookup(ENV_TUI_FIXTURE_SCROLL).as_deref(),
                    ENV_TUI_FIXTURE_SCROLL,
                    0,
                )?,
                character_name: lookup(ENV_TUI_FIXTURE_CHARACTER)
                    .unwrap_or_else(|| "Fixture".to_string()),
            }),
            None => None,
        };

        let render_size = if let Some(value) = lookup(ENV_TUI_FIXTURE_RENDER) {
            Some(parse_render_size(ENV_TUI_FIXTURE_RENDER, &value)?)
        } else if let Some(value) = lookup(ENV_TUI_RENDER_SIZE) {
            Some(parse_render_size(ENV_TUI_RENDER_SIZE, &value)?)
        } else {
            None
        };

        Ok(Self {
            fixture,
            render_size,
            frame_dump_path: lookup(ENV_TUI_DEBUG_FRAMES).map(PathBuf::from),
            no_image_probe: lookup(ENV_TUI_DEBUG_NO_IMAGE_PROBE)
                .as_deref()
                .map(parse_bool_env)
                .unwrap_or(false),
        })
    }

    fn fixture_enabled(&self) -> bool {
        self.fixture.is_some()
    }

    fn build_app(&self) -> io::Result<App> {
        let app = if let Some(fixture) = &self.fixture {
            fixture.build_app()?
        } else {
            App::default()
        };
        Ok(app)
    }
}

impl TuiFixtureConfig {
    fn build_app(&self) -> io::Result<App> {
        let content = std::fs::read_to_string(&self.path)?;
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            character_name: self.character_name.clone(),
            ..App::default()
        };

        for idx in 0..self.repeat {
            let timestamp = format!("fixture-{idx}");
            match self.role {
                FixtureRole::Assistant => app.entries.push(ConversationEntry::Assistant {
                    msg_id: None,
                    content: content.clone(),
                    images: vec![],
                    timestamp,
                    metadata: None,
                }),
                FixtureRole::User => app.entries.push(ConversationEntry::User {
                    content: content.clone(),
                    images: vec![],
                    timestamp,
                }),
                FixtureRole::System => app.entries.push(ConversationEntry::System {
                    content: content.clone(),
                    count: 1,
                    timestamp,
                }),
            }
        }

        app.scroll_offset = self.scroll_offset;
        app.auto_scroll = self.scroll_offset == 0;
        Ok(app)
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_fixture_role(value: &str) -> io::Result<FixtureRole> {
    match value.trim().to_ascii_lowercase().as_str() {
        "assistant" => Ok(FixtureRole::Assistant),
        "user" => Ok(FixtureRole::User),
        "system" => Ok(FixtureRole::System),
        other => Err(invalid_env_value(
            ENV_TUI_FIXTURE_ROLE,
            format!("expected assistant, user, or system; got {other:?}"),
        )),
    }
}

fn parse_usize_env(value: Option<&str>, name: &str, default: usize) -> io::Result<usize> {
    match value {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| {
                invalid_env_value(name, format!("expected positive integer; got {value:?}"))
            })
            .and_then(|parsed| {
                if parsed == 0 {
                    Err(invalid_env_value(name, "must be greater than zero"))
                } else {
                    Ok(parsed)
                }
            }),
        None => Ok(default),
    }
}

fn parse_u16_env(value: Option<&str>, name: &str, default: u16) -> io::Result<u16> {
    match value {
        Some(value) => value
            .parse::<u16>()
            .map_err(|_| invalid_env_value(name, format!("expected integer; got {value:?}"))),
        None => Ok(default),
    }
}

fn parse_render_size(name: &str, value: &str) -> io::Result<(u16, u16)> {
    let normalized = value.trim().replace('X', "x");
    let (width, height) = normalized
        .split_once('x')
        .ok_or_else(|| invalid_env_value(name, format!("expected WIDTHxHEIGHT; got {value:?}")))?;
    let width = width
        .parse::<u16>()
        .map_err(|_| invalid_env_value(name, "width must be an integer"))?;
    let height = height
        .parse::<u16>()
        .map_err(|_| invalid_env_value(name, "height must be an integer"))?;
    if width == 0 || height == 0 {
        return Err(invalid_env_value(
            name,
            "width and height must be greater than zero",
        ));
    }
    Ok((width, height))
}

fn parse_bool_env(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn invalid_env_value(name: &str, message: impl Into<String>) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{name}: {}", message.into()),
    )
}

struct FrameDump {
    path: PathBuf,
    next_frame: u64,
}

impl FrameDump {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            next_frame: 1,
        }
    }

    fn dump(&mut self, app: &mut App, width: u16, height: u16) -> io::Result<()> {
        let frame = render_app_to_string(app, width, height)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(
            file,
            "=== shore-tui frame {} ({}x{}) ===",
            self.next_frame, width, height
        )?;
        file.write_all(frame.as_bytes())?;
        if !frame.ends_with('\n') {
            writeln!(file)?;
        }
        self.next_frame += 1;
        Ok(())
    }
}

fn render_app_to_string(app: &mut App, width: u16, height: u16) -> io::Result<String> {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| ui::draw(frame, app))?;
    Ok(buffer_to_string(terminal.backend().buffer()))
}

fn buffer_to_string(buf: &Buffer) -> String {
    let area = buf.area;
    let mut text = String::new();
    for y in 0..area.height {
        let mut row = String::new();
        for x in 0..area.width {
            let cell = &buf[(x, y)];
            row.push_str(cell.symbol());
        }
        text.push_str(row.trim_end());
        text.push('\n');
    }
    text
}

/// Resolve the initial character: --character flag > SHORE_CHARACTER env > state file.
fn resolve_character(cli_character: Option<String>) -> Option<String> {
    if cli_character.is_some() {
        return cli_character;
    }
    if let Ok(val) = std::env::var("SHORE_CHARACTER") {
        if !val.is_empty() {
            return Some(val);
        }
    }
    // Try the CLI's active_character state file.
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let state_path = std::path::Path::new(&runtime_dir)
        .join("shore")
        .join("active_character");
    if let Ok(name) = std::fs::read_to_string(state_path) {
        let name = name.trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

fn prefs_path() -> std::path::PathBuf {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&runtime_dir)
        .join("shore")
        .join("tui_prefs.json")
}

fn load_prefs(app: &mut App) {
    if let Ok(data) = std::fs::read_to_string(prefs_path()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(b) = v.get("show_thinking").and_then(|v| v.as_bool()) {
                app.show_thinking = b;
            }
            if let Some(b) = v.get("show_tools").and_then(|v| v.as_bool()) {
                app.show_tools = b;
            }
            if let Some(b) = v.get("show_images").and_then(|v| v.as_bool()) {
                app.show_images = b;
            }
            if let Some(b) = v.get("show_timestamps").and_then(|v| v.as_bool()) {
                app.show_timestamps = b;
            }
            if let Some(b) = v.get("show_metadata").and_then(|v| v.as_bool()) {
                app.show_metadata = b;
            }
        }
    }
}

fn save_prefs(app: &App) {
    let v = serde_json::json!({
        "show_thinking": app.show_thinking,
        "show_tools": app.show_tools,
        "show_images": app.show_images,
        "show_timestamps": app.show_timestamps,
        "show_metadata": app.show_metadata,
    });
    let _ = std::fs::write(prefs_path(), v.to_string());
}

fn open_in_editor(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    input: &mut InputState,
) -> io::Result<()> {
    let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vi".to_string());
    let tmp = std::env::temp_dir().join("shore_input.md");
    std::fs::write(&tmp, input.text.as_str())?;

    io::stdout().execute(DisableBracketedPaste)?;
    io::stdout().execute(EnableLineWrap)?;
    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;

    let _ = std::process::Command::new(&editor).arg(&tmp).status();

    enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    io::stdout().execute(DisableLineWrap)?;
    io::stdout().execute(EnableBracketedPaste)?;
    terminal.clear()?;

    if let Ok(contents) = std::fs::read_to_string(&tmp) {
        input.set_text(contents.trim_end_matches('\n').to_string());
    }
    Ok(())
}

/// Open an external file picker and return the selected path(s).
///
/// Tries (in order): $SHORE_FILE_PICKER, yazi, fzf. Leaves the alternate
/// screen while the picker runs so it can draw freely.
fn pick_image(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    start_dir: Option<&str>,
) -> io::Result<Vec<String>> {
    let chooser_file = std::env::temp_dir().join("shore_image_pick");
    // Remove stale chooser file
    let _ = std::fs::remove_file(&chooser_file);

    let start = start_dir.unwrap_or(".");

    io::stdout().execute(DisableBracketedPaste)?;
    io::stdout().execute(EnableLineWrap)?;
    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;

    let result = try_yazi(&chooser_file, start).or_else(|| try_fzf(&chooser_file, start));

    enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    io::stdout().execute(DisableLineWrap)?;
    io::stdout().execute(EnableBracketedPaste)?;
    terminal.clear()?;

    match result {
        Some(true) => {
            // Read selected path(s) from chooser file
            if let Ok(contents) = std::fs::read_to_string(&chooser_file) {
                let paths: Vec<String> = contents
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                Ok(paths)
            } else {
                Ok(vec![])
            }
        }
        Some(false) => Ok(vec![]), // picker ran but user cancelled
        None => {
            // No picker found — print hint to stderr before restoring screen
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "no file picker found (install yazi or fzf)",
            ))
        }
    }
}

/// Try launching yazi. Returns Some(true) on success, Some(false) on
/// cancel/error, None if yazi is not installed.
fn try_yazi(chooser_file: &std::path::Path, start: &str) -> Option<bool> {
    let status = std::process::Command::new("yazi")
        .arg(start)
        .arg("--chooser-file")
        .arg(chooser_file)
        .status()
        .ok()?;
    Some(status.success() && chooser_file.exists())
}

/// Try launching fzf with image-aware preview. Returns Some(true) on
/// success, Some(false) on cancel, None if fzf is not installed.
fn try_fzf(chooser_file: &std::path::Path, start: &str) -> Option<bool> {
    // Build a list of image files and pipe into fzf
    let find = std::process::Command::new("find")
        .arg(start)
        .arg("-type")
        .arg("f")
        .arg("(")
        .args(["-iname", "*.png", "-o"])
        .args(["-iname", "*.jpg", "-o"])
        .args(["-iname", "*.jpeg", "-o"])
        .args(["-iname", "*.webp", "-o"])
        .args(["-iname", "*.gif", "-o"])
        .args(["-iname", "*.bmp"])
        .arg(")")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .ok()?;

    // Detect best preview command: chafa > kitty icat > file
    let preview_cmd = if which_exists("chafa") {
        "chafa -s ${FZF_PREVIEW_COLUMNS}x${FZF_PREVIEW_LINES} {}".to_string()
    } else if which_exists("kitty") {
        "kitty icat --clear --transfer-mode=memory --stdin=no {}".to_string()
    } else {
        "file {}".to_string()
    };

    let status = std::process::Command::new("fzf")
        .arg("--preview")
        .arg(&preview_cmd)
        .arg("--preview-window=right:50%")
        .stdin(find.stdout.unwrap())
        .stdout(std::fs::File::create(chooser_file).ok()?)
        .status()
        .ok()?;

    Some(status.success() && chooser_file.exists())
}

/// Check whether a command exists on PATH.
fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn send_conn_commands(
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    cmds: Vec<ConnCommand>,
) {
    for cmd in cmds {
        let _ = cmd_tx.send(cmd).await;
    }
}

fn model_settings_conn_command(rid: Option<String>) -> ConnCommand {
    ConnCommand::Send(ClientMessage::Command(Command {
        rid,
        name: "model_settings".into(),
        args: serde_json::json!({}),
    }))
}

async fn handle_conn_event_and_send(
    app: &mut App,
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    event: ConnEvent,
) -> UiEffect {
    let effect = handle_conn_event(app, event);
    send_conn_commands(cmd_tx, effect.cmds).await;
    UiEffect {
        cmds: vec![],
        redraw: effect.redraw,
    }
}

fn apply_redraw_effect(
    effect: RedrawEffect,
    needs_redraw: &mut bool,
    deferred_stream_dirty: &mut bool,
    needs_full_redraw: &mut bool,
) {
    match effect {
        RedrawEffect::None => {}
        // Stream chunks are painted by the next stream frame tick.
        RedrawEffect::DeferredStream => *deferred_stream_dirty = true,
        RedrawEffect::Immediate => *needs_redraw = true,
        RedrawEffect::ImmediateFull => {
            *needs_redraw = true;
            *needs_full_redraw = true;
        }
    }
}

async fn process_conn_event(
    app: &mut App,
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    event: ConnEvent,
    needs_redraw: &mut bool,
    deferred_stream_dirty: &mut bool,
    needs_full_redraw: &mut bool,
) {
    let effect = handle_conn_event_and_send(app, cmd_tx, event).await;
    apply_redraw_effect(
        effect.redraw,
        needs_redraw,
        deferred_stream_dirty,
        needs_full_redraw,
    );
}

fn mark_connection_task_exited(app: &mut App, conn_events_open: &mut bool) {
    if !*conn_events_open {
        return;
    }
    *conn_events_open = false;
    app.connection_status = ConnectionStatus::Disconnected;
    app.set_status("connection task exited");
}

async fn handle_action(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    action: Action,
    send_enabled: bool,
) -> io::Result<bool> {
    match action {
        Action::Quit => {
            app.should_quit = true;
            Ok(true)
        }
        Action::Interrupt => {
            app.interrupt = true;
            app.should_quit = true;
            Ok(true)
        }
        Action::Send(cmd) => {
            if send_enabled {
                let _ = cmd_tx.send(cmd).await;
            } else {
                app.set_status("fixture mode: command ignored");
            }
            Ok(true)
        }
        Action::SendMulti(cmds) => {
            if send_enabled {
                send_conn_commands(cmd_tx, cmds).await;
            } else {
                app.set_status("fixture mode: command ignored");
            }
            Ok(true)
        }
        Action::OpenInEditor => {
            let _ = open_in_editor(terminal, &mut app.input);
            Ok(true)
        }
        Action::PickImage(start_dir) => {
            match pick_image(terminal, start_dir.as_deref()) {
                Ok(paths) if paths.is_empty() => {
                    // User cancelled; the alternate screen was still restored.
                }
                Ok(paths) => {
                    let count = paths.len();
                    app.pending_images.extend(paths);
                    app.set_status(format!(
                        "attached {count} image(s) ({} pending)",
                        app.pending_images.len()
                    ));
                }
                Err(e) => {
                    app.set_status(format!("image picker: {e}"));
                }
            }
            Ok(true)
        }
        Action::PasteImage => {
            let result = tokio::time::timeout(
                Duration::from_millis(1500),
                tokio::task::spawn_blocking(clipboard::read_image_to_temp),
            )
            .await;
            match result {
                Ok(Ok(Ok(path))) => {
                    let path_str = path.to_string_lossy().into_owned();
                    app.pending_images.push(path_str);
                    app.paste_temp_paths.push(path);
                    app.set_status(format!(
                        "pasted image ({} pending)",
                        app.pending_images.len()
                    ));
                }
                Ok(Ok(Err(e))) => app.set_status(e.to_string()),
                Ok(Err(_join)) => app.set_status("paste task panicked"),
                Err(_elapsed) => app.set_status("clipboard read timed out"),
            }
            Ok(true)
        }
        Action::Redraw => Ok(true),
        Action::None => Ok(false),
    }
}

#[instrument(skip(cli, debug))]
async fn run_tui(cli: Cli, debug: TuiDebugConfig) -> io::Result<()> {
    // Set up terminal
    enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    io::stdout().execute(DisableLineWrap)?;
    io::stdout().execute(EnableBracketedPaste)?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    let character = resolve_character(cli.character);
    let fixture_mode = debug.fixture_enabled();
    info!(character = ?character, fixture_mode, "TUI starting");

    let mut app = if fixture_mode {
        debug.build_app()?
    } else {
        App {
            connection_status: ConnectionStatus::Connecting,
            ..App::default()
        }
    };
    // Probe terminal for kitty graphics support (raw mode is now active).
    if !debug.no_image_probe && !fixture_mode {
        app.image_cache.probe_protocol();
    }
    if !fixture_mode {
        load_prefs(&mut app);
    }

    // Spawn connection manager unless an offline fixture is driving the UI.
    let (cmd_tx, mut event_rx) = if fixture_mode {
        let (cmd_tx, _cmd_rx) = tokio::sync::mpsc::channel::<ConnCommand>(16);
        let (_event_tx, event_rx) = tokio::sync::mpsc::channel::<ConnEvent>(1);
        (cmd_tx, event_rx)
    } else {
        connection::spawn_connection(cli.addr, cli.config, character)
    };

    let mut terminal_events = EventStream::new();
    let mut stream_frame = tokio::time::interval(STREAM_FRAME_INTERVAL);
    stream_frame.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut needs_redraw = true;
    let mut deferred_stream_dirty = false;
    let mut needs_full_redraw = false;
    let mut conn_events_open = !fixture_mode;
    let mut frame_dump = debug.frame_dump_path.clone().map(FrameDump::new);

    // Main event loop
    let result = loop {
        if needs_redraw {
            if needs_full_redraw {
                terminal.clear()?;
                needs_full_redraw = false;
            }
            terminal.draw(|frame| ui::draw(frame, &mut app))?;
            if let Some(dump) = &mut frame_dump {
                let area = terminal.size()?;
                dump.dump(&mut app, area.width, area.height)?;
            }
            needs_redraw = false;
            deferred_stream_dirty = false;
        }

        // Poll for events (crossterm keyboard or connection events)
        tokio::select! {
            biased;
            // External SIGINT — safety net if the keyboard loop ever wedges
            // and in case the user kills us with `kill -INT <pid>`.
            _ = tokio::signal::ctrl_c() => {
                app.interrupt = true;
                app.should_quit = true;
            }
            // Connection events
            conn_event = event_rx.recv(), if conn_events_open => {
                match conn_event {
                    Some(event) => {
                        process_conn_event(
                            &mut app,
                            &cmd_tx,
                            event,
                            &mut needs_redraw,
                            &mut deferred_stream_dirty,
                            &mut needs_full_redraw,
                        ).await;

                        loop {
                            match event_rx.try_recv() {
                                Ok(event) => {
                                    process_conn_event(
                                        &mut app,
                                        &cmd_tx,
                                        event,
                                        &mut needs_redraw,
                                        &mut deferred_stream_dirty,
                                        &mut needs_full_redraw,
                                    ).await;
                                }
                                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                                    mark_connection_task_exited(&mut app, &mut conn_events_open);
                                    break;
                                }
                            }
                        }

                    }
                    None => {
                        mark_connection_task_exited(&mut app, &mut conn_events_open);
                        needs_redraw = true;
                    }
                }
            }
            terminal_event = terminal_events.next() => {
                match terminal_event {
                    Some(Ok(ev)) => {
                        let action = input::handle_event(&mut app, ev);
                        needs_redraw |= handle_action(
                            &mut terminal,
                            &mut app,
                            &cmd_tx,
                            action,
                            !fixture_mode,
                        ).await?;
                    }
                    Some(Err(e)) => return Err(e),
                    None => {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "terminal event stream ended",
                        ));
                    }
                }
            }
            // Keep progress indicators moving and coalesce high-rate stream chunks.
            _ = stream_frame.tick(), if app.stream.active => {
                app.spinner_frame = app.spinner_frame.wrapping_add(1);
                let scheduled_deferred_stream_paint = deferred_stream_dirty;
                needs_redraw = true;
                if scheduled_deferred_stream_paint {
                    deferred_stream_dirty = false;
                }
            }
        }

        if app.should_quit {
            break Ok(());
        }
    };

    info!("TUI exiting");
    if !fixture_mode {
        // Save preferences and shutdown
        save_prefs(&app);
        let _ = cmd_tx.send(ConnCommand::Shutdown).await;
    }

    // Best-effort cleanup of paste-origin temp files.
    for path in &app.paste_temp_paths {
        let _ = std::fs::remove_file(path);
    }

    // Restore terminal
    io::stdout().execute(DisableBracketedPaste)?;
    io::stdout().execute(EnableLineWrap)?;
    disable_raw_mode()?;
    io::stdout().execute(LeaveAlternateScreen)?;

    // If the user interrupted us (Ctrl+C or external SIGINT), exit with the
    // conventional 128+SIGINT=130 code so supervisors see it as a real signal.
    if app.interrupt {
        result?;
        std::process::exit(130);
    }

    result
}

fn handle_conn_event(app: &mut App, event: ConnEvent) -> UiEffect {
    match event {
        ConnEvent::Connected {
            characters,
            history,
            active_start,
            config,
            selected_character,
            ..
        } => {
            app.connection_status = ConnectionStatus::Connected;
            app.effective_sampler = None;
            app.sampler_settings_loading = false;
            app.pending_sampler_settings_rid = None;
            app.characters = characters.clone();

            if let Some(selected) = selected_character {
                app.character_name = selected;
            } else if let Some(ch) = characters.first() {
                app.character_name = ch.name.clone();
            }

            // Check private flag from config
            if let Some(private) = config.get("private").and_then(|v| v.as_bool()) {
                app.is_private = private;
            }
            app.set_active_model(config.get("active_model").and_then(|v| v.as_str()));

            // Load any history from the handshake
            rebuild_entries_from_history(history, active_start, &mut app.entries);
            reset_history_paging(app);
            transmit_entry_images(app);

            app.set_status("connected");
            UiEffect::redraw(RedrawEffect::Immediate)
        }

        ConnEvent::Disconnected(reason) => {
            app.connection_status = ConnectionStatus::Connecting;
            app.stream.reset(); // clear stale streaming state
            app.effective_sampler = None;
            app.sampler_settings_loading = false;
            app.pending_sampler_settings_rid = None;
            app.history_page_loading = false;
            app.set_status(format!("reconnecting: {reason}"));
            UiEffect::redraw(RedrawEffect::Immediate)
        }

        ConnEvent::Message(msg) => handle_server_message(app, msg),
    }
}

/// Rebuild the display log from a history snapshot, inserting the archive
/// boundary before the first active-context message.
fn rebuild_entries_from_history(
    messages: Vec<Message>,
    active_start: usize,
    entries: &mut Vec<ConversationEntry>,
) {
    entries.clear();

    let boundary_at = active_start.min(messages.len());
    let archived_turns = count_user_turns(&messages[..boundary_at]);
    let mut inserted_boundary = false;
    for (index, msg) in messages.into_iter().enumerate() {
        if boundary_at > 0 && index == boundary_at {
            entries.push(ConversationEntry::ArchiveBoundary {
                archived_count: archived_turns,
            });
            inserted_boundary = true;
        }
        expand_msg(msg, entries);
    }

    if boundary_at > 0 && !inserted_boundary {
        entries.push(ConversationEntry::ArchiveBoundary {
            archived_count: archived_turns,
        });
    }
}

fn count_user_turns(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|msg| msg.role == Role::User && !msg.is_tool_result_only())
        .count()
}

fn reset_history_paging(app: &mut App) {
    app.history_next_before = None;
    app.history_has_more_before = true;
    app.history_page_loading = false;
}

fn prepend_history_page(app: &mut App, data: &serde_json::Value) {
    app.history_page_loading = false;
    app.history_next_before = data
        .get("next_before")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    app.history_has_more_before = data
        .get("has_more_before")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let Some(messages) = data.get("messages").and_then(|v| v.as_array()) else {
        return;
    };

    let mut page_messages = Vec::new();
    for msg_val in messages {
        if let Ok(msg) = serde_json::from_value::<Message>(msg_val.clone()) {
            page_messages.push(msg);
        }
    }

    let loaded_turns = count_user_turns(&page_messages);
    let mut page_entries = Vec::new();
    for msg in page_messages {
        expand_msg(msg, &mut page_entries);
    }

    if page_entries.is_empty() {
        return;
    }

    if let Some(boundary_idx) = app
        .entries
        .iter()
        .position(|entry| matches!(entry, ConversationEntry::ArchiveBoundary { .. }))
    {
        if let ConversationEntry::ArchiveBoundary { archived_count } =
            &mut app.entries[boundary_idx]
        {
            *archived_count = archived_count.saturating_add(loaded_turns);
        }
        app.entries.splice(0..0, page_entries);
    } else {
        page_entries.push(ConversationEntry::ArchiveBoundary {
            archived_count: loaded_turns,
        });
        app.entries.splice(0..0, page_entries);
    }

    app.history_version = app.history_version.wrapping_add(1);
}

/// Expand a protocol Message into one or more ConversationEntry items.
///
/// Assistant messages with content_blocks are expanded so that thinking,
/// tool_use, and tool_result blocks become distinct entries (matching the
/// visual style used during streaming), with the text becoming the final
/// Assistant entry.
fn expand_msg(msg: Message, entries: &mut Vec<ConversationEntry>) {
    // Non-assistant or no content_blocks: simple conversion.
    if msg.role != Role::Assistant || msg.content_blocks.is_empty() {
        entries.push(match msg.role {
            Role::User => ConversationEntry::User {
                content: msg.content,
                images: msg.images,
                timestamp: msg.timestamp,
            },
            Role::Assistant => ConversationEntry::Assistant {
                msg_id: Some(msg.msg_id),
                content: msg.content,
                images: msg.images,
                timestamp: msg.timestamp,
                metadata: None,
            },
            Role::System => ConversationEntry::System {
                content: msg.content,
                count: 1,
                timestamp: msg.timestamp,
            },
        });
        return;
    }

    // Build tool_use_id → tool_name map for ToolResult labels.
    let tool_names: std::collections::HashMap<&str, &str> = msg
        .content_blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, .. } => Some((id.as_str(), name.as_str())),
            _ => None,
        })
        .collect();

    let mut text_parts: Vec<String> = Vec::new();

    for block in &msg.content_blocks {
        match block {
            ContentBlock::Thinking { thinking, .. } => {
                if !thinking.is_empty() {
                    entries.push(ConversationEntry::Thinking {
                        content: thinking.clone(),
                    });
                }
            }
            ContentBlock::RedactedThinking { .. } => {
                entries.push(ConversationEntry::Thinking {
                    content: "[redacted thinking]".into(),
                });
            }
            ContentBlock::ToolUse { id, name, input } => {
                entries.push(ConversationEntry::ToolCall {
                    tool_id: id.clone(),
                    tool_name: name.clone(),
                    input: input.clone(),
                });
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let name = tool_names.get(tool_use_id.as_str()).unwrap_or(&"tool");
                entries.push(ConversationEntry::ToolResult {
                    tool_id: tool_use_id.clone(),
                    tool_name: name.to_string(),
                    output: content.clone(),
                    is_error: *is_error,
                });
            }
            ContentBlock::Text { text } => {
                text_parts.push(text.clone());
            }
        }
    }

    // Emit the text content as the final Assistant entry.
    let content = text_parts.join("\n");
    if !content.trim().is_empty() {
        entries.push(ConversationEntry::Assistant {
            msg_id: Some(msg.msg_id),
            content,
            images: msg.images,
            timestamp: msg.timestamp,
            metadata: None,
        });
    }
}

/// Max display cells for images: 80% terminal width (minus indent), 50% terminal height.
fn image_max_cells() -> (u16, u16) {
    let (w, h) = crossterm::terminal::size().unwrap_or((80, 24));
    let max_cols = (w * 80 / 100).saturating_sub(4).max(1);
    let max_rows = (h * 50 / 100).max(1);
    (max_cols, max_rows)
}

/// Transmit images from conversation entries to kitty.
/// Prefers embedded base64 data; falls back to reading from path.
fn transmit_entry_images(app: &mut App) {
    let (max_cols, max_rows) = image_max_cells();
    for entry in &app.entries {
        let imgs = match entry {
            ConversationEntry::User { images, .. }
            | ConversationEntry::Assistant { images, .. } => images,
            _ => continue,
        };
        for img in imgs {
            transmit_image_ref(&mut app.image_cache, img, max_cols, max_rows);
        }
    }
}

/// Transmit a single ImageRef: prefer embedded data, fall back to path.
fn transmit_image_ref(
    cache: &mut images::ImageCache,
    img: &shore_protocol::types::ImageRef,
    max_cols: u16,
    max_rows: u16,
) {
    if let Some(b64) = &img.data {
        cache.ensure_transmitted_from_b64(&img.path, b64, max_cols, max_rows);
    } else {
        cache.ensure_transmitted(&img.path, max_cols, max_rows);
    }
}

fn active_model_candidate_name(active: &str, model: &serde_json::Value) -> Option<String> {
    let name = model.get("name").and_then(|v| v.as_str())?;
    let mut identifiers = vec![name];
    if let Some(qualified) = model.get("qualified_name").and_then(|v| v.as_str()) {
        identifiers.push(qualified);
    }
    if let Some(model_id) = model.get("model_id").and_then(|v| v.as_str()) {
        identifiers.push(model_id);
        if let Some(provider) = model.get("provider").and_then(|v| v.as_str()) {
            let provider_model = format!("{provider}:{model_id}");
            if App::model_identifier_matches(active, &provider_model) {
                return Some(name.to_string());
            }
        }
    }

    identifiers
        .into_iter()
        .any(|identifier| App::model_identifier_matches(active, identifier))
        .then(|| name.to_string())
}

pub(crate) fn handle_server_message(app: &mut App, msg: ServerMessage) -> UiEffect {
    match &msg {
        ServerMessage::AudioStart(_) | ServerMessage::AudioError(_) => {
            app.handle_audio_message(&msg);
            return UiEffect::redraw(RedrawEffect::Immediate);
        }
        ServerMessage::AudioChunk(_) | ServerMessage::AudioEnd(_) => {
            app.handle_audio_message(&msg);
            return UiEffect::none();
        }
        _ => {}
    }

    let redraw = match msg {
        ServerMessage::StreamStart(start) => {
            app.spinner_frame = 0;
            if start.regen {
                app.begin_regen_optimistic();
            } else if !app.stream.active {
                app.stream.reset();
                app.stream.active = true;
            } else {
                // Continuation within a multi-phase (tool-use) turn — preserve
                // accumulators so the final Assistant entry reflects the whole turn.
                app.stream.blocks.clear();
                app.stream.phase = "responding".into();
                app.stream.tool_name = None;
            }
            RedrawEffect::Immediate
        }

        ServerMessage::StreamChunk(chunk) => {
            let is_thinking = chunk.content_type == "thinking";
            match (is_thinking, app.stream.blocks.last_mut()) {
                (true, Some(StreamBlock::Thinking(ref mut s))) => s.push_str(&chunk.text),
                (false, Some(StreamBlock::Text(ref mut s))) => s.push_str(&chunk.text),
                (true, _) => app.stream.blocks.push(StreamBlock::Thinking(chunk.text)),
                (false, _) => app.stream.blocks.push(StreamBlock::Text(chunk.text)),
            }
            app.stream.phase = if is_thinking {
                "thinking"
            } else {
                "responding"
            }
            .into();
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::DeferredStream
        }

        ServerMessage::StreamEnd(end) => {
            if end.finish_reason == "cancelled" {
                app.stream.reset();
                app.set_status("generation cancelled");
                return UiEffect::redraw(RedrawEffect::ImmediateFull);
            }

            let keep_bottom = app.auto_scroll;
            app.set_active_model(Some(&end.metadata.model));
            app.tokens = end.metadata.tokens.clone();

            if !end.content.is_empty() {
                if !app.stream.accumulated_text.is_empty() {
                    app.stream.accumulated_text.push_str("\n\n");
                }
                app.stream.accumulated_text.push_str(&end.content);
            }

            match app.stream.accumulated_metadata.as_mut() {
                Some(acc) => {
                    acc.model = end.metadata.model.clone();
                    acc.tokens.input += end.metadata.tokens.input;
                    acc.tokens.output += end.metadata.tokens.output;
                    acc.tokens.cache_read += end.metadata.tokens.cache_read;
                    acc.tokens.cache_write += end.metadata.tokens.cache_write;
                    acc.timing.total_ms += end.metadata.timing.total_ms;
                    // Preserve ttft_ms from the first phase.
                }
                None => {
                    app.stream.accumulated_metadata = Some(end.metadata.clone());
                }
            }

            if end.finish_reason == "tool_use" {
                app.stream.blocks.clear();
                app.stream.phase = "tool_use".into();
                app.stream.tool_name = None;
                RedrawEffect::Immediate
            } else {
                // The daemon broadcasts a History snapshot during
                // `engine.append_message` (in persist_and_notify) and only
                // then emits StreamEnd, so the assistant entry is already
                // present in `app.entries`. Attach streaming metadata to
                // that entry — pushing a new one would duplicate it.
                let metadata = app.stream.accumulated_metadata.take();
                let slot_pos = if let Some(target) = end.msg_id.as_deref() {
                    app.entries.iter().rposition(|e| {
                        matches!(
                            e,
                            ConversationEntry::Assistant {
                                msg_id: Some(entry_msg_id),
                                ..
                            } if entry_msg_id == target
                        )
                    })
                } else {
                    app.entries
                        .iter()
                        .rposition(|e| matches!(e, ConversationEntry::Assistant { .. }))
                };
                if let Some(pos) = slot_pos {
                    if let ConversationEntry::Assistant { metadata: slot, .. } =
                        &mut app.entries[pos]
                    {
                        *slot = metadata;
                    }
                } else {
                    // Fallback: History hasn't been applied yet (shouldn't
                    // happen given daemon ordering). Push so the user isn't
                    // left with a blank turn.
                    let content = std::mem::take(&mut app.stream.accumulated_text);
                    app.entries.push(ConversationEntry::Assistant {
                        msg_id: end.msg_id.clone(),
                        content,
                        images: vec![],
                        timestamp: String::new(),
                        metadata,
                    });
                }
                app.stream.reset();
                if keep_bottom {
                    app.scroll_to_bottom();
                }
                RedrawEffect::ImmediateFull
            }
        }

        ServerMessage::Phase(phase) => {
            app.stream.phase = phase.phase;
            if let Some(model) = phase.model {
                app.set_active_model(Some(&model));
            }
            RedrawEffect::Immediate
        }

        ServerMessage::NewMessage(_) => RedrawEffect::None,

        ServerMessage::ToolCall(tc) => {
            app.stream.active = true;
            app.stream.phase = "tool_use".into();
            app.stream.tool_name = Some(tc.tool_name.clone());
            app.entries.push(ConversationEntry::ToolCall {
                tool_id: tc.tool_id,
                tool_name: tc.tool_name,
                input: tc.input,
            });
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::Immediate
        }

        ServerMessage::ToolResult(tr) => {
            app.stream.tool_name = None;
            app.entries.push(ConversationEntry::ToolResult {
                tool_id: tr.tool_id,
                tool_name: tr.tool_name,
                output: tr.output,
                is_error: tr.is_error,
            });
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::Immediate
        }

        ServerMessage::SendImage(img) => {
            let (max_cols, max_rows) = image_max_cells();
            if let Some(b64) = &img.data {
                app.image_cache
                    .ensure_transmitted_from_b64(&img.path, b64, max_cols, max_rows);
            } else {
                app.image_cache
                    .ensure_transmitted(&img.path, max_cols, max_rows);
            }
            RedrawEffect::Immediate
        }

        ServerMessage::CommandOutput(co) => {
            match co.name.as_str() {
                "log" => {
                    if let Some(messages) = co.data.get("messages").and_then(|v| v.as_array()) {
                        app.image_cache.clear();
                        let history: Vec<Message> = messages
                            .iter()
                            .filter_map(|msg_val| {
                                serde_json::from_value::<Message>(msg_val.clone()).ok()
                            })
                            .collect();
                        let active_start = co
                            .data
                            .get("active_start")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as usize;
                        rebuild_entries_from_history(history, active_start, &mut app.entries);
                        app.history_next_before = co
                            .data
                            .get("next_before")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as usize);
                        app.history_has_more_before = co
                            .data
                            .get("has_more_before")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        app.history_page_loading = false;
                        transmit_entry_images(app);
                        if app.auto_scroll {
                            app.scroll_to_bottom();
                        }
                    }
                }
                "history_page" => {
                    prepend_history_page(app, &co.data);
                    return UiEffect::redraw(RedrawEffect::Immediate);
                }
                "list_characters" => {
                    if let Some(chars) = co.data.get("characters").and_then(|v| v.as_array()) {
                        let active = co.data.get("active").and_then(|v| v.as_str()).unwrap_or("");
                        app.characters = chars
                            .iter()
                            .filter_map(|c| c.get("name").and_then(|n| n.as_str()))
                            .map(shore_protocol::types::CharacterInfo::new)
                            .collect();

                        if app.is_submenu_open("character") {
                            app.update_completions();
                            return UiEffect::redraw(RedrawEffect::Immediate);
                        }

                        let list = chars
                            .iter()
                            .filter_map(|c| c.get("name").and_then(|n| n.as_str()))
                            .map(|n| {
                                if n == active {
                                    format!("  * {n}")
                                } else {
                                    format!("    {n}")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        app.entries.push(ConversationEntry::System {
                            content: format!("Characters:\n{list}"),
                            count: 1,
                            timestamp: String::new(),
                        });
                        if app.auto_scroll {
                            app.scroll_to_bottom();
                        }
                    }
                }
                "switch_character" => {
                    if let Some(name) = co.data.get("character").and_then(|v| v.as_str()) {
                        app.character_name = name.to_string();
                    }
                    app.effective_sampler = None;
                    if co.data.get("active_model").is_some_and(|v| v.is_null()) {
                        app.set_active_model(None);
                    } else {
                        app.set_active_model(co.data.get("active_model").and_then(|v| v.as_str()));
                    }
                    if let Some(private) = co.data.get("private").and_then(|v| v.as_bool()) {
                        app.is_private = private;
                    }
                    if let Some(name) = co.data.get("character").and_then(|v| v.as_str()) {
                        app.set_status(format!("switched to {name}"));
                    }
                }
                "list_models" => {
                    if let Some(models) = co.data.get("models").and_then(|v| v.as_array()) {
                        let names: Vec<&str> = models
                            .iter()
                            .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                            .collect();
                        // Cache model names for tab completion
                        app.model_names = names.iter().map(|n| n.to_string()).collect();
                        let active = co
                            .data
                            .get("active")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty());
                        if let Some(active) = active {
                            app.set_active_model(Some(active));
                        }

                        let active_for_matching = active
                            .or_else(|| (!app.model.is_empty()).then_some(app.model.as_str()));
                        if let Some(active) = active_for_matching {
                            let active_names: Vec<String> = models
                                .iter()
                                .filter_map(|m| active_model_candidate_name(active, m))
                                .collect();
                            if !active_names.is_empty() {
                                app.active_model_names = active_names;
                            }
                        }

                        if app.is_submenu_open("model") {
                            app.update_completions();
                            return UiEffect::redraw(RedrawEffect::Immediate);
                        }

                        // Only show the list if the user explicitly requested it
                        if app.show_model_list {
                            app.show_model_list = false;
                            let hidden_count = co
                                .data
                                .get("hidden_count")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let include_hidden = co
                                .data
                                .get("include_hidden")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let list = models
                                .iter()
                                .map(|m| {
                                    let n = m.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                                    let provider =
                                        m.get("provider").and_then(|v| v.as_str()).unwrap_or("?");
                                    let source =
                                        m.get("source").and_then(|v| v.as_str()).unwrap_or("");
                                    let hidden =
                                        m.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
                                    let marker = if app.is_active_model_candidate(n) {
                                        "*"
                                    } else {
                                        " "
                                    };
                                    let tag = if hidden {
                                        format!(" [{source}, hidden]")
                                    } else if !source.is_empty() {
                                        format!(" [{source}]")
                                    } else {
                                        String::new()
                                    };
                                    format!("  {marker} {n:<28}{provider}{tag}")
                                })
                                .collect::<Vec<_>>()
                                .join("\n");
                            let footer = if !include_hidden && hidden_count > 0 {
                                format!(
                                    "\n  ({hidden_count} hidden — use `:model all` to include them)"
                                )
                            } else {
                                String::new()
                            };
                            app.entries.push(ConversationEntry::System {
                                content: format!("Models:\n{list}{footer}"),
                                count: 1,
                                timestamp: String::new(),
                            });
                            if app.auto_scroll {
                                app.scroll_to_bottom();
                            }
                        }
                    }
                }
                "model_settings" => {
                    let pending_response = app.sampler_settings_rid_matches(co.rid.as_deref());
                    let usable_response = pending_response || co.rid.is_none();
                    let snapshot = EffectiveSamplerSnapshot::from_model_settings(&co.data)
                        .filter(|snapshot| app.sampler_snapshot_matches_active_model(snapshot));
                    if let Some(snapshot) = snapshot.filter(|_| usable_response) {
                        app.finish_sampler_settings_refresh();
                        app.effective_sampler = Some(snapshot);
                    } else if pending_response {
                        app.finish_sampler_settings_refresh();
                        app.effective_sampler = None;
                    }
                    if app.is_setting_palette_open() {
                        app.update_completions();
                    }
                }
                "switch_model" => {
                    // Daemon returns `active` (the user-supplied alias) and
                    // `qualified_name` (provider/model_id). Prefer the
                    // qualified name for the displayed status because
                    // discovered models often only resolve under their
                    // upstream id.
                    let name = co
                        .data
                        .get("active")
                        .and_then(|v| v.as_str())
                        .or_else(|| co.data.get("qualified_name").and_then(|v| v.as_str()));
                    if let Some(name) = name {
                        app.set_active_model(Some(name));
                        app.set_status(format!("model: {name}"));
                    }
                    app.effective_sampler = None;
                }
                "reset_model" => {
                    app.set_active_model(None);
                    app.effective_sampler = None;
                    app.set_status("model reset to default");
                }
                "set_model_setting" => {
                    app.effective_sampler = None;
                    let refresh_rid = app.begin_sampler_settings_refresh();
                    let key = co
                        .data
                        .get("key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("setting");
                    let value_is_null = co
                        .data
                        .get("value")
                        .map(|value| value.is_null())
                        .unwrap_or(true);
                    if value_is_null {
                        app.set_status(format!("reset {key}"));
                    } else {
                        app.set_status(format!("setting {key} updated"));
                    }
                    return UiEffect {
                        cmds: vec![model_settings_conn_command(Some(refresh_rid))],
                        redraw: RedrawEffect::Immediate,
                    };
                }
                "memory" => {
                    let summary = serde_json::to_string_pretty(&co.data)
                        .unwrap_or_else(|_| co.data.to_string());
                    app.entries.push(ConversationEntry::System {
                        content: summary,
                        count: 1,
                        timestamp: String::new(),
                    });
                    if app.auto_scroll {
                        app.scroll_to_bottom();
                    }
                }
                "delete" => {
                    if let Some(deleted) = co.data.get("deleted").and_then(|v| v.as_array()) {
                        let count = deleted.len();
                        app.set_status(format!("deleted {count} entries"));
                    }
                }
                "list_alternatives" => {
                    let msg_id = co
                        .data
                        .get("ref")
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string);
                    let choices = co
                        .data
                        .get("alternatives")
                        .and_then(|v| v.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .map(|item| AltChoice {
                                    index: item.get("index").and_then(|v| v.as_u64()).unwrap_or(0)
                                        as u32,
                                    position: item
                                        .get("position")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0)
                                        as u32,
                                    active: item
                                        .get("active")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false),
                                    content: item
                                        .get("content")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    images: item
                                        .get("images")
                                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                                        .unwrap_or_default(),
                                    timestamp: item
                                        .get("timestamp")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    app.populate_alt_picker(msg_id, choices);
                }
                "alt" => {
                    let position = co
                        .data
                        .get("position")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let count = co
                        .data
                        .get("alt_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    app.set_status(format!("alt {position}/{count}"));
                }
                "compact" => {
                    let status = co
                        .data
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("done");
                    app.set_status(format!("{}: {status}", co.name));
                }
                _ => {
                    app.set_status(format!("cmd:{} completed", co.name));
                }
            }
            RedrawEffect::Immediate
        }

        ServerMessage::Error(err) => {
            if app.alt_picker.is_some() {
                app.cancel_alt_picker();
            }
            let sampler_settings_error = app.sampler_settings_loading
                && app.sampler_settings_rid_matches(err.rid.as_deref());
            if sampler_settings_error {
                app.finish_sampler_settings_refresh();
            }
            app.history_page_loading = false;
            if sampler_settings_error && app.is_setting_palette_open() {
                app.update_completions();
            }
            app.set_status(format!("error: {:?} - {}", err.code, err.message));
            RedrawEffect::Immediate
        }

        ServerMessage::CacheWarning(cw) => {
            app.set_status(format!("cache warning: {}", cw.message));
            RedrawEffect::Immediate
        }

        ServerMessage::ProviderFallbackWarning(w) => {
            app.set_status(w.message.clone());
            RedrawEffect::Immediate
        }

        ServerMessage::UsageWarning(w) => {
            app.set_status(w.message.clone());
            RedrawEffect::Immediate
        }

        ServerMessage::History(hist) => {
            if let Some(private) = hist.config.get("private").and_then(|v| v.as_bool()) {
                app.is_private = private;
            }
            app.set_active_model(hist.config.get("active_model").and_then(|v| v.as_str()));
            app.effective_sampler = None;
            if let Some(selected) = hist.selected_character {
                app.character_name = selected;
            }
            // Re-sync history
            app.image_cache.clear();
            rebuild_entries_from_history(hist.messages, hist.active_start, &mut app.entries);
            reset_history_paging(app);
            // Bump so the conv-cache fingerprint changes even when the
            // entry count and last-two summaries collide with the prior
            // value (e.g. :edit on an earlier message).
            app.history_version = app.history_version.wrapping_add(1);
            transmit_entry_images(app);
            RedrawEffect::Immediate
        }

        // Ignore unexpected messages
        _ => RedrawEffect::Immediate,
    };
    UiEffect::redraw(redraw)
}

#[cfg(test)]
mod redraw_tests {
    use super::*;
    use shore_protocol::error::ErrorCode;
    use shore_protocol::server_msg::{
        CommandOutput, Error as CommandError, StreamChunk, StreamEnd,
    };
    use shore_protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

    fn metadata() -> StreamMetadata {
        StreamMetadata {
            model: "test-model".into(),
            tokens: TokenCounts {
                input: 1,
                output: 1,
                cache_read: 0,
                cache_write: 0,
            },
            timing: TimingInfo {
                total_ms: 1,
                ttft_ms: 1,
            },
        }
    }

    fn debug_config_from(pairs: &[(&str, &str)]) -> io::Result<TuiDebugConfig> {
        TuiDebugConfig::from_lookup(|name| {
            pairs
                .iter()
                .find_map(|(key, value)| (*key == name).then(|| (*value).to_string()))
        })
    }

    fn temp_path(label: &str, extension: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shore-tui-{label}-{}-{nanos}.{extension}",
            std::process::id()
        ))
    }

    #[test]
    fn debug_config_parses_fixture_envvars() {
        let cfg = debug_config_from(&[
            (ENV_TUI_FIXTURE, "/tmp/example.md"),
            (ENV_TUI_FIXTURE_ROLE, "user"),
            (ENV_TUI_FIXTURE_REPEAT, "3"),
            (ENV_TUI_FIXTURE_SCROLL, "7"),
            (ENV_TUI_FIXTURE_CHARACTER, "DebugChar"),
            (ENV_TUI_FIXTURE_RENDER, "72x18"),
            (ENV_TUI_DEBUG_FRAMES, "/tmp/shore-tui.frames"),
            (ENV_TUI_DEBUG_NO_IMAGE_PROBE, "true"),
        ])
        .unwrap();

        let fixture = cfg.fixture.as_ref().expect("fixture");
        assert_eq!(fixture.path, PathBuf::from("/tmp/example.md"));
        assert_eq!(fixture.role, FixtureRole::User);
        assert_eq!(fixture.repeat, 3);
        assert_eq!(fixture.scroll_offset, 7);
        assert_eq!(fixture.character_name, "DebugChar");
        assert_eq!(cfg.render_size, Some((72, 18)));
        assert_eq!(
            cfg.frame_dump_path,
            Some(PathBuf::from("/tmp/shore-tui.frames"))
        );
        assert!(cfg.no_image_probe);
    }

    #[test]
    fn fixture_app_loads_markdown_without_daemon_state() {
        let path = temp_path("fixture", "md");
        std::fs::write(&path, "# Fixture\n\n- item").unwrap();

        let cfg = debug_config_from(&[
            (ENV_TUI_FIXTURE, path.to_str().unwrap()),
            (ENV_TUI_FIXTURE_REPEAT, "2"),
            (ENV_TUI_FIXTURE_SCROLL, "4"),
        ])
        .unwrap();
        let app = cfg.build_app().unwrap();

        assert!(matches!(app.connection_status, ConnectionStatus::Connected));
        assert_eq!(app.character_name, "Fixture");
        assert_eq!(app.entries.len(), 2);
        assert_eq!(app.scroll_offset, 4);
        assert!(!app.auto_scroll);
        assert!(matches!(
            &app.entries[0],
            ConversationEntry::Assistant { content, .. } if content.contains("# Fixture")
        ));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fixture_render_outputs_real_tui_frame() {
        let path = temp_path("render", "md");
        std::fs::write(
            &path,
            "`inline code wraps across the pane`\n\n```rust\nfn main() {}\n```\n\n1. numbered\n- bullet",
        )
        .unwrap();

        let cfg = debug_config_from(&[(ENV_TUI_FIXTURE, path.to_str().unwrap())]).unwrap();
        let mut app = cfg.build_app().unwrap();
        let frame = render_app_to_string(&mut app, 44, 18).unwrap();

        assert!(frame.contains("Fixture"));
        assert!(frame.contains("inline code"));
        assert!(frame.contains("fn main()"));
        assert!(frame.contains("1. numbered"));
        assert!(frame.contains("- bullet"));
        assert!(!frame.contains("```"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn frame_dump_writes_rendered_frames() {
        let path = temp_path("frames", "txt");
        let mut dump = FrameDump::new(path.clone());
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            character_name: "Debug".into(),
            ..App::default()
        };
        app.entries.push(ConversationEntry::Assistant {
            msg_id: None,
            content: "hello from dump".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });

        dump.dump(&mut app, 32, 12).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("shore-tui frame 1 (32x12)"));
        assert!(contents.contains("hello from dump"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn list_models_refreshes_open_model_submenu() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.enter_submenu("model");
        assert_eq!(app.completion.candidates, vec!["reset"]);

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "list_models".into(),
                data: serde_json::json!({
                    "active": "chat.anthropic.beta",
                    "models": [
                        {
                            "name": "alpha",
                            "qualified_name": "chat.anthropic.alpha",
                            "provider": "anthropic",
                            "model_id": "alpha"
                        },
                        {
                            "name": "beta",
                            "qualified_name": "chat.anthropic.beta",
                            "provider": "anthropic",
                            "model_id": "beta"
                        }
                    ]
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert_eq!(app.completion.candidates, vec!["alpha", "beta", "reset"]);
        assert!(app.is_active_model_candidate("beta"));
        assert!(!app.entries.iter().any(|entry| {
            matches!(entry, ConversationEntry::System { content, .. } if content.contains("Models:"))
        }));
    }

    #[test]
    fn list_characters_refreshes_open_character_submenu_without_printing() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.enter_submenu("character");
        assert!(app.completion.candidates.is_empty());

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "list_characters".into(),
                data: serde_json::json!({
                    "characters": [
                        { "name": "qifei" },
                        { "name": "debug" }
                    ]
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert_eq!(app.completion.candidates, vec!["qifei", "debug"]);
        assert_eq!(app.characters.len(), 2);
        assert!(!app.entries.iter().any(|entry| {
            matches!(entry, ConversationEntry::System { content, .. } if content.contains("Characters:"))
        }));
    }

    #[test]
    fn model_settings_refreshes_open_setting_submenu() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.enter_submenu("setting");
        assert_eq!(
            app.completion.candidates,
            vec!["loading sampler settings..."]
        );

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "model_settings".into(),
                data: serde_json::json!({
                    "effective_sampler": {
                        "temperature": 0.7,
                        "top_p": 0.95,
                        "reasoning_effort": "medium",
                        "thinking_enabled": true,
                        "budget_tokens": 2048,
                        "max_tokens": 4096,
                        "cache_ttl": "1h"
                    },
                    "scopes": {
                        "temperature": "character_model",
                        "top_p": "static_default",
                        "reasoning_effort": "static_default",
                        "thinking_enabled": "static_default",
                        "budget_tokens": "static_default",
                        "max_tokens": "static_default",
                        "cache_ttl": "static_default"
                    }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(app
            .completion
            .candidates
            .contains(&"temperature = 0.7".into()));
        assert_eq!(app.completion.selected, Some(0));
    }

    #[test]
    fn model_settings_error_refreshes_open_setting_submenu() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.enter_submenu("setting");
        assert_eq!(
            app.completion.candidates,
            vec!["loading sampler settings..."]
        );

        let effect = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: None,
                code: ErrorCode::InvalidRequest,
                message: "No model specified and no active model set".into(),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert_eq!(
            app.completion.candidates,
            vec!["sampler settings unavailable"]
        );
        assert_eq!(app.completion.selected, None);
    }

    #[test]
    fn unrelated_error_does_not_mark_pending_sampler_settings_unavailable() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.enter_submenu("setting");
        let rid = app.begin_sampler_settings_refresh();
        assert_eq!(
            app.completion.candidates,
            vec!["loading sampler settings..."]
        );

        let effect = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: None,
                code: ErrorCode::InvalidRequest,
                message: "unrelated command failed".into(),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(app.sampler_settings_loading);
        assert_eq!(
            app.pending_sampler_settings_rid.as_deref(),
            Some(rid.as_str())
        );
        assert_eq!(
            app.completion.candidates,
            vec!["loading sampler settings..."]
        );

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "model_settings".into(),
                data: serde_json::json!({
                    "effective_sampler": {
                        "temperature": 0.7
                    },
                    "scopes": {
                        "temperature": "character_model"
                    }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert!(app.pending_sampler_settings_rid.is_none());
        assert!(app
            .completion
            .candidates
            .contains(&"temperature = 0.7".into()));
    }

    #[test]
    fn pending_model_settings_error_marks_sampler_settings_unavailable() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.enter_submenu("setting");
        let rid = app.begin_sampler_settings_refresh();

        let effect = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: Some(rid),
                code: ErrorCode::InvalidRequest,
                message: "No model specified and no active model set".into(),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert!(app.pending_sampler_settings_rid.is_none());
        assert_eq!(
            app.completion.candidates,
            vec!["sampler settings unavailable"]
        );
    }

    #[test]
    fn model_settings_for_inactive_model_is_ignored() {
        let mut app = App::default();
        app.set_active_model(Some("chat.test.current"));
        app.sampler_settings_loading = true;

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "model_settings".into(),
                data: serde_json::json!({
                    "model": "chat.test.previous",
                    "effective_sampler": {
                        "temperature": 0.7
                    },
                    "scopes": {
                        "temperature": "character_model"
                    }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert!(app.effective_sampler.is_none());
    }

    #[test]
    fn model_settings_matches_active_provider_model_id_before_model_list_cache() {
        let mut app = App::default();
        app.set_active_model(Some("openrouter:anthropic/claude-sonnet-4.5"));
        app.sampler_settings_loading = true;

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "model_settings".into(),
                data: serde_json::json!({
                    "model": "chat.openrouter.sonnet",
                    "provider": "openrouter",
                    "model_id": "anthropic/claude-sonnet-4.5",
                    "effective_sampler": {
                        "temperature": 0.7
                    },
                    "scopes": {
                        "temperature": "character_model"
                    }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert_eq!(
            app.effective_sampler
                .as_ref()
                .and_then(|snapshot| snapshot.display_value("temperature")),
            Some("0.7")
        );
    }

    #[test]
    fn set_model_setting_response_requests_settings_refresh() {
        let mut app = App::default();
        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "set_model_setting".into(),
                data: serde_json::json!({
                    "key": "temperature",
                    "value": 0.8,
                    "scope": "character"
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert_eq!(effect.cmds.len(), 1);
        match &effect.cmds[0] {
            ConnCommand::Send(ClientMessage::Command(cmd)) => {
                assert_eq!(cmd.name, "model_settings");
                assert!(cmd.rid.is_some());
                assert_eq!(
                    cmd.rid.as_deref(),
                    app.pending_sampler_settings_rid.as_deref()
                );
            }
            _ => panic!("expected model_settings command"),
        }
        assert!(app.sampler_settings_loading);
        assert!(app.entries.iter().any(|entry| {
            matches!(entry, ConversationEntry::System { content, .. } if content == "setting temperature updated")
        }));
    }

    #[test]
    fn final_stream_end_requests_full_redraw() {
        let mut app = App::default();
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: None,
                revision: None,
                content: "done".into(),
                metadata: metadata(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::ImmediateFull);
    }

    #[test]
    fn tool_use_stream_end_keeps_regular_redraw() {
        let mut app = App::default();
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: None,
                revision: None,
                content: String::new(),
                metadata: metadata(),
                finish_reason: "tool_use".into(),
                is_final: false,
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
    }

    #[test]
    fn deferred_stream_effect_marks_dirty_without_immediate_redraw() {
        let mut needs_redraw = false;
        let mut deferred_stream_dirty = false;
        let mut needs_full_redraw = false;

        apply_redraw_effect(
            RedrawEffect::DeferredStream,
            &mut needs_redraw,
            &mut deferred_stream_dirty,
            &mut needs_full_redraw,
        );

        assert!(!needs_redraw);
        assert!(deferred_stream_dirty);
        assert!(!needs_full_redraw);
    }

    #[test]
    fn immediate_full_effect_requests_full_redraw() {
        let mut needs_redraw = false;
        let mut deferred_stream_dirty = true;
        let mut needs_full_redraw = false;

        apply_redraw_effect(
            RedrawEffect::ImmediateFull,
            &mut needs_redraw,
            &mut deferred_stream_dirty,
            &mut needs_full_redraw,
        );

        assert!(needs_redraw);
        assert!(deferred_stream_dirty);
        assert!(needs_full_redraw);
    }

    #[test]
    fn stream_chunk_effect_is_deferred() {
        let mut app = App::default();
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamChunk(StreamChunk {
                rid: None,
                text: "partial".into(),
                content_type: "text".into(),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::DeferredStream);
    }

    #[test]
    fn final_stream_end_attaches_metadata_by_msg_id_when_available() {
        let target_meta = metadata();
        let mut app = App::default();
        app.entries.push(ConversationEntry::Assistant {
            msg_id: Some("m_target".into()),
            content: "target".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });
        app.entries.push(ConversationEntry::Assistant {
            msg_id: Some("m_later".into()),
            content: "later".into(),
            images: vec![],
            timestamp: "t2".into(),
            metadata: None,
        });

        handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: Some("m_target".into()),
                revision: Some(7),
                content: "target".into(),
                metadata: target_meta.clone(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let target = app
            .entries
            .iter()
            .find_map(|entry| match entry {
                ConversationEntry::Assistant {
                    msg_id: Some(msg_id),
                    metadata,
                    ..
                } if msg_id == "m_target" => metadata.as_ref(),
                _ => None,
            })
            .expect("target assistant metadata");
        assert_eq!(target.model, target_meta.model);

        let later_metadata = app.entries.iter().find_map(|entry| match entry {
            ConversationEntry::Assistant {
                msg_id: Some(msg_id),
                metadata,
                ..
            } if msg_id == "m_later" => Some(metadata),
            _ => None,
        });
        assert!(matches!(later_metadata, Some(None)));
    }

    #[test]
    fn final_stream_end_with_unmatched_msg_id_does_not_annotate_latest_assistant() {
        let mut app = App::default();
        app.stream.accumulated_text = "new response".into();
        app.entries.push(ConversationEntry::Assistant {
            msg_id: Some("m_existing".into()),
            content: "existing".into(),
            images: vec![],
            timestamp: "t1".into(),
            metadata: None,
        });

        handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: Some("m_missing_from_history".into()),
                revision: Some(8),
                content: String::new(),
                metadata: metadata(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let existing_metadata = app.entries.iter().find_map(|entry| match entry {
            ConversationEntry::Assistant {
                msg_id: Some(msg_id),
                metadata,
                ..
            } if msg_id == "m_existing" => Some(metadata),
            _ => None,
        });
        assert!(matches!(existing_metadata, Some(None)));
        assert!(app.entries.iter().any(|entry| matches!(
            entry,
            ConversationEntry::Assistant {
                msg_id: Some(msg_id),
                metadata: Some(_),
                ..
            } if msg_id == "m_missing_from_history"
        )));
    }
}
