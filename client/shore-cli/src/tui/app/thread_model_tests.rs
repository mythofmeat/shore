use super::*;
use crate::cli::ThreadStep;

fn row(id: &str, created_at: &str) -> ThreadRow {
    ThreadRow {
        id: id.to_owned(),
        created_at: created_at.to_owned(),
        ..ThreadRow::default()
    }
}

fn unread(thread: &str, count: u64) -> ThreadUnread {
    ThreadUnread {
        character: "ada".to_owned(),
        thread: thread.to_owned(),
        unread: count,
        last_active: None,
    }
}

fn threads() -> App {
    App {
        thread_folders: vec!["work".to_owned(), "fiction".to_owned()],
        threads: vec![
            row("old", "2026-11-01T00:00:00Z"),
            ThreadRow {
                last_active: Some("2026-11-09T00:00:00Z".to_owned()),
                ..row("busy", "2026-10-01T00:00:00Z")
            },
            ThreadRow {
                folder: Some("fiction".to_owned()),
                ..row("story", "2026-11-05T00:00:00Z")
            },
            ThreadRow {
                folder: Some("work".to_owned()),
                position: Some(2),
                ..row("second", "2026-11-05T00:00:00Z")
            },
            ThreadRow {
                folder: Some("work".to_owned()),
                position: Some(1),
                ..row("first", "2026-11-06T00:00:00Z")
            },
            ThreadRow {
                folder: Some("work".to_owned()),
                ..row("loose", "2026-11-07T00:00:00Z")
            },
            ThreadRow {
                heartbeat: true,
                ..row("beats", "2026-11-02T00:00:00Z")
            },
            ThreadRow {
                home: true,
                ..row("main", "2026-01-01T00:00:00Z")
            },
            ThreadRow {
                folder: Some("gone".to_owned()),
                ..row("orphan", "2026-11-03T00:00:00Z")
            },
        ],
        thread_name: "story".to_owned(),
        home_thread: "main".to_owned(),
        ..App::default()
    }
}

fn order(app: &App) -> Vec<&str> {
    app.thread_order()
        .into_iter()
        .map(|thread| thread.id.as_str())
        .collect()
}

#[test]
fn threads_run_home_then_heartbeats_then_by_folder_with_placed_ones_first() {
    assert_eq!(
        order(&threads()),
        [
            "main", "beats", "busy", "orphan", "old", "loose", "first", "second", "story"
        ],
        "loose threads newest active first, a missing folder counts as none, and \
         within a folder unplaced threads lead and placed ones follow their position"
    );
}

#[test]
fn stepping_through_threads_wraps_and_the_unread_step_skips_to_one_with_news() {
    let mut app = threads();
    assert_eq!(
        app.thread_after(ThreadStep::Next).as_deref(),
        Some("main"),
        "from the last, around to the first"
    );
    assert_eq!(
        app.thread_after(ThreadStep::Previous).as_deref(),
        Some("second")
    );
    assert_eq!(app.thread_after(ThreadStep::Unread), None, "nothing unread");
    app.record_thread_unread(unread("busy", 2));
    app.record_thread_unread(unread("story", 9));
    assert_eq!(
        app.thread_after(ThreadStep::Unread).as_deref(),
        Some("busy"),
        "never the current thread"
    );
    assert_eq!(app.unread_elsewhere(), [("busy", 2)]);

    app.thread_name = "busy".to_owned();
    assert_eq!(
        app.thread_after(ThreadStep::Unread).as_deref(),
        Some("story")
    );
    assert_eq!(
        app.thread_after(ThreadStep::Next).as_deref(),
        Some("orphan")
    );
    app.thread_name = "nowhere".to_owned();
    assert_eq!(
        app.thread_after(ThreadStep::Next).as_deref(),
        Some("main"),
        "an unknown current thread counts as the last"
    );
    assert_eq!(App::default().thread_after(ThreadStep::Next), None);
}

