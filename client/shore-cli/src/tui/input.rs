use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use shore_common::protocol::client_msg::{
    Cancel, ClientMessage, ClientMessageBody, Command, Regen,
};
use shore_common::protocol::operations::{ConfigReloadArgs, Operation, ReloadConfiguration};
use tracing::debug;

use crate::cli::{
    CharacterCommand, CliCommand, ConfigCommand, MsgCommand, PaletteScope, ScrollDirection,
    SegmentTarget, SegmentsCommand, ThreadCommand, ThreadStep, UiCommand, ViewKey,
};
use crate::tui::app::{App, ConversationEntry, InputMode, PaletteMode, SegmentRequest};
use crate::tui::connection::ConnCommand;
use crate::tui::keymap::{Scope, key_token};

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
        Event::FocusGained => {
            app.focused = true;
            Action::None
        }
        Event::FocusLost => {
            app.focused = false;
            Action::None
        }
        Event::Mouse(_) => Action::None,
    }
}

fn handle_paste(app: &mut App, text: &str) -> Action {
    if app.show_help
        || app.fullscreen.is_some()
        || app.subagent_panel.is_some()
        || app.alt_picker.is_some()
        || app.palette_confirmation.is_some()
        || (app.output_pager.is_some() && app.input.mode != InputMode::Command)
    {
        return Action::None;
    }
    if app.input.mode == InputMode::Command {
        if app.is_value_editor_open() {
            for c in text
                .chars()
                .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            {
                app.type_value_editor_char(c);
            }
        } else {
            for c in text.chars() {
                app.input
                    .cmd_insert_char(if c.is_control() { ' ' } else { c });
            }
            app.update_completions();
        }
    } else {
        app.input.mode = InputMode::Insert;
        app.input.insert_str(text);
    }
    Action::Redraw
}

