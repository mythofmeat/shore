#![cfg(test)]

mod support;

use std::process::Output;

use serde_json::json;

use support::{asked, asked_of, printed, sent};

const CLIENT: &str = env!("CARGO_PKG_VERSION");

fn complaint(output: &Output) -> String {
    assert!(!output.status.success(), "{output:?}");
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

#[test]
fn an_answer_from_a_newer_daemon_that_cant_be_read_says_to_upgrade_the_client() {
    let (status, frames) = asked_of(Some("999.0.0"), json!({}), &["status"]);
    assert_eq!(sent(&frames), [(Some("status"), Some(&json!({})))]);
    assert_eq!(
        complaint(&status),
        format!(
            "error: couldn't read the daemon's answer to `status`: missing field `character`\n\
             This client is {CLIENT} and the daemon is 999.0.0. Upgrade the client."
        )
    );

    let (dream, _dream_frames) = asked_of(Some("999.0.0"), json!({}), &["dream"]);
    assert_eq!(
        complaint(&dream),
        format!(
            "error: couldn't read the daemon's answer to `dream`: missing field `character`\n\
             This client is {CLIENT} and the daemon is 999.0.0. Upgrade the client."
        )
    );
}

#[test]
fn an_answer_from_an_older_daemon_that_cant_be_read_says_to_upgrade_the_daemon() {
    let (status, _frames) = asked_of(Some("0.0.1"), json!({}), &["status"]);
    assert_eq!(
        complaint(&status),
        format!(
            "error: couldn't read the daemon's answer to `status`: missing field `character`\n\
             This client is {CLIENT} and the daemon is 0.0.1. Upgrade the daemon, or restart it if it has been upgraded."
        )
    );
}

#[test]
fn an_answer_that_cant_be_read_from_a_daemon_of_the_same_release_or_of_none_it_reports_is_just_the_error()
 {
    for version in [Some(CLIENT), None] {
        let (status, _frames) = asked_of(version, json!({}), &["status"]);
        assert_eq!(
            complaint(&status),
            "error: couldn't read the daemon's answer to `status`: missing field `character`"
        );
    }
}

#[test]
fn the_version_printout_says_which_side_to_upgrade_when_the_two_differ() {
    let (newer, _newer_frames) = asked_of(Some("999.0.0"), json!({}), &["--version"]);
    assert!(newer.status.success(), "{newer:?}");
    let lines: Vec<String> = printed(&newer).lines().map(str::to_owned).collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(
        lines.first().map(String::as_str),
        Some(format!("shore {CLIENT}").as_str())
    );
    assert!(
        lines
            .get(1)
            .is_some_and(|line| line.starts_with("daemon 999.0.0 at ")),
        "{lines:?}"
    );
    assert_eq!(
        lines.get(2).map(String::as_str),
        Some(
            format!("This client is {CLIENT} and the daemon is 999.0.0. Upgrade the client.")
                .as_str()
        )
    );

    let (same, _same_frames) = asked_of(Some(CLIENT), json!({}), &["--version"]);
    assert_eq!(printed(&same).lines().count(), 2, "{same:?}");

    let (silent, _silent_frames) = asked(json!({}), &["--version"]);
    assert_eq!(printed(&silent).lines().count(), 2, "{silent:?}");
}
