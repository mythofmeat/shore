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
        empty(
            out,
            "no providers configured; `shore provider add` lists the ones shore knows",
        );
        return;
    }
    for (index, provider) in providers.iter().enumerate() {
        if index > 0 {
            blank(out);
        }
        provider_head(out, provider);
        let mut rows = Rows::at_depth(1);
        let base = text(provider, "base_url");
        if !base.is_empty() {
            rows.add("base url", base);
        }
        let (summary, tone) = credential_summary(provider);
        rows.add_toned(credential_label(provider), &summary, tone);
        if let Some(cache) = data_cache(provider) {
            rows.add("catalog", &cache);
        }
        rows.write(out);
    }
}

fn provider_head<W: Write>(out: &mut W, provider: &Value) {
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
}

fn credentials_of(provider: &Value) -> &[Value] {
    rows_of(provider, "credentials")
}

fn credential_label(provider: &Value) -> &'static str {
    if credentials_of(provider)
        .iter()
        .any(|c| text(c, "kind") == "login")
    {
        "logins"
    } else {
        "keys"
    }
}

fn credential_summary(provider: &Value) -> (String, Tone) {
    let credentials = credentials_of(provider);
    if flag(provider, "no_auth") {
        return ("none needed".to_owned(), Tone::Plain);
    }
    let missing: Vec<&str> = credentials
        .iter()
        .filter(|c| flag(c, "enabled") && text(c, "standing") == "missing")
        .map(|c| text(c, "name"))
        .collect();
    let bad: Vec<&str> = credentials
        .iter()
        .filter(|c| flag(c, "enabled") && matches!(text(c, "standing"), "invalid" | "signed_out"))
        .map(|c| text(c, "name"))
        .collect();
    let using = credentials
        .iter()
        .find(|c| flag(c, "in_use"))
        .map(|c| text(c, "name"));
    let mut parts = vec![format!("{}", credentials.len())];
    if let Some(name) = using {
        parts.push(format!("using {name}"));
    }
    if !missing.is_empty() {
        parts.push(format!("{} missing: {}", missing.len(), missing.join(", ")));
    }
    if !bad.is_empty() {
        parts.push(format!("rejected: {}", bad.join(", ")));
    }
    let tone = if !bad.is_empty() || (using.is_none() && !missing.is_empty()) {
        Tone::Warn
    } else {
        Tone::Plain
    };
    (parts.join(" \u{00b7} "), tone)
}

fn standing_words(standing: &str) -> &str {
    match standing {
        "works" => "works",
        "invalid" => "rejected",
        "over_quota" => "over quota",
        "signed_out" => "signed out",
        "missing" => "missing",
        _ => "not checked yet",
    }
}

fn standing_tone(standing: &str) -> Tone {
    match standing {
        "works" => Tone::Good,
        "invalid" | "signed_out" | "missing" => Tone::Bad,
        "over_quota" => Tone::Warn,
        _ => Tone::Muted,
    }
}

fn money(value: f64) -> String {
    format!("${value:.2}")
}

fn credential_value(credential: &Value) -> String {
    let mut parts = Vec::new();
    match text(credential, "kind") {
        "api_key" => parts.push(format!("stored {}", text(credential, "hint"))),
        "env" => {
            let hint = text(credential, "hint");
            parts.push(if hint.is_empty() {
                format!("${}", text(credential, "env"))
            } else {
                format!("${} {hint}", text(credential, "env"))
            });
        }
        "login" => {
            let who = [text(credential, "hint"), text(credential, "plan")]
                .into_iter()
                .filter(|part| !part.is_empty() && *part != text(credential, "name"))
                .collect::<Vec<_>>()
                .join(" \u{00b7} ");
            parts.push(if who.is_empty() {
                "login".to_owned()
            } else {
                format!("login {who}")
            });
        }
        _ => parts.push("no key".to_owned()),
    }
    let standing = text(credential, "standing");
    parts.push(
        if text(credential, "kind") == "login" && standing == "over_quota" {
            "at a limit"
        } else {
            standing_words(standing)
        }
        .to_owned(),
    );
    if !flag(credential, "enabled") {
        parts.push("disabled".to_owned());
    }
    if flag(credential, "pinned") {
        parts.push("pinned".to_owned());
    }
    parts.join(" \u{00b7} ")
}

