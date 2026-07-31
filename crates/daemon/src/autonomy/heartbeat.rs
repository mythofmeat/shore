//! Heartbeat clock — deadline holder with abandonment guard.
//!
//! The character schedules its own next wake via `set_next_wake`. The clock
//! holds that deadline and fires `RunTick` when it passes. An abandonment
//! guard stops ticking when the user has been absent too long.

use std::time::Duration;
use tokio::time::Instant;

use tracing::{debug, info, warn};

use shore_common::config::app::HeartbeatConfig;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum interval a character can schedule (1 hour).
pub const MIN_WAKE_INTERVAL: Duration = Duration::from_hours(1);

/// Maximum interval a character can schedule (48 hours).
pub const MAX_WAKE_INTERVAL: Duration = Duration::from_hours(48);

// ---------------------------------------------------------------------------
// Action enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatAction {
    /// Nothing to do this tick.
    None,
    /// Fire a full heartbeat tick (private LLM call with tools).
    RunTick,
}

// ---------------------------------------------------------------------------
// HeartbeatClock
// ---------------------------------------------------------------------------

/// Deadline holder with abandonment guard.
///
/// The character drives its own cadence via `schedule()`. The clock's job is
/// to hold that deadline, apply bounds, and stop ticking when the user has
/// been gone too long.
#[derive(Debug)]
pub struct HeartbeatClock {
    /// Next scheduled wake time. `None` means no wake is scheduled (first
    /// boot, or guard has tripped).
    next_wake_at: Option<Instant>,

    /// Last time a wake was scheduled or fired. Used for the default-interval
    /// fallback when the character doesn't call set_next_wake.
    last_anchor: Instant,

    // -- abandonment guard --------------------------------------------------
    /// Consecutive heartbeat ticks that fired without a user message.
    ticks_without_user: u32,

    /// Last time a user message arrived. Used for the wall-clock leg of the
    /// abandonment guard.
    last_user_at: Option<Instant>,

    // -- config -------------------------------------------------------------
    /// Fallback interval when the character doesn't call set_next_wake.
    default_interval: Duration,

    /// Max consecutive ticks without user before the guard stops ticking.
    max_idle_ticks: u32,

    /// Max wall-clock duration without user before the guard stops ticking.
    max_silent_duration: Duration,

    /// Minimum interval between a user message and the next tick.
    /// Prevents ticks from firing during active conversation.
    min_wake_interval: Duration,
}

impl HeartbeatClock {
    pub fn with_config(config: &HeartbeatConfig) -> Self {
        Self {
            next_wake_at: None,
            last_anchor: Instant::now(),
            ticks_without_user: 0,
            last_user_at: None,
            default_interval: config.fallback_heartbeat_interval.as_duration(),
            max_idle_ticks: config.dormant_after_heartbeat_turns,
            max_silent_duration: config.dormant_after_idle_time.as_duration(),
            min_wake_interval: config.minimum_heartbeat_latency.as_duration(),
        }
    }

    // -- accessors ----------------------------------------------------------

    pub fn next_wake(&self) -> Option<Instant> {
        self.next_wake_at
    }

    /// Force the next tick to fire immediately. Does not reset abandonment counters.
    pub fn force_wake(&mut self) {
        self.next_wake_at = Some(Instant::now());
    }

    /// Force the clock into dormant state. Stays dormant until a user message
    /// resets it via reset_on_user_message().
    pub fn force_dormant(&mut self) {
        self.ticks_without_user = self.max_idle_ticks;
        self.next_wake_at = None;
    }

    /// Force the clock into active state. Resets abandonment counters and
    /// schedules an immediate tick. Guard will re-trip naturally if user
    /// doesn't respond.
    pub fn force_active(&mut self) {
        self.ticks_without_user = 0;
        self.last_user_at = Some(Instant::now());
        self.next_wake_at = Some(Instant::now());
    }

    pub fn ticks_without_user(&self) -> u32 {
        self.ticks_without_user
    }

    pub fn max_idle_ticks(&self) -> u32 {
        self.max_idle_ticks
    }

    pub fn last_user_at(&self) -> Option<Instant> {
        self.last_user_at
    }

