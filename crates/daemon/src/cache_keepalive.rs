use std::time::Duration;
use tokio::time::Instant;

/// Action returned by [`CacheKeepalive::tick`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheKeepaliveAction {
    /// No action needed.
    None,
    /// Fire a bare keepalive ping to refresh the prompt cache.
    Ping,
}

/// Standalone subsystem that keeps a model's prompt cache warm during quiet
/// stretches. It is deliberately decoupled from the heartbeat: it does **not**
/// observe the next scheduled wake, the dormancy guard, or any heartbeat config.
/// It observes exactly three things:
///
/// - `set_interval`: the active model's `cache_keepalive` cadence (`None` = off).
/// - `on_cache_warmed`: a *real* LLM call that ran on the **same model** whose
///   cache we keep warm (a foreground reply, or a heartbeat/background tick that
///   happens to use that model) — resets both the ping timer and the idle
///   clock. A call on a *different* model (e.g. a heartbeat pinned to a cheap
///   background model) does NOT warm this model's prompt cache, so it is
///   ignored: counting it would push the ping out while the real cache silently
///   expires, turning every ping into a full cache recreation.
/// - `on_cache_invalidated`: the cached prefix is known unusable (e.g. the
///   model switched and its prefix is cold).
///
/// **Two independent knobs govern it:**
/// - **interval** (per-model `cache_keepalive`): how *often* to ping. Anthropic
///   defaults to `55m`; every other sdk defaults to off. The interval is a
///   literal cadence, unrelated to the Anthropic-only `cache_ttl` wire setting.
/// - **max_idle** (global `[behavior.autonomy].cache_keepalive_max`, default
///   12h): the longest stretch *since the last real activity* over which we keep
///   pinging. Once it elapses, pinging stops until the user returns. This is the
///   user-presence / cost ceiling — keyed to the last real message, NOT to the
///   last ping (otherwise each ping would reset the clock and it would never
///   expire).
#[derive(Debug)]
pub struct CacheKeepalive {
    /// Active model's ping cadence. `None` means keepalive is off.
    interval: Option<Duration>,
    /// The model whose prompt cache this keepalive keeps warm — i.e. the model
    /// the ping itself runs on (the foreground chat model). Set from each cached
    /// request via [`set_interval`]. A warm only counts when it ran on this same
    /// model; a background tick on a different model does not refresh this
    /// cache. `None` until the first request is cached.
    ///
    /// [`set_interval`]: CacheKeepalive::set_interval
    target_model: Option<String>,
    /// Global upper bound on time since the last real activity to keep pinging.
    max_idle: Duration,
    /// Next time a keepalive ping should fire.
    next_ping_at: Option<Instant>,
    /// Last *real* cache-warming activity (user message / heartbeat). Keepalive
    /// pings do NOT update this — it anchors the `max_idle` cutoff.
    last_active_at: Option<Instant>,
    /// Last confirmed cache-warming event on the target model: a real call
    /// ([`on_cache_warmed`]) or a successful ping ([`on_ping_succeeded`]).
    /// Unlike `last_active_at`, pings DO update this — it tracks how fresh the
    /// warm prefix itself is, not user presence. Anchors the retry give-up
    /// check and the restart [`restore`] guard.
    ///
    /// [`on_cache_warmed`]: CacheKeepalive::on_cache_warmed
    /// [`on_ping_succeeded`]: CacheKeepalive::on_ping_succeeded
    /// [`restore`]: CacheKeepalive::restore
    last_warm_at: Option<Instant>,
    /// Consecutive failed ping attempts. Used for retry backoff.
    failure_count: u32,
}

/// Wall-clock-restorable snapshot of an armed keepalive schedule. Produced by
/// [`CacheKeepalive::snapshot`] for persistence and consumed by
/// [`CacheKeepalive::restore`] after a daemon restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeepaliveSnapshot {
    pub model: String,
    pub interval: Duration,
    pub last_warm_at: Instant,
    pub last_active_at: Instant,
}

fn retry_delay(failure_count: u32) -> Duration {
    let exponent = failure_count.saturating_sub(1).min(5);
    let secs = 30_u64.saturating_mul(1_u64 << exponent);
    Duration::from_secs(secs.min(15 * 60))
}

/// Grace past the ping interval during which failed pings keep retrying. The
/// interval sits below the provider cache TTL by convention (Anthropic: 55m
/// interval, 1h TTL), so `interval + grace` approximates the moment the warm
/// prefix actually dies. Retrying past that point cannot refresh anything —
/// the next "successful" ping would land on a cold cache and pay a full write
/// (the exact cost-center this subsystem must never become) — so the keepalive
/// disarms instead and waits for the next real warm.
const PING_RETRY_GRACE: Duration = Duration::from_mins(5);

impl CacheKeepalive {
    /// Create a keepalive with the global idle ceiling. The per-model interval
    /// starts unset (off) until [`set_interval`] is called from the first cached
    /// request.
    ///
    /// [`set_interval`]: CacheKeepalive::set_interval
    pub fn new(max_idle: Duration) -> Self {
        Self {
            interval: None,
            target_model: None,
            max_idle,
            next_ping_at: None,
            last_active_at: None,
            last_warm_at: None,
            failure_count: 0,
        }
    }