#[test]
fn unread_news_lands_on_its_thread_and_the_palette_and_survives_an_older_listing() {
    let mut app = threads();
    let mut news = unread("old", 3);
    news.last_active = Some("2026-11-10T00:00:00Z".to_owned());
    app.record_thread_unread(news);
    app.record_thread_unread(unread("nonexistent", 5));
    let old = app.threads.iter().find(|thread| thread.id == "old");
    assert_eq!(old.and_then(|thread| thread.unread), Some(3));
    assert_eq!(
        old.and_then(|thread| thread.last_active.as_deref()),
        Some("2026-11-10T00:00:00Z")
    );
    assert!(
        app.palette_catalog
            .threads
            .iter()
            .any(|value| value.value == "old"
                && value
                    .help
                    .as_deref()
                    .is_some_and(|help| help.contains("3 new"))),
        "{:?}",
        app.palette_catalog.threads
    );

    app.unread_listing_from = app.unread_seq;
    app.record_thread_unread(unread("busy", 4));
    for thread in &mut app.threads {
        thread.unread = None;
    }
    app.reapply_later_unread();
    let counts: Vec<(&str, u64)> = app
        .threads
        .iter()
        .filter(|thread| thread.unread_count() > 0)
        .map(|thread| (thread.id.as_str(), thread.unread_count()))
        .collect();
    assert_eq!(
        counts,
        [("busy", 4)],
        "only news that came after the listing was asked for"
    );
}

#[test]
fn a_side_thread_is_any_known_thread_other_than_home() {
    let mut app = threads();
    assert!(app.in_side_thread());
    app.thread_name = "main".to_owned();
    assert!(!app.in_side_thread());
    app.thread_name = String::new();
    assert!(!app.in_side_thread());
    app.thread_name = "story".to_owned();
    app.home_thread = String::new();
    assert!(!app.in_side_thread(), "no home known yet");
}

#[test]
fn a_thread_refresh_is_taken_only_by_its_own_answer() {
    let mut app = App::default();
    assert!(!app.take_thread_refresh(Some("anything")));
    let rid = app.begin_thread_refresh();
    assert!(rid.ends_with("_threads"));
    assert!(!app.take_thread_refresh(None));
    assert!(!app.take_thread_refresh(Some("someone-else")));
    assert!(app.take_thread_refresh(Some(&rid)));
    assert!(!app.take_thread_refresh(Some(&rid)), "taken once");
}

#[test]
fn a_model_matches_its_provider_qualified_spellings_both_ways() {
    for (active, candidate) in [
        ("opus", "opus"),
        ("anthropic.opus", "opus"),
        ("anthropic:opus", "opus"),
        ("openrouter/anthropic/opus", "opus"),
        ("opus", "anthropic.opus"),
        ("opus", "anthropic:opus"),
        ("opus", "anthropic/opus"),
    ] {
        assert!(
            App::model_identifier_matches(active, candidate),
            "{active} ~ {candidate}"
        );
    }
    for (active, candidate) in [
        ("opus", "sonnet"),
        ("anthropic:opus", "pus"),
        ("xopus", "opus"),
        ("opus-mini", "opus"),
    ] {
        assert!(
            !App::model_identifier_matches(active, candidate),
            "{active} !~ {candidate}"
        );
    }
}

#[test]
fn switching_model_clears_its_sampler_settings_and_naming_it_again_only_adds_a_spelling() {
    let mut app = App {
        effective_sampler: Some(EffectiveSamplerSnapshot::default()),
        sampler_settings_loading: true,
        pending_sampler_settings_rid: Some("r".to_owned()),
        ..App::default()
    };
    app.set_active_model(Some("anthropic:opus"));
    assert_eq!(app.model, "anthropic:opus");
    assert_eq!(app.active_model_names, ["anthropic:opus"]);
    assert!(
        app.effective_sampler.is_none()
            && !app.sampler_settings_loading
            && app.pending_sampler_settings_rid.is_none()
    );

    app.effective_sampler = Some(EffectiveSamplerSnapshot::default());
    app.set_active_model(Some("opus"));
    app.set_active_model(Some("opus"));
    assert_eq!(
        app.model, "anthropic:opus",
        "the same model under another spelling"
    );
    assert_eq!(app.active_model_names, ["anthropic:opus", "opus"]);
    assert!(
        app.effective_sampler.is_some(),
        "the same model keeps its settings"
    );

    app.set_active_model(Some("sonnet"));
    assert_eq!(
        (app.model.as_str(), app.active_model_names.clone()),
        ("sonnet", vec!["sonnet".to_owned()])
    );
    assert!(app.effective_sampler.is_none());

    app.set_active_model(Some(""));
    assert!(
        app.model.is_empty() && app.active_model_names.is_empty(),
        "an empty name is no model"
    );
    app.effective_sampler = Some(EffectiveSamplerSnapshot::default());
    app.set_active_model(None);
    assert!(
        app.effective_sampler.is_some(),
        "still no model, nothing changes"
    );
}

