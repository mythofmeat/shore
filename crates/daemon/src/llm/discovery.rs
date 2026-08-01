//! Provider model discovery and on-disk cache.
//!
//! **Ported.** `llm-sidecar/src/llm/discovery.ts` is the implementation now,
//! pinned by `llm-sidecar/tests/llm_fixtures/discovery_parity.json` (frozen;
//! generated from this file at 9023b46d).
//!
//! Do not add behaviour here — and note that the cache file is a *shared*
//! artifact for as long as both sides exist. The serialized shape is pinned
//! byte-for-byte by the fixture, so a change to `DiscoveredModel` or
//! `ProviderModelsCache` on this side writes files the TypeScript reads as
//! corrupt (and silently, since a bad cache reads as "no cache").
//!
//! Not deleted yet: `effective_catalog.rs`, `commands/providers.rs` and
//! `auto_discovery.rs` are still Rust and still read these caches (#12,
//! step 3). It goes when they do.
//!
//! OpenAI-compatible providers (OpenAI, OpenRouter, vLLM, Together, etc.)
//! share one fetcher while native Anthropic discovery uses its required API
//! headers. The Phase 5 layer is intentionally narrow:
//!
//! * `discover_openai_compatible` — one-shot fetch + map to `DiscoveredModel`.
//! * `discover_anthropic` — one-shot Anthropic Models API fetch + map.
//! * `read_cache` / `write_cache` — atomic per-provider cache files under
//!   `<cache_dir>/providers/<provider>/models.json`.
//!
//! Capabilities are kept as `Option<bool>` so unknown values stay unknown:
//! the user-facing list must not pretend a provider does *not* support
//! tool use just because it didn't advertise the field. The original
//! provider entry JSON is preserved in `raw_provider_metadata` so future
//! phases can extract more without re-fetching.
//!
//! Atomic write semantics: cache is written to a sibling tmp file and
//! renamed in. Discovery failures never delete the previous cache —
//! the write only happens on success.
//!
//! No secrets are read or written by this module's I/O code paths. The
//! caller resolves the API key (typically via
//! [`crate::llm::credentials::resolve_key_candidates`]) and passes the value
//! into the discovery fetcher. Cache files contain only public provider
//! metadata.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// Current cache schema version. Bump when adding a non-trivial field
/// that older Shore builds couldn't reasonably ignore. Older caches with
/// a smaller `version` are read on a best-effort basis; mismatched newer
/// caches are treated as "no cache" and require a refresh.
pub const CACHE_VERSION: u32 = 1;

/// Default TTL for cached provider catalogs. The auto-discovery loop in
/// the daemon refreshes any discovery-enabled provider whose cache is
/// older than this (or absent).
pub const REFRESH_INTERVAL: Duration = Duration::from_hours(24);

/// Required by Anthropic's API on every native HTTP request.
const ANTHROPIC_VERSION: &str = "2023-06-01";

// ── DiscoveredModel ─────────────────────────────────────────────────────

/// One model record returned by a provider's discovery endpoint.
///
/// Capabilities are `Option<bool>` on purpose: `None` means *unknown*,
/// not *unsupported*. UI surfaces should distinguish the two.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscoveredModel {
    pub provider_key: String,
    pub model_id: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,

    /// Wire SDK family (typically the same as the provider's `sdk` field).
    pub sdk: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_prompt_cache: Option<bool>,

    /// The original provider entry, preserved verbatim so future phases
    /// can extract additional fields without re-fetching.
    #[serde(default, skip_serializing_if = "is_null_value")]
    pub raw_provider_metadata: serde_json::Value,

    /// RFC3339 timestamp of when this record was discovered. Stored as
    /// a string to match the diagnostics ring buffer convention and
    /// avoid pulling in chrono's serde feature.
    pub discovered_at: String,
}

fn is_null_value(v: &serde_json::Value) -> bool {
    v.is_null()
}

// ── Cache file ──────────────────────────────────────────────────────────

/// On-disk per-provider cache shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderModelsCache {
    pub version: u32,
    pub provider_key: String,
    /// RFC3339 timestamp of when this cache was last refreshed.
    pub fetched_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    pub models: Vec<DiscoveredModel>,
}

/// Build the canonical cache path for `provider_key` under `cache_dir`:
/// `<cache_dir>/providers/<provider>/models.json`.
pub fn cache_path(cache_dir: &Path, provider_key: &str) -> PathBuf {
    cache_dir
        .join("providers")
        .join(provider_key)
        .join("models.json")
}

