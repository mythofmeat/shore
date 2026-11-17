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
  readonly wakesWithoutUser: number;
  readonly lastUserAt: number | undefined;
  readonly forcedDormant: boolean;
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
      ticks_without_user: state.wakesWithoutUser,
      last_user_at: state.lastUserAt === undefined ? null : toRfc3339(state.lastUserAt),
      forced_dormant: state.forcedDormant,
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

function parsedJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function decodeState(raw: string): AutonomyStateFile | undefined {
  const o = parsedJson(raw) as Record<string, unknown> | null | undefined;
  if (o?.["version"] !== STATE_VERSION) return undefined;

  const wakesWithoutUser = o["ticks_without_user"];
  if (typeof wakesWithoutUser !== "number") return undefined;

  return {
    wakesWithoutUser,
    lastUserAt: timeField(o["last_user_at"]),
    forcedDormant: o["forced_dormant"] === true,
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
