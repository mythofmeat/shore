#![cfg(test)]

mod support;

use serde_json::{Value, json};

use support::{asked, printed, sent};

fn diary() -> Value {
    json!({ "character": "ada", "kept": 5, "notes": [
        { "at": "2026-11-10T22:15:00.000Z", "thread": "main", "source": "note", "text": "Promised the ferry times.", "shown": false, "dreamed": true },
        { "at": "2026-11-11T09:05:30.000Z", "thread": "own-time", "source": "wake", "text": "Read the log.\n\nNext: the tide tables.", "shown": true, "dreamed": false },
        { "at": "2026-11-11T13:40:00.000Z", "thread": "own-time", "source": "trigger", "trigger": "mail check", "text": "Two letters.", "shown": true, "dreamed": false },
    ] })
}

#[test]
fn the_diary_is_printed_oldest_first_with_the_day_named_when_it_changes() {
    let (output, frames) = asked(diary(), &["diary"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        [
            "\u{2500}\u{2500} diary (ada, newest 3 of 5 notes) \u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}",
            "",
            "  Nov 10 \u{00b7} 22:15  note in \"main\"  \u{00b7} no longer shown to ada  \u{00b7} dreamed",
            "    Promised the ferry times.",
            "",
            "  Nov 11 \u{00b7} 09:05  wake in \"own-time\"",
            "    Read the log.",
            "",
            "    Next: the tide tables.",
            "",
            "  13:40           trigger \"mail check\"",
            "    Two letters.",
        ]
        .join("\n")
    );
    assert_eq!(
        sent(&frames),
        [(Some("diary"), Some(&json!({ "count": 20 })))]
    );
}

#[test]
fn a_count_is_sent_as_asked_and_json_prints_what_the_daemon_sent() {
    let (_all, asking_all) = asked(diary(), &["diary", "-n", "0"]);
    assert_eq!(
        sent(&asking_all),
        [(Some("diary"), Some(&json!({ "count": 0 })))]
    );
    let (_few, asking_few) = asked(diary(), &["diary", "--count", "2"]);
    assert_eq!(
        sent(&asking_few),
        [(Some("diary"), Some(&json!({ "count": 2 })))]
    );

    let (raw, _raw_asked) = asked(diary(), &["diary", "--json"]);
    assert_eq!(
        serde_json::from_str::<Value>(&printed(&raw)).unwrap(),
        diary()
    );
}

#[test]
fn a_count_that_is_not_a_number_is_refused_before_anything_is_sent() {
    let (output, frames) = asked(diary(), &["diary", "-n", "all"]);
    assert!(!output.status.success(), "{output:?}");
    assert!(frames.is_empty(), "{frames:?}");
}
