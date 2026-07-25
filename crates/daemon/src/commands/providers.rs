//! Provider discovery commands: `list_providers`, `refresh_provider_models`,
//! `list_provider_models`.
//!
//! These commands are characterless — they expose runtime state about
//! configured providers and discovered models without requiring an
//! attached character session. Secrets never leave this module: only
//! key names, env-var-set booleans, and public model metadata are
//! surfaced. Refresh failures preserve whatever cache was on disk.

use std::path::{Path, PathBuf};

use crate::ledger::LedgerClient;
use crate::llm::discovery::ProviderModelsCache;
use serde_json::{json, Value};
use shore_common::config::{models::Sdk, LoadedConfig};
use shore_common::protocol::error::ErrorCode;
use tracing::{info, warn};

use crate::commands::{CommandContext, CommandResult};

// ── Helpers ────────────────────────────────────────────────────────────

fn require_provider(args: &Value) -> Result<&str, (ErrorCode, String)> {
    args.get("provider")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or((
            ErrorCode::InvalidRequest,
            "missing required argument: provider".into(),
        ))
}

/// Whether the env var holding a key has a non-empty value. Returns just
/// the boolean — the value itself is never exposed.
fn env_set(var: &str) -> bool {
    std::env::var(var).is_ok_and(|v| !v.trim().is_empty())
}

// ── list_providers ─────────────────────────────────────────────────────

/// Return all configured providers with their public-facing metadata.
///
/// Output shape (per provider):
/// - `name`, `enabled`, `sdk`, `base_url`, `discovery_enabled`
/// - `keys`: array of `{ name, enabled, warn_on_fallback, env_set }`
/// - `cache`: `{ present: bool, models: u32, fetched_at: Option<String> }`
///
/// No env var names, no key values, nothing that could leak credentials.
pub fn list_providers(ctx: &CommandContext) -> CommandResult {
    let providers: Vec<Value> = ctx
        .config
        .providers
        .iter()
        .map(|(name, entry)| {
            let keys: Vec<Value> = entry
                .keys()
                .iter()
                .map(|k| {
                    json!({
                        "name": k.name,
                        "enabled": k.enabled,
                        "warn_on_fallback": k.warn_on_fallback,
                        "env_set": env_set(&k.env),
                    })
                })
                .collect();

            let cache_path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, name);
            let cache_summary = match crate::llm::discovery::read_cache(&cache_path) {
                Ok(Some(c)) => {
                    let hidden = c
                        .models
                        .iter()
                        .filter(|m| !entry.discovery.is_visible(&m.model_id))
                        .count();
                    json!({
                        "present": true,
                        "models": c.models.len(),
                        "visible": c.models.len().saturating_sub(hidden),
                        "hidden": hidden,
                        "fetched_at": c.fetched_at,
                    })
                }
                _ => json!({
                    "present": false,
                    "models": 0,
                    "visible": 0,
                    "hidden": 0,
                    "fetched_at": Value::Null,
                }),
            };

            json!({
                "name": name,
                "enabled": entry.enabled,
                "sdk": entry.sdk.as_ref().map(Sdk::as_str),
                "base_url": entry.base_url,
                "discovery_enabled": entry.discovery.enabled,
                "keys": keys,
                "cache": cache_summary,
            })
        })
        .collect();

    Ok(json!({ "providers": providers }))
}

// ── refresh_provider_models ────────────────────────────────────────────

/// Outcome of a successful refresh: the cache that was written and the
/// path it was written to. Used by both the single-provider and
/// bulk-refresh command wrappers as well as the auto-discovery loop.
pub(crate) struct RefreshOutcome {
    pub cache: ProviderModelsCache,
    pub cache_path: PathBuf,
}

