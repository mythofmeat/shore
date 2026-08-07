/**
 * Per-character Anthropic cache warm/cold state machine.
 *
 * Ported from `crates/daemon/src/ledger/cache_tracker.rs`. Structure and field
 * names are kept deliberately close to the Rust so the two can be diffed while
 * both exist.
 *
 * It reads a sequence of recorded calls and labels each with a cache state and,
 * when something is wrong, an anomaly. It never influences a request — the
 * decisions it informs are made elsewhere, in `../autonomy/cache_keepalive.ts`
 * (ported, not yet driving the live schedule; the daemon's
 * `cache_keepalive.rs` still does).
 *
 * The invariants are Anthropic's: a 1h prompt-cache TTL, a keepalive cadence
 * that bridges idle stretches, and a cacheable prefix that grows monotonically.
 * Other providers cache with different semantics and are given a plain
 * warm/cold label with no anomalies — running them through these rules produced
 * only false positives.
 *
 * **One row per provider call is load-bearing.** This compares each call's
 * `cache_read` against the previous call's, so a row carrying a *sum* across
 * several calls reports a read no single call made, raises the baseline above
 * anything reachable, and makes the next ordinary message look like a
 * regression. See shore commit 22a2d3ff.
 */

export type CacheState = "cold" | "warm";

export type Anomaly =
  /** A read below the baseline paired with a real write — the prefix went away. */
  | "unexpected_write"
  /** TTL expired from warm and the next call was not a keepalive: the keepalive
   *  system failed to bridge the gap it exists for. */
  | "keepalive_miss"
  /** A keepalive that read nothing and paid a write. The most expensive failure
   *  mode of the subsystem, and one that used to be silent. */
  | "cold_keepalive";

export interface Observation {
  ts: string;
  model: string;
  thinking_enabled: boolean;
  cache_read_tokens: number;
  cache_write_tokens: number;
  call_type: string;
}

export interface ObservationResult {
  state: CacheState;
  anomaly: Anomaly | undefined;
}

/** Keepalive idle ceiling in seconds (12h), mirroring
 *  `[behavior.autonomy].cache_keepalive_max`. Past this gap the keepalive
 *  subsystem deliberately stops, so a cold start beyond it is by design. */
export const DEFAULT_MAX_IDLE_SECS = 12 * 3600;

const DEFAULT_TTL_SECS = 3600;

