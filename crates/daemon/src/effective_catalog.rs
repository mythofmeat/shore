//! Effective model catalog — Phase 7.
//!
//! Merges three sources into the catalog the daemon resolves against:
//!
//! 1. The static `[chat.<provider>.<model>]` model catalog (Phase 0).
//! 2. The provider registry (Phase 1) plus its on-disk discovery cache
//!    (Phase 5/6) for discovered models.
//! 3. (Saved sampler preferences are applied separately at request time
//!    via [`crate::preferences::apply_sampler_overlay`]; this module
//!    only resolves identity + transport metadata.)
//!
//! Conflict rules (mirrors the plan):
//!
//! * Static catalog entries always win when matched by short or qualified
//!   name (existing `find_model` behavior is preserved verbatim).
//! * When a discovered model and a static entry share the same
//!   `(provider, model_id)`, the static entry wins for explicit fields —
//!   discovered metadata only fills in for providers without a static
//!   override. We achieve this by checking static-by-upstream-id before
//!   constructing a synthetic `ResolvedModel` from the discovered record.
//! * Static catalog entries are never affected by `discovery.ignore`
//!   rules; only discovered models can be hidden.

use std::path::Path;

use crate::llm::discovery::{cache_path, read_cache, DiscoveredModel};
use shore_common::config::models::{
    default_sdk, hardcoded_provider_defaults, ModelCatalog, ModelConfigFields, ResolvedModel, Sdk,
};
use shore_common::config::providers::ProviderEntry;
use shore_common::config::LoadedConfig;

#[derive(Debug, thiserror::Error)]
pub enum EffectiveCatalogError {
    #[error("model {name:?} not found in static catalog or discovered models")]
    NotFound { name: String },

    #[error("model name {name:?} is ambiguous across providers: {locations}")]
    Ambiguous { name: String, locations: String },

    #[error(
        "model {name:?} is hidden by [providers.{provider}.discovery.ignore]; \
         pass include_hidden=true or update the ignore rules to allow it"
    )]
    Hidden { name: String, provider: String },
}

/// Where an effective-catalog entry came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveSource {
    Static,
    Discovered,
}

/// One row of the merged catalog as surfaced to clients.
#[derive(Debug, Clone)]
pub struct EffectiveModel {
    pub source: EffectiveSource,
    pub resolved: ResolvedModel,
    /// True if `discovery.ignore` rules would normally hide this model.
    /// Static entries are always `false` here.
    pub hidden: bool,
}

/// Look up a model by name across the static catalog and provider
/// discovery caches.
///
/// Resolution order:
///
/// 1. Static catalog by short or qualified name (existing behavior).
/// 2. Provider-prefixed form `provider:model_id`. The provider must be in
///    the registry and enabled. For an enabled provider, a legacy static
///    `[chat.*]` entry sharing the same `(provider, model_id)` still wins this
///    cycle (deprecation window — #139); otherwise a discovery-cache record is
///    used when available, and failing that the `model_id` is trusted as-given
///    and routed via the provider's transport (no discovery required — #136).
/// 3. Bare upstream `model_id`. Searched across every registered *enabled*
///    provider's cache. If multiple providers carry the same id, returns
///    `Ambiguous` so the caller can disambiguate with `provider:id`.
///
/// A disabled provider is *uniformly* unreferenceable (#139): neither its
/// trusted/discovered models nor its legacy static `[chat.*]` entries resolve
/// through paths 2 or 3.
///
/// `include_hidden = true` permits resolving discovered models matched by
/// `discovery.ignore` patterns. Static entries are never hidden.
pub fn find_effective_model(
    config: &LoadedConfig,
    cache_dir: &Path,
    name: &str,
    include_hidden: bool,
) -> Result<ResolvedModel, EffectiveCatalogError> {
    if let Ok(m) = config.models.find_model(name) {
        return Ok(m.clone());
    }

    if let Some((provider, model_id)) = name.split_once(':') {
        if let Some(result) =
            resolve_provider_prefixed(config, cache_dir, name, provider, model_id, include_hidden)
        {
            return result;
        }
    }

    // Bare upstream id: collect matches across all providers. Static
    // entries are always considered; discovered matches require both
    // provider.enabled and discovery.enabled.
    let mut hits: Vec<(String, ResolvedModel, bool)> = Vec::new();
    for (provider_key, entry) in config.providers.iter() {
        // A disabled provider is uniformly unreferenceable (#139), including by
        // its legacy static `[chat.*]` entries — gate before the static check.
        if !entry.enabled {
            continue;
        }
        if let Some(static_match) = find_static_by_upstream(&config.models, provider_key, name) {
            hits.push((provider_key.into(), static_match.clone(), false));
            continue;
        }
        if !entry.discovery.enabled {
            continue;
        }
        let Some(disc) = read_provider_discovery(cache_dir, provider_key, name) else {
            continue;
        };
        let hidden = !entry.discovery.is_visible(&disc.model_id);
        let resolved =
            build_resolved_from_provider(provider_key, entry, &disc.model_id, Some(&disc));
        hits.push((provider_key.into(), resolved, hidden));
    }

    // Hidden hits don't participate in the ambiguity count unless the
    // caller explicitly opted in. A single hidden-only match still
    // surfaces as `Hidden` (clearer than `NotFound`).
    let (visible_hits, hidden_hits): (Vec<_>, Vec<_>) = if include_hidden {
        (hits, Vec::new())
    } else {
        hits.into_iter().partition(|(_, _, h)| !*h)
    };

    match visible_hits.len() {
        0 => {
            if let Some((provider, _, _)) = hidden_hits.into_iter().next() {
                Err(EffectiveCatalogError::Hidden {
                    name: name.into(),
                    provider,
                })
            } else {
                Err(EffectiveCatalogError::NotFound { name: name.into() })
            }
        }
        1 => {
            let Some((_, resolved, _)) = visible_hits.into_iter().next() else {
                return Err(EffectiveCatalogError::NotFound { name: name.into() });
            };
            Ok(resolved)
        }
        _ => {
            let locations = visible_hits
                .iter()
                .map(|(p, r, _)| format!("{p}:{}", r.model_id))
                .collect::<Vec<_>>()
                .join(", ");
            Err(EffectiveCatalogError::Ambiguous {
                name: name.into(),
                locations,
            })
        }
    }
}

