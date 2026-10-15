use std::io::Write;

use serde_json::Value;

use super::vocab::{Mark, Rows, Tone, blank, empty, section, warning};

fn text<'value>(row: &'value Value, key: &str) -> &'value str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

fn flag(row: &Value, key: &str) -> bool {
    row.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn list(row: &Value, key: &str) -> Vec<String> {
    row.get(key)
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

fn rows_of<'data>(data: &'data Value, key: &str) -> &'data [Value] {
    data.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn quoted_subject(warning_text: &str) -> Option<&str> {
    let after = warning_text.split_once('\'')?.1;
    after.split_once('\'').map(|(subject, _)| subject)
}

fn warnings_for<'text>(warnings: &'text [String], subject: &str) -> Vec<&'text str> {
    warnings
        .iter()
        .filter(|w| quoted_subject(w) == Some(subject))
        .map(String::as_str)
        .collect()
}

fn unattached<'text>(warnings: &'text [String], subjects: &[String]) -> Vec<&'text str> {
    warnings
        .iter()
        .filter(|w| quoted_subject(w).is_none_or(|subject| !subjects.iter().any(|s| s == subject)))
        .map(String::as_str)
        .collect()
}

fn all_warnings(data: &Value) -> Vec<String> {
    data.get("warnings")
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

pub(crate) fn write_tools<W: Write>(out: &mut W, data: &Value) {
    let warnings = all_warnings(data);

    section(out, "tools", None);
    let tools = rows_of(data, "tools");
    if tools.is_empty() {
        empty(out, "no tools registered");
    } else {
        let mut rows = Rows::new();
        for tool in tools {
            let name = text(tool, "tool");
            let on = flag(tool, "main");
            let owners = list(tool, "subagents");
            let mark = if on { Mark::On } else { Mark::Off };
            let tone = if on { Tone::Plain } else { Tone::Muted };
            rows.add_marked(mark, name, &owners.join(", "), tone);
        }
        rows.write(out);
    }

    let subagents = rows_of(data, "subagents");
    let mut names: Vec<String> = Vec::new();
    if !subagents.is_empty() {
        blank(out);
        section(out, "sub-agents", None);
        let mut rows = Rows::new();
        for sub in subagents {
            let name = text(sub, "name");
            names.push(name.to_owned());
            let on = flag(sub, "enabled");
            let broken = !warnings_for(&warnings, name).is_empty();
            let mark = if broken {
                Mark::Warn
            } else if on {
                Mark::On
            } else {
                Mark::Off
            };
            let tone = if on { Tone::Plain } else { Tone::Muted };
            rows.add_marked(mark, name, &list(sub, "tools").join(", "), tone);
        }
        rows.write(out);

        for sub in subagents {
            let name = text(sub, "name");
            for text_of in warnings_for(&warnings, name) {
                warning(out, text_of);
            }
        }
    }

    let orphans = unattached(&warnings, &names);
    if !orphans.is_empty() {
        blank(out);
        for text_of in orphans {
            warning(out, text_of);
        }
    }
}

pub(crate) fn print(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_tools(&mut out, data);
}
