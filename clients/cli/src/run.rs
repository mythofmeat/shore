use std::collections::HashMap;
use std::io::{self, IsTerminal, Read as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use shore_config::binaries::MATRIX_BIN_ENV;
use shore_protocol::server_msg::{MessageOrigin, NewMessage, ServerMessage};
use shore_protocol::types::{CharacterAvatar, CharacterInfo, Role};
use shore_swp_client::{SWPConnection, ServerAddr};
use tracing::{debug, info, instrument, warn};

use crate::cli::{Cli, CliCommand, LogRole};
use crate::output;
use crate::state;

/// Display name for the character attached to this CLI session, set once
/// after the handshake and read by any code that renders assistant output
/// outside the main command dispatcher.
static SESSION_DISPLAY_CHARACTER: OnceLock<String> = OnceLock::new();

fn session_display_character() -> &'static str {
    SESSION_DISPLAY_CHARACTER
        .get()
        .map_or("Assistant", String::as_str)
}

fn log_role_matches(filter: Option<&LogRole>, role: &Role) -> bool {
    match filter {
        None => true,
        Some(LogRole::User) => *role == Role::User,
        Some(LogRole::Assistant) => *role == Role::Assistant,
        Some(LogRole::System) => *role == Role::System,
    }
}

fn active_start_index(data: &serde_json::Value) -> usize {
    data["active_start"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

/// Execute the CLI command by connecting to the daemon and dispatching.
#[instrument(skip(cli))]
pub(crate) async fn execute(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(result) = try_handle_local_only(&cli).await {
        return result;
    }

    let addr = resolve_addr(&cli)?;

    // Character resolution: --character flag > SHORE_CHARACTER env > state file > None (daemon auto-selects).
    // `shore notify` defaults to all characters, so it deliberately ignores
    // the persisted active-character state unless the user passed -c/--character.
    let character = if matches!(cli.command, CliCommand::Notify { .. }) {
        cli.character.clone()
    } else {
        cli.character.clone().or_else(state::read_active_character)
    };

    info!(character = ?character, "CLI executing command");

    let (mut conn, server_hello, history) =
        SWPConnection::connect(&addr, "cli", "shore-cli", character.clone()).await?;

    // Prefer the daemon's authoritative answer over the local request.
    let display_character = state::resolve_display_character(
        history.selected_character.as_deref(),
        character.as_deref(),
    );
    // Stash so incidental messages inside `recv_command_data` can label
    // themselves correctly without threading the name through every call site.
    let _ignored = SESSION_DISPLAY_CHARACTER.set(display_character.clone());

    pre_apply_active_model(&mut conn, &cli).await;

    match &cli.command {
        CliCommand::Send { .. } => handle_send_command(&mut conn, &cli.command).await?,
        CliCommand::Regen { guidance } => {
            _ = conn.send_regen(true, guidance.clone()).await?;
            recv_streaming_response(&mut conn).await?;
        }
        CliCommand::Notify {
            all_messages,
            autonomous_only: _,
        } => {
            handle_notify(&mut conn, &cli, *all_messages, &server_hello.characters).await?;
        }
        CliCommand::Alt { .. } => handle_alt_command(&mut conn, &cli.command).await?,
        CliCommand::Character {
            name,
            info: false,
            new: false,
            ..
        } => match name {
            Some(target) => handle_switch_character(&mut conn, target).await?,
            None => handle_list_characters(&mut conn).await?,
        },
        CliCommand::Log { .. } => {
            handle_log_command(&mut conn, &cli.command, &display_character).await?;
        }
        CliCommand::Status { .. } => {
            handle_status_command(&mut conn, &cli.command, &display_character).await?;
        }
        CliCommand::Model {
            subcommand: None,
            reset: true,
            ..
        }
        | CliCommand::Model {
            subcommand: None,
            name: Some(_),
            info: false,
            reset: false,
            ..
        } => {
            handle_local_model_command(&mut conn, &cli.command).await?;
        }
        other @ (CliCommand::Character { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Memory { .. }
        | CliCommand::Config { .. }
        | CliCommand::Tools { .. }
        | CliCommand::Usage { .. }
        | CliCommand::Connectors { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }) => {
            handle_generic_swp_command(&mut conn, other).await?;
        }
    }

    Ok(())
}

/// Map a non-send/regen/local command to its SWP command, send it, and render
/// the response honoring `--json` / `--toml` / config formatting.
async fn handle_generic_swp_command(
    conn: &mut SWPConnection,
    other: &CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    // `config reload` is a two-round-trip interactive flow, not a single
    // mapped command.
    if let CliCommand::Config {
        subcommand: Some(_),
        ..
    } = other
    {
        return handle_config_reload(conn, other).await;
    }

    let json_mode = match other {
        CliCommand::Model {
            json, subcommand, ..
        } => {
            *json
                || matches!(
                    subcommand,
                    Some(crate::cli::ModelCommand::Setting { json: true, .. })
                )
        }
        CliCommand::Provider {
            json, subcommand, ..
        } => {
            *json
                || matches!(
                    subcommand,
                    Some(
                        crate::cli::ProviderCommand::Models { json: true, .. }
                            | crate::cli::ProviderCommand::Refresh { json: true, .. }
                    )
                )
        }
        CliCommand::Character { json, .. }
        | CliCommand::Memory { json, .. }
        | CliCommand::Config { json, .. }
        | CliCommand::Tools { json, .. }
        | CliCommand::Usage { json, .. } => *json,
        CliCommand::Send { .. }
        | CliCommand::Regen { .. }
        | CliCommand::Alt { .. }
        | CliCommand::Notify { .. }
        | CliCommand::Log { .. }
        | CliCommand::Status { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Connectors { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. } => false,
    };
    // Read-only config only. Clap's `conflicts_with_all` rejects
    // `--toml` alongside `--check`, `--reset`, or a set value at parse
    // time; the narrow match here documents that intent and avoids
    // serializing non-config responses (e.g. "set" confirmations) as
    // TOML if a future code path forgets the parse-time guard.
    let toml_mode = matches!(
        other,
        CliCommand::Config {
            toml: true,
            value: None,
            check: false,
            reset: false,
            ..
        }
    );
    let show_all = matches!(other, CliCommand::Config { all: true, .. });
    let Some((name, args)) = crate::cli::to_swp_command(other) else {
        return Err("non-send/regen/local command must map to SWP command".into());
    };
    _ = conn.send_command(name, args).await?;
    let data = recv_command_data(conn).await?;
    if toml_mode {
        print_config_toml(&data, show_all)?;
    } else if json_mode {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else if name == "config" {
        output::commands::print_config(&data, show_all);
    } else {
        output::format_command(name, &data);
    }
    Ok(())
}

/// Handle `shore config reload`: validate and reload config from disk, and
/// activate pending system-prompt edits only after the user confirms.
///
/// Two round-trips: a check call reports which prompt-visible files differ
/// from the active snapshot (any config error aborts here), then the apply
/// call adopts the fresh config and — if confirmed — refreshes the snapshot.
/// Refreshing changes the system prompt bytes, so the provider prompt cache
/// goes cold and the next message pays a one-time cache write.
async fn handle_config_reload(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Config {
        subcommand: Some(crate::cli::ConfigCommand::Reload { yes, json }),
        ..
    } = cmd
    else {
        return Err("config reload handler requires the reload subcommand".into());
    };
    let (auto_yes, json_mode) = (*yes, *json);

    _ = conn
        .send_command("config_reload", serde_json::json!({}))
        .await?;
    // Config errors surface here as a printed server error + Err.
    let check = recv_command_data(conn).await?;

    let changed: Vec<String> = check
        .get("changed_prompt_files")
        .and_then(serde_json::Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    let refresh_prompts = if changed.is_empty() {
        false
    } else if auto_yes {
        true
    } else if io::stdin().is_terminal() {
        cli_err!("System prompt files differ from the active (cached) version:");
        for file in &changed {
            cli_err!("  {file}");
        }
        cli_err!("Activating them invalidates the warm prompt cache; the next message pays a one-time cache write.");
        cli_err!("Activate now? [y/N]");
        let mut answer = String::new();
        let _ignored = io::stdin().read_line(&mut answer)?;
        matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
    } else {
        cli_err!(
            "System prompt files differ ({}); leaving them inactive — re-run with --yes to activate.",
            changed.join(", ")
        );
        false
    };

    _ = conn
        .send_command(
            "config_reload",
            serde_json::json!({ "apply": true, "refresh_prompts": refresh_prompts }),
        )
        .await?;
    let data = recv_command_data(conn).await?;

    if json_mode {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        output::format_command("config_reload", &data);
    }
    Ok(())
}

/// Handle every `shore log` form: edit/delete subcommands, a single message
/// ref, the heartbeat log, or the message list (optionally `--follow`).
async fn handle_log_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    display_character: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Log {
        subcommand,
        msg_ref,
        json,
        plain,
        content,
        role,
        reasoning,
        tools,
        subagent_tools,
        heartbeat,
        dreaming,
        events,
        api,
        count,
        follow,
        ..
    } = cmd
    else {
        return Ok(());
    };

    // Default view shows only message text; each flag opts a channel back in.
    let filter = output::LogFilter {
        reasoning: *reasoning,
        tools: *tools,
        subagent_tools: *subagent_tools,
    };

    if let Some(sub) = subcommand {
        return run_log_subcommand(conn, sub, *json).await;
    }

    if let Some(r) = msg_ref {
        let data = fetch_single_message(conn, r, role.as_ref()).await?;
        if *json {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        } else if *content {
            output::print_message_content(&data);
        } else if *plain {
            output::print_log_plain(std::slice::from_ref(&data), display_character, filter);
        } else {
            output::print_single_message(&data, display_character, filter);
        }
        return Ok(());
    }

    // Background observability views (heartbeat/dreaming transcript, the event
    // ring, raw call payloads) map to their own SWP commands via `to_swp_command`.
    if *heartbeat || *dreaming || *events || api.is_some() {
        let Some((name, swp_args)) = crate::cli::to_swp_command(cmd) else {
            return Ok(());
        };
        _ = conn.send_command(name, swp_args).await?;
        let data = recv_command_data(conn).await?;
        if *json {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        } else {
            output::format_command(name, &data);
        }
        return Ok(());
    }

    let mut args = serde_json::Map::new();
    _ = args.insert("turns".into(), serde_json::json!(count));
    if let Some(role_filter) = role {
        _ = args.insert(
            "role".into(),
            serde_json::json!(role_filter.as_protocol_role()),
        );
    }
    _ = conn
        .send_command("log", serde_json::Value::Object(args))
        .await?;
    let data = recv_command_data(conn).await?;

    render_log_list(&data, *json, *content, *plain, display_character, filter)?;

    if *follow {
        follow_log_stream(conn, role.as_ref(), display_character, filter).await?;
    }
    Ok(())
}

/// Send a `shore log edit`/`delete` subcommand and print the acknowledgement.
async fn run_log_subcommand(
    conn: &mut SWPConnection,
    sub: &crate::cli::LogCommand,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (name, args) = match sub {
        crate::cli::LogCommand::Edit { msg_ref, content } => (
            "edit",
            serde_json::json!({ "ref": msg_ref, "content": content.join(" ") }),
        ),
        crate::cli::LogCommand::Delete { msg_ref } => {
            ("delete", serde_json::json!({ "refs": msg_ref }))
        }
    };
    _ = conn.send_command(name, args).await?;
    let data = recv_command_data(conn).await?;
    if json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        output::format_command(name, &data);
    }
    Ok(())
}

/// Fetch a single message by ref (`get`), optionally filtered to one role.
async fn fetch_single_message(
    conn: &mut SWPConnection,
    msg_ref: &str,
    role: Option<&LogRole>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut args = serde_json::Map::new();
    _ = args.insert("ref".into(), serde_json::json!(msg_ref));
    if let Some(role_filter) = role {
        _ = args.insert(
            "role".into(),
            serde_json::json!(role_filter.as_protocol_role()),
        );
    }
    _ = conn
        .send_command("get", serde_json::Value::Object(args))
        .await?;
    recv_command_data(conn).await
}

/// Render a `shore log` message list honoring `--json` / `--content` / `--plain`
/// (otherwise the boundary-annotated default view).
fn render_log_list(
    data: &serde_json::Value,
    json: bool,
    content: bool,
    plain: bool,
    display_character: &str,
    filter: output::LogFilter,
) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        cli_out!("{}", serde_json::to_string_pretty(data)?);
        return Ok(());
    }
    let Some(messages) = data.get("messages").and_then(serde_json::Value::as_array) else {
        return Ok(());
    };
    if content {
        for msg in messages {
            if let Some(c) = msg["content"].as_str() {
                cli_out!("{c}");
            }
        }
    } else if plain {
        let active_start = active_start_index(data);
        output::print_log_plain_with_boundary(messages, active_start, display_character, filter);
    } else {
        let active_start = active_start_index(data);
        output::print_log_with_boundary(messages, active_start, display_character, filter);
    }
    Ok(())
}

/// Stream live log frames after a `shore log --follow`, filtered by `role` and
/// the `--reasoning` / `--tools` / `--subagent-tools` channel flags.
async fn follow_log_stream(
    conn: &mut SWPConnection,
    role: Option<&LogRole>,
    follow_char: &str,
    filter: output::LogFilter,
) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        let msg = conn.recv().await?;
        // Sub-agent frames belong to the nested tool loop; gate them on
        // --subagent-tools regardless of frame kind.
        if msg.subagent().is_some() && !filter.subagent_tools {
            continue;
        }
        match &msg {
            ServerMessage::NewMessage(nm) if log_role_matches(role, &nm.message.role) => {
                output::print_new_message(nm, nm.character.as_deref().unwrap_or(follow_char));
            }
            ServerMessage::StreamStart(start) if log_role_matches(role, &Role::Assistant) => {
                output::reset_chunk_state();
                if start.regen {
                    output::print_stream_start(start.regen);
                } else {
                    output::print_follow_stream_start(follow_char);
                }
            }
            ServerMessage::StreamChunk(chunk) if log_role_matches(role, &Role::Assistant) => {
                // Hide reasoning chunks unless --reasoning is set.
                if chunk.content_type == "thinking" && !filter.reasoning {
                    continue;
                }
                output::print_chunk(chunk);
            }
            ServerMessage::StreamEnd(end) if log_role_matches(role, &Role::Assistant) => {
                output::print_stream_end(end);
            }
            ServerMessage::ToolCall(call) if log_role_matches(role, &Role::Assistant) => {
                if filter.tools {
                    output::print_tool_call(call);
                }
            }
            ServerMessage::ToolResult(result) if log_role_matches(role, &Role::Assistant) => {
                if filter.tools {
                    output::print_tool_result(result);
                }
            }
            ServerMessage::Phase(phase) if log_role_matches(role, &Role::Assistant) => {
                output::print_phase(phase);
            }
            ServerMessage::Shutdown(_) => break,
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::StreamStart(_)
            | ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::Phase(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::SendImage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown => {}
        }
    }
    Ok(())
}

/// Handle `shore send` / `shore send --system`: read the message (args, stdin,
/// or editor), then stream the response or inject a system message.
async fn handle_send_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Send {
        message,
        images,
        temperature,
        top_p,
        thinking,
        system,
    } = cmd
    else {
        return Ok(());
    };
    let text = if !message.is_empty() {
        message.join(" ")
    } else if !io::stdin().is_terminal() {
        read_stdin()?
    } else {
        edit_message_in_editor()?
    };
    if text.is_empty() && images.is_empty() {
        return Ok(());
    }
    if *system {
        _ = conn
            .send_command("inject_system", serde_json::json!({ "text": text }))
            .await?;
        let data = recv_command_data(conn).await?;
        output::format_command("inject_system", &data);
    } else {
        let overrides = if temperature.is_some() || top_p.is_some() || thinking.is_some() {
            Some(shore_protocol::client_msg::MessageOverrides {
                temperature: *temperature,
                top_p: *top_p,
                thinking_budget: *thinking,
            })
        } else {
            None
        };
        _ = conn
            .send_message_full(&text, true, images.clone(), overrides)
            .await?;
        recv_streaming_response(conn).await?;
    }
    Ok(())
}

