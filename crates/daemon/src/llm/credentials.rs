//! Credential failure classification for the multi-key fallback path.
//!
//! Phase 4 of the provider/model rework introduces ordered named API keys
//! per provider. When a request fails with a credential-specific signal
//! (missing/invalid key, exhausted quota or budget, key-scoped rate limit),
//! the dispatch layer rotates to the next configured key for the same
//! request. Plain transient errors (5xx, generic 429, network blips) stay
//! on the current key — those go through the existing `retry.rs` path.
//!
//! This module is the classifier the dispatcher consults. It looks at the
//! provider key and the `LlmError` returned by `stream_raw` / `generate`
//! and decides whether the failure is credential-shaped enough to warrant
//! key rotation.
//!
//! Design notes:
//!
//! - Status code alone is not enough. A 401/403 is almost always
//!   credential-related; a 429 sometimes is and sometimes isn't (account
//!   quota vs. global ratelimit). Provider error bodies vary, so the
//!   classifier is permissive but not aggressive: when uncertain, prefer
//!   `NotCredentialFailure` so the caller falls back to retry semantics.
//! - The classifier never logs the API key value or env var contents. It
//!   only inspects the public error surface.
//! - Mid-stream errors (`IncompleteStream`) are explicitly *not* credential
//!   failures — by the time a stream starts, the provider has accepted
//!   the credential and the user may have already seen partial output.

use shore_common::config::models::ResolvedModel;
use shore_common::config::providers::ProviderRegistry;

use crate::llm::LlmError;

/// What kind of failure a request hit, from the perspective of credential
/// rotation. Values other than `NotCredentialFailure` are eligible for
/// rotation when another enabled key exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialFailureKind {
    /// The configured API key env var is unset or empty. Rotation should
    /// move to the next key without surfacing user-visible noise.
    MissingKey,

    /// The provider rejected the credential (typically 401/403 or
    /// `invalid_api_key` in the body). Rotate to the next key.
    InvalidKey,

    /// The credential is valid but its quota is exhausted (typically a 429
    /// with `quota`/`exceeded` wording, or `insufficient_quota`). Rotate.
    QuotaExhausted,

    /// The credential is valid but its account budget is exhausted
    /// (OpenRouter-style `402 Payment Required`, or explicit `budget`
    /// wording). Rotate; this is the case `warn_on_fallback` is meant for.
    BudgetExhausted,

    /// A rate limit clearly tied to this credential/account, not a global
    /// burst. Rotate cautiously — the classifier only emits this when the
    /// signal is unambiguous.
    RateLimitedCredential,

    /// Definitely not a credential failure (transient 5xx, network errors,
    /// malformed requests, content-filter refusals, mid-stream
    /// disconnects). Caller should defer to existing retry policy.
    NotCredentialFailure,

    /// The error shape is credential-adjacent but not confidently
    /// classifiable. Rotation is allowed; downstream warning text should
    /// be conservative.
    Unknown,
}

impl CredentialFailureKind {
    /// Whether this kind warrants rotating to the next configured key.
    pub fn should_rotate(self) -> bool {
        !matches!(self, Self::NotCredentialFailure)
    }

    /// Stable string tag for diagnostics / structured logs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingKey => "missing_key",
            Self::InvalidKey => "invalid_key",
            Self::QuotaExhausted => "quota_exhausted",
            Self::BudgetExhausted => "budget_exhausted",
            Self::RateLimitedCredential => "rate_limited_credential",
            Self::NotCredentialFailure => "not_credential_failure",
            Self::Unknown => "unknown",
        }
    }
}

