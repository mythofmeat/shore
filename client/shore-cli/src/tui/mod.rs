mod ansi;
mod app;
mod clipboard;
mod command_output;
mod connection;
mod draft;
mod images;
mod input;
mod keymap;
mod markdown;
mod ui;

use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

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
    AltChoice, App, Block, COMPACTION_SUBAGENT, CompactionRun, ConnectionStatus, ConversationEntry,
    EffectiveSamplerSnapshot, InputState, SubagentSection, Turn, TurnState, UsageDisplay,
    UsageLevel, UsageScope, compaction_round_from_phase,
};
use connection::{ConnCommand, ConnEvent};
use input::Action;

const STREAM_FRAME_INTERVAL: Duration = Duration::from_millis(200);
const INPUT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const DRAFT_AUTOSAVE_INTERVAL: Duration = Duration::from_secs(3);
const EDITOR_FENCE: &str = "# ------------------------ >8 ------------------------";
const EDITOR_FENCE_NOTE: &str =
    "# Last assistant reply. Everything below is removed when you close the editor.";
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

pub(crate) async fn run(
    addr: Option<String>,
    character: Option<String>,
    thread: Option<String>,
) -> io::Result<std::process::ExitCode> {
    let debug = TuiDebugConfig::from_env()?;

    #[expect(
        clippy::print_stdout,
        reason = "the debug render mode exists to print one frame to stdout"
    )]
    if let Some((width, height)) = debug.render_size {
        let mut app = debug.build_app()?;
        let frame = render_app_to_string(&mut app, width, height)?;
        print!("{frame}");
        return Ok(std::process::ExitCode::SUCCESS);
    }

    if !debug.fixture_enabled() {
        init_logging()?;
    }

    run_tui(addr, character, thread, debug).await
}

fn init_logging() -> io::Result<()> {
    let log_dir = shore_common::dirs::runtime_dir();
    std::fs::create_dir_all(&log_dir)?;
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("tui.log"))?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(true)
        .with_ansi(false)
        .with_writer(std::sync::Mutex::new(log_file))
        .init();
    Ok(())
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
                    .unwrap_or_else(|| "Fixture".to_owned()),
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
                    msg_id: None,
                    content: content.clone(),
                    count: 1,
                    timestamp,
                }),
            }
        }

        app.scroll_offset = usize::from(self.scroll_offset);
        app.auto_scroll = self.scroll_offset == 0;
        Ok(app)
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
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
        Some(raw_value) => raw_value
            .parse::<usize>()
            .map_err(|_| {
                invalid_env_value(
                    name,
                    format!("expected positive integer; got {raw_value:?}"),
                )
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
        Some(raw_value) => raw_value
            .parse::<u16>()
            .map_err(|_| invalid_env_value(name, format!("expected integer; got {raw_value:?}"))),
        None => Ok(default),
    }
}

fn parse_render_size(name: &str, value: &str) -> io::Result<(u16, u16)> {
    let normalized = value.trim().replace('X', "x");
    let (width_text, height_text) = normalized
        .split_once('x')
        .ok_or_else(|| invalid_env_value(name, format!("expected WIDTHxHEIGHT; got {value:?}")))?;
    let width = width_text
        .parse::<u16>()
        .map_err(|_| invalid_env_value(name, "width must be an integer"))?;
    let height = height_text
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
            "=== shore frame {} ({}x{}) ===",
            self.next_frame, width, height
        )?;
        file.write_all(frame.as_bytes())?;
        if !frame.ends_with('\n') {
            writeln!(file)?;
        }
        self.next_frame = self.next_frame.saturating_add(1);
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

fn prefs_path() -> PathBuf {
    shore_common::dirs::data_dir().join("tui_prefs.json")
}

fn legacy_prefs_paths() -> [PathBuf; 2] {
    [
        shore_common::dirs::config_dir().join("tui_prefs.json"),
        shore_common::dirs::runtime_dir().join("tui_prefs.json"),
    ]
}

fn migrate_prefs(current: &Path, legacy: &[PathBuf]) -> Option<String> {
    for old in legacy {
        let Ok(data) = std::fs::read_to_string(old) else {
            continue;
        };
        if write_prefs_file(current, &data).is_ok()
            && let Err(e) = std::fs::remove_file(old)
        {
            warn!("kept {} after migrating it: {e}", old.display());
        }
        return Some(data);
    }
    None
}

fn load_keymap(app: &mut App) {
    app.keymap = keymap::Keymap::load();
    for warning in app.keymap.warnings.clone() {
        app.set_error(warning);
    }
}

fn load_prefs(app: &mut App) {
    let path = prefs_path();
    let prefs_data = std::fs::read_to_string(&path)
        .ok()
        .or_else(|| migrate_prefs(&path, &legacy_prefs_paths()));
    if let Some(data) = prefs_data
        && let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&data)
    {
        if let Some(b) = prefs
            .get("show_thinking")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_thinking = b;
        }
        if let Some(b) = prefs.get("show_tools").and_then(serde_json::Value::as_bool) {
            app.show_tools = b;
        }
        if let Some(b) = prefs
            .get("show_subagent")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_subagent = b;
        }
        if let Some(b) = prefs
            .get("show_compaction")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_compaction = b;
        }
        if let Some(b) = prefs
            .get("show_images")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_images = b;
        }
        if let Some(b) = prefs
            .get("show_timestamps")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_timestamps = b;
        }
        if let Some(b) = prefs
            .get("show_metadata")
            .and_then(serde_json::Value::as_bool)
        {
            app.show_metadata = b;
        }
        if let Some(mode) = prefs
            .get("usage_display")
            .and_then(serde_json::Value::as_str)
            .and_then(UsageDisplay::from_token)
        {
            app.usage_display = mode;
        } else if let Some(b) = prefs.get("show_usage").and_then(serde_json::Value::as_bool) {
            app.usage_display = if b {
                UsageDisplay::Always
            } else {
                UsageDisplay::Off
            };
        } else {
        }
        if let Some(focus) = prefs
            .get("budget_focus")
            .and_then(serde_json::Value::as_str)
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
        "show_compaction": app.show_compaction,
        "show_images": app.show_images,
        "show_timestamps": app.show_timestamps,
        "show_metadata": app.show_metadata,
        "usage_display": app.usage_display.as_str(),
        "budget_focus": app.budget_focus.as_token(),
    });
    if let Err(e) = write_prefs_file(&prefs_path(), &v.to_string()) {
        warn!("failed to persist prefs: {e}");
    }
}

fn write_prefs_file(path: &Path, body: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        drop(std::fs::remove_file(&tmp));
    })
}

fn force_full_redraw(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> io::Result<()> {
    let area = terminal.size()?.into();
    terminal.resize(area)
}

fn editor_buffer(input: &str, last_reply: Option<&str>) -> String {
    let Some(reply) = last_reply else {
        return input.to_owned();
    };
    let head = if input.is_empty() {
        String::new()
    } else {
        format!("{input}\n")
    };
    format!(
        "{head}\n{EDITOR_FENCE}\n{EDITOR_FENCE_NOTE}\n\n{}\n",
        reply.trim_end_matches('\n')
    )
}

fn strip_editor_fence(contents: &str) -> String {
    let mut kept = String::new();
    for line in contents.split_inclusive('\n') {
        if line.trim_end() == EDITOR_FENCE {
            break;
        }
        kept.push_str(line);
    }
    kept.trim_end_matches('\n').to_owned()
}

fn with_cooked_terminal<T, F: FnOnce() -> io::Result<T>>(operation: F) -> io::Result<T> {
    let result = (|| {
        execute!(io::stdout(), DisableBracketedPaste, EnableLineWrap)?;
        disable_raw_mode()?;
        execute!(io::stdout(), LeaveAlternateScreen)?;
        operation()
    })();
    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        DisableLineWrap,
        EnableBracketedPaste
    )?;
    result
}

fn open_in_editor(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    input: &mut InputState,
    last_reply: Option<&str>,
) -> io::Result<()> {
    let editor = crate::run::editor_from_env();
    let sessions = draft::editor_dir(&draft::drafts_dir());
    std::fs::create_dir_all(&sessions)?;
    let tmp = draft::editor_session_path(&draft::drafts_dir(), &draft::stamp_now());
    std::fs::write(&tmp, editor_buffer(input.text.as_str(), last_reply))?;

    let (program, args) = crate::run::editor_invocation(&editor, &tmp);
    with_cooked_terminal(|| {
        let _status = std::process::Command::new(program).args(args).status()?;
        Ok(())
    })?;
    force_full_redraw(terminal)?;

    if let Ok(contents) = std::fs::read_to_string(&tmp) {
        input.set_text(strip_editor_fence(&contents));
    }
    draft::prune_editor_sessions_to_default(&draft::drafts_dir());
    Ok(())
}

fn draft_snapshot(app: &App) -> draft::Draft {
    draft::Draft {
        daemon: app.draft_daemon.clone(),
        character: app.character_name.clone(),
        thread: app.thread_name.clone(),
        text: app.input.text.clone(),
        images: app.pending_images.clone(),
        editing_ref: app.editing_ref.clone(),
    }
}

fn restore_draft(app: &mut App, dir: &Path) {
    let Some(saved) = draft::load(dir, &app.request_prefix, &draft_snapshot(app)) else {
        return;
    };
    app.input.set_text(saved.text);
    app.pending_images = saved.images;
    app.editing_ref = saved.editing_ref;
    app.input.reset_history();
    app.set_status("restored the draft and attachments you left");
}

fn save_draft(app: &App, dir: &Path) {
    if let Err(e) = draft::save(
        dir,
        &app.request_prefix,
        &draft_snapshot(app),
        &app.paste_temp_paths,
    ) {
        warn!("failed to keep the unsent draft: {e}");
    }
}

fn adopt_conversation(app: &mut App, character: Option<&str>, thread: Option<&str>) {
    let next_character = character.unwrap_or(&app.character_name).to_owned();
    let next_thread = thread.unwrap_or(&app.thread_name).to_owned();
    if app.character_name == next_character && app.thread_name == next_thread {
        return;
    }
    let root = app.draft_root.clone();
    if let Some(dir) = &root {
        save_draft(app, dir);
    }
    app.retire_operations();
    app.input.set_text(String::new());
    app.input.reset_history();
    app.input.exit_command_mode();
    app.pending_images.clear();
    app.editing_ref = None;
    app.entries.clear();
    app.image_cache.clear();
    app.image_index.clear();
    app.conv_cache = app::ConvCache::default();
    app.history_version = app.history_version.wrapping_add(1);
    app.character_name = next_character;
    app.thread_name = next_thread;
    if app.persist_session && !app.character_name.is_empty() {
        persist_active_character(&app.character_name);
        let _persisted = crate::state::write_active_thread(&app.character_name, &app.thread_name);
    }
    app.scroll_offset = 0;
    app.auto_scroll = true;
    app.usage_budgets.clear();
    if let Some(dir) = &root {
        restore_draft(app, dir);
    }
}