/// Fetch the provider's discovery endpoint with the first usable key,
/// then write the cache atomically. The cache is only updated on success
/// — any failure leaves the previous cache untouched.
///
/// Decoupled from `CommandContext` so the auto-discovery background loop
/// can call it with just the bits it needs.
pub(crate) async fn refresh_one(
    config: &LoadedConfig,
    cache_dir: &Path,
    llm: &LedgerClient,
    provider: &str,
) -> Result<RefreshOutcome, (ErrorCode, String)> {
    let entry = config.providers.get(provider).ok_or((
        ErrorCode::NotFound,
        format!("provider {provider:?} is not configured"),
    ))?;

    if !entry.enabled {
        return Err((
            ErrorCode::InvalidRequest,
            format!("provider {provider:?} is disabled"),
        ));
    }
    if !entry.discovery.enabled {
        return Err((
            ErrorCode::InvalidRequest,
            format!("provider {provider:?} has discovery disabled"),
        ));
    }

    let base_url = entry
        .base_url
        .clone()
        .or_else(|| crate::llm::default_base_url(provider).map(String::from))
        .ok_or((
            ErrorCode::InvalidRequest,
            format!(
                "provider {provider:?} has no base_url; \
                 required for provider discovery"
            ),
        ))?;

    // Pick the first enabled key whose env var holds a non-empty value.
    // We do not rotate on failure here (Phase 4 fallback is reserved for
    // chat traffic); a discovery failure is reported to the caller and
    // they can fix their credentials and retry.
    let key_value = entry
        .enabled_keys()
        .find_map(|k| std::env::var(&k.env).ok().filter(|v| !v.trim().is_empty()))
        .ok_or((
            ErrorCode::ProviderError,
            format!(
                "provider {provider:?} has no API key configured (no enabled key's env var is set)"
            ),
        ))?;

    let http = llm.inner().http_client();
    info!(provider = %provider, base_url = %base_url, "Refreshing provider models");

    let sdk = entry
        .sdk
        .clone()
        .unwrap_or_else(|| shore_common::config::models::default_sdk(provider));
    let discovered = match sdk {
        Sdk::Anthropic => {
            crate::llm::discovery::discover_anthropic(http, provider, &base_url, &key_value).await
        }
        Sdk::Openai | Sdk::Gemini | Sdk::Zai | Sdk::Openrouter | Sdk::Deepseek | Sdk::Moonshot => {
            crate::llm::discovery::discover_openai_compatible(http, provider, &base_url, &key_value)
                .await
        }
    };
    let models = match discovered {
        Ok(m) => m,
        Err(e) => {
            warn!(provider = %provider, error = %e, "Provider discovery failed; preserving previous cache");
            return Err((ErrorCode::InternalError, e.to_string()));
        }
    };

    let cache = ProviderModelsCache {
        version: crate::llm::discovery::CACHE_VERSION,
        provider_key: provider.to_owned(),
        fetched_at: chrono::Utc::now().to_rfc3339(),
        base_url: Some(base_url),
        models,
    };

    let cache_path = crate::llm::discovery::cache_path(cache_dir, provider);
    if let Err(e) = crate::llm::discovery::write_cache(&cache_path, &cache) {
        return Err((
            ErrorCode::InternalError,
            format!("failed to write provider cache: {e}"),
        ));
    }

    Ok(RefreshOutcome { cache, cache_path })
}

/// JSON-args wrapper around `refresh_one` for the single-provider
/// `shore provider refresh <name>` command path.
pub async fn refresh_provider_models(ctx: &CommandContext, args: &Value) -> CommandResult {
    let provider = require_provider(args)?;
    let outcome = refresh_one(
        &ctx.config,
        &ctx.config.dirs.cache,
        &ctx.llm_client,
        provider,
    )
    .await?;
    Ok(json!({
        "provider": provider,
        "model_count": outcome.cache.models.len(),
        "fetched_at": outcome.cache.fetched_at,
        "cache_path": outcome.cache_path.display().to_string(),
    }))
}

// ── refresh_all_provider_models ────────────────────────────────────────

/// Refresh every configured provider that is enabled and has discovery
/// enabled. Per-provider failures are aggregated rather than aborting
/// the batch — a missing key on one provider should not prevent others
/// from refreshing.
///
/// Output shape:
/// ```json
/// {
///   "results": [
///     { "provider": "openrouter", "ok": true,  "model_count": 312, "fetched_at": "..." },
///     { "provider": "openai",     "ok": false, "error": "no API key configured" }
///   ],
///   "skipped": [
///     { "provider": "anthropic", "reason": "discovery disabled" }
///   ]
/// }
/// ```
pub async fn refresh_all_provider_models(ctx: &CommandContext) -> CommandResult {
    let mut results: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();

    for (name, entry) in ctx.config.providers.iter() {
        if !entry.enabled {
            skipped.push(json!({ "provider": name, "reason": "disabled" }));
            continue;
        }
        if !entry.discovery.enabled {
            skipped.push(json!({ "provider": name, "reason": "discovery disabled" }));
            continue;
        }

        match refresh_one(&ctx.config, &ctx.config.dirs.cache, &ctx.llm_client, name).await {
            Ok(outcome) => results.push(json!({
                "provider": name,
                "ok": true,
                "model_count": outcome.cache.models.len(),
                "fetched_at": outcome.cache.fetched_at,
                "cache_path": outcome.cache_path.display().to_string(),
            })),
            Err((_code, message)) => results.push(json!({
                "provider": name,
                "ok": false,
                "error": message,
            })),
        }
    }

    Ok(json!({
        "results": results,
        "skipped": skipped,
    }))
}

// ── list_provider_models ───────────────────────────────────────────────

