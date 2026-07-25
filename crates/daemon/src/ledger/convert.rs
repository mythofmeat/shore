//! Numeric conversions at the SQLite boundary.
//!
//! SQLite stores every integer as `i64`, but our domain types use unsigned
//! widths: `u64` token counts and `u32` counts/timings. These helpers keep the
//! lossy boundary in exactly one place, with a single documented policy:
//!
//! * **reads** (`i64_to_u64`, `i64_to_u32`) clamp out-of-range values to `0` —
//!   a negative or oversized stored count is corruption, and `0` is the only
//!   sensible interpretation of a non-negative-domain column gone bad;
//! * **writes** (`u64_to_i64`) saturate at `i64::MAX` — a count that large is
//!   already nonsensical, and saturating beats silently wrapping negative;
//! * **cost math** (`u64_to_f64`) widens token counts to `f64`, lossless in
//!   practice because no workload approaches `f64`'s 2^53 exact-integer ceiling.

/// Read an `i64` SQLite column as `u64`, clamping negatives to `0`.
pub(crate) fn i64_to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// Read an `i64` SQLite column as `u32`, clamping out-of-range values to `0`.
pub(crate) fn i64_to_u32(v: i64) -> u32 {
    u32::try_from(v).unwrap_or(0)
}

/// Convert a `u64` domain value to `i64` for a SQLite bind or an `i64`
/// comparison, saturating at `i64::MAX`.
pub(crate) fn u64_to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

/// Widen a token count to `f64` for cost math.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "token counts never approach f64's 2^53 exact-integer ceiling"
)]
pub(crate) fn u64_to_f64(v: u64) -> f64 {
    v as f64
}

/// Widen a duration in seconds to `f64` for budget-pace division.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "budget windows span at most a month; second counts are ~10^6, far under f64's 2^53 exact-integer ceiling"
)]
pub(crate) fn i64_to_f64(v: i64) -> f64 {
    v as f64
}
