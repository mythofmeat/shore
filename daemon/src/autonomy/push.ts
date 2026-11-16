import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { NtfyDelivery } from "../notifications.ts";

const PUSH_STATE = "push.json";

export const PUSH_CHARS = 300;

export interface PushSettings extends NtfyDelivery {
  everyMs: number;
}

export type PushRefusal =
  | { kind: "too_soon"; lastAt: number; nextAt: number }
  | { kind: "not_set_up" };

export type PushOutcome = { kind: "sent"; nextAt: number } | PushRefusal;

export type PushSend = (delivery: NtfyDelivery, title: string, body: string) => Promise<void>;

function lastPushAt(characterDir: string): number | undefined {
  try {
    const { last } = JSON.parse(readCharacterState(characterDir, PUSH_STATE) ?? "{}") as Record<string, unknown>;
    const at = typeof last === "string" ? Date.parse(last) : Number.NaN;
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

export function pushRefusal(characterDir: string, settings: Pick<PushSettings, "topic" | "everyMs">, now: number): PushRefusal | undefined {
  if (settings.topic === "") return { kind: "not_set_up" };
  const lastAt = lastPushAt(characterDir);
  return lastAt !== undefined && now - lastAt < settings.everyMs ? { kind: "too_soon", lastAt, nextAt: lastAt + settings.everyMs } : undefined;
}

export async function pushToUser(characterDir: string, title: string, message: string, settings: PushSettings, now: number, send: PushSend): Promise<PushOutcome> {
  const refused = pushRefusal(characterDir, settings, now);
  if (refused !== undefined) return refused;
  const chars = Array.from(message);
  await send({ url: settings.url, topic: settings.topic, token: settings.token }, title, chars.length > PUSH_CHARS ? `${chars.slice(0, PUSH_CHARS).join("")}…` : message);
  writeCharacterState(characterDir, PUSH_STATE, JSON.stringify({ last: new Date(now).toISOString() }));
  return { kind: "sent", nextAt: now + settings.everyMs };
}
