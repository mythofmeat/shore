use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use shore_common::protocol::client_msg::{
    Cancel, ClientMessage, ClientMessageBody, Command, Regen,
};
use tracing::debug;

use crate::cli::{
    CharacterCommand, CliCommand, ConfigCommand, MsgCommand, PaletteScope, ScrollDirection,
    UiCommand, ViewKey,
};
use crate::tui::app::{App, InputMode, PaletteMode};
use crate::tui::connection::ConnCommand;
use crate::tui::keymap::key_token;

const HISTORY_PAGE_TURNS: u32 = 64;

pub(crate) enum Action {
    None,
    Send(ConnCommand),
    SendMulti(Vec<ConnCommand>),
    Quit,
    Interrupt,
    Redraw,
    SavePrefs,
    SendAndSavePrefs(Vec<ConnCommand>),
    OpenInEditor,
    PickImage(Option<String>),
    PasteImage,
}

pub(crate) fn handle_event(app: &mut App, event: Event) -> Action {
    match event {
        Event::Key(key) => handle_key(app, key),
        Event::Paste(text) => handle_paste(app, &text),
        Event::Resize(_, _) => Action::Redraw,
        Event::FocusGained | Event::FocusLost | Event::Mouse(_) => Action::None,
    }
}

fn handle_paste(app: &mut App, text: &str) -> Action {
    if app.input.mode != InputMode::Insert {
        app.input.mode = InputMode::Insert;
    }
    app.input.insert_str(text);
    Action::Redraw
}

fn handle_key(app: &mut App, key: KeyEvent) -> Action {
    if app.show_help {
        app.show_help = false;
        return Action::Redraw;
    }

    if app.fullscreen.is_some() {
        return handle_fullscreen(app, key);
    }

    if app.subagent_panel.is_some() {
        return handle_subagent_panel(app, key);
    }

    match (key.modifiers, key.code) {
        (KeyModifiers::CONTROL, KeyCode::Char('c')) => return Action::Interrupt,
        (KeyModifiers::CONTROL, KeyCode::Char('q')) => return Action::Quit,
        (KeyModifiers::CONTROL, KeyCode::Char('v')) => return Action::PasteImage,
        (KeyModifiers::ALT, KeyCode::Char('c')) => {
            if app.stream.active {
                app.stream.reset();
                return Action::Send(ConnCommand::Send(ClientMessage::Cancel(Cancel {})));
            }
            return Action::None;
        }
        _ => {}
    }

    if app.alt_picker.is_some() {
        return handle_alt_picker_mode(app, key);
    }

    match app.input.mode {
        InputMode::Normal => handle_normal_mode(app, key),
        InputMode::Insert => handle_insert_mode(app, key),
        InputMode::Command => handle_command_mode(app, key),
    }
}

fn redraw_or_load_older_history(app: &mut App) -> Action {
    if app.history_page_loading || !app.history_has_more_before {
        return Action::Redraw;
    }
    if app.scroll_offset < app.conversation_max_scroll.saturating_sub(2) {
        return Action::Redraw;
    }

    app.history_page_loading = true;
    let before = app.history_next_before.map_or_else(
        || serde_json::Value::String("active".into()),
        serde_json::Value::from,
    );
    Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
        rid: None,
        name: "history_page".into(),
        args: serde_json::json!({
            "before": before,
            "turns": HISTORY_PAGE_TURNS,
        }),
    })))
}

fn handle_normal_mode(app: &mut App, key: KeyEvent) -> Action {
    if key.modifiers == KeyModifiers::NONE && key.code == KeyCode::Esc {
        return if app.dismiss_latest_notification() {
            Action::Redraw
        } else {
            Action::None
        };
    }
    if key.code == KeyCode::Char(':')
        && (key.modifiers == KeyModifiers::NONE || key.modifiers == KeyModifiers::SHIFT)
    {
        debug!("Input: Normal -> Command");
        return run_ui_command(
            app,
            &UiCommand::Palette {
                scope: PaletteScope::Full,
            },
        );
    }

    let Some(command) = key_token(key)
        .and_then(|token| app.keymap.lookup(&token))
        .map(|binding| binding.command.clone())
    else {
        return Action::None;
    };
    dispatch_cli_command(app, &command)
}

fn palette_catalog_commands(app: &mut App) -> Vec<ConnCommand> {
    if app.palette_catalog_loaded || !app.pending_palette_catalog.is_empty() {
        return Vec::new();
    }
    app.palette_catalog_loaded = true;
    [
        ("providers", "list_providers"),
        ("status", "status"),
        ("tools", "tools"),
        ("config", "config_schema"),
        ("settings", "model_settings"),
    ]
    .into_iter()
    .map(|(kind, name)| {
        let rid = app.begin_palette_catalog_request(kind);
        ConnCommand::Send(ClientMessage::Command(Command {
            rid: Some(rid),
            name: name.to_owned(),
            args: serde_json::json!({}),
        }))
    })
    .collect()
}

fn handle_subagent_panel(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc | KeyCode::Char('q'))
        | (KeyModifiers::SHIFT, KeyCode::Char('S')) => {
            app.subagent_panel = None;
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Tab | KeyCode::Char('l') | KeyCode::Right)
        | (KeyModifiers::NONE, KeyCode::Char('n')) => {
            app.select_subagent_task(1);
            Action::Redraw
        }
        (KeyModifiers::SHIFT, KeyCode::BackTab)
        | (KeyModifiers::NONE, KeyCode::BackTab | KeyCode::Char('h') | KeyCode::Left) => {
            app.select_subagent_task(-1);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('j') | KeyCode::Down) => {
            app.scroll_subagent_panel(1);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('k') | KeyCode::Up) => {
            app.scroll_subagent_panel(-1);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('d') | KeyCode::PageDown) => {
            app.scroll_subagent_panel(10);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('u') | KeyCode::PageUp) => {
            app.scroll_subagent_panel(-10);
            Action::Redraw
        }
        (KeyModifiers::SHIFT, KeyCode::Char('G')) => {
            if let Some(task) = app.selected_subagent_task_mut() {
                task.follow = true;
            }
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('g')) => {
            if let Some(task) = app.selected_subagent_task_mut() {
                task.scroll = 0;
                task.follow = false;
            }
            Action::Redraw
        }
        _ => Action::None,
    }
}

fn handle_fullscreen(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc | KeyCode::Char('o')) => {
            app.fullscreen = None;
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('j') | KeyCode::Down) => {
            if let Some(ref mut idx) = app.fullscreen {
                let total = app.image_index.len();
                if total > 0 {
                    *idx = idx.saturating_add(1).checked_rem(total).unwrap_or_default();
                }
            }
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('k') | KeyCode::Up) => {
            if let Some(ref mut idx) = app.fullscreen {
                let total = app.image_index.len();
                if total > 0 {
                    *idx = idx
                        .checked_sub(1)
                        .unwrap_or_else(|| total.saturating_sub(1));
                }
            }
            Action::Redraw
        }
        _ => Action::None,
    }
}

