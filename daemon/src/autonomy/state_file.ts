/**
 * `autonomy_state.json` — what a character remembers across a restart.
 *
 * Small and deliberately so: the heartbeat's deadline and idle count, how much
 * of the conversation memory already covers, and the keepalive schedule. Not a
 * database. Everything else about a tick is recomputed from scratch.
 *
 * Ported from `crates/daemon/src/autonomy/manager.rs` and pinned against it by
 * `tests/autonomy_state_parity.test.ts`.
 *
 * ## Why the shape is load-bearing
 *
 * This file is already on users' disks, and every field on the Rust side is
 * `#[serde(default)]`. A name that changes on one side does not fail to
 * parse — it reads as absent. Absent means the keepalive stays unarmed and the
 * heartbeat forgets its deadline, which is the *fail-safe* direction and
 * exactly why it would go unnoticed: the daemon starts, nothing errors, and the
 * user pays one cold cache write and one missed wake. So the fixture pins the
 * bytes, and {@link decodeState} refuses a file it does not fully understand
 * rather than filling in blanks.
 *
 * ## Times
 *
 * RFC3339 strings on disk, epoch milliseconds in memory. The Rust held these as
 * monotonic `Instant`s and converted through the delta from `Utc::now()` on
 * every save and load — an approximation that drifted a little each restart,
 * and disagreed with itself across a suspend. Wall clock throughout makes the
 * conversion exact, which is the same correction the heartbeat clock's port
 * made for the same reason.
 */

/** Bumped when the shape changes incompatibly; older files are ignored. */
export const STATE_VERSION = 4;

export const STATE_FILENAME = "autonomy_state.json";

/** The keepalive schedule, as it survives a restart. */
export interface PersistedKeepalive {
  readonly model: string;
  /** Cadence in milliseconds. */
  readonly intervalMs: number;
  /** When the prefix was last proven warm, epoch ms. */
  readonly lastWarmAt: number;
  /** When the character last did anything, epoch ms. */
  readonly lastActiveAt: number;
}

/** Everything that survives a restart. */
export interface AutonomyStateFile {
  readonly ticksWithoutUser: number;
  /** Epoch ms, or `undefined` when no wake is scheduled. */
  readonly nextWakeAt: number | undefined;
  /** Epoch ms of the last user message, or `undefined` if there has been none. */
  readonly lastUserAt: number | undefined;
  readonly coveredTurnCount: number;
  /**
   * All-or-nothing. Any missing or unparseable field leaves this `undefined`
   * and the keepalive stays down, which fails safe: arming from a wrong anchor
   * would ping a cache that has already gone cold, at 20× the price of a read.
   */
  readonly keepalive: PersistedKeepalive | undefined;
}

/** Epoch ms to the RFC3339 spelling the Rust writes. */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** RFC3339 back to epoch ms, or `undefined` if it is not a time. */
export function fromRfc3339(s: string): number | undefined {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Render the file exactly as the daemon writes it: pretty-printed, two-space
 * indent, absent values spelled `null` rather than omitted, and no trailing
 * newline.
 */
export function encodeState(state: AutonomyStateFile): string {
  const k = state.keepalive;
  return JSON.stringify(
    {
      version: STATE_VERSION,
      ticks_without_user: state.ticksWithoutUser,
      next_wake_at: state.nextWakeAt === undefined ? null : toRfc3339(state.nextWakeAt),
      last_user_at: state.lastUserAt === undefined ? null : toRfc3339(state.lastUserAt),
      covered_turn_count: state.coveredTurnCount,
      keepalive_model: k?.model ?? null,
      keepalive_interval_ms: k?.intervalMs ?? null,
      keepalive_last_warm_at: k === undefined ? null : toRfc3339(k.lastWarmAt),
      keepalive_last_active_at: k === undefined ? null : toRfc3339(k.lastActiveAt),
    },
    null,
    2,
  );
}

/**
 * Parse a state file, or `undefined` if it cannot be trusted.
 *
 * Unreadable JSON, a version that is not this one, or a field of the wrong
 * type all give `undefined` — the character starts from defaults. That is a
 * missed wake and a cold cache, once, which beats restoring a deadline from a
 * file written by a version that meant something different by it.
 */
export function decodeState(raw: string): AutonomyStateFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const o = parsed as Record<string, unknown>;
  if (o["version"] !== STATE_VERSION) return undefined;

  const ticksWithoutUser = o["ticks_without_user"];
  if (typeof ticksWithoutUser !== "number") return undefined;

  const coveredTurnCount = o["covered_turn_count"];

  return {
    ticksWithoutUser,
    nextWakeAt: timeField(o["next_wake_at"]),
    lastUserAt: timeField(o["last_user_at"]),
    // Added after v4 shipped on the Rust side as `serde(default)`, so a file
    // without it is legitimate and reads as zero — which fails safe, since it
    // means the deep archive runs a pass rather than trusting stale coverage.
    coveredTurnCount: typeof coveredTurnCount === "number" ? coveredTurnCount : 0,
    keepalive: keepaliveField(o),
  };
}

function timeField(value: unknown): number | undefined {
  return typeof value === "string" ? fromRfc3339(value) : undefined;
}

function keepaliveField(o: Record<string, unknown>): PersistedKeepalive | undefined {
  const model = o["keepalive_model"];
  const intervalMs = o["keepalive_interval_ms"];
  const lastWarmAt = timeField(o["keepalive_last_warm_at"]);
  const lastActiveAt = timeField(o["keepalive_last_active_at"]);

  if (typeof model !== "string" || typeof intervalMs !== "number") return undefined;
  if (lastWarmAt === undefined || lastActiveAt === undefined) return undefined;

  return { model, intervalMs, lastWarmAt, lastActiveAt };
}

/** Read a character's state, or `undefined` if there is none to trust. */
export async function loadState(path: string): Promise<AutonomyStateFile | undefined> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return undefined; // No file yet: the first-run case, not an error.
  }
  return decodeState(raw);
}

/**
 * Write a character's state.
 *
 * Returns whether it landed, so the caller can keep its dirty flag set and try
 * again rather than believing a write that never happened.
 */
export async function saveState(path: string, state: AutonomyStateFile): Promise<boolean> {
  try {
    await Bun.write(path, encodeState(state));
    return true;
  } catch (err) {
    console.error(`shore: failed to save autonomy state at ${path}: ${String(err)}`);
    return false;
  }
}
