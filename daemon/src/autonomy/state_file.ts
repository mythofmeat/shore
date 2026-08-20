import { shoreLog } from "../log.ts";

export const STATE_VERSION = 4;

export const STATE_FILENAME = "autonomy_state.json";

export interface PersistedKeepalive {
  readonly model: string;
  readonly intervalMs: number;
  readonly lastWarmAt: number;
  readonly lastActiveAt: number;
}

export interface AutonomyStateFile {
  readonly ticksWithoutUser: number;
  readonly nextWakeAt: number | undefined;
  readonly lastUserAt: number | undefined;
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

export async function loadState(path: string): Promise<AutonomyStateFile | undefined> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return undefined;
  }
  return decodeState(raw);
}

export async function saveState(path: string, state: AutonomyStateFile): Promise<boolean> {
  try {
    await Bun.write(path, encodeState(state));
    return true;
  } catch (err) {
    shoreLog.error(`shore: failed to save autonomy state at ${path}: ${String(err)}`);
    return false;
  }
}
