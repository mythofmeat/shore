use std::fmt::Write as _;
#[cfg(unix)]
use std::{
    collections::VecDeque,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{json, Value};
#[cfg(unix)]
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Mutex,
    task::JoinHandle,
};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

// ── ContentBlock ─────────────────────────────────────────────────────────────

#[derive(Debug)]
enum ContentBlock {
    Text(String),
    Thinking {
        thinking: String,
        signature: Option<String>,
    },
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
}

// ── AnthropicStreamBuilder ───────────────────────────────────────────────────

#[derive(Debug)]
#[must_use]
pub struct AnthropicStreamBuilder {
    content_blocks: Vec<ContentBlock>,
    input_tokens: u32,
    output_tokens: u32,
    cache_read_input_tokens: u32,
    cache_creation_input_tokens: u32,
    model: String,
    stop_reason: String,
}

impl AnthropicStreamBuilder {
    pub fn new() -> Self {
        Self {
            content_blocks: Vec::new(),
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            model: "claude-3-5-sonnet-20241022".to_owned(),
            stop_reason: "end_turn".to_owned(),
        }
    }

    pub fn text(mut self, t: &str) -> Self {
        self.content_blocks.push(ContentBlock::Text(t.to_owned()));
        self
    }

    /// Emit a `thinking` block. Pass `None` for `signature` to skip the
    /// signature_delta event (matches what providers return when the
    /// signature is empty/absent).
    pub fn thinking(mut self, thinking: &str, signature: Option<&str>) -> Self {
        self.content_blocks.push(ContentBlock::Thinking {
            thinking: thinking.to_owned(),
            signature: signature.map(String::from),
        });
        self
    }

    /// Emit a `redacted_thinking` block. The `data` is opaque to the
    /// adapter; OpenRouter relays signed reasoning content through these
    /// with a `openrouter.reasoning:` prefix.
    pub fn redacted_thinking(mut self, data: &str) -> Self {
        self.content_blocks.push(ContentBlock::RedactedThinking {
            data: data.to_owned(),
        });
        self
    }

    pub fn tool_use(mut self, id: &str, name: &str, input: Value) -> Self {
        "tool_use".clone_into(&mut self.stop_reason);
        self.content_blocks.push(ContentBlock::ToolUse {
            id: id.to_owned(),
            name: name.to_owned(),
            input,
        });
        self
    }

    pub fn usage(mut self, input: u32, output: u32) -> Self {
        self.input_tokens = input;
        self.output_tokens = output;
        self
    }

    /// Set cache usage fields carried by the sidecar's normalized usage event.
    pub fn cache_usage(mut self, read: u32, creation: u32) -> Self {
        self.cache_read_input_tokens = read;
        self.cache_creation_input_tokens = creation;
        self
    }

    pub fn model(mut self, m: &str) -> Self {
        m.clone_into(&mut self.model);
        self
    }

    pub fn stop_reason(mut self, r: &str) -> Self {
        r.clone_into(&mut self.stop_reason);
        self
    }

    pub fn build_sidecar_ndjson(self) -> String {
        let mut out = String::new();
        let mut content = String::new();

        _ = writeln!(out, "{}", json!({"type": "start", "model": self.model}));

        for block in self.content_blocks {
            match block {
                ContentBlock::Text(text) => {
                    content.push_str(&text);
                    _ = writeln!(out, "{}", json!({"type": "text", "text": text}));
                }
                ContentBlock::Thinking {
                    thinking,
                    signature,
                } => {
                    _ = writeln!(out, "{}", json!({"type": "thinking", "text": thinking}));
                    if let Some(sig) = signature {
                        _ = writeln!(
                            out,
                            "{}",
                            json!({"type": "thinking_signature", "signature": sig})
                        );
                    }
                }
                ContentBlock::RedactedThinking { data } => {
                    _ = writeln!(
                        out,
                        "{}",
                        json!({"type": "redacted_thinking", "data": data})
                    );
                }
                ContentBlock::ToolUse { id, name, input } => {
                    _ = writeln!(
                        out,
                        "{}",
                        json!({"type": "tool_use", "id": id, "name": name, "input": input})
                    );
                }
            }
        }

        _ = writeln!(
            out,
            "{}",
            json!({
                "type": "done",
                "content": content,
                "finish_reason": self.stop_reason,
                "usage": {
                    "input_tokens": self.input_tokens,
                    "output_tokens": self.output_tokens,
                    "cache_read_tokens": self.cache_read_input_tokens,
                    "cache_creation_tokens": self.cache_creation_input_tokens,
                },
                "timing": {
                    "total_ms": 10,
                    "time_to_first_token_ms": 1,
                },
            })
        );

        out
    }
}

