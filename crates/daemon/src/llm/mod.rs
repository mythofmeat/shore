pub mod cache_forensics;
mod convert;
pub mod credentials;
pub mod debug_log;
pub mod discovery;
pub mod embed;
pub mod retry;
pub mod sanitize;
pub(crate) mod sidecar;
pub mod stream;
pub mod types;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::{AsyncRead, BufReader};
use tracing::{debug, error, warn};

use crate::call_store::CallStore;
use shore_common::config::app::ThinkingReplay;
use shore_common::config::models::ResolvedModel;
use types::{CallContext, ImageGenerateParams, ImageGenerateResponse, LlmRequest, WireMessage};

/// The reader returned by `LlmClient::stream_raw`.
///
/// Trait-object so the stream can be transparently teed for debug logging
/// without leaking that wiring into the type signatures of every consumer.
pub type StreamReader = BufReader<Box<dyn AsyncRead + Send + Unpin>>;

/// Errors from the LLM client.
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("HTTP request failed: {0}")]
    Request(#[from] reqwest::Error),

    #[error("HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },

    #[error("failed to serialize request: {0}")]
    Serialize(#[source] serde_json::Error),

    #[error("failed to parse response: {0}")]
    Deserialize(#[source] serde_json::Error),

    #[error("stream ended without done event")]
    IncompleteStream,

    /// The provider stream failed mid-flight but the sidecar emitted the usage
    /// it had already accumulated (e.g. Anthropic's `message_start` reports the
    /// cache write before any output). Carries that partial usage so the ledger
    /// records the tokens the provider already billed instead of zeros.
    #[error("stream errored after partial usage: {message}")]
    StreamErrored {
        message: String,
        usage: Box<types::Usage>,
        timing: types::Timing,
    },

    #[error("API key environment variable {var} is not set")]
    MissingApiKey { var: String },

    #[error("provider error: {message}")]
    Provider { message: String },

    #[error("model refusal detected")]
    Refusal,
}

/// Truncate a string for log preview, respecting UTF-8 char boundaries.
pub(crate) fn body_preview(body: &str, max: usize) -> &str {
    if body.len() > max {
        body.get(..body.floor_char_boundary(max)).unwrap_or(body)
    } else {
        body
    }
}

/// Check an HTTP response status, returning the response on success or
/// an `HttpStatus` error with the body text on failure.
pub(crate) async fn check_response(
    response: reqwest::Response,
) -> Result<reqwest::Response, LlmError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let status_code = status.as_u16();
    let body = response.text().await.unwrap_or_default();
    error!(
        status = status_code,
        body_len = body.len(),
        body_preview = %body_preview(&body, 200),
        "LLM API returned error status"
    );
    Err(LlmError::HttpStatus {
        status: status_code,
        body,
    })
}

/// HTTP client that calls LLM provider APIs through the sidecar.
///
/// Uses reqwest for connection pooling and TLS session reuse.
/// Each request is fully self-contained with provider, model, and API key.
#[derive(Debug, Clone)]
pub struct LlmClient {
    http_client: reqwest::Client,
    /// Unix socket for the Bun LLM sidecar. `None` makes chat/image calls
    /// return a clear configuration error; embeddings still use HTTP directly.
    sidecar_socket: Option<PathBuf>,
    /// If set, every call's request/response is recorded to the observability
    /// store as a compressed row. See the `debug_log` module.
    call_store: Option<Arc<CallStore>>,
    /// In-flight loops the sidecar may call back into to run tools. `None`
    /// means no loop can be handed over, so every request keeps the daemon's
    /// own tool loop. See `crate::tool_rpc`.
    tool_rpc: Option<Arc<crate::tool_rpc::ToolRpcRegistry>>,
}

impl LlmClient {
    /// Create a new LLM client with a shared reqwest connection pool.
    ///
    /// Bounds connect (DNS/TCP/TLS) at 30s but intentionally sets no
    /// whole-request deadline — non-streaming generates apply their own
    /// per-call `timeout()` on the `RequestBuilder` (see `sidecar::NON_STREAMING_TIMEOUT`).
    /// A global request timeout here would fire mid-body-read for any
    /// long generation and surface as the misleading "error decoding
    /// response body".
    ///
    /// # Errors
    ///
    /// Returns the underlying `reqwest::Error` if the HTTP client cannot be
    /// built — in practice only when the platform TLS backend or DNS
    /// resolver fails to initialize, a process-level invariant. This is the
    /// same failure class that makes `reqwest::Client::new()` panic, so we
    /// surface it as a `Result` rather than keeping a panic fallback.
    pub fn try_new() -> Result<Self, reqwest::Error> {
        let http_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()?;

        Ok(Self {
            http_client,
            sidecar_socket: None,
            tool_rpc: None,
            call_store: None,
        })
    }

    /// Record every call's request/response into the observability store.
    pub fn set_call_store(&mut self, store: Arc<CallStore>) {
        self.call_store = Some(store);
    }

    /// The observability store, if capture is enabled. Lets higher layers
    /// (e.g. the daemon's heartbeat/dreaming loops) record curated transcript
    /// rows into the same store without separate handle threading.
    pub fn call_store(&self) -> Option<&Arc<CallStore>> {
        self.call_store.as_ref()
    }

    /// Route stream/generate/image calls through a sidecar listening on `path`.
    pub fn set_sidecar_socket(&mut self, path: PathBuf) {
        self.sidecar_socket = Some(path);
    }

    /// Clear the sidecar socket. Chat/image calls then return a configuration
    /// error because the legacy Rust provider wire has been removed.
    pub fn clear_sidecar_socket(&mut self) {
        self.sidecar_socket = None;
    }

    /// Current sidecar socket path, if sidecar routing is enabled.
    pub fn sidecar_socket(&self) -> Option<&Path> {
        self.sidecar_socket.as_deref()
    }

    /// Announce that tool calls can be served back for sidecar-driven loops.
    pub fn set_tool_rpc(&mut self, registry: Arc<crate::tool_rpc::ToolRpcRegistry>) {
        self.tool_rpc = Some(registry);
    }

    /// The registry a loop registers itself with before handing control over,
    /// and the socket the sidecar reaches it on. `None` until the tool socket
    /// is serving, which is what keeps a daemon without one on its own loop.
    pub fn tool_rpc(&self) -> Option<(&Arc<crate::tool_rpc::ToolRpcRegistry>, PathBuf)> {
        let registry = self.tool_rpc.as_ref()?;
        let socket = crate::tool_rpc::socket_path_for(self.sidecar_socket()?);
        Some((registry, socket))
    }

    /// Borrow the shared `reqwest::Client` so other modules (e.g.
    /// provider model discovery) can reuse the connection pool instead
    /// of constructing their own client per call.
    pub fn http_client(&self) -> &reqwest::Client {
        &self.http_client
    }

    /// Build an `LlmRequest` from a resolved model profile and conversation state.
    ///
    /// Resolves the API key from the environment variable specified in the model
    /// profile. Returns `LlmError::MissingApiKey` if the variable is not set.
    ///
    /// For the multi-key fallback path (Phase 4), use
    /// [`Self::build_request_with_resolved_key`] instead — that variant takes
    /// a pre-resolved API key string so the dispatcher can rotate keys on
    /// credential failures without rebuilding the rest of the request.
    ///
    /// **Non-streaming callers with a `ProviderRegistry` available should
    /// prefer [`Self::build_request_with_provider_keys`]**, which honors
    /// `[providers.<name>].keys` instead of only the per-model
    /// `api_key_env`. This entry point remains for callers that pre-date
    /// the registry or operate without one (e.g. examples and unit tests).
    pub fn build_request(
        model: &ResolvedModel,
        messages: Vec<WireMessage>,
        system: Vec<types::SystemBlock>,
        tools: Option<Vec<types::ToolDefinition>>,
        provider_options: Option<types::ProviderOptions>,
        replay: ThinkingReplay,
    ) -> Result<LlmRequest, LlmError> {
        let api_key_env = model
            .api_key_env
            .as_deref()
            .unwrap_or(default_api_key_env(&model.provider_key));

        let api_key = std::env::var(api_key_env).map_err(|_| LlmError::MissingApiKey {
            var: api_key_env.to_owned(),
        })?;

        let mut req = Self::build_request_with_resolved_key(
            model,
            api_key,
            messages,
            system,
            tools,
            provider_options,
            replay,
        );
        req.api_key_name = Some("default".into());
        Ok(req)
    }

    /// Build an `LlmRequest` honoring the provider registry's key list.
    ///
    /// Walks `resolve_key_candidates(provider, registry, model)` in
    /// configured order and picks the first candidate whose env var is
    /// set. Falls back to the legacy single-key resolution when no
    /// candidates are present (e.g. provider not in the registry).
    /// Returns `LlmError::MissingApiKey` only when every candidate's env
    /// var is missing or the provider is explicitly disabled.
    ///
    /// This is the right entry point for non-streaming callers
    /// (compaction, dreaming, heartbeat rebuild, autonomy) so they
    /// pick up `[providers.<name>].keys` instead of silently failing
    /// when users configure provider-level keys without a per-model
    /// `api_key_env`. The streaming chat path uses
    /// `stream_with_credential_fallback`, which additionally rotates
    /// across candidates on credential-shaped failures during the
    /// network call itself.
    pub fn build_request_with_provider_keys(
        model: &ResolvedModel,
        registry: &shore_common::config::providers::ProviderRegistry,
        messages: Vec<WireMessage>,
        system: Vec<types::SystemBlock>,
        tools: Option<Vec<types::ToolDefinition>>,
        provider_options: Option<types::ProviderOptions>,
        replay: ThinkingReplay,
    ) -> Result<LlmRequest, LlmError> {
        let candidates = credentials::resolve_key_candidates(&model.provider_key, registry, model);

        if candidates.is_empty() {
            // Provider explicitly disabled — surface a recognizable error
            // rather than falling back to ambient env lookup.
            return Err(LlmError::MissingApiKey {
                var: format!("provider '{}' has no enabled keys", model.provider_key),
            });
        }

        let mut last_env = candidates
            .first()
            .map(|candidate| candidate.env.clone())
            .unwrap_or_default();
        for cand in &candidates {
            if let Some(api_key) = credentials::read_candidate_env(cand) {
                let mut req = Self::build_request_with_resolved_key(
                    model,
                    api_key,
                    messages,
                    system,
                    tools,
                    provider_options,
                    replay,
                );
                req.api_key_name = Some(cand.name.clone());
                return Ok(req);
            }
            last_env.clone_from(&cand.env);
        }

        Err(LlmError::MissingApiKey { var: last_env })
    }

    /// Build an `LlmRequest` using a pre-resolved API key string.
    ///
    /// The dispatch layer's multi-key fallback path resolves the candidate
    /// key list itself (so it can also handle missing-env-var cases by
    /// rotating to the next candidate) and passes the chosen key value here.
    /// All sampler/provider-options derivation is shared with
    /// [`Self::build_request`].
    pub fn build_request_with_resolved_key(
        model: &ResolvedModel,
        api_key: String,
        messages: Vec<WireMessage>,
        system: Vec<types::SystemBlock>,
        tools: Option<Vec<types::ToolDefinition>>,
        provider_options: Option<types::ProviderOptions>,
        replay: ThinkingReplay,
    ) -> LlmRequest {
        let normalized_options =
            provider_options.map_or_else(|| Self::provider_options_for(model), Some);

        LlmRequest {
            sdk: model.sdk.clone(),
            model: model.model_id.clone(),
            api_key,
            api_key_name: None,
            base_url: model.base_url.clone(),
            messages,
            system,
            tools,
            max_tokens: model.max_output_tokens.unwrap_or(4096),
            temperature: model.temperature,
            top_p: model.top_p,
            provider_options: normalized_options,
            provider_key: Some(model.provider_key.clone()),
            replay_prior_thinking: replay,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: model
                .cache_keepalive
                .and_then(shore_common::config::models::CacheKeepaliveSetting::interval),
        }
    }

    /// Derive the sidecar's provider knobs from a resolved model profile.
    ///
    /// Returns `None` when the model sets none of them, so the key is omitted
    /// from the request rather than sent as an empty object.
    fn provider_options_for(model: &ResolvedModel) -> Option<types::ProviderOptions> {
        // `reasoning_effort = "off"` is the explicit-disable sentinel: it maps to
        // `thinking_enabled = false` rather than an effort value, so the
        // OpenRouter adapter can send `reasoning: { effort: "none" }` (turning
        // thinking off even on always-on reasoning models) while every other
        // adapter just omits reasoning. A real effort passes through unchanged.
        let disabled = model.reasoning_effort.as_deref() == Some("off");

        types::ProviderOptions {
            reasoning_effort: model.reasoning_effort.clone().filter(|_| !disabled),
            thinking_enabled: disabled.then_some(false),
            budget_tokens: model.budget_tokens,
            cache_ttl: model.cache_ttl.clone(),
            openrouter_provider: model
                .openrouter_provider
                .as_ref()
                .and_then(|v| serde_json::to_value(v).ok()),
            gemini_generation: model.gemini_generation,
            zai_clear_thinking: model.zai_clear_thinking,
            zai_subscription: model.zai_subscription,
        }
        .into_non_empty()
    }

    /// Send a streaming completion request to the LLM provider.
    ///
    /// Returns a `BufReader` over an `AsyncRead` that yields NDJSON
    /// `StreamEvent` lines for consumption by the stream consumer. When a call
    /// store is configured, the reader is transparently teed so the full
    /// response is recorded on drop. `context` carries the per-call labels the
    /// sidecar records the ledger row from; `None` means no row.
    pub async fn stream_raw(
        &self,
        request: &LlmRequest,
        context: Option<CallContext<'_>>,
    ) -> Result<StreamReader, LlmError> {
        let call_type = context.map(|c| c.call_type);
        let prepared = preprocess_request(request);
        let body = serde_json::to_string(&*prepared).map_err(LlmError::Serialize)?;
        let ctx = debug_log::start(self.call_store.as_ref(), &prepared, &body, call_type);

        debug!(
            sdk = %prepared.sdk.as_str(),
            model = %prepared.model,
            "Sending streaming request to provider"
        );

        // The labels ride the outbound body, not `body` above: the debug log
        // records the LLM request proper, and these never reach a provider —
        // the sidecar reads the wrapper and hands the SDK only the request.
        let read_half = sidecar::stream(&prepared, context, self.sidecar_socket()).await?;
        let reader: Box<dyn AsyncRead + Send + Unpin> = match ctx {
            Some(log) => Box::new(debug_log::TeeReader::new(read_half, log)),
            None => Box::new(read_half),
        };
        Ok(BufReader::new(reader))
    }

    /// Send a non-streaming completion request to the LLM provider. `context`
    /// carries the per-call labels the sidecar records the ledger row from;
    /// `None` means no row.
    pub async fn generate(
        &self,
        request: &LlmRequest,
        context: Option<CallContext<'_>>,
    ) -> Result<types::GenerateResponse, LlmError> {
        let call_type = context.map(|c| c.call_type);
        let prepared = preprocess_request(request);
        let body = serde_json::to_string(&*prepared).map_err(LlmError::Serialize)?;
        let ctx = debug_log::start(self.call_store.as_ref(), &prepared, &body, call_type);

        let result = sidecar::generate(&prepared, context, self.sidecar_socket()).await;
        if let Some(log) = ctx {
            match &result {
                Ok(resp) => log.finish_response(resp),
                Err(e) => log.finish_error(e),
            }
        }
        result
    }

    /// Send an image generation request to the provider.
    pub async fn image_generate(
        &self,
        params: &ImageGenerateParams<'_>,
    ) -> Result<ImageGenerateResponse, LlmError> {
        sidecar::image_generate(params, self.sidecar_socket()).await
    }
}

/// Preprocess an outbound request before serialization:
///
/// Strip orphan `tool_use`/`tool_result` blocks. Orphans cause hard
/// 400s from Anthropic and OpenAI-family APIs (and from translation
/// proxies like OpenRouter).
///
/// Task-specific system instructions are attached at build time by the
/// caller via [`LlmRequest::push_inline_system`], which pins them at a
/// fixed `messages[]` slot — there is no trailing-suffix expansion step
/// here (see that method's doc-comment for why the removed `system_suffix`
/// affordance was cache-unsafe).
///
/// The healthy path (no orphans) allocates nothing.
fn preprocess_request(request: &LlmRequest) -> Cow<'_, LlmRequest> {
    let sanitized = sanitize::sanitize_tool_pairs(&request.messages);

    let Some(cleaned) = sanitized else {
        return Cow::Borrowed(request);
    };

    warn!(
        rid = request.rid.as_deref().unwrap_or("-"),
        character = request.forensic_character.as_deref().unwrap_or("-"),
        original_msgs = request.messages.len(),
        cleaned_msgs = cleaned.len(),
        "stripped orphan tool_use/tool_result blocks from outbound LLM request"
    );

    let mut owned = request.clone();
    owned.messages = cleaned;
    Cow::Owned(owned)
}

