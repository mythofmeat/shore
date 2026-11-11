import { readState, writeState } from "../storage/store.ts";

const PRESENCE_STATE = "presence.json";

const SEEN_STATE = "last_seen.json";

export interface Presence {
  status: string;
  set_at: string;
}

function stored(dataDir: string, file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readState(dataDir, file) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function instant(value: unknown): number | undefined {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

export function presence(dataDir: string): Presence | undefined {
  const { status, set_at: setAt } = stored(dataDir, PRESENCE_STATE);
  return typeof status === "string" && typeof setAt === "string" && instant(setAt) !== undefined ? { status, set_at: setAt } : undefined;
}

export function setPresence(dataDir: string, status: string, now: number): Presence {
  const next: Presence = { status: status.trim(), set_at: new Date(now).toISOString() };
  writeState(dataDir, PRESENCE_STATE, JSON.stringify(next));
  return next;
}

export function lastSeen(dataDir: string): number | undefined {
  return instant(stored(dataDir, SEEN_STATE)["at"]);
}

export function noteSeen(dataDir: string, now: number): void {
  writeState(dataDir, SEEN_STATE, JSON.stringify({ at: new Date(now).toISOString() }));
}

export function unshownPresence(current: Presence | undefined, active: readonly { presence?: Presence | undefined }[]): Presence | undefined {
  if (current === undefined || active.some((message) => message.presence?.set_at === current.set_at)) return undefined;
  return current.status === "" && active.every((message) => message.presence === undefined) ? undefined : current;
}