fn credential_note(credential: &Value) -> String {
    let mut parts = Vec::new();
    let detail = text(credential, "detail");
    let standing = text(credential, "standing");
    if !detail.is_empty() && standing != "works" && detail != standing_words(standing) {
        parts.push(detail.to_owned());
    }
    if let Some(limit) = credential.get("limit").filter(|v| !v.is_null()) {
        let spent = limit
            .get("spent_usd")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let cap = limit.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
        let period = text(limit, "period");
        let at = if flag(limit, "at_limit") {
            " (at limit)"
        } else {
            ""
        };
        parts.push(format!("{} of {}/{period}{at}", money(spent), money(cap)));
    }
    if let Some(usage) = credential.get("usage").filter(|v| !v.is_null()) {
        let calls = number(usage, "calls");
        let cost = usage.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
        parts.push(format!("{} in 30d, {} calls", money(cost), count(calls)));
    }
    parts.join(" \u{00b7} ")
}

pub(crate) fn write_provider_detail<W: Write>(out: &mut W, provider: &Value) {
    section(out, "provider", Some(text(provider, "name")));
    provider_head(out, provider);
    let mut rows = Rows::at_depth(1);
    let base = text(provider, "base_url");
    rows.add(
        "base url",
        if base.is_empty() {
            "(sdk default)"
        } else {
            base
        },
    );
    let ignored = rows_of(provider, "ignore_models")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if !ignored.is_empty() {
        rows.add("ignores", &ignored.join(", "));
    }
    if flag(provider, "subscription") {
        rows.add("billing", "subscription");
    }
    let selection = match (text(provider, "selection"), text(provider, "pinned")) {
        (_, pinned) if !pinned.is_empty() => format!("only {pinned}"),
        ("room", _) => "a login with room, preferring the week that resets soonest".to_owned(),
        _ => "first that works, in order".to_owned(),
    };
    rows.add("uses", &selection);
    let why = text(provider, "selection_detail");
    if !why.is_empty() {
        rows.add("right now", why);
    }
    if let Some(cache) = data_cache(provider) {
        rows.add("catalog", &cache);
    }
    rows.write(out);
    blank(out);
    section(out, credential_label(provider), None);
    let credentials = credentials_of(provider);
    if credentials.is_empty() {
        empty(out, "none");
        return;
    }
    let mut keys = Rows::new();
    for credential in credentials {
        let standing = text(credential, "standing");
        let mark = if flag(credential, "in_use") {
            Mark::Active
        } else if !flag(credential, "enabled") {
            Mark::Off
        } else if matches!(
            standing,
            "invalid" | "missing" | "signed_out" | "over_quota"
        ) {
            Mark::Warn
        } else {
            Mark::None
        };
        let tone = if flag(credential, "enabled") {
            standing_tone(standing)
        } else {
            Tone::Muted
        };
        keys.add_marked_noted(
            mark,
            text(credential, "name"),
            &credential_value(credential),
            &credential_note(credential),
            tone,
        );
        let windows = rows_of(credential, "windows");
        let command = text(credential, "login_command");
        if !windows.is_empty() || !command.is_empty() {
            keys.write(out);
            keys = Rows::new();
            super::usage::write_login_windows(out, windows);
            if !command.is_empty() {
                note(out, &format!("sign in with: {command}"));
            }
        }
    }
    keys.write(out);
}

pub(crate) fn write_sign_in_started<W: Write>(out: &mut W, data: &Value) {
    note(out, &format!("{}:", text(data, "message")));
    note(out, text(data, "url"));
}

pub(crate) fn print_sign_in_started(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_sign_in_started(&mut out, data);
}

pub(crate) fn write_sign_in_cancelled<W: Write>(out: &mut W, data: &Value) {
    note(out, text(data, "message"));
}

pub(crate) fn print_sign_in_cancelled(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_sign_in_cancelled(&mut out, data);
}

pub(crate) fn write_provider_changed<W: Write>(out: &mut W, data: &Value) {
    note(out, text(data, "message"));
    blank(out);
    if let Some(provider) = data.get("provider") {
        write_provider_detail(out, provider);
    }
}

