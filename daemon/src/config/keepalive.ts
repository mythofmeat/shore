import { ConfigDuration, type ParseResult } from "./duration.ts";

export type CacheKeepaliveSetting =
  | { kind: "off" }
  | { kind: "every"; interval: ConfigDuration };

const KEEPALIVE_OFF_SPELLINGS = ["off", "none", "disabled", "false", "0"];

export function parseCacheKeepalive(raw: string): ParseResult<CacheKeepaliveSetting> {
  const trimmed = raw.trim();
  if (KEEPALIVE_OFF_SPELLINGS.includes(asciiLowercase(trimmed))) return { ok: { kind: "off" } };

  const interval = ConfigDuration.parse(trimmed);
  if ("err" in interval) return interval;
  if (interval.ok.asMillisExact() === 0n) {
    return { err: 'cache_keepalive interval must be > 0; use "off" to disable' };
  }
  return { ok: { kind: "every", interval: interval.ok } };
}

export function keepaliveIntervalMs(setting: CacheKeepaliveSetting): number | undefined {
  return setting.kind === "off" ? undefined : setting.interval.asMillis();
}

export function keepaliveToString(setting: CacheKeepaliveSetting): string {
  return setting.kind === "off" ? "off" : setting.interval.toString();
}

function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
