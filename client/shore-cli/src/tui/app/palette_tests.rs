use serde_json::{Value, json};

use super::*;

fn setting(
    key: &str,
    kind: &str,
    applicability: &str,
    suggestions: &[&str],
    allow_custom: bool,
) -> Value {
    json!({
        "key": key, "kind": kind, "applicability": applicability,
        "suggestions": suggestions, "allow_custom": allow_custom,
    })
}

fn slider(key: &str, min: f64, max: f64, step: f64) -> Value {
    let mut entry = setting(key, "number", "always", &[], true);
    if let Some(fields) = entry.as_object_mut() {
        let _previous = fields.insert(
            "editor".to_owned(),
            json!({ "kind": "slider", "min": min, "max": max, "step": step }),
        );
    }
    entry
}

fn sampler(schema: Value, effective: Value, scopes: Value) -> EffectiveSamplerSnapshot {
    EffectiveSamplerSnapshot::from_model_settings(&json!({
        "model": "opus", "provider": "anthropic", "model_id": "claude-opus",
        "effective_sampler": effective, "scopes": scopes, "setting_schema": schema,
    }))
    .expect("a well-formed settings answer")
}

fn settings_app() -> App {
    App {
        effective_sampler: Some(sampler(
            json!([
                slider("temperature", 0.0, 2.0, 0.1),
                setting("top_p", "number", "honored", &["0.9", "1"], true),
                setting("seed", "u32", "ignored", &[], true),
                setting(
                    "reasoning_effort",
                    "string",
                    "always",
                    &["low", "high"],
                    true
                ),
                setting("stream", "boolean", "always", &["true", "false"], false),
                setting("keepalive", "duration", "always", &["5m"], true),
                setting("timeout", "duration_or_off", "always", &["off"], true),
                setting("extra", "json_object", "always", &[], true),
            ]),
            json!({ "temperature": 0.7, "top_p": null, "reasoning_effort": "high", "stream": true }),
            json!({ "temperature": "static_default", "reasoning_effort": "model" }),
        )),
        ..App::default()
    }
}

fn filtered(app: &mut App, filter: &str) -> Vec<String> {
    app.input.cmd_text = filter.to_owned();
    app.update_completions();
    app.completion.candidates.clone()
}

fn choose(app: &mut App, row: &str) -> Option<String> {
    app.completion.selected = app
        .completion
        .candidates
        .iter()
        .position(|candidate| candidate == row);
    assert!(
        app.completion.selected.is_some(),
        "{row:?} is not offered: {:?}",
        app.completion.candidates
    );
    app.apply_submenu()
}

fn thread(id: &str) -> ThreadRow {
    ThreadRow {
        id: id.to_owned(),
        created_at: "2026-11-01T00:00:00Z".to_owned(),
        ..ThreadRow::default()
    }
}

#[test]
fn the_model_menu_matches_names_anywhere_keeps_reset_for_its_prefix_and_starts_on_the_active_model()
{
    let mut app = App {
        model_names: vec!["sonnet".into(), "opus".into(), "Opus-Mini".into()],
        model: "anthropic:opus".into(),
        ..App::default()
    };
    app.enter_submenu("model");
    assert_eq!(
        app.completion.header.as_deref(),
        Some("model \u{b7} ctrl+f favorites")
    );
    assert_eq!(
        app.completion.candidates,
        ["sonnet", "opus", "Opus-Mini", "reset"]
    );
    assert_eq!(
        app.completion.selected,
        Some(1),
        "the active model, named with its provider"
    );
    assert_eq!(filtered(&mut app, "PU"), ["opus", "Opus-Mini"]);
    assert_eq!(filtered(&mut app, "re"), ["reset"]);
    assert_eq!(
        app.completion.selected, None,
        "the active model is filtered out"
    );
    assert_eq!(choose(&mut app, "reset").as_deref(), Some("model reset"));

    app.enter_submenu("model");
    assert_eq!(
        choose(&mut app, "Opus-Mini").as_deref(),
        Some("model use Opus-Mini")
    );
}

