/**
 * Keeps a model's prompt cache warm during quiet stretches.
 *
 * Ported from `crates/daemon/src/cache_keepalive.rs`. Structure, field names,
 * and method names are kept deliberately close to the Rust so the two can be
 * diffed while both exist. Nothing calls this yet — the daemon still drives
 * the live schedule; see the module note at the bottom.
 *
 * **Read the comments before changing anything here.** Almost every branch in
 * this file exists because a previous version of it spent real money. The two
 * failure modes it is built to prevent:
 *
 *   - **Pinging a cold cache.** A ping that reads nothing pays a full cache
 *     write, which is strictly worse than not pinging at all — the user may be
 *     hours from returning, and the prefix will have expired again by then.
 *     Every guard that refuses to arm (`on_cache_invalidated`, the model-switch
 *     branch in `setInterval`, the staleness check in `restore`, the give-up in
 *     `onPingFailed`) is protecting this invariant.
 *   - **Pinging forever.** The idle ceiling is anchored to real user activity,
 *     never to a ping, so a run of pings cannot keep pushing its own deadline
 *     out while nobody is there.
 *
 * All instants and durations are **milliseconds**. The Rust uses
 * `tokio::time::Instant` + `Duration`; the caller supplies `now` here, which
 * keeps the module pure and total on its inputs the way `CacheTracker` is.
 *
 * It observes exactly three things:
 *
 * - `setInterval`: the active model's `cache_keepalive` cadence
 *   (`undefined` = off).
 * - `onCacheWarmed`: a *real* LLM call that ran on the **same model** whose
 *   cache we keep warm (a foreground reply, or a heartbeat/background tick that
 *   happens to use that model) — resets both the ping timer and the idle clock.
 *   A call on a *different* model (e.g. a heartbeat pinned to a cheap
 *   background model) does NOT warm this model's prompt cache, so it is
 *   ignored: counting it would push the ping out while the real cache silently
 *   expires, turning every ping into a full cache recreation.
 * - `onCacheInvalidated`: the cached prefix is known unusable (e.g. the model
 *   switched and its prefix is cold).
 *
 * **Two independent knobs govern it:**
 * - **interval** (per-model `cache_keepalive`): how *often* to ping. Anthropic
 *   defaults to `55m`; every other sdk defaults to off. The interval is a
 *   literal cadence, unrelated to the Anthropic-only `cache_ttl` wire setting.
 * - **maxIdle** (global `[behavior.autonomy].cache_keepalive_max`, default
 *   12h): the longest stretch *since the last real activity* over which we keep
 *   pinging. Once it elapses, pinging stops until the user returns. This is the
 *   user-presence / cost ceiling — keyed to the last real message, NOT to the
 *   last ping (otherwise each ping would reset the clock and it would never
 *   expire).
 */

/** What `CacheKeepalive.tick` decided. */
export type CacheKeepaliveAction =
  /** No action needed. */
  | "none"
  /** Fire a bare keepalive ping to refresh the prompt cache. */
  | "ping";

/**
 * Wall-clock-restorable snapshot of an armed keepalive schedule. Produced by
 * {@link CacheKeepalive.snapshot} for persistence and consumed by
 * {@link CacheKeepalive.restore} after a restart.
 */
export interface KeepaliveSnapshot {
  model: string;
  /** Ping cadence, ms. */
  interval: number;
  last_warm_at: number;
  last_active_at: number;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * Grace past the ping interval during which failed pings keep retrying. The
 * interval sits below the provider cache TTL by convention (Anthropic: 55m
 * interval, 1h TTL), so `interval + grace` approximates the moment the warm
 * prefix actually dies. Retrying past that point cannot refresh anything — the
 * next "successful" ping would land on a cold cache and pay a full write (the
 * exact cost-center this subsystem must never become) — so the keepalive
 * disarms instead and waits for the next real warm.
 */
const PING_RETRY_GRACE_MS = 5 * MINUTE_MS;

/** Exponential retry backoff: 30s doubling per consecutive failure, capped at 15m. */
function retryDelay(failureCount: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 5);
  const secs = Math.min(30 * 2 ** exponent, 15 * 60);
  return secs * SECOND_MS;
}

export class CacheKeepalive {
  /** Active model's ping cadence, ms. `undefined` means keepalive is off. */
  #interval: number | undefined;

  /**
   * The model whose prompt cache this keepalive keeps warm — i.e. the model the
   * ping itself runs on (the foreground chat model). Set from each cached
   * request via {@link setInterval}. A warm only counts when it ran on this
   * same model; a background tick on a different model does not refresh this
   * cache. `undefined` until the first request is cached.
   */
  #targetModel: string | undefined;

