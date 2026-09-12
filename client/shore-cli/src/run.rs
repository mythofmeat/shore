use shore_common::protocol::operations::{
    ConversationLog, ConversationLogArgs, CreateCharacter, GetMessage, GetMessageArgs,
    NamedOperationArgs, Operation, OperationResponse, SwitchCharacter, SwitchThread,
    SwitchThreadArgs,
};
use std::io::{self, IsTerminal, Read as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::Role;
use shore_common::swp_client::{SWPConnection, ServerAddr};
use shore_common::token::TokenSource;
use tracing::{debug, info, instrument};

use crate::cli::{Cli, CliCommand, LogRole, ModelCommand, ModelTarget, MsgCommand};
use crate::output;
use crate::state;

static SESSION_DISPLAY_CHARACTER: OnceLock<String> = OnceLock::new();

fn log_role_matches(filter: Option<&LogRole>, role: &Role) -> bool {
    match filter {
        None => true,
        Some(LogRole::User) => *role == Role::User,
        Some(LogRole::Assistant | LogRole::Character) => *role == Role::Assistant,
        Some(LogRole::System) => *role == Role::System,
    }
}

fn active_start_index(data: &serde_json::Value) -> usize {
    data["active_start"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
}

#[derive(Debug)]
pub(crate) struct ReportedError(String);

impl ReportedError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ReportedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ReportedError {}

pub(crate) fn already_reported(err: &(dyn std::error::Error + 'static)) -> bool {
    err.downcast_ref::<ReportedError>().is_some()
}

#[instrument(skip(cli_command))]
pub(crate) async fn execute(
    requested_character: Option<String>,
    requested_thread: Option<String>,
    thread_from_env: bool,
    requested_addr: Option<String>,
    cli_command: CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli {
        character: requested_character,
        thread: requested_thread,
        addr: requested_addr,
        command: Some(cli_command),
    };
    if let Some(result) = try_handle_local_only(&cli).await {
        return result;
    }

    let Some(command_ref) = cli.command.as_ref() else {
        return Err("missing command".into());
    };

    let addr = resolve_addr(&cli)?;

    let character = cli.character.clone().or_else(state::read_active_character);
    let thread = cli
        .thread
        .clone()
        .or_else(|| character.as_deref().and_then(state::read_active_thread));

    info!(character = ?character, thread = ?thread, "CLI executing command");

    let (mut conn, _server_hello, mut history) = SWPConnection::connect_in_thread(
        &addr,
        "cli",
        "shore-cli",
        character.clone(),
        thread.clone(),
        &TokenSource::Discover,
    )
    .await?;

    let display_character = state::resolve_display_character(
        history.selected_character.as_deref(),
        character.as_deref(),
    );
    let _ignored = SESSION_DISPLAY_CHARACTER.set(display_character.clone());

    if let Some(requested) = cli.character.as_deref().filter(|r| !r.is_empty())
        && let Some(serving) = history
            .selected_character
            .as_deref()
            .filter(|s| !s.is_empty())
        && serving != requested
    {
        return Err(format!(
                    "no character named {requested:?}; the daemon is serving {serving:?}. Run `shore character` to list them."
                )
                .into());
    }

    if let Some(requested) = thread.as_deref().filter(|r| !r.is_empty())
        && let Some(serving) = history.selected_thread.as_deref().filter(|s| !s.is_empty())
        && serving != requested
    {
        let source = thread_source(cli.thread.as_deref(), thread_from_env);
        if source == ThreadSource::Flag {
            if reads_the_selected_thread(command_ref) {
                return Err(report_unresolved_thread(
                    requested,
                    serving,
                    &display_character,
                ));
            }
        } else {
            if source == ThreadSource::Env
                && let Some(saved) = state::read_active_thread(&display_character)
                && saved != requested
                && saved != serving
            {
                let (fallback_conn, _, fallback_history) = SWPConnection::connect_in_thread(
                    &addr,
                    "cli",
                    "shore-cli",
                    Some(display_character.clone()),
                    Some(saved),
                    &TokenSource::Discover,
                )
                .await?;
                conn = fallback_conn;
                history = fallback_history;
            }
            if let Some(selected) = history.selected_thread.as_deref() {
                cli_err!(
                    "thread {requested:?} is unavailable for {display_character}; using {selected:?}"
                );
                if let Err(e) = state::write_active_thread(&display_character, selected) {
                    cli_err!("could not save thread {selected:?}: {e}");
                }
            }
        }
    }

    match command_ref {
        CliCommand::Msg { command: message } => match message {
            MsgCommand::Send { .. } => handle_send_command(&mut conn, message).await?,
            MsgCommand::Regen { guidance } => {
                _ = conn.send_regen(true, guidance.clone()).await?;
                recv_streaming_response(&mut conn).await?;
            }
            MsgCommand::Alt { .. } => handle_alt_command(&mut conn, message).await?,
            MsgCommand::Edit { .. } => handle_edit_command(&mut conn, message).await?,
            MsgCommand::Delete { msg_refs, json } => {
                handle_message_change(&mut conn, command_ref, *json, msg_refs).await?;
            }
        },
        CliCommand::Character {
            subcommand: Some(crate::cli::CharacterCommand::New { name }),
            ..
        } => handle_create_character(&mut conn, name).await?,
        CliCommand::Character {
            subcommand: Some(crate::cli::CharacterCommand::Delete { name, archive, yes }),
            json,
            ..
        } => {
            handle_delete_character(&mut conn, name, archive.as_deref(), *yes, *json).await?;
        }
        CliCommand::Character {
            subcommand: Some(crate::cli::CharacterCommand::Use { name }),
            ..
        } => handle_switch_character(&mut conn, name).await?,
        CliCommand::Character {
            subcommand: None,
            info: false,
            json,
        } => handle_list_characters(&mut conn, *json).await?,
        CliCommand::Thread {
            subcommand: Some(crate::cli::ThreadCommand::Use { name }),
            ..
        } => handle_switch_thread(&mut conn, name, &display_character).await?,
        CliCommand::Thread {
            subcommand: Some(crate::cli::ThreadCommand::Archive { name }),
            json,
        } => {
            handle_thread_command(&mut conn, command_ref, false, *json).await?;
            forget_archived_thread(&display_character, name);
        }
        CliCommand::Thread { subcommand, json } => {
            handle_thread_command(&mut conn, command_ref, subcommand.is_none(), *json).await?;
        }
        CliCommand::Trace { subcommand: None } => {
            output::vocab::print_index(
                "trace",
                "what the daemon did behind the conversation",
                &[
                    ("trace calls", "raw model call payloads"),
                    (
                        "trace heartbeat",
                        "what each heartbeat tick thought and did",
                    ),
                    (
                        "trace events",
                        "the heartbeat timeline: fired, dormant, woke",
                    ),
                    ("trace errors", "errors hit since start, and key fallbacks"),
                    ("trace subagent", "stored sub-agent runs and their tools"),
                ],
            );
        }
        CliCommand::Debug { subcommand: None } => {
            output::vocab::print_index(
                "debug",
                "make the daemon do something now, out of band",
                &[
                    ("debug tick-now", "run a heartbeat tick immediately"),
                    (
                        "debug keepalive-ping-now",
                        "send a cache keepalive ping now",
                    ),
                    ("debug session-activate", "mark the session active"),
                    ("debug status-dormant", "force the heartbeat dormant"),
                    ("debug status-active", "force the heartbeat active"),
                    ("debug tool <name>", "invoke one tool directly"),
                    ("debug subagent <name>", "invoke one sub-agent directly"),
                ],
            );
        }
        CliCommand::Log { .. } => {
            handle_log_command(&mut conn, command_ref, &display_character).await?;
        }
        CliCommand::Status { .. } => {
            handle_status_command(&mut conn, command_ref, &display_character).await?;
        }
        CliCommand::Model { .. } if model_change(command_ref).is_some() => {
            let Some(change) = model_change(command_ref) else {
                return Ok(());
            };
            apply_model_change(&mut conn, command_ref, change).await?;
        }
        refused @ (CliCommand::View { .. } | CliCommand::Ui { .. }) => {
            return Err(tui_only_refusal(refused)
                .unwrap_or_else(|| "this command only applies inside `shore tui`".to_owned())
                .into());
        }
        other @ (CliCommand::Character { .. }
        | CliCommand::Export { .. }
        | CliCommand::Import { .. }
        | CliCommand::Trace { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Compact { .. }
        | CliCommand::Segments { .. }
        | CliCommand::Clear { .. }
        | CliCommand::Config { .. }
        | CliCommand::Usage { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }) => {
            handle_generic_swp_command(&mut conn, other, cli.character.as_deref()).await?;
        }
    }

    Ok(())
}

pub(crate) fn wants_json(other: &CliCommand) -> bool {
    match other {
        CliCommand::Thread { json, .. } => *json,
        CliCommand::Model {
            json, subcommand, ..
        } => *json || matches!(subcommand, Some(ModelCommand::Setting { json: true, .. })),
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
        CliCommand::Trace { subcommand } => match subcommand {
            Some(
                crate::cli::TraceCommand::Calls { json, .. }
                | crate::cli::TraceCommand::Heartbeat { json, .. }
                | crate::cli::TraceCommand::Errors { json, .. }
                | crate::cli::TraceCommand::Events { json, .. }
                | crate::cli::TraceCommand::Subagent { json, .. },
            ) => *json,
            None => false,
        },
        CliCommand::Config {
            json, subcommand, ..
        } => {
            *json
                || matches!(
                    subcommand,
                    Some(
                        crate::cli::ConfigCommand::Tools { json: true }
                            | crate::cli::ConfigCommand::Get { json: true, .. }
                            | crate::cli::ConfigCommand::Set { json: true, .. }
                            | crate::cli::ConfigCommand::Keys { json: true, .. }
                    )
                )
        }
        CliCommand::Character { json, .. }
        | CliCommand::Export { json, .. }
        | CliCommand::Import { json, .. }
        | CliCommand::Compact { json, .. }
        | CliCommand::Segments { json, .. }
        | CliCommand::Clear { json, .. }
        | CliCommand::Usage { json, .. } => *json,
        CliCommand::Debug { subcommand } => matches!(
            subcommand,
            Some(
                crate::cli::DebugCommand::Tool { json: true, .. }
                    | crate::cli::DebugCommand::Subagent { json: true, .. }
            )
        ),
        CliCommand::Msg { command } => matches!(
            command,
            MsgCommand::Edit { json: true, .. } | MsgCommand::Delete { json: true, .. }
        ),
        CliCommand::Log { .. }
        | CliCommand::Status { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. } => false,
    }
}

async fn handle_generic_swp_command(
    conn: &mut SWPConnection,
    other: &CliCommand,
    character: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let CliCommand::Config {
        subcommand: Some(crate::cli::ConfigCommand::Reload { .. }),
        ..
    } = other
    {
        return handle_config_reload(conn, other).await;
    }

    let json_mode = wants_json(other);
    let toml_mode = matches!(
        other,
        CliCommand::Config {
            toml: true,
            check: false,
            ..
        } | CliCommand::Config {
            subcommand: Some(crate::cli::ConfigCommand::Get { toml: true, .. }),
            ..
        }
    );
    let show_all = matches!(
        other,
        CliCommand::Config { all: true, .. }
            | CliCommand::Config {
                subcommand: Some(crate::cli::ConfigCommand::Get { all: true, .. }),
                ..
            }
    );
    let Some((name, args)) = crate::cli::to_swp_command(other, character) else {
        return Err("non-send/regen/local command must map to SWP command".into());
    };
    _ = conn.send_command(name, args).await?;
    let data = recv_command_data(conn).await?;
    if matches!(other, CliCommand::Provider { .. }) {
        validate_provider_output(name, &data)?;
    }
    if toml_mode {
        print_config_toml(&data, show_all)?;
    } else if json_mode {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else if name == "config" {
        output::config::print(&data, show_all);
    } else if name == "config_schema" {
        output::config::print_schema(&data, config_keys_filter(other));
    } else if name == "config_check" {
        output::config::print_check(&data);
    } else if name == "tools" {
        output::tools::print(&data);
    } else if let Some(render) = catalog_render(name) {
        render(&data);
    } else if let Some(view) = usage_view(other) {
        output::usage::print(&data, view);
    } else {
        output::format_command(name, &data);
    }
    Ok(())
}

pub(crate) fn validate_provider_output(
    name: &str,
    data: &serde_json::Value,
) -> Result<(), serde_json::Error> {
    let _: OperationResponse =
        serde_json::from_value(serde_json::json!({ "name": name, "data": data }))?;
    Ok(())
}

pub(crate) fn config_keys_filter(other: &CliCommand) -> Option<&str> {
    let CliCommand::Config {
        subcommand: Some(crate::cli::ConfigCommand::Keys { filter, .. }),
        ..
    } = other
    else {
        return None;
    };
    filter.as_deref()
}

fn catalog_render(name: &str) -> Option<fn(&serde_json::Value)> {
    match name {
        "list_models" => Some(output::catalog::print_model_list),
        "model_info" => Some(output::catalog::print_model_info),
        "model_settings" => Some(output::catalog::print_model_settings),
        "list_providers" => Some(output::catalog::print_provider_list),
        "list_provider_models" => Some(output::catalog::print_provider_models),
        _ => None,
    }
}

pub(crate) fn usage_view(cmd: &CliCommand) -> Option<output::usage::View> {
    use crate::cli::UsageCommand;
    use output::usage::View;
    let CliCommand::Usage { subcommand, .. } = cmd else {
        return None;
    };
    Some(match subcommand {
        None => View::Summary,
        Some(UsageCommand::By { .. }) => View::By,
        Some(UsageCommand::Budgets) => View::Budgets,
        Some(UsageCommand::Cache) => View::Cache,
        Some(UsageCommand::Anomalies) => View::Anomalies,
        Some(UsageCommand::Limits) => View::Limits,
        Some(UsageCommand::Export { .. }) => View::Summary,
    })
}

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
        cli_err!(
            "Activating them invalidates the warm prompt cache; the next message pays a one-time cache write."
        );
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

async fn handle_log_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    display_character: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Log {
        msg_ref,
        json,
        content,
        role,
        reasoning,
        tools,
        subagent_tools,
        count,
        follow,
        ..
    } = cmd
    else {
        return Ok(());
    };

    let filter = output::LogFilter {
        reasoning: *reasoning,
        tools: *tools,
        subagent_tools: *subagent_tools,
    };

    if let Some(r) = msg_ref {
        let data = fetch_single_message(conn, r, role.as_ref()).await?;
        if *json {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        } else if *content {
            output::print_message_content(&data);
        } else if output::use_decoration() {
            output::print_single_message(&data, display_character, filter);
        } else {
            output::print_log_plain(std::slice::from_ref(&data), display_character, filter);
        }
        return Ok(());
    }

    let (_, data) = execute_operation_with_raw::<ConversationLog>(
        conn,
        ConversationLogArgs {
            turns: Some(u64::from(*count)),
            count: None,
            role: role.map(LogRole::as_protocol_role),
        },
    )
    .await?;

    render_log_list(&data, *json, *content, display_character, filter)?;

    if *follow {
        follow_log_stream(conn, role.as_ref(), display_character, filter).await?;
    }
    Ok(())
}

async fn handle_message_change(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    json: bool,
    display_refs: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    let Some((name, args)) = crate::cli::to_swp_command(cmd, None) else {
        return Ok(());
    };
    _ = conn.send_command(name, args).await?;
    let data = recv_command_data(conn).await?;
    if json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
        return Ok(());
    }
    output::format_command(name, &response_with_display_refs(data, display_refs));
    Ok(())
}

fn response_with_display_ref(mut data: serde_json::Value, display_ref: &str) -> serde_json::Value {
    if let Some(object) = data.as_object_mut() {
        _ = object.insert("_display_ref".into(), serde_json::json!(display_ref));
    }
    data
}

fn response_with_display_refs(
    mut data: serde_json::Value,
    display_refs: &[String],
) -> serde_json::Value {
    if let Some(object) = data.as_object_mut() {
        _ = object.insert("_display_refs".into(), serde_json::json!(display_refs));
    }
    data
}

async fn fetch_single_message(
    conn: &mut SWPConnection,
    msg_ref: &str,
    role: Option<&LogRole>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let (_, data) = execute_operation_with_raw::<GetMessage>(
        conn,
        GetMessageArgs {
            reference: msg_ref.to_owned(),
            role: role.copied().map(LogRole::as_protocol_role),
        },
    )
    .await?;
    Ok(data)
}

fn render_log_list(
    data: &serde_json::Value,
    json: bool,
    content: bool,
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
    } else if output::use_decoration() {
        let active_start = active_start_index(data);
        output::print_log_with_boundary(messages, active_start, display_character, filter);
    } else {
        let active_start = active_start_index(data);
        output::print_log_plain_with_boundary(messages, active_start, display_character, filter);
    }
    Ok(())
}

async fn follow_log_stream(
    conn: &mut SWPConnection,
    role: Option<&LogRole>,
    follow_char: &str,
    filter: output::LogFilter,
) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        let msg = conn.recv().await?;
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
            | ServerMessage::ProviderWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::Unknown => {}
        }
    }
    Ok(())
}