impl Default for AnthropicStreamBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ── AnthropicJsonBuilder ─────────────────────────────────────────────────────

/// Build normalized sidecar `GenerateResponse` bodies for tests that need
/// structured thinking/redacted-thinking blocks.
#[derive(Debug)]
#[must_use]
pub struct AnthropicJsonBuilder {
    content_blocks: Vec<ContentBlock>,
    input_tokens: u32,
    output_tokens: u32,
    cache_read_input_tokens: u32,
    cache_creation_input_tokens: u32,
    model: String,
    stop_reason: String,
}

impl AnthropicJsonBuilder {
    pub fn new() -> Self {
        Self {
            content_blocks: Vec::new(),
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            model: "claude-3-5-sonnet-20241022".to_owned(),
            stop_reason: "end_turn".to_owned(),
        }
    }

    pub fn text(mut self, t: &str) -> Self {
        self.content_blocks.push(ContentBlock::Text(t.to_owned()));
        self
    }

    pub fn thinking(mut self, thinking: &str, signature: Option<&str>) -> Self {
        self.content_blocks.push(ContentBlock::Thinking {
            thinking: thinking.to_owned(),
            signature: signature.map(String::from),
        });
        self
    }

    pub fn redacted_thinking(mut self, data: &str) -> Self {
        self.content_blocks.push(ContentBlock::RedactedThinking {
            data: data.to_owned(),
        });
        self
    }

    pub fn tool_use(mut self, id: &str, name: &str, input: Value) -> Self {
        "tool_use".clone_into(&mut self.stop_reason);
        self.content_blocks.push(ContentBlock::ToolUse {
            id: id.to_owned(),
            name: name.to_owned(),
            input,
        });
        self
    }

    pub fn usage(mut self, input: u32, output: u32) -> Self {
        self.input_tokens = input;
        self.output_tokens = output;
        self
    }

    pub fn cache_usage(mut self, read: u32, creation: u32) -> Self {
        self.cache_read_input_tokens = read;
        self.cache_creation_input_tokens = creation;
        self
    }

    pub fn model(mut self, m: &str) -> Self {
        m.clone_into(&mut self.model);
        self
    }

    pub fn stop_reason(mut self, r: &str) -> Self {
        r.clone_into(&mut self.stop_reason);
        self
    }

    #[expect(
        clippy::indexing_slicing,
        reason = "serde_json index-assign on a Value literal we just built as an object"
    )]
    pub fn build_sidecar_generate(self) -> Value {
        let content_blocks: Vec<Value> = self
            .content_blocks
            .iter()
            .map(|b| match b {
                ContentBlock::Text(text) => json!({"type": "text", "text": text}),
                ContentBlock::Thinking {
                    thinking,
                    signature,
                } => {
                    let mut v = json!({"type": "thinking", "thinking": thinking});
                    if let Some(sig) = signature {
                        v["signature"] = json!(sig);
                    }
                    v
                }
                ContentBlock::RedactedThinking { data } => {
                    json!({"type": "redacted_thinking", "data": data})
                }
                ContentBlock::ToolUse { id, name, input } => json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": input,
                }),
            })
            .collect();
        let content = content_blocks
            .iter()
            .filter_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("");

        json!({
            "content": content,
            "content_blocks": content_blocks,
            "finish_reason": self.stop_reason,
            "usage": {
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "cache_read_tokens": self.cache_read_input_tokens,
                "cache_creation_tokens": self.cache_creation_input_tokens,
            },
            "timing": {
                "total_ms": 10,
                "time_to_first_token_ms": 1,
            },
            "model": self.model,
        })
    }
}

impl Default for AnthropicJsonBuilder {
    fn default() -> Self {
        Self::new()
    }
}

struct EmbeddingResponder {
    dimensions: usize,
}

impl Respond for EmbeddingResponder {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
        let input_count = match body.get("input") {
            Some(Value::Array(inputs)) => inputs.len(),
            Some(Value::String(_)) => 1,
            _ => 0,
        };
        let zeros: Vec<f64> = vec![0.0; self.dimensions];
        let data: Vec<Value> = (0..input_count)
            .map(|idx| {
                json!({
                    "object": "embedding",
                    "index": idx,
                    "embedding": zeros.clone(),
                })
            })
            .collect();
        let response = json!({
            "object": "list",
            "data": data,
            "model": "text-embedding-3-small",
            "usage": { "prompt_tokens": 8, "total_tokens": 8 }
        });
        ResponseTemplate::new(200).set_body_json(&response)
    }
}

// ── MockLlmSidecar ───────────────────────────────────────────────────────────

