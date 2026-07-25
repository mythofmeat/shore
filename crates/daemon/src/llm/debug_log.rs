//! Per-call payload capture into the observability store.
//!
//! Every outbound LLM request and its paired response (or error) is recorded as
//! one row in the [`crate::call_store::CallStore`] — the request and response
//! bodies stored as zstd-compressed blobs. This replaces the older
//! one-file-per-call dumps under `debug/api_logs*`: a single queryable, bounded,
//! compressed store instead of an unbounded directory of loose JSON files.
//!
//! Non-streaming calls record on completion. Streaming calls accumulate the
//! provider's NDJSON as it is read (via [`TeeReader`]) and record once on drop,
//! parsing the trailing `done` event for token usage and finish reason.

use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use crate::call_store::{CallRecord, CallStore, Usage as StoreUsage};
use chrono::{DateTime, Local, Utc};
use tokio::io::{AsyncRead, ReadBuf};
use tracing::warn;

use crate::llm::types::{GenerateResponse, LlmRequest, StreamEvent};
use crate::llm::LlmError;

static CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Per-call capture state: the store handle plus the metadata and redacted
/// request body needed to write one row when the call completes.
#[derive(Debug)]
pub struct CallContext {
    store: Arc<CallStore>,
    call_id: String,
    ts: DateTime<Utc>,
    started: std::time::Instant,
    request_body: String,
    call_type: Option<String>,
    character: Option<String>,
    model: String,
    provider: Option<String>,
    sdk: String,
    rid: Option<String>,
}

fn next_call_id() -> String {
    let now = Local::now();
    let seq = CALL_COUNTER.fetch_add(1, Ordering::Relaxed) % 10_000;
    // Millisecond precision + a rolling 4-digit counter — unique across any
    // realistic rate of concurrent calls inside one daemon process.
    format!("{}-{:04}", now.format("%Y%m%dT%H%M%S%3f"), seq)
}

/// Redact `api_key` from a serialized `LlmRequest` JSON body.
fn redact_request(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                if obj.contains_key("api_key") {
                    let _ignored = obj.insert("api_key".into(), serde_json::json!("[REDACTED]"));
                }
            }
            serde_json::to_string(&value).unwrap_or_else(|_| body.to_owned())
        }
        Err(_) => body.to_owned(),
    }
}

/// Begin capturing a call. Returns `None` when no store is configured (capture
/// disabled). `call_type` is the ledger call-type label, threaded down for
/// filtering; `character` and provenance come off the prepared request.
pub fn start(
    store: Option<&Arc<CallStore>>,
    request: &LlmRequest,
    body: &str,
    call_type: Option<&str>,
) -> Option<CallContext> {
    let handle = store?;
    Some(CallContext {
        store: Arc::clone(handle),
        call_id: next_call_id(),
        ts: Utc::now(),
        started: std::time::Instant::now(),
        request_body: redact_request(body),
        call_type: call_type.map(str::to_owned),
        character: request.forensic_character.clone(),
        model: request.model.clone(),
        provider: request.provider_key.clone(),
        sdk: format!("{:?}", request.sdk),
        rid: request.rid.clone(),
    })
}

impl CallContext {
    /// Record a successful non-streaming call.
    pub fn finish_response(self, resp: &GenerateResponse) {
        let body = serde_json::to_string(resp).unwrap_or_default();
        let usage = StoreUsage {
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            cache_read_tokens: resp.usage.cache_read_tokens,
        };
        let duration = crate::llm::convert::elapsed_ms_u64(self.started.elapsed());
        self.record(
            Some(&body),
            None,
            Some(&resp.finish_reason),
            usage,
            duration,
        );
    }

    /// Record a failed call.
    pub fn finish_error(self, err: &LlmError) {
        let duration = crate::llm::convert::elapsed_ms_u64(self.started.elapsed());
        let message = err.to_string();
        self.record(None, Some(&message), None, StoreUsage::default(), duration);
    }

    fn record(
        &self,
        response_body: Option<&str>,
        error: Option<&str>,
        finish_reason: Option<&str>,
        usage: StoreUsage,
        duration_ms: u64,
    ) {
        let record = CallRecord {
            call_id: &self.call_id,
            ts: self.ts,
            call_type: self.call_type.as_deref(),
            character: self.character.as_deref(),
            model: Some(&self.model),
            provider: self.provider.as_deref(),
            sdk: Some(&self.sdk),
            rid: self.rid.as_deref(),
            finish_reason,
            usage,
            duration_ms: Some(duration_ms),
            error,
            request_body: &self.request_body,
            response_body,
        };
        if let Err(e) = self.store.record_call(&record) {
            warn!(error = %e, call_id = %self.call_id, "Failed to record LLM call payload");
        }
    }
}

