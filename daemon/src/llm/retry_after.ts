export type HeaderReader = (name: string) => string | undefined;

export function headerReader(headers: unknown): HeaderReader | undefined {
  if (headers === null || headers === undefined) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    return (name) => {
      const value = (get as (n: string) => unknown).call(headers, name);
      return typeof value === "string" ? value : undefined;
    };
  }
  if (typeof headers !== "object") return undefined;
  const lower = new Map<string, string>();
  const entries = Array.isArray(headers)
    ? (headers as [string, string][])
    : Object.entries(headers as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof key !== "string") continue;
    if (typeof value === "string") lower.set(key.toLowerCase(), value);
    else if (Array.isArray(value) && typeof value[0] === "string") {
      lower.set(key.toLowerCase(), value[0]);
    }
  }
  return (name) => lower.get(name.toLowerCase());
}

export function parseRetryAfterMs(headers: unknown, now: () => number = Date.now): number | undefined {
  const read = headerReader(headers);
  if (read === undefined) return undefined;

  const millis = read("retry-after-ms");
  if (millis !== undefined) {
    const parsed = Number.parseFloat(millis);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }

  const after = read("retry-after");
  if (after === undefined) return undefined;

  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(after);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

export function retryAfterMsFromError(err: unknown, now: () => number = Date.now): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const carrier = err as { headers?: unknown; responseHeaders?: unknown; response?: unknown };
  const candidates = [
    carrier.headers,
    carrier.responseHeaders,
    (carrier.response as { headers?: unknown } | undefined)?.headers,
  ];
  for (const headers of candidates) {
    const parsed = parseRetryAfterMs(headers, now);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export interface RateLimitSnapshot {
  requests_remaining?: number;
  requests_limit?: number;
  input_tokens_remaining?: number;
  input_tokens_limit?: number;
  output_tokens_remaining?: number;
  output_tokens_limit?: number;
  resets_at?: string;
}

type NumericRateLimitField = Exclude<keyof RateLimitSnapshot, "resets_at">;

const RATE_LIMIT_FIELDS: [NumericRateLimitField, string][] = [
  ["requests_remaining", "anthropic-ratelimit-requests-remaining"],
  ["requests_limit", "anthropic-ratelimit-requests-limit"],
  ["input_tokens_remaining", "anthropic-ratelimit-input-tokens-remaining"],
  ["input_tokens_limit", "anthropic-ratelimit-input-tokens-limit"],
  ["output_tokens_remaining", "anthropic-ratelimit-output-tokens-remaining"],
  ["output_tokens_limit", "anthropic-ratelimit-output-tokens-limit"],
];

export function rateLimitSnapshot(headers: unknown): RateLimitSnapshot | undefined {
  const read = headerReader(headers);
  if (read === undefined) return undefined;

  const snapshot: RateLimitSnapshot = {};
  let seen = false;
  for (const [field, header] of RATE_LIMIT_FIELDS) {
    const raw = read(header);
    if (raw === undefined) continue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) continue;
    snapshot[field] = parsed;
    seen = true;
  }

  const resets =
    read("anthropic-ratelimit-requests-reset") ?? read("anthropic-ratelimit-input-tokens-reset");
  if (resets !== undefined) {
    snapshot.resets_at = resets;
    seen = true;
  }

  return seen ? snapshot : undefined;
}
