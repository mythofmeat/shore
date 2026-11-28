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

fn texts() -> serde_json::Value {
    let text = |name: &str,
                place: &str,
                owner: &str,
                required: bool,
                wording: Option<&str>,
                shipped: &str| {
        json!({ "name": name, "place": place, "owner": owner, "required": required, "wording": wording, "shipped": shipped, "file": null, "error": null, "values": [] })
    };
    json!({ "texts": [
        {
            "name": "time", "place": "Before a user's message.", "owner": "yours", "required": false,
            "wording": "[now: {{now}}]\nand then", "shipped": "[{{now}}]", "file": "/srv/config/texts/time.md", "error": null,
            "values": [{ "name": "now", "about": "the time" }],
        },
        text("status", "The user's statuses.", "off", false, None, "[Their status: {{statuses}}]"),
        text("opened_by_you", "A user turn put first.", "shore", true, Some("[this conversation starts with your message]"), "[this conversation starts with your message]"),
        {
            "name": "label", "place": "The request for a label.", "owner": "yours", "required": true, "wording": null, "shipped": "Label this.",
            "file": "/srv/config/gone.md", "error": "text \"label\" could not be read at /srv/config/gone.md: no such file", "values": [],
        },
        text("cli_identity", "The CLI's first line.", "cli", false, Some("You are a Claude agent."), "You are a Claude agent."),
    ]})
}

#[test]
fn config_texts_lists_every_text_with_whose_wording_is_in_use_and_where_it_goes() {
    let (output, frames) = asked(texts(), &["config", "texts"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "time           yours      Before a user's message.\n  status         off        The user's statuses.\n  opened_by_you  Shore's    A user turn put first.\n  label          yours      The request for a label.\n  cli_identity   the CLI's  The CLI's first line."
    );
    assert_eq!(sent(&frames), [(Some("texts"), Some(&json!({})))]);
}

#[test]
fn config_texts_with_a_name_shows_the_wording_in_use_the_values_it_is_given_and_shores_beside_yours()
 {
    let (output, _frames) = asked(texts(), &["config", "texts", "time"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "── time · yours ────────────────────────────────────────────────────────────────\n  where    Before a user's message.\n  file     /srv/config/texts/time.md\n  {{now}}  the time\n\n  wording in use:\n    [now: {{now}}]\n    and then\n\n  Shore's wording:\n    [{{now}}]"
    );
    let (same, _same_asked) = asked(texts(), &["config", "texts", "opened_by_you"]);
    assert_eq!(
        printed(&same),
        "── opened_by_you · Shore's ─────────────────────────────────────────────────────\n  where   A user turn put first.\n  needed  yes, it can't be switched off\n\n  wording in use:\n    [this conversation starts with your message]"
    );
    let (broken, _broken_asked) = asked(texts(), &["config", "texts", "label"]);
    assert_eq!(
        printed(&broken),
        "── label · yours ───────────────────────────────────────────────────────────────\n  where   The request for a label.\n  file    /srv/config/gone.md\n  error   text \"label\" could not be read at /srv/config/gone.md: no such file\n  needed  yes, it can't be switched off\n\n  wording in use:\n    (none)\n\n  Shore's wording:\n    Label this."
    );
    let (off, _off_asked) = asked(texts(), &["config", "texts", "status"]);
    assert_eq!(
        printed(&off),
        "── status · off ────────────────────────────────────────────────────────────────\n  where  The user's statuses.\n\n  wording in use:\n    (none)\n\n  Shore's wording:\n    [Their status: {{statuses}}]"
    );
}

#[test]
fn config_texts_refuses_a_name_it_has_no_text_for_and_gives_the_list_as_json() {
    let (output, _frames) = asked(texts(), &["config", "texts", "nope"]);
    assert!(!output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim(),
        "error: there is no text named \"nope\"; `shore config texts` lists them"
    );
    let (raw, _raw_asked) = asked(texts(), &["config", "texts", "--json"]);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&printed(&raw)).ok(),
        Some(texts())
    );
}
