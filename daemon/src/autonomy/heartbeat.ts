/**
 * Heartbeat clock — deadline holder with abandonment guard.
 *
 * The character schedules its own next wake via the `set_next_wake` tool. This
 * holds that deadline, applies bounds, and fires when it passes. An abandonment
 * guard stops ticking once the user has been absent too long, so a character
 * nobody is talking to does not keep paying for tool loops forever.
 *
 * Ported from `crates/daemon/src/autonomy/heartbeat.rs` and pinned against it by
 * `tests/heartbeat_parity.test.ts`, which replays decision walks recorded from
 * the Rust.
 *
 * **All times are wall-clock milliseconds**, supplied by the caller. The Rust
 * used `tokio::time::Instant` and reached for `Instant::now()` in three places;
 * taking `now` as a parameter throughout keeps this module pure and total on its
 * inputs, the way `CacheKeepalive` already is. It also removes the split the
 * Rust had between a monotonic live clock and wall-clock persistence — the same
 * split that made the keepalive's schedule disagree with its own state file.
 *
 * The two guards are independent and either one trips dormancy:
 *
 * - **tick count** — `ticksWithoutUser >= maxIdleTicks`. Counts firings, so a
 *   character that wakes hourly trips sooner in wall time than one that wakes
 *   daily.
 * - **silence** — `now - lastUserAt >= maxSilentMs`. Wall-clock, so it catches
 *   the case where the schedule stretched out and the tick count never climbed.
 */

/** What `HeartbeatClock.tick` decided. */
export type HeartbeatAction =
  /** Nothing to do this tick. */
  | "none"
  /** Fire a full heartbeat tick — a private LLM call with tools. */
  | "run_tick";

const HOUR_MS = 3_600_000;

/** Minimum interval a character can schedule. */
export const MIN_WAKE_INTERVAL_MS = HOUR_MS;

/** Maximum interval a character can schedule. */
export const MAX_WAKE_INTERVAL_MS = 48 * HOUR_MS;

/** The knobs from `[behavior.autonomy.heartbeat]`, already resolved. */
export interface HeartbeatClockConfig {
  /** Fallback interval when the character does not schedule its own wake. */
  defaultIntervalMs: number;
  /** Consecutive firings without a user message before the guard trips. */
  maxIdleTicks: number;
  /** Wall-clock silence before the guard trips. */
  maxSilentMs: number;
  /** Floor between a user message and the next tick, so a tick cannot fire
   *  into an active conversation. */
  minWakeIntervalMs: number;
}

/** The persisted slice, as it survives a restart. */
export interface HeartbeatSnapshot {
  ticks_without_user: number;
  next_wake_at: number | undefined;
  last_user_at: number | undefined;
}

export class HeartbeatClock {
  /** Next scheduled wake. `undefined` means none — first boot, or the guard
   *  has tripped. */
  #nextWakeAt: number | undefined;

  /** Last time a wake was scheduled or fired; the anchor the default interval
   *  is measured from when the character schedules nothing. */
  #lastAnchor: number;

  /** Consecutive firings with no user message in between. */
  #ticksWithoutUser = 0;

  /** Last user message, for the wall-clock leg of the guard. */
  #lastUserAt: number | undefined;

  readonly #config: HeartbeatClockConfig;

  constructor(config: HeartbeatClockConfig, now: number) {
    this.#config = config;
    this.#lastAnchor = now;
  }

  get nextWakeAt(): number | undefined {
    return this.#nextWakeAt;
  }

  get ticksWithoutUser(): number {
    return this.#ticksWithoutUser;
  }

  get lastUserAt(): number | undefined {
    return this.#lastUserAt;
  }

  get maxIdleTicks(): number {
    return this.#config.maxIdleTicks;
  }

  /**
   * The bounds this clock is running on, for `shore status` to report.
   *
   * Read back off the clock rather than off the daemon's own copy on purpose: a
   * config reload that never reached this side would otherwise be invisible,
   * with the status confidently reporting the interval the daemon *meant* while
   * the loop kept running the old one.
   */
  get config(): Readonly<HeartbeatClockConfig> {
    return this.#config;
  }

  /** Fire the next tick immediately. Does NOT reset the abandonment counters —
   *  a forced wake is not evidence the user came back. */
  forceWake(now: number): void {
    this.#nextWakeAt = now;
  }

  /** Force dormancy. Stays dormant until a user message resets it. */
  forceDormant(): void {
    this.#ticksWithoutUser = this.#config.maxIdleTicks;
    this.#nextWakeAt = undefined;
  }

  /** Force active: clear the counters and tick immediately. The guard re-trips
   *  on its own if the user still does not answer. */
  forceActive(now: number): void {
    this.#ticksWithoutUser = 0;
    this.#lastUserAt = now;
    this.#nextWakeAt = now;
  }

