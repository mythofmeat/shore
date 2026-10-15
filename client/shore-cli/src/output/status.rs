use std::io::Write;

use serde_json::Value;

use super::vocab::{Rows, Tone, blank, count, empty, note, section, warning};

fn text<'value>(data: &'value Value, key: &str) -> &'value str {
    data.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(data: &Value, key: &str) -> u64 {
    data.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn session_line(data: &Value) -> String {
    let turns = number(data, "turn_count");
    let context = data
        .get("context_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let turn_word = if turns == 1 { "turn" } else { "turns" };
    if context == 0 {
        format!("{turns} {turn_word} in history")
    } else {
        format!(
            "{turns} {turn_word} \u{00b7} {} tokens in history",
            count(context)
        )
    }
}

pub(crate) fn write_status<W: Write>(out: &mut W, data: &Value, character: &str) {
    let name = if character.is_empty() {
        text(data, "character")
    } else {
        character
    };
    section(out, name, None);

    let mut rows = Rows::new();
    let model = text(data, "active_model");
    rows.add_toned(
        "model",
        if model.is_empty() {
            "(none set)"
        } else {
            model
        },
        if model.is_empty() {
            Tone::Warn
        } else {
            Tone::Plain
        },
    );
    rows.add("session", &session_line(data));
    if let Some(autonomy) = data.get("autonomy").filter(|value| !value.is_null()) {
        super::autonomy::add_autonomy_rows(&mut rows, autonomy);
    }

    let pending = number(data, "pending_deferred_edit_count");
    if pending > 0 {
        rows.add_toned("pending edits", &pending.to_string(), Tone::Warn);
    }
    if let Some((line, tone)) = data
        .get("compaction")
        .and_then(|compaction| super::compaction::status_row(compaction, chrono::Local::now()))
    {
        rows.add_toned("compaction", &line, tone);
    }
    if let Some(running) = data.get("running").filter(|value| !value.is_null()) {
        let (line, tone) = super::running::status_row(running);
        rows.add_toned("running", &line, tone);
    }
    if let Some(mcp) = data.get("mcp") {
        let configured = number(mcp, "configured");
        let connected = number(mcp, "connected");
        let unavailable = number(mcp, "unavailable");
        if configured > 0 {
            let summary = if unavailable == 0 {
                format!("{connected}/{configured} servers connected")
            } else {
                format!("{connected}/{configured} connected · {unavailable} unavailable")
            };
            rows.add_toned(
                "mcp",
                &summary,
                if unavailable == 0 {
                    Tone::Plain
                } else {
                    Tone::Warn
                },
            );
        }
    }
    rows.write(out);

    let halts = data
        .get("keepalive_halts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if !halts.is_empty() {
        blank(out);
    }
    for halt in halts {
        let reason = text(halt, "reason");
        warning(
            out,
            &format!(
                "keepalive halted for {}{}",
                match text(halt, "model") {
                    "" => text(halt, "character").to_owned(),
                    halted => format!("{halted} on {}", text(halt, "character")),
                },
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(": {reason}")
                }
            ),
        );
    }

    if let Some(autonomy) = data.get("autonomy").filter(|value| !value.is_null())
        && super::autonomy::has_recent_events(autonomy)
    {
        blank(out);
        super::autonomy::write_autonomy_events(out, autonomy);
    }

    if let Some(index) = data.get("history_index").filter(|value| !value.is_null()) {
        blank(out);
        super::history::write_history_section(out, index);
    }
}

pub(crate) fn sections_of(data: &Value) -> Vec<String> {
    data.get("sections")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn all_zero(map: &serde_json::Map<String, Value>) -> bool {
    !map.is_empty()
        && map
            .values()
            .all(|v| v.as_u64().is_some_and(|n| n == 0) || v.as_i64().is_some_and(|n| n == 0))
}

fn not_started(name: &str) -> &'static str {
    match name {
        "autonomy" => "not started \u{00b7} the heartbeat is scheduled on your first message",
        "activity" => "nothing recorded yet \u{00b7} activity is learned from your messages",
        "history_index" => "no history index for this character",
        "mcp" => "no MCP servers configured",
        _ => "not started",
    }
}

fn write_mcp_section<W: Write>(out: &mut W, value: &Value) {
    section(out, "mcp", None);
    let Some(servers) = value.get("servers").and_then(Value::as_array) else {
        empty(out, "no MCP servers configured");
        return;
    };
    if servers.is_empty() {
        empty(out, "no MCP servers configured");
        return;
    }
    let mut rows = Rows::new();
    for server in servers {
        let name = text(server, "name");
        let state = text(server, "state");
        let transport = text(server, "transport");
        let tools = number(server, "connected_tools");
        let mut detail = if transport.is_empty() {
            state.to_owned()
        } else {
            format!("{state} · {transport}")
        };
        if state == "connected" {
            detail.push_str(&format!(" · {tools} tools"));
        }
        if let Some(next) = server.get("next_retry_at").and_then(Value::as_str) {
            detail.push_str(&format!(" · retry {next}"));
        }
        if let Some(error) = server.get("last_error").and_then(Value::as_str) {
            detail.push_str(&format!(" · {error}"));
        }
        rows.add_toned(
            name,
            &detail,
            if state == "connected" {
                Tone::Plain
            } else {
                Tone::Warn
            },
        );
    }
    rows.write(out);
}

pub(crate) fn write_section<W: Write>(out: &mut W, data: &Value, name: &str) -> bool {
    let Some(raw) = data.get(name) else {
        return false;
    };
    if raw.is_null() {
        section(out, name, None);
        empty(out, not_started(name));
        return true;
    }
    let value = raw;
    if name == "activity" {
        super::autonomy::write_activity_section(out, value, super::term_width());
        return true;
    }
    if name == "autonomy" {
        super::autonomy::write_autonomy_section(out, value, super::term_width());
        return true;
    }
    if name == "history_index" {
        super::history::write_history_section(out, value);
        return true;
    }
    if name == "mcp" {
        write_mcp_section(out, value);
        return true;
    }
    if name == "compaction" {
        super::compaction::write_status_section(out, value, chrono::Local::now());
        return true;
    }
    if name == "running" {
        super::running::write_status_section(out, value);
        return true;
    }
    section(out, name, None);
    let Some(map) = value.as_object() else {
        empty(out, "nothing recorded");
        return true;
    };
    if all_zero(map) {
        note(out, "0");
        return true;
    }
    let mut rows = Rows::new();
    for (key, entry) in map {
        let display = match entry {
            Value::Null => "(none)".to_owned(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            Value::Array(items) => format!("{} entries", items.len()),
            Value::Object(_) => "(table)".to_owned(),
        };
        rows.add(&key.replace('_', " "), &display);
    }
    if rows.is_empty() {
        empty(out, "nothing recorded");
    } else {
        rows.write(out);
    }
    true
}

pub(crate) fn print(data: &Value, character: &str) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_status(&mut out, data, character);
}

pub(crate) fn print_section(data: &Value, name: &str) -> bool {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_section(&mut out, data, name)
}
