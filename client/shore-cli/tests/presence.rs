#![cfg(test)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

fn send(stream: &mut TcpStream, frame: &Value) {
    let _sent = writeln!(stream, "{frame}");
}

fn serve(stream: TcpStream, data: &Value, received: &Mutex<Vec<Value>>) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    send(
        reader.get_mut(),
        &json!({ "type": "hello", "v": 1, "server_name": "test", "characters": [{ "name": "ada" }] }),
    );
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        if frame.get("type").and_then(Value::as_str) == Some("hello") {
            send(
                reader.get_mut(),
                &json!({
                    "type": "history", "messages": [], "config": {},
                    "selected_character": "ada", "selected_thread": "main"
                }),
            );
            continue;
        }
        received.lock().unwrap().push(frame.clone());
        send(
            reader.get_mut(),
            &json!({ "type": "command_output", "name": frame.get("name"), "rid": frame.get("rid"), "data": data }),
        );
    }
}

fn asked(data: Value, args: &[&str]) -> (Output, Vec<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let received = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&received);
    let _server = std::thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else { return };
            let log = Arc::clone(&recorded);
            let answer = data.clone();
            let _worker = std::thread::spawn(move || serve(stream, &answer, &log));
        }
    });
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_shore"))
        .env_remove("SHORE_ADDR")
        .env_remove("SHORE_CHARACTER")
        .env_remove("SHORE_THREAD")
        .env("SHORE_TOKEN", "test-token")
        .env("SHORE_CONFIG_DIR", home.path().join("config"))
        .env("SHORE_DATA_DIR", home.path().join("data"))
        .env("SHORE_RUNTIME_DIR", home.path().join("runtime"))
        .env("SHORE_CACHE_DIR", home.path().join("cache"))
        .args(["--addr", &addr])
        .args(args)
        .output()
        .unwrap();
    let frames = received.lock().unwrap().clone();
    (output, frames)
}

fn printed(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn sent(frames: &[Value]) -> Vec<(Option<&str>, Option<&Value>)> {
    frames
        .iter()
        .map(|frame| (frame.get("name").and_then(Value::as_str), frame.get("args")))
        .collect()
}

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
