import { describeError } from "../llm/errors";
import { shoreLog } from "../log.ts";

import { refreshHistoryIndex, withHistoryIndexLock } from "./history_index.ts";

export interface HistoryIndexRegistration {
  character: string;
  conversationDir: string;
  dbPath: string;
  indexPath: string;
}

export interface HistoryIndexServiceOptions {
  now?: () => number;
  timerIntervalMs?: number;
}

export interface HistoryIndexProgress extends HistoryIndexRegistration {
  failures: number;
  retryAt: number;
  lastError: string | undefined;
}

interface Entry extends HistoryIndexProgress {
  dirty: boolean;
}

export class HistoryIndexService {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #timerIntervalMs: number;
  #foreground = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: HistoryIndexServiceOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#timerIntervalMs = options.timerIntervalMs ?? 1_000;
  }

  register(registration: HistoryIndexRegistration): void {
    const previous = this.#entries.get(registration.character);
    const moved = previous?.conversationDir !== registration.conversationDir || previous.indexPath !== registration.indexPath ||
      previous.dbPath !== registration.dbPath;
    this.#entries.set(registration.character, {
      ...registration,
      dirty: moved || (previous?.dirty ?? true),
      failures: moved ? 0 : previous?.failures ?? 0,
      retryAt: moved ? 0 : previous?.retryAt ?? 0,
      lastError: moved ? undefined : previous?.lastError,
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
      conversationDir: entry.conversationDir,
      dbPath: entry.dbPath,
      indexPath: entry.indexPath,
      failures: entry.failures,
      retryAt: entry.retryAt,
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
    if (entry !== undefined) entry.dirty = true;
  }

  beginForeground(): () => void {
    this.#foreground += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#foreground = Math.max(0, this.#foreground - 1);
    };
  }

  async reconcileAll(): Promise<void> {
    for (const entry of this.#entries.values()) await this.#rebuild(entry);
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
    if (this.#foreground > 0) return;
    for (const entry of this.#entries.values()) {
      if (entry.dirty && this.#now() >= entry.retryAt) await this.#rebuild(entry);
    }
  }

  async #rebuild(entry: Entry): Promise<void> {
    entry.dirty = false;
    try {
      await withHistoryIndexLock(entry.indexPath, async () => {
        await refreshHistoryIndex(
          { character: entry.character, dbPath: entry.dbPath, mainConversationDir: entry.conversationDir },
          entry.indexPath,
        );
      });
      entry.failures = 0;
      entry.retryAt = 0;
      entry.lastError = undefined;
    } catch (error) {
      entry.dirty = true;
      entry.failures += 1;
      entry.lastError = describeError(error);
      entry.retryAt = this.#now() + Math.min(1_000 * 2 ** (entry.failures - 1), 60_000);
      shoreLog.warn(`shore: chat log index rebuild failed for ${entry.character}; retrying later: ${entry.lastError}`);
    }
  }
}
