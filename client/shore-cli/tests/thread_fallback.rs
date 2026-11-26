#![cfg(test)]

mod support;

use std::path::Path;
use std::process::Output;

use serde_json::{Value, json};

use support::{StandIn, shore_in};

fn run(data: &Path, env_thread: Option<&str>, flag_thread: Option<&str>) -> (Output, Vec<Value>) {
    let daemon = StandIn::start(&["heidi"], None, |hello, frame| {
        if frame["type"] == "hello" {
            return vec![json!({
                "type": "history", "selected_character": "heidi", "selected_thread": "home",
            })];
        }
        assert_eq!(
            hello["thread"], "home",
            "a command runs in the thread the daemon serves"
        );
        vec![json!({
            "type": "command_output", "name": "log", "rid": frame["rid"],
            "data": {"messages": [], "selected_thread": "home", "cursor": 0,
                "next_before": 0, "has_more_before": false, "total_turns": 0,
                "segment": null, "previous_segment": null, "next_segment": null}
        })]
    });
    let home = tempfile::tempdir().unwrap();
    let mut command = shore_in(home.path(), &daemon.addr);
    let _configured = command
        .env("SHORE_DATA_DIR", data)
        .args(["--character", "heidi"]);
    if let Some(thread) = env_thread {
        let _env = command.env("SHORE_THREAD", thread);
    }
    if let Some(thread) = flag_thread {
        let _flag = command.args(["--thread", thread]);
    }
    let output = command.args(["log", "--json"]).output().unwrap();
    let asked = daemon
        .frames()
        .iter()
        .map(|frame| match frame["type"].as_str() {
            Some("hello") => json!(["hello", frame["thread"]]),
            _ => json!(["command", frame["name"]]),
        })
        .collect();
    (output, asked)
}

fn save(data: &Path, thread: &str) {
    std::fs::create_dir_all(data.join("active_thread")).unwrap();
    std::fs::write(data.join("active_thread/heidi"), thread).unwrap();
}

fn saved(data: &Path) -> String {
    std::fs::read_to_string(data.join("active_thread/heidi")).unwrap()
}

#[test]
fn stale_environment_and_saved_threads_fall_back_to_home() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "work");
    let (output, asked) = run(data.path(), Some("eval"), None);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        asked,
        [
            json!(["hello", "eval"]),
            json!(["hello", "work"]),
            json!(["command", "log"])
        ]
    );
    assert_eq!(saved(data.path()), "home");
}

#[test]
fn explicit_missing_thread_is_refused_even_when_it_matches_the_environment() {
    let data = tempfile::tempdir().unwrap();
    save(data.path(), "work");
    let (output, asked) = run(data.path(), Some("eval"), Some("eval"));
    assert!(!output.status.success());
    assert_eq!(asked, [json!(["hello", "eval"])], "no command runs");
    assert_eq!(saved(data.path()), "work");
    assert!(String::from_utf8_lossy(&output.stderr).contains("you asked for it with --thread"));
}