    /// Update the active model's ping cadence (`None` = keepalive off), e.g. when
    /// a request is cached or the user switches models. Reschedules the ping
    /// timer to fire one interval after the last real activity. Disabling clears
    /// any pending ping.
    ///
    /// The schedule anchors strictly on `last_active_at`: if no real call has
    /// warmed a prefix yet (`None`, e.g. at startup or right after
    /// [`on_cache_invalidated`]), no ping is armed until the next
    /// [`on_cache_warmed`]. This keeps the invariant that we never ping a cold
    /// cache. `now` is unused for arming but retained for signature symmetry with
    /// the other timer mutators.
    ///
    /// [`on_cache_invalidated`]: CacheKeepalive::on_cache_invalidated
    /// [`on_cache_warmed`]: CacheKeepalive::on_cache_warmed
    pub fn set_interval(&mut self, interval: Option<Duration>, model: &str, _now: Instant) {
        // Record the model the keepalive ping runs on. Warms are gated on this:
        // only a call on this model actually refreshes the cache we maintain.
        if self.target_model.as_deref() != Some(model) {
            // A real model switch (not the first-request bootstrap): the prefix
            // we were keeping warm belongs to the old model, and nothing has
            // warmed the new model's prefix yet. An armed timer carried across
            // the switch would fire a ping at a cold cache and pay a full
            // write, so pause until the next real warm — exactly like
            // `on_cache_invalidated`.
            if self.target_model.is_some() {
                self.on_cache_invalidated();
            }
            self.target_model = Some(model.to_owned());
        }
        let changed = self.interval != interval;
        self.interval = interval;
        match interval {
            None => self.next_ping_at = None,
            Some(iv) => {
                if self.next_ping_at.is_none() || changed {
                    self.next_ping_at = self
                        .last_active_at
                        .and_then(|anchor| anchor.checked_add(iv));
                }
            }
        }
    }

    /// Called after ANY *real* LLM call involving the cached prompt — user
    /// message or heartbeat tick (NOT a keepalive ping). Resets the idle clock
    /// and schedules the next ping one interval out.
    pub fn on_cache_warmed(&mut self, model: &str, now: Instant) {
        // Only a call on the model we keep warm actually refreshed the cache.
        // A heartbeat/background tick on a *different* model leaves this model's
        // prompt cache untouched — counting it would reschedule the ping past
        // the cache's own TTL, so the next ping lands cold and pays a full cache
        // recreation. Reject only when a target is already established and the
        // models differ; before any target exists (the first foreground turn,
        // before its request is cached) the warm bootstraps the clock.
        if self.target_model.as_deref().is_some_and(|t| t != model) {
            return;
        }
        self.last_active_at = Some(now);
        self.last_warm_at = Some(now);
        self.failure_count = 0;
        self.next_ping_at = self.interval.and_then(|iv| now.checked_add(iv));
    }

    /// Called after a keepalive ping is confirmed sent. Advances the ping timer
    /// one interval from `now` WITHOUT touching the idle clock (so `max_idle`
    /// keeps counting from the last real message).
    pub fn on_ping_succeeded(&mut self, now: Instant) {
        self.failure_count = 0;
        self.last_warm_at = Some(now);
        self.next_ping_at = self.interval.and_then(|iv| now.checked_add(iv));
    }

    /// Called when the cached prompt prefix is known to be unusable (e.g. the
    /// active model changed and its prefix is cold). Pauses pinging until the
    /// next real call warms a new prefix.
    ///
    /// Ordinary compaction should not call this: the conversation tail changes,
    /// but stable pinned system sections are still worth keeping warm.
    pub fn on_cache_invalidated(&mut self) {
        self.next_ping_at = None;
        // Clear the activity anchor too: the warmed prefix is gone, so a later
        // `set_interval` must NOT re-arm off the stale timestamp. Pinging only
        // resumes once a real call re-warms via `on_cache_warmed`.
        self.last_active_at = None;
        self.last_warm_at = None;
        self.failure_count = 0;
    }

    /// Snapshot the armed schedule for persistence, or `None` when there is
    /// nothing worth restoring (keepalive off, never warmed, or invalidated).
    pub fn snapshot(&self) -> Option<KeepaliveSnapshot> {
        Some(KeepaliveSnapshot {
            model: self.target_model.clone()?,
            interval: self.interval?,
            last_warm_at: self.last_warm_at?,
            last_active_at: self.last_active_at?,
        })
    }

