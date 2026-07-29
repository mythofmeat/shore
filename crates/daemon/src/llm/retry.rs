use tracing::warn;

use super::credentials::classify_credential_failure;
use super::types::StreamResult;
use super::LlmError;

/// Policy controlling application-level retry and model fallback.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of retry attempts before giving up.
    pub max_retries: u32,

    /// Optional fallback model name to try when the primary model refuses or
    /// errors persistently. Must be a valid name in models.toml.
    pub fallback_model: Option<String>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            fallback_model: None,
        }
    }
}

/// What to do after a failed or refused response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryDecision {
    /// Retry with the same model.
    Retry,

    /// Retry with an alternative model.
    FallbackModel(String),

    /// Give up and report the error.
    Fail,
}

/// Determine whether to retry after an LLM error.
///
/// Called when `stream_raw` or stream consumption fails.
///
/// Credential-shaped failures (missing/invalid key, exhausted quota or
/// budget, account-scoped rate limits) short-circuit to `Fail` without
/// consuming retry budget — retrying the same key cannot help, and the
/// multi-key fallback wrapper above this layer relies on the error
/// surfacing immediately so it can rotate to the next configured key.
/// Plain transient errors (5xx, generic 429, network blips) still go
/// through the normal exponential-backoff retry path.
#[expect(
    clippy::match_same_arms,
    reason = "non-retryable error categories kept as separate arms, each documented at its decision point"
)]
pub fn should_retry_error(error: &LlmError, attempt: u32, policy: &RetryPolicy) -> RetryDecision {
    let cred_kind = classify_credential_failure("", error);
    if cred_kind.should_rotate() {
        warn!(
            attempt,
            kind = cred_kind.as_str(),
            error = %error,
            "Credential-shaped failure — failing fast so multi-key fallback can rotate"
        );
        return RetryDecision::Fail;
    }

    if attempt >= policy.max_retries {
        // Exhausted retries — try fallback model if available.
        if let Some(ref fallback) = policy.fallback_model {
            warn!(
                attempt,
                fallback = %fallback,
                "Retries exhausted, falling back to alternate model"
            );
            return RetryDecision::FallbackModel(fallback.clone());
        }
        return RetryDecision::Fail;
    }

    match error {
        // Transient network/connection errors — retry.
        LlmError::Request(_) | LlmError::IncompleteStream | LlmError::StreamErrored { .. } => {
            warn!(attempt, error = %error, "Transient error, retrying");
            RetryDecision::Retry
        }

        // HTTP 5xx or 429 — retry.
        LlmError::HttpStatus { status, .. } if *status >= 500 || *status == 429 => {
            warn!(attempt, status = %status, "Server error, retrying");
            RetryDecision::Retry
        }

        // HTTP 4xx (except 429) — don't retry, it's a client error.
        LlmError::HttpStatus { .. } => RetryDecision::Fail,

        // Serialization/deserialization — not transient.
        LlmError::Serialize(_) | LlmError::Deserialize(_) => RetryDecision::Fail,

        // Missing API key — not transient.
        LlmError::MissingApiKey { .. } => RetryDecision::Fail,

        // Provider errors — could be transient.
        LlmError::Provider { .. } => {
            warn!(attempt, error = %error, "Provider error, retrying");
            RetryDecision::Retry
        }

        // Model refusal — try fallback model directly.
        LlmError::Refusal => {
            if let Some(ref fallback) = policy.fallback_model {
                warn!(
                    attempt,
                    fallback = %fallback,
                    "Model refused, falling back"
                );
                RetryDecision::FallbackModel(fallback.clone())
            } else {
                RetryDecision::Fail
            }
        }
    }
}

