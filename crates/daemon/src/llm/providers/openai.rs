use serde_json::{json, Value};

use crate::llm::LlmError;

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

/// Generate embeddings via an OpenAI-compatible embeddings API.
///
/// `dimensions` maps to the OpenAI `dimensions` request field, which asks
/// `text-embedding-3*` models to return dimension-reduced vectors. `None`
/// omits the field so the provider returns the model's native width.
pub(crate) async fn embed(
    client: &reqwest::Client,
    _provider: &str,
    model: &str,
    api_key: &str,
    base_url: Option<&str>,
    input: &[&str],
    dimensions: Option<usize>,
) -> Result<Vec<Vec<f32>>, LlmError> {
    let base = base_url.unwrap_or(OPENAI_BASE_URL);
    let url = format!("{base}/embeddings");

    let body = build_embed_body(model, input, dimensions);

    let response = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await?;

    let checked = super::check_response(response).await?;

    let resp_text = checked.text().await.map_err(LlmError::Request)?;
    let resp: Value = serde_json::from_str(&resp_text).map_err(|e| LlmError::Provider {
        message: format!(
            "embedding response was not valid JSON: {e}; body preview: {}",
            super::body_preview(&resp_text, 200)
        ),
    })?;

    parse_embedding_response(&resp, input.len())
}

/// Build the `/v1/embeddings` request body. `dimensions` is emitted only when
/// `Some`; `None` omits the field so the provider returns the native width.
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

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "asserts in `?`-returning tests; the test-exemption equivalent of clippy.toml's allow-panic-in-tests"
)]
mod tests {
    use super::*;

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
