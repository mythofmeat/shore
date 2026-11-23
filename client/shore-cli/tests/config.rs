#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

#[test]
fn config_path_prints_the_folder_the_daemon_reads_its_config_from() {
    let (output, frames) = asked(
        json!({ "config_dir": "/srv/shore/config" }),
        &["config", "--path"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(printed(&output), "/srv/shore/config");
    assert_eq!(sent(&frames), [(Some("status"), Some(&json!({})))]);
}
