import { AbortError, abortRejection, isAbortError } from "./abort";
import { classifyCredentialFailure, shouldRotate, type CredentialFailureKind } from "./credentials";
import { shouldRetryError } from "./retry";
import { retryAfterMsFromError } from "./retry_after";
import type { KeyCandidate } from "./credentials";
import { describeError, toLlmError, type LlmError } from "./errors";

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_JITTER_FRACTION = 0.25;

const MAX_REASON_BYTES = 200;

const U64_MAX = 2n ** 64n - 1n;

export function llmHttpStatus(raw: unknown): number | undefined {
  const error = toLlmError(raw);
  return error.kind === "http_status" ? error.status : undefined;
}

export function sanitizeReason(raw: unknown): string {
  const error = toLlmError(raw);
  switch (error.kind) {
    case "http_status":
      return `HTTP ${error.status}`;
    case "missing_api_key":
      return `env ${debugString(error.var)} not set`;
    case "provider":
      return `provider error: ${truncateBytes(error.message, MAX_REASON_BYTES)}`;
    case "incomplete_stream":
      return "stream ended without done event";
    case "stream_errored":
      return `stream errored: ${error.message}`;
    case "transport":
      return "transport error";
    case "serialize":
      return "request serialization failed";
    case "deserialize":
      return "response deserialization failed";
    case "budget_blocked":
      return truncateBytes(error.message, MAX_REASON_BYTES);
    case "aborted":
      return "request cancelled";
    default:
      return truncateBytes(describeError(error), MAX_REASON_BYTES);
  }
}

export function missingKeyReason(envVar: string): string {
  return `env ${debugString(envVar)} unset or empty`;
}

function debugString(s: string): string {
  return JSON.stringify(s);
}

function truncateBytes(s: string, maxBytes: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return `${bytes.toString("utf8", 0, end)}…`;
}

export function buildWarningMessage(
  provider: string,
  from: KeyCandidate,
  to: KeyCandidate,
  kind: CredentialFailureKind,
): string {
  const f = debugString(from.name);
  const t = debugString(to.name);
  switch (kind) {
    case "budget_exhausted":
      return `Budget warning: ${provider} key ${f} appears exhausted. Continuing with fallback key ${t}.`;
    case "quota_exhausted":
      return `Quota warning: ${provider} key ${f} appears over quota. Continuing with fallback key ${t}.`;
    case "missing_key":
      return `${provider} key ${f} is not configured. Continuing with fallback key ${t}.`;
    case "invalid_key":
      return `${provider} key ${f} was rejected. Continuing with fallback key ${t}.`;
    case "rate_limited_credential":
      return `${provider} key ${f} is rate-limited. Continuing with fallback key ${t}.`;
    case "unknown":
      return `${provider} key ${f} failed (credential-related). Continuing with fallback key ${t}.`;
    case "not_credential_failure":
      return `${provider} fallback from ${f} to ${t}.`;
  }
}

export function backoffDelayMs(baseMs: number, attempt: number): number {
  const product = BigInt(Math.trunc(baseMs)) * 2n ** BigInt(Math.trunc(attempt));
  return Number(product > U64_MAX ? U64_MAX : product);
}

export interface RetrySettings {
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs?: number;
  jitterFraction?: number;
}

export const DEFAULT_RETRY: RetrySettings = {
  maxRetries: DEFAULT_MAX_RETRIES,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
};

export interface DelayInputs {
  retryAfterMs?: number;
  random?: () => number;
}