fn pick_image(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    start_dir: Option<&str>,
) -> io::Result<Vec<String>> {
    let chooser_file = std::env::temp_dir().join("shore_image_pick");
    drop(std::fs::remove_file(&chooser_file));

    let start = start_dir.unwrap_or(".");

    let result = with_cooked_terminal(|| {
        Ok(try_yazi(&chooser_file, start).or_else(|| try_fzf(&chooser_file, start)))
    })?;
    force_full_redraw(terminal)?;

    match result {
        Some(true) => {
            if let Ok(contents) = std::fs::read_to_string(&chooser_file) {
                let paths: Vec<String> = contents
                    .lines()
                    .map(|l| l.trim().to_owned())
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

fn try_yazi(chooser_file: &Path, start: &str) -> Option<bool> {
    let status = std::process::Command::new("yazi")
        .arg(start)
        .arg("--chooser-file")
        .arg(chooser_file)
        .status()
        .ok()?;
    Some(status.success() && chooser_file.exists())
}

fn try_fzf(chooser_file: &Path, start: &str) -> Option<bool> {
    let mut find = std::process::Command::new("find")
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
        "chafa -s ${FZF_PREVIEW_COLUMNS}x${FZF_PREVIEW_LINES} {}".to_owned()
    } else if which_exists("kitty") {
        "kitty icat --clear --transfer-mode=memory --stdin=no {}".to_owned()
    } else {
        "file {}".to_owned()
    };

    let status = std::process::Command::new("fzf")
        .arg("--preview")
        .arg(&preview_cmd)
        .arg("--preview-window=right:50%")
        .stdin(find.stdout.take()?)
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
    app: &mut App,
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    cmds: Vec<ConnCommand>,
) {
    for cmd in cmds {
        send_conn_command(app, cmd_tx, cmd).await;
    }
}

fn restore_failed_send(app: &mut App, command: ConnCommand) {
    let ConnCommand::Send(client_message) = command else {
        return;
    };
    let ClientMessage::Message(message) = client_message else {
        if let ClientMessage::Regen(regen) = &client_message
            && app.stream.rid == regen.rid
        {
            app.abort_stream();
        }
        if let ClientMessage::Command(failed) = &client_message
            && app.pending_navigation == failed.rid
        {
            app.pending_navigation = None;
        }
        app.set_error("command not sent; connection unavailable");
        return;
    };

    app.abort_stream();
    if app
        .entries
        .last()
        .and_then(ConversationEntry::as_turn)
        .is_some_and(|turn| {
            turn.role == Role::User && turn.msg_id.is_none() && turn.joined_text() == message.text
        })
    {
        let _removed = app.entries.pop();
    }
    app.input.set_text(message.text);
    app.pending_images = message.images;
    app.set_error("message not sent; restored to input for retry");
}

async fn send_conn_command(
    app: &mut App,
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    mut command: ConnCommand,
) {
    if let ConnCommand::Send(message) = &mut command {
        let request_slot = match message {
            ClientMessage::Command(cmd) => Some(&mut cmd.rid),
            ClientMessage::Message(body) => Some(&mut body.rid),
            ClientMessage::Regen(regen) => Some(&mut regen.rid),
            ClientMessage::Cancel(_) | ClientMessage::Hello(_) => None,
        };
        if let Some(rid) = request_slot
            && rid.is_none()
        {
            *rid = Some(app.next_request_id("command"));
        }
    }
    if let ConnCommand::Send(ClientMessage::Command(cmd)) = &command
        && matches!(cmd.name.as_str(), "switch_thread" | "switch_character")
    {
        if let Some(previous) = app.pending_navigation.take() {
            let _ = app.retired_streams.insert(previous);
        }
        app.pending_navigation.clone_from(&cmd.rid);
    }
    if let Err(error) = cmd_tx.try_send(command) {
        prepare_for_reconnect(app);
        restore_failed_send(app, error.into_inner());
    }
}

fn model_settings_conn_command(_app: &App, rid: Option<String>) -> ConnCommand {
    ConnCommand::Send(ClientMessage::Command(Command {
        rid,
        name: "model_settings".into(),
        args: serde_json::json!({}),
    }))
}

fn subagent_trace_conn_command(ids: &[String]) -> ConnCommand {
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
    vec![subagent_trace_conn_command(&ids)]
}

fn thread_refresh_command(app: &mut App) -> ConnCommand {
    let rid = app.begin_thread_refresh();
    ConnCommand::Send(ClientMessage::Command(Command {
        rid: Some(rid),
        name: "list_threads".into(),
        args: serde_json::json!({}),
    }))
}

fn absorb_thread_listing(app: &mut App, data: &serde_json::Value) {
    app.palette_catalog.threads = named_palette_values(data, "threads");
    let Some(rows) = data.get("threads").and_then(|v| v.as_array()) else {
        return;
    };
    app.threads = rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id").and_then(serde_json::Value::as_str)?;
            Some(app::ThreadRow {
                id: id.to_owned(),
                label: row
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                model: row
                    .get("chat_model")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                home: row
                    .get("home")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                turns: row.get("turns").and_then(serde_json::Value::as_u64),
                warm: row
                    .get("warm")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    if let Some(home) = data.get("home").and_then(serde_json::Value::as_str) {
        app.home_thread = home.to_owned();
    }
    if let Some(current) = data.get("current").and_then(serde_json::Value::as_str) {
        app.thread_name = current.to_owned();
    }
}

fn thread_listing_text(app: &App) -> String {
    app.threads
        .iter()
        .map(|row| {
            let mark = if row.id == app.thread_name { "*" } else { " " };
            format!("  {mark} {}", App::thread_row_label(row))
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    send_conn_commands(app, cmd_tx, effect.cmds).await;
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

fn prepare_for_reconnect(app: &mut App) {
    app.connection_status = ConnectionStatus::Connecting;
    app.retire_operations();
    app.effective_sampler = None;
    app.sampler_settings_loading = false;
    app.pending_sampler_settings_rid = None;
    app.pending_palette_commands.clear();
    app.invalidate_palette_catalog();
    app.history_page_loading = false;
    app.pending_subagent_trace_ids.clear();
    app.usage_budgets.clear();
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
                send_conn_command(app, cmd_tx, cmd).await;
            } else {
                app.set_status("fixture mode: command ignored");
            }
            Ok(true)
        }
        Action::SendMulti(cmds) => {
            if send_enabled {
                send_conn_commands(app, cmd_tx, cmds).await;
            } else {
                app.set_status("fixture mode: command ignored");
            }
            Ok(true)
        }
        Action::OpenInEditor => {
            let last_reply = app.last_assistant_text();
            open_in_editor(terminal, &mut app.input, last_reply.as_deref())?;
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
                send_conn_commands(app, cmd_tx, cmds).await;
            }
            Ok(true)
        }
        Action::Redraw => Ok(true),
        Action::None => Ok(false),
    }
}

struct TerminalSession {
    was_raw: bool,
}

impl TerminalSession {
    fn enter() -> io::Result<Self> {
        let session = Self {
            was_raw: crossterm::terminal::is_raw_mode_enabled()?,
        };
        let was_raw = session.was_raw;
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore_terminal(was_raw);
            previous_hook(info);
        }));
        enable_raw_mode()?;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            DisableLineWrap,
            EnableBracketedPaste
        )?;
        Ok(session)
    }
}

fn restore_terminal(was_raw: bool) {
    let _paste = execute!(io::stdout(), DisableBracketedPaste);
    let _wrap = execute!(io::stdout(), EnableLineWrap);
    let _screen = execute!(io::stdout(), LeaveAlternateScreen, crossterm::cursor::Show);
    if was_raw {
        let _raw = enable_raw_mode();
    } else {
        let _raw = disable_raw_mode();
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        restore_terminal(self.was_raw);
    }
}

#[instrument(skip(debug))]
async fn run_tui(
    addr: Option<String>,
    character: Option<String>,
    thread: Option<String>,
    debug: TuiDebugConfig,
) -> io::Result<std::process::ExitCode> {
    let terminal_session = TerminalSession::enter()?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    let resolved_character = resolve_character(character);
    let resolved_thread = thread.or_else(|| {
        resolved_character
            .as_deref()
            .and_then(crate::state::read_active_thread)
    });
    let fixture_mode = debug.fixture_enabled();
    info!(character = ?resolved_character, fixture_mode, "TUI starting");

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
        load_keymap(&mut app);
        let root = draft::drafts_dir();
        app.persist_session = true;
        app.draft_daemon = addr
            .clone()
            .or_else(|| {
                shore_common::swp_client::discover_or_default(None)
                    .ok()
                    .map(|address| address.0)
            })
            .unwrap_or_default();
        app.draft_lock = Some(draft::lock_session(&root, &app.request_prefix)?);
        app.draft_root = Some(root);
    }

    let (cmd_tx, mut event_rx) = if fixture_mode {
        let (cmd_tx, _cmd_rx) = tokio::sync::mpsc::channel::<ConnCommand>(16);
        let (_event_tx, event_rx) = tokio::sync::mpsc::channel::<ConnEvent>(1);
        (cmd_tx, event_rx)
    } else {
        connection::spawn_connection(addr, resolved_character, resolved_thread)
    };

    let mut input_poll = tokio::time::interval(INPUT_POLL_INTERVAL);
    input_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut stream_frame = tokio::time::interval(STREAM_FRAME_INTERVAL);
    stream_frame.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut notif_tick = tokio::time::interval(Duration::from_millis(250));
    notif_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut draft_tick = tokio::time::interval(DRAFT_AUTOSAVE_INTERVAL);
    draft_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut saved_draft = draft_snapshot(&app);
    let mut needs_redraw = true;
    let mut deferred_stream_dirty = false;
    let mut needs_full_redraw = false;
    let mut conn_events_open = !fixture_mode;
    let mut frame_dump = debug.frame_dump_path.clone().map(FrameDump::new);

    let result = loop {
        if needs_redraw {
            if needs_full_redraw {
                force_full_redraw(&mut terminal)?;
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
                            Ok(buffered_event) => {
                                process_conn_event(
                                    &mut app,
                                    &cmd_tx,
                                    buffered_event,
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
            _ = draft_tick.tick(), if !fixture_mode => {
                let snapshot = draft_snapshot(&app);
                if saved_draft != snapshot {
                    save_draft(&app, &draft::drafts_dir());
                    saved_draft = snapshot;
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
        save_draft(&app, &draft::drafts_dir());
        drop(cmd_tx.try_send(ConnCommand::Shutdown));
    }

    for path in &app.paste_temp_paths {
        if !app
            .pending_images
            .iter()
            .any(|image| Path::new(image) == path)
        {
            drop(std::fs::remove_file(path));
        }
    }

    drop(terminal_session);

    #[expect(
        clippy::print_stderr,
        reason = "the session error summary is written to the restored terminal on exit"
    )]
    if !app.error_log.is_empty() {
        eprintln!("\n{} error(s) during this session:", app.error_log.len());
        for line in &app.error_log {
            eprintln!("  • {}", sanitize_terminal_text(line));
        }
    }

    if app.interrupt {
        result?;
        return Ok(std::process::ExitCode::from(130));
    }

    result.map(|()| std::process::ExitCode::SUCCESS)
}

fn handle_conn_event(app: &mut App, event: ConnEvent) -> UiEffect {
    match event {
        ConnEvent::Connected {
            characters,
            history,
            active_start,
            config,
            selected_character,
            selected_thread,
            ..
        } => {
            adopt_conversation(
                app,
                selected_character.as_deref(),
                selected_thread.as_deref(),
            );
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
            app.pending_palette_commands.clear();
            app.invalidate_palette_catalog();
            app.usage_budgets.clear();
            app.characters.clone_from(&characters);

            app.character_name = next_character;
            app.thread_name = selected_thread.unwrap_or_default();

            if let Some(private) = config.get("private").and_then(serde_json::Value::as_bool) {
                app.is_private = private;
            }
            app.set_active_model(config.get("active_model").and_then(|v| v.as_str()));

            rebuild_entries_from_history(app, history, active_start);
            reset_history_paging(app);
            transmit_entry_images(app);

            app.set_status("connected");
            let mut cmds = if has_selected_character {
                vec![usage_budget_conn_command(), thread_refresh_command(app)]
            } else {
                vec![]
            };
            cmds.extend(subagent_trace_fetch(app));
            UiEffect {
                cmds,
                redraw: RedrawEffect::Immediate,
            }
        }

        ConnEvent::SendFailed(message) => {
            let rid = match &message {
                ClientMessage::Message(body) => body.rid.as_deref(),
                ClientMessage::Regen(regen) => regen.rid.as_deref(),
                ClientMessage::Command(command) => command.rid.as_deref(),
                ClientMessage::Hello(_) | ClientMessage::Cancel(_) => None,
            };
            if app.stale_request(rid) {
                app.set_error("a request from the previous conversation could not be sent");
                return UiEffect::redraw(RedrawEffect::Immediate);
            }
            prepare_for_reconnect(app);
            restore_failed_send(app, ConnCommand::Send(message));
            UiEffect::redraw(RedrawEffect::Immediate)
        }

        ConnEvent::Disconnected(reason) => {
            prepare_for_reconnect(app);
            app.set_status(format!("reconnecting: {reason}"));
            UiEffect::redraw(RedrawEffect::Immediate)
        }

        ConnEvent::Message(msg) => handle_server_message(app, msg),
    }
}

fn build_history_entries(messages: Vec<Message>, active_start: usize) -> Vec<ConversationEntry> {
    let mut entries = Vec::new();
    let boundary_at = active_start.min(messages.len());
    let archived_turns = count_user_turns(messages.get(..boundary_at).unwrap_or(&messages));
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
    app.grew_above_viewport = true;
    app.history_version = app.history_version.wrapping_add(1);
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
    app.grew_above_viewport = true;

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
                Some(app.entries.len().saturating_sub(1))
            }
            Some(_) | None => None,
        });

    if let Some(turn) = target_pos.and_then(|pos| app.entries.get_mut(pos)?.as_turn_mut()) {
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
            acc.tokens.input = acc.tokens.input.saturating_add(incoming.tokens.input);
            acc.tokens.output = acc.tokens.output.saturating_add(incoming.tokens.output);
            acc.tokens.cache_read = acc
                .tokens
                .cache_read
                .saturating_add(incoming.tokens.cache_read);
            acc.tokens.cache_write = acc
                .tokens
                .cache_write
                .saturating_add(incoming.tokens.cache_write);
            acc.timing.total_ms = acc.timing.total_ms.saturating_add(incoming.timing.total_ms);
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
    app.pending_history_page = None;
    app.history_next_before = None;
    app.history_has_more_before = true;
    app.history_page_loading = false;
}

fn prepend_history_page(app: &mut App, data: &serde_json::Value) {
    app.history_page_loading = false;
    app.history_next_before = data
        .get("next_before")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
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
        if let Some(ConversationEntry::ArchiveBoundary { archived_count }) =
            app.entries.get_mut(boundary_idx)
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
            let Some(Block::ToolUse {
                tool_id, tool_name, ..
            }) = turn.blocks.get(i)
            else {
                i = i.saturating_add(1);
                continue;
            };
            if !tool_name.starts_with("ask_") {
                i = i.saturating_add(1);
                continue;
            }
            if matches!(
                turn.blocks.get(i.saturating_add(1)),
                Some(Block::SubagentBegin(_))
            ) {
                i = i.saturating_add(1);
                continue;
            }
            let Some(Some(section)) = traces.get(tool_id.as_str()) else {
                i = i.saturating_add(1);
                continue;
            };

            let mut nested = Vec::with_capacity(section.blocks.len().saturating_add(2));
            nested.push(Block::SubagentBegin(section.name.clone()));
            nested.extend(section.blocks.iter().cloned());
            nested.push(Block::SubagentEnd(section.name.clone()));
            let inserted = nested.len();
            let insert_at = i.saturating_add(1);
            drop(turn.blocks.splice(insert_at..insert_at, nested));
            i = i.saturating_add(inserted).saturating_add(1);
        }
    }
}

fn tool_name_map(blocks: &[ContentBlock]) -> std::collections::HashMap<&str, &str> {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, name, .. } => Some((id.as_str(), name.as_str())),
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
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

fn editable_text(msg: &Message) -> String {
    if msg.content_blocks.is_empty() {
        return msg.content.clone();
    }
    msg.content_blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .collect::<Vec<&str>>()
        .join("\n")
}

fn restore_unpersisted_user_draft(app: &mut App) -> bool {
    if !app.input.text.is_empty() || !app.pending_images.is_empty() {
        return false;
    }
    let is_unpersisted_user = matches!(
        app.entries.last(),
        Some(ConversationEntry::Turn(Turn {
            role: Role::User,
            msg_id: None,
            state: TurnState::Complete,
            ..
        }))
    );
    if !is_unpersisted_user {
        return false;
    }
    let Some(ConversationEntry::Turn(turn)) = app.entries.pop() else {
        return false;
    };
    app.input.set_text(turn.joined_text());
    app.pending_images = turn.images.into_iter().map(|image| image.path).collect();
    true
}

