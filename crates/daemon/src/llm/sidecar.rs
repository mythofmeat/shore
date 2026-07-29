//! Transport for chat, image, and streaming calls.
//!
//! Every provider request goes over a Unix socket to the Bun
//! `shore-llm-sidecar`, which owns all per-provider SDK code — there is no
//! Rust-side provider branch. Embeddings are the one exception: they speak a
//! single OpenAI-compatible shape and go out over plain HTTP from
//! [`crate::llm::embed`].

use std::{path::Path, time::Duration};

use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncWriteExt, DuplexStream};
use tracing::{debug, warn};

use crate::llm::types::{
    CallContext, GenerateResponse, ImageGenerateParams, ImageGenerateResponse, LlmRequest,
};
use crate::llm::{body_preview, check_response, LlmError};

/// Status the sidecar returns for a call refused by a usage budget.
///
/// Distinct from anything a provider produces, so a policy refusal can be told
/// apart from an upstream failure. Mirrors `BUDGET_BLOCKED_STATUS` in
/// `llm-sidecar/src/server.ts`.
const BUDGET_BLOCKED: u16 = 402;

/// [`check_response`], plus the budget refusal.
///
/// A blocked call is not a transport failure and must not read like one: the
/// body is the budget's own message, and surfacing it as `Provider` keeps the
/// text identical to what the daemon raised when it ran this check itself.
async fn check_sidecar_response(
    response: reqwest::Response,
) -> Result<reqwest::Response, LlmError> {
    if response.status().as_u16() == BUDGET_BLOCKED {
        let message = response.text().await.unwrap_or_default();
        return Err(LlmError::Provider { message });
    }
    check_response(response).await
}

const SIDECAR_ORIGIN: &str = "http://sidecar";

/// Per-request ceiling for non-streaming calls.
///
/// Streaming has no whole-request bound (the sidecar reader handles
/// inter-event timing on its own), but non-streaming buffers the full
/// body and so needs *some* deadline — set generously to accommodate
/// compaction/dreaming on slow reasoning models.
const NON_STREAMING_TIMEOUT: Duration = Duration::from_mins(30);

/// Format a reqwest error with its full source chain so the proximate
/// cause (e.g. `request timed out`) appears in the log instead of just
/// the generic top-level `error decoding response body`.
fn format_reqwest_error(err: &reqwest::Error) -> String {
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

/// Build a reqwest client bound to the sidecar's Unix socket.
#[cfg(unix)]
fn sidecar_client(socket_path: Option<&Path>) -> Result<reqwest::Client, LlmError> {
    let Some(path) = socket_path else {
        return Err(LlmError::Provider {
            message: "LLM sidecar socket is not configured; stream/generate/image calls require shore-llm-sidecar".into(),
        });
    };
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .no_proxy()
        .unix_socket(path)
        .build()
        .map_err(LlmError::Request)
}

#[cfg(not(unix))]
fn sidecar_client(_socket_path: Option<&Path>) -> Result<reqwest::Client, LlmError> {
    Err(LlmError::Provider {
        message: "LLM sidecar transport requires Unix domain sockets".into(),
    })
}

/// POST `body` to the sidecar at `path` and deserialize the buffered reply.
async fn post_json<Req, Resp>(
    socket_path: Option<&Path>,
    path: &str,
    body: &Req,
) -> Result<Resp, LlmError>
where
    Req: Serialize + ?Sized,
    Resp: DeserializeOwned,
{
    let client = sidecar_client(socket_path)?;
    let response = client
        .post(format!("{SIDECAR_ORIGIN}{path}"))
        .json(body)
        .timeout(NON_STREAMING_TIMEOUT)
        .send()
        .await?;
    let checked = check_sidecar_response(response).await?;
    let text = checked.text().await?;
    serde_json::from_str(&text).map_err(|e| LlmError::Provider {
        message: format!(
            "sidecar {path} response was not valid JSON: {e}; body preview: {}",
            body_preview(&text, 200)
        ),
    })
}

/// Send a streaming request.
///
/// Returns the read half of a `DuplexStream` that yields NDJSON `StreamEvent`
/// lines, pumped from the sidecar response body by a background task.
pub(crate) async fn stream(
    request: &LlmRequest,
    context: Option<CallContext<'_>>,
    socket_path: Option<&Path>,
) -> Result<DuplexStream, LlmError> {
    debug!(
        sdk = ?request.sdk,
        model = %request.model,
        max_tokens = request.max_tokens,
        message_count = request.messages.len(),
        has_tools = request.tools.is_some(),
        "dispatching streaming LLM request through sidecar"
    );
    open_stream(request, context, socket_path)
        .await
        .inspect_err(|e| {
        warn!(sdk = ?request.sdk, model = %request.model, error = %e, "streaming request failed");
    })
}

/// The outbound body: the request plus the per-call bookkeeping labels.
///
/// Flattened over a *borrowed* request so attaching labels costs no clone of
/// the message history. `context` is what the sidecar writes ledger and
/// forensic rows from; it is absent only for callers with no ledger behind
/// them, and then the sidecar records nothing. See [`CallContext`].
#[derive(Serialize)]
struct OutboundRequest<'req> {
    #[serde(flatten)]
    request: &'req LlmRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<CallContext<'req>>,
}

