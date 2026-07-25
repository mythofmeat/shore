//! In-memory ring buffers for observability (API calls, tool executions, errors).

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::{json, Value};

pub mod logging;

// ---------------------------------------------------------------------------
// Generic ring buffer
// ---------------------------------------------------------------------------

/// Fixed-capacity ring buffer backed by a `VecDeque`.
#[derive(Debug)]
pub struct RingBuffer<T> {
    buf: VecDeque<T>,
    capacity: usize,
}

impl<T> RingBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    pub fn push(&mut self, item: T) {
        if self.buf.len() >= self.capacity {
            let _ignored = self.buf.pop_front();
        }
        self.buf.push_back(item);
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.buf.iter()
    }

    /// Return the last `n` entries (or all if fewer than `n`).
    pub fn last_n(&self, n: usize) -> impl Iterator<Item = &T> {
        let skip = self.buf.len().saturating_sub(n);
        self.buf.iter().skip(skip)
    }
}

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ApiCallEntry {
    pub timestamp: String,
    pub model: String,
    pub provider: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub ttft_ms: u32,
    pub total_ms: u32,
    pub finish_reason: String,
    /// Provider-reported total cost when available (e.g. OpenRouter's
    /// `cost` field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallEntry {
    pub timestamp: String,
    pub tool_name: String,
    pub tool_id: String,
    pub success: bool,
    pub duration_ms: u64,
    pub input_summary: String,
    pub output_summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorEntry {
    pub timestamp: String,
    pub error_type: String,
    pub message: String,
    pub context: String,
}

/// One credential-fallback rotation event for the multi-key path.
///
/// Recorded whenever the daemon abandons a configured provider key on a
/// classified credential failure (missing/invalid/quota/budget/account
/// rate limit). The payload intentionally never carries the API key
/// value or the env var contents — only the friendly key names plus
/// status/reason metadata.
#[derive(Debug, Clone, Serialize)]
pub struct KeyFallbackEntry {
    pub timestamp: String,
    /// Request id, when the rotation happened inside a tracked request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rid: Option<String>,
    pub provider: String,
    pub model: String,
    pub character: String,
    pub from_key: String,
    /// Friendly name of the key now in use, or `None` if the rotation
    /// exhausted all candidates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_key: Option<String>,
    /// Stable failure tag (`CredentialFailureKind::as_str()`).
    pub kind: String,
    /// HTTP status when applicable (omitted for missing-key / network cases).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Sanitized reason. Never contains secrets.
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Diagnostics aggregate
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY: usize = 100;

#[derive(Debug)]
pub struct Diagnostics {
    pub api_calls: RingBuffer<ApiCallEntry>,
    pub tool_calls: RingBuffer<ToolCallEntry>,
    pub errors: RingBuffer<ErrorEntry>,
    pub key_fallbacks: RingBuffer<KeyFallbackEntry>,
}

impl Default for Diagnostics {
    fn default() -> Self {
        Self {
            api_calls: RingBuffer::new(DEFAULT_CAPACITY),
            tool_calls: RingBuffer::new(DEFAULT_CAPACITY),
            errors: RingBuffer::new(DEFAULT_CAPACITY),
            key_fallbacks: RingBuffer::new(DEFAULT_CAPACITY),
        }
    }
}

/// Truncate a string to at most `max` bytes on a char boundary.
pub fn truncate_summary(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_owned()
    } else {
        let end = s.floor_char_boundary(max);
        format!("{}…", s.get(..end).unwrap_or(s))
    }
}

impl Diagnostics {
    /// Serialize the last `n` entries from each ring as JSON.
    pub fn to_json(&self, last_n: usize) -> Value {
        let api: Vec<Value> = self
            .api_calls
            .last_n(last_n)
            .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
            .collect();
        let tools: Vec<Value> = self
            .tool_calls
            .last_n(last_n)
            .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
            .collect();
        let errors: Vec<Value> = self
            .errors
            .last_n(last_n)
            .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
            .collect();
        let key_fallbacks: Vec<Value> = self
            .key_fallbacks
            .last_n(last_n)
            .map(|e| serde_json::to_value(e).unwrap_or(json!(null)))
            .collect();

        json!({
            "api_calls": { "count": self.api_calls.len(), "recent": api },
            "tool_calls": { "count": self.tool_calls.len(), "recent": tools },
            "errors": { "count": self.errors.len(), "recent": errors },
            "key_fallbacks": { "count": self.key_fallbacks.len(), "recent": key_fallbacks },
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_push_within_capacity() {
        let mut rb = RingBuffer::new(5);
        rb.push(1);
        rb.push(2);
        rb.push(3);
        assert_eq!(rb.len(), 3);
        let items: Vec<_> = rb.iter().copied().collect();
        assert_eq!(items, vec![1, 2, 3]);
    }

    #[test]
    fn ring_buffer_evicts_oldest() {
        let mut rb = RingBuffer::new(3);
        for i in 0..5 {
            rb.push(i);
        }
        assert_eq!(rb.len(), 3);
        let items: Vec<_> = rb.iter().copied().collect();
        assert_eq!(items, vec![2, 3, 4]);
    }

    #[test]
    fn ring_buffer_last_n() {
        let mut rb = RingBuffer::new(10);
        for i in 0..7 {
            rb.push(i);
        }
        let last3: Vec<_> = rb.last_n(3).copied().collect();
        assert_eq!(last3, vec![4, 5, 6]);
    }

    #[test]
    fn ring_buffer_last_n_larger_than_len() {
        let mut rb = RingBuffer::new(10);
        rb.push(1);
        rb.push(2);
        let all: Vec<_> = rb.last_n(100).copied().collect();
        assert_eq!(all, vec![1, 2]);
    }

    #[test]
    fn ring_buffer_empty() {
        let rb: RingBuffer<i32> = RingBuffer::new(5);
        assert_eq!(rb.len(), 0);
        assert_eq!(rb.iter().count(), 0);
        assert_eq!(rb.last_n(10).count(), 0);
    }

    #[test]
    fn truncate_summary_short() {
        assert_eq!(truncate_summary("hello", 200), "hello");
    }

    #[test]
    fn truncate_summary_long() {
        let long = "a".repeat(300);
        let result = truncate_summary(&long, 200);
        assert!(result.len() <= 204); // 200 + "…"
        assert!(result.ends_with('…'));
    }

    #[test]
    fn diagnostics_to_json_structure() {
        let mut diag = Diagnostics::default();
        diag.api_calls.push(ApiCallEntry {
            timestamp: "2026-01-01T00:00:00Z".into(),
            model: "test-model".into(),
            provider: "anthropic".into(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 80,
            cache_write_tokens: 10,
            ttft_ms: 200,
            total_ms: 1000,
            finish_reason: "end_turn".into(),
            total_cost_usd: Some(0.0123),
            error: None,
        });
        diag.tool_calls.push(ToolCallEntry {
            timestamp: "2026-01-01T00:00:01Z".into(),
            tool_name: "check_time".into(),
            tool_id: "t1".into(),
            success: true,
            duration_ms: 5,
            input_summary: "{}".into(),
            output_summary: "2026-01-01T00:00:01Z".into(),
        });
        diag.errors.push(ErrorEntry {
            timestamp: "2026-01-01T00:00:02Z".into(),
            error_type: "llm".into(),
            message: "connection refused".into(),
            context: "character=test".into(),
        });

        let json = diag.to_json(10);
        assert_eq!(json.pointer("/api_calls/count"), Some(&json!(1)));
        assert_eq!(json.pointer("/tool_calls/count"), Some(&json!(1)));
        assert_eq!(json.pointer("/errors/count"), Some(&json!(1)));
        assert_eq!(
            json.pointer("/api_calls/recent/0/model"),
            Some(&json!("test-model"))
        );
        assert_eq!(
            json.pointer("/tool_calls/recent/0/tool_name"),
            Some(&json!("check_time"))
        );
        assert_eq!(
            json.pointer("/errors/recent/0/error_type"),
            Some(&json!("llm"))
        );
    }

    #[test]
    fn diagnostics_empty_to_json() {
        let diag = Diagnostics::default();
        let json = diag.to_json(10);
        assert_eq!(json.pointer("/api_calls/count"), Some(&json!(0)));
        assert_eq!(
            json.pointer("/api_calls/recent")
                .and_then(Value::as_array)
                .map(Vec::is_empty),
            Some(true)
        );
    }
}