fn expand_msg(msg: Message, entries: &mut Vec<ConversationEntry>) {
    if msg.role == Role::System {
        entries.push(ConversationEntry::System {
            msg_id: Some(msg.msg_id),
            content: msg.content,
            count: 1,
            timestamp: msg.timestamp,
        });
        return;
    }

    if msg.content_blocks.is_empty() {
        let msg_id = Some(msg.msg_id);
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
    let max_cols = w
        .saturating_mul(80)
        .checked_div(100)
        .unwrap_or(1)
        .saturating_sub(4)
        .max(1);
    let max_rows = h.saturating_mul(50).checked_div(100).unwrap_or(1).max(1);
    (max_cols, max_rows)
}

fn transmit_entry_images(app: &mut App) {
    transmit_entry_images_from(app, 0);
}

fn transmit_entry_images_from(app: &mut App, start: usize) {
    let (max_cols, max_rows) = image_max_cells();
    for entry in app.entries.iter().skip(start) {
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
        return Some(qualified.to_owned());
    }
    let provider_name = model.get("provider").and_then(|value| value.as_str());
    let model_identifier = model.get("model_id").and_then(|value| value.as_str());
    if let (Some(provider), Some(model_id)) = (provider_name, model_identifier) {
        return Some(format!("{provider}:{model_id}"));
    }
    model
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

fn favorite_model_names(models: &[serde_json::Value]) -> Vec<String> {
    models
        .iter()
        .filter(|model| {
            model
                .get("favorite")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(model_switch_name)
        .collect()
}

fn subscription_model_names(models: &[serde_json::Value]) -> Vec<String> {
    models
        .iter()
        .filter(|model| {
            model
                .get("subscription_included")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(model_switch_name)
        .collect()
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

fn untagged_task_key(name: &str) -> String {
    format!("subagent:{name}")
}

fn query_of(input: &serde_json::Value) -> String {
    input
        .get("query")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn route_subagent_task_frame(app: &mut App, msg: ServerMessage) -> UiEffect {
    let name = msg.subagent().map(str::to_owned);
    let Some(task_id) = msg
        .task_id()
        .map(str::to_owned)
        .or_else(|| name.as_deref().map(untagged_task_key))
    else {
        return UiEffect::redraw(RedrawEffect::None);
    };
    let idx = app.subagent_task_index(&task_id, name.as_deref());
    if let Some(task) = app.subagent_tasks.get_mut(idx) {
        task.parent_request_id = msg.request_id().map(str::to_owned);
    }

    match msg {
        ServerMessage::StreamChunk(chunk) => {
            if chunk.content_type == "thinking" {
                app.subagent_task_append_thinking(idx, &chunk.text);
            } else {
                app.subagent_task_append_text(idx, &chunk.text);
            }
        }
        ServerMessage::ToolCall(tc) => {
            app.subagent_task_push_block(
                idx,
                Block::ToolUse {
                    tool_id: tc.tool_id,
                    tool_name: tc.tool_name,
                    input: tc.input,
                },
            );
        }
        ServerMessage::ToolResult(tr) => {
            app.subagent_task_push_block(
                idx,
                Block::ToolResult {
                    tool_id: tr.tool_id,
                    tool_name: tr.tool_name,
                    output: tr.output,
                    is_error: tr.is_error,
                },
            );
        }
        ServerMessage::Hello(_)
        | ServerMessage::History(_)
        | ServerMessage::Shutdown(_)
        | ServerMessage::Ping(_)
        | ServerMessage::CommandOutput(_)
        | ServerMessage::Error(_)
        | ServerMessage::StreamStart(_)
        | ServerMessage::StreamEnd(_)
        | ServerMessage::Phase(_)
        | ServerMessage::NewMessage(_)
        | ServerMessage::SendImage(_)
        | ServerMessage::CacheWarning(_)
        | ServerMessage::ProviderWarning(_)
        | ServerMessage::ProviderFallbackWarning(_)
        | ServerMessage::UsageWarning(_)
        | ServerMessage::ConfigWarning(_)
        | ServerMessage::Unknown => {}
    }

    UiEffect::redraw(if app.subagent_panel == Some(idx) {
        RedrawEffect::Immediate
    } else {
        RedrawEffect::None
    })
}

fn named_palette_values(data: &serde_json::Value, array: &str) -> Vec<crate::cli::PaletteValue> {
    data.get(array)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let value = item
                .as_str()
                .or_else(|| item.get("name").and_then(serde_json::Value::as_str))
                .or_else(|| item.get("id").and_then(serde_json::Value::as_str))
                .or_else(|| item.get("tool").and_then(serde_json::Value::as_str))?;
            let help = item
                .get("description")
                .and_then(serde_json::Value::as_str)
                .or_else(|| item.get("type").and_then(serde_json::Value::as_str))
                .map(str::to_owned);
            Some(crate::cli::PaletteValue {
                value: value.to_owned(),
                help,
            })
        })
        .collect()
}

fn absorb_palette_catalog(app: &mut App, kind: &str, data: &serde_json::Value) {
    match kind {
        "threads" => absorb_thread_listing(app, data),
        "models" => {
            if data.get("models").is_some_and(serde_json::Value::is_object) {
                let models = crate::output::models_by_provider(data);
                app.model_names = models.iter().filter_map(model_switch_name).collect();
                app.favorite_model_names = favorite_model_names(&models);
                app.subscription_model_names = subscription_model_names(&models);
            }
        }
        "providers" => {
            app.palette_catalog.providers = named_palette_values(data, "providers");
        }
        "status" => {
            app.palette_catalog.status_sections = data
                .get("sections")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(crate::cli::PaletteValue::plain)
                .collect();
        }
        "tools" => {
            let mut tools = named_palette_values(data, "tools");
            tools.extend(named_palette_values(data, "mcp"));
            tools.extend(
                named_palette_values(data, "subagents")
                    .into_iter()
                    .map(|value| crate::cli::PaletteValue {
                        value: format!("ask_{}", value.value),
                        help: value.help,
                    }),
            );
            tools.sort_by(|left, right| left.value.cmp(&right.value));
            tools.dedup_by(|left, right| left.value == right.value);
            app.palette_catalog.tools = tools;
            app.palette_catalog.subagents = named_palette_values(data, "subagents");
        }
        "config" => {
            app.palette_catalog.config_schema = Some(data.clone());
            let entries = data
                .get("schema")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten();
            let mut sections = Vec::new();
            let mut keys = Vec::new();
            for entry in entries {
                let Some(key) = entry.get("key").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let setting_kind = entry
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("value");
                let restart = entry
                    .get("restart_required")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let help = if restart {
                    format!("{setting_kind}; daemon restart required")
                } else {
                    setting_kind.to_owned()
                };
                let value = crate::cli::PaletteValue {
                    value: key.to_owned(),
                    help: Some(help),
                };
                sections.push(value.clone());
                if entry
                    .get("settable")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    keys.push(value);
                }
            }
            app.palette_catalog.config_sections = sections;
            app.palette_catalog.config_keys = keys;
        }
        "settings" => {
            if let Some(snapshot) = EffectiveSamplerSnapshot::from_model_settings(data) {
                app.note_active_model_from_snapshot(&snapshot);
                app.effective_sampler = Some(snapshot);
            }
        }
        _ => {}
    }
    if app.input.mode == app::InputMode::Command {
        app.update_completions();
    }
}

fn is_compaction_frame(msg: &ServerMessage) -> bool {
    if msg.subagent() == Some(COMPACTION_SUBAGENT) {
        return true;
    }
    match msg {
        ServerMessage::Phase(phase) => compaction_round_from_phase(&phase.phase).is_some(),
        ServerMessage::Hello(_)
        | ServerMessage::History(_)
        | ServerMessage::Shutdown(_)
        | ServerMessage::Ping(_)
        | ServerMessage::CommandOutput(_)
        | ServerMessage::Error(_)
        | ServerMessage::StreamStart(_)
        | ServerMessage::StreamChunk(_)
        | ServerMessage::StreamEnd(_)
        | ServerMessage::NewMessage(_)
        | ServerMessage::ToolCall(_)
        | ServerMessage::ToolResult(_)
        | ServerMessage::SendImage(_)
        | ServerMessage::CacheWarning(_)
        | ServerMessage::ProviderWarning(_)
        | ServerMessage::ProviderFallbackWarning(_)
        | ServerMessage::UsageWarning(_)
        | ServerMessage::ConfigWarning(_)
        | ServerMessage::Unknown => false,
    }
}

fn route_compaction_frame(app: &mut App, msg: ServerMessage) -> UiEffect {
    let run = app.compaction.get_or_insert_with(CompactionRun::default);

    match msg {
        ServerMessage::Phase(phase) => {
            if let Some(round) = compaction_round_from_phase(&phase.phase) {
                run.note_round(round);
            }
        }
        ServerMessage::StreamChunk(chunk) => {
            if chunk.content_type == "thinking" {
                run.append_thinking(&chunk.text);
            } else {
                run.append_text(&chunk.text);
            }
        }
        ServerMessage::StreamEnd(_) => {
            run.flush_text();
            run.flush_thinking();
        }
        ServerMessage::ToolCall(tc) => {
            run.push_block(Block::ToolUse {
                tool_id: tc.tool_id,
                tool_name: tc.tool_name,
                input: tc.input,
            });
        }
        ServerMessage::ToolResult(tr) => {
            run.push_block(Block::ToolResult {
                tool_id: tr.tool_id,
                tool_name: tr.tool_name,
                output: tr.output,
                is_error: tr.is_error,
            });
        }
        ServerMessage::Hello(_)
        | ServerMessage::History(_)
        | ServerMessage::Shutdown(_)
        | ServerMessage::Ping(_)
        | ServerMessage::CommandOutput(_)
        | ServerMessage::Error(_)
        | ServerMessage::StreamStart(_)
        | ServerMessage::NewMessage(_)
        | ServerMessage::SendImage(_)
        | ServerMessage::CacheWarning(_)
        | ServerMessage::ProviderWarning(_)
        | ServerMessage::ProviderFallbackWarning(_)
        | ServerMessage::UsageWarning(_)
        | ServerMessage::ConfigWarning(_)
        | ServerMessage::Unknown => {}
    }

    if app.auto_scroll {
        app.scroll_to_bottom();
    }
    UiEffect::redraw(RedrawEffect::DeferredStream)
}

pub(crate) fn handle_server_message(app: &mut App, msg: ServerMessage) -> UiEffect {
    let navigation_response = app
        .pending_navigation
        .as_deref()
        .is_some_and(|rid| Some(rid) == msg.request_id());
    if !navigation_response && app.stale_request(msg.request_id()) {
        return UiEffect::redraw(RedrawEffect::None);
    }
    if app.pending_navigation.is_some()
        && matches!(msg, ServerMessage::History(_))
        && !navigation_response
    {
        return UiEffect::redraw(RedrawEffect::None);
    }
    if navigation_response
        && matches!(
            msg,
            ServerMessage::CommandOutput(_) | ServerMessage::Error(_)
        )
    {
        app.pending_navigation = None;
    }
    if is_compaction_frame(&msg) {
        return route_compaction_frame(app, msg);
    }
    if msg.task_id().is_some() || msg.subagent().is_some() {
        let known_task = app
            .subagent_tasks
            .iter()
            .find(|task| Some(task.task_id.as_str()) == msg.task_id());
        let expected = known_task.map_or(app.stream.rid.as_deref(), |task| {
            task.parent_request_id.as_deref()
        });
        if expected != msg.request_id() {
            return UiEffect::redraw(RedrawEffect::None);
        }
        return route_subagent_task_frame(app, msg);
    }
    let stream_frame = matches!(
        msg,
        ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::Phase(_)
    );
    if stream_frame || matches!(msg, ServerMessage::StreamStart(_)) {
        if app.stream.active {
            if app.stream.rid.as_deref() != msg.request_id() {
                return UiEffect::redraw(RedrawEffect::None);
            }
        } else {
            if stream_frame {
                return UiEffect::redraw(RedrawEffect::None);
            }
        }
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
                app.stream.phase = "responding".into();
                app.stream.tool_name = None;
            }
            app.stream.rid.clone_from(&start.rid);
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
            if end.finish_reason == "cancelled" {
                app.abort_stream();
                app.set_status("generation cancelled");
                return UiEffect::redraw(RedrawEffect::ImmediateFull);
            }

            let keep_bottom = app.auto_scroll;
            app.history_version = app.history_version.wrapping_add(1);
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

            match target_pos.and_then(|pos| app.entries.get_mut(pos)?.as_turn_mut()) {
                Some(turn) => {
                    accumulate_metadata(&mut turn.metadata, &end.metadata);
                    if turn.msg_id.is_none() {
                        turn.msg_id.clone_from(&end.msg_id);
                    }
                    if final_phase {
                        if let Some(terminal) = &end.terminal_content_blocks {
                            let tool_names = tool_name_map(terminal);
                            let authoritative = blocks_from_content(terminal, &tool_names);
                            let replace_from = turn
                                .blocks
                                .iter()
                                .rposition(|block| matches!(block, Block::ToolResult { .. }))
                                .map_or(0, |position| position.saturating_add(1));
                            turn.blocks.truncate(replace_from);
                            turn.blocks.extend(authoritative);
                        } else {
                            if !end.content.is_empty()
                                && !turn.blocks.iter().any(|b| matches!(b, Block::Text(_)))
                            {
                                turn.blocks.push(Block::Text(end.content.clone()));
                            }
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
            if let Some(name) = tc.tool_name.strip_prefix("ask_") {
                app.begin_subagent_task(&tc.tool_id, name, query_of(&tc.input));
            }
            app.stream_push_tool_call(tc.tool_id, tc.tool_name, tc.input);
            if app.auto_scroll {
                app.scroll_to_bottom();
            }
            RedrawEffect::Immediate
        }

        ServerMessage::ToolResult(tr) => {
            app.stream.tool_name = None;
            app.settle_subagent_task(&tr.tool_id, &tr.output, tr.is_error);
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
            if co.name == "compact" {
                app.compaction = None;
            }
            if let Some(kind) = app.take_palette_catalog_request(co.rid.as_deref()) {
                absorb_palette_catalog(app, &kind, &co.data);
                return UiEffect::redraw(RedrawEffect::Immediate);
            }
            let palette_command = app.take_palette_command(co.rid.as_deref());
            if co.name == "config_reload"
                && co.data.get("applied").is_none()
                && let Some((command_text, yes)) = palette_command.as_deref().and_then(|text| {
                    let parsed = crate::cli::parse_palette_command(text).ok()?;
                    let crate::cli::CliCommand::Config {
                        subcommand: Some(crate::cli::ConfigCommand::Reload { yes, .. }),
                        ..
                    } = parsed
                    else {
                        return None;
                    };
                    Some((text.to_owned(), yes))
                })
            {
                let changed = co
                    .data
                    .get("changed_prompt_files")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>();
                if !changed.is_empty() && !yes {
                    app.set_warning(format!(
                        "System prompt files changed: {}. Config reloaded without activating them; review them, then run `:config reload --yes`.",
                        changed.join(", ")
                    ));
                }
                let rid = app.begin_palette_command(&command_text);
                return UiEffect {
                    cmds: vec![ConnCommand::Send(ClientMessage::Command(Command {
                        rid: Some(rid),
                        name: "config_reload".into(),
                        args: serde_json::json!({
                            "apply": true,
                            "refresh_prompts": yes && !changed.is_empty()
                        }),
                    }))],
                    redraw: RedrawEffect::Immediate,
                };
            }
            let palette_rendered = palette_command.as_deref().and_then(|command| {
                command_output::render(command, &co.name, &co.data, &app.character_name)
            });
            let palette_log_is_display = palette_command
                .as_deref()
                .and_then(|command| crate::cli::parse_palette_command(command).ok())
                .is_some_and(|command| {
                    matches!(
                        command,
                        crate::cli::CliCommand::Log { json: true, .. }
                            | crate::cli::CliCommand::Log { content: true, .. }
                    )
                });
            let palette_character_json = palette_command
                .as_deref()
                .and_then(|command| crate::cli::parse_palette_command(command).ok())
                .is_some_and(|command| {
                    matches!(
                        command,
                        crate::cli::CliCommand::Character { json: true, .. }
                    )
                });
            if co.name == "log" && palette_log_is_display {
                if let (Some(command), Some(rendered)) = (palette_command, palette_rendered) {
                    app.push_command_text(&command, rendered);
                }
                return UiEffect::redraw(RedrawEffect::Immediate);
            }
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
                            .and_then(|value| usize::try_from(value).ok())
                            .unwrap_or_default();
                        rebuild_entries_from_history(app, history, active_start);
                        app.history_next_before = co
                            .data
                            .get("next_before")
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|value| usize::try_from(value).ok());
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
                    if app.pending_history_page.as_deref() != co.rid.as_deref()
                        || app.pending_history_page.is_none()
                    {
                        return UiEffect::redraw(RedrawEffect::None);
                    }
                    app.pending_history_page = None;
                    prepend_history_page(app, &co.data);
                    return UiEffect {
                        cmds: subagent_trace_fetch(app),
                        redraw: RedrawEffect::Immediate,
                    };
                }
                "subagent_trace" => {
                    absorb_subagent_traces(app, &co.data);
                    if let (Some(command), Some(rendered)) = (palette_command, palette_rendered) {
                        app.push_command_text(&command, rendered);
                    }
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

                        if !palette_character_json {
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
                                msg_id: None,
                                content: format!("Characters:\n{list}"),
                                count: 1,
                                timestamp: String::new(),
                            });
                            if app.auto_scroll {
                                app.scroll_to_bottom();
                            }
                        }
                    }
                }
                "list_threads" => {
                    let quiet = app.take_thread_refresh(co.rid.as_deref());
                    absorb_thread_listing(app, &co.data);
                    if quiet {
                        return UiEffect::redraw(RedrawEffect::Immediate);
                    }
                    if app.is_submenu_open("thread") {
                        app.update_completions();
                        return UiEffect::redraw(RedrawEffect::Immediate);
                    }
                    if !palette_character_json {
                        app.entries.push(ConversationEntry::System {
                            msg_id: None,
                            content: format!("Threads:\n{}", thread_listing_text(app)),
                            count: 1,
                            timestamp: String::new(),
                        });
                        if app.auto_scroll {
                            app.scroll_to_bottom();
                        }
                    }
                }
                "create_thread" | "archive_thread" | "thread_home" | "thread_label"
                | "thread_model" => {
                    absorb_thread_listing(app, &co.data);
                }
                "fork_thread" => {
                    absorb_thread_listing(app, &co.data);
                    if let Some(fork) = co.data.get("fork") {
                        let thread = fork
                            .get("thread")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        let source = fork
                            .get("source")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        let turns = fork
                            .get("turns")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0);
                        app.set_status(format!("forked {source} -> {thread} ({turns} turns)"));
                    }
                }
                "switch_thread" => {
                    let Some(name) = co
                        .data
                        .get("thread")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                    else {
                        return UiEffect::redraw(RedrawEffect::Immediate);
                    };
                    let changed =
                        co.data.get("changed").and_then(serde_json::Value::as_bool) == Some(true);
                    adopt_conversation(app, None, Some(&name));
                    if !app.character_name.is_empty() {
                        let _persisted =
                            crate::state::write_active_thread(&app.character_name, &name);
                    }
                    app.set_status(if changed {
                        format!("thread: {name}")
                    } else {
                        format!("already in {name}")
                    });
                    if changed {
                        app.subagent_traces.clear();
                        app.pending_subagent_trace_ids.clear();
                        app.effective_sampler = None;
                        return UiEffect {
                            cmds: vec![thread_refresh_command(app)],
                            redraw: RedrawEffect::Immediate,
                        };
                    }
                }
                "switch_character" => {
                    if let Some(name) = co.data.get("character").and_then(|v| v.as_str()) {
                        adopt_conversation(app, Some(name), None);
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
                "create_character" => {
                    if let Some(name) = co
                        .data
                        .get("character")
                        .or_else(|| co.data.get("name"))
                        .and_then(serde_json::Value::as_str)
                        && !app.characters.iter().any(|known| known.name == name)
                    {
                        app.characters
                            .push(shore_common::protocol::types::CharacterInfo::new(name));
                    }
                }
                "list_models" => {
                    if co
                        .data
                        .get("models")
                        .is_some_and(serde_json::Value::is_object)
                    {
                        let models = crate::output::models_by_provider(&co.data);
                        app.model_names = models.iter().filter_map(model_switch_name).collect();
                        app.favorite_model_names = favorite_model_names(&models);
                        app.subscription_model_names = subscription_model_names(&models);
                        let active = co
                            .data
                            .get("active")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty());
                        if let Some(active_name) = active {
                            app.set_active_model(Some(active_name));
                        }

                        let active_for_matching = active
                            .or_else(|| (!app.model.is_empty()).then_some(app.model.as_str()));
                        if let Some(active_name) = active_for_matching {
                            let active_names: Vec<String> = models
                                .iter()
                                .filter_map(|model| active_model_candidate_name(active_name, model))
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
                                        None => provider.to_owned(),
                                    };
                                    let source =
                                        m.get("source").and_then(|v| v.as_str()).unwrap_or("");
                                    let hidden = m
                                        .get("hidden")
                                        .and_then(serde_json::Value::as_bool)
                                        .unwrap_or(false);
                                    let switch_name = model_switch_name(m);
                                    let marker = if switch_name
                                        .as_deref()
                                        .is_some_and(|s| app.is_active_model_candidate(s))
                                    {
                                        "*"
                                    } else {
                                        " "
                                    };
                                    let star = if m
                                        .get("favorite")
                                        .and_then(serde_json::Value::as_bool)
                                        .unwrap_or(false)
                                    {
                                        "\u{2605}"
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
                                    format!("  {marker}{star} {n:<28}{qualified}{tag}")
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
                                msg_id: None,
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
                    let sampler_snapshot = EffectiveSamplerSnapshot::from_model_settings(&co.data);
                    let incompatible = co.data.get("effective_sampler").is_some()
                        && co.data.get("setting_schema").is_none();
                    if pending_response {
                        app.finish_sampler_settings_refresh();
                        if let Some(snapshot) = sampler_snapshot {
                            app.note_active_model_from_snapshot(&snapshot);
                            app.effective_sampler = Some(snapshot);
                        } else {
                            if incompatible {
                                app.effective_sampler = None;
                                app.set_error(
                                    "client and daemon must be upgraded together to edit model settings",
                                );
                            }
                        }
                    } else {
                        if co.rid.is_none()
                            && let Some(snapshot) = sampler_snapshot.filter(|candidate_snapshot| {
                                app.sampler_snapshot_matches_active_model(candidate_snapshot)
                            })
                        {
                            app.finish_sampler_settings_refresh();
                            app.note_active_model_from_snapshot(&snapshot);
                            app.effective_sampler = Some(snapshot);
                        }
                    }
                    if app.is_setting_palette_open() {
                        app.update_completions();
                    }
                }
                "switch_model"
                    if co
                        .data
                        .get("role")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|role| role == "chat") =>
                {
                    let active_name = co
                        .data
                        .get("active")
                        .and_then(|v| v.as_str())
                        .or_else(|| co.data.get("qualified_name").and_then(|v| v.as_str()));
                    if let Some(name) = active_name {
                        app.set_active_model(Some(name));
                        app.set_status(format!("model: {name}"));
                    }
                    app.effective_sampler = None;
                }
                "favorite_model" => {
                    if let Some(names) = co.data.get("favorites").and_then(|v| v.as_array()) {
                        app.favorite_model_names = names
                            .iter()
                            .filter_map(|v| v.as_str())
                            .map(str::to_owned)
                            .collect();
                    }
                    let name = co
                        .data
                        .get("qualified_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("model");
                    let favorite = co
                        .data
                        .get("favorite")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    let verb = if favorite { "favorited" } else { "unfavorited" };
                    app.set_status(format!("{verb} {}", crate::output::abbreviate_model(name)));
                }
                "reset_model"
                    if co
                        .data
                        .get("role")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|role| role == "chat") =>
                {
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
                    if let (Some(command), Some(rendered)) = (palette_command, palette_rendered) {
                        app.push_command_text(&command, rendered);
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
                        .map(str::to_owned);
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
                                        .and_then(|value| u32::try_from(value).ok())
                                        .unwrap_or_default(),
                                    position: item
                                        .get("position")
                                        .and_then(serde_json::Value::as_u64)
                                        .and_then(|value| u32::try_from(value).ok())
                                        .unwrap_or_default(),
                                    active: item
                                        .get("active")
                                        .and_then(serde_json::Value::as_bool)
                                        .unwrap_or(false),
                                    content: item
                                        .get("content")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_owned(),
                                    images: item
                                        .get("images")
                                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                                        .unwrap_or_default(),
                                    timestamp: item
                                        .get("timestamp")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_owned(),
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
                "get" => {
                    if let Some(msg_ref) = app.take_edit_prefill(co.rid.as_deref()) {
                        match serde_json::from_value::<Message>(co.data.clone()) {
                            Ok(message) if !message.msg_id.is_empty() => {
                                let text = editable_text(&message);
                                app.start_editing(message.msg_id, text);
                            }
                            Ok(_) => {
                                app.set_error(format!(
                                    "could not read message {msg_ref}: missing message ID"
                                ));
                            }
                            Err(e) => {
                                app.set_error(format!("could not read message {msg_ref}: {e}"));
                            }
                        }
                    }
                }
                _ => {
                    app.set_status(format!("cmd:{} completed", co.name));
                }
            }
            if let (Some(command), Some(rendered)) = (palette_command, palette_rendered) {
                app.push_command_text(&command, rendered);
            }
            RedrawEffect::Immediate
        }

        ServerMessage::Error(err) => {
            let generation_error = app.stream.active
                && match (app.stream.rid.as_deref(), err.rid.as_deref()) {
                    (Some(active), Some(received)) => active == received,
                    (None, None) => true,
                    (Some(_), None) | (None, Some(_)) => false,
                };
            let restored_draft = if generation_error {
                app.fail_stream();
                restore_unpersisted_user_draft(app)
            } else {
                false
            };
            app.compaction = None;
            if app.alt_picker.is_some() {
                app.cancel_alt_picker();
            }
            let _ = app.take_edit_prefill(err.rid.as_deref());
            let sampler_settings_error = app.sampler_settings_loading
                && app.sampler_settings_rid_matches(err.rid.as_deref());
            if sampler_settings_error {
                app.finish_sampler_settings_refresh();
            }
            let palette_command = app.take_palette_command(err.rid.as_deref());
            if app
                .take_palette_catalog_request(err.rid.as_deref())
                .is_some()
            {
                app.palette_catalog_loaded = false;
            }
            app.history_page_loading = false;
            if sampler_settings_error && app.is_setting_palette_open() {
                app.update_completions();
            }
            let context =
                palette_command.map_or_else(String::new, |command| format!(":{command}: "));
            let mut rendered = format!("{context}error: {:?} - {}", err.code, err.message);
            if restored_draft {
                rendered.push_str(
                    " Draft restored to the composer; use `:image clear` to remove its attachments.",
                );
            }
            if generation_error {
                app.set_critical_error(rendered);
            } else {
                app.set_error(rendered);
            }
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

        ServerMessage::ProviderWarning(w) => {
            app.set_warning(w.message.clone());
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
            adopt_conversation(
                app,
                hist.selected_character.as_deref(),
                hist.selected_thread.as_deref(),
            );
            if let Some(delta) = hist.delta {
                let keep_position = match delta.after.as_deref() {
                    Some(id) => app
                        .entries
                        .iter()
                        .rposition(|entry| match entry {
                            ConversationEntry::Turn(turn) => turn.msg_id.as_deref() == Some(id),
                            ConversationEntry::System { msg_id, .. } => {
                                msg_id.as_deref() == Some(id)
                            }
                            ConversationEntry::ArchiveBoundary { .. } => false,
                        })
                        .map(|index| index.saturating_add(1)),
                    None => Some(
                        app.entries
                            .iter()
                            .rposition(|entry| {
                                matches!(entry, ConversationEntry::ArchiveBoundary { .. })
                            })
                            .map_or(0, |index| index.saturating_add(1)),
                    ),
                };
                let Some(keep) = keep_position else {
                    return UiEffect {
                        cmds: vec![ConnCommand::Send(ClientMessage::Command(Command {
                            rid: None,
                            name: "switch_thread".into(),
                            args: serde_json::json!({"name": app.thread_name, "resync": true}),
                        }))],
                        redraw: RedrawEffect::None,
                    };
                };
                let mut messages = hist.messages;
                for message in &mut messages {
                    for image in &mut message.images {
                        if image.data.is_none() {
                            image.data = app
                                .entries
                                .iter()
                                .rev()
                                .filter_map(ConversationEntry::as_turn)
                                .flat_map(|turn| &turn.images)
                                .find(|old| old.path == image.path && old.data.is_some())
                                .and_then(|old| old.data.clone());
                        }
                    }
                }
                let suffix = app.entries.split_off(keep);
                let mut prefix = std::mem::replace(&mut app.entries, suffix);
                reconcile_streaming_turn(app, messages, 0);
                prefix.append(&mut app.entries);
                app.entries = prefix;
                app.history_version = app.history_version.wrapping_add(1);
                transmit_entry_images_from(app, keep);
                return UiEffect {
                    cmds: vec![],
                    redraw: RedrawEffect::Immediate,
                };
            }

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
            if let Some(thread) = hist.selected_thread {
                app.thread_name = thread;
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

        ServerMessage::Hello(_)
        | ServerMessage::Shutdown(_)
        | ServerMessage::Ping(_)
        | ServerMessage::Unknown => RedrawEffect::Immediate,
    };
    UiEffect::redraw(redraw)
}

#[cfg(test)]
mod redraw_tests {
    use super::*;
    use shore_common::protocol::error::ErrorCode;
    use shore_common::protocol::server_msg::{
        CommandOutput, Error as CommandError, History, StreamChunk, StreamEnd, StreamStart,
    };
    use shore_common::protocol::types::{StreamMetadata, TimingInfo, TokenCounts};

    #[expect(unsafe_code, reason = "env::set_var is unsafe as of edition 2024")]
    fn set_env(key: &str, value: &Path) {
        // SAFETY: the one test that touches env holds it for its whole body.
        unsafe { std::env::set_var(key, value) }
    }

    #[expect(unsafe_code, reason = "env::remove_var is unsafe as of edition 2024")]
    fn unset_env(key: &str) {
        // SAFETY: as above.
        unsafe { std::env::remove_var(key) }
    }

    #[test]
    fn a_filtered_log_recovers_from_a_missing_delta_anchor() {
        let mut app = App::default();
        let message = |id: &str, role: &str| {
            serde_json::json!({
                "msg_id": id, "role": role, "content": id, "images": [], "content_blocks": [], "timestamp": ""
            })
        };
        let history = |revision, messages, delta| {
            serde_json::from_value(serde_json::json!({
                "type": "history", "messages": messages, "selected_character": "ada",
                "selected_thread": "side", "revision": revision, "delta": delta
            }))
            .unwrap()
        };
        let initial = serde_json::json!([message("user", "user"), message("reply", "assistant")]);
        let _ = handle_server_message(&mut app, history(2, initial, serde_json::Value::Null));
        let _ = handle_server_message(
            &mut app,
            serde_json::from_value(serde_json::json!({
                "type": "command_output", "name": "log", "data": {"messages": []}
            }))
            .unwrap(),
        );
        assert!(app.entries.is_empty());

        let effect = handle_server_message(
            &mut app,
            history(
                3,
                serde_json::json!([message("reply", "assistant"), message("next", "user")]),
                serde_json::json!({"base_revision": 2, "after": "user"}),
            ),
        );
        assert_eq!(effect.cmds.len(), 1);
        let Some(ConnCommand::Send(ClientMessage::Command(command))) = effect.cmds.first() else {
            panic!("missing anchor must request a synchronization snapshot");
        };
        assert_eq!(command.name, "switch_thread");
        assert_eq!(
            command.args,
            serde_json::json!({"name": "side", "resync": true})
        );

        let _ = handle_server_message(
            &mut app,
            history(
                3,
                serde_json::json!([
                    message("user", "user"),
                    message("reply", "assistant"),
                    message("next", "user")
                ]),
                serde_json::Value::Null,
            ),
        );
        let next = handle_server_message(
            &mut app,
            history(
                4,
                serde_json::json!([message("next", "user"), message("answer", "assistant")]),
                serde_json::json!({"base_revision": 3, "after": "reply"}),
            ),
        );
        assert!(next.cmds.is_empty());
        assert_eq!(
            app.entries
                .iter()
                .filter_map(ConversationEntry::as_turn)
                .filter_map(|turn| turn.msg_id.as_deref())
                .collect::<Vec<_>>(),
            ["user", "reply", "next", "answer"]
        );
        assert_eq!(app.thread_name, "side");
    }

    #[test]
    fn a_revision_gap_disconnect_clears_stream_state_before_the_snapshot() {
        let mut app = App::default();
        let _ = handle_server_message(
            &mut app,
            serde_json::from_value(serde_json::json!({
                "type": "stream_start", "rid": "abandoned", "regen": false
            }))
            .unwrap(),
        );
        assert!(app.stream.active);
        let _ = handle_conn_event(
            &mut app,
            ConnEvent::Disconnected("history revision gap".into()),
        );
        let _ = handle_conn_event(
            &mut app,
            ConnEvent::Connected {
                server_name: "test".into(),
                characters: vec![],
                history: vec![],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("ada".into()),
                selected_thread: Some("side".into()),
            },
        );
        assert!(!app.stream.active);
        assert!(app.stream.rid.is_none());
        assert_eq!(app.thread_name, "side");
    }

    #[test]
    fn a_history_delta_replaces_only_the_suffix_and_preserves_paging() {
        let mut app = App::default();
        let message = |id: &str, role: &str| {
            serde_json::json!({
                "msg_id": id, "role": role, "content": id, "images": [], "content_blocks": [], "timestamp": ""
            })
        };
        let mut old = message("old", "assistant");
        *old.get_mut("images").unwrap() =
            serde_json::json!([{"path": "stable-image", "data": "aW1hZ2U="}]);
        let full: ServerMessage = serde_json::from_value(serde_json::json!({
            "type": "history", "messages": [message("user", "user"), old],
            "selected_character": "ada", "selected_thread": "main", "revision": 2
        }))
        .unwrap();
        let _ = handle_server_message(&mut app, full);
        app.history_has_more_before = false;
        let prefix = app
            .entries
            .first()
            .unwrap()
            .as_turn()
            .unwrap()
            .blocks
            .as_ptr();
        let mut replacement = message("new", "assistant");
        *replacement.get_mut("images").unwrap() = serde_json::json!([{"path": "stable-image"}]);
        let delta: ServerMessage = serde_json::from_value(serde_json::json!({
            "type": "history", "messages": [replacement],
            "selected_character": "ada", "selected_thread": "main", "revision": 3,
            "delta": {"base_revision": 2, "after": "user"}
        }))
        .unwrap();
        let _ = handle_server_message(&mut app, delta);
        assert_eq!(app.entries.len(), 2);
        assert_eq!(
            app.entries
                .first()
                .unwrap()
                .as_turn()
                .unwrap()
                .blocks
                .as_ptr(),
            prefix
        );
        assert_eq!(
            app.entries
                .get(1)
                .unwrap()
                .as_turn()
                .unwrap()
                .msg_id
                .as_deref(),
            Some("new")
        );
        assert_eq!(
            app.entries
                .get(1)
                .unwrap()
                .as_turn()
                .unwrap()
                .images
                .first()
                .unwrap()
                .data
                .as_deref(),
            Some("aW1hZ2U=")
        );
        assert!(!app.history_has_more_before);
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

    fn thread_listing() -> serde_json::Value {
        serde_json::json!({
            "character": "qifei",
            "home": "main",
            "current": "eval",
            "threads": [
                {"id": "main", "compaction": true, "home": true, "current": false},
                {
                    "id": "eval",
                    "label": "SDK eval",
                    "chat_model": "claude-agent:opus5",
                    "compaction": false,
                    "home": false,
                    "current": true,
                },
            ],
        })
    }

    #[test]
    fn a_thread_listing_fills_the_picker_and_says_where_home_is() {
        let mut app = App::default();

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "list_threads".into(),
                data: thread_listing(),
            }),
        );

        assert_eq!(app.home_thread, "main");
        assert_eq!(app.thread_name, "eval");
        assert_eq!(
            app.threads.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            vec!["main", "eval"]
        );
        assert_eq!(
            app.threads.get(1).and_then(|t| t.model.clone()).as_deref(),
            Some("claude-agent:opus5")
        );
        assert!(app.in_side_thread(), "eval is not home");
    }

    #[test]
    fn the_startup_roster_refresh_stays_out_of_the_transcript() {
        let mut app = App::default();
        let rid = app.begin_thread_refresh();

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "list_threads".into(),
                data: thread_listing(),
            }),
        );

        assert_eq!(app.home_thread, "main");
        assert!(
            app.entries.is_empty(),
            "a refresh nobody asked for must not print a listing",
        );
    }

    #[test]
    fn a_listing_the_user_asked_for_is_printed() {
        let mut app = App::default();

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "list_threads".into(),
                data: thread_listing(),
            }),
        );

        assert_eq!(app.entries.len(), 1, "the listing reaches the transcript");
    }

    #[test]
    fn switching_threads_is_persisted_and_refetches_the_roster() {
        let tmp = tempfile::TempDir::new().unwrap();
        set_env("SHORE_DATA_DIR", &tmp.path().join("shore"));
        let result = std::panic::catch_unwind(|| {
            let mut app = App {
                character_name: "qifei".into(),
                thread_name: "main".into(),
                ..App::default()
            };

            let effect = handle_server_message(
                &mut app,
                ServerMessage::CommandOutput(CommandOutput {
                    rid: None,
                    name: "switch_thread".into(),
                    data: serde_json::json!({
                        "character": "qifei",
                        "thread": "eval",
                        "changed": true,
                    }),
                }),
            );

            assert_eq!(app.thread_name, "eval");
            assert_eq!(
                shore_common::active_character::read_active_thread("qifei").as_deref(),
                Some("eval"),
                "the switch has to reach the file the next client reads",
            );
            assert_eq!(effect.cmds.len(), 1, "the roster is refetched");
        });
        unset_env("SHORE_DATA_DIR");
        result.unwrap();
    }

    #[test]
    fn a_switch_that_changed_nothing_asks_for_nothing() {
        let tmp = tempfile::TempDir::new().unwrap();
        set_env("SHORE_RUNTIME_DIR", &tmp.path().join("shore"));
        let result = std::panic::catch_unwind(|| {
            let mut app = App {
                character_name: "qifei".into(),
                thread_name: "eval".into(),
                ..App::default()
            };

            let effect = handle_server_message(
                &mut app,
                ServerMessage::CommandOutput(CommandOutput {
                    rid: None,
                    name: "switch_thread".into(),
                    data: serde_json::json!({
                        "character": "qifei",
                        "thread": "eval",
                        "changed": false,
                    }),
                }),
            );

            assert_eq!(app.thread_name, "eval");
            assert!(effect.cmds.is_empty());
        });
        unset_env("SHORE_RUNTIME_DIR");
        result.unwrap();
    }

    #[test]
    fn a_pushed_history_moves_the_client_to_the_thread_it_names() {
        let mut app = App {
            thread_name: "main".into(),
            ..App::default()
        };

        let _ = handle_server_message(
            &mut app,
            ServerMessage::History(History {
                delta: None,
                rid: None,
                messages: vec![],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("qifei".into()),
                selected_thread: Some("eval".into()),
                revision: 1,
            }),
        );

        assert_eq!(app.thread_name, "eval");
    }

    #[test]
    fn a_daemon_that_names_no_thread_leaves_the_client_where_it_is() {
        let mut app = App {
            thread_name: "eval".into(),
            ..App::default()
        };

        let _ = handle_server_message(
            &mut app,
            ServerMessage::History(History {
                delta: None,
                rid: None,
                messages: vec![],
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: Some("qifei".into()),
                selected_thread: None,
                revision: 1,
            }),
        );

        assert_eq!(app.thread_name, "eval");
    }

    #[test]
    fn the_editor_buffer_carries_the_last_reply_below_the_fence() {
        let buf = editor_buffer("my draft", Some("the reply\n## a heading"));
        let (above, below) = buf.split_once(EDITOR_FENCE).expect("fence is present");
        assert_eq!(above.trim_end(), "my draft");
        assert!(below.contains("the reply"));
        assert!(
            below.contains("## a heading"),
            "the reply is left as raw text"
        );
    }

    #[test]
    fn an_empty_draft_still_gets_the_reply() {
        let buf = editor_buffer("", Some("the reply"));
        assert!(buf.starts_with('\n'), "the cursor line stays empty");
        assert!(buf.contains(EDITOR_FENCE));
    }

    #[test]
    fn nothing_is_appended_without_a_previous_reply() {
        assert_eq!(editor_buffer("my draft", None), "my draft");
    }

    #[test]
    fn everything_from_the_fence_down_is_dropped() {
        let buf = editor_buffer("my draft", Some("the reply"));
        assert_eq!(strip_editor_fence(&buf), "my draft");
    }

    #[test]
    fn a_quoted_line_pulled_above_the_fence_survives() {
        let buf = editor_buffer("about this bit:", Some("line one\nline two"));
        let edited = buf.replace("about this bit:", "about this bit:\n> line two");
        assert_eq!(strip_editor_fence(&edited), "about this bit:\n> line two");
    }

    #[test]
    fn a_buffer_without_a_fence_is_kept_whole() {
        assert_eq!(
            strip_editor_fence("# my own heading\nbody\n\n"),
            "# my own heading\nbody"
        );
    }

    #[test]
    fn the_last_complete_assistant_turn_is_the_one_offered() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::assistant(
            None,
            "older reply".into(),
            Vec::new(),
            String::new(),
            None,
        ));
        app.entries.push(ConversationEntry::user(
            "a question".into(),
            Vec::new(),
            String::new(),
        ));
        app.entries.push(ConversationEntry::assistant(
            None,
            "newer reply".into(),
            Vec::new(),
            String::new(),
            None,
        ));
        assert_eq!(app.last_assistant_text().as_deref(), Some("newer reply"));

        if let Some(turn) = app
            .entries
            .last_mut()
            .and_then(ConversationEntry::as_turn_mut)
        {
            turn.state = TurnState::Streaming;
        }
        assert_eq!(
            app.last_assistant_text().as_deref(),
            Some("older reply"),
            "a reply still streaming is not offered",
        );
    }

    #[test]
    fn an_empty_conversation_offers_nothing() {
        assert_eq!(App::default().last_assistant_text(), None);
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

    fn top_rows(frame: &str, count: usize) -> Vec<&str> {
        frame.lines().take(count).collect()
    }

    fn simple_message(role: Role, id: &str, content: &str) -> Message {
        Message {
            msg_id: id.into(),
            role,
            content: content.into(),
            images: vec![],
            content_blocks: vec![],
            alt_index: None,
            alt_count: None,
            alternatives: vec![],
            timestamp: format!("t{id}"),
            provider_key: None,
            model: None,
            origin: None,
        }
    }

    #[test]
    fn history_rebuild_keeps_scrolled_up_viewport() {
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            ..App::default()
        };

        let mut messages: Vec<Message> = Vec::new();
        for i in 0..20 {
            messages.push(simple_message(
                Role::User,
                &format!("u{i}"),
                &format!("Message {i}"),
            ));
            messages.push(simple_message(
                Role::Assistant,
                &format!("a{i}"),
                &format!("Reply {i}"),
            ));
        }
        rebuild_entries_from_history(&mut app, messages.clone(), 0);
        drop(render_app_to_string(&mut app, 80, 30));

        app.scroll_up(20);
        let before = render_app_to_string(&mut app, 80, 30).unwrap();

        messages.get_mut(3).expect("fourth message").content =
            "A much longer reply that wraps over several lines\n\nsecond paragraph\n\nthird paragraph"
                .into();
        let _ = handle_server_message(
            &mut app,
            ServerMessage::History(History {
                delta: None,
                rid: None,
                messages,
                active_start: 0,
                config: serde_json::json!({}),
                selected_character: None,
                selected_thread: None,
                revision: 0,
            }),
        );
        let after = render_app_to_string(&mut app, 80, 30).unwrap();

        assert_eq!(
            top_rows(&before, 20),
            top_rows(&after, 20),
            "text under a scrolled-up viewport should not move when a history rebuild changes content above it\nbefore:\n{before}\nafter:\n{after}"
        );
    }

    fn stream_start(app: &mut App) {
        let _ = handle_server_message(
            app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
                subagent: None,
                task_id: None,
            }),
        );
    }

    fn stream_chunk(app: &mut App, text: &str) {
        let _ = handle_server_message(
            app,
            ServerMessage::StreamChunk(StreamChunk {
                rid: None,
                text: text.into(),
                content_type: "text".into(),
                subagent: None,
                task_id: None,
            }),
        );
    }

    fn stream_end(app: &mut App) {
        let _ = handle_server_message(
            app,
            ServerMessage::StreamEnd(StreamEnd {
                rid: None,
                msg_id: None,
                revision: None,
                terminal_content_blocks: None,
                content: String::new(),
                metadata: metadata(),
                finish_reason: "stop".into(),
                is_final: true,
                subagent: None,
                task_id: None,
            }),
        );
    }

    #[test]
    fn stream_end_keeps_scrolled_up_viewport() {
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            ..App::default()
        };

        for i in 0..20 {
            app.entries.push(ConversationEntry::user(
                format!("Message {i}"),
                vec![],
                format!("t{i}"),
            ));
            app.entries.push(ConversationEntry::assistant(
                None,
                format!("Reply {i}"),
                vec![],
                format!("r{i}"),
                None,
            ));
        }

        stream_start(&mut app);
        stream_chunk(&mut app, "First chunk of the answer.");
        drop(render_app_to_string(&mut app, 80, 30));

        app.scroll_up(500);
        let before = render_app_to_string(&mut app, 80, 30).unwrap();

        for tick in 0..6 {
            stream_chunk(
                &mut app,
                &format!("\nchunk {tick} with some reasonably long text to wrap around"),
            );
            drop(render_app_to_string(&mut app, 80, 30));
        }

        stream_end(&mut app);
        let after = render_app_to_string(&mut app, 80, 30).unwrap();

        assert_eq!(
            top_rows(&before, 20),
            top_rows(&after, 20),
            "text under a scrolled-up viewport should not move when the stream completes\nbefore:\n{before}\nafter:\n{after}"
        );
    }

    fn debug_config_from(pairs: &[(&str, &str)]) -> io::Result<TuiDebugConfig> {
        TuiDebugConfig::from_lookup(|name| {
            pairs
                .iter()
                .find_map(|(key, value)| (*key == name).then(|| (*value).to_owned()))
        })
    }

    fn temp_path(label: &str, extension: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "shore-{label}-{}-{nanos}.{extension}",
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
            (ENV_TUI_DEBUG_FRAMES, "/tmp/shore.frames"),
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
            Some(PathBuf::from("/tmp/shore.frames"))
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
            app.entries.first().and_then(ConversationEntry::as_turn),
            Some(t) if t.role == Role::Assistant && t.joined_text().contains("# Fixture")
        ));

        drop(std::fs::remove_file(path));
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

        drop(std::fs::remove_file(path));
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
        assert!(contents.contains("shore frame 1 (32x12)"));
        assert!(contents.contains("hello from dump"));

        drop(std::fs::remove_file(path));
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

    fn pager_text(pager: &app::OutputPager) -> String {
        pager
            .lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
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
    fn palette_cli_command_output_is_rendered_in_the_conversation() {
        let mut app = App::default();
        let rid = app.begin_palette_command("status --section daemon");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid.clone()),
                name: "status".into(),
                data: serde_json::json!({ "daemon": { "state": "running" } }),
            }),
        );

        assert!(!app.pending_palette_commands.contains_key(&rid));
        assert_eq!(
            system_entry_count(&app),
            0,
            "command output no longer lands in the conversation"
        );
        let pager = app.output_pager.as_ref().expect("output opens the pager");
        assert_eq!(pager.command, "status --section daemon");
        assert!(
            ansi::plain(&pager_text(pager)).contains("running"),
            "{:?}",
            pager_text(pager)
        );
    }

    #[test]
    fn opening_the_palette_asks_for_everything_its_arguments_complete_from() {
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            ..App::default()
        };
        app.input.mode = app::InputMode::Normal;

        let action = input::handle_event(
            &mut app,
            crossterm::event::Event::Key(crossterm::event::KeyEvent {
                code: crossterm::event::KeyCode::Char(':'),
                modifiers: crossterm::event::KeyModifiers::SHIFT,
                kind: crossterm::event::KeyEventKind::Press,
                state: crossterm::event::KeyEventState::NONE,
            }),
        );
        let Action::SendMulti(sent) = action else {
            panic!("opening the palette should fetch its catalog");
        };
        let names: Vec<String> = sent
            .into_iter()
            .filter_map(|conn| match conn {
                ConnCommand::Send(ClientMessage::Command(command)) => Some(command.name),
                ConnCommand::Send(_) | ConnCommand::Shutdown => None,
            })
            .collect();

        for wanted in [
            "list_models",
            "list_providers",
            "status",
            "tools",
            "config_schema",
            "model_settings",
        ] {
            assert!(
                names.iter().any(|name| name == wanted),
                "`{wanted}` feeds a completion the palette offers, so it has to be asked for: {names:?}"
            );
        }
    }

    #[test]
    fn a_model_name_can_be_completed_as_soon_as_the_palette_opens() {
        let mut app = App::default();
        let rid = app.begin_palette_catalog_request("models");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "list_models".into(),
                data: serde_json::json!({
                    "models": {
                        "moonshotai": [{ "name": "kimi-k3" }],
                        "anthropic": [{ "name": "opus" }]
                    }
                }),
            }),
        );

        app.input.enter_command_mode();
        for c in "model use ".chars() {
            app.input.cmd_insert_char(c);
        }
        app.update_completions();

        assert!(
            app.completion
                .candidates
                .iter()
                .any(|candidate| candidate.ends_with("kimi-k3")),
            "`model use` should offer the live models: {:?}",
            app.completion.candidates
        );
    }

    #[test]
    fn palette_catalog_responses_feed_dynamic_argument_completion_silently() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.input.cmd_text = "config set ".into();
        app.input.cmd_cursor = app.input.cmd_text.len();
        let rid = app.begin_palette_catalog_request("config");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "config_schema".into(),
                data: serde_json::json!({
                    "schema": [{
                        "key": "defaults.stream",
                        "type": "boolean",
                        "settable": true,
                        "values": ["true", "false"]
                    }]
                }),
            }),
        );

        assert!(
            app.entries.is_empty(),
            "catalog prefetch must stay out of chat"
        );
        assert!(
            app.completion
                .candidates
                .contains(&"config set defaults.stream".to_owned())
        );
    }

    #[test]
    fn config_reload_applies_safe_changes_without_activating_changed_prompts() {
        let mut app = App::default();
        let check_rid = app.begin_palette_command("config reload");

        let check = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(check_rid),
                name: "config_reload".into(),
                data: serde_json::json!({
                    "changed_prompt_files": ["system.md"]
                }),
            }),
        );

        let Some(ConnCommand::Send(ClientMessage::Command(apply))) = check.cmds.first() else {
            panic!("reload check should be followed by apply");
        };
        assert_eq!(apply.args.get("apply"), Some(&serde_json::json!(true)));
        assert_eq!(
            apply.args.get("refresh_prompts"),
            Some(&serde_json::json!(false))
        );
        assert!(apply.rid.is_some());
    }

    #[test]
    fn character_json_uses_one_palette_result_instead_of_also_printing_native_list() {
        let mut app = App::default();
        let rid = app.begin_palette_command("character --json");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "list_characters".into(),
                data: serde_json::json!({
                    "active": "ada",
                    "characters": [{ "name": "ada" }, { "name": "lin" }]
                }),
            }),
        );

        assert_eq!(system_entry_count(&app), 0);
        let pager = app
            .output_pager
            .as_ref()
            .expect("json result opens the pager");
        assert_eq!(pager.command, "character --json");
        assert!(!pager_text(pager).contains("Characters:"));
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
                    "models": {
                        "anthropic": [
                            {
                                "name": "alpha",
                                "qualified_name": "chat.anthropic.alpha",
                                "model_id": "alpha"
                            },
                            {
                                "name": "beta",
                                "qualified_name": "chat.anthropic.beta",
                                "model_id": "beta"
                            }
                        ]
                    }
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
                    "models": {
                        "deepseek": [
                            {
                                "name": "deepseek-v4-pro",
                                "qualified_name": "deepseek:deepseek-v4-pro",
                                "model_id": "deepseek-v4-pro",
                                "source": "discovered"
                            }
                        ],
                        "opencode-go": [
                            {
                                "name": "deepseek-v4-pro",
                                "qualified_name": "opencode-go:deepseek-v4-pro",
                                "model_id": "deepseek-v4-pro",
                                "source": "discovered"
                            }
                        ]
                    }
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
                ConversationEntry::Turn(_)
                | ConversationEntry::System { .. }
                | ConversationEntry::ArchiveBoundary { .. } => None,
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
                    "setting_schema": [
                        {"key":"temperature","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true},
                        {"key":"top_p","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true},
                        {"key":"reasoning_effort","kind":"string","applicability":"honored","suggestions":["medium"],"allow_custom":true},
                        {"key":"budget_tokens","kind":"u32","applicability":"honored","suggestions":[],"allow_custom":true},
                        {"key":"max_output_tokens","kind":"u32","applicability":"always","suggestions":[],"allow_custom":true},
                        {"key":"cache_ttl","kind":"duration","applicability":"honored","suggestions":["1h"],"allow_custom":true}
                    ],
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

    fn stored_message(msg_id: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "msg_id": msg_id,
            "role": "user",
            "content": text,
            "content_blocks": [{ "type": "text", "text": text }],
            "timestamp": "2026-08-19T10:00:00+10:00"
        })
    }

    #[test]
    fn a_get_response_prefills_the_edit_buffer() {
        let mut app = App::default();
        let rid = app.begin_edit_prefill("3");

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "get".into(),
                data: stored_message("m_abc", "the third message"),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert_eq!(app.editing_ref.as_deref(), Some("m_abc"));
        assert_eq!(app.input.text, "the third message");
        assert_eq!(app.input.mode, app::InputMode::Insert);
        assert!(app.pending_edit_prefill.is_none());
    }

    #[test]
    fn a_get_response_for_someone_else_leaves_the_editor_alone() {
        let mut app = App::default();
        let _ = app.begin_edit_prefill("3");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: None,
                name: "get".into(),
                data: stored_message("m_abc", "not mine"),
            }),
        );

        assert!(app.editing_ref.is_none());
        assert!(app.input.text.is_empty());
        assert!(app.pending_edit_prefill.is_some());
    }

    #[test]
    fn an_edit_prefill_without_a_message_id_does_not_arm_an_edit() {
        for id in [serde_json::Value::Null, serde_json::json!("")] {
            let mut app = App::default();
            let rid = app.begin_edit_prefill("last");
            let mut message = stored_message("m_original", "original text");
            *message.get_mut("msg_id").unwrap() = id;
            let _ = handle_server_message(
                &mut app,
                ServerMessage::CommandOutput(CommandOutput {
                    rid: Some(rid),
                    name: "get".into(),
                    data: message,
                }),
            );
            assert!(app.editing_ref.is_none());
            assert!(app.pending_edit_prefill.is_none());
            assert!(app.input.text.is_empty());
            assert!(
                app.error_log
                    .iter()
                    .any(|error| error.contains("could not read message last"))
            );
        }
    }

    #[test]
    fn an_edit_keeps_its_resolved_target_when_a_new_message_arrives() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

        for reference in ["last", "-1", "1", "m_original"] {
            let mut app = App::default();
            app.input.mode = app::InputMode::Command;
            app.input.cmd_text = format!("msg edit {reference}");
            let enter = Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
            let Action::Send(ConnCommand::Send(ClientMessage::Command(get))) =
                input::handle_event(&mut app, enter.clone())
            else {
                panic!("edit should request its prefill");
            };
            assert_eq!(get.name, "get");
            assert_eq!(get.args.get("ref").unwrap(), reference);
            let _ = handle_server_message(
                &mut app,
                ServerMessage::CommandOutput(CommandOutput {
                    rid: get.rid,
                    name: "get".into(),
                    data: stored_message("m_original", "original text"),
                }),
            );
            assert_eq!(app.input.text, "original text");
            let arrival = serde_json::from_value(serde_json::json!({
                "type": "new_message", "character": app.character_name,
                "msg_id": "m_new", "role": "user", "content": "new arrival",
                "timestamp": "2026-09-10T00:00:00Z"
            }))
            .unwrap();
            let _ = handle_server_message(&mut app, arrival);
            app.input.set_text("replacement".into());
            let Action::SendMulti(commands) = input::handle_event(&mut app, enter) else {
                panic!("saving should send the edit and refresh history");
            };
            let Some(ConnCommand::Send(ClientMessage::Command(edit))) = commands.first() else {
                panic!("first command should be the edit");
            };
            assert_eq!(edit.name, "edit");
            assert_eq!(
                edit.args.get("ref").unwrap(),
                "m_original",
                "requested {reference}"
            );
            assert_eq!(edit.args.get("content").unwrap(), "replacement");
        }
    }

    #[test]
    fn a_refused_ref_reports_the_daemon_error_and_arms_no_edit() {
        let mut app = App::default();
        let rid = app.begin_edit_prefill("99");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: Some(rid),
                code: ErrorCode::NotFound,
                message: "Message index 99 out of range (conversation has 4 messages)".into(),
                retry_after_ms: None,
            }),
        );

        assert!(app.pending_edit_prefill.is_none());
        assert!(app.editing_ref.is_none());
        assert!(
            app.error_log
                .iter()
                .any(|e| e.contains("Message index 99 out of range"))
        );
    }

    #[test]
    fn rejected_unpersisted_message_returns_text_and_images_to_the_composer() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::assistant(
            Some("m_assistant".into()),
            "the answer".into(),
            vec![],
            "t1".into(),
            None,
        ));
        app.entries.push(ConversationEntry::user(
            "look at this".into(),
            vec![shore_common::protocol::types::ImageRef {
                path: "/tmp/image.png".into(),
                caption: None,
                data: None,
            }],
            String::new(),
        ));
        app.stream.active = true;

        let _ = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: None,
                code: ErrorCode::InvalidRequest,
                message: "model does not accept images".into(),
                retry_after_ms: None,
            }),
        );

        assert_eq!(
            app.entries.len(),
            1,
            "the rejected optimistic row is removed"
        );
        assert_eq!(app.input.text, "look at this");
        assert_eq!(app.pending_images, vec!["/tmp/image.png"]);
        assert!(
            app.error_log.last().is_some_and(|error| {
                error.contains("restored to the composer") && error.contains(":image clear")
            }),
            "the recovery path should be explicit: {:?}",
            app.error_log
        );
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

        let unrelated_error_effect = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: Some(rid),
                code: ErrorCode::InvalidRequest,
                message: "No model specified and no active model set".into(),
                retry_after_ms: None,
            }),
        );

        assert_eq!(unrelated_error_effect.redraw, RedrawEffect::Immediate);
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
                retry_after_ms: None,
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

        let sampler_settings_effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "model_settings".into(),
                data: serde_json::json!({
                    "effective_sampler": {
                        "temperature": 0.7
                    },
                    "setting_schema": [{"key":"temperature","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true}],
                    "scopes": {
                        "temperature": "character_model"
                    }
                }),
            }),
        );

        assert_eq!(sampler_settings_effect.redraw, RedrawEffect::Immediate);
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
                retry_after_ms: None,
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
    fn a_legacy_model_settings_response_requires_a_lockstep_upgrade() {
        let mut app = App::default();
        let rid = app.begin_sampler_settings_refresh();

        let effect = handle_server_message(
            &mut app,
            ServerMessage::CommandOutput(CommandOutput {
                rid: Some(rid),
                name: "model_settings".into(),
                data: serde_json::json!({"effective_sampler":{"temperature":0.7}}),
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::Immediate);
        assert!(!app.sampler_settings_loading);
        assert!(app.effective_sampler.is_none());
        assert!(
            app.error_log
                .iter()
                .any(|entry| entry.contains("client and daemon must be upgraded together"))
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
                    "setting_schema": [{"key":"temperature","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true}],
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
            fields: std::collections::BTreeMap::from([(
                "temperature".into(),
                app::EffectiveSamplerField {
                    value: Some("0.5".into()),
                    scope: Some("character_model".into()),
                },
            )]),
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
                    "setting_schema": [{"key":"temperature","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true}],
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
            fields: std::collections::BTreeMap::from([(
                "temperature".into(),
                app::EffectiveSamplerField {
                    value: Some("0.5".into()),
                    scope: Some("character_model".into()),
                },
            )]),
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
                    "setting_schema": [{"key":"temperature","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true}],
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
                    "setting_schema": [{"key":"temperature","kind":"number","applicability":"honored","suggestions":[],"allow_custom":true}],
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
        let Some(ConnCommand::Send(ClientMessage::Command(cmd))) = effect.cmds.first() else {
            panic!("expected model_settings command");
        };
        assert_eq!(cmd.name, "model_settings");
        assert!(cmd.rid.is_some());
        assert_eq!(
            cmd.rid.as_deref(),
            app.pending_sampler_settings_rid.as_deref()
        );
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
        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
                subagent: None,
                task_id: None,
            }),
        );
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                terminal_content_blocks: None,
                content: "done".into(),
                metadata: metadata(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        assert_eq!(effect.redraw, RedrawEffect::ImmediateFull);
    }

    #[test]
    fn generation_error_finishes_the_real_stream_and_preserves_partial_text() {
        let mut app = App::default();
        app.stream.active = true;
        app.stream_append_text("partial answer");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: None,
                code: ErrorCode::ProviderError,
                message: "rate limited".into(),
                retry_after_ms: None,
            }),
        );

        assert!(!app.stream.active);
        let turn = app
            .entries
            .last()
            .and_then(ConversationEntry::as_turn)
            .expect("partial assistant turn is retained");
        assert!(!turn.is_streaming());
        assert_eq!(turn.joined_text(), "partial answer");
        assert!(
            app.error_log
                .last()
                .is_some_and(|line| line.contains("rate limited"))
        );
    }

    #[test]
    fn unrelated_command_error_does_not_finish_an_active_generation() {
        let mut app = App::default();
        app.stream.active = true;
        app.stream_append_text("still running");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::Error(CommandError {
                rid: Some("palette_1".into()),
                code: ErrorCode::InternalError,
                message: "command failed".into(),
                retry_after_ms: None,
            }),
        );

        assert!(app.stream.active);
        assert!(
            app.entries
                .last()
                .and_then(ConversationEntry::as_turn)
                .is_some_and(Turn::is_streaming)
        );
    }

    #[test]
    fn final_terminal_blocks_replace_corrupted_stream_chunks() {
        let mut app = App::default();
        app.stream.active = true;
        app.stream_append_text("garbled answr");

        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: Some("m_1".into()),
                revision: Some(1),
                terminal_content_blocks: Some(vec![ContentBlock::Text {
                    text: "complete answer".into(),
                }]),
                content: "complete answer".into(),
                metadata: metadata(),
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        );

        let turn = app
            .entries
            .last()
            .and_then(ConversationEntry::as_turn)
            .expect("assistant turn");
        assert_eq!(turn.joined_text(), "complete answer");
        assert!(!turn.is_streaming());
    }

    #[test]
    fn tool_use_stream_end_keeps_regular_redraw() {
        let mut app = App::default();
        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
                subagent: None,
                task_id: None,
            }),
        );
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                terminal_content_blocks: None,
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
        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
                subagent: None,
                task_id: None,
            }),
        );
        let effect = handle_server_message(
            &mut app,
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
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
        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
                subagent: None,
                task_id: None,
            }),
        );
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
                task_id: None,
                rid: None,
                msg_id: Some("m_target".into()),
                revision: Some(7),
                terminal_content_blocks: None,
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
        let _ = handle_server_message(
            &mut app,
            ServerMessage::StreamStart(StreamStart {
                rid: None,
                regen: false,
                subagent: None,
                task_id: None,
            }),
        );
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
                task_id: None,
                rid: None,
                msg_id: Some("m_missing_from_history".into()),
                revision: Some(8),
                terminal_content_blocks: None,
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