/// Return the merged model list for a provider: discovered (from cache)
/// plus statically configured models from `[chat.<provider>.<name>]`.
///
/// Static models are always returned, even when the discovery cache is
/// missing. This preserves the manual escape hatch from Phase 0.
///
/// Ignore filtering (Phase 6): discovered models matched by the
/// provider's `discovery.ignore` rules are placed in `hidden`
/// instead of `discovered`. Pass `include_hidden = true` to fold them
/// back into the main `discovered` list. Static models are not
/// filtered — manual catalog entries are always intentional.
pub fn list_provider_models(ctx: &CommandContext, args: &Value) -> CommandResult {
    let provider = require_provider(args)?;
    let include_hidden = args
        .get("include_hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Validate that the provider is at least *known* (configured in the
    // registry, or referenced by a static chat entry). Discovering the
    // hardcoded provider defaults is a Phase 7 concern.
    let registry_entry = ctx.config.providers.get(provider);
    let known_in_static = ctx
        .config
        .models
        .chat
        .values()
        .any(|m| m.provider_key == provider);
    if registry_entry.is_none() && !known_in_static {
        return Err((
            ErrorCode::NotFound,
            format!("provider {provider:?} is not configured"),
        ));
    }

    let cache_path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, provider);
    let cache = crate::llm::discovery::read_cache(&cache_path)
        .ok()
        .flatten();

    let mut discovered: Vec<Value> = Vec::new();
    let mut hidden: Vec<Value> = Vec::new();
    if let Some(c) = cache.as_ref() {
        for m in &c.models {
            let is_visible = registry_entry.is_none_or(|e| e.discovery.is_visible(&m.model_id));
            if is_visible || include_hidden {
                discovered.push(discovered_to_json(m));
            } else {
                hidden.push(discovered_to_json(m));
            }
        }
    }

    let static_models: Vec<Value> = ctx
        .config
        .models
        .chat
        .values()
        .filter(|m| m.provider_key == provider)
        .map(|m| {
            json!({
                "source": "static",
                "name": m.name,
                "qualified_name": m.qualified_name,
                "model_id": m.model_id,
                "sdk": m.sdk.as_str(),
                "max_output_tokens": m.max_output_tokens,
            })
        })
        .collect();

    Ok(json!({
        "provider": provider,
        "discovered": discovered,
        "hidden": hidden,
        "static": static_models,
        "include_hidden": include_hidden,
        "cache": cache.map(|c| json!({
            "fetched_at": c.fetched_at,
            "model_count": c.models.len(),
        })).unwrap_or(json!({ "fetched_at": Value::Null, "model_count": 0 })),
    }))
}

