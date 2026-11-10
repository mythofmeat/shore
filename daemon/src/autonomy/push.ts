import { readCharacterState, writeCharacterState } from "../storage/store.ts";
import type { NtfyDelivery } from "../notifications.ts";

const PUSH_STATE = "push.json";

const PUSH_CHARS = 300;

export interface PushSettings extends NtfyDelivery {
  everyMs: number;
}

export type PushOutcome =
  | { kind: "sent"; nextAt: number }
  | { kind: "too_soon"; lastAt: number; nextAt: number }
  | { kind: "not_set_up" };

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

export async function pushToUser(characterDir: string, title: string, message: string, settings: PushSettings, now: number, send: PushSend): Promise<PushOutcome> {
  if (settings.topic === "") return { kind: "not_set_up" };
  const lastAt = lastPushAt(characterDir);
  if (lastAt !== undefined && now - lastAt < settings.everyMs) return { kind: "too_soon", lastAt, nextAt: lastAt + settings.everyMs };
  const chars = Array.from(message);
  await send({ url: settings.url, topic: settings.topic, token: settings.token }, title, chars.length > PUSH_CHARS ? `${chars.slice(0, PUSH_CHARS).join("")}…` : message);
  writeCharacterState(characterDir, PUSH_STATE, JSON.stringify({ last: new Date(now).toISOString() }));
  return { kind: "sent", nextAt: now + settings.everyMs };
}
