/**
 * Whether a failed or refused turn is worth trying again.
 *
 * Ported from `crates/daemon/src/llm/retry.rs`, pinned by
 * `tests/llm_fixtures/llm_decisions_parity.json`.
 *
 * This sits *below* credential rotation and above nothing: it decides retry,
 * fall back to another model, or give up. The one structural rule is that
 * credential-shaped failures never consume retry budget — they short-circuit
 * to `fail` so the multi-key wrapper above sees the error immediately and can
 * rotate. Retrying the same rejected key three times first would spend the
 * budget on the one thing that provably cannot work.
 *
 * # On logging
 *
 * The Rust warned on six of its branches. Only one survives here: the
 * credential short-circuit, because `fail` from a function called
 * `should_retry` is the one outcome a reader would not predict from the error
 * alone. The rest restated the branch they sat in. `tracing` is filtered off
 * by default and `console.warn` is not, so keeping them would have meant one
 * line per attempt in the daemon's output for ordinary transient failures.
 */

import { classifyCredentialFailure, shouldRotate } from "./credentials";
import { describeLlmError, type LlmError } from "./errors";

/**
 * What {@link shouldRetryRefusal} reads off a completed stream.
 *
 * The Rust took a whole `StreamResult` and touched two fields of it. Narrowed
 * here rather than reproduced, so this module does not pull in the stream
 * result type before `llm/stream.rs` is ported and can define it properly.
 */
export interface RefusalCheckable {
  content: string;
  finish_reason: string;
}

/** Retry and model-fallback policy. */
export interface RetryPolicy {
  /** Attempts before giving up. */
  max_retries: number;
  /** Model to try when the primary refuses or fails persistently. */
  fallback_model?: string;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { max_retries: 2 };

/** What to do after a failed or refused response. */
export type RetryDecision =
  | { decision: "retry" }
  | { decision: "fallback_model"; model: string }
  | { decision: "fail" };

const RETRY: RetryDecision = { decision: "retry" };
const FAIL: RetryDecision = { decision: "fail" };

/**
 * Decide what to do after a failed request.
 *
 * Order matters and is load-bearing twice over: the credential check runs
 * before the attempt ceiling (so rotation is never delayed by retry budget),
 * and the ceiling runs before the per-error branches (so an exhausted budget
 * reaches the fallback model even for an error that would otherwise retry).
 */
export function shouldRetryError(
  error: LlmError,
  attempt: number,
  policy: RetryPolicy,
): RetryDecision {
  const credKind = classifyCredentialFailure("", error);
  if (shouldRotate(credKind)) {
    console.warn(
      `shore: credential-shaped failure (${credKind}) on attempt ${attempt}, ` +
        `failing fast so multi-key fallback can rotate: ${describeLlmError(error)}`,
    );
    return FAIL;
  }

  if (attempt >= policy.max_retries) {
    if (policy.fallback_model !== undefined) {
      return { decision: "fallback_model", model: policy.fallback_model };
    }
    return FAIL;
  }

  switch (error.kind) {
    // Transport and stream failures are transient.
    case "transport":
    case "incomplete_stream":
    case "stream_errored":
      return RETRY;

    case "http_status":
      // 5xx and 429 are worth another go; every other 4xx is the caller's
      // fault and will fail identically next time.
      return error.status >= 500 || error.status === 429 ? RETRY : FAIL;

    // Not transient: the same bytes will fail the same way.
    case "serialize":
    case "deserialize":
    case "missing_api_key":
      return FAIL;

    // Vague enough to be worth one more attempt.
    case "provider":
      return RETRY;

    // A refusal is not going to change on a retry with the same model; only a
    // different model is worth trying.
    case "refusal":
      return policy.fallback_model !== undefined
        ? { decision: "fallback_model", model: policy.fallback_model }
        : FAIL;
  }
}

/**
 * Decide what to do about a response that *succeeded* but reads as a refusal.
 *
 * Note the return for a non-refusal: `fail`, meaning "stop" — the caller reads
 * it as "accept this result", not as an error. Naming it that way is the
 * Rust's, kept because the caller matches on the same three values from both
 * entry points.
 *
 * The fallback model is preferred over a plain retry here, and unlike
 * {@link shouldRetryError} it is reached *without* exhausting the attempt
 * budget: a model that just refused is unlikely to change its mind, so
 * spending attempts on it before switching is spending them on nothing.
 */
export function shouldRetryRefusal(
  result: RefusalCheckable,
  attempt: number,
  policy: RetryPolicy,
): RetryDecision {
  if (!isRefusal(result.content, result.finish_reason)) return FAIL;

  if (policy.fallback_model !== undefined) {
    return { decision: "fallback_model", model: policy.fallback_model };
  }
  if (attempt < policy.max_retries) return RETRY;
  return FAIL;
}

/**
 * Whether a completed response reads as a model refusal.
 *
 * Two signals. A provider that says so in `finish_reason` is believed outright,
 * whatever the content. Otherwise the content is matched against a phrase list,
 * but only when it is short — a long answer that happens to contain
 * "I cannot" is almost always discussing something rather than declining it.
 *
 * **The length limit is in bytes, not characters**, and that is faithful rather
 * than incidental: the Rust tested `content.len()`, which is the UTF-8 byte
 * length. TypeScript's `.length` is UTF-16 code units, so a naive port would
 * disagree on any non-ASCII response — a 269-character reply in a language
 * with two-byte characters is 529 bytes, past the limit for the Rust and well
 * inside it for a `.length` check. The fixture pins exactly that case.
 */
export function isRefusal(content: string, finishReason: string): boolean {
  if (finishReason === "content_filter" || finishReason === "refusal") return true;

  if (byteLength(content) > 500) return false;

  const lower = content.toLowerCase();
  return REFUSAL_PATTERNS.some((pattern) => lower.includes(pattern));
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Phrases that read as a refusal. Matched case-insensitively, as substrings. */
const REFUSAL_PATTERNS = [
  "i cannot",
  "i can't",
  "i'm unable to",
  "i am unable to",
  "i'm not able to",
  "i must decline",
  "i have to decline",
  "as an ai",
  "against my guidelines",
  "violates my",
  "i must refuse",
] as const;
