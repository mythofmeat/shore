//! What the daemon reads back from the sidecar's ledger endpoints.
//!
//! Everything that computes these lives in `llm-sidecar/src/ledger/` now — the
//! queries, the budget arithmetic, the report assembly. What is left on this
//! side is the shape of the answers, and only where the daemon has to do
//! something with them other than hand them to a client.
//!
//! `shore usage` needs nothing here: its payload is forwarded to the CLI as
//! opaque JSON, and adding a Rust struct in the middle would be a third place to
//! keep the field names in step. Budget warnings do, because the daemon
//! reshapes them into a `UsageWarning` frame and a desktop notification.

use serde::Deserialize;

/// A budget threshold crossed since the last check.
///
/// Deserialize-only: the sidecar decides when a threshold is newly crossed,
/// because deciding that means writing the dedup marker, and two processes each
/// deciding it would race for the marker.
#[derive(Debug, Clone, Deserialize)]
pub struct UsageBudgetWarningEvent {
    pub budget: String,
    pub message: String,
    pub current_cost: f64,
    pub cost_limit: f64,
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    /// Calendar period name (`hour` / `day` / `week` / `month`).
    pub period: String,
    pub period_start: String,
    pub reset_at: String,
    /// `reset_at` in the daemon's local time as `YYYY-MM-DD HH:MM AM|PM`, for
    /// clients that surface the string verbatim. `reset_at` stays RFC 3339 UTC.
    pub reset_at_display: String,
    /// `budget` for the period cap, `pace` for the pace allowance. The
    /// cost/period/window fields describe whichever one tripped.
    pub scope: String,
}

/// The `/v1/usage/warnings` reply.
#[derive(Debug, Clone, Deserialize)]
pub struct BudgetWarnings {
    pub warnings: Vec<UsageBudgetWarningEvent>,
}

/// One `(model, provider, call_type)` group over the queried window.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelUsageRow {
    pub model: String,
    pub provider: String,
    pub call_type: String,
    pub first_ts: String,
    pub last_ts: String,
    pub call_count: u64,
}

/// The `/v1/usage/models` reply.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelHistory {
    pub models: Vec<ModelUsageRow>,
}