#[cfg(test)]
mod send_failure_tests {
    use super::*;
    use shore_common::protocol::client_msg::ClientMessageBody;

    fn failed_message() -> ClientMessage {
        ClientMessage::Message(ClientMessageBody {
            rid: None,
            text: "please keep this".into(),
            stream: true,
            images: vec!["one.png".into(), "two.jpg".into()],
            image_data: vec![],
            absence_seconds: None,
        })
    }

    fn assert_message_was_restored(app: &App) {
        assert_eq!(app.input.text, "please keep this");
        assert_eq!(app.pending_images, vec!["one.png", "two.jpg"]);
        assert!(
            app.notifications
                .iter()
                .any(|notification| notification.content.contains("restored to input")),
            "the failure should explain where the message went: {:?}",
            app.notifications
        );
    }

    #[test]
    fn failed_connection_send_restores_text_and_attachments() {
        let mut app = App {
            connection_status: ConnectionStatus::Connected,
            ..App::default()
        };
        app.stream.active = true;

        let _ = handle_conn_event(&mut app, ConnEvent::SendFailed(failed_message()));

        assert!(matches!(
            app.connection_status,
            ConnectionStatus::Connecting
        ));
        assert!(!app.stream.active, "the abandoned stream must stop");
        assert_message_was_restored(&app);
    }