/// Handle `shore alt`: map the selector/ref to its SWP command and render.
async fn handle_alt_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Alt {
        selector,
        msg_ref,
        json,
    } = cmd
    else {
        return Ok(());
    };
    let (name, args) = crate::cli::alt_command_to_swp(selector.as_deref(), msg_ref.as_deref());
    _ = conn.send_command(name, args).await?;
    let data = recv_command_data(conn).await?;
    if *json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        output::format_command(name, &data);
    }
    Ok(())
}

/// Handle `shore status` / `shore status --diagnostics`, including a single
/// `--section` lookup.
async fn handle_status_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    display_character: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Status {
        section,
        diagnostics,
        count,
        json,
        ..
    } = cmd
    else {
        return Ok(());
    };
    if *diagnostics {
        _ = conn
            .send_command("diagnostics", serde_json::json!({ "count": count }))
            .await?;
        let data = recv_command_data(conn).await?;
        if *json {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        } else {
            output::print_diagnostics(&data);
        }
        return Ok(());
    }
    _ = conn.send_command("status", serde_json::json!({})).await?;
    let data = recv_command_data(conn).await?;
    match section {
        Some(s) => {
            if let Some(val) = data.get(s.as_str()) {
                cli_out!("{}", serde_json::to_string_pretty(val)?);
            } else {
                return Err(format!("Unknown status section: {s}").into());
            }
        }
        None if *json => {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        }
        None => {
            output::print_status(&data, display_character);
        }
    }
    Ok(())
}

