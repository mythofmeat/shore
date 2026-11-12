import { basename, dirname } from "node:path";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import { shoreLog } from "../log.ts";
import type { AskedWake } from "./own_time.ts";

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

export interface PersistedDream {
  readonly lastAt?: number;
  readonly turnsSince: number;
  readonly retryAt?: number;
  readonly failures: number;
  readonly forced: boolean;
}

export const NO_DREAM: PersistedDream = { turnsSince: 0, failures: 0, forced: false };

export interface AutonomyStateFile {
  readonly wakesWithoutUser: number;
  readonly lastUserAt: number | undefined;
  readonly forcedDormant: boolean;
  readonly asked: AskedWake | undefined;
  readonly lastHeartbeatAt: number | undefined;
  readonly notBefore: number | undefined;
  readonly coveredTurnCount: number;
  readonly keepalive: PersistedKeepalive | undefined;
  readonly dream?: PersistedDream;
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
      next_wake_at: state.asked === undefined ? null : toRfc3339(state.asked.at),
      last_user_at: state.lastUserAt === undefined ? null : toRfc3339(state.lastUserAt),
      forced_dormant: state.forcedDormant,
      wake_anchor_at: state.lastHeartbeatAt === undefined ? null : toRfc3339(state.lastHeartbeatAt),
      wake_reason: state.asked?.reason ?? null,
      not_before: state.notBefore === undefined ? null : toRfc3339(state.notBefore),
      covered_turn_count: state.coveredTurnCount,
      keepalive_model: k?.model ?? null,
      keepalive_identity: k?.identity ?? null,
      keepalive_interval_ms: k?.intervalMs ?? null,
      keepalive_last_warm_at: k === undefined ? null : toRfc3339(k.lastWarmAt),
      keepalive_last_active_at: k === undefined ? null : toRfc3339(k.lastActiveAt),
      keepalive_pings_sent: k?.pingsSent ?? null,
      keepalive_max_pings: k?.maxPings ?? null,
      ...encodeDream(state.dream ?? NO_DREAM),
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

  const wakesWithoutUser = o["ticks_without_user"];
  if (typeof wakesWithoutUser !== "number") return undefined;

  const coveredTurnCount = o["covered_turn_count"];

  return {
    wakesWithoutUser,
    lastUserAt: timeField(o["last_user_at"]),
    forcedDormant: o["forced_dormant"] === true,
    asked: askedField(o),
    lastHeartbeatAt: timeField(o["wake_anchor_at"]),
    notBefore: timeField(o["not_before"]),
    coveredTurnCount: typeof coveredTurnCount === "number" ? coveredTurnCount : 0,
    keepalive: keepaliveField(o),
    dream: dreamField(o),
  };
}

function encodeDream(dream: PersistedDream): Record<string, unknown> {
  return {
    dream_last_at: dream.lastAt === undefined ? null : toRfc3339(dream.lastAt),
    dream_turns_since: dream.turnsSince,
    dream_retry_at: dream.retryAt === undefined ? null : toRfc3339(dream.retryAt),
    dream_failures: dream.failures,
    dream_forced: dream.forced,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function dreamField(o: Record<string, unknown>): PersistedDream {
  const lastAt = timeField(o["dream_last_at"]);
  const retryAt = timeField(o["dream_retry_at"]);
  return {
    ...(lastAt === undefined ? {} : { lastAt }),
    turnsSince: count(o["dream_turns_since"]),
    ...(retryAt === undefined ? {} : { retryAt }),
    failures: count(o["dream_failures"]),
    forced: o["dream_forced"] === true,
  };
}

function askedField(o: Record<string, unknown>): AskedWake | undefined {
  const at = timeField(o["next_wake_at"]);
  const reason = o["wake_reason"];
  if (at === undefined || o["default_wake"] === true) return undefined;
  return { at, reason: typeof reason === "string" ? reason : "" };
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
