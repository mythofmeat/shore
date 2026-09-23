#[cfg(test)]
use std::io;
use std::io::Write;

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
    SECRET_KEYS
        .iter()
        .any(|s| lowered == *s || lowered.ends_with(&format!("_{s}")))
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
                items.iter().map(scalar).collect::<Vec<String>>().join(", ")
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
        Value::Object(map) => map
            .iter()
            .any(|(k, v)| has_interesting(v, default.and_then(|d| d.get(k)), show_all)),
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
    let Some(mut segments) =
        scoped.map(|key| key.split('.').map(str::to_owned).collect::<Vec<String>>())
    else {
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
        write_set(out, key, data);
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
        note(
            out,
            "showing what differs from defaults \u{00b7} -a for everything",
        );
    }
}

fn strings(data: &Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn write_set<W: Write>(out: &mut W, key: &str, data: &Value) {
    section(out, "config set", Some(key));

    let value = data.get("value").unwrap_or(&Value::Null);
    let previous = data.get("previous").unwrap_or(&Value::Null);
    let shown = if is_secret(&[], key.rsplit('.').next().unwrap_or(key)) {
        redacted(value)
    } else {
        scalar(value)
    };

    let mut rows = Rows::new();
    if previous == value {
        rows.add_toned("unchanged", &shown, Tone::Muted);
    } else {
        rows.add_toned("was", &scalar(previous), Tone::Muted);
        rows.add_toned("now", &shown, Tone::Good);
    }
    if let Some(file) = data.get("file").and_then(Value::as_str) {
        rows.add_toned("written to", file, Tone::Muted);
    }
    rows.write(out);

    let restart = strings(data, "restart_required");
    if !restart.is_empty() {
        blank(out);
        warning(
            out,
            &format!(
                "{} {} only after a daemon restart",
                restart.join(", "),
                if restart.len() == 1 {
                    "takes effect"
                } else {
                    "take effect"
                }
            ),
        );
    }

    if let Some(preferred) = data.get("masked_by_preference").and_then(Value::as_str) {
        blank(out);
        note(
            out,
            &format!(
                "this character still uses {preferred} \u{00b7} `shore model reset` to fall back to the default"
            ),
        );
    }
}

pub(crate) fn write_schema<W: Write>(out: &mut W, data: &Value, filter: Option<&str>) {
    section(out, "config keys", filter);

    let Some(entries) = data.get("schema").and_then(Value::as_array) else {
        empty(out, "keys");
        return;
    };

    let settable = entries.iter().filter(|entry| {
        entry
            .get("settable")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });

    let mut rows = Rows::new();
    for entry in settable {
        let Some(key) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if filter.is_some_and(|needle| !key.contains(needle)) {
            continue;
        }
        let described = entry.get("type").and_then(Value::as_str).unwrap_or("value");
        if entry
            .get("restart_required")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            rows.add_noted(key, described, "needs restart", Tone::Warn);
        } else {
            rows.add_toned(key, described, Tone::Muted);
        }
    }

    if rows.is_empty() {
        empty(out, "matching keys");
        return;
    }
    rows.write(out);
    blank(out);
    note(
        out,
        "read one with `shore config get <key>` \u{00b7} write it with `shore config set <key> <value>`",
    );
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
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_config(&mut out, data, show_all);
}

pub(crate) fn print_check(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_check(&mut out, data);
}

