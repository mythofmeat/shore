//! Cache forensics — enablement and the desktop anomaly alert.
//!
//! The forensic log itself (`{cache_dir}/cache_forensics.jsonl`) is written by
//! the **sidecar**, because the row that matters records which `cache_control`
//! breakpoints were placed, and placement is decided in the Anthropic adapter.
//! The daemon supplies the per-call labels the sidecar cannot know (character,
//! call type, rid) via [`context`], and the sidecar writes one complete row per
//! call — placement and usage together.
//!
//! This module used to write that log from the daemon. When placement moved to
//! the sidecar in the migration (#123) the daemon lost the placement data, its
//! `log_request` call site went with it, and the writer sat dead while
//! `log_response` kept emitting half-rows whose `call_id` correlated with
//! nothing. Cache-behaviour questions were unanswerable from the log for as
//! long as that lasted; do not reintroduce a daemon-side writer without also
//! moving placement back.
//!
//! Rust still owns the *reaction* to a cache anomaly ([`notify_anomaly`]),
//! which is driven by the ledger's cache tracker, and the ledger keeps
//! per-call cache token counts independently of this log.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static FORENSIC_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Per-call labels stamped onto the sidecar's forensic rows.
///
/// Borrowed and serialized alongside the request so attaching them costs no
/// clone of the message history. Present only when forensics is enabled; the
/// sidecar writes nothing when it is absent, which keeps the daemon's
/// `[advanced].cache_forensics` the single switch.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct ForensicsContext<'req> {
    /// Directory to append `cache_forensics.jsonl` to.
    pub dir: &'req Path,
    pub character: &'req str,
    pub call_type: &'req str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rid: Option<&'req str>,
}

/// The labels for this call, or `None` when forensics is off.
pub fn context<'req>(
    request: &'req crate::llm::types::LlmRequest,
    call_type: Option<&'req str>,
) -> Option<ForensicsContext<'req>> {
    Some(ForensicsContext {
        dir: FORENSIC_DIR.get()?,
        character: request.forensic_character.as_deref().unwrap_or("-"),
        call_type: call_type.unwrap_or("-"),
        rid: request.rid.as_deref(),
    })
}

/// Enable cache forensics. Call once at startup with the cache directory.
pub fn enable(cache_dir: PathBuf) {
    let _ignored = FORENSIC_DIR.set(cache_dir);
}

/// Whether forensics is enabled.
pub fn is_enabled() -> bool {
    FORENSIC_DIR.get().is_some()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_wire_shape_matches_the_sidecar_interface() {
        // Mirrors `ForensicsContext` in `llm-sidecar/src/llm/forensics.ts`. The
        // sidecar casts the body rather than validating it, so a renamed field
        // here would silently produce rows labelled `undefined` instead of
        // failing anywhere.
        let ctx = ForensicsContext {
            dir: Path::new("/var/cache/shore"),
            character: "poppy",
            call_type: "keepalive",
            rid: Some("r-1"),
        };
        assert_eq!(
            serde_json::to_value(ctx).expect("serialize"),
            serde_json::json!({
                "dir": "/var/cache/shore",
                "character": "poppy",
                "call_type": "keepalive",
                "rid": "r-1",
            })
        );
    }

    #[test]
    fn absent_rid_is_omitted_not_null() {
        let ctx = ForensicsContext {
            dir: Path::new("/tmp"),
            character: "-",
            call_type: "message",
            rid: None,
        };
        let json = serde_json::to_value(ctx).expect("serialize");
        assert!(json.get("rid").is_none());
    }
}
