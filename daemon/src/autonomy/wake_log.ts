import { shoreLog } from "../log.ts";

import { dirname } from "node:path";
import { characterScope, insertEvent, readEvents, withStorage } from "../storage/store.ts";

export const WAKE_LOG_CAPACITY = 100;

export type WakeEventKind = import("../protocol/WakeEventKind.ts").WakeEventKind;

const KNOWN_KINDS = new Set<string>([
  "tick_fired",
  "call_failed",
  "message_sent",
  "message_skipped",
  "tool_use",
  "dormant",
  "wake",
  "timeout",
  "dormant_ping",
  "budget_paused",
  "recap_written",
  "recap_missing",
]);

export type WakeEvent = import("../protocol/WakeEvent.ts").WakeEvent;

export function encodeEvent(event: WakeEvent): string {
  return JSON.stringify({
    timestamp: event.timestamp,
    kind: event.kind,
    detail: event.detail,
  });
}

export function decodeEvent(line: string): WakeEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;

  const { timestamp, kind, detail } = parsed as Record<string, unknown>;
  if (typeof timestamp !== "string" || typeof detail !== "string") return undefined;
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) return undefined;

  return { timestamp, kind: kind as WakeEventKind, detail };
}

export class WakeLog {
  #events: WakeEvent[] = [];
  #dirty = false;
  #pending: WakeEvent[] = [];
  readonly #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
  }

  static async load(path: string): Promise<WakeLog> {
    const log = new WakeLog(path);
    const { data, character } = characterScope(dirname(path));
    for (const line of readEvents(data, character, "wake", WAKE_LOG_CAPACITY)) {
      const event = decodeEvent(line);
      if (event !== undefined) log.#append(event);
    }
    return log;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  push(kind: WakeEventKind, detail: string, timestamp: string): void {
    const event = { timestamp, kind, detail };
    this.#append(event);
    this.#pending.push(event);
    this.#dirty = true;
  }

  #append(event: WakeEvent): void {
    if (this.#events.length >= WAKE_LOG_CAPACITY) this.#events.shift();
    this.#events.push(event);
  }

  recent(limit: number): WakeEvent[] {
    if (this.#path !== undefined && limit > this.#events.length) {
      const { data, character } = characterScope(dirname(this.#path));
      try {
        const stored = readEvents(data, character, "wake", limit).flatMap((line) => {
          const event = decodeEvent(line);
          return event === undefined ? [] : [event];
        });
        return [...stored, ...this.#pending].slice(-limit);
      } catch (error) {
        shoreLog.error(`shore: failed to read retained wake events: ${String(error)}`);
      }
    }
    return this.#events.slice(Math.max(this.#events.length - limit, 0));
  }

  encode(): string {
    return this.#events.map((e) => `${encodeEvent(e)}\n`).join("");
  }

  async flushIfDirty(): Promise<void> {
    if (!this.#dirty) return;
    const path = this.#path;
    if (path === undefined) {
      this.#dirty = false;
      this.#pending = [];
      return;
    }

    try {
      const { data, character } = characterScope(dirname(path));
      withStorage(data, (db) => db.transaction(() => {
        for (const event of this.#pending) insertEvent(db, { character, kind: "wake", timestamp: event.timestamp, content: encodeEvent(event) });
      })());
    } catch (err) {
      shoreLog.error(`shore: failed to flush the wake log at ${path}: ${String(err)}`);
      return;
    }
    this.#dirty = false;
    this.#pending = [];
  }
}
