#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

fn prompt() -> serde_json::Value {
    json!({
        "thread": "story",
        "parts": [
            { "label": "SOUL.md", "text": "Frank keeps the lighthouse.\nHe writes at night.", "changed": true },
            { "label": "thread_pins", "text": "Pinned here.\n\n## notes/plan.md\n\nChapter three.", "changed": false },
        ],
        "pins": [
            { "pin": "notes/plan.md", "bytes": 14, "shown": "whole", "changed": true },
            { "pin": "stories/long.md", "bytes": 33_280, "shown": "cut", "changed": false },
            { "pin": "stories/longer.md", "bytes": 1024, "shown": "left_out", "changed": false },
            { "pin": "notes/gone.md", "bytes": 0, "shown": "nothing", "changed": false },
            { "pin": "!git log --oneline -5", "bytes": 0, "shown": "nothing", "changed": false },
        ],
    })
}

#[test]
fn thread_prompt_shows_each_part_of_the_system_prompt_and_what_each_pin_shows() {
    let (output, frames) = asked(prompt(), &["thread", "prompt", "story"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "── SOUL.md · changed in the workspace since; --refresh shows the new version ────────\n  Frank keeps the lighthouse.\n  He writes at night.\n\n── thread_pins ─────────────────────────────────────────────────────────────────\n  Pinned here.\n\n  ## notes/plan.md\n\n  Chapter three.\n\n── pins ────────────────────────────────────────────────────────────────────────\n  notes/plan.md          14 B  changed in the workspace since; --refresh shows the new version\n  stories/long.md        32.5 KB, cut: past what a thread's pins can take together\n  stories/longer.md      1 KB, left out: past what a thread's pins can take together\n  notes/gone.md          empty, or not in the workspace\n  !git log --oneline -5  hasn't run yet; it runs with the next message"
    );
    assert_eq!(
        sent(&frames),
        [(Some("thread_prompt"), Some(&json!({ "name": "story" })))]
    );
}

#[test]
fn thread_prompt_refresh_asks_the_daemon_to_refresh_the_prompt_first_and_a_thread_without_pins_lists_none()
 {
    let bare = json!({ "thread": "bare", "parts": [{ "label": "SOUL.md", "text": "Frank.", "changed": false }], "pins": [] });
    let (output, frames) = asked(bare, &["thread", "prompt", "bare", "--refresh"]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        printed(&output),
        "── SOUL.md ─────────────────────────────────────────────────────────────────────\n  Frank."
    );
    assert_eq!(
        sent(&frames),
        [(
            Some("thread_prompt_refresh"),
            Some(&json!({ "name": "bare" }))
        )]
    );
    let (empty, _empty_asked) = asked(
        json!({ "thread": "bare", "parts": [], "pins": [] }),
        &["thread", "prompt", "bare"],
    );
    assert_eq!(printed(&empty), "(no system prompt)");
}
