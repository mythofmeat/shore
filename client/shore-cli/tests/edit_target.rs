#![cfg(test)]
#![cfg(unix)]

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::FromRawFd;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

#[expect(
    unsafe_code,
    reason = "a pseudo-terminal exercises the real interactive editor path"
)]
fn terminal_pair() -> (File, File) {
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: both output pointers are valid; null optional arguments request defaults.
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
    // SAFETY: successful openpty returned an owned master file descriptor.
    let master_file = unsafe { File::from_raw_fd(master) };
    // SAFETY: the slave descriptor is owned and distinct from the master.
    let slave_file = unsafe { File::from_raw_fd(slave) };
    (master_file, slave_file)
}

fn send(reader: &mut BufReader<TcpStream>, message: Value) {
    writeln!(reader.get_mut(), "{message}").unwrap();
}

fn receive(reader: &mut BufReader<TcpStream>) -> Value {
    let mut line = String::new();
    let _read = reader.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn edit_in_terminal(reference: &str, editor_body: &str) -> Option<Value> {
    let data = tempfile::tempdir().unwrap();
    let editor = data.path().join("editor.sh");
    std::fs::write(&editor, editor_body).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (_master, slave) = terminal_pair();
    let mut child = Command::new(env!("CARGO_BIN_EXE_shore"))
        .env("SHORE_DATA_DIR", data.path())
        .env("SHORE_TOKEN", "test-token")
        .env_remove("SHORE_THREAD")
        .env("VISUAL", format!("sh {}", editor.display()))
        .stdin(slave)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .args([
            "--addr",
            &address.to_string(),
            "--character",
            "test",
            "--thread",
            "main",
            "msg",
            "edit",
            reference,
        ])
        .spawn()
        .unwrap();
    let started = Instant::now();
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if started.elapsed() > Duration::from_secs(10) {
                    let _killed = child.kill();
                    let output = child.wait_with_output().unwrap();
                    panic!(
                        "client did not connect: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("accept failed: {error}"),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    send(
        &mut reader,
        json!({
            "type": "hello", "v": 1, "server_name": "test", "characters": []
        }),
    );
    let _hello = receive(&mut reader);
    send(
        &mut reader,
        json!({
            "type": "history", "messages": [], "config": {},
            "selected_character": "test", "selected_thread": "main"
        }),
    );
    let get = receive(&mut reader);
    assert_eq!(get.get("name").and_then(Value::as_str), Some("get"));
    assert_eq!(
        get.pointer("/args/ref").and_then(Value::as_str),
        Some(reference)
    );
    send(
        &mut reader,
        json!({
            "type": "command_output", "rid": get.get("rid"), "name": "get",
            "data": { "msg_id": "m_original", "role": "user", "content": "original text",
                      "timestamp": "2026-09-10T00:00:00Z" }
        }),
    );
    send(
        &mut reader,
        json!({
            "type": "new_message", "character": "test", "msg_id": "m_new",
            "role": "user", "content": "new arrival", "timestamp": "2026-09-10T00:00:01Z"
        }),
    );
    let mut line = String::new();
    let _read = reader.read_line(&mut line).unwrap();
    let edit = if line.is_empty() {
        None
    } else {
        let command: Value = serde_json::from_str(&line).unwrap();
        send(
            &mut reader,
            json!({
                "type": "command_output", "rid": command.get("rid"), "name": "edit",
                "data": { "ref": command.pointer("/args/ref"), "edited": true }
            }),
        );
        Some(command)
    };
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    edit
}

#[test]
fn shell_editor_keeps_the_fetched_message_id_after_a_new_arrival() {
    for reference in ["last", "-1", "1", "m_original"] {
        let edit = edit_in_terminal(
            reference,
            "test \"$(cat \"$1\")\" = 'original text' || exit 1\nprintf 'replacement' > \"$1\"\n",
        )
        .expect("saving changed text should send an edit");
        assert_eq!(edit.get("name").unwrap(), "edit");
        assert_eq!(
            edit.pointer("/args/ref").unwrap(),
            "m_original",
            "requested {reference}"
        );
        assert_eq!(edit.pointer("/args/content").unwrap(), "replacement");
    }
}

#[test]
fn closing_the_shell_editor_unchanged_sends_no_edit() {
    assert!(edit_in_terminal("last", "exit 0\n").is_none());
}