/// Handle the model commands the CLI applies locally — `model --reset` and a
/// bare `model <name>` switch — which clear the runtime mirror. (`--all`
/// propagates `include_hidden = true`, the documented escape hatch from the
/// `discovery.ignore` error message.)
async fn handle_local_model_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Model {
        name,
        reset,
        all,
        json,
        ..
    } = cmd
    else {
        return Ok(());
    };
    if *reset {
        _ = conn
            .send_command("reset_model", serde_json::json!({}))
            .await?;
        let data = recv_command_data(conn).await?;
        _ = state::clear_active_model();
        if *json {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        } else {
            output::format_command("reset_model", &data);
        }
        return Ok(());
    }
    let mut args = serde_json::Map::new();
    if let Some(model_name) = name {
        _ = args.insert("name".into(), serde_json::json!(model_name));
    }
    if *all {
        _ = args.insert("include_hidden".into(), serde_json::json!(true));
    }
    _ = conn
        .send_command("switch_model", serde_json::Value::Object(args))
        .await?;
    let data = recv_command_data(conn).await?;
    _ = state::clear_active_model();
    if *json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        output::format_command("switch_model", &data);
    }
    Ok(())
}

/// Handle the commands that never need a daemon connection — `config --path`,
/// `character --new`, `connectors`, and `complete`. Returns `Some(result)` when
/// one of them ran, or `None` to continue with the normal connected path.
async fn try_handle_local_only(cli: &Cli) -> Option<Result<(), Box<dyn std::error::Error>>> {
    // config --path: query the daemon for its actual config dir, fall back to local.
    if matches!(&cli.command, CliCommand::Config { path: true, .. }) {
        return Some(print_config_path(cli).await);
    }
    if let CliCommand::Character {
        name: Some(name),
        new: true,
        ..
    } = &cli.command
    {
        return Some(handle_create_character(name));
    }
    if let CliCommand::Connectors { subcommand } = &cli.command {
        return Some(handle_connectors_command(subcommand, cli));
    }
    if let CliCommand::Complete { kind } = &cli.command {
        // Any failure (daemon down, parse error) ends with empty stdout
        // and a zero exit code so fish falls back to no suggestions.
        let _ignored = handle_complete_query(*kind, cli).await;
        return Some(Ok(()));
    }
    None
}

/// Best-effort re-apply of the persisted active model after connecting.
///
/// Regression for #3: `switch_model` only mutates per-session state on the
/// daemon, so a one-shot CLI invocation discards the choice on exit. Re-apply
/// it here so every subsequent command sees it. A stale entry (model removed
/// from config) must not stop the user's actual command.
async fn pre_apply_active_model(conn: &mut SWPConnection, cli: &Cli) {
    if matches!(cli.command, CliCommand::Notify { .. }) {
        return;
    }
    let Some(model) = state::read_active_model() else {
        return;
    };
    if let Err(e) = conn
        .send_command("switch_model", serde_json::json!({ "name": &model }))
        .await
    {
        debug!(error = %e, model = %model, "failed to pre-apply active model");
        return;
    }
    // Drain the response so it doesn't get mixed into the next command's
    // stream. Errors (e.g. stale model) are ignored — the user's real
    // command still runs.
    match conn.recv().await {
        Ok(ServerMessage::CommandOutput(_)) => {
            debug!(model = %model, "pre-applied active model");
        }
        Ok(ServerMessage::Error(err)) => {
            debug!(
                model = %model,
                error = %err.message,
                "stale active-model state file, ignoring",
            );
        }
        Ok(other) => {
            debug!(?other, "unexpected reply to pre-apply switch_model");
        }
        Err(e) => {
            debug!(error = %e, "error draining pre-apply switch_model reply");
        }
    }
}

/// Handle `switch-character` locally: validate via daemon, write state file.
async fn handle_switch_character(
    conn: &mut SWPConnection,
    name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    info!(character = name, "Switching active character");
    let _ignored = conn
        .send_command("switch_character", serde_json::json!({ "name": name }))
        .await?;
    _ = recv_command_data(conn).await?;
    state::write_active_character(name)?;
    cli_out!("Switched to character: {name}");
    cli_out!("To override per-terminal: export SHORE_CHARACTER={name}");
    Ok(())
}

/// Handle `list-characters`: query daemon, annotate active character.
async fn handle_list_characters(
    conn: &mut SWPConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ignored = conn
        .send_command("list_characters", serde_json::json!({}))
        .await?;
    let data = recv_command_data(conn).await?;

    let active = state::read_active_character();

    if let Some(chars) = data.get("characters").and_then(serde_json::Value::as_array) {
        debug!(count = chars.len(), "Listed characters from daemon");
        for ch in chars {
            if let Some(name) = ch["name"].as_str() {
                if active.as_deref() == Some(name) {
                    cli_out!("  * {name} (active)");
                } else {
                    cli_out!("    {name}");
                }
            }
        }
    }
    Ok(())
}

/// Emit plain names (one per line) for shell completion helpers.
///
/// Errors are returned so the caller can swallow them — completion tooling
/// must never print to stderr or exit non-zero on transient failures.
async fn handle_complete_query(
    kind: crate::cli::CompleteKind,
    cli: &Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::cli::CompleteKind;
    let addr = resolve_addr(cli)?;
    // Character selection doesn't matter for list_models/list_characters,
    // so hand the daemon None and let it auto-attach.
    let (mut conn, _hello, _history) =
        SWPConnection::connect(&addr, "cli", "shore-cli", None).await?;

    let (cmd, array_key) = match kind {
        CompleteKind::Models => ("list_models", "models"),
        CompleteKind::Characters => ("list_characters", "characters"),
        CompleteKind::Providers => ("list_providers", "providers"),
    };

    let _ignored = conn.send_command(cmd, serde_json::json!({})).await?;
    let data = recv_command_data(&mut conn).await?;
    if let Some(items) = data.get(array_key).and_then(serde_json::Value::as_array) {
        for item in items {
            if let Some(name) = item["name"].as_str() {
                cli_out!("{name}");
            }
        }
    }
    Ok(())
}

/// Handle `shore connectors` subcommands. Today only Matrix exists, so
/// this dispatches to its handler; new connectors get their own arms here.
fn handle_connectors_command(
    subcommand: &crate::cli::ConnectorsCommand,
    cli: &Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    match subcommand {
        crate::cli::ConnectorsCommand::Matrix {
            subcommand: matrix_sub,
        } => handle_matrix_command(matrix_sub, cli),
    }
}

