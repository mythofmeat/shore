import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { shoreLog } from "../log.ts";

import { MessageStore } from "../engine/message_store.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

const ACTIVE_JSONL_FILE = "active.jsonl";
const CURSOR_FILE = "mem0_cursor.json";
const MESSAGE_CHARS = 4_000;

export interface Mem0IngestRegistration {
  character: string;
  characterDataDir: string;
  server: string;
}

export interface Mem0IngestServiceOptions {
  mcpRegistry?: Pick<McpRegistry, "call"> | undefined;
  now?: (() => number) | undefined;
  idleDelayMs?: number | undefined;
  batchSize?: number | undefined;
  timerIntervalMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
}

export interface Mem0IngestProgress {
  character: string;
  server: string;
  cursor: string | undefined;
  pending: boolean;
  failures: number;
  retryAt: number;
  lastError: string | undefined;
}

interface Entry extends Mem0IngestRegistration {
  dirty: boolean;
  cursor: string | undefined;
  loaded: boolean;
  failures: number;
  retryAt: number;
  lastError: string | undefined;
}

export class Mem0IngestService {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #idleDelayMs: number;
  readonly #batchSize: number;
  readonly #timerIntervalMs: number;
  readonly #maxRetryDelayMs: number;
  #mcpRegistry: Pick<McpRegistry, "call"> | undefined;
  #idleSince: number;
  #lastPicked: string | undefined;
  #foreground = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: Mem0IngestServiceOptions = {}) {
    this.#mcpRegistry = options.mcpRegistry;
    this.#now = options.now ?? (() => Date.now());
    this.#idleDelayMs = options.idleDelayMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 8;
    this.#timerIntervalMs = options.timerIntervalMs ?? 1_000;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.#idleSince = this.#now();
  }

  attachRegistry(registry: Pick<McpRegistry, "call">): void {
    this.#mcpRegistry = registry;
  }

  register(registration: Mem0IngestRegistration): void {
    const previous = this.#entries.get(registration.character);
    const moved = previous?.characterDataDir !== registration.characterDataDir;
    this.#entries.set(registration.character, {
      ...registration,
      dirty: previous === undefined ? true : previous.dirty || moved,
      cursor: moved ? undefined : previous?.cursor,
      loaded: moved ? false : previous?.loaded ?? false,
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

  progress(character: string): Mem0IngestProgress | undefined {
    const entry = this.#entries.get(character);
    if (entry === undefined) return undefined;
    return {
      character: entry.character,
      server: entry.server,
      cursor: entry.cursor,
      pending: entry.dirty,
      failures: entry.failures,
      retryAt: entry.retryAt,
      lastError: entry.lastError,
    };
  }

  noteMutation(character: string): void {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    entry.dirty = true;
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

  async start(): Promise<void> {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, this.#timerIntervalMs);
    this.#timer.unref?.();
  }

  async runOnce(): Promise<void> {
    if (this.#running !== undefined) {
      await this.#running;
      return;
    }
    this.#running = this.#runOnce().finally(() => {
      this.#running = undefined;
    });
    await this.#running;
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #runOnce(): Promise<void> {
    if (this.#closed || this.#mcpRegistry === undefined) return;
    const now = this.#now();
    if (this.#foreground > 0 || now - this.#idleSince < this.#idleDelayMs) return;

    for (const character of this.#roundRobin()) {
      const entry = this.#entries.get(character);
      if (entry === undefined || !entry.dirty || now < entry.retryAt) continue;
      this.#lastPicked = character;
      try {
        const sent = await this.#ingest(entry);
        entry.failures = 0;
        entry.retryAt = 0;
        entry.lastError = undefined;
        if (sent === 0) entry.dirty = false;
      } catch (error) {
        entry.failures += 1;
        entry.lastError = error instanceof Error ? error.message : String(error);
        entry.retryAt = now + Math.min(1000 * 2 ** (entry.failures - 1), this.#maxRetryDelayMs);
        shoreLog.warn(
          `shore: mem0 ingest for ${entry.character} failed, retrying: ${entry.lastError}`,
        );
      }
      return;
    }
  }

  #roundRobin(): string[] {
    const names = [...this.#entries.keys()];
    if (this.#lastPicked === undefined) return names;
    const at = names.indexOf(this.#lastPicked);
    return at < 0 ? names : [...names.slice(at + 1), ...names.slice(0, at + 1)];
  }

  async #ingest(entry: Entry): Promise<number> {
    if (!entry.loaded) {
      entry.cursor = await readCursor(entry.characterDataDir);
      entry.loaded = true;
    }

    const pending = (await activeMessages(entry.characterDataDir))
      .filter((message) => entry.cursor === undefined || message.timestamp > entry.cursor)
      .slice(0, this.#batchSize);
    if (pending.length === 0) return 0;

    const registry = this.#mcpRegistry;
    if (registry === undefined) return 0;
    await registry.call(`mcp__${entry.server}__add`, {
      messages: pending.map((message) => ({
        role: message.role,
        content: `[${message.timestamp.slice(0, 16)}] ${message.text.slice(0, MESSAGE_CHARS)}`,
      })),
      character: entry.character,
      metadata: { ts: pending[0]?.timestamp ?? "" },
    });

    const last = pending[pending.length - 1];
    if (last !== undefined) {
      entry.cursor = last.timestamp;
      await writeCursor(entry.characterDataDir, last.timestamp);
    }
    return pending.length;
  }
}

interface IngestMessage {
  role: string;
  text: string;
  timestamp: string;
}

async function activeMessages(characterDataDir: string): Promise<IngestMessage[]> {
  try {
    const { store } = await MessageStore.loadWithRaw(join(characterDataDir, ACTIVE_JSONL_FILE));
    return settledOnly(store.messages())
      .flatMap((message) => {
        const text = message.content.trim();
        if (text === "" || message.timestamp === undefined) return [];
        return [{ role: message.role, text, timestamp: message.timestamp }];
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

export function settledOnly<T extends { role: string }>(messages: readonly T[]): T[] {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  return lastUser < 0 ? [] : messages.slice(0, lastUser + 1);
}

async function readCursor(characterDataDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(characterDataDir, CURSOR_FILE), "utf8");
    const parsed = JSON.parse(raw) as { cursor?: unknown };
    return typeof parsed.cursor === "string" ? parsed.cursor : undefined;
  } catch {
    return undefined;
  }
}

async function writeCursor(characterDataDir: string, cursor: string): Promise<void> {
  await writeFile(join(characterDataDir, CURSOR_FILE), JSON.stringify({ cursor }), "utf8");
}