  /** Global upper bound on time since the last real activity to keep pinging, ms. */
  readonly #maxIdle: number;

  /** Next time a keepalive ping should fire. */
  #nextPingAt: number | undefined;

  /**
   * Last *real* cache-warming activity (user message / heartbeat). Keepalive
   * pings do NOT update this — it anchors the `maxIdle` cutoff.
   */
  #lastActiveAt: number | undefined;

  /**
   * Last confirmed cache-warming event on the target model: a real call
   * ({@link onCacheWarmed}) or a successful ping ({@link onPingSucceeded}).
   * Unlike `lastActiveAt`, pings DO update this — it tracks how fresh the warm
   * prefix itself is, not user presence. Anchors the retry give-up check and
   * the restart {@link restore} guard.
   */
  #lastWarmAt: number | undefined;

  /** Consecutive failed ping attempts. Used for retry backoff. */
  #failureCount = 0;

  /**
   * Create a keepalive with the global idle ceiling (ms). The per-model
   * interval starts unset (off) until {@link setInterval} is called from the
   * first cached request.
   */
  constructor(maxIdleMs: number) {
    this.#maxIdle = maxIdleMs;
  }

  /**
   * Update the active model's ping cadence (`undefined` = keepalive off), e.g.
   * when a request is cached or the user switches models. Reschedules the ping
   * timer to fire one interval after the last real activity. Disabling clears
   * any pending ping.
   *
   * The schedule anchors strictly on `lastActiveAt`: if no real call has warmed
   * a prefix yet (`undefined`, e.g. at startup or right after
   * {@link onCacheInvalidated}), no ping is armed until the next
   * {@link onCacheWarmed}. This keeps the invariant that we never ping a cold
   * cache. `now` is unused for arming but retained for signature symmetry with
   * the other timer mutators.
   */
  setInterval(
    interval: number | undefined,
    model: string,
    _now?: number,
  ): void {
    // Record the model the keepalive ping runs on. Warms are gated on this:
    // only a call on this model actually refreshes the cache we maintain.
    if (this.#targetModel !== model) {
      // A real model switch (not the first-request bootstrap): the prefix we
      // were keeping warm belongs to the old model, and nothing has warmed the
      // new model's prefix yet. An armed timer carried across the switch would
      // fire a ping at a cold cache and pay a full write, so pause until the
      // next real warm — exactly like `onCacheInvalidated`.
      if (this.#targetModel !== undefined) {
        this.onCacheInvalidated();
      }
      this.#targetModel = model;
    }
    const changed = this.#interval !== interval;
    this.#interval = interval;
    if (interval === undefined) {
      this.#nextPingAt = undefined;
      return;
    }
    if (this.#nextPingAt === undefined || changed) {
      this.#nextPingAt =
        this.#lastActiveAt === undefined
          ? undefined
          : this.#lastActiveAt + interval;
    }
  }

  /**
   * Called after ANY *real* LLM call involving the cached prompt — user message
   * or heartbeat tick (NOT a keepalive ping). Resets the idle clock and
   * schedules the next ping one interval out.
   */
  onCacheWarmed(model: string, now: number): void {
    // Only a call on the model we keep warm actually refreshed the cache. A
    // heartbeat/background tick on a *different* model leaves this model's
    // prompt cache untouched — counting it would reschedule the ping past the
    // cache's own TTL, so the next ping lands cold and pays a full cache
    // recreation. Reject only when a target is already established and the
    // models differ; before any target exists (the first foreground turn,
    // before its request is cached) the warm bootstraps the clock.
    if (this.#targetModel !== undefined && this.#targetModel !== model) {
      return;
    }
    this.#lastActiveAt = now;
    this.#lastWarmAt = now;
    this.#failureCount = 0;
    this.#nextPingAt =
      this.#interval === undefined ? undefined : now + this.#interval;
  }

  /**
   * Called after a keepalive ping is confirmed sent. Advances the ping timer
   * one interval from `now` WITHOUT touching the idle clock (so `maxIdle` keeps
   * counting from the last real message).
   */
  onPingSucceeded(now: number): void {
    this.#failureCount = 0;
    this.#lastWarmAt = now;
    this.#nextPingAt =
      this.#interval === undefined ? undefined : now + this.#interval;
  }

