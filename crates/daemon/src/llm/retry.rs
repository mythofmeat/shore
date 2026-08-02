//! Retry decisions.
//!
//! **Ported.** `llm-sidecar/src/llm/retry.ts` is the implementation now,
//! pinned by `llm-sidecar/tests/llm_fixtures/llm_decisions_parity.json`
//! (frozen; generated from this file at 9023b46d). Do not add behaviour here.
//!
//! Not deleted yet: `engine/tools.rs`, `handler/generation.rs` and `llm/mod.rs`
//! still call it and none of them have moved (#12, step 3). It goes with them.
//!
//! Refusal detection and model fallback used to live here and were removed by
//! #16: nothing in production ever set a fallback model, nothing constructed
//! `LlmError::Refusal`, and `should_retry_refusal` had no caller outside its own
//! tests. `finish_reason` values of `content_filter` and `refusal` still arrive
//! from the providers and still reach the conversation and the ledger — what is
//! gone is the phrase-matching detector and the reaction nothing invoked.

use tracing::warn;

use super::credentials::classify_credential_failure;
use super::LlmError;

/// Policy controlling application-level retry.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of retry attempts before giving up.
    pub max_retries: u32,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_retries: 2 }
    }
}

/// What to do after a failed response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryDecision {
    /// Retry with the same model.
    Retry,

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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_policy(max_retries: u32) -> RetryPolicy {
        RetryPolicy { max_retries }
    }

    // ── should_retry_error tests ──────────────────────────────────────

    #[test]
    fn retries_transient_errors() {
        let policy = make_policy(3);

        let incomplete = LlmError::IncompleteStream;
        assert_eq!(
            should_retry_error(&incomplete, 1, &policy),
            RetryDecision::Retry
        );
    }

    #[test]
    fn retries_server_errors() {
        let policy = make_policy(3);

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
        let policy = make_policy(3);

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
        let policy = make_policy(3);
        let err = LlmError::MissingApiKey {
            var: "TEST_KEY".into(),
        };
        assert_eq!(should_retry_error(&err, 0, &policy), RetryDecision::Fail);
    }

    #[test]
    fn fails_when_retries_exhausted() {
        let policy = make_policy(1);

        let err = LlmError::IncompleteStream;
        assert_eq!(should_retry_error(&err, 0, &policy), RetryDecision::Retry);
        assert_eq!(should_retry_error(&err, 1, &policy), RetryDecision::Fail);
    }
}
