import type { Message } from "../engine/types.ts";
import { readState, writeState } from "../storage/store.ts";

const PRESENCE_STATE = "presence.json";

const SEEN_STATE = "last_seen.json";

export const MAX_STATUS_CHARS = 80;

export type Presence = NonNullable<Message["presence"]>;

export type Status = Presence["statuses"][number];

export interface PresenceState {
  presence: Presence | undefined;
  history: string[];
}

export interface StatusChange {
  on?: readonly string[] | undefined;
  off?: readonly string[] | undefined;
  clear?: boolean | undefined;
  forget?: readonly string[] | undefined;
}

export interface ChangedPresence extends PresenceState {
  changed: boolean;
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

function statusOf(raw: unknown): Status[] {
  if (typeof raw !== "object" || raw === null) return [];
  const { status, set_at: setAt } = raw as Record<string, unknown>;
  return typeof status === "string" && instant(setAt) !== undefined ? [{ status, set_at: setAt as string }] : [];
}

function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export function presenceState(dataDir: string): PresenceState {
  const { statuses, changed_at: changedAt, history } = stored(dataDir, PRESENCE_STATE);
  return {
    presence: instant(changedAt) === undefined ? undefined : { statuses: list(statuses).flatMap(statusOf), changed_at: changedAt as string },
    history: list(history).filter((name) => typeof name === "string"),
  };
}

export function presence(dataDir: string): Presence | undefined {
  return presenceState(dataDir).presence;
}

export function statusNames(statuses: readonly Status[]): string[] {
  return statuses.map((status) => status.status);
}

export function changePresence(dataDir: string, change: StatusChange, now: number): ChangedPresence {
  const { presence: current, history } = presenceState(dataDir);
  const before = current?.statuses ?? [];
  const on = [...new Set(change.on)];
  const off = new Set(change.clear === true ? statusNames(before) : change.off);
  const kept = before.filter((status) => !off.has(status.status) || on.includes(status.status));
  const added = on.filter((name) => !kept.some((status) => status.status === name));
  const changed = kept.length < before.length || added.length > 0;
  const at = new Date(now).toISOString();
  const next = changed ? { statuses: [...kept, ...added.map((status) => ({ status, set_at: at }))], changed_at: at } : current;
  const forgotten = new Set(change.forget);
  const remembered = [...on, ...history.filter((name) => !on.includes(name))].filter((name) => !forgotten.has(name));
  writeState(dataDir, PRESENCE_STATE, JSON.stringify({ ...next, history: remembered }));
  return { presence: next, history: remembered, changed };
}

export function lastSeen(dataDir: string): number | undefined {
  return instant(stored(dataDir, SEEN_STATE)["at"]);
}

export function noteSeen(dataDir: string, now: number): void {
  writeState(dataDir, SEEN_STATE, JSON.stringify({ at: new Date(now).toISOString() }));
}

function same(shown: readonly Status[], current: readonly Status[]): boolean {
  return shown.length === current.length && shown.every((status, index) => status.status === current[index]?.status && status.set_at === current[index].set_at);
}

export function unshownPresence(current: Presence | undefined, active: readonly { presence?: Presence | undefined }[]): Presence | undefined {
  if (current === undefined) return undefined;
  const shown = active.findLast((message) => message.presence !== undefined)?.presence?.statuses ?? [];
  return same(shown, current.statuses) ? undefined : current;
}