/// Read a provider's cache, returning `Ok(None)` when the file is absent
/// or corrupt. Corrupt caches are logged but not propagated as errors —
/// a caller asking for cached models should not fall over because of a
/// bad file; the user can refresh.
pub fn read_cache(path: &Path) -> std::io::Result<Option<ProviderModelsCache>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    match serde_json::from_slice::<ProviderModelsCache>(&bytes) {
        Ok(c) if c.version <= CACHE_VERSION => Ok(Some(c)),
        Ok(c) => {
            warn!(
                path = %path.display(),
                cache_version = c.version,
                supported = CACHE_VERSION,
                "Provider cache version newer than this build — treating as missing"
            );
            Ok(None)
        }
        Err(e) => {
            warn!(
                path = %path.display(),
                error = %e,
                "Provider cache failed to parse — treating as missing"
            );
            Ok(None)
        }
    }
}

/// Elapsed time since `fetched_at` (RFC3339). Returns `None` when the
/// timestamp can't be parsed or sits in the future — callers treat
/// `None` as "stale" so a corrupt timestamp triggers a refresh rather
/// than silently leaving the cache untouched forever.
pub fn cache_age(fetched_at: &str) -> Option<Duration> {
    let parsed = chrono::DateTime::parse_from_rfc3339(fetched_at).ok()?;
    let now = chrono::Utc::now();
    let elapsed = now.signed_duration_since(parsed.with_timezone(&chrono::Utc));
    elapsed.to_std().ok()
}

/// Cache is stale if `fetched_at` is unparseable or older than
/// [`REFRESH_INTERVAL`].
pub fn is_stale(cache: &ProviderModelsCache) -> bool {
    match cache_age(&cache.fetched_at) {
        Some(age) => age >= REFRESH_INTERVAL,
        None => true,
    }
}

/// Write a provider cache atomically: serialize → write to tmp sibling →
/// rename in. The rename only succeeds on success, so a previous good
/// cache survives a serialization or I/O failure.
pub fn write_cache(path: &Path, cache: &ProviderModelsCache) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(cache)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, path)?;
    debug!(path = %path.display(), models = cache.models.len(), "Wrote provider model cache");
    Ok(())
}

// ── Discovery error ─────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("provider {provider}: {kind} discovery is not enabled")]
    DiscoveryDisabled { provider: String, kind: String },

    #[error("provider {provider}: no API key configured")]
    NoKeys { provider: String },

    #[error("provider {provider}: missing base_url for discovery")]
    MissingBaseUrl { provider: String },

    #[error("provider {provider}: discovery HTTP {status}")]
    HttpStatus {
        provider: String,
        status: u16,
        body: String,
    },

    #[error("provider {provider}: network error: {source}")]
    Network {
        provider: String,
        #[source]
        source: reqwest::Error,
    },

    #[error("provider {provider}: failed to parse models response: {source}")]
    Parse {
        provider: String,
        #[source]
        source: serde_json::Error,
    },
}

// ── OpenAI-compatible /v1/models fetcher ────────────────────────────────

/// Fetch and map a provider's `/v1/models` endpoint.
///
/// `base_url` should be the provider's API root (e.g.
/// `https://openrouter.ai/api/v1`). The `/models` suffix is appended,
/// preserving an existing trailing slash when present.
pub async fn discover_openai_compatible(
    http: &reqwest::Client,
    provider_key: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let url = build_models_url(base_url);
    debug!(provider = provider_key, url = %url, "Fetching provider models");

    let resp = http
        .get(&url)
        .bearer_auth(api_key)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| DiscoveryError::Network {
            provider: provider_key.to_owned(),
            source: e,
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| DiscoveryError::Network {
        provider: provider_key.to_owned(),
        source: e,
    })?;

    if !status.is_success() {
        return Err(DiscoveryError::HttpStatus {
            provider: provider_key.to_owned(),
            status: status.as_u16(),
            body: truncate_for_log(&body),
        });
    }

    parse_openai_models_response(provider_key, base_url, &body)
}