async fn open_stream(
    request: &LlmRequest,
    context: Option<CallContext<'_>>,
    socket_path: Option<&Path>,
) -> Result<DuplexStream, LlmError> {
    let client = sidecar_client(socket_path)?;
    let response = client
        .post(format!("{SIDECAR_ORIGIN}/v1/stream"))
        .json(&OutboundRequest { request, context })
        .send()
        .await?;
    let checked = check_sidecar_response(response).await?;

    let (mut writer, reader) = tokio::io::duplex(64 * 1024);
    let _stream_pump = tokio::spawn(async move {
        let mut body = checked.bytes_stream();
        while let Some(next) = body.next().await {
            match next {
                Ok(bytes) => {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    warn!(
                        error = %format_reqwest_error(&e),
                        "LLM sidecar stream body read error"
                    );
                    break;
                }
            }
        }
    });

    Ok(reader)
}

/// Send a non-streaming completion request.
pub(crate) async fn generate(
    request: &LlmRequest,
    context: Option<CallContext<'_>>,
    socket_path: Option<&Path>,
) -> Result<GenerateResponse, LlmError> {
    debug!(
        sdk = ?request.sdk,
        model = %request.model,
        max_tokens = request.max_tokens,
        message_count = request.messages.len(),
        "dispatching non-streaming LLM request through sidecar"
    );
    let result: Result<GenerateResponse, LlmError> = post_json(
        socket_path,
        "/v1/generate",
        &OutboundRequest { request, context },
    )
    .await;
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

/// Send an image generation request.
pub(crate) async fn image_generate(
    params: &ImageGenerateParams<'_>,
    socket_path: Option<&Path>,
) -> Result<ImageGenerateResponse, LlmError> {
    debug!(model = %params.model, "dispatching image generation request through sidecar");
    post_json(socket_path, "/v1/image", &SidecarImageRequest::from(params))
        .await
        .inspect_err(|e| {
            warn!(model = %params.model, error = %e, "image generation request failed");
        })
}

#[derive(Serialize)]
struct SidecarImageRequest<'img> {
    provider_key: &'img str,
    model: &'img str,
    api_key: &'img str,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<&'img str>,
    prompt: &'img str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<&'img str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<&'img str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<&'img str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_size: Option<&'img str>,
}

impl<'img> From<&'img ImageGenerateParams<'img>> for SidecarImageRequest<'img> {
    fn from(params: &'img ImageGenerateParams<'img>) -> Self {
        Self {
            provider_key: params.provider_key,
            model: params.model,
            api_key: params.api_key,
            base_url: params.base_url,
            prompt: params.prompt,
            size: params.size,
            quality: params.quality,
            aspect_ratio: params.aspect_ratio,
            image_size: params.image_size,
        }
    }
}