async fn handle_send_command(
    conn: &mut SWPConnection,
    cmd: &MsgCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let MsgCommand::Send {
        message,
        images,
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
        edit_text_in_editor("")?
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
        _ = conn
            .send_message_with_images(&text, true, images.clone())
            .await?;
        recv_streaming_response(conn).await?;
    }
    Ok(())
}

async fn handle_edit_command(
    conn: &mut SWPConnection,
    cmd: &MsgCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let MsgCommand::Edit {
        msg_ref,
        content,
        json,
    } = cmd
    else {
        return Ok(());
    };

    let mut target_ref = msg_ref.clone();
    let replacement = match typed_replacement(content, msg_ref)? {
        Some(text) => text,
        None if !io::stdin().is_terminal() => {
            typed_replacement(std::slice::from_ref(&read_stdin()?), msg_ref)?
                .ok_or_else(|| empty_edit_refusal(msg_ref))?
        }
        None => {
            let message = fetch_single_message(conn, msg_ref, None).await?;
            target_ref = message
                .get("msg_id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| format!("could not read message {msg_ref}: missing message ID"))?
                .to_owned();
            let current = message_text(&message);
            let edited = edit_text_in_editor(&current)?;
            let Some(text) = editor_replacement(&current, &edited) else {
                cli_out!("nothing to change, {msg_ref} left alone");
                return Ok(());
            };
            text
        }
    };

    _ = conn
        .send_command(
            "edit",
            serde_json::json!({ "ref": target_ref, "content": replacement }),
        )
        .await?;
    let data = recv_command_data(conn).await?;
    if *json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
        return Ok(());
    }
    output::format_command(
        "edit",
        &response_with_display_refs(data, std::slice::from_ref(msg_ref)),
    );
    Ok(())
}