/// Return the conventional API key env var name for a provider key.
pub fn default_api_key_env(provider_key: &str) -> &'static str {
    match provider_key {
        "anthropic" => "ANTHROPIC_API_KEY",
        "openai" => "OPENAI_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        "zhipuai" => "ZHIPUAI_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        "moonshot" | "moonshotai" => "MOONSHOT_API_KEY",
        "xai" => "XAI_API_KEY",
        "zai" => "ZAI_API_KEY",
        "nanogpt" => "NANOGPT_API_KEY",
        "opencode-go" => "OPENCODE_API_KEY",
        _ => "LLM_API_KEY",
    }
}

/// Return the conventional HTTPS base URL for a provider key, when one
/// is well-known. Returns `None` for providers whose endpoint is
/// deployment-specific (custom OpenAI-compatible upstreams, on-prem,
/// etc.) — those must set `base_url` explicitly.
///
/// Mirrors the hardcoded fallbacks the chat path already applies so
/// discovery (`refresh_provider_models`) doesn't demand a redundant
/// `base_url` line in `[providers.<key>]`.
pub fn default_base_url(provider_key: &str) -> Option<&'static str> {
    match provider_key {
        "anthropic" => Some("https://api.anthropic.com"),
        "openai" => Some("https://api.openai.com/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "deepseek" => Some("https://api.deepseek.com"),
        "moonshot" | "moonshotai" => Some("https://api.moonshot.ai/v1"),
        "xai" => Some("https://api.x.ai/v1"),
        // Z.ai's standard OpenAI-compatible endpoint. Used for the discovery
        // path only; chat routes through the sidecar's `ZaiProvider`, which
        // owns its own base URL and the `zai_subscription` coding-endpoint
        // switch — so this default never reaches a chat request.
        "zai" => Some("https://api.z.ai/api/paas/v4"),
        // OpenCode Go subscription gateway. Discovery hits `{base}/models` and
        // chat routes to `{base}/chat/completions` (openai SDK) or
        // `{base}/messages` (anthropic SDK, after `stripTrailingV1`), per the
        // per-model SDK that discovery's auto-map assigns.
        "opencode-go" => Some("https://opencode.ai/zen/go/v1"),
        _ => None,
    }
}

