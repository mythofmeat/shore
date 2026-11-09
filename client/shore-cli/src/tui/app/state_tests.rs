use std::time::{Duration, Instant};

use serde_json::json;

use super::*;

fn described(block: &Block) -> String {
    match block {
        Block::Text(text) => format!("text:{text}"),
        Block::Thinking(text) => format!("thinking:{text}"),
        Block::ToolUse { tool_name, .. } => format!("tool:{tool_name}"),
        Block::ToolResult {
            tool_name,
            output,
            is_error,
            ..
        } => format!(
            "result:{tool_name}={output}{}",
            if *is_error { "!" } else { "" }
        ),
        Block::SubagentBegin(name) => format!("begin:{name}"),
        Block::SubagentEnd(name) => format!("end:{name}"),
    }
}

fn blocks_of(entry: Option<&ConversationEntry>) -> Vec<String> {
    entry
        .and_then(ConversationEntry::as_turn)
        .map_or_else(Vec::new, |turn| turn.blocks.iter().map(described).collect())
}

fn said(role: Role, text: &str) -> ConversationEntry {
    ConversationEntry::Turn(Turn::text(
        role,
        Some(format!("m_{text}")),
        text.to_owned(),
        Vec::new(),
        "2026-11-10T00:00:00Z".to_owned(),
        None,
    ))
}

#[test]
fn a_stream_builds_one_turn_merging_runs_of_text_and_of_thinking() {
    let mut app = App {
        entries: vec![said(Role::User, "hi")],
        ..App::default()
    };
    app.stream_append_thinking("let me ");
    app.stream_append_thinking("think");
    app.stream_append_text("hel");
    app.stream_append_text("lo");
    app.stream_push_tool_call("t_1".to_owned(), "read".to_owned(), json!({}));
    app.stream_push_tool_result("read".to_owned(), "contents".to_owned(), Vec::new(), true);
    app.stream_append_text("done");
    app.stream_append_thinking("again");
    assert_eq!(
        app.entries.len(),
        2,
        "one streaming turn for the whole reply"
    );
    assert_eq!(
        blocks_of(app.entries.last()),
        [
            "thinking:let me think",
            "text:hello",
            "tool:read",
            "result:read=contents!",
            "text:done",
            "thinking:again",
        ]
    );
    assert!(
        app.entries
            .last()
            .and_then(ConversationEntry::as_turn)
            .is_some_and(Turn::is_streaming)
    );
}

#[test]
fn a_failed_stream_keeps_what_arrived_and_drops_a_turn_that_never_started() {
    let mut started = App::default();
    started.stream.active = true;
    started.stream_append_text("partial");
    started.fail_stream();
    assert_eq!(blocks_of(started.entries.last()), ["text:partial"]);
    assert!(
        started
            .entries
            .last()
            .and_then(ConversationEntry::as_turn)
            .is_some_and(|turn| !turn.is_streaming())
    );
    assert!(!started.stream.active);

    let mut empty = App {
        entries: vec![said(Role::User, "hi")],
        ..App::default()
    };
    let _streaming = empty.ensure_streaming_turn();
    empty.fail_stream();
    assert_eq!(empty.entries.len(), 1, "the empty reply goes");

    let mut settled = App {
        entries: vec![said(Role::User, "hi"), said(Role::Assistant, "hello")],
        ..App::default()
    };
    settled.fail_stream();
    assert_eq!(settled.entries.len(), 2, "a finished reply is left alone");
}

#[test]
fn an_aborted_stream_removes_its_turn_and_a_regeneration_forgets_what_it_replaced() {
    let mut app = App {
        entries: vec![said(Role::User, "hi"), said(Role::Assistant, "hello")],
        scroll_offset: 4,
        auto_scroll: false,
        spinner_frame: 3,
        ..App::default()
    };
    app.begin_regen_optimistic();
    assert!(app.stream.active && app.stream.regen);
    assert_eq!(app.replaced.ids, ["m_hello"]);
    assert_eq!(app.spinner_frame, 0);
    assert_eq!(app.scroll_offset, 0);
    assert!(app.auto_scroll);
    app.stream_append_text("new");
    app.abort_stream();
    assert_eq!(app.entries.len(), 2);
    assert!(!app.stream.active);
    assert!(
        app.replaced.ids.is_empty(),
        "the replaced reply is shown again"
    );
}

