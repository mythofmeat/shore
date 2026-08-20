use std::io::{self, Write};

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

fn embedding_models(data: &Value) -> String {
    let mut models: Vec<&str> = data
        .pointer("/index/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if let Some(model) = data.pointer("/history_index/model").and_then(Value::as_str)
        && !models.contains(&model)
    {
        models.push(model);
    }
    models.join(", ")
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
    let embeddings = embedding_models(data);
    if !embeddings.is_empty() {
        rows.add("embedding", &embeddings);
    }
    rows.add("session", &session_line(data));
    if let Some(autonomy) = data.get("autonomy").filter(|value| !value.is_null()) {
        super::autonomy::add_autonomy_rows(&mut rows, autonomy);
    }

    let pending = number(data, "pending_deferred_edit_count");
    if pending > 0 {
        rows.add_toned("pending edits", &pending.to_string(), Tone::Warn);
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

    if let Some(autonomy) = data.get("autonomy").filter(|value| !value.is_null())
        && super::autonomy::has_recent_events(autonomy)
    {
        blank(out);
        super::autonomy::write_autonomy_events(out, autonomy);
    }

    if data.get("index").is_some_and(|value| !value.is_null())
        || data
            .get("history_index")
            .is_some_and(|value| !value.is_null())
    {
        blank(out);
        super::workspace::write_compact_index_section(
            out,
            data.get("index"),
            data.get("history_index"),
        );
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
        "index" => "no workspace configured for this character",
        "history_index" => "no history index for this character",
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
    if name == "index" {
        super::workspace::write_compact_index_section(out, Some(value), data.get("history_index"));
        return true;
    }
    if name == "history_index" {
        super::history::write_history_section(out, value);
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

        set_color_enabled(true);
        let busy = json!({
            "character": "qifei",
            "active_model": "opencode-go:glm-5.3",
            "turn_count": 11, "message_count": 34,
            "config_dir": "/config",
            "tokens": {
                "input": 120_000, "output": 48_000,
                "cache_read": 1_600_000, "cache_write": 32_000
            },
            "pending_deferred_edit_count": 0,
            "keepalive_halted": null, "autonomy": null, "activity": null,
            "sections": ["tokens", "autonomy", "activity"]
        });
        let mut busy_buf = Vec::new();
        write_status(&mut busy_buf, &busy, "");
        set_color_enabled(false);
        _ = stdout.write_all(b"\n----- STATUS, MID CONVERSATION (shore status) -----\n");
        _ = stdout.write_all(&busy_buf);
        _ = stdout.write_all(b"----- end -----\n");
        _ = stdout.flush();
    }

    #[test]
    fn a_zero_turn_count_says_what_it_is_counting() {
        let out = render(&payload());
        assert!(
            out.contains("0 turns in history"),
            "a bare 0 reads as 'nothing ever happened'; say the window: {out}"
        );
        assert!(
            !out.contains("Turns        0"),
            "the old unqualified label must be gone: {out}"
        );
    }

    #[test]
    fn turns_count_the_conversation_not_the_daemon_uptime() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("turn_count") {
            *slot = json!(11);
        }
        let out = render(&data);
        assert!(
            out.contains("11 turns in history"),
            "turn_count is user turns in the stored conversation, which outlives a restart: {out}"
        );
        assert!(
            !out.contains("turns since the daemon started"),
            "the turn count is not a daemon-uptime figure: {out}"
        );
    }

    #[test]
    fn both_halves_of_the_session_line_share_one_window() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("turn_count") {
            *slot = json!(11);
        }
        if let Some(slot) = data.get_mut("tokens") {
            *slot = json!({
                "input": 1_000_000, "output": 500_000,
                "cache_read": 300_000, "cache_write": 0
            });
        }
        let legacy_out = render(&data);
        assert!(
            !legacy_out.contains("1.8M"),
            "an older daemon's cumulative counters must not masquerade as context: {legacy_out}"
        );
        if let Some(map) = data.as_object_mut() {
            drop(map.insert("context_tokens".to_owned(), json!(23_400)));
        }
        let out = render(&data);
        assert!(
            out.contains("11 turns \u{00b7} 23.4K tokens in history"),
            "the session must report active history, not cumulative model traffic: {out}"
        );
        assert!(
            !out.contains("1.8M"),
            "cache reads and earlier calls must not inflate current context: {out}"
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
        if let Some(map) = data.as_object_mut() {
            drop(map.insert("context_tokens".to_owned(), json!(8_042)));
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
        assert!(
            render(&data).contains("1 turn in history"),
            "{}",
            render(&data)
        );
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
        assert!(
            !out.contains('{'),
            "a section must not print raw json: {out}"
        );
        assert!(out.contains("heartbeat"), "{out}");
        assert!(out.contains("dormant"), "{out}");

        let generic = json!({"tokens": {"input": 8042, "output": 12}});
        let mut plain = Vec::new();
        assert!(write_section(&mut plain, &generic, "tokens"));
        let rows = String::from_utf8(plain).unwrap_or_default();
        assert!(
            !rows.contains('{'),
            "a section must not print raw json: {rows}"
        );
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
    fn a_table_of_counters_that_are_all_zero_says_zero_once() {
        set_color_enabled(false);
        let mut buf = Vec::new();
        assert!(write_section(&mut buf, &payload(), "tokens"));
        let out = String::from_utf8(buf).unwrap_or_default();
        let zeros = out.matches('0').count();
        assert_eq!(zeros, 1, "four zeros say no more than one does: {out}");
        assert!(!out.contains("cache read"), "{out}");
    }

    #[test]
    fn a_counter_that_moved_still_shows_the_breakdown() {
        set_color_enabled(false);
        let mut data = payload();
        if let Some(slot) = data.pointer_mut("/tokens/input") {
            *slot = json!(1024);
        }
        let mut buf = Vec::new();
        assert!(write_section(&mut buf, &data, "tokens"));
        let out = String::from_utf8(buf).unwrap_or_default();
        assert!(out.contains("input"), "{out}");
        assert!(out.contains("1024"), "{out}");
        assert!(
            out.contains("cache read"),
            "the breakdown must survive one non-zero counter: {out}"
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
    fn the_default_view_omits_analytics_sections() {
        let out = render(&payload());
        for name in ["tokens", "autonomy", "activity"] {
            assert!(
                !out.contains(&format!("\u{2500}\u{2500} {name} ")),
                "{name} is diagnostic/analytics detail, not status dashboard content: {out}"
            );
        }
    }

    #[test]
    fn the_dashboard_consolidates_live_status() {
        let data = json!({
            "character": "qifei",
            "active_model": "zai:glm-5.3",
            "turn_count": 5,
            "context_tokens": 23_400,
            "tokens": {"input": 288_106, "output": 71_483, "cache_read": 1_131_904, "cache_write": 0},
            "config_dir": "/config",
            "pending_deferred_edit_count": 0,
            "keepalive_halted": null,
            "autonomy": {
                "heartbeat_state": "Active",
                "ticks_without_user": 1,
                "dormant_after_heartbeat_turns": 3,
                "seconds_since_user": 11_400,
                "last_user_at": "2026-08-20T04:06:00+00:00",
                "seconds_until_wake": 17_340,
                "next_wake_at": "2026-08-20T12:06:00+00:00",
                "recent_events": [
                    {"timestamp": "2026-08-20T07:10:00+00:00", "kind": "tool_use", "detail": "Tool: edit"},
                    {"timestamp": "2026-08-20T07:11:00+00:00", "kind": "message_sent", "detail": "Autonomous message sent"}
                ]
            },
            "index": {
                "embedded": 1702,
                "pending": 0,
                "models": ["qwen/qwen3-embedding-8b"],
                "bytes": 29_779_558,
                "last_indexed_at": "2026-08-20T07:11:00+00:00"
            },
            "history_index": {
                "messages": 36_684,
                "pending": 0,
                "model": "qwen/qwen3-embedding-8b"
            },
            "sections": ["tokens", "autonomy", "activity", "index", "history_index"]
        });
        let out = render(&data);
        for wanted in [
            "5 turns \u{00b7} 23.4K tokens in history",
            "last active",
            "next heartbeat",
            "2/3 remaining",
            "Autonomous message sent",
            "1702 files \u{00b7} 36684 messages",
            "(up to date)",
            "qwen/qwen3-embedding-8b",
        ] {
            assert!(out.contains(wanted), "missing {wanted:?}: {out}");
        }
        for unwanted in [
            "/config",
            "1.5M",
            "Tool: edit",
            "files seen",
            "vectors",
            "engagement",
        ] {
            assert!(!out.contains(unwanted), "unexpected {unwanted:?}: {out}");
        }
        assert!(
            !out.contains("\n\n\n"),
            "dashboard has excess vertical whitespace: {out}"
        );
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
