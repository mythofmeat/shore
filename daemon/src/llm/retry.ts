import { shoreLog } from "../log.ts";

import { classifyCredentialFailure, shouldRotate } from "./credentials";
import { describeError, describeLlmError, toLlmError } from "./errors";

export interface RetryPolicy {
  max_retries: number;
}

export type RetryDecision = { decision: "retry" } | { decision: "fail" };

const RETRY: RetryDecision = { decision: "retry" };
const FAIL: RetryDecision = { decision: "fail" };

export function shouldRetryError(
  raw: unknown,
  attempt: number,
  policy: RetryPolicy,
): RetryDecision {
  const error = toLlmError(raw);
  if (error.kind === "aborted") return FAIL;

  const credKind = classifyCredentialFailure("", error);
  if (shouldRotate(credKind)) {
    shoreLog.warn(
      `shore: ${credKind} on attempt ${attempt}, failing fast so multi-key fallback can ` +
        `rotate the key: ${describeLlmError(error)}`,
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
      return error.status >= 500 || error.status === 429 || error.status === 408 ? RETRY : FAIL;

    case "serialize":
    case "deserialize":
    case "missing_api_key":
      return FAIL;

    case "provider":
      return RETRY;

    case "budget_blocked":
      return FAIL;

    default:
      shoreLog.warn(
        `shore: unclassifiable provider failure on attempt ${attempt}, retrying as ` +
          `transport: ${describeError(error)}`,
      );
      return RETRY;
  }
}
