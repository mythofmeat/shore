#![cfg(test)]

mod support;

use std::process::{Command, Output};
use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use support::StandIn;

fn start(answering: impl Fn(&Value, &Value) -> Vec<Value> + Send + Sync + 'static) -> StandIn {
    StandIn::start(&["ada", "bob"], None, answering)
}

fn is_hello(frame: &Value) -> bool {
    frame.get("type").and_then(Value::as_str) == Some("hello")
}

fn named(frame: &Value) -> Option<&str> {
    frame.get("name").and_then(Value::as_str)
}

fn history(messages: Value) -> Value {
    json!({
        "type": "history", "messages": messages, "config": {},
        "selected_character": "ada", "selected_thread": "story"
    })
}

fn output(command: &Value, data: Value) -> Value {
    json!({ "type": "command_output", "name": command["name"], "rid": command["rid"], "data": data })
}

fn threads() -> Value {
    json!({ "threads": [{ "id": "main", "label": "Home" }, { "id": "story" }] })
}

fn answers_threads(hello: &Value, frame: &Value) -> Vec<Value> {
    if is_hello(frame) {
        return vec![history(json!([]))];
    }
    let as_named = hello.get("character").and_then(Value::as_str) == Some("ada")
        && hello.get("thread").and_then(Value::as_str) == Some("story")
        && hello.get("token").and_then(Value::as_str) == Some("test-token");
    match named(frame) {
        Some("list_threads") if as_named => vec![output(frame, threads())],
        Some("list_threads") => vec![output(
            frame,
            json!({ "threads": [{ "id": "asked-as-someone-else" }] }),
        )],
        _ => Vec::new(),
    }
}

fn shore(env: &[(&str, &str)], args: &[&str]) -> Output {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("config")).unwrap();
    std::fs::write(home.path().join("config").join("token"), "test-token").unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_shore"));
    let _isolated = command
        .env_remove("SHORE_ADDR")
        .env_remove("SHORE_CHARACTER")
        .env_remove("SHORE_THREAD")
        .env_remove("SHORE_COMPLETE")
        .env_remove("SHORE_TOKEN")
        .env("SHORE_CONFIG_DIR", home.path().join("config"))
        .env("SHORE_DATA_DIR", home.path().join("data"))
        .env("SHORE_RUNTIME_DIR", home.path().join("runtime"))
        .env("SHORE_CACHE_DIR", home.path().join("cache"));
    for (name, value) in env {
        let _set = command.env(name, value);
    }
    command.args(args).output().unwrap()
}

