use crate::cli::{CliCommand, ConfigCommand};

const TUI_OUTPUT_WIDTH: usize = 80;
const PAGER_FRAME_AND_MARGIN: usize = 8;

fn pager_width(terminal: usize) -> usize {
    TUI_OUTPUT_WIDTH.min(terminal.saturating_sub(PAGER_FRAME_AND_MARGIN))
}

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
        | CliCommand::Diary { .. }
        | CliCommand::Dream { .. }
        | CliCommand::Presence { .. }
        | CliCommand::Completions { .. }
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
    let turns = crate::output::turns(
        segment
            .get("turn_count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    );
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
    format!("#{index}  {first} → {last} · {turns}{excluded}{label}{note}")
}

fn render_segments(data: &serde_json::Value) -> String {
    if let Some(found) = crate::output::commands::found_messages(data) {
        return crate::output::commands::found_message_lines(&found).join("\n");
    }
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
    if let Err(error) = crate::run::validate_registered_output(wire_name, data) {
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
        "compact_watch" | "compact_cancel" => Some(written(|out| {
            crate::output::compaction::write_watch_result(out, data, TUI_OUTPUT_WIDTH);
        })),
        "segments" => Some(render_segments(data)),
        "clear" => Some(crate::output::commands::cleared(data)),
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
        "provider_detail" => Some(written(|out| {
            crate::output::catalog::write_provider_detail(out, data);
        })),
        "provider_presets" => Some(written(|out| {
            crate::output::catalog::write_provider_presets(out, data);
        })),
        "add_provider"
        | "update_provider"
        | "add_credential"
        | "update_credential"
        | "remove_credential"
        | "order_credentials"
        | "select_credential"
        | "set_credential_limit"
        | "finish_sign_in" => Some(written(|out| {
            crate::output::catalog::write_provider_changed(out, data);
        })),
        "start_sign_in" => Some(written(|out| {
            crate::output::catalog::write_sign_in_started(out, data);
        })),
        "cancel_sign_in" => Some(written(|out| {
            crate::output::catalog::write_sign_in_cancelled(out, data);
        })),
        "remove_provider" => Some(written(|out| {
            crate::output::catalog::write_provider_removed(out, data);
        })),
        "test_credential" => Some(written(|out| {
            crate::output::catalog::write_credential_tested(out, data);
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
        "dream" => Some(crate::output::commands::dream_report_text(data)),
        "diary" => Some(written(|out| {
            crate::output::diary::write_diary(out, data, pager_width(crate::output::term_width()));
        })),
        "presence" => Some(crate::output::commands::presence_text(data)),
        "mark" | "unmark" | "marks" => Some(crate::output::commands::marks_text(wire_name, data)),
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
        "set_model_setting" => data
            .get("warning")
            .and_then(serde_json::Value::as_str)
            .map(|warning| format!("Warning: {warning}.")),
        "delete" | "alt" => data.get("workspace").and_then(workspace_note),
        "log" | "list_characters" | "switch_character" | "switch_model" | "reset_model"
        | "list_alternatives" => None,
        _ => Some(json(data)),
    }
}

fn workspace_note(rewind: &serde_json::Value) -> Option<String> {
    if rewind.get("kept").and_then(serde_json::Value::as_str) == Some("later_turns") {
        return Some("Workspace files kept: later turns build on this one.".to_owned());
    }
    let paths = |key: &str| -> Vec<String> {
        rewind
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let files = |count: usize| {
        format!(
            "{count} workspace file{}",
            if count == 1 { "" } else { "s" }
        )
    };
    let restored = paths("restored");
    let skipped = paths("skipped");
    let restored_note =
        (!restored.is_empty()).then(|| format!("Restored {}", files(restored.len())));
    if skipped.is_empty() {
        return restored_note.map(|note| format!("{note}."));
    }
    let left = format!(
        "{} changed since and {} left as is: {}",
        files(skipped.len()),
        if skipped.len() == 1 { "was" } else { "were" },
        skipped.join(", ")
    );
    Some(match restored_note {
        Some(note) => format!("{note}; {left}."),
        None => format!("{left}."),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn config_asked_for_as_toml_is_shown_as_toml_with_defaults_left_out_unless_all_is_asked_for() {
        let data = json!({
            "config": { "chat": { "model": "anthropic:fixture", "display_name": "eve" } },
            "defaults": { "chat": { "display_name": "eve" } }
        });
        let changed = crate::run::render_config_toml(&data, false).ok();
        let all = crate::run::render_config_toml(&data, true).ok();
        assert!(
            changed
                .as_deref()
                .is_some_and(|toml| toml.contains("model"))
        );
        assert_ne!(changed, all);
        assert_eq!(
            super::render("config --toml", "config", &data, "ada"),
            changed
        );
        assert_eq!(
            super::render("config --toml --all", "config", &data, "ada"),
            all
        );
        assert_ne!(super::render("config", "config", &data, "ada"), changed);
        assert_ne!(super::render("config --all", "config", &data, "ada"), all);
    }

    #[test]
    fn the_diary_is_wrapped_to_fit_inside_the_pager_however_narrow_the_terminal() {
        assert_eq!(super::pager_width(200), 80);
        assert_eq!(super::pager_width(88), 80);
        assert_eq!(super::pager_width(87), 79);
        assert_eq!(super::pager_width(62), 54);
        for terminal in 12_u16..=120 {
            let (popup, _viewport) = crate::tui::ui::output_pager_layout(
                ratatui::layout::Rect::new(0, 0, terminal, 24),
                10,
            );
            let inside = usize::from(popup.width).saturating_sub(2);
            assert!(
                super::pager_width(usize::from(terminal)) < inside,
                "a {terminal}-column terminal"
            );
        }

        crate::output::set_color_enabled(false);
        let long = ["lamps"; 13].join(" ");
        let data = json!({ "character": "ada", "kept": 2, "notes": [
            { "at": "dawn", "thread": "main", "source": "note", "text": "Ferry times.", "shown": false, "dreamed": false },
            { "at": "noon", "thread": "heartbeat", "source": "heartbeat", "text": long, "shown": true, "dreamed": true },
        ] });
        assert_eq!(
            super::render("diary -n 5", "diary", &data, "ada"),
            Some(
                [
                    format!(
                        "\u{2500}\u{2500} diary (ada, 2 notes) {}",
                        "\u{2500}".repeat(48)
                    )
                    .as_str(),
                    "",
                    "  dawn            note in \"main\"  \u{00b7} no longer shown to ada",
                    "    Ferry times.",
                    "",
                    "  noon            heartbeat  \u{00b7} dreamed",
                    "    lamps lamps lamps lamps lamps lamps lamps lamps lamps lamps lamps",
                    "    lamps lamps",
                ]
                .join("\n")
            )
        );
    }

    fn segment(index: u64, turns: u64, overrides: &serde_json::Value) -> serde_json::Value {
        let mut summary = json!({
            "index": index, "first_message_at": "Nov 1", "last_message_at": "Nov 2", "compacted_at": "Nov 3",
            "turn_count": turns, "excluded": false, "label": null, "note": null, "memory_before": null, "memory_after": null,
        });
        if let (Some(fields), Some(changed)) = (summary.as_object_mut(), overrides.as_object()) {
            fields.extend(changed.clone());
        }
        summary
    }

    #[test]
    fn segments_and_what_a_clear_left_are_told_in_turns() {
        let listing = json!({ "character": "ada", "thread": "main", "count": 2, "segments": [
            segment(0, 1, &json!({})),
            segment(1, 30, &json!({ "excluded": true, "label": "the storm", "note": "rough seas" })),
        ] });
        assert_eq!(
            super::render("segments", "segments", &listing, "ada"),
            Some(
                [
                    "#0  Nov 1 → Nov 2 · 1 turn",
                    "#1  Nov 1 → Nov 2 · 30 turns · excluded · the storm",
                    "  rough seas",
                ]
                .join("\n")
            )
        );
        let cleared = json!({ "status": "clear", "character": "ada", "thread": "main", "segment": segment(3, 30, &json!({})) });
        assert_eq!(
            super::render("clear", "clear", &cleared, "ada"),
            Some("Cleared 30 turns into segment #3.".to_owned())
        );
    }

    #[test]
    fn marks_read_as_what_was_liked_or_disliked_and_why() {
        let listing = json!({
            "tags": ["too long", "repetitive"],
            "replies": [{ "ref": "m_1", "attempts": [
                { "position": 1, "shown": false, "attempt": "at_1", "asked": "first", "marks": [
                    { "kind": "dislike", "phrase": null, "reason": "flat", "tags": ["too long"], "at": "now" },
                    { "kind": "like", "phrase": "the sea", "reason": null, "tags": [], "at": "now" },
                ] },
                { "position": 2, "shown": true, "attempt": "at_2", "asked": "with_reason", "marks": [] },
                { "position": 3, "shown": false, "attempt": null, "asked": null, "marks": [] },
                { "position": 4, "shown": false, "attempt": "at_4", "asked": "another_take", "marks": [] },
                { "position": 5, "shown": false, "attempt": "at_5", "asked": "reroll", "marks": [] },
            ] }],
        });
        assert_eq!(
            super::render("msg marks", "marks", &listing, "ada"),
            Some(
                [
                    "m_1",
                    "  1. first:",
                    "     disliked: too long; flat",
                    "     liked \"the sea\"",
                    "  2. shown, with a reason: no marks",
                    "  3.: no marks",
                    "  4. another take: no marks",
                    "  5. reroll: no marks",
                    "Reason tags: too long, repetitive.",
                ]
                .join("\n")
            )
        );
        assert_eq!(
            super::render(
                "msg marks",
                "marks",
                &json!({ "tags": [], "replies": [] }),
                "ada"
            ),
            Some("No reason tags are set in marks.tags.".to_owned())
        );
        let changed = json!({ "ref": "m_1", "position": 2, "attempt": "at_2", "changed": true, "marks": [
            { "kind": "like", "phrase": null, "reason": "warm", "tags": [], "at": "now" },
            { "kind": "dislike", "phrase": "the sea", "reason": null, "tags": ["repetitive"], "at": "now" },
        ] });
        assert_eq!(
            super::render("msg like", "mark", &changed, "ada"),
            Some("Attempt 2 of m_1: liked: warm; disliked \"the sea\": repetitive.".to_owned())
        );
        let cleared =
            json!({ "ref": "m_1", "position": 1, "attempt": "at_1", "changed": true, "marks": [] });
        assert_eq!(
            super::render("msg unmark", "unmark", &cleared, "ada"),
            Some("Attempt 1 of m_1 has no marks now.".to_owned())
        );
        assert_eq!(
            crate::output::commands::marks_text("marks", &json!({ "replies": 3 })),
            "The daemon sent marks this client can't read."
        );
        assert_eq!(
            crate::output::commands::marks_text("mark", &json!({})),
            "The daemon sent a mark this client can't read."
        );
    }

    #[test]
    fn the_palette_shows_a_status_in_the_same_words_as_the_command_line() {
        assert_eq!(
            super::render(
                "presence asleep",
                "presence",
                &json!({ "status": "asleep", "set_at": "just now", "choices": ["asleep"] }),
                "ada"
            ),
            Some("Your status is \"asleep\", set just now.".to_owned())
        );
        assert_eq!(
            super::render(
                "presence --clear",
                "presence",
                &json!({ "choices": ["asleep", "busy"] }),
                "ada"
            ),
            Some("You have no status set. You can set one of: asleep, busy.".to_owned())
        );
    }
}
