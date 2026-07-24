//! Multi-key credential fallback wrapper around `stream_with_retry`.
//!
//! Phase 4 of the provider/model rework lets a provider declare ordered
//! named API keys. On every request, Shore tries them in configured
//! order; if one fails with a credential-scoped signal (missing/invalid
//! key, exhausted quota or budget, account-scoped rate limit), it
//! abandons that key and retries the same request with the next one.
//!
//! Important invariants:
//!
//! * Fallback is **non-sticky**. Every new request restarts at the
//!   first enabled key — a previous-call rotation never short-circuits
//!   the next call's resolution.
//! * Transient errors (`stream_with_retry`'s 5xx / 429 / network) stay
//!   on the current key. The classifier in `crate::llm::credentials`
//!   only triggers rotation for credential-shaped failures.
//! * Mid-stream failures do not rotate. By the time bytes flow, the
//!   provider has accepted the credential and the user may have seen
//!   partial output. `IncompleteStream` is classified as
//!   `NotCredentialFailure` and falls through to the retry layer.
//! * Warnings honor `warn_on_fallback`. Falling away from a key with
//!   that flag emits a visible client warning (`ProviderFallbackWarning`)
//!   and a diagnostics record. Without it, the rotation is silent at
//!   the user level but still recorded for observability.
//! * Secrets never leave this module. The dispatcher reads env vars
//!   here; only friendly key names, status codes, and sanitized reason
//!   strings are surfaced to clients or diagnostics.

use chrono::Utc;
use tracing::{debug, error, warn};

use crate::llm::credentials::{
    classify_credential_failure, read_candidate_env, resolve_key_candidates, CredentialFailureKind,
    KeyCandidate,
};
use crate::llm::types::{LlmRequest, StreamResult};
use crate::llm::LlmError;
use shore_common::config::{models::ResolvedModel, LoadedConfig};
use shore_common::diagnostics::KeyFallbackEntry;
use shore_common::protocol::server_msg::{ProviderFallbackWarning, ServerMessage};

use super::generation::stream_with_retry;
use super::GenContext;

/// Outcome of trying one provider key candidate during credential fallback.
enum CandidateResult {
    /// Streaming succeeded.
    Success(StreamResult),
    /// Non-credential failure — do not rotate keys.
    NonCredentialFailure(LlmError),
    /// Credential failure — rotate to the next key.
    CredentialFailure(LlmError),
}

/// Bundled parameters for a single candidate attempt during key fallback.
struct CandidateAttempt<'att> {
    ctx: &'att GenContext,
    request: &'att mut LlmRequest,
    resolved: &'att ResolvedModel,
    effective_config: &'att LoadedConfig,
    regen: bool,
    char_name: &'att str,
    thinking_enabled: bool,
}

/// Try one provider key candidate. On success returns `Success`. On failure
/// classifies the error: credential failures (rotate) return `CredentialFailure`;
/// non-credential failures return `NonCredentialFailure`.
async fn try_candidate(
    att: &mut CandidateAttempt<'_>,
    cand: &KeyCandidate,
    next_cand: Option<&KeyCandidate>,
) -> CandidateResult {
    // A missing/empty env value is a credential failure (`MissingKey`) —
    // rotate without touching the network.
    let Some(api_key) = read_candidate_env(cand) else {
        let err = record_missing_key_fallback(
            att.ctx,
            att.request,
            att.resolved,
            att.char_name,
            cand,
            next_cand,
        );
        return CandidateResult::CredentialFailure(err);
    };

    att.request.api_key = api_key;
    att.request.api_key_name = Some(cand.name.clone());

    match stream_with_retry(
        att.ctx,
        att.request,
        att.resolved,
        att.effective_config,
        att.regen,
        att.char_name,
        att.thinking_enabled,
    )
    .await
    {
        Ok(r) => CandidateResult::Success(r),
        Err(e) => {
            let kind = classify_credential_failure(&att.resolved.provider_key, &e);
            if !kind.should_rotate() {
                // Transient retries already exhausted, OR this is a
                // 4xx/refusal/etc. that key rotation cannot help.
                return CandidateResult::NonCredentialFailure(e);
            }
            let status = llm_http_status(&e);
            let reason = sanitize_reason(&e);
            record_fallback(
                att.ctx,
                FallbackRecord {
                    request: att.request,
                    resolved: att.resolved,
                    char_name: att.char_name,
                    from: cand,
                    to: next_cand,
                    kind,
                    status,
                    reason: &reason,
                },
            );
            CandidateResult::CredentialFailure(e)
        }
    }
}

