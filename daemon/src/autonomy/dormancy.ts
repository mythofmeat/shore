export interface DormancyConfig {
  maxIdleWakes: number;
  maxSilentMs: number;
}

export interface DormancySnapshot {
  wakesWithoutUser: number;
  lastUserAt: number | undefined;
  forcedDormant: boolean;
}

export class Dormancy {
  #config: DormancyConfig;
  #wakesWithoutUser = 0;
  #lastUserAt: number | undefined;
  #forced = false;

  constructor(config: DormancyConfig) {
    this.#config = config;
  }

  get config(): DormancyConfig {
    return this.#config;
  }

  get wakesWithoutUser(): number {
    return this.#wakesWithoutUser;
  }

  get lastUserAt(): number | undefined {
    return this.#lastUserAt;
  }

  setConfig(config: DormancyConfig): void {
    this.#config = config;
  }

  isDormant(now: number): boolean {
    if (this.#forced) return true;
    if (this.#wakesWithoutUser >= this.#config.maxIdleWakes) return true;
    return this.#lastUserAt !== undefined && now - this.#lastUserAt >= this.#config.maxSilentMs;
  }

  wakeStarted(): void {
    this.#wakesWithoutUser += 1;
  }

  onUserMessage(now: number): void {
    this.#forced = false;
    this.#wakesWithoutUser = 0;
    this.#lastUserAt = now;
  }

  forceDormant(): void {
    this.#forced = true;
  }

  seedLastUserAtIfUnset(at: number): void {
    if (this.#lastUserAt === undefined) this.#lastUserAt = at;
  }

  restore(snapshot: DormancySnapshot): void {
    this.#wakesWithoutUser = snapshot.wakesWithoutUser;
    this.#lastUserAt = snapshot.lastUserAt;
    this.#forced = snapshot.forcedDormant;
  }

  snapshot(): DormancySnapshot {
    return { wakesWithoutUser: this.#wakesWithoutUser, lastUserAt: this.#lastUserAt, forcedDormant: this.#forced };
  }
}