fn typed_replacement(
    content: &[String],
    msg_ref: &str,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if content.is_empty() {
        return Ok(None);
    }
    let typed = content.join(" ").trim().to_owned();
    if typed.is_empty() {
        return Err(empty_edit_refusal(msg_ref).into());
    }
    Ok(Some(typed))
}

fn editor_replacement(current: &str, edited: &str) -> Option<String> {
    let saved = edited.trim();
    (!saved.is_empty() && saved != current.trim()).then(|| saved.to_owned())
}

fn empty_edit_refusal(msg_ref: &str) -> String {
    format!(
        "`msg edit {msg_ref}` with empty replacement text would erase the message. Give it \
         content, or run `shore msg delete {msg_ref}` if removing it is what you meant."
    )
}

fn message_text(data: &serde_json::Value) -> String {
    if let Some(blocks) = data["content_blocks"].as_array()
        && !blocks.is_empty()
    {
        let text = blocks
            .iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return text;
        }
    }
    data["content"].as_str().unwrap_or_default().to_owned()
}

async fn handle_alt_command(
    conn: &mut SWPConnection,
    cmd: &MsgCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let MsgCommand::Alt {
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
        let shown = response_with_display_ref(data, msg_ref.as_deref().unwrap_or("last"));
        output::format_command(name, &shown);
    }
    Ok(())
}

async fn handle_status_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    display_character: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Status { section, json, .. } = cmd else {
        return Ok(());
    };
    _ = conn.send_command("status", serde_json::json!({})).await?;
    let data = recv_command_data(conn).await?;
    match section {
        Some(s) => {
            let known = output::status::sections_of(&data);
            if known.is_empty() {
                return Err(
                    "this daemon does not report status sections; it is older than the client"
                        .into(),
                );
            }
            if !known.iter().any(|k| k == s) {
                return Err(format!(
                    "no status section named {s:?}; shore has {}",
                    known.join(", ")
                )
                .into());
            }
            let val = data.get(s.as_str()).unwrap_or(&serde_json::Value::Null);
            if *json {
                cli_out!("{}", serde_json::to_string_pretty(val)?);
            } else {
                _ = output::status::print_section(&data, s);
            }
        }
        None if *json => {
            cli_out!("{}", serde_json::to_string_pretty(&data)?);
        }
        None => {
            output::status::print(&data, display_character);
        }
    }
    Ok(())
}

enum ModelChange<'target> {
    SwitchTo(&'target str, &'target ModelTarget),
    Reset(Option<&'target ModelTarget>),
}

fn model_change(cmd: &CliCommand) -> Option<ModelChange<'_>> {
    let CliCommand::Model {
        subcommand, reset, ..
    } = cmd
    else {
        return None;
    };
    match subcommand {
        Some(ModelCommand::Use { name, target }) => Some(ModelChange::SwitchTo(name, target)),
        Some(ModelCommand::Reset { target }) => Some(ModelChange::Reset(Some(target))),
        Some(_) => None,
        None if *reset => Some(ModelChange::Reset(None)),
        None => None,
    }
}

async fn apply_model_change(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    change: ModelChange<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Model { all, json, .. } = cmd else {
        return Ok(());
    };
    let target = match change {
        ModelChange::Reset(target) => target,
        ModelChange::SwitchTo(_, target) => Some(target),
    };
    let with_target = |mut args: serde_json::Map<String, serde_json::Value>| {
        if let Some(selected) = target {
            selected.write_into(&mut args);
        }
        args
    };
    let (command, args) = match change {
        ModelChange::Reset(_) => ("reset_model", with_target(serde_json::Map::new())),
        ModelChange::SwitchTo(name, _) => {
            let mut args = serde_json::Map::new();
            _ = args.insert("name".into(), serde_json::json!(name));
            if *all {
                _ = args.insert("include_hidden".into(), serde_json::json!(true));
            }
            ("switch_model", with_target(args))
        }
    };
    _ = conn
        .send_command(command, serde_json::Value::Object(args))
        .await?;
    let data = recv_command_data(conn).await?;
    if *json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        output::format_command(command, &data);
    }
    Ok(())
}