/// List the merged catalog: every static chat model plus every discovered
/// model. Discovered models are deduplicated against static entries with
/// the same `(provider, model_id)` — only one row appears, sourced from
/// the static side.
///
/// `include_hidden = false` (the default) drops discovered rows hidden by
/// `discovery.ignore` rules. Static rows are always included.
pub fn list_effective_models(
    config: &LoadedConfig,
    cache_dir: &Path,
    include_hidden: bool,
) -> Vec<EffectiveModel> {
    let mut out: Vec<EffectiveModel> = config
        .models
        .chat
        .values()
        .map(|m| EffectiveModel {
            source: EffectiveSource::Static,
            resolved: m.clone(),
            hidden: false,
        })
        .collect();

    for (provider_key, entry) in config.providers.iter() {
        if !entry.enabled || !entry.discovery.enabled {
            continue;
        }
        let cache_p = cache_path(cache_dir, provider_key);
        let Some(cache) = read_cache(&cache_p).ok().flatten() else {
            continue;
        };
        // Discovery caches preserve the provider's raw `/v1/models` order,
        // which is effectively arbitrary. Sort by upstream id so each
        // provider's block lists alphabetically (static entries above are
        // already ordered by the BTreeMap key).
        let mut discovered: Vec<&DiscoveredModel> = cache.models.iter().collect();
        discovered.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        for disc in discovered {
            if find_static_by_upstream(&config.models, provider_key, &disc.model_id).is_some() {
                continue;
            }
            let hidden = !entry.discovery.is_visible(&disc.model_id);
            if hidden && !include_hidden {
                continue;
            }
            let resolved =
                build_resolved_from_provider(provider_key, entry, &disc.model_id, Some(disc));
            out.push(EffectiveModel {
                source: EffectiveSource::Discovered,
                resolved,
                hidden,
            });
        }
    }
    out
}

// ── Internals ───────────────────────────────────────────────────────────

fn read_provider_discovery(
    cache_dir: &Path,
    provider_key: &str,
    model_id: &str,
) -> Option<DiscoveredModel> {
    let cache = read_cache(&cache_path(cache_dir, provider_key))
        .ok()
        .flatten()?;
    cache.models.into_iter().find(|m| m.model_id == model_id)
}

/// Resolve the provider-prefixed form `provider:model_id`.
///
/// Returns `Some(result)` when the named provider is registered *and enabled*
/// — the lookup is authoritative from there (a resolved model or `Hidden`).
/// Returns `None` when the prefix is malformed, the provider isn't registered,
/// or the provider is disabled, so the caller falls through to the
/// bare-upstream-id search (which then yields `NotFound`).
fn resolve_provider_prefixed(
    config: &LoadedConfig,
    cache_dir: &Path,
    name: &str,
    provider: &str,
    model_id: &str,
    include_hidden: bool,
) -> Option<Result<ResolvedModel, EffectiveCatalogError>> {
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }
    let entry = config.providers.get(provider)?;

    // A disabled provider is *uniformly* unreferenceable (#139) — never trust a
    // stale cache, route to a provider the user turned off, or resolve a legacy
    // static `[chat.*]` entry sitting under it. This gate runs before the
    // static-by-upstream check so disabling a provider hides its statics too.
    if !entry.enabled {
        return None;
    }

    // For an enabled provider, a legacy static `[chat.<provider>.*]` entry that
    // shares this `(provider, model_id)` still wins this cycle, so its
    // hand-configured fields are honored over the trusted/discovered build
    // (deprecation window — see `parse_category`).
    if let Some(static_match) = find_static_by_upstream(&config.models, provider, model_id) {
        return Some(Ok(static_match.clone()));
    }

    let hidden_err = || {
        Err(EffectiveCatalogError::Hidden {
            name: name.into(),
            provider: provider.into(),
        })
    };

    if entry.discovery.enabled {
        // Prefer a cached discovery record (richer upstream metadata) and
        // honor `discovery.ignore` visibility.
        if let Some(disc) = read_provider_discovery(cache_dir, provider, model_id) {
            if !entry.discovery.is_visible(&disc.model_id) && !include_hidden {
                return Some(hidden_err());
            }
            return Some(Ok(build_resolved_from_provider(
                provider,
                entry,
                &disc.model_id,
                Some(&disc),
            )));
        }
        // Not in the cache, but an explicitly-ignored id stays hidden so
        // qualified refs can't bypass `discovery.ignore` (matches the
        // cached-and-hidden behavior above).
        if !entry.discovery.is_visible(model_id) && !include_hidden {
            return Some(hidden_err());
        }
    }

    // Trust a fully-qualified `provider:model_id` on an enabled provider even
    // without a discovery record: route transport from `[providers.<provider>]`
    // and take `model_id` as given. This keeps models on discovery-off
    // providers referenceable once the static `[chat.*]` catalog is retired
    // (#136).
    Some(Ok(build_resolved_from_provider(
        provider, entry, model_id, None,
    )))
}