/// Return true when the provider's thinking-mode API rejects requests that
/// omit `reasoning_content` from prior assistant turns. DeepSeek V3.1+ and
/// Moonshot's Kimi-thinking enforce this — stripping thinking from history
/// for these providers produces a 400 like
/// `"reasoning_content in the thinking mode must be passed back to the API."`.
///
/// This is a prompt-history shaping hint, not a Rust-provider wire rule. The
/// sidecar adapters own provider request conversion and do not replay prior
/// thinking into output-only fields.
pub fn requires_reasoning_replay(provider_key: &str) -> bool {
    matches!(provider_key, "deepseek" | "moonshot" | "moonshotai")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{ToolResultContent, WireBlock, WireRole};
    use shore_common::config::models::{ResolvedModel, Sdk};

    fn item<T>(items: &[T], index: usize) -> &T {
        items.get(index).expect("expected item")
    }

    #[test]
    fn body_preview_handles_multibyte_at_boundary() {
        // 199 ASCII bytes + "é" (2 bytes) = 201 bytes total.
        // Slicing at byte 200 lands inside "é" and must not panic.
        let body = format!("{}{}", "x".repeat(199), "é");
        assert_eq!(
            body.len(),
            201,
            "test fixture must straddle the 200-byte cut"
        );
        let preview = body_preview(&body, 200);
        assert!(preview.len() <= 200, "preview must not exceed the max");
        assert!(
            preview.is_char_boundary(preview.len()),
            "preview must end on a char boundary"
        );
    }

    /// Helper to build a minimal test ResolvedModel.
    fn test_model(name: &str, provider_key: &str, sdk: Sdk) -> ResolvedModel {
        ResolvedModel {
            name: name.into(),
            qualified_name: format!("{provider_key}:claude-test"),
            category: "chat".into(),
            provider_key: provider_key.into(),
            sdk,
            model_id: "claude-test".into(),
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
            gemini_generation: None,
            zai_clear_thinking: None,
            zai_subscription: None,
            replay_prior_thinking: None,
            max_tool_iterations: None,
        }
    }

    #[test]
    fn build_request_resolves_api_key() {
        std::env::set_var("TEST_API_KEY_015", "sk-test-key");

        let mut model = test_model("test-model", "anthropic", Sdk::Anthropic);
        model.max_output_tokens = Some(2048);
        model.temperature = Some(0.5);
        model.api_key_env = Some("TEST_API_KEY_015".into());

        let req = LlmClient::build_request(
            &model,
            vec![WireMessage::text(WireRole::User, "Hi")],
            Vec::new(),
            None,
            None,
            ThinkingReplay::All,
        )
        .unwrap();

        assert_eq!(req.sdk, Sdk::Anthropic);
        assert_eq!(req.model, "claude-test");
        assert_eq!(req.api_key, "sk-test-key");
        assert_eq!(req.max_tokens, 2048);
        assert_eq!(req.temperature, Some(0.5));
        assert!(req.base_url.is_none());
        assert_eq!(req.provider_key.as_deref(), Some("anthropic"));

        std::env::remove_var("TEST_API_KEY_015");
    }

    #[test]
    fn build_request_maps_cache_keepalive_to_interval() {
        use shore_common::config::duration::ConfigDuration;
        use shore_common::config::models::CacheKeepaliveSetting;

        std::env::set_var("TEST_API_KEY_KA", "sk-test-key");

        // A resolved `Every(55m)` cadence becomes a transient `keepalive_interval`
        // on the request (Anthropic-shaped here, but the mapping is sdk-agnostic).
        let cadence = ConfigDuration::from_secs(55 * 60);
        let mut model = test_model("ka-model", "anthropic", Sdk::Anthropic);
        model.api_key_env = Some("TEST_API_KEY_KA".into());
        model.cache_keepalive = Some(CacheKeepaliveSetting::Every(cadence));
        let req = LlmClient::build_request(
            &model,
            vec![WireMessage::text(WireRole::User, "Hi")],
            Vec::new(),
            None,
            None,
            ThinkingReplay::All,
        )
        .unwrap();
        assert_eq!(req.keepalive_interval, Some(cadence.as_duration()));

        // `Off` and unset both resolve to no interval (keepalive disabled).
        model.cache_keepalive = Some(CacheKeepaliveSetting::Off);
        let off =
            LlmClient::build_request(&model, vec![], Vec::new(), None, None, ThinkingReplay::All)
                .unwrap();
        assert_eq!(off.keepalive_interval, None);

        model.cache_keepalive = None;
        let unset =
            LlmClient::build_request(&model, vec![], Vec::new(), None, None, ThinkingReplay::All)
                .unwrap();
        assert_eq!(unset.keepalive_interval, None);

        std::env::remove_var("TEST_API_KEY_KA");
    }

    #[test]
    fn build_request_translates_reasoning_off_to_thinking_disabled() {
        // Issue #164: `reasoning_effort = "off"` becomes a `thinking_enabled =
        // false` provider option (NOT a reasoning_effort value), which the
        // OpenRouter adapter turns into `reasoning.effort = "none"`.
        std::env::set_var("TEST_API_KEY_164", "sk-test-key");
        let mut model = test_model("or-model", "openrouter", Sdk::Openrouter);
        model.api_key_env = Some("TEST_API_KEY_164".into());

        model.reasoning_effort = Some("off".into());
        let req =
            LlmClient::build_request(&model, vec![], Vec::new(), None, None, ThinkingReplay::All)
                .unwrap();
        let opts = req.provider_options.expect("provider_options present");
        assert_eq!(opts.thinking_enabled, Some(false));
        assert_eq!(opts.reasoning_effort, None);

        // A real effort passes through unchanged.
        model.reasoning_effort = Some("high".into());
        let req_high =
            LlmClient::build_request(&model, vec![], Vec::new(), None, None, ThinkingReplay::All)
                .unwrap();
        let opts_high = req_high.provider_options.expect("provider_options present");
        assert_eq!(opts_high.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(opts_high.thinking_enabled, None);

        std::env::remove_var("TEST_API_KEY_164");
    }

    #[test]
    fn build_request_uses_default_api_key_env() {
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-test");

        let model = test_model("test", "anthropic", Sdk::Anthropic);

        let req =
            LlmClient::build_request(&model, vec![], Vec::new(), None, None, ThinkingReplay::All)
                .unwrap();

        assert_eq!(req.api_key, "sk-ant-test");
        assert_eq!(req.max_tokens, 4096);

        std::env::remove_var("ANTHROPIC_API_KEY");
    }

    #[test]
    fn build_request_with_provider_keys_uses_first_set_env() {
        // Regression pin: non-streaming callers (compaction, dreaming,
        // heartbeat) must honor `[providers.<name>].keys` and not only
        // the per-model `api_key_env`. Otherwise a provider configured
        // with provider-level keys but no per-model api_key_env fails
        // these paths with `MissingApiKey` while chat works fine.
        use shore_common::config::providers::ProviderRegistry;

        std::env::remove_var("PRIMARY_KEY_017");
        std::env::set_var("FALLBACK_KEY_017", "sk-fallback");

        let providers_table: toml::Table = r#"
[providers.openrouter]
sdk = "openai"

[[providers.openrouter.keys]]
name = "primary"
env = "PRIMARY_KEY_017"

[[providers.openrouter.keys]]
name = "fallback"
env = "FALLBACK_KEY_017"
"#
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        // Model has *no* api_key_env — without provider-key resolution,
        // `build_request` would fall back to OPENROUTER_API_KEY and fail.
        let model = test_model("test", "openrouter", Sdk::Openai);

        let req = LlmClient::build_request_with_provider_keys(
            &model,
            &registry,
            vec![],
            Vec::new(),
            None,
            None,
            ThinkingReplay::All,
        )
        .unwrap();
        assert_eq!(req.api_key, "sk-fallback");

        std::env::remove_var("FALLBACK_KEY_017");
    }

    #[test]
    fn build_request_with_provider_keys_falls_back_to_legacy_when_no_keys() {
        // Provider in the registry only for sdk/base_url (no keys list)
        // must keep the legacy single-key path working — the test
        // mirrors `resolve_key_candidates`'s documented contract.
        use shore_common::config::providers::ProviderRegistry;

        std::env::set_var("LEGACY_KEY_017", "sk-legacy");

        let providers_table: toml::Table = r#"
[providers.openrouter]
sdk = "openai"
base_url = "https://openrouter.ai/api/v1"
"#
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let mut model = test_model("test", "openrouter", Sdk::Openai);
        model.api_key_env = Some("LEGACY_KEY_017".into());

        let req = LlmClient::build_request_with_provider_keys(
            &model,
            &registry,
            vec![],
            Vec::new(),
            None,
            None,
            ThinkingReplay::All,
        )
        .unwrap();
        assert_eq!(req.api_key, "sk-legacy");

        std::env::remove_var("LEGACY_KEY_017");
    }

    #[test]
    fn build_request_with_provider_keys_errors_when_disabled() {
        // Explicitly disabled providers must surface a clear error
        // instead of falling through to ambient env lookup.
        use shore_common::config::providers::ProviderRegistry;

        let providers_table: toml::Table = r#"
[providers.openrouter]
enabled = false
sdk = "openai"
"#
        .parse()
        .unwrap();
        let registry = ProviderRegistry::from_section(
            providers_table.get("providers").and_then(|v| v.as_table()),
        )
        .unwrap();

        let model = test_model("test", "openrouter", Sdk::Openai);
        let err = LlmClient::build_request_with_provider_keys(
            &model,
            &registry,
            vec![],
            Vec::new(),
            None,
            None,
            ThinkingReplay::All,
        )
        .unwrap_err();
        let LlmError::MissingApiKey { var } = err else {
            panic!("Expected MissingApiKey");
        };
        assert!(var.contains("openrouter"), "got {var}");
    }

    #[test]
    fn build_request_errors_on_missing_api_key() {
        std::env::remove_var("NONEXISTENT_KEY_015");

        let mut model = test_model("test", "anthropic", Sdk::Anthropic);
        model.api_key_env = Some("NONEXISTENT_KEY_015".into());

        let err =
            LlmClient::build_request(&model, vec![], Vec::new(), None, None, ThinkingReplay::All)
                .unwrap_err();
        let LlmError::MissingApiKey { var } = err else {
            panic!("Expected MissingApiKey");
        };
        assert_eq!(var, "NONEXISTENT_KEY_015");
    }

    #[test]
    fn default_api_key_env_for_providers() {
        assert_eq!(default_api_key_env("anthropic"), "ANTHROPIC_API_KEY");
        assert_eq!(default_api_key_env("openai"), "OPENAI_API_KEY");
        assert_eq!(default_api_key_env("gemini"), "GEMINI_API_KEY");
        assert_eq!(default_api_key_env("openrouter"), "OPENROUTER_API_KEY");
        assert_eq!(default_api_key_env("zhipuai"), "ZHIPUAI_API_KEY");
        assert_eq!(default_api_key_env("deepseek"), "DEEPSEEK_API_KEY");
        assert_eq!(default_api_key_env("xai"), "XAI_API_KEY");
        assert_eq!(default_api_key_env("zai"), "ZAI_API_KEY");
        assert_eq!(default_api_key_env("nanogpt"), "NANOGPT_API_KEY");
        assert_eq!(default_api_key_env("opencode-go"), "OPENCODE_API_KEY");
        assert_eq!(default_api_key_env("unknown"), "LLM_API_KEY");
    }

    #[test]
    fn default_base_url_for_known_providers() {
        assert_eq!(
            default_base_url("openrouter"),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(
            default_base_url("openai"),
            Some("https://api.openai.com/v1")
        );
        assert_eq!(
            default_base_url("anthropic"),
            Some("https://api.anthropic.com")
        );
        assert_eq!(
            default_base_url("deepseek"),
            Some("https://api.deepseek.com")
        );
        assert_eq!(default_base_url("xai"), Some("https://api.x.ai/v1"));
        assert_eq!(
            default_base_url("opencode-go"),
            Some("https://opencode.ai/zen/go/v1")
        );
        assert_eq!(
            default_base_url("zai"),
            Some("https://api.z.ai/api/paas/v4")
        );
        // Custom or unknown providers must still set base_url explicitly.
        assert_eq!(default_base_url("opencode"), None);
        assert_eq!(default_base_url("unknown"), None);
    }

    #[test]
    fn requires_reasoning_replay_for_thinking_mode_providers() {
        assert!(requires_reasoning_replay("deepseek"));
        assert!(requires_reasoning_replay("moonshot"));
        // `moonshotai` is an accepted provider-key alias (cf. default_api_key_env
        // / default_base_url) and must gate replay the same as `moonshot`.
        assert!(requires_reasoning_replay("moonshotai"));
        // Anthropic Claude 4.x doesn't replay prior-turn thinking.
        assert!(!requires_reasoning_replay("anthropic"));
        // OpenAI reasoning models surface a summary, not raw reasoning.
        assert!(!requires_reasoning_replay("openai"));
        // OpenRouter normalizes reasoning per upstream; our helper is
        // about local stripping, so default to false there.
        assert!(!requires_reasoning_replay("openrouter"));
        assert!(!requires_reasoning_replay("zai"));
        assert!(!requires_reasoning_replay("xai"));
        assert!(!requires_reasoning_replay("unknown"));
    }

    #[test]
    fn client_is_clone_and_send() {
        fn assert_clone_send<T: Clone + Send>() {}
        assert_clone_send::<LlmClient>();
    }

    fn req_with_messages(messages: Vec<WireMessage>) -> LlmRequest {
        LlmRequest {
            sdk: Sdk::Anthropic,
            model: "m".into(),
            api_key: "k".into(),
            api_key_name: None,
            base_url: None,
            messages,
            system: Vec::new(),
            tools: None,
            max_tokens: 4096,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: Some("anthropic".into()),
            replay_prior_thinking: ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        }
    }

    #[test]
    fn preprocess_clean_messages_is_borrowed() {
        // No orphan tool_use/tool_result pairs → nothing to rewrite, so
        // preprocess_request returns the input by reference (zero alloc).
        let req = req_with_messages(vec![WireMessage::text(WireRole::User, "hi")]);
        let out = preprocess_request(&req);
        assert!(matches!(out, Cow::Borrowed(_)));
        assert_eq!(out.messages.len(), 1);
    }

    #[test]
    fn preprocess_strips_orphan_tool_result() {
        // A tool_result with no matching tool_use is an orphan; sanitize
        // drops it and preprocess_request returns an owned, cleaned copy.
        let req = req_with_messages(vec![
            WireMessage::text(WireRole::User, "hi"),
            WireMessage::new(
                WireRole::User,
                vec![WireBlock::ToolResult {
                    tool_use_id: "orphan".to_owned(),
                    content: ToolResultContent::Text("stale".to_owned()),
                    is_error: false,
                }],
            ),
        ]);
        let out = preprocess_request(&req);
        assert!(matches!(out, Cow::Owned(_)));
        // The orphan-only message is dropped entirely.
        assert_eq!(out.messages.len(), 1);
        assert_eq!(item(&out.messages, 0).content, vec![WireBlock::text("hi")]);
    }
}
