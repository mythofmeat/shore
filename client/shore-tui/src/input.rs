use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use shore_common::protocol::client_msg::{
    Cancel, ClientMessage, ClientMessageBody, Command, Regen,
};
use tracing::debug;

use crate::app::{App, InputMode, PaletteMode};
use crate::connection::ConnCommand;

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
        _ => Action::None,
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
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::Esc) => {
            if app.dismiss_latest_notification() {
                Action::Redraw
            } else {
                Action::None
            }
        }

        (KeyModifiers::NONE, KeyCode::Char('i')) => {
            debug!("Input: Normal → Insert");
            app.input.mode = InputMode::Insert;
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('a')) => {
            debug!("Input: Normal → Insert (append)");
            app.input.move_right();
            app.input.mode = InputMode::Insert;
            Action::Redraw
        }
        (KeyModifiers::SHIFT, KeyCode::Char('A')) => {
            debug!("Input: Normal → Insert (end)");
            app.input.move_end();
            app.input.mode = InputMode::Insert;
            Action::Redraw
        }
        (KeyModifiers::SHIFT, KeyCode::Char('I')) => {
            debug!("Input: Normal → Insert (home)");
            app.input.move_home();
            app.input.mode = InputMode::Insert;
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Char('h') | KeyCode::Left) => {
            app.input.move_left();
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('l') | KeyCode::Right) => {
            app.input.move_right();
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('0') | KeyCode::Home) => {
            app.input.move_home();
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('$') | KeyCode::End) => {
            app.input.move_end();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Char('k') | KeyCode::Up) => {
            app.scroll_up(1);
            redraw_or_load_older_history(app)
        }
        (KeyModifiers::NONE, KeyCode::Char('j') | KeyCode::Down) => {
            app.scroll_down(1);
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('u')) => {
            app.scroll_up(10);
            redraw_or_load_older_history(app)
        }
        (KeyModifiers::NONE, KeyCode::Char('d')) => {
            app.scroll_down(10);
            Action::Redraw
        }
        (KeyModifiers::SHIFT, KeyCode::Char('G')) => {
            app.scroll_to_bottom();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Char('t')) => {
            app.show_thinking = !app.show_thinking;
            Action::SavePrefs
        }

        (KeyModifiers::SHIFT, KeyCode::Char('T')) => {
            app.show_tools = !app.show_tools;
            Action::SavePrefs
        }

        (KeyModifiers::NONE, KeyCode::Char('s')) => {
            app.show_subagent = !app.show_subagent;
            Action::SendAndSavePrefs(crate::subagent_trace_fetch(app))
        }

        (KeyModifiers::SHIFT, KeyCode::Char('S')) => {
            if app.subagent_tasks.is_empty() {
                app.set_status("no background sub-agents yet");
                return Action::Redraw;
            }
            app.open_subagent_panel();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Char('p')) => {
            app.show_images = !app.show_images;
            Action::SavePrefs
        }

        (KeyModifiers::CONTROL, KeyCode::Char('g')) => Action::OpenInEditor,

        (KeyModifiers::NONE, KeyCode::Char('r')) => {
            app.begin_regen_optimistic();
            let msg = ClientMessage::Regen(Regen {
                rid: None,
                stream: true,
            });
            Action::Send(ConnCommand::Send(msg))
        }

        (KeyModifiers::NONE, KeyCode::Char('o')) => {
            if app.image_index.is_empty() {
                return Action::None;
            }
            let term_height = crossterm::terminal::size().map_or(24, |(_, h)| h);
            let visible_h = (term_height * 80 / 100).max(1) as usize;
            let last_line = app.image_index.last().map_or(0, |e| e.line);
            let total_approx = last_line + visible_h;
            let center = if app.auto_scroll {
                total_approx.saturating_sub(visible_h / 2)
            } else {
                total_approx
                    .saturating_sub(app.scroll_offset as usize)
                    .saturating_sub(visible_h / 2)
            };
            let best = app
                .image_index
                .iter()
                .enumerate()
                .min_by_key(|(_, e)| (e.line as isize - center as isize).unsigned_abs())
                .map_or(0, |(i, _)| i);
            app.fullscreen = Some(best);
            Action::Redraw
        }

        (KeyModifiers::SHIFT | KeyModifiers::NONE, KeyCode::Char(':')) => {
            debug!("Input: Normal → Command");
            app.input.enter_command_mode();
            app.update_completions();
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
                    *idx = (*idx + 1) % total;
                }
            }
            Action::Redraw
        }
        (KeyModifiers::NONE, KeyCode::Char('k') | KeyCode::Up) => {
            if let Some(ref mut idx) = app.fullscreen {
                let total = app.image_index.len();
                if total > 0 {
                    *idx = (*idx + total - 1) % total;
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
            let mut image_uploads: Vec<shore_common::protocol::client_msg::ImageUpload> =
                Vec::new();
            let mut image_refs: Vec<shore_common::protocol::types::ImageRef> = Vec::new();
            for p in &images {
                match std::fs::read(p) {
                    Ok(bytes) => {
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let filename = std::path::Path::new(p).file_name().map_or_else(
                            || "image".to_string(),
                            |f| f.to_string_lossy().to_string(),
                        );
                        image_refs.push(shore_common::protocol::types::ImageRef {
                            path: p.clone(),
                            caption: None,
                            data: Some(b64.clone()),
                        });
                        image_uploads.push(shore_common::protocol::client_msg::ImageUpload {
                            filename,
                            data: b64,
                            mime_type: None,
                        });
                    }
                    Err(e) => {
                        app.set_error(format!("failed to read image: {e}"));
                    }
                }
            }
            app.dismiss_notifications();
            app.entries.push(crate::app::ConversationEntry::user(
                text.clone(),
                image_refs,
                String::new(),
            ));
            app.scroll_to_bottom();
            app.stream.active = true;
            let msg = ClientMessage::Message(ClientMessageBody {
                rid: None,

                text,
                stream: true,
                images,
                image_data: image_uploads,
                absence_seconds: None,
            });
            Action::Send(ConnCommand::Send(msg))
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
            app.next_completion();
            enter_completed_submenu(app).unwrap_or(Action::Redraw)
        }

        (KeyModifiers::CONTROL, KeyCode::Char('j')) | (KeyModifiers::NONE, KeyCode::Down) => {
            app.next_completion();
            Action::Redraw
        }

        (KeyModifiers::SHIFT | KeyModifiers::NONE, KeyCode::BackTab) => {
            app.prev_completion();
            enter_completed_submenu(app).unwrap_or(Action::Redraw)
        }

        (KeyModifiers::CONTROL, KeyCode::Char('k')) | (KeyModifiers::NONE, KeyCode::Up) => {
            app.prev_completion();
            Action::Redraw
        }

        (KeyModifiers::NONE, KeyCode::Enter) => {
            let trimmed = app.input.cmd_text.trim().to_string();
            if let Some(parent) = App::canonical_submenu_parent(&trimmed) {
                app.enter_submenu(parent);
                submenu_fetch_action(app, parent)
            } else {
                app.completion.clear();
                let text = app.input.take_cmd_text();
                parse_command(app, &text)
            }
        }

        (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(' ')) => {
            let trimmed = app.input.cmd_text.trim().to_string();
            if let Some(parent) = App::canonical_submenu_parent(&trimmed) {
                app.enter_submenu(parent);
                submenu_fetch_action(app, parent)
            } else {
                app.input.cmd_insert_char(' ');
                app.update_completions();
                Action::Redraw
            }
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

fn enter_completed_submenu(app: &mut App) -> Option<Action> {
    let trimmed = app.input.cmd_text.trim();
    let parent = App::canonical_submenu_parent(trimmed)?;
    app.input.cmd_text = parent.to_string();
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

fn parse_command(app: &mut App, input: &str) -> Action {
    let input = input.trim();
    if input.is_empty() {
        return Action::Redraw;
    }

    let mut parts = input.splitn(2, ' ');
    let cmd = parts.next().unwrap_or("");
    let arg = parts.next().unwrap_or("").trim();

    debug!(cmd, has_arg = !arg.is_empty(), "TUI command dispatched");
    match cmd {
        "cancel" => {
            if app.stream.active {
                app.stream.reset();
                Action::Send(ConnCommand::Send(ClientMessage::Cancel(Cancel {})))
            } else {
                app.set_status("nothing to cancel");
                Action::Redraw
            }
        }

        "help" => {
            app.show_help = true;
            Action::Redraw
        }

        "view" => {
            let mut parts = arg.split_whitespace();
            let Some(key) = parts.next() else {
                app.enter_submenu("view");
                return Action::Redraw;
            };
            if !App::is_view_key(key) {
                app.set_status(format!("unknown view option: {key}"));
                return Action::Redraw;
            }
            let value = parts.next().unwrap_or("toggle");
            if parts.next().is_some() {
                app.set_status(
                    "usage: :view [timestamps|thinking|tools|subagent|images|metadata|usage|budget] [on|off|toggle]",
                );
                return Action::Redraw;
            }
            if key == "usage" {
                let lowered = value.to_ascii_lowercase();
                let mode = if lowered == "toggle" {
                    app.cycle_usage_display()
                } else if let Some(mode) = crate::app::UsageDisplay::from_token(&lowered) {
                    app.set_usage_display(mode);
                    mode
                } else {
                    app.set_status("usage: :view usage [off|always|warn|toggle]");
                    return Action::Redraw;
                };
                app.update_completions();
                app.set_status(format!("view usage: {}", mode.as_str()));
                return Action::SavePrefs;
            }
            if key == "budget" {
                let focus = if value.eq_ignore_ascii_case("toggle") {
                    app.cycle_budget_focus()
                } else if let Some(focus) = crate::app::BudgetFocus::from_token(value) {
                    app.set_budget_focus(focus.clone());
                    focus
                } else {
                    app.set_status("usage: :view budget [auto|cap|pace|<budget>|<budget>:pace]");
                    return Action::Redraw;
                };
                app.update_completions();
                let unknown = focus.name.is_some() && app.focused_budget().is_none();
                let token = focus.as_token();
                app.set_status(if unknown {
                    format!("view budget: {token} (no such budget reported yet)")
                } else {
                    format!("view budget: {token}")
                });
                return Action::SavePrefs;
            }
            let enabled = match value.to_ascii_lowercase().as_str() {
                "on" | "true" | "yes" | "1" => {
                    let _ = app.set_view_option(key, true);
                    true
                }
                "off" | "false" | "no" | "0" => {
                    let _ = app.set_view_option(key, false);
                    false
                }
                "toggle" => app.toggle_view_option(key).unwrap_or(false),
                _ => {
                    app.set_status(
                        "usage: :view [timestamps|thinking|tools|subagent|images|metadata|usage|budget] [on|off|toggle]",
                    );
                    return Action::Redraw;
                }
            };
            app.update_completions();
            app.set_status(format!(
                "view {key}: {}",
                if enabled { "on" } else { "off" }
            ));
            Action::SavePrefs
        }

        "character" | "characters" => {
            if arg.is_empty() {
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,

                    name: "list_characters".into(),
                    args: serde_json::json!({}),
                })))
            } else {
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,

                    name: "switch_character".into(),
                    args: serde_json::json!({ "name": arg }),
                })))
            }
        }

        "model" => {
            let (include_hidden, rest) = match arg.split_once(' ') {
                Some(("all", rest)) => (true, rest.trim()),
                _ if arg == "all" => (true, ""),
                _ => (false, arg),
            };
            if rest.is_empty() {
                app.show_model_list = true;
                let mut args = serde_json::json!({});
                if include_hidden {
                    args["include_hidden"] = serde_json::json!(true);
                }
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,
                    name: "list_models".into(),
                    args,
                })))
            } else if rest == "reset" {
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,
                    name: "reset_model".into(),
                    args: serde_json::json!({}),
                })))
            } else {
                let mut args = serde_json::json!({ "name": rest });
                if include_hidden {
                    args["include_hidden"] = serde_json::json!(true);
                }
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,
                    name: "switch_model".into(),
                    args,
                })))
            }
        }

        "setting" => {
            let trimmed = arg.trim();
            if trimmed.is_empty() {
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,
                    name: "model_settings".into(),
                    args: serde_json::json!({}),
                })))
            } else if let Some(("reset", key)) = trimmed.split_once(' ') {
                let key = key.trim();
                if key.is_empty() {
                    app.set_status("usage: :setting reset <key>");
                    Action::Redraw
                } else {
                    Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                        rid: None,
                        name: "set_model_setting".into(),
                        args: serde_json::json!({
                            "key": key,
                            "value": serde_json::Value::Null,
                            "scope": "character",
                        }),
                    })))
                }
            } else if let Some((key, value)) = trimmed.split_once(' ') {
                let value = value.trim();
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,
                    name: "set_model_setting".into(),
                    args: serde_json::json!({
                        "key": key,
                        "value": parse_setting_value_str(key, value),
                        "scope": "character",
                    }),
                })))
            } else {
                app.set_status("usage: :setting [<key> <value>] | :setting reset <key>");
                Action::Redraw
            }
        }

        "compact" => {
            let mut args = serde_json::json!({});
            for word in arg.split_whitespace() {
                if word == "restart" {
                    args["restart"] = serde_json::json!(true);
                } else if let Ok(n) = word.parse::<u32>() {
                    args["keep_turns"] = serde_json::json!(n);
                } else {
                    app.set_status("usage: :compact [keep_turns] [restart]");
                    return Action::Redraw;
                }
            }
            Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                rid: None,

                name: "compact".into(),
                args,
            })))
        }

        "delete" => {
            if arg.is_empty() {
                app.set_status("usage: :delete <ref>  (e.g. last, -1, -2)");
                Action::Redraw
            } else {
                let refs: Vec<&str> = arg.split_whitespace().collect();
                let args = if refs.len() == 1 {
                    serde_json::json!({ "refs": refs[0] })
                } else {
                    serde_json::json!({ "refs": refs })
                };
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,

                    name: "delete".into(),
                    args,
                })))
            }
        }

        "edit" => {
            if arg.is_empty() || arg == "cancel" {
                if app.editing_ref.is_some() || app.pending_edit_prefill.is_some() {
                    app.editing_ref = None;
                    app.cancel_edit_prefill();
                    app.input.text.clear();
                    app.input.cursor = 0;
                    app.set_status("edit cancelled");
                } else {
                    app.set_status("usage: :edit <ref>  (e.g. last, -1, 3, m_...)");
                }
                Action::Redraw
            } else {
                let rid = app.begin_edit_prefill(arg);
                app.set_status(format!("loading {arg}..."));
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: Some(rid),
                    name: "get".into(),
                    args: serde_json::json!({ "ref": arg }),
                })))
            }
        }

        "regen" => {
            app.begin_regen_optimistic();
            let msg = ClientMessage::Regen(Regen {
                rid: None,
                stream: true,
            });
            Action::Send(ConnCommand::Send(msg))
        }

        "alt" => {
            let mut parts = arg.split_whitespace();
            let first = parts.next();
            let msg_ref = match first {
                None | Some("list") => parts.next(),
                Some(other) => Some(other),
            };
            if parts.next().is_some() {
                app.set_status("usage: :alt [ref]");
                return Action::Redraw;
            }
            let target_ref = msg_ref.map(ToString::to_string);
            app.start_alt_picker(target_ref.clone());
            let mut args = serde_json::Map::new();
            if let Some(msg_ref) = target_ref {
                let _ = args.insert("ref".into(), serde_json::json!(msg_ref));
            }
            let msg = ClientMessage::Command(Command {
                rid: None,
                name: "list_alternatives".into(),
                args: serde_json::Value::Object(args),
            });
            Action::Send(ConnCommand::Send(msg))
        }

        "image" => {
            if arg == "clear" {
                let count = app.pending_images.len();
                app.pending_images.clear();
                app.set_status(format!("cleared {count} pending image(s)"));
                Action::Redraw
            } else if arg.is_empty() {
                Action::PickImage(None)
            } else {
                let expanded = if arg.starts_with('~') {
                    if let Ok(home) = std::env::var("HOME") {
                        arg.replacen('~', &home, 1)
                    } else {
                        arg.to_string()
                    }
                } else {
                    arg.to_string()
                };
                let path = if std::path::Path::new(&expanded).is_absolute() {
                    expanded
                } else {
                    std::env::current_dir()
                        .map(|d| d.join(&expanded).to_string_lossy().to_string())
                        .unwrap_or(expanded)
                };
                if std::path::Path::new(&path).exists() {
                    app.pending_images.push(path.clone());
                    app.set_status(format!(
                        "attached image ({} pending)",
                        app.pending_images.len()
                    ));
                    Action::Redraw
                } else {
                    app.set_error(format!("file not found: {path}"));
                    Action::Redraw
                }
            }
        }

        "sys" | "system" => {
            if arg.is_empty() {
                app.set_status("usage: :sys <instruction>");
                Action::Redraw
            } else {
                Action::Send(ConnCommand::Send(ClientMessage::Command(Command {
                    rid: None,

                    name: "inject_system".into(),
                    args: serde_json::json!({ "text": arg }),
                })))
            }
        }

        "reasoning" => {
            let cmd = if arg.is_empty() {
                Command {
                    rid: None,
                    name: "model_settings".into(),
                    args: serde_json::json!({}),
                }
            } else if arg.eq_ignore_ascii_case("reset") {
                Command {
                    rid: None,
                    name: "set_model_setting".into(),
                    args: serde_json::json!({
                        "key": "reasoning_effort",
                        "value": serde_json::Value::Null,
                        "scope": "character",
                    }),
                }
            } else {
                Command {
                    rid: None,
                    name: "set_model_setting".into(),
                    args: serde_json::json!({
                        "key": "reasoning_effort",
                        "value": parse_setting_value_str("reasoning_effort", arg),
                        "scope": "character",
                    }),
                }
            };
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd)))
        }

        _ => {
            app.set_status(format!("unknown command: {cmd}"));
            Action::Redraw
        }
    }
}