fn find_static_by_upstream<'cat>(
    catalog: &'cat ModelCatalog,
    provider: &str,
    model_id: &str,
) -> Option<&'cat ResolvedModel> {
    catalog
        .chat
        .values()
        .find(|m| m.provider_key == provider && m.model_id == model_id)
}

/// Build a `ResolvedModel` for a `provider:model_id` reference, routing
/// transport from the provider registry entry.
///
/// When a discovery record is supplied (`disc = Some`), its upstream metadata
/// (SDK hint, base_url, context/output limits) fills fields the provider entry
/// leaves unset. With `disc = None` the `model_id` is trusted as-given and only
/// provider/hardcoded defaults apply — the path that keeps models on a
/// discovery-off provider referenceable after the static `[chat.*]` catalog is
/// retired (#136).
///
/// `[providers.<provider>.defaults]` (the rehomed provider-level behavioral and
/// vendor defaults — #137) is applied last, so it wins over discovered/hardcoded
/// metadata, mirroring the static cascade.
fn build_resolved_from_provider(
    provider_key: &str,
    entry: &ProviderEntry,
    model_id: &str,
    disc: Option<&DiscoveredModel>,
) -> ResolvedModel {
    let provider_defaults = hardcoded_provider_defaults(provider_key).fields;

    // Mirror the `anthropic/*` auto-promotion that fires on static
    // `[chat.<provider>.<model>]` entries in `ResolvedModel::from_parts`.
    // OpenRouter's discovery feed reports `sdk = "openai"` for every model,
    // so without this an `anthropic/*` slug under a registry that omits
    // `sdk = "anthropic"` would land on `Sdk::Openai` and miss prompt
    // caching. Only fires when the user hasn't pinned an SDK on the
    // provider entry — explicit config still wins.
    //
    // The curated hardcoded provider default (e.g. `openrouter → Openrouter`,
    // `zai → Zai`) is preferred over the discovery feed's `disc.sdk`, because
    // openai-compatible discovery stamps a blanket `"openai"` for every model
    // and so carries no real per-model signal. This keeps the discovered path
    // consistent with the static path, where the hardcoded default fills `sdk`.
    // A provider with no hardcoded default falls through to `disc.sdk` (when a
    // discovery record is present), then to `default_sdk`.
    let sdk = entry
        .sdk
        .clone()
        .or_else(|| model_id.starts_with("anthropic/").then_some(Sdk::Anthropic))
        .or_else(|| provider_defaults.sdk.clone())
        .or_else(|| disc.and_then(|d| Sdk::parse_wire(&d.sdk)))
        .unwrap_or_else(|| default_sdk(provider_key));

    let base_url = entry
        .base_url
        .clone()
        .or_else(|| disc.and_then(|d| d.base_url.clone()))
        .or_else(|| provider_defaults.base_url.clone());

    let max_context_tokens = disc
        .and_then(|d| d.context_length)
        .and_then(|v| u32::try_from(v).ok())
        .or(provider_defaults.max_context_tokens);

    let max_output_tokens = disc
        .and_then(|d| d.max_output_tokens)
        .and_then(|v| u32::try_from(v).ok())
        .or(provider_defaults.max_output_tokens);

    // Canonical identity for a discovered/trusted model is `provider:model_id`
    // (#139) — not the retired `chat.<provider>.<model_id>` static-catalog
    // cosplay. Unlike that synthetic name, this round-trips back through
    // `find_effective_model` cleanly.
    let qualified_name = format!("{provider_key}:{model_id}");

    let mut fields = ModelConfigFields {
        sdk: Some(sdk.clone()),
        api_key_env: None,
        base_url,
        max_context_tokens,
        max_output_tokens,
        temperature: provider_defaults.temperature,
        top_p: None,
        reasoning_effort: None,
        budget_tokens: None,
        cache_ttl: None,
        cache_keepalive: None,
        openrouter_provider: None,
        gemini_generation: None,
        zai_clear_thinking: provider_defaults.zai_clear_thinking,
        zai_subscription: None,
    };

    // Apply `[providers.<provider>.defaults]` last, so it wins over discovered
    // upstream metadata — the same "user config wins" precedence the static
    // cascade gives. This carries routing (`openrouter_provider`), `cache_ttl`,
    // sampler knobs, etc. that the discovery feed never reports. Unset fields
    // fall through to the discovered/hardcoded values built above.
    fields.merge_from(&entry.defaults);

    // The overlay may have changed `sdk`; `from_parts` reads it from `fields`
    // when present, so pass the (possibly overridden) value as the fallback too.
    let sdk_fallback = fields.sdk.clone().unwrap_or(sdk);

    ResolvedModel::from_parts(
        model_id.to_owned(),
        qualified_name,
        "chat".into(),
        provider_key.into(),
        model_id.to_owned(),
        sdk_fallback,
        fields,
    )
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    use crate::llm::discovery::{ProviderModelsCache, CACHE_VERSION};
    use shore_common::config::models::ModelCatalog;
    use shore_common::config::providers::ProviderRegistry;
    use shore_common::config::ShoreDirs;

    macro_rules! assert_variant {
        ($value:expr, $pattern:pat => $body:expr $(,)?) => {{
            let $pattern = $value else {
                panic!("expected enum variant did not match");
            };
            $body
        }};
    }

    fn make_loaded(tmp: &tempfile::TempDir, providers_toml: &str, chat_toml: &str) -> LoadedConfig {
        // Caches in production only exist after a successful refresh, which
        // requires discovery.enabled = true. Mirror that invariant for tests:
        // any provider without an explicit discovery block gets enabled = true,
        // so cache writes match real-world conditions. Tests that need the
        // disabled-discovery path set `[providers.X.discovery] enabled = false`
        // explicitly.
        let providers = if providers_toml.is_empty() {
            ProviderRegistry::default()
        } else {
            let mut table: toml::Table = providers_toml.parse().unwrap();
            if let Some(providers_table) = table.get_mut("providers").and_then(|v| v.as_table_mut())
            {
                for (_, value) in providers_table.iter_mut() {
                    if let Some(provider_entry) = value.as_table_mut() {
                        let needs_discovery = !provider_entry.contains_key("discovery");
                        if needs_discovery {
                            let mut disc = toml::Table::new();
                            let _ignored =
                                disc.insert("enabled".into(), toml::Value::Boolean(true));
                            _ = provider_entry.insert("discovery".into(), toml::Value::Table(disc));
                        }
                    }
                }
            }
            ProviderRegistry::from_section(table.get("providers").and_then(|v| v.as_table()))
                .unwrap()
        };
        let catalog = if chat_toml.is_empty() {
            ModelCatalog::default()
        } else {
            let table: toml::Table = chat_toml.parse().unwrap();
            ModelCatalog::from_sections(table.get("chat").and_then(|v| v.as_table()), None, None)
                .unwrap()
        };
        let mut loaded = LoadedConfig::new_for_test(
            shore_common::config::app::AppConfig::default(),
            catalog,
            ShoreDirs {
                config: tmp.path().join("config"),
                data: tmp.path().to_path_buf(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );
        loaded.providers = providers;
        loaded
    }

    fn write_cache_for(tmp: &tempfile::TempDir, provider: &str, model_ids: &[&str]) {
        let models = model_ids
            .iter()
            .map(|id| DiscoveredModel {
                provider_key: provider.into(),
                model_id: (*id).into(),
                display_name: None,
                sdk: "openai".into(),
                base_url: Some("https://example.test/v1".into()),
                created_at: None,
                owned_by: None,
                description: None,
                context_length: Some(200_000),
                max_output_tokens: Some(8192),
                supports_tools: None,
                supports_images: None,
                supports_reasoning: None,
                supports_prompt_cache: None,
                raw_provider_metadata: serde_json::Value::Null,
                discovered_at: "2026-04-29T00:00:00Z".into(),
            })
            .collect();
        let cache = ProviderModelsCache {
            version: CACHE_VERSION,
            provider_key: provider.into(),
            fetched_at: "2026-04-29T00:00:00Z".into(),
            base_url: Some("https://example.test/v1".into()),
            models,
        };
        let path = cache_path(tmp.path(), provider);
        crate::llm::discovery::write_cache(&path, &cache).unwrap();
    }

    // ── find_effective_model ────────────────────────────────────────────

    #[test]
    fn discovered_model_selectable_by_bare_id() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap();
        assert_eq!(m.provider_key, "openrouter");
        assert_eq!(m.model_id, "anthropic/claude-sonnet-4.5");
        assert_eq!(m.qualified_name, "openrouter:anthropic/claude-sonnet-4.5");
        assert_eq!(m.max_context_tokens, Some(200_000));
        // Discovered models inherit the registry's base_url.
        assert_eq!(m.base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
    }

    #[test]
    fn discovered_qualified_name_round_trips_through_resolver() {
        // A discovered/trusted model's `qualified_name` is now the canonical
        // `provider:model_id` identity (#139), not the retired
        // `chat.<provider>.<model_id>` cosplay. Unlike that synthetic name,
        // feeding it back into `find_effective_model` resolves cleanly — this
        // pins the round-trip so the old footgun (a qualified_name that
        // silently NotFound-ed when re-resolved, breaking chat after
        // `switch_model` to a discovered model) cannot return.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:anthropic/claude-sonnet-4.5",
            true,
        )
        .unwrap();
        assert_eq!(m.qualified_name, "openrouter:anthropic/claude-sonnet-4.5");
        // Round-trip: re-resolving the qualified_name yields the same model.
        let again = find_effective_model(&loaded, tmp.path(), &m.qualified_name, true).unwrap();
        assert_eq!(again.qualified_name, m.qualified_name);
        assert_eq!(again.model_id, "anthropic/claude-sonnet-4.5");
    }

    #[test]
    fn discovered_anthropic_model_gets_default_cache_ttl() {
        // Discovered models route through ResolvedModel::from_parts, so the
        // SDK-conditional cache_ttl default applies to them too. A custom
        // provider with sdk = "anthropic" (entry.sdk overrides the cache's
        // hardcoded "openai") should produce a discovered model with
        // cache_ttl = Some("1h").
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.my_anthropic_proxy]
sdk = "anthropic"
api_key_env = "MY_KEY"
base_url = "https://example.test/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "my_anthropic_proxy", &["claude-opus-4-6"]);

        let m = find_effective_model(&loaded, tmp.path(), "claude-opus-4-6", false).unwrap();
        assert_eq!(m.provider_key, "my_anthropic_proxy");
        assert_eq!(m.sdk, Sdk::Anthropic);
        assert_eq!(m.cache_ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn discovered_claude_4_7_plus_drops_rejected_sampler() {
        // The sampler cutoff (#138) also fires on the discovered path, since it
        // converges on ResolvedModel::from_parts. A `temperature` pinned via
        // `[providers.*.defaults]` is dropped for a Claude >=4.7 model id but
        // kept for one below the cutoff.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
sdk = "anthropic"
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.defaults]
temperature = 0.5
"#,
            "",
        );
        write_cache_for(
            &tmp,
            "openrouter",
            &["anthropic/claude-opus-4.8", "anthropic/claude-sonnet-4.6"],
        );

        let opus =
            find_effective_model(&loaded, tmp.path(), "anthropic/claude-opus-4.8", false).unwrap();
        assert_eq!(opus.temperature, None, "rejected for opus >=4.7");

        let sonnet =
            find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.6", false)
                .unwrap();
        assert_eq!(sonnet.temperature, Some(0.5), "kept below the 4.7 cutoff");
    }

    #[test]
    fn discovered_model_inherits_provider_level_defaults() {
        // `[providers.<provider>.defaults]` fields must cascade onto discovered
        // models the same way they fold into static `[chat.<provider>.<model>]`
        // entries. Regression: discovered models previously hard-coded
        // `openrouter_provider: None`, silently dropping routing pins for
        // discovery-only setups (the entire reason a user pins
        // `order = ["Anthropic"]` for anthropic/* models on OpenRouter).
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
sdk = "anthropic"
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.defaults]
cache_ttl = "1h"
openrouter_provider = { order = ["Anthropic"] }
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-opus-4.8"]);

        let m =
            find_effective_model(&loaded, tmp.path(), "anthropic/claude-opus-4.8", false).unwrap();
        assert_eq!(m.provider_key, "openrouter");
        assert_eq!(m.cache_ttl.as_deref(), Some("1h"));
        let or = m
            .openrouter_provider
            .expect("routing pin should be inherited from [providers.openrouter.defaults]");
        let order = or
            .get("order")
            .and_then(|v| v.as_array())
            .expect("openrouter_provider.order array");
        assert_eq!(order.len(), 1);
        assert_eq!(order[0].as_str(), Some("Anthropic"));
    }

    #[test]
    fn discovered_model_explicit_default_overrides_discovered_metadata() {
        // User config wins over discovered upstream metadata: a provider-level
        // `max_output_tokens` must beat the discovery feed's reported value.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
sdk = "anthropic"
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.defaults]
max_output_tokens = 32768
"#,
            "",
        );
        // write_cache_for reports max_output_tokens = 8192.
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-opus-4.8"]);

        let m =
            find_effective_model(&loaded, tmp.path(), "anthropic/claude-opus-4.8", false).unwrap();
        assert_eq!(m.max_output_tokens, Some(32768));
    }

    #[test]
    fn discovered_model_selectable_by_provider_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:anthropic/claude-sonnet-4.5",
            false,
        )
        .unwrap();
        assert_eq!(m.provider_key, "openrouter");
        assert_eq!(m.model_id, "anthropic/claude-sonnet-4.5");
    }

    #[test]
    fn static_alias_still_resolves_to_static_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.openrouter.sonnet]
