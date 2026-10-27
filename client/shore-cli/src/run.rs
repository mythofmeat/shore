use shore_common::protocol::operations::{
    CancelCompaction, ConfigReloadArgs, ConversationLog, ConversationLogArgs, ConversationPage,
    CreateCharacter, DeleteCharacter, DeleteCharacterArgs, EmptyOperationArgs, GetMessage,
    GetMessageArgs, NamedOperationArgs, Operation, OperationResponse, ReadStatus,
    ReloadConfiguration, ResetModel, ResetModelArgs, SwitchCharacter, SwitchModel, SwitchModelArgs,
    SwitchThread, SwitchThreadArgs, is_registered_operation,
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
const VERSION_PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

fn log_role_matches(filter: Option<&LogRole>, role: &Role) -> bool {
    match filter {
        None => true,
        Some(LogRole::User) => *role == Role::User,
        Some(LogRole::Assistant | LogRole::Character) => *role == Role::Assistant,
        Some(LogRole::System) => *role == Role::System,
    }
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
        version: false,
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
        CliCommand::Export {
            character: exported,
            all: _,
            full,
            output,
            json,
        } => {
            crate::archives::handle_export(
                &mut conn,
                exported.as_deref(),
                output.as_deref(),
                *full,
                *json,
            )
            .await?;
        }
        CliCommand::Import { archive, json } => {
            crate::archives::handle_import(&mut conn, archive, *json).await?;
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
        compact @ CliCommand::Compact { json: false, .. } => {
            handle_compact(&mut conn, compact, cli.character.as_deref()).await?;
        }
        other @ (CliCommand::Character { .. }
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

async fn handle_compact(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
    character: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some((name, args)) = crate::cli::to_swp_command(cmd, character) else {
        return Err("compact must map to an SWP command".into());
    };
    _ = conn.send_command(name, args).await?;
    let watching = name != CancelCompaction::NAME;
    if watching {
        output::print_notice(
            "Ctrl-C stops watching; the compaction keeps running. `shore compact --cancel` stops it.",
        );
    }
    output::reset_chunk_state();
    let received = tokio::select! {
        data = recv_compaction_stream(conn) => data,
        _ = tokio::signal::ctrl_c(), if watching => {
            output::end_live_output();
            output::print_notice(
                "Stopped watching. The compaction is still running: `shore compact --watch` follows it again.",
            );
            return Ok(());
        }
    };
    output::end_live_output();
    let data = received?;
    validate_registered_output(name, &data)?;
    output::format_command(name, &data);
    Ok(())
}

async fn recv_compaction_stream(
    conn: &mut SWPConnection,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    loop {
        let msg = conn.recv().await?;
        if !conn.matches_last_request(&msg) {
            continue;
        }
        match &msg {
            ServerMessage::CommandOutput(co) => return Ok(co.data.clone()),
            ServerMessage::Error(err) => {
                output::end_live_output();
                output::print_server_error(
                    serde_json::to_string(&err.code)
                        .unwrap_or_default()
                        .trim_matches('"'),
                    &err.message,
                );
                return Err(ReportedError::new(err.message.clone()).into());
            }
            ServerMessage::StreamChunk(chunk) => output::print_chunk(chunk),
            ServerMessage::ToolCall(call) => output::print_tool_call(call),
            ServerMessage::ToolResult(result) => output::print_tool_result(result),
            ServerMessage::Phase(phase) => output::print_phase_header(phase),
            ServerMessage::ProviderWarning(_) | ServerMessage::ProviderFallbackWarning(_) => {
                output::print_warning_frame(&msg);
            }
            ServerMessage::ConfigWarning(w) => output::print_config_warning(w),
            ServerMessage::Hello(_)
            | ServerMessage::History(_)
            | ServerMessage::Shutdown(_)
            | ServerMessage::Ping(_)
            | ServerMessage::StreamStart(_)
            | ServerMessage::StreamEnd(_)
            | ServerMessage::NewMessage(_)
            | ServerMessage::SendImage(_)
            | ServerMessage::CacheWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::PlanLimitWarning(_)
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::ThreadsChanged(_)
            | ServerMessage::ThreadUnread(_)
            | ServerMessage::Unknown => {}
        }
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
    validate_registered_output(name, &data)?;
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

pub(crate) fn validate_registered_output(
    name: &str,
    data: &serde_json::Value,
) -> Result<(), serde_json::Error> {
    if !is_registered_operation(name) {
        return Ok(());
    }
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

    let check = execute_operation::<ReloadConfiguration>(
        conn,
        ConfigReloadArgs {
            apply: None,
            refresh_prompts: None,
        },
    )
    .await?;

    let changed = check.changed_prompt_files;

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

    let (_, data) = execute_operation_with_raw::<ReloadConfiguration>(
        conn,
        ConfigReloadArgs {
            apply: Some(true),
            refresh_prompts: Some(refresh_prompts),
        },
    )
    .await?;

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
        segment,
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

    let (page, data) = execute_operation_with_raw::<ConversationLog>(
        conn,
        ConversationLogArgs {
            turns: Some(u64::from(*count)),
            count: None,
            role: role.map(LogRole::as_protocol_role),
            segment: segment.map(u64::from),
        },
    )
    .await?;

    render_log_list(&page, &data, *json, *content, display_character, filter)?;

    if *follow {
        let previous = page.previous_segment.map(|summary| summary.index);
        follow_log_stream(conn, role.as_ref(), display_character, filter, previous).await?;
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
    page: &ConversationPage,
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
    } else {
        let frame = output::SegmentFrame::of_page(page, chrono::Local::now());
        if output::use_decoration() {
            output::print_log_framed(messages, &frame, display_character, filter);
        } else {
            output::print_log_plain_framed(messages, &frame, display_character, filter);
        }
    }
    Ok(())
}

async fn follow_log_stream(
    conn: &mut SWPConnection,
    role: Option<&LogRole>,
    follow_char: &str,
    filter: output::LogFilter,
    mut previous_segment: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut reply_streaming = false;
    loop {
        let msg = conn.recv().await?;
        let main_agent = msg.subagent().is_none() && msg.task_id().is_none();
        if let ServerMessage::StreamStart(_) = msg {
            reply_streaming |= main_agent;
        } else if let ServerMessage::StreamEnd(end) = &msg {
            reply_streaming &= !(main_agent && end.is_final);
        } else if let ServerMessage::Error(_) = msg {
            reply_streaming = false;
        } else {
        }
        if msg.subagent().is_some() && !filter.subagent_tools {
            continue;
        }
        match &msg {
            ServerMessage::NewMessage(nm)
                if reply_streaming && nm.message.role == Role::Assistant => {}
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
            ServerMessage::History(history) if history.delta.is_none() => {
                let latest = history
                    .previous_segment
                    .as_ref()
                    .map(|summary| summary.index);
                if latest != previous_segment
                    && let Some(index) = latest
                {
                    output::print_segment_boundary(index);
                }
                previous_segment = latest;
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
            | ServerMessage::PlanLimitWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::ThreadsChanged(_)
            | ServerMessage::ThreadUnread(_)
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
    let (_, data) = execute_operation_with_raw::<ReadStatus>(conn, EmptyOperationArgs {}).await?;
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
    let selected = target.map(ModelTarget::operation_args).unwrap_or_default();
    let (command, data) = match change {
        ModelChange::Reset(_) => {
            let (_, data) = execute_operation_with_raw::<ResetModel>(
                conn,
                ResetModelArgs {
                    background_task: selected.background_task,
                    subagent: selected.subagent,
                },
            )
            .await?;
            (ResetModel::NAME, data)
        }
        ModelChange::SwitchTo(name, _) => {
            let (_, data) = execute_operation_with_raw::<SwitchModel>(
                conn,
                SwitchModelArgs {
                    name: Some(name.to_owned()),
                    include_hidden: all.then_some(true),
                    background_task: selected.background_task,
                    subagent: selected.subagent,
                },
            )
            .await?;
            (SwitchModel::NAME, data)
        }
    };
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

    let backup = archive
        .map(|path| crate::archives::archive_target(Some(path), name))
        .transpose()?;
    if let Some(target) = &backup {
        _ = crate::archives::export_to(conn, name, target).await?;
    }

    info!(character = name, "Deleting character");
    let (data, mut raw) = execute_operation_with_raw::<DeleteCharacter>(
        conn,
        DeleteCharacterArgs {
            character: name.to_owned(),
            confirm: name.to_owned(),
            archive: None,
        },
    )
    .await?;

    if json {
        if let (Some(target), Some(fields)) = (&backup, raw.as_object_mut()) {
            _ = fields.insert("archive".to_owned(), target.display().to_string().into());
        }
        cli_out!("{}", serde_json::to_string_pretty(&raw)?);
    } else {
        if let Some(target) = &backup {
            cli_out!("Backed up to {}", target.display());
        }
        cli_out!("Deleted character: {name}");
        for path in data.removed {
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

pub(crate) async fn print_version(
    requested_addr: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    cli_out!("shore {}", env!("CARGO_PKG_VERSION"));
    let addr = match requested_addr {
        Some(addr) => ServerAddr(addr),
        None => match shore_common::swp_client::discover_or_default(None) {
            Ok(addr) => addr,
            Err(e) => {
                cli_out!("daemon: not found ({e})");
                return Ok(());
            }
        },
    };
    match SWPConnection::probe(&addr, VERSION_PROBE_DEADLINE).await {
        Ok(hello) => cli_out!(
            "daemon {} at {}",
            hello
                .server_version
                .as_deref()
                .unwrap_or("unknown (too old to report it)"),
            addr.0
        ),
        Err(e) => cli_out!("daemon: not reachable at {} ({e})", addr.0),
    }
    Ok(())
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
            | ServerMessage::PlanLimitWarning(_)
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
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::ThreadsChanged(_)
            | ServerMessage::ThreadUnread(_)
            | ServerMessage::Unknown => {}
        }
    }
}

pub(crate) async fn execute_operation<O: Operation>(
    conn: &mut SWPConnection,
    input: O::Input,
) -> Result<O::Output, Box<dyn std::error::Error>> {
    Ok(execute_operation_with_raw::<O>(conn, input).await?.0)
}

pub(crate) async fn execute_operation_with_raw<O: Operation>(
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
            | ServerMessage::PlanLimitWarning(_)
            | ServerMessage::RequestAccepted(_)
            | ServerMessage::RequestFinished(_)
            | ServerMessage::ThreadsChanged(_)
            | ServerMessage::ThreadUnread(_)
            | ServerMessage::Unknown => {}
        }
    }
}

#[cfg(test)]
mod tests {

    use crate::cli::Cli;

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
    fn an_editor_that_exits_badly_changes_nothing() {
        let left_alone = super::edit_text_with("false", "the original").expect("no hard failure");
        assert_eq!(
            super::editor_replacement("the original", &left_alone),
            None,
            "a failed editor must not be read as an empty rewrite"
        );
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
}
