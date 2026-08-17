use std::io::{self, IsTerminal, Read as _};
use std::path::PathBuf;
use std::sync::OnceLock;

use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::Role;
use shore_common::swp_client::{SWPConnection, ServerAddr};
use tracing::{debug, info, instrument};

use crate::cli::{BackgroundTarget, Cli, CliCommand, LogRole, ModelCommand};
use crate::output;
use crate::state;

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

#[instrument(skip(cli))]
pub(crate) async fn execute(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(result) = try_handle_local_only(&cli).await {
        return result;
    }

    let addr = resolve_addr(&cli)?;

    let character = cli.character.clone().or_else(state::read_active_character);

    info!(character = ?character, "CLI executing command");

    let (mut conn, _server_hello, history) =
        SWPConnection::connect(&addr, "cli", "shore-cli", character.clone()).await?;

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

    pre_apply_active_model(&mut conn).await;

    match &cli.command {
        CliCommand::Send { .. } => handle_send_command(&mut conn, &cli.command).await?,
        CliCommand::Regen => {
            _ = conn.send_regen(true).await?;
            recv_streaming_response(&mut conn).await?;
        }
        CliCommand::Alt { .. } => handle_alt_command(&mut conn, &cli.command).await?,
        CliCommand::Character {
            subcommand: Some(crate::cli::CharacterCommand::New { name }),
            ..
        } => handle_create_character(&mut conn, name).await?,
        CliCommand::Character {
            subcommand: Some(crate::cli::CharacterCommand::Use { name }),
            ..
        } => handle_switch_character(&mut conn, name).await?,
        CliCommand::Character {
            subcommand: None,
            info: false,
            json,
        } => handle_list_characters(&mut conn, *json).await?,
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
            handle_log_command(&mut conn, &cli.command, &display_character).await?;
        }
        CliCommand::Edit { msg_ref, json, .. } => {
            let one = std::slice::from_ref(msg_ref);
            handle_message_change(&mut conn, &cli.command, *json, one).await?;
        }
        CliCommand::Delete { msg_refs, json } => {
            handle_message_change(&mut conn, &cli.command, *json, msg_refs).await?;
        }
        CliCommand::Status { .. } => {
            handle_status_command(&mut conn, &cli.command, &display_character).await?;
        }
        CliCommand::Model { .. } if model_change(&cli.command).is_some() => {
            let Some(change) = model_change(&cli.command) else {
                return Ok(());
            };
            apply_model_change(&mut conn, &cli.command, change).await?;
        }
        other @ (CliCommand::Character { .. }
        | CliCommand::Trace { .. }
        | CliCommand::Debug { .. }
        | CliCommand::Model { .. }
        | CliCommand::Provider { .. }
        | CliCommand::Compact { .. }
        | CliCommand::Config { .. }
        | CliCommand::Usage { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }) => {
            handle_generic_swp_command(&mut conn, other, cli.character.as_deref()).await?;
        }
    }

    Ok(())
}