fn handle_insert_mode(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc) => {
            debug!("Input: Insert → Normal");
            app.input.mode = InputMode::Normal;
            if app.editing_ref.take().is_some() {
                app.input.text.clear();
                app.input.cursor = 0;
                app.set_status("edit cancelled");
            }
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Enter) => {
            let text = app.input.take_text();
            if text.trim().is_empty() && app.pending_images.is_empty() {
                return Action::None;
            }

            if let Some(edit_ref) = app.editing_ref.take() {
                app.set_status(format!("edited message ({edit_ref})"));
                return Action::SendMulti(vec![
                    ConnCommand::Send(ClientMessage::Command(Command {
                        rid: None,

                        name: "edit".into(),
                        args: serde_json::json!({ "ref": edit_ref, "content": text }),
                    })),
                    ConnCommand::Send(ClientMessage::Command(Command {
                        rid: None,

                        name: "log".into(),
                        args: serde_json::json!({}),
                    })),
                ]);
            }

            let images = std::mem::take(&mut app.pending_images);
            send_user_message(app, text, images)
        }

        (KeyModifiers::SHIFT | KeyModifiers::ALT, KeyCode::Enter) => {
            app.input.insert_newline();
            Action::Redraw
        }

        (KeyModifiers::ALT, KeyCode::Backspace) => {
            app.input.backspace_word();
            Action::Redraw
        }
        (KeyModifiers::ALT, KeyCode::Delete) => {
            app.input.delete_word();
            Action::Redraw
        }

        (_, KeyCode::Backspace) => {
            app.input.backspace();
            Action::Redraw
        }

        (_, KeyCode::Delete) => {
            app.input.delete();
            Action::Redraw
        }

        (_, KeyCode::Left) => {
            app.input.move_left();
            Action::Redraw
        }
        (_, KeyCode::Right) => {
            app.input.move_right();
            Action::Redraw
        }
        (_, KeyCode::Home) | (KeyModifiers::CONTROL, KeyCode::Char('a')) => {
            app.input.move_home();
            Action::Redraw
        }
        (_, KeyCode::End) | (KeyModifiers::CONTROL, KeyCode::Char('e')) => {
            app.input.move_end();
            Action::Redraw
        }

        (KeyModifiers::CONTROL, KeyCode::Char('u')) => {
            app.scroll_up(10);
            redraw_or_load_older_history(app)
        }
        (KeyModifiers::CONTROL, KeyCode::Char('d')) => {
            app.scroll_down(10);
            Action::Redraw
        }

        (KeyModifiers::CONTROL, KeyCode::Char('g')) => Action::OpenInEditor,

        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(c)) => {
            app.input.insert_char(c);
            Action::Redraw
        }

        _ => Action::None,
    }
}

fn handle_command_mode(app: &mut App, key: KeyEvent) -> Action {
    if app.palette_confirmation.is_some() {
        return handle_palette_confirmation(app, key);
    }
    if matches!(app.completion.mode, PaletteMode::ValueEditor(_)) {
        return handle_value_editor_mode(app, key);
    }
    if matches!(app.completion.mode, PaletteMode::Submenu(_)) {
        return handle_submenu_mode(app, key);
    }

    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc) => {
            debug!("Input: Command → Normal (cancelled)");
            app.input.exit_command_mode();
            app.completion.clear();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Tab) => {
            if app.completion.selected.is_none() {
                app.next_completion();
            }
            app.apply_completion();
            app.update_completions();
            enter_completed_submenu(app).unwrap_or(Action::Redraw)
        }

        (KeyModifiers::CONTROL, KeyCode::Char('j')) | (KeyModifiers::NONE, KeyCode::Down) => {
            app.next_completion();
            Action::Redraw
        }

        (KeyModifiers::SHIFT | KeyModifiers::NONE, KeyCode::BackTab) => {
            if app.completion.selected.is_none() {
                app.prev_completion();
            }
            app.apply_completion();
            app.update_completions();
            enter_completed_submenu(app).unwrap_or(Action::Redraw)
        }

        (KeyModifiers::CONTROL, KeyCode::Char('k')) | (KeyModifiers::NONE, KeyCode::Up) => {
            app.prev_completion();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Enter) => {
            let committed_completion = app.completion.selected.is_some();
            if committed_completion {
                app.apply_completion();
                app.update_completions();
            }
            let trimmed = app.input.cmd_text.trim().to_owned();
            if let Some(parent) = App::canonical_submenu_parent(&trimmed) {
                app.enter_submenu(parent);
                submenu_fetch_action(app, parent)
            } else if committed_completion
                && crate::cli::parse_palette_command(&trimmed).is_err()
                && !app.completion.candidates.is_empty()
            {
                Action::Redraw
            } else {
                app.completion.clear();
                let text = app.input.take_cmd_text();
                parse_command(app, &text)
            }
        }

        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(' ')) => {
            app.input.cmd_insert_char(' ');
            app.update_completions();
            Action::Redraw
        }

        (_, KeyCode::Backspace) => {
            if app.input.cmd_text.is_empty() {
                app.input.exit_command_mode();
                app.completion.clear();
            } else {
                app.input.cmd_backspace();
                app.update_completions();
            }
            Action::Redraw
        }

        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(c)) => {
            app.input.cmd_insert_char(c);
            app.update_completions();
            Action::Redraw
        }

        _ => Action::None,
    }
}

fn handle_palette_confirmation(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Enter | KeyCode::Char('y')) => {
            let Some(confirmation) = app.palette_confirmation.take() else {
                return Action::Redraw;
            };
            app.confirmed_palette_command = Some(confirmation.command.clone());
            app.input.mode = InputMode::Normal;
            parse_command(app, &confirmation.command)
        }
        (KeyModifiers::NONE, KeyCode::Esc | KeyCode::Char('n')) => {
            app.palette_confirmation = None;
            app.input.exit_command_mode();
            app.set_status("command cancelled");
            Action::Redraw
        }
        _ => Action::None,
    }
}

fn enter_completed_submenu(app: &mut App) -> Option<Action> {
    let trimmed = app.input.cmd_text.trim();
    let parent = App::canonical_submenu_parent(trimmed)?;
    app.input.cmd_text = parent.to_owned();
    app.input.cmd_cursor = parent.len();
    app.enter_submenu(parent);
    Some(submenu_fetch_action(app, parent))
}

