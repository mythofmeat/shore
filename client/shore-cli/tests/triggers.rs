#![cfg(test)]

mod support;

use serde_json::{Value, json};

use support::{asked, printed, sent};

fn status(state: &str) -> Value {
    json!({
        "character": "ada", "keepalive_halts": [], "turn_count": 3, "active_model": "anthropic:opus",
        "config_dir": "/config", "data_dir": "/data", "cache_dir": "/cache",
        "pending_deferred_edit_count": 0, "pending_deferred_edits": [],
        "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
        "autonomy": { "state": state, "wakes_without_user": 1, "dormant_after_wakes": 3, "dormant_after_idle_time_secs": 0, "recent_events": [] },
        "activity": null, "history_index": null, "sections": ["autonomy", "triggers"],
        "triggers": {
            "enabled": true,
            "next_wake": { "trigger": "lamp", "at": "2026-11-18T13:00:00+00:00" },
            "triggers": [{ "name": "lamp", "does": "every 1h, wakes ada, \"Trim the lamp.\"", "status": "never fired" }],
            "not_running": [],
        },
    })
}

fn lines(state: &str, args: &[&str]) -> Vec<String> {
    let (output, frames) = asked(status(state), args);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(sent(&frames), [(Some("status"), Some(&json!({})))]);
    printed(&output)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect()
}

#[test]
fn status_has_a_row_for_the_triggers_saying_which_is_due_next() {
    let shown = lines("Active", &["status"]);
    assert!(
        shown
            .iter()
            .any(|line| line == "triggers 1 \u{00b7} next lamp due now"),
        "{shown:?}"
    );
}

#[test]
fn the_triggers_section_lists_each_one_and_warns_only_while_the_character_is_dormant() {
    let awake = lines("Active", &["status", "--section", "triggers"]);
    assert_eq!(
        awake.get(1..),
        Some(
            &[
                "lamp every 1h, wakes ada, \"Trim the lamp.\"".to_owned(),
                "never fired".to_owned()
            ][..]
        )
    );
    let dormant = lines("Dormant", &["status", "--section", "triggers"]);
    assert_eq!(
        dormant.get(1).map(String::as_str),
        Some("! ada is dormant, so nothing fires until you write")
    );
}
