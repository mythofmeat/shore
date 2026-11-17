#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed};

#[test]
fn watching_or_stopping_a_compaction_says_none_is_running() {
    let idle = json!({ "character": "ada", "state": "idle", "pass": null });
    for flag in ["--watch", "--cancel"] {
        let (output, _frames) = asked(idle.clone(), &["compact", flag]);
        assert!(output.status.success(), "{flag}: {output:?}");
        let shown = printed(&output);
        assert!(
            shown.contains("not running") && shown.contains("none since the daemon started"),
            "{flag}: {shown}"
        );
    }
}
