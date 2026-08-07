import { ConfigDuration } from "./duration.ts";

export function serializeConfigValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof ConfigDuration) return value.toString();
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const key of [...value.keys()].sort()) {
      out[key] = serializeConfigValue(value.get(key));
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(serializeConfigValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializeConfigValue(v);
    }
    return out;
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}