#[test]
fn the_character_menu_matches_the_start_of_a_name_and_starts_on_the_current_character() {
    let character = CharacterInfo::new;
    let mut app = App {
        characters: vec![character("Ada"), character("bob"), character("adele")],
        character_name: "bob".into(),
        ..App::default()
    };
    app.enter_submenu("character");
    assert_eq!(app.completion.header, None);
    assert_eq!(app.completion.candidates, ["Ada", "bob", "adele"]);
    assert_eq!(app.completion.selected, Some(1));
    assert_eq!(filtered(&mut app, "AD"), ["Ada", "adele"]);
    assert_eq!(
        filtered(&mut app, "da"),
        Vec::<String>::new(),
        "only the start of a name matches"
    );
    let _shown = filtered(&mut app, "");
    assert_eq!(
        choose(&mut app, "adele").as_deref(),
        Some("character use adele")
    );

    let mut nameless = App {
        characters: vec![character("Ada")],
        ..App::default()
    };
    nameless.enter_submenu("character");
    assert_eq!(
        nameless.completion.selected, None,
        "no current character, nothing preselected"
    );
}

#[test]
fn the_thread_menu_lists_facts_matches_ids_and_labels_and_starts_on_the_current_thread() {
    let mut app = App {
        thread_name: "story".into(),
        thread_folders: vec!["fiction".into()],
        threads: vec![
            ThreadRow {
                home: true,
                turns: Some(3),
                ..thread("main")
            },
            ThreadRow {
                label: Some("The Storm".into()),
                purpose: Some("a  story\nabout   weather".into()),
                folder: Some("fiction".into()),
                unread: Some(2),
                turns: Some(1),
                warm: true,
                model: Some("opus".into()),
                locked: true,
                ..thread("story")
            },
            ThreadRow {
                heartbeat: true,
                turns: Some(0),
                ..thread("beats")
            },
        ],
        ..App::default()
    };
    app.enter_submenu("thread");
    assert_eq!(
        app.completion.header.as_deref(),
        Some("thread \u{b7} home gets what own time sends")
    );
    assert_eq!(
        app.completion.candidates,
        [
            "main \u{2014} home \u{b7} 3 turns",
            "beats \u{2014} own time \u{b7} empty",
            "story \u{2014} in fiction \u{b7} 2 new \u{b7} 1 turn \u{b7} warm \u{b7} opus \u{b7} locked \u{b7} The Storm",
        ]
    );
    assert_eq!(app.completion.selected, Some(2));
    assert_eq!(
        app.completion
            .candidates
            .get(2)
            .and_then(|row| app.command_description(row))
            .as_deref(),
        Some("a story about weather")
    );
    assert_eq!(filtered(&mut app, "STORM").len(), 1, "a label matches");
    assert_eq!(filtered(&mut app, "eat").len(), 1, "an id matches anywhere");
    let _shown = filtered(&mut app, "");
    assert_eq!(
        choose(&mut app, "beats \u{2014} own time \u{b7} empty").as_deref(),
        Some("thread use beats")
    );
}

#[test]
fn a_thread_active_in_the_future_reads_as_just_now() {
    let row = ThreadRow {
        last_active: Some("2999-01-01T00:00:00Z".into()),
        ..thread("story")
    };
    assert_eq!(App::thread_row_label(&row), "story \u{2014} 0s ago");
}

#[test]
fn the_setting_menu_waits_for_settings_and_says_when_there_are_none() {
    let mut app = settings_app();
    app.enter_submenu("setting");
    assert_eq!(app.completion.header.as_deref(), Some("setting key"));
    assert_eq!(app.completion.candidates, ["loading sampler settings..."]);
    assert_eq!(app.completion.selected, None);
    assert_eq!(choose(&mut app, "loading sampler settings..."), None);
    assert!(
        app.is_submenu_open("setting"),
        "nothing happens while loading"
    );

    let mut none = App::default();
    none.switch_submenu("setting");
    assert_eq!(none.completion.candidates, ["sampler settings unavailable"]);
    none.switch_submenu("setting:temperature");
    assert_eq!(none.completion.header.as_deref(), Some("setting value"));
    assert_eq!(none.completion.candidates, ["sampler settings unavailable"]);
    assert_eq!(choose(&mut none, "sampler settings unavailable"), None);
    none.switch_submenu("setting:reset");
    assert_eq!(choose(&mut none, "sampler settings unavailable"), None);
}