pub(crate) fn print_schema(data: &Value, filter: Option<&str>) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_schema(&mut out, data, filter);
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
                "defaults": {"display_name": "eve"}
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
        let mcp_line = out.lines().find(|l| l.trim() == "mcp:").unwrap_or_default();
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
    fn a_long_leaf_value_is_shown_in_full() {
        let values = [
            "x".repeat(316),
            "Things already known\nthat bear on what is being said\nright now".to_owned(),
        ];
        for value in values {
            let data = json!({"key": "subagents.memory.prompt", "config": value.as_str()});
            let out = render(&data, false);
            assert!(
                out.contains(value.as_str()),
                "a targeted lookup must show the value it was asked for: {out}"
            );
        }
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
        write_check(
            &mut healthy,
            &json!({"config_dir": "/config", "warnings": []}),
        );
        let clean = String::from_utf8(healthy).unwrap_or_default();
        assert!(clean.contains("no problems found"), "{clean}");

        let mut broken = Vec::new();
        write_check(
            &mut broken,
            &json!({"config_dir": "/config", "warnings": ["No chat models configured."]}),
        );
        let dirty = String::from_utf8(broken).unwrap_or_default();
        assert!(dirty.contains("No chat models configured."), "{dirty}");
        assert!(
            dirty.trim_end().lines().last().unwrap_or("").contains('!'),
            "{dirty}"
        );
    }

    #[test]
    fn a_missing_value_reads_as_unset_not_as_the_word_null() {
        let data = json!({"config": {"defaults": {"model": null}}, "defaults": {}});
        let out = render(&data, true);
        assert!(
            !out.contains("null"),
            "a null must not print as the word null: {out}"
        );
        assert!(out.contains("(none)"), "{out}");
    }

    #[test]
    fn a_subtable_that_is_entirely_default_is_collapsed_away() {
        let data = json!({
            "config": {"compaction": {"idle_after": "20h"}, "notifications": {"enabled": true}},
            "defaults": {"notifications": {"enabled": true}}
        });
        let out = render(&data, false);
        assert!(
            out.contains("idle_after"),
            "a changed key must survive: {out}"
        );
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
        assert!(
            !out.contains('{'),
            "a table array must not fall back to json: {out}"
        );
        assert!(out.contains("brainwife"), "{out}");
        assert!(out.contains("spare"), "{out}");
    }

    #[test]
    fn no_config_line_ships_trailing_whitespace() {
        for line in render(&payload(), true).lines() {
            assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
        }
    }

    fn set_payload() -> Value {
        json!({
            "set": "compaction.idle_after",
            "value": "6h",
            "previous": "12h",
            "file": "/home/eve/.config/shore/config.toml",
            "action": "replaced",
            "restart_required": [],
            "masked_by_preference": null
        })
    }

    fn with(base: Value, overrides: &[(&str, Value)]) -> Value {
        let mut data = base;
        if let Some(map) = data.as_object_mut() {
            for (key, value) in overrides {
                let _replaced = map.insert((*key).to_owned(), value.clone());
            }
        }
        data
    }

    fn render_schema(data: &Value, filter: Option<&str>) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_schema(&mut buf, data, filter);
        String::from_utf8(buf).unwrap_or_default()
    }

    #[test]
    fn a_set_shows_the_old_value_beside_the_new_one() {
        let out = render(&set_payload(), false);
        assert!(
            out.contains("12h"),
            "the previous value orients the reader: {out}"
        );
        assert!(out.contains("6h"), "{out}");
        assert!(out.contains("config.toml"), "say which file moved: {out}");
    }

    #[test]
    fn a_set_that_changed_nothing_says_so_instead_of_faking_a_move() {
        let data = with(set_payload(), &[("previous", json!("6h"))]);
        let out = render(&data, false);
        assert!(out.contains("unchanged"), "{out}");
        assert!(!out.contains("was"), "{out}");
    }

    #[test]
    fn a_restart_only_key_warns_that_the_running_daemon_has_not_moved() {
        let data = with(
            set_payload(),
            &[
                ("set", json!("daemon.addr")),
                ("restart_required", json!(["[daemon]"])),
            ],
        );
        let out = render(&data, false);
        assert!(out.contains("[daemon]"), "{out}");
        assert!(out.contains("restart"), "{out}");
    }

    #[test]
    fn a_saved_model_preference_is_called_out_after_setting_the_default_model() {
        let data = with(
            set_payload(),
            &[
                ("set", json!("defaults.model")),
                ("masked_by_preference", json!("anthropic:claude-opus-4-5")),
            ],
        );
        let out = render(&data, false);
        assert!(
            out.contains("shore model reset"),
            "point at the way out: {out}"
        );
    }

    #[test]
    fn setting_a_secret_never_echoes_it_back() {
        let data = with(
            set_payload(),
            &[
                ("set", json!("notifications.ntfy.token")),
                ("value", json!("tk_9f3c1d55aa")),
                ("previous", json!("")),
            ],
        );
        let out = render(&data, false);
        assert!(
            !out.contains("tk_9f3c1d55aa"),
            "a token must not be echoed: {out}"
        );
        assert!(out.contains("(set, hidden)"), "{out}");
    }

    fn schema_payload() -> Value {
        json!({"schema": [
            {"key": "compaction.idle_after", "type": "duration", "settable": true, "restart_required": false},
            {"key": "daemon.addr", "type": "string", "settable": true, "restart_required": true},
            {"key": "defaults.stream", "type": "boolean", "settable": true, "restart_required": false},
            {"key": "memory.compaction", "type": "table", "settable": false, "restart_required": false}
        ]})
    }

    #[test]
    fn the_key_listing_shows_types_and_hides_what_cannot_be_set() {
        let out = render_schema(&schema_payload(), None);
        assert!(out.contains("compaction.idle_after"), "{out}");
        assert!(out.contains("duration"), "the type is the point: {out}");
        assert!(
            !out.contains("memory.compaction"),
            "a table is not settable, so it is not offered: {out}"
        );
    }

    #[test]
    fn the_key_listing_flags_restart_only_keys() {
        let out = render_schema(&schema_payload(), None);
        let line = out
            .lines()
            .find(|l| l.contains("daemon.addr"))
            .unwrap_or_default();
        assert!(line.contains("needs restart"), "{out}");
    }

    #[test]
    fn the_key_listing_filters_by_substring() {
        let out = render_schema(&schema_payload(), Some("idle"));
        assert!(out.contains("compaction.idle_after"), "{out}");
        assert!(!out.contains("daemon.addr"), "{out}");
    }

    #[test]
    fn an_empty_filter_result_says_so_rather_than_printing_a_bare_header() {
        let out = render_schema(&schema_payload(), Some("nothing-matches"));
        assert!(out.contains("matching keys"), "{out}");
    }

    #[test]
    fn no_set_or_schema_line_ships_trailing_whitespace() {
        let data = with(set_payload(), &[("restart_required", json!(["[daemon]"]))]);
        for line in render(&data, false)
            .lines()
            .chain(render_schema(&schema_payload(), None).lines())
        {
            assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
        }
    }

    #[test]
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh config-set"]
    fn render_preview_config_set() {
        set_color_enabled(true);
        let mut buf = Vec::new();

        let moved = with(
            set_payload(),
            &[
                ("set", json!("defaults.model")),
                ("value", json!("anthropic:claude-opus-4-5")),
                ("previous", json!("zai-sub:glm-4.6")),
                ("masked_by_preference", json!("zai-sub:glm-4.6")),
            ],
        );
        write_set(&mut buf, "defaults.model", &moved);

        let restart = with(
            set_payload(),
            &[
                ("set", json!("daemon.addr")),
                ("value", json!("127.0.0.1:7321")),
                ("previous", json!("127.0.0.1:7320")),
                ("restart_required", json!(["[daemon]"])),
            ],
        );
        write_set(&mut buf, "daemon.addr", &restart);

        write_schema(&mut buf, &schema_payload(), None);

        set_color_enabled(false);
        let stdout = io::stdout();
        let mut lock = stdout.lock();
        let _header = lock.write_all(b"----- config set / keys -----\n");
        let _body = lock.write_all(&buf);
        let _footer = lock.write_all(b"----- end -----\n");
    }
}
