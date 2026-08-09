import { classifyCredentialFailure, shouldRotate } from "./credentials";
import { describeLlmError, type LlmError } from "./errors";

export interface RetryPolicy {
  max_retries: number;
}

export type RetryDecision = { decision: "retry" } | { decision: "fail" };

const RETRY: RetryDecision = { decision: "retry" };
const FAIL: RetryDecision = { decision: "fail" };

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
    case "transport":
    case "incomplete_stream":
    case "stream_errored":
      return RETRY;

    case "http_status":
      return error.status >= 500 || error.status === 429 ? RETRY : FAIL;

    case "serialize":
    case "deserialize":
    case "missing_api_key":
      return FAIL;

    case "provider":
      return RETRY;

    case "budget_blocked":
      return FAIL;
  }
}
