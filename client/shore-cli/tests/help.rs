#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

#[test]
fn shore_with_no_command_prints_its_help_and_asks_the_daemon_nothing() {
    let (help, _help_frames) = asked(json!({}), &["--help"]);
    assert!(help.status.success(), "{help:?}");
    assert!(
        printed(&help).contains("Usage: shore [OPTIONS] [COMMAND]"),
        "{}",
        printed(&help)
    );
    for leading in [&[][..], &["--character", "ada", "--thread", "main"][..]] {
        let (bare, frames) = asked(json!({}), leading);
        assert!(bare.status.success(), "{bare:?}");
        assert_eq!(printed(&bare), printed(&help), "after {leading:?}");
        assert_eq!(sent(&frames), [], "after {leading:?}");
    }
}
