//! LedgerClient: compiler-enforced wrapper around LlmClient.

use crate::ledger::budget::{
    enforce_budget_for_call, newly_crossed_budget_warnings, BudgetCallContext,
    UsageBudgetWarningEvent,
};
use crate::ledger::cache_tracker::{Anomaly, CacheState, CacheTracker, CacheTrackers, Observation};
use crate::ledger::pricing::PricingEngine;
use crate::ledger::store::{CallRow, Ledger};
use crate::ledger::stream::LedgerStream;
use crate::llm::credentials::{
    classify_credential_failure, read_candidate_env, resolve_key_candidates, CredentialFailureKind,
    KeyCandidate,
};
use crate::llm::types::{GenerateResponse, LlmRequest, Timing, Usage};
use crate::llm::{LlmClient, LlmError};
use chrono::Utc;
use shore_common::config::app::UsageConfig;
use shore_common::config::models::ResolvedModel;
use shore_common::config::providers::ProviderRegistry;
use shore_common::config::LoadedConfig;
use std::path::Path;
use std::sync::{Arc, RwLock};
use tracing::{debug, error, info, instrument, warn};

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

    fn affects_cache_tracker(self) -> bool {
        !matches!(self, CallType::Dreaming)
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

// ── record_call ─────────────────────────────────────────────────────────────

pub(crate) struct RecordCall<'ctx> {
    pub(crate) provider: &'ctx str,
    pub(crate) api_key_name: Option<String>,
    pub(crate) model: &'ctx str,
    pub(crate) call_type: CallType,
    pub(crate) character: &'ctx str,
    pub(crate) usage: &'ctx Usage,
    pub(crate) timing: &'ctx Timing,
    pub(crate) finish_reason: &'ctx str,
    pub(crate) thinking_enabled: bool,
    pub(crate) cache_ttl: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
}

/// The effort this call actually ran at, as recorded on the ledger row.
///
/// Effort is part of the Anthropic prompt-cache key — changing it invalidates
/// every message-level breakpoint (tools and system may survive) — so the
/// ledger keeps it to distinguish a configuration change from a cache bug.
///
/// `reasoning_effort = "off"` never reaches `provider_options` under that name:
/// `build_request` translates it to `thinking_enabled: false` so the OpenRouter
/// adapter can send `reasoning: {effort: "none"}` while other adapters just omit
/// reasoning. Reconstruct it here, because "off" is a distinct cache-relevant
/// setting and must not be confused with a provider that has no effort surface
/// at all (`None`).
fn resolved_reasoning_effort(provider_options: Option<&serde_json::Value>) -> Option<String> {
    let opts = provider_options?;
    if let Some(effort) = opts.get("reasoning_effort").and_then(|v| v.as_str()) {
        return Some(effort.to_owned());
    }
    match opts
        .get("thinking_enabled")
        .and_then(serde_json::Value::as_bool)
    {
        Some(false) => Some("off".to_owned()),
        _ => None,
    }
}

