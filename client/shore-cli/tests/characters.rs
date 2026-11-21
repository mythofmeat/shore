#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

#[test]
fn a_new_character_names_its_config_folder_and_workspace_and_where_its_prompt_is_laid_out() {
    let (output, frames) = asked(
        json!({ "character": "bo", "config_dir": "/cfg/characters/bo", "workspace_dir": "/ws/bo" }),
        &["character", "new", "bo"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "Created bo\n  config     /cfg/characters/bo\n  workspace  /ws/bo\nIts prompt is the [[prompt]] list in config. Switch to it with: shore character bo"
    );
    assert_eq!(
        sent(&frames),
        [(Some("create_character"), Some(&json!({ "name": "bo" })))]
    );
}

#[test]
fn character_info_lists_the_prompt_files_and_leaves_the_row_out_without_any() {
    let details = |prompt_files: serde_json::Value| {
        json!({
            "name": "ada", "active": true, "config_dir": "/cfg/ada", "workspace_dir": "/ws/ada",
            "prompt_files": prompt_files, "has_config_override": false, "pending_deferred_edits": [],
            "data_dir": "/data/ada", "has_data": true
        })
    };
    let (listed, frames) = asked(
        details(json!(["SOUL.md", "notes/MAP.md"])),
        &["character", "info"],
    );
    assert!(listed.status.success(), "{listed:?}");
    let shown = printed(&listed);
    let row = shown
        .lines()
        .find(|line| line.contains("Prompt files"))
        .unwrap_or_default();
    assert!(row.ends_with("SOUL.md, notes/MAP.md"), "{shown}");
    assert!(!shown.contains("Definition"), "{shown}");
    assert_eq!(
        sent(&frames),
        [(Some("character_info"), Some(&json!({ "name": "" })))]
    );

    let (bare, _) = asked(details(json!([])), &["character", "info"]);
    assert!(bare.status.success(), "{bare:?}");
    let plain = printed(&bare);
    assert!(plain.contains("/data/ada"), "{plain}");
    assert!(!plain.contains("Prompt files"), "{plain}");
}