fn snapshot(
    model: Option<&str>,
    provider: Option<&str>,
    model_id: Option<&str>,
) -> EffectiveSamplerSnapshot {
    EffectiveSamplerSnapshot {
        model: model.map(str::to_owned),
        provider: provider.map(str::to_owned),
        model_id: model_id.map(str::to_owned),
        ..EffectiveSamplerSnapshot::default()
    }
}

#[test]
fn sampler_settings_belong_to_the_active_model_under_any_of_its_names() {
    let mut app = App::default();
    assert!(
        app.sampler_snapshot_matches_active_model(&snapshot(Some("sonnet"), None, None)),
        "no model yet, anything fits"
    );
    app.set_active_model(Some("opus"));
    assert!(
        app.sampler_snapshot_matches_active_model(&snapshot(None, None, None)),
        "an unnamed answer fits"
    );
    assert!(app.sampler_snapshot_matches_active_model(&snapshot(Some("opus"), None, None)));
    assert!(app.sampler_snapshot_matches_active_model(&snapshot(
        Some("other"),
        None,
        Some("opus")
    )));
    assert!(
        !app.sampler_snapshot_matches_active_model(&snapshot(
            None,
            Some("anthropic"),
            Some("claude-opus")
        )),
        "a provider and id not yet known as this model"
    );
    app.active_model_names
        .push("anthropic:claude-opus-4".to_owned());
    assert!(app.sampler_snapshot_matches_active_model(&snapshot(
        Some("x"),
        Some("anthropic"),
        Some("claude-opus-4")
    )));
    assert!(!app.sampler_snapshot_matches_active_model(&snapshot(
        Some("sonnet"),
        Some("anthropic"),
        Some("claude-sonnet")
    )));
    assert!(
        !app.sampler_snapshot_matches_active_model(&snapshot(None, Some("anthropic"), None)),
        "a provider alone names nothing"
    );
}

#[test]
fn an_answer_about_the_active_model_teaches_its_other_names() {
    let mut app = App {
        active_model_names: vec!["opus".to_owned()],
        ..App::default()
    };
    app.note_active_model_from_snapshot(&snapshot(
        Some("opus"),
        Some("anthropic"),
        Some("claude-opus"),
    ));
    assert_eq!(
        app.active_model_names,
        ["opus", "anthropic:claude-opus", "claude-opus"]
    );
    app.note_active_model_from_snapshot(&snapshot(Some(""), None, Some("claude-opus")));
    assert_eq!(
        app.active_model_names,
        ["opus", "anthropic:claude-opus", "claude-opus"],
        "nothing twice, nothing empty"
    );
    assert!(app.is_active_model_candidate("anthropic/claude-opus"));
    assert!(!app.is_active_model_candidate("sonnet"));
}

#[test]
fn the_active_model_is_recognised_from_its_own_name_when_no_spelling_is_known() {
    let app = App {
        model: "anthropic:opus".to_owned(),
        ..App::default()
    };
    assert!(app.is_active_model_candidate("opus"));
    assert!(
        !App::default().is_active_model_candidate("opus"),
        "no model, nothing is active"
    );
}

#[test]
fn favourites_and_subscription_models_match_under_any_spelling() {
    let mut app = App {
        subscription_model_names: vec!["anthropic:opus".to_owned()],
        ..App::default()
    };
    assert!(app.is_subscription_model_candidate("opus"));
    assert!(!app.is_subscription_model_candidate("sonnet"));
    app.set_favorite_model("opus", true);
    app.set_favorite_model("anthropic:opus", true);
    assert_eq!(
        app.favorite_model_names,
        ["opus"],
        "already a favourite under another spelling"
    );
    assert!(app.is_favorite_model_candidate("anthropic/opus"));
    app.set_favorite_model("sonnet", true);
    app.set_favorite_model("anthropic.opus", false);
    assert_eq!(app.favorite_model_names, ["sonnet"]);
}

#[test]
fn sampler_settings_answers_are_matched_to_their_request() {
    let mut app = App::default();
    assert!(!app.sampler_settings_rid_matches(Some("r")));
    let rid = app.begin_sampler_settings_refresh();
    assert!(rid.ends_with("_sampler_settings"));
    assert!(app.sampler_settings_loading);
    assert!(!app.sampler_settings_rid_matches(None));
    assert!(!app.sampler_settings_rid_matches(Some("someone-else")));
    assert!(app.sampler_settings_rid_matches(Some(&rid)));
    app.finish_sampler_settings_refresh();
    assert!(!app.sampler_settings_loading);
    assert!(!app.sampler_settings_rid_matches(Some(&rid)));
}