fn reads_the_selected_thread(command: &CliCommand) -> bool {
    match command {
        CliCommand::Msg { .. }
        | CliCommand::Log { .. }
        | CliCommand::Compact { .. }
        | CliCommand::Clear { .. }
        | CliCommand::Segments { .. } => true,

        CliCommand::Thread { .. }
        | CliCommand::Character { .. }
        | CliCommand::Status { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Config { .. }
        | CliCommand::Usage { .. }
        | CliCommand::Trace { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Export { .. }
        | CliCommand::Import { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. } => false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThreadSource {
    Flag,
    Env,
    Saved,
}

fn thread_source(from_cli: Option<&str>, from_env: bool) -> ThreadSource {
    if from_cli.is_none() {
        return ThreadSource::Saved;
    }
    if from_env {
        ThreadSource::Env
    } else {
        ThreadSource::Flag
    }
}

fn report_unresolved_thread(
    requested: &str,
    serving: &str,
    character: &str,
) -> Box<dyn std::error::Error> {
    output::print_error(&format!("no thread named {requested:?} for {character}"));
    cli_err!();
    cli_err!("  you asked for it with --thread");
    cli_err!("  the daemon is serving {serving:?}");
    cli_err!();
    cli_err!("  shore thread             list the threads that do exist");
    cli_err!("  shore thread new {requested}   create it");
    cli_err!("  shore thread use {requested}   make it the saved choice");
    Box::new(ReportedError::new(format!(
        "no thread named {requested:?} for {character}"
    )))
}

async fn try_handle_local_only(cli: &Cli) -> Option<Result<(), Box<dyn std::error::Error>>> {
    if matches!(&cli.command, Some(CliCommand::Config { path: true, .. })) {
        return Some(print_config_path(cli).await);
    }
    if let Some(CliCommand::Complete { kind, arg }) = &cli.command {
        let _ignored = handle_complete_query(*kind, arg.as_deref(), cli).await;
        return Some(Ok(()));
    }
    if let Some(command) = &cli.command
        && let Some(message) = tui_only_refusal(command)
    {
        return Some(Err(message.into()));
    }
    None
}

#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "every command except these two is a normal daemon-backed command"
)]
pub(crate) fn tui_only_refusal(command: &CliCommand) -> Option<String> {
    match command {
        CliCommand::View { key, .. } => Some(format!(
            "`view {}` changes what the TUI draws, so it only applies inside `shore tui`",
            key.as_str()
        )),
        CliCommand::Ui { .. } => {
            Some("`ui` drives a running TUI; run it from inside `shore tui`".to_owned())
        }
        _ => None,
    }
}

async fn handle_switch_character(
    conn: &mut SWPConnection,
    name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    info!(character = name, "Switching active character");
    let _selection = execute_operation::<SwitchCharacter>(
        conn,
        NamedOperationArgs {
            name: name.to_owned(),
        },
    )
    .await?;
    state::write_active_character(name)?;
    cli_out!("Switched to character: {name}");
    cli_out!("To override per-terminal: export SHORE_CHARACTER={name}");
    Ok(())
}

async fn handle_switch_thread(
    conn: &mut SWPConnection,
    name: &str,
    character: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    info!(thread = name, "Switching active thread");
    let _selection = execute_operation::<SwitchThread>(
        conn,
        SwitchThreadArgs {
            name: name.to_owned(),
            resync: None,
        },
    )
    .await?;
    state::write_active_thread(character, name)?;
    cli_out!("Talking in thread: {name}");
    cli_out!("To override per-terminal: export SHORE_THREAD={name}");
    Ok(())
}

fn forget_archived_thread(character: &str, archived: &str) {
    if state::read_active_thread(character).as_deref() == Some(archived) {
        match state::clear_active_thread(character) {
            Ok(()) => cli_out!("{archived} was your saved thread; back to the home thread"),
            Err(e) => output::print_error(&format!("could not forget thread {archived}: {e}")),
        }
    }
    if std::env::var("SHORE_THREAD").ok().as_deref() == Some(archived) {
        cli_err!("SHORE_THREAD still names {archived} in this shell — unset it");
    }
}

async fn handle_thread_command(
    conn: &mut SWPConnection,
    command: &CliCommand,
    listing: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some((name, args)) = crate::cli::to_swp_command(command, None) else {
        return Ok(());
    };
    let _ignored = conn.send_command(name, args).await?;
    let data = recv_command_data(conn).await?;

    if json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
        return Ok(());
    }
    if !listing {
        cli_out!("");
    }
    output::catalog::print_thread_list(&data);
    Ok(())
}

async fn handle_create_character(
    conn: &mut SWPConnection,
    name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let data = execute_operation::<CreateCharacter>(
        conn,
        NamedOperationArgs {
            name: name.to_owned(),
        },
    )
    .await?;

    let workspace = data.workspace_dir;
    cli_out!("Created character scaffold: {workspace}");

    for (file, purpose) in SCAFFOLD_GUIDE {
        let created = data.created_files.iter().any(|created| created == file);
        if created {
            cli_out!("  {file:<10} {purpose}");
        }
    }
    cli_out!("Switch to it with: shore character {name}");
    Ok(())
}

async fn handle_delete_character(
    conn: &mut SWPConnection,
    name: &str,
    archive: Option<&Path>,
    yes: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !yes && !confirm_delete_character(name)? {
        cli_err!("Left {name} alone.");
        return Ok(());
    }

    info!(character = name, "Deleting character");
    let args = match archive {
        Some(path) => serde_json::json!({
            "character": name,
            "confirm": name,
            "archive": crate::cli::absolute_path(path),
        }),
        None => serde_json::json!({ "character": name, "confirm": name }),
    };
    let _ignored = conn.send_command("delete_character", args).await?;
    let data = recv_command_data(conn).await?;

    if json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        if let Some(written) = data.get("archive").and_then(serde_json::Value::as_str) {
            cli_out!("Backed up to {written}");
        }
        cli_out!("Deleted character: {name}");
        for path in data
            .get("removed")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
        {
            cli_out!("  removed {path}");
        }
    }

    forget_deleted_character(name);
    Ok(())
}

fn confirm_delete_character(name: &str) -> Result<bool, Box<dyn std::error::Error>> {
    if !io::stdin().is_terminal() {
        return Err(format!(
            "deleting {name} cannot be undone; re-run with --yes \
             (add --archive PATH to keep a backup first)"
        )
        .into());
    }
    cli_err!(
        "Deleting {name} removes, on the daemon host: its workspace (SOUL.md, USER.md, memory),"
    );
    cli_err!("its config and avatar, its threads and data, its search indexes, and its rows in");
    cli_err!("the history and usage databases. This cannot be undone.");
    cli_err!("Type the character name to confirm:");
    let mut answer = String::new();
    let _ignored = io::stdin().read_line(&mut answer)?;
    Ok(answer.trim() == name)
}

fn forget_deleted_character(name: &str) {
    if let Err(e) = state::clear_active_thread(name) {
        output::print_error(&format!(
            "could not forget the thread saved for {name}: {e}"
        ));
    }
    if state::read_active_character().as_deref() == Some(name) {
        match state::clear_active_character() {
            Ok(()) => {
                cli_out!("{name} was your saved character; `shore character` lists what is left");
            }
            Err(e) => output::print_error(&format!("could not forget character {name}: {e}")),
        }
    }
    if std::env::var("SHORE_CHARACTER").ok().as_deref() == Some(name) {
        cli_err!("SHORE_CHARACTER still names {name} in this shell — unset it");
    }
}

const SCAFFOLD_GUIDE: &[(&str, &str)] = &[
    ("SOUL.md", "who the character is"),
    ("USER.md", "who you are, to them"),
    (
        "AGENTS.md",
        "the system prompt (a copy of the built-in one)",
    ),
    ("TOOLS.md", "extra guidance on using tools"),
];

async fn handle_list_characters(
    conn: &mut SWPConnection,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ignored = conn
        .send_command("list_characters", serde_json::json!({}))
        .await?;
    let data = recv_command_data(conn).await?;

    if json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
        return Ok(());
    }
    let active = state::read_active_character();
    output::catalog::print_character_list(&data, active.as_deref());
    Ok(())
}

