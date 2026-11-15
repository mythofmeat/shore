#![cfg(test)]

mod support;

use serde_json::json;

use std::process::Output;

use support::{asked, printed, sent};

fn lines(output: &Output) -> Vec<String> {
    assert!(output.status.success(), "{output:?}");
    printed(output)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect()
}

fn under(heading: &str, shown: &[String]) -> Vec<String> {
    let Some((first, rest)) = shown.split_first() else {
        panic!("nothing was printed")
    };
    assert!(
        first.starts_with(&format!("\u{2500}\u{2500} {heading} \u{2500}")),
        "{first}"
    );
    rest.to_vec()
}

#[test]
fn what_a_characters_wakes_did_is_listed_with_how_many_events_there_are() {
    let (shown, frames) = asked(
        json!({ "events": [
            { "timestamp": "dawn", "kind": "tick_fired", "detail": "lamp is due" },
            { "timestamp": "noon", "kind": "message_sent", "detail": "said hello" },
        ] }),
        &["trace", "events", "-n", "2"],
    );
    assert_eq!(
        under("wake events (2 events)", &lines(&shown)),
        [
            "dawn tick_fired lamp is due",
            "noon message_sent said hello"
        ]
    );
    assert_eq!(
        sent(&frames),
        [(Some("wake_log"), Some(&json!({ "count": 2 })))]
    );

    let (none, _none_frames) = asked(json!({ "events": [] }), &["trace", "events"]);
    assert_eq!(under("wake events", &lines(&none)), ["(no wake events)"]);
}

#[test]
fn a_wakes_transcript_shows_each_round_or_says_there_is_none_or_that_capture_is_off() {
    let round = json!({
        "id": 1, "ts": "dawn", "source": "wake", "character": "ada",
        "call_type": "wake", "iteration": 2, "provider": "anthropic", "model": "fixture",
        "finish_reason": "end_turn",
        "usage": { "input_tokens": 10, "output_tokens": 4, "cache_read_tokens": 7, "cache_write_tokens": 1 },
        "entry": { "reasoning": ["Check the lamp."], "text": "The lamp is lit.", "tool_calls": [] },
    });
    let (shown, frames) = asked(
        json!({ "source": "wake", "character": "ada", "enabled": true, "entries": [round] }),
        &["trace", "wakes", "-n", "3"],
    );
    assert_eq!(
        under("wake transcript (ada)", &lines(&shown)),
        [
            "dawn wake#2 anthropic/fixture",
            "end_turn in=10 out=4 cache_read=7 cache_write=1",
            "reasoning: Check the lamp.",
            "text: The lamp is lit.",
        ]
    );
    assert_eq!(
        sent(&frames),
        [(
            Some("transcript"),
            Some(&json!({ "source": "wake", "count": 3 }))
        )]
    );

    let (empty, _empty_frames) = asked(
        json!({ "source": "dreaming", "character": "ada", "enabled": true, "entries": [] }),
        &["trace", "dreams"],
    );
    assert_eq!(
        under("dreaming transcript (ada)", &lines(&empty)),
        ["(no transcript entries yet)"]
    );

    let (off, _off_frames) = asked(
        json!({ "source": "wake", "character": "ada", "enabled": false, "entries": [] }),
        &["trace", "wakes"],
    );
    assert_eq!(
        under("wake transcript (ada)", &lines(&off)),
        ["(payload capture is disabled)"]
    );
}

#[test]
fn stored_sub_agent_runs_are_listed_or_said_to_be_missing() {
    let (none, frames) = asked(
        json!({ "character": "ada", "entries": [] }),
        &["trace", "subagent"],
    );
    assert_eq!(
        under("sub-agent runs (ada)", &lines(&none)),
        ["(no sub-agent runs recorded yet)"]
    );
    assert_eq!(
        sent(&frames),
        [(Some("subagent_trace"), Some(&json!({ "count": 20 })))]
    );

    let (missing, _missing_frames) = asked(
        json!({ "character": "ada", "entries": [], "requested_ids": ["tu_9"] }),
        &["trace", "subagent", "tu_9"],
    );
    assert_eq!(
        under("sub-agent runs (ada)", &lines(&missing)),
        ["(no sub-agent run with id tu_9 \u{2014} `shore trace subagent` lists what is stored)"]
    );
}

#[test]
fn the_error_log_lists_errors_and_key_fallbacks_with_how_many_there_were_of_each() {
    let (shown, frames) = asked(
        json!({
            "errors": { "count": 3, "recent": [
                { "timestamp": "2026-11-01T09:30:05Z", "error_type": "provider", "message": "overloaded", "context": "turn 4" },
            ] },
            "key_fallbacks": { "count": 1, "recent": [
                { "timestamp": "2026-11-01T09:31:00Z", "provider": "anthropic", "model": "opus", "character": "ada", "from_key": "main", "to_key": "spare", "kind": "rate_limit", "status": 429, "reason": "too many requests" },
            ] },
        }),
        &["trace", "errors", "-n", "5"],
    );
    let lines = lines(&shown);
    let [errors, error, fallbacks, fallback] = lines.as_slice() else {
        panic!("{lines:?}")
    };
    assert!(
        errors.starts_with("\u{2500}\u{2500} Errors (3 total) \u{2500}"),
        "{errors}"
    );
    assert!(error.ends_with(" provider overloaded turn 4"), "{error}");
    assert!(
        fallbacks.starts_with("\u{2500}\u{2500} Key fallbacks (1 total) \u{2500}"),
        "{fallbacks}"
    );
    assert!(
        fallback.ends_with(" main -> spare rate_limit 429 too many requests"),
        "{fallback}"
    );
    assert_eq!(
        sent(&frames),
        [(Some("error_log"), Some(&json!({ "count": 5 })))]
    );
}