fn handle_key(app: &mut App, key: KeyEvent) -> Action {
    if app.show_help {
        return handle_help_overlay(app, key);
    }

    if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('c') {
        return Action::Interrupt;
    }

    if let Some(command) = key_token(key)
        .and_then(|token| app.keymap.lookup(Scope::Global, &token))
        .map(|binding| binding.command.clone())
    {
        return dispatch_cli_command(app, &command);
    }

    if app.output_pager.is_some() && app.input.mode != InputMode::Command {
        return handle_output_pager(app, key);
    }

    if app.fullscreen.is_some() {
        return handle_fullscreen(app, key);
    }

    if app.subagent_panel.is_some() {
        return handle_subagent_panel(app, key);
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

fn handle_help_overlay(app: &mut App, key: KeyEvent) -> Action {
    match key.code {
        KeyCode::Down | KeyCode::Char('j') => {
            app.help_scroll = app.help_scroll.saturating_add(1);
        }
        KeyCode::PageDown => {
            app.help_scroll = app.help_scroll.saturating_add(10);
        }
        KeyCode::Up | KeyCode::Char('k') => {
            app.help_scroll = app.help_scroll.saturating_sub(1);
        }
        KeyCode::PageUp => {
            app.help_scroll = app.help_scroll.saturating_sub(10);
        }
        KeyCode::Home => app.help_scroll = 0,
        KeyCode::Backspace
        | KeyCode::Enter
        | KeyCode::Left
        | KeyCode::Right
        | KeyCode::End
        | KeyCode::Tab
        | KeyCode::BackTab
        | KeyCode::Delete
        | KeyCode::Insert
        | KeyCode::F(_)
        | KeyCode::Char(_)
        | KeyCode::Null
        | KeyCode::Esc
        | KeyCode::CapsLock
        | KeyCode::ScrollLock
        | KeyCode::NumLock
        | KeyCode::PrintScreen
        | KeyCode::Pause
        | KeyCode::Menu
        | KeyCode::KeypadBegin
        | KeyCode::Media(_)
        | KeyCode::Modifier(_) => {
            app.show_help = false;
            app.help_scroll = 0;
        }
    }
    Action::Redraw
}

fn redraw_or_load_earlier_in_segment(app: &mut App) -> Action {
    let Some(view) = &app.segment_view else {
        return Action::Redraw;
    };
    if app.pending_segment_page.is_some() || !view.has_more_before {
        return Action::Redraw;
    }
    if app.scroll_offset < app.conversation_max_scroll.saturating_sub(2) {
        return Action::Redraw;
    }
    let args = serde_json::json!({
        "segment": view.summary.index,
        "before": view.next_before,
        "turns": HISTORY_PAGE_TURNS,
    });
    Action::Send(segment_page_request(app, SegmentRequest::Earlier, args))
}

fn segment_page_request(
    app: &mut App,
    request: SegmentRequest,
    args: serde_json::Value,
) -> ConnCommand {
    let rid = app.next_request_id("history_page");
    app.pending_segment_page = Some((rid.clone(), request));
    ConnCommand::Send(ClientMessage::Command(Command {
        rid: Some(rid),
        name: "history_page".into(),
        args,
    }))
}

pub(crate) fn refresh_segment_neighbours(app: &mut App) -> Option<ConnCommand> {
    let index = app.segment_view.as_ref()?.summary.index;
    if matches!(app.pending_segment_page, Some((_, SegmentRequest::Open))) {
        return None;
    }
    let args = serde_json::json!({ "segment": index, "count": 0 });
    Some(segment_page_request(app, SegmentRequest::Neighbours, args))
}

fn open_segment(app: &mut App, index: u64) -> Action {
    let args = serde_json::json!({ "segment": index, "turns": HISTORY_PAGE_TURNS });
    Action::Send(segment_page_request(app, SegmentRequest::Open, args))
}

fn run_segment_command(app: &mut App, target: SegmentTarget) -> Action {
    match target {
        SegmentTarget::Older => {
            let previous = app
                .segment_view
                .as_ref()
                .map_or(app.previous_segment.as_ref(), |view| view.previous.as_ref())
                .map(|summary| summary.index);
            if let Some(index) = previous {
                return open_segment(app, index);
            }
            app.set_status(if app.segment_view.is_some() {
                "this is the first segment"
            } else {
                "nothing before the current context"
            });
        }
        SegmentTarget::Newer => match app
            .segment_view
            .as_ref()
            .map(|view| view.next.as_ref().map(|summary| summary.index))
        {
            Some(Some(index)) => return open_segment(app, index),
            Some(None) => {
                let _closed = app.close_segment_view();
                app.set_status("back in the current context");
            }
            None => app.set_status("already in the current context"),
        },
        SegmentTarget::Current => {
            let closed = app.close_segment_view();
            app.set_status(if closed {
                "back in the current context"
            } else {
                "already in the current context"
            });
        }
        SegmentTarget::Index(index) => return open_segment(app, u64::from(index)),
    }
    Action::Redraw
}

fn segment_to_open(command: &CliCommand) -> Option<u64> {
    if let CliCommand::Segments {
        subcommand: Some(SegmentsCommand::Show { index }),
        ..
    } = command
    {
        return Some(u64::from(*index));
    }
    if let CliCommand::Log {
        segment: Some(index),
        msg_ref: None,
        ..
    } = command
    {
        return Some(u64::from(*index));
    }
    None
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
        .and_then(|token| app.keymap.lookup(Scope::Normal, &token))
        .map(|binding| binding.command.clone())
    else {
        return Action::None;
    };
    dispatch_cli_command(app, &command)
}

fn open_palette(app: &mut App, scope: PaletteScope) -> Action {
    app.input.enter_command_mode();
    app.completion.scope = scope;
    app.update_completions();
    let commands = palette_catalog_commands(app);
    if commands.is_empty() {
        Action::Redraw
    } else {
        Action::SendMulti(commands)
    }
}

fn palette_catalog_commands(app: &mut App) -> Vec<ConnCommand> {
    if app.palette_catalog_loaded || !app.pending_palette_catalog.is_empty() {
        return Vec::new();
    }
    app.palette_catalog_loaded = true;
    [
        ("models", "list_models"),
        ("threads", "list_threads"),
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

fn handle_output_pager(app: &mut App, key: KeyEvent) -> Action {
    let page = app
        .output_pager
        .as_ref()
        .map_or(1, |pager| i32::from(pager.viewport).max(1));

    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc | KeyCode::Char('q')) => {
            app.output_pager = None;
            Action::Redraw
        }
        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(':')) => run_ui_command(
            app,
            &UiCommand::Palette {
                scope: PaletteScope::Full,
            },
        ),
        (KeyModifiers::NONE, KeyCode::Char('/')) => run_ui_command(
            app,
            &UiCommand::Palette {
                scope: PaletteScope::Shortcuts,
            },
        ),
        (KeyModifiers::CONTROL, KeyCode::Char('p')) => run_ui_command(
            app,
            &UiCommand::Palette {
                scope: PaletteScope::Config,
            },
        ),
        (KeyModifiers::NONE, KeyCode::Char('j') | KeyCode::Down) => {
            app.scroll_output_pager(1);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('k') | KeyCode::Up) => {
            app.scroll_output_pager(-1);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('d') | KeyCode::PageDown) => {
            app.scroll_output_pager(page);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('u') | KeyCode::PageUp) => {
            app.scroll_output_pager(page.saturating_neg());
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('g') | KeyCode::Home) => {
            app.scroll_output_pager(i32::MIN);
            Action::Redraw
        }
        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char('G'))
        | (KeyModifiers::NONE, KeyCode::End) => {
            app.scroll_output_pager(i32::MAX);
            Action::Redraw
        }
        _ => Action::None,
    }
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
                app.input.set_text(String::new());
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
                return Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,

                    name: "edit".into(),
                    args: serde_json::json!({ "ref": edit_ref, "content": text }),
                })));
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
            redraw_or_load_earlier_in_segment(app)
        }
        (KeyModifiers::CONTROL, KeyCode::Char('d')) => {
            app.scroll_down(10);
            Action::Redraw
        }

        (KeyModifiers::CONTROL, KeyCode::Char('g')) => Action::OpenInEditor,

        (KeyModifiers::CONTROL, KeyCode::Char('z')) => {
            if !app.input.undo() {
                app.set_status("nothing left to undo");
            }
            Action::Redraw
        }
        (KeyModifiers::CONTROL, KeyCode::Char('y')) => {
            if !app.input.redo() {
                app.set_status("nothing to redo");
            }
            Action::Redraw
        }

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
            Action::Redraw
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
            Action::Redraw
        }

        (KeyModifiers::CONTROL, KeyCode::Char('k')) | (KeyModifiers::NONE, KeyCode::Up) => {
            app.prev_completion();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Enter) if app.completion.scope == PaletteScope::Shortcuts => {
            run_selected_shortcut(app)
        }

        (KeyModifiers::NONE, KeyCode::Enter) => {
            let committed_completion = app.completion.selected.is_some();
            if committed_completion {
                app.apply_completion();
                app.update_completions();
            }
            let trimmed = app.input.cmd_text.trim().to_owned();
            if committed_completion
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

fn run_selected_shortcut(app: &mut App) -> Action {
    let chosen = app
        .completion
        .selected
        .and_then(|index| app.completion.candidates.get(index).cloned())
        .or_else(|| {
            let typed = app.input.cmd_text.trim().to_lowercase();
            (app.completion.candidates.len() == 1 || !typed.is_empty())
                .then(|| app.completion.candidates.first().cloned())
                .flatten()
        });
    let Some(name) = chosen else {
        app.set_error("no shortcut matches");
        return Action::Redraw;
    };
    let Some((command, needs_more_input)) = app.shortcut_command(&name) else {
        app.set_error(format!("/{name} is no longer defined"));
        return Action::Redraw;
    };

    app.completion.clear();
    let _discarded = app.input.take_cmd_text();
    if needs_more_input {
        app.input.enter_command_mode();
        app.input.cmd_text = format!("{command} ");
        app.input.cmd_cursor = app.input.cmd_text.len();
        app.update_completions();
        return Action::Redraw;
    }
    app.input.exit_command_mode();
    dispatch_cli_command(app, &command)
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

        (KeyModifiers::CONTROL, KeyCode::Char('f')) => toggle_favorite_selection(app),

        (KeyModifiers::NONE, KeyCode::Enter) => {
            if app.completion.selected.is_none() && !app.completion.candidates.is_empty() {
                app.completion.selected = Some(0);
            }
            let in_view_submenu = app.is_view_submenu();
            let toggled_view_row =
                app.is_submenu_open("config") && app.selected_row_is_view_option();
            let before = app.open_submenu_parent();
            if let Some(cmd) = app.apply_submenu() {
                return parse_command(app, &cmd);
            }
            let after = app.open_submenu_parent();
            if before != after
                && let Some(parent) = after
            {
                return submenu_fetch_action(app, &parent);
            }
            if in_view_submenu || toggled_view_row {
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

fn toggle_favorite_selection(app: &mut App) -> Action {
    if !app.is_submenu_open("model") {
        return Action::None;
    }
    let Some(name) = app
        .selected_completion()
        .filter(|candidate| *candidate != "reset")
        .map(str::to_owned)
    else {
        return Action::None;
    };

    let favorite = !app.is_favorite_model_candidate(&name);
    app.set_favorite_model(&name, favorite);

    Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
        rid: None,
        name: "favorite_model".into(),
        args: serde_json::json!({ "name": name, "favorite": favorite }),
    })))
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
        "thread" => ("list_threads", None),
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

const PALETTE_ALIASES: [(&str, &str); 14] = [
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
    ("threads", "thread"),
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

fn visible_message_ids(app: &App) -> Vec<Option<String>> {
    app.entries
        .iter()
        .filter_map(|entry| match entry {
            ConversationEntry::Turn(turn) => Some(turn.msg_id.clone()),
            ConversationEntry::System {
                msg_id: Some(msg_id),
                ..
            } => Some(Some(msg_id.clone())),
            ConversationEntry::System { msg_id: None, .. } => None,
        })
        .collect()
}

fn pin_delete_refs(app: &App, refs: &[String]) -> Result<Vec<String>, String> {
    let visible = visible_message_ids(app);
    refs.iter()
        .map(|msg_ref| {
            let from_end_index = match msg_ref.as_str() {
                "last" | "latest" => Some(1_usize),
                _ => msg_ref
                    .parse::<i64>()
                    .ok()
                    .filter(|index| *index < 0)
                    .and_then(|index| usize::try_from(index.unsigned_abs()).ok()),
            };
            let Some(distance_from_end) = from_end_index else {
                return Ok(msg_ref.clone());
            };
            let Some(target) = visible
                .len()
                .checked_sub(distance_from_end)
                .and_then(|index| visible.get(index))
            else {
                return Err(format!(
                    "cannot safely resolve message {msg_ref:?} from the loaded transcript; nothing was deleted"
                ));
            };
            target.clone().ok_or_else(|| {
                format!(
                    "the message shown as {msg_ref:?} was not accepted by the daemon; nothing was deleted"
                )
            })
        })
        .collect()
}

fn pinned_delete_input(app: &App, command: &CliCommand) -> Result<Option<String>, String> {
    let CliCommand::Msg {
        command: MsgCommand::Delete { msg_refs, json },
    } = command
    else {
        return Ok(None);
    };
    let pinned = pin_delete_refs(app, msg_refs)?;
    if pinned.as_slice() == msg_refs.as_slice() {
        return Ok(None);
    }
    Ok(Some(format!(
        "msg delete {}{}",
        pinned.join(" "),
        if *json { " --json" } else { "" }
    )))
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
        | ViewKey::Compaction
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
                    app.scroll_up(usize::from(lines));
                    return redraw_or_load_earlier_in_segment(app);
                }
                ScrollDirection::Down => app.scroll_down(usize::from(lines)),
                ScrollDirection::Top => {
                    app.scroll_up(usize::MAX);
                    return redraw_or_load_earlier_in_segment(app);
                }
                ScrollDirection::Bottom => app.scroll_to_bottom(),
            }
            Action::Redraw
        }

        UiCommand::Segment { target } => run_segment_command(app, *target),

        UiCommand::Thread { target } => run_thread_step(app, *target),

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
                app.input.set_text(String::new());
                app.set_status("edit cancelled");
            } else {
                app.set_status("no edit in progress");
            }
            Action::Redraw
        }

        UiCommand::Cancel => {
            if app.stream.active {
                app.set_status("cancelling generation");
                Action::Send(ConnCommand::Send(ClientMessage::Cancel(Cancel {})))
            } else {
                app.set_status("nothing to cancel");
                Action::Redraw
            }
        }

        UiCommand::Help => {
            app.show_help = true;
            app.help_scroll = 0;
            Action::Redraw
        }

        UiCommand::Palette { scope } => match scope {
            PaletteScope::Full | PaletteScope::Shortcuts => open_palette(app, *scope),
            PaletteScope::Config => {
                let opened = open_palette(app, PaletteScope::Config);
                app.enter_submenu("config");
                let fetch = submenu_fetch_action(app, "setting");
                app.update_completions();
                match (opened, fetch) {
                    (Action::SendMulti(mut commands), Action::Send(settings)) => {
                        commands.push(settings);
                        Action::SendMulti(commands)
                    }
                    (Action::SendMulti(commands), _) => Action::SendMulti(commands),
                    (_, only) => only,
                }
            }
        },

        UiCommand::Bind {
            key,
            command: words,
            global,
        } => run_bind_command(app, scope_of(*global), key, &words.join(" ")),

        UiCommand::Output => {
            if app.reopen_output_pager() {
                Action::Redraw
            } else {
                app.set_status("no command output yet");
                Action::Redraw
            }
        }

        UiCommand::Unbind { key, global } => run_unbind_command(app, scope_of(*global), key),

        UiCommand::Quit => Action::Quit,
    }
}