#[test]
fn sub_agent_tasks_are_kept_by_their_tool_call_and_settle_as_done_or_failed() {
    let mut app = App::default();
    app.stream.rid = Some("r_1".to_owned());
    app.begin_subagent_task("t_1", "memory", "what did we say".to_owned());
    app.begin_subagent_task("t_2", "music", "play".to_owned());
    assert_eq!(
        app.subagent_task_index("t_1", Some("renamed")),
        0,
        "the same call is the same task"
    );
    assert_eq!(app.subagent_task_index("t_3", None), 2);
    assert_eq!(app.subagent_task_index("t_3", Some("late")), 2);
    let names: Vec<&str> = app
        .subagent_tasks
        .iter()
        .map(|task| task.name.as_str())
        .collect();
    assert_eq!(
        names,
        ["memory", "music", "late"],
        "a name is filled in only when missing"
    );
    assert_eq!(
        app.subagent_tasks
            .first()
            .and_then(|task| task.parent_request_id.as_deref()),
        Some("r_1")
    );
    assert_eq!(
        app.subagent_tasks.first().map(|task| task.query.as_str()),
        Some("what did we say")
    );
    assert_eq!(app.running_subagent_count(), 3);

    app.subagent_task_append_text(0, "fou");
    app.subagent_task_append_text(0, "nd");
    app.subagent_task_append_thinking(0, "hm");
    app.subagent_task_append_thinking(0, "m");
    app.subagent_task_push_block(0, Block::SubagentEnd("memory".to_owned()));
    app.subagent_task_append_text(9, "nowhere");
    let first_blocks: Vec<String> = app
        .subagent_tasks
        .first()
        .map_or_else(Vec::new, |task| task.blocks.iter().map(described).collect());
    assert_eq!(first_blocks, ["text:found", "thinking:hmm", "end:memory"]);

    app.settle_subagent_task("t_1", "remembered", false);
    app.settle_subagent_task("t_2", "no speakers", true);
    app.settle_subagent_task("t_9", "unknown", false);
    let settled: Vec<(&str, Option<&str>)> = app
        .subagent_tasks
        .iter()
        .map(|task| (task.status.as_str(), task.detail.as_deref()))
        .collect();
    assert_eq!(
        settled,
        [
            ("done", Some("remembered")),
            ("error", Some("no speakers")),
            ("running", None)
        ]
    );
    assert_eq!(app.running_subagent_count(), 1);

    app.begin_subagent_task("t_2", "music", "try again".to_owned());
    assert_eq!(
        app.subagent_tasks
            .get(1)
            .map(|task| (task.status.as_str(), task.detail.clone())),
        Some(("running", None))
    );
}

#[test]
fn the_sub_agent_panel_opens_on_a_running_task_and_steps_around_the_list() {
    let mut app = App::default();
    app.open_subagent_panel();
    assert_eq!(app.subagent_panel, None, "nothing to show");
    app.select_subagent_task(1);
    assert_eq!(app.subagent_panel, None);

    for id in ["t_1", "t_2", "t_3"] {
        app.begin_subagent_task(id, "memory", String::new());
    }
    app.settle_subagent_task("t_1", "", false);
    app.open_subagent_panel();
    assert_eq!(app.subagent_panel, Some(1), "the first one still running");
    app.select_subagent_task(-2);
    assert_eq!(app.subagent_panel, Some(2));
    app.select_subagent_task(1);
    assert_eq!(app.subagent_panel, Some(0));

    for id in ["t_2", "t_3"] {
        app.settle_subagent_task(id, "", false);
    }
    app.open_subagent_panel();
    assert_eq!(
        app.subagent_panel,
        Some(2),
        "the latest when none is running"
    );

    app.scroll_subagent_panel(5);
    app.scroll_subagent_panel(-2);
    let task = app
        .subagent_tasks
        .get(2)
        .map(|view| (view.scroll, view.follow));
    assert_eq!(
        task,
        Some((3, false)),
        "scrolling back stops following the output"
    );
    app.scroll_subagent_panel(-9);
    assert_eq!(app.subagent_tasks.get(2).map(|view| view.scroll), Some(0));
    if let Some(view) = app.subagent_tasks.get_mut(2) {
        view.follow = true;
    }
    app.scroll_subagent_panel(1);
    assert_eq!(
        app.subagent_tasks.get(2).map(|view| view.follow),
        Some(true),
        "scrolling on keeps following"
    );
}