    /// Re-arm from a persisted snapshot after a restart. The provider-side
    /// cache lives on Anthropic's servers, so a daemon restart does NOT cool
    /// it — losing the schedule here is what used to turn a quick redeploy
    /// into a full cold cache write on the user's next message.
    ///
    /// Guard: only re-arms while the snapshot's last warm is younger than one
    /// ping interval (the interval sits below the cache TTL by convention, so
    /// such a prefix is provably still warm). Anything staler could fire a
    /// ping at a cold cache — the one thing this subsystem must never do — so
    /// it stays unarmed and waits for the next real warm. Returns whether the
    /// schedule was re-armed.
    pub fn restore(&mut self, snapshot: &KeepaliveSnapshot, now: Instant) -> bool {
        if now.duration_since(snapshot.last_warm_at) >= snapshot.interval {
            return false;
        }
        self.target_model = Some(snapshot.model.clone());
        self.interval = Some(snapshot.interval);
        self.last_warm_at = Some(snapshot.last_warm_at);
        self.last_active_at = Some(snapshot.last_active_at);
        self.next_ping_at = snapshot.last_warm_at.checked_add(snapshot.interval);
        self.failure_count = 0;
        true
    }

    /// Called by the autonomy loop on each tick.
    ///
    /// Returns `Ping` iff a ping is due (`next_ping_at` set and reached) and the
    /// character is still within the `max_idle` window since its last real
    /// activity. Past `max_idle`, pinging stops (the user is presumed away) until
    /// real activity resumes.
    ///
    /// Does NOT advance `next_ping_at` — the caller must call
    /// [`on_ping_succeeded`] after a successful ping, or [`on_ping_failed`] to
    /// schedule a short retry backoff.
    ///
    /// [`on_ping_succeeded`]: CacheKeepalive::on_ping_succeeded
    /// [`on_ping_failed`]: CacheKeepalive::on_ping_failed
    pub fn tick(&mut self, now: Instant) -> CacheKeepaliveAction {
        let Some(ping_at) = self.next_ping_at else {
            return CacheKeepaliveAction::None;
        };
        if now < ping_at {
            return CacheKeepaliveAction::None;
        }

        // Stop pinging once we've gone `max_idle` without a real message — the
        // user is presumed away and keeping the cache warm is no longer worth
        // the spend. Counted from the last real activity, never from a ping.
        if let Some(last) = self.last_active_at {
            if now.duration_since(last) >= self.max_idle {
                self.next_ping_at = None;
                return CacheKeepaliveAction::None;
            }
        }

        CacheKeepaliveAction::Ping
    }

