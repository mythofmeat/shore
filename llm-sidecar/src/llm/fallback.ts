/**
 * Transient retry, and rotating across a provider's configured API keys.
 *
 * Ported from `crates/daemon/src/handler/generation.rs` (`stream_with_retry`)
 * and `crates/daemon/src/handler/key_fallback.rs`, pinned by
 * `tests/llm_fixtures/fallback_parity.json`.
 *
 * Two layers, deliberately separate, wrapping every outbound call:
 *
 * 1. {@link streamWithRetry} absorbs *transient* failures — 5xx, network
 *    blips, a stream that ends without its done event — with exponential
 *    backoff on the same key.
 * 2. {@link streamWithCredentialFallback} sits above it and rotates to the
 *    next configured key when a failure is *credential*-shaped. Each candidate
 *    gets the full transient budget before its key is abandoned.
 *
 * # Why the order matters
 *
 * Getting it backwards burns every configured key on what was a passing 503
 * and reports "all keys exhausted" when nothing was wrong with any of them.
 * Retrying inside the rotation is what keeps a transient failure from looking
 * like a credential one.
 *
 * # Invariants carried over verbatim
 *
 * - **Rotation is not sticky.** Every request restarts at the first enabled
 *   key. A rotation on the previous call never short-circuits this one's
 *   resolution, so a key that recovers is picked up immediately.
 * - **A missing environment variable rotates without touching the network.**
 *   It is a credential failure like any other.
 * - **Mid-stream failures never rotate.** Once bytes are flowing the provider
 *   has accepted the credential and the user may have seen partial output, so
 *   an interrupted stream falls through to the retry layer instead.
 * - **Secrets never leave the caller.** Candidates carry the *name* of an
 *   environment variable; only friendly key names, status codes and sanitized
 *   reasons reach a client or a diagnostics record.
 */

import { classifyCredentialFailure, shouldRotate, type CredentialFailureKind } from "./credentials";
import { shouldRetryError } from "./retry";
import type { KeyCandidate } from "./credentials";
import type { LlmError } from "./errors";

/** Transient retries before giving up, when the config sets none. */
export const DEFAULT_MAX_RETRIES = 2;
/** Backoff base in milliseconds, when the config sets none. */
export const DEFAULT_BACKOFF_BASE_MS = 500;

/** Longest provider message kept in a sanitized reason, in *bytes*. */
const MAX_REASON_BYTES = 200;

/** `u64::MAX`, the ceiling the Rust's saturating arithmetic clamps to. */
const U64_MAX = 2n ** 64n - 1n;

// ── Error projection ────────────────────────────────────────────────────

/** The HTTP status behind a failure, when it had one. */
export function llmHttpStatus(error: LlmError): number | undefined {
  return error.kind === "http_status" ? error.status : undefined;
}

/**
 * A short description of a failure, safe to surface.
 *
 * Response bodies are dropped entirely rather than truncated: a provider's
 * 4xx body can echo part of a credential, internal ids, or quota figures
 * verbatim, and a warning is exactly the wrong place for any of it. Only the
 * status survives. Provider-supplied *messages* are usually benign and are
 * kept, capped defensively.
 */
export function sanitizeReason(error: LlmError): string {
  switch (error.kind) {
    case "http_status":
      return `HTTP ${error.status}`;
    case "missing_api_key":
      return `env ${debugString(error.var)} not set`;
    case "provider":
      return `provider error: ${truncateBytes(error.message, MAX_REASON_BYTES)}`;
    case "refusal":
      return "model refusal";
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
  }
}

/** The reason recorded when a candidate's environment variable is unset. */
export function missingKeyReason(envVar: string): string {
  return `env ${debugString(envVar)} unset or empty`;
}

/**
 * Rust's `{:?}` on a string: quoted, with the same escapes JSON uses for
 * everything these values can contain.
 */
function debugString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Cap a string at a **byte** length, moving the cut back to a UTF-8 character
 * boundary so a multibyte character straddling the limit is dropped whole.
 *
 * `slice(0, 200)` would cut by UTF-16 code units — neither the same threshold
 * nor the same boundary.
 */
function truncateBytes(s: string, maxBytes: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return `${bytes.toString("utf8", 0, end)}…`;
}

// ── Warning text ────────────────────────────────────────────────────────

