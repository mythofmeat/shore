#![cfg(test)]

mod support;

use std::process::Output;

use serde_json::{Value, json};

use support::{StandIn, at, shore_in};

fn daemon() -> StandIn {
    StandIn::start(&["ada", "bo"], None, |hello, frame| {
        if frame["type"] == "hello" {
            let character = hello
                .get("character")
                .and_then(Value::as_str)
                .filter(|name| ["ada", "bo"].contains(name));
            let thread = hello
                .get("thread")
                .and_then(Value::as_str)
                .filter(|name| ["main", "garden"].contains(name));
            return vec![
                json!({ "type": "history", "selected_character": character.unwrap_or("ada"), "selected_thread": thread.unwrap_or("main") }),
            ];
        }
        match frame["type"].as_str() {
            Some("message" | "regen") => vec![
                json!({ "type": "stream_start", "rid": "r1", "regen": frame["type"] == "regen" }),
                json!({ "type": "stream_chunk", "rid": "r1", "text": "hello back", "content_type": "text" }),
                json!({
                    "type": "stream_end", "rid": "r1", "content": "hello back", "finish_reason": "end_turn", "is_final": true,
                    "metadata": { "tokens": { "input": 1, "output": 1, "cache_read": 0, "cache_write": 0 }, "timing": { "total_ms": 1, "ttft_ms": 1 }, "model": "m" },
                }),
            ],
            _ => Vec::new(),
        }
    })
}

fn run(stand_in: &StandIn, home: &std::path::Path, args: &[&str]) -> Output {
    shore_in(home, &stand_in.addr).args(args).output().unwrap()
}

fn sent(stand_in: &StandIn, kind: &str) -> Value {
    let frame = stand_in
        .frames()
        .into_iter()
        .find(|frame| frame["type"] == kind)
        .unwrap();
    serde_json::from_str(at(&frame, &["sent"]).as_str().unwrap()).unwrap()
}

#[test]
fn a_message_is_posted_as_the_operation_s_own_arguments_and_its_reply_streams_back() {
    let stand_in = daemon();
    let home = tempfile::tempdir().unwrap();
    let said = run(
        &stand_in,
        home.path(),
        &["--character", "bo", "msg", "send", "hi", "there"],
    );
    assert!(said.status.success(), "{said:?}");
    assert!(
        String::from_utf8_lossy(&said.stdout).contains("hello back"),
        "{said:?}"
    );
    assert_eq!(
        sent(&stand_in, "message"),
        json!({ "text": "hi there", "stream": true, "images": [] })
    );
    let asked = stand_in
        .frames()
        .into_iter()
        .find(|frame| frame["type"] == "message")
        .unwrap();
    assert_eq!(
        at(&asked, &["rid"]),
        "r1",
        "the daemon names the request, not the CLI"
    );

    let again = run(
        &stand_in,
        home.path(),
        &["msg", "regen", "--reason", "shorter"],
    );
    assert!(again.status.success(), "{again:?}");
    assert_eq!(
        sent(&stand_in, "regen"),
        json!({ "stream": true, "reason": "shorter" })
    );
}

#[test]
fn switching_character_or_thread_checks_the_name_with_the_daemon_and_saves_only_one_it_serves() {
    let stand_in = daemon();
    let home = tempfile::tempdir().unwrap();
    let switched = run(&stand_in, home.path(), &["character", "use", "bo"]);
    assert!(switched.status.success(), "{switched:?}");
    assert_eq!(
        std::fs::read_to_string(home.path().join("data").join("active_character"))
            .unwrap()
            .trim(),
        "bo"
    );
    let unknown = run(&stand_in, home.path(), &["character", "use", "nobody"]);
    assert!(!unknown.status.success(), "{unknown:?}");
    assert!(
        String::from_utf8_lossy(&unknown.stderr).contains("no character named \"nobody\""),
        "{unknown:?}"
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("data").join("active_character"))
            .unwrap()
            .trim(),
        "bo",
        "unchanged"
    );

    let threaded = run(&stand_in, home.path(), &["thread", "use", "garden"]);
    assert!(threaded.status.success(), "{threaded:?}");
    assert_eq!(
        std::fs::read_to_string(home.path().join("data").join("active_thread").join("bo"))
            .unwrap()
            .trim(),
        "garden"
    );
    let missing = run(&stand_in, home.path(), &["thread", "use", "attic"]);
    assert!(!missing.status.success(), "{missing:?}");
    assert!(
        String::from_utf8_lossy(&missing.stderr).contains("no thread named \"attic\" for bo"),
        "{missing:?}"
    );
    let asked: Vec<Value> = stand_in
        .frames()
        .into_iter()
        .filter(|frame| frame["type"] == "hello")
        .map(|frame| json!([at(&frame, &["character"]), at(&frame, &["thread"])]))
        .collect();
    assert!(
        asked.contains(&json!(["bo", "attic"])),
        "the thread is asked for under the character it belongs to: {asked:?}"
    );
    assert!(
        stand_in
            .frames()
            .iter()
            .all(|frame| frame["type"] == "hello"),
        "no switch operation is sent"
    );
}

#[test]
fn the_version_probe_needs_no_sign_in_and_tells_a_shore_daemon_from_anything_else() {
    let shore = StandIn::start(&["ada"], Some("9.9.9"), |_, _| Vec::new());
    let home = tempfile::tempdir().unwrap();
    std::fs::remove_dir_all(home.path()).unwrap();
    let probed = shore_in(home.path(), &shore.addr)
        .arg("--version")
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&probed.stdout)
            .contains(&format!("daemon 9.9.9 at {}", shore.addr)),
        "{probed:?}"
    );
    let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = other.local_addr().unwrap().to_string();
    let _answer = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = other.accept() {
            use std::io::{Read as _, Write as _};
            let mut buffer = [0_u8; 1024];
            let _read = stream.read(&mut buffer);
            let _sent = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi");
        }
    });
    let elsewhere = shore_in(home.path(), &address)
        .arg("--version")
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&elsewhere.stdout).contains("isn't a Shore daemon"),
        "{elsewhere:?}"
    );
}