#[test]
fn the_setting_menu_shows_the_settings_this_model_uses_with_their_values() {
    let mut app = settings_app();
    app.switch_submenu("setting");
    assert_eq!(
        app.completion.candidates,
        [
            "temperature = 0.7",
            "top_p = unset",
            "reasoning_effort = high",
            "stream = true",
            "keepalive = unset",
            "timeout = unset",
            "extra = unset",
            "reset",
        ]
    );
    assert_eq!(
        app.completion.selected,
        Some(2),
        "the first setting set above its default"
    );
    assert_eq!(
        filtered(&mut app, "t"),
        ["temperature = 0.7", "top_p = unset", "timeout = unset"]
    );
    assert_eq!(filtered(&mut app, "res"), ["reset"]);
    assert_eq!(choose(&mut app, "reset"), None);
    assert!(app.is_submenu_open("setting:reset"));
    assert_eq!(
        app.completion.candidates,
        [
            "temperature",
            "top_p",
            "reasoning_effort",
            "stream",
            "keepalive",
            "timeout",
            "extra"
        ]
    );
    assert_eq!(filtered(&mut app, "re"), ["reasoning_effort"]);
    assert_eq!(
        choose(&mut app, "reasoning_effort").as_deref(),
        Some("setting reasoning_effort --reset")
    );
    assert!(
        !app.is_submenu_open("setting:reset"),
        "the menu closes once applied"
    );
}

#[test]
fn a_slider_setting_opens_the_value_editor_and_others_a_value_menu() {
    let mut app = settings_app();
    app.switch_submenu("setting");
    assert_eq!(choose(&mut app, "temperature = 0.7"), None);
    assert!(app.is_value_editor_open());
    assert_eq!(
        app.apply_value_editor().as_deref(),
        Some("setting temperature 0.7")
    );

    let mut menu = settings_app();
    menu.switch_submenu("setting");
    assert_eq!(choose(&mut menu, "reasoning_effort = high"), None);
    assert!(menu.is_submenu_open("setting:reasoning_effort"));
    assert_eq!(menu.completion.candidates, ["low", "high", "reset"]);
    assert_eq!(menu.completion.selected, Some(1), "the value in effect");
    assert_eq!(
        choose(&mut menu, "low").as_deref(),
        Some("setting reasoning_effort low")
    );
}

#[test]
fn a_value_menu_offers_a_typed_value_of_the_right_kind_as_custom() {
    let mut app = settings_app();
    let offered = |menu: &mut App, key: &str, typed: &str| {
        menu.switch_submenu(&format!("setting:{key}"));
        filtered(menu, typed)
    };
    assert_eq!(offered(&mut app, "top_p", "0.95"), ["Custom: 0.95"]);
    assert_eq!(
        offered(&mut app, "top_p", "0.9"),
        ["0.9"],
        "a suggestion is not repeated"
    );
    assert_eq!(offered(&mut app, "top_p", "lots"), Vec::<String>::new());
    assert_eq!(offered(&mut app, "seed", "42"), ["Custom: 42"]);
    assert_eq!(offered(&mut app, "seed", "-1"), Vec::<String>::new());
    assert_eq!(
        offered(&mut app, "extra", "{\"a\":1}"),
        ["Custom: {\"a\":1}"]
    );
    assert_eq!(offered(&mut app, "extra", "[1]"), Vec::<String>::new());
    assert_eq!(
        offered(&mut app, "stream", "maybe"),
        Vec::<String>::new(),
        "a boolean takes only its two"
    );
    assert_eq!(
        offered(&mut app, "reasoning_effort", "medium"),
        ["Custom: medium"]
    );
    assert_eq!(offered(&mut app, "keepalive", "10m"), ["Custom: 10m"]);
    assert_eq!(offered(&mut app, "keepalive", "OFF"), Vec::<String>::new());
    assert_eq!(offered(&mut app, "timeout", "off"), ["off"]);
    assert_eq!(offered(&mut app, "timeout", "30s"), ["Custom: 30s"]);
    assert_eq!(
        offered(&mut app, "reasoning_effort", "RESET"),
        ["reset"],
        "never a custom value"
    );
    assert_eq!(offered(&mut app, "reasoning_effort", "reset"), ["reset"]);
    assert_eq!(offered(&mut app, "nonexistent", ""), Vec::<String>::new());

    let _custom = offered(&mut app, "top_p", "0.95");
    assert_eq!(
        choose(&mut app, "Custom: 0.95").as_deref(),
        Some("setting top_p 0.95")
    );
    let _cleared = offered(&mut app, "top_p", "");
    assert_eq!(
        choose(&mut app, "reset").as_deref(),
        Some("setting top_p --reset")
    );
}

#[test]
fn the_value_in_effect_is_preselected_even_when_typed_as_custom() {
    let app = settings_app();
    assert!(app.is_effective_setting_candidate("reasoning_effort", "high"));
    assert!(app.is_effective_setting_candidate("reasoning_effort", "Custom:  high "));
    assert!(!app.is_effective_setting_candidate("reasoning_effort", "low"));
    assert!(!app.is_effective_setting_candidate("reasoning_effort", "reset"));
    assert!(!App::default().is_effective_setting_candidate("reasoning_effort", "high"));
}

