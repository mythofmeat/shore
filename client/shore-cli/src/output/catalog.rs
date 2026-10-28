use std::io::Write;

use serde_json::Value;

use super::vocab::{Align, Mark, Rows, Table, Tone, blank, count, empty, hidden, note, section};

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
        Value::Array(items) => items.iter().map(scalar).collect::<Vec<String>>().join(", "),
        Value::Object(_) => "(table)".to_owned(),
    }
}

fn write_roles<W: Write>(out: &mut W, data: &Value) {
    let roles = rows_of(data, "roles");
    if roles.is_empty() {
        return;
    }
    section(out, "in use", None);
    let mut rows = Rows::new();
    for role in roles {
        let model = text(role, "model");
        let (value, tone) = if model.is_empty() {
            ("(not set)", Tone::Muted)
        } else {
            (model, Tone::Plain)
        };
        rows.add_noted(text(role, "role"), value, text(role, "source"), tone);
    }
    rows.write(out);
    blank(out);
}

fn model_rows(models: &[&Value], active: &str) -> Rows {
    let mut rows = Rows::new();
    for model in models {
        let name = text(model, "name");
        let is_active = !active.is_empty() && text(model, "qualified_name") == active;
        let mark = if is_active { Mark::Active } else { Mark::None };
        let tone = if is_active { Tone::Active } else { Tone::Plain };
        rows.add_marked(mark, name, text(model, "provider"), tone);
    }
    rows
}