fn wants_json(other: &CliCommand) -> bool {
    match other {
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
        | CliCommand::Compact { json, .. }
        | CliCommand::Usage { json, .. } => *json,
        CliCommand::Debug { subcommand } => matches!(
            subcommand,
            Some(
                crate::cli::DebugCommand::Tool { json: true, .. }
                    | crate::cli::DebugCommand::Subagent { json: true, .. }
            )
        ),
        CliCommand::Edit { json, .. } | CliCommand::Delete { json, .. } => *json,
        CliCommand::Send { .. }
        | CliCommand::Regen
        | CliCommand::Alt { .. }
        | CliCommand::Log { .. }
        | CliCommand::Status { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. } => false,
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

fn config_keys_filter(other: &CliCommand) -> Option<&str> {
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

fn usage_view(cmd: &CliCommand) -> Option<output::usage::View> {
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
            | ServerMessage::ProviderFallbackWarning(_)
            | ServerMessage::UsageWarning(_)
            | ServerMessage::ConfigWarning(_)
            | ServerMessage::Unknown => {}
        }
    }
    Ok(())
}

async fn handle_send_command(
    conn: &mut SWPConnection,
    cmd: &CliCommand,
) -> Result<(), Box<dyn std::error::Error>> {
    let CliCommand::Send {
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
        _ = conn
            .send_message_with_images(&text, true, images.clone())
            .await?;
        recv_streaming_response(conn).await?;
    }
    Ok(())
}

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
    SwitchTo(&'target str, Option<BackgroundTarget>),
    Reset(Option<BackgroundTarget>),
}

fn model_change(cmd: &CliCommand) -> Option<ModelChange<'_>> {
    let CliCommand::Model {
        subcommand, reset, ..
    } = cmd
    else {
        return None;
    };
    match subcommand {
        Some(ModelCommand::Use {
            name: target,
            background,
        }) => Some(ModelChange::SwitchTo(target, *background)),
        Some(ModelCommand::Reset { background }) => Some(ModelChange::Reset(*background)),
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
    let background = match change {
        ModelChange::Reset(task) | ModelChange::SwitchTo(_, task) => task,
    };
    let with_task = |mut args: serde_json::Map<String, serde_json::Value>| {
        if let Some(task) = background {
            _ = args.insert("background_task".into(), serde_json::json!(task.as_str()));
        }
        args
    };
    let (command, args) = match change {
        ModelChange::Reset(_) => ("reset_model", with_task(serde_json::Map::new())),
        ModelChange::SwitchTo(target, _) => {
            let mut args = serde_json::Map::new();
            _ = args.insert("name".into(), serde_json::json!(target));
            if *all {
                _ = args.insert("include_hidden".into(), serde_json::json!(true));
            }
            ("switch_model", with_task(args))
        }
    };
    _ = conn
        .send_command(command, serde_json::Value::Object(args))
        .await?;
    let data = recv_command_data(conn).await?;
    if background.is_none() {
        _ = state::clear_active_model();
    }
    if *json {
        cli_out!("{}", serde_json::to_string_pretty(&data)?);
    } else {
        output::format_command(command, &data);
    }
    Ok(())
}

async fn try_handle_local_only(cli: &Cli) -> Option<Result<(), Box<dyn std::error::Error>>> {
    if matches!(&cli.command, CliCommand::Config { path: true, .. }) {
        return Some(print_config_path(cli).await);
    }
    if let CliCommand::Complete { kind, arg } = &cli.command {
        let _ignored = handle_complete_query(*kind, arg.as_deref(), cli).await;
        return Some(Ok(()));
    }
    None
}

async fn pre_apply_active_model(conn: &mut SWPConnection) {
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

async fn handle_create_character(
    conn: &mut SWPConnection,
    name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ignored = conn
        .send_command("create_character", serde_json::json!({ "name": name }))
        .await?;
    let data = recv_command_data(conn).await?;

    let workspace = data
        .get("workspace_dir")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    cli_out!("Created character scaffold: {workspace}");

    for (file, purpose) in SCAFFOLD_GUIDE {
        let created = data
            .get("created_files")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|files| files.iter().any(|f| f.as_str() == Some(file)));
        if created {
            cli_out!("  {file:<10} {purpose}");
        }
    }
    cli_out!("Switch to it with: shore character {name}");
    Ok(())
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
    let (mut conn, _hello, _history) =
        SWPConnection::connect(&addr, "cli", "shore-cli", None).await?;

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

    if kind == CompleteKind::SettingKeys {
        let _ignored = conn
            .send_command("model_settings", serde_json::json!({}))
            .await?;
        let data = recv_command_data(&mut conn).await?;
        print_setting_key_completions(&data);
        return Ok(());
    }

    let (cmd, array_keys) = match kind {
        CompleteKind::Models => ("list_models", &["models"][..]),
        CompleteKind::Characters => ("list_characters", &["characters"][..]),
        CompleteKind::Providers => ("list_providers", &["providers"][..]),
        CompleteKind::Sections => ("status", &["sections"][..]),
        CompleteKind::Tools => ("tools", &["tools", "subagents", "mcp"][..]),
        CompleteKind::Subagents => ("tools", &["subagents"][..]),
        CompleteKind::SettingKeys
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
    let Some(applicability) = data
        .get("applicability")
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    let effective = data
        .get("effective_sampler")
        .and_then(serde_json::Value::as_object);

    let mut out = Vec::new();
    for (key, raw) in applicability {
        let verdict = raw.as_str().unwrap_or("always");
        if verdict == "rejected" {
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

fn config_dir() -> PathBuf {
    shore_common::dirs::config_dir()
}

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

fn print_config_toml(
    data: &serde_json::Value,
    show_all: bool,
) -> Result<(), Box<dyn std::error::Error>> {
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
    cli_write!("{rendered}");
    Ok(())
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

fn resolve_editor(visual: Option<String>, editor: Option<String>) -> String {
    [visual, editor]
        .into_iter()
        .flatten()
        .map(|c| c.trim().to_owned())
        .find(|c| !c.is_empty())
        .unwrap_or_else(|| "vi".into())
}

fn edit_message_in_editor() -> Result<String, Box<dyn std::error::Error>> {
    let editor = resolve_editor(std::env::var("VISUAL").ok(), std::env::var("EDITOR").ok());

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
            ServerMessage::ProviderFallbackWarning(_)
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
            | ServerMessage::Unknown => {}
        }
    }
}

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
            ServerMessage::NewMessage(new_msg) => {
                output::print_new_message(
                    new_msg,
                    new_msg
                        .character
                        .as_deref()
                        .unwrap_or_else(|| session_display_character()),
                );
            }
            ServerMessage::ConfigWarning(w) => {
                output::print_config_warning(w);
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

#[cfg(test)]
mod tests {
    use super::{ModelChange, model_change};
    use crate::cli::ModelCommand;
    use crate::test_env::set_env;
    use tokio::io::AsyncWriteExt;
    use tokio::io::duplex;

    use shore_common::protocol::SWP_V1;
    use shore_common::protocol::client_msg::ClientMessage;
    use shore_common::protocol::error::ErrorCode;
    use shore_common::protocol::server_msg::*;
    use shore_common::protocol::types::*;

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
            rid: None,
            messages: vec![],
            active_start: 0,
            config: serde_json::json!({}),
            selected_character: None,
            revision: 0,
        });
        write_json_line(&mut w, &history).await;

        let client_msg: ClientMessage = read_json_line(&mut reader).await;

        for msg in &responses {
            write_json_line(&mut w, msg).await;
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
            json: false,
            info,
            reset,
        }
    }

    #[test]
    fn switching_models_clears_the_local_pin() {
        let cmd = model_command(Some(ModelCommand::Use {
            name: "opus".to_owned(),
            background: None,
        }));
        assert!(
            matches!(
                model_change(&cmd),
                Some(ModelChange::SwitchTo("opus", None))
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
                background: None
            }))),
            Some(ModelChange::Reset(None))
        ));
    }

    #[test]
    fn reading_about_models_changes_nothing() {
        let listing = model_command(None);
        let describing = model_command(Some(ModelCommand::Info { name: None }));
        let info_flag = model_flags(None, true, false);
        for cmd in [listing, describing, info_flag] {
            assert!(model_change(&cmd).is_none(), "{cmd:?}");
        }
    }

    fn test_cli(command: CliCommand) -> Cli {
        Cli {
            addr: None,
            character: None,
            command,
        }
    }

    fn with_token() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| set_env(shore_common::token::TOKEN_ENV, "test-token"));
    }

    async fn execute_with_mock(cli: Cli, responses: Vec<ServerMessage>) -> ClientMessage {
        with_token();
        let (client_stream, server_stream) = duplex(16384);

        let server_handle = tokio::spawn(mock_server(server_stream, responses));

        let (mut conn, _hello, _history) = shore_common::swp_client::SWPConnection::connect_raw(
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
            CliCommand::Regen => {
                let _ignored = conn.send_regen(true).await.unwrap();
                super::recv_streaming_response(&mut conn).await.unwrap();
            }
            other @ (CliCommand::Alt { .. }
            | CliCommand::Log { .. }
            | CliCommand::Edit { .. }
            | CliCommand::Delete { .. }
            | CliCommand::Trace { .. }
            | CliCommand::Character { .. }
            | CliCommand::Status { .. }
            | CliCommand::Debug { .. }
            | CliCommand::Model { .. }
            | CliCommand::Provider { .. }
            | CliCommand::Compact { .. }
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

    #[tokio::test]
    async fn send_sends_swp_message() {
        let cli = test_cli(CliCommand::Send {
            message: vec!["hello".into(), "world".into()],
            images: vec![],
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

    #[tokio::test]
    async fn regen_sends_swp_regen() {
        let cli = test_cli(CliCommand::Regen);
        let received = execute_with_mock(cli, streaming_response("Haha!")).await;

        assert_variant!(
            received,
            ClientMessage::Regen(r) => assert!(r.stream)
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
        let cli = test_cli(CliCommand::Edit {
            msg_ref: "m1".into(),
            content: vec!["new".into(), "text".into()],
            json: false,
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

    #[tokio::test]
    async fn delete_sends_delete_command() {
        let cli = test_cli(CliCommand::Delete {
            msg_refs: vec!["m1".into()],
            json: false,
        });
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
        let cli = test_cli(CliCommand::Delete {
            msg_refs: vec!["-1".into(), "-2".into(), "-3".into()],
            json: false,
        });
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
            system: false,
        });
        let received = execute_with_mock(cli, responses).await;
        assert!(matches!(received, ClientMessage::Message(_)));
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
        with_token();
        let (client_stream, server_stream) = duplex(16384);
        let server = tokio::spawn(mock_server(server_stream, vec![ServerMessage::Error(err)]));

        let (mut conn, _hello, _history) = shore_common::swp_client::SWPConnection::connect_raw(
            client_stream,
            "cli",
            "shore-cli",
            None,
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
            "applicability": { "temperature": "honored", "top_p": "honored" },
            "effective_sampler": { "temperature": 0.8, "top_p": null },
        }));
        assert!(lines.contains(&"temperature\t0.8".to_owned()), "{lines:?}");
        assert!(lines.contains(&"top_p\tunset".to_owned()), "{lines:?}");
    }

    #[test]
    fn a_key_the_model_rejects_is_not_offered() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "applicability": { "temperature": "rejected", "top_p": "honored" },
            "effective_sampler": {},
        }));
        assert_eq!(lines, vec!["top_p\tunset".to_owned()]);
    }

    #[test]
    fn a_key_the_model_ignores_is_offered_but_flagged() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "applicability": { "top_p": "ignored" },
            "effective_sampler": { "top_p": 0.9 },
        }));
        assert_eq!(lines, vec!["top_p\t0.9 (ignored by this model)".to_owned()]);
    }

    #[test]
    fn a_string_setting_is_described_without_json_quotes() {
        let lines = super::setting_key_completions(&serde_json::json!({
            "applicability": { "reasoning_effort": "honored" },
            "effective_sampler": { "reasoning_effort": "high" },
        }));
        assert_eq!(lines, vec!["reasoning_effort\thigh".to_owned()]);
    }
}
