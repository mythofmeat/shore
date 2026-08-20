import { compareByCodePoint } from "../util/sort.ts";
import { ConfigDuration } from "./duration.ts";

export function serializeConfigValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof ConfigDuration) return value.toString();
  if (value instanceof Map) {
    const map = value as ReadonlyMap<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [...map.keys()].sort(compareByCodePoint)) {
      out[key] = serializeConfigValue(map.get(key));
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
