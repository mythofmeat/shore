#![cfg(test)]

mod support;

use std::process::Output;

use serde_json::{Value, json};

use support::{StandIn, at, nth, shore_in};

const ARCHIVE: &str = "pretend archive bytes";

fn hello() -> Value {
    json!({ "type": "history", "selected_character": "ada", "selected_thread": "main" })
}

fn output(frame: &Value, data: Value) -> Vec<Value> {
    vec![
        json!({ "type": "command_output", "name": frame["name"], "rid": frame["rid"], "data": data }),
    ]
}

fn daemon(sent: &'static str, total: usize) -> StandIn {
    StandIn::start(&["ada"], None, move |_, frame| {
        if frame["type"] == "hello" {
            return vec![hello()];
        }
        let name = frame.get("name").and_then(Value::as_str);
        let path = frame.get("path").and_then(Value::as_str);
        match (name, path) {
            (Some("export_character"), _) => output(
                frame,
                json!({
                    "character": "ada", "archive": "/spool/archive.tar", "bytes": total, "live": true,
                    "call_diagnostics": "included", "external_memory": "rebuild_from_archived_segments", "transfer": "t-down",
                }),
            ),
            (Some("export_backup"), _) => output(
                frame,
                json!({
                    "characters": ["ada"], "archive": "/spool/archive.tar", "bytes": total, "transfer": "t-down",
                }),
            ),
            (Some("import_archive"), _) => output(
                frame,
                json!({ "characters": ["ada"], "skipped": ["bo"], "restored": [], "kept": [] }),
            ),
            (_, Some("/api/transfers/t-down")) => {
                vec![json!({ "type": "http", "status": 200, "raw": sent })]
            }
            (_, Some("/api/transfers")) => vec![json!({
                "type": "http", "status": 200,
                "body": { "transfer": "t-up", "bytes": frame["content"].as_str().map_or(0, str::len) },
            })],
            _ => Vec::new(),
        }
    })
}

fn run(daemon: &StandIn, home: &std::path::Path, args: &[&str]) -> Output {
    shore_in(home, &daemon.addr).args(args).output().unwrap()
}

#[test]
fn an_exported_character_is_downloaded_whole_into_the_file_named() {
    let stand_in = daemon(ARCHIVE, ARCHIVE.len());
    let home = tempfile::tempdir().unwrap();
    let target = home.path().join("ada.shore.tar");
    let exported = run(
        &stand_in,
        home.path(),
        &["export", "ada", "--output", target.to_str().unwrap()],
    );
    assert!(exported.status.success(), "{exported:?}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), ARCHIVE);
    assert_eq!(
        String::from_utf8_lossy(&exported.stdout).trim(),
        format!(
            "Exported ada to {} ({} bytes).",
            target.display(),
            ARCHIVE.len()
        )
    );
    let fetched: Vec<Value> = stand_in
        .frames()
        .into_iter()
        .filter(|frame| frame["type"] == "web")
        .collect();
    assert_eq!(fetched.len(), 1, "{fetched:?}");
    assert_eq!(
        (
            at(nth(&fetched, 0), &["method"]),
            at(nth(&fetched, 0), &["token"])
        ),
        (&json!("GET"), &json!("test-token"))
    );
}

#[test]
fn a_download_that_comes_up_short_is_refused_and_leaves_no_file() {
    let stand_in = daemon("short", ARCHIVE.len());
    let home = tempfile::tempdir().unwrap();
    let target = home.path().join("ada.shore.tar");
    let exported = run(
        &stand_in,
        home.path(),
        &["export", "ada", "--output", target.to_str().unwrap()],
    );
    assert!(!exported.status.success(), "{exported:?}");
    assert!(
        String::from_utf8_lossy(&exported.stderr).contains(&format!(
            "the daemon sent 5 of the archive's {} bytes",
            ARCHIVE.len()
        )),
        "{exported:?}"
    );
    assert!(!target.exists(), "nothing half-written is kept");
}

#[test]
fn an_archive_is_uploaded_whole_and_then_imported_by_its_transfer() {
    let stand_in = daemon(ARCHIVE, ARCHIVE.len());
    let home = tempfile::tempdir().unwrap();
    let archive = home.path().join("ada.shore.tar");
    std::fs::write(&archive, ARCHIVE).unwrap();
    let imported = run(
        &stand_in,
        home.path(),
        &["import", archive.to_str().unwrap()],
    );
    assert!(imported.status.success(), "{imported:?}");
    assert_eq!(
        String::from_utf8_lossy(&imported.stdout).trim(),
        "Imported character ada.\nLeft alone, already here: bo."
    );
    let uploaded: Vec<Value> = stand_in
        .frames()
        .into_iter()
        .filter(|frame| frame["type"] == "web")
        .collect();
    assert_eq!(
        at(nth(&uploaded, 0), &["content"]),
        ARCHIVE,
        "the archive's bytes arrive whole"
    );
    assert_eq!(
        at(nth(&stand_in.commands("import_archive"), 0), &["args"]),
        &json!({ "transfer": "t-up" })
    );

    let empty = home.path().join("empty.tar");
    std::fs::write(&empty, "").unwrap();
    let refused = run(&stand_in, home.path(), &["import", empty.to_str().unwrap()]);
    assert!(!refused.status.success(), "{refused:?}");
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("there was nothing to upload"),
        "{refused:?}"
    );
}

#[test]
fn a_backup_whose_download_is_damaged_is_refused_before_the_folder_changes() {
    let stand_in = daemon(ARCHIVE, ARCHIVE.len());
    let home = tempfile::tempdir().unwrap();
    let folder = home.path().join("backup");
    let backed_up = run(
        &stand_in,
        home.path(),
        &["export", "--all", "--output", folder.to_str().unwrap()],
    );
    assert!(!backed_up.status.success(), "{backed_up:?}");
    assert_eq!(
        at(nth(&stand_in.commands("export_backup"), 0), &["args"]),
        &json!({}),
        "a first backup has no base"
    );
    let fetched: Vec<Value> = stand_in
        .frames()
        .into_iter()
        .filter(|frame| frame["type"] == "web")
        .collect();
    assert_eq!(fetched.len(), 1, "it was downloaded: {fetched:?}");
    let left: Vec<_> = std::fs::read_dir(&folder)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    assert!(left.is_empty(), "the folder gained nothing: {left:?}");
}
