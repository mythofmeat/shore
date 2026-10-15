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
}