#[test]
fn the_palette_reports_which_menu_is_open() {
    let mut app = App::default();
    assert_eq!(app.open_submenu_parent(), None);
    assert!(
        !app.is_setting_palette_open() && !app.is_value_editor_open() && !app.is_view_submenu()
    );
    for (parent, settings) in [
        ("config", true),
        ("setting", true),
        ("setting:top_p", true),
        ("view", false),
        ("model", false),
    ] {
        app.switch_submenu(parent);
        assert_eq!(app.open_submenu_parent().as_deref(), Some(parent));
        assert_eq!(app.is_setting_palette_open(), settings, "{parent}");
        assert_eq!(app.is_view_submenu(), parent == "view");
    }
    app.enter_value_editor(
        "temperature",
        ValueEditorKind::Slider {
            min: 0.0,
            max: 1.0,
            step: 0.1,
            current: 0.5,
            typed: None,
            dirty: false,
        },
    );
    assert!(app.is_setting_palette_open() && app.is_value_editor_open());
    assert_eq!(app.open_submenu_parent(), None);

    app.switch_submenu("view");
    app.completion.selected = Some(1);
    assert!(app.selected_row_is_view_option());
    app.switch_submenu("model");
    app.model_names = vec!["opus".to_owned()];
    app.update_completions();
    app.completion.selected = Some(0);
    assert!(!app.selected_row_is_view_option());
    app.completion.selected = None;
    assert!(!app.selected_row_is_view_option());
}

type Switch = (&'static str, fn(&App) -> bool);

#[test]
fn each_view_option_reads_and_sets_its_own_switch() {
    let switches: [Switch; 7] = [
        ("timestamps", |app| app.show_timestamps),
        ("thinking", |app| app.show_thinking),
        ("tools", |app| app.show_tools),
        ("subagent", |app| app.show_subagent),
        ("compaction", |app| app.show_compaction),
        ("images", |app| app.show_images),
        ("metadata", |app| app.show_metadata),
    ];
    for (key, reads) in switches {
        let mut app = App::default();
        for enabled in [true, false] {
            assert!(app.set_view_option(key, enabled));
            assert_eq!(reads(&app), enabled, "{key}");
            assert_eq!(app.view_enabled(key), Some(enabled), "{key}");
        }
        assert_eq!(app.toggle_view_option(key), Some(true));
        assert!(reads(&app), "{key} toggled on");
        for (other, other_reads) in switches {
            if other != key {
                assert_eq!(
                    other_reads(&app),
                    other_reads(&App::default()),
                    "{key} left {other} alone"
                );
            }
        }
    }
    let mut app = App::default();
    assert!(!app.set_view_option("nonsense", true));
    assert_eq!(app.view_enabled("nonsense"), None);
    assert_eq!(app.toggle_view_option("nonsense"), None);
    assert!(app.set_view_option("usage", true));
    assert_eq!(app.usage_display, UsageDisplay::Always);
    assert_eq!(app.view_enabled("usage"), Some(true));
    assert!(app.set_view_option("usage", false));
    assert_eq!(app.view_enabled("usage"), Some(false));
    assert_eq!(app.view_enabled("budget"), Some(false));
    assert_eq!(app.toggle_view_option("budget"), Some(true));
    assert_eq!(app.view_enabled("budget"), Some(true));
}

#[test]
fn the_budget_readout_cycles_through_named_budgets_only_when_there_are_several() {
    let budget = |name: &str| UsageBudget {
        name: name.to_owned(),
        ..UsageBudget::default()
    };
    let mut app = App {
        usage_budgets: vec![budget("monthly")],
        ..App::default()
    };
    let tokens = |cycling: &mut App, steps: usize| -> Vec<String> {
        (0..steps)
            .map(|_| cycling.cycle_budget_focus().as_token())
            .collect()
    };
    assert_eq!(tokens(&mut app, 4), ["cap", "pace", "auto", "cap"]);
    app.usage_budgets.push(budget("daily"));
    app.budget_focus = BudgetFocus::default();
    assert_eq!(
        tokens(&mut app, 5),
        ["cap", "pace", "monthly", "daily", "auto"]
    );
    app.budget_focus = BudgetFocus::named("removed");
    assert_eq!(
        tokens(&mut app, 1),
        ["auto"],
        "a focus no longer in the cycle starts over"
    );
}
