use crate::cli::{CliCommand, ConfigCommand};

const TUI_OUTPUT_WIDTH: usize = 80;

fn written(write: impl FnOnce(&mut Vec<u8>)) -> String {
    let mut buffer = Vec::new();
    write(&mut buffer);
    String::from_utf8_lossy(&buffer).trim_end().to_owned()
}

fn json(data: &serde_json::Value) -> String {
    serde_json::to_string_pretty(data).unwrap_or_else(|_| data.to_string())
}

fn config_modes(command: &CliCommand) -> (bool, bool) {
    match command {
        CliCommand::Config {
            toml,
            all,
            subcommand,
            ..
        } => match subcommand {
            Some(ConfigCommand::Get {
                toml: leaf_toml,
                all: leaf_all,
                ..
            }) => (*toml || *leaf_toml, *all || *leaf_all),
            _ => (*toml, *all),
        },
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
        | CliCommand::Usage { .. }
        | CliCommand::Completions { .. }
        | CliCommand::Complete { .. }
        | CliCommand::View { .. }
        | CliCommand::Ui { .. } => (false, false),
    }
}

fn segment_row(segment: &serde_json::Value) -> String {
    let index = segment
        .get("index")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let first = segment
        .get("first_message_at")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    let last = segment
        .get("last_message_at")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    let messages = segment
        .get("message_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let excluded = if segment
        .get("excluded")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        " · excluded"
    } else {
        ""
    };
    let label = segment
        .get("label")
        .and_then(serde_json::Value::as_str)
        .map(|value| format!(" · {value}"))
        .unwrap_or_default();
    let note = segment
        .get("note")
        .and_then(serde_json::Value::as_str)
        .map(|value| format!("\n  {value}"))
        .unwrap_or_default();
    format!("#{index}  {first} → {last} · {messages} messages{excluded}{label}{note}")
}

fn render_segments(data: &serde_json::Value) -> String {
    if let Some(segment) = data.get("segment") {
        let mut rendered = segment_row(segment);
        if let Some(messages) = data.get("messages").and_then(serde_json::Value::as_array) {
            for message in messages {
                let role = message
                    .get("role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("?");
                let content = message
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                rendered.push_str(&format!("\n\n{role}: {content}"));
            }
        }
        return rendered;
    }
    data.get("segments")
        .and_then(serde_json::Value::as_array)
        .filter(|segments| !segments.is_empty())
        .map(|segments| {
            segments
                .iter()
                .map(segment_row)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| "No archived conversation segments.".to_owned())
}

fn render_config_reload(data: &serde_json::Value) -> String {
    let path = data
        .get("config_path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("config");
    let mut lines = vec![format!("Configuration reloaded from {path}.")];
    let changed = data
        .get("changed_prompt_files")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect::<Vec<_>>();
    if !changed.is_empty() {
        if data
            .get("prompts_refreshed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            lines.push(format!(
                "Activated updated system prompts: {}.",
                changed.join(", ")
            ));
        } else {
            lines.push(format!(
                "Left updated system prompts inactive: {}. Use `:config reload --yes` after reviewing them.",
                changed.join(", ")
            ));
        }
    }
    let restart = data
        .get("restart_required")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect::<Vec<_>>();
    if !restart.is_empty() {
        lines.push(format!(
            "Daemon restart required for: {}.",
            restart.join(", ")
        ));
    }
    lines.join("\n")
}

fn render_character_info(data: &serde_json::Value) -> String {
    let name = data
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("?");
    let mut lines = vec![format!("Character: {name}")];
    if data
        .get("active")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        lines.push("Active: yes".to_owned());
    }
    for (label, key) in [("Config", "config_dir"), ("Data", "data_dir")] {
        if let Some(value) = data.get(key).and_then(serde_json::Value::as_str) {
            lines.push(format!("{label}: {value}"));
        }
    }
    if let Some(prompts) = data
        .get("prompt_overrides")
        .and_then(serde_json::Value::as_array)
    {
        let names = prompts
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        if !names.is_empty() {
            lines.push(format!("Prompt overrides: {}", names.join(", ")));
        }
    }
    if let Some(preview) = data
        .get("definition_preview")
        .and_then(serde_json::Value::as_str)
        .filter(|preview| !preview.is_empty())
    {
        lines.push(format!("\n{preview}"));
    }
    lines.join("\n")
}

fn render_provider_refresh_all(data: &serde_json::Value) -> String {
    let mut lines = data
        .get("results")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|result| {
            let provider = result
                .get("provider")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            if result
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                let count = result
                    .get("model_count")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                format!("✓ {provider}: {count} models")
            } else {
                let error = result
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown error");
                format!("✗ {provider}: {error}")
            }
        })
        .collect::<Vec<_>>();
    lines.extend(
        data.get("skipped")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .map(|skipped| {
                format!(
                    "– {}: skipped ({})",
                    skipped
                        .get("provider")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("?"),
                    skipped
                        .get("reason")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("no reason reported")
                )
            }),
    );
    if lines.is_empty() {
        "No configured provider catalogs were refreshed.".to_owned()
    } else {
        lines.join("\n")
    }
}