fn handle_submenu_mode(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc) => {
            app.exit_submenu();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Tab | KeyCode::Down)
        | (KeyModifiers::CONTROL, KeyCode::Char('j')) => {
            app.next_completion();
            Action::Redraw
        }

        (KeyModifiers::SHIFT | KeyModifiers::NONE, KeyCode::BackTab)
        | (KeyModifiers::CONTROL, KeyCode::Char('k'))
        | (KeyModifiers::NONE, KeyCode::Up) => {
            app.prev_completion();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Enter) => {
            if app.completion.selected.is_none() && !app.completion.candidates.is_empty() {
                app.completion.selected = Some(0);
            }
            let in_view_submenu = app.is_view_submenu();
            if let Some(cmd) = app.apply_submenu() {
                parse_command(app, &cmd)
            } else if in_view_submenu {
                Action::SavePrefs
            } else {
                Action::Redraw
            }
        }

        (_, KeyCode::Backspace) => {
            if app.input.cmd_text.is_empty() {
                app.exit_submenu();
            } else {
                app.input.cmd_backspace();
                app.update_completions();
            }
            Action::Redraw
        }

        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(c)) => {
            app.input.cmd_insert_char(c);
            app.update_completions();
            Action::Redraw
        }

        _ => Action::None,
    }
}

fn handle_value_editor_mode(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc) => {
            app.exit_value_editor();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Left) | (KeyModifiers::CONTROL, KeyCode::Char('h')) => {
            app.adjust_value_editor(-1.0);
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Right) | (KeyModifiers::CONTROL, KeyCode::Char('l')) => {
            app.adjust_value_editor(1.0);
            Action::Redraw
        }

        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(c))
            if c.is_ascii_digit() || c == '.' || c == '-' =>
        {
            app.type_value_editor_char(c);
            Action::Redraw
        }

        (_, KeyCode::Backspace) => {
            app.backspace_value_editor();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Enter) => {
            if let Some(cmd) = app.apply_value_editor() {
                parse_command(app, &cmd)
            } else {
                app.set_status("invalid value");
                Action::Redraw
            }
        }

        _ => Action::None,
    }
}

fn handle_alt_picker_mode(app: &mut App, key: KeyEvent) -> Action {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc) => {
            app.cancel_alt_picker();
            Action::Redraw
        }
        (KeyModifiers::CONTROL, KeyCode::Char('j')) | (KeyModifiers::NONE, KeyCode::Down) => {
            app.next_alt();
            Action::Redraw
        }
        (KeyModifiers::CONTROL, KeyCode::Char('k')) | (KeyModifiers::NONE, KeyCode::Up) => {
            app.prev_alt();
            Action::Redraw
        }
        (KeyModifiers::CONTROL, KeyCode::Char('u')) | (KeyModifiers::NONE, KeyCode::PageUp) => {
            app.scroll_up(10);
            Action::Redraw
        }
        (KeyModifiers::CONTROL, KeyCode::Char('d')) | (KeyModifiers::NONE, KeyCode::PageDown) => {
            app.scroll_down(10);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Enter) => {
            let Some(args) = app.selected_alt_command_args() else {
                return Action::Redraw;
            };
            app.close_alt_picker_after_confirm();
            Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                rid: None,
                name: "alt".into(),
                args,
            })))
        }
        _ => Action::None,
    }
}

fn submenu_fetch_action(app: &mut App, parent: &str) -> Action {
    let (name, rid) = match parent {
        "model" => ("list_models", None),
        "character" => ("list_characters", None),
        "setting" => ("model_settings", Some(app.begin_sampler_settings_refresh())),
        "view" => return Action::Redraw,
        _ => return Action::Redraw,
    };
    Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
        rid,
        name: name.into(),
        args: serde_json::json!({}),
    })))
}

const PALETTE_ALIASES: [(&str, &str); 13] = [
    ("regen", "msg regen"),
    ("edit", "msg edit"),
    ("delete", "msg delete"),
    ("alt", "msg alt"),
    ("send", "msg send"),
    ("sys", "msg send --system"),
    ("system", "msg send --system"),
    ("setting", "model setting"),
    ("reasoning", "model setting reasoning_effort"),
    ("characters", "character"),
    ("cancel", "ui cancel"),
    ("help", "ui help"),
    ("image", "ui image"),
];

pub(crate) fn expand_aliases(input: &str) -> String {
    let trimmed = input.trim();
    let (head, rest) = trimmed
        .split_once(char::is_whitespace)
        .unwrap_or((trimmed, ""));
    let Some((_, expansion)) = PALETTE_ALIASES
        .iter()
        .find(|&&(shorthand, _)| shorthand == head)
    else {
        return trimmed.to_owned();
    };
    if rest.trim().is_empty() {
        (*expansion).to_owned()
    } else {
        format!("{expansion} {}", rest.trim())
    }
}

fn parse_command(app: &mut App, input: &str) -> Action {
    let expanded = expand_aliases(input);
    if expanded.is_empty() {
        return Action::Redraw;
    }
    debug!(command = %expanded, "TUI command dispatched");
    dispatch_cli_command(app, &expanded)
}

fn run_view_command(app: &mut App, key: ViewKey, value: Option<&str>) -> Action {
    let raw = value.unwrap_or("toggle");
    let lowered = raw.to_ascii_lowercase();

    match key {
        ViewKey::Usage => {
            let mode = if lowered == "toggle" {
                app.cycle_usage_display()
            } else if let Some(mode) = crate::tui::app::UsageDisplay::from_token(&lowered) {
                app.set_usage_display(mode);
                mode
            } else {
                app.set_error(unusable_view_value(key, raw));
                return Action::Redraw;
            };
            app.update_completions();
            app.set_status(format!("view usage: {}", mode.as_str()));
            Action::SavePrefs
        }

        ViewKey::Budget => {
            let focus = if lowered == "toggle" {
                app.cycle_budget_focus()
            } else if let Some(focus) = crate::tui::app::BudgetFocus::from_token(raw) {
                app.set_budget_focus(focus.clone());
                focus
            } else {
                app.set_error(unusable_view_value(key, raw));
                return Action::Redraw;
            };
            app.update_completions();
            let token = focus.as_token();
            app.set_status(if focus.name.is_some() && app.focused_budget().is_none() {
                format!("view budget: {token} (no such budget reported yet)")
            } else {
                format!("view budget: {token}")
            });
            Action::SavePrefs
        }

        ViewKey::Timestamps
        | ViewKey::Thinking
        | ViewKey::Tools
        | ViewKey::Subagent
        | ViewKey::Images
        | ViewKey::Metadata => {
            let name = key.as_str();
            let enabled = match lowered.as_str() {
                "on" | "true" | "yes" | "1" => {
                    let _ignored = app.set_view_option(name, true);
                    true
                }
                "off" | "false" | "no" | "0" => {
                    let _ignored = app.set_view_option(name, false);
                    false
                }
                "toggle" => app.toggle_view_option(name).unwrap_or(false),
                _ => {
                    app.set_error(unusable_view_value(key, raw));
                    return Action::Redraw;
                }
            };
            app.update_completions();
            app.set_status(format!(
                "view {name}: {}",
                if enabled { "on" } else { "off" }
            ));
            if key == ViewKey::Subagent && enabled {
                Action::SendAndSavePrefs(crate::tui::subagent_trace_fetch(app))
            } else {
                Action::SavePrefs
            }
        }
    }
}

