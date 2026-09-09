#![cfg(test)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

fn send(stream: &mut TcpStream, message: Value) {
    writeln!(stream, "{message}").unwrap();
}

fn serve(stream: TcpStream, requested: &str, selected: &str, runs_command: bool) {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    send(
        reader.get_mut(),
        json!({
            "type": "hello", "v": 1, "server_name": "test", "characters": []
        }),
    );
    let mut line = String::new();
    let _read = reader.read_line(&mut line).unwrap();
    let hello: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(hello.get("thread").and_then(Value::as_str), Some(requested));
    send(
        reader.get_mut(),
        json!({
            "type": "history", "messages": [], "config": {},
            "selected_character": "qifei", "selected_thread": selected
        }),
    );
    line.clear();
    let _read_command = reader.read_line(&mut line).unwrap();
    if runs_command {
        let command: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(command.get("name").and_then(Value::as_str), Some("log"));
        send(
            reader.get_mut(),
            json!({
                "type": "command_output", "name": "log", "rid": command.get("rid"),
                "data": {"messages": [], "selected_thread": selected}
            }),
        );
    } else {
        assert!(
            line.is_empty(),
            "no command should run on the rejected connection"
        );
    }
}

fn run(
    data: &Path,
    env_thread: Option<&str>,
    flag_thread: Option<&str>,
    connections: Vec<(&'static str, &'static str, bool)>,
) -> Output {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut workers = Vec::new();
        for (requested, selected, runs_command) in connections {
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            started.elapsed() < Duration::from_secs(10),
                            "client did not connect"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            workers.push(std::thread::spawn(move || {
                serve(stream, requested, selected, runs_command);
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_shore"));
    let _configured = command
        .env("SHORE_DATA_DIR", data)
        .env("SHORE_TOKEN", "test-token")
        .env_remove("SHORE_THREAD")
        .args(["--addr", &addr.to_string(), "--character", "qifei"]);
    if let Some(thread) = env_thread {
        let _env = command.env("SHORE_THREAD", thread);
    }
    if let Some(thread) = flag_thread {
        let _flag = command.args(["--thread", thread]);
    }
    let output = command.args(["log", "--json"]).output().unwrap();
    server.join().unwrap();
    output
}

fn save(data: &Path, thread: &str) {
    std::fs::create_dir_all(data.join("active_thread")).unwrap();
    std::fs::write(data.join("active_thread/qifei"), thread).unwrap();
}

fn saved(data: &Path) -> String {
    std::fs::read_to_string(data.join("active_thread/qifei")).unwrap()
}

#[test]
fn stale_saved_thread_recovers_and_the_next_invocation_uses_the_repaired_choice() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "eval");
    let first = run(data.path(), None, None, vec![("eval", "home", true)]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(saved(data.path()), "home");
    assert!(String::from_utf8_lossy(&first.stderr).contains("using \"home\""));
    assert!(
        serde_json::from_slice::<Value>(&first.stdout).is_ok(),
        "stdout remains JSON"
    );

    let second = run(data.path(), None, None, vec![("home", "home", true)]);
    assert!(second.status.success());
    assert!(second.stderr.is_empty(), "recovery is not repeated");
}

#[test]
fn stale_environment_thread_tries_the_saved_thread_before_home() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "work");
    let output = run(
        data.path(),
        Some("eval"),
        None,
        vec![("eval", "home", false), ("work", "work", true)],
    );
    assert!(output.status.success());
    assert_eq!(saved(data.path()), "work");
    assert!(String::from_utf8_lossy(&output.stderr).contains("using \"work\""));
}

#[test]
fn stale_environment_and_saved_threads_fall_back_to_home() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "work");
    let output = run(
        data.path(),
        Some("eval"),
        None,
        vec![("eval", "home", false), ("work", "home", true)],
    );
    assert!(output.status.success());
    assert_eq!(saved(data.path()), "home");
}

#[test]
fn stale_environment_thread_without_a_saved_choice_uses_home() {
    let data = tempfile::tempdir().unwrap();
    let output = run(
        data.path(),
        Some("eval"),
        None,
        vec![("eval", "home", true)],
    );
    assert!(output.status.success());
    assert_eq!(saved(data.path()), "home");
}

#[test]
fn explicit_missing_thread_is_refused_even_when_it_matches_the_environment() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "work");
    let output = run(
        data.path(),
        Some("eval"),
        Some("eval"),
        vec![("eval", "home", false)],
    );
    assert!(!output.status.success());
    assert_eq!(saved(data.path()), "work");
    assert!(String::from_utf8_lossy(&output.stderr).contains("you asked for it with --thread"));
}

#[test]
fn valid_saved_thread_is_resumed_without_a_fallback() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "eval");
    let output = run(data.path(), None, None, vec![("eval", "eval", true)]);
    assert!(output.status.success());
    assert_eq!(saved(data.path()), "eval");
    assert!(output.stderr.is_empty());
}
