//! Markdown rendering for daemon command outputs.
//!
//! `CommandOutput` frames carry JSON; dumping that in a code block reads like
//! debug spew. This module formats the common commands the way the TUI
//! renders them — as human-oriented Markdown — and falls back to the JSON
//! code block for anything unrecognized or shaped unexpectedly.
//!
//! Every renderer is defensive: a missing/mistyped field returns `None`, and
//! the caller falls back to the raw dump rather than showing half-parsed
//! output.

use serde_json::Value;

/// Render a command output as Markdown. Never fails — unknown commands and
/// unexpected shapes get the raw JSON code block.
pub fn render_command_output(name: &str, data: &Value) -> String {
    let rendered = match name {
        "status" => render_status(data),
        "list_characters" => render_characters(data),
        "list_models" => render_models(data),
        "model_settings" => render_model_settings(data),
        "list_alternatives" => render_alternatives(data),
        "alt" => render_alt(data),
        "memory" => render_memory(data),
        "log" | "history_page" => render_log(data),
        _ => None,
    };
    rendered.unwrap_or_else(|| render_fallback(name, data))
}

fn render_fallback(name: &str, data: &Value) -> String {
    let pretty = serde_json::to_string_pretty(data).unwrap_or_else(|_| format!("{data:?}"));
    format!("**{name}**\n```json\n{pretty}\n```")
}

fn str_field<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn u64_field(data: &Value, key: &str) -> Option<u64> {
    data.get(key).and_then(Value::as_u64)
}

/// Render one sampler value tersely (no quotes around strings).
fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "—".into(),
        other => other.to_string(),
    }
}

fn render_status(data: &Value) -> Option<String> {
    let character = str_field(data, "character")?;
    let mut lines = vec![format!("**{character}** — status")];
    if let Some(model) = str_field(data, "active_model") {
        lines.push(format!("- model: `{model}`"));
    }
    if let Some(turns) = u64_field(data, "turn_count") {
        lines.push(format!("- turns: {turns}"));
    }
    if let Some(tokens) = data.get("tokens").and_then(Value::as_object) {
        let get = |k: &str| tokens.get(k).and_then(Value::as_u64).unwrap_or(0);
        lines.push(format!(
            "- session tokens: {} in / {} out (cache {} read / {} write)",
            get("input"),
            get("output"),
            get("cache_read"),
            get("cache_write"),
        ));
    }
    if let Some(autonomy) = data.get("autonomy") {
        if let Some(state) = str_field(autonomy, "state").or_else(|| str_field(autonomy, "mode")) {
            lines.push(format!("- autonomy: {state}"));
        }
    }
    Some(lines.join("\n"))
}

fn render_characters(data: &Value) -> Option<String> {
    let characters = data.get("characters")?.as_array()?;
    let mut lines = vec!["**Characters**".to_string()];
    for c in characters {
        let name = str_field(c, "name")?;
        match str_field(c, "description").filter(|d| !d.is_empty()) {
            Some(desc) => lines.push(format!("- **{name}** — {desc}")),
            None => lines.push(format!("- **{name}**")),
        }
    }
    Some(lines.join("\n"))
}

fn render_models(data: &Value) -> Option<String> {
    let models = data.get("models")?.as_array()?;
    let active = str_field(data, "active");
    let mut lines = vec!["**Models**".to_string()];
    for m in models {
        let qualified = str_field(m, "qualified_name").or_else(|| str_field(m, "name"))?;
        let short = str_field(m, "name").unwrap_or(qualified);
        let is_active = active == Some(qualified) || active == Some(short);
        let marker = if is_active { "**●** " } else { "" };
        let mut line = format!("- {marker}`{qualified}`");
        if let Some(provider) = str_field(m, "provider") {
            line.push_str(&format!(" ({provider})"));
        }
        if m.get("hidden").and_then(Value::as_bool) == Some(true) {
            line.push_str(" _hidden_");
        }
        lines.push(line);
    }
    if let Some(hidden) = u64_field(data, "hidden_count").filter(|&h| h > 0) {
        if data.get("include_hidden").and_then(Value::as_bool) != Some(true) {
            lines.push(format!("\n_{hidden} hidden — `!model all` to include._"));
        }
    }
    Some(lines.join("\n"))
}

