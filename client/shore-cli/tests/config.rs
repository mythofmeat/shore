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

fn configured() -> serde_json::Value {
    json!({
        "config": {
            "name": "ada",
            "chat": { "model": "opus", "max_tokens": 4096, "stop": null },
            "tags": ["a", 1, 2.5, true],
            "retries": 3,
        },
        "defaults": { "chat": { "max_tokens": 4096 }, "retries": 3 },
    })
}

#[test]
fn config_toml_prints_only_what_differs_from_the_defaults_with_values_before_tables() {
    let (output, frames) = asked(configured(), &["config", "--toml"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        sent(&frames).first().and_then(|(name, _)| *name),
        Some("config")
    );
    assert_eq!(
        printed(&output),
        [
            "name = \"ada\"",
            "tags = [",
            "    \"a\",",
            "    1,",
            "    2.5,",
            "    true,",
            "]",
            "",
            "[chat]",
            "model = \"opus\"",
        ]
        .join("\n")
    );
}

#[test]
fn config_toml_all_prints_the_defaults_too() {
    let (output, _frames) = asked(configured(), &["config", "--toml", "--all"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        [
            "name = \"ada\"",
            "retries = 3",
            "tags = [",
            "    \"a\",",
            "    1,",
            "    2.5,",
            "    true,",
            "]",
            "",
            "[chat]",
            "max_tokens = 4096",
            "model = \"opus\"",
        ]
        .join("\n")
    );
}
