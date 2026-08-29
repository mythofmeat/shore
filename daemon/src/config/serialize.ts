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

export const SECRET_CONFIG_PATHS: readonly string[] = [
  "notifications.ntfy.token",
  "mcp.*.env.*",
  "mcp.*.headers.*",
];

export const REDACTED = "<redacted>";

function matches(pattern: string[], path: string[]): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((part, i) => part === "*" || part === path[i]);
}

function isSecretPath(path: string[]): boolean {
  return SECRET_CONFIG_PATHS.some((p) => matches(p.split("."), path));
}

export function redactSecrets(value: unknown, path: string[] = []): unknown {
  if (isSecretPath(path)) {
    if (typeof value === "string") return value === "" ? value : REDACTED;
    return value === null || value === undefined ? value : REDACTED;
  }
  if (Array.isArray(value)) return value.map((v, i) => redactSecrets(v, [...path, String(i)]));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecrets(v, [...path, key]);
    }
    return out;
  }
  return value;
}