fn run_thread_step(app: &mut App, step: ThreadStep) -> Action {
    let Some(name) = app.thread_after(step) else {
        app.set_status(match step {
            ThreadStep::Unread => "no unread messages in other threads",
            ThreadStep::Next | ThreadStep::Previous => "no other thread to switch to",
        });
        return Action::Redraw;
    };
    if name == app.thread_name {
        app.set_status("no other thread to switch to");
        return Action::Redraw;
    }
    Action::Send(super::switch_thread_command(&name))
}

const fn scope_of(global: bool) -> Scope {
    if global { Scope::Global } else { Scope::Normal }
}

fn save_keymap(app: &App) -> std::io::Result<()> {
    match &app.settings_files {
        Some(files) => app.keymap.save_to(&files.keymap),
        None => Ok(()),
    }
}

fn run_bind_command(app: &mut App, scope: Scope, key: &str, command: &str) -> Action {
    if let Err(problem) = app.keymap.bind(scope, key, command) {
        app.set_error(problem);
        return Action::Redraw;
    }
    match save_keymap(app) {
        Ok(()) => app.set_status(format!("{key} runs {command}")),
        Err(error) => app.set_error(format!("bound {key} for this session only: {error}")),
    }
    Action::Redraw
}

fn run_unbind_command(app: &mut App, scope: Scope, key: &str) -> Action {
    match app.keymap.unbind(scope, key) {
        Err(problem) => {
            app.set_error(problem);
            return Action::Redraw;
        }
        Ok(None) => {
            app.set_status(format!("{key} was not bound"));
            return Action::Redraw;
        }
        Ok(Some(previous)) => {
            if let Err(error) = save_keymap(app) {
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
        total.saturating_sub(app.scroll_offset).saturating_sub(half)
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
    let _closed = app.close_segment_view();

    if app.stream.active {
        app.input.set_text(text);
        app.pending_images = images;
        app.set_error(
            "a reply is already in progress; your draft is ready to send when it finishes",
        );
        return Action::Redraw;
    }

    let prepared_result = images
        .iter()
        .map(|path| {
            shore_common::swp_client::read_image_upload(path).map(|upload| {
                let image_ref = shore_common::protocol::types::ImageRef {
                    path: path.clone(),
                    caption: None,
                    data: Some(upload.data.clone()),
                    ..shore_common::protocol::types::ImageRef::default()
                };
                (image_ref, upload)
            })
        })
        .collect::<shore_common::swp_client::Result<Vec<_>>>();
    let prepared = match prepared_result {
        Ok(attachments) => attachments,
        Err(error) => {
            app.input.set_text(text);
            app.pending_images = images;
            app.set_error(format!("message not sent: {error}"));
            return Action::Redraw;
        }
    };
    let (image_refs, image_uploads) = prepared.into_iter().unzip();

    app.dismiss_notifications();
    app.entries.push(ConversationEntry::user(
        text.clone(),
        image_refs,
        String::new(),
    ));
    app.scroll_to_bottom();
    app.stream.active = true;
    let rid = app.next_request_id("message");
    app.stream.rid = Some(rid.clone());
    Action::Send(ConnCommand::Send(ClientMessage::Message(
        ClientMessageBody {
            rid: Some(rid),
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

fn dispatch_cli_command(app: &mut App, raw_input: &str) -> Action {
    let mut effective_input = raw_input.to_owned();
    let mut command = match crate::cli::parse_palette_command(raw_input) {
        Ok(parsed) => parsed,
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
    match pinned_delete_input(app, &command) {
        Ok(Some(pinned)) => {
            effective_input = pinned;
            command = match crate::cli::parse_palette_command(&effective_input) {
                Ok(parsed) => parsed,
                Err(error) => {
                    app.set_error(format!("could not pin delete target: {error}"));
                    return Action::Redraw;
                }
            };
        }
        Ok(None) => {}
        Err(error) => {
            app.set_error(error);
            return Action::Redraw;
        }
    }
    let input = effective_input.as_str();

    if let CliCommand::View { key, value } = &command {
        return run_view_command(app, *key, value.as_deref());
    }
    if let CliCommand::Ui { command: ui } = &command {
        return run_ui_command(app, ui);
    }
    if let Some(index) = segment_to_open(&command) {
        return open_segment(app, index);
    }
    if let (
        Some(view),
        CliCommand::Msg {
            command:
                MsgCommand::Regen { .. }
                | MsgCommand::Alt { .. }
                | MsgCommand::Edit { .. }
                | MsgCommand::Delete { .. },
        },
    ) = (&app.segment_view, &command)
    {
        let index = view.summary.index;
        app.set_error(format!(
            "segment {index} is read-only; press ] or run `ui segment current` to change the current context"
        ));
        return Action::Redraw;
    }

    match &command {
        CliCommand::Completions { .. } | CliCommand::Complete { .. } => {
            app.set_error("shell completion generation is a terminal-only CLI operation");
            return Action::Redraw;
        }
        CliCommand::Export { .. } | CliCommand::Import { .. } => {
            app.set_error(
                "export and import copy archives to and from this machine; run them from a shell",
            );
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
        CliCommand::Thread {
            subcommand: Some(ThreadCommand::New { name, .. }),
            ..
        } => {
            app.pending_thread_create = Some(name.clone());
        }
        CliCommand::Msg { .. }
        | CliCommand::Compact { .. }
        | CliCommand::Segments { .. }
        | CliCommand::Clear { .. }
        | CliCommand::Trace { .. }
        | CliCommand::Character { .. }
        | CliCommand::Thread { .. }
        | CliCommand::Status { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Config { .. }
        | CliCommand::Usage { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. } => {}
    }

    if let Some(prompt) = palette_confirmation_prompt(app, &command)
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
            command: MsgCommand::Regen { guidance },
        } => {
            if app.stream.active {
                app.set_error("a reply is already in progress");
                return Action::Redraw;
            }
            app.begin_regen_optimistic();
            let rid = app.next_request_id("regen");
            app.stream.rid = Some(rid.clone());
            Action::Send(ConnCommand::Send(ClientMessage::Regen(Regen {
                rid: Some(rid),
                stream: true,
                guidance: guidance.clone(),
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
        CliCommand::Character {
            subcommand: Some(CharacterCommand::Delete { name, .. }),
            ..
        } => {
            app.set_error(format!(
                "deleting a character cannot be undone, so it is shell-only: \
                 run `shore character delete {name}`"
            ));
            Action::Redraw
        }
        CliCommand::Config { path: true, .. } => {
            palette_swp_command(app, input, "status", serde_json::json!({}))
        }
        CliCommand::Config {
            subcommand: Some(ConfigCommand::Reload { .. }),
            ..
        } => match ReloadConfiguration::command(
            ConfigReloadArgs {
                apply: None,
                refresh_prompts: None,
            },
            None,
        ) {
            Ok(reload_command) => {
                palette_swp_command(app, input, &reload_command.name, reload_command.args)
            }
            Err(error) => {
                app.set_error(error.to_string());
                Action::Redraw
            }
        },
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
        | CliCommand::Thread { .. }
        | CliCommand::Export { .. }
        | CliCommand::Import { .. }
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

fn delete_target_description(app: &App, msg_ref: &str) -> String {
    let target = app.entries.iter().find_map(|entry| match entry {
        ConversationEntry::Turn(turn) if turn.msg_id.as_deref() == Some(msg_ref) => Some((
            format!("{:?}", turn.role).to_lowercase(),
            turn.joined_text(),
        )),
        ConversationEntry::System {
            msg_id: Some(msg_id),
            content,
            ..
        } if msg_id == msg_ref => Some(("system".to_owned(), content.clone())),
        ConversationEntry::Turn(_) | ConversationEntry::System { .. } => None,
    });
    let Some((role, content)) = target else {
        return format!("conversation entry {msg_ref:?}");
    };
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = compact.chars().take(48).collect::<String>();
    if compact.chars().count() > 48 {
        preview.push('…');
    }
    if preview.is_empty() {
        format!("{role} message {msg_ref:?}")
    } else {
        format!("{role} message {msg_ref:?} ({preview:?})")
    }
}

#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "only a deliberately small subset of commands needs confirmation"
)]
fn palette_confirmation_prompt(app: &App, command: &CliCommand) -> Option<String> {
    match command {
        CliCommand::Msg {
            command: MsgCommand::Delete { msg_refs, .. },
        } if msg_refs.len() == 1 => Some(format!(
            "Delete {}? This cannot be undone.",
            msg_refs.first().map_or_else(
                || "conversation entry".to_owned(),
                |msg_ref| delete_target_description(app, msg_ref)
            )
        )),
        CliCommand::Msg {
            command: MsgCommand::Delete { msg_refs, .. },
        } => Some(format!(
            "Delete {} conversation entries ({})? This cannot be undone.",
            msg_refs.len(),
            msg_refs.join(", ")
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
            subcommand: Some(crate::cli::DebugCommand::Tool { describe: true, .. }),
        } => None,
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
    fn ctrl_c_interrupts() {
        let mut app = App::default();
        let action = handle_key(
            &mut app,
            make_key(KeyModifiers::CONTROL, KeyCode::Char('c')),
        );
        assert!(matches!(action, Action::Interrupt));
    }

    #[test]
    fn unreadable_attachment_keeps_the_whole_draft_in_the_composer() {
        let temp = tempfile::tempdir().unwrap();
        let readable = temp.path().join("readable.png");
        std::fs::write(&readable, b"image bytes").unwrap();
        let unreadable_path = temp.path().join("missing.png");
        let unreadable = unreadable_path.to_string_lossy().into_owned();
        let paths = vec![readable.to_string_lossy().into_owned(), unreadable.clone()];
        let mut app = App::default();
        app.input.mode = InputMode::Insert;
        app.input.set_text("keep this draft".to_owned());
        app.pending_images.clone_from(&paths);

        let action = handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Enter));

        assert!(matches!(action, Action::Redraw));
        assert_eq!(app.input.text, "keep this draft");
        assert_eq!(app.pending_images, paths);
        assert!(
            app.entries.is_empty(),
            "the unsent message must not appear in history"
        );
        assert!(
            !app.stream.active,
            "an unsent message must not start a stream"
        );
        assert!(
            app.notifications.iter().any(|note| {
                note.content.contains("message not sent") && note.content.contains(&unreadable)
            }),
            "the error should explain which attachment blocked the send: {:?}",
            app.notifications
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
    fn delete_last_refuses_an_optimistic_message_the_daemon_never_accepted() {
        let mut app = App::default();
        app.entries.push(ConversationEntry::assistant(
            Some("m_assistant".into()),
            "the answer".into(),
            vec![],
            "t1".into(),
            None,
        ));
        app.entries.push(ConversationEntry::user(
            "failed image message".into(),
            vec![],
            String::new(),
        ));

        assert!(matches!(
            parse_command(&mut app, "delete last"),
            Action::Redraw
        ));
        assert!(app.palette_confirmation.is_none());
        assert!(app.error_log.last().is_some_and(
            |error| error.contains("not accepted") && error.contains("nothing was deleted")
        ));
    }
}