  /**
   * Called when the cached prompt prefix is known to be unusable (e.g. the
   * active model changed and its prefix is cold). Pauses pinging until the next
   * real call warms a new prefix.
   *
   * Ordinary compaction should not call this: the conversation tail changes,
   * but stable pinned system sections are still worth keeping warm.
   */
  onCacheInvalidated(): void {
    this.#nextPingAt = undefined;
    // Clear the activity anchor too: the warmed prefix is gone, so a later
    // `setInterval` must NOT re-arm off the stale timestamp. Pinging only
    // resumes once a real call re-warms via `onCacheWarmed`.
    this.#lastActiveAt = undefined;
    this.#lastWarmAt = undefined;
    this.#failureCount = 0;
  }

  /**
   * Snapshot the armed schedule for persistence, or `undefined` when there is
   * nothing worth restoring (keepalive off, never warmed, or invalidated).
   */
  snapshot(): KeepaliveSnapshot | undefined {
    if (
      this.#targetModel === undefined ||
      this.#interval === undefined ||
      this.#lastWarmAt === undefined ||
      this.#lastActiveAt === undefined
    ) {
      return undefined;
    }
    return {
      model: this.#targetModel,
      interval: this.#interval,
      last_warm_at: this.#lastWarmAt,
      last_active_at: this.#lastActiveAt,
    };
  }

  /**
   * Re-arm from a persisted snapshot after a restart. The provider-side cache
   * lives on Anthropic's servers, so a restart does NOT cool it — losing the
   * schedule here is what used to turn a quick redeploy into a full cold cache
   * write on the user's next message.
   *
   * Guard: only re-arms while the snapshot's last warm is younger than one ping
   * interval (the interval sits below the cache TTL by convention, so such a
   * prefix is provably still warm). Anything staler could fire a ping at a cold
   * cache — the one thing this subsystem must never do — so it stays unarmed
   * and waits for the next real warm. Returns whether the schedule was re-armed.
   */
  restore(snapshot: KeepaliveSnapshot, now: number): boolean {
    if (now - snapshot.last_warm_at >= snapshot.interval) {
      return false;
    }
    this.#targetModel = snapshot.model;
    this.#interval = snapshot.interval;
    this.#lastWarmAt = snapshot.last_warm_at;
    this.#lastActiveAt = snapshot.last_active_at;
    this.#nextPingAt = snapshot.last_warm_at + snapshot.interval;
    this.#failureCount = 0;
    return true;
  }

  /**
   * Called by the autonomy loop on each tick.
   *
   * Returns `"ping"` iff a ping is due (`nextPingAt` set and reached) and the
   * character is still within the `maxIdle` window since its last real
   * activity. Past `maxIdle`, pinging stops (the user is presumed away) until
   * real activity resumes.
   *
   * Does NOT advance `nextPingAt` — the caller must call
   * {@link onPingSucceeded} after a successful ping, or {@link onPingFailed} to
   * schedule a short retry backoff.
   */
  tick(now: number): CacheKeepaliveAction {
    const pingAt = this.#nextPingAt;
    if (pingAt === undefined) {
      return "none";
    }
    if (now < pingAt) {
      return "none";
    }

    // Stop pinging once we've gone `maxIdle` without a real message — the user
    // is presumed away and keeping the cache warm is no longer worth the spend.
    // Counted from the last real activity, never from a ping.
    if (this.#lastActiveAt !== undefined) {
      if (now - this.#lastActiveAt >= this.#maxIdle) {
        this.#nextPingAt = undefined;
        return "none";
      }
    }

    return "ping";
  }

  /**
   * Called when a keepalive ping fails or is skipped. Retries with a short
   * exponential backoff so transient failures still get another chance before
   * the cache goes cold — but once the last confirmed warm is older than
   * `interval + PING_RETRY_GRACE_MS` the prefix is past any plausible TTL, and a
   * later retry could only recreate a cold cache at full write cost for a user
   * who may be gone for hours (the failure mode a budget block used to trigger:
   * retries outlive the block, then the first ping through pays the whole
   * prefix). At that point the keepalive disarms instead; the next real warm
   * re-arms it.
   */
  onPingFailed(now: number): void {
    const warmExpired =
      this.#lastWarmAt === undefined || this.#interval === undefined
        ? true
        : now - this.#lastWarmAt >= this.#interval + PING_RETRY_GRACE_MS;
    if (warmExpired) {
      this.onCacheInvalidated();
      return;
    }
    this.#failureCount += 1;
    this.#nextPingAt = now + retryDelay(this.#failureCount);
  }
}
