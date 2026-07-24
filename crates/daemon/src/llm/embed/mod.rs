//! Embedding model abstraction.
//!
//! [`Embedder`] is dyn-compatible so call sites can hold an
//! `Arc<dyn Embedder>` chosen at startup from config without each consumer
//! knowing the provider shape. The shipped impl is OpenAI-compatible,
//! covering OpenAI, Together, Voyage's compat endpoint, OpenRouter, and
//! any self-hosted server that speaks the same shape (e.g.
//! text-embedding-inference, llama.cpp's `/v1/embeddings`).

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use dashmap::DashMap;

use crate::llm::LlmError;

/// Vector embedding provider.
///
/// `model_id` identifies the model that produced a vector — index entries
/// embed it so a model swap invalidates cached vectors.
#[async_trait]
pub trait Embedder: Send + Sync {
    async fn embed(&self, inputs: &[&str]) -> Result<Vec<Vec<f32>>, LlmError>;
    fn model_id(&self) -> &str;
    /// Requested output width, or `None` to use the model's native width.
    ///
    /// This is the configured `dimensions` knob, not a measured width: when
    /// `None`, the actual vector length is whatever the provider returns.
    fn dimensions(&self) -> Option<usize>;
}

/// Hosted OpenAI-compatible embedder (`/v1/embeddings`).
///
/// Works with any provider that speaks the OpenAI embeddings shape
/// (OpenAI itself, Together, Voyage's compat endpoint, OpenRouter, etc.).
pub struct OpenAIEmbedder {
    http_client: reqwest::Client,
    model: String,
    api_key: String,
    base_url: Option<String>,
    dimensions: Option<usize>,
}

impl std::fmt::Debug for OpenAIEmbedder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAIEmbedder")
            .field("http_client", &self.http_client)
            .field("model", &self.model)
            .field("api_key", &"<redacted>")
            .field("base_url", &self.base_url)
            .field("dimensions", &self.dimensions)
            .finish()
    }
}

impl OpenAIEmbedder {
    pub fn new<M: Into<String>, K: Into<String>>(
        http_client: reqwest::Client,
        model: M,
        api_key: K,
        base_url: Option<String>,
        dimensions: Option<usize>,
    ) -> Self {
        Self {
            http_client,
            model: model.into(),
            api_key: api_key.into(),
            base_url,
            dimensions,
        }
    }
}

#[async_trait]
impl Embedder for OpenAIEmbedder {
    async fn embed(&self, inputs: &[&str]) -> Result<Vec<Vec<f32>>, LlmError> {
        crate::llm::providers::embed(
            &self.http_client,
            "openai",
            &self.model,
            &self.api_key,
            self.base_url.as_deref(),
            inputs,
            self.dimensions,
        )
        .await
    }

    fn model_id(&self) -> &str {
        &self.model
    }

    fn dimensions(&self) -> Option<usize> {
        self.dimensions
    }
}

/// Process-wide cache so an `Arc<dyn Embedder>` is loaded once and shared
/// across requests, characters, and heartbeat ticks.
///
/// Keyed by an opaque string the caller chooses — typically
/// `"<provider>::<model_id>"` — so a config swap to a different model
/// produces a new entry rather than reusing the old one.
fn embedder_cache() -> &'static DashMap<String, Arc<dyn Embedder>> {
    static CACHE: OnceLock<DashMap<String, Arc<dyn Embedder>>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

/// Look up an embedder by `key`; if absent, run `build` and cache the
/// result. Subsequent callers get the same `Arc` clone.
pub fn cache_or_build<F, E>(key: &str, build: F) -> Result<Arc<dyn Embedder>, E>
where
    F: FnOnce() -> Result<Arc<dyn Embedder>, E>,
{
    if let Some(e) = embedder_cache().get(key) {
        return Ok(Arc::clone(e.value()));
    }
    let new = build()?;
    let _ignored = embedder_cache().insert(key.to_owned(), Arc::clone(&new));
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeEmbedder {
        dim: usize,
    }

    #[async_trait]
    impl Embedder for FakeEmbedder {
        async fn embed(&self, inputs: &[&str]) -> Result<Vec<Vec<f32>>, LlmError> {
            Ok(inputs
                .iter()
                .map(|s| {
                    let mut v = vec![0.0_f32; self.dim];
                    if !s.is_empty() {
                        let hash = s.bytes().fold(0_u32, |a, b| a.wrapping_add(u32::from(b)));
                        let idx_base = usize::try_from(hash).unwrap_or(usize::MAX);
                        if let Some(idx) = idx_base.checked_rem(self.dim) {
                            if let Some(slot) = v.get_mut(idx) {
                                *slot = 1.0;
                            }
                        }
                    }
                    v
                })
                .collect())
        }
        fn model_id(&self) -> &'static str {
            "fake"
        }
        fn dimensions(&self) -> Option<usize> {
            Some(self.dim)
        }
    }

    #[tokio::test]
    async fn dyn_embedder_round_trip() {
        let e: Box<dyn Embedder> = Box::new(FakeEmbedder { dim: 4 });
        let out = e.embed(&["a", "b"]).await.unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out.first().expect("embedding output").len(), 4);
        assert_eq!(e.model_id(), "fake");
        assert_eq!(e.dimensions(), Some(4));
    }
}
