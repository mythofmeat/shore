export const HEARTBEAT_TRIGGER = "heartbeat";

export interface OwnTimeConfig {
  defaultIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  maxIdleWakes: number;
  maxSilentMs: number;
  deferOnActivity?: boolean;
  heartbeatOff?: boolean;
}

export interface AskedWake {
  at: number;
  reason: string;
}

export type OwnWake =
  | { kind: "asked"; reason: string }
  | { kind: "heartbeat"; byHand: boolean };

export interface OwnTimeSnapshot {
  wakesWithoutUser: number;
  lastUserAt: number | undefined;
  forcedDormant: boolean;
  asked: AskedWake | undefined;
  lastHeartbeatAt: number | undefined;
  notBefore: number | undefined;
}

export class OwnTime {
  #config: OwnTimeConfig;
  #asked: AskedWake | undefined;
  #lastHeartbeatAt: number;
  #notBefore: number | undefined;
  #byHand = false;
  #wakesWithoutUser = 0;
  #lastUserAt: number | undefined;
  #forcedDormant = false;

  constructor(config: OwnTimeConfig, now: number) {
    this.#config = config;
    this.#lastHeartbeatAt = now;
  }

  get config(): Readonly<OwnTimeConfig> {
    return this.#config;
  }

  get asked(): Readonly<AskedWake> | undefined {
    return this.#asked;
  }

  get wakesWithoutUser(): number {
    return this.#wakesWithoutUser;
  }

  get lastUserAt(): number | undefined {
    return this.#lastUserAt;
  }

  get heartbeatIntervalMs(): number {
    return this.#bounded(this.#config.defaultIntervalMs);
  }

  setConfig(config: OwnTimeConfig, now: number): void {
    const raised = config.minIntervalMs > this.#config.minIntervalMs;
    this.#config = config;
    const asked = this.#asked;
    if (asked === undefined) return;
    const floor = raised ? now + config.minIntervalMs : asked.at;
    this.#asked = { ...asked, at: Math.min(Math.max(asked.at, floor), now + config.maxIntervalMs) };
  }

  ask(hoursFromNow: number, reason: string, now: number): number {
    const delay = this.#bounded(Math.max(0, hoursFromNow * 3_600_000));
    this.#asked = { at: now + delay, reason: reason.trim() === "" ? "" : reason };
    return delay;
  }

  isDormant(now: number): boolean {
    if (this.#forcedDormant) return true;
    if (this.#wakesWithoutUser >= this.#config.maxIdleWakes) return true;
    return this.#lastUserAt !== undefined && now - this.#lastUserAt >= this.#config.maxSilentMs;
  }

  stateAt(now: number): "Active" | "Dormant" {
    return this.isDormant(now) ? "Dormant" : "Active";
  }

  nextAt(now: number): number | undefined {
    if (this.isDormant(now)) return undefined;
    if (this.#byHand) return now;
    const set = this.#asked?.at ?? (this.#config.heartbeatOff === true ? undefined : this.#lastHeartbeatAt + this.heartbeatIntervalMs);
    return set === undefined ? undefined : Math.max(set, this.#notBefore ?? set);
  }

  due(now: number): OwnWake | undefined {
    const at = this.nextAt(now);
    const byHand = this.#byHand;
    const asked = this.#asked;
    this.#byHand = false;
    if (at === undefined) {
      if (asked !== undefined && now >= asked.at) this.#asked = undefined;
      return undefined;
    }
    if (now < at) return undefined;
    this.#asked = undefined;
    return asked === undefined ? { kind: "heartbeat", byHand } : { kind: "asked", reason: asked.reason };
  }

  wakeStarted(now: number, plain: boolean): void {
    this.#wakesWithoutUser += 1;
    if (plain) this.#lastHeartbeatAt = now;
  }

  onUserMessage(now: number): void {
    if (this.isDormant(now)) this.#lastHeartbeatAt = now;
    this.#forcedDormant = false;
    this.#wakesWithoutUser = 0;
    this.#lastUserAt = now;
    this.onActivity(now);
  }

  onActivity(now: number): void {
    if (this.#config.deferOnActivity === true) this.#notBefore = now + this.#config.minIntervalMs;
  }

  forceNow(): void {
    this.#byHand = true;
  }

  forceDormant(): void {
    this.#asked = undefined;
    this.#forcedDormant = true;
  }

  forceActive(now: number): void {
    this.#forcedDormant = false;
    this.#wakesWithoutUser = 0;
    this.#lastUserAt = now;
    this.#byHand = true;
  }

  seedLastUserAtIfUnset(at: number): void {
    if (this.#lastUserAt === undefined) this.#lastUserAt = at;
  }

  restore(snapshot: OwnTimeSnapshot, now: number): void {
    this.#wakesWithoutUser = snapshot.wakesWithoutUser;
    this.#forcedDormant = snapshot.forcedDormant;
    this.#asked = snapshot.asked === undefined ? undefined : { ...snapshot.asked, at: Math.min(snapshot.asked.at, now + this.#config.maxIntervalMs) };
    this.#notBefore = snapshot.notBefore;
    this.#lastHeartbeatAt = snapshot.lastHeartbeatAt ?? this.#lastHeartbeatAt;
    this.#lastUserAt = snapshot.lastUserAt;
  }

  snapshot(): OwnTimeSnapshot {
    return {
      wakesWithoutUser: this.#wakesWithoutUser,
      lastUserAt: this.#lastUserAt,
      forcedDormant: this.#forcedDormant,
      asked: this.#asked,
      lastHeartbeatAt: this.#lastHeartbeatAt,
      notBefore: this.#notBefore,
    };
  }

  #bounded(delayMs: number): number {
    return Math.min(Math.max(delayMs, this.#config.minIntervalMs), this.#config.maxIntervalMs);
  }
}