#[cfg(unix)]
enum SidecarResponseBody {
    Body(String),
    Hang,
}

#[cfg(unix)]
const STREAM_PATH: &str = "/v1/stream";
#[cfg(unix)]
const GENERATE_PATH: &str = "/v1/generate";
#[cfg(unix)]
const HEALTHZ_PATH: &str = "/healthz";

#[cfg(unix)]
struct QueuedSidecarResponse {
    path: &'static str,
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: SidecarResponseBody,
}

#[cfg(unix)]
impl QueuedSidecarResponse {
    fn json(path: &'static str, body: &Value) -> Self {
        Self {
            path,
            status: 200,
            reason: "OK",
            content_type: "application/json",
            body: SidecarResponseBody::Body(body.to_string()),
        }
    }

    fn ndjson(path: &'static str, events: Vec<Value>) -> Self {
        let mut body = String::new();
        for event in events {
            _ = writeln!(body, "{event}");
        }
        Self {
            path,
            status: 200,
            reason: "OK",
            content_type: "application/x-ndjson",
            body: SidecarResponseBody::Body(body),
        }
    }

    fn text(
        path: &'static str,
        status: u16,
        reason: &'static str,
        body: impl Into<String>,
    ) -> Self {
        Self {
            path,
            status,
            reason,
            content_type: "text/plain",
            body: SidecarResponseBody::Body(body.into()),
        }
    }

    fn hanging(path: &'static str) -> Self {
        Self {
            path,
            status: 200,
            reason: "OK",
            content_type: "application/x-ndjson",
            body: SidecarResponseBody::Hang,
        }
    }
}

/// Unix-domain mock for the Rust ↔ TypeScript sidecar IPC contract.
///
/// This intentionally returns normalized sidecar responses rather than
/// provider-native Anthropic/OpenAI bodies. Tests using this mock exercise the
/// daemon's sidecar contract boundary; provider wire-shape coverage belongs in
/// the sidecar adapter tests.
#[cfg(unix)]
pub struct MockLlmSidecar {
    server: MockServer,
    _tmp: tempfile::TempDir,
    socket_path: PathBuf,
    responses: Arc<Mutex<VecDeque<QueuedSidecarResponse>>>,
    received: Arc<Mutex<Vec<(String, Value)>>>,
    task: JoinHandle<()>,
}

#[cfg(unix)]
impl std::fmt::Debug for MockLlmSidecar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockLlmSidecar")
            .field("socket_path", &self.socket_path)
            .finish_non_exhaustive()
    }
}