    #[tokio::test]
    async fn failed_command_enqueue_restores_text_and_attachments() {
        let mut app = App::default();
        app.stream.active = true;
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(1);
        drop(cmd_rx);

        send_conn_command(&mut app, &cmd_tx, ConnCommand::Send(failed_message())).await;

        assert!(!app.stream.active, "the abandoned stream must stop");
        assert_message_was_restored(&app);
    }
}

#[cfg(test)]
mod draft_lifecycle_tests {
    use super::*;

    #[test]
    fn quitting_with_text_in_the_box_brings_it_back_next_time() {
        let tmp = tempfile::tempdir().unwrap();
        let mut leaving = App::default();
        leaving
            .input
            .set_text("the thing I was halfway through saying".to_owned());
        save_draft(&leaving, tmp.path());

        let mut arriving = App::default();
        restore_draft(&mut arriving, tmp.path());

        assert_eq!(
            arriving.input.text,
            "the thing I was halfway through saying"
        );
        assert!(
            arriving
                .notifications
                .iter()
                .any(|n| n.content.contains("restored the draft")),
            "the restore should say so: {:?}",
            arriving.notifications
        );
    }

    #[test]
    fn undo_cannot_wipe_a_draft_the_moment_it_is_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let mut leaving = App::default();
        leaving.input.set_text("keep me".to_owned());
        save_draft(&leaving, tmp.path());

