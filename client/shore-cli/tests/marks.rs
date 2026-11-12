#![cfg(test)]

mod support;

use serde_json::{Value, json};

use support::{asked, printed, sent};

fn changed(marks: &Value) -> Value {
    json!({ "ref": "m_1", "position": 2, "attempt": "at_2", "phrase": "the sea", "changed": true, "marks": marks })
}

#[test]
fn liking_words_sends_them_with_the_reason_and_prints_the_attempts_marks() {
    let marks = json!([{ "kind": "like", "phrase": "the sea", "reason": "vivid", "tags": ["too long"], "at": "now" }]);
    let (output, frames) = asked(
        changed(&marks),
        &[
            "msg",
            "like",
            "-1",
            "--attempt",
            "2",
            "--phrase",
            "the sea",
            "--reason",
            "vivid",
            "--tag",
            "too long",
        ],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "Attempt 2 of m_1: liked \"the sea\": too long; vivid."
    );
    assert_eq!(
        sent(&frames),
        [(
            Some("mark"),
            Some(
                &json!({ "ref": "-1", "position": 2, "kind": "like", "phrase": "the sea", "reason": "vivid", "tags": ["too long"] })
            )
        )]
    );
}

#[test]
fn a_dislike_an_unmark_and_the_listing_print_what_the_daemon_holds_or_its_raw_answer() {
    let (disliked, disliking) = asked(changed(&json!([])), &["msg", "dislike"]);
    assert_eq!(printed(&disliked), "Attempt 2 of m_1 has no marks now.");
    assert_eq!(
        sent(&disliking),
        [(Some("mark"), Some(&json!({ "kind": "dislike" })))]
    );

    let (raw, unmarking) = asked(
        changed(&json!([])),
        &["msg", "unmark", "m_1", "--phrase", "the sea", "--json"],
    );
    assert_eq!(
        serde_json::from_str::<Value>(&printed(&raw)).unwrap(),
        changed(&json!([]))
    );
    assert_eq!(
        sent(&unmarking),
        [(
            Some("unmark"),
            Some(&json!({ "ref": "m_1", "phrase": "the sea" }))
        )]
    );

    let listing = json!({ "tags": ["too long"], "replies": [{ "ref": "m_1", "attempts": [
        { "position": 1, "shown": true, "attempt": "at_1", "asked": "with_reason", "marks": [] },
    ] }] });
    let (listed, listing_asked) = asked(listing, &["msg", "marks", "last"]);
    assert_eq!(
        printed(&listed),
        "m_1\n  1. shown, with a reason: no marks\nReason tags: too long."
    );
    assert_eq!(
        sent(&listing_asked),
        [(Some("marks"), Some(&json!({ "refs": ["last"] })))]
    );
}