fn parse_setting_value_str(key: &str, raw: &str) -> serde_json::Value {
    use serde_json::Value;
    let trimmed = raw.trim();
    match key {
        "replay_prior_thinking" | "zai_clear_thinking" | "zai_subscription" => {
            match trimmed.to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" => Value::Bool(true),
                "false" | "no" | "off" => Value::Bool(false),
                _ => Value::String(trimmed.to_string()),
            }
        }
        "temperature" | "top_p" => trimmed
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map_or_else(|| Value::String(trimmed.to_string()), Value::Number),
        "budget_tokens" | "max_output_tokens" | "gemini_generation" | "max_tool_iterations" => {
            trimmed.parse::<u64>().map_or_else(
                |_| Value::String(trimmed.to_string()),
                |n| Value::Number(n.into()),
            )
        }
        "reasoning_effort" => match trimmed.to_ascii_lowercase().as_str() {
            "off" | "none" | "disable" | "disabled" | "unset" | "" => Value::String("off".into()),
            _ => Value::String(trimmed.to_string()),
        },
        "openrouter_provider" => serde_json::from_str::<Value>(trimmed)
            .unwrap_or_else(|_| Value::String(trimmed.to_string())),
        _ => Value::String(trimmed.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEventKind, KeyEventState};
    use serde_json::json;

    #[test]
    fn parse_setting_value_coerces_daemon_sampler_keys() {
        assert_eq!(
            parse_setting_value_str("replay_prior_thinking", "last_turn"),
            json!("last_turn")
        );
        assert_eq!(
            parse_setting_value_str("replay_prior_thinking", "off"),
            json!(false)
        );

        assert_eq!(
            parse_setting_value_str("zai_clear_thinking", "false"),
            json!(false)
        );
        assert_eq!(
            parse_setting_value_str("zai_subscription", "yes"),
            json!(true)
        );

        assert_eq!(parse_setting_value_str("gemini_generation", "3"), json!(3));

        assert_eq!(
            parse_setting_value_str("max_tool_iterations", "16"),
            json!(16)
        );
        assert_eq!(
            parse_setting_value_str("cache_keepalive", "55m"),
            json!("55m")
        );
        assert_eq!(
            parse_setting_value_str("cache_keepalive", "off"),
            json!("off")
        );

        assert_eq!(
            parse_setting_value_str("openrouter_provider", r#"{"order":["Anthropic"]}"#),
            json!({"order": ["Anthropic"]})
        );
        assert_eq!(
            parse_setting_value_str("openrouter_provider", "Anthropic"),
            json!("Anthropic")
        );

        assert_eq!(
            parse_setting_value_str("reasoning_effort", "none"),
            json!("off")
        );
        assert_eq!(
            parse_setting_value_str("reasoning_effort", "high"),
            json!("high")
        );
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
        use crate::app::UsageDisplay;
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
        use crate::app::{BudgetFocus, UsageBudget};
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
        match action {
            Action::Send(ConnCommand::Send(ClientMessage::Cancel(_))) => {}
            _ => panic!("expected Cancel send"),
        }
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
        match parse_command(&mut app, "cancel") {
            Action::Send(ConnCommand::Send(ClientMessage::Cancel(_))) => {}
            _ => panic!("expected Cancel send"),
        }
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

        let action = parse_command(&mut app, "view timestamps on");
        assert!(matches!(action, Action::SavePrefs));
        assert!(app.show_timestamps);

        let action = parse_command(&mut app, "view metadata off");
        assert!(matches!(action, Action::SavePrefs));
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

        match handle_key(&mut app, make_key(KeyModifiers::NONE, KeyCode::Char('k'))) {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "history_page");
                assert_eq!(cmd.args["before"], "active");
                assert_eq!(cmd.args["turns"], HISTORY_PAGE_TURNS);
            }
            _ => panic!("expected history_page command"),
        }
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
        match parse_command(&mut app, "character Bob") {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "switch_character");
                assert_eq!(cmd.args["name"], "Bob");
            }
            _ => panic!("expected single switch_character send"),
        }
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
        match action {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "list_characters");
            }
            _ => panic!("expected list_characters fetch"),
        }
    }

    #[test]
    fn provider_command_is_not_a_tui_shortcut() {
        let mut app = App::default();
        app.input.enter_command_mode();
        app.update_completions();
        assert!(!app.completion.candidates.iter().any(|c| c == "provider"));

        let action = parse_command(&mut app, "provider refresh openai");
        assert!(matches!(action, Action::Redraw));
        assert!(
            app.notifications
                .iter()
                .any(|n| n.content == "unknown command: provider")
        );
    }

    #[test]
    fn delete_command_sends_single_delete_request() {
        let mut app = App::default();
        match parse_command(&mut app, "delete last") {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "delete");
                assert_eq!(cmd.args["refs"], "last");
            }
            _ => panic!("expected single delete send"),
        }
    }

    #[test]
    fn edit_command_asks_the_daemon_to_resolve_the_ref() {
        let mut app = App::default();
        match parse_command(&mut app, "edit 3") {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "get");
                assert_eq!(cmd.args["ref"], "3");
                assert!(cmd.rid.is_some());
                assert!(app.editing_ref.is_none());
                assert!(app.pending_edit_prefill.is_some());
            }
            _ => panic!("expected a get request for the message being edited"),
        }
    }

    #[test]
    fn edit_cancel_drops_a_prefill_still_in_flight() {
        let mut app = App::default();
        let _ = parse_command(&mut app, "edit 3");

        let action = parse_command(&mut app, "edit cancel");

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
        match parse_command(&mut app, "alt") {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "list_alternatives");
                assert!(cmd.args.as_object().unwrap().is_empty());
                assert!(app.alt_picker.is_some());
            }
            _ => panic!("expected alt list command send"),
        }
    }

    #[test]
    fn alt_command_accepts_message_ref() {
        let mut app = App::default();
        match parse_command(&mut app, "alt -2") {
            Action::Send(ConnCommand::Send(ClientMessage::Command(cmd))) => {
                assert_eq!(cmd.name, "list_alternatives");
                assert_eq!(cmd.args["ref"], "-2");
            }
            _ => panic!("expected alt list command send"),
        }
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