/// Fetch and map Anthropic's native Models API endpoint.
///
/// Unlike OpenAI-compatible discovery, Anthropic authenticates with
/// `x-api-key` and requires an API version header. Its conventional
/// `base_url` is the API host, so `/v1/models` is appended when the
/// caller did not already include a version segment.
pub async fn discover_anthropic(
    http: &reqwest::Client,
    provider_key: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let url = build_anthropic_models_url(base_url);
    debug!(provider = provider_key, url = %url, "Fetching Anthropic provider models");

    let resp = http
        .get(&url)
        .header("accept", "application/json")
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("x-api-key", api_key)
        .send()
        .await
        .map_err(|e| DiscoveryError::Network {
            provider: provider_key.to_owned(),
            source: e,
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| DiscoveryError::Network {
        provider: provider_key.to_owned(),
        source: e,
    })?;

    if !status.is_success() {
        return Err(DiscoveryError::HttpStatus {
            provider: provider_key.to_owned(),
            status: status.as_u16(),
            body: truncate_for_log(&body),
        });
    }

    parse_anthropic_models_response(provider_key, base_url, &body)
}

/// Append `/models` to a provider base URL, handling a trailing slash.
fn build_models_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    format!("{trimmed}/models")
}

/// Append Anthropic's Models API path to either the host root or a
/// caller-supplied version root such as a gateway `/api/v1` URL.
fn build_anthropic_models_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}

/// Truncate a response body for logging so we don't drag huge payloads
/// (or, in pathological cases, secrets that a buggy provider might echo)
/// into error chains.
fn truncate_for_log(body: &str) -> String {
    const MAX: usize = 512;
    if body.len() <= MAX {
        body.to_owned()
    } else {
        // Round down to the nearest UTF-8 char boundary so a multibyte
        // character straddling byte 512 doesn't panic the slice.
        let end = body.floor_char_boundary(MAX);
        format!("{}…", body.get(..end).unwrap_or(body))
    }
}

#[derive(Deserialize)]
struct ModelsEnvelope {
    #[serde(default)]
    data: Vec<serde_json::Value>,
}

fn parse_openai_models_response(
    provider_key: &str,
    base_url: &str,
    body: &str,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    parse_models_response(provider_key, base_url, "openai", body)
}

fn parse_anthropic_models_response(
    provider_key: &str,
    base_url: &str,
    body: &str,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    parse_models_response(provider_key, base_url, "anthropic", body)
}

fn parse_models_response(
    provider_key: &str,
    base_url: &str,
    sdk: &str,
    body: &str,
) -> Result<Vec<DiscoveredModel>, DiscoveryError> {
    let envelope: ModelsEnvelope =
        serde_json::from_str(body).map_err(|e| DiscoveryError::Parse {
            provider: provider_key.to_owned(),
            source: e,
        })?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut out = Vec::with_capacity(envelope.data.len());
    for raw in envelope.data {
        if let Some(model) = map_entry(provider_key, base_url, sdk, &raw, &now) {
            out.push(model);
        }
    }
    Ok(out)
}

/// Resolve the wire SDK for a single discovered model.
///
/// OpenAI-compatible discovery stamps one blanket `sdk` for every model, which
/// is correct for single-dialect gateways. OpenCode Go, however, fronts open
/// models across two dialects behind one `/models` feed: MiniMax and Qwen speak
/// the Anthropic `/messages` format, everything else the OpenAI
/// `/chat/completions` format (per opencode.ai/docs/go). Auto-map those two
/// families to `anthropic` so chat routes to the right adapter; all other
/// providers keep the feed's `default_sdk` unchanged.
fn effective_model_sdk<'sdk>(
    provider_key: &str,
    model_id: &str,
    default_sdk: &'sdk str,
) -> &'sdk str {
    if provider_key != "opencode-go" {
        return default_sdk;
    }
    let id = model_id.to_ascii_lowercase();
    // Strip any leading `vendor/` namespace some feeds prepend before matching.
    let bare = id.rsplit('/').next().unwrap_or(&id);
    if bare.starts_with("qwen") || bare.starts_with("minimax") {
        "anthropic"
    } else {
        "openai"
    }
}