/// Determine whether to retry after a completed response that may be a refusal.
///
/// Called after a successful stream completes to check if the content looks
/// like a model refusal (e.g., "I cannot help with that").
pub fn should_retry_refusal(
    result: &StreamResult,
    attempt: u32,
    policy: &RetryPolicy,
) -> RetryDecision {
    if !is_refusal(&result.content, &result.finish_reason) {
        return RetryDecision::Fail; // Not a refusal — accept the result.
    }

    warn!(
        attempt,
        finish_reason = %result.finish_reason,
        content_prefix = %truncate(&result.content, 80),
        "Refusal detected in response"
    );

    if let Some(ref fallback) = policy.fallback_model {
        RetryDecision::FallbackModel(fallback.clone())
    } else if attempt < policy.max_retries {
        RetryDecision::Retry
    } else {
        RetryDecision::Fail
    }
}

/// Detect whether a response looks like a model refusal.
///
/// Checks the finish_reason and common refusal phrases in the content.
pub fn is_refusal(content: &str, finish_reason: &str) -> bool {
    // Some providers signal refusal via finish_reason.
    if finish_reason == "content_filter" || finish_reason == "refusal" {
        return true;
    }

    // Check for common refusal patterns in short responses.
    // Only check short responses to avoid false positives in long outputs.
    if content.len() > 500 {
        return false;
    }

    let lower = content.to_lowercase();

    REFUSAL_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// Common phrases indicating a model refusal.
const REFUSAL_PATTERNS: &[&str] = &[
    "i cannot",
    "i can't",
    "i'm unable to",
    "i am unable to",
    "i'm not able to",
    "i must decline",
    "i have to decline",
    "as an ai",
    "against my guidelines",
    "violates my",
    "i must refuse",
];

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_owned()
    } else {
        let end = s.floor_char_boundary(max);
        format!("{}…", s.get(..end).unwrap_or(s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{StreamResult, Timing, Usage};

    fn make_policy(max_retries: u32, fallback: Option<&str>) -> RetryPolicy {
        RetryPolicy {
            max_retries,
            fallback_model: fallback.map(String::from),
        }
    }

    fn make_result(content: &str, finish_reason: &str) -> StreamResult {
        StreamResult {
            content: content.into(),
            model: "test".into(),
            finish_reason: finish_reason.into(),
            usage: Usage::default(),
            timing: Timing::default(),
            tool_uses: vec![],
            content_blocks: vec![],
            calls: vec![],
        }
    }

    // ── is_refusal tests ──────────────────────────────────────────────

    #[test]
    fn detects_content_filter_finish_reason() {
        assert!(is_refusal("", "content_filter"));
        assert!(is_refusal("", "refusal"));
    }

    #[test]
    fn detects_refusal_phrases() {
        assert!(is_refusal("I cannot help with that request.", "end_turn"));
        assert!(is_refusal("I can't assist with this.", "end_turn"));
        assert!(is_refusal("I'm unable to do that.", "end_turn"));
        assert!(is_refusal(
            "As an AI, I must decline this request.",
            "end_turn"
        ));
    }

    #[test]
    fn does_not_flag_normal_content() {
        assert!(!is_refusal("Hello! How can I help you today?", "end_turn"));
        assert!(!is_refusal("Here is the code you requested.", "end_turn"));
        assert!(!is_refusal("The weather is sunny.", "end_turn"));
    }

    #[test]
    fn does_not_flag_long_content_with_refusal_substring() {
        // Long content that happens to contain a refusal phrase shouldn't trigger.
        let long = format!(
            "{}I cannot believe how great this code is!",
            "x".repeat(500)
        );
        assert!(!is_refusal(&long, "end_turn"));
    }

    // ── should_retry_error tests ──────────────────────────────────────

    #[test]
    fn retries_transient_errors() {
        let policy = make_policy(3, None);

        let incomplete = LlmError::IncompleteStream;
        assert_eq!(
            should_retry_error(&incomplete, 1, &policy),
            RetryDecision::Retry
        );
    }

    #[test]
    fn retries_server_errors() {
        let policy = make_policy(3, None);

        let err_500 = LlmError::HttpStatus {
            status: 500,
            body: String::new(),
        };
        assert_eq!(
            should_retry_error(&err_500, 0, &policy),
            RetryDecision::Retry
        );

        let err_429 = LlmError::HttpStatus {
            status: 429,
            body: String::new(),
        };
        assert_eq!(
            should_retry_error(&err_429, 0, &policy),
            RetryDecision::Retry
        );
    }

    #[test]
    fn does_not_retry_client_errors() {
        let policy = make_policy(3, None);

        let err_400 = LlmError::HttpStatus {
            status: 400,
            body: "invalid json".into(),
        };
        assert_eq!(
            should_retry_error(&err_400, 0, &policy),
            RetryDecision::Fail
        );
    }

    #[test]
    fn does_not_retry_missing_api_key() {
        let policy = make_policy(3, None);
        let err = LlmError::MissingApiKey {
            var: "TEST_KEY".into(),
        };
        assert_eq!(should_retry_error(&err, 0, &policy), RetryDecision::Fail);
    }

    #[test]
    fn falls_back_when_retries_exhausted() {
        let policy = make_policy(2, Some("fallback-model"));

        let err = LlmError::IncompleteStream;
        // attempt 0: retry
        assert_eq!(should_retry_error(&err, 0, &policy), RetryDecision::Retry);
        // attempt 1: retry
        assert_eq!(should_retry_error(&err, 1, &policy), RetryDecision::Retry);
        // attempt 2: exhausted, fall back
        assert_eq!(
            should_retry_error(&err, 2, &policy),
            RetryDecision::FallbackModel("fallback-model".into())
        );
    }

    #[test]
    fn fails_when_retries_exhausted_no_fallback() {
        let policy = make_policy(1, None);

        let err = LlmError::IncompleteStream;
        assert_eq!(should_retry_error(&err, 0, &policy), RetryDecision::Retry);
        assert_eq!(should_retry_error(&err, 1, &policy), RetryDecision::Fail);
    }

    #[test]
    fn refusal_error_goes_to_fallback() {
        let policy = make_policy(3, Some("gpt-4o"));
        let err = LlmError::Refusal;
        assert_eq!(
            should_retry_error(&err, 0, &policy),
            RetryDecision::FallbackModel("gpt-4o".into())
        );
    }

    #[test]
    fn refusal_error_fails_without_fallback() {
        let policy = make_policy(3, None);
        let err = LlmError::Refusal;
        assert_eq!(should_retry_error(&err, 0, &policy), RetryDecision::Fail);
    }

    // ── should_retry_refusal tests ────────────────────────────────────

    #[test]
    fn retry_refusal_detects_and_falls_back() {
        let policy = make_policy(2, Some("gpt-4o"));
        let result = make_result("I cannot help with that.", "end_turn");

        assert_eq!(
            should_retry_refusal(&result, 0, &policy),
            RetryDecision::FallbackModel("gpt-4o".into())
        );
    }

    #[test]
    fn retry_refusal_retries_without_fallback() {
        let policy = make_policy(2, None);
        let result = make_result("I cannot help with that.", "end_turn");

        assert_eq!(
            should_retry_refusal(&result, 0, &policy),
            RetryDecision::Retry
        );
    }

    #[test]
    fn retry_refusal_fails_when_exhausted_no_fallback() {
        let policy = make_policy(1, None);
        let result = make_result("I cannot help with that.", "end_turn");

        assert_eq!(
            should_retry_refusal(&result, 1, &policy),
            RetryDecision::Fail
        );
    }

    #[test]
    fn retry_refusal_accepts_normal_content() {
        let policy = make_policy(2, Some("gpt-4o"));
        let result = make_result("Hello! Here's the answer.", "end_turn");

        // Normal content — should return Fail meaning "don't retry, accept this".
        assert_eq!(
            should_retry_refusal(&result, 0, &policy),
            RetryDecision::Fail
        );
    }

    #[test]
    fn retry_refusal_detects_content_filter() {
        let policy = make_policy(2, Some("gpt-4o"));
        let result = make_result("", "content_filter");

        assert_eq!(
            should_retry_refusal(&result, 0, &policy),
            RetryDecision::FallbackModel("gpt-4o".into())
        );
    }
}