#[test]
fn an_edit_prefill_is_used_only_by_its_own_answer() {
    let mut app = App::default();
    let rid = app.begin_edit_prefill("m_7");
    assert!(rid.ends_with("_edit_prefill"));
    assert_eq!(app.take_edit_prefill(Some("someone-else")), None);
    assert_eq!(app.take_edit_prefill(None), None);
    assert_eq!(app.take_edit_prefill(Some(&rid)).as_deref(), Some("m_7"));
    assert_eq!(app.take_edit_prefill(Some(&rid)), None, "used once");

    let cancelled = app.begin_edit_prefill("m_8");
    app.cancel_edit_prefill();
    assert_eq!(app.take_edit_prefill(Some(&cancelled)), None);
}

#[test]
fn palette_answers_are_matched_to_their_requests_and_a_reconnect_drops_them() {
    let mut app = App::default();
    let command = app.begin_palette_command("thread list");
    assert!(command.ends_with("_palette"));
    assert_eq!(app.take_palette_command(None), None);
    assert_eq!(
        app.take_palette_command(Some(&command)).as_deref(),
        Some("thread list")
    );
    assert_eq!(app.take_palette_command(Some(&command)), None);

    let segments = app.begin_palette_catalog_request(crate::completion::Source::Segments);
    assert!(segments.ends_with("_palette_catalog"));
    app.needed_palette_sources = vec![
        crate::completion::Source::Segments,
        crate::completion::Source::Calls,
    ];
    assert_eq!(
        app.take_needed_palette_sources(),
        [crate::completion::Source::Calls],
        "a source already asked for is not asked for again"
    );
    assert!(app.needed_palette_sources.is_empty());
    assert_eq!(app.take_palette_catalog_request(None), None);
    assert_eq!(
        app.take_palette_catalog_request(Some(&segments)),
        Some(crate::completion::Source::Segments)
    );

    let _pending = app.begin_palette_catalog_request(crate::completion::Source::Calls);
    app.needed_palette_sources = vec![crate::completion::Source::Segments];
    app.palette_catalog_loaded = true;
    app.palette_catalog.threads = vec![crate::completion::PaletteValue::plain("main")];
    app.palette_catalog.models = vec![crate::completion::PaletteValue::plain("opus")];
    app.invalidate_palette_catalog();
    assert!(!app.palette_catalog_loaded);
    assert!(app.pending_palette_catalog.is_empty());
    assert!(app.needed_palette_sources.is_empty());
    assert!(app.palette_catalog.threads.is_empty());
    assert_eq!(
        app.palette_catalog.models.len(),
        1,
        "the TUI's own values stay"
    );
}

#[test]
fn command_output_opens_a_pager_that_scrolls_within_its_text() {
    let mut app = App::default();
    assert!(!app.reopen_output_pager());
    app.scroll_output_pager(3);
    app.push_command_text("thread list", "one\ntwo\nthree\nfour\nfive".to_owned());
    if let Some(pager) = app.output_pager.as_mut() {
        pager.viewport = 2;
    }
    let scroll = |paged: &App| paged.output_pager.as_ref().map(|pager| pager.scroll);
    app.scroll_output_pager(2);
    assert_eq!(scroll(&app), Some(2));
    app.scroll_output_pager(10);
    assert_eq!(scroll(&app), Some(3), "the last page is as far as it goes");
    app.scroll_output_pager(-1);
    assert_eq!(scroll(&app), Some(2));
    app.scroll_output_pager(-9);
    assert_eq!(scroll(&app), Some(0));
    app.scroll_output_pager(1);
    assert!(app.reopen_output_pager());
    assert_eq!(scroll(&app), Some(0), "reopened at the top");
    assert_eq!(
        app.output_pager
            .as_ref()
            .map(|pager| pager.command.as_str()),
        Some("thread list")
    );
}