        let mut arriving = App::default();
        restore_draft(&mut arriving, tmp.path());

        assert!(
            !arriving.input.undo(),
            "there is nothing before the restore"
        );
        assert_eq!(arriving.input.text, "keep me");
    }

    #[test]
    fn sending_the_message_leaves_no_draft_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let mut app = App::default();
        app.input.set_text("about to send".to_owned());
        save_draft(&app, tmp.path());

        let _sent = app.input.take_text();
        save_draft(&app, tmp.path());

        let mut next = App::default();
        restore_draft(&mut next, tmp.path());
        assert_eq!(next.input.text, "");
        assert!(next.notifications.is_empty());
    }

    #[test]
    fn an_empty_box_on_a_fresh_start_stays_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let mut app = App::default();
        restore_draft(&mut app, tmp.path());
        assert_eq!(app.input.text, "");
        assert!(app.notifications.is_empty());
    }
}

#[cfg(test)]
mod prefs_path_tests {
    use super::*;

    #[test]
    fn a_prefs_file_left_in_the_config_dir_moves_to_the_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data/tui_prefs.json");
        let config = tmp.path().join("config/tui_prefs.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, r#"{"show_tools":false}"#).unwrap();

        let found = migrate_prefs(&data, std::slice::from_ref(&config));

        assert_eq!(found.as_deref(), Some(r#"{"show_tools":false}"#));
        assert_eq!(
            std::fs::read_to_string(&data).unwrap(),
            r#"{"show_tools":false}"#
        );
        assert!(!config.exists(), "the old copy should not be left behind");
    }

    #[test]
    fn the_first_legacy_location_that_has_a_file_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data/tui_prefs.json");
        let config = tmp.path().join("config/tui_prefs.json");
        let runtime = tmp.path().join("runtime/tui_prefs.json");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::write(&runtime, r#"{"show_thinking":true}"#).unwrap();

        let found = migrate_prefs(&data, &[config, runtime.clone()]);

        assert_eq!(found.as_deref(), Some(r#"{"show_thinking":true}"#));
        assert!(!runtime.exists());
    }

    #[test]
    fn nothing_to_migrate_leaves_the_data_dir_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data/tui_prefs.json");
        let missing = tmp.path().join("config/tui_prefs.json");

        assert!(migrate_prefs(&data, &[missing]).is_none());
        assert!(!data.exists());
    }
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    use serde_json::json;
    fn frame(value: serde_json::Value) -> ServerMessage {
        serde_json::from_value(value).unwrap()
    }
    fn msg(id: &str, text: &str) -> serde_json::Value {
        json!({"msg_id":id,"role":"assistant","content":text,"timestamp":"2026-09-10T00:00:00Z"})
    }
    fn history(thread: &str, messages: serde_json::Value) -> ServerMessage {
        frame(
            json!({"type":"history","selected_character":"ada","selected_thread":thread,"messages":messages,"config":{},"revision":1}),
        )
    }
    #[test]
    fn switch_retires_stream_and_edit() {
        let mut app = App {
            character_name: "ada".into(),
            thread_name: "main".into(),
            ..App::default()
        };
        app.start_editing("last".into(), "old edit".into());
        let _ = handle_server_message(&mut app, frame(json!({"type":"stream_start","rid":"old"})));
        let _ = handle_server_message(
            &mut app,
            frame(json!({"type":"stream_chunk","rid":"old","text":"unfinished"})),
        );
        let _ = handle_server_message(
            &mut app,
            history("side", json!([msg("side-reply", "side original")])),
        );
        assert!(app.editing_ref.is_none());
        assert!(
            !app.entries
                .last()
                .unwrap()
                .as_turn()
                .unwrap()
                .is_streaming()
        );
        let _ = handle_server_message(
            &mut app,
            frame(json!({"type":"stream_chunk","rid":"old","text":" OLD CONTINUATION"})),
        );
        assert_eq!(
            app.entries.last().unwrap().as_turn().unwrap().joined_text(),
            "side original"
        );
    }
    #[test]
    fn stale_cancel_preserves_new_request() {
        let mut app = App::default();
        let _ = handle_server_message(&mut app, frame(json!({"type":"stream_start","rid":"new"})));
        let _ = handle_server_message(
            &mut app,
            frame(json!({"type":"stream_chunk","rid":"new","text":"new reply"})),
        );
        let _ = handle_server_message(
            &mut app,
            frame(
                json!({"type":"stream_end","rid":"old","content":"","finish_reason":"cancelled","is_final":true,"metadata":{"tokens":{"input":0,"output":0,"cache_read":0,"cache_write":0},"timing":{"total_ms":0,"ttft_ms":0},"model":"test"}}),
            ),
        );
        assert!(app.stream.active);
        assert_eq!(
            app.entries.last().unwrap().as_turn().unwrap().joined_text(),
            "new reply"
        );
    }
    #[test]
    fn edit_prefill_pins_message_id() {
        let mut app = App::default();
        let rid = app.begin_edit_prefill("last");
        let _ = handle_server_message(
            &mut app,
            frame(
                json!({"type":"command_output","name":"get","rid":rid,"data":msg("stable-message-id","original")}),
            ),
        );
        assert_eq!(app.editing_ref.as_deref(), Some("stable-message-id"));
        app.input.set_text("replacement".into());
        let action = input::handle_event(
            &mut app,
            crossterm::event::Event::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            )),
        );
        let Action::SendMulti(commands) = action else {
            panic!("expected edit")
        };
        let ConnCommand::Send(ClientMessage::Command(cmd)) = commands.first().unwrap() else {
            panic!("expected command")
        };
        assert_eq!(cmd.args.get("ref").unwrap(), "stable-message-id");
    }
    #[test]
    fn unsolicited_history_page_cannot_enter_current_thread() {
        let mut app = App::default();
        let _ = handle_server_message(
            &mut app,
            history("side", json!([msg("side-reply", "side original")])),
        );
        let _ = handle_server_message(
            &mut app,
            frame(
                json!({"type":"command_output","name":"history_page","data":{"messages":[msg("main-old","wrong thread page")],"active_start":1,"has_more_before":false}}),
            ),
        );
        assert!(
            !app.entries
                .iter()
                .filter_map(ConversationEntry::as_turn)
                .any(|t| t.joined_text() == "wrong thread page")
        );
    }
    #[test]
    fn long_transcript_shows_its_tail() {
        let mut app = App::default();
        let body = (0..66000)
            .map(|n| format!("line {n}\n"))
            .collect::<String>()
            + "TAIL_SENTINEL";
        app.entries = build_history_entries(
            vec![serde_json::from_value(msg("long", &format!("```\n{body}\n```"))).unwrap()],
            0,
        );
        let rendered = render_app_to_string(&mut app, 80, 24).unwrap();
        assert!(app.conv_cache.lines.len() > 65535);
        assert!(app.conv_cache.content_visual > 65535);
        assert!(rendered.contains("TAIL_SENTINEL"));
    }
    #[test]
    fn draft_save_retains_attachment_state() {
        let tmp = tempfile::tempdir().unwrap();
        let mut app = App::default();
        app.input.set_text("unsent with image".into());
        app.pending_images.push("/tmp/image.png".into());
        save_draft(&app, tmp.path());
        let mut resumed = App::default();
        restore_draft(&mut resumed, tmp.path());
        assert_eq!(resumed.input.text, "unsent with image");
        assert_eq!(resumed.pending_images, app.pending_images);
    }
}

#[cfg(test)]
mod reliability_input_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn background_model_preserves_chat_model_display() {
        let mut app = App::default();
        app.set_active_model(Some("provider:chat"));
        let frame=serde_json::from_value(json!({"type":"command_output","name":"switch_model","data":{"active":"provider:background","role":"heartbeat","config_key":"defaults.background.heartbeat","changed":true}})).unwrap();
        let _ = handle_server_message(&mut app, frame);
        assert_eq!(app.model, "provider:chat");
    }
    #[test]
    fn paste_in_command_palette_stays_in_palette() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.input.cmd_text = "model use ".into();
        app.input.cmd_cursor = 10;
        let _ = input::handle_event(
            &mut app,
            crossterm::event::Event::Paste("provider:model".into()),
        );
        assert_eq!(app.input.mode, app::InputMode::Command);
        assert_eq!(app.input.cmd_text, "model use provider:model");
        assert!(app.input.text.is_empty());
    }
}

