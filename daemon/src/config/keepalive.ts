import { ConfigDuration, MAX_SCHEDULE_OFFSET, rustTrim, type ParseResult } from "./duration.ts";

export const DEFAULT_KEEPALIVE_PINGS = 1;

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
  if (interval.ok.asMillisExact() > MAX_SCHEDULE_OFFSET.asMillisExact()) {
    return { err: `cache_keepalive interval must not exceed ${MAX_SCHEDULE_OFFSET.toString()}` };
  }
  return { ok: { kind: "every", interval: interval.ok } };
}

export function parsePositiveDuration(name: string, raw: string): ParseResult<ConfigDuration> {
  const parsed = ConfigDuration.parse(rustTrim(raw));
  if ("err" in parsed) return parsed;
  if (parsed.ok.asMillisExact() === 0n) return { err: `${name} must be > 0` };
  return { ok: parsed.ok };
}

export function parseKeepalivePings(raw: unknown): ParseResult<number> {
  const parsed = typeof raw === "number"
    ? raw
    : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 0xff_ff_ff_ff) {
    return { err: `cache_keepalive_pings must be a whole number >= 1; got ${JSON.stringify(raw) ?? "null"}` };
  }
  return { ok: parsed };
}

export function keepaliveToString(setting: CacheKeepaliveSetting): string {
  return setting.kind === "off" ? "off" : setting.interval.toString();
}

export function keepaliveWindowSecs(intervalMs: number | undefined, pings: number | undefined): number {
  if (intervalMs === undefined) return 0;
  return Math.trunc((intervalMs * (pings ?? DEFAULT_KEEPALIVE_PINGS)) / 1000);
}
