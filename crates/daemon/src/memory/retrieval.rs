//! Embedder resolution from config, with a process-wide cache.
//!
//! The hybrid retrieval pipeline lives in
//! [`crate::memory::workspace_index`]. This file used to also host a
//! memory-only retrieval implementation (`search_memory`) — that was
//! superseded by the workspace-wide hybrid path and removed.
//!
//! There is no bundled local embedder. Callers configure an
//! OpenAI-compatible endpoint (hosted or self-hosted, e.g.
//! text-embedding-inference, llama.cpp's `/v1/embeddings`); when nothing is
//! configured, hybrid search degrades to lexical-only at the call site.
//!
//! Identity is a bare `provider:model_id`; transport (`base_url`) and
//! credentials resolve through `[providers.<provider>]`, reusing the same
//! key-fallback contract as chat (`resolve_key_candidates_for`). Optional
//! per-model `[embedding."provider:model_id"]` settings carry `dimensions`;
//! when unset the provider returns the model's native width.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::llm::credentials::{read_candidate_env, resolve_key_candidates_for};
use crate::llm::embed::{Embedder, OpenAIEmbedder};
use shore_common::config::models::{hardcoded_provider_defaults, EmbeddingSettings};
use shore_common::config::providers::ProviderRegistry;

/// Resolve the target embedding identity: the configured default, else the
/// sole settings-overlay key. With multiple overlay entries and no default,
/// fail rather than silently pick one — the choice would be arbitrary
/// (BTreeMap order).
fn resolve_embedder_target<'emb>(
    default_ref: Option<&'emb str>,
    embedding: &'emb BTreeMap<String, EmbeddingSettings>,
) -> Result<&'emb str, String> {
    if let Some(t) = default_ref {
        return Ok(t);
    }
    let mut keys = embedding.keys();
    match (keys.next(), keys.next()) {
        (Some(only), None) => Ok(only.as_str()),
        (Some(_), Some(_)) => Err(
            "multiple [embedding.\"provider:model_id\"] entries are configured \
             but defaults.embedding is unset; set defaults.embedding to choose one"
                .to_owned(),
        ),
        _ => Err(
            "no embedding model configured; semantic search disabled. Set \
             defaults.embedding = \"provider:model_id\" pointing at an \
             OpenAI-compatible embeddings endpoint and configure \
             [providers.<provider>] (see CONFIGURATION.md)."
                .to_owned(),
        ),
    }
}

/// Resolve the API key for an embedding provider via the
/// `[providers.<p>].keys[]` fallback chain; the first env-set candidate wins.
/// Mirrors chat's resolution so multi-key providers work.
fn resolve_embedder_api_key(
    provider_key: &str,
    providers: &ProviderRegistry,
) -> Result<String, String> {
    let candidates = resolve_key_candidates_for(provider_key, providers, None);
    if candidates.is_empty() {
        return Err(format!(
            "embedding provider '{provider_key}' is disabled in [providers.{provider_key}]"
        ));
    }
    candidates
        .iter()
        .find_map(read_candidate_env)
        .ok_or_else(|| {
            let envs: Vec<&str> = candidates.iter().map(|c| c.env.as_str()).collect();
            format!(
                "embedding API key not set for provider '{provider_key}'; \
             set one of these env vars: {}",
                envs.join(", ")
            )
        })
}