/// Classify an `LlmError` for the multi-key fallback path.
///
/// `provider_key` is informational — most decisions come from status code
/// and body wording. It is wired in so future provider-specific tweaks
/// have a place to land without changing the call sites.
#[expect(
    clippy::match_same_arms,
    reason = "credential-failure categories kept as separate arms, each documented at its decision point"
)]
pub fn classify_credential_failure(_provider_key: &str, error: &LlmError) -> CredentialFailureKind {
    match error {
        LlmError::MissingApiKey { .. } => CredentialFailureKind::MissingKey,

        LlmError::HttpStatus { status, body } => classify_http(*status, body),

        // Mid-stream disconnects must not rotate keys: the provider already
        // accepted the credential, and the user may have seen partial
        // output.
        LlmError::IncompleteStream | LlmError::StreamErrored { .. } => {
            CredentialFailureKind::NotCredentialFailure
        }

        // Network / transport / serde / refusal — none of these are
        // credential failures. Let retry.rs decide what to do.
        LlmError::Request(_)
        | LlmError::Serialize(_)
        | LlmError::Deserialize(_)
        | LlmError::Refusal => CredentialFailureKind::NotCredentialFailure,

        // Generic provider errors are too vague to confidently rotate on.
        LlmError::Provider { .. } => CredentialFailureKind::NotCredentialFailure,
    }
}

fn classify_http(status: u16, body: &str) -> CredentialFailureKind {
    let body_lc = body.to_lowercase();

    match status {
        // 401 Unauthorized / 403 Forbidden — credential is bad.
        401 | 403 => {
            if mentions_quota(&body_lc) {
                // Some providers return 403 for exhausted quota.
                CredentialFailureKind::QuotaExhausted
            } else {
                CredentialFailureKind::InvalidKey
            }
        }

        // 402 Payment Required — OpenRouter and some Stripe-backed APIs
        // use this for account-budget exhaustion.
        402 => CredentialFailureKind::BudgetExhausted,

        // 429 Too Many Requests — needs body wording to disambiguate.
        429 => {
            if mentions_budget(&body_lc) {
                CredentialFailureKind::BudgetExhausted
            } else if mentions_quota(&body_lc) {
                CredentialFailureKind::QuotaExhausted
            } else if mentions_credential_rate_limit(&body_lc) {
                CredentialFailureKind::RateLimitedCredential
            } else {
                // Generic 429 — global ratelimit, not credential-scoped.
                CredentialFailureKind::NotCredentialFailure
            }
        }

        // Some 400s carry credential signals (`invalid_api_key`,
        // `authentication_error`) when the gateway is loose about which
        // status to use.
        400 => {
            if mentions_invalid_credential(&body_lc) {
                CredentialFailureKind::InvalidKey
            } else if mentions_quota(&body_lc) {
                CredentialFailureKind::QuotaExhausted
            } else {
                CredentialFailureKind::NotCredentialFailure
            }
        }

        // 5xx and everything else: not credential-related.
        _ => CredentialFailureKind::NotCredentialFailure,
    }
}

fn mentions_quota(body_lc: &str) -> bool {
    body_lc.contains("quota")
        || body_lc.contains("insufficient_quota")
        || body_lc.contains("usage limit")
        || body_lc.contains("monthly limit")
}

fn mentions_budget(body_lc: &str) -> bool {
    body_lc.contains("budget")
        || body_lc.contains("payment required")
        || body_lc.contains("insufficient_funds")
        || body_lc.contains("credit")
}

fn mentions_credential_rate_limit(body_lc: &str) -> bool {
    // Heuristic: a 429 that names the key/account is credential-scoped.
    // We avoid treating plain "rate limit" wording as credential because
    // those are usually global bursts.
    body_lc.contains("account_rate_limit")
        || body_lc.contains("per-key rate")
        || body_lc.contains("api key rate")
}

fn mentions_invalid_credential(body_lc: &str) -> bool {
    body_lc.contains("invalid_api_key")
        || body_lc.contains("invalid api key")
        || body_lc.contains("authentication_error")
        || body_lc.contains("authentication failed")
        || body_lc.contains("unauthorized")
}

// ── Key candidates ─────────────────────────────────────────────────────────