model_id = "anthropic/claude-sonnet-4.5"
cache_ttl = "1h"
max_output_tokens = 16384
"#,
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        // Short alias resolves to the static entry, with its overrides intact.
        let m = find_effective_model(&loaded, tmp.path(), "sonnet", false).unwrap();
        assert_eq!(m.qualified_name, "chat.openrouter.sonnet");
        assert_eq!(m.cache_ttl.as_deref(), Some("1h"));
        assert_eq!(m.max_output_tokens, Some(16384));
    }

    #[test]
    fn static_overrides_discovered_when_same_provider_and_model_id() {
        // Plan requirement: "manual static config wins for explicit fields".
        // When the user types the bare upstream id, return the static entry —
        // not a fresh ResolvedModel built from the discovered record.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.openrouter.sonnet]
model_id = "anthropic/claude-sonnet-4.5"
cache_ttl = "1h"
max_output_tokens = 16384
"#,
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap();
        // Static name wins, not a synthesized discovered name.
        assert_eq!(m.name, "sonnet");
        assert_eq!(m.qualified_name, "chat.openrouter.sonnet");
        assert_eq!(m.cache_ttl.as_deref(), Some("1h"));
        assert_eq!(m.max_output_tokens, Some(16384));
    }

    #[test]
    fn ambiguous_bare_id_across_providers_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.together]