async fn handle_complete_query(
    kind: crate::cli::CompleteKind,
    arg: Option<&str>,
    cli: &Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::cli::CompleteKind;
    let addr = resolve_addr(cli)?;
    let character = cli.character.clone().or_else(state::read_active_character);
    let thread = cli
        .thread
        .clone()
        .or_else(|| character.as_deref().and_then(state::read_active_thread));
    let (mut conn, _hello, _history) = SWPConnection::connect_in_thread(
        &addr,
        "cli",
        "shore-cli",
        character,
        thread,
        &TokenSource::Discover,
    )
    .await?;

    if matches!(
        kind,
        CompleteKind::ConfigKeys | CompleteKind::ConfigSections | CompleteKind::ConfigValues
    ) {
        let _ignored = conn
            .send_command("config_schema", serde_json::json!({}))
            .await?;
        let data = recv_command_data(&mut conn).await?;
        print_config_completions(kind, arg, &data);
        return Ok(());
    }

    if kind == CompleteKind::SettingKeys || kind == CompleteKind::SettingValues {
        let _ignored = conn
            .send_command("model_settings", serde_json::json!({}))
            .await?;
        let data = recv_command_data(&mut conn).await?;
        if kind == CompleteKind::SettingKeys {
            print_setting_key_completions(&data);
        } else {
            if let Some(key) = arg {
                for value in setting_value_completions(&data, key) {
                    cli_out!("{value}");
                }
            }
        }
        return Ok(());
    }

    if kind == CompleteKind::Models {
        let _ignored = conn
            .send_command("list_models", serde_json::json!({}))
            .await?;
        let data = recv_command_data(&mut conn).await?;
        for model in output::models_by_provider(&data) {
            if let Some(name) = model.get("name").and_then(serde_json::Value::as_str) {
                cli_out!("{name}");
            }
        }
        return Ok(());
    }

    let (cmd, array_keys) = match kind {
        CompleteKind::Threads => ("list_threads", &["threads"][..]),
        CompleteKind::Characters => ("list_characters", &["characters"][..]),
        CompleteKind::Providers => ("list_providers", &["providers"][..]),
        CompleteKind::Sections => ("status", &["sections"][..]),
        CompleteKind::Tools => ("tools", &["tools", "subagents", "mcp"][..]),
        CompleteKind::Subagents => ("tools", &["subagents"][..]),
        CompleteKind::Models
        | CompleteKind::SettingKeys
        | CompleteKind::SettingValues
        | CompleteKind::ConfigKeys
        | CompleteKind::ConfigSections
        | CompleteKind::ConfigValues => {
            return Ok(());
        }
    };

    let _ignored = conn.send_command(cmd, serde_json::json!({})).await?;
    let data = recv_command_data(&mut conn).await?;
    for array_key in array_keys {
        let Some(items) = data.get(array_key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(name) = item
                .as_str()
                .or_else(|| item["name"].as_str())
                .or_else(|| item["id"].as_str())
                .or_else(|| item["tool"].as_str())
            else {
                continue;
            };
            if kind == CompleteKind::Tools && *array_key == "subagents" {
                cli_out!("ask_{name}");
            } else {
                cli_out!("{name}");
            }
        }
    }
    Ok(())
}

fn json_strings(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn setting_key_completions(data: &serde_json::Value) -> Vec<String> {
    let Some(schema) = data
        .get("setting_schema")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let effective = data
        .get("effective_sampler")
        .and_then(serde_json::Value::as_object);

    let mut out = Vec::new();
    for entry in schema {
        let Some(key) = entry.get("key").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let verdict = entry
            .get("applicability")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("rejected");
        if verdict != "always" && verdict != "honored" {
            continue;
        }
        let current = effective
            .and_then(|s| s.get(key))
            .filter(|v| !v.is_null())
            .map(render_setting_value);
        let described = match (current, verdict) {
            (Some(value), "ignored") => format!("{value} (ignored by this model)"),
            (Some(value), _) => value,
            (None, "ignored") => "unset (ignored by this model)".to_owned(),
            (None, _) => "unset".to_owned(),
        };
        out.push(format!("{key}\t{described}"));
    }
    out
}

pub(crate) fn setting_value_completions(data: &serde_json::Value, key: &str) -> Vec<String> {
    data.get("setting_schema")
        .and_then(serde_json::Value::as_array)
        .and_then(|schema| {
            schema.iter().find(|entry| {
                let matches_key = entry.get("key").and_then(serde_json::Value::as_str) == Some(key);
                let applicable = entry
                    .get("applicability")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value == "always" || value == "honored");
                matches_key && applicable
            })
        })
        .and_then(|entry| entry.get("suggestions"))
        .and_then(serde_json::Value::as_array)
        .map(|suggestions| {
            suggestions
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn render_setting_value(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

fn print_setting_key_completions(data: &serde_json::Value) {
    for line in setting_key_completions(data) {
        cli_out!("{line}");
    }
}

fn print_config_completions(
    kind: crate::cli::CompleteKind,
    arg: Option<&str>,
    data: &serde_json::Value,
) {
    use crate::cli::CompleteKind;
    let Some(entries) = data.get("schema").and_then(serde_json::Value::as_array) else {
        return;
    };

    if kind == CompleteKind::ConfigValues {
        let Some(key) = arg else { return };
        let Some(entry) = entries
            .iter()
            .find(|e| e.get("key").and_then(serde_json::Value::as_str) == Some(key))
        else {
            return;
        };
        for value in config_value_candidates(entry, data) {
            cli_out!("{value}");
        }
        return;
    }

    let settable_only = kind == CompleteKind::ConfigKeys;
    for entry in entries {
        let Some(key) = entry.get("key").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if key.contains('<') {
            continue;
        }
        let settable = entry
            .get("settable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if settable_only && !settable {
            continue;
        }
        let described = entry
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("value");
        if entry
            .get("restart_required")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            cli_out!("{key}\t{described} (needs restart)");
        } else {
            cli_out!("{key}\t{described}");
        }
    }
}

fn config_value_candidates(entry: &serde_json::Value, data: &serde_json::Value) -> Vec<String> {
    if let Some(source) = entry.get("source").and_then(serde_json::Value::as_str) {
        let from_source = json_strings(data.get("sources").and_then(|s| s.get(source)));
        if !from_source.is_empty() {
            return from_source;
        }
    }
    json_strings(entry.get("values"))
}

pub(crate) fn config_value_candidates_for_key(key: &str, data: &serde_json::Value) -> Vec<String> {
    data.get("schema")
        .and_then(serde_json::Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("key").and_then(serde_json::Value::as_str) == Some(key))
        })
        .map_or_else(Vec::new, |entry| config_value_candidates(entry, data))
}

fn config_dir() -> PathBuf {
    shore_common::dirs::config_dir()
}

async fn print_config_path(cli: &Cli) -> Result<(), Box<dyn std::error::Error>> {
    let addr = resolve_addr(cli)?;
    let character = cli.character.clone().or_else(state::read_active_character);

    if let Ok((mut conn, _hello, _history)) =
        SWPConnection::connect(&addr, "cli", "shore-cli", character, &TokenSource::Discover).await
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

fn print_config_toml(
    data: &serde_json::Value,
    show_all: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let rendered = render_config_toml(data, show_all)?;
    cli_write!("{rendered}");
    Ok(())
}

pub(crate) fn render_config_toml(
    data: &serde_json::Value,
    show_all: bool,
) -> Result<String, Box<dyn std::error::Error>> {
    let payload = data.get("config").unwrap_or(data);
    let key = data.get("key").and_then(|v| v.as_str());
    let defaults: Option<&serde_json::Value> = data.get("defaults");
    let filtered: serde_json::Value;
    let effective: &serde_json::Value = if show_all {
        payload
    } else {
        filtered = filter_non_defaults(payload, defaults)
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        &filtered
    };

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
    Ok(rendered)
}

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

fn read_stdin() -> Result<String, Box<dyn std::error::Error>> {
    let mut buf = String::new();
    let _ignored = io::stdin().read_to_string(&mut buf)?;
    Ok(buf.trim().to_owned())
}

pub(crate) fn editor_from_env() -> String {
    resolve_editor(std::env::var("VISUAL").ok(), std::env::var("EDITOR").ok())
}

const SHELL_METACHARACTERS: &str = "|&;<>()$`\\\"' \t\n*?[#~=%";

fn needs_a_shell(editor: &str) -> bool {
    editor.chars().any(|c| SHELL_METACHARACTERS.contains(c))
}

pub(crate) fn editor_invocation(editor: &str, path: &Path) -> (String, Vec<std::ffi::OsString>) {
    if needs_a_shell(editor) {
        (
            "sh".to_owned(),
            vec![
                "-c".into(),
                format!("{editor} \"$@\"").into(),
                editor.into(),
                path.into(),
            ],
        )
    } else {
        (editor.to_owned(), vec![path.into()])
    }
}

fn resolve_editor(visual: Option<String>, editor: Option<String>) -> String {
    [visual, editor]
        .into_iter()
        .flatten()
        .map(|c| c.trim().to_owned())
        .find(|c| !c.is_empty())
        .unwrap_or_else(|| "vi".into())
}

fn seed_editor_file(path: &Path, seed: &str) -> io::Result<()> {
    let trimmed = seed.trim_end();
    if trimmed.is_empty() {
        return Ok(());
    }
    std::fs::write(path, format!("{trimmed}\n"))
}

fn edit_text_in_editor(seed: &str) -> Result<String, Box<dyn std::error::Error>> {
    edit_text_with(&editor_from_env(), seed)
}

fn edit_text_with(editor: &str, seed: &str) -> Result<String, Box<dyn std::error::Error>> {
    let tmp = tempfile::Builder::new()
        .prefix("shore-")
        .suffix(".md")
        .tempfile()?;

    let path = tmp.path().to_path_buf();
    seed_editor_file(&path, seed)?;

    let (program, args) = editor_invocation(editor, &path);
    let status = std::process::Command::new(program).args(args).status()?;

    if !status.success() {
        return Ok(String::new());
    }

    let content = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_owned();

    Ok(content)
}

fn resolve_addr(cli: &Cli) -> Result<ServerAddr, shore_common::swp_client::ClientError> {
    if let Some(addr) = &cli.addr {
        return Ok(ServerAddr(addr.clone()));
    }
    shore_common::swp_client::discover_or_default(None)
}

async fn recv_streaming_response(
    conn: &mut SWPConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut spinner = output::StreamSpinner::new();
    spinner.start();

    output::reset_chunk_state();

    let mut current_subagent: Option<String> = None;

    loop {
        let msg = conn.recv().await?;

        if !conn.matches_last_request(&msg) {
            continue;
        }

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
                if end.subagent.is_some() {
                    spinner.restart();
                    continue;
                }
                spinner.stop().await;
                debug!(finish_reason = end.finish_reason, "Stream complete");
                if end.finish_reason == "tool_use" {
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
                    serde_json::to_string(&err.code)
                        .unwrap_or_default()
                        .trim_matches('"'),
                    &err.message,
                );
                return Err(ReportedError::new(err.message.clone()).into());
            }
            ServerMessage::SendImage(img) => {
                output::print_send_image(img);
            }
            ServerMessage::Phase(phase) => {
                if spinner.is_active() {
                    spinner.set_phase(&phase.phase);
                    if let Some(model) = &phase.model {
                        spinner.set_model(Some(model.clone()));
                    }
                } else {
                    output::print_phase(phase);
                }
            }
            ServerMessage::ProviderWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_) => {
                spinner.clear().await;
                output::print_warning_frame(&msg);
            }
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::CommandOutput(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::Unknown => {}
        }
    }
}

