import { shoreLog } from "../log.ts";

import type { Embedder } from "../llm/embed.ts";
import { indexPendingBatch, type RetrievalConfig } from "./workspace_index.ts";

export interface WorkspaceIndexRegistration {
  character: string;
  workspaceDir: string;
  indexPath: string;
  retrievalConfig: RetrievalConfig;
  embedder?: Embedder;
  embedderError?: string;
}

export interface WorkspaceIndexServiceOptions {
  now?: () => number;
  idleDelayMs?: number;
  batchPauseMs?: number;
  timerIntervalMs?: number;
  maxBatchItems?: number;
}

export interface WorkspaceIndexProgress {
  character: string;
  pending: number;
  files: number;
  failures: number;
  retryAt: number;
  lastError: string | undefined;
  sweptAt: number | undefined;
  embedderError: string | undefined;
}

interface Entry extends WorkspaceIndexRegistration {
  retryAt: number;
  failures: number;
  nextBatchAt: number;
  pending: number;
  files: number;
  lastError: string | undefined;
  sweptAt: number | undefined;
}

export class WorkspaceIndexService {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #idleDelayMs: number;
  readonly #batchPauseMs: number;
  readonly #timerIntervalMs: number;
  readonly #maxBatchItems: number | undefined;
  #idleSince: number;
  #lastPicked: string | undefined;
  #foreground = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: WorkspaceIndexServiceOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#idleDelayMs = options.idleDelayMs ?? 30_000;
    this.#batchPauseMs = options.batchPauseMs ?? 1_000;
    this.#timerIntervalMs = options.timerIntervalMs ?? 1_000;
    this.#maxBatchItems = options.maxBatchItems;
    this.#idleSince = this.#now();
  }

  register(registration: WorkspaceIndexRegistration): void {
    const previous = this.#entries.get(registration.character);
    const identityChanged =
      previous?.embedder?.identity !== registration.embedder?.identity ||
      previous?.embedder?.modelId !== registration.embedder?.modelId ||
      previous?.embedder?.dimensions !== registration.embedder?.dimensions;
    this.#entries.set(registration.character, {
      ...registration,
      retryAt: identityChanged ? 0 : (previous?.retryAt ?? 0),
      failures: identityChanged ? 0 : (previous?.failures ?? 0),
      nextBatchAt: previous?.nextBatchAt ?? 0,
      pending: previous?.pending ?? 0,
      files: previous?.files ?? 0,
      lastError: identityChanged ? undefined : previous?.lastError,
      sweptAt: previous?.sweptAt,
    });
  }

  unregister(character: string): void {
    this.#entries.delete(character);
  }

  registeredCharacters(): string[] {
    return [...this.#entries.keys()];
  }

  progress(character: string): WorkspaceIndexProgress | undefined {
    const entry = this.#entries.get(character);
    if (entry === undefined) return undefined;
    return {
      character,
      pending: entry.pending,
      files: entry.files,
      failures: entry.failures,
      retryAt: entry.retryAt,
      lastError: entry.lastError,
      sweptAt: entry.sweptAt,
      embedderError: entry.embedderError,
    };
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, this.#timerIntervalMs);
    this.#timer.unref?.();
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
    const now = this.#now();
    if (this.#foreground > 0 || now - this.#idleSince < this.#idleDelayMs) return;

    const characters = [...this.#entries.keys()];
    const after = this.#lastPicked === undefined ? -1 : characters.indexOf(this.#lastPicked);
    for (let step = 1; step <= characters.length; step += 1) {
      const name = characters[(after + step) % characters.length]!;
      const entry = this.#entries.get(name)!;
      if (entry.embedder === undefined || now < entry.retryAt || now < entry.nextBatchAt) continue;
      this.#lastPicked = name;
      try {
        const outcome = await indexPendingBatch({
          workspaceDir: entry.workspaceDir,
          retrievalConfig: entry.retrievalConfig,
          embedder: entry.embedder,
          indexPath: entry.indexPath,
          ...(this.#maxBatchItems === undefined ? {} : { maxBatchItems: this.#maxBatchItems }),
        });
        entry.failures = 0;
        entry.retryAt = 0;
        entry.lastError = undefined;
        entry.pending = outcome.pending;
        entry.files = outcome.files;
        entry.sweptAt = this.#now();
        entry.nextBatchAt = this.#now() + this.#batchPauseMs;
      } catch (error) {
        entry.failures += 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        entry.retryAt = this.#now() + Math.min(1_000 * 2 ** (entry.failures - 1), 60_000);
        shoreLog.warn(
          `shore: workspace embedding backfill failed for ${entry.character}; retrying later: ${entry.lastError}`,
        );
      }
      break;
    }
  }
}