api_key_env = "TG_KEY"
base_url = "https://api.together.xyz/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["meta-llama/llama-3-70b"]);
        write_cache_for(&tmp, "together", &["meta-llama/llama-3-70b"]);

        let err =
            find_effective_model(&loaded, tmp.path(), "meta-llama/llama-3-70b", false).unwrap_err();
        assert_variant!(

            err,
            EffectiveCatalogError::Ambiguous { ref locations, .. } => {
                assert!(locations.contains("openrouter"));
                assert!(locations.contains("together"));
            }

        );
    }

    #[test]
    fn provider_prefix_disambiguates_two_providers() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.together]
api_key_env = "TG_KEY"
base_url = "https://api.together.xyz/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["meta-llama/llama-3-70b"]);
        write_cache_for(&tmp, "together", &["meta-llama/llama-3-70b"]);

        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "together:meta-llama/llama-3-70b",
            false,
        )
        .unwrap();
        assert_eq!(m.provider_key, "together");
    }

    #[test]
    fn unknown_name_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let err = find_effective_model(&loaded, tmp.path(), "ghost-model", false).unwrap_err();
        assert!(matches!(err, EffectiveCatalogError::NotFound { .. }));
    }

    #[test]
    fn hidden_discovered_model_rejected_with_clear_error() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
