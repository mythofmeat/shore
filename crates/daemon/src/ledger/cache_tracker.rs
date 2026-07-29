//! Whether a character's Anthropic prompt cache is still warm.
//!
//! This used to be the warm/cold state machine — TTL expiry, model and thinking
//! toggles, tool-loop baselines, and the `unexpected_write` / `keepalive_miss` /
//! `cold_keepalive` anomalies. That machine now lives in
//! `llm-sidecar/src/ledger/cache_tracker.ts`, because it runs as part of
//! *writing* a row and the writer moved. Nothing in the daemon observes calls
//! any more.
//!
//! What is left is the read side: `shore usage` reports cache health, and to do
//! that it needs one question answered about a character's last recorded
//! Anthropic call. It is deliberately recomputed rather than read out of that
//! row's stored `cache_state`, because the stored value is what was true when
//! the call was made — a prefix that has since aged past its TTL is cold now
//! and the report should say so.
//!
//! The sidecar has its own copy of this rule, in `CacheTracker.reconstruct`,
//! where it seeds a character's tracker on the first call after a restart. Both
//! copies are live, for different consumers; keep them in step.

/// Whether a character's prompt cache prefix is currently usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheState {
    Cold,
    Warm,
}

impl CacheState {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            CacheState::Cold => "cold",
            CacheState::Warm => "warm",
        }
    }
}

/// Whether the prefix behind a character's last Anthropic call is still warm.
///
/// Warm requires both halves: the call must be inside the cache TTL, and it
/// must actually have read something. A call that read nothing wrote a prefix
/// but proves nothing about one existing before it, which is the same reason
/// the sidecar's tracker treats a zero read as cold.
///
/// An unparseable timestamp reads as cold rather than as an error: the report
/// says "cold" instead of failing, and a row we cannot date is one we cannot
/// claim is fresh.
#[must_use]
pub fn reconstruct_state(last_ts: &str, last_cache_read: u64, ttl_secs: u64) -> CacheState {
    let Ok(ts) = chrono::DateTime::parse_from_rfc3339(last_ts) else {
        return CacheState::Cold;
    };
    let elapsed = chrono::Utc::now()
        .signed_duration_since(ts.with_timezone(&chrono::Utc))
        .num_seconds();
    if elapsed < crate::ledger::convert::u64_to_i64(ttl_secs) && last_cache_read > 0 {
        CacheState::Warm
    } else {
        CacheState::Cold
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ago(secs: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::seconds(secs)).to_rfc3339()
    }

    #[test]
    fn a_recent_call_that_read_the_cache_is_warm() {
        assert_eq!(reconstruct_state(&ago(60), 5_000, 3600), CacheState::Warm);
    }

    #[test]
    fn a_call_past_the_ttl_is_cold() {
        assert_eq!(reconstruct_state(&ago(3_601), 5_000, 3600), CacheState::Cold);
    }

    /// A write with no read is a prefix being created, not one being reused —
    /// there is nothing yet to say survives. Mirrors the sidecar's rule.
    #[test]
    fn a_recent_call_that_read_nothing_is_cold() {
        assert_eq!(reconstruct_state(&ago(60), 0, 3600), CacheState::Cold);
    }

    #[test]
    fn an_undateable_row_is_cold_rather_than_an_error() {
        assert_eq!(reconstruct_state("not a timestamp", 5_000, 3600), CacheState::Cold);
    }

    /// A shorter configured TTL must shorten the warm window, not be ignored.
    #[test]
    fn the_ttl_is_the_one_passed_in() {
        assert_eq!(reconstruct_state(&ago(400), 5_000, 300), CacheState::Cold);
        assert_eq!(reconstruct_state(&ago(400), 5_000, 3600), CacheState::Warm);
    }
}