#[cfg(unix)]
impl MockLlmSidecar {
    #[expect(
        clippy::expect_used,
        reason = "test harness setup fails fast when the mock sidecar cannot bind"
    )]
    pub async fn start() -> Self {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().expect("mock sidecar tempdir");
        let socket_path = tmp.path().join("llm-sidecar.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind mock sidecar socket");
        let responses = Arc::new(Mutex::new(VecDeque::new()));
        let received = Arc::new(Mutex::new(Vec::new()));
        let task = tokio::spawn(run_mock_sidecar(
            listener,
            Arc::clone(&responses),
            Arc::clone(&received),
        ));

        Self {
            server,
            _tmp: tmp,
            socket_path,
            responses,
            received,
            task,
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub fn base_url(&self) -> String {
        self.server.uri()
    }

    pub async fn enqueue_text(&self, text: &str) {
        self.enqueue_stream_text(text).await;
    }

    pub async fn enqueue_text_optional(&self, text: &str) {
        self.enqueue_stream_text(text).await;
    }

    pub async fn enqueue_tool_use(&self, id: &str, name: &str, input: Value) {
        self.enqueue_stream_tool_use(id, name, input).await;
    }

    pub async fn enqueue_raw_ndjson(&self, body: String) {
        self.enqueue(QueuedSidecarResponse {
            path: STREAM_PATH,
            status: 200,
            reason: "OK",
            content_type: "application/x-ndjson",
            body: SidecarResponseBody::Body(body),
        })
        .await;
    }

    pub async fn enqueue_stream(&self, builder: AnthropicStreamBuilder) {
        self.enqueue_raw_ndjson(builder.build_sidecar_ndjson())
            .await;
    }

    pub async fn enqueue_error(&self, status: u16, body: &str) {
        self.enqueue(QueuedSidecarResponse::text(
            STREAM_PATH,
            status,
            "Error",
            body,
        ))
        .await;
    }

    pub async fn enqueue_error_optional(&self, status: u16, body: &str) {
        self.enqueue(QueuedSidecarResponse::text(
            GENERATE_PATH,
            status,
            "Error",
            body,
        ))
        .await;
    }

    pub async fn enqueue_hanging(&self) {
        self.enqueue(QueuedSidecarResponse::hanging(STREAM_PATH))
            .await;
    }

    // NB: this hangs the STREAM endpoint, not generate, despite the `_optional`
    // suffix the error/text helpers use for `/v1/generate`. Every caller sends
    // an interactive streaming message (`send_message(..., true)` → `/v1/stream`),
    // so the hang must land on STREAM_PATH; pointing it at GENERATE_PATH makes
    // those streaming requests 500 ("no queued response"), which the retry
    // policy then retries and steals later stream responses.
    pub async fn enqueue_hanging_optional(&self) {
        self.enqueue_hanging().await;
    }

    pub async fn enqueue_stream_text(&self, text: &str) {
        let mut events = vec![json!({"type": "start", "model": "claude-3-5-sonnet-20241022"})];
        if !text.is_empty() {
            events.push(json!({"type": "text", "text": text}));
        }
        events.push(done_event(text, "end_turn"));
        self.enqueue(QueuedSidecarResponse::ndjson(STREAM_PATH, events))
            .await;
    }

    pub async fn enqueue_stream_tool_use(&self, id: &str, name: &str, input: Value) {
        self.enqueue(QueuedSidecarResponse::ndjson(
            STREAM_PATH,
            vec![
                json!({"type": "start", "model": "claude-3-5-sonnet-20241022"}),
                json!({"type": "tool_use", "id": id, "name": name, "input": input}),
                done_event("", "tool_use"),
            ],
        ))
        .await;
    }

    pub async fn enqueue_json_text(&self, text: &str) {
        self.enqueue(QueuedSidecarResponse::json(
            GENERATE_PATH,
            &generate_text_response(text),
        ))
        .await;
    }

    pub async fn enqueue_json_tool_use(&self, id: &str, name: &str, input: Value) {
        self.enqueue(QueuedSidecarResponse::json(
            GENERATE_PATH,
            &generate_tool_use_response(id, name, &input),
        ))
        .await;
    }

    pub async fn enqueue_json(&self, builder: AnthropicJsonBuilder) {
        self.enqueue(QueuedSidecarResponse::json(
            GENERATE_PATH,
            &builder.build_sidecar_generate(),
        ))
        .await;
    }

    pub async fn enqueue_json_text_optional(&self, text: &str) {
        self.enqueue_json_text(text).await;
    }

    pub async fn enqueue_json_compaction_write_optional(&self, path: &str, content: &str) {
        self.enqueue_json_tool_use(
            "call_compact_write",
            "edit",
            json!({"path": path, "content": content}),
        )
        .await;
        self.enqueue_json_text("memory written").await;
    }

    pub async fn enqueue_embedding_optional(&self, dimensions: usize) {
        Mock::given(method("POST"))
            .and(path_regex("/embeddings"))
            .respond_with(EmbeddingResponder { dimensions })
            .up_to_n_times(100)
            .mount(&self.server)
            .await;
    }

    pub async fn received_requests(&self) -> Vec<Value> {
        self.received
            .lock()
            .await
            .iter()
            .map(|(_, body)| body.clone())
            .collect()
    }

    pub async fn received_requests_with_path(&self) -> Vec<(String, Value)> {
        self.received.lock().await.clone()
    }

    async fn enqueue(&self, response: QueuedSidecarResponse) {
        self.responses.lock().await.push_back(response);
    }
}

#[cfg(unix)]
impl Drop for MockLlmSidecar {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(unix)]
fn usage() -> Value {
    json!({
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_tokens": 8,
        "cache_creation_tokens": 0,
    })
}

#[cfg(unix)]
fn timing() -> Value {
    json!({
        "total_ms": 10,
        "time_to_first_token_ms": 1,
    })
}

#[cfg(unix)]
fn done_event(content: &str, finish_reason: &str) -> Value {
    json!({
        "type": "done",
        "content": content,
        "finish_reason": finish_reason,
        "usage": usage(),
        "timing": timing(),
    })
}

#[cfg(unix)]
fn generate_text_response(text: &str) -> Value {
    json!({
        "content": text,
        "content_blocks": [{ "type": "text", "text": text }],
        "finish_reason": "end_turn",
        "usage": usage(),
        "timing": timing(),
        "model": "claude-3-5-sonnet-20241022",
    })
}

#[cfg(unix)]
fn generate_tool_use_response(id: &str, name: &str, input: &Value) -> Value {
    json!({
        "content": "",
        "content_blocks": [{
            "type": "tool_use",
            "id": id,
            "name": name,
            "input": input,
        }],
        "finish_reason": "tool_use",
        "usage": usage(),
        "timing": timing(),
        "model": "claude-3-5-sonnet-20241022",
    })
}

#[cfg(unix)]
async fn run_mock_sidecar(
    listener: UnixListener,
    responses: Arc<Mutex<VecDeque<QueuedSidecarResponse>>>,
    received: Arc<Mutex<Vec<(String, Value)>>>,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let conn_responses = Arc::clone(&responses);
        let conn_received = Arc::clone(&received);
        let handle = tokio::spawn(async move {
            handle_mock_sidecar_connection(stream, conn_responses, conn_received).await;
        });
        drop(handle);
    }
}