/**
 * The user-facing sentence for one rotation.
 *
 * Tailored per failure kind so it reads naturally whatever the cause. Never
 * includes a status body, an environment value, or the key.
 */
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
      // Unreachable through the rotation path, which only builds a message for
      // rotation-triggering kinds. Kept so a future caller cannot leak a
      // message claiming a cause that did not happen.
      return `${provider} fallback from ${f} to ${t}.`;
  }
}

// ── Backoff ─────────────────────────────────────────────────────────────

/**
 * Delay before the attempt after `attempt`: `base * 2^attempt`.
 *
 * Saturating, not wrapping. The Rust used `saturating_mul`/`saturating_pow`
 * throughout, so a pathological base or attempt count clamps at `u64::MAX`
 * instead of wrapping round to a near-zero delay and hammering the provider.
 * BigInt does the arithmetic because the clamp point is past what a double
 * represents exactly.
 */
export function backoffDelayMs(baseMs: number, attempt: number): number {
  const product = BigInt(Math.trunc(baseMs)) * 2n ** BigInt(Math.trunc(attempt));
  return Number(product > U64_MAX ? U64_MAX : product);
}

// ── Retry ───────────────────────────────────────────────────────────────

/** How many transient retries, and how long to wait between them. */
export interface RetrySettings {
  maxRetries: number;
  backoffBaseMs: number;
}

export const DEFAULT_RETRY: RetrySettings = {
  maxRetries: DEFAULT_MAX_RETRIES,
  backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
};

/** One attempt. Rejects with an {@link LlmError} to signal failure. */
export type Attempt<T> = () => Promise<T>;

/** Injected so tests do not spend real time asleep. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, absorbing transient failures with exponential backoff.
 *
 * Rejects with the underlying {@link LlmError} rather than wrapping it, so the
 * rotation layer above can classify the failure and decide whether a different
 * key would help.
 */
export async function streamWithRetry<T>(
  attempt: Attempt<T>,
  settings: RetrySettings = DEFAULT_RETRY,
  shouldRetry: (error: LlmError, attempt: number, maxRetries: number) => boolean = defaultShouldRetry,
  sleep: Sleep = realSleep,
): Promise<T> {
  let attemptIndex = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (raw) {
      const error = raw as LlmError;
      if (!shouldRetry(error, attemptIndex, settings.maxRetries)) throw error;
      await sleep(backoffDelayMs(settings.backoffBaseMs, attemptIndex));
      attemptIndex += 1;
    }
  }
}

/**
 * Default retry predicate, deferring to the ported decision table.
 *
 * Split out so the loop above is testable without the classifier, and so the
 * classifier stays the single place that decides what "transient" means.
 */
function defaultShouldRetry(error: LlmError, attempt: number, maxRetries: number): boolean {
  // `fallback_model` is the third arm and is unreachable in production — no
  // construction site ever sets one (#16). It is treated as "stop" here, which
  // is what the Rust's caller did with it too.
  return shouldRetryError(error, attempt, { max_retries: maxRetries }).decision === "retry";
}

// ── Credential rotation ─────────────────────────────────────────────────

/** What a rotation produced, for diagnostics and for the client warning. */
export interface FallbackEvent {
  from: KeyCandidate;
  to?: KeyCandidate;
  kind: CredentialFailureKind;
  status?: number;
  reason: string;
  /** The sentence to show the user, present only when the abandoned key opted in. */
  warning?: string;
}

export interface FallbackHooks {
  /** Every rotation, whether or not the user opted into a visible warning. */
  record: (event: FallbackEvent) => void;
}

/**
 * Try each candidate in configured order, rotating on credential failures.
 *
 * `attempt` receives the resolved key and its candidate; it should perform the
 * whole call *including* its transient retries — {@link streamWithRetry} is the
 * intended inner layer. A candidate whose environment variable is unset is
 * rotated past without calling `attempt` at all.
 *
 * @throws {LlmError} the last classified failure, or a `missing_api_key`
 * naming the provider when there was no candidate to try.
 */
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

  let lastError: LlmError | undefined;

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
      const error = raw as LlmError;
      const kind = classifyCredentialFailure(providerKey, error);
      if (!shouldRotate(kind)) {
        // Transient retries are already spent, or this is something no other
        // key can fix. Rotating here would burn every remaining credential.
        throw error;
      }
      record(hooks, providerKey, candidate, next, kind, llmHttpStatus(error), sanitizeReason(error));
      lastError = error;
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
  // The warning is shown only when the key being *abandoned* opted into
  // visibility, and only when there is somewhere to rotate to — the
  // final failure surfaces as the thrown error instead.
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