#[test]
fn the_view_menu_toggles_a_row_in_place_and_says_what_it_did() {
    let mut app = App {
        show_timestamps: true,
        show_tools: false,
        show_metadata: false,
        ..App::default()
    };
    app.enter_submenu("view");
    assert_eq!(app.completion.header.as_deref(), Some("view option"));
    assert_eq!(
        app.completion.candidates,
        [
            "timestamps = on",
            "thinking = on",
            "tools = off",
            "subagent = on",
            "images = on",
            "metadata = off",
            "usage = off",
            "budget = auto",
        ]
    );
    assert_eq!(
        filtered(&mut app, "t"),
        ["timestamps = on", "thinking = on", "tools = off"]
    );
    assert_eq!(choose(&mut app, "thinking = on"), None);
    assert!(!app.show_thinking);
    assert_eq!(
        app.completion.candidates.get(1).map(String::as_str),
        Some("thinking = off")
    );
    assert_eq!(
        app.completion.selected,
        Some(1),
        "the toggled row stays selected"
    );
    assert!(
        app.notifications
            .iter()
            .any(|n| n.content == "view thinking: off")
    );

    let _all = filtered(&mut app, "");
    assert_eq!(choose(&mut app, "usage = off"), None);
    assert_eq!(app.usage_display, UsageDisplay::Off.cycled());
    assert_eq!(choose(&mut app, "budget = auto"), None);
    assert_ne!(app.budget_focus, BudgetFocus::default());
}

#[test]
fn the_config_menu_leads_with_model_character_and_thread_then_settings_then_view() {
    let mut app = App {
        model: "opus".into(),
        thread_name: "story".into(),
        ..settings_app()
    };
    app.switch_submenu("config");
    assert_eq!(app.completion.header.as_deref(), Some("what to change"));
    let rows = app.completion.candidates.clone();
    assert_eq!(
        rows.iter().take(4).map(String::as_str).collect::<Vec<_>>(),
        [
            "model = opus",
            "character = unset",
            "thread = story",
            "temperature = 0.7"
        ]
    );
    assert!(rows.contains(&"reset".to_owned()));
    assert!(rows.ends_with(&["usage = off".to_owned(), "budget = auto".to_owned()]));
    assert_eq!(
        filtered(&mut app, "th"),
        ["thread = story", "thinking = on"]
    );

    assert_eq!(choose(&mut app, "thread = story"), None);
    assert!(app.is_submenu_open("thread"));

    app.switch_submenu("config");
    let _all = filtered(&mut app, "");
    assert_eq!(choose(&mut app, "thinking = on"), None);
    assert!(!app.show_thinking, "a view row toggles in place");
    assert!(app.is_submenu_open("config"));

    assert_eq!(choose(&mut app, "reset"), None);
    assert!(app.is_submenu_open("setting:reset"));

    app.switch_submenu("config");
    assert_eq!(choose(&mut app, "temperature = 0.7"), None);
    assert!(app.is_value_editor_open());

    app.switch_submenu("config");
    assert_eq!(choose(&mut app, "top_p = unset"), None);
    assert!(app.is_submenu_open("setting:top_p"));
}

#[test]
fn the_config_menu_shows_the_settings_state_only_where_settings_would_be() {
    let mut loading = App {
        sampler_settings_loading: true,
        ..settings_app()
    };
    loading.switch_submenu("config");
    assert!(
        loading
            .completion
            .candidates
            .contains(&"loading sampler settings...".to_owned())
    );
    assert_eq!(
        filtered(&mut loading, "temp"),
        ["loading sampler settings..."],
        "a filter that matches a setting still says why it can't be edited"
    );
    assert_eq!(filtered(&mut loading, "thr"), ["thread = unset"]);
    assert_eq!(choose(&mut loading, "thread = unset"), None);
    assert!(
        loading.is_submenu_open("thread"),
        "model, character and thread still open"
    );

    loading.switch_submenu("config");
    let _all = filtered(&mut loading, "");
    assert_eq!(choose(&mut loading, "loading sampler settings..."), None);
    assert!(
        loading.is_submenu_open("config"),
        "a blocked row does nothing"
    );

    let mut unavailable = App::default();
    unavailable.switch_submenu("config");
    assert!(
        !unavailable
            .completion
            .candidates
            .contains(&"sampler settings unavailable".to_owned()),
        "with no settings at all there is nothing to explain: {:?}",
        unavailable.completion.candidates
    );
    assert!(
        !unavailable
            .completion
            .candidates
            .contains(&"reset".to_owned())
    );
}

