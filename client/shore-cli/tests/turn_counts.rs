#![cfg(test)]

mod support;

use std::process::Output;

use serde_json::{Value, json};

use support::{asked, printed, sent};

fn segment(index: u64, turns: u64, label: &Value) -> Value {
    json!({
        "index": index, "first_message_at": null, "last_message_at": null, "compacted_at": "2026-11-03T10:00:00Z",
        "turn_count": turns, "excluded": false, "label": label, "note": null, "memory_before": null, "memory_after": null,
    })
}

fn words(output: &Output) -> String {
    printed(output)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn succeeded(output: &Output) -> &Output {
    assert!(output.status.success(), "{output:?}");
    output
}

#[test]
fn segments_are_listed_by_how_many_turns_they_hold() {
    let listing = json!({ "character": "ada", "thread": "main", "count": 2, "segments": [
        segment(0, 1, &Value::Null),
        segment(1, 30, &json!("the storm")),
    ] });
    let (output, _frames) = asked(listing, &["segments"]);
    assert_eq!(
        printed(succeeded(&output)),
        ["#0    ? → ?  1 turn", "#1    ? → ?  30 turns  the storm"].join("\n")
    );
}

#[test]
fn a_clear_says_how_many_turns_went_into_the_segment() {
    let cleared = json!({ "status": "clear", "character": "ada", "thread": "main", "segment": segment(3, 30, &Value::Null) });
    let (output, _frames) = asked(cleared, &["clear"]);
    assert_eq!(
        printed(succeeded(&output)),
        "Cleared 30 turns into segment #3."
    );
}

#[test]
fn a_compaction_says_what_it_archived_and_kept_in_turns() {
    let rotated = |dry: bool| json!({ "status": "rotated", "character": "ada", "compacted_turns": 30, "retained_turns": 8, "dry_run": dry, "memory_files_written": [] });
    let (archived, _frames) = asked(rotated(false), &["compact"]);
    let told = words(succeeded(&archived));
    assert!(
        told.contains("Turns 30 archived into history, 8 retained"),
        "{told}"
    );
    assert!(!told.contains("Messages"), "{told}");
    let (dry, _dry_frames) = asked(rotated(true), &["compact"]);
    assert!(
        words(succeeded(&dry)).contains("Turns 30 would be archived into history, 8 retained"),
        "{}",
        words(&dry)
    );
    let compacted = json!({
        "status": "compacted", "character": "ada", "compacted_turns": 30, "retained_turns": 8,
        "memory_files_written": ["memory/a.md"], "new_conversation_id": "c", "tool_rounds": 1, "tools_called": ["edit"],
    });
    let (summarized, _summarized_frames) = asked(compacted, &["compact"]);
    assert!(
        words(succeeded(&summarized)).contains("Turns 30 compacted, 8 retained"),
        "{}",
        words(&summarized)
    );
}

fn forked(scope: &str, turns: u64) -> Value {
    let thread = |id: &str| json!({ "id": id, "created_at": "2026-11-12T00:00:00Z", "compaction": true, "home": id == "main", "current": id == "main" });
    json!({
        "character": "ada", "threads": [thread("main"), thread("spin")], "home": "main", "current": "main",
        "fork": { "fork_id": "fk", "thread": "spin", "source": "main", "created_at": "2026-11-12T00:00:00Z", "turns": turns, "scope": scope },
    })
}

#[test]
fn a_fork_says_how_many_turns_it_copied() {
    let (whole, _frames) = asked(forked("full", 30), &["thread", "fork", "spin"]);
    assert!(
        words(succeeded(&whole)).contains(
            "spin is a snapshot of main: the whole active context, 30 turns. Each side is edited and compacted on its own from here"
        ),
        "{}",
        words(&whole)
    );
    let (last, _last_frames) = asked(
        forked("last_turns", 1),
        &["thread", "fork", "spin", "--turns", "1"],
    );
    assert!(
        words(succeeded(&last)).contains(
            "spin is a snapshot of main: the last 1 turn. Each side is edited and compacted on its own from here"
        ),
        "{}",
        words(&last)
    );
}

fn activity(messages: u64) -> Value {
    json!({
        "character": "ada", "keepalive_halts": [], "turn_count": 3, "active_model": null,
        "config_dir": "/config", "data_dir": "/data", "cache_dir": "/cache",
        "pending_deferred_edit_count": 0, "pending_deferred_edits": [],
        "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
        "autonomy": null, "history_index": null, "sections": ["activity"], "activity": {
        "hour_histogram": vec![0.5; 24], "hour_classifications": vec!["normal"; 24], "has_sufficient_heatmap": true,
        "engagement_score": 0.5, "sessions_per_day": 1.5, "message_count": messages,
    } })
}

#[test]
fn the_activity_record_counts_the_messages_you_sent() {
    let shown = |messages: u64| {
        let (output, _frames) = asked(activity(messages), &["status", "--section", "activity"]);
        words(succeeded(&output))
    };
    assert!(
        shown(42).contains("sessions/day \u{00b7} 42 messages"),
        "{}",
        shown(42)
    );
    assert!(
        shown(1).contains("sessions/day \u{00b7} 1 message"),
        "{}",
        shown(1)
    );
    assert!(shown(0).contains("nothing recorded yet"), "{}", shown(0));
}

fn page(segment_shown: &Value, previous: &Value) -> Value {
    json!({
        "messages": [], "cursor": 0, "next_before": 0, "has_more_before": false, "total_turns": 30,
        "segment": segment_shown, "previous_segment": previous, "next_segment": null,
    })
}

#[test]
fn a_segment_in_the_log_is_titled_with_its_turns_like_the_current_context() {
    let (archived, _frames) = asked(
        page(&segment(3, 30, &Value::Null), &Value::Null),
        &["log", "--segment", "3"],
    );
    assert!(
        words(succeeded(&archived)).contains("segment 3 \u{00b7} 30 turns"),
        "{}",
        words(&archived)
    );
    let (current, _current_frames) =
        asked(page(&Value::Null, &segment(2, 1, &Value::Null)), &["log"]);
    let told = words(succeeded(&current));
    assert!(told.contains("current context \u{00b7} 30 turns"), "{told}");
    assert!(
        told.contains("before this: segment 2 \u{00b7} 1 turn \u{00b7} shore log --segment 2"),
        "{told}"
    );
}

#[test]
fn the_log_takes_its_length_in_turns_and_no_longer_by_a_count() {
    let (turns, asking) = asked(page(&Value::Null, &Value::Null), &["log", "-n", "5"]);
    assert!(turns.status.success(), "{turns:?}");
    assert_eq!(sent(&asking), [(Some("log"), Some(&json!({ "turns": 5 })))]);
    let (output, frames) = asked(page(&Value::Null, &Value::Null), &["log", "--count", "5"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(frames.is_empty(), "{frames:?}");
}