pub(crate) fn write_provider_presets<W: Write>(out: &mut W, data: &Value) {
    section(out, "known providers", None);
    let mut rows = Rows::new();
    for preset in rows_of(data, "presets") {
        let configured = flag(preset, "configured");
        let auth = match text(preset, "credential_kind") {
            "login" => "Claude login".to_owned(),
            _ => format!("key in ${}", text(preset, "api_key_env")),
        };
        rows.add_marked_noted(
            if configured { Mark::On } else { Mark::None },
            text(preset, "name"),
            &format!("{} \u{00b7} {auth}", text(preset, "sdk")),
            if configured { "added" } else { "" },
            if configured { Tone::Muted } else { Tone::Plain },
        );
    }
    rows.write(out);
    blank(out);
    note(
        out,
        "Add one with `shore provider add <name>`, or your own with `shore provider add <name> --sdk openai --base-url <url>`.",
    );
}

pub(crate) fn write_credential_tested<W: Write>(out: &mut W, data: &Value) {
    let standing = text(data, "standing");
    let mut rows = Rows::new();
    rows.add_marked_noted(
        if flag(data, "ok") {
            Mark::On
        } else {
            Mark::Warn
        },
        &format!("{} {}", text(data, "provider"), text(data, "credential")),
        standing_words(standing),
        text(data, "detail"),
        standing_tone(standing),
    );
    rows.write(out);
}

pub(crate) fn write_provider_removed<W: Write>(out: &mut W, data: &Value) {
    let keys = number(data, "keys_removed");
    let limits = number(data, "limits_removed");
    let mut extra = Vec::new();
    if keys > 0 {
        extra.push(format!(
            "{keys} stored key{}",
            if keys == 1 { "" } else { "s" }
        ));
    }
    if limits > 0 {
        extra.push(format!(
            "{limits} spend limit{}",
            if limits == 1 { "" } else { "s" }
        ));
    }
    let with = if extra.is_empty() {
        String::new()
    } else {
        format!(" with its {}", extra.join(" and "))
    };
    note(
        out,
        &format!(
            "Removed provider {}{with} from {}.",
            text(data, "provider"),
            text(data, "file")
        ),
    );
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
    if flag(row, "heartbeat") {
        parts.push("heartbeats".to_owned());
    }
    let folder = text(row, "folder");
    if !folder.is_empty() {
        parts.push(format!("in {folder}"));
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
    if flag(row, "locked") {
        parts.push("locked".to_owned());
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
    let copied = super::turns(fork.get("turns").and_then(Value::as_u64).unwrap_or(0));
    let scope = if fork.get("scope").and_then(Value::as_str) == Some("last_turns") {
        format!("the last {copied}")
    } else {
        format!("the whole active context, {copied}")
    };
    Some(format!(
        "{thread} is a snapshot of {source}: {scope}. \
         Each side is edited and compacted on its own from here"
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
    let empty_folders: Vec<&str> = rows_of(data, "folders")
        .iter()
        .map(|folder| text(folder, "name"))
        .filter(|name| !threads.iter().any(|thread| text(thread, "folder") == *name))
        .collect();
    if !empty_folders.is_empty() {
        note(out, &format!("empty folders: {}", empty_folders.join(", ")));
    }
    if let Some(compaction) = data.get("compaction") {
        note(
            out,
            &format!(
                "{} is compacting; `shore compact --watch` follows it",
                text(compaction, "thread")
            ),
        );
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
    if threads.iter().any(|thread| flag(thread, "locked")) {
        note(
            out,
            "a locked thread's label, purpose and files change only when you change them",
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

pub(crate) fn print_provider_detail(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_provider_detail(&mut out, data);
}

pub(crate) fn print_provider_changed(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_provider_changed(&mut out, data);
}

pub(crate) fn print_provider_presets(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_provider_presets(&mut out, data);
}

pub(crate) fn print_credential_tested(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_credential_tested(&mut out, data);
}

pub(crate) fn print_provider_removed(data: &Value) {
    let stdout = crate::output::stdout();
    let mut out = stdout.lock();
    write_provider_removed(&mut out, data);
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