#[cfg(test)]
mod conversation_reliability_tests {
    use super::{
        App, ConversationEntry, ServerMessage, adopt_conversation, draft, handle_server_message,
        render_app_to_string, send_conn_command,
    };
    use crate::tui::app::OutputPager;
    use serde_json::json;
    use shore_common::protocol::client_msg::{ClientMessage, Command};
    use shore_common::swp_client::ConnCommand;

    fn frame(value: serde_json::Value) -> ServerMessage {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_switch_discards_old_page_and_catalog_responses_but_accepts_new_ones() {
        let mut app = App {
            character_name: "ada".into(),
            thread_name: "main".into(),
            ..App::default()
        };
        let page_rid = app.next_request_id("history_page");
        app.pending_history_page = Some(page_rid.clone());
        app.history_page_loading = true;
        let catalog_rid = app.begin_palette_catalog_request("models");
        let _effect = handle_server_message(
            &mut app,
            frame(
                json!({"type":"history", "selected_character":"ada", "selected_thread":"side", "messages":[], "config":{}, "revision":2}),
            ),
        );
        let _page = handle_server_message(
            &mut app,
            frame(
                json!({"type":"command_output", "name":"history_page", "rid":page_rid, "data":{"messages":[{"msg_id":"wrong", "role":"assistant", "content":"wrong conversation", "timestamp":""}]}}),
            ),
        );
        let _catalog = handle_server_message(
            &mut app,
            frame(
                json!({"type":"command_output", "name":"list_models", "rid":catalog_rid, "data":{"models":{"wrong":[{"id":"wrong-model"}]}}}),
            ),
        );
        assert!(app.entries.is_empty());
        assert!(app.model_names.is_empty());
        assert!(app.pending_palette_catalog.is_empty());
        assert!(!app.history_page_loading);
        let fresh = app.next_request_id("history_page");
        app.pending_history_page = Some(fresh.clone());
        let _new_page = handle_server_message(
            &mut app,
            frame(
                json!({"type":"command_output", "name":"history_page", "rid":fresh, "data":{"messages":[{"msg_id":"right", "role":"assistant", "content":"right conversation", "timestamp":""}], "active_start":0, "has_more_before":false}}),
            ),
        );
        assert_eq!(
            app.entries
                .iter()
                .find_map(ConversationEntry::as_turn)
                .unwrap()
                .joined_text(),
            "right conversation"
        );
    }

    #[test]
    fn conversation_switches_restore_their_own_editor_and_attachments() {
        let tmp = tempfile::tempdir().unwrap();
        let mut app = App {
            draft_root: Some(tmp.path().to_path_buf()),
            draft_daemon: "localhost:9090".into(),
            character_name: "ada".into(),
            thread_name: "main".into(),
            ..App::default()
        };
        app.draft_lock = Some(draft::lock_session(tmp.path(), &app.request_prefix).unwrap());
        app.start_editing("stable-message-id".into(), "edit in progress".into());
        app.pending_images.push("attachment.png".into());
        adopt_conversation(&mut app, None, Some("side"));
        assert!(app.input.text.is_empty());
        assert!(app.pending_images.is_empty());
        assert!(app.editing_ref.is_none());
        app.input.set_text("side draft".into());
        adopt_conversation(&mut app, None, Some("main"));
        assert_eq!(app.input.text, "edit in progress");
        assert_eq!(app.pending_images, ["attachment.png"]);
        assert_eq!(app.editing_ref.as_deref(), Some("stable-message-id"));
        adopt_conversation(&mut app, None, Some("side"));
        assert_eq!(app.input.text, "side draft");
    }

    #[test]
    fn stale_chunks_tools_and_starts_cannot_mutate_a_new_reply() {
        let mut app = App::default();
        let _start =
            handle_server_message(&mut app, frame(json!({"type":"stream_start", "rid":"new"})));
        let _chunk = handle_server_message(
            &mut app,
            frame(json!({"type":"stream_chunk", "rid":"new", "text":"keep this"})),
        );
        for stale in [
            json!({"type":"stream_start", "rid":"old", "regen":true}),
            json!({"type":"stream_chunk", "rid":"old", "text":"wrong"}),
            json!({"type":"tool_call", "rid":"old", "tool_id":"old-tool", "tool_name":"wrong", "input":{}}),
            json!({"type":"tool_result", "rid":"old", "tool_id":"old-tool", "tool_name":"wrong", "output":"wrong"}),
            json!({"type":"stream_chunk", "rid":"old", "task_id":"old-task", "subagent":"wrong", "text":"wrong"}),
        ] {
            let _effect = handle_server_message(&mut app, frame(stale));
        }
        assert_eq!(
            app.entries.last().unwrap().as_turn().unwrap().joined_text(),
            "keep this"
        );
        assert_eq!(app.stream.rid.as_deref(), Some("new"));
        assert!(app.subagent_tasks.is_empty());
    }

    #[test]
    fn spinner_updates_preserve_settled_text_allocations() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::user(
            "settled message".into(),
            vec![],
            "".into(),
        ));
        let _start = handle_server_message(
            &mut app,
            frame(json!({"type":"stream_start", "rid":"live"})),
        );
        let _first = render_app_to_string(&mut app, 80, 24).unwrap();
        let allocation = |state: &App| {
            state
                .conv_cache
                .lines
                .iter()
                .flat_map(|line| &line.spans)
                .find(|span| span.content.contains("settled message"))
                .unwrap()
                .content
                .as_ptr()
        };
        let before = allocation(&app);
        assert_eq!(app.conv_cache.settled_entries, 1);
        app.spinner_frame = 1;
        let _second = render_app_to_string(&mut app, 80, 24).unwrap();
        assert_eq!(allocation(&app), before);
    }

    #[test]
    fn the_output_pager_can_reach_past_the_terminal_integer_limit() {
        let mut app = App::default();
        let mut lines = vec![ratatui::text::Line::from("line"); 66_000];
        lines.push(ratatui::text::Line::from("PAGER_TAIL"));
        app.output_pager = Some(OutputPager {
            command: "status".into(),
            lines,
            scroll: 0,
            viewport: 1,
        });
        app.scroll_output_pager(i32::MAX);
        let rendered = render_app_to_string(&mut app, 80, 24).unwrap();
        assert!(rendered.contains("PAGER_TAIL"));
    }

    #[tokio::test]
    async fn full_command_queue_does_not_block_input_or_leave_pending_navigation() {
        let mut app = App::default();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        tx.try_send(ConnCommand::Shutdown).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            send_conn_command(
                &mut app,
                &tx,
                ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,
                    name: "switch_thread".into(),
                    args: json!({"name":"side"}),
                })),
            ),
        )
        .await
        .unwrap();
        assert!(app.pending_navigation.is_none());
        assert!(!app.error_log.is_empty());
    }
}
