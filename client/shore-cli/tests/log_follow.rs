#![cfg(test)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};

use serde_json::{Value, json};

fn send(stream: &mut TcpStream, frame: &Value) {
    let _sent = writeln!(stream, "{frame}");
}

fn serve(stream: TcpStream, pushed: &[Value]) {
    stream.set_nonblocking(false).unwrap();
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
        send(
            reader.get_mut(),
            &json!({
                "type": "command_output", "name": frame.get("name"), "rid": frame.get("rid"),
                "data": {
                    "messages": [], "cursor": 0, "next_before": 0, "has_more_before": false,
                    "total_turns": 0, "segment": null, "previous_segment": null, "next_segment": null,
                },
            }),
        );
        for later in pushed {
            send(reader.get_mut(), later);
        }
    }
}

fn following(env: &[(&str, &str)]) -> Output {
    let pushed = [
        json!({
            "type": "new_message", "revision": 1, "character": "ada", "msg_id": "m_9",
            "role": "assistant", "content": "Look at this.",
            "content_blocks": [{ "type": "text", "text": "Look at this." }],
            "timestamp": "2026-11-23T10:00:00Z",
            "images": [{ "path": "sea.png", "caption": "the sea", "data": "cG5nLWJ5dGVz" }],
        }),
        json!({ "type": "shutdown" }),
    ];
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let _server = std::thread::spawn(move || {
        if let Ok((stream, _peer)) = listener.accept() {
            serve(stream, &pushed);
        }
    });
    let home = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_shore"))
        .env_clear()
        .env("SHORE_TOKEN", "test-token")
        .env("TZ", "UTC")
        .env("SHORE_CONFIG_DIR", home.path().join("config"))
        .env("SHORE_DATA_DIR", home.path().join("data"))
        .env("SHORE_RUNTIME_DIR", home.path().join("runtime"))
        .env("SHORE_CACHE_DIR", home.path().join("cache"))
        .envs(env.iter().copied())
        .args(["--addr", &addr, "log", "--follow"])
        .output()
        .unwrap()
}

#[test]
fn a_followed_reply_draws_its_picture_in_a_terminal_that_can_and_names_it_elsewhere() {
    let kitty = following(&[("SHORE_IMAGES", "kitty")]);
    assert!(kitty.status.success(), "{kitty:?}");
    let drawn = String::from_utf8_lossy(&kitty.stdout);
    assert!(drawn.contains("Look at this."), "{drawn}");
    assert!(
        drawn.contains("\u{1b}_Ga=T,f=100,m=0;cG5nLWJ5dGVz\u{1b}\\"),
        "{drawn:?}"
    );
    assert!(!drawn.contains("[img:"), "{drawn}");

    let plain = following(&[]);
    assert!(plain.status.success(), "{plain:?}");
    let named = String::from_utf8_lossy(&plain.stdout);
    assert!(named.contains("[img: the sea]"), "{named}");
    assert!(!named.contains("\u{1b}_G"), "{named:?}");
}
