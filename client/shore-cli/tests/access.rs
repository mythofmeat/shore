#![cfg(test)]

mod support;

use std::io::Write as _;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use support::{StandIn, at, nth, shore_in};

fn hello() -> Value {
    json!({ "type": "history", "selected_character": "ada", "selected_thread": "main" })
}

fn answer(status: u64, body: Value) -> Vec<Value> {
    vec![json!({ "type": "http", "status": status, "body": body })]
}

fn path(frame: &Value) -> &str {
    frame
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

type Reply = (u64, Value);

struct Door {
    state: Reply,
    chosen: Reply,
    signed: Reply,
}

fn opened(password_set: bool) -> Door {
    Door {
        state: (200, json!({ "password_set": password_set })),
        chosen: (204, Value::Null),
        signed: (200, json!({ "token": "shore_mine" })),
    }
}

fn signing_in(door: Door) -> (StandIn, Arc<Mutex<Vec<Value>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&asked);
    let daemon = StandIn::start(&["ada"], None, move |_, frame| {
        if frame["type"] == "hello" {
            return vec![hello()];
        }
        if frame["type"] == "command" {
            return vec![
                json!({ "type": "command_output", "name": frame["name"], "rid": frame["rid"], "data": { "statuses": [], "history": [] } }),
            ];
        }
        seen.lock().unwrap().push(frame.clone());
        let (status, body) = match (frame["method"].as_str(), path(frame)) {
            (Some("GET"), "/api/sign-in") => door.state.clone(),
            (Some("POST"), "/api/password") => door.chosen.clone(),
            (Some("POST"), "/api/sign-in") => door.signed.clone(),
            _ => (404, json!({ "code": "not_found", "message": "gone" })),
        };
        if status == 204 {
            return Vec::new();
        }
        answer(status, body)
    });
    (daemon, asked)
}

fn unsigned(home: &std::path::Path, addr: &str) -> Command {
    let command = shore_in(home, addr);
    std::fs::remove_file(home.join("config").join("sign-ins.toml")).unwrap();
    command
}

fn piped(mut command: Command, typed: &str) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(typed.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn asked_of(asked: &Arc<Mutex<Vec<Value>>>) -> Vec<(String, String, Value)> {
    asked
        .lock()
        .unwrap()
        .iter()
        .map(|frame| {
            (
                frame["method"].as_str().unwrap_or_default().to_owned(),
                path(frame).to_owned(),
                frame["body"].clone(),
            )
        })
        .collect()
}

fn kept(home: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(home.join("config").join("sign-ins.toml")).ok()
}

#[test]
fn signing_in_with_the_password_keeps_the_cli_s_own_credential_and_uses_it() {
    let (daemon, asked) = signing_in(opened(true));
    let home = tempfile::tempdir().unwrap();
    let origin = format!("http://{}", daemon.addr);
    let mut command = unsigned(home.path(), &daemon.addr);
    let _args = command.args([
        "sign-in",
        &format!("{}/", daemon.addr),
        "--name",
        "desk",
        "--stdin",
    ]);
    let output = piped(command, "hunter22 two\r\n");
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        stdout(&output),
        format!(
            "Signed in to {origin}; the credential is kept in {}.\nPoint the CLI there with --addr {origin}, SHORE_ADDR, or default_address in client.toml.",
            home.path().join("config").join("sign-ins.toml").display()
        )
    );
    assert_eq!(
        asked_of(&asked),
        vec![
            ("GET".to_owned(), "/api/sign-in".to_owned(), Value::Null),
            (
                "POST".to_owned(),
                "/api/sign-in".to_owned(),
                json!({ "name": "desk", "password": "hunter22 two" })
            ),
        ],
        "it asks whether there is a password, then signs in with it, the line ending dropped"
    );
    assert_eq!(
        kept(home.path()).unwrap_or_default(),
        format!("\"{origin}\" = \"shore_mine\"\n")
    );

    let mut listed = shore_in(home.path(), &daemon.addr);
    std::fs::write(
        home.path().join("config").join("sign-ins.toml"),
        format!("\"{origin}\" = \"shore_mine\"\n"),
    )
    .unwrap();
    let ran = listed.args(["character"]).output().unwrap();
    assert!(ran.status.success(), "{ran:?}");
    let tokens: Vec<Value> = daemon
        .frames()
        .iter()
        .filter(|frame| frame["type"] == "hello")
        .map(|frame| frame["token"].clone())
        .collect();
    assert_eq!(
        tokens.last(),
        Some(&json!("shore_mine")),
        "later commands use the CLI's own credential"
    );
}

