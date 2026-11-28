import { shoreLog } from "../log.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { TriggerFiring } from "./runner.ts";

export const ASKED_STATE = "asked_wakes.json";

function askedWake(raw: unknown): TriggerFiring | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { thread, from, reason, at, startsAt, limitMs } = raw as Record<string, unknown>;
  if (typeof thread !== "string" || typeof from !== "string" || typeof reason !== "string" || typeof at !== "number") return undefined;
  return { name: "", thread, from, reason, at, ...(typeof startsAt === "number" ? { startsAt } : {}), ...(typeof limitMs === "number" ? { limitMs } : {}) };
}

function saved(firing: TriggerFiring): Record<string, unknown> {
  return { thread: firing.thread, from: firing.from, reason: firing.reason, at: firing.at, startsAt: firing.startsAt, limitMs: firing.limitMs };
}

export class AskedWakes {
  readonly #characterDir: string;
  readonly #waiting = new Map<string, TriggerFiring>();

  constructor(characterDir: string) {
    this.#characterDir = characterDir;
    try {
      const parsed: unknown = JSON.parse(readCharacterState(characterDir, ASKED_STATE) ?? "[]");
      for (const raw of Array.isArray(parsed) ? parsed : []) {
        const firing = askedWake(raw);
        if (firing !== undefined) this.#waiting.set(firing.thread ?? "", firing);
      }
    } catch (error) {
      shoreLog.error(`shore: could not read the wakes asked for at ${characterDir}: ${String(error)}`);
    }
  }

  list(): TriggerFiring[] {
    return [...this.#waiting.values()];
  }

  keep(firing: TriggerFiring): void {
    this.#waiting.set(firing.thread ?? "", firing);
    this.#save();
  }

  gone(firings: readonly TriggerFiring[]): void {
    for (const firing of firings) {
      const kept = this.#waiting.get(firing.thread ?? "");
      if (kept?.at === firing.at && kept.from === firing.from) this.#waiting.delete(firing.thread ?? "");
    }
    this.#save();
  }

  #save(): void {
    try {
      writeCharacterState(this.#characterDir, ASKED_STATE, JSON.stringify(this.list().map(saved)));
    } catch (error) {
      shoreLog.error(`shore: could not save the wakes asked for at ${this.#characterDir}: ${String(error)}`);
    }
  }
}
