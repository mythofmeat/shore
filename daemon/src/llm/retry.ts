/**
 * Whether a failed turn is worth trying again.
 *
 * Ported from `crates/daemon/src/llm/retry.rs`, pinned by
 * `tests/llm_fixtures/llm_decisions_parity.json`.
 *
 * This sits *below* credential rotation and above nothing: it decides retry or
 * give up. The one structural rule is that credential-shaped failures never
 * consume retry budget — they short-circuit to `fail` so the multi-key wrapper
 * above sees the error immediately and can rotate. Retrying the same rejected
 * key three times first would spend the budget on the one thing that provably
 * cannot work.
 *
 * # On refusals
 *
 * An earlier version of this module also carried `shouldRetryRefusal` and
 * `isRefusal` — a phrase-matching detector over the completed response, and a
 * fallback-model arm to react to it. Both were removed by #16: no production
 * caller ever set a fallback model, nothing constructed the `refusal` error,
 * and the detector's own tests were its only callers. Providers still report
 * `finish_reason` values of `content_filter` and `refusal`, and those still
 * reach the conversation and the ledger untouched; there is simply nothing that
 * acts on them, which is what was true in practice before as well.
 *
 * # On logging
 *
 * The Rust warned on five of its branches. Only one survives here: the
 * credential short-circuit, because `fail` from a function called
 * `should_retry` is the one outcome a reader would not predict from the error
 * alone. The rest restated the branch they sat in. `tracing` is filtered off
 * by default and `console.warn` is not, so keeping them would have meant one
 * line per attempt in the daemon's output for ordinary transient failures.
 */

import { classifyCredentialFailure, shouldRotate } from "./credentials";
import { describeLlmError, type LlmError } from "./errors";

/** Retry policy. */
export interface RetryPolicy {
  /** Attempts before giving up. */
  max_retries: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { max_retries: 2 };

/** What to do after a failed response. */
export type RetryDecision = { decision: "retry" } | { decision: "fail" };

const RETRY: RetryDecision = { decision: "retry" };
const FAIL: RetryDecision = { decision: "fail" };

/**
 * Decide what to do after a failed request.
 *
 * Order matters: the credential check runs before the attempt ceiling, so
 * rotation is never delayed by retry budget.
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

  if (attempt >= policy.max_retries) return FAIL;

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

    // A policy decision, computed locally from the ledger. It will decide the
    // same way on every attempt, so retrying only makes the refusal slower.
    case "budget_blocked":
      return FAIL;
  }
}
