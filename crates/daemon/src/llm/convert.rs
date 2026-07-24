//! Explicit, saturating numeric conversions used in place of lossy `as` casts.
//!
//! Centralizing these keeps the truncation policy (and its justification) in one
//! place instead of scattering `#[expect]`-worthy `as` casts across call sites.

use std::time::Duration;

/// Whole milliseconds of an elapsed `Duration`, saturating at `u64::MAX`.
pub(crate) fn elapsed_ms_u64(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}
