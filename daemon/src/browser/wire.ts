import type { ServerMessage } from "../protocol/ServerMessage.ts";
import wire from "../protocol/wire.generated.json" with { type: "json" };
import { validServerMessage } from "./validators.generated.js";

const knownTypes: ReadonlySet<string> = new Set(wire.server.oneOf.map((variant) => variant.properties.type.const));

export type ParsedFrame =
  | { kind: "known"; message: ServerMessage }
  | { kind: "future"; message: Record<string, unknown> & { type: string } }
  | { kind: "invalid"; reason: string };

export function parseServerFrame(text: string): ParsedFrame {
  if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) return { kind: "invalid", reason: "Server frame exceeds the browser limit" };
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { return { kind: "invalid", reason: "Server sent invalid JSON" }; }
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("type" in value) || typeof value.type !== "string" || value.type.length === 0 || value.type.length > 128) {
    return { kind: "invalid", reason: "Server frame has no valid event type" };
  }
  if (!knownTypes.has(value.type)) return { kind: "future", message: value as Record<string, unknown> & { type: string } };
  if (!validServerMessage(value)) return { kind: "invalid", reason: `Server sent an invalid ${value.type} event` };
  return { kind: "known", message: value };
}