#[test]
fn a_daemon_with_no_password_has_one_chosen_first_and_then_signs_in_with_it() {
    let (daemon, asked) = signing_in(opened(false));
    let home = tempfile::tempdir().unwrap();
    let mut command = unsigned(home.path(), &daemon.addr);
    let _args = command.args(["sign-in", &daemon.addr, "--name", "desk", "--stdin"]);
    let output = piped(command, "first pass\n");
    assert!(output.status.success(), "{output:?}");
    assert!(
        stderr(&output).contains(&format!(
            "http://{} has no password yet. Choose one; every browser and CLI signs in with it.",
            daemon.addr
        )),
        "{}",
        stderr(&output)
    );
    assert_eq!(
        asked_of(&asked),
        vec![
            ("GET".to_owned(), "/api/sign-in".to_owned(), Value::Null),
            (
                "POST".to_owned(),
                "/api/password".to_owned(),
                json!({ "password": "first pass" })
            ),
            (
                "POST".to_owned(),
                "/api/sign-in".to_owned(),
                json!({ "name": "desk", "password": "first pass" })
            ),
        ]
    );
    assert!(
        kept(home.path()).is_some_and(|text| text.contains("shore_mine")),
        "the credential is kept"
    );
}

#[test]
fn a_refused_password_or_an_unreadable_answer_says_so_and_keeps_nothing() {
    let refused = |status: u64, message: &str| {
        (
            status,
            json!({ "code": "unauthorized", "message": message }),
        )
    };
    for (door, said) in [
        (
            Door {
                signed: refused(401, "That password isn’t right"),
                ..opened(true)
            },
            "That password isn’t right",
        ),
        (
            Door {
                chosen: refused(400, "Choose a password of at least 8 characters"),
                ..opened(false)
            },
            "Choose a password of at least 8 characters",
        ),
        (
            Door {
                state: (500, json!("not a problem")),
                ..opened(true)
            },
            "the daemon answered HTTP 500",
        ),
        (
            Door {
                state: (200, json!({ "set": true })),
                ..opened(true)
            },
            "missing field `password_set`",
        ),
        (
            Door {
                signed: (200, json!({})),
                ..opened(true)
            },
            "missing field `token`",
        ),
    ] {
        let (daemon, _) = signing_in(door);
        let home = tempfile::tempdir().unwrap();
        let mut command = unsigned(home.path(), &daemon.addr);
        let _args = command.args(["sign-in", &daemon.addr, "--stdin"]);
        let output = piped(command, "hunter22");
        assert!(!output.status.success(), "{output:?}");
        assert!(
            stderr(&output).contains(said),
            "{said}: {}",
            stderr(&output)
        );
        assert_eq!(kept(home.path()), None, "nothing is kept");
    }
}

#[test]
fn a_sign_in_nobody_answers_says_where_it_looked() {
    let home = tempfile::tempdir().unwrap();
    let mut command = unsigned(home.path(), "127.0.0.1:1");
    let _args = command.args(["sign-in", "127.0.0.1:1", "--stdin"]);
    let output = piped(command, "hunter22");
    assert!(!output.status.success(), "{output:?}");
    assert!(
        stderr(&output).contains("nothing answered at http://127.0.0.1:1 ("),
        "{}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains(
            "port 7340 unless changed, so try http://127.0.0.1:7340; the old TCP port 7320 is gone"
        ),
        "{}",
        stderr(&output)
    );
}

#[test]
fn without_a_terminal_or_stdin_the_password_has_nowhere_to_come_from() {
    for password_set in [true, false] {
        let (daemon, asked) = signing_in(opened(password_set));
        let home = tempfile::tempdir().unwrap();
        let output = unsigned(home.path(), &daemon.addr)
            .args(["sign-in", &daemon.addr])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{output:?}");
        assert!(
            stderr(&output).contains(
                "there's no terminal to ask for the password on; pipe it in with --stdin"
            ),
            "{}",
            stderr(&output)
        );
        assert_eq!(asked_of(&asked).len(), 1, "only the question was asked");
    }
}