  /**
   * Seed `lastUserAt` from backfilled history, but only when nothing has set it
   * yet.
   *
   * A character bootstrapped from existing chat history would otherwise have
   * `undefined` here, and `undefined` reads as "never silent" — which would let
   * dreaming run against a conversation that has actually been idle for weeks.
   */
  seedLastUserAtIfUnset(at: number): void {
    if (this.#lastUserAt === undefined) this.#lastUserAt = at;
  }

  #isAbandoned(now: number): boolean {
    if (this.#ticksWithoutUser >= this.#config.maxIdleTicks) return true;
    if (this.#lastUserAt !== undefined) {
      if (now - this.#lastUserAt >= this.#config.maxSilentMs) return true;
    }
    return false;
  }

  isDormant(now: number): boolean {
    return this.#isAbandoned(now);
  }

  /** Label for status display and logging. */
  stateAt(now: number): "Active" | "Dormant" {
    return this.isDormant(now) ? "Dormant" : "Active";
  }

  /**
   * Called by the autonomy loop on every tick.
   *
   * 1. No deadline → set one at `lastAnchor + defaultInterval` and return.
   *    Except when already abandoned: a dormant clock must not re-arm itself,
   *    or the guard would be a speed bump rather than a stop.
   * 2. Deadline not reached → nothing.
   * 3. Deadline reached but a guard trips → clear the deadline, stay dormant.
   * 4. Otherwise fire: count it, clear the deadline, re-anchor.
   */
  tick(now: number): HeartbeatAction {
    const wakeAt = this.#nextWakeAt;
    if (wakeAt === undefined) {
      if (this.#isAbandoned(now)) return "none";
      this.#nextWakeAt = this.#lastAnchor + this.#config.defaultIntervalMs;
      return "none";
    }

    if (now < wakeAt) return "none";

    // The two guards are checked separately rather than through `isAbandoned`,
    // because reaching the deadline while abandoned must also *clear* it. The
    // Rust does the same, and the duplication is deliberate: collapsing them
    // would either stop clearing the deadline or start clearing it on a tick
    // that was never due.
    if (this.#ticksWithoutUser >= this.#config.maxIdleTicks) {
      this.#nextWakeAt = undefined;
      return "none";
    }
    if (this.#lastUserAt !== undefined) {
      if (now - this.#lastUserAt >= this.#config.maxSilentMs) {
        this.#nextWakeAt = undefined;
        return "none";
      }
    }

    this.#ticksWithoutUser += 1;
    this.#nextWakeAt = undefined;
    this.#lastAnchor = now;
    return "run_tick";
  }

  /**
   * The character scheduled its own next wake.
   *
   * Out-of-range values are clamped rather than rejected, so a misbehaving
   * character can never silently disable its own heartbeat by asking for a wake
   * in a year — or hammer it by asking for one in a second.
   */
  schedule(when: number, now: number): void {
    const delta = Math.max(0, when - now);
    const clamped = Math.min(Math.max(delta, MIN_WAKE_INTERVAL_MS), MAX_WAKE_INTERVAL_MS);
    this.#nextWakeAt = now + clamped;
    this.#lastAnchor = now;
  }

  /**
   * A user message arrived.
   *
   * Clears the tick counter, anchors the silence guard, and pushes the next
   * wake out to at least `minWakeInterval` — but never *pulls it in*. A
   * character that scheduled a wake two days out keeps it; the floor only
   * applies when the deadline was sooner than that, or absent because this is
   * the first message or the guard had tripped.
   */
  onUserMessage(now: number): void {
    this.#ticksWithoutUser = 0;
    this.#lastUserAt = now;

    const floor = now + this.#config.minWakeIntervalMs;
    const existing = this.#nextWakeAt;
    this.#nextWakeAt = existing !== undefined && existing > floor ? existing : floor;
  }

  /** Re-arm from persisted state after a restart. */
  restore(snapshot: HeartbeatSnapshot): void {
    this.#ticksWithoutUser = snapshot.ticks_without_user;
    if (snapshot.next_wake_at !== undefined) {
      this.#nextWakeAt = snapshot.next_wake_at;
      this.#lastAnchor = snapshot.next_wake_at;
    }
    if (snapshot.last_user_at !== undefined) {
      this.#lastUserAt = snapshot.last_user_at;
    }
  }

  /** The slice worth persisting. */
  snapshot(): HeartbeatSnapshot {
    return {
      ticks_without_user: this.#ticksWithoutUser,
      next_wake_at: this.#nextWakeAt,
      last_user_at: this.#lastUserAt,
    };
  }
}