fn discovered_to_json(m: &crate::llm::discovery::DiscoveredModel) -> Value {
    json!({
        "source": "discovered",
        "model_id": m.model_id,
        "display_name": m.display_name,
        "sdk": m.sdk,
        "owned_by": m.owned_by,
        "context_length": m.context_length,
        "max_output_tokens": m.max_output_tokens,
        "supports_tools": m.supports_tools,
        "supports_images": m.supports_images,
        "supports_reasoning": m.supports_reasoning,
        "supports_prompt_cache": m.supports_prompt_cache,
        "discovered_at": m.discovered_at,
    })
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use crate::ledger::LedgerClient;
    use crate::llm::discovery::{DiscoveredModel, ProviderModelsCache, CACHE_VERSION};
    use shore_common::config::app::{AutonomyConfig, CompactionConfig};
    use shore_common::config::providers::ProviderRegistry;
    use shore_common::diagnostics::Diagnostics;
    use shore_common::protocol::server_msg::ServerMessage;
    use tokio::sync::broadcast;

    use crate::autonomy::manager::AutonomyManager;
    use crate::commands::SessionTokens;

    fn field<'val>(value: &'val Value, key: &str) -> &'val Value {
        value
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key}"))
    }

    fn array_field<'val>(value: &'val Value, key: &str) -> &'val [Value] {
        field(value, key).as_array().expect("array field")
    }

    fn item<T>(values: &[T], index: usize) -> &T {
        values.get(index).expect("value item")
    }

    fn build_ctx_with_registry(tmp: &tempfile::TempDir, toml_str: &str) -> CommandContext {
        let (push_tx, _push_rx) = broadcast::channel(16);
        let data_dir = tmp.path().to_path_buf();

        let providers = if toml_str.is_empty() {
            ProviderRegistry::default()
        } else {
            let table: toml::Table = toml_str.parse().unwrap();
            let section = table.get("providers").and_then(|v| v.as_table());
            ProviderRegistry::from_section(section).unwrap()
        };

        let mut loaded = LoadedConfig::new_for_test(
            shore_common::config::app::AppConfig::default(),
            shore_common::config::models::ModelCatalog::default(),
            shore_common::config::ShoreDirs {
                config: tmp.path().join("config"),
                data: data_dir.clone(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );
        loaded.providers = providers;

        let (_tx, rx) = tokio::sync::watch::channel(());
        let autonomy = AutonomyManager::new(
            AutonomyConfig::default(),
            CompactionConfig::default(),
            data_dir.clone(),
            rx,
        );

        CommandContext {
            config_path: loaded.dirs.config.join("config.toml"),
            config: loaded,
            push_tx,
            data_dir: data_dir.clone(),
            character_name: None,
            active_model: None,
            active_resolved_model: None,
            session_tokens: Arc::new(Mutex::new(SessionTokens::default())),
            autonomy,
            llm_client: LedgerClient::new(
                crate::llm::LlmClient::try_new().unwrap(),
                &data_dir.join("ledger.db"),
            )
            .unwrap(),
            diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
        }
    }

    fn write_test_cache(cache_dir: &Path, provider: &str, models: Vec<DiscoveredModel>) {
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: provider.into(),
            fetched_at: "2026-04-28T10:00:00Z".into(),
            base_url: Some("https://example.test/v1".into()),
            models,
        };
        let path = crate::llm::discovery::cache_path(cache_dir, provider);
        crate::llm::discovery::write_cache(&path, &cache).unwrap();
    }

    fn discovered_fixture(provider: &str, model_id: &str) -> DiscoveredModel {
        DiscoveredModel {
            provider_key: provider.into(),
            model_id: model_id.into(),
            display_name: None,
            sdk: "openai".into(),
            base_url: Some("https://example.test/v1".into()),
            created_at: None,
            owned_by: None,
            description: None,
            context_length: None,
            max_output_tokens: None,
            supports_tools: None,
            supports_images: None,
            supports_reasoning: None,
            supports_prompt_cache: None,
            raw_provider_metadata: Value::Null,
            discovered_at: "2026-04-28T10:00:00Z".into(),
        }
    }

    // ── list_providers ──────────────────────────────────────────────────

    #[test]
    fn list_providers_no_secrets_in_output() {
        let tmp = tempfile::tempdir().unwrap();
        let unique = format!("PROV_TEST_LIST_KEY_{}", std::process::id());
        std::env::set_var(&unique, "sk-this-must-not-appear");
        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[providers.openrouter]
sdk = "openai"
base_url = "https://openrouter.ai/api/v1"

[[providers.openrouter.keys]]
name = "main"
env = "{unique}"
warn_on_fallback = true
"#
            ),
        );

        let out = list_providers(&ctx).unwrap();
        let s = serde_json::to_string(&out).unwrap();

        // Secret value never appears.
        assert!(
            !s.contains("sk-this-must-not-appear"),
            "secret leaked into list_providers output: {s}"
        );
        // Env var name never appears either.
        assert!(!s.contains(&unique), "env var name leaked: {s}");

        // But friendly key name and env_set boolean do.
        let provider = item(array_field(&out, "providers"), 0);
        assert_eq!(field(provider, "name"), "openrouter");
        let key = item(array_field(provider, "keys"), 0);
        assert_eq!(field(key, "name"), "main");
        assert_eq!(field(key, "env_set"), true);
        assert_eq!(field(key, "warn_on_fallback"), true);

        std::env::remove_var(&unique);
    }

    #[test]
    fn list_providers_reports_cache_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.openrouter]
sdk = "openai"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OR_KEY"
"#,
        );
        write_test_cache(
            &ctx.config.dirs.cache,
            "openrouter",
            vec![discovered_fixture(
                "openrouter",
                "anthropic/claude-3.5-sonnet",
            )],
        );

        let out = list_providers(&ctx).unwrap();
        let provider = item(array_field(&out, "providers"), 0);
        let cache = field(provider, "cache");
        assert_eq!(field(cache, "present"), true);
        assert_eq!(field(cache, "models"), 1);
    }

    #[test]
    fn list_providers_reports_absent_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.openai]
api_key_env = "OPENAI_KEY"
"#,
        );
        let out = list_providers(&ctx).unwrap();
        let provider = item(array_field(&out, "providers"), 0);
        let cache = field(provider, "cache");
        assert_eq!(field(cache, "present"), false);
        assert_eq!(field(cache, "models"), 0);
    }

    // ── list_provider_models ────────────────────────────────────────────

    #[test]
    fn list_provider_models_merges_static_and_discovered() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
"#,
        );
        // Inject a static chat entry under the same provider.
        let table: toml::Table = r#"
[chat.openrouter.kimi]
model_id = "kimi-k2"
"#
        .parse()
        .unwrap();
        let chat = table.get("chat").and_then(|v| v.as_table());
        ctx.config.models =
            shore_common::config::models::ModelCatalog::from_sections(chat, None, None).unwrap();

        write_test_cache(
            &ctx.config.dirs.cache,
            "openrouter",
            vec![discovered_fixture(
                "openrouter",
                "anthropic/claude-3.5-sonnet",
            )],
        );

        let out = list_provider_models(&ctx, &json!({ "provider": "openrouter" })).unwrap();
        assert_eq!(field(&out, "provider"), "openrouter");
        assert_eq!(array_field(&out, "discovered").len(), 1);
        let static_models = array_field(&out, "static");
        assert_eq!(static_models.len(), 1);
        assert_eq!(field(item(static_models, 0), "model_id"), "kimi-k2");
        // Contract: static entries expose the renamed output-budget key and
        // never the old `max_tokens` (renamed; no backward-compatible alias).
        assert!(
            item(static_models, 0).get("max_output_tokens").is_some(),
            "static model JSON must expose `max_output_tokens`"
        );
        assert!(
            item(static_models, 0).get("max_tokens").is_none(),
            "static model JSON must not expose the old `max_tokens` key"
        );
        assert_eq!(
            field(item(array_field(&out, "discovered"), 0), "model_id"),
            "anthropic/claude-3.5-sonnet"
        );
    }

    #[test]
    fn list_provider_models_returns_static_when_cache_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
