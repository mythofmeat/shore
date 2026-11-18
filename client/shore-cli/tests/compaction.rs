#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

#[test]
fn watching_or_stopping_a_compaction_says_none_is_running() {
    let idle = json!({ "character": "ada", "state": "idle", "pass": null });
    for (flag, operation) in [("--watch", "compact_watch"), ("--cancel", "compact_cancel")] {
        let (output, frames) = asked(idle.clone(), &["compact", flag]);
        assert!(output.status.success(), "{flag}: {output:?}");
        assert!(
            sent(&frames)
                .iter()
                .any(|(name, _)| *name == Some(operation)),
            "{flag}: {frames:?}"
        );
        let shown = printed(&output);
        assert!(
            shown.contains("not running") && shown.contains("none since the daemon started"),
            "{flag}: {shown}"
        );
    }
}