fn unusable_view_value(key: ViewKey, raw: &str) -> String {
    format!(
        "view {} takes {}, not {raw:?}",
        key.as_str(),
        key.values().join(" | ")
    )
}

fn run_ui_command(app: &mut App, command: &UiCommand) -> Action {
    match command {
        UiCommand::Insert { home, end } => {
            if *home {
                app.input.move_home();
            }
            if *end {
                app.input.move_end();
            }
            app.input.mode = InputMode::Insert;
            Action::Redraw
        }

        UiCommand::Normal => {
            app.input.mode = InputMode::Normal;
            Action::Redraw
        }

        UiCommand::Scroll { direction, amount } => {
            let lines = amount.unwrap_or(1);
            match direction {
                ScrollDirection::Up => {
                    app.scroll_up(lines);
                    return redraw_or_load_older_history(app);
                }
                ScrollDirection::Down => app.scroll_down(lines),
                ScrollDirection::Top => {
                    app.scroll_up(u16::MAX);
                    return redraw_or_load_older_history(app);
                }
                ScrollDirection::Bottom => app.scroll_to_bottom(),
            }
            Action::Redraw
        }

        UiCommand::Images => {
            let Some(index) = nearest_image(app) else {
                app.set_status("no images in view");
                return Action::Redraw;
            };
            app.fullscreen = Some(index);
            Action::Redraw
        }

        UiCommand::Subagents => {
            if app.subagent_tasks.is_empty() {
                app.set_status("no background sub-agents yet");
            } else {
                app.open_subagent_panel();
            }
            Action::Redraw
        }

        UiCommand::Editor => Action::OpenInEditor,

        UiCommand::Image { target } => run_ui_image_command(app, target.as_deref()),

        UiCommand::EditCancel => {
            if app.editing_ref.is_some() || app.pending_edit_prefill.is_some() {
                app.editing_ref = None;
                app.cancel_edit_prefill();
                app.input.text.clear();
                app.input.cursor = 0;
                app.set_status("edit cancelled");
            } else {
                app.set_status("no edit in progress");
            }
            Action::Redraw
        }

        UiCommand::Cancel => {
            if app.stream.active {
                app.stream.reset();
                Action::Send(ConnCommand::Send(ClientMessage::Cancel(Cancel {})))
            } else {
                app.set_status("nothing to cancel");
                Action::Redraw
            }
        }

        UiCommand::Help => {
            app.show_help = true;
            Action::Redraw
        }

        UiCommand::Palette { scope } => match scope {
            PaletteScope::Full => {
                app.input.enter_command_mode();
                app.update_completions();
                let commands = palette_catalog_commands(app);
                if commands.is_empty() {
                    Action::Redraw
                } else {
                    Action::SendMulti(commands)
                }
            }
            PaletteScope::Shortcuts | PaletteScope::Config => {
                app.set_status("that palette is not built yet");
                Action::Redraw
            }
        },

        UiCommand::Bind {
            key,
            command: words,
        } => run_bind_command(app, key, &words.join(" ")),

        UiCommand::Unbind { key } => run_unbind_command(app, key),

        UiCommand::Quit => Action::Quit,
    }
}

fn run_bind_command(app: &mut App, key: &str, command: &str) -> Action {
    if let Err(problem) = app.keymap.bind(key, command) {
        app.set_error(problem);
        return Action::Redraw;
    }
    match app.keymap.save() {
        Ok(()) => app.set_status(format!("{key} runs {command}")),
        Err(error) => app.set_error(format!("bound {key} for this session only: {error}")),
    }
    Action::Redraw
}

fn run_unbind_command(app: &mut App, key: &str) -> Action {
    match app.keymap.unbind(key) {
        Err(problem) => {
            app.set_error(problem);
            return Action::Redraw;
        }
        Ok(None) => {
            app.set_status(format!("{key} was not bound"));
            return Action::Redraw;
        }
        Ok(Some(previous)) => {
            if let Err(error) = app.keymap.save() {
                app.set_error(format!("freed {key} for this session only: {error}"));
                return Action::Redraw;
            }
            app.set_status(format!("{key} no longer runs {previous}"));
        }
    }
    Action::Redraw
}

fn run_ui_image_command(app: &mut App, target: Option<&str>) -> Action {
    match target {
        None => Action::PickImage(None),
        Some("paste") => Action::PasteImage,
        Some("clear") => {
            let count = app.pending_images.len();
            app.pending_images.clear();
            app.set_status(format!("cleared {count} pending image(s)"));
            Action::Redraw
        }
        Some(path) => {
            let expanded = match path.strip_prefix('~') {
                Some(tail) if !tail.starts_with(|c: char| c.is_alphanumeric()) => {
                    match std::env::var("HOME") {
                        Ok(home) => format!("{home}{tail}"),
                        Err(_) => path.to_owned(),
                    }
                }
                _ => path.to_owned(),
            };
            let resolved = if std::path::Path::new(&expanded).is_absolute() {
                expanded
            } else {
                std::env::current_dir()
                    .map(|dir| dir.join(&expanded).to_string_lossy().into_owned())
                    .unwrap_or(expanded)
            };
            if std::path::Path::new(&resolved).exists() {
                app.pending_images.push(resolved);
                app.set_status(format!(
                    "attached image ({} pending)",
                    app.pending_images.len()
                ));
            } else {
                app.set_error(format!("file not found: {resolved}"));
            }
            Action::Redraw
        }
    }
}

fn nearest_image(app: &App) -> Option<usize> {
    if app.image_index.is_empty() {
        return None;
    }
    let term_height = crossterm::terminal::size().map_or(24, |(_, height)| height);
    let visible = usize::from(
        term_height
            .saturating_mul(80)
            .checked_div(100)
            .unwrap_or(1)
            .max(1),
    );
    let last_line = app.image_index.last().map_or(0, |entry| entry.line);
    let total = last_line.saturating_add(visible);
    let half = visible.checked_div(2).unwrap_or_default();
    let center = if app.auto_scroll {
        total.saturating_sub(half)
    } else {
        total
            .saturating_sub(usize::from(app.scroll_offset))
            .saturating_sub(half)
    };
    app.image_index
        .iter()
        .enumerate()
        .min_by_key(|(_, entry)| entry.line.abs_diff(center))
        .map(|(index, _)| index)
}

