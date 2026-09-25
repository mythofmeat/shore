import { basename, dirname } from "node:path";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import { shoreLog } from "../log.ts";

export const STATE_VERSION = 4;

export const STATE_FILENAME = "autonomy_state.json";

export interface PersistedKeepalive {
  readonly model: string;
  readonly identity?: string;
  readonly intervalMs: number;
  readonly lastWarmAt: number;
  readonly lastActiveAt: number;
  readonly pingsSent?: number;
  readonly maxPings?: number;
}

export interface AutonomyStateFile {
  readonly ticksWithoutUser: number;
  readonly nextWakeAt: number | undefined;
  readonly lastUserAt: number | undefined;
  readonly forcedDormant?: boolean;
  readonly defaultWake?: boolean;
  readonly wakeAnchorAt?: number;
  readonly coveredTurnCount: number;
  readonly keepalive: PersistedKeepalive | undefined;
}

export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function fromRfc3339(s: string): number | undefined {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

export function encodeState(state: AutonomyStateFile): string {
  const k = state.keepalive;
  return JSON.stringify(
    {
      version: STATE_VERSION,
      ticks_without_user: state.ticksWithoutUser,
      next_wake_at: state.nextWakeAt === undefined ? null : toRfc3339(state.nextWakeAt),
      last_user_at: state.lastUserAt === undefined ? null : toRfc3339(state.lastUserAt),
      forced_dormant: state.forcedDormant === true,
      default_wake: state.defaultWake === true,
      wake_anchor_at: state.wakeAnchorAt === undefined ? null : toRfc3339(state.wakeAnchorAt),
      covered_turn_count: state.coveredTurnCount,
      keepalive_model: k?.model ?? null,
      keepalive_identity: k?.identity ?? null,
      keepalive_interval_ms: k?.intervalMs ?? null,
      keepalive_last_warm_at: k === undefined ? null : toRfc3339(k.lastWarmAt),
      keepalive_last_active_at: k === undefined ? null : toRfc3339(k.lastActiveAt),
      keepalive_pings_sent: k?.pingsSent ?? null,
      keepalive_max_pings: k?.maxPings ?? null,
    },
    null,
    2,
  );
}

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
    ...wakeProvenance(o),
    coveredTurnCount: typeof coveredTurnCount === "number" ? coveredTurnCount : 0,
    keepalive: keepaliveField(o),
  };
}

function wakeProvenance(o: Record<string, unknown>): Pick<AutonomyStateFile, "forcedDormant" | "defaultWake" | "wakeAnchorAt"> {
  const wakeAnchorAt = timeField(o["wake_anchor_at"]);
  return {
    ...(o["forced_dormant"] === true ? { forcedDormant: true } : {}),
    ...(o["default_wake"] === true ? { defaultWake: true } : {}),
    ...(wakeAnchorAt === undefined ? {} : { wakeAnchorAt }),
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

  const identity = o["keepalive_identity"];
  const pingsSent = o["keepalive_pings_sent"];
  const maxPings = o["keepalive_max_pings"];
  return {
    model, intervalMs, lastWarmAt, lastActiveAt,
    ...(typeof identity === "string" ? { identity } : {}),
    ...(typeof pingsSent === "number" ? { pingsSent } : {}),
    ...(typeof maxPings === "number" ? { maxPings } : {}),
  };
}

export async function loadState(path: string): Promise<AutonomyStateFile | undefined> {
  let raw: string;
  try {
    const stored = readCharacterState(dirname(path), basename(path));
    if (stored === undefined) return undefined;
    raw = stored;
  } catch {
    return undefined;
  }
  return decodeState(raw);
}

export async function saveState(path: string, state: AutonomyStateFile): Promise<boolean> {
  try {
    writeCharacterState(dirname(path), basename(path), encodeState(state));
    return true;
  } catch (err) {
    shoreLog.error(`shore: failed to save autonomy state at ${path}: ${String(err)}`);
    return false;
  }
}
