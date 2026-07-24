use crate::convert::{i64_to_f64, u64_to_f64, usize_to_f64};
use chrono::{Datelike, Local, NaiveDateTime, Timelike, Weekday};
use tokio::time::Instant;
use tracing::debug;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Idle gap (seconds) marking a session boundary.
pub const SESSION_GAP: u64 = 1800;

/// Minimum messages for adaptive timing.
pub const SUFFICIENT_DATA_MSGS: usize = 5;
/// Minimum distinct days for adaptive timing.
pub const SUFFICIENT_DATA_DAYS: usize = 2;

/// Minimum messages for hour-weighted (heatmap) timing.
pub const SUFFICIENT_HEATMAP_MSGS: usize = 20;
/// Minimum distinct days for hour-weighted timing.
pub const SUFFICIENT_HEATMAP_DAYS: usize = 7;

/// Below this many events on a weekday, fall back to global histogram.
pub const WEEKDAY_HEATMAP_MIN: usize = 5;

/// Hour classified as peak if density > avg × this factor.
pub const PEAK_HOUR_THRESHOLD: f64 = 1.5;
/// Hour classified as trough if density < avg × this factor.
pub const TROUGH_HOUR_THRESHOLD: f64 = 0.5;

/// Stats cache validity in seconds.
pub const STATS_CACHE_TTL: u64 = 60;

/// Number of recent sessions used for session-median calculation.
pub const SESSION_MEDIANS_WINDOW: usize = 30;
/// Number of response gaps tracked per session for tempo.
pub const SESSION_TEMPO_WINDOW: usize = 10;

/// Z-score threshold for anomaly detection.
pub const ANOMALY_Z_SCORE: f64 = 1.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A recorded message timestamp.
#[derive(Debug, Clone)]
pub struct MessageTimestamp {
    /// Monotonic instant (for gap computation within a process lifetime).
    pub monotonic: Instant,
    /// Wall-clock time.
    pub wall_clock: NaiveDateTime,
    /// Day of the week.
    pub weekday: Weekday,
}

/// Classification of an hour slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HourClassification {
    Peak,
    Trough,
    Normal,
}

/// Cached activity statistics.
#[derive(Debug, Clone)]
pub struct ActivityStats {
    pub engagement_score: f64,
    pub consistency: f64,
    pub tempo_score: f64,
    pub session_count: usize,
    pub sessions_per_day: f64,
    pub hour_histogram: [f64; 24],
    pub hour_classifications: [HourClassification; 24],
    pub has_sufficient_data: bool,
    pub has_sufficient_heatmap: bool,
    pub median_session_gap: Option<f64>,
    pub anomaly_z_score: Option<f64>,
    pub computed_at: Instant,
}

