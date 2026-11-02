import { shoreLog } from "../log.ts";
import type { InvalidationReason, KeepaliveReprime } from "./last_request.ts";

export const REFRESH_DELAY_MS = 300;
export const REFRESH_RETRY_MS = 30_000;
export const REFRESH_RETRIES = 3;

export interface CachedRequestRefreshDeps {
  disarm(character: string): void;
  invalidate(character: string, reason: InvalidationReason): void;
  changesTo(character: string): number;
  rebuild(character: string, thread: string | undefined): Promise<KeepaliveReprime>;
  delayMs?: number;
  retryMs?: number;
}

interface PendingRebuild {
  thread: string | undefined;
  retried: number;
}

export class CachedRequestRefresher {
  readonly #deps: CachedRequestRefreshDeps;
  readonly #pending = new Map<string, PendingRebuild>();
  readonly #retries = new Set<ReturnType<typeof setTimeout>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #rebuilding: { character: string; thread: string | undefined } | undefined;
  #stopped = false;

  constructor(deps: CachedRequestRefreshDeps) {
    this.#deps = deps;
  }

  refresh(character: string, reason: InvalidationReason, thread?: string): void {
    this.#deps.disarm(character);
    this.#deps.invalidate(character, reason);
    if (this.#stopped) return;
    this.#pending.set(character, { thread, retried: 0 });
    this.#schedule(this.#deps.delayMs ?? REFRESH_DELAY_MS);
  }

  targetThread(character: string): string | undefined {
    const rebuilding = this.#rebuilding?.character === character ? this.#rebuilding.thread : undefined;
    return this.#pending.get(character)?.thread ?? rebuilding;
  }

  #schedule(delay: number): void {
    if (this.#stopped || this.#running !== undefined) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.#drain().finally(() => {
        this.#running = undefined;
        if (this.#pending.size > 0) this.#schedule(0);
      });
    }, delay);
    this.#timer.unref?.();
  }

  async #drain(): Promise<void> {
    for (const [character, target] of this.#pending) {
      this.#pending.delete(character);
      await this.#rebuild(character, target);
      if (this.#stopped) return;
    }
  }

  async #rebuild(character: string, target: PendingRebuild): Promise<void> {
    const before = this.#deps.changesTo(character);
    let rebuilt: boolean;
    this.#rebuilding = { character, thread: target.thread };
    try {
      rebuilt = (await this.#deps.rebuild(character, target.thread)).kind !== "disarm";
    } catch (e) {
      shoreLog.warn(`shore: could not rebuild the cached request for ${character}: ${String(e)}`);
      rebuilt = false;
    } finally {
      this.#rebuilding = undefined;
    }
    if (rebuilt) return;
    if (target.retried >= REFRESH_RETRIES) {
      shoreLog.warn(`shore: no keepalive for ${character} until something rebuilds its request, because the rebuild kept failing`);
      return;
    }
    this.#retryLater(character, target, before);
  }

  #retryLater(character: string, target: PendingRebuild, before: number): void {
    const timer = setTimeout(() => {
      this.#retries.delete(timer);
      if (this.#stopped || this.#deps.changesTo(character) !== before || this.#pending.has(character)) return;
      this.#pending.set(character, { thread: target.thread, retried: target.retried + 1 });
      this.#schedule(0);
    }, (this.#deps.retryMs ?? REFRESH_RETRY_MS) * 2 ** target.retried);
    timer.unref?.();
    this.#retries.add(timer);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    for (const timer of this.#retries) clearTimeout(timer);
    this.#retries.clear();
    this.#pending.clear();
    await this.#running;
  }
}
