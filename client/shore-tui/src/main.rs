#![expect(
    elided_lifetimes_in_paths,
    unused_qualifications,
    clippy::arithmetic_side_effects,
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::else_if_without_else,
    clippy::exit,
    clippy::expect_used,
    clippy::float_arithmetic,
    clippy::indexing_slicing,
    clippy::integer_division,
    clippy::let_underscore_must_use,
    clippy::shadow_reuse,
    clippy::shadow_unrelated,
    clippy::str_to_string,
    clippy::string_slice,
    clippy::unreachable,
    clippy::unseparated_literal_suffix,
    clippy::unwrap_in_result,
    clippy::unwrap_used,
    clippy::wildcard_enum_match_arm,
    reason = "pre-existing violations from before this crate opted into the workspace lints (#8)"
)]

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
use crossterm::event::{DisableBracketedPaste, EnableBracketedPaste, poll, read};
use crossterm::execute;
use crossterm::terminal::{
    DisableLineWrap, EnableLineWrap, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode,
    enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::buffer::Buffer;
use shore_common::protocol::client_msg::{ClientMessage, Command};
use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::{ContentBlock, Message, Role, StreamMetadata};
use tracing::{info, instrument, warn};
use tracing_subscriber::EnvFilter;

#[cfg(test)]
use app::UsageBudget;
use app::{
    AltChoice, App, Block, ConnectionStatus, ConversationEntry, EffectiveSamplerSnapshot,
    InputState, SubagentSection, Turn, TurnState, UsageDisplay, UsageLevel, UsageScope,
};
use connection::{ConnCommand, ConnEvent};
use input::Action;

const STREAM_FRAME_INTERVAL: Duration = Duration::from_millis(200);
const INPUT_POLL_INTERVAL: Duration = Duration::from_millis(10);
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
}

#[derive(Parser)]
#[command(name = "shore-tui", about = "Shore terminal UI")]
struct Cli {
    /// TCP address of the daemon (overrides discovery)
    ///
    /// Reads `SHORE_ADDR` when the flag is absent, matching `shore`. The two
    /// binaries talk to the same daemon and are configured the same way, so a
    /// variable that steers one and is ignored by the other is a trap — you set
    /// it, `shore` obeys, and `shore-tui` silently falls back to discovery.
    #[arg(long, env = "SHORE_ADDR")]
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
    let log_dir = shore_common::dirs::runtime_dir();
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
                .is_some_and(parse_bool_env),
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
                FixtureRole::Assistant => app.entries.push(ConversationEntry::assistant(
                    None,
                    content.clone(),
                    vec![],
                    timestamp,
                    None,
                )),
                FixtureRole::User => {
                    app.entries
                        .push(ConversationEntry::user(content.clone(), vec![], timestamp));
                }
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
    let mut terminal = Terminal::new(backend).map_err(io::Error::other)?;
    let _ = terminal
        .draw(|frame| ui::draw(frame, app))
        .map_err(io::Error::other)?;
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

fn resolve_character(cli_character: Option<String>) -> Option<String> {
    if cli_character.is_some() {
        return cli_character;
    }
    if let Ok(val) = std::env::var("SHORE_CHARACTER")
        && !val.is_empty()
    {
        return Some(val);
    }
    shore_common::active_character::read_active_character()
}

fn persist_active_character(name: &str) {
    if let Err(e) = shore_common::active_character::write_active_character(name) {
        tracing::warn!(character = name, error = %e, "could not persist the active character");
    }
}

fn prefs_path() -> std::path::PathBuf {
    shore_common::dirs::config_dir().join("tui_prefs.json")
}

fn legacy_prefs_path() -> std::path::PathBuf {
    shore_common::dirs::runtime_dir().join("tui_prefs.json")
}

fn load_prefs(app: &mut App) {
    let data = std::fs::read_to_string(prefs_path())
        .or_else(|_| std::fs::read_to_string(legacy_prefs_path()));
    if let Ok(data) = data
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&data)
    {
        if let Some(b) = v.get("show_thinking").and_then(serde_json::Value::as_bool) {
            app.show_thinking = b;
        }
        if let Some(b) = v.get("show_tools").and_then(serde_json::Value::as_bool) {
            app.show_tools = b;
        }
        if let Some(b) = v.get("show_subagent").and_then(serde_json::Value::as_bool) {
            app.show_subagent = b;
        }
        if let Some(b) = v.get("show_images").and_then(serde_json::Value::as_bool) {
            app.show_images = b;
        }
        if let Some(b) = v
            .get("show_timestamps")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_timestamps = b;
        }
        if let Some(b) = v.get("show_metadata").and_then(serde_json::Value::as_bool) {
            app.show_metadata = b;
        }
        if let Some(mode) = v
            .get("usage_display")
            .and_then(|v| v.as_str())
            .and_then(app::UsageDisplay::from_token)
        {
            app.usage_display = mode;
        } else if let Some(b) = v.get("show_usage").and_then(serde_json::Value::as_bool) {
            app.usage_display = if b {
                app::UsageDisplay::Always
            } else {
                app::UsageDisplay::Off
            };
        }
        if let Some(focus) = v
            .get("budget_focus")
            .and_then(|v| v.as_str())
            .and_then(app::BudgetFocus::from_token)
        {
            app.budget_focus = focus;
        }
    }
}

fn save_prefs(app: &App) {
    let v = serde_json::json!({
        "show_thinking": app.show_thinking,
        "show_tools": app.show_tools,
        "show_subagent": app.show_subagent,
        "show_images": app.show_images,
        "show_timestamps": app.show_timestamps,
        "show_metadata": app.show_metadata,
        "usage_display": app.usage_display.as_str(),
        "budget_focus": app.budget_focus.as_token(),
    });
    let path = prefs_path();
    if let Some(dir) = path.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        warn!("failed to create prefs dir {}: {e}", dir.display());
        return;
    }
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, v.to_string()) {
        warn!("failed to write prefs: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        warn!("failed to persist prefs: {e}");
        let _ = std::fs::remove_file(&tmp);
    }
}

fn open_in_editor(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    input: &mut InputState,
) -> io::Result<()> {
    let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vi".to_string());
    let tmp = std::env::temp_dir().join("shore_input.md");
    std::fs::write(&tmp, input.text.as_str())?;

    execute!(io::stdout(), DisableBracketedPaste, EnableLineWrap)?;
    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen)?;

    let _ = std::process::Command::new(&editor).arg(&tmp).status();

    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        DisableLineWrap,
        EnableBracketedPaste
    )?;
    terminal.clear()?;

    if let Ok(contents) = std::fs::read_to_string(&tmp) {
        input.set_text(contents.trim_end_matches('\n').to_string());
    }
    Ok(())
}

fn pick_image(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    start_dir: Option<&str>,
) -> io::Result<Vec<String>> {
    let chooser_file = std::env::temp_dir().join("shore_image_pick");
    let _ = std::fs::remove_file(&chooser_file);

    let start = start_dir.unwrap_or(".");

    execute!(io::stdout(), DisableBracketedPaste, EnableLineWrap)?;
    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen)?;

    let result = try_yazi(&chooser_file, start).or_else(|| try_fzf(&chooser_file, start));

    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        DisableLineWrap,
        EnableBracketedPaste
    )?;
    terminal.clear()?;

    match result {
        Some(true) => {
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
        Some(false) => Ok(vec![]),
        None => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no file picker found (install yazi or fzf)",
        )),
    }
}

