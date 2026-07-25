//! Lossy numeric conversions used across the daemon.
//!
//! Lossless widenings (`u32`→`f64`/`u64`/`i64`) should use `f64::from` etc.
//! directly — these helpers exist only for the genuinely lossy directions, so
//! the truncation/precision policy lives in one documented place rather than
//! scattered `as` casts:
//!
//! * `*_to_f64` / `*_to_f32` widen counts for ratio/percentage math; precision
//!   is lost only above the floating-point exact-integer ceiling, which no real
//!   count reaches;
//! * `f64_to_u32_saturating` clamps a (rounded) non-negative float back into
//!   `u32` range, saturating rather than wrapping on overflow.

use std::time::Duration;

/// Widen a `u64` to `f64` for ratio/percentage math.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "counts never approach f64's 2^53 exact-integer ceiling"
)]
pub(crate) fn u64_to_f64(v: u64) -> f64 {
    v as f64
}

/// Widen a `usize` to `f64` for ratio/percentage math.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "counts never approach f64's 2^53 exact-integer ceiling"
)]
pub(crate) fn usize_to_f64(v: usize) -> f64 {
    v as f64
}

/// Widen a `usize` to `f32` for local score normalization.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "lexical scores are small ranking weights, far below f32's exact-integer ceiling"
)]
pub(crate) fn usize_to_f32(v: usize) -> f32 {
    v as f32
}

/// Widen a `u32` to `f32` for local score normalization.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "ranking counts are small weights, far below f32's exact-integer ceiling"
)]
pub(crate) fn u32_to_f32(v: u32) -> f32 {
    v as f32
}

/// Widen an `i64` to `f64` for ratio/duration math.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "values never approach f64's 2^53 exact-integer ceiling"
)]
pub(crate) fn i64_to_f64(v: i64) -> f64 {
    v as f64
}

/// Clamp a non-negative `f64` into `u32`, saturating at the bounds.
#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "input is clamped into [0, u32::MAX] before the cast, so it is exact"
)]
pub(crate) fn f64_to_u32_saturating(v: f64) -> u32 {
    v.clamp(0.0, f64::from(u32::MAX)) as u32
}

/// Narrow a `usize` to `u32`, saturating at `u32::MAX`.
pub(crate) fn usize_to_u32(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

/// Widen a `usize` to `u64`, saturating at `u64::MAX` on wider targets.
pub(crate) fn usize_to_u64(v: usize) -> u64 {
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// Narrow a `u64` to `usize`, saturating at `usize::MAX` (a no-op on 64-bit).
pub(crate) fn u64_to_usize(v: u64) -> usize {
    usize::try_from(v).unwrap_or(usize::MAX)
}

/// Whole milliseconds of an elapsed `Duration`, saturating at `u64::MAX`.
pub(crate) fn elapsed_ms_u64(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Whole milliseconds of an elapsed `Duration`, saturating at `u32::MAX`.
pub(crate) fn elapsed_ms_u32(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX)
}
