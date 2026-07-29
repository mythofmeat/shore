//! Cache forensics — the enablement switch.
//!
//! The forensic log itself (`{cache_dir}/cache_forensics.jsonl`) is written by
//! the **sidecar**, because the row that matters records which `cache_control`
//! breakpoints were placed, and placement is decided in the Anthropic adapter.
//! The daemon supplies the per-call labels the sidecar cannot know — character,
//! call type, rid — on [`CallContext`], whose `forensics_dir` is what this
//! module supplies and what switches the log on.
//!
//! This module used to write that log from the daemon. When placement moved to
//! the sidecar in the migration (#123) the daemon lost the placement data, its
//! `log_request` call site went with it, and the writer sat dead while
//! `log_response` kept emitting half-rows whose `call_id` correlated with
//! nothing. Cache-behaviour questions were unanswerable from the log for as
//! long as that lasted; do not reintroduce a daemon-side writer without also
//! moving placement back.
//!
//! The *reaction* to a cache anomaly — the desktop notification — moved to the
//! sidecar with the ledger, since that is where the anomaly is now detected.
//!
//! [`CallContext`]: crate::llm::types::CallContext

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static FORENSIC_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Enable cache forensics. Call once at startup with the cache directory.
pub fn enable(cache_dir: PathBuf) {
    let _ignored = FORENSIC_DIR.set(cache_dir);
}

/// The directory the sidecar should append the forensic log to, or `None` when
/// forensics is off. Rides on [`CallContext::forensics_dir`].
///
/// [`CallContext::forensics_dir`]: crate::llm::types::CallContext::forensics_dir
pub fn dir() -> Option<&'static Path> {
    FORENSIC_DIR.get().map(PathBuf::as_path)
}
