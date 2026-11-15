#![cfg(test)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

type Answer = dyn Fn(&Value, &Value) -> Vec<Value> + Send + Sync;

struct FakeDaemon {
    addr: String,
    accepted: Arc<AtomicUsize>,
    received: Arc<Mutex<Vec<Value>>>,
}

impl FakeDaemon {
    fn start(answering: impl Fn(&Value, &Value) -> Vec<Value> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let accepted = Arc::new(AtomicUsize::new(0));
        let received = Arc::new(Mutex::new(Vec::new()));
        let answer: Arc<Answer> = Arc::new(answering);
        let counted = Arc::clone(&accepted);
        let recorded = Arc::clone(&received);
        let _server = std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(stream) = incoming else { return };
                let _previous = counted.fetch_add(1, Ordering::SeqCst);
                let replies = Arc::clone(&answer);
                let log = Arc::clone(&recorded);
                let _worker = std::thread::spawn(move || serve(stream, replies.as_ref(), &log));
            }
        });
        Self {
            addr,
            accepted,
            received,
        }
    }

    fn commands(&self, name: &str) -> Vec<Value> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.get("name").and_then(Value::as_str) == Some(name))
            .cloned()
            .collect()
    }
}

fn send(stream: &mut TcpStream, frame: &Value) {
    let _sent = writeln!(stream, "{frame}");
}

fn serve(stream: TcpStream, answer: &Answer, received: &Mutex<Vec<Value>>) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    send(
        reader.get_mut(),
        &json!({
            "type": "hello", "v": 1, "server_name": "test",
            "characters": [{ "name": "ada" }, { "name": "bob" }]
        }),
    );
    let mut hello = Value::Null;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        if frame.get("type").and_then(Value::as_str) == Some("hello") {
            hello = frame.clone();
        }
        received.lock().unwrap().push(frame.clone());
        for reply in answer(&hello, &frame) {
            send(reader.get_mut(), &reply);
        }
    }
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_shore"));
    let _isolated = command
        .env_remove("SHORE_ADDR")
        .env_remove("SHORE_CHARACTER")
        .env_remove("SHORE_THREAD")
        .env_remove("SHORE_COMPLETE")
        .env("SHORE_TOKEN", "test-token")
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
    let daemon = FakeDaemon::start(answers_threads);
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
    let daemon = FakeDaemon::start(answers_threads);
    assert_eq!(
        fish(&["--addr", &daemon.addr, "--character", ""]),
        ["ada", "bob"]
    );
}

#[test]
fn message_refs_come_from_the_history_a_daemon_sends_on_connecting() {
    let daemon = FakeDaemon::start(|_, frame| {
        if !is_hello(frame) {
            return Vec::new();
        }
        vec![history(json!([
            { "msg_id": "m_1", "role": "user", "timestamp": "2026-11-10T00:00:00Z",
              "content_blocks": [{ "type": "text", "text": "hello there\nsecond line" }] },
            { "msg_id": "m_2", "role": "assistant", "timestamp": "2026-11-10T00:00:01Z",
              "content_blocks": [
                  { "type": "thinking", "thinking": "the reader asked a question" },
                  { "type": "text", "text": "a reply that runs on well past forty-eight characters before it ends" }
              ] },
            { "msg_id": "m_3", "role": "system", "timestamp": "2026-11-10T00:00:02Z",
              "content": "be brief\nand kind", "content_blocks": [] },
        ]))]
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
fn a_lookup_waits_for_its_own_answer_and_passes_over_frames_meant_for_others() {
    let daemon = FakeDaemon::start(|hello, frame| {
        if named(frame) != Some("list_threads") {
            return answers_threads(hello, frame);
        }
        vec![
            json!({
                "type": "command_output", "name": "list_threads", "rid": "someone-else",
                "data": { "threads": [{ "id": "not-mine" }] }
            }),
            json!({ "type": "error", "rid": "someone-else", "code": "busy", "message": "not mine" }),
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
    let daemon = FakeDaemon::start(|hello, frame| {
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
    let daemon = FakeDaemon::start(|_, frame| {
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
        daemon.accepted.load(Ordering::SeqCst),
        1,
        "two lookups on one line share the failed attempt"
    );
}

#[test]
fn model_settings_are_asked_for_the_target_named_on_the_line() {
    let daemon = FakeDaemon::start(|_, frame| {
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
    let daemon = FakeDaemon::start(|_, frame| {
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
    let daemon = FakeDaemon::start(answers_threads);
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
