#![cfg(test)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

fn send(stream: &mut TcpStream, message: Value) {
    writeln!(stream, "{message}").unwrap();
}

fn reply(text: &str, msg_id: &str) -> Value {
    json!({
        "type": "new_message", "revision": 2, "character": "wren", "thread": "home",
        "msg_id": msg_id, "role": "assistant", "content": text,
        "content_blocks": [], "timestamp": "2026-10-03T17:23:00Z"
    })
}

fn stream_end(text: &str) -> Value {
    json!({
        "type": "stream_end", "content": text, "is_final": true,
        "metadata": {
            "tokens": {"input": 1, "output": 1, "cache_read": 0, "cache_write": 0},
            "timing": {"total_ms": 1, "ttft_ms": 1}, "model": "test"
        }
    })
}

fn serve_new_message_before_final_stream_end(stream: TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    send(
        reader.get_mut(),
        json!({"type": "hello", "v": 1, "server_name": "test", "characters": []}),
    );
    let mut line = String::new();
    let _hello = reader.read_line(&mut line).unwrap();
    send(
        reader.get_mut(),
        json!({
            "type": "history", "messages": [], "config": {},
            "selected_character": "wren", "selected_thread": "home"
        }),
    );
    line.clear();
    let _command = reader.read_line(&mut line).unwrap();
    let command: Value = serde_json::from_str(&line).unwrap();
    let out = reader.get_mut();
    send(
        out,
        json!({
            "type": "command_output", "name": "log", "rid": command.get("rid"),
            "data": {"messages": [], "selected_thread": "home", "cursor": 0,
                "next_before": 0, "has_more_before": false, "total_turns": 0,
                "segment": null, "previous_segment": null, "next_segment": null}
        }),
    );
    send(
        out,
        json!({
            "type": "new_message", "revision": 1, "character": "wren", "thread": "home",
            "msg_id": "u1", "role": "user", "content": "fifth question",
            "content_blocks": [], "timestamp": "2026-10-03T17:23:00Z"
        }),
    );
    send(out, json!({"type": "stream_start"}));
    send(
        out,
        json!({"type": "stream_chunk", "text": "Answer 5: ", "content_type": "text"}),
    );
    send(
        out,
        json!({"type": "stream_chunk", "text": "fifth question", "content_type": "text"}),
    );
    send(out, reply("Answer 5: fifth question", "a1"));
    send(out, stream_end("Answer 5: fifth question"));
    send(out, reply("Unstreamed note", "a2"));
    send(out, json!({"type": "shutdown"}));
}

#[test]
fn a_streamed_reply_prints_once_while_following() {
    let data = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        serve_new_message_before_final_stream_end(listener.accept().unwrap().0)
    });
    let output = Command::new(env!("CARGO_BIN_EXE_shore"))
        .env("SHORE_DATA_DIR", data.path())
        .env("SHORE_TOKEN", "test-token")
        .env_remove("SHORE_THREAD")
        .args(["--addr", &addr.to_string(), "--character", "wren"])
        .args(["log", "-f"])
        .output()
        .unwrap();
    server.join().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        stdout.matches("Answer 5: fifth question").count(),
        1,
        "{stdout}"
    );
    assert!(stdout.contains("fifth question\n"), "{stdout}");
    assert!(stdout.contains("Unstreamed note"), "{stdout}");
}