// ---------------------------------------------------------------------------
// ActivityTracker
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ActivityTracker {
    timestamps: Vec<MessageTimestamp>,
    cached_stats: Option<ActivityStats>,
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self {
            timestamps: Vec::new(),
            cached_stats: None,
        }
    }

    /// Record a new message event at the current time.
    pub fn record_message(&mut self) {
        let now_local = Local::now().naive_local();
        self.record_message_at(Instant::now(), now_local);
    }

    /// Record a message with explicit timestamps (useful for testing).
    pub fn record_message_at(&mut self, monotonic: Instant, wall_clock: NaiveDateTime) {
        let weekday = wall_clock.weekday();
        self.timestamps.push(MessageTimestamp {
            monotonic,
            wall_clock,
            weekday,
        });
        // Invalidate cache.
        self.cached_stats = None;
    }

    /// Backfill the tracker with historical wall-clock timestamps.
    ///
    /// Used on first creation to seed from existing chat history.
    /// No-op if the tracker already has data (safety guard).
    pub fn backfill(&mut self, wall_clocks: &[NaiveDateTime]) {
        if !self.timestamps.is_empty() || wall_clocks.is_empty() {
            return;
        }
        debug!(
            count = wall_clocks.len(),
            "Backfilling activity tracker with historical timestamps"
        );

        let monotonic_base = Instant::now();
        for (i, wall_clock) in wall_clocks.iter().enumerate() {
            let weekday = wall_clock.weekday();
            let offset = u64::try_from(i).unwrap_or(u64::MAX);
            self.timestamps.push(MessageTimestamp {
                monotonic: monotonic_base
                    .checked_add(std::time::Duration::from_nanos(offset))
                    .unwrap_or(monotonic_base),
                wall_clock: *wall_clock,
                weekday,
            });
        }

        // Ensure chronological order regardless of input order.
        self.timestamps.sort_by_key(|ts| ts.wall_clock);

        // Invalidate cache.
        self.cached_stats = None;
    }

    /// Number of recorded messages.
    pub fn message_count(&self) -> usize {
        self.timestamps.len()
    }

    /// Get cached stats, recomputing if stale or absent.
    pub fn stats(&mut self) -> &ActivityStats {
        let need_recompute = self
            .cached_stats
            .as_ref()
            .is_none_or(|s| s.computed_at.elapsed().as_secs() >= STATS_CACHE_TTL);
        if need_recompute {
            debug!(
                messages = self.timestamps.len(),
                "Recomputing activity stats"
            );
            let stats = self.compute_stats();
            self.cached_stats = Some(stats);
        }
        #[expect(
            clippy::unwrap_used,
            reason = "cached_stats is Some here: set above when stale, pre-existing when fresh"
        )]
        self.cached_stats.as_ref().unwrap()
    }

    /// Force recompute stats (bypasses cache TTL).
    pub fn recompute_stats(&mut self) -> &ActivityStats {
        debug!(
            messages = self.timestamps.len(),
            "Force-recomputing activity stats"
        );
        let stats = self.compute_stats();
        self.cached_stats.insert(stats)
    }

    // -----------------------------------------------------------------------
    // Internal computations
    // -----------------------------------------------------------------------

    #[expect(
        clippy::float_arithmetic,
        reason = "activity statistics compute f64 session rates and weighted engagement scores"
    )]
    fn compute_stats(&self) -> ActivityStats {
        let now = Instant::now();
        let current_weekday = Local::now().naive_local().weekday();

        let distinct_days = self.distinct_days();
        let msg_count = self.timestamps.len();

        let has_sufficient_data =
            msg_count >= SUFFICIENT_DATA_MSGS && distinct_days >= SUFFICIENT_DATA_DAYS;
        let has_sufficient_heatmap =
            msg_count >= SUFFICIENT_HEATMAP_MSGS && distinct_days >= SUFFICIENT_HEATMAP_DAYS;

        // Session detection.
        let sessions = self.detect_sessions();
        let session_count = sessions.len();

        // Sessions per day.
        let sessions_per_day = if distinct_days > 0 {
            usize_to_f64(session_count) / usize_to_f64(distinct_days)
        } else {
            0.0
        };

        // Consistency: fraction of distinct days with at least one message,
        // relative to the span from first to last message.
        let consistency = self.compute_consistency();

        // Session medians (inter-session gaps).
        let session_gaps = self.compute_session_gaps(&sessions);
        let median_session_gap = median(&session_gaps);

        // Tempo score from recent intra-session response gaps.
        let tempo_gaps = self.compute_tempo_gaps(&sessions);
        let tempo_score = compute_tempo_score(&tempo_gaps);

        // Engagement score.
        let engagement_score = 0.6 * consistency + 0.4 * tempo_score;

        // Hour histogram (weekday-aware).
        let hour_histogram = self.compute_hour_histogram(current_weekday);

        // Peak/trough classification.
        let hour_classifications = classify_hours(&hour_histogram);

        // Z-score anomaly on the most recent gap.
        let anomaly_z_score = self.compute_anomaly_z_score(&sessions);

        ActivityStats {
            engagement_score,
            consistency,
            tempo_score,
            session_count,
            sessions_per_day,
            hour_histogram,
            hour_classifications,
            has_sufficient_data,
            has_sufficient_heatmap,
            median_session_gap,
            anomaly_z_score,
            computed_at: now,
        }
    }

    /// Count distinct calendar days across all recorded timestamps.
    fn distinct_days(&self) -> usize {
        let days: std::collections::HashSet<_> = self
            .timestamps
            .iter()
            .map(|ts| ts.wall_clock.date())
            .collect();
        days.len()
    }

    /// Consistency: ratio of active days to total span days.
    #[expect(
        clippy::float_arithmetic,
        reason = "consistency is a bounded f64 ratio of active days to observed span days"
    )]
    fn compute_consistency(&self) -> f64 {
        let [first, .., last] = self.timestamps.as_slice() else {
            return if self.timestamps.is_empty() { 0.0 } else { 1.0 };
        };
        let first_date = first.wall_clock.date();
        let last_date = last.wall_clock.date();
        let span_days = last_date
            .signed_duration_since(first_date)
            .num_days()
            .saturating_add(1);
        if span_days <= 0 {
            return 1.0;
        }

        let active_days = self.distinct_days();
        (usize_to_f64(active_days) / i64_to_f64(span_days)).clamp(0.0, 1.0)
    }

    /// Detect sessions: each session is a slice of contiguous timestamps where
    /// consecutive wall-clock gaps are < SESSION_GAP seconds.
    fn detect_sessions(&self) -> Vec<Vec<usize>> {
        if self.timestamps.is_empty() {
            return Vec::new();
        }

        let mut sessions: Vec<Vec<usize>> = Vec::new();
        let mut current_session = vec![0_usize];

        for i in 1..self.timestamps.len() {
            let prev_ts = i.checked_sub(1).and_then(|j| self.timestamps.get(j));
            let gap = match (self.timestamps.get(i), prev_ts) {
                (Some(cur), Some(prev)) => cur
                    .wall_clock
                    .signed_duration_since(prev.wall_clock)
                    .num_seconds()
                    .unsigned_abs(),
                _ => continue,
            };
            if gap >= SESSION_GAP {
                sessions.push(std::mem::take(&mut current_session));
            }
            current_session.push(i);
        }
        sessions.push(current_session);

        // Limit to last SESSION_MEDIANS_WINDOW sessions.
        if sessions.len() > SESSION_MEDIANS_WINDOW {
            let _ignored = sessions.drain(..sessions.len().saturating_sub(SESSION_MEDIANS_WINDOW));
        }

        sessions
    }

    /// Compute inter-session gaps (seconds between last msg of session N and
    /// first msg of session N+1).
    fn compute_session_gaps(&self, sessions: &[Vec<usize>]) -> Vec<f64> {
        if sessions.len() < 2 {
            return Vec::new();
        }

        let mut gaps = Vec::with_capacity(sessions.len().saturating_sub(1));
        for pair in sessions.windows(2) {
            let [prev_session, next_session] = pair else {
                continue;
            };
            let (Some(&last_of_prev), Some(&first_of_next)) =
                (prev_session.last(), next_session.first())
            else {
                continue;
            };
            let (Some(next_ts), Some(prev_ts)) = (
                self.timestamps.get(first_of_next),
                self.timestamps.get(last_of_prev),
            ) else {
                continue;
            };
            let gap = u64_to_f64(
                next_ts
                    .wall_clock
                    .signed_duration_since(prev_ts.wall_clock)
                    .num_seconds()
                    .unsigned_abs(),
            );
            gaps.push(gap);
        }
        gaps
    }

    /// Compute intra-session response gaps for tempo, limited to last
    /// SESSION_TEMPO_WINDOW gaps across recent sessions.
    fn compute_tempo_gaps(&self, sessions: &[Vec<usize>]) -> Vec<f64> {
        let mut all_gaps = Vec::new();
        for session in sessions {
            for pair in session.windows(2) {
                let [a, b] = pair else {
                    continue;
                };
                let (Some(ts_b), Some(ts_a)) = (self.timestamps.get(*b), self.timestamps.get(*a))
                else {
                    continue;
                };
                let gap = u64_to_f64(
                    ts_b.wall_clock
                        .signed_duration_since(ts_a.wall_clock)
                        .num_seconds()
                        .unsigned_abs(),
                );
                all_gaps.push(gap);
            }
        }
        // Keep only the last SESSION_TEMPO_WINDOW gaps.
        if all_gaps.len() > SESSION_TEMPO_WINDOW {
            let _ignored = all_gaps.drain(..all_gaps.len().saturating_sub(SESSION_TEMPO_WINDOW));
        }
        all_gaps
    }

    /// Weekday-aware hour histogram. If the current weekday has ≥ WEEKDAY_HEATMAP_MIN
    /// events, use only that weekday's data; otherwise fall back to global.
    #[expect(
        clippy::float_arithmetic,
        reason = "hour histogram normalizes event counts into f64 density buckets"
    )]
    fn compute_hour_histogram(&self, current_weekday: Weekday) -> [f64; 24] {
        let weekday_events: Vec<&MessageTimestamp> = self
            .timestamps
            .iter()
            .filter(|ts| ts.weekday == current_weekday)
            .collect();

        let source: Vec<u32> = if weekday_events.len() >= WEEKDAY_HEATMAP_MIN {
            weekday_events
                .iter()
                .map(|ts| ts.wall_clock.time().hour())
                .collect()
        } else {
            self.timestamps
                .iter()
                .map(|ts| ts.wall_clock.time().hour())
                .collect()
        };

        let mut histogram = [0.0_f64; 24];
        for hour in &source {
            let hour_idx = usize::try_from(*hour).unwrap_or(0);
            if let Some(slot) = histogram.get_mut(hour_idx) {
                *slot += 1.0;
            }
        }

        // Normalize to density (fraction of total).
        let total: f64 = histogram.iter().sum();
        if total > 0.0 {
            for h in &mut histogram {
                *h /= total;
            }
        }

        histogram
    }

    /// Z-score anomaly detection on the most recent inter-message gap.
    #[expect(
        clippy::float_arithmetic,
        reason = "gap anomaly detection computes f64 mean, variance, and z-score"
    )]
    fn compute_anomaly_z_score(&self, sessions: &[Vec<usize>]) -> Option<f64> {
        let gaps = self.compute_session_gaps(sessions);
        if gaps.len() < 3 {
            return None;
        }

        let mean = gaps.iter().sum::<f64>() / usize_to_f64(gaps.len());
        let variance =
            gaps.iter().map(|g| (g - mean).powi(2)).sum::<f64>() / usize_to_f64(gaps.len());
        let std_dev = variance.sqrt();

        if std_dev < f64::EPSILON {
            return Some(0.0);
        }

        let last_gap = *gaps.last()?;
        Some((last_gap - mean) / std_dev)
    }
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

