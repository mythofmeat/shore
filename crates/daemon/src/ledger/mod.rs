pub mod client;
mod convert;
pub mod pricing;
pub mod reports;
pub mod store;
mod sync;

pub use client::{CallType, CredentialFallbackEvent, KeepaliveSchedule, LedgerClient};
pub use store::Ledger;

/// Whether a provider is billed by a flat subscription rather than metered
/// per-token usage.
///
/// Subscription calls are still recorded in the ledger (tokens, timing,
/// transcripts) for observability, but they contribute `$0` to usage budgets
/// and spend reports — per-token pricing is meaningless under a flat plan, and
/// budgets must never throttle calls that don't accrue marginal cost. Such rows
/// carry `cost_source = "subscription"` and `total_cost = 0`.
///
/// `opencode-go` is OpenCode's flat-rate ($10/mo) gateway over open models.
#[must_use]
pub fn is_subscription_provider(provider: &str) -> bool {
    matches!(provider, "opencode-go")
}
