#![cfg(test)]

mod support;

use std::process::Output;
use std::sync::atomic::{AtomicUsize, Ordering};
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

fn signing_in(polls: Vec<(u64, Value)>) -> (StandIn, Arc<Mutex<Vec<Value>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&asked);
    let answered = AtomicUsize::new(0);
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
        match path(frame) {
            "/api/sign-in" => answer(
                200,
                json!({ "id": "4a0c3f6e-0000-4000-8000-000000000001", "code": "4F7K", "expires_at": 1 }),
            ),
            "/api/sign-in/4a0c3f6e-0000-4000-8000-000000000001" => {
                let at = answered.fetch_add(1, Ordering::SeqCst);
                let (status, body) = polls
                    .get(at)
                    .cloned()
                    .unwrap_or((404, json!({ "code": "not_found", "message": "gone" })));
                answer(status, body)
            }
            _ => Vec::new(),
        }
    });
    (daemon, asked)
}

#[test]
fn signing_in_shows_the_code_waits_for_it_to_be_allowed_and_then_uses_its_own_credential() {
    let (daemon, asked) = signing_in(vec![
        (202, json!({})),
        (200, json!({ "token": "shore_mine" })),
    ]);
    let home = tempfile::tempdir().unwrap();
    let origin = format!("http://{}", daemon.addr);
    let output = shore_in(home.path(), &daemon.addr)
        .env("SHORE_SIGN_IN_POLL_MS", "5")
        .args(["sign-in", &format!("{}/", daemon.addr), "--name", "desk"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(
        stderr(&output).contains("    4F7K"),
        "the code is shown: {}",
        stderr(&output)
    );
    assert!(
        stderr(&output).contains("shore devices allow 4F7K"),
        "and how to allow it"
    );
    assert!(
        stdout(&output).starts_with(&format!("Signed in to {origin}")),
        "{}",
        stdout(&output)
    );
    let requests = asked.lock().unwrap().clone();
    let started = nth(&requests, 0);
    assert_eq!(
        at(started, &["body", "name"]),
        "desk",
        "the name it asked under"
    );
    let secret = at(started, &["body", "secret"])
        .as_str()
        .unwrap()
        .to_owned();
    assert!(secret.len() >= 32, "a long secret: {secret}");
    assert!(
        requests
            .iter()
            .skip(1)
            .all(|poll| at(poll, &["body", "secret"]) == secret.as_str()),
        "it polls with the same secret"
    );
    assert_eq!(requests.len(), 3, "it asked twice before it was let in");
    let kept = std::fs::read_to_string(home.path().join("config").join("sign-ins.toml")).unwrap();
    assert!(
        kept.contains(&format!("\"{origin}\" = \"shore_mine\"")),
        "{kept}"
    );

    std::fs::remove_file(home.path().join("config").join("token")).unwrap();
    let listed = shore_in_kept(home.path(), &daemon.addr)
        .args(["character"])
        .output()
        .unwrap();
    assert!(listed.status.success(), "{listed:?}");
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

fn shore_in_kept(home: &std::path::Path, addr: &str) -> std::process::Command {
    let token = home.join("config").join("token");
    let kept = std::fs::read(&token).ok();
    let command = shore_in(home, addr);
    match kept {
        Some(bytes) => std::fs::write(&token, bytes).unwrap(),
        None => std::fs::remove_file(&token).unwrap(),
    }
    command
}

#[test]
fn a_refused_or_expired_sign_in_says_so_and_keeps_nothing() {
    for (status, body, said) in [
        (
            403,
            json!({ "code": "forbidden", "message": "The sign-in was refused" }),
            "The sign-in was refused",
        ),
        (
            404,
            json!({ "code": "not_found", "message": "This sign-in request expired" }),
            "This sign-in request expired",
        ),
        (500, json!("not a problem"), "the daemon answered HTTP 500"),
    ] {
        let (daemon, _) = signing_in(vec![(status, body)]);
        let home = tempfile::tempdir().unwrap();
        let output = shore_in(home.path(), &daemon.addr)
            .env("SHORE_SIGN_IN_POLL_MS", "5")
            .args(["sign-in", &daemon.addr])
            .output()
            .unwrap();
        assert!(!output.status.success(), "{output:?}");
        assert!(stderr(&output).contains(said), "{}", stderr(&output));
        assert!(
            !home.path().join("config").join("sign-ins.toml").exists(),
            "nothing is kept"
        );
    }
}

#[test]
fn a_sign_in_the_daemon_turns_away_at_once_is_reported_without_a_code() {
    let daemon = StandIn::start(&["ada"], None, |_, frame| {
        if path(frame) == "/api/sign-in" {
            return answer(
                429,
                json!({ "code": "too_many_requests", "message": "Too many devices are waiting to sign in" }),
            );
        }
        Vec::new()
    });
    let home = tempfile::tempdir().unwrap();
    let output = shore_in(home.path(), &daemon.addr)
        .args(["sign-in", &daemon.addr])
        .output()
        .unwrap();
    assert!(!output.status.success(), "{output:?}");
    assert!(
        stderr(&output).contains("Too many devices are waiting to sign in"),
        "{}",
        stderr(&output)
    );
    assert!(
        !stderr(&output).contains("allow the code"),
        "no code to show"
    );
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
        "requests": [{ "code": "4F7K", "name": "laptop", "expires_at": 1 }],
    })
}

#[test]
fn the_devices_list_shows_who_is_waiting_and_who_is_signed_in() {
    let (output, asked, _) = devices(&["devices"], listing());
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        stdout(&output),
        "Waiting to sign in:\n  4F7K  laptop\n  (shore devices allow <code>, or shore devices refuse <code>)\n\nSigned in:\n  b1  Firefox on Linux · browser · not used yet\n  c1  desk · command line · used 2023-11-14 22:13  (this one)\n  k1  Phone · automation key for presence, status · not used yet"
    );
    assert_eq!(asked.len(), 1, "{asked:?}");
    let (raw, _, _) = devices(&["devices", "--json"], listing());
    let printed: Value = serde_json::from_str(&stdout(&raw)).unwrap();
    assert_eq!(printed, listing(), "JSON is the list as the daemon sent it");
    let (bare, _, _) = devices(&["devices"], json!({ "devices": [], "requests": [] }));
    assert_eq!(
        stdout(&bare),
        "Signed in:",
        "nothing waiting, nothing listed"
    );
}