#[test]
fn a_sign_in_without_a_name_goes_by_this_computer_s_name() {
    let (daemon, asked) = signing_in(opened(true));
    let home = tempfile::tempdir().unwrap();
    let mut command = unsigned(home.path(), &daemon.addr);
    let _args = command.args(["sign-in", &daemon.addr, "--stdin"]);
    let _output = piped(command, "hunter22");
    let expected = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap()
        .trim()
        .to_owned();
    assert!(!expected.is_empty(), "the test machine has a name");
    let bodies: Vec<Value> = asked_of(&asked)
        .into_iter()
        .map(|(_, _, body)| body)
        .collect();
    assert_eq!(at(nth(&bodies, 1), &["name"]), expected.as_str());
}

#[cfg(target_os = "linux")]
struct Terminal {
    master: std::fs::File,
    shown: std::sync::mpsc::Receiver<Vec<u8>>,
    seen: Vec<u8>,
    child: std::process::Child,
}

#[cfg(target_os = "linux")]
impl Terminal {
    #[expect(
        unsafe_code,
        reason = "a pseudo-terminal opens only through libc::openpty, which has no safe std wrapper"
    )]
    fn run(mut command: Command) -> Self {
        use std::os::fd::{FromRawFd as _, OwnedFd};
        let mut master_fd = -1;
        let mut slave_fd = -1;
        // SAFETY: openpty only writes the two descriptors it opens into the integers it is given; the name, settings and size may be null.
        let opened = unsafe {
            libc::openpty(
                &raw mut master_fd,
                &raw mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        assert_eq!(opened, 0, "a pseudo-terminal opens");
        // SAFETY: openpty just opened this descriptor and nothing else owns it.
        let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
        // SAFETY: openpty just opened this descriptor and nothing else owns it.
        let slave = unsafe { OwnedFd::from_raw_fd(slave_fd) };
        let child = command
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave))
            .spawn()
            .unwrap();
        drop(command);
        let mut reader = master.try_clone().unwrap();
        let (sender, shown) = std::sync::mpsc::channel();
        let _reading = std::thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            while let Ok(count) = std::io::Read::read(&mut reader, &mut buffer) {
                if count == 0
                    || sender
                        .send(buffer.get(..count).unwrap_or_default().to_vec())
                        .is_err()
                {
                    break;
                }
            }
        });
        Self {
            master,
            shown,
            seen: Vec::new(),
            child,
        }
    }

    fn shown(&self) -> String {
        String::from_utf8_lossy(&self.seen).into_owned()
    }

    fn type_after(&mut self, prompt: &str, keys: &[u8]) {
        while !self.shown().contains(prompt) {
            let more = self
                .shown
                .recv_timeout(std::time::Duration::from_secs(20))
                .unwrap_or_else(|_| panic!("no {prompt:?} on the terminal: {:?}", self.shown()));
            self.seen.extend(more);
        }
        self.seen.clear();
        self.master.write_all(keys).unwrap();
    }

    fn finish(mut self) -> (std::process::ExitStatus, String) {
        let status = self.child.wait().unwrap();
        while let Ok(more) = self.shown.recv_timeout(std::time::Duration::from_secs(20)) {
            self.seen.extend(more);
        }
        (status, self.shown())
    }
}

