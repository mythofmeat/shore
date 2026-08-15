use std::io::{self, Write};

use serde_json::{Map, Value};

use super::vocab::{Rows, Tone, blank, empty, key_line, note, section, warning};

const SECRET_KEYS: &[&str] = &[
    "api_key",
    "apikey",
    "key",
    "token",
    "secret",
    "password",
    "authorization",
];

const LONG_VALUE_LINES: usize = 2;
const LONG_VALUE_CHARS: usize = 160;

fn is_secret(path: &[String], key: &str) -> bool {
    if path.iter().any(|p| p == "headers") {
        return true;
    }
    let lowered = key.to_ascii_lowercase();
    SECRET_KEYS.iter().any(|s| lowered == *s || lowered.ends_with(&format!("_{s}")))
}

fn redacted(value: &Value) -> String {
    let empty_value = match value {
        Value::String(s) => s.is_empty(),
        Value::Null => true,
        Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => false,
    };
    if empty_value {
        "(unset)".to_owned()
    } else {
        "(set, hidden)".to_owned()
    }
}

fn scalar(value: &Value) -> String {
    match value {
        Value::Null => "(none)".to_owned(),
        Value::String(s) if s.is_empty() => "(empty)".to_owned(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => {
            if items.is_empty() {
                "(none)".to_owned()
            } else {
                items
                    .iter()
                    .map(scalar)
                    .collect::<Vec<String>>()
                    .join(", ")
            }
        }
        Value::Object(_) => "(table)".to_owned(),
    }
}

fn is_long_text(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let lines = text.lines().count();
    if lines > LONG_VALUE_LINES {
        return Some(format!("({lines} lines)"));
    }
    let chars = text.chars().count();
    if chars > LONG_VALUE_CHARS {
        return Some(format!("({chars} chars)"));
    }
    None
}

fn is_scalar(value: &Value) -> bool {
    match value {
        Value::Object(_) => false,
        Value::Array(items) => !items.iter().any(Value::is_object),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => true,
    }
}

fn differs(value: &Value, default: Option<&Value>) -> bool {
    default.is_none_or(|d| d != value)
}

fn has_interesting(value: &Value, default: Option<&Value>, show_all: bool) -> bool {
    if show_all {
        return true;
    }
    match value {
        Value::Object(map) => map.iter().any(|(k, v)| {
            has_interesting(v, default.and_then(|d| d.get(k)), show_all)
        }),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {
            differs(value, default)
        }
    }
}

fn write_tree<W: Write>(
    out: &mut W,
    map: &Map<String, Value>,
    defaults: Option<&Value>,
    depth: usize,
    show_all: bool,
    path: &mut Vec<String>,
) {
    let mut rows = Rows::at_depth(depth);
    for (key, value) in map {
        if !is_scalar(value) {
            continue;
        }
        let default = defaults.and_then(|d| d.get(key));
        if !show_all && !differs(value, default) {
            continue;
        }
        let display = if is_secret(path, key) {
            redacted(value)
        } else if let Some(summary) = is_long_text(value) {
            summary
        } else {
            scalar(value)
        };
        let tone = if is_secret(path, key) {
            Tone::Muted
        } else {
            Tone::Plain
        };
        rows.add_toned(key, &display, tone);
    }
    if !rows.is_empty() {
        rows.write(out);
    }

    for (key, value) in map {
        if is_scalar(value) {
            continue;
        }
        let default = defaults.and_then(|d| d.get(key));
        if !has_interesting(value, default, show_all) {
            continue;
        }
        path.push(key.clone());
        key_line(out, depth, key);
        match value {
            Value::Object(child) => {
                write_tree(out, child, default, depth.saturating_add(1), show_all, path);
            }
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    if let Some(child) = item.as_object() {
                        key_line(out, depth.saturating_add(1), &format!("[{i}]"));
                        write_tree(out, child, None, depth.saturating_add(2), show_all, path);
                    }
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
        let _popped = path.pop();
    }
}

fn any_secret(map: &Map<String, Value>, path: &mut Vec<String>) -> bool {
    for (key, value) in map {
        if is_scalar(value) {
            if is_secret(path, key) {
                return true;
            }
            continue;
        }
        if let Some(child) = value.as_object() {
            path.push(key.clone());
            let found = any_secret(child, path);
            let _popped = path.pop();
            if found {
                return true;
            }
        }
    }
    false
}

fn write_leaf<W: Write>(out: &mut W, scoped: Option<&str>, value: &Value) {
    let Some(mut segments) = scoped.map(|key| {
        key.split('.').map(str::to_owned).collect::<Vec<String>>()
    }) else {
        empty(out, "nothing configured");
        return;
    };
    let Some(leaf) = segments.pop() else {
        empty(out, "nothing configured");
        return;
    };
    let secret = is_secret(&segments, &leaf);
    let display = if secret {
        redacted(value)
    } else if let Some(summary) = is_long_text(value) {
        summary
    } else {
        scalar(value)
    };
    let mut rows = Rows::new();
    rows.add_toned(
        &leaf,
        &display,
        if secret { Tone::Muted } else { Tone::Plain },
    );
    rows.write(out);
    if secret {
        blank(out);
        note(out, "secrets hidden \u{00b7} --json to read them");
    }
}

pub(crate) fn write_config<W: Write>(out: &mut W, data: &Value, show_all: bool) {
    if let Some(key) = data.get("set").and_then(Value::as_str) {
        section(out, "config set", None);
        let mut rows = Rows::new();
        let value = data.get("value").unwrap_or(&Value::Null);
        rows.add(key, &scalar(value));
        rows.write(out);
        return;
    }

    let scoped = data.get("key").and_then(Value::as_str);
    section(out, "config", scoped);
    let value = data.get("config").unwrap_or(&Value::Null);
    let Some(config) = value.as_object() else {
        write_leaf(out, scoped, value);
        return;
    };
    let mut path: Vec<String> = Vec::new();
    write_tree(out, config, data.get("defaults"), 0, show_all, &mut path);

    let mut probe: Vec<String> = Vec::new();
    if any_secret(config, &mut probe) {
        blank(out);
        note(out, "secrets hidden \u{00b7} --json to read them");
    }
    if !show_all && scoped.is_none() {
        note(out, "showing what differs from defaults \u{00b7} -a for everything");
    }
}

pub(crate) fn write_check<W: Write>(out: &mut W, data: &Value) {
    section(out, "config check", None);
    let mut rows = Rows::new();
    for (label, key) in [("config dir", "config_dir"), ("data dir", "data_dir")] {
        if let Some(value) = data.get(key).and_then(Value::as_str) {
            rows.add(label, value);
        }
    }
    let chat = data.get("chat_models").and_then(Value::as_u64).unwrap_or(0);
    let providers = data.get("providers").and_then(Value::as_u64).unwrap_or(0);
    let source = if chat > 0 {
        format!("{chat} configured")
    } else if providers > 0 {
        format!("from {providers} provider(s) by discovery")
    } else {
        "none".to_owned()
    };
    rows.add("models", &source);
    if !rows.is_empty() {
        rows.write(out);
    }

    let warnings: Vec<&str> = data
        .get("warnings")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if warnings.is_empty() {
        blank(out);
        note(out, "no problems found");
        return;
    }
    blank(out);
    for text in warnings {
        warning(out, text);
    }
}

pub(crate) fn print(data: &Value, show_all: bool) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_config(&mut out, data, show_all);
}

pub(crate) fn print_check(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_check(&mut out, data);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;
    use serde_json::json;

    fn render(data: &Value, show_all: bool) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_config(&mut buf, data, show_all);
        String::from_utf8(buf).unwrap_or_default()
    }

    fn payload() -> Value {
        json!({
            "config": {
                "mcp": {
                    "whoop": {
                        "url": "http://mcp-whoop:3000/mcp",
                        "headers": {"Authorization": "Bearer c78911b4d4502e957cbee6546"}
                    }
                },
                "subagents": {
                    "memory": {
                        "description": "Search the archive",
                        "prompt": "You are {{char}}.\nline two\nline three\nline four"
                    }
                },
                "defaults": {"display_name": "ren"}
            },
            "defaults": {}
        })
    }

    #[test]
    fn a_bearer_token_never_reaches_the_screen() {
        let out = render(&payload(), true);
        assert!(
            !out.contains("c78911b4"),
            "an mcp header is a credential and must not be printed: {out}"
        );
        assert!(out.contains("(set, hidden)"), "{out}");
        assert!(out.contains("--json to read them"), "{out}");
    }

    #[test]
    fn a_secret_that_is_not_set_reads_differently_from_one_that_is() {
        let mut data = payload();
        if let Some(slot) = data.pointer_mut("/config/mcp/whoop/headers/Authorization") {
            *slot = json!("");
        }
        let out = render(&data, true);
        assert!(out.contains("(unset)"), "{out}");
        assert!(!out.contains("(set, hidden)"), "{out}");
    }

    #[test]
    fn a_long_prompt_is_summarised_instead_of_dumped() {
        let out = render(&payload(), true);
        assert!(
            !out.contains("line three"),
            "a prompt body must not be inlined into the config tree: {out}"
        );
        assert!(out.contains("(4 lines)"), "{out}");
    }

    #[test]
    fn a_single_line_wall_of_text_is_summarised_too() {
        let mut data = payload();
        if let Some(slot) = data.pointer_mut("/config/subagents/memory/description") {
            *slot = json!("x".repeat(400));
        }
        let out = render(&data, true);
        assert!(out.contains("(400 chars)"), "{out}");
        assert!(!out.contains(&"x".repeat(200)), "{out}");
    }

    #[test]
    fn a_short_string_is_still_shown_in_full() {
        let out = render(&payload(), true);
        assert!(out.contains("Search the archive"), "{out}");
        assert!(out.contains("http://mcp-whoop:3000/mcp"), "{out}");
    }

    #[test]
    fn nesting_is_indented_so_the_tree_survives_long_values() {
        let out = render(&payload(), true);
        let url_line = out
            .lines()
            .find(|l| l.contains("mcp-whoop"))
            .unwrap_or_default();
        let mcp_line = out
            .lines()
            .find(|l| l.trim() == "mcp:")
            .unwrap_or_default();
        let depth_of = |l: &str| l.len().saturating_sub(l.trim_start().len());
        assert!(
            depth_of(url_line) > depth_of(mcp_line),
            "a value must sit deeper than the key that owns it: {out}"
        );
    }

    #[test]
    fn the_default_view_says_it_is_filtered() {
        let out = render(&payload(), false);
        assert!(
            out.contains("-a for everything"),
            "a filtered view must say it is filtered: {out}"
        );
    }

    #[test]
    fn reading_one_key_prints_its_value_not_an_empty_notice() {
        let data = json!({
            "key": "tools.enabled_tools",
            "config": ["read", "edit", "git"],
            "defaults": []
        });
        let out = render(&data, false);
        assert!(
            out.contains("read, edit, git"),
            "a leaf read must show the value it was asked for: {out}"
        );
        assert!(
            !out.contains("nothing configured"),
            "a key that has a value must not read as unset: {out}"
        );
    }

    #[test]
    fn a_leaf_value_is_labelled_the_way_the_tree_labels_it() {
        let data = json!({"key": "memory.compaction.min_turns", "config": 10});
        let out = render(&data, false);
        let row = out
            .lines()
            .find(|l| l.contains("min_turns") && !l.contains("config \u{00b7}"))
            .unwrap_or_default();
        assert!(
            row.contains("min_turns") && row.contains("10"),
            "the row must carry the leaf name and its value: {out}"
        );
        assert!(
            !row.contains("memory.compaction.min_turns"),
            "the dotted path belongs in the header, not the row: {out}"
        );
    }

    #[test]
    fn a_leaf_read_of_a_credential_is_still_redacted() {
        let data = json!({
            "key": "mcp.whoop.headers.Authorization",
            "config": "Bearer c78911b4d4502e957cbee6546"
        });
        let out = render(&data, false);
        assert!(
            !out.contains("c78911b4"),
            "reading a header directly must not be a way around redaction: {out}"
        );
        assert!(out.contains("(set, hidden)"), "{out}");
    }

    #[test]
    fn a_key_that_is_set_to_nothing_reads_as_none() {
        let data = json!({"key": "defaults.model", "config": Value::Null});
        let out = render(&data, false);
        assert!(out.contains("(none)"), "{out}");
    }

    #[test]
    fn a_set_confirmation_reports_the_key_and_value() {
        let data = json!({"set": "defaults.model", "value": "kimi-k3"});
        let out = render(&data, false);
        assert!(out.contains("defaults.model"), "{out}");
        assert!(out.contains("kimi-k3"), "{out}");
    }

    #[test]
    fn check_reports_problems_as_warnings_and_silence_as_healthy() {
        set_color_enabled(false);
        let mut healthy = Vec::new();
        write_check(&mut healthy, &json!({"config_dir": "/config", "warnings": []}));
        let clean = String::from_utf8(healthy).unwrap_or_default();
        assert!(clean.contains("no problems found"), "{clean}");

        let mut broken = Vec::new();
        write_check(
            &mut broken,
            &json!({"config_dir": "/config", "warnings": ["No chat models configured."]}),
        );
        let dirty = String::from_utf8(broken).unwrap_or_default();
        assert!(dirty.contains("No chat models configured."), "{dirty}");
        assert!(dirty.trim_end().lines().last().unwrap_or("").contains('!'), "{dirty}");
    }

    #[test]
    fn a_missing_value_reads_as_unset_not_as_the_word_null() {
        let data = json!({"config": {"defaults": {"model": null}}, "defaults": {}});
        let out = render(&data, true);
        assert!(!out.contains("null"), "a null must not print as the word null: {out}");
        assert!(out.contains("(none)"), "{out}");
    }

    #[test]
    fn a_subtable_that_is_entirely_default_is_collapsed_away() {
        let data = json!({
            "config": {"cache": {"keepalive_max": "20h"}, "notifications": {"enabled": true}},
            "defaults": {"notifications": {"enabled": true}}
        });
        let out = render(&data, false);
        assert!(out.contains("keepalive_max"), "a changed key must survive: {out}");
        assert!(
            !out.contains("notifications"),
            "a subtable matching defaults is noise: {out}"
        );
    }

    #[test]
    fn an_array_of_tables_renders_as_blocks_not_as_json() {
        let data = json!({
            "config": {"usage": {"budgets": [
                {"name": "brainwife", "cost_usd": 15},
                {"name": "spare", "cost_usd": 5}
            ]}},
            "defaults": {}
        });
        let out = render(&data, true);
        assert!(!out.contains('{'), "a table array must not fall back to json: {out}");
        assert!(out.contains("brainwife"), "{out}");
        assert!(out.contains("spare"), "{out}");
    }

    #[test]
    fn no_config_line_ships_trailing_whitespace() {
        for line in render(&payload(), true).lines() {
            assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
        }
    }
}