    /// Seed `last_user_at` from backfilled history, but only when it has not
    /// already been set by a real user message or restored state. Used so a
    /// character bootstrapped from existing chat history still honors the
    /// dreaming inactivity window instead of treating `None` as "safe to dream".
    pub fn seed_last_user_at_if_unset(&mut self, at: Instant) {
        if self.last_user_at.is_none() {
            self.last_user_at = Some(at);
        }
    }

    pub fn default_interval(&self) -> Duration {
        self.default_interval
    }

    pub fn min_wake_interval(&self) -> Duration {
        self.min_wake_interval
    }

    pub fn max_silent_duration(&self) -> Duration {
        self.max_silent_duration
    }

    fn is_abandoned(&self, now: Instant) -> bool {
        if self.ticks_without_user >= self.max_idle_ticks {
            return true;
        }
        if let Some(last_user) = self.last_user_at {
            if now.duration_since(last_user) >= self.max_silent_duration {
                return true;
            }
        }
        false
    }

    pub fn is_dormant(&self, now: Instant) -> bool {
        self.is_abandoned(now)
    }

    /// Human-readable state label for status display and logging.
    pub fn state_at(&self, now: Instant) -> &str {
        if self.is_dormant(now) {
            "Dormant"
        } else {
            "Active"
        }
    }

    // -- core ---------------------------------------------------------------

    /// Called by the autonomy loop on each ~30s tick.
    ///
    /// Semantics:
    /// 1. If `next_wake_at` is None → set to `last_anchor + default_interval`, return None.
    /// 2. If `now < next_wake_at` → return None.
    /// 3. Deadline passed — check abandonment guard. If tripped, clear
    ///    `next_wake_at` and return None.
    /// 4. Guard passes → increment counter, clear deadline, update anchor,
    ///    return RunTick.
    pub fn tick(&mut self, now: Instant) -> HeartbeatAction {
        // Step 1: bootstrap if no deadline set — but only if the guard hasn't
        // already tripped. Once abandoned, we stay dormant until reset by a
        // user message.
        let Some(wake_at) = self.next_wake_at else {
            if self.is_abandoned(now) {
                return HeartbeatAction::None;
            }
            let target = self
                .last_anchor
                .checked_add(self.default_interval)
                .unwrap_or(self.last_anchor);
            self.next_wake_at = Some(target);
            debug!(
                default_interval_secs = self.default_interval.as_secs(),
                "HeartbeatClock: no deadline set, scheduling default"
            );
            return HeartbeatAction::None;
        };

        // Step 2: not due yet.
        if now < wake_at {
            return HeartbeatAction::None;
        }

        // Step 3: deadline passed — check abandonment guard.
        if self.ticks_without_user >= self.max_idle_ticks {
            // Tick-count guard.
            info!(
                ticks_without_user = self.ticks_without_user,
                max_idle_ticks = self.max_idle_ticks,
                "HeartbeatClock: abandonment guard tripped (tick count)"
            );
            self.next_wake_at = None;
            return HeartbeatAction::None;
        }
        if let Some(last_user) = self.last_user_at {
            if now.duration_since(last_user) >= self.max_silent_duration {
                info!(
                    silent_secs = now.duration_since(last_user).as_secs(),
                    max_silent_secs = self.max_silent_duration.as_secs(),
                    "HeartbeatClock: abandonment guard tripped (silent duration)"
                );
                self.next_wake_at = None;
                return HeartbeatAction::None;
            }
        }

        // Step 4: guard passes — fire the tick.
        self.ticks_without_user = self.ticks_without_user.saturating_add(1);
        self.next_wake_at = None;
        self.last_anchor = now;
        debug!(
            ticks_without_user = self.ticks_without_user,
            "HeartbeatClock: tick firing"
        );
        HeartbeatAction::RunTick
    }

    /// Called when the character invokes `set_next_wake` during a tick.
    ///
    /// Bounds: `MIN_WAKE_INTERVAL <= (when - now) <= MAX_WAKE_INTERVAL`.
    /// Out-of-range values are clamped (with a warning logged) rather than
    /// rejected, so a misbehaving character can never silently disable
    /// heartbeat.
    pub fn schedule(&mut self, when: Instant, now: Instant) {
        let delta = when.saturating_duration_since(now);
        let clamped = delta.clamp(MIN_WAKE_INTERVAL, MAX_WAKE_INTERVAL);

        if clamped != delta {
            warn!(
                requested_secs = delta.as_secs(),
                clamped_secs = clamped.as_secs(),
                "HeartbeatClock: set_next_wake clamped to bounds"
            );
        }

        let target = now.checked_add(clamped).unwrap_or(now);
        self.next_wake_at = Some(target);
        self.last_anchor = now;
        debug!(
            wake_in_secs = clamped.as_secs(),
            "HeartbeatClock: character scheduled next wake"
        );
    }

