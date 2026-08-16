use std::io::{self, Write};

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
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_tools(&mut out, data);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;
    use serde_json::json;

    fn render(data: &Value) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        write_tools(&mut buf, data);
        String::from_utf8(buf).unwrap_or_default()
    }

    fn payload() -> Value {
        json!({
            "tools": [
                {"tool": "read", "main": true, "subagents": ["internet", "memory"]},
                {"tool": "generate_image", "main": false, "subagents": []}
            ],
            "subagents": [
                {"name": "internet", "enabled": true,
                 "tools": ["web_search", "read"], "model": null},
                {"name": "lights", "enabled": false,
                 "tools": ["mcp__hue__*"], "model": null}
            ],
            "warnings": ["subagent 'lights' references unknown tool 'mcp__hue__*'"]
        })
    }

    #[test]
    fn a_broken_subagent_is_marked_on_its_own_row() {
        let out = render(&payload());
        let broken = out
            .lines()
            .find(|l| l.contains("lights"))
            .unwrap_or_default();
        assert!(
            broken.trim_start().starts_with('!'),
            "the row itself must carry the warning mark: {broken:?}"
        );
    }

    #[test]
    fn a_healthy_subagent_is_not_marked_broken() {
        let out = render(&payload());
        let healthy = out
            .lines()
            .find(|l| l.contains("internet") && !l.contains("read  "))
            .unwrap_or_default();
        assert!(
            !healthy.trim_start().starts_with('!'),
            "a working sub-agent must not look broken: {healthy:?}"
        );
    }

    #[test]
    fn subagent_names_line_up_regardless_of_state() {
        let out = render(&payload());
        let columns: Vec<usize> = out
            .lines()
            .filter_map(|l| {
                let name = l.split_whitespace().nth(1)?;
                if name == "internet" || name == "lights" {
                    l.find(name)
                        .map(|byte| l.get(..byte).unwrap_or("").chars().count())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(columns.len(), 2, "both sub-agent rows must be found: {out}");
        assert!(
            columns.windows(2).all(|w| w.first() == w.get(1)),
            "state belongs in a fixed-width mark, not a variable prefix: {out}"
        );
    }

    #[test]
    fn a_warning_naming_nothing_is_still_shown() {
        let mut data = payload();
        if let Some(slot) = data.get_mut("warnings") {
            *slot = json!(["enabled_subagents references undefined subagent 'ghost'"]);
        }
        let out = render(&data);
        assert!(
            out.contains("ghost"),
            "a warning that matches no row must not be swallowed: {out}"
        );
    }

    #[test]
    fn tools_and_subagents_are_the_same_kind_of_list() {
        let out = render(&payload());
        let roster = ["read", "generate_image", "internet", "lights"];
        for name in roster {
            let row = out
                .lines()
                .find(|l| l.split_whitespace().nth(1) == Some(name))
                .unwrap_or_default();
            let mark = row.trim_start().chars().next().unwrap_or(' ');
            assert!(
                ['\u{2713}', '\u{00b7}', '!'].contains(&mark),
                "{name} must carry a mark like every other row: {row:?}"
            );
        }
    }

    #[test]
    fn no_row_ships_trailing_whitespace() {
        for line in render(&payload()).lines() {
            assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
        }
    }
}
