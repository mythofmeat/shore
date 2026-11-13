#![cfg(test)]

mod support;

use serde_json::{Value, json};

use support::{asked, printed, sent};

fn changed(label: &str, skipped: bool) -> Value {
    json!({
        "character": "ada", "thread": "main", "action": "label", "skipped": skipped,
        "segment": {
            "index": 3, "first_message_at": "2026-11-01T08:00:00Z", "last_message_at": "2026-11-01T09:00:00Z",
            "compacted_at": "2026-11-01T10:00:00Z", "turn_count": 4, "excluded": false,
            "label": label, "note": null, "memory_before": null, "memory_after": null
        }
    })
}

#[test]
fn label_auto_asks_the_daemon_to_write_the_label_and_shows_the_segment_with_it() {
    let (output, frames) = asked(
        changed("Lighting the lamp", false),
        &["segments", "label", "3", "--auto"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        sent(&frames),
        [(
            Some("segments"),
            Some(&json!({ "action": "label", "index": 3, "auto": true }))
        )]
    );
    assert_eq!(
        printed(&output),
        "#3    2026-11-01T08:00:00Z → 2026-11-01T09:00:00Z  4 turns  Lighting the lamp"
    );
}

#[test]
fn label_auto_passes_replace_and_the_model_on() {
    let (_output, frames) = asked(
        changed("Second thoughts", false),
        &[
            "segments",
            "label",
            "3",
            "--auto",
            "--replace",
            "--model",
            "pinned",
        ],
    );
    assert_eq!(
        sent(&frames),
        [(
            Some("segments"),
            Some(
                &json!({ "action": "label", "index": 3, "auto": true, "replace": true, "model": "pinned" })
            )
        )]
    );
}

#[test]
fn a_segment_that_already_has_a_label_is_reported_as_skipped_and_is_not_a_failure() {
    let (output, _frames) = asked(
        changed("By hand", true),
        &["segments", "label", "3", "--auto"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "Segment 3 already has a label: By hand. Use --replace to write a new one."
    );
}

#[test]
fn a_label_typed_by_hand_is_sent_as_before_and_a_bare_label_command_still_clears_it() {
    let (_set, set_frames) = asked(
        changed("By hand", false),
        &["segments", "label", "3", "By hand"],
    );
    assert_eq!(
        sent(&set_frames),
        [(
            Some("segments"),
            Some(&json!({ "action": "label", "index": 3, "value": "By hand" }))
        )]
    );
    let (_cleared, cleared_frames) = asked(changed("x", false), &["segments", "label", "3"]);
    assert_eq!(
        sent(&cleared_frames),
        [(
            Some("segments"),
            Some(&json!({ "action": "label", "index": 3, "value": null }))
        )]
    );
}

#[test]
fn auto_cant_be_given_with_a_label_and_replace_and_model_need_auto() {
    for args in [
        &["segments", "label", "3", "By hand", "--auto"][..],
        &["segments", "label", "3", "--replace"][..],
        &["segments", "label", "3", "--model", "pinned"][..],
    ] {
        let (output, frames) = asked(changed("x", false), args);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
        assert!(frames.is_empty(), "{args:?}: {frames:?}");
    }
}