ignore = ["meta-llama/*"]
"#,
            "",
        );
        write_cache_for(
            &tmp,
            "openrouter",
            &["anthropic/claude-sonnet-4.5", "meta-llama/llama-3-70b"],
        );

        let err =
            find_effective_model(&loaded, tmp.path(), "meta-llama/llama-3-70b", false).unwrap_err();
        assert_variant!(

            err,
            EffectiveCatalogError::Hidden {
                ref name,
                ref provider,
            } => {
                assert_eq!(name, "meta-llama/llama-3-70b");
                assert_eq!(provider, "openrouter");
            }

        );
        // Visible neighbour resolves fine.
        assert!(
            find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false,)
                .is_ok()
        );
    }

    #[test]
    fn hidden_discovered_model_resolves_with_include_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
ignore = ["meta-llama/*"]
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["meta-llama/llama-3-70b"]);

        let m = find_effective_model(&loaded, tmp.path(), "meta-llama/llama-3-70b", true).unwrap();
        assert_eq!(m.provider_key, "openrouter");
        assert_eq!(m.model_id, "meta-llama/llama-3-70b");
    }

    #[test]
    fn provider_prefix_for_hidden_model_also_rejected_without_include_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
ignore = ["meta-llama/*"]
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["meta-llama/llama-3-70b"]);

        let err = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:meta-llama/llama-3-70b",
            false,
        )
        .unwrap_err();
        assert!(matches!(err, EffectiveCatalogError::Hidden { .. }));

        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:meta-llama/llama-3-70b",
            true,
        )
        .unwrap();
        assert_eq!(m.provider_key, "openrouter");
    }

    // ── list_effective_models ───────────────────────────────────────────

    #[test]
    fn list_includes_static_and_discovered() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.anthropic.opus]