/// One candidate API key for the multi-key fallback path.
///
/// The dispatch layer materializes a `Vec<KeyCandidate>` for a given
/// `(provider_key, model)` from the provider registry plus a legacy
/// single-key fallback. Each request walks the list in order, rotating on
/// credential failures. The friendly `name` is what surfaces in fallback
/// warnings to clients — never the env var value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCandidate {
    /// Friendly name (e.g. `"budget"`, `"overflow"`, or `"default"` for
    /// the legacy single-key path). Surfaced to clients on fallback.
    pub name: String,

    /// Env var that holds the API key value. The dispatcher reads this
    /// just before each attempt; readers never log the value itself.
    pub env: String,

    /// If true, falling away from this key emits a visible warning to
    /// connected clients. Used to flag a budget-capped key whose
    /// exhaustion the user should see immediately.
    pub warn_on_fallback: bool,
}

/// Resolve the ordered list of API key candidates for `(provider_key, model)`.
///
/// Resolution order:
///
/// 1. If `[providers.<provider_key>]` exists and is disabled, return empty.
/// 2. If the provider entry has any enabled `[[keys]]`, return them in
///    configured order. Disabled keys are filtered out here, not silently
///    dropped — they remain visible via `ProviderRegistry::get`.
/// 3. Otherwise (either no provider entry, or an enabled provider entry
///    that declares no keys — e.g. a registry entry added only for
///    sdk/base_url/discovery), fall back to the legacy single-key path:
///    synthesize one `KeyCandidate { name: "default",
///    env: model.api_key_env || default_api_key_env(provider_key) }`.
///
/// Falling back when an enabled provider has no keys preserves the
/// pre-Phase-1 contract that a static `[chat.X.Y].api_key_env` keeps
/// working when the user adds `[providers.X]` for non-credential reasons.
///
/// The returned vector is empty only when the provider is explicitly
/// disabled. The dispatcher treats that as a hard failure
/// (`MissingApiKey`) without rotation.
pub fn resolve_key_candidates(
    provider_key: &str,
    registry: &ProviderRegistry,
    model: &ResolvedModel,
) -> Vec<KeyCandidate> {
    resolve_key_candidates_for(provider_key, registry, model.api_key_env.as_deref())
}

/// Resolve the ordered list of API key candidates for `provider_key` without a
/// [`ResolvedModel`]. Used by the non-chat categories (embedding, image
/// generation) whose identity is a bare `provider:model_id` rather than a
/// resolved chat model, but which must reuse the exact same `[providers.*]`
/// key-fallback contract.
///
/// `fallback_api_key_env` is the single env name to synthesize a `"default"`
/// key from when the provider declares no `[[keys]]` (mirrors a static model's
/// `api_key_env`). `None` falls back to [`crate::llm::default_api_key_env`].
///
/// See [`resolve_key_candidates`] for the full resolution-order contract.
pub fn resolve_key_candidates_for(
    provider_key: &str,
    registry: &ProviderRegistry,
    fallback_api_key_env: Option<&str>,
) -> Vec<KeyCandidate> {
    if let Some(entry) = registry.get(provider_key) {
        if !entry.enabled {
            return Vec::new();
        }
        let candidates: Vec<KeyCandidate> = entry
            .enabled_keys()
            .map(|k| KeyCandidate {
                name: k.name.clone(),
                env: k.env.clone(),
                warn_on_fallback: k.warn_on_fallback,
            })
            .collect();
        if !candidates.is_empty() {
            return candidates;
        }
        // Enabled provider with no usable keys → fall through to legacy
        // single-key synthesis below so static api_key_env still works.
    }

    // Legacy single-key fallback. Mirrors `LlmClient::build_request`'s
    // env resolution so providers not yet in the registry — or registered
    // for sdk/base_url/discovery only — behave identically to pre-Phase-4
    // code.
    let env = fallback_api_key_env.map_or_else(
        || crate::llm::default_api_key_env(provider_key).to_owned(),
        str::to_owned,
    );
    vec![KeyCandidate {
        name: "default".into(),
        env,
        warn_on_fallback: false,
    }]
}

