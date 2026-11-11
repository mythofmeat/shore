import { shoreLog } from "../log.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";

const SEALED_STATE = "sealed.json";

export interface SealedThread {
  id: string;
  label: string;
  unseal_at: string;
  created_at: string;
}

function sealedThread(raw: unknown): SealedThread | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, label, unseal_at, created_at } = raw as Record<string, unknown>;
  if (typeof id !== "string" || typeof label !== "string" || typeof unseal_at !== "string" || typeof created_at !== "string") return undefined;
  return Number.isNaN(Date.parse(unseal_at)) ? undefined : { id, label, unseal_at, created_at };
}

export function sealedThreads(characterDir: string): SealedThread[] {
  try {
    const parsed: unknown = JSON.parse(readCharacterState(characterDir, SEALED_STATE) ?? "[]");
    if (Array.isArray(parsed)) return parsed.flatMap((raw) => sealedThread(raw) ?? []);
  } catch (error) {
    shoreLog.error(`shore: could not read the sealed threads at ${characterDir}: ${String(error)}`);
  }
  return [];
}

export function keepSealedThreads(characterDir: string, sealed: readonly SealedThread[]): void {
  writeCharacterState(characterDir, SEALED_STATE, JSON.stringify(sealed));
}

export function sealedIn(characterDir: string, id: string): SealedThread | undefined {
  return sealedThreads(characterDir).find((sealed) => sealed.id === id);
}
