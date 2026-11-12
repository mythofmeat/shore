#![cfg(test)]

mod support;

use serde_json::{Value, json};

use support::{asked, printed, sent};

#[test]
fn setting_a_status_sends_it_and_prints_what_the_daemon_now_holds() {
    let (output, frames) = asked(
        json!({ "status": "at work", "set_at": "this morning", "choices": ["asleep", "at work"] }),
        &["presence", "at work"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "Your status is \"at work\", set this morning."
    );
    assert_eq!(
        sent(&frames),
        [(Some("presence"), Some(&json!({ "status": "at work" })))]
    );
}

#[test]
fn clearing_sends_an_empty_status_and_asking_sends_none() {
    let (cleared, clearing) = asked(
        json!({ "choices": ["asleep", "at work"] }),
        &["presence", "--clear"],
    );
    assert_eq!(
        printed(&cleared),
        "You have no status set. You can set one of: asleep, at work."
    );
    assert_eq!(
        sent(&clearing),
        [(Some("presence"), Some(&json!({ "status": "" })))]
    );

    let (shown, asking) = asked(json!({ "status": "asleep", "choices": [] }), &["presence"]);
    assert_eq!(printed(&shown), "Your status is \"asleep\", set ?.");
    assert_eq!(sent(&asking), [(Some("presence"), Some(&json!({})))]);

    let (none, _none_asked) = asked(json!({ "choices": [] }), &["presence"]);
    assert_eq!(printed(&none), "You have no status set.");

    let (raw, _raw_asked) = asked(
        json!({ "status": "asleep", "choices": ["asleep"] }),
        &["presence", "--json"],
    );
    assert_eq!(
        serde_json::from_str::<Value>(&printed(&raw)).unwrap(),
        json!({ "status": "asleep", "choices": ["asleep"] })
    );
}

#[test]
fn a_status_and_clear_together_are_refused_before_anything_is_sent() {
    let (output, frames) = asked(json!({ "choices": [] }), &["presence", "asleep", "--clear"]);
    assert!(!output.status.success());
    assert!(frames.is_empty(), "{frames:?}");
}
