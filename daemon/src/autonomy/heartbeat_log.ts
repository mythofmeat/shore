/**
 * The heartbeat event log — a bounded ring, persisted as JSONL.
 *
 * What `shore log --heartbeat` shows: the last hundred things autonomy did for
 * a character. It is a record for a person to read, not state anything depends
 * on, so it is written whole on each flush and losing a line costs nothing.
 *
 * Ported from `crates/daemon/src/autonomy/mod.rs` and pinned against it by
 * `tests/heartbeat_log_parity.test.ts`.
 *
 * ## The wire format is load-bearing
 *
 * The Rust spells its event kinds `snake_case` on the wire and `PascalCase` in
 * source, so the two can drift apart with nothing to notice. The CLI reading
 * this file skips any line it cannot parse — so a kind spelled wrong here does
 * not produce an error, it produces a log with entries missing. The fixture
 * pins every kind's exact bytes for that reason.
 *
 * Writes go through a temporary file and a rename, so a reader never sees a
 * half-written log. That matters more here than the content does: the Rust CLI
 * reads this file while the daemon is running.
 */

import { rename } from "node:fs/promises";

/** How many events are kept. Older ones fall off the front. */
export const HEARTBEAT_LOG_CAPACITY = 100;

/** The kinds of thing worth recording, exactly as they appear on the wire. */
export type HeartbeatEventKind =
  /** A heartbeat tick fired. */
  | "tick_fired"
  /** The character generated a message and sent it. */
  | "message_sent"
  /** The character woke, considered it, and chose not to speak. */
  | "message_skipped"
  /** A tool was used during a tick. */
  | "tool_use"
  /** The abandonment guard tripped. */
  | "dormant"
  /** The user came back. */
  | "wake"
  /** A tick was killed by the timeout guard. */
  | "timeout"
  /** A bare ping sent to keep the provider's cache warm. */
  | "dormant_ping"
  /** A tick was skipped before it spent anything, by `[usage]`. */
  | "budget_paused"
  /** Retained so older logs still parse. */
  | "recap_written"
  /** Retained so older logs still parse. */
  | "recap_missing";

const KNOWN_KINDS = new Set<string>([
  "tick_fired",
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

/** One recorded event. The field order is the order it is written in. */
export interface HeartbeatEvent {
  /** RFC3339, local offset — what the Rust's `chrono::Local` produced. */
  readonly timestamp: string;
  readonly kind: HeartbeatEventKind;
  readonly detail: string;
}

/** Serialize one event to its JSONL line, field order and all. */
export function encodeEvent(event: HeartbeatEvent): string {
  // Built explicitly rather than by spreading: the Rust writes timestamp,
  // kind, detail in that order, and a reader diffing the two files should see
  // nothing. JSON.stringify follows insertion order, so this is the order.
  return JSON.stringify({
    timestamp: event.timestamp,
    kind: event.kind,
    detail: event.detail,
  });
}

/**
 * Parse one JSONL line, or `undefined` if it is not an event.
 *
 * Unparseable lines are dropped rather than thrown on, matching the Rust: a
 * log is a record, and one corrupt line should not cost the other ninety-nine.
 */
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

  /** Bind to a file, or pass nothing for a log that never touches disk. */
  constructor(path?: string) {
    this.#path = path;
  }

  /**
   * Read a log back from disk.
   *
   * A missing or unreadable file gives an empty log bound to the path, which
   * is the first-run case and not an error. The loaded log is clean: it
   * already matches disk, and flushing it would rewrite what is there.
   */
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
      // Every file ends with one, so this is the common case rather than a
      // guard against corruption; `decodeEvent` would reject it either way.
      if (trimmed === "") continue;
      const event = decodeEvent(trimmed);
      if (event === undefined) continue;
      log.#append(event);
    }
    // Deliberately still clean: `#append` does not dirty, only `push` does.
    return log;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  /** Record an event. Memory only — nothing reaches disk until a flush. */
  push(kind: HeartbeatEventKind, detail: string, timestamp: string): void {
    this.#append({ timestamp, kind, detail });
    this.#dirty = true;
  }

  #append(event: HeartbeatEvent): void {
    if (this.#events.length >= HEARTBEAT_LOG_CAPACITY) this.#events.shift();
    this.#events.push(event);
  }

  /**
   * The most recent `limit` events, still oldest first.
   *
   * The window is taken from the end but not reversed: `shore log` prints
   * these in the order they happened, and the limit is about how far back to
   * go, not which end to read from.
   */
  recent(limit: number): HeartbeatEvent[] {
    return this.#events.slice(Math.max(this.#events.length - limit, 0));
  }

  /** The whole ring as JSONL, trailing newline included. */
  encode(): string {
    return this.#events.map((e) => `${encodeEvent(e)}\n`).join("");
  }

  /**
   * Rewrite the file from the ring, if anything has changed.
   *
   * Whole-file, not append: the ring drops its oldest events and the file has
   * to drop them too. An unwritable path clears nothing — the events stay
   * dirty and the next flush tries again.
   */
  async flushIfDirty(): Promise<void> {
    if (!this.#dirty) return;
    const path = this.#path;
    if (path === undefined) {
      this.#dirty = false;
      return;
    }

    // `heartbeat.jsonl` -> `heartbeat.jsonl.tmp`, matching the Rust's
    // `with_extension("jsonl.tmp")` for this filename. Beside the target, so
    // the rename stays within one filesystem and is therefore atomic.
    const tmp = `${path}.tmp`;
    try {
      await Bun.write(tmp, this.encode());
      await rename(tmp, path);
    } catch (err) {
      console.error(`shore: failed to flush heartbeat log at ${path}: ${String(err)}`);
      return;
    }
    this.#dirty = false;
  }
}