/// Run the warm/cold cache state machine for calls that report cache metrics,
/// emitting a forensics anomaly notification on divergence. Returns the
/// `(cache_state, cache_anomaly)` strings to persist on the call row.
fn track_cache_state(
    cache_trackers: &CacheTrackers,
    record: &RecordCall<'_>,
    ts: &str,
) -> (Option<String>, Option<String>) {
    // A `cancelled` row is a placeholder for a call whose stream future was
    // dropped before any terminal frame arrived (see `LedgerStream::drop`). It
    // carries no cache signal — usage is all zero — so feeding it to the tracker
    // would inject a bogus cold/zero observation, perturbing the warm/cold
    // baseline and firing false anomalies. A genuine mid-stream `error` is
    // different: it can still carry a real cache write (StreamErrored), so it is
    // tracked normally.
    if record.finish_reason == "cancelled" {
        return (None, None);
    }
    if !record.call_type.affects_cache_tracker() {
        return (None, None);
    }

    // The warm/cold *state machine* encodes Anthropic-specific invariants (1h
    // prompt-cache TTL, keepalive cadence, monotonic prefix growth). Other
    // providers report cache metrics with different semantics (automatic prefix
    // caching, variable hit rates) and generally need no babysitting, so running
    // them through these invariants only produces non-actionable false
    // anomalies. For non-Anthropic calls we still record a plain warm/cold
    // `cache_state` for visibility — derived directly from this row's read —
    // but never emit an anomaly. Native Anthropic and OpenRouter-routed
    // Anthropic (`anthropic/...` model id) get the full machine.
    if !crate::ledger::pricing::is_anthropic_pricing(record.provider, record.model) {
        feed_foreign_call_to_tracker(cache_trackers, record, ts);

        let has_metrics =
            record.usage.cache_read_tokens > 0 || record.usage.cache_creation_tokens > 0;
        if !has_metrics {
            return (None, None);
        }
        let state = if record.usage.cache_read_tokens > 0 {
            "warm"
        } else {
            "cold"
        };
        return (Some(state.to_owned()), None);
    }

    let obs = Observation {
        ts: ts.to_owned(),
        model: record.model.to_owned(),
        thinking_enabled: record.thinking_enabled,
        cache_read_tokens: record.usage.cache_read_tokens,
        cache_write_tokens: record.usage.cache_creation_tokens,
        call_type: record.call_type.as_str().to_owned(),
    };

    let max_idle_secs = cache_trackers.max_idle_secs();
    let mut trackers = cache_trackers.lock();
    let tracker = trackers
        .entry(record.character.to_owned())
        .or_insert_with(|| CacheTracker::with_max_idle_secs(max_idle_secs));
    let result = tracker.observe(&obs);

    let state_str = match result.state {
        CacheState::Cold => "cold",
        CacheState::Warm => "warm",
    };
    let anomaly_str = result.anomaly.map(|a| match a {
        Anomaly::UnexpectedWrite => "unexpected_write",
        Anomaly::KeepaliveMiss => "keepalive_miss",
        Anomaly::ColdKeepalive => "cold_keepalive",
    });

    if let Some(anomaly) = &anomaly_str {
        error!(
            provider = record.provider,
            model = record.model,
            character = record.character,
            call_type = record.call_type.as_str(),
            cache_state = state_str,
            anomaly,
            cache_read_tokens = record.usage.cache_read_tokens,
            cache_creation_tokens = record.usage.cache_creation_tokens,
            "Cache anomaly detected"
        );
        crate::llm::cache_forensics::notify_anomaly(
            record.character,
            anomaly,
            record.call_type.as_str(),
            record.usage.cache_read_tokens,
            record.usage.cache_creation_tokens,
        );
    }

    (Some(state_str.to_owned()), anomaly_str.map(String::from))
}

/// Feed the two non-Anthropic call shapes the Anthropic tracker still cares
/// about, without ever creating an entry for a character that has no
/// Anthropic history:
/// - Compaction rewrites the conversation the Anthropic prefix is built from
///   no matter which model ran it (the common setup: a cheap background model
///   compacting under an Anthropic chat). The tracker must observe the reset,
///   or the next foreground call is judged against the stale pre-compaction
///   baseline and misflagged as an `unexpected_write`.
/// - Foreground activity keeps the `KeepaliveMiss` window anchor honest even
///   when the user chats on another model.
fn feed_foreign_call_to_tracker(cache_trackers: &CacheTrackers, record: &RecordCall<'_>, ts: &str) {
    let mut trackers = cache_trackers.lock();
    let Some(tracker) = trackers.get_mut(record.character) else {
        return;
    };
    match record.call_type {
        CallType::Compaction => {
            _ = tracker.observe(&Observation {
                ts: ts.to_owned(),
                model: record.model.to_owned(),
                thinking_enabled: record.thinking_enabled,
                cache_read_tokens: record.usage.cache_read_tokens,
                cache_write_tokens: record.usage.cache_creation_tokens,
                call_type: record.call_type.as_str().to_owned(),
            });
        }
        CallType::Message | CallType::ToolLoop => tracker.note_activity(ts),
        CallType::HeartbeatToolLoop
        | CallType::Keepalive
        | CallType::Heartbeat
        | CallType::Dreaming
        | CallType::MemoryQuery
        | CallType::Subagent => {}
    }
}