/// Tempo score logistic: 1 / (1 + e^((median_gap - 900) / 400)).
#[expect(
    clippy::float_arithmetic,
    reason = "tempo scoring is a logistic curve over f64 gap durations"
)]
pub fn compute_tempo_score(gaps: &[f64]) -> f64 {
    let Some(med) = median(gaps) else {
        return 0.5; // neutral when no data
    };
    1.0 / (1.0 + ((med - 900.0) / 400.0).exp())
}

/// Classify each hour as Peak, Trough, or Normal based on histogram density.
#[expect(
    clippy::float_arithmetic,
    reason = "hour classification compares f64 densities against scaled peak/trough thresholds"
)]
pub fn classify_hours(histogram: &[f64; 24]) -> [HourClassification; 24] {
    let non_zero: Vec<f64> = histogram.iter().copied().filter(|&d| d > 0.0).collect();
    let avg = if non_zero.is_empty() {
        0.0
    } else {
        non_zero.iter().sum::<f64>() / usize_to_f64(non_zero.len())
    };

    let mut result = [HourClassification::Normal; 24];
    if avg < f64::EPSILON {
        return result;
    }

    for (slot, &density) in result.iter_mut().zip(histogram.iter()) {
        if density > avg * PEAK_HOUR_THRESHOLD {
            *slot = HourClassification::Peak;
        } else if density < avg * TROUGH_HOUR_THRESHOLD {
            *slot = HourClassification::Trough;
        } else {
            *slot = HourClassification::Normal;
        }
    }
    result
}

