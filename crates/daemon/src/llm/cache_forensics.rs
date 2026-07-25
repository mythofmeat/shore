//! Cache forensics — on-disk diagnostic log for every Anthropic cache event.
//!
//! Writes append-only JSONL to `{cache_dir}/cache_forensics.jsonl`.
//! Enabled at startup via `enable()`.  Each Anthropic API call produces
//! a "request" entry (breakpoint placement) and, if the response has
//! cache_creation_tokens > 0, a "cache_write" entry.  Both share the
//! same `call_id` for correlation.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use serde_json::json;

static FORENSIC_DIR: OnceLock<PathBuf> = OnceLock::new();
static CALL_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
pub struct RequestLog<'log> {
    pub call_id: u64,
    pub character: Option<&'log str>,
    pub model: &'log str,
    pub msg_count: usize,
    pub msg_breakpoints: &'log [usize],
    pub sys_breakpoints: &'log [usize],
    pub sys_blocks: usize,
    pub prefix_hash: u64,
    pub has_existing_markers: bool,
    pub cache_enabled: bool,
    pub rid: Option<&'log str>,
}

#[derive(Debug, Clone, Copy)]
pub struct ResponseLog<'log> {
    pub call_id: u64,
    pub model: &'log str,
    pub character: &'log str,
    pub call_type: &'log str,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// Enable cache forensics.  Call once at startup with the cache directory.
pub fn enable(cache_dir: PathBuf) {
    let _ignored = FORENSIC_DIR.set(cache_dir);
}

/// Whether forensics is enabled.
pub fn is_enabled() -> bool {
    FORENSIC_DIR.get().is_some()
}

/// Allocate a monotonic call ID for correlating request/response entries.
pub fn next_call_id() -> u64 {
    CALL_COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Write an arbitrary JSON entry to the forensic log.
pub fn write_entry(entry: &serde_json::Value) {
    let Some(dir) = FORENSIC_DIR.get() else {
        return;
    };
    let path = dir.join("cache_forensics.jsonl");
    let line = entry.to_string();

    // Best-effort append — don't crash or block the main path on I/O errors.
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ignored = writeln!(f, "{line}");
    }
}

/// Log the request-side cache placement for an Anthropic call.
pub fn log_request(entry: RequestLog<'_>) {
    let ts = chrono::Local::now().to_rfc3339();
    write_entry(&json!({
        "ts": ts,
        "type": "request",
        "call_id": entry.call_id,
        "character": entry.character,
        "model": entry.model,
        "msg_count": entry.msg_count,
        "msg_breakpoints": entry.msg_breakpoints,
        "sys_breakpoints": entry.sys_breakpoints,
        "sys_blocks": entry.sys_blocks,
        "prefix_hash": format!("{:016x}", entry.prefix_hash),
        "has_existing_markers": entry.has_existing_markers,
        "cache_enabled": entry.cache_enabled,
        "rid": entry.rid,
    }));
}

/// Log the response-side cache event.
pub fn log_response(entry: ResponseLog<'_>) {
    let ts = chrono::Local::now().to_rfc3339();
    write_entry(&json!({
        "ts": ts,
        "type": "response",
        "call_id": entry.call_id,
        "model": entry.model,
        "character": entry.character,
        "call_type": entry.call_type,
        "input_tokens": entry.input_tokens,
        "output_tokens": entry.output_tokens,
        "cache_read_tokens": entry.cache_read_tokens,
        "cache_creation_tokens": entry.cache_creation_tokens,
    }));
}

/// Log a failed API call (error from generate/stream) so keepalive and
/// other failures are visible in the forensic log, not just journald.
pub fn log_error(call_id: u64, model: &str, character: &str, call_type: &str, error: &str) {
    let ts = chrono::Local::now().to_rfc3339();
    write_entry(&json!({
        "ts": ts,
        "type": "error",
        "call_id": call_id,
        "model": model,
        "character": character,
        "call_type": call_type,
        "error": error,
    }));
}

/// Fire a desktop notification for a cache anomaly.
///
/// Spawns `notify-send` in the background — best-effort, never blocks.
pub fn notify_anomaly(
    character: &str,
    anomaly: &str,
    call_type: &str,
    cache_read: u64,
    cache_write: u64,
) {
    if !is_enabled() {
        return;
    }
    let summary = format!("shore: cache {anomaly}");
    let body = format!("{character} ({call_type})\nread={cache_read} write={cache_write}");
    let _ignored = std::process::Command::new("notify-send")
        .args(["--urgency=normal", "--app-name=shore", &summary, &body])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}