/// Stream the request with multi-key credential fallback.
///
/// Resolves candidate keys for the request's provider, then walks them
/// in order. Each candidate gets the full transient-retry budget via
/// `stream_with_retry`; only credential-classified failures rotate to
/// the next candidate. The request's `api_key` is rewritten in-place
/// before each attempt — callers must pass `&mut`.
pub(super) async fn stream_with_credential_fallback(
    ctx: &GenContext,
    request: &mut LlmRequest,
    resolved: &ResolvedModel,
    effective_config: &LoadedConfig,
    regen: bool,
    char_name: &str,
    thinking_enabled: bool,
) -> Result<StreamResult, LlmError> {
    let candidates = resolve_key_candidates(
        &resolved.provider_key,
        &effective_config.providers,
        resolved,
    );

    if candidates.is_empty() {
        // Provider explicitly disabled, or registered but with zero
        // enabled keys. There's nothing to try.
        return Err(LlmError::MissingApiKey {
            var: format!("provider '{}' has no enabled keys", resolved.provider_key),
        });
    }

    debug!(
        provider = %resolved.provider_key,
        model = %resolved.qualified_name,
        candidates = candidates.len(),
        "stream_with_credential_fallback starting"
    );

    let total = candidates.len();
    let mut last_err: Option<LlmError> = None;
    let mut att = CandidateAttempt {
        ctx,
        request,
        resolved,
        effective_config,
        regen,
        char_name,
        thinking_enabled,
    };

    for (i, cand) in candidates.iter().enumerate() {
        let next_cand = candidates.get(i.saturating_add(1));
        match try_candidate(&mut att, cand, next_cand).await {
            CandidateResult::Success(r) => {
                if i > 0 {
                    debug!(
                        provider = %resolved.provider_key,
                        used_key = %cand.name,
                        rotated_past = i,
                        "stream completed after credential fallback"
                    );
                }
                return Ok(r);
            }
            CandidateResult::NonCredentialFailure(e) => return Err(e),
            CandidateResult::CredentialFailure(e) => {
                last_err = Some(e);
                if next_cand.is_none() {
                    break;
                }
            }
        }
    }

    // Every candidate was tried (or skipped) and none succeeded. Surface
    // the most recent classified error so callers and clients see why.
    let final_err = last_err.unwrap_or_else(|| LlmError::MissingApiKey {
        var: format!("all keys for provider '{}' failed", resolved.provider_key),
    });
    error!(
        provider = %resolved.provider_key,
        model = %resolved.qualified_name,
        candidates = total,
        error = %final_err,
        "stream_with_credential_fallback exhausted all keys"
    );
    Err(final_err)
}

fn llm_http_status(error: &LlmError) -> Option<u16> {
    match error {
        LlmError::HttpStatus { status, .. } => Some(*status),
        LlmError::Request(_)
        | LlmError::Serialize(_)
        | LlmError::Deserialize(_)
        | LlmError::IncompleteStream
        | LlmError::StreamErrored { .. }
        | LlmError::MissingApiKey { .. }
        | LlmError::Provider { .. }
        | LlmError::Refusal => None,
    }
}

/// Record one fallback event: diagnostics + (optionally) a SWP warning.
///
/// The warning fires only when the *previous* key (the one we are
/// abandoning) has `warn_on_fallback = true`. Diagnostics records every
/// rotation regardless, so `shore status --diagnostics` shows the full
/// picture even when the user did not opt into a visible warning.
#[derive(Clone, Copy)]
struct FallbackRecord<'rec> {
    request: &'rec LlmRequest,
    resolved: &'rec ResolvedModel,
    char_name: &'rec str,
    from: &'rec KeyCandidate,
    to: Option<&'rec KeyCandidate>,
    kind: CredentialFailureKind,
    status: Option<u16>,
    reason: &'rec str,
}

fn record_missing_key_fallback(
    ctx: &GenContext,
    request: &LlmRequest,
    resolved: &ResolvedModel,
    char_name: &str,
    cand: &KeyCandidate,
    next_cand: Option<&KeyCandidate>,
) -> LlmError {
    let kind = CredentialFailureKind::MissingKey;
    let reason = format!("env {:?} unset or empty", cand.env);
    record_fallback(
        ctx,
        FallbackRecord {
            request,
            resolved,
            char_name,
            from: cand,
            to: next_cand,
            kind,
            status: None,
            reason: &reason,
        },
    );
    LlmError::MissingApiKey {
        var: cand.env.clone(),
    }
}

