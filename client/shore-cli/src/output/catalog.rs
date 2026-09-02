use std::io::{self, Write};

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
        empty(
            out,
            "client and daemon must be upgraded together to edit model settings",
        );
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
            "models": {
                "anthropic": [
                    {"name": "claude-opus-5", "qualified_name": "anthropic:claude-opus-5",
                     "hidden": false}
                ],
                "deepseek": [
                    {"name": "deepseek-v4-pro", "qualified_name": "deepseek:deepseek-v4-pro",
                     "hidden": false}
                ]
            },
            "active": "deepseek:deepseek-v4-pro",
            "roles": [
                {"role": "chat", "model": "deepseek:deepseek-v4-pro", "source": "character"},
                {"role": "heartbeat", "model": "deepseek:deepseek-v4-pro",
                 "source": "inherits chat"},
                {"role": "compaction", "model": "anthropic:claude-opus-5",
                 "source": "defaults.background.compaction"},
                {"role": "embedding", "model": null, "source": null}
            ],
            "include_hidden": false,
            "hidden_count": 440
        })
    }

    #[test]
    fn the_list_says_what_each_model_is_used_for() {
        let out = render(|b| write_model_list(b, &models()));
        for role in ["chat", "heartbeat", "compaction"] {
            assert!(out.contains(role), "{role} is missing: {out}");
        }
        assert!(
            out.contains("inherits chat"),
            "a role that borrows the chat model must say so: {out}"
        );
    }

    #[test]
    fn a_role_nobody_set_is_shown_as_unset_not_omitted() {
        let out = render(|b| write_model_list(b, &models()));
        let row = out
            .lines()
            .find(|l| l.contains("embedding"))
            .unwrap_or_default();
        assert!(
            row.contains("(not set)"),
            "an unconfigured role must still have a row: {out}"
        );
    }

    #[test]
    fn the_source_column_lines_up_across_roles() {
        let out = render(|b| write_model_list(b, &models()));
        let columns: Vec<usize> = [
            "character",
            "inherits chat",
            "defaults.background.compaction",
        ]
        .iter()
        .filter_map(|source| {
            let line = out.lines().find(|l| l.contains(*source))?;
            line.find(source)
                .map(|byte| line.get(..byte).unwrap_or("").chars().count())
        })
        .collect();
        assert_eq!(columns.len(), 3, "all three sources must render: {out}");
        assert!(
            columns.windows(2).all(|w| w.first() == w.get(1)),
            "the source is a column, not a suffix: {out}"
        );
    }

    #[test]
    fn a_list_with_no_roles_still_renders_the_catalog() {
        let mut data = models();
        if let Some(slot) = data.get_mut("roles") {
            *slot = json!([]);
        }
        let out = render(|b| write_model_list(b, &data));
        assert!(out.contains("deepseek-v4-pro"), "{out}");
        assert!(
            !out.contains("in use"),
            "an empty roles block must not print: {out}"
        );
    }

    fn with_favorite(mut data: Value, qualified: &str) -> Value {
        let groups = data
            .get_mut("models")
            .and_then(Value::as_object_mut)
            .expect("models is a group table");
        for models in groups.values_mut() {
            for model in models.as_array_mut().into_iter().flatten() {
                if text(model, "qualified_name") == qualified
                    && let Some(fields) = model.as_object_mut()
                {
                    let _replaced = fields.insert("favorite".to_owned(), json!(true));
                }
            }
        }
        data
    }

    #[test]
    fn favorites_get_their_own_section_above_the_catalog() {
        let data = with_favorite(models(), "anthropic:claude-opus-5");
        let out = render(|b| write_model_list(b, &data));
        let favorites = out.find("favorites").expect("a favorites section: {out}");
        let catalog = out
            .find("\u{2500}\u{2500} models")
            .expect("a models section");
        assert!(favorites < catalog, "favorites come first: {out}");

        let after = out.get(favorites..).unwrap_or_default();
        let opus = after.find("claude-opus-5").unwrap_or(usize::MAX);
        assert!(
            opus < catalog.saturating_sub(favorites),
            "a favorite belongs in the favorites section, not the catalog: {out}"
        );
    }

    #[test]
    fn a_model_listed_as_a_favorite_is_not_repeated_below() {
        let data = with_favorite(models(), "anthropic:claude-opus-5");
        let out = render(|b| write_model_list(b, &data));
        assert_eq!(
            out.matches("claude-opus-5").count(),
            2,
            "once in the roles block, once as a favorite: {out}"
        );
    }

    #[test]
    fn a_list_with_no_favorites_looks_exactly_as_it_did() {
        let out = render(|b| write_model_list(b, &models()));
        assert!(
            !out.contains("favorites"),
            "an empty favorites section must not print: {out}"
        );
        assert!(out.contains("deepseek-v4-pro"), "{out}");
    }

    #[test]
    fn favorites_only_drops_the_catalog_and_the_hidden_footer() {
        let mut data = with_favorite(models(), "anthropic:claude-opus-5");
        if let Some(fields) = data.as_object_mut() {
            let _replaced = fields.insert("favorites_only".to_owned(), json!(true));
        }
        let out = render(|b| write_model_list(b, &data));
        assert!(out.contains("claude-opus-5"), "{out}");
        assert!(
            !out.contains("deepseek-v4-pro\n"),
            "--favorites lists favorites only: {out}"
        );
        assert!(
            !out.contains("440 hidden"),
            "the --all footer is meaningless in a favorites-only view: {out}"
        );
    }

    #[test]
    fn favorites_only_with_nothing_favorited_says_how_to_fix_that() {
        let mut data = models();
        if let Some(fields) = data.as_object_mut() {
            let _replaced = fields.insert("favorites_only".to_owned(), json!(true));
        }
        let out = render(|b| write_model_list(b, &data));
        assert!(
            out.contains("shore model fav"),
            "an empty favorites view must name the command that fills it: {out}"
        );
    }

    #[test]
    #[ignore = "preview: .claude/skills/run-shore-cli/preview.sh models"]
    fn render_preview_models() {
        set_color_enabled(true);
        let data = json!({
            "models": {
                "anthropic": [
                    {"name": "claude-opus-5", "qualified_name": "anthropic:claude-opus-5",
                     "hidden": false}
                ],
                "opencode-go": [
                    {"name": "glm-5.2", "qualified_name": "opencode-go:glm-5.2",
                     "hidden": false},
                    {"name": "glm-5.3", "qualified_name": "opencode-go:glm-5.3",
                     "hidden": false},
                    {"name": "kimi-k3", "qualified_name": "opencode-go:kimi-k3",
                     "hidden": false}
                ]
            },
            "active": "opencode-go:glm-5.3",
            "roles": [
                {"role": "chat", "model": "opencode-go:glm-5.3", "source": "character"},
                {"role": "heartbeat", "model": "opencode-go:glm-5.3",
                 "source": "inherits chat"},
                {"role": "compaction", "model": "opencode-go:glm-5.3",
                 "source": "inherits chat"},
                {"role": "sub-agents", "model": "opencode-go:glm-5.2",
                 "source": "defaults.subagent_model"},
                {"role": "embedding", "model": "openrouter:qwen/qwen3-embedding-8b",
                 "source": "defaults.embedding"},
                {"role": "images", "model": null, "source": null}
            ],
            "include_hidden": false,
            "hidden_count": 440
        });
        let mut buf = Vec::new();
        write_model_list(&mut buf, &data);
        set_color_enabled(false);
        let mut stdout = io::stdout();
        let _ignored = stdout.write_all(b"\n----- MODEL LIST (shore model) -----\n");
        _ = stdout.write_all(&buf);
        _ = stdout.write_all(b"----- end -----\n");
        _ = stdout.flush();
    }

    #[test]
    fn the_active_model_is_marked_once_not_twice() {
        let out = render(|b| write_model_list(b, &models()));
        let catalog = out
            .split("\u{2500}\u{2500} models")
            .nth(1)
            .unwrap_or_default();
        let row = catalog
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
        assert!(
            out.contains("440 hidden \u{00b7} --all to include"),
            "{out}"
        );
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

    fn an_overview() -> Value {
        json!({
            "overview": true,
            "character": "qifei",
            "inherited_count": 2,
            "roles": [
                {
                    "role": "chat",
                    "flag": "--chat",
                    "model": "anthropic:claude-opus-5",
                    "source": "character",
                    "inherited": false,
                    "settings": [
                        {"key": "reasoning_effort", "value": "high", "scope": "character"},
                        {"key": "temperature", "value": 0.7, "scope": "global"}
                    ],
                    "same_settings_as": null,
                    "error": null
                },
                {
                    "role": "compaction",
                    "flag": "--background=compaction",
                    "model": "anthropic:claude-opus-5",
                    "source": "defaults.background.compaction",
                    "inherited": false,
                    "settings": [],
                    "same_settings_as": "chat",
                    "error": null
                },
                {
                    "role": "sub-agent: music",
                    "flag": "--subagent=music",
                    "model": "openrouter:moonshot/kimi-k3",
                    "source": "subagents.music.model",
                    "inherited": false,
                    "settings": [{"key": "max_output_tokens", "value": 4096, "scope": "character"}],
                    "same_settings_as": null,
                    "error": null
                },
                {
                    "role": "sub-agents",
                    "flag": "--subagent",
                    "model": null,
                    "source": "inherits chat",
                    "inherited": true,
                    "settings": [],
                    "same_settings_as": null,
                    "error": "sub-agents use different models (music \u{2192} kimi-k3, librarian \u{2192} opus); target one by name instead of `all`"
                }
            ]
        })
    }

    #[test]
    fn the_overview_names_every_role_and_how_to_reach_it() {
        set_color_enabled(false);
        let out = render(|b| write_model_settings(b, &an_overview()));

        for role in ["chat", "compaction", "sub-agent: music", "sub-agents"] {
            assert!(out.contains(role), "{role} must appear: {out}");
        }
        for flag in ["--chat", "--background=compaction", "--subagent=music"] {
            assert!(
                out.contains(&format!("shore model setting {flag}")),
                "{flag} must be spelled out as a command to type: {out}"
            );
        }
        assert!(out.contains("reasoning_effort"), "{out}");
        assert!(out.contains("2 more role(s) inherit"), "{out}");
    }

    #[test]
    fn the_overview_warns_when_two_roles_share_one_model() {
        set_color_enabled(false);
        let out = render(|b| write_model_settings(b, &an_overview()));
        assert!(
            out.contains("shares settings with") && out.contains("tuning either moves both"),
            "a shared model must be called out, not left to be discovered: {out}"
        );
    }

    #[test]
    fn a_role_that_cannot_resolve_says_so_rather_than_vanishing() {
        set_color_enabled(false);
        let out = render(|b| write_model_settings(b, &an_overview()));
        assert!(
            out.contains("unresolved") && out.contains("use different models"),
            "{out}"
        );
    }

    #[test]
    fn a_legacy_settings_response_requires_a_lockstep_upgrade() {
        let data = json!({
            "model": "openai:legacy",
            "effective_sampler": {"temperature": 1}
        });
        let out = render(|buffer| write_model_settings(buffer, &data));
        assert!(
            out.contains("client and daemon must be upgraded together"),
            "{out}"
        );
    }

    #[test]
    fn naming_one_setting_shows_only_that_one() {
        set_color_enabled(false);
        let data = json!({
            "model": "deepseek:deepseek-v4-pro",
            "key": "temperature",
            "effective_sampler": {"temperature": 1, "reasoning_effort": "max"},
            "setting_schema": [
                {"key":"temperature","applicability":"honored"},
                {"key":"reasoning_effort","applicability":"honored"}
            ],
            "saved_character": {"reasoning_effort": "max", "temperature": 1},
            "saved_global": null
        });
        let out = render(|b| write_model_settings(b, &data));
        assert!(out.contains("temperature"), "{out}");
        assert!(
            !out.contains("reasoning_effort"),
            "naming a key must narrow the view to it: {out}"
        );
    }

    #[test]
    fn a_named_setting_that_is_unset_says_so_instead_of_showing_nothing() {
        set_color_enabled(false);
        let data = json!({
            "model": "deepseek:deepseek-v4-pro",
            "key": "top_p",
            "effective_sampler": {"temperature": 1, "top_p": null},
            "setting_schema": [
                {"key":"temperature","applicability":"honored"},
                {"key":"top_p","applicability":"honored"}
            ],
            "saved_character": null,
            "saved_global": null
        });
        let out = render(|b| write_model_settings(b, &data));
        assert!(out.contains("built-in default"), "{out}");
    }

    #[test]
    fn settings_name_where_each_value_came_from() {
        let data = json!({
            "model": "deepseek:deepseek-v4-pro",
            "effective_sampler": {"temperature": 1, "reasoning_effort": "max"},
            "setting_schema": [
                {"key":"temperature","applicability":"honored"},
                {"key":"reasoning_effort","applicability":"honored"}
            ],
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
            "effective_sampler": {"temperature": 1, "gemini_generation": 3},
            "setting_schema": [
                {"key":"temperature","applicability":"honored"},
                {"key":"gemini_generation","applicability":"ignored"}
            ],
            "saved_character": {"gemini_generation": 3},
            "saved_global": null
        });
        let out = render(|b| write_model_settings(b, &data));
        assert!(out.contains("temperature"), "{out}");
        assert!(
            !out.contains("gemini_generation"),
            "a knob this sdk ignores must not sit in the table: {out}"
        );
        assert!(
            out.contains("1 saved setting(s) this model's sdk ignores"),
            "but it must not vanish silently either: {out}"
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
        let out = render(|b| write_model_list(b, &json!({"models": {}})));
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
