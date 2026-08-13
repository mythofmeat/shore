import type { Embedder } from "../llm/embed.ts";
import { HistorySearchIndex, withHistoryIndexLock } from "./history_index.ts";

export interface HistoryIndexRegistration {
  character: string;
  characterDataDir: string;
  indexPath: string;
  embedder?: Embedder;
}

export interface HistoryIndexServiceOptions {
  now?: () => number;
  idleDelayMs?: number;
  batchPauseMs?: number;
  timerIntervalMs?: number;
}

interface Entry extends HistoryIndexRegistration {
  dirty: boolean;
  retryAt: number;
  failures: number;
  nextBatchAt: number;
}

export class HistoryIndexService {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #idleDelayMs: number;
  readonly #batchPauseMs: number;
  readonly #timerIntervalMs: number;
  #idleSince: number;
  #foreground = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: HistoryIndexServiceOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#idleDelayMs = options.idleDelayMs ?? 30_000;
    this.#batchPauseMs = options.batchPauseMs ?? 1_000;
    this.#timerIntervalMs = options.timerIntervalMs ?? 1_000;
    this.#idleSince = this.#now();
  }

  register(registration: HistoryIndexRegistration): void {
    const previous = this.#entries.get(registration.character);
    const locationChanged = previous?.characterDataDir !== registration.characterDataDir ||
      previous?.indexPath !== registration.indexPath;
    const identityChanged = previous?.embedder?.identity !== registration.embedder?.identity ||
      previous?.embedder?.modelId !== registration.embedder?.modelId ||
      previous?.embedder?.dimensions !== registration.embedder?.dimensions;
    this.#entries.set(registration.character, {
      ...registration,
      dirty: locationChanged || (previous?.dirty ?? true),
      retryAt: identityChanged ? 0 : previous?.retryAt ?? 0,
      failures: identityChanged ? 0 : previous?.failures ?? 0,
      nextBatchAt: previous?.nextBatchAt ?? 0,
    });
  }

  unregister(character: string): void {
    this.#entries.delete(character);
  }

  registeredCharacters(): string[] {
    return [...this.#entries.keys()];
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer !== undefined) return;
    await this.reconcileAll();
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#timerIntervalMs);
    this.#timer.unref?.();
  }

  noteMutation(character: string): void {
    const entry = this.#entries.get(character);
    if (entry !== undefined) entry.dirty = true;
  }

  beginForeground(): () => void {
    this.#foreground += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#foreground = Math.max(0, this.#foreground - 1);
      this.#idleSince = this.#now();
    };
  }

  async reconcileAll(): Promise<void> {
    for (const entry of this.#entries.values()) await this.#reconcile(entry);
  }

  async runOnce(): Promise<void> {
    if (this.#closed || this.#running !== undefined) return await this.#running;
    const running = this.#runOnce();
    this.#running = running;
    try {
      await running;
    } finally {
      if (this.#running === running) this.#running = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #runOnce(): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.dirty) await this.#reconcile(entry);
    }
    const now = this.#now();
    if (this.#foreground > 0 || now - this.#idleSince < this.#idleDelayMs) return;
    for (const entry of this.#entries.values()) {
      if (entry.embedder === undefined || now < entry.retryAt || now < entry.nextBatchAt) continue;
      try {
        const embedded = await withHistoryIndexLock(entry.indexPath, async () => {
          const index = HistorySearchIndex.open({
            characterDataDir: entry.characterDataDir,
            path: entry.indexPath,
          });
          try {
            await index.reconcile();
            return await index.embedPending(entry.embedder!);
          } finally {
            index.close();
          }
        });
        entry.failures = 0;
        entry.retryAt = 0;
        if (embedded > 0) entry.nextBatchAt = now + this.#batchPauseMs;
      } catch (error) {
        entry.failures += 1;
        entry.retryAt = now + Math.min(1_000 * 2 ** (entry.failures - 1), 60_000);
        console.warn(
          `shore: history embedding backfill failed for ${entry.character}; retrying later: ${String(error)}`,
        );
      }
      break;
    }
  }

  async #reconcile(entry: Entry): Promise<void> {
    try {
      await withHistoryIndexLock(entry.indexPath, async () => {
        const index = HistorySearchIndex.open({
          characterDataDir: entry.characterDataDir,
          path: entry.indexPath,
        });
        try {
          await index.reconcile();
        } finally {
          index.close();
        }
      });
      entry.dirty = false;
    } catch (error) {
      console.warn(`shore: history search index reconciliation failed for ${entry.character}: ${String(error)}`);
    }
  }
}