fn render_message(data: &serde_json::Value) -> String {
    let role = data
        .get("role")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("message");
    let message_id = data
        .get("msg_id")
        .or_else(|| data.get("id"))
        .and_then(serde_json::Value::as_str);
    let heading = message_id.map_or_else(
        || role.to_owned(),
        |resolved_id| format!("{role} · {resolved_id}"),
    );
    let content = data
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    format!("{heading}\n{content}").trim_end().to_owned()
}

pub(crate) fn render(
    input: &str,
    wire_name: &str,
    data: &serde_json::Value,
    character: &str,
) -> Option<String> {
    let command = crate::cli::parse_palette_command(input).ok()?;
    if matches!(&command, CliCommand::Config { path: true, .. }) {
        return Some(
            data.get("config_dir")
                .and_then(serde_json::Value::as_str)
                .map_or_else(
                    || shore_common::dirs::config_dir().display().to_string(),
                    str::to_owned,
                ),
        );
    }
    if matches!(
        &command,
        CliCommand::Provider { .. } | CliCommand::Config { .. } | CliCommand::Model { .. }
    ) && let Err(error) = crate::run::validate_registered_output(wire_name, data)
    {
        return Some(format!("Invalid operation result: {error}"));
    }
    let specialized_json = matches!(
        &command,
        CliCommand::Log { json: true, .. } | CliCommand::Status { json: true, .. }
    );
    if crate::run::wants_json(&command) || specialized_json {
        let selected = if let CliCommand::Status {
            section: Some(section),
            ..
        } = &command
        {
            data.get(section).unwrap_or(&serde_json::Value::Null)
        } else {
            data
        };
        let display = selected.clone();
        return Some(json(&display));
    }

    if matches!(&command, CliCommand::Log { content: true, .. }) {
        if let Some(content) = data.get("content").and_then(serde_json::Value::as_str) {
            return Some(content.to_owned());
        }
        let content = data
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|message| message.get("content").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n");
        return Some(content);
    }

    let (toml, show_all) = config_modes(&command);
    if toml {
        return crate::run::render_config_toml(data, show_all).ok();
    }

    match wire_name {
        "status" => {
            let CliCommand::Status { section, .. } = &command else {
                return Some(json(data));
            };
            Some(match section {
                Some(selected_section) => {
                    let rendered = written(|out| {
                        let _ = crate::output::status::write_section(out, data, selected_section);
                    });
                    if rendered.is_empty() {
                        format!("No status section named {selected_section:?} was returned.")
                    } else {
                        rendered
                    }
                }
                None => written(|out| crate::output::status::write_status(out, data, character)),
            })
        }
        "config" => Some(written(|out| {
            crate::output::config::write_config(out, data, show_all);
        })),
        "config_schema" => Some(written(|out| {
            crate::output::config::write_schema(
                out,
                data,
                crate::run::config_keys_filter(&command),
            );
        })),
        "config_check" => Some(written(|out| {
            crate::output::config::write_check(out, data);
        })),
        "tools" => Some(written(|out| crate::output::tools::write_tools(out, data))),
        "compact" => Some(written(|out| {
            crate::output::commands::write_compact_result(out, data, TUI_OUTPUT_WIDTH);
        })),
        "segments" => Some(render_segments(data)),
        "clear" => Some(format!(
            "Archived {} messages into segment #{}.",
            data.get("message_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            data.pointer("/segment/index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
        )),
        "config_reload" => Some(render_config_reload(data)),
        "call_log" => Some(written(|out| {
            crate::output::commands::write_call_log(out, data, TUI_OUTPUT_WIDTH);
        })),
        "transcript" => Some(written(|out| {
            crate::output::commands::write_trace_transcript(out, data, TUI_OUTPUT_WIDTH);
        })),
        "subagent_trace" => Some(written(|out| {
            crate::output::commands::write_subagent_trace(out, data, TUI_OUTPUT_WIDTH);
        })),
        "error_log" => Some(written(|out| {
            crate::output::commands::write_error_log(out, data);
        })),
        "heartbeat_log" => Some(written(|out| {
            crate::output::transcript::write_heartbeat_log(out, data, TUI_OUTPUT_WIDTH);
        })),
        "run_tool" => Some(written(|out| {
            crate::output::commands::write_run_tool(out, data, TUI_OUTPUT_WIDTH);
        })),
        "get" => Some(render_message(data)),
        "character_info" => Some(render_character_info(data)),
        "create_character" => Some(format!(
            "Created character {}.",
            data.get("character")
                .or_else(|| data.get("name"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )),
        "list_models" => None,
        "model_info" => Some(written(|out| {
            crate::output::catalog::write_model_info(out, data);
        })),
        "model_settings" => Some(written(|out| {
            crate::output::catalog::write_model_settings(out, data);
        })),
        "list_providers" => Some(written(|out| {
            crate::output::catalog::write_provider_list(out, data);
        })),
        "list_provider_models" => Some(written(|out| {
            crate::output::catalog::write_provider_models(out, data);
        })),
        "usage" => {
            if matches!(
                data.get("mode").and_then(serde_json::Value::as_str),
                Some("csv" | "tsv")
            ) {
                return data
                    .get("data")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
            }
            crate::run::usage_view(&command).map(|view| {
                written(|out| match view {
                    crate::output::usage::View::Summary => {
                        crate::output::usage::write_summary(out, data)
                    }
                    crate::output::usage::View::By => {
                        crate::output::usage::write_breakdown(out, data)
                    }
                    crate::output::usage::View::Budgets => {
                        crate::output::usage::write_budgets(out, data)
                    }
                    crate::output::usage::View::Cache => {
                        crate::output::usage::write_cache(out, data)
                    }
                    crate::output::usage::View::Anomalies => {
                        crate::output::usage::write_anomalies(out, data)
                    }
                    crate::output::usage::View::Limits => {
                        crate::output::usage::write_limits(out, data)
                    }
                })
            })
        }
        "refresh_provider_models" => Some(format!(
            "Refreshed {}: {} models (fetched {}).",
            data.get("provider")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?"),
            data.get("model_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            data.get("fetched_at")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )),
        "refresh_all_provider_models" => Some(render_provider_refresh_all(data)),
        "heartbeat_tick_now" => Some(format!(
            "Scheduled a heartbeat tick for {}.",
            data.get("character")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )),
        "heartbeat_set_dormant" | "heartbeat_set_active" => Some(format!(
            "Heartbeat forced {} for {}.",
            if wire_name == "heartbeat_set_active" {
                "active"
            } else {
                "dormant"
            },
            data.get("character")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )),
        "session_activate" => Some(format!(
            "{} {}.",
            if data
                .get("registered")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                "Activated"
            } else {
                "Already active"
            },
            data.get("character")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )),
        "keepalive_ping_now" => Some(format!(
            "Keepalive ping for {}: {}.",
            data.get("character")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?"),
            data.get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("completed")
        )),
        "inject_system" => Some("System instruction injected.".to_owned()),
        "edit" => Some(format!(
            "Edited message {}.",
            data.get("msg_id")
                .or_else(|| data.get("id"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?")
        )),
        "log" | "list_characters" | "switch_character" | "switch_model" | "reset_model"
        | "set_model_setting" | "delete" | "list_alternatives" | "alt" => None,
        _ => Some(json(data)),
    }
}

#[cfg(test)]
mod provider_contract_tests {
    use super::render;

    #[test]
    fn provider_palette_rejects_malformed_data_and_keeps_additive_json_fields() {
        let invalid = render(
            "provider",
            "list_providers",
            &serde_json::json!({"providers":[{"name":"incomplete"}]}),
            "ada",
        );
        assert!(invalid.is_some_and(|text| text.starts_with("Invalid operation result:")));
        let data = serde_json::json!({"providers":[],"future":"inspectable"});
        let output = render("provider --json", "list_providers", &data, "ada").unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output).unwrap(),
            data
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::ansi;

    #[test]
    fn status_section_is_selected_in_the_tui_renderer() {
        let rendered = render(
            "status --section daemon",
            "status",
            &serde_json::json!({
                "daemon": { "state": "running" },
                "session": { "turns": 4 }
            }),
            "ada",
        )
        .expect("rendered");
        let text = ansi::plain(&rendered);
        assert!(text.contains("running"));
        assert!(!text.contains("turns"));
    }

    #[test]
    fn config_key_filter_reaches_the_existing_formatter() {
        let rendered = render(
            "config keys cache",
            "config_schema",
            &serde_json::json!({
                "schema": [
                    { "key": "cache.ttl", "type": "duration", "kind": "duration", "settable": true, "optional": false, "restart_required": false, "secret": false, "values": ["1h"] },
                    { "key": "daemon.addr", "type": "string", "kind": "string", "settable": true, "optional": false, "restart_required": true, "secret": false, "values": [] }
                ],
                "sources": {"chat_models":[],"embedding_models":[],"image_models":[],"tools":[],"subagents":[],"characters":[],"providers":[]}
            }),
            "ada",
        )
        .expect("rendered");
        let text = ansi::plain(&rendered);
        assert!(text.contains("cache.ttl"));
        assert!(!text.contains("daemon.addr"));
    }

    #[test]
    fn trace_calls_uses_the_human_formatter_unless_json_was_requested() {
        let data = serde_json::json!({
            "entries": [{
                "id": 7,
                "call_type": "message",
                "provider": "anthropic",
                "model": "claude",
                "duration_ms": 12,
                "request_bytes": 10,
                "response_bytes": 20,
                "usage": {
                    "input_tokens": 3,
                    "output_tokens": 4,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0
                }
            }]
        });
        let rendered = render("trace calls", "call_log", &data, "ada").expect("rendered");
        let text = ansi::plain(&rendered);
        assert!(text.contains("call log"));
        assert!(text.contains("message"));
        assert!(!text.contains("\"entries\""));
    }
}
