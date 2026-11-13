#![cfg(test)]

mod support;

use std::process::Output;

use serde_json::json;

use support::{asked, printed, sent};

fn lines(output: &Output) -> Vec<String> {
    assert!(output.status.success(), "{output:?}");
    printed(output)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect()
}

#[test]
fn starting_a_wake_by_hand_says_so_and_passes_on_the_daemons_warning() {
    let (started, frames) = asked(
        json!({ "status": "scheduled", "character": "ada" }),
        &["debug", "heartbeat_tick_now"],
    );
    assert_eq!(lines(&started), ["Started a wake for ada."]);
    assert_eq!(
        sent(&frames),
        [(Some("heartbeat_tick_now"), Some(&json!({})))]
    );

    let (warned, _warned_frames) = asked(
        json!({ "status": "scheduled", "character": "ada", "warning": "ada is dormant, so the wake waits." }),
        &["debug", "heartbeat_tick_now"],
    );
    assert_eq!(
        lines(&warned),
        [
            "Started a wake for ada.",
            "ada is dormant, so the wake waits."
        ]
    );
}

#[test]
fn making_a_character_dormant_or_active_says_which_it_now_is() {
    let (dormant, dormant_frames) = asked(
        json!({ "status": "dormant", "character": "ada" }),
        &["debug", "heartbeat_status_dormant"],
    );
    assert_eq!(lines(&dormant), ["ada is now dormant."]);
    assert_eq!(
        sent(&dormant_frames),
        [(Some("heartbeat_set_dormant"), Some(&json!({})))]
    );

    let (active, active_frames) = asked(
        json!({ "status": "active", "character": "ada" }),
        &["debug", "heartbeat_status_active"],
    );
    assert_eq!(lines(&active), ["ada is now active."]);
    assert_eq!(
        sent(&active_frames),
        [(Some("heartbeat_set_active"), Some(&json!({})))]
    );
}

#[test]
fn activating_a_session_shows_the_keepalive_and_the_state_of_own_time() {
    let (first, _first_frames) = asked(
        json!({
            "character": "ada", "registered": true, "own_time": "Active",
            "keepalive": { "status": "resumed", "interval_secs": 270, "next_ping_at": "2026-11-12T00:04:00Z", "seconds_until_ping": 240 },
        }),
        &["debug", "session_activate"],
    );
    assert_eq!(
        lines(&first),
        [
            "Activated ada.",
            "Keepalive: already warm; next ping in 4m",
            "Own time: active"
        ]
    );

    let (again, _again_frames) = asked(
        json!({
            "character": "ada", "registered": false, "own_time": "Dormant",
            "keepalive": { "status": "off" },
        }),
        &["debug", "session_activate"],
    );
    assert_eq!(
        lines(&again),
        [
            "ada was already active.",
            "Keepalive: off \u{2014} this character's model sets cache_keepalive = off",
            "Own time: dormant"
        ]
    );

    let (unregistered, _unregistered_frames) = asked(
        json!({ "character": "ada", "registered": false, "own_time": null, "keepalive": { "status": "off" } }),
        &["debug", "session_activate"],
    );
    assert_eq!(
        lines(&unregistered).last().map(String::as_str),
        Some("Own time: no state (registration failed)")
    );
}

#[test]
fn the_thread_list_marks_home_and_the_own_time_thread() {
    let thread = |id: &str, own: bool| {
        json!({
            "id": id, "created_at": "2026-11-12T00:00:00Z", "compaction": !own, "home": id == "main",
            "current": id == "main", "heartbeat": own, "turns": 2,
        })
    };
    let (output, _frames) = asked(
        json!({
            "character": "ada", "threads": [thread("main", false), thread("own-time", true)],
            "home": "main", "current": "main",
        }),
        &["thread"],
    );
    assert_eq!(
        lines(&output).get(1..),
        Some(
            &[
                "* main home \u{00b7} 2 turns \u{00b7} compacts".to_owned(),
                "own-time own time \u{00b7} 2 turns \u{00b7} trims".to_owned(),
                "home gets what own time sends, unless a trigger names another thread".to_owned(),
            ][..]
        )
    );
}