    /// Called when a keepalive ping fails or is skipped. Retries with a short
    /// exponential backoff so transient failures still get another chance before
    /// the cache goes cold — but once the last confirmed warm is older than
    /// `interval + PING_RETRY_GRACE` the prefix is past any plausible TTL, and a
    /// later retry could only recreate a cold cache at full write cost for a
    /// user who may be gone for hours (the failure mode a budget block used to
    /// trigger: retries outlive the block, then the first ping through pays the
    /// whole prefix). At that point the keepalive disarms instead; the next
    /// real warm re-arms it.
    pub fn on_ping_failed(&mut self, now: Instant) {
        let warm_expired = match (self.last_warm_at, self.interval) {
            (Some(warm), Some(iv)) => {
                now.duration_since(warm) >= iv.saturating_add(PING_RETRY_GRACE)
            }
            _ => true,
        };
        if warm_expired {
            self.on_cache_invalidated();
            return;
        }
        self.failure_count = self.failure_count.saturating_add(1);
        self.next_ping_at = now.checked_add(retry_delay(self.failure_count));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The model whose cache the keepalive maintains in these tests.
    const MODEL: &str = "opus";
    /// A different model — a warm reported on this must NOT count.
    const OTHER_MODEL: &str = "glm";

    fn hours(h: u64) -> Duration {
        Duration::from_secs(h.saturating_mul(3600))
    }

    fn minutes(m: u64) -> Duration {
        Duration::from_secs(m.saturating_mul(60))
    }

    /// A keepalive with a 12h idle ceiling and a 55m interval already armed.
    fn armed(now: Instant) -> CacheKeepalive {
        let mut ka = CacheKeepalive::new(hours(12));
        ka.set_interval(Some(minutes(55)), MODEL, now);
        ka.on_cache_warmed(MODEL, now);
        ka
    }

    #[test]
    fn new_returns_no_action() {
        let mut ka = CacheKeepalive::new(hours(12));
        assert_eq!(ka.tick(Instant::now()), CacheKeepaliveAction::None);
    }

    #[test]
    fn off_interval_never_pings() {
        let now = Instant::now();
        let mut ka = CacheKeepalive::new(hours(12));
        // No interval set (keepalive off) — warming does not schedule a ping.
        ka.on_cache_warmed(MODEL, now);
        assert_eq!(ka.tick(now + hours(2)), CacheKeepaliveAction::None);
        // Explicitly off.
        ka.set_interval(None, MODEL, now);
        assert_eq!(ka.tick(now + hours(2)), CacheKeepaliveAction::None);
    }

    #[test]
    fn ping_fires_after_interval() {
        let now = Instant::now();
        let mut ka = armed(now);
        // Not due yet at 54 minutes (interval is 55min).
        assert_eq!(ka.tick(now + minutes(54)), CacheKeepaliveAction::None);
        // Due at 55 minutes.
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn ping_reschedules_after_confirm() {
        let now = Instant::now();
        let mut ka = armed(now);
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::Ping);
        // Confirm the ping succeeded — advances from the ping time.
        ka.on_ping_succeeded(now + minutes(55));
        assert_eq!(ka.tick(now + minutes(109)), CacheKeepaliveAction::None);
        assert_eq!(ka.tick(now + minutes(110)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn ping_succeeded_does_not_reset_idle_clock() {
        // The max_idle cutoff counts from the last REAL activity, so repeated
        // pings must not push it back. With a 2h ceiling and 55m interval, the
        // third scheduled ping lands past the ceiling and must be suppressed.
        let now = Instant::now();
        let mut ka = CacheKeepalive::new(hours(2));
        ka.set_interval(Some(minutes(55)), MODEL, now);
        ka.on_cache_warmed(MODEL, now);

        // Ping 1 at 55m — within 2h.
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::Ping);
        ka.on_ping_succeeded(now + minutes(55));
        // Ping 2 at 110m — within 2h.
        assert_eq!(ka.tick(now + minutes(110)), CacheKeepaliveAction::Ping);
        ka.on_ping_succeeded(now + minutes(110));
        // Ping 3 would be at 165m — past the 2h (120m) idle ceiling → stop.
        assert_eq!(ka.tick(now + minutes(165)), CacheKeepaliveAction::None);
        // Cleared, so later ticks also stay quiet until real activity resumes.
        assert_eq!(ka.tick(now + minutes(166)), CacheKeepaliveAction::None);
    }

    #[test]
    fn real_activity_resets_idle_clock_and_resumes() {
        let now = Instant::now();
        let mut ka = CacheKeepalive::new(hours(2));
        ka.set_interval(Some(minutes(55)), MODEL, now);
        ka.on_cache_warmed(MODEL, now);

        // Drift to just under the ceiling, then a real message arrives.
        ka.on_cache_warmed(MODEL, now + minutes(115));
        // The old 55m ping does not fire; the timer moved to 115+55=170m.
        assert_eq!(ka.tick(now + minutes(120)), CacheKeepaliveAction::None);
        // Fires at 170m, now measured against the fresh activity at 115m.
        assert_eq!(ka.tick(now + minutes(170)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn retry_backs_off_when_not_confirmed() {
        let now = Instant::now();
        let mut ka = armed(now);
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::Ping);
        // Caller does NOT confirm (ping failed/skipped) — short backoff, not a
        // tight spin.
        ka.on_ping_failed(now + minutes(55));
        assert_eq!(
            ka.tick(now + minutes(55) + Duration::from_secs(29)),
            CacheKeepaliveAction::None
        );
        assert_eq!(
            ka.tick(now + minutes(55) + Duration::from_secs(30)),
            CacheKeepaliveAction::Ping
        );
    }

    #[test]
    fn cache_warm_resets_ping_deadline() {
        let now = Instant::now();
        let mut ka = armed(now);
        // A user message warms the cache at 30min.
        ka.on_cache_warmed(MODEL, now + minutes(30));
        // The old ping at 55min should NOT fire (deadline moved to 30+55=85).
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::None);
        assert_eq!(ka.tick(now + minutes(85)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn warm_on_different_model_is_ignored() {
        // Regression: a heartbeat/background tick on a DIFFERENT model than the
        // keepalive target does not refresh the target's prompt cache, so it
        // must neither reschedule the ping nor reset the idle clock. Counting it
        // (the old bug) pushed the ping past the cache's TTL, turning every ping
        // into a full cache recreation.
        let now = Instant::now();
        let mut ka = armed(now);
        // Off-model "warm" at 30min must NOT move the deadline to 30+55=85m...
        ka.on_cache_warmed(OTHER_MODEL, now + minutes(30));
        // ...the original 55m ping (from the real warm at `now`) still stands.
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn warm_on_different_model_does_not_reset_idle_ceiling() {
        // The idle ceiling counts from the last REAL target warm. An off-model
        // tick must not push it back, or background noise would keep the cache
        // warm forever while the user is away.
        let now = Instant::now();
        let mut ka = CacheKeepalive::new(hours(2));
        ka.set_interval(Some(minutes(55)), MODEL, now);
        ka.on_cache_warmed(MODEL, now);

        // An off-model tick at 90min does not reset the 2h ceiling anchored at `now`.
        ka.on_cache_warmed(OTHER_MODEL, now + minutes(90));
        ka.on_ping_succeeded(now + minutes(55));
        ka.on_ping_succeeded(now + minutes(110));
        // Ping 3 at 165m is past the 2h ceiling (still measured from `now`) → stop.
        assert_eq!(ka.tick(now + minutes(165)), CacheKeepaliveAction::None);
    }

    #[test]
    fn invalidation_pauses_and_warm_resumes() {
        let now = Instant::now();
        let mut ka = armed(now);
        // The cached prefix becomes unusable (e.g. model switch).
        ka.on_cache_invalidated();
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::None);
        // Next real call warms a new prefix — pings resume.
        ka.on_cache_warmed(MODEL, now + hours(1));
        assert_eq!(
            ka.tick(now + hours(1) + minutes(55)),
            CacheKeepaliveAction::Ping
        );
    }

    #[test]
    fn disabling_interval_stops_pinging() {
        let now = Instant::now();
        let mut ka = armed(now);
        // User switches to a model with keepalive off.
        ka.set_interval(None, MODEL, now + minutes(10));
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::None);
        assert_eq!(ka.tick(now + hours(3)), CacheKeepaliveAction::None);
    }

    #[test]
    fn switching_interval_reschedules_from_last_activity() {
        let now = Instant::now();
        let mut ka = armed(now);
        // Switch to a 6h cadence at 30min; anchored to last activity (now),
        // the next ping moves to 6h.
        ka.set_interval(Some(hours(6)), MODEL, now + minutes(30));
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::None);
        assert_eq!(ka.tick(now + hours(6)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn persistent_ping_failures_disarm_once_warm_window_expires() {
        // A budget block (or provider outage) fails every ping. Retries are
        // fine while the prefix could still be warm, but once the last warm is
        // older than interval + grace the cache is dead — retrying further
        // would eventually "succeed" with a full cold write hours later (the
        // $-burning failure mode observed live). The keepalive must disarm.
        let now = Instant::now();
        let mut ka = armed(now);
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::Ping);

        // Failures within the warm window keep retrying...
        ka.on_ping_failed(now + minutes(55));
        assert_eq!(
            ka.tick(now + minutes(55) + Duration::from_secs(30)),
            CacheKeepaliveAction::Ping
        );
        ka.on_ping_failed(now + minutes(56));
        assert_eq!(ka.tick(now + minutes(57)), CacheKeepaliveAction::Ping);

        // ...but a failure past interval (55m) + grace (5m) disarms for good.
        ka.on_ping_failed(now + minutes(61));
        assert_eq!(ka.tick(now + minutes(62)), CacheKeepaliveAction::None);
        assert_eq!(ka.tick(now + hours(3)), CacheKeepaliveAction::None);

        // A real warm re-arms the schedule.
        ka.on_cache_warmed(MODEL, now + hours(4));
        ka.set_interval(Some(minutes(55)), MODEL, now + hours(4));
        assert_eq!(
            ka.tick(now + hours(4) + minutes(55)),
            CacheKeepaliveAction::Ping
        );
    }

    #[test]
    fn model_switch_requires_fresh_warm_before_pinging() {
        // Switching the chat model retargets the keepalive, but the new
        // model's prefix has never been warmed — an armed timer carried across
        // the switch would fire a cold ping (observed live: a sonnet keepalive
        // paying a 21k write right after an opus→sonnet switch).
        let now = Instant::now();
        let mut ka = armed(now);
        ka.set_interval(Some(minutes(55)), OTHER_MODEL, now + minutes(10));
        assert_eq!(ka.tick(now + minutes(55)), CacheKeepaliveAction::None);
        assert_eq!(ka.tick(now + hours(3)), CacheKeepaliveAction::None);

        // A real warm on the new model resumes pinging.
        ka.on_cache_warmed(OTHER_MODEL, now + hours(4));
        assert_eq!(
            ka.tick(now + hours(4) + minutes(55)),
            CacheKeepaliveAction::Ping
        );
    }

    #[test]
    fn snapshot_roundtrips_through_restore() {
        let now = Instant::now();
        let ka = armed(now);
        let snapshot = ka.snapshot().expect("armed keepalive must snapshot");
        assert_eq!(snapshot.model, MODEL);
        assert_eq!(snapshot.interval, minutes(55));

        // Restart 20 minutes later: warm is fresher than one interval, so the
        // schedule re-arms and the ping still fires at last_warm + interval.
        let mut restored = CacheKeepalive::new(hours(12));
        assert!(restored.restore(&snapshot, now + minutes(20)));
        assert_eq!(restored.tick(now + minutes(54)), CacheKeepaliveAction::None);
        assert_eq!(restored.tick(now + minutes(55)), CacheKeepaliveAction::Ping);
    }

    #[test]
    fn restore_stays_unarmed_when_warm_is_stale() {
        // Restart after more than one interval since the last warm: the prefix
        // may already be past its TTL, so re-arming could fire a cold ping.
        // Stay unarmed until the next real warm.
        let now = Instant::now();
        let ka = armed(now);
        let snapshot = ka.snapshot().expect("armed keepalive must snapshot");

        let mut restored = CacheKeepalive::new(hours(12));
        assert!(!restored.restore(&snapshot, now + minutes(56)));
        assert_eq!(restored.tick(now + hours(2)), CacheKeepaliveAction::None);
    }

    #[test]
    fn snapshot_absent_when_unarmed_or_invalidated() {
        let now = Instant::now();
        assert!(CacheKeepalive::new(hours(12)).snapshot().is_none());

        let mut ka = armed(now);
        ka.on_cache_invalidated();
        assert!(ka.snapshot().is_none());
    }

    // ── cross-language parity fixture ────────────────────────────────────────

    /// Deterministic xorshift64. A fixed seed keeps the generated fixture
    /// byte-stable across runs, which is what makes it reviewable as a diff.
    struct Rng(u64);

    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next_u64() % n
        }
    }

    fn snapshot_json(snap: Option<&KeepaliveSnapshot>, base: Instant) -> serde_json::Value {
        snap.map_or(serde_json::Value::Null, |s| {
            serde_json::json!({
                "model": s.model,
                "interval_ms": u64::try_from(s.interval.as_millis()).unwrap_or(u64::MAX),
                "last_warm_at_ms": u64::try_from(
                    s.last_warm_at.duration_since(base).as_millis()
                ).unwrap_or(u64::MAX),
                "last_active_at_ms": u64::try_from(
                    s.last_active_at.duration_since(base).as_millis()
                ).unwrap_or(u64::MAX),
            })
        })
    }

    fn ms(d: Duration) -> u64 {
        u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
    }

    /// How far the clock moves before the next random step.
    ///
    /// Time only ever moves forward, as it does in the daemon. A backwards step
    /// would compare Rust's saturating `duration_since` against TypeScript's
    /// signed subtraction, which is a divergence the real system cannot produce.
    ///
    /// Advances cluster on and around the cadences in play (55m, 6h) and the 2h
    /// ceiling, with ±1min of jitter, rather than spreading uniformly. A uniform
    /// walk almost never lands on an armed deadline, so almost every tick
    /// answers `None` and the fixture stops discriminating exactly where it
    /// matters — a divergence that fires an *extra* ping is the expensive
    /// direction, and it only shows up at a boundary.
    fn random_advance(rng: &mut Rng) -> u64 {
        const MIN_MS: u64 = 60 * 1000;
        let jitter =
            |r: &mut Rng, centre_min: u64| centre_min * MIN_MS + r.below(2 * MIN_MS) - MIN_MS;
        match rng.below(8) {
            0 | 1 => rng.below(3 * MIN_MS),
            2 | 3 => jitter(rng, 55),
            4 => jitter(rng, 6 * 60),
            5 => jitter(rng, 2 * 60),
            _ => rng.below(40 * MIN_MS),
        }
    }

    /// One random mutation of, or probe against, the state machine.
    fn random_step(t: &mut Trace, rng: &mut Rng, at_ms: u64) {
        let model = if rng.below(4) == 0 {
            OTHER_MODEL
        } else {
            MODEL
        };
        match rng.below(12) {
            0 | 1 => {
                let interval = match rng.below(3) {
                    0 => None,
                    1 => Some(minutes(55)),
                    _ => Some(hours(6)),
                };
                t.set_interval(interval, model, at_ms);
            }
            2..=4 => t.warm(model, at_ms),
            5 => t.ping_succeeded(at_ms),
            6 => t.ping_failed(at_ms),
            7 => t.invalidate(),
            8 => {
                let _recorded = t.snapshot();
            }
            _ => t.tick(at_ms),
        }
    }

    /// Generate one pseudo-random scenario, recording the state machine's own
    /// answer at every observable point.
    fn generate_case(rng: &mut Rng, index: usize) -> serde_json::Value {
        // Alternate the ceiling so both the 12h default and a tight 2h ceiling
        // (where the idle cutoff actually bites mid-scenario) are exercised.
        let max_idle = if index.is_multiple_of(3) {
            hours(2)
        } else {
            hours(12)
        };
        let mut t = Trace::new(max_idle);
        let mut at_ms: u64 = 0;
        for _ in 0..30 {
            at_ms += random_advance(rng);
            random_step(&mut t, rng, at_ms);
        }
        t.restore_tail(rng);
        t.finish(&format!("walk_{index:02}"))
    }

    /// Drives the real state machine while recording every call and every
    /// decision, so a hand-written scenario and a random walk emit the same
    /// fixture shape.
    struct Trace {
        ka: CacheKeepalive,
        base: Instant,
        max_idle: Duration,
        steps: Vec<serde_json::Value>,
    }

    impl Trace {
        fn new(max_idle: Duration) -> Self {
            Self {
                ka: CacheKeepalive::new(max_idle),
                base: Instant::now(),
                max_idle,
                steps: Vec::new(),
            }
        }

        fn at(&self, at_ms: u64) -> Instant {
            self.base + Duration::from_millis(at_ms)
        }

        fn set_interval(&mut self, interval: Option<Duration>, model: &str, at_ms: u64) {
            self.ka.set_interval(interval, model, self.at(at_ms));
            self.steps.push(serde_json::json!({
                "op": "set_interval",
                "at_ms": at_ms,
                "model": model,
                "interval_ms": interval.map(ms),
            }));
        }

        fn warm(&mut self, model: &str, at_ms: u64) {
            self.ka.on_cache_warmed(model, self.at(at_ms));
            self.steps
                .push(serde_json::json!({ "op": "warm", "at_ms": at_ms, "model": model }));
        }

        fn ping_succeeded(&mut self, at_ms: u64) {
            self.ka.on_ping_succeeded(self.at(at_ms));
            self.steps
                .push(serde_json::json!({ "op": "ping_succeeded", "at_ms": at_ms }));
        }

        fn ping_failed(&mut self, at_ms: u64) {
            self.ka.on_ping_failed(self.at(at_ms));
            self.steps
                .push(serde_json::json!({ "op": "ping_failed", "at_ms": at_ms }));
        }

        fn invalidate(&mut self) {
            self.ka.on_cache_invalidated();
            self.steps.push(serde_json::json!({ "op": "invalidate" }));
        }

        fn tick(&mut self, at_ms: u64) {
            let action = self.ka.tick(self.at(at_ms));
            self.steps.push(serde_json::json!({
                "op": "tick",
                "at_ms": at_ms,
                "expect": match action {
                    CacheKeepaliveAction::Ping => "ping",
                    CacheKeepaliveAction::None => "none",
                },
            }));
        }

        /// Record what the keepalive would persist, and hand it back so the
        /// caller can restart from it.
        fn snapshot(&mut self) -> Option<KeepaliveSnapshot> {
            let snap = self.ka.snapshot();
            self.steps.push(serde_json::json!({
                "op": "snapshot",
                "expect": snapshot_json(snap.as_ref(), self.base),
            }));
            snap
        }

        /// Snapshot, then restart from it into fresh keepalives at several ages
        /// relative to the snapshot's own interval — including *exactly* one
        /// interval, the `>=` boundary in `restore`. Half an interval must
        /// re-arm; one interval and beyond must not. Getting that edge wrong is
        /// a ping at a prefix that may already be dead.
        ///
        /// Runs against whatever state the walk happened to end in, which is the
        /// point: a restart lands on arbitrary state, not on a tidy one.
        fn restore_tail(&mut self, rng: &mut Rng) {
            let Some(snap) = self.snapshot() else {
                return;
            };
            let snap_json = snapshot_json(Some(&snap), self.base);
            let warm_at_ms = ms(snap.last_warm_at.duration_since(self.base));
            let interval_ms = ms(snap.interval);
            let ages = [
                interval_ms / 2,
                interval_ms.saturating_sub(1),
                interval_ms,
                interval_ms + 1,
                interval_ms * 2,
            ];
            for age_ms in ages {
                let restore_at_ms = warm_at_ms + age_ms;
                let mut restored = CacheKeepalive::new(self.max_idle);
                let armed = restored.restore(&snap, self.at(restore_at_ms));
                self.steps.push(serde_json::json!({
                    "op": "restore",
                    "at_ms": restore_at_ms,
                    "snapshot": snap_json.clone(),
                    "expect": armed,
                }));
                let mut probe_ms = restore_at_ms;
                for _ in 0..4 {
                    probe_ms += rng.below(40 * 60 * 1000);
                    let action = restored.tick(self.at(probe_ms));
                    self.steps.push(serde_json::json!({
                        "op": "restored_tick",
                        "at_ms": probe_ms,
                        "expect": match action {
                            CacheKeepaliveAction::Ping => "ping",
                            CacheKeepaliveAction::None => "none",
                        },
                    }));
                }
            }
        }

        fn finish(self, name: &str) -> serde_json::Value {
            serde_json::json!({
                "name": name,
                "max_idle_ms": ms(self.max_idle),
                "steps": self.steps,
            })
        }
    }

    /// Scenarios that sit exactly on a comparison boundary.
    ///
    /// These are not decoration. Mutating each `>=` in this file to `>`, and
    /// each backoff constant by one step, showed that the random walks and the
    /// unit tests above *both* missed four of them: the idle ceiling, the
    /// give-up window, the retry cap, and the retry grace. A random walk lands
    /// on an exact boundary essentially never, and the unit tests were written
    /// a comfortable margin past each one.
    ///
    /// Every survivor is an over-ping: the mutant keeps a schedule armed where
    /// the real machine disarms it, and the ping it eventually fires lands on a
    /// prefix that is already gone. That is a full cache write per occurrence,
    /// which is the entire cost this subsystem exists to avoid.
    fn boundary_cases() -> Vec<serde_json::Value> {
        let mut out = Vec::new();

        // `tick`: the due-check is `now < next_ping_at`, so landing exactly on
        // the deadline must ping.
        {
            let mut t = Trace::new(hours(12));
            t.set_interval(Some(minutes(55)), MODEL, 0);
            t.warm(MODEL, 0);
            t.tick(ms(minutes(55)) - 1);
            t.tick(ms(minutes(55)));
            out.push(t.finish("boundary_tick_exactly_on_deadline"));
        }

        // `tick`: the ceiling is `now - last_active >= max_idle`, so landing
        // exactly on it must stop. A 60m cadence under a 120m ceiling puts the
        // second scheduled ping precisely there.
        {
            let mut t = Trace::new(hours(2));
            t.set_interval(Some(minutes(60)), MODEL, 0);
            t.warm(MODEL, 0);
            t.tick(ms(minutes(60)));
            t.ping_succeeded(ms(minutes(60)));
            t.tick(ms(minutes(120)));
            t.tick(ms(minutes(121)));
            out.push(t.finish("boundary_idle_ceiling_exact"));
        }

        // One minute of headroom under the same schedule flips it back to a
        // ping — otherwise the case above would also pass with the ceiling
        // check deleted outright.
        {
            let mut t = Trace::new(minutes(121));
            t.set_interval(Some(minutes(60)), MODEL, 0);
            t.warm(MODEL, 0);
            t.tick(ms(minutes(60)));
            t.ping_succeeded(ms(minutes(60)));
            t.tick(ms(minutes(120)));
            out.push(t.finish("boundary_idle_ceiling_headroom"));
        }

        // `on_ping_failed`: one millisecond inside `interval + grace` still
        // retries.
        {
            let mut t = Trace::new(hours(12));
            t.set_interval(Some(minutes(55)), MODEL, 0);
            t.warm(MODEL, 0);
            t.ping_failed(ms(minutes(60)) - 1);
            t.tick(ms(minutes(60)) - 1 + ms(Duration::from_secs(30)));
            out.push(t.finish("boundary_giveup_inside_window"));
        }

        // ...and exactly on it disarms for good. This is the case that pins the
        // 5m grace: widening it to 6m turns the tick below back into a ping.
        {
            let mut t = Trace::new(hours(12));
            t.set_interval(Some(minutes(55)), MODEL, 0);
            t.warm(MODEL, 0);
            t.ping_failed(ms(minutes(60)));
            t.tick(ms(minutes(61)));
            t.tick(ms(hours(5)));
            out.push(t.finish("boundary_giveup_exact"));
        }

        // The full backoff ladder: 30s doubling, clamped at 15m. A 6h cadence
        // keeps every failure inside the give-up window so the run is not cut
        // short, and 20m spacing keeps each probe pair ahead of the next
        // failure.
        {
            let mut t = Trace::new(hours(12));
            t.set_interval(Some(hours(6)), MODEL, 0);
            t.warm(MODEL, 0);
            for (i, delay_secs) in [30_u64, 60, 120, 240, 480, 900, 900].iter().enumerate() {
                let fail_at = ms(minutes(20)) * (u64::try_from(i).unwrap_or(0) + 1);
                let delay_ms = delay_secs * 1000;
                t.ping_failed(fail_at);
                t.tick(fail_at + delay_ms - 1);
                t.tick(fail_at + delay_ms);
            }
            out.push(t.finish("boundary_retry_backoff_ladder"));
        }

        out
    }

    /// Pins the keepalive's decisions across the two implementations that must
    /// agree on them: this state machine and `CacheKeepalive` in
    /// `llm-sidecar/src/autonomy/cache_keepalive.ts`.
    ///
    /// The unit tests above are a poor guard against a *port*: they were
    /// translated alongside the TypeScript, so both sides can be wrong in the
    /// same way and stay green. This walks 40 pseudo-random event sequences
    /// through the real Rust machine and records what it decided, which is a
    /// claim about behaviour rather than about either test suite. A disagreement
    /// means one implementation would ping when the other would not — and a ping
    /// at a cold prefix is a full cache write.
    ///
    /// Regenerate with `SHORE_REGENERATE_FIXTURES=1 cargo test -p shore-daemon
    /// keepalive_decisions_match_shared_fixture`, then read the diff: it is
    /// exactly the schedule change you are shipping.
    #[test]
    fn keepalive_decisions_match_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cache_keepalive_parity.json"
        );

        let mut rng = Rng(0x5EED_C0FF_EE15_600D);
        let mut cases = boundary_cases();
        cases.extend((0..40).map(|i| generate_case(&mut rng, i)));
        let doc = serde_json::json!({
            "_comment": [
                "Generated. Do not hand-edit — see `keepalive_decisions_match_shared_fixture`",
                "in crates/daemon/src/cache_keepalive.rs.",
                "Pseudo-random event walks through the cache keepalive, with the decision",
                "the Rust state machine made at every observable point. Replayed by",
                "llm-sidecar/tests/cache_keepalive_parity.test.ts against the TypeScript",
                "port; the two must agree on every one.",
                "All times are milliseconds from an arbitrary origin, non-decreasing."
            ],
            "cases": cases,
        });
        let rendered = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());

        if std::env::var_os("SHORE_REGENERATE_FIXTURES").is_some() {
            std::fs::write(path, &rendered).unwrap();
            return;
        }

        let on_disk = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            rendered, on_disk,
            "keepalive decisions changed. Regenerate with SHORE_REGENERATE_FIXTURES=1 \
             and update llm-sidecar/src/autonomy/cache_keepalive.ts to match."
        );
    }

    #[test]
    fn set_interval_after_invalidation_does_not_arm_cold_cache() {
        // After invalidation, a model-switch `set_interval` must NOT re-arm off
        // the stale activity timestamp: pinging a cold prefix is exactly what
        // invalidation exists to prevent. Only a real warm resumes pinging.
        let now = Instant::now();
        let mut ka = armed(now);
        ka.on_cache_invalidated();

        // New request cached for the switched model, but nothing has warmed its
        // prefix yet → no ping armed, even far in the future.
        ka.set_interval(Some(minutes(55)), MODEL, now + minutes(5));
        assert_eq!(ka.tick(now + hours(2)), CacheKeepaliveAction::None);

        // A real call warms the new prefix → pinging resumes from there.
        ka.on_cache_warmed(MODEL, now + hours(1));
        assert_eq!(
            ka.tick(now + hours(1) + minutes(55)),
            CacheKeepaliveAction::Ping
        );
    }
}
