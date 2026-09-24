export type CacheKeepaliveAction =
  | "none"
  | "ping";

export interface KeepaliveSnapshot {
  model: string;
  interval: number;
  last_warm_at: number;
  last_active_at: number;
  pings_sent?: number;
  max_pings?: number;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

const PING_RETRY_GRACE_MS = 5 * MINUTE_MS;

function retryDelay(failureCount: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 5);
  const secs = Math.min(30 * 2 ** exponent, 15 * 60);
  return secs * SECOND_MS;
}

export class CacheKeepalive {
  #interval: number | undefined;

  #targetModel: string | undefined;

  #maxPings: number;

  #pingsSent = 0;

  #nextPingAt: number | undefined;

  #lastActiveAt: number | undefined;

  #lastWarmAt: number | undefined;

  #prefixWarmAt: number | undefined;

  #failureCount = 0;

  constructor(maxPings: number) {
    this.#maxPings = maxPings;
  }

  get pingsSent(): number {
    return this.#pingsSent;
  }

  get maxPings(): number {
    return this.#maxPings;
  }

  setMaxPings(maxPings: number): void {
    this.#maxPings = maxPings;
  }

  get nextPingAt(): number | undefined {
    return this.#nextPingAt;
  }

  get interval(): number | undefined {
    return this.#interval;
  }

  #deadline(now: number): number | undefined {
    if (this.#interval === undefined || this.#pingsSent >= this.#maxPings) return undefined;
    const byCadence = now + this.#interval;
    if (this.#prefixWarmAt === undefined) return byCadence;
    return Math.min(byCadence, this.#prefixWarmAt + this.#interval);
  }

  onPrefixWarmed(now: number): void {
    this.#prefixWarmAt = now;
    this.#nextPingAt = this.#deadline(now);
  }

  setInterval(
    interval: number | undefined,
    model: string,
    _now?: number,
  ): void {
    if (this.#targetModel !== model) {
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
          :
            this.#deadline(this.#lastActiveAt);
    }
  }

  onCacheWarmed(model: string, now: number): void {
    if (this.#targetModel !== undefined && this.#targetModel !== model) {
      return;
    }
    this.#lastActiveAt = now;
    this.#lastWarmAt = now;
    this.#failureCount = 0;
    this.#pingsSent = 0;
    this.#nextPingAt = this.#deadline(now);
  }

  onPingSucceeded(now: number): void {
    this.#pingsSent += 1;
    this.#failureCount = 0;
    this.#lastWarmAt = now;
    this.#prefixWarmAt = now;
    this.#nextPingAt = this.#deadline(now);
  }

  onCacheInvalidated(): void {
    this.#nextPingAt = undefined;
    this.#lastActiveAt = undefined;
    this.#lastWarmAt = undefined;
    this.#prefixWarmAt = undefined;
    this.#failureCount = 0;
    this.#pingsSent = 0;
  }

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
      pings_sent: this.#pingsSent,
      max_pings: this.#maxPings,
    };
  }

  restore(snapshot: KeepaliveSnapshot, now: number): boolean {
    if (now - snapshot.last_warm_at >= snapshot.interval) {
      return false;
    }
    this.#targetModel = snapshot.model;
    this.#interval = snapshot.interval;
    this.#lastWarmAt = snapshot.last_warm_at;
    this.#prefixWarmAt = snapshot.last_warm_at;
    this.#lastActiveAt = snapshot.last_active_at;
    this.#failureCount = 0;
    this.#pingsSent = snapshot.pings_sent ?? 0;
    if (snapshot.max_pings !== undefined) this.#maxPings = snapshot.max_pings;
    this.#nextPingAt = this.#pingsSent >= this.#maxPings ? undefined : snapshot.last_warm_at + snapshot.interval;
    return true;
  }

  tick(now: number): CacheKeepaliveAction {
    const pingAt = this.#nextPingAt;
    if (pingAt === undefined) {
      return "none";
    }
    if (now < pingAt) {
      return "none";
    }

    if (this.#pingsSent >= this.#maxPings) {
      this.#nextPingAt = undefined;
      return "none";
    }

    return "ping";
  }

  onPingFailed(now: number): void {
    const confirmed = this.#prefixWarmAt ?? this.#lastWarmAt;
    const warmExpired =
      confirmed === undefined || this.#interval === undefined
        ? true
        : now - confirmed >= this.#interval + PING_RETRY_GRACE_MS;
    if (warmExpired) {
      this.onCacheInvalidated();
      return;
    }
    this.#failureCount += 1;
    this.#nextPingAt = now + retryDelay(this.#failureCount);
  }
}