/// Handle `shore connectors matrix` subcommands by delegating to the
/// `shore-matrix` binary.
///
/// Packaged installs keep the bridge off `$PATH`; [`MATRIX_BIN_ENV`] and the
/// libexec fallbacks are what still make it reachable from here.
fn handle_matrix_command(
    subcommand: &crate::cli::MatrixCommand,
    cli: &Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    // Resolved the same way the daemon resolves it, so `shore connectors
    // matrix ...` keeps working when packaging holds the bridge off `$PATH`.
    let binary = shore_config::binaries::resolve("shore-matrix", MATRIX_BIN_ENV)
        .path
        .ok_or_else(|| {
            format!(
                "shore-matrix binary not found via {}. Install it, or point \
                 {MATRIX_BIN_ENV} at it.",
                shore_config::binaries::searched_locations(MATRIX_BIN_ENV)
            )
        })?;
    let mut cmd = std::process::Command::new(&binary);

    // Config + data discovery: ask the running daemon via the instance
    // registry so interactive invocations work even when the shell lacks
    // SHORE_CONFIG_DIR / SHORE_DATA_DIR (typical when the daemon runs
    // under systemd with those set in the unit file).
    let resolved_config = match cli.config.clone() {
        Some(c) => Some(c),
        None => shore_swp_client::discover_config_dir()
            .ok()
            .flatten()
            .map(|p| p.display().to_string()),
    };
    if let Some(ref config) = resolved_config {
        let _ignored = cmd.arg("--config").arg(config);
    }
    if std::env::var_os("SHORE_DATA_DIR").is_none() {
        if let Some(data_dir) = shore_swp_client::discover_data_dir().ok().flatten() {
            let _ignored = cmd.env("SHORE_DATA_DIR", data_dir);
        }
    }
    if let Some(ref addr) = cli.addr {
        let _ignored = cmd.arg("--addr").arg(addr);
    }

    match subcommand {
        crate::cli::MatrixCommand::Setup => {
            let _ignored = cmd.arg("--setup");
        }
        crate::cli::MatrixCommand::Register { username, password } => {
            let _ignored = cmd.arg("--register").arg(username);
            if let Some(pw) = password {
                _ = cmd.arg("--register-password").arg(pw);
            }
        }
    }

    let status = cmd
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .map_err(|e| format!("failed to run {}: {e}", binary.display()))?;

    if !status.success() {
        return Err(format!("shore-matrix exited with status {status}").into());
    }
    Ok(())
}

/// Create a new character scaffold directory.
fn handle_create_character(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let char_dir = create_character_scaffold(&config_dir(), name)?;
    cli_out!("Created character scaffold: {}", char_dir.display());
    Ok(())
}

/// Scaffold `characters/<name>/workspace/SOUL.md` under `config_dir`.
///
/// Errors if the character already exists in either the canonical
/// (`workspace/SOUL.md`) or legacy (`character.md`) layout, matching
/// `shore_config::discover_characters`. Returns the character directory.
fn create_character_scaffold(
    config_dir: &Path,
    name: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let char_dir = config_dir.join("characters").join(name);
    let workspace_dir = char_dir.join(shore_config::CHARACTER_WORKSPACE_DIR);
    let soul_md = workspace_dir.join(shore_config::SOUL_FILE);

    if soul_md.exists() || char_dir.join("character.md").exists() {
        return Err(format!(
            "Character '{}' already exists at {}",
            name,
            char_dir.display()
        )
        .into());
    }

    std::fs::create_dir_all(&workspace_dir)?;
    std::fs::write(
        &soul_md,
        format!("You are {name}.\n\n<!-- Edit this file to define {name}'s personality and behavior. -->\n"),
    )?;
    Ok(char_dir)
}

/// Resolve the Shore config directory.
fn config_dir() -> PathBuf {
    shore_config::config_dir()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotifyMode {
    AutonomousOnly,
    AllMessages,
}

const NOTIFY_PREVIEW_MAX: usize = 200;

async fn handle_notify(
    conn: &mut SWPConnection,
    cli: &Cli,
    all_messages: bool,
    characters: &[CharacterInfo],
) -> Result<(), Box<dyn std::error::Error>> {
    let mode = if all_messages {
        NotifyMode::AllMessages
    } else {
        NotifyMode::AutonomousOnly
    };
    let config_dir = resolve_notify_config_dir(cli);
    let requested_character = cli.character.as_deref();
    let avatars = notification_avatars(characters);

    info!(
        character = ?requested_character,
        all_messages,
        config_dir = %config_dir.display(),
        "starting desktop notification listener"
    );

    loop {
        match conn.recv().await? {
            ServerMessage::NewMessage(msg) => {
                if should_notify_message(&msg, requested_character, mode) {
                    let character = notify_character(&msg, requested_character);
                    let title = format!("Shore - {character}");
                    let body = notification_preview(&msg.message.content)
                        .unwrap_or_else(|| "New message".to_owned());
                    let icon =
                        notification_icon_path(&config_dir, character, avatars.get(character));
                    if let Err(e) = send_desktop_notification(&title, &body, icon.as_deref()) {
                        warn!(error = %e, "desktop notification failed");
                    }
                }
            }
            ServerMessage::Shutdown(_) => break,
            ServerMessage::Ping(_) | ServerMessage::History(_) => {}
            other @ (ServerMessage::Hello(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::Error(_)
            | ServerMessage::StreamStart(_)
            | ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::Phase(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::SendImage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown) => {
                debug!(?other, "ignoring non-notification event");
            }
        }
    }

    Ok(())
}

fn notification_avatars(characters: &[CharacterInfo]) -> HashMap<String, CharacterAvatar> {
    characters
        .iter()
        .filter_map(|info| {
            info.avatar
                .clone()
                .map(|avatar| (info.name.clone(), avatar))
        })
        .collect()
}

fn resolve_notify_config_dir(cli: &Cli) -> PathBuf {
    if let Some(config) = &cli.config {
        let path = PathBuf::from(config);
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "config.toml")
            || path.extension().and_then(|ext| ext.to_str()) == Some("toml")
        {
            return path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf();
        }
        return path;
    }

    shore_swp_client::discover_config_dir()
        .ok()
        .flatten()
        .unwrap_or_else(config_dir)
}

fn should_notify_message(
    msg: &NewMessage,
    requested_character: Option<&str>,
    mode: NotifyMode,
) -> bool {
    if let Some(character) = requested_character {
        if msg.character.as_deref() != Some(character) {
            return false;
        }
    }

    match mode {
        NotifyMode::AutonomousOnly => msg.message.origin == Some(MessageOrigin::Autonomous),
        NotifyMode::AllMessages => {
            msg.message.role == Role::Assistant
                && matches!(
                    msg.message.origin,
                    Some(MessageOrigin::AssistantReply | MessageOrigin::Autonomous)
                )
        }
    }
}

fn notify_character<'msg>(
    msg: &'msg NewMessage,
    requested_character: Option<&'msg str>,
) -> &'msg str {
    msg.character
        .as_deref()
        .or(requested_character)
        .unwrap_or_else(|| session_display_character())
}

fn notification_preview(content: &str) -> Option<String> {
    let line = content
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(content)
        .trim();
    if line.is_empty() {
        return None;
    }

    let mut preview = String::new();
    for ch in line.chars().take(NOTIFY_PREVIEW_MAX) {
        preview.push(ch);
    }
    if line.chars().count() > NOTIFY_PREVIEW_MAX {
        preview.push_str("...");
    }
    Some(preview)
}

fn notification_icon_path(
    config_dir: &Path,
    character: &str,
    remote_avatar: Option<&CharacterAvatar>,
) -> Option<PathBuf> {
    if let Some(avatar) = remote_avatar {
        match cache_avatar_icon(character, avatar) {
            Ok(path) => return Some(path),
            Err(e) => warn!(
                character,
                error = %e,
                "failed to cache remote notification avatar"
            ),
        }
    }

    local_avatar_icon_path(config_dir, character)
}

