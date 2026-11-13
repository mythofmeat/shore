use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

fn send(stream: &mut TcpStream, frame: &Value) {
    let _sent = writeln!(stream, "{frame}");
}

fn serve(stream: TcpStream, version: Option<&str>, data: &Value, received: &Mutex<Vec<Value>>) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut hello = json!({ "type": "hello", "v": 1, "server_name": "test", "characters": [{ "name": "ada" }] });
    if let (Some(reported), Some(fields)) = (version, hello.as_object_mut()) {
        let _replaced = fields.insert("server_version".to_owned(), json!(reported));
    }
    send(reader.get_mut(), &hello);
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

pub(crate) fn asked(data: Value, args: &[&str]) -> (Output, Vec<Value>) {
    asked_of(None, data, args)
}

pub(crate) fn asked_of(version: Option<&str>, data: Value, args: &[&str]) -> (Output, Vec<Value>) {
    let reported = version.map(str::to_owned);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let received = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&received);
    let _server = std::thread::spawn(move || {
        for incoming in listener.incoming() {
            let Ok(stream) = incoming else { return };
            let log = Arc::clone(&recorded);
            let answer = data.clone();
            let told = reported.clone();
            let _worker = std::thread::spawn(move || serve(stream, told.as_deref(), &answer, &log));
        }
    });
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_shore"))
        .env_remove("SHORE_ADDR")
        .env_remove("SHORE_CHARACTER")
        .env_remove("SHORE_THREAD")
        .env("SHORE_TOKEN", "test-token")
        .env("TZ", "UTC")
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

pub(crate) fn printed(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

pub(crate) fn sent(frames: &[Value]) -> Vec<(Option<&str>, Option<&Value>)> {
    frames
        .iter()
        .map(|frame| (frame.get("name").and_then(Value::as_str), frame.get("args")))
        .collect()
}