/// Extract the finish reason and token usage from the trailing `done` event of
/// an accumulated NDJSON stream. Best-effort: unparseable or absent `done`
/// yields `None`/default.
fn parse_stream_summary(body: &str) -> (Option<String>, StoreUsage) {
    let mut finish = None;
    let mut usage = StoreUsage::default();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(StreamEvent::Done {
            finish_reason,
            usage: done_usage,
            ..
        }) = serde_json::from_str::<StreamEvent>(trimmed)
        {
            finish = Some(finish_reason);
            usage = StoreUsage {
                input_tokens: done_usage.input_tokens,
                output_tokens: done_usage.output_tokens,
                cache_read_tokens: done_usage.cache_read_tokens,
            };
        }
    }
    (finish, usage)
}

// ---------------------------------------------------------------------------
// Streaming tee: wrap an AsyncRead so every byte read is also accumulated and
// recorded to the store when the reader is dropped.
// ---------------------------------------------------------------------------

/// Wrap a stream reader so every chunk it yields is also buffered; on drop the
/// full response is recorded to the store as one call row. The consumer sees an
/// unchanged byte stream.
pub struct TeeReader<R> {
    inner: R,
    ctx: Option<CallContext>,
    buf: Vec<u8>,
    read_error: Option<String>,
}

impl<R: std::fmt::Debug> std::fmt::Debug for TeeReader<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TeeReader")
            .field("inner", &self.inner)
            .field("ctx", &self.ctx)
            .field("buffered_bytes", &self.buf.len())
            .field("read_error", &self.read_error)
            .finish()
    }
}

impl<R> TeeReader<R> {
    pub fn new(inner: R, ctx: CallContext) -> Self {
        Self {
            inner,
            ctx: Some(ctx),
            buf: Vec::new(),
            read_error: None,
        }
    }
}

impl<R> Drop for TeeReader<R> {
    fn drop(&mut self) {
        let Some(ctx) = self.ctx.take() else {
            return;
        };
        let body = String::from_utf8_lossy(&self.buf).into_owned();
        let (finish, usage) = parse_stream_summary(&body);
        let duration = crate::llm::convert::elapsed_ms_u64(ctx.started.elapsed());
        ctx.record(
            Some(&body),
            self.read_error.as_deref(),
            finish.as_deref(),
            usage,
            duration,
        );
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for TeeReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Err(e)) = &poll {
            self.read_error = Some(e.to_string());
        }
        if let Poll::Ready(Ok(())) = &poll {
            let after = buf.filled().len();
            if after > before {
                if let Some(new_bytes) = buf.filled().get(before..after) {
                    self.buf.extend_from_slice(new_bytes);
                }
            }
        }
        poll
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_replaces_api_key() {
        let redacted = redact_request(r#"{"api_key":"secret","model":"m"}"#);
        assert!(
            redacted.contains("[REDACTED]"),
            "api_key must be redacted: {redacted}"
        );
        assert!(
            !redacted.contains("secret"),
            "raw key must not survive: {redacted}"
        );
        assert!(
            redacted.contains("\"model\":\"m\""),
            "other fields preserved"
        );
    }

    #[test]
    fn parse_summary_reads_done_event() {
        let stream = concat!(
            "{\"type\":\"text\",\"text\":\"hi\"}\n",
            "{\"type\":\"done\",\"content\":\"hi\",\"finish_reason\":\"end_turn\",",
            "\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_read_tokens\":3},",
            "\"timing\":{\"total_ms\":1}}\n",
        );
        let (finish, usage) = parse_stream_summary(stream);
        assert_eq!(finish.as_deref(), Some("end_turn"), "finish reason parsed");
        assert_eq!(usage.input_tokens, 10, "input tokens parsed");
        assert_eq!(usage.cache_read_tokens, 3, "cache read tokens parsed");
    }

    #[test]
    fn parse_summary_tolerates_no_done() {
        let (finish, usage) = parse_stream_summary("{\"type\":\"text\",\"text\":\"hi\"}\n");
        assert!(finish.is_none(), "no done event → no finish reason");
        assert_eq!(usage.input_tokens, 0, "no done event → default usage");
    }
}