fn local_avatar_icon_path(config_dir: &Path, character: &str) -> Option<PathBuf> {
    for filename in ["avatar.png", "avatar.jpg", "avatar.jpeg", "avatar.webp"] {
        let path = config_dir.join("characters").join(character).join(filename);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn cache_avatar_icon(
    character: &str,
    avatar: &CharacterAvatar,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cache_dir = shore_config::ShoreDirs::resolve()
        .cache
        .join("notification-icons");
    cache_avatar_icon_in_dir(&cache_dir, character, avatar)
}

fn cache_avatar_icon_in_dir(
    cache_dir: &Path,
    character: &str,
    avatar: &CharacterAvatar,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let bytes = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(&avatar.data)?
    };
    if bytes.is_empty() {
        return Err("remote avatar payload is empty".into());
    }

    std::fs::create_dir_all(cache_dir)?;
    let path = cache_dir.join(format!(
        "{}.{}",
        notification_avatar_basename(character),
        notification_avatar_extension(&avatar.mime_type)
    ));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

fn notification_avatar_basename(character: &str) -> String {
    let basename: String = character
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if basename.is_empty() {
        "character".to_owned()
    } else {
        basename
    }
}

fn notification_avatar_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "img",
    }
}

fn send_desktop_notification(
    title: &str,
    body: &str,
    icon: Option<&Path>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut cmd = std::process::Command::new("notify-send");
    let _ignored = cmd.arg("--app-name=shore");
    if let Some(icon_path) = icon {
        _ = cmd.arg("--icon").arg(icon_path);
    }
    let status = cmd.arg(title).arg(body).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("notify-send exited with status {status}").into())
    }
}

/// Print the config directory path by querying the daemon.
/// Falls back to local resolution if the daemon is unreachable.
async fn print_config_path(cli: &Cli) -> Result<(), Box<dyn std::error::Error>> {
    let addr = resolve_addr(cli)?;
    let character = cli.character.clone().or_else(state::read_active_character);

    if let Ok((mut conn, _hello, _history)) =
        SWPConnection::connect(&addr, "cli", "shore-cli", character).await
    {
        let _ignored = conn.send_command("status", serde_json::json!({})).await?;
        let data = recv_command_data(&mut conn).await?;
        if let Some(dir) = data.get("config_dir").and_then(serde_json::Value::as_str) {
            cli_out!("{dir}");
        } else {
            cli_out!("{}", config_dir().display());
        }
        Ok(())
    } else {
        cli_err!("(no daemon running — showing local config dir)");
        cli_out!("{}", config_dir().display());
        Ok(())
    }
}

/// Print the `shore config` payload as TOML, ready to paste into a config file.
///
/// With `show_all = false`, drops keys whose value equals the daemon's built-in
/// default so the output is a diff against defaults — paste-able to override
/// only what you've customized.
fn print_config_toml(
    data: &serde_json::Value,
    show_all: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let payload = data.get("config").unwrap_or(data);
    let key = data.get("key").and_then(|v| v.as_str());
    // Prefer the daemon-supplied baseline; synthesize one locally if absent so
    // we behave the same against pre-defaults daemons.
    let local_baseline;
    let defaults: Option<&serde_json::Value> = if let Some(d) = data.get("defaults") {
        Some(d)
    } else {
        local_baseline = serde_json::to_value(shore_config::app::AppConfig::default()).ok();
        match key {
            Some(k) => local_baseline.as_ref().and_then(|d| d.get(k)),
            None => local_baseline.as_ref(),
        }
    };
    let filtered: serde_json::Value;
    let effective: &serde_json::Value = if show_all {
        payload
    } else {
        // If nothing differs from defaults, render an empty table rather than
        // erroring out — `shore config --toml` should still succeed.
        filtered = filter_non_defaults(payload, defaults)
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        &filtered
    };

    // Section view (`shore config <key> --toml`): wrap the subtree under its
    // table name so the output drops into a config file as-is — otherwise
    // nested tables would be at root level (e.g. `[heartbeat]` instead of
    // `[behavior.heartbeat]`).
    let section_payload;
    let to_serialize: &serde_json::Value = if let Some(k) = key {
        let mut section_map = serde_json::Map::new();
        let _ignored = section_map.insert(k.to_owned(), effective.clone());
        section_payload = serde_json::Value::Object(section_map);
        &section_payload
    } else {
        effective
    };

    let toml_value =
        json_to_toml_value(to_serialize).ok_or("config payload is not a TOML table")?;
    let rendered = match toml_value {
        toml::Value::Table(t) => toml::to_string_pretty(&t)?,
        other @ (toml::Value::String(_)
        | toml::Value::Integer(_)
        | toml::Value::Float(_)
        | toml::Value::Boolean(_)
        | toml::Value::Datetime(_)
        | toml::Value::Array(_)) => toml::to_string_pretty(&other)?,
    };
    cli_write!("{rendered}");
    Ok(())
}

/// Return a copy of `value` with every leaf that equals its corresponding entry
/// in `defaults` removed, and subtables with no surviving descendants pruned.
/// Returns `None` when nothing survives.
fn filter_non_defaults(
    value: &serde_json::Value,
    defaults: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let d = defaults.and_then(|dd| dd.get(k));
                if matches!(v, serde_json::Value::Object(_)) {
                    if let Some(sub) = filter_non_defaults(v, d) {
                        let _ignored = out.insert(k.clone(), sub);
                    }
                } else if d.is_none_or(|dd| dd != v) {
                    let _ignored = out.insert(k.clone(), v.clone());
                } else {
                    // Value equals its default: omit it from the diff.
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(serde_json::Value::Object(out))
            }
        }
        leaf @ (serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_)
        | serde_json::Value::Array(_)) => {
            if defaults.is_none_or(|d| d != leaf) {
                Some(leaf.clone())
            } else {
                None
            }
        }
    }
}

/// Convert a `serde_json::Value` to a `toml::Value`, preserving key order but
/// emitting non-table fields before nested tables so the TOML serializer never
/// hits a "value after table" error. Drops `null` entries (TOML has no null).
fn json_to_toml_value(value: &serde_json::Value) -> Option<toml::Value> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(toml::Value::Boolean(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(toml::Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Some(toml::Value::Float(f))
            } else {
                Some(toml::Value::String(n.to_string()))
            }
        }
        serde_json::Value::String(s) => Some(toml::Value::String(s.clone())),
        serde_json::Value::Array(arr) => Some(toml::Value::Array(
            arr.iter().filter_map(json_to_toml_value).collect(),
        )),
        serde_json::Value::Object(map) => {
            let mut table = toml::value::Table::new();
            let converted: Vec<(&String, toml::Value)> = map
                .iter()
                .filter_map(|(k, v)| json_to_toml_value(v).map(|tv| (k, tv)))
                .collect();
            for (k, v) in &converted {
                if !matches!(v, toml::Value::Table(_)) {
                    let _ignored = table.insert((*k).clone(), v.clone());
                }
            }
            for (k, v) in &converted {
                if matches!(v, toml::Value::Table(_)) {
                    let _ignored = table.insert((*k).clone(), v.clone());
                }
            }
            Some(toml::Value::Table(table))
        }
    }
}

/// Read all of stdin to a string (for piped input).
fn read_stdin() -> Result<String, Box<dyn std::error::Error>> {
    let mut buf = String::new();
    let _ignored = io::stdin().read_to_string(&mut buf)?;
    Ok(buf.trim().to_owned())
}

/// Open `$EDITOR` (or `$VISUAL`) with a temp file and return the composed text.
/// Returns an empty string if the user saves an empty file or the editor exits non-zero.
fn edit_message_in_editor() -> Result<String, Box<dyn std::error::Error>> {
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".into());

    let tmp = tempfile::Builder::new()
        .prefix("shore-")
        .suffix(".md")
        .tempfile()?;

    let path = tmp.path().to_path_buf();

    let status = std::process::Command::new(&editor).arg(&path).status()?;

    if !status.success() {
        return Ok(String::new());
    }

    let content = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_owned();

    Ok(content)
}

/// Resolve the daemon address from CLI flags or discovery.
fn resolve_addr(cli: &Cli) -> Result<ServerAddr, shore_swp_client::ClientError> {
    if let Some(addr) = &cli.addr {
        return Ok(ServerAddr(addr.clone()));
    }
    shore_swp_client::discover_or_default(cli.config.as_deref())
}

