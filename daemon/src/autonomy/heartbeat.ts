export type HeartbeatAction =
  | "none"
  | "run_tick";

export interface HeartbeatClockConfig {
  defaultIntervalMs: number;
  maxIdleTicks: number;
  maxSilentMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
}

export interface HeartbeatSnapshot {
  ticks_without_user: number;
  next_wake_at: number | undefined;
  last_user_at: number | undefined;
}

export class HeartbeatClock {
  #nextWakeAt: number | undefined;

  #lastAnchor: number;

  #ticksWithoutUser = 0;

  #lastUserAt: number | undefined;

  #config: HeartbeatClockConfig;
  #defaultWake = false;

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

  get config(): Readonly<HeartbeatClockConfig> {
    return this.#config;
  }

  setConfig(config: HeartbeatClockConfig, now: number): void {
    const previous = this.#config;
    this.#config = config;
    if (previous.defaultIntervalMs === config.defaultIntervalMs &&
        previous.minIntervalMs === config.minIntervalMs &&
        previous.maxIntervalMs === config.maxIntervalMs) return;
    const existing = this.#nextWakeAt;
    if (existing === undefined) return;
    if (this.#defaultWake) {
      this.#nextWakeAt = Math.max(now, this.#lastAnchor + this.#bounded(config.defaultIntervalMs));
    } else if (config.minIntervalMs > previous.minIntervalMs) {
      this.boundWake(now);
    } else if (existing > now + config.maxIntervalMs) {
      this.#nextWakeAt = now + config.maxIntervalMs;
    }
  }

  forceWake(now: number): void {
    this.#nextWakeAt = now;
    this.#defaultWake = false;
  }

  forceDormant(): void {
    this.#ticksWithoutUser = this.#config.maxIdleTicks;
    this.#nextWakeAt = undefined;
  }

  forceActive(now: number): void {
    this.#ticksWithoutUser = 0;
    this.#lastUserAt = now;
    this.#nextWakeAt = now;
    this.#defaultWake = false;
  }

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

  stateAt(now: number): "Active" | "Dormant" {
    return this.isDormant(now) ? "Dormant" : "Active";
  }

  tick(now: number): HeartbeatAction {
    const wakeAt = this.#nextWakeAt;
    if (wakeAt === undefined) {
      if (this.#isAbandoned(now)) return "none";
      this.#nextWakeAt = this.#lastAnchor + this.#bounded(this.#config.defaultIntervalMs);
      this.#defaultWake = true;
      return "none";
    }

    if (now < wakeAt) return "none";

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

  #bounded(delayMs: number): number {
    return Math.min(Math.max(delayMs, this.#config.minIntervalMs), this.#config.maxIntervalMs);
  }

  schedule(when: number, now: number): number {
    const clamped = this.#bounded(Math.max(0, when - now));
    this.#nextWakeAt = now + clamped;
    this.#lastAnchor = now;
    this.#defaultWake = false;
    return clamped;
  }

  onUserMessage(now: number): void {
    this.#ticksWithoutUser = 0;
    this.#lastUserAt = now;

    const floor = now + this.#config.minIntervalMs;
    const existing = this.#nextWakeAt;
    this.#nextWakeAt = existing !== undefined && existing > floor ? existing : floor;
    this.#defaultWake = false;
  }

  boundWake(now: number, ensureScheduled = false): void {
    const existing = this.#nextWakeAt;
    if (existing === undefined && !ensureScheduled) return;
    const bounded = now + this.#bounded((existing ?? now) - now);
    if (existing === bounded) return;
    this.#nextWakeAt = bounded;
    this.#lastAnchor = now;
    this.#defaultWake = false;
  }

  restore(snapshot: HeartbeatSnapshot): void {
    this.#ticksWithoutUser = snapshot.ticks_without_user;
    if (snapshot.next_wake_at !== undefined) {
      this.#nextWakeAt = snapshot.next_wake_at;
      this.#lastAnchor = snapshot.next_wake_at;
      this.#defaultWake = false;
    }
    if (snapshot.last_user_at !== undefined) {
      this.#lastUserAt = snapshot.last_user_at;
    }
  }

  snapshot(): HeartbeatSnapshot {
    return {
      ticks_without_user: this.#ticksWithoutUser,
      next_wake_at: this.#nextWakeAt,
      last_user_at: this.#lastUserAt,
    };
  }
}