#[test]
fn a_slider_starts_at_the_value_in_effect_quantized_or_in_the_middle_when_unknown() {
    let mut app = settings_app();
    app.switch_submenu("setting");
    let _known_editor = choose(&mut app, "temperature = 0.7");
    app.adjust_value_editor(1.0);
    assert_eq!(
        app.apply_value_editor().as_deref(),
        Some("setting temperature 0.8")
    );

    let mut unknown = App {
        effective_sampler: Some(sampler(
            json!([slider("temperature", 0.0, 2.0, 0.5)]),
            json!({}),
            json!({}),
        )),
        ..App::default()
    };
    unknown.switch_submenu("setting");
    let _unknown_editor = choose(&mut unknown, "temperature = unset");
    assert_eq!(
        unknown.apply_value_editor().as_deref(),
        Some("setting temperature 1.0")
    );

    let mut edge = App {
        effective_sampler: Some(sampler(
            json!([slider("temperature", 0.0, 2.0, 0.5)]),
            json!({ "temperature": 1.3 }),
            json!({}),
        )),
        ..App::default()
    };
    edge.switch_submenu("setting");
    let _edge_editor = choose(&mut edge, "temperature = 1.3");
    assert_eq!(
        edge.apply_value_editor().as_deref(),
        Some("setting temperature 1.5"),
        "snapped to a step"
    );
}

#[test]
fn a_slider_value_is_clamped_to_its_range_and_snapped_to_its_steps() {
    assert_eq!(App::quantize_slider_value(0.0, 2.0, 0.5, 2.6), 2.0);
    assert_eq!(App::quantize_slider_value(0.0, 2.0, 0.5, -1.0), 0.0);
    assert_eq!(App::quantize_slider_value(0.0, 2.0, 0.5, 0.74), 0.5);
    assert_eq!(App::quantize_slider_value(0.0, 2.0, 0.5, 0.76), 1.0);
    assert_eq!(
        App::quantize_slider_value(1.0, 3.0, 0.5, 1.26),
        1.5,
        "steps count from the minimum"
    );
    assert_eq!(
        App::quantize_slider_value(0.0, 2.0, 0.0, 0.33),
        0.33,
        "no step, no snapping"
    );
    assert_eq!(
        App::quantize_slider_value(0.0, 2.0, -1.0, 3.0),
        2.0,
        "no step, still clamped"
    );
    assert!(
        (App::quantize_slider_value(0.0, 1.0, 0.3, 0.95) - 0.9).abs() < 1e-9,
        "a last partial step never passes the maximum"
    );
}

#[test]
fn a_settings_answer_with_an_unknown_kind_is_refused_whole() {
    let kinds = [
        "number",
        "u32",
        "boolean",
        "string",
        "duration",
        "duration_or_off",
        "json_object",
    ];
    let schema: Vec<Value> = kinds
        .iter()
        .map(|kind| setting(kind, kind, "always", &[], false))
        .collect();
    let snapshot = sampler(Value::Array(schema), json!({}), json!({}));
    let parsed: Vec<SettingKind> = snapshot
        .setting_schema
        .iter()
        .map(|entry| entry.kind.clone())
        .collect();
    assert_eq!(
        parsed,
        [
            SettingKind::Number,
            SettingKind::U32,
            SettingKind::Boolean,
            SettingKind::String,
            SettingKind::Duration,
            SettingKind::DurationOrOff,
            SettingKind::JsonObject,
        ]
    );
    let unknown = json!({
        "effective_sampler": {},
        "setting_schema": [setting("temperature", "number", "always", &[], true), setting("odd", "matrix", "always", &[], true)],
    });
    assert_eq!(
        EffectiveSamplerSnapshot::from_model_settings(&unknown),
        None
    );
    let not_a_slider = json!({
        "effective_sampler": {},
        "setting_schema": [{
            "key": "temperature", "kind": "number", "applicability": "always",
            "suggestions": [], "allow_custom": true,
            "editor": { "kind": "dial", "min": 0, "max": 2, "step": 0.1 },
        }],
    });
    let dial = EffectiveSamplerSnapshot::from_model_settings(&not_a_slider).unwrap();
    assert_eq!(
        dial.setting_schema
            .first()
            .map(|entry| entry.editor.clone()),
        Some(None)
    );
}