/// Receive and render a streaming response (for send/regen).
#[expect(
    clippy::too_many_lines,
    reason = "receives every streaming server message and renders chunks, tool calls, and nested sub-agent output"
)]
async fn recv_streaming_response(
    conn: &mut SWPConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut spinner = output::StreamSpinner::new();
    spinner.start();

    // Reset once per turn (not per tool-loop round) so blank-line separation
    // between blocks survives across rounds.
    output::reset_chunk_state();

    // Which sub-agent's nested loop we're currently rendering, if any. A frame
    // tagged with a sub-agent name opens the section; the first untagged frame
    // after it closes the section. (The primary loop is blocked awaiting the
    // sub-agent, so its frames can't interleave, and nesting is one level deep.)
    let mut current_subagent: Option<String> = None;

    loop {
        let msg = conn.recv().await?;

        // Bracket sub-agent activity on tag transitions.
        let tag = msg.subagent();
        if tag != current_subagent.as_deref() {
            if let Some(prev) = &current_subagent {
                spinner.clear().await;
                output::print_subagent_end(prev);
            }
            if let Some(name) = tag {
                spinner.clear().await;
                output::print_subagent_begin(name);
            }
            current_subagent = tag.map(str::to_owned);
        }

        match &msg {
            ServerMessage::StreamStart(start) => {
                output::print_stream_start(start.regen);
            }
            ServerMessage::StreamChunk(chunk) => {
                spinner.clear().await;
                if chunk.subagent.is_some() {
                    output::print_subagent_chunk(chunk);
                } else {
                    output::print_chunk(chunk);
                }
            }
            ServerMessage::StreamEnd(end) => {
                // A sub-agent boundary never ends the primary generation — keep
                // the spinner up and read on.
                if end.subagent.is_some() {
                    spinner.restart();
                    continue;
                }
                spinner.stop().await;
                debug!(finish_reason = end.finish_reason, "Stream complete");
                if end.finish_reason == "tool_use" {
                    // Tool loop: more messages will follow.
                    // Restart spinner for the next LLM round.
                    spinner.restart();
                    continue;
                }
                output::print_stream_end(end);
                return Ok(());
            }
            ServerMessage::ToolCall(call) => {
                spinner.clear().await;
                if call.subagent.is_some() {
                    output::print_subagent_tool_call(call);
                } else {
                    output::print_tool_call(call);
                }
            }
            ServerMessage::ToolResult(result) => {
                if result.subagent.is_some() {
                    output::print_subagent_tool_result(result);
                } else {
                    output::print_tool_result(result);
                }
            }
            ServerMessage::Error(err) => {
                spinner.stop().await;
                output::print_server_error(
                    &serde_json::to_string(&err.code).unwrap_or_default(),
                    &err.message,
                );
                return Err(err.message.clone().into());
            }
            ServerMessage::SendImage(img) => {
                output::print_send_image(img);
            }
            ServerMessage::Phase(phase) => {
                // Update spinner instead of printing static label when active.
                if spinner.is_active() {
                    spinner.set_phase(&phase.phase);
                    if let Some(model) = &phase.model {
                        spinner.set_model(Some(model.clone()));
                    }
                } else {
                    output::print_phase(phase);
                }
            }
            ServerMessage::ProviderFallbackWarning(w) => {
                spinner.clear().await;
                output::print_provider_fallback_warning(w);
            }
            ServerMessage::UsageWarning(w) => {
                spinner.clear().await;
                output::print_usage_warning(w);
            }
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::Unknown => {}
        }
    }
}

