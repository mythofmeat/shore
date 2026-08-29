import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { shoreLog } from "../log.ts";

import { HistoryStore } from "../engine/history_store.ts";
import { deriveContentFromBlocks } from "../engine/message_store.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

const CURSOR_FILE = "mem0_cursor.json";
const MESSAGE_CHARS = 4_000;

export interface Mem0Cursor {
  segment: number;
  ordinal: number;
}

export interface Mem0IngestRegistration {
  character: string;
  characterDataDir: string;
  historyDbPath: string;
  server: string;
}

export interface Mem0IngestServiceOptions {
  mcpRegistry?: Pick<McpRegistry, "call"> | undefined;
  now?: (() => number) | undefined;
  idleDelayMs?: number | undefined;
  batchSize?: number | undefined;
  timerIntervalMs?: number | undefined;
  pollPauseMs?: number | undefined;
  maxPollPauseMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
}

export interface Mem0IngestProgress {
  character: string;
  server: string;
  cursor: Mem0Cursor | undefined;
  pending: boolean;
  failures: number;
  retryAt: number;
  nextPollAt: number;
  lastError: string | undefined;
}

interface Entry extends Mem0IngestRegistration {
  cursor: Mem0Cursor | undefined;
  loaded: boolean;
  idleRounds: number;
  nextPollAt: number;
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
  readonly #pollPauseMs: number;
  readonly #maxPollPauseMs: number;
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
    this.#pollPauseMs = options.pollPauseMs ?? 1_000;
    this.#maxPollPauseMs = options.maxPollPauseMs ?? 5 * 60_000;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.#idleSince = this.#now();
  }

  attachRegistry(registry: Pick<McpRegistry, "call">): void {
    this.#mcpRegistry = registry;
  }

  register(registration: Mem0IngestRegistration): void {
    const previous = this.#entries.get(registration.character);
    const moved =
      previous?.characterDataDir !== registration.characterDataDir ||
      previous?.historyDbPath !== registration.historyDbPath;
    this.#entries.set(registration.character, {
      ...registration,
      cursor: moved ? undefined : previous?.cursor,
      loaded: moved ? false : previous?.loaded ?? false,
      idleRounds: moved ? 0 : previous?.idleRounds ?? 0,
      nextPollAt: moved ? 0 : previous?.nextPollAt ?? 0,
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
      pending: entry.idleRounds === 0,
      failures: entry.failures,
      retryAt: entry.retryAt,
      nextPollAt: entry.nextPollAt,
      lastError: entry.lastError,
    };
  }

  noteMutation(character: string): void {
    const entry = this.#entries.get(character);
    if (entry === undefined) return;
    entry.idleRounds = 0;
    entry.nextPollAt = 0;
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
      if (entry === undefined || now < entry.retryAt || now < entry.nextPollAt) continue;
      this.#lastPicked = character;
      try {
        const sent = await this.#ingest(entry);
        entry.failures = 0;
        entry.retryAt = 0;
        entry.lastError = undefined;
        entry.idleRounds = sent > 0 ? 0 : entry.idleRounds + 1;
        entry.nextPollAt = this.#now() + this.#pauseFor(entry.idleRounds);
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

  #pauseFor(idleRounds: number): number {
    if (idleRounds === 0) return this.#pollPauseMs;
    const grown = this.#pollPauseMs * 2 ** Math.min(idleRounds, 20);
    return Math.min(grown, this.#maxPollPauseMs);
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

    const batch = nextBatch(entry.historyDbPath, entry.character, entry.cursor, this.#batchSize);
    if (batch === undefined) return 0;

    const registry = this.#mcpRegistry;
    if (registry === undefined) return 0;
    await registry.call(`mcp__${entry.server}__add`, {
      messages: batch.messages.map((message) => ({
        role: message.role,
        content: `[${message.timestamp.slice(0, 16)}] ${message.text.slice(0, MESSAGE_CHARS)}`,
      })),
      character: entry.character,
      metadata: {
        ts: batch.messages[0]?.timestamp ?? "",
        segment: batch.cursor.segment,
      },
    });

    entry.cursor = batch.cursor;
    await writeCursor(entry.characterDataDir, batch.cursor);
    return batch.messages.length;
  }
}

interface IngestMessage {
  role: string;
  text: string;
  timestamp: string;
}

interface IngestBatch {
  messages: IngestMessage[];
  cursor: Mem0Cursor;
}

function nextBatch(
  historyDbPath: string,
  character: string,
  cursor: Mem0Cursor | undefined,
  limit: number,
): IngestBatch | undefined {
  let store: HistoryStore;
  try {
    store = HistoryStore.open(historyDbPath);
  } catch {
    return undefined;
  }
  try {
    for (const record of store.entries(character)) {
      if (record.excluded === true || record.message_count === 0) continue;
      if (cursor !== undefined && record.idx < cursor.segment) continue;
      const after = cursor !== undefined && record.idx === cursor.segment ? cursor.ordinal : -1;

      const messages: IngestMessage[] = [];
      let ordinal = after;
      const archived = store.readSegment(character, record.idx);
      for (let at = after + 1; at < archived.length && messages.length < limit; at += 1) {
        const message = archived[at];
        if (message === undefined || message.timestamp === undefined) continue;
        const text = deriveContentFromBlocks(message.content_blocks, false).trim();
        if (text === "") continue;
        messages.push({ role: message.role, text, timestamp: message.timestamp });
        ordinal = at;
      }
      if (messages.length > 0) return { messages, cursor: { segment: record.idx, ordinal } };
    }
    return undefined;
  } finally {
    store.close();
  }
}

async function readCursor(characterDataDir: string): Promise<Mem0Cursor | undefined> {
  try {
    const raw = await readFile(join(characterDataDir, CURSOR_FILE), "utf8");
    const parsed = JSON.parse(raw) as { segment?: unknown; ordinal?: unknown };
    if (typeof parsed.segment !== "number" || typeof parsed.ordinal !== "number") return undefined;
    return { segment: parsed.segment, ordinal: parsed.ordinal };
  } catch {
    return undefined;
  }
}

async function writeCursor(characterDataDir: string, cursor: Mem0Cursor): Promise<void> {
  await writeFile(join(characterDataDir, CURSOR_FILE), JSON.stringify(cursor), "utf8");
}