model_id = "claude-opus-4-7"
"#,
        );
        write_cache_for(
            &tmp,
            "openrouter",
            &["anthropic/claude-sonnet-4.5", "openai/gpt-4o"],
        );

        let list = list_effective_models(&loaded, tmp.path(), false);
        let names: Vec<&str> = list.iter().map(|e| e.resolved.model_id.as_str()).collect();
        assert!(names.contains(&"claude-opus-4-7"));
        assert!(names.contains(&"anthropic/claude-sonnet-4.5"));
        assert!(names.contains(&"openai/gpt-4o"));
        // Sources tagged correctly.
        for entry in &list {
            if entry.resolved.model_id == "claude-opus-4-7" {
                assert_eq!(entry.source, EffectiveSource::Static);
            } else {
                assert_eq!(entry.source, EffectiveSource::Discovered);
            }
        }
    }

    #[test]
    fn list_sorts_discovered_alphabetically_within_provider() {
        // The discovery cache preserves the provider's raw /v1/models order;
        // list_effective_models must re-sort each provider's block by id.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(
            &tmp,
            "openrouter",
            &["x-ai/grok-4", "anthropic/claude-opus", "openai/gpt-5"],
        );

        let list = list_effective_models(&loaded, tmp.path(), false);
        let names: Vec<&str> = list.iter().map(|e| e.resolved.model_id.as_str()).collect();
        assert_eq!(
            names,
            vec!["anthropic/claude-opus", "openai/gpt-5", "x-ai/grok-4"],
        );
    }

    #[test]
    fn list_dedupes_when_static_overrides_discovered() {
        // A static entry with the same (provider, model_id) as a discovered
        // model must appear once, sourced as static.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.openrouter.sonnet]
model_id = "anthropic/claude-sonnet-4.5"
cache_ttl = "1h"
"#,
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let list = list_effective_models(&loaded, tmp.path(), false);
        let same_id: Vec<_> = list
            .iter()
            .filter(|e| e.resolved.model_id == "anthropic/claude-sonnet-4.5")
            .collect();
        assert_eq!(same_id.len(), 1, "deduplicated to a single row");
        assert_eq!(same_id[0].source, EffectiveSource::Static);
        assert_eq!(same_id[0].resolved.cache_ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn list_drops_hidden_unless_include_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
ignore = ["meta-llama/*"]
"#,
            "",
        );
        write_cache_for(
            &tmp,
            "openrouter",
            &["anthropic/claude-sonnet-4.5", "meta-llama/llama-3-70b"],
        );

        let visible_only = list_effective_models(&loaded, tmp.path(), false);
        let names: Vec<&str> = visible_only
            .iter()
            .map(|e| e.resolved.model_id.as_str())
            .collect();
        assert!(names.contains(&"anthropic/claude-sonnet-4.5"));
        assert!(!names.contains(&"meta-llama/llama-3-70b"));

        let with_hidden = list_effective_models(&loaded, tmp.path(), true);
        assert_eq!(with_hidden.len(), 2);
        let llama = with_hidden
            .iter()
            .find(|e| e.resolved.model_id == "meta-llama/llama-3-70b")
            .unwrap();
        assert!(
            llama.hidden,
            "hidden flag set even when include_hidden=true"
        );
    }

    // ── Default sdk for discovered models ───────────────────────────────

    #[test]
    fn discovered_anthropic_slug_auto_promotes_to_anthropic_sdk() {
        // OpenRouter-style provider with no explicit `sdk = ` on the
        // registry entry. The discovery cache reports `sdk = "openai"`
        // (the default in `write_cache_for`) for every model, so without
        // the slug heuristic an `anthropic/*` discovered model would land
        // on `Sdk::Openai` and miss prompt caching. Pin that the
        // heuristic fires and `cache_ttl` defaults to "1h" as a result.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap();
        assert_eq!(m.sdk, Sdk::Anthropic);
        assert_eq!(m.cache_ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn discovered_non_anthropic_openrouter_model_defaults_to_openrouter_sdk() {
        // The `anthropic/*` slug heuristic must not fire on non-anthropic
        // ids. Instead of the discovery feed's blanket "openai", a discovered
        // OpenRouter model lands on the curated provider default `Openrouter`
        // (the sidecar's normalized non-Anthropic path) — consistent with the
        // static `[chat.openrouter.<model>]` path. No Anthropic cache_ttl.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["openai/gpt-4o"]);

        let m = find_effective_model(&loaded, tmp.path(), "openai/gpt-4o", false).unwrap();
        assert_eq!(m.sdk, Sdk::Openrouter);
        assert_eq!(m.cache_ttl, None);
    }

    #[test]
    fn explicit_registry_sdk_wins_over_anthropic_slug_on_discovered() {
        // `entry.sdk = "openai"` on the registry must beat the
        // `anthropic/*` heuristic — same precedence as the static-path
        // `explicit_sdk_wins_over_anthropic_slug_auto_promotion` test.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
sdk = "openai"
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap();
        assert_eq!(m.sdk, Sdk::Openai);
        assert_eq!(m.cache_ttl, None);
    }

    #[test]
    fn discovered_model_picks_up_provider_registry_sdk() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
sdk = "anthropic"
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap();
        assert_eq!(m.sdk, Sdk::Anthropic, "registry sdk wins over discovered");
    }

    // ── Disabled provider / disabled discovery filtering ────────────────

    #[test]
    fn disabled_provider_cache_is_ignored_for_bare_id() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
enabled = false
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let err = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap_err();
        assert!(
            matches!(err, EffectiveCatalogError::NotFound { .. }),
            "stale cache for a disabled provider must not be searched"
        );
    }

    #[test]
    fn discovery_disabled_cache_is_ignored_for_bare_id() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = false
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let err = find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
            .unwrap_err();
        assert!(
            matches!(err, EffectiveCatalogError::NotFound { .. }),
            "cache from previously-enabled discovery must not be honored once disabled"
        );
    }

    #[test]
    fn disabled_provider_cache_is_ignored_for_provider_prefix_lookup() {
        // Even with the explicit `provider:model_id` form the cache must not
        // be consulted when the provider is disabled.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
enabled = false
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let err = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:anthropic/claude-sonnet-4.5",
            false,
        )
        .unwrap_err();
        assert!(matches!(err, EffectiveCatalogError::NotFound { .. }));
    }

    #[test]
    fn disabled_provider_static_entry_is_unreferenceable() {
        // #139 end state: a disabled provider is *uniformly* unreferenceable —
        // even a legacy static `[chat.*]` entry sitting under it must not
        // resolve, by either the `provider:model_id` form or the bare id. This
        // drops the old static carve-out that resolved statics regardless of
        // `enabled`.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
enabled = false
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            r#"
[chat.openrouter.sonnet]
model_id = "anthropic/claude-sonnet-4.5"
cache_ttl = "1h"
"#,
        );

        // Qualified `provider:model_id` form.
        let err = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:anthropic/claude-sonnet-4.5",
            false,
        )
        .unwrap_err();
        assert!(
            matches!(err, EffectiveCatalogError::NotFound { .. }),
            "static under a disabled provider must not resolve by provider:model_id, got {err:?}"
        );

        // Bare upstream id.
        let bare_err =
            find_effective_model(&loaded, tmp.path(), "anthropic/claude-sonnet-4.5", false)
                .unwrap_err();
        assert!(
            matches!(bare_err, EffectiveCatalogError::NotFound { .. }),
            "static under a disabled provider must not resolve by bare id, got {bare_err:?}"
        );

        // The static short alias still resolves through the static catalog
        // (`find_model`), which is provider-enabled-agnostic — selection
        // durability is separate from the disabled-provider gate.
        let m = find_effective_model(&loaded, tmp.path(), "sonnet", false).unwrap();
        assert_eq!(m.qualified_name, "chat.openrouter.sonnet");
    }

    // ── Trusted `provider:model_id` without discovery (#136) ────────────

    #[test]
    fn provider_prefix_resolves_on_discovery_off_provider() {
        // With the static `[chat.*]` catalog retired, a fully-qualified
        // `provider:model_id` on an enabled provider must resolve even when
        // discovery is off and there is no cache — transport comes from the
        // provider entry, `model_id` is taken as given.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.local]
sdk = "openai"
api_key_env = "LOCAL_KEY"
base_url = "https://local.test/v1"

[providers.local.discovery]
enabled = false
"#,
            "",
        );

        let m = find_effective_model(&loaded, tmp.path(), "local:my-model-7b", false).unwrap();
        assert_eq!(m.provider_key, "local");
        assert_eq!(m.model_id, "my-model-7b");
        assert_eq!(m.sdk, Sdk::Openai);
        assert_eq!(m.base_url.as_deref(), Some("https://local.test/v1"));
    }

    #[test]
    fn provider_prefix_resolves_when_not_in_discovery_cache() {
        // Discovery is on but the model isn't in the cache (e.g. brand-new
        // upstream model, or a private id discovery never lists). A
        // fully-qualified ref on the enabled provider is still trusted.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let m = find_effective_model(&loaded, tmp.path(), "openrouter:cohere/command-r", false)
            .unwrap();
        assert_eq!(m.provider_key, "openrouter");
        assert_eq!(m.model_id, "cohere/command-r");
        // Provider base_url still applies on the trusted path.
        assert_eq!(m.base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
    }

    #[test]
    fn trusted_anthropic_slug_promotes_sdk_and_cache_ttl() {
        // The `anthropic/*` auto-promotion that fires for discovered/static
        // models must also fire on the trusted (no-discovery) path, so prompt
        // caching works by default for `anthropic/*` slugs.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.or-anthropic]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.or-anthropic.discovery]
enabled = false
"#,
            "",
        );

        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "or-anthropic:anthropic/claude-opus-4.8",
            false,
        )
        .unwrap();
        assert_eq!(
            m.sdk,
            Sdk::Anthropic,
            "anthropic/* slug promotes to Anthropic SDK"
        );
        assert_eq!(
            m.cache_ttl.as_deref(),
            Some("1h"),
            "anthropic SDK gets default cache_ttl"
        );
    }

    #[test]
    fn trusted_path_picks_up_provider_defaults() {
        // The load-bearing `or-anthropic` case from #131: a discovery-off
        // provider whose routing pin + max_output_tokens live in
        // `[providers.<provider>.defaults]` must flow onto a trusted
        // `provider:model_id` ref (no discovery, no static catalog).
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.or-anthropic]
sdk = "anthropic"
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.or-anthropic.discovery]
enabled = false