fn render_model_settings(data: &Value) -> Option<String> {
    let model = str_field(data, "model")?;
    let sampler = data.get("effective_sampler")?.as_object()?;
    let scopes = data.get("scopes").and_then(Value::as_object);
    let mut lines = vec![format!("**Sampler** — `{model}`")];
    for (key, value) in sampler {
        if value.is_null() {
            continue;
        }
        let scope = scopes
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .map(|s| format!(" _({s})_"))
            .unwrap_or_default();
        lines.push(format!("- {key}: `{}`{scope}", scalar(value)));
    }
    if lines.len() == 1 {
        lines.push("_all defaults_".into());
    }
    Some(lines.join("\n"))
}

/// Cap alternative previews so a long reply doesn't flood the room.
fn preview(content: &str, max_chars: usize) -> String {
    let flat = content.replace('\n', " ");
    let mut chars = flat.chars();
    let mut out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn render_alternatives(data: &Value) -> Option<String> {
    let alternatives = data.get("alternatives")?.as_array()?;
    let count = u64_field(data, "alt_count").unwrap_or(alternatives.len() as u64);
    let mut lines = vec![format!(
        "**Alternate responses** ({count}) — switch with `!alt <n>` or ◀ ▶ reactions"
    )];
    for alt in alternatives {
        let position = u64_field(alt, "position")?;
        let content = str_field(alt, "content").unwrap_or_default();
        let marker = if alt.get("active").and_then(Value::as_bool) == Some(true) {
            "**▶**"
        } else {
            "·"
        };
        lines.push(format!("{marker} {position}. {}", preview(content, 160)));
    }
    Some(lines.join("\n"))
}

/// `alt` output when the swap couldn't be applied in place (unmapped message):
/// a short confirmation instead of dumping the full JSON.
fn render_alt(data: &Value) -> Option<String> {
    let position = u64_field(data, "position")?;
    let count = u64_field(data, "alt_count")?;
    let content = str_field(data, "content")?;
    Some(format!(
        "Switched to alternative {position}/{count}:\n\n{content}"
    ))
}

fn render_memory(data: &Value) -> Option<String> {
    // Search results (`!memory <query>`).
    if let Some(results) = data.get("results").and_then(Value::as_array) {
        let query = str_field(data, "query").unwrap_or("memory");
        if results.is_empty() {
            return Some(format!("No memory matches for _{query}_."));
        }
        let mut lines = vec![format!("**Memory matches** — _{query}_")];
        for r in results {
            match r {
                Value::String(s) => lines.push(format!("- {}", preview(s, 200))),
                other => {
                    // Common shape: {file/path, snippet/content, ...}
                    let label = str_field(other, "file")
                        .or_else(|| str_field(other, "path"))
                        .or_else(|| str_field(other, "title"));
                    let body = str_field(other, "snippet")
                        .or_else(|| str_field(other, "content"))
                        .or_else(|| str_field(other, "text"))?;
                    match label {
                        Some(l) => lines.push(format!("- **{l}** — {}", preview(body, 200))),
                        None => lines.push(format!("- {}", preview(body, 200))),
                    }
                }
            }
        }
        return Some(lines.join("\n"));
    }
    None
}

fn render_log(data: &Value) -> Option<String> {
    let messages = data.get("messages")?.as_array()?;
    if messages.is_empty() {
        return Some("_No messages._".into());
    }
    let mut lines = vec![format!("**Recent messages** ({})", messages.len())];
    for m in messages {
        let role = str_field(m, "role").unwrap_or("?");
        let content = str_field(m, "content").unwrap_or_default();
        let who = match role {
            "user" => "👤",
            "assistant" => "🤖",
            "system" => "⚙️",
            other => other,
        };
        lines.push(format!("- {who} {}", preview(content, 160)));
    }
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_command_falls_back_to_json_block() {
        let out = render_command_output("mystery", &json!({"a": 1}));
        assert!(out.starts_with("**mystery**"));
        assert!(out.contains("```json"));
        assert!(out.contains("\"a\": 1"));
    }

    #[test]
    fn malformed_known_command_falls_back() {
        // `status` without the expected fields → raw dump, not a panic or
        // half-rendered output.
        let out = render_command_output("status", &json!({"weird": true}));
        assert!(out.contains("```json"));
    }

    #[test]
    fn status_renders_summary_lines() {
        let out = render_command_output(
            "status",
            &json!({
                "character": "poppy",
                "active_model": "claude-sonnet-5",
                "turn_count": 42,
                "tokens": {"input": 100, "output": 50, "cache_read": 10, "cache_write": 5},
            }),
        );
        assert!(out.contains("**poppy**"));
        assert!(out.contains("`claude-sonnet-5`"));
        assert!(out.contains("turns: 42"));
        assert!(out.contains("100 in / 50 out"));
        assert!(!out.contains("```"));
    }

    #[test]
    fn characters_render_with_descriptions() {
        let out = render_command_output(
            "list_characters",
            &json!({"characters": [
                {"name": "poppy", "description": "flower enthusiast"},
                {"name": "sage"},
            ]}),
        );
        assert!(out.contains("**poppy** — flower enthusiast"));
        assert!(out.contains("**sage**"));
    }

    #[test]
    fn models_mark_active_and_note_hidden() {
        let out = render_command_output(
            "list_models",
            &json!({
                "models": [
                    {"name": "sonnet", "qualified_name": "chat.anthropic.sonnet", "provider": "anthropic", "hidden": false},
                    {"name": "gpt", "qualified_name": "chat.openai.gpt", "provider": "openai", "hidden": false},
                ],
                "active": "chat.anthropic.sonnet",
                "include_hidden": false,
                "hidden_count": 3,
            }),
        );
        assert!(out.contains("**●** `chat.anthropic.sonnet`"));
        assert!(!out.contains("**●** `chat.openai.gpt`"));
        assert!(out.contains("3 hidden"));
    }

    #[test]
    fn model_settings_render_sampler_with_scopes() {
        let out = render_command_output(
            "model_settings",
            &json!({
                "model": "chat.anthropic.sonnet",
                "effective_sampler": {"temperature": 0.7, "reasoning_effort": "high", "top_p": null},
                "scopes": {"temperature": "character", "reasoning_effort": "global"},
            }),
        );
        assert!(out.contains("temperature: `0.7` _(character)_"));
        assert!(out.contains("reasoning_effort: `high` _(global)_"));
        assert!(!out.contains("top_p"), "null values skipped");
    }

    #[test]
    fn alternatives_render_with_active_marker() {
        let out = render_command_output(
            "list_alternatives",
            &json!({
                "ref": "m1",
                "alt_count": 2,
                "alternatives": [
                    {"position": 1, "active": false, "content": "first try"},
                    {"position": 2, "active": true, "content": "second try"},
                ],
            }),
        );
        assert!(out.contains("· 1. first try"));
        assert!(out.contains("**▶** 2. second try"));
    }

    #[test]
    fn alt_renders_confirmation() {
        let out = render_command_output(
            "alt",
            &json!({"ref": "m1", "position": 2, "alt_count": 3, "content": "the other take"}),
        );
        assert!(out.contains("2/3"));
        assert!(out.contains("the other take"));
    }

    #[test]
    fn log_renders_role_markers_and_truncates() {
        let long = "x".repeat(500);
        let out = render_command_output(
            "log",
            &json!({"messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": long},
            ]}),
        );
        assert!(out.contains("👤 hi"));
        assert!(out.contains("🤖 x"));
        assert!(out.contains('…'), "long content truncated");
        assert!(out.len() < 400);
    }

    #[test]
    fn preview_respects_char_boundaries() {
        // Multi-byte chars must not split (chars(), not byte slicing).
        let s = "日本語のテキストです".repeat(30);
        let p = preview(&s, 50);
        assert_eq!(p.chars().count(), 51); // 50 + ellipsis
    }
}