#[cfg(target_os = "linux")]
#[test]
fn on_a_terminal_the_password_is_asked_for_without_showing_it_and_edited_as_typed() {
    let (daemon, asked) = signing_in(opened(true));
    let home = tempfile::tempdir().unwrap();
    let mut command = unsigned(home.path(), &daemon.addr);
    let _args = command.args(["sign-in", &daemon.addr, "--name", "desk"]);
    let mut terminal = Terminal::run(command);
    terminal.type_after(
        "Password (not shown as you type): ",
        b"junk\x15secrex\x7ft\x01 updates\r",
    );
    let (status, shown) = terminal.finish();
    assert!(status.success(), "{shown}");
    assert!(
        !shown.contains("secret") && !shown.contains("junk"),
        "nothing typed is shown: {shown:?}"
    );
    assert_eq!(
        asked_of(&asked)
            .get(1)
            .map(|(_, _, body)| body["password"].clone()),
        Some(json!("secret updates")),
        "Ctrl-U clears, Backspace takes one back, other control keys type nothing"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn on_a_terminal_a_first_password_is_typed_twice_and_must_match() {
    for (again, chosen) in [(&b"first pass\r"[..], true), (&b"first pasz\r"[..], false)] {
        let (daemon, asked) = signing_in(opened(false));
        let home = tempfile::tempdir().unwrap();
        let mut command = unsigned(home.path(), &daemon.addr);
        let _args = command.args(["sign-in", &daemon.addr, "--name", "desk"]);
        let mut terminal = Terminal::run(command);
        terminal.type_after("New password (not shown as you type): ", b"first pass\r");
        terminal.type_after("Type it again: ", again);
        let (status, shown) = terminal.finish();
        let paths: Vec<String> = asked_of(&asked)
            .into_iter()
            .map(|(_, path, _)| path)
            .collect();
        if chosen {
            assert!(status.success(), "{shown}");
            assert_eq!(
                paths,
                ["/api/sign-in", "/api/password", "/api/sign-in"],
                "{shown}"
            );
        } else {
            assert!(!status.success(), "{shown}");
            assert!(
                shown.contains("the two passwords differ; nothing changed"),
                "{shown}"
            );
            assert_eq!(paths, ["/api/sign-in"], "nothing is chosen: {shown}");
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn on_a_terminal_escape_ctrl_c_or_ctrl_d_gives_up_without_signing_in() {
    for key in [&b"\x1b"[..], b"ab\x03", b"ab\x04"] {
        let (daemon, asked) = signing_in(opened(true));
        let home = tempfile::tempdir().unwrap();
        let mut command = unsigned(home.path(), &daemon.addr);
        let _args = command.args(["sign-in", &daemon.addr]);
        let mut terminal = Terminal::run(command);
        terminal.type_after("Password (not shown as you type): ", key);
        let (status, shown) = terminal.finish();
        assert!(!status.success(), "{key:?}: {shown}");
        assert!(
            shown.contains("cancelled; nothing changed"),
            "{key:?}: {shown}"
        );
        assert_eq!(
            asked_of(&asked).len(),
            1,
            "{key:?}: only the question was asked"
        );
        assert_eq!(kept(home.path()), None, "{key:?}: nothing is kept");
    }
}

fn devices(args: &[&str], reply: Value) -> (Output, Vec<Value>, String) {
    let daemon = StandIn::start(&["ada"], None, move |_, frame| {
        if frame["type"] == "hello" {
            return vec![hello()];
        }
        match path(frame) {
            "/api/devices/list" => answer(200, reply.clone()),
            "/api/login-code" => answer(200, json!({ "code": "c0de", "expires_at": 1 })),
            _ => Vec::new(),
        }
    });
    let home = tempfile::tempdir().unwrap();
    let output = shore_in(home.path(), &daemon.addr)
        .args(args)
        .output()
        .unwrap();
    let asked = daemon
        .frames()
        .into_iter()
        .filter(|frame| frame["type"] == "web")
        .collect();
    (output, asked, format!("http://{}", daemon.addr))
}

fn listing() -> Value {
    json!({
        "devices": [
            { "id": "b1", "kind": "browser", "name": "Firefox on Linux", "created_at": 0, "last_used_at": 0, "current": false },
            { "id": "c1", "kind": "cli", "name": "desk", "created_at": 0, "last_used_at": 1_700_000_000_000_u64, "current": true },
            { "id": "k1", "kind": "automation", "name": "Phone", "created_at": 0, "operations": ["presence", "status"], "current": false },
        ],
    })
}

#[test]
fn the_devices_list_shows_who_is_signed_in() {
    let (output, asked, _) = devices(&["devices"], listing());
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        stdout(&output),
        "Signed in:\n  b1  Firefox on Linux · browser · not used yet\n  c1  desk · command line · used 2023-11-14 22:13  (this one)\n  k1  Phone · automation key for presence, status · not used yet"
    );
    assert_eq!(asked.len(), 1, "{asked:?}");
    let (raw, _, _) = devices(&["devices", "--json"], listing());
    let printed: Value = serde_json::from_str(&stdout(&raw)).unwrap();
    assert_eq!(printed, listing(), "JSON is the list as the daemon sent it");
    let (bare, _, _) = devices(&["devices"], json!({ "devices": [] }));
    assert_eq!(stdout(&bare), "Signed in:", "nothing listed");
}

#[test]
fn a_device_is_signed_out_by_its_id_and_nothing_lets_a_cli_in_by_a_code_any_more() {
    let (signed_out, revoked, _) = devices(&["devices", "sign-out", "k1"], Value::Null);
    assert_eq!(stdout(&signed_out), "Signed out k1.", "{signed_out:?}");
    assert_eq!(
        (path(nth(&revoked, 0)), at(nth(&revoked, 0), &["body"])),
        ("/api/devices/revoke", &json!({ "id": "k1" }))
    );
    for gone in ["allow", "refuse"] {
        let (output, asked, _) = devices(&["devices", gone, "4F7K"], Value::Null);
        assert!(!output.status.success(), "{gone}: {output:?}");
        assert!(asked.is_empty(), "{gone}: nothing reached the daemon");
    }
}

#[test]
fn a_sign_in_link_names_the_address_a_browser_opens() {
    let (here, _, origin) = devices(&["devices", "link"], Value::Null);
    assert_eq!(
        stdout(&here),
        format!(
            "{origin}/#login=c0de\nOpen it in the browser within five minutes; it works once and saves typing the password there."
        )
    );
    let (there, _, _) = devices(
        &["devices", "link", "--address", "phone.example:7340"],
        Value::Null,
    );
    assert!(
        stdout(&there).starts_with("http://phone.example:7340/#login=c0de\n"),
        "{}",
        stdout(&there)
    );
    let (raw, _, _) = devices(
        &[
            "devices",
            "--json",
            "link",
            "--address",
            "https://shore.example",
        ],
        Value::Null,
    );
    assert_eq!(
        serde_json::from_str::<Value>(&stdout(&raw)).unwrap(),
        json!({ "link": "https://shore.example/#login=c0de", "code": "c0de", "expires_at": 1 })
    );
}

#[test]
fn a_cli_that_isnt_signed_in_is_told_how_to_sign_in() {
    let daemon = StandIn::start(&["ada"], None, |_, frame| {
        if frame["type"] == "hello" {
            return vec![
                json!({ "type": "error", "code": "unauthorized", "message": "This credential isn't signed in to this daemon; sign in again" }),
            ];
        }
        Vec::new()
    });
    let home = tempfile::tempdir().unwrap();
    let output = shore_in(home.path(), &daemon.addr)
        .args(["status"])
        .output()
        .unwrap();
    assert!(!output.status.success(), "{output:?}");
    assert!(
        stderr(&output).contains(&format!(
            "sign in again. Sign in with `shore sign-in http://{}`",
            daemon.addr
        )),
        "{}",
        stderr(&output)
    );
    let nowhere = tempfile::tempdir().unwrap();
    let missing = shore_in(nowhere.path(), "127.0.0.1:1")
        .args(["status"])
        .output()
        .unwrap();
    assert!(
        stderr(&missing).contains(
            "port 7340 unless changed, so try http://127.0.0.1:7340; the old TCP port 7320 is gone"
        ),
        "{}",
        stderr(&missing)
    );
    std::fs::write(
        nowhere.path().join("config").join("token"),
        "a daemon token\n",
    )
    .unwrap();
    let unsigned_run = unsigned(nowhere.path(), &daemon.addr)
        .args(["status"])
        .output()
        .unwrap();
    assert!(
        stderr(&unsigned_run).contains(&format!(
            "this CLI isn't signed in to http://{0}. Run `shore sign-in http://{0}` and give the daemon's password.",
            daemon.addr
        )),
        "a token file in the config folder is never read: {}",
        stderr(&unsigned_run)
    );
    assert_eq!(
        daemon
            .frames()
            .iter()
            .filter(|frame| frame["type"] == "hello")
            .count(),
        1,
        "without a sign-in nothing is sent"
    );
}