fn record_fallback(ctx: &GenContext, record: FallbackRecord<'_>) {
    let FallbackRecord {
        request,
        resolved,
        char_name,
        from,
        to,
        kind,
        status,
        reason,
    } = record;
    let timestamp = Utc::now().to_rfc3339();
    let to_name = to.map(|k| k.name.clone());

    // Diagnostics: always recorded.
    {
        let mut diag = match ctx.diagnostics.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        diag.key_fallbacks.push(KeyFallbackEntry {
            timestamp: timestamp.clone(),
            rid: request.rid.clone(),
            provider: resolved.provider_key.clone(),
            model: resolved.qualified_name.clone(),
            character: char_name.to_owned(),
            from_key: from.name.clone(),
            to_key: to_name.clone(),
            kind: kind.as_str().to_owned(),
            status,
            reason: reason.to_owned(),
        });
    }

    warn!(
        provider = %resolved.provider_key,
        model = %resolved.qualified_name,
        character = %char_name,
        from_key = %from.name,
        to_key = to_name.as_deref().unwrap_or("-"),
        kind = kind.as_str(),
        status = ?status,
        rid = request.rid.as_deref().unwrap_or("-"),
        // `reason` is sanitized but still goes only to logs, not to
        // clients without `warn_on_fallback`.
        reason = %reason,
        "rotating provider key after credential failure"
    );

    // SWP warning: only when the abandoned key opted into visibility,
    // and only when there's a destination key (the final-failure case
    // surfaces through the returned `LlmError` instead of a warning).
    if from.warn_on_fallback {
        if let Some(to_cand) = to {
            let message = build_warning_message(&resolved.provider_key, from, to_cand, kind);
            let warning = ProviderFallbackWarning {
                rid: request.rid.clone(),
                provider: resolved.provider_key.clone(),
                from_key: from.name.clone(),
                to_key: to_cand.name.clone(),
                kind: kind.as_str().to_owned(),
                status,
                message,
            };
            // Best-effort send. If the direct channel is full or closed
            // we still have the diagnostics + tracing records.
            if let Err(e) = ctx
                .direct_tx
                .try_send(ServerMessage::ProviderFallbackWarning(warning))
            {
                debug!(
                    error = %e,
                    "ProviderFallbackWarning drop: direct channel unavailable"
                );
            }
        }
    }
}

/// Build the user-facing warning string. Variant tailored to the
/// failure kind so the message reads naturally regardless of why we
/// rotated. Never includes status bodies, env values, or the API key.
fn build_warning_message(
    provider: &str,
    from: &KeyCandidate,
    to: &KeyCandidate,
    kind: CredentialFailureKind,
) -> String {
    match kind {
        CredentialFailureKind::BudgetExhausted => format!(
            "Budget warning: {provider} key {:?} appears exhausted. Continuing with fallback key {:?}.",
            from.name, to.name
        ),
        CredentialFailureKind::QuotaExhausted => format!(
            "Quota warning: {provider} key {:?} appears over quota. Continuing with fallback key {:?}.",
            from.name, to.name
        ),
        CredentialFailureKind::MissingKey => format!(
            "{provider} key {:?} is not configured. Continuing with fallback key {:?}.",
            from.name, to.name
        ),
        CredentialFailureKind::InvalidKey => format!(
            "{provider} key {:?} was rejected. Continuing with fallback key {:?}.",
            from.name, to.name
        ),
        CredentialFailureKind::RateLimitedCredential => format!(
            "{provider} key {:?} is rate-limited. Continuing with fallback key {:?}.",
            from.name, to.name
        ),
        CredentialFailureKind::Unknown => format!(
            "{provider} key {:?} failed (credential-related). Continuing with fallback key {:?}.",
            from.name, to.name
        ),
        CredentialFailureKind::NotCredentialFailure => {
            // Should never happen — we only call build_warning_message
            // for rotation-triggering kinds — but stay defensive so a
            // future caller change doesn't leak a misleading message.
            format!("{provider} fallback from {:?} to {:?}.", from.name, to.name)
        }
    }
}