/// Compute median of a slice.
fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid: usize = sorted.len().checked_div(2).unwrap_or_default();
    if sorted.len().is_multiple_of(2) {
        let lo_opt = mid.checked_sub(1).and_then(|i| sorted.get(i));
        let (Some(lo), Some(hi)) = (lo_opt, sorted.get(mid)) else {
            return None;
        };
        Some(lo.midpoint(*hi))
    } else {
        sorted.get(mid).copied()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, Weekday};
    use std::time::Duration;
    use tokio::time::Instant;

    /// Helper: create a NaiveDateTime from components.
    fn dt(year: i32, month: u32, day: u32, hour: u32, min: u32, sec: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, min, sec)
            .unwrap()
    }

    /// Helper: create a sequence of message timestamps with specified gaps.
    fn build_tracker_with_timestamps(times: &[NaiveDateTime]) -> ActivityTracker {
        let mut tracker = ActivityTracker::new();
        let base = Instant::now();
        for (i, wall) in times.iter().enumerate() {
            let offset = u64::try_from(i).unwrap_or(u64::MAX);
            let mono = base + Duration::from_secs(offset);
            tracker.record_message_at(mono, *wall);
        }
        tracker
    }

    // -- tempo_score logistic -------------------------------------------------

    #[test]
    fn test_tempo_score_30s() {
        // median gap = 30s → score ≈ 0.90
        let score = compute_tempo_score(&[30.0]);
        assert!((score - 0.90).abs() < 0.02, "30s: got {score}");
    }

    #[test]
    fn test_tempo_score_5min() {
        // median gap = 300s → score ≈ 0.82
        let score = compute_tempo_score(&[300.0]);
        assert!((score - 0.82).abs() < 0.02, "5min: got {score}");
    }

    #[test]
    fn test_tempo_score_15min() {
        // median gap = 900s → score = 0.50 exactly
        let score = compute_tempo_score(&[900.0]);
        assert!((score - 0.50).abs() < 0.01, "15min: got {score}");
    }

    #[test]
    fn test_tempo_score_30min() {
        // median gap = 1800s → score ≈ 0.10
        let score = compute_tempo_score(&[1800.0]);
        assert!(score < 0.20, "30min: got {score}");
    }

    #[test]
    fn test_tempo_score_empty() {
        let score = compute_tempo_score(&[]);
        assert!((score - 0.5).abs() < f64::EPSILON);
    }

    // -- median ---------------------------------------------------------------

    #[test]
    fn test_median_odd() {
        assert_eq!(median(&[1.0, 3.0, 2.0]), Some(2.0));
    }

    #[test]
    fn test_median_even() {
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), Some(2.5));
    }

    #[test]
    fn test_median_empty() {
        assert_eq!(median(&[]), None);
    }

    // -- hour histogram with weekday filtering --------------------------------

    #[test]
    fn test_hour_histogram_weekday_filtering() {
        // Build timestamps: 6 events on Wednesday at hour 10, 2 events on
        // Thursday at hour 14.
        let wednesday_times: Vec<NaiveDateTime> = (0..6)
            .map(|i| dt(2026, 3, 25, 10, i * 5, 0)) // 2026-03-25 is a Wednesday
            .collect();
        let thursday_times: Vec<NaiveDateTime> = (0..2)
            .map(|i| dt(2026, 3, 26, 14, i * 5, 0)) // Thursday
            .collect();

        let all_times: Vec<NaiveDateTime> = wednesday_times
            .iter()
            .chain(thursday_times.iter())
            .copied()
            .collect();

        let tracker = build_tracker_with_timestamps(&all_times);

        // Wednesday has 6 events (≥ WEEKDAY_HEATMAP_MIN=5), so should filter.
        let hist = tracker.compute_hour_histogram(Weekday::Wed);
        // All density should be at hour 10.
        assert!(hist[10] > 0.0);
        assert!((hist[10] - 1.0).abs() < f64::EPSILON); // 100% density at hour 10
        assert!((hist[14]).abs() < f64::EPSILON); // Thursday events excluded

        // Thursday has only 2 events (< 5), so should fall back to global.
        let hist_thu = tracker.compute_hour_histogram(Weekday::Thu);
        assert!(hist_thu[10] > 0.0); // Wednesday events included in global
        assert!(hist_thu[14] > 0.0); // Thursday events included too
    }

    #[test]
    fn test_hour_histogram_global_fallback() {
        // Only 3 events on Monday → below WEEKDAY_HEATMAP_MIN.
        let times: Vec<NaiveDateTime> = (0..3)
            .map(|i| dt(2026, 3, 23, 9 + i, 0, 0)) // Monday
            .collect();
        let tracker = build_tracker_with_timestamps(&times);

        let hist = tracker.compute_hour_histogram(Weekday::Mon);
        // Should use global data (all 3 events).
        let total: f64 = hist.iter().sum();
        assert!((total - 1.0).abs() < 0.01); // normalized
    }

    // -- peak/trough classification -------------------------------------------

    #[test]
    fn test_classify_hours_peak_trough() {
        let mut histogram = [0.0_f64; 24];
        // One heavy hour, rest light.
        histogram[10] = 0.50; // Very high density.
        histogram[14] = 0.30;
        histogram[3] = 0.01; // Very low density.
        histogram[4] = 0.01;
        // Remaining hours = 0. avg of non-zero = (0.50 + 0.30 + 0.01 + 0.01) / 4 = 0.205
        // Peak threshold = 0.205 * 1.5 = 0.3075 → hour 10 is peak
        // Trough threshold = 0.205 * 0.5 = 0.1025 → hours 3, 4 are trough
        let classes = classify_hours(&histogram);
        assert_eq!(classes[10], HourClassification::Peak);
        assert_eq!(classes[3], HourClassification::Trough);
        assert_eq!(classes[4], HourClassification::Trough);
        assert_eq!(classes[14], HourClassification::Normal);
    }

    #[test]
    fn test_classify_hours_all_zero() {
        let histogram = [0.0_f64; 24];
        let classes = classify_hours(&histogram);
        assert!(classes.iter().all(|c| *c == HourClassification::Normal));
    }

    // -- session detection ----------------------------------------------------

    #[test]
    fn test_session_detection() {
        // Two sessions: 3 msgs with 60s gaps, then a 40-minute gap, then 2 msgs.
        let times = vec![
            dt(2026, 3, 25, 10, 0, 0),
            dt(2026, 3, 25, 10, 1, 0),
            dt(2026, 3, 25, 10, 2, 0),
            // 40 min gap (> SESSION_GAP)
            dt(2026, 3, 25, 10, 42, 0),
            dt(2026, 3, 25, 10, 43, 0),
        ];
        let tracker = build_tracker_with_timestamps(&times);
        let sessions = tracker.detect_sessions();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].len(), 3);
        assert_eq!(sessions[1].len(), 2);
    }

    #[test]
    fn test_single_session() {
        // All messages within 5 minutes — single session.
        let times: Vec<NaiveDateTime> = (0..5).map(|i| dt(2026, 3, 25, 10, i, 0)).collect();
        let tracker = build_tracker_with_timestamps(&times);
        let sessions = tracker.detect_sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].len(), 5);
    }

    // -- engagement score -----------------------------------------------------

    #[test]
    fn test_engagement_score_computation() {
        // Build timestamps across 2 days, fast tempo.
        let times = vec![
            dt(2026, 3, 24, 10, 0, 0),
            dt(2026, 3, 24, 10, 0, 30), // 30s gap → high tempo
            dt(2026, 3, 24, 10, 1, 0),
            dt(2026, 3, 25, 14, 0, 0),
            dt(2026, 3, 25, 14, 0, 30),
        ];
        let mut tracker = build_tracker_with_timestamps(&times);
        let stats = tracker.recompute_stats();

        // 2 active days / 2 span days → consistency = 1.0
        assert!((stats.consistency - 1.0).abs() < 0.01);
        // Tempo gaps are ~30s → tempo_score ≈ 0.90
        assert!(stats.tempo_score > 0.80);
        // engagement = 0.6 * 1.0 + 0.4 * ~0.90 = ~0.96
        assert!(stats.engagement_score > 0.90);
        assert!(stats.has_sufficient_data);
    }

    // -- data sufficiency -----------------------------------------------------

    #[test]
    fn test_insufficient_data() {
        // Only 3 messages on 1 day.
        let times: Vec<NaiveDateTime> = (0..3).map(|i| dt(2026, 3, 25, 10, i, 0)).collect();
        let mut tracker = build_tracker_with_timestamps(&times);
        let stats = tracker.recompute_stats();
        assert!(!stats.has_sufficient_data);
        assert!(!stats.has_sufficient_heatmap);
    }

    #[test]
    fn test_sufficient_data() {
        // 5 messages across 2 days.
        let times = vec![
            dt(2026, 3, 24, 10, 0, 0),
            dt(2026, 3, 24, 10, 1, 0),
            dt(2026, 3, 24, 10, 2, 0),
            dt(2026, 3, 25, 14, 0, 0),
            dt(2026, 3, 25, 14, 1, 0),
        ];
        let mut tracker = build_tracker_with_timestamps(&times);
        let stats = tracker.recompute_stats();
        assert!(stats.has_sufficient_data);
        assert!(!stats.has_sufficient_heatmap); // need 20 msgs + 7 days
    }

    // -- z-score anomaly detection --------------------------------------------

    #[test]
    fn test_anomaly_z_score() {
        // Regular sessions every 2 hours, then one session after 12 hours.
        let times = vec![
            // Session 1
            dt(2026, 3, 25, 8, 0, 0),
            dt(2026, 3, 25, 8, 1, 0),
            // Session 2 (2h later)
            dt(2026, 3, 25, 10, 0, 0),
            dt(2026, 3, 25, 10, 1, 0),
            // Session 3 (2h later)
            dt(2026, 3, 25, 12, 0, 0),
            dt(2026, 3, 25, 12, 1, 0),
            // Session 4 (2h later)
            dt(2026, 3, 25, 14, 0, 0),
            dt(2026, 3, 25, 14, 1, 0),
            // Session 5 (12h later — anomalous!)
            dt(2026, 3, 26, 2, 0, 0),
            dt(2026, 3, 26, 2, 1, 0),
        ];
        let mut tracker = build_tracker_with_timestamps(&times);
        let stats = tracker.recompute_stats();
        // The last session gap (12h) should produce a high z-score.
        assert!(stats.anomaly_z_score.is_some());
        assert!(
            stats.anomaly_z_score.unwrap() > ANOMALY_Z_SCORE,
            "z-score {} should exceed {}",
            stats.anomaly_z_score.unwrap(),
            ANOMALY_Z_SCORE
        );
    }

    // -- stats caching --------------------------------------------------------

    #[test]
    fn test_stats_cache_invalidated_on_new_message() {
        let times = vec![dt(2026, 3, 25, 10, 0, 0), dt(2026, 3, 25, 10, 1, 0)];
        let mut tracker = build_tracker_with_timestamps(&times);

        // Compute stats once.
        let _ignored = tracker.recompute_stats();
        assert!(tracker.cached_stats.is_some());

        // Recording a new message invalidates the cache.
        tracker.record_message_at(Instant::now(), dt(2026, 3, 25, 10, 5, 0));
        assert!(tracker.cached_stats.is_none());
    }

    // -- session medians window -----------------------------------------------

    #[test]
    fn test_session_medians_window_limit() {
        // Create 35 sessions (more than SESSION_MEDIANS_WINDOW=30).
        let mut times = Vec::new();
        for s in 0_u32..35 {
            let base_hour = s % 12;
            let day = 1 + s / 12;
            // Each session: 2 messages 1 minute apart.
            times.push(dt(2026, 3, day, base_hour, 0, 0));
            times.push(dt(2026, 3, day, base_hour, 1, 0));
        }
        let tracker = build_tracker_with_timestamps(&times);
        let sessions = tracker.detect_sessions();
        assert!(sessions.len() <= SESSION_MEDIANS_WINDOW);
    }

    // -- backfill -------------------------------------------------------------

    #[test]
    fn test_backfill_populates_and_invalidates_cache() {
        let mut tracker = ActivityTracker::new();
        let times = vec![
            dt(2026, 3, 20, 10, 0, 0),
            dt(2026, 3, 21, 14, 0, 0),
            dt(2026, 3, 22, 9, 0, 0),
        ];
        tracker.backfill(&times);
        assert_eq!(tracker.message_count(), 3);
        assert!(tracker.cached_stats.is_none());

        // Verify chronological order.
        for pair in tracker.timestamps.windows(2) {
            assert!(pair[0].wall_clock <= pair[1].wall_clock);
        }
    }

    #[test]
    fn test_backfill_noop_when_data_exists() {
        let mut tracker = ActivityTracker::new();
        tracker.record_message();
        assert_eq!(tracker.message_count(), 1);

        tracker.backfill(&[dt(2026, 3, 20, 10, 0, 0), dt(2026, 3, 21, 14, 0, 0)]);
        assert_eq!(tracker.message_count(), 1);
    }

    #[test]
    fn test_backfill_empty_vec_is_noop() {
        let mut tracker = ActivityTracker::new();
        tracker.backfill(&[]);
        assert_eq!(tracker.message_count(), 0);
    }

    #[test]
    fn test_backfill_then_record_message() {
        let mut tracker = ActivityTracker::new();
        tracker.backfill(&[dt(2026, 3, 20, 10, 0, 0), dt(2026, 3, 21, 14, 0, 0)]);
        assert_eq!(tracker.message_count(), 2);

        tracker.record_message();
        assert_eq!(tracker.message_count(), 3);
    }

    #[test]
    fn test_backfill_sorts_unordered_input() {
        let mut tracker = ActivityTracker::new();
        tracker.backfill(&[
            dt(2026, 3, 22, 9, 0, 0),
            dt(2026, 3, 20, 10, 0, 0),
            dt(2026, 3, 21, 14, 0, 0),
        ]);
        assert_eq!(tracker.message_count(), 3);
        assert_eq!(tracker.timestamps[0].wall_clock, dt(2026, 3, 20, 10, 0, 0));
        assert_eq!(tracker.timestamps[1].wall_clock, dt(2026, 3, 21, 14, 0, 0));
        assert_eq!(tracker.timestamps[2].wall_clock, dt(2026, 3, 22, 9, 0, 0));
    }
}
