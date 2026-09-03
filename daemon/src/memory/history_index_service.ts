import { required } from "../util/required.ts";

import { describeError } from "../llm/errors";
import { shoreLog } from "../log.ts";

import type { Embedder } from "../llm/embed.ts";
import { HistorySearchIndex, withHistoryIndexLock } from "./history_index.ts";

export interface HistoryIndexRegistration {
  character: string;
  characterDataDir: string;
  dbPath: string;
  indexPath: string;
  embedder?: Embedder;
}

export interface HistoryIndexServiceOptions {
  now?: () => number;
  idleDelayMs?: number;
  batchPauseMs?: number;
  maxBatchPauseMs?: number;
  timerIntervalMs?: number;
}

export interface HistoryIndexProgress {
  character: string;
  characterDataDir: string;
  dbPath: string;
  indexPath: string;
  embedder: Embedder | undefined;
  failures: number;
  retryAt: number;
  nextBatchAt: number;
  lastError: string | undefined;
}

interface Entry extends HistoryIndexRegistration {
  dirty: boolean;
  retryAt: number;
  failures: number;
  nextBatchAt: number;
  idleRounds: number;
  lastError: string | undefined;
}

export class HistoryIndexService {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #idleDelayMs: number;
  readonly #batchPauseMs: number;
  readonly #maxBatchPauseMs: number;
  readonly #timerIntervalMs: number;
  #idleSince: number;
  #lastPicked: string | undefined;
  #foreground = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: HistoryIndexServiceOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#idleDelayMs = options.idleDelayMs ?? 30_000;
    this.#batchPauseMs = options.batchPauseMs ?? 1_000;
    this.#maxBatchPauseMs = options.maxBatchPauseMs ?? 5 * 60_000;
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
      nextBatchAt: identityChanged ? 0 : previous?.nextBatchAt ?? 0,
      idleRounds: identityChanged ? 0 : previous?.idleRounds ?? 0,
      lastError: identityChanged ? undefined : previous?.lastError,
    });
  }

  unregister(character: string): void {
    this.#entries.delete(character);
  }

  registeredCharacters(): string[] {
    return [...this.#entries.keys()];
  }

  progress(character: string): HistoryIndexProgress | undefined {
    const entry = this.#entries.get(character);
    if (entry === undefined) return undefined;
    return {
      character,
      characterDataDir: entry.characterDataDir,
      dbPath: entry.dbPath,
      indexPath: entry.indexPath,
      embedder: entry.embedder,
      failures: entry.failures,
      retryAt: entry.retryAt,
      nextBatchAt: entry.nextBatchAt,
      lastError: entry.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer !== undefined) return;
    await this.reconcileAll();
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#timerIntervalMs);
    this.#timer.unref?.();
  }

  noteMutation(character: string): void {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    entry.dirty = true;
    entry.idleRounds = 0;
    entry.nextBatchAt = 0;
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

  #pauseFor(idleRounds: number): number {
    if (idleRounds === 0) return this.#batchPauseMs;
    const grown = this.#batchPauseMs * 2 ** Math.min(idleRounds, 20);
    return Math.min(grown, this.#maxBatchPauseMs);
  }

  async #runOnce(): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.dirty) await this.#reconcile(entry);
    }
    const now = this.#now();
    if (this.#foreground > 0 || now - this.#idleSince < this.#idleDelayMs) return;
    const characters = [...this.#entries.keys()];
    const after = this.#lastPicked === undefined ? -1 : characters.indexOf(this.#lastPicked);
    for (let step = 1; step <= characters.length; step += 1) {
      const name = required(characters[(after + step) % characters.length]);
      const entry = required(this.#entries.get(name));
      if (entry.embedder === undefined || now < entry.retryAt || now < entry.nextBatchAt) continue;
      this.#lastPicked = name;
      try {
        const embedded = await withHistoryIndexLock(entry.indexPath, async () => {
          const index = HistorySearchIndex.open({
            characterDataDir: entry.characterDataDir,
            character: entry.character,
            dbPath: entry.dbPath,
            path: entry.indexPath,
          });
          try {
            await index.reconcile();
            return await index.embedPending(required(entry.embedder));
          } finally {
            index.close();
          }
        });
        entry.failures = 0;
        entry.retryAt = 0;
        entry.lastError = undefined;
        entry.idleRounds = embedded > 0 ? 0 : entry.idleRounds + 1;
        entry.nextBatchAt = this.#now() + this.#pauseFor(entry.idleRounds);
      } catch (error) {
        entry.failures += 1;
        entry.lastError = describeError(error);
        entry.retryAt = now + Math.min(1_000 * 2 ** (entry.failures - 1), 60_000);
        shoreLog.warn(
          `shore: history embedding backfill failed for ${entry.character}; retrying later: ${entry.lastError}`,
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
          character: entry.character,
          dbPath: entry.dbPath,
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
      shoreLog.warn(`shore: history search index reconciliation failed for ${entry.character}: ${String(error)}`);
    }
  }
}