"#,
        );
        let table: toml::Table = r#"
[chat.openrouter.kimi]
model_id = "kimi-k2"
"#
        .parse()
        .unwrap();
        ctx.config.models = shore_common::config::models::ModelCatalog::from_sections(
            table.get("chat").and_then(|v| v.as_table()),
            None,
            None,
        )
        .unwrap();

        let out = list_provider_models(&ctx, &json!({ "provider": "openrouter" })).unwrap();
        assert!(array_field(&out, "discovered").is_empty());
        assert_eq!(array_field(&out, "static").len(), 1);
        assert_eq!(field(field(&out, "cache"), "model_count"), 0);
    }

    // ── ignore filtering ────────────────────────────────────────────────

    fn build_ctx_with_ignore(tmp: &tempfile::TempDir, ignore: &[&str]) -> CommandContext {
        use std::fmt::Write as _;

        let mut v = String::new();
        for p in ignore {
            let _ignored = writeln!(&mut v, "  {p:?},");
        }
        let toml_str = format!(
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"

[providers.openrouter.discovery]
enabled = true
ignore = [
{v}]
"#,
        );
        build_ctx_with_registry(tmp, &toml_str)
    }

    fn cache_with_models(cache_dir: &Path, provider: &str, ids: &[&str]) {
        let models = ids
            .iter()
            .map(|id| discovered_fixture(provider, id))
            .collect();
        write_test_cache(cache_dir, provider, models);
    }

    #[test]
    fn ignore_hides_matching_pattern() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_ignore(&tmp, &["meta-llama/*"]);
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &[
                "anthropic/claude-3.5-sonnet",
                "meta-llama/llama-3-405b",
                "openai/gpt-4o",
            ],
        );

        let out = list_provider_models(&ctx, &json!({ "provider": "openrouter" })).unwrap();
        let discovered = array_field(&out, "discovered");
        let hidden = array_field(&out, "hidden");
        let dids: Vec<&str> = discovered
            .iter()
            .map(|m| field(m, "model_id").as_str().unwrap())
            .collect();
        let hids: Vec<&str> = hidden
            .iter()
            .map(|m| field(m, "model_id").as_str().unwrap())
            .collect();
        assert!(dids.contains(&"anthropic/claude-3.5-sonnet"));
        assert!(dids.contains(&"openai/gpt-4o"));
        assert!(!dids.contains(&"meta-llama/llama-3-405b"));
        assert_eq!(hids, vec!["meta-llama/llama-3-405b"]);
    }

    #[test]
    fn ignore_star_then_negate_shows_only_anthropic() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_ignore(&tmp, &["*", "!anthropic/*"]);
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &[
                "anthropic/claude-3.5-sonnet",
                "meta-llama/llama-3-405b",
                "openai/gpt-4o",
            ],
        );

        let out = list_provider_models(&ctx, &json!({ "provider": "openrouter" })).unwrap();
        let dids: Vec<&str> = array_field(&out, "discovered")
            .iter()
            .map(|m| field(m, "model_id").as_str().unwrap())
            .collect();
        assert_eq!(dids, vec!["anthropic/claude-3.5-sonnet"]);
        assert_eq!(array_field(&out, "hidden").len(), 2);
    }

    #[test]
    fn ignore_last_match_wins_at_command_level() {
        // Hide all anthropic, then un-hide a single id. Last match wins.
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_ignore(&tmp, &["anthropic/*", "!anthropic/claude-3.5-sonnet"]);
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &[
                "anthropic/claude-3.5-sonnet",
                "anthropic/claude-3-haiku",
                "openai/gpt-4o",
            ],
        );

        let out = list_provider_models(&ctx, &json!({ "provider": "openrouter" })).unwrap();
        let dids: Vec<&str> = array_field(&out, "discovered")
            .iter()
            .map(|m| field(m, "model_id").as_str().unwrap())
            .collect();
        let hids: Vec<&str> = array_field(&out, "hidden")
            .iter()
            .map(|m| field(m, "model_id").as_str().unwrap())
            .collect();
        assert!(dids.contains(&"anthropic/claude-3.5-sonnet"));
        assert!(dids.contains(&"openai/gpt-4o"));
        assert_eq!(hids, vec!["anthropic/claude-3-haiku"]);
    }

    #[test]
    fn hidden_models_remain_in_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_ignore(&tmp, &["meta-llama/*"]);
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &["meta-llama/llama-3-405b", "anthropic/claude-3.5-sonnet"],
        );

        // Even though one model is hidden, the cache file still contains both.
        let path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, "openrouter");
        let cache = crate::llm::discovery::read_cache(&path).unwrap().unwrap();
        assert_eq!(cache.models.len(), 2);
    }

    #[test]
    fn include_hidden_returns_filtered_models_in_main_list() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_ignore(&tmp, &["meta-llama/*"]);
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &["meta-llama/llama-3-405b", "anthropic/claude-3.5-sonnet"],
        );

        let out = list_provider_models(
            &ctx,
            &json!({ "provider": "openrouter", "include_hidden": true }),
        )
        .unwrap();
        assert_eq!(array_field(&out, "discovered").len(), 2);
        assert!(array_field(&out, "hidden").is_empty());
        assert_eq!(field(&out, "include_hidden"), true);
    }

    #[test]
    fn static_models_not_filtered_by_ignore() {
        // Even with a wildcard hide-all rule, manual `[chat.<provider>.<...>]`
        // entries must remain visible — they are intentional.
        let tmp = tempfile::tempdir().unwrap();
        let mut ctx = build_ctx_with_ignore(&tmp, &["*"]);
        let table: toml::Table = r#"
[chat.openrouter.kimi]
model_id = "kimi-k2"
"#
        .parse()
        .unwrap();
        ctx.config.models = shore_common::config::models::ModelCatalog::from_sections(
            table.get("chat").and_then(|v| v.as_table()),
            None,
            None,
        )
        .unwrap();
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &["meta-llama/llama-3-405b"],
        );

        let out = list_provider_models(&ctx, &json!({ "provider": "openrouter" })).unwrap();
        // Discovered hidden by the "*" rule.
        assert!(array_field(&out, "discovered").is_empty());
        assert_eq!(array_field(&out, "hidden").len(), 1);
        // Static model still surfaced.
        let static_models = array_field(&out, "static");
        assert_eq!(static_models.len(), 1);
        assert_eq!(field(item(static_models, 0), "model_id"), "kimi-k2");
    }

    #[test]
    fn list_providers_reports_hidden_count() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_ignore(&tmp, &["meta-llama/*"]);
        cache_with_models(
            &ctx.config.dirs.cache,
            "openrouter",
            &[
                "meta-llama/llama-3-405b",
                "meta-llama/llama-3-70b",
                "anthropic/claude-3.5-sonnet",
            ],
        );

        let out = list_providers(&ctx).unwrap();
        let provider = item(array_field(&out, "providers"), 0);
        let cache = field(provider, "cache");
        assert_eq!(field(cache, "models"), 3);
        assert_eq!(field(cache, "visible"), 1);
        assert_eq!(field(cache, "hidden"), 2);
    }

    #[test]
    fn list_provider_models_unknown_provider_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(&tmp, "");
        let err = list_provider_models(&ctx, &json!({ "provider": "ghost" })).unwrap_err();
        assert_eq!(err.0, ErrorCode::NotFound);
    }

    #[test]
    fn list_provider_models_missing_arg() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(&tmp, "");
        let err = list_provider_models(&ctx, &json!({})).unwrap_err();
        assert_eq!(err.0, ErrorCode::InvalidRequest);
    }

    // ── refresh_provider_models ─────────────────────────────────────────

    #[tokio::test]
    async fn refresh_unknown_provider_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(&tmp, "");
        let err = refresh_provider_models(&ctx, &json!({ "provider": "ghost" }))
            .await
            .unwrap_err();
        assert_eq!(err.0, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn refresh_disabled_provider_is_invalid_request() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.openrouter]
