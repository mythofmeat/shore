#![cfg(test)]

mod support;

use serde_json::json;

use support::{asked, printed, sent};

#[test]
fn the_error_log_lists_errors_and_key_fallbacks_with_how_many_there_were_of_each() {
    let (shown, frames) = asked(
        json!({
            "errors": { "count": 3, "recent": [
                { "timestamp": "2026-11-01T09:30:05Z", "error_type": "provider", "message": "overloaded", "context": "turn 4" },
            ] },
            "key_fallbacks": { "count": 1, "recent": [
                { "timestamp": "2026-11-01T09:31:00Z", "provider": "anthropic", "model": "opus", "character": "ada", "from_key": "main", "to_key": "spare", "kind": "rate_limit", "status": 429, "reason": "too many requests" },
            ] },
        }),
        &["trace", "errors", "-n", "5"],
    );
    assert!(shown.status.success(), "{shown:?}");
    let lines: Vec<String> = printed(&shown)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect();
    let [errors, error, fallbacks, fallback] = lines.as_slice() else {
        panic!("{lines:?}")
    };
    assert!(
        errors.starts_with("\u{2500}\u{2500} Errors (3 total) \u{2500}"),
        "{errors}"
    );
    assert!(error.ends_with(" provider overloaded turn 4"), "{error}");
    assert!(
        fallbacks.starts_with("\u{2500}\u{2500} Key fallbacks (1 total) \u{2500}"),
        "{fallbacks}"
    );
    assert!(
        fallback.ends_with(" main -> spare rate_limit 429 too many requests"),
        "{fallback}"
    );
    assert_eq!(
        sent(&frames),
        [(Some("error_log"), Some(&json!({ "count": 5 })))]
    );
}
