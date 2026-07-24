pub(crate) mod openai;
pub(crate) mod sidecar;

use std::{path::Path, time::Duration};

use tracing::{debug, error, warn};

use crate::llm::types::{GenerateResponse, ImageGenerateParams, ImageGenerateResponse, LlmRequest};
use crate::llm::LlmError;
use tokio::io::DuplexStream;

/// Per-request ceiling for non-streaming generate calls.
///
/// Streaming has no whole-request bound (the sidecar reader handles
/// inter-event timing on its own), but non-streaming buffers the full
/// body and so needs *some* deadline — set generously to accommodate
/// compaction/dreaming on slow reasoning models.
pub(crate) const NON_STREAMING_TIMEOUT: Duration = Duration::from_mins(30);

/// Format a reqwest error with its full source chain so the proximate
/// cause (e.g. `request timed out`) appears in the log instead of just
/// the generic top-level `error decoding response body`.
pub(crate) fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(err);
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    if err.is_timeout() && !out.contains("timed out") {
        out.push_str(" (request timed out)");
    }
    out
}

/// Truncate a string for log preview, respecting UTF-8 char boundaries.
fn body_preview(body: &str, max: usize) -> &str {
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

fn missing_sidecar_error() -> LlmError {
    LlmError::Provider {
        message: "LLM sidecar socket is not configured; stream/generate/image calls require shore-llm-sidecar".into(),
    }
}

/// Dispatch a streaming request through the sidecar.
///
/// Returns the read half of a DuplexStream that yields NDJSON `StreamEvent` lines.
pub(crate) async fn stream(
    _client: &reqwest::Client,
    request: &LlmRequest,
    sidecar_socket: Option<&Path>,
) -> Result<DuplexStream, LlmError> {
    debug!(
        sdk = ?request.sdk,
        model = %request.model,
        max_tokens = request.max_tokens,
        message_count = request.messages.len(),
        has_tools = request.tools.is_some(),
        "dispatching streaming LLM request through sidecar"
    );
    let Some(socket) = sidecar_socket else {
        let error = missing_sidecar_error();
        warn!(sdk = ?request.sdk, model = %request.model, error = %error, "streaming request failed");
        return Err(error);
    };

    let result = sidecar::stream(request, socket).await;
    if let Err(e) = &result {
        warn!(sdk = ?request.sdk, model = %request.model, error = %e, "streaming request failed");
    }
    result
}

/// Dispatch a non-streaming generate request through the sidecar.
pub(crate) async fn generate(
    _client: &reqwest::Client,
    request: &LlmRequest,
    sidecar_socket: Option<&Path>,
) -> Result<GenerateResponse, LlmError> {
    debug!(
        sdk = ?request.sdk,
        model = %request.model,
        max_tokens = request.max_tokens,
        message_count = request.messages.len(),
        "dispatching non-streaming LLM request through sidecar"
    );
    let Some(socket) = sidecar_socket else {
        let error = missing_sidecar_error();
        warn!(sdk = ?request.sdk, model = %request.model, error = %error, "non-streaming request failed");
        return Err(error);
    };

    let result = sidecar::generate(request, socket).await;
    match &result {
        Ok(resp) => debug!(
            model = %resp.model,
            finish_reason = %resp.finish_reason,
            input_tokens = resp.usage.input_tokens,
            output_tokens = resp.usage.output_tokens,
            total_ms = resp.timing.total_ms,
            "non-streaming request completed"
        ),
        Err(e) => {
            warn!(sdk = ?request.sdk, model = %request.model, error = %e, "non-streaming request failed");
        }
    }
    result
}

/// Dispatch an embedding request.
pub(crate) async fn embed(
    client: &reqwest::Client,
    provider: &str,
    model: &str,
    api_key: &str,
    base_url: Option<&str>,
    input: &[&str],
    dimensions: Option<usize>,
) -> Result<Vec<Vec<f32>>, LlmError> {
    debug!(provider = %provider, model = %model, input_count = input.len(), "dispatching embedding request");
    openai::embed(
        client, provider, model, api_key, base_url, input, dimensions,
    )
    .await
}

/// Dispatch an image generation request through the sidecar.
pub(crate) async fn image_generate(
    _client: &reqwest::Client,
    params: &ImageGenerateParams<'_>,
    sidecar_socket: Option<&Path>,
) -> Result<ImageGenerateResponse, LlmError> {
    debug!(model = %params.model, "dispatching image generation request through sidecar");
    if let Some(socket) = sidecar_socket {
        sidecar::image_generate(params, socket).await
    } else {
        let error = missing_sidecar_error();
        warn!(model = %params.model, error = %error, "image generation request failed");
        Err(error)
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "asserts in `?`-returning tests; the test-exemption equivalent of clippy.toml's allow-panic-in-tests"
)]
mod tests {
    use super::*;
    use serde_json::json;
    use shore_common::config::models::Sdk;

    fn make_request(sdk: Sdk) -> LlmRequest {
        LlmRequest {
            sdk,
            model: "test-model".into(),
            api_key: "sk-test".into(),
            api_key_name: None,
            base_url: Some("http://127.0.0.1:1".into()),
            messages: vec![json!({"role": "user", "content": "hi"})],
            system: None,
            tools: None,
            max_tokens: 100,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
        }
    }

    #[test]
    fn body_preview_handles_multibyte_at_boundary() {
        // 199 ASCII bytes + "é" (2 bytes) = 201 bytes total.
        // Slicing at byte 200 lands inside "é" and must not panic.
        let body = format!("{}{}", "x".repeat(199), "é");
        assert_eq!(body.len(), 201);
        let preview = body_preview(&body, 200);
        assert!(preview.len() <= 200);
        assert!(preview.is_char_boundary(preview.len()));
    }

    #[tokio::test]
    async fn stream_without_sidecar_returns_clear_error() -> Result<(), String> {
        let client = reqwest::Client::new();
        let request = make_request(Sdk::Openai);
        let Err(err) = stream(&client, &request, None).await else {
            return Err("stream without sidecar unexpectedly succeeded".into());
        };

        assert!(err.to_string().contains("shore-llm-sidecar"));
        Ok(())
    }

    #[tokio::test]
    async fn generate_without_sidecar_returns_clear_error() -> Result<(), String> {
        let client = reqwest::Client::new();
        let request = make_request(Sdk::Anthropic);
        let Err(err) = generate(&client, &request, None).await else {
            return Err("generate without sidecar unexpectedly succeeded".into());
        };

        assert!(err.to_string().contains("shore-llm-sidecar"));
        Ok(())
    }

    #[tokio::test]
    async fn image_generate_without_sidecar_returns_clear_error() -> Result<(), String> {
        let client = reqwest::Client::new();
        let params = ImageGenerateParams {
            provider_key: "openai",
            model: "gpt-image-1",
            api_key: "sk-test",
            base_url: None,
            prompt: "draw a shore",
            size: None,
            quality: None,
            aspect_ratio: None,
            image_size: None,
        };
        let Err(err) = image_generate(&client, &params, None).await else {
            return Err("image generation without sidecar unexpectedly succeeded".into());
        };

        assert!(err.to_string().contains("shore-llm-sidecar"));
        Ok(())
    }
}
