//! Embedding model abstraction.
//!
//! [`Embedder`] is dyn-compatible so call sites can hold an
//! `Arc<dyn Embedder>` chosen at startup from config without each consumer
//! knowing the provider shape. The shipped impl is OpenAI-compatible,
//! covering OpenAI, Together, Voyage's compat endpoint, OpenRouter, and
//! any self-hosted server that speaks the same shape (e.g.
//! text-embedding-inference, llama.cpp's `/v1/embeddings`).
//!
//! This is the one LLM call shore makes from Rust: one endpoint, one body
//! shape, no per-provider branching, so routing it through the sidecar with
//! everything else (see [`crate::llm::sidecar`]) would buy nothing.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use dashmap::DashMap;
use serde_json::{json, Value};
use tracing::debug;

use crate::llm::{body_preview, check_response, LlmError};

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

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
        let base = self.base_url.as_deref().unwrap_or(OPENAI_BASE_URL);
        debug!(model = %self.model, input_count = inputs.len(), "dispatching embedding request");

        let response = self
            .http_client
            .post(format!("{base}/embeddings"))
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", self.api_key),
            )
            .json(&build_embed_body(&self.model, inputs, self.dimensions))
            .send()
            .await?;
        let checked = check_response(response).await?;

        let text = checked.text().await?;
        let resp: Value = serde_json::from_str(&text).map_err(|e| LlmError::Provider {
            message: format!(
                "embedding response was not valid JSON: {e}; body preview: {}",
                body_preview(&text, 200)
            ),
        })?;

        parse_embedding_response(&resp, inputs.len())
    }

    fn model_id(&self) -> &str {
        &self.model
    }

    fn dimensions(&self) -> Option<usize> {
        self.dimensions
    }
}

/// Build the `/v1/embeddings` request body.
///
/// `dimensions` maps to the OpenAI `dimensions` request field, which asks
/// `text-embedding-3*` models to return dimension-reduced vectors. It is
/// emitted only when `Some`; `None` omits the field so the provider returns
/// the model's native width.
fn build_embed_body(model: &str, input: &[&str], dimensions: Option<usize>) -> Value {
    let mut map = serde_json::Map::new();
    let _prev_model = map.insert("model".into(), json!(model));
    let _prev_input = map.insert("input".into(), json!(input));
    if let Some(dims) = dimensions {
        let _prev_dims = map.insert("dimensions".into(), json!(dims));
    }
    Value::Object(map)
}

fn parse_embedding_response(
    resp: &Value,
    expected_count: usize,
) -> Result<Vec<Vec<f32>>, LlmError> {
    let data = resp
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| LlmError::Provider {
            message: "embedding response missing data array".into(),
        })?;

    if data.len() != expected_count {
        return Err(LlmError::Provider {
            message: format!(
                "embedding response returned {} vectors for {} inputs",
                data.len(),
                expected_count
            ),
        });
    }

    data.iter()
        .enumerate()
        .map(|(item_idx, item)| {
            let nums =
                item.get("embedding")
                    .and_then(|e| e.as_array())
                    .ok_or_else(|| LlmError::Provider {
                        message: format!(
                            "embedding response item {item_idx} missing embedding array"
                        ),
                    })?;

            nums.iter()
                .enumerate()
                .map(|(num_idx, n)| {
                    #[expect(
                        clippy::cast_possible_truncation,
                        clippy::as_conversions,
                        reason = "embeddings are downcast to f32 for storage; precision loss is acceptable"
                    )]
                    let value = n.as_f64().map(|f| f as f32);
                    value.ok_or_else(|| LlmError::Provider {
                        message: format!(
                            "embedding response item {item_idx} has non-numeric value at position {num_idx}"
                        ),
                    })
                })
                .collect()
        })
        .collect()
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
#[expect(
    clippy::panic_in_result_fn,
    reason = "asserts in `?`-returning tests; the test-exemption equivalent of clippy.toml's allow-panic-in-tests"
)]
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

    #[test]
    fn build_embed_body_omits_dimensions_when_unset() {
        let body = build_embed_body("text-embedding-3-large", &["hi"], None);
        assert!(
            body.get("dimensions").is_none(),
            "unset dimensions must be omitted so the provider returns native width: {body}"
        );
        assert_eq!(body.get("model"), Some(&json!("text-embedding-3-large")));
    }

    #[test]
    fn build_embed_body_includes_dimensions_when_set() {
        let body = build_embed_body("text-embedding-3-large", &["hi"], Some(256));
        assert_eq!(body.get("dimensions"), Some(&json!(256)));
    }

    #[test]
    fn parse_embedding_response_accepts_vectors() -> Result<(), String> {
        let resp = json!({
            "data": [
                {"embedding": [1.0, 2.5]},
                {"embedding": [-3.0, 4.25]}
            ]
        });

        let vectors = parse_embedding_response(&resp, 2).map_err(|e| e.to_string())?;

        assert_eq!(vectors, vec![vec![1.0, 2.5], vec![-3.0, 4.25]]);
        Ok(())
    }

    #[test]
    fn parse_embedding_response_rejects_count_mismatch() -> Result<(), String> {
        let resp = json!({"data": [{"embedding": [1.0]}]});

        let Err(err) = parse_embedding_response(&resp, 2) else {
            return Err("expected count mismatch".into());
        };

        assert!(err.to_string().contains("1 vectors for 2 inputs"));
        Ok(())
    }

    #[test]
    fn parse_embedding_response_rejects_non_numeric_values() -> Result<(), String> {
        let resp = json!({"data": [{"embedding": [1.0, "bad"]}]});

        let Err(err) = parse_embedding_response(&resp, 1) else {
            return Err("expected non-numeric value".into());
        };

        assert!(err.to_string().contains("non-numeric value"));
        Ok(())
    }
}
