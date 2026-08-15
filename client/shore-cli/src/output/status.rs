use std::io::{self, Write};

use serde_json::Value;

use super::vocab::{Rows, Tone, blank, count, empty, section, warning};

fn text<'value>(data: &'value Value, key: &str) -> &'value str {
    data.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(data: &Value, key: &str) -> u64 {
    data.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn session_line(data: &Value) -> String {
    let turns = number(data, "turn_count");
    let tokens = data.get("tokens");
    let spent: u64 = tokens.map_or(0, |t| {
        number(t, "input")
            .saturating_add(number(t, "output"))
            .saturating_add(number(t, "cache_read"))
            .saturating_add(number(t, "cache_write"))
    });
    let turn_word = if turns == 1 { "turn" } else { "turns" };
    if spent == 0 {
        format!("{turns} {turn_word} since the daemon started")
    } else {
        format!(
            "{turns} {turn_word} since the daemon started \u{00b7} {} tokens",
            count(spent)
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
        if model.is_empty() { "(none set)" } else { model },
        if model.is_empty() {
            Tone::Warn
        } else {
            Tone::Plain
        },
    );
    rows.add("session", &session_line(data));

    let config_dir = text(data, "config_dir");
    if !config_dir.is_empty() {
        rows.add("config", config_dir);
    }

    let pending = number(data, "pending_deferred_edit_count");
    if pending > 0 {
        rows.add_toned(
            "pending edits",
            &pending.to_string(),
            Tone::Warn,
        );
    }
    rows.write(out);

    if let Some(halt) = data.get("keepalive_halted").filter(|h| !h.is_null()) {
        blank(out);
        let reason = text(halt, "reason");
        warning(
            out,
            &format!(
                "keepalive halted for {}{}",
                text(halt, "character"),
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(": {reason}")
                }
            ),
        );
    }

    for section_name in sections_of(data) {
        blank(out);
        let _shown = write_section(out, data, &section_name);
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

fn not_started(name: &str) -> &'static str {
    match name {
        "autonomy" => "not started \u{00b7} the heartbeat is scheduled on your first message",
        "activity" => "nothing recorded yet \u{00b7} activity is learned from your messages",
        _ => "not started",
    }
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
    section(out, name, None);
    let Some(map) = value.as_object() else {
        empty(out, "nothing recorded");
        return true;
    };
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
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_status(&mut out, data, character);
}

pub(crate) fn print_section(data: &Value, name: &str) -> bool {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_section(&mut out, data, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;
    use serde_json::json;

    fn render(data: &Value) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_status(&mut buf, data, "");
        String::from_utf8(buf).unwrap_or_default()
    }

    fn payload() -> Value {
        json!({
            "character": "qifei",
            "active_model": "deepseek:deepseek-v4-pro",
            "turn_count": 0,
            "message_count": 0,
            "config_dir": "/config",
            "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
            "pending_deferred_edit_count": 0,
            "keepalive_halted": null,
            "autonomy": null,
            "activity": null,
            "sections": ["tokens", "autonomy", "activity"]
        })
    }

    #[test]
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh status"]
    fn render_preview_status() {
        set_color_enabled(true);
        let fresh = json!({
            "character": "qifei",
            "active_model": "opencode-go:glm-5.3",
            "turn_count": 0, "message_count": 0,
            "config_dir": "/config",
            "tokens": {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0},
            "pending_deferred_edit_count": 0,
            "keepalive_halted": null, "autonomy": null, "activity": null,
            "sections": ["tokens", "autonomy", "activity"]
        });
        let mut buf = Vec::new();
        write_status(&mut buf, &fresh, "");
        set_color_enabled(false);
        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"\n----- STATUS, FRESH DAEMON (shore status) -----\n");
        _ = stdout.write_all(&buf);
        _ = stdout.write_all(b"----- end -----\n");
        _ = stdout.flush();
    }

    #[test]
    fn a_zero_turn_count_says_what_it_is_counting() {
        let out = render(&payload());
        assert!(
            out.contains("since the daemon started"),
            "a bare 0 reads as 'nothing ever happened'; say the window: {out}"
        );
        assert!(
            !out.contains("Turns        0"),
            "the old unqualified label must be gone: {out}"
        );
    }

    #[test]
    fn the_character_names_the_section_rather_than_a_generic_word() {
        let out = render(&payload());
        assert!(out.starts_with("\u{2500}\u{2500} qifei "), "{out}");
    }

    #[test]
    fn a_session_with_traffic_reports_its_tokens() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("turn_count") {
            *slot = json!(3);
        }
        if let Some(slot) = data.pointer_mut("/tokens/input") {
            *slot = json!(8_042);
        }
        let out = render(&data);
        assert!(out.contains("3 turns"), "{out}");
        assert!(out.contains("8.0K tokens"), "{out}");
    }

    #[test]
    fn one_turn_is_not_pluralised() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("turn_count") {
            *slot = json!(1);
        }
        assert!(render(&data).contains("1 turn since"), "{}", render(&data));
    }

    #[test]
    fn a_missing_model_reads_as_a_problem_not_as_blank() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("active_model") {
            *slot = json!("");
        }
        let out = render(&data);
        assert!(out.contains("(none set)"), "{out}");
    }

    #[test]
    fn a_halted_keepalive_is_surfaced_not_buried() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("keepalive_halted") {
            *slot = json!({"character": "qifei", "reason": "budget exhausted"});
        }
        let out = render(&data);
        assert!(out.contains("keepalive halted for qifei"), "{out}");
        assert!(out.contains("budget exhausted"), "{out}");
    }

    #[test]
    fn a_status_section_renders_as_rows_rather_than_json() {
        set_color_enabled(false);
        let data = json!({"autonomy": {"enabled": true, "heartbeat_state": "dormant"}});
        let mut buf = Vec::new();
        assert!(write_section(&mut buf, &data, "autonomy"));
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(!out.contains('{'), "a section must not print raw json: {out}");
        assert!(out.contains("heartbeat"), "{out}");
        assert!(out.contains("dormant"), "{out}");

        let generic = json!({"tokens": {"input": 8042, "output": 12}});
        let mut plain = Vec::new();
        assert!(write_section(&mut plain, &generic, "tokens"));
        let rows = String::from_utf8(plain).unwrap_or_default();
        assert!(!rows.contains('{'), "a section must not print raw json: {rows}");
        assert!(rows.contains("8042"), "{rows}");
    }

    #[test]
    fn a_section_that_has_not_started_says_so_rather_than_vanishing() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        assert!(
            write_section(&mut buf, &payload(), "autonomy"),
            "a section shore knows about must render even when it is empty"
        );
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(out.contains("autonomy"), "{out}");
        assert!(
            out.contains("not started"),
            "an empty section must say why it is empty: {out}"
        );
    }

    #[test]
    fn a_name_that_is_not_a_section_renders_nothing() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        assert!(
            !write_section(&mut buf, &payload(), "not_a_section"),
            "only names the payload carries are sections"
        );
    }

    #[test]
    fn the_default_view_shows_every_section_the_daemon_named() {
        let out = render(&payload());
        for name in ["tokens", "autonomy", "activity"] {
            assert!(
                out.contains(name),
                "{name} is in `sections` but missing from the default view: {out}"
            );
        }
    }

    #[test]
    fn the_hardcoded_memory_mode_is_gone() {
        let out = render(&payload());
        assert!(
            !out.contains("markdown"),
            "memory mode was a constant, not status: {out}"
        );
    }

    #[test]
    fn no_status_line_ships_trailing_whitespace() {
        for line in render(&payload()).lines() {
            assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
        }
    }
}