fn fish(words: &[&str]) -> Vec<String> {
    let mut args = vec!["--", "shore"];
    args.extend_from_slice(words);
    let completed = shore(&[("SHORE_COMPLETE", "fish")], &args);
    assert!(completed.status.success(), "{completed:?}");
    String::from_utf8(completed.stdout)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_shell_completes_from_the_daemon_named_on_the_line_as_the_character_and_thread_named_there() {
    let daemon = start(answers_threads);
    let offered = fish(&[
        "--addr",
        &daemon.addr,
        "--character",
        "ada",
        "--thread",
        "story",
        "thread",
        "lock",
        "",
    ]);
    assert_eq!(offered, ["main\tHome", "story"]);
    assert_eq!(daemon.commands("list_threads").len(), 1);
}

#[test]
fn a_shell_offers_the_characters_a_daemon_says_hello_with() {
    let daemon = start(answers_threads);
    assert_eq!(
        fish(&["--addr", &daemon.addr, "--character", ""]),
        ["ada", "bob"]
    );
}

#[test]
fn message_refs_come_from_the_recent_messages_the_daemon_lists() {
    let daemon = start(|_, frame| {
        if is_hello(frame) {
            return vec![history(json!([]))];
        }
        if named(frame) != Some("log") || frame["args"] != json!({ "count": 20 }) {
            return Vec::new();
        }
        vec![output(
            frame,
            json!({ "messages": [
            { "msg_id": "m_1", "role": "user", "timestamp": "2026-11-10T00:00:00Z",
              "content_blocks": [{ "type": "text", "text": "hello there\nsecond line" }] },
            { "msg_id": "m_2", "role": "assistant", "timestamp": "2026-11-10T00:00:01Z",
              "content_blocks": [
                  { "type": "thinking", "thinking": "the reader asked a question" },
                  { "type": "text", "text": "a reply that runs on well past forty-eight characters before it ends" }
              ] },
            { "msg_id": "m_3", "role": "system", "timestamp": "2026-11-10T00:00:02Z",
              "content": "be brief\nand kind", "content_blocks": [] },
        ] }),
        )]
    });
    assert_eq!(
        fish(&["--addr", &daemon.addr, "msg", "edit", ""]),
        [
            "last",
            "-1",
            "-2",
            "-3",
            "m_3\tsystem be brief",
            "m_2\tassistant a reply that runs on well past forty-eight chara",
            "m_1\tuser hello there",
        ]
    );
}

#[test]
fn a_lookup_waits_for_its_own_answer_and_passes_over_other_frames() {
    let daemon = start(|hello, frame| {
        if named(frame) != Some("list_threads") {
            return answers_threads(hello, frame);
        }
        vec![
            json!({ "type": "request_accepted", "rid": frame["rid"] }),
            json!({
                "type": "command_output", "name": "list_models", "rid": frame["rid"],
                "data": { "threads": [{ "id": "not-mine" }] }
            }),
            json!({ "type": "ping" }),
            output(frame, threads()),
        ]
    });
    let offered = fish(&[
        "--addr",
        &daemon.addr,
        "--character",
        "ada",
        "--thread",
        "story",
        "thread",
        "lock",
        "",
    ]);
    assert_eq!(offered, ["main\tHome", "story"]);
}

#[test]
fn an_error_answer_ends_a_lookup_with_nothing_offered() {
    let daemon = start(|hello, frame| {
        if named(frame) != Some("list_threads") {
            return answers_threads(hello, frame);
        }
        vec![
            json!({ "type": "error", "rid": frame["rid"], "code": "internal_error", "message": "no threads" }),
            output(frame, threads()),
        ]
    });
    let offered = fish(&[
        "--addr",
        &daemon.addr,
        "--character",
        "ada",
        "--thread",
        "story",
        "thread",
        "lock",
        "",
    ]);
    assert!(
        offered.iter().all(|line| line.starts_with("--")),
        "{offered:?}"
    );
}

#[test]
fn a_daemon_that_refuses_the_connection_is_tried_once_per_completion() {
    let daemon = start(|_, frame| {
        if is_hello(frame) {
            vec![json!({ "type": "error", "code": "unauthorized", "message": "wrong token" })]
        } else {
            Vec::new()
        }
    });
    let offered = fish(&[
        "--addr",
        &daemon.addr,
        "provider",
        "openrouter",
        "set",
        "sdk",
        "",
    ]);
    assert!(
        offered.iter().all(|line| line.starts_with("--")),
        "{offered:?}"
    );
    assert_eq!(
        daemon.requests.load(Ordering::SeqCst),
        1,
        "two lookups on one line share the failed attempt"
    );
}

#[test]
fn model_settings_are_asked_for_the_target_named_on_the_line() {
    let daemon = start(|_, frame| {
        if is_hello(frame) {
            return vec![history(json!([]))];
        }
        if named(frame) != Some("model_settings") {
            return Vec::new();
        }
        let key = if frame["args"] == json!({ "background_task": "wake" }) {
            "temperature"
        } else {
            "asked-for-something-else"
        };
        vec![output(
            frame,
            json!({ "setting_schema": [{ "key": key, "applicability": "always" }] }),
        )]
    });
    assert_eq!(
        fish(&[
            "--addr",
            &daemon.addr,
            "model",
            "setting",
            "--background=wake",
            ""
        ]),
        ["temperature\tunset"]
    );
}

#[test]
fn a_tool_is_described_once_for_its_arguments() {
    let daemon = start(|_, frame| {
        if is_hello(frame) {
            return vec![history(json!([]))];
        }
        if named(frame) != Some("run_tool") {
            return Vec::new();
        }
        vec![output(
            frame,
            json!({ "tool": "search", "input_schema": {
                "required": ["query"],
                "properties": { "query": { "type": "string", "description": "What to find" } }
            }}),
        )]
    });
    assert_eq!(
        fish(&["--addr", &daemon.addr, "debug", "tool", "search", ""]),
        ["query=\tWhat to find"]
    );
    let described = daemon.commands("run_tool");
    assert_eq!(described.len(), 1, "{described:?}");
    assert_eq!(
        described.first().and_then(|frame| frame.get("args")),
        Some(&json!({ "tool": "search", "describe": true }))
    );
}

#[test]
fn a_shell_offers_flags_only_once_a_dash_is_typed() {
    let daemon = start(answers_threads);
    let words = |current: &'static str| {
        fish(&[
            "--addr",
            &daemon.addr,
            "--character",
            "ada",
            "--thread",
            "story",
            "thread",
            "lock",
            current,
        ])
    };
    assert!(words("").iter().all(|line| !line.starts_with('-')));
    assert!(
        words("--").iter().any(|line| line.starts_with("--help")),
        "{:?}",
        words("--")
    );
}

#[test]
fn a_shell_completes_the_word_under_the_cursor_even_with_words_after_it() {
    let completed = shore(
        &[
            ("SHORE_COMPLETE", "bash"),
            ("_CLAP_COMPLETE_INDEX", "2"),
            ("_CLAP_IFS", "\n"),
        ],
        &["--", "shore", "thread", "lo", "main"],
    );
    assert!(completed.status.success(), "{completed:?}");
    assert_eq!(String::from_utf8(completed.stdout).unwrap(), "lock");
}

#[test]
fn completions_prints_the_line_a_shell_registers() {
    let printed = shore(&[], &["completions", "fish"]);
    assert!(printed.status.success(), "{printed:?}");
    let script = String::from_utf8(printed.stdout).unwrap();
    assert!(script.contains("SHORE_COMPLETE=fish shore --"), "{script}");
}