/// Read a key candidate's env var, returning `None` when unset or empty.
///
/// Treating empty as missing mirrors how shells often unset variables
/// (`KEY=`) and matches the user's mental model that "not configured"
/// covers both cases. Whitespace-only values are also rejected.
pub fn read_candidate_env(candidate: &KeyCandidate) -> Option<String> {
    let value = std::env::var(&candidate.env).ok()?;
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(status: u16, body: &str) -> LlmError {
        LlmError::HttpStatus {
            status,
            body: body.into(),
        }
    }

    #[test]
    fn missing_api_key_is_classified() {
        let err = LlmError::MissingApiKey { var: "X".into() };
        assert_eq!(
            classify_credential_failure("openai", &err),
            CredentialFailureKind::MissingKey
        );
    }

    #[test]
    fn http_401_is_invalid_key() {
        assert_eq!(
            classify_credential_failure("openai", &http(401, "")),
            CredentialFailureKind::InvalidKey
        );
    }

    #[test]
    fn http_403_with_quota_wording_is_quota() {
        assert_eq!(
            classify_credential_failure("openai", &http(403, r#"{"error":"quota exceeded"}"#)),
            CredentialFailureKind::QuotaExhausted
        );
    }

    #[test]
    fn http_402_is_budget_exhausted() {
        assert_eq!(
            classify_credential_failure(
                "openrouter",
                &http(402, "Payment Required: insufficient credit"),
            ),
            CredentialFailureKind::BudgetExhausted
        );
    }

    #[test]
    fn http_429_with_budget_wording_is_budget() {
        assert_eq!(
            classify_credential_failure("openrouter", &http(429, "budget exceeded")),
            CredentialFailureKind::BudgetExhausted
        );
    }

    #[test]
    fn http_429_with_quota_wording_is_quota() {
        assert_eq!(
            classify_credential_failure("openai", &http(429, r#"{"type":"insufficient_quota"}"#)),
            CredentialFailureKind::QuotaExhausted
        );
    }

    #[test]
    fn http_429_with_account_rate_limit_is_credential_scoped() {
        assert_eq!(
            classify_credential_failure(
                "openai",
                &http(429, "account_rate_limit reached for this api key")
            ),
            CredentialFailureKind::RateLimitedCredential
        );
    }

    #[test]
    fn generic_429_is_not_credential() {
        assert_eq!(
            classify_credential_failure("openai", &http(429, "Too Many Requests")),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn http_400_invalid_api_key_in_body_is_invalid_key() {
        assert_eq!(
            classify_credential_failure("openai", &http(400, r#"{"error":"invalid_api_key"}"#)),
            CredentialFailureKind::InvalidKey
        );
    }

    #[test]
    fn http_400_malformed_request_is_not_credential() {
        assert_eq!(
            classify_credential_failure("openai", &http(400, r#"{"error":"messages: required"}"#)),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn http_500_is_not_credential() {
        assert_eq!(
            classify_credential_failure("openai", &http(500, "internal error")),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn http_503_is_not_credential() {
        assert_eq!(
            classify_credential_failure("openai", &http(503, "")),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn incomplete_stream_is_not_credential() {
        assert_eq!(
            classify_credential_failure("openai", &LlmError::IncompleteStream),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn refusal_is_not_credential() {
        assert_eq!(
            classify_credential_failure("openai", &LlmError::Refusal),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn provider_error_is_not_credential() {
        // Generic provider-side error is too vague — classifier defers to
        // retry.rs rather than aggressively rotating keys on every blip.
        assert_eq!(
            classify_credential_failure(
                "openai",
                &LlmError::Provider {
                    message: "something went wrong".into()
                }
            ),
            CredentialFailureKind::NotCredentialFailure
        );
    }

    #[test]
    fn should_rotate_excludes_only_not_credential_failure() {
        assert!(CredentialFailureKind::MissingKey.should_rotate());
        assert!(CredentialFailureKind::InvalidKey.should_rotate());
        assert!(CredentialFailureKind::QuotaExhausted.should_rotate());
        assert!(CredentialFailureKind::BudgetExhausted.should_rotate());
        assert!(CredentialFailureKind::RateLimitedCredential.should_rotate());
        assert!(CredentialFailureKind::Unknown.should_rotate());
        assert!(!CredentialFailureKind::NotCredentialFailure.should_rotate());
    }

    // ── KeyCandidate / resolve_key_candidates ────────────────────────

    use shore_common::config::models::{ResolvedModel, Sdk};

    fn test_model(provider_key: &str, api_key_env: Option<&str>) -> ResolvedModel {
        ResolvedModel {
            name: "m".into(),
            qualified_name: format!("{provider_key}:m1"),
            category: "chat".into(),
            provider_key: provider_key.into(),
            sdk: Sdk::Openai,
            model_id: "m1".into(),
            api_key_env: api_key_env.map(String::from),
            base_url: None,
            max_context_tokens: None,
            max_output_tokens: None,
            temperature: None,
            top_p: None,
            reasoning_effort: None,
            budget_tokens: None,
            cache_ttl: None,
            cache_keepalive: None,
            openrouter_provider: None,
            gemini_generation: None,
            zai_clear_thinking: None,
            zai_subscription: None,
            replay_prior_thinking: None,
            max_tool_iterations: None,
        }
    }

    fn registry_from(s: &str) -> ProviderRegistry {
        let table: toml::Table = s.parse().unwrap();
        let providers = table.get("providers").and_then(|v| v.as_table());
        ProviderRegistry::from_section(providers).unwrap()
    }

    fn candidate(cands: &[KeyCandidate], index: usize) -> &KeyCandidate {
        cands.get(index).expect("key candidate")
    }

    #[test]
    fn resolve_falls_back_to_single_default_key_when_provider_not_in_registry() {
        let registry = ProviderRegistry::default();
        let model = test_model("anthropic", None);
        let cands = resolve_key_candidates("anthropic", &registry, &model);
        assert_eq!(cands.len(), 1);
        assert_eq!(candidate(&cands, 0).name.as_str(), "default");
        assert_eq!(candidate(&cands, 0).env.as_str(), "ANTHROPIC_API_KEY");
        assert!(!candidate(&cands, 0).warn_on_fallback);
    }

    #[test]
    fn legacy_fallback_honors_explicit_model_api_key_env() {
        let registry = ProviderRegistry::default();
        let model = test_model("openai", Some("MY_OVERRIDE_KEY"));
        let cands = resolve_key_candidates("openai", &registry, &model);
        assert_eq!(cands.len(), 1);
        assert_eq!(candidate(&cands, 0).env.as_str(), "MY_OVERRIDE_KEY");
    }

    #[test]
    fn registry_named_keys_resolve_in_order() {
        let registry = registry_from(
            r#"
[[providers.openrouter.keys]]
name = "budget"
env = "OR_BUDGET"
warn_on_fallback = true

[[providers.openrouter.keys]]
name = "overflow"
env = "OR_OVERFLOW"
"#,
        );
        let model = test_model("openrouter", None);
        let cands = resolve_key_candidates("openrouter", &registry, &model);
        assert_eq!(cands.len(), 2);
        assert_eq!(candidate(&cands, 0).name.as_str(), "budget");
        assert!(candidate(&cands, 0).warn_on_fallback);
        assert_eq!(candidate(&cands, 1).name.as_str(), "overflow");
        assert!(!candidate(&cands, 1).warn_on_fallback);
    }

    #[test]
    fn registry_disabled_keys_are_skipped() {
        let registry = registry_from(
            r#"
[[providers.openrouter.keys]]
name = "first"
env = "A"

[[providers.openrouter.keys]]
name = "off"
env = "B"
enabled = false

[[providers.openrouter.keys]]
name = "third"
env = "C"
"#,
        );
        let model = test_model("openrouter", None);
        let names: Vec<_> = resolve_key_candidates("openrouter", &registry, &model)
            .into_iter()
            .map(|k| k.name)
            .collect();
        assert_eq!(names, vec!["first", "third"]);
    }

    #[test]
    fn registry_compact_form_synthesizes_default_candidate() {
        let registry = registry_from(
            r#"
[providers.openai]
api_key_env = "OPENAI_API_KEY"
"#,
        );
        let model = test_model("openai", None);
        let cands = resolve_key_candidates("openai", &registry, &model);
        assert_eq!(cands.len(), 1);
        assert_eq!(candidate(&cands, 0).name.as_str(), "default");
        assert_eq!(candidate(&cands, 0).env.as_str(), "OPENAI_API_KEY");
    }

    #[test]
    fn enabled_provider_with_no_keys_falls_back_to_static_api_key_env() {
        // P2 regression: a [providers.X] block added only for sdk/base_url/
        // discovery (no [[keys]], no compact api_key_env) must NOT yield an
        // empty candidate list — the static model's api_key_env should keep
        // working unchanged.
        let registry = registry_from(
            r#"
[providers.openrouter]
sdk = "openai"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
"#,
        );
        let model = test_model("openrouter", Some("OPENROUTER_API_KEY"));
        let cands = resolve_key_candidates("openrouter", &registry, &model);
        assert_eq!(cands.len(), 1);
        assert_eq!(candidate(&cands, 0).name.as_str(), "default");
        assert_eq!(candidate(&cands, 0).env.as_str(), "OPENROUTER_API_KEY");
    }

    #[test]
    fn enabled_provider_with_no_keys_falls_back_to_default_env() {
        // Same fallback path, but the static model has no api_key_env —
        // synthesize from default_api_key_env(provider_key).
        let registry = registry_from(
            r#"
[providers.anthropic]
base_url = "https://api.anthropic.com"
"#,
        );
        let model = test_model("anthropic", None);
        let cands = resolve_key_candidates("anthropic", &registry, &model);
        assert_eq!(cands.len(), 1);
        assert_eq!(candidate(&cands, 0).env.as_str(), "ANTHROPIC_API_KEY");
    }

    #[test]
    fn disabled_provider_yields_no_candidates() {
        let registry = registry_from(
            r#"
[providers.openrouter]
enabled = false
api_key_env = "OR_KEY"
"#,
        );
        let model = test_model("openrouter", None);
        let cands = resolve_key_candidates("openrouter", &registry, &model);
        assert!(cands.is_empty());
    }

    #[test]
    fn read_candidate_env_returns_none_for_unset() {
        // Use a name that won't collide with anything else.
        std::env::remove_var("SHORE_TEST_CRED_UNSET_42");
        let cand = KeyCandidate {
            name: "x".into(),
            env: "SHORE_TEST_CRED_UNSET_42".into(),
            warn_on_fallback: false,
        };
        assert!(read_candidate_env(&cand).is_none());
    }

    #[test]
    fn read_candidate_env_returns_none_for_empty() {
        std::env::set_var("SHORE_TEST_CRED_EMPTY_42", "");
        let cand = KeyCandidate {
            name: "x".into(),
            env: "SHORE_TEST_CRED_EMPTY_42".into(),
            warn_on_fallback: false,
        };
        assert!(read_candidate_env(&cand).is_none());
        std::env::remove_var("SHORE_TEST_CRED_EMPTY_42");
    }

    #[test]
    fn read_candidate_env_returns_value_for_set() {
        std::env::set_var("SHORE_TEST_CRED_SET_42", "sk-abc");
        let cand = KeyCandidate {
            name: "x".into(),
            env: "SHORE_TEST_CRED_SET_42".into(),
            warn_on_fallback: false,
        };
        assert_eq!(read_candidate_env(&cand).as_deref(), Some("sk-abc"));
        std::env::remove_var("SHORE_TEST_CRED_SET_42");
    }

    #[test]
    fn as_str_is_stable() {
        // Diagnostics / log consumers depend on these tags.
        assert_eq!(CredentialFailureKind::MissingKey.as_str(), "missing_key");
        assert_eq!(CredentialFailureKind::InvalidKey.as_str(), "invalid_key");
        assert_eq!(
            CredentialFailureKind::QuotaExhausted.as_str(),
            "quota_exhausted"
        );
        assert_eq!(
            CredentialFailureKind::BudgetExhausted.as_str(),
            "budget_exhausted"
        );
        assert_eq!(
            CredentialFailureKind::RateLimitedCredential.as_str(),
            "rate_limited_credential"
        );
        assert_eq!(
            CredentialFailureKind::NotCredentialFailure.as_str(),
            "not_credential_failure"
        );
        assert_eq!(CredentialFailureKind::Unknown.as_str(), "unknown");
    }
}