fn try_yazi(chooser_file: &std::path::Path, start: &str) -> Option<bool> {
    let status = std::process::Command::new("yazi")
        .arg(start)
        .arg("--chooser-file")
        .arg(chooser_file)
        .status()
        .ok()?;
    Some(status.success() && chooser_file.exists())
}

fn try_fzf(chooser_file: &std::path::Path, start: &str) -> Option<bool> {
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

fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

async fn send_conn_commands(
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    cmds: Vec<ConnCommand>,
) {
    for cmd in cmds {
        let _ = cmd_tx.send(cmd).await;
    }
}

fn model_settings_conn_command(_app: &App, rid: Option<String>) -> ConnCommand {
    ConnCommand::Send(ClientMessage::Command(Command {
        rid,
        name: "model_settings".into(),
        args: serde_json::json!({}),
    }))
}

fn subagent_trace_conn_command(ids: Vec<String>) -> ConnCommand {
    ConnCommand::Send(ClientMessage::Command(Command {
        rid: None,
        name: "subagent_trace".into(),
        args: serde_json::json!({ "ids": ids }),
    }))
}

fn missing_subagent_trace_ids(app: &App) -> Vec<String> {
    let mut ids = Vec::new();
    for entry in &app.entries {
        let Some(turn) = entry.as_turn() else {
            continue;
        };
        for block in &turn.blocks {
            let Block::ToolUse {
                tool_id, tool_name, ..
            } = block
            else {
                continue;
            };
            if tool_name.starts_with("ask_")
                && !app.subagent_traces.contains_key(tool_id)
                && !ids.contains(tool_id)
            {
                ids.push(tool_id.clone());
            }
        }
    }
    ids
}

pub(crate) fn subagent_trace_fetch(app: &mut App) -> Vec<ConnCommand> {
    if !app.show_subagent || !app.pending_subagent_trace_ids.is_empty() {
        return vec![];
    }
    let ids = missing_subagent_trace_ids(app);
    if ids.is_empty() {
        return vec![];
    }
    app.pending_subagent_trace_ids.extend(ids.iter().cloned());
    vec![subagent_trace_conn_command(ids)]
}

fn absorb_subagent_traces(app: &mut App, data: &serde_json::Value) {
    if data
        .get("character")
        .and_then(|v| v.as_str())
        .is_some_and(|character| character != app.character_name)
    {
        return;
    }

    if let Some(entries) = data.get("entries").and_then(|v| v.as_array()) {
        for entry in entries {
            let (Some(parent), Some(name)) = (
                entry.get("parent_tool_use_id").and_then(|v| v.as_str()),
                entry.get("subagent").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            let messages: Vec<Message> = entry
                .get("messages")
                .and_then(|v| v.as_array())
                .map(|msgs| {
                    msgs.iter()
                        .filter_map(|m| serde_json::from_value::<Message>(m.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();

            let content: Vec<ContentBlock> = messages
                .into_iter()
                .flat_map(|m| m.content_blocks)
                .collect();
            let names = tool_name_map(&content);
            let blocks = blocks_from_content(&content, &names);
            drop(app.subagent_traces.insert(
                parent.to_owned(),
                Some(SubagentSection {
                    name: name.to_owned(),
                    blocks,
                }),
            ));
        }
    }

    for id in std::mem::take(&mut app.pending_subagent_trace_ids) {
        _ = app.subagent_traces.entry(id).or_insert(None);
    }

    splice_subagent_sections(&mut app.entries, &app.subagent_traces);
    app.history_version = app.history_version.wrapping_add(1);
}

fn usage_budget_conn_command() -> ConnCommand {
    ConnCommand::Send(ClientMessage::Command(Command {
        rid: None,
        name: "usage".into(),
        args: serde_json::json!({ "budget": true }),
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

fn sanitize_terminal_text(text: &str) -> String {
    text.chars()
        .map(|ch| match ch {
            '\n' | '\r' | '\t' => ' ',
            c if c.is_control() => '\u{fffd}',
            c => c,
        })
        .collect()
}

fn mark_connection_task_exited(app: &mut App, conn_events_open: &mut bool) {
    if !*conn_events_open {
        return;
    }
    *conn_events_open = false;
    app.connection_status = ConnectionStatus::Disconnected;
    app.set_warning("connection task exited");
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
                Ok(paths) if paths.is_empty() => {}
                Ok(paths) => {
                    let count = paths.len();
                    app.pending_images.extend(paths);
                    app.set_status(format!(
                        "attached {count} image(s) ({} pending)",
                        app.pending_images.len()
                    ));
                }
                Err(e) => {
                    app.set_error(format!("image picker: {e}"));
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
                Ok(Ok(Err(e))) => app.set_error(e.to_string()),
                Ok(Err(_join)) => app.set_error("paste task panicked"),
                Err(_elapsed) => app.set_error("clipboard read timed out"),
            }
            Ok(true)
        }
        Action::SavePrefs => {
            save_prefs(app);
            Ok(true)
        }
        Action::SendAndSavePrefs(cmds) => {
            save_prefs(app);
            if send_enabled {
                send_conn_commands(cmd_tx, cmds).await;
            }
            Ok(true)
        }
        Action::Redraw => Ok(true),
        Action::None => Ok(false),
    }
}

#[instrument(skip(cli, debug))]
async fn run_tui(cli: Cli, debug: TuiDebugConfig) -> io::Result<()> {
    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        DisableLineWrap,
        EnableBracketedPaste
    )?;
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
    if !debug.no_image_probe && !fixture_mode {
        app.image_cache.probe_protocol();
    }
    if !fixture_mode {
        load_prefs(&mut app);
    }

    let (cmd_tx, mut event_rx) = if fixture_mode {
        let (cmd_tx, _cmd_rx) = tokio::sync::mpsc::channel::<ConnCommand>(16);
        let (_event_tx, event_rx) = tokio::sync::mpsc::channel::<ConnEvent>(1);
        (cmd_tx, event_rx)
    } else {
        connection::spawn_connection(cli.addr, cli.config, character)
    };

    let mut input_poll = tokio::time::interval(INPUT_POLL_INTERVAL);
    input_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut stream_frame = tokio::time::interval(STREAM_FRAME_INTERVAL);
    stream_frame.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut notif_tick = tokio::time::interval(Duration::from_millis(250));
    notif_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut needs_redraw = true;
    let mut deferred_stream_dirty = false;
    let mut needs_full_redraw = false;
    let mut conn_events_open = !fixture_mode;
    let mut frame_dump = debug.frame_dump_path.clone().map(FrameDump::new);

    let result = loop {
        if needs_redraw {
            if needs_full_redraw {
                terminal.clear()?;
                needs_full_redraw = false;
            }
            let _ = terminal.draw(|frame| ui::draw(frame, &mut app))?;
            if let Some(dump) = &mut frame_dump {
                let area = terminal.size()?;
                dump.dump(&mut app, area.width, area.height)?;
            }
            needs_redraw = false;
            deferred_stream_dirty = false;
        }

        tokio::select! {
            biased;
            _ = tokio::signal::ctrl_c() => {
                app.interrupt = true;
                app.should_quit = true;
            }
            conn_event = event_rx.recv(), if conn_events_open => {
                if let Some(event) = conn_event {
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

                } else {
                    mark_connection_task_exited(&mut app, &mut conn_events_open);
                    needs_redraw = true;
                }
            }
            _ = input_poll.tick() => {
                loop {
                    if app.should_quit {
                        break;
                    }
                    match poll(Duration::ZERO) {
                        Ok(true) => match read() {
                            Ok(ev) => {
                                let action = input::handle_event(&mut app, ev);
                                needs_redraw |= handle_action(
                                    &mut terminal,
                                    &mut app,
                                    &cmd_tx,
                                    action,
                                    !fixture_mode,
                                ).await?;
                            }
                            Err(e) => return Err(e),
                        },
                        Ok(false) => break,
                        Err(e) => return Err(e),
                    }
                }
            }
            _ = stream_frame.tick(), if app.stream.active => {
                app.spinner_frame = app.spinner_frame.wrapping_add(1);
                let scheduled_deferred_stream_paint = deferred_stream_dirty;
                needs_redraw = true;
                if scheduled_deferred_stream_paint {
                    deferred_stream_dirty = false;
                }
            }
            _ = notif_tick.tick(), if !app.notifications.is_empty() => {
                if app.expire_notifications(std::time::Instant::now()) {
                    needs_redraw = true;
                }
            }
        }

        if app.should_quit {
            break Ok(());
        }
    };

    info!("TUI exiting");
    if !fixture_mode {
        save_prefs(&app);
        let _ = cmd_tx.send(ConnCommand::Shutdown).await;
    }

    for path in &app.paste_temp_paths {
        let _ = std::fs::remove_file(path);
    }

    execute!(io::stdout(), DisableBracketedPaste, EnableLineWrap)?;
    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen)?;

    if !app.error_log.is_empty() {
        eprintln!("\n{} error(s) during this session:", app.error_log.len());
        for line in &app.error_log {
            eprintln!("  • {}", sanitize_terminal_text(line));
        }
    }

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
            let has_selected_character = selected_character.is_some();
            let next_character = selected_character.unwrap_or_default();
            if app.character_name != next_character {
                app.subagent_traces.clear();
                app.pending_subagent_trace_ids.clear();
            }
            app.connection_status = ConnectionStatus::Connected;
            app.effective_sampler = None;
            app.sampler_settings_loading = false;
            app.pending_sampler_settings_rid = None;
            app.usage_budgets.clear();
            app.characters.clone_from(&characters);

            app.character_name = next_character;

            if let Some(private) = config.get("private").and_then(serde_json::Value::as_bool) {
                app.is_private = private;
            }
            app.set_active_model(config.get("active_model").and_then(|v| v.as_str()));

            rebuild_entries_from_history(app, history, active_start);
            reset_history_paging(app);
            transmit_entry_images(app);

            app.set_status("connected");
            let mut cmds = if has_selected_character {
                vec![usage_budget_conn_command()]
            } else {
                vec![]
            };
            cmds.extend(subagent_trace_fetch(app));
            UiEffect {
                cmds,
                redraw: RedrawEffect::Immediate,
            }
        }

        ConnEvent::Disconnected(reason) => {
            app.connection_status = ConnectionStatus::Connecting;
            app.abort_stream();
            app.effective_sampler = None;
            app.sampler_settings_loading = false;
            app.pending_sampler_settings_rid = None;
            app.history_page_loading = false;
            app.pending_subagent_trace_ids.clear();
            app.usage_budgets.clear();
            app.set_status(format!("reconnecting: {reason}"));
            UiEffect::redraw(RedrawEffect::Immediate)
        }

        ConnEvent::Message(msg) => handle_server_message(app, msg),
    }
}

fn build_history_entries(messages: Vec<Message>, active_start: usize) -> Vec<ConversationEntry> {
    let mut entries = Vec::new();
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
        expand_msg(msg, &mut entries);
    }

    if boundary_at > 0 && !inserted_boundary {
        entries.push(ConversationEntry::ArchiveBoundary {
            archived_count: archived_turns,
        });
    }
    entries
}

fn rebuild_entries_from_history(app: &mut App, messages: Vec<Message>, active_start: usize) {
    app.entries = build_history_entries(messages, active_start);
    splice_subagent_sections(&mut app.entries, &app.subagent_traces);
}

fn reconcile_streaming_turn(app: &mut App, messages: Vec<Message>, active_start: usize) {
    let in_flight = app
        .entries
        .last()
        .and_then(ConversationEntry::as_turn)
        .filter(|turn| turn.is_streaming());
    let prev_metadata = in_flight.and_then(|turn| turn.metadata.clone());
    let prev_msg_id = in_flight.and_then(|turn| turn.msg_id.clone());

    app.entries = build_history_entries(messages, active_start);

    if !app.stream.active {
        return;
    }

    let target_pos = prev_msg_id
        .as_deref()
        .and_then(|id| {
            app.entries.iter().rposition(|e| {
                matches!(
                    e.as_turn(),
                    Some(Turn { role: Role::Assistant, msg_id: Some(m), .. }) if m == id
                )
            })
        })
        .or_else(|| match app.entries.last() {
            Some(entry) if matches!(entry.as_turn(), Some(t) if matches!(t.role, Role::Assistant)) => {
                Some(app.entries.len() - 1)
            }
            _ => None,
        });

    if let Some(turn) = target_pos.and_then(|pos| app.entries[pos].as_turn_mut()) {
        turn.state = TurnState::Streaming;
        if turn.metadata.is_none() {
            turn.metadata = prev_metadata;
        }
    }

    splice_subagent_sections(&mut app.entries, &app.subagent_traces);
}

fn accumulate_metadata(slot: &mut Option<StreamMetadata>, incoming: &StreamMetadata) {
    match slot {
        Some(acc) => {
            acc.model.clone_from(&incoming.model);
            acc.tokens.input += incoming.tokens.input;
            acc.tokens.output += incoming.tokens.output;
            acc.tokens.cache_read += incoming.tokens.cache_read;
            acc.tokens.cache_write += incoming.tokens.cache_write;
            acc.timing.total_ms += incoming.timing.total_ms;
        }
        None => *slot = Some(incoming.clone()),
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
        .and_then(serde_json::Value::as_u64)
        .map(|v| v as usize);
    app.history_has_more_before = data
        .get("has_more_before")
        .and_then(serde_json::Value::as_bool)
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
        drop(app.entries.splice(0..0, page_entries));
    } else {
        page_entries.push(ConversationEntry::ArchiveBoundary {
            archived_count: loaded_turns,
        });
        drop(app.entries.splice(0..0, page_entries));
    }

    splice_subagent_sections(&mut app.entries, &app.subagent_traces);
    app.grew_above_viewport = true;
    app.history_version = app.history_version.wrapping_add(1);
}

fn splice_subagent_sections(
    entries: &mut [ConversationEntry],
    traces: &std::collections::HashMap<String, Option<SubagentSection>>,
) {
    if traces.is_empty() {
        return;
    }
    for entry in entries {
        let ConversationEntry::Turn(turn) = entry else {
            continue;
        };
        if turn.is_streaming() {
            continue;
        }
        let mut i = 0;
        while i < turn.blocks.len() {
            let Block::ToolUse {
                tool_id, tool_name, ..
            } = &turn.blocks[i]
            else {
                i += 1;
                continue;
            };
            if !tool_name.starts_with("ask_") {
                i += 1;
                continue;
            }
            if matches!(turn.blocks.get(i + 1), Some(Block::SubagentBegin(_))) {
                i += 1;
                continue;
            }
            let Some(Some(section)) = traces.get(tool_id.as_str()) else {
                i += 1;
                continue;
            };

            let mut nested = Vec::with_capacity(section.blocks.len() + 2);
            nested.push(Block::SubagentBegin(section.name.clone()));
            nested.extend(section.blocks.iter().cloned());
            nested.push(Block::SubagentEnd(section.name.clone()));
            let inserted = nested.len();
            drop(turn.blocks.splice((i + 1)..=i, nested));
            i += inserted + 1;
        }
    }
}

fn tool_name_map(blocks: &[ContentBlock]) -> std::collections::HashMap<&str, &str> {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, .. } => Some((id.as_str(), name.as_str())),
            _ => None,
        })
        .collect()
}

