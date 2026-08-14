use std::io::{self, Write};

use serde_json::Value;

use super::vocab::{
    Align, Mark, Rows, Table, Tone, blank, count, empty, hidden, note, section,
};

fn text<'value>(row: &'value Value, key: &str) -> &'value str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

fn flag(row: &Value, key: &str) -> bool {
    row.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn number(row: &Value, key: &str) -> u64 {
    row.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn rows_of<'data>(data: &'data Value, key: &str) -> &'data [Value] {
    data.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn scalar(value: &Value) -> String {
    match value {
        Value::Null => "(unset)".to_owned(),
        Value::String(s) if s.is_empty() => "(unset)".to_owned(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items
            .iter()
            .map(scalar)
            .collect::<Vec<String>>()
            .join(", "),
        Value::Object(_) => "(table)".to_owned(),
    }
}

pub(crate) fn write_model_list<W: Write>(out: &mut W, data: &Value) {
    section(out, "models", None);
    let models = rows_of(data, "models");
    if models.is_empty() {
        empty(out, "no models available");
        return;
    }
    let active = text(data, "active");
    let mut rows = Rows::new();
    for model in models {
        let name = text(model, "name");
        let is_active = !active.is_empty() && text(model, "qualified_name") == active;
        let mark = if is_active { Mark::Active } else { Mark::None };
        let tone = if is_active { Tone::Active } else { Tone::Plain };
        rows.add_marked(mark, name, text(model, "provider"), tone);
    }
    rows.write(out);

    let hidden_count = usize::try_from(number(data, "hidden_count")).unwrap_or(0);
    if !flag(data, "include_hidden") && hidden_count > 0 {
        blank(out);
        hidden(out, hidden_count, "--all");
    }
}

pub(crate) fn write_model_info<W: Write>(out: &mut W, data: &Value) {
    section(out, text(data, "qualified_name"), None);
    let mut rows = Rows::new();
    for (label, key) in [
        ("provider", "provider_key"),
        ("model id", "model_id"),
        ("sdk", "sdk"),
        ("base url", "base_url"),
        ("api key env", "api_key_env"),
    ] {
        if let Some(value) = data.get(key) {
            rows.add(label, &scalar(value));
        }
    }
    let context = number(data, "max_context_tokens");
    if context > 0 {
        rows.add("context", &count(context));
    }
    let output = number(data, "max_output_tokens");
    if output > 0 {
        rows.add("max output", &count(output));
    }
    rows.write(out);
}

fn source_of(key: &str, data: &Value) -> (&'static str, Tone) {
    let character = data.get("saved_character").and_then(|s| s.get(key));
    if character.is_some_and(|v| !v.is_null()) {
        return ("character", Tone::Active);
    }
    let global = data.get("saved_global").and_then(|s| s.get(key));
    if global.is_some_and(|v| !v.is_null()) {
        return ("global", Tone::Plain);
    }
    ("default", Tone::Muted)
}

pub(crate) fn write_model_settings<W: Write>(out: &mut W, data: &Value) {
    section(out, "model settings", Some(text(data, "model")));
    let Some(effective) = data.get("effective_sampler").and_then(Value::as_object) else {
        empty(out, "no settings available");
        return;
    };
    let applicability = data.get("applicability");
    let honored = |key: &str| -> bool {
        applicability
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .is_none_or(|state| state != "ignored")
    };
    let mut table = Table::new(&["setting", "value", "from"], &[
        Align::Left,
        Align::Left,
        Align::Left,
    ]);
    let mut ignored = 0_usize;
    for (key, value) in effective {
        let (source, _tone) = source_of(key, data);
        let is_set = !value.is_null() || source != "default";
        if !honored(key) {
            if is_set {
                ignored = ignored.saturating_add(1);
            }
            continue;
        }
        if !is_set {
            continue;
        }
        table.row(&[key.clone(), scalar(value), source.to_owned()]);
    }
    if table.is_empty() {
        empty(out, "nothing set; every value is the built-in default");
    } else {
        table.write(out);
        blank(out);
        note(out, "from: character beats global beats default");
        if ignored > 0 {
            note(
                out,
                &format!("{ignored} saved setting(s) this model's sdk ignores, not shown"),
            );
        }
    }
}

pub(crate) fn write_background_models<W: Write>(out: &mut W, data: &Value) {
    section(out, "background models", None);
    let tasks = rows_of(data, "background");
    if tasks.is_empty() {
        empty(out, "no background tasks configured");
        return;
    }
    let mut rows = Rows::new();
    for task in tasks {
        let model = text(task, "model");
        let source = text(task, "source");
        let value = if model.is_empty() {
            format!("inherits the chat model ({source})")
        } else {
            format!("{model} \u{00b7} {source}")
        };
        let tone = if model.is_empty() {
            Tone::Muted
        } else {
            Tone::Plain
        };
        rows.add_toned(text(task, "task"), &value, tone);
    }
    rows.write(out);
}

pub(crate) fn write_provider_list<W: Write>(out: &mut W, data: &Value) {
    section(out, "providers", None);
    let providers = rows_of(data, "providers");
    if providers.is_empty() {
        empty(out, "no providers configured");
        return;
    }
    for (index, provider) in providers.iter().enumerate() {
        if index > 0 {
            blank(out);
        }
        let on = flag(provider, "enabled");
        let mut head = Rows::new();
        let discovery = if flag(provider, "discovery_enabled") {
            " \u{00b7} discovery"
        } else {
            ""
        };
        head.add_marked(
            if on { Mark::On } else { Mark::Off },
            text(provider, "name"),
            &format!("{}{discovery}", text(provider, "sdk")),
            if on { Tone::Plain } else { Tone::Muted },
        );
        head.write(out);

        let mut rows = Rows::at_depth(1);
        let base = text(provider, "base_url");
        if !base.is_empty() {
            rows.add("base url", base);
        }
        let keys = rows_of(provider, "keys");
        if !keys.is_empty() {
            let missing: Vec<&str> = keys
                .iter()
                .filter(|k| !flag(k, "env_set"))
                .map(|k| text(k, "name"))
                .collect();
            let value = if missing.is_empty() {
                format!("{} set", keys.len())
            } else {
                format!("{} missing: {}", missing.len(), missing.join(", "))
            };
            let tone = if missing.is_empty() {
                Tone::Plain
            } else {
                Tone::Warn
            };
            rows.add_toned("keys", &value, tone);
        }
        if let Some(cache) = data_cache(provider) {
            rows.add("catalog", &cache);
        }
        rows.write(out);
    }
}

fn data_cache(provider: &Value) -> Option<String> {
    let cache = provider.get("cache")?;
    if !flag(cache, "present") {
        return Some("not fetched yet".to_owned());
    }
    let visible = number(cache, "visible");
    let hidden_models = number(cache, "hidden");
    let total = number(cache, "models").max(visible.saturating_add(hidden_models));
    Some(format!("{visible} shown of {total}"))
}

pub(crate) fn write_provider_models<W: Write>(out: &mut W, data: &Value) {
    section(out, "provider models", Some(text(data, "provider")));
    let shown = rows_of(data, "discovered");
    if shown.is_empty() {
        empty(out, "nothing discovered yet");
    } else {
        let mut table = Table::new(&["model id", "name"], &[Align::Left, Align::Left]);
        for model in shown {
            table.row(&[
                text(model, "model_id").to_owned(),
                text(model, "display_name").to_owned(),
            ]);
        }
        table.write(out);
    }
    let hidden_models = rows_of(data, "hidden");
    if !hidden_models.is_empty() {
        blank(out);
        hidden(out, hidden_models.len(), "--all");
    }
}

pub(crate) fn write_character_list<W: Write>(out: &mut W, data: &Value, active: Option<&str>) {
    section(out, "characters", None);
    let names: Vec<String> = data
        .get("characters")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|c| {
                    c.as_str()
                        .map_or_else(|| text(c, "name").to_owned(), str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        empty(out, "no characters configured");
        return;
    }
    let mut rows = Rows::new();
    for name in &names {
        let is_active = active == Some(name.as_str());
        rows.add_marked(
            if is_active { Mark::Active } else { Mark::None },
            name,
            "",
            if is_active { Tone::Active } else { Tone::Plain },
        );
    }
    rows.write(out);
}

pub(crate) fn print_model_list(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_model_list(&mut out, data);
}

pub(crate) fn print_model_info(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_model_info(&mut out, data);
}

pub(crate) fn print_model_settings(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_model_settings(&mut out, data);
}

pub(crate) fn print_background_models(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_background_models(&mut out, data);
}

pub(crate) fn print_provider_list(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_provider_list(&mut out, data);
}

pub(crate) fn print_provider_models(data: &Value) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_provider_models(&mut out, data);
}

pub(crate) fn print_character_list(data: &Value, active: Option<&str>) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    write_character_list(&mut out, data, active);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::set_color_enabled;
    use serde_json::json;

    fn render<F: FnOnce(&mut Vec<u8>)>(f: F) -> String {
        set_color_enabled(false);
        let mut buf = Vec::new();
        f(&mut buf);
        String::from_utf8(buf).unwrap_or_default()
    }

    fn models() -> Value {
        json!({
            "models": [
                {"name": "claude-opus-5", "qualified_name": "anthropic:claude-opus-5",
                 "provider": "anthropic", "hidden": false},
                {"name": "deepseek-v4-pro", "qualified_name": "deepseek:deepseek-v4-pro",
                 "provider": "deepseek", "hidden": false}
            ],
            "active": "deepseek:deepseek-v4-pro",
            "include_hidden": false,
            "hidden_count": 440
        })
    }

    #[test]
    fn the_active_model_is_marked_once_not_twice() {
        let out = render(|b| write_model_list(b, &models()));
        let row = out
            .lines()
            .find(|l| l.contains("deepseek-v4-pro"))
            .unwrap_or_default();
        assert!(row.trim_start().starts_with('*'), "{row:?}");
        assert!(
            !row.contains("(active)"),
            "the mark already says it; the word is redundant: {row:?}"
        );
    }

    #[test]
    fn hidden_models_use_the_one_agreed_phrasing() {
        let out = render(|b| write_model_list(b, &models()));
        assert!(out.contains("440 hidden \u{00b7} --all to include"), "{out}");
    }

    #[test]
    fn a_full_listing_does_not_mention_hidden_models() {
        let mut data = models();
        if let Some(slot) = data.get_mut("include_hidden") {
            *slot = json!(true);
        }
        let out = render(|b| write_model_list(b, &data));
        assert!(!out.contains("hidden"), "{out}");
    }

    #[test]
    fn settings_name_where_each_value_came_from() {
        let data = json!({
            "model": "deepseek:deepseek-v4-pro",
            "effective_sampler": {"temperature": 1, "reasoning_effort": "max"},
            "saved_character": {"reasoning_effort": "max"},
            "saved_global": null
        });
        let out = render(|b| write_model_settings(b, &data));
        assert!(out.contains("reasoning_effort"), "{out}");
        assert!(out.contains("character"), "{out}");
        assert!(
            out.contains("character beats global beats default"),
            "the precedence must be stated, not implied by brackets: {out}"
        );
    }

    #[test]
    fn a_setting_the_sdk_ignores_is_not_offered_as_if_it_worked() {
        let data = json!({
            "model": "anthropic:claude-opus-5",
            "effective_sampler": {"temperature": 1, "zai_subscription": "pro"},
            "applicability": {"temperature": "honored", "zai_subscription": "ignored"},
            "saved_character": {"zai_subscription": "pro"},
            "saved_global": null
        });
        let out = render(|b| write_model_settings(b, &data));
        assert!(out.contains("temperature"), "{out}");
        assert!(
            !out.contains("zai_subscription"),
            "a knob this sdk ignores must not sit in the table: {out}"
        );
        assert!(
            out.contains("1 saved setting(s) this model's sdk ignores"),
            "but it must not vanish silently either: {out}"
        );
    }

    #[test]
    fn background_models_say_inheritance_once_not_twice() {
        let data = json!({"background": [
            {"task": "heartbeat", "model": "", "source": "active chat model"}
        ]});
        let out = render(|b| write_background_models(b, &data));
        assert!(out.contains("inherits the chat model"), "{out}");
        assert!(
            !out.contains("(unresolved)"),
            "one phrase, not a contradiction plus a gloss: {out}"
        );
    }

    #[test]
    fn a_provider_missing_its_key_reads_as_a_problem() {
        let data = json!({"providers": [{
            "name": "anthropic", "enabled": true, "sdk": "anthropic",
            "base_url": "https://api.anthropic.com", "discovery_enabled": true,
            "keys": [{"name": "default", "env_set": false}],
            "cache": {"present": true, "models": 10, "visible": 2, "hidden": 8}
        }]});
        let out = render(|b| write_provider_list(b, &data));
        assert!(out.contains("missing: default"), "{out}");
        assert!(out.contains("2 shown of 10"), "{out}");
    }

    #[test]
    fn characters_are_marked_the_same_way_models_are() {
        let data = json!({"characters": ["Yuna", "qifei"]});
        let out = render(|b| write_character_list(b, &data, Some("qifei")));
        let row = out
            .lines()
            .find(|l| l.contains("qifei"))
            .unwrap_or_default();
        assert!(row.trim_start().starts_with('*'), "{row:?}");
        assert!(!row.contains("(active)"), "{row:?}");
    }

    #[test]
    fn an_empty_catalog_says_so_instead_of_printing_a_bare_header() {
        let out = render(|b| write_model_list(b, &json!({"models": []})));
        assert!(out.contains("(no models available)"), "{out}");
    }

    #[test]
    fn no_catalog_surface_ships_trailing_whitespace() {
        let surfaces = [
            render(|b| write_model_list(b, &models())),
            render(|b| write_character_list(b, &json!({"characters": ["a"]}), Some("a"))),
        ];
        for out in &surfaces {
            for line in out.lines() {
                assert!(!line.ends_with(' '), "trailing whitespace: {line:?}");
            }
        }
    }
}