/// Receive a command response and return the data payload.
async fn recv_command_data(
    conn: &mut SWPConnection,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    loop {
        let msg = conn.recv().await?;
        match &msg {
            ServerMessage::CommandOutput(co) => {
                return Ok(co.data.clone());
            }
            ServerMessage::Error(err) => {
                output::print_server_error(
                    &serde_json::to_string(&err.code).unwrap_or_default(),
                    &err.message,
                );
                return Err(err.message.clone().into());
            }
            ServerMessage::SendImage(img) => {
                output::print_send_image(img);
            }
            ServerMessage::NewMessage(new_msg) => {
                output::print_new_message(
                    new_msg,
                    new_msg
                        .character
                        .as_deref()
                        .unwrap_or_else(|| session_display_character()),
                );
            }
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::StreamStart(_)
            | ServerMessage::StreamChunk(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::Phase(_)
            | ServerMessage::ToolCall(_)
            | ServerMessage::ToolResult(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::Unknown => {}
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use tokio::io::duplex;
    use tokio::io::AsyncWriteExt;

    use shore_protocol::client_msg::ClientMessage;
    use shore_protocol::server_msg::*;
    use shore_protocol::types::*;
    use shore_protocol::SWP_V1;

    use crate::cli::{Cli, CliCommand};

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    fn arg<'val>(args: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        args.get(key).expect("expected command argument")
    }

    fn notify_msg(character: &str, origin: Option<MessageOrigin>, role: Role) -> NewMessage {
        NewMessage {
            revision: 1,
            character: Some(character.into()),
            message: Message {
                msg_id: "m1".into(),
                origin,
                role,
                content: "hello".into(),
                images: vec![],
                content_blocks: vec![],
                alt_index: None,
                alt_count: None,
                alternatives: vec![],
                provider_key: None,
                model: None,
                timestamp: "2026-01-01T00:00:00Z".into(),
            },
        }
    }

    #[test]
    fn notify_filter_autonomous_only() {
        let auto = notify_msg("Alice", Some(MessageOrigin::Autonomous), Role::Assistant);
        let reply = notify_msg(
            "Alice",
            Some(MessageOrigin::AssistantReply),
            Role::Assistant,
        );
        assert!(super::should_notify_message(
            &auto,
            None,
            super::NotifyMode::AutonomousOnly
        ));
        assert!(!super::should_notify_message(
            &reply,
            None,
            super::NotifyMode::AutonomousOnly
        ));
    }

    #[test]
    fn notify_filter_all_messages_assistant_only() {
        let reply = notify_msg(
            "Alice",
            Some(MessageOrigin::AssistantReply),
            Role::Assistant,
        );
        let user = notify_msg("Alice", Some(MessageOrigin::UserInput), Role::User);
        assert!(super::should_notify_message(
            &reply,
            None,
            super::NotifyMode::AllMessages
        ));
        assert!(!super::should_notify_message(
            &user,
            None,
            super::NotifyMode::AllMessages
        ));
    }

    #[test]
    fn notify_filter_respects_character() {
        let auto = notify_msg("Alice", Some(MessageOrigin::Autonomous), Role::Assistant);
        assert!(super::should_notify_message(
            &auto,
            Some("Alice"),
            super::NotifyMode::AutonomousOnly
        ));
        assert!(!super::should_notify_message(
            &auto,
            Some("Bob"),
            super::NotifyMode::AutonomousOnly
        ));
    }

    #[test]
    fn notification_preview_uses_first_non_empty_line_and_truncates() {
        let content = format!(
            "\n\n  {}\nsecond",
            "x".repeat(super::NOTIFY_PREVIEW_MAX + 2)
        );
        let preview = super::notification_preview(&content).unwrap();
        assert_eq!(preview.len(), super::NOTIFY_PREVIEW_MAX + 3);
        assert!(preview.ends_with("..."));
    }

    #[test]
    fn avatar_icon_path_requires_existing_avatar() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("characters").join("Alice");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(super::local_avatar_icon_path(tmp.path(), "Alice").is_none());
        std::fs::write(dir.join("avatar.png"), b"png").unwrap();
        assert!(super::local_avatar_icon_path(tmp.path(), "Alice").is_some());
    }

    #[test]
    fn notification_avatars_indexes_handshake_avatars() {
        let avatars = super::notification_avatars(&[CharacterInfo {
            name: "Alice".into(),
            avatar: Some(CharacterAvatar {
                mime_type: "image/png".into(),
                data: "cG5n".into(),
            }),
        }]);
        assert_eq!(
            avatars.get("Alice").map(|avatar| avatar.mime_type.as_str()),
            Some("image/png")
        );
    }

    #[test]
    fn cache_avatar_icon_materializes_remote_avatar() {
        let tmp = tempfile::tempdir().unwrap();
        let avatar = CharacterAvatar {
            mime_type: "image/png".into(),
            data: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(b"png")
            },
        };

        let path = super::cache_avatar_icon_in_dir(tmp.path(), "Alice Smith", &avatar).unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("Alice_Smith.png")
        );
        assert_eq!(std::fs::read(path).unwrap(), b"png");
    }

    #[test]
    fn cache_avatar_icon_uses_mime_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let avatar = CharacterAvatar {
            mime_type: "image/jpeg".into(),
            data: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(b"jpg")
            },
        };

        let path = super::cache_avatar_icon_in_dir(cache.path(), "Alice", &avatar).unwrap();
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("jpg"));
        assert!(super::local_avatar_icon_path(tmp.path(), "Alice").is_none());
    }

    /// Helper: write a JSON line to a writer.
    async fn write_json_line<W: AsyncWriteExt + Unpin, T: serde::Serialize>(w: &mut W, val: &T) {
        let line = serde_json::to_string(val).unwrap();
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    /// Helper: read one JSON line from a reader.
    async fn read_json_line<
        R: tokio::io::AsyncBufReadExt + Unpin,
        T: serde::de::DeserializeOwned,
    >(
        r: &mut R,
    ) -> T {
        let mut line = String::new();
        let _ignored = r.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    /// Spawn a mock SWP server that completes the handshake, reads one client
    /// message, and responds with the given server messages.
    async fn mock_server(
        server_stream: tokio::io::DuplexStream,
        responses: Vec<ServerMessage>,
    ) -> ClientMessage {
        let (r, mut w) = tokio::io::split(server_stream);
        let mut reader = tokio::io::BufReader::new(r);

        // Handshake: send server hello
        let hello = ServerMessage::Hello(ServerHello {
            v: SWP_V1,
            server_name: "test-daemon".into(),
            characters: vec![],
        });
        write_json_line(&mut w, &hello).await;

        // Read client hello
        let _client_hello: ClientMessage = read_json_line(&mut reader).await;

        // Send empty history
        let history = ServerMessage::History(History {
            rid: None,
            messages: vec![],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: None,
            revision: 0,
        });
        write_json_line(&mut w, &history).await;

        // Read the client's command/message
        let client_msg: ClientMessage = read_json_line(&mut reader).await;

        // Send all response messages
        for msg in &responses {
            write_json_line(&mut w, msg).await;
        }

        client_msg
    }

    /// Build a Cli struct for testing (bypasses actual socket connection).
    fn test_cli(command: CliCommand) -> Cli {
        Cli {
            addr: None,
            config: None,
            character: None,
            no_color: false,
            command,
        }
    }

    /// Execute a command against a mock server and return what the server received.
    async fn execute_with_mock(cli: Cli, responses: Vec<ServerMessage>) -> ClientMessage {
        let (client_stream, server_stream) = duplex(16384);

        let server_handle = tokio::spawn(mock_server(server_stream, responses));

        // Connect using the raw stream and run the command logic
        let (mut conn, _hello, _history) = shore_swp_client::SWPConnection::connect_raw(
            client_stream,
            "cli",
            "shore-cli",
            cli.character.clone(),
        )
        .await
        .unwrap();

        match &cli.command {
            CliCommand::Send {
                message, images, ..
            } => {
                let text = message.join(" ");
                let _ignored = conn
                    .send_message_with_images(&text, true, images.clone())
                    .await
                    .unwrap();
                super::recv_streaming_response(&mut conn).await.unwrap();
            }
            CliCommand::Regen { guidance } => {
                let _ignored = conn.send_regen(true, guidance.clone()).await.unwrap();
                super::recv_streaming_response(&mut conn).await.unwrap();
            }
            other @ (CliCommand::Alt { .. }
            | CliCommand::Notify { .. }
            | CliCommand::Log { .. }
            | CliCommand::Character { .. }
            | CliCommand::Status { .. }
            | CliCommand::Debug { .. }
            | CliCommand::Model { .. }
            | CliCommand::Provider { .. }
            | CliCommand::Memory { .. }
            | CliCommand::Config { .. }
            | CliCommand::Tools { .. }
            | CliCommand::Usage { .. }
            | CliCommand::Connectors { .. }
            | CliCommand::Completions { .. }
            | CliCommand::Complete { .. }) => {
                let (name, args) = crate::cli::to_swp_command(other).unwrap();
                let _ignored = conn.send_command(name, args).await.unwrap();
                let _data = super::recv_command_data(&mut conn).await.unwrap();
            }
        }

        drop(conn);
        server_handle.await.unwrap()
    }

    fn streaming_response(text: &str) -> Vec<ServerMessage> {
        vec![
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                rid: None,
                regen: false,
            }),
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                rid: None,
                text: text.into(),
                content_type: "text".into(),
            }),
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: text.into(),
                metadata: StreamMetadata {
                    tokens: TokenCounts {
                        input: 10,
                        output: 5,
                        cache_read: 0,
                        cache_write: 0,
                    },
                    timing: TimingInfo {
                        total_ms: 100,
                        ttft_ms: 20,
                    },
                    model: "test-model".into(),
                },
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        ]
    }

    fn command_response(name: &str) -> Vec<ServerMessage> {
        vec![ServerMessage::CommandOutput(CommandOutput {
            rid: None,
            name: name.into(),
            data: serde_json::json!({"ok": true}),
        })]
    }

    // ── Send command ─────────────────────────────────────────────────

    #[tokio::test]
    async fn send_sends_swp_message() {
        let cli = test_cli(CliCommand::Send {
            message: vec!["hello".into(), "world".into()],
            images: vec![],
            temperature: None,
            top_p: None,
            thinking: None,
            system: false,
        });
        let received = execute_with_mock(cli, streaming_response("Hi there!")).await;

        assert_variant!(
            received,
            ClientMessage::Message(m) => {
                assert_eq!(m.text, "hello world");
                assert!(m.stream);
            }
        );
    }

    // ── Regen command ────────────────────────────────────────────────

    #[tokio::test]
    async fn regen_sends_swp_regen() {
        let cli = test_cli(CliCommand::Regen {
            guidance: Some("be funny".into()),
        });
        let received = execute_with_mock(cli, streaming_response("Haha!")).await;

        assert_variant!(
            received,
            ClientMessage::Regen(r) => {
                assert!(r.stream);
                assert_eq!(r.guidance.as_deref(), Some("be funny"));
            }
        );
    }

    // ── Status command ───────────────────────────────────────────────

    #[tokio::test]
    async fn status_sends_swp_command() {
        let cli = test_cli(CliCommand::Status {
            section: None,
            diagnostics: false,
            count: 10,
            json: false,
        });
        let received = execute_with_mock(cli, command_response("status")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "status");
            }
        );
    }

    // ── Character is handled locally (see state.rs) ───────────────

    // ── Memory compact command ───────────────────────────────────────

    #[tokio::test]
    async fn memory_compact_sends_command() {
        let cli = test_cli(CliCommand::Memory {
            subcommand: Some(crate::cli::MemoryCommand::Compact { keep_turns: None }),
            query: None,
            json: false,
        });
        let received = execute_with_mock(cli, command_response("compact")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "compact");
                assert_eq!(c.args, serde_json::json!({}));
            }
        );
    }

    // ── Memory query command ─────────────────────────────────────────

    #[tokio::test]
    async fn memory_sends_command_with_query() {
        let cli = test_cli(CliCommand::Memory {
            subcommand: None,
            query: Some("recent topics".into()),
            json: false,
        });
        let received = execute_with_mock(cli, command_response("memory")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "memory");
                assert_eq!(arg(&c.args, "query"), "recent topics");
            }
        );
    }

    // ── Log edit command ─────────────────────────────────────────────

    #[tokio::test]
    async fn log_edit_sends_edit_command() {
        let cli = test_cli(CliCommand::Log {
            subcommand: Some(crate::cli::LogCommand::Edit {
                msg_ref: "m1".into(),
                content: vec!["new".into(), "text".into()],
            }),
            msg_ref: None,
            count: 20,
            role: None,
            follow: false,
            json: false,
            content: false,
            plain: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
            heartbeat: false,
            dreaming: false,
            events: false,
            api: None,
            call_type: None,
        });
        let received = execute_with_mock(cli, command_response("edit")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "edit");
                assert_eq!(arg(&c.args, "ref"), "m1");
                assert_eq!(arg(&c.args, "content"), "new text");
            }
        );
    }

    // ── Log delete command ───────────────────────────────────────────

    #[tokio::test]
    async fn log_delete_sends_delete_command() {
        let cli = test_cli(CliCommand::Log {
            subcommand: Some(crate::cli::LogCommand::Delete {
                msg_ref: "m1".into(),
            }),
            msg_ref: None,
            count: 20,
            role: None,
            follow: false,
            json: false,
            content: false,
            plain: false,
            reasoning: false,
            tools: false,
            subagent_tools: false,
            heartbeat: false,
            dreaming: false,
            events: false,
            api: None,
            call_type: None,
        });
        let received = execute_with_mock(cli, command_response("delete")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "delete");
                assert_eq!(arg(&c.args, "refs"), "m1");
            }
        );
    }

    // ── Streaming with thinking chunks ───────────────────────────────

    #[tokio::test]
    async fn streaming_with_thinking_chunks() {
        let responses = vec![
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                rid: None,
                regen: false,
            }),
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                rid: None,
                text: "Let me think...".into(),
                content_type: "thinking".into(),
            }),
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                rid: None,
                text: "Here's the answer.".into(),
                content_type: "text".into(),
            }),
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                rid: None,
                msg_id: None,
                revision: None,
                content: "Here's the answer.".into(),
                metadata: StreamMetadata {
                    tokens: TokenCounts {
                        input: 10,
                        output: 5,
                        cache_read: 0,
                        cache_write: 0,
                    },
                    timing: TimingInfo {
                        total_ms: 200,
                        ttft_ms: 50,
                    },
                    model: "test-model".into(),
                },
                finish_reason: "end_turn".into(),
                is_final: true,
            }),
        ];

        let cli = test_cli(CliCommand::Send {
            message: vec!["test".into()],
            images: vec![],
            temperature: None,
            top_p: None,
            thinking: None,
            system: false,
        });
        let received = execute_with_mock(cli, responses).await;
        assert!(matches!(received, ClientMessage::Message(_)));
    }

    #[test]
    fn json_to_toml_reorders_tables_after_scalars() {
        // serde_json with `preserve_order` keeps insertion order, which the
        // daemon doesn't guarantee. The converter must move tables after
        // scalars within each table so toml serialization never errors with
        // "value after table".
        let json = serde_json::json!({
            "section_a": { "nested": true },
            "scalar": "value",
        });
        let tv = super::json_to_toml_value(&json).expect("table");
        let rendered = match tv {
            toml::Value::Table(t) => toml::to_string_pretty(&t).expect("serialize"),
            toml::Value::String(_)
            | toml::Value::Integer(_)
            | toml::Value::Float(_)
            | toml::Value::Boolean(_)
            | toml::Value::Datetime(_)
            | toml::Value::Array(_) => panic!("expected table"),
        };
        // scalar definition must precede the [section_a] header
        let scalar_idx = rendered.find("scalar").expect("scalar present");
        let table_idx = rendered.find("[section_a]").expect("table header present");
        assert!(
            scalar_idx < table_idx,
            "scalar must serialize before nested table:\n{rendered}"
        );
    }

    #[test]
    fn filter_non_defaults_prunes_default_leaves_and_empty_subtables() {
        let config = serde_json::json!({
            "outer": {
                "kept": "user-value",
                "nested": { "a": 1, "b": 2 },
            },
            "scalar_user": "x",
            "scalar_default": "d",
        });
        let defaults = serde_json::json!({
            "outer": {
                "kept": "default-value",
                "nested": { "a": 1, "b": 2 },
            },
            "scalar_user": "other",
            "scalar_default": "d",
        });
        let filtered = super::filter_non_defaults(&config, Some(&defaults)).expect("not empty");
        let outer = filtered.get("outer").expect("outer kept");
        assert!(outer.get("kept").is_some(), "non-default leaf preserved");
        assert!(
            outer.get("nested").is_none(),
            "all-default subtable should be pruned"
        );
        assert!(filtered.get("scalar_user").is_some());
        assert!(
            filtered.get("scalar_default").is_none(),
            "default scalar should be pruned"
        );
    }

    #[test]
    fn print_config_toml_section_view_wraps_under_key() {
        // Regression: `shore config <section> --toml` must wrap the subtree
        // under its table name, otherwise pasting the output back into a
        // config file would land nested tables at the wrong path.
        let data = serde_json::json!({
            "key": "daemon",
            "config": {
                "addr": "0.0.0.0:1112",
                "unsafe_allow_remote_access": true,
            },
            "defaults": {
                "addr": "127.0.0.1:7320",
                "unsafe_allow_remote_access": false,
            },
        });
        // Capture stdout by routing through to_string_pretty directly via the
        // same logic. Since print_config_toml writes to stdout, exercise the
        // wrapping logic by replicating the path.
        let payload = data.get("config").unwrap();
        let key = data.get("key").and_then(|v| v.as_str()).unwrap();
        let mut section_map = serde_json::Map::new();
        let _ignored = section_map.insert(key.to_owned(), payload.clone());
        let section_payload = serde_json::Value::Object(section_map);
        let toml_value = super::json_to_toml_value(&section_payload).expect("table");
        let rendered = match toml_value {
            toml::Value::Table(t) => toml::to_string_pretty(&t).expect("ok"),
            toml::Value::String(_)
            | toml::Value::Integer(_)
            | toml::Value::Float(_)
            | toml::Value::Boolean(_)
            | toml::Value::Datetime(_)
            | toml::Value::Array(_) => panic!("expected table"),
        };
        assert!(
            rendered.contains("[daemon]"),
            "section name must appear as a TOML table header:\n{rendered}"
        );
    }

    #[test]
    fn filter_non_defaults_returns_none_when_all_match() {
        // Regression: when nothing differs from defaults, the caller should
        // be able to render an empty TOML table rather than fail outright.
        let config = serde_json::json!({ "a": 1, "b": 2 });
        let defaults = serde_json::json!({ "a": 1, "b": 2 });
        assert!(super::filter_non_defaults(&config, Some(&defaults)).is_none());
        // The caller substitutes an empty object so json_to_toml_value yields
        // a valid (empty) table.
        let fallback = serde_json::Value::Object(serde_json::Map::new());
        let tv = super::json_to_toml_value(&fallback).expect("empty table");
        assert!(matches!(tv, toml::Value::Table(ref t) if t.is_empty()));
    }

    #[test]
    fn json_to_toml_drops_nulls() {
        let json = serde_json::json!({ "set": null, "kept": 1 });
        let tv = super::json_to_toml_value(&json).expect("table");
        let toml::Value::Table(t) = tv else {
            panic!("expected table")
        };
        assert!(t.contains_key("kept"));
        assert!(!t.contains_key("set"), "null entries should be dropped");
    }

    #[test]
    fn create_character_scaffolds_workspace_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let char_dir =
            super::create_character_scaffold(dir.path(), "ada").expect("scaffold should succeed");
        let soul_md = char_dir
            .join(shore_config::CHARACTER_WORKSPACE_DIR)
            .join(shore_config::SOUL_FILE);
        let content = std::fs::read_to_string(&soul_md).expect("SOUL.md should exist");
        assert!(content.starts_with("You are ada."));
        assert!(
            !char_dir.join("character.md").exists(),
            "legacy character.md should not be written"
        );
    }

    #[test]
    fn create_character_rejects_existing_workspace_character() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _ = super::create_character_scaffold(dir.path(), "ada").expect("first create");
        let err =
            super::create_character_scaffold(dir.path(), "ada").expect_err("re-create should fail");
        assert!(err.to_string().contains("already exists"));
    }

    #[test]
    fn create_character_rejects_existing_legacy_character() {
        let dir = tempfile::tempdir().expect("tempdir");
        let char_dir = dir.path().join("characters").join("ada");
        std::fs::create_dir_all(&char_dir).expect("mkdir");
        std::fs::write(char_dir.join("character.md"), "You are ada.\n").expect("write");
        let err = super::create_character_scaffold(dir.path(), "ada")
            .expect_err("create over legacy layout should fail");
        assert!(err.to_string().contains("already exists"));
    }
}