fn blocks_from_content(
    content_blocks: &[ContentBlock],
    tool_names: &std::collections::HashMap<&str, &str>,
) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    for block in content_blocks {
        match block {
            ContentBlock::Thinking { thinking, .. } => {
                if !thinking.is_empty() {
                    blocks.push(Block::Thinking(thinking.clone()));
                }
            }
            ContentBlock::RedactedThinking { .. } => {}
            ContentBlock::ToolUse { id, name, input } => {
                blocks.push(Block::ToolUse {
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
                blocks.push(Block::ToolResult {
                    tool_id: tool_use_id.clone(),
                    tool_name: (*name).to_owned(),
                    output: content.clone(),
                    is_error: *is_error,
                });
            }
            ContentBlock::Text { text } => {
                if !text.trim().is_empty() {
                    blocks.push(Block::Text(text.clone()));
                }
            }
        }
    }
    blocks
}

fn expand_msg(msg: Message, entries: &mut Vec<ConversationEntry>) {
    if msg.role == Role::System {
        entries.push(ConversationEntry::System {
            content: msg.content,
            count: 1,
            timestamp: msg.timestamp,
        });
        return;
    }

    if msg.content_blocks.is_empty() {
        let msg_id = (msg.role == Role::Assistant).then_some(msg.msg_id);
        entries.push(ConversationEntry::Turn(Turn::text(
            msg.role,
            msg_id,
            msg.content,
            msg.images,
            msg.timestamp,
            None,
        )));
        return;
    }

    let tool_names = tool_name_map(&msg.content_blocks);
    let blocks = blocks_from_content(&msg.content_blocks, &tool_names);

    entries.push(ConversationEntry::Turn(Turn {
        role: msg.role,
        msg_id: Some(msg.msg_id),
        blocks,
        images: msg.images,
        timestamp: msg.timestamp,
        state: TurnState::Complete,
        metadata: None,
    }));
}

fn image_max_cells() -> (u16, u16) {
    let (w, h) = crossterm::terminal::size().unwrap_or((80, 24));
    let max_cols = (w * 80 / 100).saturating_sub(4).max(1);
    let max_rows = (h * 50 / 100).max(1);
    (max_cols, max_rows)
}

fn transmit_entry_images(app: &mut App) {
    let (max_cols, max_rows) = image_max_cells();
    for entry in &app.entries {
        let Some(turn) = entry.as_turn() else {
            continue;
        };
        for img in &turn.images {
            transmit_image_ref(&mut app.image_cache, img, max_cols, max_rows);
        }
    }
}

fn transmit_image_ref(
    cache: &mut images::ImageCache,
    img: &shore_common::protocol::types::ImageRef,
    max_cols: u16,
    max_rows: u16,
) {
    if let Some(b64) = &img.data {
        let _ = cache.ensure_transmitted_from_b64(&img.path, b64, max_cols, max_rows);
    } else {
        let _ = cache.ensure_transmitted(&img.path, max_cols, max_rows);
    }
}

fn model_switch_name(model: &serde_json::Value) -> Option<String> {
    if let Some(qualified) = model.get("qualified_name").and_then(|v| v.as_str()) {
        return Some(qualified.to_string());
    }
    let provider = model.get("provider").and_then(|v| v.as_str());
    let model_id = model.get("model_id").and_then(|v| v.as_str());
    if let (Some(provider), Some(model_id)) = (provider, model_id) {
        return Some(format!("{provider}:{model_id}"));
    }
    model
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
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
                return model_switch_name(model);
            }
        }
    }

    identifiers
        .into_iter()
        .any(|identifier| App::model_identifier_matches(active, identifier))
        .then(|| model_switch_name(model))
        .flatten()
}

