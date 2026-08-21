export type CacheState = "cold" | "warm";

export type Anomaly =
  | "unexpected_write"
  | "keepalive_miss"
  | "cold_keepalive"
  | "keepalive_rewrote"
  | "keepalive_double_miss";

export const KEEPALIVE_REWRITE_TOKENS = 1000;

export interface Observation {
  ts: string;
  model: string;
  thinking_enabled: boolean;
  cache_read_tokens: number;
  cache_write_tokens: number;
  call_type: string;
  tool_surface?: string | undefined;
}

export interface ObservationResult {
  state: CacheState;
  anomaly: Anomaly | undefined;
}

const DEFAULT_MAX_IDLE_SECS = 12 * 3600;

const DEFAULT_TTL_SECS = 3600;

function parseTs(ts: string): number | undefined {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

const secondsBetween = (later: number, earlier: number): number =>
  Math.trunc((later - earlier) / 1000);

const materialWrite = (cacheReadTokens: number, cacheWriteTokens: number): boolean =>
  cacheWriteTokens * 100 >= cacheReadTokens;

function toolLoopKind(callType: string): string | undefined {
  return callType === "tool_loop" || callType === "heartbeat_tool_loop" ? callType : undefined;
}

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
  #lastToolSurface: string | undefined;
  #lastCallType: string | undefined;
  #lastCacheRead = 0;
  #lastToolLoopKind: string | undefined;
  #lastToolLoopCacheRead = 0;
  #ttlSecs: number;
  #maxIdleSecs: number;
  #ttlExpiredSinceWarm = false;

  #lastKeepaliveMissed = false;
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

  static reconstruct(
    lastTs: string,
    lastModel: string,
    lastThinking: boolean,
    lastCacheRead: number,
    ttlSecs: number,
    now: number = Date.now(),
    lastToolSurface?: string,
  ): CacheTracker {
    const tracker = new CacheTracker(ttlSecs);
    const parsed = parseTs(lastTs);
    tracker.#lastTs = parsed;
    tracker.#lastModel = lastModel;
    tracker.#lastThinking = lastThinking;
    tracker.#lastToolSurface = lastToolSurface;
    tracker.#lastCacheRead = lastCacheRead;
    tracker.#state = reconstructState(lastTs, lastCacheRead, ttlSecs, now);
    return tracker;
  }

  noteActivity(ts: string): void {
    const parsed = parseTs(ts);
    if (parsed !== undefined) this.#lastActivityTs = parsed;
  }

  observe(obs: Observation): ObservationResult {
    const obsTs = parseTs(obs.ts);

    if (obs.call_type === "compaction") {
      this.#state = "cold";
      this.#lastCacheRead = 0;
      this.#clearToolLoopBaseline();
      this.#ttlExpiredSinceWarm = false;
      this.#updateMetadata(obsTs, obs.model, obs.thinking_enabled, obs.tool_surface);
      this.#lastCallType = obs.call_type;
      this.#lastKeepaliveMissed = false;
      return { state: this.#state, anomaly: undefined };
    }

    const loopKind = toolLoopKind(obs.call_type);
    const skipNormalCacheReadComparison = obs.call_type !== "message" && loopKind === undefined;

    if (this.#state === "warm" && this.#lastTs !== undefined && obsTs !== undefined) {
      if (secondsBetween(obsTs, this.#lastTs) > this.#ttlSecs) {
        this.#state = "cold";
        this.#lastCacheRead = 0;
        this.#clearToolLoopBaseline();
        this.#ttlExpiredSinceWarm = true;
      }
    }

    if (this.#state === "warm" && this.#lastModel !== undefined && this.#lastModel !== obs.model) {
      this.#state = "cold";
      this.#lastCacheRead = 0;
      this.#clearToolLoopBaseline();
      this.#ttlExpiredSinceWarm = false;
    }

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

    if (
      this.#state === "warm" &&
      this.#lastToolSurface !== undefined &&
      obs.tool_surface !== undefined &&
      this.#lastToolSurface !== obs.tool_surface
    ) {
      this.#state = "cold";
      this.#lastCacheRead = 0;
      this.#clearToolLoopBaseline();
      this.#ttlExpiredSinceWarm = false;
    }

    let anomaly: Anomaly | undefined;
    if (this.#state === "warm") {
      anomaly = this.#observeWarmCache(obs, loopKind);
    } else if (obs.cache_read_tokens > 0 || obs.cache_write_tokens > 0) {
      this.#state = "warm";
    }

    if (this.#ttlExpiredSinceWarm) {
      this.#ttlExpiredSinceWarm = false;
      if (obs.call_type !== "keepalive") {
        const withinKeepaliveWindow =
          this.#lastActivityTs !== undefined && obsTs !== undefined
            ? secondsBetween(obsTs, this.#lastActivityTs) <= this.#maxIdleSecs
            : true;
        if (anomaly === undefined && withinKeepaliveWindow) anomaly = "keepalive_miss";
      }
    }

    const pureMiss =
      obs.call_type === "keepalive" &&
      obs.cache_read_tokens === 0 &&
      obs.cache_write_tokens > 0;

    if (obs.call_type === "keepalive") {
      if (pureMiss && this.#lastKeepaliveMissed) {
        anomaly = "keepalive_double_miss";
      } else if (anomaly === undefined && pureMiss) {
        anomaly = "cold_keepalive";
      } else if (anomaly === undefined && obs.cache_write_tokens >= KEEPALIVE_REWRITE_TOKENS) {
        anomaly = "keepalive_rewrote";
      }
    }
    this.#lastKeepaliveMissed =
      obs.call_type === "keepalive"
        ? pureMiss
        : this.#lastKeepaliveMissed && obs.cache_read_tokens === 0;

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

    this.#updateMetadata(obsTs, obs.model, obs.thinking_enabled, obs.tool_surface);
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

  #updateMetadata(
    ts: number | undefined,
    model: string,
    thinking: boolean,
    toolSurface: string | undefined,
  ): void {
    this.#lastTs = ts;
    this.#lastModel = model;
    this.#lastThinking = thinking;
    if (toolSurface !== undefined) this.#lastToolSurface = toolSurface;
  }

  #clearToolLoopBaseline(): void {
    this.#lastToolLoopKind = undefined;
    this.#lastToolLoopCacheRead = 0;
  }
}

export class CacheTrackers {
  readonly #map = new Map<string, CacheTracker>();
  #maxIdleSecs = DEFAULT_MAX_IDLE_SECS;

  setMaxIdleSecs(secs: number): void {
    this.#maxIdleSecs = secs;
    for (const tracker of this.#map.values()) tracker.setMaxIdleSecs(secs);
  }

  get maxIdleSecs(): number {
    return this.#maxIdleSecs;
  }

  forCharacter(character: string, ttlSecs: number = DEFAULT_TTL_SECS): CacheTracker {
    let tracker = this.#map.get(character);
    if (!tracker) {
      tracker = new CacheTracker(ttlSecs, this.#maxIdleSecs);
      this.#map.set(character, tracker);
    }
    return tracker;
  }

  needsSeed(character: string): boolean {
    return !this.#map.has(character);
  }

  seed(character: string, tracker: CacheTracker): void {
    tracker.setMaxIdleSecs(this.#maxIdleSecs);
    this.#map.set(character, tracker);
  }
}
