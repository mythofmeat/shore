#![cfg(test)]

mod support;

use serde_json::{Value, json};

use support::{asked, printed, sent};

#[test]
fn turning_statuses_on_sends_them_and_prints_each_one_on_with_the_others_used_before() {
    let (output, frames) = asked(
        json!({
            "statuses": [
                { "status": "at work", "set_at": "this morning" },
                { "status": "tired", "set_at": "noon" }
            ],
            "history": ["tired", "at work", "asleep", "out"]
        }),
        &["presence", "at work", "tired"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "On: \"at work\" since this morning, \"tired\" since noon.\nUsed before: asleep, out."
    );
    assert_eq!(
        sent(&frames),
        [(
            Some("presence"),
            Some(&json!({ "on": ["at work", "tired"] }))
        )]
    );
}

#[test]
fn off_clear_and_forget_are_sent_together_and_asking_sends_nothing() {
    let (swapped, swapping) = asked(
        json!({ "statuses": [], "history": ["asleep"] }),
        &[
            "presence",
            "in bed",
            "--off",
            "on the couch",
            "--clear",
            "--forget",
            "slep",
        ],
    );
    assert_eq!(printed(&swapped), "No status is on.\nUsed before: asleep.");
    assert_eq!(
        sent(&swapping),
        [(
            Some("presence"),
            Some(
                &json!({ "on": ["in bed"], "off": ["on the couch"], "clear": true, "forget": ["slep"] })
            )
        )]
    );

    let (shown, asking) = asked(
        json!({ "statuses": [{ "status": "asleep", "set_at": "last night" }], "history": ["asleep"] }),
        &["presence"],
    );
    assert_eq!(printed(&shown), "On: \"asleep\" since last night.");
    assert_eq!(sent(&asking), [(Some("presence"), Some(&json!({})))]);

    let (none, _none_asked) = asked(json!({ "statuses": [], "history": [] }), &["presence"]);
    assert_eq!(printed(&none), "No status is on.");

    let (raw, _raw_asked) = asked(
        json!({ "statuses": [], "history": ["asleep"] }),
        &["presence", "--json"],
    );
    assert_eq!(
        serde_json::from_str::<Value>(&printed(&raw)).unwrap(),
        json!({ "statuses": [], "history": ["asleep"] })
    );
}