/** Epoch millis, or undefined when the timestamp will not parse. */
function parseTs(ts: string): number | undefined {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Whole seconds between two epoch-millis stamps, truncated toward zero —
 *  matching chrono's `num_seconds`. */
const secondsBetween = (later: number, earlier: number): number =>
  Math.trunc((later - earlier) / 1000);

/**
 * Whether a cache write is large enough (≥1% of the read) to signal a real
 * prefix invalidation.
 *
 * A read below the baseline with only a token-scale write means the *request*
 * got shorter — an edited or regenerated turn hitting a still-warm prefix and
 * recaching its tail. That costs pennies and warms the cache; alarming on it
 * buries the real signal.
 */
const materialWrite = (cacheReadTokens: number, cacheWriteTokens: number): boolean =>
  cacheWriteTokens * 100 >= cacheReadTokens;

/** Loops keep a short-lived baseline of their own; a normal message does not. */
function toolLoopKind(callType: string): string | undefined {
  return callType === "tool_loop" || callType === "heartbeat_tool_loop" ? callType : undefined;
}

/**
 * Whether the prefix behind a character's last Anthropic call is still warm.
 *
 * Warm requires both halves: the call must be inside the cache TTL, and it must
 * actually have read something. A call that read nothing wrote a prefix but
 * proves nothing about one existing before it.
 *
 * An unparseable timestamp reads as cold rather than as an error — a row we
 * cannot date is one we cannot claim is fresh.
 *
 * Two callers, one rule: {@link CacheTracker.reconstruct} seeds a tracker after
 * a restart, and `usage.ts` recomputes cache health for `shore usage`. The
 * daemon kept a second copy of this in `ledger/cache_tracker.rs` for the latter;
 * it went when its reader did.
 */
export function reconstructState(
  lastTs: string,
  lastCacheRead: number,
  ttlSecs: number,
  now: number = Date.now(),
): CacheState {
  const parsed = parseTs(lastTs);
  return parsed !== undefined && secondsBetween(now, parsed) < ttlSecs && lastCacheRead > 0
    ? "warm"
    : "cold";
}

export class CacheTracker {
  #state: CacheState = "cold";
  #lastTs: number | undefined;
  #lastModel: string | undefined;
  #lastThinking: boolean | undefined;
  #lastCallType: string | undefined;
  #lastCacheRead = 0;
  #lastToolLoopKind: string | undefined;
  #lastToolLoopCacheRead = 0;
  #ttlSecs: number;
  #maxIdleSecs: number;
  /** True when the cache was warm and just aged out via TTL. The next
   *  non-keepalive call in this state is a `keepalive_miss`. */
  #ttlExpiredSinceWarm = false;
  /** Last *foreground* activity (`message` / `tool_loop`).
   *
   *  The keepalive-miss window is measured from here, never from pings or
   *  background calls. Anchoring on the previous observation instead misread
   *  the deliberate past-the-ceiling stop: pings run all night, stop 12h after
   *  the user left, and the user's return looks like a short gap from the last
   *  ping — flagging a by-design cold start as a failure. */
  #lastActivityTs: number | undefined;

  constructor(ttlSecs: number = DEFAULT_TTL_SECS, maxIdleSecs: number = DEFAULT_MAX_IDLE_SECS) {
    this.#ttlSecs = ttlSecs;
    this.#maxIdleSecs = maxIdleSecs;
  }

  get state(): CacheState {
    return this.#state;
  }

  get lastCacheRead(): number {
    return this.#lastCacheRead;
  }

  setMaxIdleSecs(secs: number): void {
    this.#maxIdleSecs = secs;
  }

  /**
   * Rebuild from the last recorded Anthropic call, as the daemon's
   * `reconstruct_cache_state` did at startup. Warm only if that call is inside
   * the TTL *and* actually read cache.
   */
  static reconstruct(
    lastTs: string,
    lastModel: string,
    lastThinking: boolean,
    lastCacheRead: number,
    ttlSecs: number,
    now: number = Date.now(),
  ): CacheTracker {
    const tracker = new CacheTracker(ttlSecs);
    const parsed = parseTs(lastTs);
    tracker.#lastTs = parsed;
    tracker.#lastModel = lastModel;
    tracker.#lastThinking = lastThinking;
    tracker.#lastCacheRead = lastCacheRead;
    tracker.#state = reconstructState(lastTs, lastCacheRead, ttlSecs, now);
    // Activity history is unknown, so the keepalive-miss window falls back to
    // flagging rather than silently excusing a gap it cannot measure.
    return tracker;
  }

  /**
   * Record foreground activity seen outside this state machine — the user
   * chatting on a non-Anthropic model, whose rows skip the Anthropic rules.
   * Keeps the keepalive-window anchor honest without running any transitions.
   */
  noteActivity(ts: string): void {
    const parsed = parseTs(ts);
    if (parsed !== undefined) this.#lastActivityTs = parsed;
  }

  observe(obs: Observation): ObservationResult {
    const obsTs = parseTs(obs.ts);

    // 1. Compaction always goes cold. Deliberate, not a keepalive failure.
    if (obs.call_type === "compaction") {
      this.#state = "cold";
      this.#lastCacheRead = 0;
      this.#clearToolLoopBaseline();
      this.#ttlExpiredSinceWarm = false;
      this.#updateMetadata(obsTs, obs.model, obs.thinking_enabled);
      this.#lastCallType = obs.call_type;
      return { state: this.#state, anomaly: undefined };
    }

    // 1b. Only `message` shares the prefix the warm/cold baseline tracks.
    // Keepalives, heartbeats, subagents and memory queries each run a
    // *different* prefix, so comparing their reads to the message baseline
    // produced false `unexpected_write`s. Loops keep their own baseline below.
    const loopKind = toolLoopKind(obs.call_type);
    const skipNormalCacheReadComparison = obs.call_type !== "message" && loopKind === undefined;

    // 2. TTL expiry: warm → cold.
    if (this.#state === "warm" && this.#lastTs !== undefined && obsTs !== undefined) {
      if (secondsBetween(obsTs, this.#lastTs) > this.#ttlSecs) {
        this.#state = "cold";
        this.#lastCacheRead = 0;
        this.#clearToolLoopBaseline();
        this.#ttlExpiredSinceWarm = true;
      }
    }

    // 3. Model change: warm → cold. Deliberate.
    if (this.#state === "warm" && this.#lastModel !== undefined && this.#lastModel !== obs.model) {
      this.#state = "cold";
      this.#lastCacheRead = 0;
      this.#clearToolLoopBaseline();
      this.#ttlExpiredSinceWarm = false;
    }

    // 4. Thinking toggle: warm → cold. Deliberate.
    if (
      this.#state === "warm" &&
      this.#lastThinking !== undefined &&
      this.#lastThinking !== obs.thinking_enabled
    ) {
      this.#state = "cold";
      this.#lastCacheRead = 0;
      this.#clearToolLoopBaseline();
      this.#ttlExpiredSinceWarm = false;
    }

    // 5. Evaluate against expected behaviour.
    let anomaly: Anomaly | undefined;
    if (this.#state === "warm") {
      anomaly = this.#observeWarmCache(obs, loopKind);
    } else if (obs.cache_read_tokens > 0 || obs.cache_write_tokens > 0) {
      this.#state = "warm";
    }

    // 5b. Keepalive miss: the cache aged out and the next call was not a ping.
    if (this.#ttlExpiredSinceWarm) {
      this.#ttlExpiredSinceWarm = false;
      if (obs.call_type !== "keepalive") {
        // Only a miss if the keepalive *should* have been pinging. Past the
        // idle ceiling it deliberately stops (user presumed away), so a cold
        // start beyond that gap is expected. Measured from the last foreground
        // activity — the same anchor the keepalive's own ceiling uses. With no
        // usable timestamps we cannot prove a deliberate stop, so we keep the
        // stricter behaviour and flag.
        const withinKeepaliveWindow =
          this.#lastActivityTs !== undefined && obsTs !== undefined
            ? secondsBetween(obsTs, this.#lastActivityTs) <= this.#maxIdleSecs
            : true;
        if (anomaly === undefined && withinKeepaliveWindow) anomaly = "keepalive_miss";
      }
      // else: a keepalive arrived. Whether it refreshed anything is judged in 5c.
    }

    // 5c. Cold keepalive: the ping read nothing and paid a write. A healthy one
    // reads a still-warm prefix and writes nothing. Pure function of this single
    // observation, so interleaved models thrashing the state machine cannot
    // mask it.
    if (
      anomaly === undefined &&
      obs.call_type === "keepalive" &&
      obs.cache_read_tokens === 0 &&
      obs.cache_write_tokens > 0
    ) {
      anomaly = "cold_keepalive";
    }

    // 6. Update baselines. Only normal messages move the message baseline.
    if (loopKind !== undefined) {
      if (anomaly === undefined) {
        this.#lastToolLoopKind = loopKind;
        this.#lastToolLoopCacheRead = obs.cache_read_tokens;
      } else {
        this.#clearToolLoopBaseline();
      }
    } else if (!skipNormalCacheReadComparison) {
      this.#lastCacheRead = obs.cache_read_tokens;
      this.#clearToolLoopBaseline();
    } else if (obs.call_type === "heartbeat") {
      this.#clearToolLoopBaseline();
    }
    // else: comparison skipped for a non-heartbeat call — leave the baseline alone.

    this.#updateMetadata(obsTs, obs.model, obs.thinking_enabled);
    this.#lastCallType = obs.call_type;
    if ((obs.call_type === "message" || obs.call_type === "tool_loop") && obsTs !== undefined) {
      this.#lastActivityTs = obsTs;
    }

    return { state: this.#state, anomaly };
  }

  #observeWarmCache(obs: Observation, loopKind: string | undefined): Anomaly | undefined {
    if (loopKind !== undefined) {
      const continuedLoop =
        this.#lastToolLoopKind === loopKind && this.#lastCallType === obs.call_type;
      const droppedWithinLoop =
        continuedLoop &&
        obs.cache_read_tokens < this.#lastToolLoopCacheRead &&
        materialWrite(obs.cache_read_tokens, obs.cache_write_tokens);
      const coldWriteAfterWarmMessage =
        !continuedLoop &&
        this.#lastCacheRead > 0 &&
        obs.cache_read_tokens === 0 &&
        obs.cache_write_tokens > 0;

      if (droppedWithinLoop || coldWriteAfterWarmMessage) {
        this.#state = "cold";
        this.#lastCacheRead = 0;
        return "unexpected_write";
      }
      return undefined;
    }

    // Only `message` is comparable to the message baseline.
    if (
      obs.call_type !== "message" ||
      obs.cache_read_tokens >= this.#lastCacheRead ||
      !materialWrite(obs.cache_read_tokens, obs.cache_write_tokens)
    ) {
      return undefined;
    }
    this.#state = "cold";
    this.#lastCacheRead = 0;
    return "unexpected_write";
  }

  #updateMetadata(ts: number | undefined, model: string, thinking: boolean): void {
    this.#lastTs = ts;
    this.#lastModel = model;
    this.#lastThinking = thinking;
  }

  #clearToolLoopBaseline(): void {
    this.#lastToolLoopKind = undefined;
    this.#lastToolLoopCacheRead = 0;
  }
}

/**
 * Per-character trackers plus the keepalive idle ceiling applied to them.
 *
 * Bun runs one JS thread, so the map is serialized without a lock — the
 * property the Rust side needed a `Mutex` for.
 */
export class CacheTrackers {
  readonly #map = new Map<string, CacheTracker>();
  #maxIdleSecs = DEFAULT_MAX_IDLE_SECS;

  /** Set the ceiling for future trackers and retune the live ones. */
  setMaxIdleSecs(secs: number): void {
    this.#maxIdleSecs = secs;
    for (const tracker of this.#map.values()) tracker.setMaxIdleSecs(secs);
  }

  get maxIdleSecs(): number {
    return this.#maxIdleSecs;
  }

  /** The character's tracker, creating a cold one if there is none. */
  forCharacter(character: string, ttlSecs: number = DEFAULT_TTL_SECS): CacheTracker {
    let tracker = this.#map.get(character);
    if (!tracker) {
      tracker = new CacheTracker(ttlSecs, this.#maxIdleSecs);
      this.#map.set(character, tracker);
    }
    return tracker;
  }

  /** True when this character has no tracker yet — the caller may want to seed
   *  one from the last recorded call rather than starting cold. */
  needsSeed(character: string): boolean {
    return !this.#map.has(character);
  }

  seed(character: string, tracker: CacheTracker): void {
    tracker.setMaxIdleSecs(this.#maxIdleSecs);
    this.#map.set(character, tracker);
  }
}
