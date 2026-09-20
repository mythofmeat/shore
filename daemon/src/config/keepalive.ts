import { ConfigDuration, rustTrim, type ParseResult } from "./duration.ts";

export const DEFAULT_KEEPALIVE_MAX_SECS = 12 * 60 * 60;

export function resolveKeepaliveMaxSecs(model: number | undefined, configured?: number): number {
  return model ?? configured ?? DEFAULT_KEEPALIVE_MAX_SECS;
}

export type CacheKeepaliveSetting =
  | { kind: "off" }
  | { kind: "every"; interval: ConfigDuration };


export function parseCacheKeepalive(raw: string): ParseResult<CacheKeepaliveSetting> {
  const trimmed = raw.trim();
  if (trimmed === "off") return { ok: { kind: "off" } };

  const interval = ConfigDuration.parse(trimmed);
  if ("err" in interval) return interval;
  if (interval.ok.asMillisExact() === 0n) {
    return { err: 'cache_keepalive interval must be > 0; use "off" to disable' };
  }
  return { ok: { kind: "every", interval: interval.ok } };
}

export function parseCacheKeepaliveMax(raw: string): ParseResult<ConfigDuration> {
  const parsed = ConfigDuration.parse(rustTrim(raw));
  if ("err" in parsed) return parsed;
  if (parsed.ok.asMillisExact() === 0n) {
    return {
      err: 'cache_keepalive_max must be > 0; use cache_keepalive = "off" to stop pinging entirely',
    };
  }
  return { ok: parsed.ok };
}

export function keepaliveIntervalMs(setting: CacheKeepaliveSetting): number | undefined {
  return setting.kind === "off" ? undefined : setting.interval.asMillis();
}

export function keepaliveToString(setting: CacheKeepaliveSetting): string {
  return setting.kind === "off" ? "off" : setting.interval.toString();
}
