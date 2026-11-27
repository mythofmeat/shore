#![cfg(test)]

mod support;

use std::process::Output;

use serde_json::{Value, json};

use support::{StandIn, shore_in};

fn following(env: &[(&str, &str)]) -> (Output, Vec<Value>) {
    let daemon = StandIn::start(&["ada"], None, |_, frame| match frame["type"].as_str() {
        Some("hello") => vec![
            json!({ "type": "history", "selected_character": "ada", "selected_thread": "main" }),
        ],
        Some("follow") => vec![
            json!({ "type": "ping" }),
            json!({
                "type": "new_message", "revision": 1, "character": "ada", "msg_id": "m_9",
                "role": "assistant", "content": "Look at this.",
                "content_blocks": [{ "type": "text", "text": "Look at this." }],
                "timestamp": "2026-11-23T10:00:00Z",
                "images": [{ "path": "sea.png", "caption": "the sea", "data": "cG5nLWJ5dGVz" }],
            }),
            json!({ "type": "shutdown" }),
        ],
        _ => vec![json!({
            "type": "command_output", "name": frame["name"], "rid": frame["rid"],
            "data": {
                "messages": [], "cursor": 0, "next_before": 0, "has_more_before": false,
                "total_turns": 0, "segment": null, "previous_segment": null, "next_segment": null,
            },
        })],
    });
    let home = tempfile::tempdir().unwrap();
    let output = shore_in(home.path(), &daemon.addr)
        .envs(env.iter().copied())
        .args(["log", "--follow"])
        .output()
        .unwrap();
    let asked = daemon
        .frames()
        .iter()
        .filter_map(|frame| frame["type"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    (output, asked.into_iter().map(Value::from).collect())
}

#[test]
fn a_followed_reply_draws_its_picture_in_a_terminal_that_can_and_names_it_elsewhere() {
    let (kitty, asked) = following(&[("SHORE_IMAGES", "kitty")]);
    assert!(kitty.status.success(), "{kitty:?}");
    assert_eq!(
        asked,
        [json!("hello"), json!("follow"), json!("command")],
        "the events are followed before the page is fetched, so nothing between the two is lost"
    );
    let drawn = String::from_utf8_lossy(&kitty.stdout);
    assert!(drawn.contains("Look at this."), "{drawn}");
    assert!(
        drawn.contains("\u{1b}_Ga=T,f=100,m=0;cG5nLWJ5dGVz\u{1b}\\"),
        "{drawn:?}"
    );
    assert!(!drawn.contains("[img:"), "{drawn}");

    let (plain, _) = following(&[]);
    assert!(plain.status.success(), "{plain:?}");
    let named = String::from_utf8_lossy(&plain.stdout);
    assert!(named.contains("[img: the sea]"), "{named}");
    assert!(!named.contains("\u{1b}_G"), "{named:?}");
}