/// Strip the body from `LlmError::HttpStatus` so warnings/diagnostics
/// keep the status code but never leak provider response payloads
/// (which can include partial credentials, internal IDs, or quota
/// quotas verbatim).
fn sanitize_reason(err: &LlmError) -> String {
    match err {
        LlmError::HttpStatus { status, .. } => format!("HTTP {status}"),
        LlmError::MissingApiKey { var } => format!("env {var:?} not set"),
        LlmError::Provider { message } => {
            // Provider-supplied messages are usually benign, but cap the
            // length defensively in case a backend returns a verbose body.
            let truncated = if message.len() > 200 {
                let end = message.floor_char_boundary(200);
                format!("{}…", message.get(..end).unwrap_or(message))
            } else {
                message.clone()
            };
            format!("provider error: {truncated}")
        }
        LlmError::Refusal => "model refusal".into(),
        LlmError::IncompleteStream => "stream ended without done event".into(),
        LlmError::StreamErrored { message, .. } => format!("stream errored: {message}"),
        LlmError::Request(_) => "transport error".into(),
        LlmError::Serialize(_) => "request serialization failed".into(),
        LlmError::Deserialize(_) => "response deserialization failed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shore_common::config::models::Sdk;

    fn make_kind_message(kind: CredentialFailureKind) -> String {
        let from = KeyCandidate {
            name: "budget".into(),
            env: "X".into(),
            warn_on_fallback: true,
        };
        let to = KeyCandidate {
            name: "overflow".into(),
            env: "Y".into(),
            warn_on_fallback: false,
        };
        build_warning_message("openrouter", &from, &to, kind)
    }

    #[test]
    fn warning_message_for_budget_mentions_exhaustion() {
        let s = make_kind_message(CredentialFailureKind::BudgetExhausted);
        assert!(s.contains("Budget warning"));
        assert!(s.contains("openrouter"));
        assert!(s.contains("\"budget\""));
        assert!(s.contains("\"overflow\""));
    }

    #[test]
    fn warning_message_for_invalid_says_rejected() {
        let s = make_kind_message(CredentialFailureKind::InvalidKey);
        assert!(s.contains("rejected"));
    }

    #[test]
    fn warning_message_for_missing_says_not_configured() {
        let s = make_kind_message(CredentialFailureKind::MissingKey);
        assert!(s.contains("not configured"));
    }

    #[test]
    fn warning_message_never_contains_env_value() {
        // Sanity: even contrived env names don't leak.
        let from = KeyCandidate {
            name: "k1".into(),
            env: "SHORE_SECRET_VALUE_MUST_NOT_LEAK".into(),
            warn_on_fallback: true,
        };
        let to = KeyCandidate {
            name: "k2".into(),
            env: "OTHER".into(),
            warn_on_fallback: false,
        };
        let s = build_warning_message(
            "openrouter",
            &from,
            &to,
            CredentialFailureKind::BudgetExhausted,
        );
        assert!(!s.contains("SHORE_SECRET_VALUE_MUST_NOT_LEAK"));
        assert!(!s.contains("OTHER"));
    }

    #[test]
    fn sanitize_http_status_drops_body() {
        let err = LlmError::HttpStatus {
            status: 401,
            body: r#"{"key":"sk-LEAKED-VALUE"}"#.into(),
        };
        let s = sanitize_reason(&err);
        assert_eq!(s, "HTTP 401");
        assert!(!s.contains("sk-LEAKED-VALUE"));
    }

    #[test]
    fn sanitize_provider_truncates_long_messages() {
        let err = LlmError::Provider {
            message: "x".repeat(500),
        };
        let s = sanitize_reason(&err);
        assert!(s.starts_with("provider error: "));
        // Truncated to 200 chars + "…", well below the 500 input.
        assert!(s.len() < 240);
    }

    #[test]
    fn sanitize_missing_api_key_includes_var_name() {
        let err = LlmError::MissingApiKey {
            var: "OPENAI_API_KEY".into(),
        };
        assert!(sanitize_reason(&err).contains("OPENAI_API_KEY"));
    }

    // Smoke test: this module should compile against ResolvedModel by
    // referencing fields the dispatch actually uses.
    #[test]
    fn provider_key_field_is_used() {
        let m = ResolvedModel {
            name: "m".into(),
            qualified_name: "x:m1".into(),
            category: "chat".into(),
            provider_key: "x".into(),
            sdk: Sdk::Openai,
            model_id: "m1".into(),
            api_key_env: None,
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
            vertex_project: None,
            vertex_location: None,
            gemini_generation: None,
            gemini_web_search: None,
            zai_clear_thinking: None,
            zai_subscription: None,
            replay_prior_thinking: None,
            max_tool_iterations: None,
        };
        assert_eq!(m.provider_key, "x");
    }
}
