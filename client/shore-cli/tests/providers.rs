#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

#[test]
fn refreshing_every_provider_prints_each_one_refreshed_or_not() {
    let (output, frames) = asked(
        json!({
            "results": [
                { "ok": true, "provider": "anthropic", "model_count": 3, "fetched_at": "2026-11-24T00:00:00Z", "cache_path": "/cache/anthropic.json" },
                { "ok": false, "provider": "openrouter", "error": "timed out" }
            ],
            "skipped": [{ "provider": "nanogpt", "reason": "disabled" }]
        }),
        &["provider", "refresh"],
    );
    assert!(output.status.success(), "{output:?}");
    let shown = printed(&output);
    assert!(
        shown.contains("Provider refresh")
            && shown.contains("anthropic: 3 models (fetched 2026-11-24T00:00:00Z)")
            && shown.contains("openrouter")
            && shown.contains("timed out"),
        "{shown}"
    );
    assert_eq!(
        sent(&frames),
        [(Some("refresh_all_provider_models"), Some(&json!({})))]
    );
}