#[cfg(all(test, unix))]
#[expect(
    clippy::panic_in_result_fn,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::wildcard_enum_match_arm,
    clippy::let_underscore_must_use,
    unused_results,
    reason = "test scaffolding: a hand-rolled HTTP-over-Unix-socket harness with asserts in `?`-returning tests; the panic/indexing/arithmetic lints are the test-exemption equivalent of clippy.toml's allow-unwrap/expect/panic-in-tests"
)]
mod tests {
    use super::*;
    use crate::llm::types::{WireMessage, WireRole};
    use std::io;

    use serde_json::json;
    use shore_common::config::models::Sdk;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::sync::oneshot;

    type TestError = Box<dyn std::error::Error + Send + Sync + 'static>;
    type TestResult<T = ()> = Result<T, TestError>;

    fn test_request() -> LlmRequest {
        LlmRequest {
            sdk: Sdk::Openai,
            model: "openai/gpt-test".into(),
            api_key: "sk-test".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![WireMessage::text(WireRole::User, "hi")],
            system: Vec::new(),
            tools: None,
            max_tokens: 128,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: Some("openai".into()),
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        }
    }

    fn test_image_params() -> ImageGenerateParams<'static> {
        ImageGenerateParams {
            provider_key: "openrouter",
            model: "image-model",
            api_key: "sk-test",
            base_url: Some("https://openrouter.ai/api/v1"),
            prompt: "draw a test",
            size: None,
            quality: None,
            aspect_ratio: Some("16:9"),
            image_size: Some("1024x576"),
        }
    }

    fn serve_once(
        socket_path: &Path,
        status: &str,
        body: String,
    ) -> TestResult<oneshot::Receiver<TestResult<(String, String)>>> {
        let listener = UnixListener::bind(socket_path)?;
        let (tx, rx) = oneshot::channel();
        let status_owned = status.to_owned();
        tokio::spawn(async move {
            let result = async {
                let (mut stream, _) = listener.accept().await?;
                let captured = read_http_request(&mut stream).await?;
                let response = format!(
                    "HTTP/1.1 {status_owned}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await?;
                TestResult::Ok(captured)
            }
            .await;
            let _ = tx.send(result);
        });
        Ok(rx)
    }

    async fn read_http_request(stream: &mut UnixStream) -> TestResult<(String, String)> {
        let mut buf = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 1024];
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "client closed before headers",
                )
                .into());
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                break pos + 4;
            }
        };

        let headers = String::from_utf8(buf[..header_end].to_vec())?;
        let request_line = headers.lines().next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "missing HTTP request line")
        })?;
        let path = request_line
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request path"))?
            .to_owned();
        let mut content_len = 0;
        for line in headers.lines() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.eq_ignore_ascii_case("content-length") {
                content_len = value.trim().parse::<usize>()?;
                break;
            }
        }

        while buf.len() < header_end + content_len {
            let mut chunk = [0_u8; 1024];
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "client closed before body",
                )
                .into());
            }
            buf.extend_from_slice(&chunk[..n]);
        }

        let body = String::from_utf8(buf[header_end..header_end + content_len].to_vec())?;
        Ok((path, body))
    }

    fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    #[tokio::test]
    async fn generate_posts_request_over_unix_socket() -> TestResult {
        let tmp = tempfile::tempdir()?;
        let socket = tmp.path().join("llm.sock");
        let response_body = json!({
            "content": "hello",
            "content_blocks": [{"type": "text", "text": "hello"}],
            "finish_reason": "end_turn",
            "usage": {
                "input_tokens": 1,
                "output_tokens": 2,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 0
            },
            "timing": {"total_ms": 3, "time_to_first_token_ms": 3},
            "model": "openai/gpt-test"
        })
        .to_string();
        let captured = serve_once(&socket, "200 OK", response_body)?;

        let resp = generate(&test_request(), None, Some(&socket)).await?;
        let (path, body) = captured.await??;
        let parsed: serde_json::Value = serde_json::from_str(&body)?;

        assert_eq!(path, "/v1/generate");
        assert_eq!(parsed["model"], "openai/gpt-test");
        assert_eq!(resp.content, "hello");
        assert_eq!(resp.usage.output_tokens, 2);
        Ok(())
    }

    #[tokio::test]
    async fn stream_returns_sidecar_ndjson_reader() -> TestResult {
        let tmp = tempfile::tempdir()?;
        let socket = tmp.path().join("llm.sock");
        let response_body = concat!(
            "{\"type\":\"start\",\"model\":\"m\"}\n",
            "{\"type\":\"done\",\"content\":\"\",\"finish_reason\":\"end_turn\",",
            "\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"cache_read_tokens\":0,\"cache_creation_tokens\":0},",
            "\"timing\":{\"total_ms\":1,\"time_to_first_token_ms\":1}}\n"
        ).to_owned();
        let captured = serve_once(&socket, "200 OK", response_body)?;

        let mut reader = stream(&test_request(), None, Some(&socket)).await?;
        let mut body = String::new();
        reader.read_to_string(&mut body).await?;
        let (path, _) = captured.await??;

        assert_eq!(path, "/v1/stream");
        assert!(body.contains("\"type\":\"start\""));
        assert!(body.contains("\"type\":\"done\""));
        Ok(())
    }

    #[tokio::test]
    async fn image_generate_posts_request_over_unix_socket() -> TestResult {
        let tmp = tempfile::tempdir()?;
        let socket = tmp.path().join("llm.sock");
        let response_body = json!({
            "url": "https://example.test/image.png",
            "revised_prompt": "a better prompt",
            "timing": {"total_ms": 5}
        })
        .to_string();
        let captured = serve_once(&socket, "200 OK", response_body)?;

        let resp = image_generate(&test_image_params(), Some(&socket)).await?;
        let (path, body) = captured.await??;
        let parsed: serde_json::Value = serde_json::from_str(&body)?;

        assert_eq!(path, "/v1/image");
        assert_eq!(parsed["provider_key"], "openrouter");
        assert_eq!(parsed["base_url"], "https://openrouter.ai/api/v1");
        assert_eq!(parsed["aspect_ratio"], "16:9");
        assert_eq!(parsed["image_size"], "1024x576");
        assert_eq!(resp.url, "https://example.test/image.png");
        assert_eq!(resp.timing.total_ms, 5);
        Ok(())
    }

    #[tokio::test]
    async fn non_success_status_maps_to_http_status() -> TestResult {
        let tmp = tempfile::tempdir()?;
        let socket = tmp.path().join("llm.sock");
        let captured = serve_once(&socket, "429 Too Many Requests", "slow down".into())?;

        let Err(err) = generate(&test_request(), None, Some(&socket)).await else {
            return Err(io::Error::other("expected sidecar 429 to fail").into());
        };
        let (path, _) = captured.await??;

        assert_eq!(path, "/v1/generate");
        match err {
            LlmError::HttpStatus { status, body } => {
                assert_eq!(status, 429);
                assert_eq!(body, "slow down");
            }
            other => {
                return Err(io::Error::other(format!("expected HttpStatus, got {other:?}")).into());
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn calls_without_a_socket_name_the_sidecar() -> TestResult {
        let Err(stream_err) = stream(&test_request(), None, None).await else {
            return Err(io::Error::other("stream without sidecar unexpectedly succeeded").into());
        };
        let Err(generate_err) = generate(&test_request(), None, None).await else {
            return Err(io::Error::other("generate without sidecar unexpectedly succeeded").into());
        };
        let Err(image_err) = image_generate(&test_image_params(), None).await else {
            return Err(io::Error::other("image without sidecar unexpectedly succeeded").into());
        };

        for err in [stream_err, generate_err, image_err] {
            assert!(
                err.to_string().contains("shore-llm-sidecar"),
                "unconfigured-socket error must name the sidecar binary: {err}"
            );
        }
        Ok(())
    }
}