pub(crate) fn handle_server_message(app: &mut App, msg: ServerMessage) -> UiEffect {
    if matches!(
        msg,
        ServerMessage::StreamStart(_)
            | ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::SendImage(_)
    ) {
        app.sync_subagent_section(msg.subagent());
    }

    let redraw = match msg {
        ServerMessage::StreamStart(start) => {
            if start.subagent.is_some() {
                app.spinner_frame = 0;
                return UiEffect::redraw(RedrawEffect::Immediate);
            }
            app.spinner_frame = 0;
            if start.regen {
                app.begin_regen_optimistic();
            } else if !app.stream.active {
                app.stream.reset();
                app.stream.active = true;
            } else {
                app.stream.phase = "responding".into();
                app.stream.tool_name = None;
            }
            RedrawEffect::Immediate
        }

        ServerMessage::StreamChunk(chunk) => {
            if chunk.content_type == "thinking" {
                app.stream_append_thinking(&chunk.text);
                app.stream.phase = "thinking".into();
            } else {
                app.stream_append_text(&chunk.text);
                app.stream.phase = "responding".into();
            }
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::DeferredStream
        }

        ServerMessage::StreamEnd(end) => {
            if end.subagent.is_some() {
                return UiEffect::redraw(RedrawEffect::Immediate);
            }
            if end.finish_reason == "cancelled" {
                app.abort_stream();
                app.set_status("generation cancelled");
                return UiEffect::redraw(RedrawEffect::ImmediateFull);
            }

            let keep_bottom = app.auto_scroll;
            app.set_active_model(Some(&end.metadata.model));
            app.tokens = end.metadata.tokens.clone();

            let final_phase = end.finish_reason != "tool_use";

            let target_pos = end
                .msg_id
                .as_deref()
                .and_then(|target| {
                    app.entries.iter().rposition(|e| {
                        matches!(
                            e.as_turn(),
                            Some(Turn { msg_id: Some(id), .. }) if id == target
                        )
                    })
                })
                .or_else(|| {
                    app.entries
                        .iter()
                        .rposition(|e| matches!(e.as_turn(), Some(t) if t.is_streaming()))
                });

            match target_pos.and_then(|pos| app.entries[pos].as_turn_mut()) {
                Some(turn) => {
                    accumulate_metadata(&mut turn.metadata, &end.metadata);
                    if turn.msg_id.is_none() {
                        turn.msg_id.clone_from(&end.msg_id);
                    }
                    if final_phase {
                        if !end.content.is_empty()
                            && !turn.blocks.iter().any(|b| matches!(b, Block::Text(_)))
                        {
                            turn.blocks.push(Block::Text(end.content.clone()));
                        }
                        turn.state = TurnState::Complete;
                    }
                }
                None if final_phase => {
                    let mut metadata = None;
                    accumulate_metadata(&mut metadata, &end.metadata);
                    app.entries.push(ConversationEntry::Turn(Turn::text(
                        Role::Assistant,
                        end.msg_id.clone(),
                        end.content.clone(),
                        vec![],
                        String::new(),
                        metadata,
                    )));
                }
                None => {
                    let turn = app.ensure_streaming_turn();
                    accumulate_metadata(&mut turn.metadata, &end.metadata);
                    if turn.msg_id.is_none() {
                        turn.msg_id.clone_from(&end.msg_id);
                    }
                }
            }

            if final_phase {
                app.stream.reset();
                if matches!(end.finish_reason.as_str(), "max_tokens" | "length") {
                    app.set_status("reply truncated at the max_tokens ceiling");
                }
                if keep_bottom {
                    app.scroll_to_bottom();
                }
                return UiEffect {
                    cmds: vec![usage_budget_conn_command()],
                    redraw: RedrawEffect::ImmediateFull,
                };
            }
            app.stream.phase = "tool_use".into();
            app.stream.tool_name = None;
            RedrawEffect::Immediate
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
            app.stream_push_tool_call(tc.tool_id, tc.tool_name, tc.input);
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::Immediate
        }

        ServerMessage::ToolResult(tr) => {
            app.stream.tool_name = None;
            app.stream_push_tool_result(tr.tool_id, tr.tool_name, tr.output, tr.is_error);
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::Immediate
        }

        ServerMessage::SendImage(img) => {
            let (max_cols, max_rows) = image_max_cells();
            if let Some(b64) = &img.data {
                let _ = app
                    .image_cache
                    .ensure_transmitted_from_b64(&img.path, b64, max_cols, max_rows);
            } else {
                let _ = app
                    .image_cache
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
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as usize;
                        rebuild_entries_from_history(app, history, active_start);
                        app.history_next_before = co
                            .data
                            .get("next_before")
                            .and_then(serde_json::Value::as_u64)
                            .map(|v| v as usize);
                        app.history_has_more_before = co
                            .data
                            .get("has_more_before")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false);
                        app.history_page_loading = false;
                        transmit_entry_images(app);
                        if app.auto_scroll {
                            app.scroll_to_bottom();
                        }
                        return UiEffect {
                            cmds: subagent_trace_fetch(app),
                            redraw: RedrawEffect::Immediate,
                        };
                    }
                }
                "history_page" => {
                    prepend_history_page(app, &co.data);
                    return UiEffect {
                        cmds: subagent_trace_fetch(app),
                        redraw: RedrawEffect::Immediate,
                    };
                }
                "subagent_trace" => {
                    absorb_subagent_traces(app, &co.data);
                    return UiEffect {
                        cmds: subagent_trace_fetch(app),
                        redraw: RedrawEffect::Immediate,
                    };
                }
                "list_characters" => {
                    if let Some(chars) = co.data.get("characters").and_then(|v| v.as_array()) {
                        let active = co.data.get("active").and_then(|v| v.as_str()).unwrap_or("");
                        app.characters = chars
                            .iter()
                            .filter_map(|c| c.get("name").and_then(|n| n.as_str()))
                            .map(shore_common::protocol::types::CharacterInfo::new)
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
                        persist_active_character(name);
                    }
                    app.subagent_traces.clear();
                    app.pending_subagent_trace_ids.clear();
                    app.effective_sampler = None;
                    if co
                        .data
                        .get("active_model")
                        .is_some_and(serde_json::Value::is_null)
                    {
                        app.set_active_model(None);
                    } else {
                        app.set_active_model(co.data.get("active_model").and_then(|v| v.as_str()));
                    }
                    if let Some(private) =
                        co.data.get("private").and_then(serde_json::Value::as_bool)
                    {
                        app.is_private = private;
                    }
                    if let Some(name) = co.data.get("character").and_then(|v| v.as_str()) {
                        app.set_status(format!("switched to {name}"));
                    }
                }
                "list_models" => {
                    if let Some(models) = co.data.get("models").and_then(|v| v.as_array()) {
                        app.model_names = models.iter().filter_map(model_switch_name).collect();
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

                        if app.show_model_list {
                            app.show_model_list = false;
                            let hidden_count = co
                                .data
                                .get("hidden_count")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0);
                            let include_hidden = co
                                .data
                                .get("include_hidden")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false);
                            let list = models
                                .iter()
                                .map(|m| {
                                    let n = m.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                                    let provider =
                                        m.get("provider").and_then(|v| v.as_str()).unwrap_or("?");
                                    let qualified = match m.get("model_id").and_then(|v| v.as_str())
                                    {
                                        Some(model_id) => format!("{provider}:{model_id}"),
                                        None => provider.to_string(),
                                    };
                                    let source =
                                        m.get("source").and_then(|v| v.as_str()).unwrap_or("");
                                    let hidden = m
                                        .get("hidden")
                                        .and_then(serde_json::Value::as_bool)
                                        .unwrap_or(false);
                                    let marker = if model_switch_name(m)
                                        .is_some_and(|s| app.is_active_model_candidate(&s))
                                    {
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
                                    format!("  {marker} {n:<28}{qualified}{tag}")
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
                    let snapshot = EffectiveSamplerSnapshot::from_model_settings(&co.data);
                    if pending_response {
                        app.finish_sampler_settings_refresh();
                        if let Some(snapshot) = snapshot {
                            app.note_active_model_from_snapshot(&snapshot);
                            app.effective_sampler = Some(snapshot);
                        }
                    } else if co.rid.is_none()
                        && let Some(snapshot) = snapshot
                            .filter(|snapshot| app.sampler_snapshot_matches_active_model(snapshot))
                    {
                        app.finish_sampler_settings_refresh();
                        app.note_active_model_from_snapshot(&snapshot);
                        app.effective_sampler = Some(snapshot);
                    }
                    if app.is_setting_palette_open() {
                        app.update_completions();
                    }
                }
                "switch_model" => {
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
                    let value_is_null = co.data.get("value").is_none_or(serde_json::Value::is_null);
                    if value_is_null {
                        app.set_status(format!("reset {key}"));
                    } else {
                        app.set_status(format!("setting {key} updated"));
                    }
                    return UiEffect {
                        cmds: vec![model_settings_conn_command(app, Some(refresh_rid))],
                        redraw: RedrawEffect::Immediate,
                    };
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
                                    index: item
                                        .get("index")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(0)
                                        as u32,
                                    position: item
                                        .get("position")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(0)
                                        as u32,
                                    active: item
                                        .get("active")
                                        .and_then(serde_json::Value::as_bool)
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
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    let count = co
                        .data
                        .get("alt_count")
                        .and_then(serde_json::Value::as_u64)
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
                "usage" => {
                    app.apply_usage_budgets(&co.data);
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
            app.set_error(format!("error: {:?} - {}", err.code, err.message));
            RedrawEffect::Immediate
        }

        ServerMessage::CacheWarning(cw) => {
            app.set_warning(format!("cache warning: {}", cw.message));
            RedrawEffect::Immediate
        }

        ServerMessage::ConfigWarning(cw) => {
            let what = cw.character.as_deref().unwrap_or("config");
            app.set_warning(format!("{what}: {} not applied — {}", cw.path, cw.message));
            RedrawEffect::Immediate
        }

        ServerMessage::ProviderFallbackWarning(w) => {
            app.set_warning(w.message.clone());
            RedrawEffect::Immediate
        }

        ServerMessage::UsageWarning(w) => {
            if app.usage_display == UsageDisplay::Off {
                app.set_warning(w.message.clone());
            } else {
                let scope = if w.scope.as_deref() == Some("pace") {
                    UsageScope::Pace
                } else {
                    UsageScope::Cap
                };
                app.apply_usage_warning(
                    &w.budget,
                    scope,
                    UsageLevel {
                        percent_used: w.percent_used,
                        crossed_warn_at: w.crossed_warn_at.clone(),
                        over_limit: w.percent_used >= 1.0,
                    },
                );
            }
            RedrawEffect::Immediate
        }

        ServerMessage::History(hist) => {
            if let Some(private) = hist
                .config
                .get("private")
                .and_then(serde_json::Value::as_bool)
            {
                app.is_private = private;
            }
            app.set_active_model(hist.config.get("active_model").and_then(|v| v.as_str()));
            app.effective_sampler = None;
            if let Some(selected) = hist.selected_character {
                app.character_name = selected;
            }
            app.image_cache.clear();
            reconcile_streaming_turn(app, hist.messages, hist.active_start);
            reset_history_paging(app);
            app.history_version = app.history_version.wrapping_add(1);
            transmit_entry_images(app);
            return UiEffect {
                cmds: subagent_trace_fetch(app),
                redraw: RedrawEffect::Immediate,
            };
        }

        _ => RedrawEffect::Immediate,
    };
    UiEffect::redraw(redraw)
}

#[cfg(test)]
mod redraw_tests {
    use super::*;
    use shore_common::protocol::error::ErrorCode;
    use shore_common::protocol::server_msg::{
        CommandOutput, Error as CommandError, StreamChunk, StreamEnd,
    };
    use shore_common::protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

    #[expect(unsafe_code, reason = "env::set_var is unsafe as of edition 2024")]
    fn set_env(key: &str, value: &std::path::Path) {
        // SAFETY: the one test that touches env holds it for its whole body.
        unsafe { std::env::set_var(key, value) }
    }

    #[expect(unsafe_code, reason = "env::remove_var is unsafe as of edition 2024")]
    fn unset_env(key: &str) {
        // SAFETY: as above.
        unsafe { std::env::remove_var(key) }
    }

    #[test]
    fn a_switch_is_persisted_for_the_next_client() {
        let tmp = tempfile::TempDir::new().unwrap();
        set_env("SHORE_RUNTIME_DIR", &tmp.path().join("shore"));
        unset_env("SHORE_CHARACTER");
        let result = std::panic::catch_unwind(|| {
            let mut app = App::default();

            let _ = handle_server_message(
                &mut app,
                ServerMessage::CommandOutput(CommandOutput {
                    rid: None,
                    name: "switch_character".into(),
                    data: serde_json::json!({ "character": "poppy", "active_model": null }),
                }),
            );

            assert_eq!(app.character_name, "poppy");
            assert_eq!(
                shore_common::active_character::read_active_character().as_deref(),
                Some("poppy"),
                "the switch has to reach the file the next client reads",
            );
            assert_eq!(resolve_character(None).as_deref(), Some("poppy"));

            assert_eq!(
                resolve_character(Some("Yuna".into())).as_deref(),
                Some("Yuna")
            );
            assert_eq!(
                shore_common::active_character::read_active_character().as_deref(),
                Some("poppy"),
            );
        });
        unset_env("SHORE_RUNTIME_DIR");
        result.unwrap();
    }

    #[test]
    fn sanitize_terminal_text_strips_escapes_and_flattens_lines() {
        let dirty = "error\x1b[2Jspoofed\nsecond line\twith tab";
        let clean = sanitize_terminal_text(dirty);
        assert!(!clean.contains('\x1b'), "escape byte stripped");
        assert!(!clean.contains('\n'), "newline flattened");
        assert!(!clean.contains('\t'), "tab flattened");
        assert!(clean.contains("error"));
        assert!(clean.contains("second line with tab"));
    }

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
            app.entries[0].as_turn(),
            Some(t) if t.role == Role::Assistant && t.joined_text().contains("# Fixture")
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
        app.entries.push(ConversationEntry::assistant(
            None,
            "hello from dump".into(),
            vec![],
            "t1".into(),
            None,
        ));

        dump.dump(&mut app, 32, 12).unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("shore-tui frame 1 (32x12)"));
        assert!(contents.contains("hello from dump"));

        let _ = std::fs::remove_file(path);
    }

    fn usage_warning(percent: f64) -> ServerMessage {
        ServerMessage::UsageWarning(shore_common::protocol::server_msg::UsageWarning {
            rid: None,
            budget: "monthly".into(),
            message: "usage budget at 80%".into(),
            current_cost: 4.1,
            cost_limit: 5.0,
            percent_used: percent,
            crossed_warn_at: vec![0.8],
            period: "month".into(),
            period_start: "2026-06-01T00:00:00Z".into(),
            reset_at: "2026-07-01T00:00:00Z".into(),
            reset_at_display: String::new(),
            scope: None,
        })
    }

    fn system_entry_count(app: &App) -> usize {
        app.entries
            .iter()
            .filter(|e| matches!(e, ConversationEntry::System { .. }))
            .count()
    }

    fn trace_app() -> App {
        App {
            character_name: "Rhia".into(),
            ..Default::default()
        }
    }

    fn delegating_turn(parent_id: &str) -> ConversationEntry {
        ConversationEntry::Turn(Turn {
            role: Role::Assistant,
            msg_id: Some("m_1".into()),
            blocks: vec![
                Block::ToolUse {
                    tool_id: parent_id.into(),
                    tool_name: "ask_research".into(),
                    input: serde_json::json!({ "query": "when did Sam leave?" }),
                },
                Block::ToolResult {
                    tool_id: parent_id.into(),
                    tool_name: "ask_research".into(),
                    output: "June".into(),
                    is_error: false,
                },
            ],
            images: vec![],
            timestamp: "2026-08-13T10:00:00+10:00".into(),
            state: TurnState::Complete,
            metadata: None,
        })
    }

    fn trace_output(parent_id: &str) -> ServerMessage {
        trace_output_for_character(parent_id, "Rhia")
    }

    fn trace_output_for_character(parent_id: &str, character: &str) -> ServerMessage {
        ServerMessage::CommandOutput(CommandOutput {
            rid: None,
            name: "subagent_trace".into(),
            data: serde_json::json!({
                "character": character,
                "entries": [{
                    "ts": "2026-08-13T10:00:00+10:00",
                    "subagent": "research",
                    "parent_tool_use_id": parent_id,
                    "model": "cheap",
                    "messages": [
                        {
                            "msg_id": "s_1",
                            "role": "assistant",
                            "content": "",
                            "images": [],
                            "content_blocks": [
                                { "type": "thinking", "thinking": "memory first" },
                                { "type": "tool_use", "id": "s1", "name": "search_memory",
                                  "input": { "query": "Sam" } }
                            ],
                            "timestamp": "2026-08-13T10:00:00+10:00"
                        },
                        {
                            "msg_id": "s_2",
                            "role": "user",
                            "content": "",
                            "images": [],
                            "content_blocks": [
                                { "type": "tool_result", "tool_use_id": "s1",
                                  "content": "June — Sam took the small room", "is_error": false }
                            ],
                            "timestamp": "2026-08-13T10:00:01+10:00"
                        }
                    ],
                    "result": "June"
                }]
            }),
        })
    }

    fn turn_blocks(app: &App) -> &[Block] {
        &app.entries
            .first()
            .and_then(ConversationEntry::as_turn)
            .expect("a turn")
            .blocks
    }

    #[test]
    fn a_stored_run_is_spliced_between_the_ask_call_and_its_result() {
        let mut app = trace_app();
        app.entries.push(delegating_turn("toolu_p1"));
        app.pending_subagent_trace_ids.push("toolu_p1".into());

        let _ = handle_server_message(&mut app, trace_output("toolu_p1"));

        let kinds: Vec<&str> = turn_blocks(&app)
            .iter()
            .map(|b| match b {
                Block::ToolUse { .. } => "use",
                Block::ToolResult { .. } => "result",
                Block::SubagentBegin(_) => "begin",
                Block::SubagentEnd(_) => "end",
                Block::Thinking(_) => "thinking",
                Block::Text(_) => "text",
            })
            .collect();
        assert_eq!(
            kinds,
            vec!["use", "begin", "thinking", "use", "result", "end", "result"]
        );
    }

    #[test]
    fn a_nested_result_is_labelled_from_a_call_in_another_message() {
        let mut app = trace_app();
        app.entries.push(delegating_turn("toolu_p1"));

        let _ = handle_server_message(&mut app, trace_output("toolu_p1"));

        let labelled = turn_blocks(&app).iter().any(
            |b| matches!(b, Block::ToolResult { tool_name, .. } if tool_name == "search_memory"),
        );
        assert!(labelled, "nested result must carry its call's name");
    }

    #[test]
    fn splicing_twice_does_not_duplicate_the_section() {
        let mut app = trace_app();
        app.entries.push(delegating_turn("toolu_p1"));

        let _ = handle_server_message(&mut app, trace_output("toolu_p1"));
        let after_first = turn_blocks(&app).len();
        splice_subagent_sections(&mut app.entries, &app.subagent_traces);

        assert_eq!(
            turn_blocks(&app).len(),
            after_first,
            "the splice runs after every rebuild; it must be idempotent"
        );
    }

    #[test]
    fn an_id_with_no_stored_run_is_not_requested_again() {
        let mut app = trace_app();
        app.entries.push(delegating_turn("toolu_p1"));
        assert_eq!(
            missing_subagent_trace_ids(&app),
            vec!["toolu_p1".to_owned()],
            "an unfetched ask_ call is worth one request"
        );
        app.pending_subagent_trace_ids.push("toolu_p1".into());

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "subagent_trace".into(),
                data: serde_json::json!({ "character": "Rhia", "entries": [] }),
            }),
        );

        assert!(
            missing_subagent_trace_ids(&app).is_empty(),
            "an empty answer must be remembered, or every rebuild re-asks forever"
        );
    }

    #[test]
    fn an_in_flight_trace_request_is_not_duplicated() {
        let mut app = trace_app();
        app.entries.push(delegating_turn("toolu_p1"));

        assert_eq!(subagent_trace_fetch(&mut app).len(), 1);
        assert!(subagent_trace_fetch(&mut app).is_empty());
    }

    #[test]
    fn a_trace_for_another_character_is_ignored() {
        let mut app = trace_app();
        app.entries.push(delegating_turn("toolu_p1"));
        app.pending_subagent_trace_ids.push("toolu_p1".into());

        let _ = handle_server_message(&mut app, trace_output_for_character("toolu_p1", "Other"));

        assert!(!app.subagent_traces.contains_key("toolu_p1"));
        assert_eq!(app.pending_subagent_trace_ids, vec!["toolu_p1"]);
    }

    #[test]
    fn nothing_is_fetched_while_the_section_is_toggled_off() {
        let mut app = App {
            show_subagent: false,
            ..Default::default()
        };
        app.entries.push(delegating_turn("toolu_p1"));

        assert!(subagent_trace_fetch(&mut app).is_empty());
        assert!(app.pending_subagent_trace_ids.is_empty());

        app.show_subagent = true;
        assert_eq!(subagent_trace_fetch(&mut app).len(), 1);
    }

    #[test]
    fn a_turn_without_delegation_costs_no_request() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::Turn(Turn {
            role: Role::Assistant,
            msg_id: Some("m_1".into()),
            blocks: vec![Block::Text("no tools here".into())],
            images: vec![],
            timestamp: "2026-08-13T10:00:00+10:00".into(),
            state: TurnState::Complete,
            metadata: None,
        }));

        assert!(subagent_trace_fetch(&mut app).is_empty());
    }

    #[test]
    fn usage_warning_notifies_when_monitor_hidden() {
        let mut app = App::default();

        let _ = handle_server_message(&mut app, usage_warning(0.82));

        assert_eq!(
            app.notifications.len(),
            1,
            "hidden monitor should fall back to a notification toast"
        );
        assert!(
            app.usage_budgets.is_empty(),
            "no chip state needed while hidden"
        );
    }

    #[test]
    fn usage_warning_suppressed_and_folded_into_chip_when_visible() {
        let mut app = App {
            usage_display: UsageDisplay::Always,
            ..Default::default()
        };

        let _ = handle_server_message(&mut app, usage_warning(0.82));

        assert_eq!(
            system_entry_count(&app),
            0,
            "visible monitor should suppress the notification"
        );
        let budget = app.focused_budget().expect("warning seeds chip state");
        assert_eq!(budget.name, "monthly");
        assert!((budget.percent_used - 0.82).abs() < f64::EPSILON);
        assert!(budget.in_warning(), "crossed threshold flags warning state");
    }

    #[test]
    fn disconnect_clears_cached_budgets() {
        let mut app = App {
            usage_display: UsageDisplay::Always,
            ..Default::default()
        };
        app.usage_budgets = vec![UsageBudget {
            name: "monthly".into(),
            percent_used: 0.82,
            crossed_warn_at: vec![0.8],
            over_limit: false,
            pace: None,
        }];

        let _ = handle_conn_event(&mut app, ConnEvent::Disconnected("server gone".into()));

        assert!(
            app.usage_budgets.is_empty(),
            "reconnecting must not keep rendering the previous session's budget"
        );
    }

    #[test]
    fn usage_command_output_populates_budgets_silently() {
        let mut app = App::default();

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "usage".into(),
                data: serde_json::json!({
                    "mode": "budget",
                    "budgets": [
                        { "name": "daily", "percent_used": 0.2, "crossed_warn_at": [], "over_limit": false },
                        { "name": "monthly", "percent_used": 0.95, "crossed_warn_at": [0.8, 0.9], "over_limit": false }
                    ]
                }),
            }),
        );

        assert_eq!(system_entry_count(&app), 0, "background poll is silent");
        assert_eq!(app.usage_budgets.len(), 2);
        assert_eq!(app.focused_budget().unwrap().name, "monthly");
    }

    #[test]
    fn budget_pace_outranks_a_cooler_period_cap() {
        let mut app = App::default();

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "usage".into(),
                data: serde_json::json!({
                    "mode": "budget",
                    "budgets": [{
                        "name": "weekly",
                        "percent_used": 0.2,
                        "crossed_warn_at": [],
                        "over_limit": false,
                        "pace": {
                            "percent_used": 1.4,
                            "crossed_warn_at": [0.8, 1.0],
                            "over_limit": true
                        }
                    }]
                }),
            }),
        );

        let budget = app.focused_budget().expect("one budget cached");
        let headline = budget.headline();
        assert!(headline.over_limit, "pace is over its allowance");
        assert!(budget.in_warning(), "an overspent pace styles as a warning");
        assert!(
            (headline.percent_used - 1.4).abs() < f64::EPSILON,
            "chip reports the pace figure, not the 20% week"
        );
    }

    #[test]
    fn a_warning_pace_outranks_a_hotter_but_calm_cap() {
        let mut app = App::default();

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "usage".into(),
                data: serde_json::json!({
                    "mode": "budget",
                    "budgets": [{
                        "name": "weekly",
                        "percent_used": 0.6,
                        "crossed_warn_at": [],
                        "over_limit": false,
                        "pace": {
                            "percent_used": 0.55,
                            "crossed_warn_at": [0.5],
                            "over_limit": false
                        }
                    }]
                }),
            }),
        );

        let budget = app.focused_budget().expect("one budget cached");
        assert!(budget.in_warning(), "the pace warning is not swallowed");
        let headline = budget.headline();
        assert_eq!(headline.crossed_warn_at, vec![0.5]);
        assert!(
            (headline.percent_used - 0.55).abs() < f64::EPSILON,
            "the warning limit is the one reported, despite the cooler percent"
        );
        assert!(
            (budget.headline_percent() - 0.55).abs() < f64::EPSILON,
            "headline_percent agrees with headline"
        );
    }

    #[test]
    fn pace_warning_push_does_not_clobber_the_cached_cap() {
        let mut app = App {
            usage_budgets: vec![UsageBudget {
                name: "weekly".into(),
                percent_used: 0.3,
                crossed_warn_at: vec![],
                over_limit: false,
                pace: None,
            }],
            ..Default::default()
        };

        app.apply_usage_warning(
            "weekly",
            UsageScope::Pace,
            UsageLevel {
                percent_used: 1.2,
                crossed_warn_at: vec![1.0],
                over_limit: true,
            },
        );

        let budget = app.focused_budget().expect("one budget cached");
        assert!(
            (budget.percent_used - 0.3).abs() < f64::EPSILON,
            "the period cap figure survives a pace push"
        );
        assert!(budget.pace.as_ref().is_some_and(|p| p.over_limit));
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
        assert_eq!(
            app.completion.candidates,
            vec!["chat.anthropic.alpha", "chat.anthropic.beta", "reset"]
        );
        assert!(app.is_active_model_candidate("beta"));
        assert!(!app.entries.iter().any(|entry| {
            matches!(entry, ConversationEntry::System { content, .. } if content.contains("Models:"))
        }));
    }

    #[test]
    fn list_models_caches_provider_qualified_switch_names() {
        let mut app = App {
            show_model_list: true,
            ..App::default()
        };

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "list_models".into(),
                data: serde_json::json!({
                    "models": [
                        {
                            "name": "deepseek-v4-pro",
                            "qualified_name": "deepseek:deepseek-v4-pro",
                            "provider": "deepseek",
                            "model_id": "deepseek-v4-pro",
                            "source": "discovered"
                        },
                        {
                            "name": "deepseek-v4-pro",
                            "qualified_name": "opencode-go:deepseek-v4-pro",
                            "provider": "opencode-go",
                            "model_id": "deepseek-v4-pro",
                            "source": "discovered"
                        }
                    ]
                }),
            }),
        );

        assert_eq!(
            app.model_names,
            vec!["deepseek:deepseek-v4-pro", "opencode-go:deepseek-v4-pro"]
        );
        let listing = app
            .entries
            .iter()
            .find_map(|entry| match entry {
                ConversationEntry::System { content, .. } if content.contains("Models:") => {
                    Some(content.clone())
                }
                _ => None,
            })
            .expect("`:model` prints the model list");
        assert!(listing.contains("deepseek:deepseek-v4-pro"), "{listing}");
        assert!(listing.contains("opencode-go:deepseek-v4-pro"), "{listing}");
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
                        "budget_tokens": 2048,
                        "max_output_tokens": 4096,
                        "cache_ttl": "1h"
                    },
                    "scopes": {
                        "temperature": "character_model",
                        "top_p": "static_default",
                        "reasoning_effort": "static_default",
                        "budget_tokens": "static_default",
                        "max_output_tokens": "static_default",
                        "cache_ttl": "static_default"
                    }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(
            app.completion
                .candidates
                .contains(&"temperature = 0.7".into())
        );
        assert_eq!(app.completion.selected, Some(0));
    }

    #[test]
    fn model_settings_error_refreshes_open_setting_submenu() {
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
                rid: Some(rid),
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
        assert!(
            app.completion
                .candidates
                .contains(&"temperature = 0.7".into())
        );
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
    fn pending_model_settings_response_is_trusted_even_for_drifted_model_label() {
        let mut app = App::default();
        app.set_active_model(Some("chat.test.current"));
        let rid = app.begin_sampler_settings_refresh();

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
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
        assert_eq!(
            app.effective_sampler
                .as_ref()
                .and_then(|snapshot| snapshot.display_value("temperature")),
            Some("0.7")
        );
        assert!(app.is_active_model_candidate("chat.test.previous"));
    }

    #[test]
    fn pending_model_settings_response_adopts_daemons_current_model() {
        let mut app = App::default();
        app.set_active_model(Some("chat.test.current"));
        app.effective_sampler = Some(EffectiveSamplerSnapshot {
            model: Some("chat.test.current".into()),
            temperature: crate::app::EffectiveSamplerField {
                value: Some("0.5".into()),
                scope: Some("character_model".into()),
            },
            ..EffectiveSamplerSnapshot::default()
        });
        let rid = app.begin_sampler_settings_refresh();

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "model_settings".into(),
                data: serde_json::json!({
                    "model": "chat.test.other",
                    "effective_sampler": { "temperature": 0.9 },
                    "scopes": { "temperature": "character_model" }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert_eq!(
            app.effective_sampler
                .as_ref()
                .and_then(|snapshot| snapshot.display_value("temperature")),
            Some("0.9"),
            "a matching-rid response is authoritative for the daemon's active model"
        );
    }

    #[test]
    fn orphaned_model_settings_response_does_not_wipe_effective_sampler() {
        let mut app = App::default();
        app.set_active_model(Some("chat.test.current"));
        app.effective_sampler = Some(EffectiveSamplerSnapshot {
            model: Some("chat.test.current".into()),
            temperature: crate::app::EffectiveSamplerField {
                value: Some("0.5".into()),
                scope: Some("character_model".into()),
            },
            ..EffectiveSamplerSnapshot::default()
        });

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some("tui_sampler_settings_999".into()),
                name: "model_settings".into(),
                data: serde_json::json!({
                    "model": "chat.test.previous",
                    "effective_sampler": { "temperature": 0.9 },
                    "scopes": { "temperature": "character_model" }
                }),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert_eq!(
            app.effective_sampler
                .as_ref()
                .and_then(|snapshot| snapshot.display_value("temperature")),
            Some("0.5"),
            "orphaned response must not overwrite or wipe the snapshot"
        );
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
        assert!(
            app.notifications
                .iter()
                .any(|n| n.content == "setting temperature updated")
        );
    }

    #[test]
    fn final_stream_end_requests_full_redraw() {
        let mut app = App::default();
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
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
                subagent: None,
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
                subagent: None,
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
        app.entries.push(ConversationEntry::assistant(
            Some("m_target".into()),
            "target".into(),
            vec![],
            "t1".into(),
            None,
        ));
        app.entries.push(ConversationEntry::assistant(
            Some("m_later".into()),
            "later".into(),
            vec![],
            "t2".into(),
            None,
        ));

        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
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
            .filter_map(ConversationEntry::as_turn)
            .find(|t| t.msg_id.as_deref() == Some("m_target"))
            .and_then(|t| t.metadata.as_ref())
            .expect("target assistant metadata");
        assert_eq!(target.model, target_meta.model);

        let later_metadata = app
            .entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .find(|t| t.msg_id.as_deref() == Some("m_later"))
            .map(|t| &t.metadata);
        assert!(matches!(later_metadata, Some(None)));
    }

    #[test]
    fn final_stream_end_with_unmatched_msg_id_does_not_annotate_latest_assistant() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::assistant(
            Some("m_existing".into()),
            "existing".into(),
            vec![],
            "t1".into(),
            None,
        ));

        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                rid: None,
                msg_id: Some("m_missing_from_history".into()),
                revision: Some(8),
                content: "new response".into(),
                metadata: metadata(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let existing_metadata = app
            .entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .find(|t| t.msg_id.as_deref() == Some("m_existing"))
            .map(|t| &t.metadata);
        assert!(matches!(existing_metadata, Some(None)));
        assert!(
            app.entries
                .iter()
                .filter_map(ConversationEntry::as_turn)
                .any(|t| {
                    t.msg_id.as_deref() == Some("m_missing_from_history") && t.metadata.is_some()
                })
        );
    }
}