#[cfg(unix)]
async fn handle_mock_sidecar_connection(
    mut stream: UnixStream,
    responses: Arc<Mutex<VecDeque<QueuedSidecarResponse>>>,
    received: Arc<Mutex<Vec<(String, Value)>>>,
) {
    let response = match read_http_request(&mut stream).await {
        Ok((path, _body)) if path == HEALTHZ_PATH => {
            QueuedSidecarResponse::text(HEALTHZ_PATH, 200, "OK", "ok\n")
        }
        Ok((path, body)) => {
            let parsed_body = serde_json::from_str(&body).unwrap_or_else(|_| json!(body));
            received.lock().await.push((path.clone(), parsed_body));
            let mut queued = responses.lock().await;
            let response_index = queued
                .iter()
                .position(|response| response.path == path.as_str());
            response_index
                .and_then(|index| queued.remove(index))
                .unwrap_or_else(|| {
                    QueuedSidecarResponse::text(
                        "",
                        500,
                        "Internal Server Error",
                        format!("no queued sidecar response for {path}"),
                    )
                })
        }
        Err(e) => QueuedSidecarResponse::text(
            "",
            400,
            "Bad Request",
            format!("invalid mock sidecar request: {e}"),
        ),
    };
    let _ignored = write_http_response(&mut stream, response).await;
}

#[cfg(unix)]
#[expect(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    reason = "mock HTTP parser over a Unix socket; offsets are derived from the bytes just read"
)]
async fn read_http_request(stream: &mut UnixStream) -> io::Result<(String, String)> {
    let mut buf = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 1024];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "client closed before headers",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
    };

    let headers = String::from_utf8(buf[..header_end].to_vec())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let request_line = headers
        .lines()
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request path"))?
        .to_owned();
    let content_len = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| {
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>())
        })
        .transpose()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?
        .unwrap_or_default();

    while buf.len() < header_end + content_len {
        let mut chunk = [0_u8; 1024];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "client closed before body",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }

    let body = String::from_utf8(buf[header_end..header_end + content_len].to_vec())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok((path, body))
}

#[cfg(unix)]
async fn write_http_response(
    stream: &mut UnixStream,
    response: QueuedSidecarResponse,
) -> io::Result<()> {
    let SidecarResponseBody::Body(body) = response.body else {
        let mut buf = [0_u8; 1024];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) => return Ok(()),
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                    ) =>
                {
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        }
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        response.status,
        response.reason,
        response.content_type,
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(unix)]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stream_builder_text_response() {
        let body = AnthropicStreamBuilder::new()
            .text("Hello, world!")
            .usage(5, 10)
            .build_sidecar_ndjson();

        assert!(body.contains("\"type\":\"start\""), "missing start event");
        assert!(body.contains("\"type\":\"text\""), "missing text event");
        assert!(body.contains("Hello, world!"), "missing text content");
        assert!(
            body.contains("\"finish_reason\":\"end_turn\""),
            "missing end_turn finish_reason"
        );
        assert!(
            body.contains("\"input_tokens\":5"),
            "missing input token count"
        );
        assert!(
            body.contains("\"output_tokens\":10"),
            "missing output token count"
        );
    }

    #[test]
    fn test_stream_builder_tool_use_response() {
        let input = json!({ "query": "weather in London" });
        let body = AnthropicStreamBuilder::new()
            .tool_use("toolu_01", "search", input.clone())
            .build_sidecar_ndjson();

        assert!(body.contains("\"type\":\"start\""), "missing start event");
        assert!(
            body.contains("\"type\":\"tool_use\""),
            "missing tool_use event"
        );
        assert!(body.contains("\"toolu_01\""), "missing tool id");
        assert!(body.contains("\"search\""), "missing tool name");
        assert!(
            body.contains("\"finish_reason\":\"tool_use\""),
            "missing tool_use finish_reason"
        );
        assert!(
            body.contains("weather in London"),
            "missing tool input content"
        );
    }
}
