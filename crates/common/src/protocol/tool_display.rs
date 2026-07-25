use serde_json::Value;

/// Format a tool input for human-facing clients.
///
/// Empty object inputs are omitted because they add noise without information.
pub fn format_tool_input(input: &Value) -> Option<String> {
    format_tool_input_with_limit(input, None)
}

/// Format a tool input, truncating the rendered text when `max_bytes` is set.
pub fn format_tool_input_with_limit(input: &Value, max_bytes: Option<usize>) -> Option<String> {
    if input.as_object().is_some_and(serde_json::Map::is_empty) {
        return None;
    }

    let formatted = format_json_value(input);
    Some(truncate_with_notice(formatted, max_bytes))
}

/// Format tool output for human-facing clients.
///
/// When the output is a JSON value serialized into a string, it is rendered with
/// the same compact, label-oriented shape as tool inputs. Plain text output is
/// preserved.
pub fn format_tool_output(output: &str) -> String {
    format_tool_output_with_limit(output, None)
}

/// Format tool output, truncating the rendered text when `max_bytes` is set.
pub fn format_tool_output_with_limit(output: &str, max_bytes: Option<usize>) -> String {
    let trimmed = output.trim_end();
    let formatted = match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => format_json_value(&value),
        Err(_) => trimmed.to_owned(),
    };
    truncate_with_notice(formatted, max_bytes)
}

fn format_json_value(value: &Value) -> String {
    let mut lines = Vec::new();
    push_value(&mut lines, value, 0);
    lines.join("\n")
}

fn push_value(lines: &mut Vec<String>, value: &Value, indent: usize) {
    match value {
        Value::Object(map) => {
            if map.is_empty() {
                lines.push(format!("{}{{}}", spaces(indent)));
                return;
            }
            for (key, child) in map {
                push_key_value(lines, key, child, indent);
            }
        }
        Value::Array(values) => push_array(lines, values, indent),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            push_scalar(lines, value, indent);
        }
    }
}

fn push_key_value(lines: &mut Vec<String>, key: &str, value: &Value, indent: usize) {
    let prefix = spaces(indent);
    if let Some(inline) = inline_value(value) {
        lines.push(format!("{prefix}{key}: {inline}"));
        return;
    }

    lines.push(format!("{prefix}{key}:"));
    push_value(lines, value, indent.saturating_add(2));
}

fn push_array(lines: &mut Vec<String>, values: &[Value], indent: usize) {
    let prefix = spaces(indent);
    if values.is_empty() {
        lines.push(format!("{prefix}[]"));
        return;
    }

    if values.iter().all(|value| inline_value(value).is_some()) {
        let joined = values
            .iter()
            .filter_map(inline_value)
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("{prefix}[{joined}]"));
        return;
    }

    for value in values {
        if let Some(inline) = inline_value(value) {
            lines.push(format!("{prefix}- {inline}"));
        } else {
            lines.push(format!("{prefix}-"));
            push_value(lines, value, indent.saturating_add(2));
        }
    }
}

fn push_scalar(lines: &mut Vec<String>, value: &Value, indent: usize) {
    let prefix = spaces(indent);
    match value {
        Value::String(text) => {
            for line in text.lines() {
                lines.push(format!("{prefix}{line}"));
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            if let Some(inline) = inline_value(value) {
                lines.push(format!("{prefix}{inline}"));
            }
        }
    }
}

fn inline_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("null".to_owned()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.contains('\n') => Some(format_string(s)),
        Value::Array(values) if values.iter().all(|item| inline_value(item).is_some()) => {
            let joined = values
                .iter()
                .filter_map(inline_value)
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!("[{joined}]"))
        }
        Value::Object(map) if map.is_empty() => Some("{}".to_owned()),
        Value::String(_) | Value::Array(_) | Value::Object(_) => None,
    }
}

fn format_string(value: &str) -> String {
    if value.is_empty() {
        "\"\"".to_owned()
    } else {
        value.to_owned()
    }
}

fn truncate_with_notice(mut text: String, max_bytes: Option<usize>) -> String {
    let Some(limit) = max_bytes else {
        return text;
    };
    let original_len = text.len();
    if original_len <= limit {
        return text;
    }

    let end = floor_char_boundary(&text, limit);
    text.truncate(end);
    text.push_str("\n... truncated, ");
    text.push_str(&original_len.to_string());
    text.push_str(" bytes total");
    text
}

fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i = i.saturating_sub(1);
    }
    i
}

fn spaces(count: usize) -> String {
    " ".repeat(count)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn empty_tool_input_is_omitted() {
        assert_eq!(format_tool_input(&json!({})), None);
    }

    #[test]
    fn object_input_uses_key_value_lines() {
        let input = json!({
            "query": "rust tui frameworks",
            "max_results": 3,
            "include_answer": true
        });

        let formatted = format_tool_input(&input).unwrap();

        assert!(formatted.contains("query: rust tui frameworks"));
        assert!(formatted.contains("max_results: 3"));
        assert!(formatted.contains("include_answer: true"));
        assert!(!formatted.contains("\"query\""));
        assert!(!formatted.contains('{'));
    }

    #[test]
    fn nested_values_are_indented() {
        let input = json!({
            "request": {
                "path": "/tmp/report.md",
                "tags": ["draft", "notes"]
            }
        });

        let formatted = format_tool_input(&input).unwrap();

        assert!(formatted.contains("request:\n  path: /tmp/report.md"));
        assert!(formatted.contains("tags: [draft, notes]"));
    }

    #[test]
    fn json_tool_output_is_formatted() {
        let output = r#"{"ok":true,"items":["alpha","beta"]}"#;

        let formatted = format_tool_output(output);

        assert!(formatted.contains("ok: true"));
        assert!(formatted.contains("items: [alpha, beta]"));
    }

    #[test]
    fn fixture_json_escaped_newlines_expand_to_lines() {
        let output = r#"{"content":"line one\nline two"}"#;

        let formatted = format_tool_output(output);

        assert_eq!(formatted, "content:\n  line one\n  line two");
    }

    #[test]
    fn fixture_plain_literal_backslash_n_stays_literal() {
        let output = r"line one\nline two";

        let formatted = format_tool_output(output);

        assert_eq!(formatted, r"line one\nline two");
    }

    #[test]
    fn plain_tool_output_is_preserved() {
        let output = "Found 3 results\n";

        assert_eq!(format_tool_output(output), "Found 3 results");
    }

    #[test]
    fn formatting_respects_utf8_when_truncated() {
        let input = json!({"text": "cafe: caf\u{00e9} caf\u{00e9} caf\u{00e9}"});

        let formatted = format_tool_input_with_limit(&input, Some(15)).unwrap();

        assert!(formatted.contains("truncated"));
        assert!(std::str::from_utf8(formatted.as_bytes()).is_ok());
    }
}