enabled = false
api_key_env = "OR_KEY"
"#,
        );
        let err = refresh_provider_models(&ctx, &json!({ "provider": "openrouter" }))
            .await
            .unwrap_err();
        assert_eq!(err.0, ErrorCode::InvalidRequest);
        assert!(err.1.contains("disabled"));
    }

    #[tokio::test]
    async fn refresh_discovery_disabled_is_invalid_request() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://example.test/v1"

[providers.openrouter.discovery]
enabled = false
"#,
        );
        let err = refresh_provider_models(&ctx, &json!({ "provider": "openrouter" }))
            .await
            .unwrap_err();
        assert_eq!(err.0, ErrorCode::InvalidRequest);
        assert!(err.1.contains("discovery"));
    }

    #[tokio::test]
    async fn refresh_well_known_provider_falls_back_to_default_base_url() {
        // openrouter has a well-known base_url default; omitting it from
        // the registry must not block discovery. The refresh proceeds
        // past the base_url check and fails later on missing key — that
        // failure point is what proves the default kicked in.
        let tmp = tempfile::tempdir().unwrap();
        let unique = format!("PROV_TEST_DEFAULT_BASE_{}", std::process::id());
        std::env::remove_var(&unique);
        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[[providers.openrouter.keys]]
name = "main"
env = "{unique}"

[providers.openrouter.discovery]
enabled = true
"#
            ),
        );
        let err = refresh_provider_models(&ctx, &json!({ "provider": "openrouter" }))
            .await
            .unwrap_err();
        // No base_url set, but openrouter has a default → we reach the
        // key check instead of the base_url check.
        assert_eq!(err.0, ErrorCode::ProviderError);
        assert!(
            !err.1.contains("base_url"),
            "expected default to kick in; got: {}",
            err.1
        );
    }

    #[tokio::test]
    async fn refresh_unknown_provider_without_base_url_still_errors() {
        // Custom provider keys (no well-known default) must still get the
        // explicit "no base_url" error so users know they have to set it.
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.opencode]
api_key_env = "OC_KEY"