fn map_entry(
    provider_key: &str,
    base_url: &str,
    sdk: &str,
    raw: &serde_json::Value,
    now: &str,
) -> Option<DiscoveredModel> {
    let id = raw.get("id").and_then(|v| v.as_str())?.to_owned();
    let model_sdk = effective_model_sdk(provider_key, &id, sdk);
    let display_name = raw
        .get("name")
        .or_else(|| raw.get("display_name"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let created_at = raw
        .get("created")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| {
            raw.get("created_at")
                .and_then(|v| v.as_str())
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.timestamp())
        });
    let owned_by = raw
        .get("owned_by")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let description = raw
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let context_length = raw
        .get("context_length")
        .and_then(serde_json::Value::as_u64);

    // OpenRouter shape: top_provider.max_completion_tokens
    let max_output_tokens = raw
        .get("top_provider")
        .and_then(|v| v.get("max_completion_tokens"))
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            raw.get("max_completion_tokens")
                .and_then(serde_json::Value::as_u64)
        });

    // Capabilities — best-effort, otherwise unknown.
    let supports_tools = supported_param(raw, &["tools", "tool_use", "function_calling"]);
    let supports_reasoning = supported_param(raw, &["reasoning", "include_reasoning"]);
    let supports_images = modality_includes(raw, "input", "image");
    let supports_prompt_cache = supported_param(raw, &["prompt_cache", "cache_control"]);

    Some(DiscoveredModel {
        provider_key: provider_key.to_owned(),
        model_id: id,
        display_name,
        sdk: model_sdk.to_owned(),
        base_url: Some(base_url.to_owned()),
        created_at,
        owned_by,
        description,
        context_length,
        max_output_tokens,
        supports_tools,
        supports_images,
        supports_reasoning,
        supports_prompt_cache,
        raw_provider_metadata: raw.clone(),
        discovered_at: now.to_owned(),
    })
}

/// Look at OpenRouter-style `supported_parameters: [...]` for any of the
/// listed names. `None` means the field is absent — unknown, not false.
fn supported_param(raw: &serde_json::Value, candidates: &[&str]) -> Option<bool> {
    let arr = raw.get("supported_parameters")?.as_array()?;
    let values: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
    Some(candidates.iter().any(|c| values.contains(c)))
}