#[test]
fn scrolling_up_stops_following_and_reaching_the_bottom_follows_again() {
    let mut app = App::default();
    app.scroll_up(3);
    assert_eq!((app.scroll_offset, app.auto_scroll), (3, false));
    app.scroll_down(1);
    assert_eq!((app.scroll_offset, app.auto_scroll), (2, false));
    app.scroll_down(5);
    assert_eq!((app.scroll_offset, app.auto_scroll), (0, true));
    app.scroll_up(4);
    app.scroll_to_bottom();
    assert_eq!((app.scroll_offset, app.auto_scroll), (0, true));
}

#[test]
fn a_repeated_notification_counts_up_and_the_oldest_passing_one_makes_room() {
    let mut app = App::default();
    app.set_status("saved");
    app.set_status("saved");
    app.set_warning("saved");
    app.set_critical_error("disk full");
    app.set_critical_error("disk full");
    let shown: Vec<(&str, NotificationLevel, u32, bool)> = app
        .notifications
        .iter()
        .map(|n| (n.content.as_str(), n.level, n.count, n.sticky))
        .collect();
    assert_eq!(
        shown,
        [
            ("saved", NotificationLevel::Info, 2, false),
            ("saved", NotificationLevel::Warning, 1, false),
            ("disk full", NotificationLevel::Error, 2, true),
        ]
    );
    app.notify(NotificationLevel::Error, "disk full");
    assert_eq!(
        app.notifications.len(),
        4,
        "a passing error is not the sticky one"
    );
    app.set_status("one more");
    let kept: Vec<&str> = app
        .notifications
        .iter()
        .map(|n| n.content.as_str())
        .collect();
    assert_eq!(
        kept,
        ["saved", "disk full", "disk full", "one more"],
        "the oldest passing one went"
    );
    assert_eq!(
        app.notifications.first().map(|n| n.level),
        Some(NotificationLevel::Warning)
    );
}

#[test]
fn notifications_pass_after_their_time_but_a_sticky_one_stays_until_dismissed() {
    let mut app = App::default();
    app.set_status("saved");
    app.set_critical_error("disk full");
    let created = app
        .notifications
        .first()
        .map_or_else(Instant::now, |n| n.created);
    assert!(
        !app.expire_notifications(created),
        "nothing has expired yet"
    );
    assert!(
        !app.expire_notifications(created + NOTIFICATION_TTL - Duration::from_millis(1)),
        "not before its time"
    );
    assert_eq!(app.notifications.len(), 2);
    assert!(
        app.expire_notifications(created + NOTIFICATION_TTL),
        "gone exactly at its time"
    );
    let left: Vec<&str> = app
        .notifications
        .iter()
        .map(|n| n.content.as_str())
        .collect();
    assert_eq!(left, ["disk full"]);
    assert!(!app.expire_notifications(created + NOTIFICATION_TTL + Duration::from_secs(60)));
    assert!(app.dismiss_latest_notification());
    assert!(!app.dismiss_latest_notification());
    assert_eq!(app.error_log, ["disk full"]);
}

fn alt(index: u32, content: &str, active: bool) -> AltChoice {
    AltChoice {
        index,
        position: index,
        active,
        content: content.to_owned(),
        images: Vec::new(),
        timestamp: format!("2026-11-10T00:00:0{index}Z"),
    }
}

#[test]
fn the_alternate_picker_previews_each_reply_in_place_and_restores_on_cancel() {
    let mut app = App {
        entries: vec![
            said(Role::User, "hi"),
            said(Role::Assistant, "first"),
            said(Role::User, "and"),
            said(Role::Assistant, "second"),
        ],
        ..App::default()
    };
    app.start_alt_picker(Some("m_first".to_owned()));
    app.next_alt();
    app.prev_alt();
    assert_eq!(app.selected_alt_command_args(), None, "still loading");
    let version = app.history_version;
    app.populate_alt_picker(
        Some("m_first".to_owned()),
        vec![
            alt(0, "first", false),
            alt(1, "other", true),
            alt(2, "", false),
        ],
    );
    assert_eq!(
        blocks_of(app.entries.get(1)),
        ["text:other"],
        "the active alternate is shown"
    );
    assert_ne!(app.history_version, version);
    assert_eq!(
        app.selected_alt_command_args(),
        Some(json!({ "index": 1, "ref": "m_first" }))
    );
    app.next_alt();
    assert_eq!(
        blocks_of(app.entries.get(1)),
        Vec::<String>::new(),
        "an empty alternate shows nothing"
    );
    app.next_alt();
    assert_eq!(blocks_of(app.entries.get(1)), ["text:first"]);
    app.prev_alt();
    assert_eq!(
        blocks_of(app.entries.get(1)),
        Vec::<String>::new(),
        "back past the first wraps to the last"
    );
    app.prev_alt();
    assert_eq!(blocks_of(app.entries.get(1)), ["text:other"]);
    assert_eq!(
        blocks_of(app.entries.get(3)),
        ["text:second"],
        "other replies are untouched"
    );
    app.cancel_alt_picker();
    assert_eq!(blocks_of(app.entries.get(1)), ["text:first"]);
    assert!(app.alt_picker.is_none());
}