[providers.opencode.discovery]
enabled = true
"#,
        );
        let err = refresh_provider_models(&ctx, &json!({ "provider": "opencode" }))
            .await
            .unwrap_err();
        assert_eq!(err.0, ErrorCode::InvalidRequest);
        assert!(err.1.contains("base_url"));
    }

    #[tokio::test]
    async fn refresh_with_no_keys_set_is_unauthorized() {
        let tmp = tempfile::tempdir().unwrap();
        let unique = format!("PROV_TEST_NOKEY_{}", std::process::id());
        // Make sure it's not set.
        std::env::remove_var(&unique);
        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[providers.openrouter]
base_url = "https://example.test/v1"

[[providers.openrouter.keys]]
name = "main"
env = "{unique}"

[providers.openrouter.discovery]
enabled = true
"#
            ),
        );
        let err = refresh_provider_models(&ctx, &json!({ "provider": "openrouter" }))
            .await
            .unwrap_err();
        assert_eq!(err.0, ErrorCode::ProviderError);
    }

    #[tokio::test]
    async fn refresh_failure_preserves_previous_cache() {
        // Pre-populate a cache, then run a refresh that fails because the
        // server returns 500. The old cache must remain on disk.
        let tmp = tempfile::tempdir().unwrap();
        let unique = format!("PROV_TEST_FAILKEEP_{}", std::process::id());
        std::env::set_var(&unique, "sk-test");

        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v1/models"))
            .respond_with(wiremock::ResponseTemplate::new(500).set_body_string("server boom"))
            .mount(&mock)
            .await;

        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[providers.upstream]
base_url = "{base}/v1"

[[providers.upstream.keys]]
name = "main"
env = "{unique}"

[providers.upstream.discovery]
enabled = true
"#,
                base = mock.uri()
            ),
        );

        let prior = vec![discovered_fixture("upstream", "kept-after-failure")];
        write_test_cache(&ctx.config.dirs.cache, "upstream", prior.clone());

        let err = refresh_provider_models(&ctx, &json!({ "provider": "upstream" }))
            .await
            .unwrap_err();
        assert_eq!(err.0, ErrorCode::InternalError);

        let path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, "upstream");
        let still_there = crate::llm::discovery::read_cache(&path)
            .unwrap()
            .expect("cache present");
        assert_eq!(
            still_there.models, prior,
            "previous cache must survive failed refresh"
        );

        std::env::remove_var(&unique);
        // Silence the unused warning.
        let _ignored = ServerMessage::Error(shore_common::protocol::server_msg::Error {
            rid: None,
            code: ErrorCode::InternalError,
            message: String::new(),
        });
    }

    #[tokio::test]
    async fn refresh_writes_cache_and_returns_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let unique = format!("PROV_TEST_REFRESH_{}", std::process::id());
        std::env::set_var(&unique, "sk-fixture");

        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "openai/gpt-4o", "object": "model", "owned_by": "openai" },
                { "id": "anthropic/claude-3.5-sonnet", "object": "model", "context_length": 200_000 }
            ]
        });
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v1/models"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(&body))
            .mount(&mock)
            .await;

        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[providers.upstream]
base_url = "{base}/v1"

[[providers.upstream.keys]]
name = "main"
env = "{unique}"