/// Build a [`CallRow`] from a record, computing cost and assembling all fields.
fn build_call_row(
    pricing: &PricingEngine,
    record: &RecordCall<'_>,
    ts: String,
    cache_state: Option<String>,
    cache_anomaly: Option<String>,
) -> CallRow {
    // Subscription providers (e.g. opencode-go) bill a flat plan, not per token:
    // record the usage for observability but zero the cost so it never accrues
    // against usage budgets or spend reports. See `is_subscription_provider`.
    let subscription = crate::ledger::is_subscription_provider(record.provider);

    // Cost calculation (sync — cached pricing only, no fetch). Skipped entirely
    // for subscription calls — metered pricing doesn't apply.
    let priced_cost = if subscription {
        None
    } else {
        pricing
            .calculate_cost(crate::ledger::pricing::CostRequest {
                provider: record.provider,
                model: record.model,
                input_tokens: record.usage.input_tokens,
                output_tokens: record.usage.output_tokens,
                cache_read_tokens: record.usage.cache_read_tokens,
                cache_write_tokens: record.usage.cache_creation_tokens,
                cache_ttl: record.cache_ttl.as_deref(),
            })
            .ok()
            .flatten()
    };
    let total_cost_override = if subscription {
        None
    } else {
        record.usage.total_cost_usd
    };
    let cost_source = if subscription {
        "subscription"
    } else if total_cost_override.is_some() {
        "provider_reported"
    } else {
        "pricing_catalog"
    };
    // Per-component costs are recorded only when we priced the call ourselves; a
    // provider-reported total (and any subscription call) leaves the breakdown null.
    let breakdown = total_cost_override
        .is_none()
        .then_some(())
        .and(priced_cost.as_ref());

    CallRow {
        ts,
        character: record.character.to_owned(),
        provider: record.provider.to_owned(),
        api_key_name: record.api_key_name.clone(),
        model: record.model.to_owned(),
        call_type: record.call_type.as_str().to_owned(),
        input_tokens: record.usage.input_tokens,
        output_tokens: record.usage.output_tokens,
        cache_read_tokens: record.usage.cache_read_tokens,
        cache_write_tokens: record.usage.cache_creation_tokens,
        cache_ttl: record.cache_ttl.clone(),
        reasoning_effort: record.reasoning_effort.clone(),
        total_ms: record.timing.total_ms,
        ttft_ms: record.timing.time_to_first_token_ms,
        finish_reason: record.finish_reason.to_owned(),
        thinking_enabled: record.thinking_enabled,
        cache_state,
        cache_anomaly,
        input_cost: breakdown.map(|c| c.input),
        output_cost: breakdown.map(|c| c.output),
        cache_read_cost: breakdown.map(|c| c.cache_read),
        cache_write_cost: breakdown.map(|c| c.cache_write),
        cost_source: Some(cost_source.to_owned()),
        // Subscription calls record $0; otherwise prefer the provider-reported
        // total, then our catalog estimate, else null (unpriced).
        total_cost: total_cost_override
            .or_else(|| priced_cost.as_ref().map(|c| c.total))
            .or(subscription.then_some(0.0)),
    }
}

#[instrument(skip(ledger, pricing, cache_trackers, record), fields(call_type = record.call_type.as_str()))]
#[expect(
    clippy::needless_pass_by_value,
    reason = "record is logically consumed by this sink; callers pass ownership"
)]
pub(crate) fn record_call(
    ledger: &Ledger,
    pricing: &PricingEngine,
    cache_trackers: &CacheTrackers,
    record: RecordCall<'_>,
) {
    let ts = Utc::now().to_rfc3339();
    let has_cache_metrics =
        record.usage.cache_read_tokens > 0 || record.usage.cache_creation_tokens > 0;
    let (cache_state, cache_anomaly) = track_cache_state(cache_trackers, &record, &ts);

    let row = build_call_row(pricing, &record, ts, cache_state, cache_anomaly);

    let RecordCall {
        provider,
        model,
        character,
        call_type,
        usage,
        ..
    } = record;

    // Cache forensics: log response-side data for ALL cache events.
    // Uses call_id=0 since we don't have the request-side correlation ID
    // here — but character + call_type + timestamp provide enough context.
    if has_cache_metrics && crate::llm::cache_forensics::is_enabled() {
        crate::llm::cache_forensics::log_response(crate::llm::cache_forensics::ResponseLog {
            call_id: 0, // no request-side correlation for streaming path
            model,
            character,
            call_type: call_type.as_str(),
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
        });
    }

    info!(
        provider,
        model,
        character,
        call_type = call_type.as_str(),
        input_tokens = usage.input_tokens,
        output_tokens = usage.output_tokens,
        total_cost = row.total_cost,
        "LLM call recorded"
    );
    if let Err(e) = ledger.insert(&row) {
        error!(error = %e, "Failed to insert call row into ledger");
    }
}

