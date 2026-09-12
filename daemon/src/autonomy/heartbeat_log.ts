import { shoreLog } from "../log.ts";

import { basename, dirname } from "node:path";
import { characterScope, importLegacyLog, insertEvent, readEvents, withStorage } from "../storage/store.ts";

export const HEARTBEAT_LOG_CAPACITY = 100;

export type HeartbeatEventKind = import("../protocol/HeartbeatEventKind.ts").HeartbeatEventKind;

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

export type HeartbeatEvent = import("../protocol/HeartbeatEvent.ts").HeartbeatEvent;

export function encodeEvent(event: HeartbeatEvent): string {
  return JSON.stringify({
    timestamp: event.timestamp,
    kind: event.kind,
    detail: event.detail,
  });
}

export function decodeEvent(line: string): HeartbeatEvent | undefined {
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

  return { timestamp, kind: kind as HeartbeatEventKind, detail };
}

export class HeartbeatLog {
  #events: HeartbeatEvent[] = [];
  #dirty = false;
  #pending: HeartbeatEvent[] = [];
  readonly #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
  }

  static async load(path: string): Promise<HeartbeatLog> {
    const log = new HeartbeatLog(path);
    const { data, character } = characterScope(dirname(path));
    await importLegacyLog(data, `${character}/${basename(path)}`, (line) => {
      const event = decodeEvent(line);
      return { character, kind: event === undefined ? "legacy_invalid" : "heartbeat", timestamp: event?.timestamp ?? "", content: line };
    });
    for (const line of readEvents(data, character, "heartbeat", HEARTBEAT_LOG_CAPACITY)) {
      const event = decodeEvent(line);
      if (event !== undefined) log.#append(event);
    }
    return log;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  push(kind: HeartbeatEventKind, detail: string, timestamp: string): void {
    const event = { timestamp, kind, detail };
    this.#append(event);
    this.#pending.push(event);
    this.#dirty = true;
  }

  #append(event: HeartbeatEvent): void {
    if (this.#events.length >= HEARTBEAT_LOG_CAPACITY) this.#events.shift();
    this.#events.push(event);
  }

  recent(limit: number): HeartbeatEvent[] {
    if (this.#path !== undefined && limit > this.#events.length) {
      const { data, character } = characterScope(dirname(this.#path));
      try {
        const stored = readEvents(data, character, "heartbeat", limit).flatMap((line) => {
          const event = decodeEvent(line);
          return event === undefined ? [] : [event];
        });
        return [...stored, ...this.#pending].slice(-limit);
      } catch (error) {
        shoreLog.error(`shore: failed to read retained heartbeat history: ${String(error)}`);
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
        for (const event of this.#pending) insertEvent(db, { character, kind: "heartbeat", timestamp: event.timestamp, content: encodeEvent(event) });
      })());
    } catch (err) {
      shoreLog.error(`shore: failed to flush heartbeat log at ${path}: ${String(err)}`);
      return;
    }
    this.#dirty = false;
    this.#pending = [];
  }
}