/// Build (or fetch from the process-wide cache) the configured embedder.
///
/// `default_ref` is `defaults.embedding` — a `provider:model_id` identity.
/// `embedding` holds optional per-model category settings keyed by the same
/// identity. Transport and credentials resolve through `providers`.
///
/// Returns `Err` when no embedding model is configured, the identity is not a
/// hosted `provider:model_id`, or no API key is set. Callers degrade hybrid
/// search to lexical mode on any error.
pub fn resolve_embedder(
    default_ref: Option<&str>,
    embedding: &BTreeMap<String, EmbeddingSettings>,
    providers: &ProviderRegistry,
    http_client: &reqwest::Client,
) -> Result<Arc<dyn Embedder>, String> {
    let target = resolve_embedder_target(default_ref, embedding)?;

    let Some((provider_key, model_id)) = target.split_once(':') else {
        return Err(format!(
            "embedding model '{target}' is not a `provider:model_id` identity. \
             Hosted semantic search needs an OpenAI-compatible embeddings endpoint \
             (e.g. \"openai:text-embedding-3-large\") with transport under \
             [providers.<provider>]; bundled local ids are not served at runtime."
        ));
    };
    if provider_key.is_empty() || model_id.is_empty() {
        return Err(format!(
            "embedding model '{target}' is not a valid `provider:model_id` identity"
        ));
    }

    // Preserve "unset" as `None` so the wire request omits `dimensions` and the
    // provider returns the model's native width, rather than substituting a
    // hardcoded default that silently dimension-reduces non-1536 models.
    let dimensions = embedding
        .get(target)
        .and_then(|s| s.dimensions)
        .map(|value| {
            usize::try_from(value).map_err(|_| {
                format!(
                    "embedding model '{target}' has invalid dimensions {value}; \
                     expected a value that fits in usize"
                )
            })
        })
        .transpose()?;

    // Transport: registry base_url, else the hardcoded provider default, else
    // None (the OpenAI-compatible SDK default endpoint).
    let base_url = providers
        .get(provider_key)
        .and_then(|e| e.base_url.clone())
        .or_else(|| hardcoded_provider_defaults(provider_key).fields.base_url);

    let api_key = resolve_embedder_api_key(provider_key, providers)?;

    let cache_key = format!(
        "{provider_key}::{model_id}::{}::{}",
        base_url.as_deref().unwrap_or("default"),
        dimensions.map_or_else(|| "native".to_owned(), |d| d.to_string())
    );
    let owned_model_id = model_id.to_owned();
    let owned_http_client = http_client.clone();
    crate::llm::embed::cache_or_build(&cache_key, move || {
        Ok::<Arc<dyn Embedder>, String>(Arc::new(OpenAIEmbedder::new(
            owned_http_client,
            owned_model_id,
            api_key,
            base_url,
            dimensions,
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_from(toml_str: &str) -> ProviderRegistry {
        let table: toml::Table = toml_str.parse().unwrap();
        ProviderRegistry::from_section(table.get("providers").and_then(|v| v.as_table())).unwrap()
    }

    fn empty_registry() -> ProviderRegistry {
        ProviderRegistry::from_section(None).unwrap()
    }

    fn resolve_error(
        default_ref: Option<&str>,
        embedding: &BTreeMap<String, EmbeddingSettings>,
        providers: &ProviderRegistry,
    ) -> String {
        let http = reqwest::Client::new();
        match resolve_embedder(default_ref, embedding, providers, &http) {
            Ok(_) => panic!("resolve_embedder unexpectedly succeeded"),
            Err(err) => err,
        }
    }

    #[test]
    fn no_model_configured_returns_clear_error() {
        let embedding = BTreeMap::new();
        let err = resolve_error(None, &embedding, &empty_registry());
        assert!(
            err.contains("no embedding model configured"),
            "expected unconfigured-error, got: {err}"
        );
    }

    #[test]
    fn bare_alias_ref_is_rejected() {
        let embedding = BTreeMap::new();
        let err = resolve_error(Some("not-a-provider-model"), &embedding, &empty_registry());
        assert!(
            err.contains("not a `provider:model_id` identity"),
            "error should explain the identity shape: {err}"
        );
    }

    #[test]
    fn missing_api_key_names_the_env() {
        // A custom provider with a guaranteed-unset env makes this deterministic.
        let providers = registry_from(
            r#"
[providers.acme]
base_url = "https://acme.example.com/v1"
api_key_env = "SHORE_TEST_EMBED_DEFINITELY_UNSET_KEY"
"#,
        );
        let embedding = BTreeMap::new();
        let err = resolve_error(Some("acme:some-embed-model"), &embedding, &providers);
        assert!(
            err.contains("SHORE_TEST_EMBED_DEFINITELY_UNSET_KEY"),
            "error should name the unset env var: {err}"
        );
    }

    #[test]
    fn builds_embedder_with_settings_dimensions() {
        let api_key_env = "SHORE_TEST_EMBED_BUILD_KEY";
        std::env::set_var(api_key_env, "test-key");
        let providers = registry_from(&format!(
            r#"
[providers.acme]
base_url = "https://acme.example.com/v1"
api_key_env = "{api_key_env}"
"#,
        ));
        let mut embedding = BTreeMap::new();
        let _ignored = embedding.insert(
            "acme:my-embed".to_owned(),
            EmbeddingSettings {
                dimensions: Some(512),
            },
        );
        let http = reqwest::Client::new();
        let embedder = resolve_embedder(Some("acme:my-embed"), &embedding, &providers, &http)
            .expect("embedder should build");
        std::env::remove_var(api_key_env);
        assert_eq!(embedder.model_id(), "my-embed");
        assert_eq!(embedder.dimensions(), Some(512));
    }

    #[test]
    fn unset_dimensions_resolve_to_none() {
        let api_key_env = "SHORE_TEST_EMBED_NATIVE_KEY";
        std::env::set_var(api_key_env, "test-key");
        let providers = registry_from(&format!(
            r#"
[providers.acme]
base_url = "https://acme.example.com/v1"
api_key_env = "{api_key_env}"
"#,
        ));
        // No [embedding."acme:native-embed"] overlay → dimensions unset.
        let embedding = BTreeMap::new();
        let http = reqwest::Client::new();
        let embedder = resolve_embedder(Some("acme:native-embed"), &embedding, &providers, &http)
            .expect("embedder should build");
        std::env::remove_var(api_key_env);
        assert_eq!(
            embedder.dimensions(),
            None,
            "unset dimensions must stay None so the wire request omits the field"
        );
    }
}