// ── LedgerClient ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LedgerClient {
    inner: LlmClient,
    ledger: Arc<Ledger>,
    cache_trackers: Arc<CacheTrackers>,
    pricing: Arc<PricingEngine>,
    usage_config: Arc<RwLock<UsageConfig>>,
}

impl LedgerClient {
    /// Create a new LedgerClient backed by a file database at `db_path`.
    pub fn new(client: LlmClient, db_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let ledger = Arc::new(Ledger::open(db_path)?);
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        Ok(Self {
            inner: client,
            ledger,
            cache_trackers: Arc::new(CacheTrackers::default()),
            pricing,
            usage_config: Arc::new(RwLock::new(UsageConfig::default())),
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
            cache_trackers: Arc::new(CacheTrackers::default()),
            pricing,
            usage_config: Arc::new(RwLock::new(UsageConfig::default())),
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

    /// Push the keepalive idle ceiling (`[behavior.autonomy].cache_keepalive_max`)
    /// into the cache anomaly trackers, so `KeepaliveMiss` is judged against
    /// the ceiling the keepalive subsystem actually enforces rather than the
    /// built-in default. Called at startup and on config reload, mirroring
    /// [`set_usage_config`].
    ///
    /// [`set_usage_config`]: LedgerClient::set_usage_config
    pub fn set_cache_keepalive_ceiling(&self, ceiling: std::time::Duration) {
        self.cache_trackers.set_max_idle_secs(ceiling.as_secs());
    }

    fn usage_config_snapshot(&self) -> UsageConfig {
        match self.usage_config.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn enforce_usage_budget(
        &self,
        provider_key: &str,
        api_key_name: Option<&str>,
        model: &str,
        call_type: CallType,
        character: &str,
    ) -> Result<(), LlmError> {
        let config = self.usage_config_snapshot();
        if config.budgets.is_empty() {
            return Ok(());
        }

        match enforce_budget_for_call(
            &self.ledger,
            &config,
            BudgetCallContext {
                provider: provider_key,
                api_key_name,
                model,
                call_type,
                character,
            },
            Utc::now(),
        ) {
            Ok(()) => Ok(()),
            Err(block) => {
                warn!(
                    provider = provider_key,
                    model,
                    character,
                    call_type = call_type.as_str(),
                    budget = %block.budget_name,
                    current_cost = block.current_cost,
                    cost_limit = block.cost_limit,
                    action = ?block.action,
                    "LLM call blocked by usage budget"
                );
                Err(LlmError::Provider {
                    message: block.to_string(),
                })
            }
        }
    }

    /// Return newly crossed usage budget warning thresholds and mark them
    /// delivered for the current budget window.
    pub fn newly_crossed_usage_budget_warnings(
        &self,
    ) -> Result<Vec<UsageBudgetWarningEvent>, rusqlite::Error> {
        let config = self.usage_config_snapshot();
        if config.budgets.is_empty() {
            return Ok(Vec::new());
        }
        newly_crossed_budget_warnings(&self.ledger, &config, Utc::now())
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
        messages: Vec<serde_json::Value>,
        system: Option<serde_json::Value>,
        tools: Option<Vec<serde_json::Value>>,
        provider_options: Option<serde_json::Value>,
    ) -> Result<LlmRequest, LlmError> {
        LlmClient::build_request(model, messages, system, tools, provider_options)
    }

    /// Passthrough to `LlmClient::build_request_with_provider_keys`.
    pub fn build_request_with_provider_keys(
        model: &ResolvedModel,
        registry: &ProviderRegistry,
        messages: Vec<serde_json::Value>,
        system: Option<serde_json::Value>,
        tools: Option<Vec<serde_json::Value>>,
        provider_options: Option<serde_json::Value>,
    ) -> Result<LlmRequest, LlmError> {
        LlmClient::build_request_with_provider_keys(
            model,
            registry,
            messages,
            system,
            tools,
            provider_options,
        )
    }

    /// Send a non-streaming request, then record the call to the ledger.
    ///
    /// Calls `pricing.get_or_fetch()` first for lazy pricing resolution.
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
        self.enforce_usage_budget(
            provider_key,
            request.api_key_name.as_deref(),
            &request.model,
            call_type,
            character,
        )?;
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

        let resp = match self.inner.generate(request, Some(call_type.as_str())).await {
            Ok(r) => r,
            Err(e) => {
                // Log the failure to the forensic log so keepalive and other
                // errors are diagnosable from disk, not just journald.
                crate::llm::cache_forensics::log_error(
                    0,
                    &request.model,
                    character,
                    call_type.as_str(),
                    &e.to_string(),
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

        let cache_ttl = request
            .provider_options
            .as_ref()
            .and_then(|opts| opts.get("cache_ttl"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let reasoning_effort = resolved_reasoning_effort(request.provider_options.as_ref());

        record_call(
            &self.ledger,
            &self.pricing,
            &self.cache_trackers,
            RecordCall {
                provider: provider_key,
                api_key_name: request.api_key_name.clone(),
                model: &request.model,
                call_type,
                character,
                usage: &resp.usage,
                timing: &resp.timing,
                finish_reason: &resp.finish_reason,
                thinking_enabled,
                cache_ttl,
                reasoning_effort,
            },
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

    /// Send a streaming request, returning a LedgerStream that must be finalized.
    ///
    /// Calls `pricing.get_or_fetch()` first for lazy pricing resolution.
    /// The caller MUST call `finalize()` on the returned stream after consumption,
    /// otherwise the API call will not be recorded (and a tracing::error is emitted on drop).
    #[instrument(skip(self, request, call_type), fields(model = %request.model, call_type = call_type.as_str()))]
    pub async fn stream_raw(
        &self,
        request: &LlmRequest,
        call_type: CallType,
        character: &str,
        thinking_enabled: bool,
    ) -> Result<LedgerStream, LlmError> {
        let provider_key = request
            .provider_key
            .as_deref()
            .unwrap_or(request.sdk.as_str());
        self.enforce_usage_budget(
            provider_key,
            request.api_key_name.as_deref(),
            &request.model,
            call_type,
            character,
        )?;
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

        let reader = match self
            .inner
            .stream_raw(request, Some(call_type.as_str()))
            .await
        {
            Ok(r) => r,
            Err(e) => {
                crate::llm::cache_forensics::log_error(
                    0,
                    &request.model,
                    character,
                    call_type.as_str(),
                    &e.to_string(),
                );
                return Err(e);
            }
        };

        let cache_ttl = request
            .provider_options
            .as_ref()
            .and_then(|opts| opts.get("cache_ttl"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let reasoning_effort = resolved_reasoning_effort(request.provider_options.as_ref());

        Ok(LedgerStream::new(
            reader,
            crate::ledger::stream::CallMeta {
                provider: provider_key.to_owned(),
                api_key_name: request.api_key_name.clone(),
                model: request.model.clone(),
                call_type,
                character: character.to_owned(),
                thinking_enabled,
                cache_ttl,
                reasoning_effort,
            },
            Arc::clone(&self.ledger),
            Arc::clone(&self.pricing),
            Arc::clone(&self.cache_trackers),
        ))
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

    /// Reconstruct cache tracker state from the last Anthropic call in the DB.
    pub fn reconstruct_cache_state(&self, character: &str, ttl_secs: u64) {
        match self.ledger.last_anthropic_call(character) {
            Ok(Some(row)) => {
                let mut tracker = CacheTracker::reconstruct(
                    &row.ts,
                    &row.model,
                    row.thinking_enabled,
                    row.cache_read_tokens,
                    ttl_secs,
                );
                tracker.set_max_idle_secs(self.cache_trackers.max_idle_secs());
                let _ignored = self
                    .cache_trackers
                    .lock()
                    .insert(character.to_owned(), tracker);
            }
            Ok(None) => {} // No prior call — start cold
            Err(e) => {
                error!(
                    error = %e,
                    character,
                    "Failed to read last Anthropic call for cache reconstruction"
                );
            }
        }
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
    use crate::ledger::pricing::PricingEngine;
    use crate::ledger::store::Ledger;
    use std::sync::Arc;

    type TestParts = (Arc<Ledger>, Arc<PricingEngine>, Arc<CacheTrackers>);

    fn test_parts() -> TestParts {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());
        (ledger, pricing, trackers)
    }

    fn first_item<T>(items: &[T]) -> &T {
        items.first().expect("expected at least one item")
    }

    #[test]
    fn resolved_effort_reads_the_wire_options() {
        use serde_json::json;
        let effort = |v: serde_json::Value| resolved_reasoning_effort(Some(&v));

        assert_eq!(
            effort(json!({"reasoning_effort": "high"})).as_deref(),
            Some("high")
        );
        // `off` is rewritten by `build_request` into `thinking_enabled: false`
        // with no `reasoning_effort` key — reconstruct it rather than record a
        // null, since "explicitly off" and "provider has no effort surface"
        // read a cache miss very differently.
        assert_eq!(
            effort(json!({"thinking_enabled": false})).as_deref(),
            Some("off")
        );
        // Thinking on with no named effort is the provider default, not "off".
        assert_eq!(effort(json!({"thinking_enabled": true})), None);
        assert_eq!(effort(json!({"cache_ttl": "1h"})), None);
        assert_eq!(resolved_reasoning_effort(None), None);
    }

    #[test]
    fn record_inserts_row() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "anthropic",
                api_key_name: Some("default".into()),
                model: "claude-opus-4-6",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let rows = ledger.recent(1).unwrap();
        assert_eq!(rows.len(), 1);
        let row = first_item(&rows);
        assert_eq!(row.character, "aria");
        assert_eq!(row.call_type, "message");
    }

    #[test]
    fn record_uses_provider_total_cost_override() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "openrouter",
                api_key_name: None,
                model: "claude-sonnet-4-5",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    total_cost_usd: Some(0.0042),
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let rows = ledger.recent(1).unwrap();
        let row = first_item(&rows);
        assert_eq!(row.total_cost, Some(0.0042));
        assert_eq!(row.cost_source.as_deref(), Some("provider_reported"));
        assert!(row.input_cost.is_none());
        assert!(row.output_cost.is_none());
        assert!(row.cache_read_cost.is_none());
        assert!(row.cache_write_cost.is_none());
    }

    #[test]
    fn subscription_provider_records_zero_cost() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "opencode-go",
                api_key_name: Some("default".into()),
                model: "kimi-k2.6",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    // Even a provider-reported total is ignored under a flat plan.
                    total_cost_usd: Some(0.0042),
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let rows = ledger.recent(1).unwrap();
        let row = first_item(&rows);
        // Usage is still recorded for observability...
        assert_eq!(row.input_tokens, 100);
        assert_eq!(row.output_tokens, 50);
        // ...but the call accrues $0 and is tagged as subscription.
        assert_eq!(row.total_cost, Some(0.0));
        assert_eq!(row.cost_source.as_deref(), Some("subscription"));
        assert!(row.input_cost.is_none());
        assert!(row.output_cost.is_none());
    }

    #[test]
    fn record_updates_cache_tracker() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "anthropic",
                api_key_name: Some("default".into()),
                model: "claude-opus-4-6",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 500,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let map = trackers.lock();
        let tracker = map.get("aria").unwrap();
        assert_eq!(tracker.state(), CacheState::Warm);
    }

    #[test]
    fn dreaming_call_does_not_touch_cache_tracker() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "anthropic",
                api_key_name: Some("default".into()),
                model: "claude-opus-4-6",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 400,
                    cache_creation_tokens: 0,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "anthropic",
                api_key_name: Some("default".into()),
                model: "claude-opus-4-6",
                call_type: CallType::Dreaming,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );

        let map = trackers.lock();
        let tracker = map.get("aria").unwrap();
        assert_eq!(tracker.state(), CacheState::Warm);
        assert_eq!(tracker.last_cache_read(), 400);
        let rows = ledger.recent(2).unwrap();
        let row = first_item(&rows);
        assert_eq!(row.call_type, "dreaming");
        assert!(row.cache_state.is_none());
        assert!(row.cache_anomaly.is_none());
    }

    #[test]
    fn non_anthropic_skips_cache_tracker() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "openai",
                api_key_name: Some("default".into()),
                model: "gpt-4o",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "stop",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let rows = ledger.recent(1).unwrap();
        let row = first_item(&rows);
        assert!(row.cache_state.is_none());
        assert!(!trackers.lock().contains_key("aria"));
    }

    #[test]
    fn non_anthropic_records_cache_state_without_anomaly() {
        // Non-Anthropic providers get plain warm/cold visibility derived from
        // the row, but never run the Anthropic-specific anomaly machine and
        // never create a tracker entry (no false `unexpected_write`).
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "deepseek",
                api_key_name: Some("default".into()),
                model: "deepseek-v4-pro",
                call_type: CallType::Subagent,
                character: "poppy",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 512,
                    cache_creation_tokens: 0,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "stop",
                thinking_enabled: false,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let rows = ledger.recent(1).unwrap();
        let row = first_item(&rows);
        assert_eq!(row.cache_state.as_deref(), Some("warm"));
        assert!(row.cache_anomaly.is_none());
        assert!(!trackers.lock().contains_key("poppy"));
    }

    #[test]
    fn foreign_model_compaction_resets_anthropic_tracker() {
        // The daily-driver setup: an Anthropic chat compacted by a cheap
        // non-Anthropic background model. The compaction rewrites the
        // conversation the Anthropic prefix is built from, so the tracker must
        // observe the reset — otherwise the first post-compaction message
        // (with its legitimately smaller read) is judged against the stale
        // baseline and misflagged as an `unexpected_write` (seen live).
        let (ledger, pricing, trackers) = test_parts();
        let record = |provider, model, call_type, read, write| {
            record_call(
                &ledger,
                &pricing,
                &trackers,
                RecordCall {
                    provider,
                    api_key_name: Some("default".into()),
                    model,
                    call_type,
                    character: "poppy",
                    usage: &Usage {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_read_tokens: read,
                        cache_creation_tokens: write,
                        ..Default::default()
                    },
                    timing: &Timing {
                        total_ms: 500,
                        time_to_first_token_ms: 0,
                    },
                    finish_reason: "end_turn",
                    thinking_enabled: true,
                    cache_ttl: None,
                    reasoning_effort: None,
                },
            );
        };

        // Warm an Anthropic baseline at 50k.
        record("anthropic", "claude-opus-4-6", CallType::Message, 50_000, 0);
        // Compaction runs on a non-Anthropic model.
        record("zai", "glm-5.2", CallType::Compaction, 0, 0);
        // First post-compaction Anthropic message: much smaller read plus a
        // real write of the new tail — a fresh warm-up, not an anomaly.
        record(
            "anthropic",
            "claude-opus-4-6",
            CallType::Message,
            8_382,
            11_381,
        );

        let rows = ledger.recent(1).unwrap();
        let row = first_item(&rows);
        assert_eq!(row.cache_state.as_deref(), Some("warm"));
        assert!(
            row.cache_anomaly.is_none(),
            "post-compaction warm-up must not be flagged against the stale baseline"
        );
        let map = trackers.lock();
        assert_eq!(map.get("poppy").unwrap().state(), CacheState::Warm);
    }

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

    #[test]
    fn record_maps_cache_creation_to_cache_write() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "anthropic",
                api_key_name: Some("default".into()),
                model: "claude-opus-4-6",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 80,
                    cache_creation_tokens: 200,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
        );
        let rows = ledger.recent(1).unwrap();
        let row = first_item(&rows);
        assert_eq!(row.cache_write_tokens, 200);
        assert_eq!(row.cache_read_tokens, 80);
    }

    #[test]
    fn record_stores_cache_ttl() {
        let (ledger, pricing, trackers) = test_parts();
        record_call(
            &ledger,
            &pricing,
            &trackers,
            RecordCall {
                provider: "anthropic",
                api_key_name: Some("default".into()),
                model: "claude-opus-4-6",
                call_type: CallType::Message,
                character: "aria",
                usage: &Usage {
                    input_tokens: 100,
                    output_tokens: 50,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    ..Default::default()
                },
                timing: &Timing {
                    total_ms: 1500,
                    time_to_first_token_ms: 0,
                },
                finish_reason: "end_turn",
                thinking_enabled: false,
                reasoning_effort: None,
                cache_ttl: Some("5m".to_owned()),
            },
        );
        let rows = ledger.recent(1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(first_item(&rows).cache_ttl, Some("5m".to_owned()));
    }
}