    /// Called when a user message arrives.
    ///
    /// Semantics:
    /// 1. Reset `ticks_without_user = 0`.
    /// 2. Set `last_user_at = Some(now)`.
    /// 3. `next_wake_at = max(next_wake_at, Some(now + min_wake_interval))`.
    ///    If `next_wake_at` was None (first message, or abandoned), this
    ///    bootstraps the cycle. If the character had scheduled further out,
    ///    the schedule is preserved.
    pub fn on_user_message(&mut self, now: Instant) {
        self.ticks_without_user = 0;
        self.last_user_at = Some(now);

        let min_wake = now.checked_add(self.min_wake_interval).unwrap_or(now);
        let wake_at = match self.next_wake_at {
            Some(existing) if existing > min_wake => existing,
            _ => min_wake,
        };
        self.next_wake_at = Some(wake_at);

        debug!(
            wake_in_secs = wake_at.duration_since(now).as_secs(),
            "HeartbeatClock: user message, deadline set"
        );
    }

    /// Restore state from persistence (daemon restart).
    pub fn restore(
        &mut self,
        ticks_without_user: u32,
        next_wake_at: Option<Instant>,
        last_user_at: Option<Instant>,
    ) {
        debug!(
            ticks_without_user,
            has_wake = next_wake_at.is_some(),
            has_user = last_user_at.is_some(),
            "HeartbeatClock: state restored from persistence"
        );
        self.ticks_without_user = ticks_without_user;
        if let Some(wake) = next_wake_at {
            self.next_wake_at = Some(wake);
            self.last_anchor = wake;
        }
        if let Some(user) = last_user_at {
            self.last_user_at = Some(user);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(interval_secs: u64, max_idle: u32) -> HeartbeatClock {
        use shore_common::config::ConfigDuration;
        let config = HeartbeatConfig {
            enabled: true,
            fallback_heartbeat_interval: ConfigDuration::from_secs(interval_secs),
            dormant_after_heartbeat_turns: max_idle,
            dormant_after_idle_time: ConfigDuration::from_secs(172_800), // 48h
            minimum_heartbeat_latency: ConfigDuration::from_secs(3600),  // 1h
            wrap_up_grace_rounds: 1,
        };
        HeartbeatClock::with_config(&config)
    }

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    // -- cross-language parity fixture --------------------------------------
    //
    // The tests below were written against this implementation and will be
    // translated alongside the TypeScript port, so they cannot catch a mistake
    // made in both halves of the translation at once. This can.
    //
    // It drives the real clock through deterministic event walks and records
    // what it decided at every observable point. The TypeScript replays the
    // same walks and must give the same answers. Once the Rust is deleted the
    // fixture freezes: it becomes the last word on what the daemon did, not a
    // file to regenerate when a diff appears.
    //
    // `force_wake` and `force_active` are deliberately absent — both read
    // `Instant::now()` internally rather than a passed `now`, so they cannot
    // appear in a time-controlled walk. They are three lines each and pinned by
    // the unit tests above.

    /// Deterministic LCG. Only the *generator* needs one; the walk it produces
    /// is written into the fixture as an explicit event list, so the replaying
    /// side reproduces nothing and just applies what it is given.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            self.0 >> 33
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// Milliseconds from the walk's origin, rounded half-up.
    ///
    /// Rounding rather than truncating matters for reproducibility, not
    /// tidiness. `with_config` captures its own `Instant::now()` for
    /// `last_anchor` a few microseconds after `origin`, so every value derived
    /// from the bootstrap path carries that skew. Truncating or ceiling turns
    /// it into a `3600001` that changes with machine load; rounding absorbs it,
    /// and the fixture reproduces byte for byte.
    fn ms_since(origin: Instant, at: Instant) -> u64 {
        let nanos = at.saturating_duration_since(origin).as_nanos();
        u64::try_from((nanos + 500_000) / 1_000_000).unwrap_or(u64::MAX)
    }

    fn observed(clock: &HeartbeatClock, origin: Instant, now: Instant) -> serde_json::Value {
        serde_json::json!({
            "next_wake_ms": clock.next_wake().map(|w| ms_since(origin, w)),
            "ticks_without_user": clock.ticks_without_user(),
            "last_user_ms": clock.last_user_at().map(|u| ms_since(origin, u)),
            "label": clock.state_at(now),
        })
    }

    fn walk(seed: u64, interval_secs: u64, max_idle: u32) -> serde_json::Value {
        let origin = Instant::now();
        let mut clock = clock(interval_secs, max_idle);
        let mut rng = Lcg(seed);
        let mut at = origin;
        let mut steps = Vec::new();

        for _ in 0..120 {
            // Advance by a spread that straddles the interval, so deadlines are
            // sometimes met and sometimes not.
            at = at
                .checked_add(secs(rng.below(4 * interval_secs.max(1)) + 1))
                .unwrap_or(at);

            // Weighted towards what the loop actually does. `force_dormant` is
            // a manual command, so it is rare here — an even spread let it
            // dominate, and a dormant clock decides nothing, which starved the
            // paths worth pinning.
            let (event, action) = match rng.below(100) {
                0..=57 => {
                    let action = clock.tick(at);
                    (serde_json::json!({ "kind": "tick" }), Some(action))
                }
                58..=79 => {
                    clock.on_user_message(at);
                    (serde_json::json!({ "kind": "user_message" }), None)
                }
                80..=94 => {
                    // Bucketed rather than uniform, so every branch of the
                    // clamp is hit: a uniform draw over the plausible range is
                    // 98% in-bounds and would almost never exercise the floor.
                    let delta = match rng.below(3) {
                        0 => secs(rng.below(3_600)),             // below MIN
                        1 => secs(rng.below(169_200) + 3_600),   // in range
                        _ => secs(rng.below(200_000) + 172_800), // above MAX
                    };
                    let when = at.checked_add(delta).unwrap_or(at);
                    clock.schedule(when, at);
                    (
                        serde_json::json!({
                            "kind": "schedule",
                            "delta_ms": u64::try_from(delta.as_millis()).unwrap_or(u64::MAX),
                        }),
                        None,
                    )
                }
                95..=97 => {
                    let ago = secs(rng.below(300_000));
                    let seeded = at.checked_sub(ago).unwrap_or(origin);
                    clock.seed_last_user_at_if_unset(seeded);
                    (
                        serde_json::json!({
                            "kind": "seed_last_user_if_unset",
                            "at_ms": ms_since(origin, seeded),
                        }),
                        None,
                    )
                }
                _ => {
                    clock.force_dormant();
                    (serde_json::json!({ "kind": "force_dormant" }), None)
                }
            };

            steps.push(serde_json::json!({
                "now_ms": ms_since(origin, at),
                "event": event,
                "action": action.map(|a| match a {
                    HeartbeatAction::None => "none",
                    HeartbeatAction::RunTick => "run_tick",
                }),
                "state": observed(&clock, origin, at),
            }));
        }

        serde_json::json!({
            "seed": seed,
            "config": {
                "default_interval_secs": interval_secs,
                "max_idle_ticks": max_idle,
                "max_silent_secs": 172_800,
                "min_wake_secs": 3_600,
            },
            "steps": steps,
        })
    }

    fn heartbeat_census() -> serde_json::Value {
        serde_json::json!({
            "bounds": {
                "min_wake_interval_secs": MIN_WAKE_INTERVAL.as_secs(),
                "max_wake_interval_secs": MAX_WAKE_INTERVAL.as_secs(),
            },
            // Three shapes: a short interval that fires often, the realistic
            // default, and a low tick ceiling that trips the guard early.
            "walks": [
                walk(1, 3_600, 6),
                walk(2, 7_200, 3),
                walk(3, 1_800, 12),
            ],
        })
    }

    /// Regenerate with `SHORE_REGENERATE_FIXTURES=1 cargo test -p shore-daemon
    /// heartbeat_decisions_match_shared_fixture`, then read the diff: it is
    /// exactly what the TypeScript will now be held to.
    #[test]
    fn heartbeat_decisions_match_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/heartbeat_parity.json"
        );
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&heartbeat_census()).unwrap()
        );

        if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
            std::fs::write(path, &rendered).unwrap();
            return;
        }

        let on_disk = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            rendered, on_disk,
            "heartbeat decisions changed. If that was intended, regenerate with \
             SHORE_REGENERATE_FIXTURES=1 and make the TypeScript match; if it \
             was not, this is the regression the fixture exists to catch."
        );
    }

    // -- basic lifecycle ----------------------------------------------------

    #[test]
    fn first_tick_bootstraps_deadline() {
        let mut c = clock(60, 3);
        let now = Instant::now();
        assert_eq!(c.tick(now), HeartbeatAction::None);
        assert!(c.next_wake_at.is_some());
    }

    #[test]
    fn tick_fires_after_default_interval() {
        let mut c = clock(60, 3);
        let now = Instant::now();
        let _ignored = c.tick(now); // bootstrap
        assert_eq!(c.tick(now + secs(61)), HeartbeatAction::RunTick);
        assert_eq!(c.ticks_without_user, 1);
    }

    #[test]
    fn tick_does_not_fire_before_deadline() {
        let mut c = clock(60, 3);
        let now = Instant::now();
        let _ignored = c.tick(now); // bootstrap
        assert_eq!(c.tick(now + secs(30)), HeartbeatAction::None);
    }

    #[test]
    fn after_tick_fires_next_bootstrap_applies() {
        // After RunTick, next_wake_at is None. The next 30s poll should
        // re-bootstrap with default_interval from the new anchor.
        let mut c = clock(60, 3);
        let now = Instant::now();
        let _ignored = c.tick(now); // bootstrap
        let t1 = now + secs(61);
        assert_eq!(c.tick(t1), HeartbeatAction::RunTick);
        // next_wake_at is now None; next tick re-bootstraps.
        assert_eq!(c.tick(t1 + secs(1)), HeartbeatAction::None);
        // Fires again after another full interval from anchor.
        assert_eq!(c.tick(t1 + secs(61)), HeartbeatAction::RunTick);
    }

    // -- abandonment guard: tick count --------------------------------------

    #[test]
    fn guard_trips_after_max_idle_ticks() {
        let mut c = clock(60, 2);
        let mut now = Instant::now();

        let _ignored = c.tick(now); // bootstrap

        // Tick 1.
        now += secs(61);
        assert_eq!(c.tick(now), HeartbeatAction::RunTick);

        // Tick 2.
        now += secs(61);
        _ = c.tick(now); // bootstrap
        now += secs(61);
        assert_eq!(c.tick(now), HeartbeatAction::RunTick);

        // ticks_without_user is now 2 == max_idle. Next deadline: guard trips.
        now += secs(61);
        _ = c.tick(now); // bootstrap
        now += secs(61);
        assert_eq!(c.tick(now), HeartbeatAction::None);
        assert!(c.next_wake_at.is_none());
    }

    #[test]
    fn guard_does_not_trip_if_user_active() {
        let mut c = clock(60, 2);
        let mut now = Instant::now();

        let _ignored = c.tick(now); // bootstrap

        now += secs(61);
        assert_eq!(c.tick(now), HeartbeatAction::RunTick); // tick 1

        // User resets the counter.
        now += secs(10);
        c.on_user_message(now);
        assert_eq!(c.ticks_without_user, 0);

        // Next tick fires normally.
        now += secs(3601);
        assert_eq!(c.tick(now), HeartbeatAction::RunTick);
        assert_eq!(c.ticks_without_user, 1);
    }

    // -- abandonment guard: silent duration ---------------------------------

    /// The silence guard is `>=`, so it trips *at* the threshold rather than a
    /// tick past it.
    ///
    /// `guard_trips_on_silent_duration` above steps a second beyond (7201 for a
    /// 7200 ceiling), which leaves the boundary itself unpinned — relaxing the
    /// comparison to `>` passes it, and passes the parity walks too, because a
    /// randomised walk essentially never lands on an exact 48-hour mark. This is
    /// the case only a deliberate test reaches.
    #[test]
    fn silent_guard_trips_exactly_at_the_threshold() {
        let mut c = clock(3600, 100); // tick ceiling high enough not to trip first
        c.max_silent_duration = secs(7200);
        let now = Instant::now();
        c.on_user_message(now);

        // Arm a deadline that the boundary tick will have reached.
        c.schedule(now + secs(3600), now);

        // Exactly at the ceiling: silent for 7200s, not 7201.
        let at_threshold = now + secs(7200);
        assert_eq!(c.tick(at_threshold), HeartbeatAction::None);
        assert!(
            c.next_wake_at.is_none(),
            "tripping the guard clears the deadline"
        );
    }

    /// The same `>=` boundary on the *other* copy of the silence check.
    ///
    /// `is_abandoned` duplicates it for two callers `tick`'s deadline path never
    /// reaches: the bootstrap branch, which must refuse to re-arm a dormant
    /// clock, and `state_at`, which labels it. Relaxing only this copy leaves
    /// the test above green.
    #[test]
    fn silence_marks_dormant_exactly_at_the_threshold() {
        let mut c = clock(3600, 100);
        c.max_silent_duration = secs(7200);
        let now = Instant::now();
        c.on_user_message(now);
        c.next_wake_at = None;

        let at_threshold = now + secs(7200);
        assert_eq!(c.state_at(at_threshold), "Dormant");
        // The bootstrap branch must not hand a dormant clock a fresh deadline.
        assert_eq!(c.tick(at_threshold), HeartbeatAction::None);
        assert!(
            c.next_wake_at.is_none(),
            "an abandoned clock must not re-arm itself"
        );
    }

    #[test]
    fn guard_trips_on_silent_duration() {
        let mut c = clock(3600, 100); // high tick count so it doesn't trip first
        c.max_silent_duration = secs(7200); // 2h for test speed
        let now = Instant::now();

        // Simulate: user sent a message, then silence.
        c.on_user_message(now);

        // Fast-forward past the first tick (1h).
        let t1 = now + secs(3601);
        assert_eq!(c.tick(t1), HeartbeatAction::RunTick);

        // Bootstrap next deadline.
        let t2 = t1 + secs(1);
        let _ignored = c.tick(t2);

        // At 2h+1s past user message → silent guard trips.
        let t3 = now + secs(7201);
        assert_eq!(c.tick(t3), HeartbeatAction::None);
        assert!(c.next_wake_at.is_none());
    }

    // -- schedule() ---------------------------------------------------------

    #[test]
    fn schedule_sets_deadline() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        c.on_user_message(now);

        // Character schedules 4h out.
        c.schedule(now + Duration::from_hours(4), now);
        assert!(c.next_wake_at.is_some());

        // Should not fire at 3h.
        assert_eq!(c.tick(now + secs(3 * 3600)), HeartbeatAction::None);
        // Should fire at 4h+1s.
        assert_eq!(c.tick(now + secs(4 * 3600 + 1)), HeartbeatAction::RunTick);
    }

    #[test]
    fn schedule_clamps_below_minimum() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        c.on_user_message(now);

        // Try to schedule 10 minutes out — clamped to 1h.
        c.schedule(now + secs(600), now);
        let wake = c.next_wake_at.unwrap();
        let delta = wake.duration_since(now);
        assert_eq!(delta, MIN_WAKE_INTERVAL);
    }

    #[test]
    fn schedule_clamps_above_maximum() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        c.on_user_message(now);

        // Try to schedule 72h out — clamped to 48h.
        c.schedule(now + secs(72 * 3600), now);
        let wake = c.next_wake_at.unwrap();
        let delta = wake.duration_since(now);
        assert_eq!(delta, MAX_WAKE_INTERVAL);
    }

    // -- on_user_message() --------------------------------------------------

    #[test]
    fn user_message_resets_counter() {
        let mut c = clock(60, 3);
        let mut now = Instant::now();
        let _ignored = c.tick(now);
        now += secs(61);
        _ = c.tick(now); // ticks_without_user = 1
        assert_eq!(c.ticks_without_user, 1);

        c.on_user_message(now);
        assert_eq!(c.ticks_without_user, 0);
    }

    #[test]
    fn user_message_preserves_further_schedule() {
        let mut c = clock(3600, 3);
        let now = Instant::now();

        // Character scheduled 6h out.
        c.schedule(now + secs(6 * 3600), now);
        let original = c.next_wake_at.unwrap();

        // User message at t+30min. The 6h schedule is further out than
        // now + MIN_WAKE (1h), so it should be preserved.
        c.on_user_message(now + secs(1800));
        assert_eq!(c.next_wake_at.unwrap(), original);
    }

    #[test]
    fn user_message_pushes_imminent_deadline() {
        let mut c = clock(60, 3);
        let now = Instant::now();
        let _ignored = c.tick(now); // bootstrap: deadline at now + 60s

        // User message at t+50s. The existing deadline (now+60) is only 10s
        // away, which is less than MIN_WAKE (1h), so on_user_message pushes
        // it to now+50 + 1h.
        let msg_time = now + secs(50);
        c.on_user_message(msg_time);
        let expected_min = msg_time + MIN_WAKE_INTERVAL;
        assert_eq!(c.next_wake_at.unwrap(), expected_min);
    }

    #[test]
    fn user_message_bootstraps_from_none() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        // next_wake_at is None (fresh clock, no tick yet).
        assert!(c.next_wake_at.is_none());

        c.on_user_message(now);
        // Should have set next_wake_at to now + MIN_WAKE.
        assert_eq!(c.next_wake_at.unwrap(), now + MIN_WAKE_INTERVAL);
    }

    #[test]
    fn user_message_wakes_from_abandoned() {
        let mut c = clock(60, 1);
        let mut now = Instant::now();
        let _ignored = c.tick(now); // bootstrap
        now += secs(61);
        _ = c.tick(now); // tick 1

        // Bootstrap and trip the guard.
        now += secs(61);
        _ = c.tick(now); // bootstrap
        now += secs(61);
        assert_eq!(c.tick(now), HeartbeatAction::None); // guard trips
        assert!(c.next_wake_at.is_none());

        // User returns.
        now += secs(100);
        c.on_user_message(now);
        assert_eq!(c.ticks_without_user, 0);
        assert!(c.next_wake_at.is_some());
    }

    // -- restore() ----------------------------------------------------------

    #[test]
    fn restore_with_future_wake() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        let future = now + secs(7200);

        c.restore(2, Some(future), Some(now));
        assert_eq!(c.ticks_without_user, 2);
        assert_eq!(c.next_wake_at, Some(future));
        assert_eq!(c.last_user_at, Some(now));
    }

    #[test]
    fn restore_with_past_wake_fires_immediately() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        let past = now - secs(100);

        c.restore(1, Some(past), Some(now));
        // Deadline is in the past → tick() fires immediately.
        assert_eq!(c.tick(now), HeartbeatAction::RunTick);
    }

    // -- state_at() label ---------------------------------------------------

    #[test]
    fn state_label_active_when_healthy() {
        let c = clock(3600, 3);
        assert_eq!(c.state_at(Instant::now()), "Active");
    }

    #[test]
    fn state_label_dormant_when_tick_guard_tripped() {
        let mut c = clock(60, 1);
        let mut now = Instant::now();
        let _ignored = c.tick(now); // bootstrap
        now += secs(61);
        _ = c.tick(now); // tick 1
        now += secs(61);
        _ = c.tick(now); // bootstrap
        now += secs(61);
        _ = c.tick(now); // guard trips
        assert_eq!(c.state_at(now), "Dormant");
    }

    #[test]
    fn state_label_dormant_when_silent_duration_tripped() {
        let mut c = clock(3600, 100);
        c.max_silent_duration = secs(7200);
        let now = Instant::now();

        c.on_user_message(now);

        let t1 = now + secs(3601);
        assert_eq!(c.tick(t1), HeartbeatAction::RunTick);

        let t2 = t1 + secs(1);
        let _ignored = c.tick(t2);

        let t3 = now + secs(7201);
        assert_eq!(c.tick(t3), HeartbeatAction::None);
        assert_eq!(c.state_at(t3), "Dormant");
    }

    #[test]
    fn state_label_dormant_when_forced_dormant() {
        let mut c = clock(3600, 3);
        c.force_dormant();
        assert_eq!(c.state_at(Instant::now()), "Dormant");
    }

    #[test]
    fn seed_last_user_at_only_fills_when_unset() {
        let mut c = clock(3600, 3);
        let now = Instant::now();
        assert!(c.last_user_at().is_none());

        let backfilled = now - secs(120);
        c.seed_last_user_at_if_unset(backfilled);
        assert_eq!(c.last_user_at(), Some(backfilled));

        // A second seed must not clobber the existing value.
        c.seed_last_user_at_if_unset(now);
        assert_eq!(c.last_user_at(), Some(backfilled));
    }
}
