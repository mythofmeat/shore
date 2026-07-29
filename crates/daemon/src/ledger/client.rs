//! LedgerClient: compiler-enforced wrapper around LlmClient.

use crate::ledger::pricing::PricingEngine;
use crate::ledger::reports::{
    BudgetWarnings, ModelHistory, ModelUsageRow, UsageBudgetWarningEvent,
};
use crate::ledger::store::Ledger;
use crate::llm::credentials::{
    classify_credential_failure, read_candidate_env, resolve_key_candidates, CredentialFailureKind,
    KeyCandidate,
};
use crate::llm::types::{CallContext, GenerateResponse, LlmRequest};
use crate::llm::{LlmClient, LlmError};
use serde::Serialize;
use shore_common::config::app::UsageConfig;
use shore_common::config::models::ResolvedModel;
use shore_common::config::providers::ProviderRegistry;
use shore_common::config::LoadedConfig;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tracing::{debug, error, instrument, warn};

// ── CallType ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum CallType {
    Message,
    ToolLoop,
    HeartbeatToolLoop,
    Keepalive,
    Heartbeat,
    Compaction,
    Dreaming,
    MemoryQuery,
    /// Initial stream of a delegated sub-agent (`ask_<name>` tool). The
    /// agent's own tool-loop continuations are tagged `ToolLoop`, mirroring
    /// how the heartbeat path tags only its first call distinctly.
    Subagent,
}

impl CallType {
    pub fn as_str(&self) -> &'static str {
        match self {
            CallType::Message => "message",
            CallType::ToolLoop => "tool_loop",
            CallType::HeartbeatToolLoop => "heartbeat_tool_loop",
            CallType::Keepalive => "keepalive",
            CallType::Heartbeat => "heartbeat",
            CallType::Compaction => "compaction",
            CallType::Dreaming => "dreaming",
            CallType::MemoryQuery => "memory_query",
            CallType::Subagent => "subagent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialFallbackEvent {
    pub from_key: String,
    pub to_key: Option<String>,
    pub kind: String,
    pub status: Option<u16>,
    pub reason: String,
    pub warn_on_fallback: bool,
}

// ── recording ───────────────────────────────────────────────────────────────
//
// Rows are written by the **sidecar**, not here. It is what makes the provider
// call, so it is the only side that sees each call of a delegated tool loop
// separately, and the only side that can record a failed call at the moment it
// fails. The daemon's job is to hand it the labels it cannot derive — see
// [`CallContext`] and `llm-sidecar/src/ledger/`.
//
// This file kept a `record_call` sink until the seam moved. Splitting the
// ownership — sidecar for successes, daemon for failures — was the tempting
// intermediate and is the one shape that cannot work: a loop that records two
// calls and then dies would be double-counted by a daemon-side error row.

// ── LedgerClient ────────────────────────────────────────────────────────────

/// The per-call labels resolved on this side before dispatch.
///
/// Grouped rather than passed loose: they share the property of being decided
/// here and consumed over there, and `cache_ttl`/`reasoning_effort` are sent
/// already resolved so a row's shape does not depend on two implementations of
/// the same resolution agreeing.
#[derive(Debug, Clone, Copy)]
struct CallLabels<'req> {
    thinking_enabled: bool,
    cache_ttl: Option<&'req str>,
    reasoning_effort: Option<&'req str>,
    /// Budgets for the sidecar's gate. `None` when none are configured.
    usage: Option<&'req UsageConfig>,
}

// ── Ledger query bodies ─────────────────────────────────────────────────────
//
// The three `/v1/usage*` requests. Each names the ledger to read, because the
// sidecar serves whatever path it is handed rather than holding one open for
// the daemon — the same arrangement the recording path uses.

#[derive(Serialize)]
struct UsageReportRequest<'req> {
    ledger: &'req Path,
    /// The `shore usage` arguments, verbatim. The sidecar picks the mode.
    args: &'req serde_json::Value,
    usage: &'req UsageConfig,
}

#[derive(Serialize)]
struct BudgetWarningsRequest<'req> {
    ledger: &'req Path,
    usage: &'req UsageConfig,
}

#[derive(Serialize)]
struct ModelHistoryRequest<'req> {
    ledger: &'req Path,
    character: &'req str,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<&'req str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    until: Option<&'req str>,
}