[providers.upstream.discovery]
enabled = true
"#,
                base = mock.uri()
            ),
        );

        let out = refresh_provider_models(&ctx, &json!({ "provider": "upstream" }))
            .await
            .unwrap();
        assert_eq!(field(&out, "model_count"), 2);
        assert_eq!(field(&out, "provider"), "upstream");

        // Cache file is on disk and contains both models.
        let path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, "upstream");
        let cache = crate::llm::discovery::read_cache(&path)
            .unwrap()
            .expect("cache");
        assert_eq!(cache.models.len(), 2);
        assert!(cache
            .models
            .iter()
            .any(|m| m.model_id == "anthropic/claude-3.5-sonnet"));
        assert_eq!(item(&cache.models, 1).context_length, Some(200_000));

        std::env::remove_var(&unique);
    }

    #[tokio::test]
    async fn refresh_anthropic_uses_native_models_api() {
        let tmp = tempfile::tempdir().unwrap();
        let unique = format!("PROV_TEST_ANTHROPIC_REFRESH_{}", std::process::id());
        std::env::set_var(&unique, "sk-ant-fixture");

        let body = serde_json::json!({
            "data": [{
                "created_at": "2025-05-14T00:00:00Z",
                "display_name": "Claude Sonnet 4",
                "id": "claude-sonnet-4-20250514",
                "type": "model"
            }],
            "has_more": false
        });
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v1/models"))
            .and(wiremock::matchers::header("x-api-key", "sk-ant-fixture"))
            .and(wiremock::matchers::header(
                "anthropic-version",
                "2023-06-01",
            ))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(&body))
            .mount(&mock)
            .await;

        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[providers.anthropic]
base_url = "{base}"

[[providers.anthropic.keys]]
name = "main"
env = "{unique}"

[providers.anthropic.discovery]
enabled = true
"#,
                base = mock.uri()
            ),
        );

        let out = refresh_provider_models(&ctx, &json!({ "provider": "anthropic" }))
            .await
            .unwrap();
        assert_eq!(field(&out, "model_count"), 1);

        let path = crate::llm::discovery::cache_path(&ctx.config.dirs.cache, "anthropic");
        let cache = crate::llm::discovery::read_cache(&path)
            .unwrap()
            .expect("cache");
        assert_eq!(item(&cache.models, 0).model_id, "claude-sonnet-4-20250514");
        assert_eq!(
            item(&cache.models, 0).display_name.as_deref(),
            Some("Claude Sonnet 4")
        );
        assert_eq!(item(&cache.models, 0).sdk, "anthropic");

        std::env::remove_var(&unique);
    }

    // ── refresh_all_provider_models ─────────────────────────────────────

    #[tokio::test]
    async fn refresh_all_skips_disabled_and_discovery_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(
            &tmp,
            r#"
[providers.alpha]
enabled = false
api_key_env = "ALPHA_KEY"

[providers.beta]
api_key_env = "BETA_KEY"
base_url = "https://example.test/v1"

[providers.beta.discovery]
enabled = false
"#,
        );

        let out = refresh_all_provider_models(&ctx).await.unwrap();
        let skipped = array_field(&out, "skipped");
        let reasons: std::collections::BTreeMap<&str, &str> = skipped
            .iter()
            .map(|s| {
                (
                    field(s, "provider").as_str().unwrap(),
                    field(s, "reason").as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(reasons.get("alpha").copied(), Some("disabled"));
        assert_eq!(reasons.get("beta").copied(), Some("discovery disabled"));
        assert!(array_field(&out, "results").is_empty());
    }

    #[tokio::test]
    async fn refresh_all_continues_after_one_provider_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let good_key = format!("PROV_TEST_REFRESH_ALL_GOOD_{}", std::process::id());
        let bad_key = format!("PROV_TEST_REFRESH_ALL_BAD_{}", std::process::id());
        std::env::set_var(&good_key, "sk-fixture");
        std::env::remove_var(&bad_key);

        let body = serde_json::json!({
            "object": "list",
            "data": [{ "id": "good/m1", "object": "model" }]
        });
        let mock = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v1/models"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(&body))
            .mount(&mock)
            .await;

        let ctx = build_ctx_with_registry(
            &tmp,
            &format!(
                r#"
[providers.good]
base_url = "{base}/v1"

[[providers.good.keys]]
name = "main"
env = "{good_key}"

[providers.good.discovery]
enabled = true

[providers.bad]
base_url = "https://example.test/v1"

[[providers.bad.keys]]
name = "main"
env = "{bad_key}"

[providers.bad.discovery]
enabled = true
"#,
                base = mock.uri()
            ),
        );

        let out = refresh_all_provider_models(&ctx).await.unwrap();
        let results = array_field(&out, "results");
        let by_name: std::collections::BTreeMap<&str, &Value> = results
            .iter()
            .map(|r| (field(r, "provider").as_str().unwrap(), r))
            .collect();
        let good = by_name.get("good").expect("good result");
        let bad = by_name.get("bad").expect("bad result");
        assert_eq!(field(good, "ok"), true);
        assert_eq!(field(good, "model_count"), 1);
        assert_eq!(field(bad, "ok"), false);
        assert!(field(bad, "error").as_str().unwrap().contains("API key"));
        assert!(array_field(&out, "skipped").is_empty());

        std::env::remove_var(&good_key);
    }

    #[tokio::test]
    async fn refresh_all_empty_registry_returns_empty_lists() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = build_ctx_with_registry(&tmp, "");
        let out = refresh_all_provider_models(&ctx).await.unwrap();
        assert!(array_field(&out, "results").is_empty());
        assert!(array_field(&out, "skipped").is_empty());
    }
}