/// Look at OpenRouter-style `architecture.{input,output}_modalities` for
/// a specific modality. `None` means the field is absent.
fn modality_includes(raw: &serde_json::Value, side: &str, modality: &str) -> Option<bool> {
    let arch = raw.get("architecture")?;
    let key = format!("{side}_modalities");
    let arr = arch.get(&key)?.as_array()?;
    Some(arr.iter().any(|v| v.as_str() == Some(modality)))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn model(models: &[DiscoveredModel], index: usize) -> &DiscoveredModel {
        models.get(index).expect("discovered model")
    }

    fn field<'val>(value: &'val serde_json::Value, key: &str) -> &'val serde_json::Value {
        value
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key}"))
    }

    #[test]
    fn cache_path_layout() {
        let p = cache_path(Path::new("/cache"), "openrouter");
        assert_eq!(p, PathBuf::from("/cache/providers/openrouter/models.json"));
    }

    #[test]
    fn read_missing_cache_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let p = cache_path(tmp.path(), "ghost");
        assert!(read_cache(&p).unwrap().is_none());
    }

    #[test]
    fn write_then_read_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "openrouter");
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: "openrouter".into(),
            fetched_at: "2026-04-28T10:00:00Z".into(),
            base_url: Some("https://openrouter.ai/api/v1".into()),
            models: vec![DiscoveredModel {
                provider_key: "openrouter".into(),
                model_id: "x-ai/grok-2".into(),
                display_name: Some("Grok 2".into()),
                sdk: "openai".into(),
                base_url: Some("https://openrouter.ai/api/v1".into()),
                created_at: Some(1_700_000_000),
                owned_by: Some("xai".into()),
                description: None,
                context_length: Some(131_072),
                max_output_tokens: Some(8192),
                supports_tools: Some(true),
                supports_images: Some(false),
                supports_reasoning: None,
                supports_prompt_cache: None,
                raw_provider_metadata: serde_json::json!({"id":"x-ai/grok-2"}),
                discovered_at: "2026-04-28T10:00:00Z".into(),
            }],
        };

        write_cache(&path, &cache).unwrap();

        let read_back = read_cache(&path).unwrap().expect("present");
        assert_eq!(read_back, cache);

        // No tmp file left behind.
        let tmp_path = path.with_extension("json.tmp");
        assert!(!tmp_path.exists(), "tmp sibling should be renamed in");
    }

    #[test]
    fn corrupt_cache_returns_none_without_erroring() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "openrouter");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not-json{{{").unwrap();
        assert!(read_cache(&path).unwrap().is_none());
    }

    #[test]
    fn newer_cache_version_treated_as_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "openrouter");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = serde_json::json!({
            "version": CACHE_VERSION + 99,
            "provider_key": "openrouter",
            "fetched_at": "2030-01-01T00:00:00Z",
            "models": [],
        });
        std::fs::write(&path, serde_json::to_vec(&body).unwrap()).unwrap();
        assert!(read_cache(&path).unwrap().is_none());
    }

    #[test]
    fn build_models_url_handles_trailing_slash() {
        assert_eq!(
            build_models_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/models"
        );
        assert_eq!(
            build_models_url("https://openrouter.ai/api/v1/"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn build_anthropic_models_url_adds_version_path_from_host_root() {
        assert_eq!(
            build_anthropic_models_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            build_anthropic_models_url("https://gateway.test/api/v1/"),
            "https://gateway.test/api/v1/models"
        );
    }

    #[test]
    fn parses_openai_minimal_response() {
        let body = r#"{
            "object": "list",
            "data": [
                { "id": "gpt-4o", "object": "model", "created": 1234567890, "owned_by": "openai" },
                { "id": "gpt-4o-mini", "object": "model" }
            ]
        }"#;
        let models =
            parse_openai_models_response("openai", "https://api.openai.com/v1", body).unwrap();
        assert_eq!(models.len(), 2);
        let first = model(&models, 0);
        assert_eq!(first.model_id, "gpt-4o");
        assert_eq!(first.owned_by.as_deref(), Some("openai"));
        assert_eq!(first.created_at, Some(1_234_567_890));
        assert!(first.supports_tools.is_none(), "unknown stays unknown");
        assert!(first.supports_images.is_none());
        assert_eq!(first.sdk, "openai");
        assert_eq!(first.base_url.as_deref(), Some("https://api.openai.com/v1"));
        assert_eq!(model(&models, 1).owned_by, None);
    }

    #[test]
    fn parses_openrouter_extended_response() {
        let body = r#"{
            "data": [{
                "id": "anthropic/claude-3.5-sonnet",
                "name": "Claude 3.5 Sonnet",
                "context_length": 200000,
                "supported_parameters": ["temperature", "tools", "reasoning"],
                "architecture": {
                    "input_modalities": ["text", "image"],
                    "output_modalities": ["text"]
                },
                "top_provider": { "max_completion_tokens": 8192 },
                "description": "Strong general model."
            }]
        }"#;
        let models =
            parse_openai_models_response("openrouter", "https://openrouter.ai/api/v1", body)
                .unwrap();
        assert_eq!(models.len(), 1);
        let m = model(&models, 0);
        assert_eq!(m.model_id, "anthropic/claude-3.5-sonnet");
        assert_eq!(m.display_name.as_deref(), Some("Claude 3.5 Sonnet"));
        assert_eq!(m.context_length, Some(200_000));
        assert_eq!(m.max_output_tokens, Some(8192));
        assert_eq!(m.supports_tools, Some(true));
        assert_eq!(m.supports_reasoning, Some(true));
        assert_eq!(m.supports_images, Some(true));
        assert_eq!(m.supports_prompt_cache, Some(false));
        assert_eq!(m.description.as_deref(), Some("Strong general model."));
        assert_eq!(
            field(&m.raw_provider_metadata, "id"),
            &serde_json::json!("anthropic/claude-3.5-sonnet")
        );
    }

    #[test]
    fn opencode_go_discovery_auto_maps_sdk_per_model_family() {
        // OpenCode Go's `/models` feed is OpenAI-compatible (blanket "openai"),
        // but MiniMax/Qwen must route through the Anthropic `/messages` adapter.
        let body = r#"{
            "data": [
                { "id": "deepseek-v4-pro", "object": "model" },
                { "id": "kimi-k2.6", "object": "model" },
                { "id": "glm-5.1", "object": "model" },
                { "id": "qwen3.7-max", "object": "model" },
                { "id": "minimax-m2.7", "object": "model" }
            ]
        }"#;
        let models =
            parse_openai_models_response("opencode-go", "https://opencode.ai/zen/go/v1", body)
                .unwrap();
        let sdk_of = |id: &str| {
            models
                .iter()
                .find(|m| m.model_id == id)
                .map(|m| m.sdk.as_str())
                .expect("model present")
        };
        assert_eq!(sdk_of("deepseek-v4-pro"), "openai");
        assert_eq!(sdk_of("kimi-k2.6"), "openai");
        assert_eq!(sdk_of("glm-5.1"), "openai");
        assert_eq!(sdk_of("qwen3.7-max"), "anthropic");
        assert_eq!(sdk_of("minimax-m2.7"), "anthropic");
    }

    #[test]
    fn non_opencode_provider_keeps_blanket_discovery_sdk() {
        // The auto-map must not leak into other OpenAI-compatible gateways:
        // a qwen model discovered via OpenRouter still reports the feed sdk.
        let body = r#"{ "data": [{ "id": "qwen/qwen3-max", "object": "model" }] }"#;
        let models =
            parse_openai_models_response("openrouter", "https://openrouter.ai/api/v1", body)
                .unwrap();
        assert_eq!(model(&models, 0).sdk, "openai");
    }

    #[test]
    fn parses_anthropic_models_response() {
        let body = r#"{
            "data": [{
                "created_at": "1970-01-01T00:00:00Z",
                "display_name": "Claude Sonnet 4",
                "id": "claude-sonnet-4-20250514",
                "type": "model"
            }],
            "has_more": false
        }"#;
        let models =
            parse_anthropic_models_response("anthropic", "https://api.anthropic.com", body)
                .unwrap();
        assert_eq!(models.len(), 1);
        let m = model(&models, 0);
        assert_eq!(m.model_id, "claude-sonnet-4-20250514");
        assert_eq!(m.display_name.as_deref(), Some("Claude Sonnet 4"));
        assert_eq!(m.created_at, Some(0));
        assert_eq!(m.sdk, "anthropic");
        assert_eq!(
            field(&m.raw_provider_metadata, "type"),
            &serde_json::json!("model")
        );
    }

    #[test]
    fn unknown_capability_stays_unknown_when_field_absent() {
        let body = r#"{"data": [{"id": "x", "object": "model"}]}"#;
        let models = parse_openai_models_response("p", "u", body).unwrap();
        let first = model(&models, 0);
        assert_eq!(first.supports_tools, None);
        assert_eq!(first.supports_images, None);
        assert_eq!(first.supports_reasoning, None);
        assert_eq!(first.supports_prompt_cache, None);
    }

    #[test]
    fn entry_without_id_is_skipped() {
        let body = r#"{"data": [{"object":"model"}, {"id":"keep","object":"model"}]}"#;
        let models = parse_openai_models_response("p", "u", body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(model(&models, 0).model_id, "keep");
    }

    #[test]
    fn parse_invalid_json_propagates_error() {
        let err = parse_openai_models_response("openai", "u", "{bad json").unwrap_err();
        assert!(matches!(err, DiscoveryError::Parse { .. }));
    }

    #[test]
    fn truncate_for_log_caps_long_bodies() {
        let body = "x".repeat(2000);
        let truncated = truncate_for_log(&body);
        assert!(truncated.len() < body.len());
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn truncate_for_log_passes_short_bodies() {
        assert_eq!(truncate_for_log("hi"), "hi");
    }

    #[test]
    fn cache_age_parses_rfc3339_and_returns_elapsed() {
        let one_hour_ago = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        let age = cache_age(&one_hour_ago).expect("parses");
        assert!(age >= Duration::from_mins(59));
        assert!(age < Duration::from_mins(61));
    }

    #[test]
    fn cache_age_returns_none_for_garbage() {
        assert!(cache_age("not a timestamp").is_none());
        assert!(cache_age("").is_none());
    }

    #[test]
    fn is_stale_true_when_older_than_interval() {
        let old = (chrono::Utc::now() - chrono::Duration::hours(48)).to_rfc3339();
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: "p".into(),
            fetched_at: old,
            base_url: None,
            models: vec![],
        };
        assert!(is_stale(&cache));
    }

    #[test]
    fn is_stale_false_when_recent() {
        let fresh = chrono::Utc::now().to_rfc3339();
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: "p".into(),
            fetched_at: fresh,
            base_url: None,
            models: vec![],
        };
        assert!(!is_stale(&cache));
    }

    #[test]
    fn is_stale_true_when_timestamp_is_garbage() {
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: "p".into(),
            fetched_at: "not-a-timestamp".into(),
            base_url: None,
            models: vec![],
        };
        assert!(is_stale(&cache));
    }

    #[test]
    fn truncate_for_log_handles_multibyte_at_boundary() {
        // Pad with 510 ASCII bytes, then a 3-byte char so byte 512 lands
        // mid-character. A naive `&body[..512]` would panic here.
        let mut body = "x".repeat(510);
        body.push('世');
        body.push_str(&"y".repeat(2000));
        let truncated = truncate_for_log(&body);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() < body.len());
    }
}