fn send_user_message(app: &mut App, text: String, images: Vec<String>) -> Action {
    if text.trim().is_empty() && images.is_empty() {
        return Action::Redraw;
    }

    let mut image_uploads: Vec<shore_common::protocol::client_msg::ImageUpload> = Vec::new();
    let mut image_refs: Vec<shore_common::protocol::types::ImageRef> = Vec::new();
    for path in &images {
        match std::fs::read(path) {
            Ok(bytes) => {
                use base64::Engine;
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let filename = std::path::Path::new(path).file_name().map_or_else(
                    || "image".to_owned(),
                    |file| file.to_string_lossy().to_string(),
                );
                image_refs.push(shore_common::protocol::types::ImageRef {
                    path: path.clone(),
                    caption: None,
                    data: Some(data.clone()),
                });
                image_uploads.push(shore_common::protocol::client_msg::ImageUpload {
                    filename,
                    data,
                    mime_type: None,
                });
            }
            Err(error) => app.set_error(format!("failed to read image: {error}")),
        }
    }

    app.dismiss_notifications();
    app.entries.push(crate::tui::app::ConversationEntry::user(
        text.clone(),
        image_refs,
        String::new(),
    ));
    app.scroll_to_bottom();
    app.stream.active = true;
    Action::Send(ConnCommand::Send(ClientMessage::Message(
        ClientMessageBody {
            rid: None,
            text,
            stream: true,
            images,
            image_data: image_uploads,
            absence_seconds: None,
        },
    )))
}

fn palette_swp_command(
    app: &mut App,
    label: &str,
    name: impl Into<String>,
    args: serde_json::Value,
) -> Action {
    let rid = app.begin_palette_command(label);
    Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
        rid: Some(rid),
        name: name.into(),
        args,
    })))
}

fn dispatch_cli_command(app: &mut App, input: &str) -> Action {
    if shlex::split(input).is_some_and(|words| {
        words.iter().any(|word| {
            matches!(word.as_str(), "--addr" | "--character" | "-c")
                || word.starts_with("--addr=")
                || word.starts_with("--character=")
        })
    }) {
        app.set_error("the TUI is already attached to a daemon and character; switch with `character use` instead");
        return Action::Redraw;
    }
    let command = match crate::cli::parse_palette_command(input) {
        Ok(command) => command,
        Err(error) => {
            let message = error
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("invalid command")
                .trim();
            app.set_error(message.to_owned());
            return Action::Redraw;
        }
    };

    if let CliCommand::View { key, value } = &command {
        return run_view_command(app, *key, value.as_deref());
    }
    if let CliCommand::Ui { command: ui } = &command {
        return run_ui_command(app, ui);
    }

    match &command {
        CliCommand::Completions { .. } | CliCommand::Complete { .. } => {
            app.set_error("shell completion generation is a terminal-only CLI operation");
            return Action::Redraw;
        }
        CliCommand::Status {
            section: Some(section),
            ..
        } if !app.palette_catalog.status_sections.is_empty()
            && !app
                .palette_catalog
                .status_sections
                .iter()
                .any(|candidate| candidate.value == *section) =>
        {
            app.set_error(format!("no status section named {section:?}"));
            return Action::Redraw;
        }
        CliCommand::Log {
            reasoning,
            tools,
            subagent_tools,
            follow,
            ..
        } => {
            if *reasoning {
                app.show_thinking = true;
            }
            if *tools {
                app.show_tools = true;
            }
            if *subagent_tools {
                app.show_subagent = true;
            }
            if *follow {
                app.set_status("the TUI already follows this conversation live");
            }
        }
        CliCommand::Msg { .. }
        | CliCommand::Compact { .. }
        | CliCommand::Segments { .. }
        | CliCommand::Clear { .. }
        | CliCommand::Trace { .. }
        | CliCommand::Character { .. }
        | CliCommand::Status { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Config { .. }
        | CliCommand::Usage { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. } => {}
    }

    if let Some(prompt) = palette_confirmation_prompt(&command)
        && app.confirmed_palette_command.as_deref() != Some(input)
    {
        app.palette_confirmation = Some(crate::tui::app::PaletteConfirmation {
            command: input.to_owned(),
            prompt,
        });
        app.input.mode = InputMode::Command;
        return Action::Redraw;
    }
    if app.confirmed_palette_command.as_deref() == Some(input) {
        app.confirmed_palette_command = None;
    }

    match &command {
        CliCommand::Msg {
            command:
                MsgCommand::Send {
                    message,
                    images,
                    system: false,
                },
        } => send_user_message(app, message.join(" "), images.clone()),
        CliCommand::Msg {
            command:
                MsgCommand::Send {
                    message,
                    system: true,
                    ..
                },
        } => palette_swp_command(
            app,
            input,
            "inject_system",
            serde_json::json!({ "text": message.join(" ") }),
        ),
        CliCommand::Msg {
            command: MsgCommand::Edit {
                msg_ref, content, ..
            },
        } if content.is_empty() => {
            let rid = app.begin_edit_prefill(msg_ref);
            app.set_status(format!("loading {msg_ref}..."));
            Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                rid: Some(rid),
                name: "get".into(),
                args: serde_json::json!({ "ref": msg_ref }),
            })))
        }
        CliCommand::Msg {
            command: MsgCommand::Regen,
        } => {
            app.begin_regen_optimistic();
            Action::Send(ConnCommand::Send(ClientMessage::Regen(Regen {
                rid: None,
                stream: true,
            })))
        }
        CliCommand::Msg {
            command: MsgCommand::Alt {
                selector, msg_ref, ..
            },
        } if selector.as_deref().is_none_or(|value| value == "list") => {
            let target_ref = msg_ref.clone();
            app.start_alt_picker(target_ref.clone());
            let mut args = serde_json::Map::new();
            if let Some(selected_ref) = target_ref {
                let _ = args.insert("ref".into(), serde_json::json!(selected_ref));
            }
            Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                rid: None,
                name: "list_alternatives".into(),
                args: serde_json::Value::Object(args),
            })))
        }
        CliCommand::Character {
            subcommand: None,
            info: false,
            ..
        } => palette_swp_command(app, input, "list_characters", serde_json::json!({})),
        CliCommand::Character {
            subcommand: Some(CharacterCommand::Use { name }),
            ..
        } => palette_swp_command(
            app,
            input,
            "switch_character",
            serde_json::json!({ "name": name }),
        ),
        CliCommand::Character {
            subcommand: Some(CharacterCommand::New { name }),
            ..
        } => palette_swp_command(
            app,
            input,
            "create_character",
            serde_json::json!({ "name": name }),
        ),
        CliCommand::Config { path: true, .. } => {
            palette_swp_command(app, input, "status", serde_json::json!({}))
        }
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Reload { .. }),
            ..
        } => palette_swp_command(app, input, "config_reload", serde_json::json!({})),
        CliCommand::Trace { subcommand: None } => {
            app.set_status("usage: :trace [calls|heartbeat|events|errors|subagent]");
            Action::Redraw
        }
        CliCommand::Debug { subcommand: None } => {
            app.set_status("usage: :debug <command> (type `debug ` to browse)");
            Action::Redraw
        }
        CliCommand::Model {
            subcommand: None,
            json,
            ..
        } => {
            app.show_model_list = !json;
            let Some((name, args)) =
                crate::cli::to_swp_command(&command, Some(&app.character_name))
            else {
                app.set_error("model command is not available in the TUI");
                return Action::Redraw;
            };
            palette_swp_command(app, input, name, args)
        }
        CliCommand::Msg { .. }
        | CliCommand::Log { .. }
        | CliCommand::Compact { .. }
        | CliCommand::Segments { .. }
        | CliCommand::Clear { .. }
        | CliCommand::Trace { .. }
        | CliCommand::Character { .. }
        | CliCommand::Status { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Config { .. }
        | CliCommand::Usage { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. } => {
            let Some((name, args)) =
                crate::cli::to_swp_command(&command, Some(&app.character_name))
            else {
                app.set_error(format!("command is not available in the TUI: {input}"));
                return Action::Redraw;
            };
            palette_swp_command(app, input, name, args)
        }
    }
}