async fn execute_operation<O: Operation>(
    conn: &mut SWPConnection,
    input: O::Input,
) -> Result<O::Output, Box<dyn std::error::Error>> {
    Ok(execute_operation_with_raw::<O>(conn, input).await?.0)
}

async fn execute_operation_with_raw<O: Operation>(
    conn: &mut SWPConnection,
    input: O::Input,
) -> Result<(O::Output, serde_json::Value), Box<dyn std::error::Error>> {
    let _request = conn.send_operation::<O>(input).await?;
    let data = recv_command_data(conn).await?;
    Ok((serde_json::from_value(data.clone())?, data))
}

async fn recv_command_data(
    conn: &mut SWPConnection,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    loop {
        let msg = conn.recv().await?;
        if !conn.matches_last_request(&msg) {
            continue;
        }
        match &msg {
            ServerMessage::CommandOutput(co) => {
                return Ok(co.data.clone());
            }
            ServerMessage::Error(err) => {
                output::print_server_error(
                    serde_json::to_string(&err.code)
                        .unwrap_or_default()
                        .trim_matches('"'),
                    &err.message,
                );
                return Err(ReportedError::new(err.message.clone()).into());
            }
            ServerMessage::ConfigWarning(w) => {
                output::print_config_warning(w);
            }
            ServerMessage::SendImage(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::Hello(_)
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
            | ServerMessage::ProviderWarning(_)
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::Unknown => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ModelChange, model_change};
    use crate::cli::{ModelCommand, ModelTarget};
    use shore_common::token::TokenSource;
    use tokio::io::AsyncWriteExt;
    use tokio::io::duplex;

    use shore_common::protocol::SWP_V1;
    use shore_common::protocol::client_msg::ClientMessage;
    use shore_common::protocol::error::ErrorCode;
    use shore_common::protocol::server_msg::*;
    use shore_common::protocol::types::*;

    use crate::cli::{Cli, CliCommand, MsgCommand};

    #[test]
    fn thread_commands_survive_a_thread_name_that_no_longer_resolves() {
        for args in [
            vec!["thread"],
            vec!["thread", "new", "eval"],
            vec!["thread", "use", "main"],
            vec!["thread", "archive", "eval"],
            vec!["thread", "label", "eval", "Agent SDK"],
            vec!["thread", "home", "main"],
            vec!["character"],
            vec!["status"],
            vec!["model"],
        ] {
            let mut full = vec!["shore"];
            full.extend_from_slice(&args);
            let cli = <Cli as clap::Parser>::parse_from(full);
            let command = cli.command.as_ref().expect("a command");
            assert!(
                !super::reads_the_selected_thread(command),
                "`shore {}` must run even when the selected thread is gone",
                args.join(" "),
            );
        }
    }

    #[test]
    fn conversation_commands_still_refuse_the_wrong_thread() {
        for args in [
            vec!["msg", "send", "hi"],
            vec!["log"],
            vec!["compact"],
            vec!["clear"],
            vec!["segments"],
        ] {
            let mut full = vec!["shore"];
            full.extend_from_slice(&args);
            let cli = <Cli as clap::Parser>::parse_from(full);
            let command = cli.command.as_ref().expect("a command");
            assert!(
                super::reads_the_selected_thread(command),
                "`shore {}` reads the thread, so a wrong one has to be an error",
                args.join(" "),
            );
        }
    }

    #[test]
    fn an_unresolved_thread_is_traced_to_where_it_was_named() {
        use super::{ThreadSource, thread_source};

        assert_eq!(
            thread_source(None, false),
            ThreadSource::Saved,
            "nothing on the command line means it came off disk",
        );
        assert_eq!(thread_source(Some("eval"), true), ThreadSource::Env);
        assert_eq!(thread_source(Some("eval"), false), ThreadSource::Flag);
    }

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

    async fn write_json_line<W: AsyncWriteExt + Unpin, T: serde::Serialize>(w: &mut W, val: &T) {
        let line = serde_json::to_string(val).unwrap();
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

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

    async fn mock_server(
        server_stream: tokio::io::DuplexStream,
        responses: Vec<ServerMessage>,
    ) -> ClientMessage {
        let (r, mut w) = tokio::io::split(server_stream);
        let mut reader = tokio::io::BufReader::new(r);

        let hello = ServerMessage::Hello(ServerHello {
            v: SWP_V1,
            server_name: "test-daemon".into(),
            characters: vec![],
        });
        write_json_line(&mut w, &hello).await;

        let _client_hello: ClientMessage = read_json_line(&mut reader).await;

        let history = ServerMessage::History(History {
            delta: None,
            rid: None,
            messages: vec![],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: None,
            selected_thread: None,
            revision: 0,
        });
        write_json_line(&mut w, &history).await;

        let client_msg: ClientMessage = read_json_line(&mut reader).await;

        let request = serde_json::to_value(&client_msg).unwrap();
        for msg in &responses {
            let mut response = serde_json::to_value(msg).unwrap();
            if response.get("rid").is_none() {
                let _previous = response.as_object_mut().unwrap().insert(
                    "rid".into(),
                    request.get("rid").cloned().unwrap_or_default(),
                );
            }
            write_json_line(&mut w, &response).await;
        }

        client_msg
    }

    fn model_command(subcommand: Option<ModelCommand>) -> CliCommand {
        model_flags(subcommand, false, false)
    }

    fn model_flags(subcommand: Option<ModelCommand>, info: bool, reset: bool) -> CliCommand {
        CliCommand::Model {
            subcommand,
            all: false,
            favorites: false,
            json: false,
            info,
            reset,
        }
    }

    use crate::cli::{UiCommand, ViewKey};
    use crate::run::tui_only_refusal;

    #[test]
    fn the_terminal_refuses_screen_commands_by_naming_where_they_work() {
        let view = CliCommand::View {
            key: ViewKey::Thinking,
            value: None,
        };
        let refusal = tui_only_refusal(&view).expect("view needs a screen");
        assert!(refusal.contains("thinking"), "{refusal}");
        assert!(refusal.contains("shore tui"), "{refusal}");

        let ui = CliCommand::Ui {
            command: UiCommand::Normal,
        };
        assert!(
            tui_only_refusal(&ui).is_some_and(|message| message.contains("shore tui")),
            "ui needs a screen too"
        );
    }

    #[test]
    fn a_daemon_backed_command_is_not_mistaken_for_a_screen_command() {
        let status = CliCommand::Status {
            section: None,
            json: false,
        };
        assert_eq!(tui_only_refusal(&status), None);
    }

    #[test]
    fn switching_models_clears_the_local_pin() {
        let cmd = model_command(Some(ModelCommand::Use {
            name: "opus".to_owned(),
            target: ModelTarget::default(),
        }));
        assert!(
            matches!(
                model_change(&cmd),
                Some(ModelChange::SwitchTo("opus", target)) if target.is_bare()
            ),
            "{cmd:?}"
        );
    }

    #[test]
    fn both_spellings_of_a_model_reset_are_one_change() {
        let flag = model_flags(None, false, true);
        assert!(matches!(
            model_change(&flag),
            Some(ModelChange::Reset(None))
        ));
        assert!(matches!(
            model_change(&model_command(Some(ModelCommand::Reset {
                target: ModelTarget::default()
            }))),
            Some(ModelChange::Reset(Some(target))) if target.is_bare()
        ));
    }

    #[test]
    fn reading_about_models_changes_nothing() {
        let listing = model_command(None);
        let describing = model_command(Some(ModelCommand::Info {
            name: None,
            target: ModelTarget::default(),
        }));
        let info_flag = model_flags(None, true, false);
        for cmd in [listing, describing, info_flag] {
            assert!(model_change(&cmd).is_none(), "{cmd:?}");
        }
    }

    fn test_cli(command: CliCommand) -> Cli {
        Cli {
            addr: None,
            character: None,
            thread: None,
            command: Some(command),
        }
    }

    fn msg_command(command: MsgCommand) -> CliCommand {
        CliCommand::Msg { command }
    }

    fn test_token() -> TokenSource {
        TokenSource::Given("test-token".into())
    }

    async fn execute_with_mock(cli: Cli, responses: Vec<ServerMessage>) -> ClientMessage {
        let (client_stream, server_stream) = duplex(16384);

        let server_handle = tokio::spawn(mock_server(server_stream, responses));

        let (mut conn, _hello, _history) = shore_common::swp_client::SWPConnection::connect_raw(
            client_stream,
            "cli",
            "shore-cli",
            cli.character.clone(),
            &test_token(),
        )
        .await
        .unwrap();

        let Some(command) = cli.command.as_ref() else {
            panic!("expected a command");
        };
        match command {
            CliCommand::View { .. } | CliCommand::Ui { .. } => {
                panic!("client-side commands never reach the daemon harness")
            }
            CliCommand::Msg {
                command:
                    MsgCommand::Send {
                        message, images, ..
                    },
            } => {
                let text = message.join(" ");
                let _ignored = conn
                    .send_message_with_images(&text, true, images.clone())
                    .await
                    .unwrap();
                super::recv_streaming_response(&mut conn).await.unwrap();
            }
            CliCommand::Msg {
                command: MsgCommand::Regen { guidance },
            } => {
                let _ignored = conn.send_regen(true, guidance.clone()).await.unwrap();
                super::recv_streaming_response(&mut conn).await.unwrap();
            }
            other @ (CliCommand::Msg { .. }
            | CliCommand::Log { .. }
            | CliCommand::Trace { .. }
            | CliCommand::Character { .. }
            | CliCommand::Thread { .. }
            | CliCommand::Export { .. }
            | CliCommand::Import { .. }
            | CliCommand::Status { .. }
            | CliCommand::Debug { .. }
            | CliCommand::Model { .. }
            | CliCommand::Provider { .. }
            | CliCommand::Compact { .. }
            | CliCommand::Segments { .. }
            | CliCommand::Clear { .. }
            | CliCommand::Config { .. }
            | CliCommand::Usage { .. }
            | CliCommand::Completions { .. }
            | CliCommand::Complete { .. }) => {
                let (name, args) = crate::cli::to_swp_command(other, None).unwrap();
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
                task_id: None,
                rid: None,
                regen: false,
            }),
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: text.into(),
                content_type: "text".into(),
            }),
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                terminal_content_blocks: None,
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

    #[tokio::test]
    async fn send_sends_swp_message() {
        let cli = test_cli(msg_command(MsgCommand::Send {
            message: vec!["hello".into(), "world".into()],
            images: vec![],
            system: false,
        }));
        let received = execute_with_mock(cli, streaming_response("Hi there!")).await;

        assert_variant!(
            received,
            ClientMessage::Message(m) => {
                assert_eq!(m.text, "hello world");
                assert!(m.stream);
            }
        );
    }

    #[tokio::test]
    async fn regen_sends_swp_regen() {
        let cli = test_cli(msg_command(MsgCommand::Regen {
            guidance: Some("consult memory first".into()),
        }));
        let received = execute_with_mock(cli, streaming_response("Haha!")).await;

        assert_variant!(
            received,
            ClientMessage::Regen(r) => {
                assert!(r.stream);
                assert_eq!(r.guidance.as_deref(), Some("consult memory first"));
            }
        );
    }

    #[tokio::test]
    async fn status_sends_swp_command() {
        let cli = test_cli(CliCommand::Status {
            section: None,
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

    #[tokio::test]
    async fn compact_sends_command() {
        let cli = test_cli(CliCommand::Compact {
            keep_turns: None,
            restart: false,
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

    #[tokio::test]
    async fn edit_sends_edit_command() {
        let cli = test_cli(msg_command(MsgCommand::Edit {
            msg_ref: "m1".into(),
            content: vec!["new".into(), "text".into()],
            json: false,
        }));
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

    #[tokio::test]
    async fn delete_sends_delete_command() {
        let cli = test_cli(msg_command(MsgCommand::Delete {
            msg_refs: vec!["m1".into()],
            json: false,
        }));
        let received = execute_with_mock(cli, command_response("delete")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "delete");
                assert_eq!(arg(&c.args, "refs"), &serde_json::json!(["m1"]));
            }
        );
    }

    #[tokio::test]
    async fn delete_sends_every_ref_in_one_command() {
        let cli = test_cli(msg_command(MsgCommand::Delete {
            msg_refs: vec!["-1".into(), "-2".into(), "-3".into()],
            json: false,
        }));
        let received = execute_with_mock(cli, command_response("delete")).await;

        assert_variant!(
            received,
            ClientMessage::Command(c) => {
                assert_eq!(c.name, "delete");
                assert_eq!(arg(&c.args, "refs"), &serde_json::json!(["-1", "-2", "-3"]));
            }
        );
    }

    #[tokio::test]
    async fn streaming_with_thinking_chunks() {
        let responses = vec![
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                task_id: None,
                rid: None,
                regen: false,
            }),
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: "Let me think...".into(),
                content_type: "thinking".into(),
            }),
            ServerMessage::StreamChunk(StreamChunk {
                subagent: None,
                task_id: None,
                rid: None,
                text: "Here's the answer.".into(),
                content_type: "text".into(),
            }),
            ServerMessage::StreamEnd(StreamEnd {
                subagent: None,
                task_id: None,
                rid: None,
                msg_id: None,
                revision: None,
                terminal_content_blocks: None,
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

        let cli = test_cli(msg_command(MsgCommand::Send {
            message: vec!["test".into()],
            images: vec![],
            system: false,
        }));
        let received = execute_with_mock(cli, responses).await;
        assert!(matches!(received, ClientMessage::Message(_)));
    }

    #[test]
    fn an_edit_with_no_replacement_text_asks_the_editor_instead_of_erasing() {
        let none: Vec<String> = vec![];
        assert!(
            super::typed_replacement(&none, "last")
                .expect("no arguments is not an error")
                .is_none(),
            "bare `msg edit last` should fall through to the editor"
        );
    }

    #[test]
    fn an_explicitly_empty_edit_is_refused_and_points_at_delete() {
        for empty in [vec![String::new()], vec!["   ".to_owned()]] {
            let refusal = super::typed_replacement(&empty, "-2")
                .expect_err("empty replacement text must not reach the daemon")
                .to_string();
            assert!(refusal.contains("-2"), "{refusal}");
            assert!(refusal.contains("msg delete"), "{refusal}");
        }
    }

    #[test]
    fn typed_replacement_text_is_joined_and_trimmed() {
        let typed = super::typed_replacement(&["  hello".to_owned(), "there  ".to_owned()], "last")
            .expect("valid")
            .expect("some");
        assert_eq!(typed, "hello there");
    }

    #[test]
    fn closing_the_editor_unchanged_or_empty_leaves_the_message_alone() {
        assert_eq!(
            super::editor_replacement("the original", "the original"),
            None
        );
        assert_eq!(
            super::editor_replacement("the original", "the original\n"),
            None,
            "a trailing newline the editor added is not a change"
        );
        assert_eq!(super::editor_replacement("the original", ""), None);
        assert_eq!(super::editor_replacement("the original", "   \n "), None);
        assert_eq!(
            super::editor_replacement("the original", " a rewrite \n"),
            Some("a rewrite".to_owned())
        );
    }

    #[test]
    fn the_editor_opens_on_the_text_the_message_actually_holds() {
        let blocks = serde_json::json!({
            "content": "",
            "content_blocks": [
                { "type": "thinking", "text": "ignore me" },
                { "type": "text", "text": "first" },
                { "type": "text", "text": "second" },
            ],
        });
        assert_eq!(super::message_text(&blocks), "first\nsecond");

        let plain = serde_json::json!({ "content": "just content" });
        assert_eq!(super::message_text(&plain), "just content");

        let neither = serde_json::json!({ "content_blocks": [] });
        assert_eq!(super::message_text(&neither), "");
    }

    #[test]
    fn the_editor_buffer_starts_from_the_current_message() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("seed.md");
        super::seed_editor_file(&path, "the original\n\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "the original\n");

        let blank = tmp.path().join("blank.md");
        super::seed_editor_file(&blank, "  \n ").unwrap();
        assert!(
            !blank.exists(),
            "an empty message should leave the editor on an untouched buffer"
        );
    }

    #[test]
    fn the_editor_sees_the_old_text_and_its_save_becomes_the_replacement() {
        let rewritten = super::edit_text_with("sed -i s/original/rewritten/", "the original")
            .expect("the editor ran");
        assert_eq!(rewritten, "the rewritten");
    }

    #[test]
    fn an_editor_that_exits_badly_changes_nothing() {
        let left_alone = super::edit_text_with("false", "the original").expect("no hard failure");
        assert_eq!(
            super::editor_replacement("the original", &left_alone),
            None,
            "a failed editor must not be read as an empty rewrite"
        );
    }

    #[test]
    fn json_to_toml_reorders_tables_after_scalars() {
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
        let data = serde_json::json!({
            "key": "daemon",
            "config": {
                "addr": "0.0.0.0:1112",
            },
            "defaults": {
                "addr": "127.0.0.1:7320",
            },
        });
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
        let config = serde_json::json!({ "a": 1, "b": 2 });
        let defaults = serde_json::json!({ "a": 1, "b": 2 });
        assert!(super::filter_non_defaults(&config, Some(&defaults)).is_none());
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

    async fn error_from_mock(err: Error) -> Box<dyn std::error::Error> {
        let (client_stream, server_stream) = duplex(16384);
        let server = tokio::spawn(mock_server(server_stream, vec![ServerMessage::Error(err)]));

        let (mut conn, _hello, _history) = shore_common::swp_client::SWPConnection::connect_raw(
            client_stream,
            "cli",
            "shore-cli",
            None,
            &test_token(),
        )
        .await
        .unwrap();
        let _ignored = conn
            .send_command("status", serde_json::json!({}))
            .await
            .unwrap();
        let failure = super::recv_command_data(&mut conn)
            .await
            .expect_err("the mock answers with an error");
        drop(conn);
        let _client_msg = server.await.unwrap();
        failure
    }

    #[tokio::test]
    async fn a_server_error_is_marked_as_already_reported() {
        let failure = error_from_mock(Error {
            rid: None,
            code: ErrorCode::InvalidRequest,
            message: "no characters available".into(),
            retry_after_ms: None,
        })
        .await;

        assert!(super::already_reported(failure.as_ref()));
        assert_eq!(failure.to_string(), "no characters available");
    }

    #[test]
    fn an_unprinted_error_is_not_marked() {
        let failure: Box<dyn std::error::Error> = "connection refused".into();
        assert!(!super::already_reported(failure.as_ref()));
    }

    #[test]
    fn the_environment_order_is_visual_then_editor_then_vi() {
        assert_eq!(
            super::resolve_editor(Some("code -w".into()), Some("nano".into())),
            "code -w"
        );
        assert_eq!(super::resolve_editor(None, Some("nano".into())), "nano");
        assert_eq!(super::resolve_editor(None, None), "vi");
    }

    #[test]
    fn a_blank_candidate_is_skipped_rather_than_launched() {
        assert_eq!(
            super::resolve_editor(Some("  ".into()), Some("nano".into())),
            "nano"
        );
        assert_eq!(super::resolve_editor(Some(String::new()), None), "vi");
    }

    #[test]
    fn a_bare_editor_name_is_launched_directly() {
        let (program, args) = super::editor_invocation("nvim", std::path::Path::new("/tmp/d.md"));
        assert_eq!(program, "nvim");
        assert_eq!(args, ["/tmp/d.md"]);
    }

    #[test]
    fn an_editor_with_arguments_goes_through_a_shell() {
        let (program, args) =
            super::editor_invocation("code -w", std::path::Path::new("/tmp/d.md"));
        assert_eq!(program, "sh");
        assert_eq!(args, ["-c", "code -w \"$@\"", "code -w", "/tmp/d.md"]);
    }

    #[test]
    fn a_path_the_shell_would_split_is_still_passed_as_one_argument() {
        let (_, args) = super::editor_invocation("code -w", std::path::Path::new("/tmp/my d.md"));
        assert_eq!(
            args.last().map(std::ffi::OsString::as_os_str),
            Some(std::ffi::OsStr::new("/tmp/my d.md")),
            "the file is a positional argument, not part of the command string",
        );
    }

    #[test]
    fn display_ref_decorates_human_output_without_replacing_the_wire_ref() {
        let shown = super::response_with_display_ref(
            serde_json::json!({ "ref": "m_290d4d13-9370" }),
            "last",
        );
        assert_eq!(
            shown.get("ref"),
            Some(&serde_json::json!("m_290d4d13-9370"))
        );
        assert_eq!(shown.get("_display_ref"), Some(&serde_json::json!("last")));
    }

    #[test]
    fn setting_keys_carry_the_effective_value_as_the_description() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "setting_schema": [
                {"key":"temperature","applicability":"honored"},
                {"key":"top_p","applicability":"honored"}
            ],
            "effective_sampler": { "temperature": 0.8, "top_p": null },
        }));
        assert!(lines.contains(&"temperature\t0.8".to_owned()), "{lines:?}");
        assert!(lines.contains(&"top_p\tunset".to_owned()), "{lines:?}");
    }

    #[test]
    fn setting_values_come_from_the_daemon_suggestions() {
        let values = super::setting_value_completions(
            &serde_json::json!({
                "setting_schema": [{
                    "key":"reasoning_effort",
                    "applicability":"honored",
                    "suggestions":["low","provider-future-value"]
                }]
            }),
            "reasoning_effort",
        );
        assert_eq!(values, ["low", "provider-future-value"]);
    }

    #[test]
    fn a_key_the_model_rejects_is_not_offered() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "setting_schema": [
                {"key":"temperature","applicability":"rejected"},
                {"key":"top_p","applicability":"honored"}
            ],
            "effective_sampler": {},
        }));
        assert_eq!(lines, vec!["top_p\tunset".to_owned()]);
    }

    #[test]
    fn a_key_the_model_ignores_is_hidden() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "setting_schema": [{"key":"top_p","applicability":"ignored"}],
            "effective_sampler": { "top_p": 0.9 },
        }));
        assert!(lines.is_empty());
    }

    #[test]
    fn a_string_setting_is_described_without_json_quotes() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "setting_schema": [{"key":"reasoning_effort","applicability":"honored"}],
            "effective_sampler": { "reasoning_effort": "high" },
        }));
        assert_eq!(lines, vec!["reasoning_effort\thigh".to_owned()]);
    }
}
