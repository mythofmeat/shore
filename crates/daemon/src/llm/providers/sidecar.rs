use std::path::Path;

use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::{AsyncWriteExt, DuplexStream};
use tracing::warn;

use crate::llm::types::{GenerateResponse, ImageGenerateParams, ImageGenerateResponse, LlmRequest};
use crate::llm::LlmError;

use super::{check_response, format_reqwest_error, NON_STREAMING_TIMEOUT};

const SIDECAR_ORIGIN: &str = "http://sidecar";

#[cfg(unix)]
fn sidecar_client(socket_path: &Path) -> Result<reqwest::Client, LlmError> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .no_proxy()
        .unix_socket(socket_path)
        .build()
        .map_err(LlmError::Request)
}

#[cfg(not(unix))]
fn sidecar_client(_socket_path: &Path) -> Result<reqwest::Client, LlmError> {
    Err(LlmError::Provider {
        message: "LLM sidecar transport requires Unix domain sockets".into(),
    })
}

pub(crate) async fn stream(
    request: &LlmRequest,
    socket_path: &Path,
) -> Result<DuplexStream, LlmError> {
    let client = sidecar_client(socket_path)?;
    let response = client
        .post(format!("{SIDECAR_ORIGIN}/v1/stream"))
        .json(request)
        .send()
        .await?;
    let checked = check_response(response).await?;

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

pub(crate) async fn generate(
    request: &LlmRequest,
    socket_path: &Path,
) -> Result<GenerateResponse, LlmError> {
    let client = sidecar_client(socket_path)?;
    let response = client
        .post(format!("{SIDECAR_ORIGIN}/v1/generate"))
        .json(request)
        .timeout(NON_STREAMING_TIMEOUT)
        .send()
        .await?;
    let checked = check_response(response).await?;
    let body = checked.text().await?;
    serde_json::from_str(&body).map_err(|e| LlmError::Provider {
        message: format!(
            "sidecar /v1/generate response was not valid JSON: {e}; body preview: {}",
            super::body_preview(&body, 200)
        ),
    })
}

pub(crate) async fn image_generate(
    params: &ImageGenerateParams<'_>,
    socket_path: &Path,
) -> Result<ImageGenerateResponse, LlmError> {
    let client = sidecar_client(socket_path)?;
    let request = SidecarImageRequest::from(params);
    let response = client
        .post(format!("{SIDECAR_ORIGIN}/v1/image"))
        .json(&request)
        .timeout(NON_STREAMING_TIMEOUT)
        .send()
        .await?;
    let checked = check_response(response).await?;
    let body = checked.text().await?;
    serde_json::from_str(&body).map_err(|e| LlmError::Provider {
        message: format!(
            "sidecar /v1/image response was not valid JSON: {e}; body preview: {}",
            super::body_preview(&body, 200)
        ),
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
            messages: vec![json!({"role": "user", "content": "hi"})],
            system: None,
            tools: None,
            max_tokens: 128,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: Some("openai".into()),
            rid: None,
            forensic_character: None,
            retain_long: false,
            keepalive_interval: None,
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

        let resp = generate(&test_request(), &socket).await?;
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

        let mut reader = stream(&test_request(), &socket).await?;
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

        let params = ImageGenerateParams {
            provider_key: "openrouter",
            model: "image-model",
            api_key: "sk-test",
            base_url: Some("https://openrouter.ai/api/v1"),
            prompt: "draw a test",
            size: None,
            quality: None,
            aspect_ratio: Some("16:9"),
            image_size: Some("1024x576"),
        };
        let resp = image_generate(&params, &socket).await?;
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

        let Err(err) = generate(&test_request(), &socket).await else {
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
}