#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "only a deliberately small subset of commands needs confirmation"
)]
fn palette_confirmation_prompt(command: &CliCommand) -> Option<String> {
    match command {
        CliCommand::Msg {
            command: MsgCommand::Delete { msg_refs, .. },
        } => Some(format!(
            "Delete {} conversation {}?",
            msg_refs.len(),
            if msg_refs.len() == 1 {
                "entry"
            } else {
                "entries"
            }
        )),
        CliCommand::Msg {
            command: MsgCommand::Edit {
                msg_ref, content, ..
            },
        } if !content.is_empty() => Some(format!("Replace the content of message {msg_ref:?}?")),
        CliCommand::Compact { .. } => {
            Some("Summarize and archive older conversation turns?".to_owned())
        }
        CliCommand::Clear { .. } => Some("Archive and clear the active conversation?".to_owned()),
        CliCommand::Character {
            subcommand: Some(CharacterCommand::New { name }),
            ..
        } => Some(format!("Create character workspace {name:?}?")),
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Set { key, .. }),
            ..
        } => Some(format!("Write setting {key:?} to the config?")),
        CliCommand::Debug {
            subcommand:
                Some(crate::cli::DebugCommand::Tool {
                    name,
                    describe: false,
                    ..
                }),
        } => Some(format!("Run tool {name:?}? Its side effects are real.")),
        CliCommand::Debug {
            subcommand: Some(crate::cli::DebugCommand::Subagent { name, .. }),
        } => Some(format!("Run sub-agent {name:?}? This spends tokens.")),
        CliCommand::Debug {
            subcommand: Some(_),
        } => Some("Run this daemon debug operation now?".to_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEventKind, KeyEventState};

    fn sent_command(action: Action) -> Command {
        let Action::Send(ConnCommand::Send(ClientMessage::Command(command))) = action else {
            panic!("expected command send");
        };
        command
    }

    fn make_key(modifiers: KeyModifiers, code: KeyCode) -> KeyEvent {
        KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }

    #[test]
    fn view_usage_command_sets_and_cycles_mode() {
        use crate::tui::app::UsageDisplay;
        let mut app = App::default();
        assert_eq!(app.usage_display, UsageDisplay::Off);

        let _ = parse_command(&mut app, "view usage warn");
        assert_eq!(app.usage_display, UsageDisplay::Warn);
        let _ = parse_command(&mut app, "view usage always");
        assert_eq!(app.usage_display, UsageDisplay::Always);
        let _ = parse_command(&mut app, "view usage off");
        assert_eq!(app.usage_display, UsageDisplay::Off);

        let _ = parse_command(&mut app, "view usage on");
        assert_eq!(app.usage_display, UsageDisplay::Always);
        let _ = parse_command(&mut app, "view usage toggle");
        assert_eq!(app.usage_display, UsageDisplay::Warn);
        let _ = parse_command(&mut app, "view usage toggle");
        assert_eq!(app.usage_display, UsageDisplay::Off);

        let _ = parse_command(&mut app, "view usage sometimes");
        assert_eq!(app.usage_display, UsageDisplay::Off);
    }

    #[test]
    fn view_budget_command_pins_and_cycles_focus() {
        use crate::tui::app::{BudgetFocus, UsageBudget};
        let mut app = App {
            usage_budgets: vec![UsageBudget {
                name: "brainwife".into(),
                ..UsageBudget::default()
            }],
            ..App::default()
        };
        assert_eq!(app.budget_focus, BudgetFocus::default());

        let _ = parse_command(&mut app, "view budget pace");
        assert_eq!(app.budget_focus.as_token(), "pace");
        let _ = parse_command(&mut app, "view budget cap");
        assert_eq!(app.budget_focus.as_token(), "cap");

        let _ = parse_command(&mut app, "view budget brainwife:pace");
        assert_eq!(app.budget_focus.as_token(), "brainwife:pace");
        let _ = parse_command(&mut app, "view budget brainwife");
        assert_eq!(app.budget_focus.as_token(), "brainwife");

        let _ = parse_command(&mut app, "view budget auto");
        assert_eq!(app.budget_focus, BudgetFocus::default());
        let _ = parse_command(&mut app, "view budget toggle");
        assert_eq!(app.budget_focus.as_token(), "cap");

        let _ = parse_command(&mut app, "view budget brainwife:yearly");
        assert_eq!(app.budget_focus.as_token(), "cap");
    }

    #[test]
    fn ctrl_c_interrupts() {
        let mut app = App::default();
        let action = handle_key(
            &mut app,
            make_key(KeyModifiers::CONTROL, KeyCode::Char('c')),
        );
        assert!(matches!(action, Action::Interrupt));
    }

    #[test]
    fn ctrl_c_still_interrupts_during_stream() {
        let mut app = App::default();
        app.stream.active = true;
        let action = handle_key(
            &mut app,
            make_key(KeyModifiers::CONTROL, KeyCode::Char('c')),
        );
        assert!(
            matches!(action, Action::Interrupt),
            "Ctrl+C must not be overloaded with cancel"
        );
    }

    #[test]
    fn alt_c_cancels_active_stream() {
        let mut app = App::default();
        app.stream.active = true;
        let action = handle_key(&mut app, make_key(KeyModifiers::ALT, KeyCode::Char('c')));
        assert!(matches!(
            action,
            Action::Send(ConnCommand::Send(ClientMessage::Cancel(_)))
        ));
        assert!(!app.stream.active, "stream state should be reset on cancel");
    }

    #[test]
    fn alt_c_is_noop_without_stream() {
        let mut app = App::default();
        assert!(!app.stream.active);
        let action = handle_key(&mut app, make_key(KeyModifiers::ALT, KeyCode::Char('c')));
        assert!(matches!(action, Action::None));
    }

    #[test]
    fn esc_in_insert_does_not_cancel_stream() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        app.stream.active = true;
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Esc));
        assert!(matches!(action, Action::Redraw));
        assert_eq!(app.input.mode, InputMode::Normal);
        assert!(
            app.stream.active,
            "Escape from insert must not cancel a generation"
        );
    }

    #[test]
    fn cancel_command_sends_cancel_when_streaming() {
        let mut app = App::default();
        app.stream.active = true;
        assert!(matches!(
            parse_command(&mut app, "cancel"),
            Action::Send(ConnCommand::Send(ClientMessage::Cancel(_)))
        ));
        assert!(!app.stream.active);
    }

    #[test]
    fn insert_mode_enter_sends() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        for c in "hello".chars() {
            app.input.insert_char(c);
        }
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Enter));
        assert!(matches!(action, Action::Send(_)));
    }

    #[test]
    fn insert_mode_empty_enter_is_noop() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Enter));
        assert!(matches!(action, Action::None));
    }

    #[test]
    fn normal_mode_i_enters_insert() {
        let mut app = App::default();
        app.input.mode = InputMode::Normal;
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Char('i')));
        assert!(matches!(action, Action::Redraw));
        assert_eq!(app.input.mode, InputMode::Insert);
    }

    #[test]
    fn esc_returns_to_normal() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Esc));
        assert!(matches!(action, Action::Redraw));
        assert_eq!(app.input.mode, InputMode::Normal);
    }

    #[test]
    fn normal_mode_r_regens() {
        let mut app = App::default();
        app.input.mode = InputMode::Normal;
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Char('r')));
        assert!(matches!(action, Action::Send(_)));
    }

    #[test]
    fn view_command_toggles_local_option() {
        let mut app = App::default();
        assert!(!app.show_timestamps);

        let timestamps_action = parse_command(&mut app, "view timestamps on");
        assert!(matches!(timestamps_action, Action::SavePrefs));
        assert!(app.show_timestamps);

        let metadata_action = parse_command(&mut app, "view metadata off");
        assert!(matches!(metadata_action, Action::SavePrefs));
        assert!(!app.show_metadata);
    }

    #[test]
    fn toggle_keys_persist_prefs() {
        let mut app = App::default();
        app.input.mode = InputMode::Normal;
        let before = app.show_thinking;
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Char('t')));
        assert!(matches!(action, Action::SavePrefs));
        assert_eq!(app.show_thinking, !before);
    }

    #[test]
    fn view_submenu_toggle_persists_prefs() {
        let mut app = App::default();
        app.input.mode = InputMode::Command;
        app.enter_submenu("view");
        assert!(app.is_view_submenu());
        assert!(!app.completion.candidates.is_empty());

        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Enter));
        assert!(matches!(action, Action::SavePrefs));
    }

    #[test]
    fn scroll_shortcuts() {
        let mut app = App::default();
        app.input.mode = InputMode::Normal;
        let _ = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Char('k')));
        assert_eq!(app.scroll_offset, 1);
        let _ = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Char('j')));
        assert_eq!(app.scroll_offset, 0);
    }

    #[test]
    fn scroll_top_requests_older_history_page() {
        let mut app = App::default();
        app.input.mode = InputMode::Normal;
        app.history_has_more_before = true;
        app.conversation_max_scroll = 1;

        let cmd = sent_command(handle_key(
            &mut app,
            make_key(KeyModifiers::NONE, KeyCode::Char('k')),
        ));
        assert_eq!(cmd.name, "history_page");
        assert_eq!(cmd.args.get("before"), Some(&serde_json::json!("active")));
        assert_eq!(
            cmd.args.get("turns"),
            Some(&serde_json::json!(HISTORY_PAGE_TURNS))
        );
        assert!(app.history_page_loading);
    }

    #[test]
    fn shift_enter_inserts_newline() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        for c in "line1".chars() {
            app.input.insert_char(c);
        }
        let _ = handle_key(&mut app, make_key(KeyModifiers::SHIFT, KeyCode::Enter));
        assert!(app.input.text.contains('\n'));
    }

    #[test]
    fn character_command_sends_single_switch_request() {
        let mut app = App::default();
        let cmd = sent_command(parse_command(&mut app, "character use Bob"));
        assert_eq!(cmd.name, "switch_character");
        assert_eq!(cmd.args.get("name"), Some(&serde_json::json!("Bob")));
    }

    #[test]
    fn tab_completion_enters_submenu_parent() {
        let mut app = App::default();
        app.input.enter_command_mode();
        for c in "chara".chars() {
            app.input.cmd_insert_char(c);
        }
        app.update_completions();

        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Tab));
        assert!(
            matches!(app.completion.mode, PaletteMode::Submenu(_)),
            "Tab on a submenu parent should enter the child picker"
        );
        assert_eq!(app.input.cmd_text, "");
        let cmd = sent_command(action);
        assert_eq!(cmd.name, "list_characters");
    }

    #[test]
    fn cli_commands_are_discoverable_and_use_the_shared_wire_adapter() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.update_completions();
        for expected in ["provider", "segments", "status", "usage", "trace", "config"] {
            assert!(
                app.completion
                    .candidates
                    .iter()
                    .any(|candidate| candidate == expected),
                "{expected} should be exposed by the shared CLI catalog"
            );
        }

        app.input.cmd_text = "provider ".into();
        app.input.cmd_cursor = app.input.cmd_text.len();
        app.update_completions();
        assert!(
            app.completion
                .candidates
                .iter()
                .any(|candidate| candidate == "provider refresh"),
            "nested CLI subcommands should be browsable"
        );

        let cmd = sent_command(parse_command(&mut app, "provider refresh openai"));
        assert_eq!(cmd.name, "refresh_provider_models");
        assert_eq!(cmd.args.get("provider"), Some(&serde_json::json!("openai")));
        let rid = cmd.rid.expect("palette CLI commands carry a request id");
        assert_eq!(
            app.pending_palette_commands.get(&rid).map(String::as_str),
            Some("provider refresh openai")
        );
    }

    #[test]
    fn shared_cli_parser_preserves_quoted_arguments() {
        let mut app = App::default();
        let cmd = sent_command(parse_command(
            &mut app,
            "segments note 3 'important context'",
        ));
        assert_eq!(cmd.name, "segments");
        assert_eq!(cmd.args.get("action"), Some(&serde_json::json!("note")));
        assert_eq!(cmd.args.get("index"), Some(&serde_json::json!(3)));
        assert_eq!(
            cmd.args.get("value"),
            Some(&serde_json::json!("important context"))
        );
    }

    #[test]
    fn side_effectful_cli_commands_require_an_explicit_tui_confirmation() {
        let mut app = App::default();
        let action = parse_command(&mut app, "config set defaults.stream false");
        assert!(matches!(action, Action::Redraw));
        assert_eq!(
            app.palette_confirmation
                .as_ref()
                .map(|confirmation| confirmation.command.as_str()),
            Some("config set defaults.stream false")
        );
        assert_eq!(app.input.mode, InputMode::Command);
        assert!(
            !app.palette_confirmation
                .as_ref()
                .is_some_and(|confirmation| confirmation.prompt.contains("false")),
            "confirmation copy must not echo config values because they may be secrets"
        );

        let sent = sent_command(handle_palette_confirmation(
            &mut app,
            make_key(KeyModifiers::NONE, KeyCode::Enter),
        ));
        assert_eq!(sent.name, "config");
        assert_eq!(
            sent.args.get("key"),
            Some(&serde_json::json!("defaults.stream"))
        );
        assert_eq!(sent.args.get("value"), Some(&serde_json::json!("false")));
    }

    #[test]
    fn updated_character_and_model_cli_grammar_is_not_shadowed_by_tui_aliases() {
        let mut app = App {
            confirmed_palette_command: Some("character new Ada".into()),
            ..App::default()
        };
        let create = sent_command(parse_command(&mut app, "character new Ada"));
        assert_eq!(create.name, "create_character");
        assert_eq!(create.args.get("name"), Some(&serde_json::json!("Ada")));

        let switch = sent_command(parse_command(&mut app, "model use opus"));
        assert_eq!(switch.name, "switch_model");
        assert_eq!(switch.args.get("name"), Some(&serde_json::json!("opus")));

        app.confirmed_palette_command = Some("compact 4 --restart".into());
        let compact = sent_command(parse_command(&mut app, "compact 4 --restart"));
        assert_eq!(compact.name, "compact");
        assert_eq!(compact.args.get("keep_turns"), Some(&serde_json::json!(4)));
        assert_eq!(compact.args.get("restart"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn delete_command_sends_single_delete_request() {
        let mut app = App::default();
        assert!(
            matches!(parse_command(&mut app, "delete last"), Action::Redraw),
            "deleting a message should ask first"
        );
        app.palette_confirmation = None;
        app.confirmed_palette_command = Some("msg delete last".into());
        let cmd = sent_command(parse_command(&mut app, "delete last"));
        assert_eq!(cmd.name, "delete");
        assert_eq!(cmd.args.get("refs"), Some(&serde_json::json!(["last"])));
    }

    #[test]
    fn edit_command_asks_the_daemon_to_resolve_the_ref() {
        let mut app = App::default();
        let cmd = sent_command(parse_command(&mut app, "edit 3"));
        assert_eq!(cmd.name, "get");
        assert_eq!(cmd.args.get("ref"), Some(&serde_json::json!("3")));
        assert!(cmd.rid.is_some());
        assert!(app.editing_ref.is_none());
        assert!(app.pending_edit_prefill.is_some());
    }

    #[test]
    fn edit_cancel_drops_a_prefill_still_in_flight() {
        let mut app = App::default();
        let _ = parse_command(&mut app, "edit 3");

        let action = parse_command(&mut app, "ui edit-cancel");

        assert!(matches!(action, Action::Redraw));
        assert!(app.pending_edit_prefill.is_none());
        assert!(
            app.notifications
                .iter()
                .any(|n| n.content == "edit cancelled"),
            "cancelling an in-flight prefill should say so"
        );
    }

    #[test]
    fn alt_command_sends_list_request_and_opens_picker() {
        let mut app = App::default();
        let cmd = sent_command(parse_command(&mut app, "alt"));
        assert_eq!(cmd.name, "list_alternatives");
        assert!(cmd.args.as_object().unwrap().is_empty());
        assert!(app.alt_picker.is_some());
    }

    #[test]
    fn alt_command_accepts_message_ref() {
        let mut app = App::default();
        let cmd = sent_command(parse_command(&mut app, "alt --ref -2"));
        assert_eq!(cmd.name, "list_alternatives");
        assert_eq!(cmd.args.get("ref"), Some(&serde_json::json!("-2")));
    }

    #[test]
    fn ctrl_v_returns_paste_image_in_insert_mode() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        let action = handle_key(
            &mut app,
            make_key(KeyModifiers::CONTROL, KeyCode::Char('v')),
        );
        assert!(matches!(action, Action::PasteImage));
    }

    #[test]
    fn ctrl_v_returns_paste_image_in_normal_mode() {
        let mut app = App::default();
        app.input.mode = InputMode::Normal;
        let action = handle_key(
            &mut app,
            make_key(KeyModifiers::CONTROL, KeyCode::Char('v')),
        );
        assert!(matches!(action, Action::PasteImage));
    }

    #[test]
    fn ctrl_v_returns_paste_image_in_command_mode() {
        let mut app = App::default();
        app.input.enter_command_mode();
        let action = handle_key(
            &mut app,
            make_key(KeyModifiers::CONTROL, KeyCode::Char('v')),
        );
        assert!(matches!(action, Action::PasteImage));
    }

    #[test]
    fn user_send_clears_toasts() {
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        app.set_status("reconnecting: connection lost");
        app.set_status("connected");
        assert_eq!(app.notifications.len(), 2);
        for c in "hi".chars() {
            app.input.insert_char(c);
        }
        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Enter));
        assert!(matches!(action, Action::Send(_)));
        assert!(app.notifications.is_empty());
        assert!(app.entries.iter().any(|e| matches!(
            e.as_turn(),
            Some(t) if t.role == shore_common::protocol::types::Role::User
        )));
    }
}