#[test]
fn a_waiting_cli_is_let_in_or_turned_away_by_its_code_and_a_device_signed_out_by_its_id() {
    let (allowed, asked, _) = devices(&["devices", "allow", "4F7K"], Value::Null);
    assert_eq!(
        stdout(&allowed),
        "Let in the CLI showing 4F7K.",
        "{allowed:?}"
    );
    assert_eq!(
        (path(nth(&asked, 0)), at(nth(&asked, 0), &["body"])),
        (
            "/api/devices/decide",
            &json!({ "code": "4F7K", "allow": true })
        )
    );
    let (refused, refusals, _) = devices(&["devices", "refuse", "4F7K"], Value::Null);
    assert_eq!(
        stdout(&refused),
        "Turned away the CLI showing 4F7K.",
        "{refused:?}"
    );
    assert_eq!(
        at(nth(&refusals, 0), &["body"]),
        &json!({ "code": "4F7K", "allow": false })
    );
    let (signed_out, revoked, _) = devices(&["devices", "sign-out", "k1"], Value::Null);
    assert_eq!(stdout(&signed_out), "Signed out k1.", "{signed_out:?}");
    assert_eq!(
        (path(nth(&revoked, 0)), at(nth(&revoked, 0), &["body"])),
        ("/api/devices/revoke", &json!({ "id": "k1" }))
    );
}

#[test]
fn a_sign_in_link_names_the_address_a_browser_opens() {
    let (here, _, origin) = devices(&["devices", "link"], Value::Null);
    assert!(
        stdout(&here).starts_with(&format!("{origin}/#login=c0de\n")),
        "{}",
        stdout(&here)
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
        stderr(&missing).contains("port 7340 unless changed; the old TCP port 7320 is gone"),
        "{}",
        stderr(&missing)
    );
    std::fs::remove_file(nowhere.path().join("config").join("token")).unwrap();
    let unsigned = shore_in_kept(nowhere.path(), &daemon.addr)
        .args(["status"])
        .output()
        .unwrap();
    assert!(
        stderr(&unsigned).contains(&format!(
            "this CLI isn't signed in to http://{}",
            daemon.addr
        )),
        "{}",
        stderr(&unsigned)
    );
}

#[test]
fn a_sign_in_without_a_name_goes_by_this_computer_s_name() {
    let (daemon, asked) = signing_in(vec![(403, json!({ "code": "forbidden", "message": "no" }))]);
    let home = tempfile::tempdir().unwrap();
    let _output = shore_in(home.path(), &daemon.addr)
        .env("SHORE_SIGN_IN_POLL_MS", "5")
        .args(["sign-in", &daemon.addr])
        .output()
        .unwrap();
    let expected = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap()
        .trim()
        .to_owned();
    assert!(!expected.is_empty(), "the test machine has a name");
    let requests = asked.lock().unwrap().clone();
    assert_eq!(at(nth(&requests, 0), &["body", "name"]), expected.as_str());
}