[providers.or-anthropic.defaults]
max_output_tokens = 8192
openrouter_provider = { order = ["Anthropic"] }
"#,
            "",
        );

        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "or-anthropic:anthropic/claude-opus-4.8",
            false,
        )
        .unwrap();
        assert_eq!(m.max_output_tokens, Some(8192));
        let or = m
            .openrouter_provider
            .expect("routing pin from [providers.or-anthropic.defaults]");
        assert_eq!(
            or.get("order").and_then(|v| v.as_array()).map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn trusted_path_still_respects_discovery_ignore() {
        // When discovery is on, `discovery.ignore` is honored for qualified
        // refs even when the id isn't in the cache — qualified refs must not
        // be a backdoor around ignore rules. `include_hidden` still opts in.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.openrouter.discovery]
enabled = true
ignore = ["meta-llama/*"]
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        // Not in the cache, but matches an ignore pattern → Hidden.
        let err = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:meta-llama/llama-4-uncached",
            false,
        )
        .unwrap_err();
        assert!(matches!(err, EffectiveCatalogError::Hidden { .. }));

        // include_hidden opts back in and resolves on the trusted path.
        let m = find_effective_model(
            &loaded,
            tmp.path(),
            "openrouter:meta-llama/llama-4-uncached",
            true,
        )
        .unwrap();
        assert_eq!(m.model_id, "meta-llama/llama-4-uncached");
    }

    #[test]
    fn disabled_provider_dropped_from_list() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
enabled = false
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["anthropic/claude-sonnet-4.5"]);

        let list = list_effective_models(&loaded, tmp.path(), true);
        let names: Vec<&str> = list.iter().map(|e| e.resolved.model_id.as_str()).collect();
        assert!(!names.contains(&"anthropic/claude-sonnet-4.5"));
    }

    // ── Hidden/visible ambiguity ────────────────────────────────────────

    #[test]
    fn one_visible_one_hidden_resolves_to_visible_not_ambiguous() {
        // P3 regression: when one provider has a visible match and another
        // has a hidden match for the same upstream id, `include_hidden=false`
        // must resolve to the visible one — not error as ambiguous.
        let tmp = tempfile::tempdir().unwrap();
        let loaded = make_loaded(
            &tmp,
            r#"
[providers.openrouter]
api_key_env = "OR_KEY"
base_url = "https://openrouter.ai/api/v1"

[providers.together]
api_key_env = "TG_KEY"
base_url = "https://api.together.xyz/v1"

[providers.together.discovery]
enabled = true
ignore = ["meta-llama/*"]
"#,
            "",
        );
        write_cache_for(&tmp, "openrouter", &["meta-llama/llama-3-70b"]);
        write_cache_for(&tmp, "together", &["meta-llama/llama-3-70b"]);

        // openrouter visible (default-show), together hidden (hide pattern).
        let m = find_effective_model(&loaded, tmp.path(), "meta-llama/llama-3-70b", false).unwrap();
        assert_eq!(m.provider_key, "openrouter");

        // With include_hidden=true, both participate and the resolution
        // becomes genuinely ambiguous.
        let err =
            find_effective_model(&loaded, tmp.path(), "meta-llama/llama-3-70b", true).unwrap_err();
        assert!(matches!(err, EffectiveCatalogError::Ambiguous { .. }));
    }
}