#[derive(Debug, Clone)]
pub struct LedgerClient {
    inner: LlmClient,
    ledger: Arc<Ledger>,
    /// Where the sidecar should write rows. `None` for an in-memory ledger,
    /// which no second process can open — such a client records nothing.
    db_path: Option<Arc<Path>>,
    pricing: Arc<PricingEngine>,
    usage_config: Arc<RwLock<UsageConfig>>,
    /// `[behavior.autonomy].cache_keepalive_max`, in seconds; `0` until config
    /// is loaded. Sent on every call rather than pushed once, because the
    /// tracker it configures now lives in another process.
    keepalive_max_secs: Arc<AtomicU64>,
}

impl LedgerClient {
    /// Create a new LedgerClient backed by a file database at `db_path`.
    pub fn new(client: LlmClient, db_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let ledger = Arc::new(Ledger::open(db_path)?);
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        Ok(Self {
            inner: client,
            ledger,
            db_path: Some(Arc::from(db_path)),
            pricing,
            usage_config: Arc::new(RwLock::new(UsageConfig::default())),
            keepalive_max_secs: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Create a LedgerClient with an in-memory database (tests only).
    #[cfg(test)]
    pub fn new_in_memory(client: LlmClient) -> Self {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        Self {
            inner: client,
            ledger,
            db_path: None,
            pricing,
            usage_config: Arc::new(RwLock::new(UsageConfig::default())),
            keepalive_max_secs: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Replace the runtime usage-budget configuration used for LLM admission.
    pub fn set_usage_config(&self, config: UsageConfig) {
        match self.usage_config.write() {
            Ok(mut guard) => {
                *guard = config;
            }
            Err(poisoned) => {
                *poisoned.into_inner() = config;
            }
        }
    }

    /// Record the keepalive idle ceiling (`[behavior.autonomy].cache_keepalive_max`)
    /// so `keepalive_miss` is judged against the interval the keepalive
    /// subsystem actually enforces rather than the tracker's built-in default.
    /// Called at startup and on config reload, mirroring [`set_usage_config`].
    ///
    /// The tracker it configures lives in the sidecar now, so the value is
    /// stored here and stamped onto each [`CallContext`] rather than pushed.
    ///
    /// [`set_usage_config`]: LedgerClient::set_usage_config
    pub fn set_cache_keepalive_ceiling(&self, ceiling: std::time::Duration) {
        self.keepalive_max_secs
            .store(ceiling.as_secs(), Ordering::Relaxed);
    }

    /// The per-call labels the sidecar writes ledger rows from.
    ///
    /// `cache_ttl` and `reasoning_effort` are resolved here rather than
    /// re-derived on the far side, so a row's shape does not depend on two
    /// implementations of the same resolution agreeing.
    fn call_context<'req>(
        &'req self,
        request: &'req LlmRequest,
        call_type: CallType,
        character: &'req str,
        labels: CallLabels<'req>,
    ) -> CallContext<'req> {
        let ceiling = self.keepalive_max_secs.load(Ordering::Relaxed);
        CallContext {
            ledger: self.db_path.as_deref(),
            character,
            call_type: call_type.as_str(),
            api_key_name: request.api_key_name.as_deref(),
            thinking_enabled: labels.thinking_enabled,
            cache_ttl: labels.cache_ttl,
            reasoning_effort: labels.reasoning_effort,
            keepalive_max_secs: (ceiling > 0).then_some(ceiling),
            forensics_dir: crate::llm::cache_forensics::dir(),
            rid: request.rid.as_deref(),
            usage: labels.usage,
        }
    }

    /// The budgets to send with a call, or `None` when there are none to
    /// enforce. Cloned into the caller's frame so the borrow outlives the
    /// [`CallContext`] built from it.
    #[must_use]
    fn usage_for_call(&self) -> Option<UsageConfig> {
        let config = self.usage_config_snapshot();
        (!config.budgets.is_empty()).then_some(config)
    }

    fn usage_config_snapshot(&self) -> UsageConfig {
        match self.usage_config.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    // The budget gate used to live here, between `usage_config_snapshot` and
    // the dispatch below. It now runs in the sidecar, which is the side that
    // actually places the call — the same move the ledger row writer made in
    // shore commit fe2058b3, and for the same reason: this side was authorising
    // a call it no longer makes. The budgets travel with each request in
    // `CallContext::usage`, and a refusal comes back as a `Provider` error
    // carrying the budget's own message, so the text a user reads is unchanged.

    /// Where the sidecar should read from, or an error naming why it cannot.
    ///
    /// `None` is an in-memory ledger, which no second process can open. Tests
    /// build those; a running daemon always has a file.
    fn ledger_path(&self) -> Result<&Path, LlmError> {
        self.db_path.as_deref().ok_or_else(|| LlmError::Provider {
            message: "usage reports need a ledger on disk; this client has an in-memory one".into(),
        })
    }

    /// The `shore usage` payload for `args`, computed by the sidecar.
    ///
    /// Forwarded as opaque JSON. The daemon has no business reshaping a report
    /// it does not compute, and the CLI is what reads the fields.
    pub async fn usage_report(
        &self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, LlmError> {
        self.inner
            .ledger_query(
                "/v1/usage",
                &UsageReportRequest {
                    ledger: self.ledger_path()?,
                    args,
                    usage: &self.usage_config_snapshot(),
                },
            )
            .await
    }

    /// Newly crossed usage budget warning thresholds, marked delivered for the
    /// current window as a side effect of being reported.
    ///
    /// The dedup marker is why this is one call rather than a read here and a
    /// write there: whoever decides a threshold is "new" must be the one that
    /// records it, or two processes race for the same row.
    pub async fn newly_crossed_usage_budget_warnings(
        &self,
    ) -> Result<Vec<UsageBudgetWarningEvent>, LlmError> {
        let config = self.usage_config_snapshot();
        if config.budgets.is_empty() {
            return Ok(Vec::new());
        }
        let reply: BudgetWarnings = self
            .inner
            .ledger_query(
                "/v1/usage/warnings",
                &BudgetWarningsRequest {
                    ledger: self.ledger_path()?,
                    usage: &config,
                },
            )
            .await?;
        Ok(reply.warnings)
    }

    /// Per-model provenance for one character, backing the `model_history` tool.
    pub async fn model_history(
        &self,
        character: &str,
        since: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<ModelUsageRow>, LlmError> {
        let reply: ModelHistory = self
            .inner
            .ledger_query(
                "/v1/usage/models",
                &ModelHistoryRequest {
                    ledger: self.ledger_path()?,
                    character,
                    since,
                    until,
                },
            )
            .await?;
        Ok(reply.models)
    }

    /// Passthrough to `LlmClient::build_request`.
    ///
    /// Honors only the per-model `api_key_env`. Callers that have a
    /// `ProviderRegistry` available should prefer
    /// [`Self::build_request_with_provider_keys`] so users with
    /// `[providers.<name>].keys` (and no per-model `api_key_env`) don't
    /// hit `MissingApiKey` on non-streaming paths.
    pub fn build_request(
        model: &ResolvedModel,
        messages: Vec<crate::llm::types::WireMessage>,
        system: Vec<crate::llm::types::SystemBlock>,
        tools: Option<Vec<crate::llm::types::ToolDefinition>>,
        provider_options: Option<crate::llm::types::ProviderOptions>,
        replay: shore_common::config::app::ThinkingReplay,
    ) -> Result<LlmRequest, LlmError> {
        LlmClient::build_request(model, messages, system, tools, provider_options, replay)
    }

    /// Passthrough to `LlmClient::build_request_with_provider_keys`.
    pub fn build_request_with_provider_keys(
        model: &ResolvedModel,
        registry: &ProviderRegistry,
        messages: Vec<crate::llm::types::WireMessage>,
        system: Vec<crate::llm::types::SystemBlock>,
        tools: Option<Vec<crate::llm::types::ToolDefinition>>,
        provider_options: Option<crate::llm::types::ProviderOptions>,
        replay: shore_common::config::app::ThinkingReplay,
    ) -> Result<LlmRequest, LlmError> {
        LlmClient::build_request_with_provider_keys(
            model,
            registry,
            messages,
            system,
            tools,
            provider_options,
            replay,
        )
    }

    /// Send a non-streaming request. The sidecar records the row from the
    /// [`CallContext`] attached here.
    ///
    /// Calls `pricing.get_or_fetch()` first so the sidecar's cost lookup — which
    /// reads the same `pricing` table and never fetches on the recording path —
    /// finds an entry.
    #[instrument(skip(self, request, call_type), fields(model = %request.model, call_type = call_type.as_str()))]
    pub async fn generate(
        &self,
        request: &LlmRequest,
        call_type: CallType,
        character: &str,
        thinking_enabled: bool,
    ) -> Result<GenerateResponse, LlmError> {
        // Lazy pricing fetch (best-effort, don't block on failure)
        let provider_key = request
            .provider_key
            .as_deref()
            .unwrap_or(request.sdk.as_str());
        debug!(
            model = request.model,
            call_type = call_type.as_str(),
            character,
            "generate: sending request"
        );
        let _ignored = self
            .pricing
            .get_or_fetch(provider_key, &request.model)
            .await;

        let cache_ttl = request
            .provider_options
            .as_ref()
            .and_then(|opts| opts.cache_ttl.clone());
        let reasoning_effort = request
            .provider_options
            .as_ref()
            .and_then(crate::llm::types::ProviderOptions::resolved_reasoning_effort);
        let usage = self.usage_for_call();
        let context = self.call_context(
            request,
            call_type,
            character,
            CallLabels {
                thinking_enabled,
                cache_ttl: cache_ttl.as_deref(),
                reasoning_effort: reasoning_effort.as_deref(),
                usage: usage.as_ref(),
            },
        );

        let resp = match self.inner.generate(request, Some(context)).await {
            Ok(r) => r,
            Err(e) => {
                // A dispatch that never opened has no ledger row and no cache
                // event, so this structured record is the only durable trace.
                error!(
                    model = request.model,
                    character,
                    call_type = call_type.as_str(),
                    error = %e,
                    "LLM dispatch failed before the call opened"
                );
                return Err(e);
            }
        };
        debug!(
            model = request.model,
            call_type = call_type.as_str(),
            finish_reason = resp.finish_reason,
            "generate: response received"
        );

        Ok(resp)
    }

    /// Send a non-streaming request with the same ordered provider-key
    /// fallback policy used by chat streaming.
    ///
    /// Every call starts at the first enabled key. Credential-shaped failures
    /// such as missing keys, rejected keys, exhausted quota, or exhausted
    /// budget rotate to the next configured key. Transient/provider failures
    /// still return normally so callers can apply their own retry/backoff
    /// policy.
    pub async fn generate_with_credential_fallback(
        &self,
        request: &mut LlmRequest,
        resolved: &ResolvedModel,
        providers: &ProviderRegistry,
        call_type: CallType,
        character: &str,
        thinking_enabled: bool,
    ) -> Result<(GenerateResponse, Vec<CredentialFallbackEvent>), LlmError> {
        let candidates = resolve_key_candidates(&resolved.provider_key, providers, resolved);
        if candidates.is_empty() {
            return Err(LlmError::MissingApiKey {
                var: format!("provider '{}' has no enabled keys", resolved.provider_key),
            });
        }

        debug!(
            provider = %resolved.provider_key,
            model = %resolved.qualified_name,
            call_type = call_type.as_str(),
            candidates = candidates.len(),
            "generate_with_credential_fallback starting"
        );

        let total = candidates.len();
        let mut events = Vec::new();
        let mut last_err: Option<LlmError> = None;

        for (i, cand) in candidates.iter().enumerate() {
            let next_cand = i.checked_add(1).and_then(|index| candidates.get(index));

            let Some(api_key) = read_candidate_env(cand) else {
                last_err = Some(record_missing_key_fallback(
                    cand,
                    next_cand,
                    FallbackContext {
                        request,
                        resolved,
                        call_type,
                        character,
                    },
                    &mut events,
                ));
                if next_cand.is_some() {
                    continue;
                }
                break;
            };

            request.api_key = api_key;
            request.api_key_name = Some(cand.name.clone());

            match self
                .generate(request, call_type, character, thinking_enabled)
                .await
            {
                Ok(resp) => return Ok((resp, events)),
                Err(e) => {
                    let kind = classify_credential_failure(&resolved.provider_key, &e);
                    if !kind.should_rotate() {
                        return Err(e);
                    }

                    let status = http_status_code(&e);
                    let reason = sanitize_fallback_reason(&e);
                    events.push(record_generate_fallback_event(
                        FallbackContext {
                            request,
                            resolved,
                            call_type,
                            character,
                        },
                        cand,
                        next_cand,
                        kind,
                        status,
                        &reason,
                    ));
                    last_err = Some(e);
                    if next_cand.is_none() {
                        break;
                    }
                }
            }
        }

        Err(report_key_exhaustion(
            resolved, call_type, character, total, last_err,
        ))
    }

    /// Resolve the request's model from a loaded config, then apply
    /// non-streaming provider-key fallback. If the request is from an older
    /// persisted state and cannot be matched to the current catalog, fall back
    /// to the existing single-key `generate` behavior.
    pub async fn generate_with_config_fallback(
        &self,
        request: &mut LlmRequest,
        config: &LoadedConfig,
        call_type: CallType,
        character: &str,
        thinking_enabled: bool,
    ) -> Result<(GenerateResponse, Vec<CredentialFallbackEvent>), LlmError> {
        let resolved_model = resolve_model_for_request(request, config).cloned();
        if let Some(resolved) = resolved_model {
            self.generate_with_credential_fallback(
                request,
                &resolved,
                &config.providers,
                call_type,
                character,
                thinking_enabled,
            )
            .await
        } else {
            debug!(
                provider = request.provider_key.as_deref().unwrap_or(request.sdk.as_str()),
                model = %request.model,
                call_type = call_type.as_str(),
                character,
                "generate_with_config_fallback could not resolve model; using single-key request"
            );
            self.generate(request, call_type, character, thinking_enabled)
                .await
                .map(|resp| (resp, Vec::new()))
        }
    }

    /// Open a streaming request. The sidecar records one row per provider call
    /// from the [`CallContext`] attached here, so there is nothing to finalize:
    /// the returned reader is just a reader.
    ///
    /// Calls `pricing.get_or_fetch()` first so the sidecar's cost lookup — which
    /// reads the same `pricing` table and never fetches on the recording path —
    /// finds an entry.
    #[instrument(skip(self, request, call_type), fields(model = %request.model, call_type = call_type.as_str()))]
    pub async fn stream_raw(
        &self,
        request: &LlmRequest,
        call_type: CallType,
        character: &str,
        thinking_enabled: bool,
    ) -> Result<crate::llm::StreamReader, LlmError> {
        let provider_key = request
            .provider_key
            .as_deref()
            .unwrap_or(request.sdk.as_str());
        debug!(
            model = request.model,
            call_type = call_type.as_str(),
            character,
            "stream_raw: opening stream"
        );
        let _ignored = self
            .pricing
            .get_or_fetch(provider_key, &request.model)
            .await;

        let cache_ttl = request
            .provider_options
            .as_ref()
            .and_then(|opts| opts.cache_ttl.clone());
        let reasoning_effort = request
            .provider_options
            .as_ref()
            .and_then(crate::llm::types::ProviderOptions::resolved_reasoning_effort);
        let usage = self.usage_for_call();
        let context = self.call_context(
            request,
            call_type,
            character,
            CallLabels {
                thinking_enabled,
                cache_ttl: cache_ttl.as_deref(),
                reasoning_effort: reasoning_effort.as_deref(),
                usage: usage.as_ref(),
            },
        );

        self.inner
            .stream_raw(request, Some(context))
            .await
            .inspect_err(|e| {
                error!(
                    model = request.model,
                    character,
                    call_type = call_type.as_str(),
                    error = %e,
                    "LLM stream dispatch failed before the call opened"
                );
            })
    }

    /// Access the inner LlmClient (for embed/image_generate passthrough).
    pub fn inner(&self) -> &LlmClient {
        &self.inner
    }

    /// Access the ledger (for CLI queries).
    pub fn ledger(&self) -> &Arc<Ledger> {
        &self.ledger
    }

    /// Access the pricing engine (for CLI refresh/recalculate).
    pub fn pricing(&self) -> &Arc<PricingEngine> {
        &self.pricing
    }
}

fn resolve_model_for_request<'ctx>(
    request: &LlmRequest,
    config: &'ctx LoadedConfig,
) -> Option<&'ctx ResolvedModel> {
    let provider = request.provider_key.as_deref();
    config.models.chat.values().find(|model| {
        model.model_id == request.model
            && model.sdk == request.sdk
            && provider.is_none_or(|p| p == model.provider_key)
    })
}

/// Loop-invariant context for a credential-fallback attempt.
#[derive(Clone, Copy)]
struct FallbackContext<'ctx> {
    request: &'ctx LlmRequest,
    resolved: &'ctx ResolvedModel,
    call_type: CallType,
    character: &'ctx str,
}

fn record_generate_fallback_event(
    ctx: FallbackContext<'_>,
    from: &KeyCandidate,
    to: Option<&KeyCandidate>,
    kind: CredentialFailureKind,
    status: Option<u16>,
    reason: &str,
) -> CredentialFallbackEvent {
    let to_key = to.map(|candidate| candidate.name.clone());
    warn!(
        provider = %ctx.resolved.provider_key,
        model = %ctx.resolved.qualified_name,
        call_type = ctx.call_type.as_str(),
        character = ctx.character,
        from_key = %from.name,
        to_key = to_key.as_deref().unwrap_or("-"),
        kind = kind.as_str(),
        status = ?status,
        rid = ctx.request.rid.as_deref().unwrap_or("-"),
        reason = %reason,
        "rotating provider key after non-streaming credential failure"
    );

    CredentialFallbackEvent {
        from_key: from.name.clone(),
        to_key,
        kind: kind.as_str().to_owned(),
        status,
        reason: reason.to_owned(),
        warn_on_fallback: from.warn_on_fallback,
    }
}

/// The HTTP status carried by an `HttpStatus` error, if any. All other error
/// kinds (transport, stream, serde, refusal, …) have no status code.
fn http_status_code(err: &LlmError) -> Option<u16> {
    if let LlmError::HttpStatus { status, .. } = err {
        Some(*status)
    } else {
        None
    }
}

fn sanitize_fallback_reason(err: &LlmError) -> String {
    match err {
        LlmError::HttpStatus { status, .. } => format!("HTTP {status}"),
        LlmError::MissingApiKey { var } => format!("env {var:?} not set"),
        LlmError::Provider { message } => {
            let truncated = if message.len() > 200 {
                let end = message.floor_char_boundary(200);
                format!("{}...", message.get(..end).unwrap_or(message))
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

/// Record a missing-key fallback event and return the error to store in
/// `last_err`.
fn record_missing_key_fallback(
    cand: &KeyCandidate,
    next_cand: Option<&KeyCandidate>,
    ctx: FallbackContext<'_>,
    events: &mut Vec<CredentialFallbackEvent>,
) -> LlmError {
    let kind = CredentialFailureKind::MissingKey;
    let reason = format!("env {:?} unset or empty", cand.env);
    events.push(record_generate_fallback_event(
        ctx, cand, next_cand, kind, None, &reason,
    ));
    LlmError::MissingApiKey {
        var: cand.env.clone(),
    }
}

/// Build the error returned when all credential candidates are exhausted.
fn report_key_exhaustion(
    resolved: &ResolvedModel,
    call_type: CallType,
    character: &str,
    total: usize,
    last_err: Option<LlmError>,
) -> LlmError {
    let final_err = last_err.unwrap_or_else(|| LlmError::MissingApiKey {
        var: format!("all keys for provider '{}' failed", resolved.provider_key),
    });
    error!(
        provider = %resolved.provider_key,
        model = %resolved.qualified_name,
        call_type = call_type.as_str(),
        character,
        candidates = total,
        error = %final_err,
        "generate_with_credential_fallback exhausted all keys"
    );
    final_err
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_type_as_str() {
        assert_eq!(CallType::Message.as_str(), "message");
        assert_eq!(CallType::ToolLoop.as_str(), "tool_loop");
        assert_eq!(CallType::HeartbeatToolLoop.as_str(), "heartbeat_tool_loop");
        assert_eq!(CallType::Keepalive.as_str(), "keepalive");
        assert_eq!(CallType::Heartbeat.as_str(), "heartbeat");
        assert_eq!(CallType::Compaction.as_str(), "compaction");
        assert_eq!(CallType::Dreaming.as_str(), "dreaming");
        assert_eq!(CallType::MemoryQuery.as_str(), "memory_query");
    }
}