pub(crate) fn write_model_list<W: Write>(out: &mut W, data: &Value) {
    write_roles(out, data);
    let favorites_only = flag(data, "favorites_only");
    let active = text(data, "active");
    let models = super::models_by_provider(data);
    let (favorites, rest): (Vec<&Value>, Vec<&Value>) =
        models.iter().partition(|model| flag(model, "favorite"));

    if !favorites.is_empty() {
        section(out, "favorites", None);
        model_rows(&favorites, active).write(out);
        if !favorites_only {
            blank(out);
        }
    }

    if favorites_only {
        if favorites.is_empty() {
            section(out, "favorites", None);
            empty(out, "none yet \u{00b7} shore model fav <name>");
        }
        return;
    }

    section(out, "models", None);
    if rest.is_empty() {
        let why = if favorites.is_empty() {
            "no models available"
        } else {
            "nothing outside favorites"
        };
        empty(out, why);
    } else {
        model_rows(&rest, active).write(out);
    }

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

fn write_saved_settings<W: Write>(out: &mut W, settings: &[Value]) {
    let mut rows = Rows::at_depth(2);
    for saved in settings {
        rows.add_noted(
            text(saved, "key"),
            &scalar(saved.get("value").unwrap_or(&Value::Null)),
            text(saved, "scope"),
            Tone::Plain,
        );
    }
    rows.write(out);
}

fn write_overview_role<W: Write>(out: &mut W, role: &Value) {
    let settings = rows_of(role, "settings");
    let tuned = !settings.is_empty();

    let mut head = Rows::new();
    head.add_marked(
        if tuned { Mark::Active } else { Mark::Off },
        text(role, "role"),
        super::abbreviate_model(text(role, "model")),
        if tuned { Tone::Plain } else { Tone::Muted },
    );
    head.write(out);

    let mut rows = Rows::at_depth(1);
    let source = text(role, "source");
    if !source.is_empty() {
        rows.add("from", source);
    }
    rows.add_toned(
        "target",
        &format!("shore model setting {}", text(role, "flag")),
        Tone::Muted,
    );
    let shared = role.get("same_settings_as").and_then(Value::as_str);
    if let Some(other) = shared {
        rows.add_toned(
            "shares settings with",
            &format!("{other} — the same model, so tuning either moves both"),
            Tone::Warn,
        );
    }
    if let Some(problem) = role.get("error").and_then(Value::as_str) {
        rows.add_toned("unresolved", problem, Tone::Bad);
    }
    rows.write(out);

    if tuned {
        write_saved_settings(out, settings);
    }
}

fn write_settings_overview<W: Write>(out: &mut W, data: &Value) {
    let character = data.get("character").and_then(Value::as_str);
    section(out, "model settings", character);

    let roles = rows_of(data, "roles");
    if roles.is_empty() {
        empty(out, "nothing resolves to a model yet");
        return;
    }
    for (index, role) in roles.iter().enumerate() {
        if index > 0 {
            blank(out);
        }
        write_overview_role(out, role);
    }

    let inherited = number(data, "inherited_count");
    blank(out);
    if inherited > 0 {
        note(
            out,
            &format!("{inherited} more role(s) inherit and are tuned by nothing, not shown"),
        );
    }
    note(out, "add a target flag to see or set just one of these");
}

pub(crate) fn write_model_settings<W: Write>(out: &mut W, data: &Value) {
    if flag(data, "overview") {
        write_settings_overview(out, data);
        return;
    }
    section(out, "model settings", Some(text(data, "model")));
    let Some(schema) = data.get("setting_schema").and_then(Value::as_array) else {
        empty(out, "daemon returned invalid model settings");
        return;
    };
    let Some(effective) = data.get("effective_sampler").and_then(Value::as_object) else {
        empty(out, "no settings available");
        return;
    };
    let honored = |key: &str| -> bool {
        schema
            .iter()
            .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
            .and_then(|entry| entry.get("applicability"))
            .and_then(Value::as_str)
            .is_some_and(|state| state == "always" || state == "honored")
    };
    let mut table = Table::new(
        &["setting", "value", "from"],
        &[Align::Left, Align::Left, Align::Left],
    );
    let only = data.get("key").and_then(Value::as_str);
    let mut ignored = 0_usize;
    for (key, value) in effective {
        if only.is_some_and(|wanted| wanted != key) {
            continue;
        }
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
        empty(
            out,
            only.map_or(
                "nothing set; every value is the built-in default",
                |wanted| {
                    if honored(wanted) {
                        "not set; this one is the built-in default"
                    } else {
                        "set, but this model's sdk ignores it"
                    }
                },
            ),
        );
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
        let mut table = Table::new(
            &["model id", "name", "subscription"],
            &[Align::Left, Align::Left, Align::Left],
        );
        for model in shown {
            table.row(&[
                text(model, "model_id").to_owned(),
                text(model, "display_name").to_owned(),
                match model.get("subscription_included").and_then(Value::as_bool) {
                    Some(true) => "included".to_owned(),
                    Some(false) => "paid".to_owned(),
                    None => String::new(),
                },
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

fn thread_turns(turns: u64) -> String {
    match turns {
        0 => "empty".to_owned(),
        1 => "1 turn".to_owned(),
        n => format!("{n} turns"),
    }
}

fn thread_facts(row: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if flag(row, "home") {
        parts.push("home".to_owned());
    }
    if let Some(unread) = row
        .get("unread")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
    {
        parts.push(format!("{unread} new"));
    }
    if let Some(turns) = row.get("turns").and_then(Value::as_u64) {
        parts.push(thread_turns(turns));
    }
    if flag(row, "warm") {
        parts.push("warm".to_owned());
    }
    parts.push(
        if flag(row, "compaction") {
            "compacts"
        } else {
            "trims"
        }
        .to_owned(),
    );
    let model = text(row, "chat_model");
    if !model.is_empty() {
        parts.push(model.to_owned());
    }
    let source = row
        .get("forked_from")
        .and_then(|origin| origin.get("source"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !source.is_empty() {
        parts.push(format!("forked from {source}"));
    }
    let files = row
        .get("files")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if files > 0 {
        parts.push(format!("{files} file{}", if files == 1 { "" } else { "s" }));
    }
    parts.join(" \u{b7} ")
}

fn thread_note(row: &Value) -> String {
    let label = text(row, "label");
    let purpose = text(row, "purpose");
    match (label.is_empty(), purpose.is_empty()) {
        (_, true) => label.to_owned(),
        (true, false) => purpose.to_owned(),
        (false, false) => format!("{label} \u{2014} {purpose}"),
    }
}

fn fork_note(data: &Value) -> Option<String> {
    let fork = data.get("fork")?;
    let thread = fork.get("thread").and_then(Value::as_str)?;
    let source = fork.get("source").and_then(Value::as_str)?;
    let messages = fork.get("messages").and_then(Value::as_u64).unwrap_or(0);
    let turns = fork.get("turns").and_then(Value::as_u64).unwrap_or(0);
    let scope = if fork.get("scope").and_then(Value::as_str) == Some("last_turns") {
        format!("the last {}", thread_turns(turns))
    } else {
        "the whole active context".to_owned()
    };
    Some(format!(
        "{thread} is a snapshot of {source}: {scope}, {messages} message(s), \
         {turns} of your turn(s). Each side is edited and compacted on its own from here"
    ))
}

pub(crate) fn write_thread_list<W: Write>(out: &mut W, data: &Value) {
    let character = text(data, "character");
    section(
        out,
        "threads",
        if character.is_empty() {
            None
        } else {
            Some(character)
        },
    );
    let threads = rows_of(data, "threads");
    if threads.is_empty() {
        empty(out, "no threads");
        return;
    }

    let mut rows = Rows::new();
    for thread in threads {
        let current = flag(thread, "current");
        rows.add_marked_noted(
            if current { Mark::Active } else { Mark::None },
            text(thread, "id"),
            &thread_facts(thread),
            &thread_note(thread),
            if current { Tone::Active } else { Tone::Plain },
        );
    }
    rows.write(out);
    blank(out);
    if let Some(forked) = fork_note(data) {
        note(out, &forked);
    }
    note(
        out,
        "home is where unprompted messages arrive; other threads speak only when spoken to",
    );
    if threads.iter().any(|thread| flag(thread, "warm")) {
        note(
            out,
            "warm is the thread holding the cache slot; a turn anywhere else pays to rebuild it",
        );
    }
}

pub(crate) fn print_thread_list(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_thread_list(&mut out, data);
}

pub(crate) fn print_model_list(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_model_list(&mut out, data);
}

pub(crate) fn print_model_info(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_model_info(&mut out, data);
}

pub(crate) fn print_model_settings(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_model_settings(&mut out, data);
}

pub(crate) fn print_provider_list(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_provider_list(&mut out, data);
}

pub(crate) fn print_provider_models(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_provider_models(&mut out, data);
}

pub(crate) fn print_character_list(data: &Value, active: Option<&str>) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_character_list(&mut out, data, active);
}
