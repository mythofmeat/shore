mod ansi;
mod app;
#[cfg(test)]
mod capability_inventory;
mod clipboard;
mod command_output;
mod connection;
mod draft;
mod images;
mod input;
mod keymap;
mod markdown;
#[cfg(test)]
mod review_tests;
mod ui;

use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange, poll, read,
};
use crossterm::execute;
use crossterm::terminal::{
    DisableLineWrap, EnableLineWrap, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode,
    enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::buffer::Buffer;
use shore_common::protocol::client_msg::{ClientMessage, Command};
use shore_common::protocol::operations::{
    ConfigReloadArgs, ConfigReloadResult, ConversationPage, MarkThreadRead, MarkThreadReadArgs,
    Operation, ReloadConfiguration, ThreadUnread, UsageArgs, UsageReport,
};
use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::{ContentBlock, Message, Role, StreamMetadata};
use tracing::{info, instrument, warn};
use tracing_subscriber::EnvFilter;

use app::{
    AltChoice, App, Block, COMPACTION_SUBAGENT, CompactionRun, ConnectionStatus, ConversationEntry,
    EffectiveSamplerSnapshot, InputState, Replaced, SegmentRequest, SubagentSection, Turn,
    TurnState, UsageDisplay, UsageLevel, UsageScope, compaction_round_from_phase,
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

fn load_keymap(app: &mut App) {
    let Some(files) = &app.settings_files else {
        return;
    };
    app.keymap = keymap::Keymap::load_from(&files.keymap);
    for warning in app.keymap.warnings.clone() {
        app.set_error(warning);
    }
}

fn load_prefs(app: &mut App) {
    let Some(files) = &app.settings_files else {
        return;
    };
    let prefs_data = std::fs::read_to_string(&files.prefs).ok();
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
    let Some(files) = &app.settings_files else {
        return;
    };
    if let Err(e) = write_prefs_file(&files.prefs, &v.to_string()) {
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
        execute!(
            io::stdout(),
            DisableFocusChange,
            DisableBracketedPaste,
            EnableLineWrap
        )?;
        disable_raw_mode()?;
        execute!(io::stdout(), LeaveAlternateScreen)?;
        operation()
    })();
    enable_raw_mode()?;
    execute!(
        io::stdout(),
        EnterAlternateScreen,
        DisableLineWrap,
        EnableBracketedPaste,
        EnableFocusChange
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

fn save_draft(app: &App, dir: &Path) -> bool {
    if let Err(e) = draft::save(
        dir,
        &app.request_prefix,
        &draft_snapshot(app),
        &app.paste_temp_paths,
    ) {
        warn!("failed to keep the unsent draft: {e}");
        return false;
    }
    true
}

fn initialize_drafts(app: &mut App, root: PathBuf) {
    match draft::lock_session(&root, &app.request_prefix) {
        Ok(lock) => {
            app.draft_lock = Some(lock);
            restore_draft(app, &root);
            app.draft_root = Some(root);
        }
        Err(error) => {
            warn!("draft recovery unavailable: {error}");
            app.set_warning("draft recovery unavailable; unsent messages will not be saved");
        }
    }
}

fn persist_conversation(app: &App) {
    if app.persist_session && !app.character_name.is_empty() {
        persist_active_character(&app.character_name);
        let _persisted = crate::state::write_active_thread(&app.character_name, &app.thread_name);
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
        let _saved = save_draft(app, dir);
    }
    let navigation = app.pending_navigation.take();
    app.retire_operations();
    app.pending_navigation = navigation;
    app.input.set_text(String::new());
    app.input.reset_history();
    app.input.exit_command_mode();
    app.pending_images.clear();
    app.editing_ref = None;
    let _closed = app.close_segment_view();
    app.previous_segment = None;
    app.entries.clear();
    app.image_cache.clear();
    app.image_index.clear();
    app.conv_cache = app::ConvCache::default();
    app.history_version = app.history_version.wrapping_add(1);
    if app.character_name != next_character {
        app.unread_updates.clear();
    }
    app.character_name = next_character;
    app.thread_name = next_thread;
    persist_conversation(app);
    app.scroll_offset = 0;
    app.auto_scroll = true;
    app.clear_usage_limits();
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

fn restore_image_path(app: &mut App, path: String, data: Option<&str>) -> String {
    if Path::new(&path).exists() {
        return path;
    }
    if let Some(encoded) = data {
        match draft::recover_attachment(encoded) {
            Ok(recovered) => {
                let result = recovered.to_string_lossy().into_owned();
                app.paste_temp_paths.push(recovered);
                return result;
            }
            Err(error) => app.set_error(format!("could not restore attachment {path}: {error}")),
        }
    }
    path
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
        app.set_error("command not sent; try again");
        return;
    };

    if app.stream.rid == message.rid {
        app.abort_stream();
    }
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
    app.pending_images = message
        .images
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            restore_image_path(
                app,
                path,
                message
                    .image_data
                    .get(index)
                    .map(|image| image.data.as_str()),
            )
        })
        .collect();
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
        && cmd.name == "list_threads"
    {
        app.unread_listing_from = app.unread_seq;
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
        let closed = matches!(error, tokio::sync::mpsc::error::TrySendError::Closed(_));
        restore_failed_send(app, error.into_inner());
        if closed {
            app.retire_operations();
            app.connection_status = ConnectionStatus::Disconnected;
        }
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

fn listing_text(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn listing_flag(row: &serde_json::Value, key: &str) -> bool {
    row.get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn absorb_thread_listing(app: &mut App, data: &serde_json::Value) {
    let Some(listed) = data.get("threads").and_then(|v| v.as_array()) else {
        app.palette_catalog.threads.clear();
        return;
    };
    let rows: Vec<app::ThreadRow> = listed
        .iter()
        .filter_map(|row| {
            let id = row.get("id").and_then(serde_json::Value::as_str)?;
            Some(app::ThreadRow {
                id: id.to_owned(),
                label: listing_text(row, "label"),
                purpose: listing_text(row, "purpose"),
                model: listing_text(row, "chat_model"),
                home: listing_flag(row, "home"),
                turns: row.get("turns").and_then(serde_json::Value::as_u64),
                unread: row.get("unread").and_then(serde_json::Value::as_u64),
                warm: listing_flag(row, "warm"),
                created_at: listing_text(row, "created_at").unwrap_or_default(),
                last_active: listing_text(row, "last_active"),
                by_character: listing_text(row, "created_by").as_deref() == Some("character"),
                locked: listing_flag(row, "locked"),
            })
        })
        .collect();
    let character = data
        .get("character")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&app.character_name)
        .to_owned();
    if app.threads_known_for.as_deref() == Some(character.as_str()) {
        announce_started_threads(app, &rows);
    }
    app.threads_known_for = Some(character);
    app.threads = rows;
    app.reapply_later_unread();
    app.sync_thread_catalog();
    if let Some(home) = data.get("home").and_then(serde_json::Value::as_str) {
        app.home_thread = home.to_owned();
    }
    if let Some(current) = data.get("current").and_then(serde_json::Value::as_str) {
        app.thread_name = current.to_owned();
    }
}

fn announce_started_threads(app: &mut App, rows: &[app::ThreadRow]) {
    let notes: Vec<String> = rows
        .iter()
        .filter(|row| row.by_character && !app.threads.iter().any(|known| known.id == row.id))
        .map(|row| {
            let mut note = format!("{} started a thread: {}", app.character_name, row.id);
            if let Some(label) = &row.label {
                note.push_str(&format!(" \u{2014} {label}"));
            }
            if let Some(purpose) = &row.purpose {
                note.push_str(&format!("\n  {purpose}"));
            }
            note.push_str(&format!("\n  :thread use {} opens it", row.id));
            note
        })
        .collect();
    if notes.is_empty() {
        return;
    }
    for content in notes {
        app.entries.push(ConversationEntry::System {
            msg_id: None,
            content,
            count: 1,
            timestamp: String::new(),
        });
    }
    if app.auto_scroll {
        app.scroll_to_bottom();
    }
}

fn thread_listing_text(app: &App) -> String {
    app.thread_order()
        .into_iter()
        .map(|row| {
            let mark = if row.id == app.thread_name { "*" } else { " " };
            format!("  {mark} {}", App::thread_row_label(row))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn read_mark_command(app: &mut App) -> Option<ConnCommand> {
    if !app.focused
        || app.segment_view.is_some()
        || app.thread_name.is_empty()
        || app.connection_status != ConnectionStatus::Connected
    {
        return None;
    }
    let unread = app
        .threads
        .iter()
        .find(|row| row.id == app.thread_name)?
        .unread_count();
    if unread == 0 {
        return None;
    }
    let through = app.entries.iter().rev().find_map(|entry| {
        let stamp = match entry {
            ConversationEntry::Turn(turn) if !turn.is_streaming() => turn.timestamp.as_str(),
            ConversationEntry::Turn(_) => return None,
            ConversationEntry::System { timestamp, .. } => timestamp.as_str(),
        };
        chrono::DateTime::parse_from_rfc3339(stamp)
            .is_ok()
            .then(|| stamp.to_owned())
    })?;
    let key = format!("{}/{}/{through}", app.character_name, app.thread_name);
    if app.read_mark_sent.as_deref() == Some(key.as_str()) {
        return None;
    }
    let rid = app.next_request_id("read");
    let command = MarkThreadRead::command(
        MarkThreadReadArgs {
            name: app.thread_name.clone(),
            through: Some(through),
        },
        Some(rid.clone()),
    )
    .ok()?;
    app.read_mark_sent = Some(key);
    app.pending_read_mark_rid = Some(rid);
    Some(ConnCommand::Send(ClientMessage::Command(command)))
}

fn switch_thread_command(name: &str) -> ConnCommand {
    ConnCommand::Send(ClientMessage::Command(Command {
        rid: None,
        name: "switch_thread".into(),
        args: serde_json::json!({ "name": name }),
    }))
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

fn usage_budget_conn_commands(app: &mut App) -> Vec<ConnCommand> {
    match UsageReport::command(
        UsageArgs {
            budget: Some(true),
            ..UsageArgs::default()
        },
        None,
    ) {
        Ok(command) => vec![ConnCommand::Send(ClientMessage::Command(command))],
        Err(error) => {
            app.set_error(error.to_string());
            vec![]
        }
    }
}

async fn handle_conn_event_and_send(
    app: &mut App,
    cmd_tx: &tokio::sync::mpsc::Sender<ConnCommand>,
    event: ConnEvent,
) -> UiEffect {
    let mut effect = handle_conn_event(app, event);
    effect.cmds.extend(read_mark_command(app));
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
    app.read_mark_sent = None;
    app.pending_read_mark_rid = None;
    app.retire_operations();
    app.effective_sampler = None;
    app.sampler_settings_loading = false;
    app.pending_sampler_settings_rid = None;
    app.pending_palette_commands.clear();
    app.invalidate_palette_catalog();
    app.pending_segment_page = None;
    app.pending_subagent_trace_ids.clear();
    app.clear_usage_limits();
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
            match clipboard::read_image_to_temp().await {
                Ok(path) => {
                    let path_str = path.to_string_lossy().into_owned();
                    app.pending_images.push(path_str);
                    app.paste_temp_paths.push(path);
                    app.set_status(format!(
                        "pasted image ({} pending)",
                        app.pending_images.len()
                    ));
                }
                Err(e) => app.set_error(e.to_string()),
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
            EnableBracketedPaste,
            EnableFocusChange
        )?;
        Ok(session)
    }
}

fn restore_terminal(was_raw: bool) {
    let _focus = execute!(io::stdout(), DisableFocusChange);
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
            character_name: resolved_character.clone().unwrap_or_default(),
            thread_name: resolved_thread.clone().unwrap_or_default(),
            ..App::default()
        }
    };
    if !debug.no_image_probe && !fixture_mode {
        app.image_cache.probe_protocol();
    }
    if !fixture_mode {
        app.settings_files = Some(app::SettingsFiles::resolve());
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
        initialize_drafts(&mut app, root);
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
                                if !fixture_mode && let Some(mark) = read_mark_command(&mut app) {
                                    send_conn_command(&mut app, &cmd_tx, mark).await;
                                }
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
            _ = draft_tick.tick(), if app.draft_root.is_some() => {
                let snapshot = draft_snapshot(&app);
                if saved_draft != snapshot
                    && let Some(root) = &app.draft_root
                    && save_draft(&app, root)
                {
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
        if let Some(root) = &app.draft_root {
            let _saved = save_draft(&app, root);
        }
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
            previous_segment,
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
            app.clear_usage_limits();
            app.characters.clone_from(&characters);

            app.character_name = next_character;
            app.thread_name = selected_thread.unwrap_or_default();
            persist_conversation(app);

            if let Some(private) = config.get("private").and_then(serde_json::Value::as_bool) {
                app.is_private = private;
            }
            app.set_active_model(config.get("active_model").and_then(|v| v.as_str()));

            let _closed = app.close_segment_view();
            app.previous_segment = previous_segment;
            rebuild_entries_from_history(app, history);
            transmit_entry_images(app);

            app.set_status("connected");
            let mut cmds = if has_selected_character {
                let mut commands = usage_budget_conn_commands(app);
                commands.push(thread_refresh_command(app));
                commands
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

fn build_history_entries(messages: Vec<Message>) -> Vec<ConversationEntry> {
    let mut entries = Vec::new();
    for msg in messages {
        expand_msg(msg, &mut entries);
    }
    entries
}

fn rebuild_entries_from_history(app: &mut App, messages: Vec<Message>) {
    app.replaced.rebuilt_from(0, &messages);
    app.entries = build_history_entries(messages);
    splice_subagent_sections(&mut app.entries, &app.subagent_traces);
    app.grew_above_viewport = true;
    app.history_version = app.history_version.wrapping_add(1);
}

fn reconcile_streaming_turn(app: &mut App, messages: Vec<Message>) {
    let in_flight = app
        .entries
        .last()
        .and_then(ConversationEntry::as_turn)
        .filter(|turn| turn.is_streaming());
    let prev_metadata = in_flight.and_then(|turn| turn.metadata.clone());
    let prev_msg_id = in_flight.and_then(|turn| turn.msg_id.clone());

    app.entries = build_history_entries(messages);
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
            Some(entry)
                if matches!(entry.as_turn(), Some(t) if matches!(t.role, Role::Assistant))
                    && !entry.msg_id().is_some_and(|id| app.replaced.replaces(id)) =>
            {
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

fn absorb_segment_page(app: &mut App, request: SegmentRequest, data: &serde_json::Value) {
    let Ok(mut page) = serde_json::from_value::<ConversationPage>(data.clone()) else {
        app.set_error("could not read the segment page");
        return;
    };
    let entries = build_history_entries(std::mem::take(&mut page.messages));
    match request {
        SegmentRequest::Open => {
            let opened = page.segment.as_ref().map(|summary| summary.index);
            if app.show_segment(page, entries) {
                if let Some(index) = opened {
                    app.set_status(format!(
                        "viewing segment {index} · [ older · ] newer · ui segment current"
                    ));
                }
            } else {
                app.set_error("the daemon sent no segment");
            }
        }
        SegmentRequest::Earlier => app.prepend_segment_page(page, entries),
        SegmentRequest::Neighbours => app.refresh_segment_neighbours(page),
    }
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
            | ContentBlock::Image { .. }
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
            ContentBlock::Image { .. } => blocks.push(Block::Text("[Image attached]".to_owned())),
            ContentBlock::RedactedThinking { .. } => {}
            ContentBlock::ToolUse {
                id, name, input, ..
            } => {
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
                let (output, images) = images::tool_result_parts(content, name);
                blocks.push(Block::ToolResult {
                    tool_name: (*name).to_owned(),
                    output,
                    images,
                    is_error: is_error.unwrap_or(false),
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
            | ContentBlock::Image { .. }
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
    app.pending_images = turn
        .images
        .into_iter()
        .map(|image| restore_image_path(app, image.path, image.data.as_deref()))
        .collect();
    true
}

fn expand_msg(msg: Message, entries: &mut Vec<ConversationEntry>) {
    let images = msg.display_images();
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
            images,
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
        images,
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
        for block in &turn.blocks {
            if let Block::ToolResult { images, .. } = block {
                for img in images {
                    transmit_image_ref(&mut app.image_cache, img, max_cols, max_rows);
                }
            }
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
            let (max_cols, max_rows) = image_max_cells();
            for img in &tr.images {
                transmit_image_ref(&mut app.image_cache, img, max_cols, max_rows);
            }
            app.subagent_task_push_block(
                idx,
                Block::ToolResult {
                    tool_name: tr.tool_name,
                    output: tr.output,
                    images: tr.images,
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
        | ServerMessage::PlanLimitWarning(_)
        | ServerMessage::ConfigWarning(_)
        | ServerMessage::RequestAccepted(_)
        | ServerMessage::RequestFinished(_)
        | ServerMessage::ThreadsChanged(_)
        | ServerMessage::ThreadUnread(_)
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
                if key.contains('<') {
                    continue;
                }
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
        | ServerMessage::PlanLimitWarning(_)
        | ServerMessage::ConfigWarning(_)
        | ServerMessage::RequestAccepted(_)
        | ServerMessage::RequestFinished(_)
        | ServerMessage::ThreadsChanged(_)
        | ServerMessage::ThreadUnread(_)
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
            let (max_cols, max_rows) = image_max_cells();
            for img in &tr.images {
                transmit_image_ref(&mut app.image_cache, img, max_cols, max_rows);
            }
            run.push_block(Block::ToolResult {
                tool_name: tr.tool_name,
                output: tr.output,
                images: tr.images,
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
        | ServerMessage::PlanLimitWarning(_)
        | ServerMessage::ConfigWarning(_)
        | ServerMessage::RequestAccepted(_)
        | ServerMessage::RequestFinished(_)
        | ServerMessage::ThreadsChanged(_)
        | ServerMessage::ThreadUnread(_)
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
    let adopting = matches!(msg, ServerMessage::StreamStart(_))
        && !app.stream.active
        && msg.task_id().is_none()
        && msg.subagent().is_none();
    if !navigation_response && !adopting && app.stale_request(msg.request_id()) {
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
            if !app.stream.active {
                app.stream.reset();
                app.stream.active = true;
                if start.regen {
                    app.replaced = Replaced::tail_of(&app.entries);
                    app.scroll_to_bottom();
                }
            } else {
                app.stream.phase = "responding".into();
                app.stream.tool_name = None;
            }
            if start.regen {
                app.stream.regen = true;
                app.replaced.ids = start.replaces;
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
            let image_scope = end
                .msg_id
                .as_deref()
                .or(end.rid.as_deref())
                .unwrap_or("stream");
            let terminal = end.terminal_content_blocks.as_deref().unwrap_or_default();

            let landed_pos = end.msg_id.as_deref().and_then(|target| {
                app.entries.iter().rposition(|e| {
                    matches!(
                        e.as_turn(),
                        Some(Turn { msg_id: Some(id), .. }) if id == target
                    )
                })
            });
            let target_pos = landed_pos.or_else(|| {
                app.entries
                    .iter()
                    .rposition(|e| matches!(e.as_turn(), Some(t) if t.is_streaming()))
            });

            match target_pos.and_then(|pos| app.entries.get_mut(pos)?.as_turn_mut()) {
                Some(turn) => {
                    shore_common::protocol::types::append_inline_images(
                        &mut turn.images,
                        image_scope,
                        terminal,
                    );
                    accumulate_metadata(&mut turn.metadata, &end.metadata);
                    if turn.msg_id.is_none() {
                        turn.msg_id.clone_from(&end.msg_id);
                    }
                    if final_phase {
                        if end.terminal_content_blocks.is_some() {
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
                    let mut images = Vec::new();
                    shore_common::protocol::types::append_inline_images(
                        &mut images,
                        image_scope,
                        terminal,
                    );
                    let mut turn = Turn::text(
                        Role::Assistant,
                        end.msg_id.clone(),
                        end.content.clone(),
                        images,
                        String::new(),
                        metadata,
                    );
                    if end.terminal_content_blocks.is_some() {
                        turn.blocks = blocks_from_content(terminal, &tool_name_map(terminal));
                    }
                    app.entries.push(ConversationEntry::Turn(turn));
                }
                None => {
                    let turn = app.ensure_streaming_turn();
                    shore_common::protocol::types::append_inline_images(
                        &mut turn.images,
                        image_scope,
                        terminal,
                    );
                    accumulate_metadata(&mut turn.metadata, &end.metadata);
                    if turn.msg_id.is_none() {
                        turn.msg_id.clone_from(&end.msg_id);
                    }
                }
            }

            if !shore_common::protocol::types::inline_images(terminal).is_empty() {
                transmit_entry_images(app);
            }

            if final_phase {
                if app.stream.regen {
                    match end.msg_id.filter(|_| landed_pos.is_none()) {
                        Some(replacement) => app.replaced.replacement = Some(replacement),
                        None => app.replaced = Replaced::default(),
                    }
                }
                app.stream.reset();
                if matches!(end.finish_reason.as_str(), "max_tokens" | "length") {
                    app.set_status("reply truncated at the max_tokens ceiling");
                }
                if keep_bottom {
                    app.scroll_to_bottom();
                }
                return UiEffect {
                    cmds: usage_budget_conn_commands(app),
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
            let (max_cols, max_rows) = image_max_cells();
            for img in &tr.images {
                transmit_image_ref(&mut app.image_cache, img, max_cols, max_rows);
            }
            app.stream.tool_name = None;
            app.settle_subagent_task(&tr.tool_id, &tr.output, tr.is_error);
            app.stream_push_tool_result(tr.tool_name, tr.output, tr.images, tr.is_error);
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
            if matches!(
                co.name.as_str(),
                "compact" | "compact_watch" | "compact_cancel"
            ) {
                app.compaction = None;
            }
            if let Some(kind) = app.take_palette_catalog_request(co.rid.as_deref()) {
                absorb_palette_catalog(app, &kind, &co.data);
                return UiEffect::redraw(RedrawEffect::Immediate);
            }
            let palette_command = app.take_palette_command(co.rid.as_deref());
            if co.name == "config_reload"
                && co.data.get("applied").and_then(serde_json::Value::as_bool) == Some(false)
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
                let preview = match serde_json::from_value::<ConfigReloadResult>(co.data.clone()) {
                    Ok(preview) => preview,
                    Err(error) => {
                        app.set_error(format!("Invalid configuration preview: {error}"));
                        return UiEffect::redraw(RedrawEffect::Immediate);
                    }
                };
                let changed = preview.changed_prompt_files;
                if !changed.is_empty() && !yes {
                    app.set_warning(format!(
                        "System prompt files changed: {}. Config reloaded without activating them; review them, then run `:config reload --yes`.",
                        changed.join(", ")
                    ));
                }
                let rid = app.begin_palette_command(&command_text);
                let command = match ReloadConfiguration::command(
                    ConfigReloadArgs {
                        apply: Some(true),
                        refresh_prompts: Some(yes && !changed.is_empty()),
                    },
                    Some(rid),
                ) {
                    Ok(command) => command,
                    Err(error) => {
                        app.set_error(error.to_string());
                        return UiEffect::redraw(RedrawEffect::Immediate);
                    }
                };
                return UiEffect {
                    cmds: vec![ConnCommand::Send(ClientMessage::Command(command))],
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
            let mut refresh_usage = false;
            let mut follow_up: Vec<ConnCommand> = Vec::new();
            match co.name.as_str() {
                "history_page" => {
                    let Some((rid, request)) = app.pending_segment_page.take() else {
                        return UiEffect::redraw(RedrawEffect::None);
                    };
                    if Some(rid.as_str()) != co.rid.as_deref() {
                        app.pending_segment_page = Some((rid, request));
                        return UiEffect::redraw(RedrawEffect::None);
                    }
                    absorb_segment_page(app, request, &co.data);
                    return UiEffect::redraw(RedrawEffect::Immediate);
                }
                "subagent_trace" => {
                    absorb_subagent_traces(app, &co.data);
                    transmit_entry_images(app);
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
                "create_thread" => {
                    absorb_thread_listing(app, &co.data);
                    if let Some(name) = app.pending_thread_create.take()
                        && app.threads.iter().any(|row| row.id == name)
                    {
                        follow_up.push(switch_thread_command(&name));
                    }
                }
                "archive_thread" | "thread_home" | "thread_label" | "thread_purpose"
                | "thread_files" | "thread_lock" => {
                    absorb_thread_listing(app, &co.data);
                }
                "mark_thread_read" => {
                    if app.pending_read_mark_rid.is_some()
                        && app.pending_read_mark_rid.as_deref() == co.rid.as_deref()
                    {
                        app.pending_read_mark_rid = None;
                    }
                    if let Ok(update) = serde_json::from_value::<ThreadUnread>(co.data.clone())
                        && update.character == app.character_name
                    {
                        app.record_thread_unread(update);
                    }
                    return UiEffect::redraw(RedrawEffect::Immediate);
                }
                "thread_model" => {
                    absorb_thread_listing(app, &co.data);
                    refresh_usage = true;
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
                    persist_conversation(app);
                    app.set_status(if changed {
                        format!("thread: {name}")
                    } else {
                        format!("already in {name}")
                    });
                    if changed {
                        app.subagent_traces.clear();
                        app.pending_subagent_trace_ids.clear();
                        app.effective_sampler = None;
                        let mut cmds = vec![thread_refresh_command(app)];
                        cmds.extend(usage_budget_conn_commands(app));
                        return UiEffect {
                            cmds,
                            redraw: RedrawEffect::Immediate,
                        };
                    }
                }
                "switch_character" => {
                    if let Some(name) = co.data.get("character").and_then(|v| v.as_str()) {
                        adopt_conversation(app, Some(name), None);
                        persist_conversation(app);
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
                    refresh_usage = true;
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
                    if pending_response {
                        app.finish_sampler_settings_refresh();
                        if let Some(snapshot) = sampler_snapshot {
                            app.note_active_model_from_snapshot(&snapshot);
                            app.effective_sampler = Some(snapshot);
                        } else {
                            app.effective_sampler = None;
                            app.set_error("daemon returned invalid model settings");
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
                    refresh_usage = true;
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
            if refresh_usage {
                follow_up.extend(usage_budget_conn_commands(app));
            }
            if !follow_up.is_empty() {
                return UiEffect {
                    cmds: follow_up,
                    redraw: RedrawEffect::Immediate,
                };
            }
            RedrawEffect::Immediate
        }

        ServerMessage::Error(err) => {
            if err.rid.is_some() && app.pending_read_mark_rid.as_deref() == err.rid.as_deref() {
                app.pending_read_mark_rid = None;
                return UiEffect::redraw(RedrawEffect::None);
            }
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
            if app
                .pending_segment_page
                .as_ref()
                .is_some_and(|(rid, _)| Some(rid.as_str()) == err.rid.as_deref())
            {
                app.pending_segment_page = None;
            }
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

        ServerMessage::PlanLimitWarning(w) => {
            let applied = app.usage_display != UsageDisplay::Off
                && app.apply_plan_limit_warning(
                    w.window.into(),
                    UsageLevel {
                        percent_used: w.percent_used,
                        crossed_warn_at: w.crossed_warn_at.clone(),
                        over_limit: w.over_limit,
                    },
                );
            if !applied {
                app.set_warning(w.message.clone());
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
                        })
                        .map(|index| index.saturating_add(1)),
                    None => Some(0),
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
                app.replaced.rebuilt_from(keep, &messages);
                let suffix = app.entries.split_off(keep);
                let mut prefix = std::mem::replace(&mut app.entries, suffix);
                reconcile_streaming_turn(app, messages);
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
            app.replaced.rebuilt_from(0, &hist.messages);
            reconcile_streaming_turn(app, hist.messages);
            let moved = hist.previous_segment.as_ref().map(|summary| summary.index)
                != app.previous_segment.as_ref().map(|summary| summary.index);
            app.previous_segment = hist.previous_segment;
            app.history_version = app.history_version.wrapping_add(1);
            transmit_entry_images(app);
            let mut cmds = subagent_trace_fetch(app);
            if moved {
                cmds.extend(input::refresh_segment_neighbours(app));
            }
            return UiEffect {
                cmds,
                redraw: RedrawEffect::Immediate,
            };
        }

        ServerMessage::ThreadsChanged(changed) => {
            if changed.character != app.character_name {
                return UiEffect::redraw(RedrawEffect::None);
            }
            return UiEffect {
                cmds: vec![thread_refresh_command(app)],
                redraw: RedrawEffect::None,
            };
        }

        ServerMessage::ThreadUnread(update) => {
            if update.character != app.character_name {
                return UiEffect::redraw(RedrawEffect::None);
            }
            app.record_thread_unread(update);
            RedrawEffect::Immediate
        }

        ServerMessage::Hello(_)
        | ServerMessage::Shutdown(_)
        | ServerMessage::Ping(_)
        | ServerMessage::RequestAccepted(_)
        | ServerMessage::RequestFinished(_)
        | ServerMessage::Unknown => RedrawEffect::Immediate,
    };
    UiEffect::redraw(redraw)
}

#[cfg(test)]
mod redraw_tests {
    use super::*;
    use shore_common::protocol::error::ErrorCode;

    use shore_common::protocol::server_msg::{Error as CommandError, StreamChunk, StreamStart};

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
                ..shore_common::protocol::types::ImageRef::default()
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

    fn joke_prompt(app: &mut App) {
        app.entries.push(ConversationEntry::Turn(Turn::text(
            Role::User,
            Some("m_user".into()),
            "Tell me a joke".into(),
            vec![],
            "t1".into(),
            None,
        )));
    }

    fn saved_joke(app: &mut App) {
        joke_prompt(app);
        app.entries.push(ConversationEntry::assistant(
            Some("m_old".into()),
            "Why did the chicken cross the road?".into(),
            vec![],
            "t2".into(),
            None,
        ));
    }

    fn partial_reply_without_an_id(app: &mut App, text: &str) {
        app.stream.active = true;
        app.stream.rid = Some("r_send".into());
        let _ = handle_server_message(app, chunk_of("r_send", text));
        let _ = handle_server_message(app, failed("r_send"));
        app.dismiss_notifications();
    }

    fn start_regen(app: &mut App) {
        app.begin_regen_optimistic();
        app.stream.rid = Some("r_regen".into());
    }

    fn regen_start(replaces: &[&str]) -> ServerMessage {
        ServerMessage::StreamStart(StreamStart {
            rid: Some("r_regen".into()),
            regen: true,
            replaces: replaces.iter().map(|id| (*id).to_owned()).collect(),
            subagent: None,
            task_id: None,
        })
    }

    fn chunk_of(rid: &str, text: &str) -> ServerMessage {
        ServerMessage::StreamChunk(StreamChunk {
            rid: Some(rid.into()),
            text: text.into(),
            content_type: "text".into(),
            subagent: None,
            task_id: None,
        })
    }

    fn failed(rid: &str) -> ServerMessage {
        ServerMessage::Error(CommandError {
            rid: Some(rid.into()),
            code: ErrorCode::ProviderError,
            message: "overloaded".into(),
            retry_after_ms: None,
        })
    }

    fn screen(app: &mut App) -> String {
        render_app_to_string(app, 80, 30).unwrap()
    }

    #[test]
    fn a_failed_regen_brings_back_everything_it_hid() {
        let mut app = App::default();
        saved_joke(&mut app);
        partial_reply_without_an_id(&mut app, "Why did the chicken");

        start_regen(&mut app);
        let _ = handle_server_message(&mut app, regen_start(&["m_old"]));
        let hidden = screen(&mut app);
        assert!(!hidden.contains("chicken"), "{hidden}");

        let _ = handle_server_message(&mut app, failed("r_regen"));
        let restored = screen(&mut app);
        assert_eq!(
            restored.matches("Why did the chicken").count(),
            2,
            "both the saved reply and the partial one come back\n{restored}"
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
        let _ = handle_conn_event(&mut app, ConnEvent::Disconnected("send failed".into()));

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
        assert!(save_draft(&leaving, tmp.path()));

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
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    use serde_json::json;
    fn frame(value: serde_json::Value) -> ServerMessage {
        serde_json::from_value(value).unwrap()
    }
    fn msg(id: &str, text: &str) -> serde_json::Value {
        json!({"msg_id":id,"role":"assistant","content":text,"content_blocks":[{"type":"text","text":text}],"timestamp":"2026-09-10T00:00:00Z"})
    }
    fn history(thread: &str, messages: serde_json::Value) -> ServerMessage {
        frame(
            json!({"type":"history","selected_character":"ada","selected_thread":thread,"messages":messages,"config":{},"revision":1}),
        )
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
                json!({"type":"command_output","name":"history_page","data":{"messages":[msg("main-old","wrong thread page")],"cursor":0,"next_before":0,"has_more_before":false,"total_turns":0,"segment":null,"previous_segment":null,"next_segment":null}}),
            ),
        );
        assert!(app.segment_view.is_none());
        assert!(
            !app.entries
                .iter()
                .filter_map(ConversationEntry::as_turn)
                .any(|t| t.joined_text() == "wrong thread page")
        );
    }
}

#[cfg(test)]
mod conversation_reliability_tests {
    use super::{App, ServerMessage, handle_server_message};

    use serde_json::json;

    fn frame(value: serde_json::Value) -> ServerMessage {
        serde_json::from_value(value).unwrap()
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
}
