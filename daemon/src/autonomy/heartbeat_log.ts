import { shoreLog } from "../log.ts";

import { rename } from "node:fs/promises";

export const HEARTBEAT_LOG_CAPACITY = 100;

export type HeartbeatEventKind =
  | "tick_fired"
  | "call_failed"
  | "message_sent"
  | "message_skipped"
  | "tool_use"
  | "dormant"
  | "wake"
  | "timeout"
  | "dormant_ping"
  | "budget_paused"
  | "recap_written"
  | "recap_missing";

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

export interface HeartbeatEvent {
  readonly timestamp: string;
  readonly kind: HeartbeatEventKind;
  readonly detail: string;
}

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
  readonly #path: string | undefined;

  constructor(path?: string) {
    this.#path = path;
  }

  static async load(path: string): Promise<HeartbeatLog> {
    const log = new HeartbeatLog(path);
    let data: string;
    try {
      data = await Bun.file(path).text();
    } catch {
      return log;
    }

    for (const line of data.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const event = decodeEvent(trimmed);
      if (event === undefined) continue;
      log.#append(event);
    }
    return log;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  push(kind: HeartbeatEventKind, detail: string, timestamp: string): void {
    this.#append({ timestamp, kind, detail });
    this.#dirty = true;
  }

  #append(event: HeartbeatEvent): void {
    if (this.#events.length >= HEARTBEAT_LOG_CAPACITY) this.#events.shift();
    this.#events.push(event);
  }

  recent(limit: number): HeartbeatEvent[] {
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
      return;
    }

    const tmp = `${path}.tmp`;
    try {
      await Bun.write(tmp, this.encode());
      await rename(tmp, path);
    } catch (err) {
      shoreLog.error(`shore: failed to flush heartbeat log at ${path}: ${String(err)}`);
      return;
    }
    this.#dirty = false;
  }
}