export function retryDelayMs(
  settings: RetrySettings,
  attempt: number,
  inputs: DelayInputs = {},
): number {
  const ceiling = Math.max(0, settings.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const spread = Math.max(0, settings.jitterFraction ?? DEFAULT_JITTER_FRACTION);
  const random = inputs.random ?? Math.random;
  const exponential = backoffDelayMs(settings.backoffBaseMs, attempt);
  const hint = inputs.retryAfterMs;
  const floor = hint !== undefined && hint > 0 ? Math.max(exponential, hint) : exponential;

  if (floor >= ceiling) return Math.max(0, Math.round(ceiling - ceiling * spread * random()));

  const headroom = Math.min(floor * spread, ceiling - floor);
  return Math.ceil(floor + headroom * random());
}

export type Attempt<T> = () => Promise<T>;

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function sleepUnlessAborted(
  sleep: Sleep,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw new AbortError();
  const rejection = abortRejection(signal);
  try {
    await Promise.race([sleep(ms), rejection.promise]);
  } finally {
    rejection.dispose();
  }
}

export interface RetryContext {
  signal?: AbortSignal;
  random?: () => number;
}

export async function streamWithRetry<T>(
  attempt: Attempt<T>,
  settings: RetrySettings = DEFAULT_RETRY,
  shouldRetry: (error: LlmError, attempt: number, maxRetries: number) => boolean = defaultShouldRetry,
  sleep: Sleep = realSleep,
  context: RetryContext = {},
): Promise<T> {
  let attemptIndex = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (raw) {
      const error = raw as LlmError;
      if (context.signal?.aborted === true) throw error;
      if (isAbortError(raw)) throw raw;
      if (!shouldRetry(error, attemptIndex, settings.maxRetries)) throw error;
      const hint = retryAfterHint(raw);
      const delay = retryDelayMs(settings, attemptIndex, {
        ...(hint === undefined ? {} : { retryAfterMs: hint }),
        ...(context.random === undefined ? {} : { random: context.random }),
      });
      await sleepUnlessAborted(sleep, delay, context.signal);
      attemptIndex += 1;
    }
  }
}

export function retryAfterHint(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const carried = (raw as { retry_after_ms?: unknown }).retry_after_ms;
  if (typeof carried === "number" && Number.isFinite(carried) && carried >= 0) return carried;
  return retryAfterMsFromError(raw);
}

function defaultShouldRetry(error: LlmError, attempt: number, maxRetries: number): boolean {
  return shouldRetryError(error, attempt, { max_retries: maxRetries }).decision === "retry";
}

export interface FallbackEvent {
  from: KeyCandidate;
  to?: KeyCandidate;
  kind: CredentialFailureKind;
  status?: number;
  reason: string;
  warning?: string;
}

export interface FallbackHooks {
  record: (event: FallbackEvent) => void;
}

export async function streamWithCredentialFallback<T>(
  providerKey: string,
  candidates: KeyCandidate[],
  readEnv: (candidate: KeyCandidate) => string | undefined,
  attempt: (apiKey: string, candidate: KeyCandidate) => Promise<T>,
  hooks: FallbackHooks,
): Promise<T> {
  if (candidates.length === 0) {
    throw missingApiKey(`provider '${providerKey}' has no enabled keys`);
  }

  let lastError: unknown;

  for (const [index, candidate] of candidates.entries()) {
    const next = candidates[index + 1];

    const apiKey = readEnv(candidate);
    if (apiKey === undefined) {
      const error = missingApiKey(candidate.env);
      record(hooks, providerKey, candidate, next, "missing_key", undefined, missingKeyReason(candidate.env));
      lastError = error;
      continue;
    }

    try {
      return await attempt(apiKey, candidate);
    } catch (raw) {
      const error = toLlmError(raw);
      const kind = classifyCredentialFailure(providerKey, error);
      if (!shouldRotate(kind)) {
        throw raw;
      }
      record(hooks, providerKey, candidate, next, kind, llmHttpStatus(error), sanitizeReason(error));
      lastError = raw;
    }
  }

  throw lastError ?? missingApiKey(`all keys for provider '${providerKey}' failed`);
}

function record(
  hooks: FallbackHooks,
  providerKey: string,
  from: KeyCandidate,
  to: KeyCandidate | undefined,
  kind: CredentialFailureKind,
  status: number | undefined,
  reason: string,
): void {
  const warning =
    from.warn_on_fallback && to !== undefined
      ? buildWarningMessage(providerKey, from, to, kind)
      : undefined;

  hooks.record({
    from,
    ...(to !== undefined ? { to } : {}),
    kind,
    ...(status !== undefined ? { status } : {}),
    reason,
    ...(warning !== undefined ? { warning } : {}),
  });
}

function missingApiKey(envVar: string): LlmError {
  return { kind: "missing_api_key", var: envVar };
}
