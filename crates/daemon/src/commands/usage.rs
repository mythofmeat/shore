//! `shore usage`, forwarded to the sidecar.
//!
//! This module used to be the report itself: period parsing, filter building,
//! eight payload shapes, cache health, and the budget summary. All of it lives
//! in `llm-sidecar/src/ledger/usage.ts` now, for the reason the row writer and
//! the budget gate moved before it — the ledger has one owner, and it is the
//! process that writes to it. The payloads are unchanged and pinned across the
//! two languages by `tests/usage_parity.rs`.
//!
//! What is left here is the one mode the sidecar cannot answer alone.

use shore_common::protocol::error::ErrorCode;
use tracing::debug;

use super::{CommandContext, CommandResult};

/// `true` when boolean arg `key` is explicitly set to `true`.
fn flag(args: &serde_json::Value, key: &str) -> bool {
    args.get(key).and_then(serde_json::Value::as_bool) == Some(true)
}

pub async fn usage(ctx: &CommandContext, args: &serde_json::Value) -> CommandResult {
    debug!(
        last = args.get("last").and_then(|v| v.as_str()).unwrap_or("today"),
        "Usage query started"
    );

    if flag(args, "refresh_pricing") {
        // Two caches sit in front of the `pricing` table: this process's engine
        // and the sidecar's. Empty the table here first — that also clears the
        // local one — and only then ask the sidecar to drop its copy, so
        // nothing can repopulate from the table in between.
        ctx.llm_client
            .pricing()
            .clear_cache()
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    }

    ctx.llm_client
        .usage_report(args)
        .await
        .map_err(|e| (ErrorCode::InternalError, e.to_string()))
}