#[test]
fn an_alternate_picker_with_no_target_previews_the_latest_reply_and_closes_when_there_are_none() {
    let mut app = App {
        entries: vec![said(Role::User, "hi"), said(Role::Assistant, "only")],
        ..App::default()
    };
    app.populate_alt_picker(None, vec![alt(0, "only", false), alt(1, "else", false)]);
    assert_eq!(
        blocks_of(app.entries.get(1)),
        ["text:only"],
        "the first when none is active"
    );
    app.next_alt();
    assert_eq!(blocks_of(app.entries.get(1)), ["text:else"]);
    assert_eq!(app.selected_alt_command_args(), Some(json!({ "index": 1 })));
    app.close_alt_picker_after_confirm();
    assert!(app.alt_picker.is_none());
    assert_eq!(
        blocks_of(app.entries.get(1)),
        ["text:else"],
        "a confirmed choice stays"
    );

    app.start_alt_picker(None);
    app.populate_alt_picker(None, Vec::new());
    assert!(app.alt_picker.is_none());
    assert!(
        app.notifications
            .iter()
            .any(|n| n.content == "no alternate responses")
    );
}

#[test]
fn the_last_reply_text_skips_a_reply_still_streaming_or_with_nothing_to_say() {
    let mut app = App {
        entries: vec![said(Role::Assistant, "settled"), said(Role::User, "next")],
        ..App::default()
    };
    assert_eq!(app.last_assistant_text().as_deref(), Some("settled"));
    app.entries.push(said(Role::Assistant, "  "));
    assert_eq!(
        app.last_assistant_text(),
        None,
        "the latest reply decides, even when blank"
    );
    let _blank = app.entries.pop();
    app.stream_append_text("streaming");
    assert_eq!(app.last_assistant_text().as_deref(), Some("settled"));
    assert_eq!(App::default().last_assistant_text(), None);
}

#[test]
fn answers_to_an_earlier_connection_or_a_retired_stream_are_stale() {
    let mut app = App {
        request_prefix: "tui".to_owned(),
        ..App::default()
    };
    let earlier = app.next_request_id("log");
    assert_eq!(earlier, "tui_0_1_log");
    assert!(!app.stale_request(Some(&earlier)));
    assert!(!app.stale_request(None));
    assert!(
        !app.stale_request(Some("cli_0_1_log")),
        "another client's ids are not ours to judge"
    );
    app.stream.active = true;
    app.stream.rid = Some(earlier.clone());
    app.retire_operations();
    let later = app.next_request_id("log");
    assert_eq!(later, "tui_1_2_log");
    assert!(app.stale_request(Some(&earlier)), "retired with the stream");
    assert!(
        app.stale_request(Some("tui_0_7_log")),
        "from before the reconnect"
    );
    assert!(!app.stale_request(Some(&later)));
    app.stream.active = true;
    app.stream.rid = Some(earlier.clone());
    assert!(
        !app.stale_request(Some(&earlier)),
        "the stream in flight is never stale"
    );
}

#[test]
fn forgetting_message_copies_drops_the_lookup_in_flight_too() {
    let mut app = App::default();
    let _previous = app.message_copies.insert("m_1".to_owned(), Vec::new());
    app.pending_message_copies = Some(("r".to_owned(), vec!["m_1".to_owned()]));
    app.invalidate_message_copies();
    assert!(
        app.stale_message_copies,
        "the answer in flight is already out of date"
    );
    app.forget_message_copies();
    assert!(app.message_copies.is_empty());
    assert_eq!(app.pending_message_copies, None);
    assert!(!app.stale_message_copies);
}
