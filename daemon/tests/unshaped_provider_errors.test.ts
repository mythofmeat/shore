import { describe, expect, test } from "bun:test";

import { isAbortError, isTimeoutError } from "../src/llm/abort.ts";
import { classifyCredentialFailure, shouldRotate } from "../src/llm/credentials.ts";
import { describeError, toLlmError } from "../src/llm/errors.ts";
import { sanitizeReason, streamWithRetry } from "../src/llm/fallback.ts";
import { shouldRetryError } from "../src/llm/retry.ts";

function bunFetchTimeout(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

class ApiCallError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;
  constructor(status: number, body: string) {
    super(`provider returned ${status}`);
    this.name = "AI_APICallError";
    this.statusCode = status;
    this.responseBody = body;
  }
}

describe("a socket timeout is a transport failure, not a cancellation", () => {
  test("isAbortError no longer swallows it", () => {
    const err = bunFetchTimeout();
    expect(isAbortError(err)).toBe(false);
    expect(isTimeoutError(err)).toBe(true);
  });

  test("a real cancellation is still an abort", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
    expect(isTimeoutError(controller.signal.reason)).toBe(false);
  });

  test("it normalizes to a retryable transport error", () => {
    const error = toLlmError(bunFetchTimeout());
    expect(error.kind).toBe("transport");
    expect(shouldRetryError(bunFetchTimeout(), 0, { max_retries: 2 })).toEqual({
      decision: "retry",
    });
  });

  test("streamWithRetry reissues it up to the configured limit", async () => {
    let calls = 0;
    const thrown = await streamWithRetry(
      async () => {
        calls += 1;
        throw bunFetchTimeout();
      },
      { maxRetries: 2, backoffBaseMs: 1 },
      undefined,
      async () => {},
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((thrown as Error).name).toBe("TimeoutError");
    expect(calls).toBe(3);
  });

  test("a caller's own cancellation still stops the loop after one attempt", async () => {
    const controller = new AbortController();
    let calls = 0;
    const thrown = await streamWithRetry(
      async () => {
        calls += 1;
        controller.abort();
        throw bunFetchTimeout();
      },
      { maxRetries: 2, backoffBaseMs: 1 },
      undefined,
      async () => {},
      { signal: controller.signal },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((thrown as Error).name).toBe("TimeoutError");
    expect(calls).toBe(1);
  });
});

describe("an error that does not carry shore's own shape", () => {
  test("is never reported as a credential failure", () => {
    for (const raw of [
      new Error("socket hang up"),
      bunFetchTimeout(),
      new ApiCallError(500, "upstream exploded"),
      "a bare string",
      42,
    ]) {
      const kind = classifyCredentialFailure("moonshotai", raw);
      expect(shouldRotate(kind)).toBe(false);
    }
  });

  test("is retried rather than discarded", () => {
    expect(shouldRetryError(new Error("socket hang up"), 0, { max_retries: 2 })).toEqual({
      decision: "retry",
    });
  });

  test("keeps its own text instead of becoming (undefined)", () => {
    expect(describeError(toLlmError(new Error("socket hang up")))).toContain("socket hang up");
    expect(describeError(toLlmError(bunFetchTimeout()))).toContain("timed out");
  });

  test("sanitizeReason carries it too, so a fallback warning says what went wrong", () => {
    expect(sanitizeReason(new Error("socket hang up"))).toBe("transport error: socket hang up");
    expect(sanitizeReason(bunFetchTimeout())).toContain("timed out");
  });

  test("a long transport message is still truncated without splitting a character", () => {
    const reason = sanitizeReason(new Error(`${"x".repeat(199)}\u4E16${"y".repeat(400)}`));
    expect(reason).not.toContain("\uFFFD");
    expect(Buffer.from(reason, "utf8").length).toBeLessThanOrEqual(220);
  });
});

describe("SDK errors are read for their status code", () => {
  test("the Vercel AI SDK's statusCode becomes an http_status", () => {
    const error = toLlmError(new ApiCallError(429, "rate limited"));
    expect(error).toMatchObject({ kind: "http_status", status: 429, body: "rate limited" });
  });

  test("the OpenAI SDK's status becomes an http_status", () => {
    const raw = Object.assign(new Error("Internal server error"), { status: 500 });
    expect(toLlmError(raw)).toMatchObject({ kind: "http_status", status: 500 });
  });

  test("a 429 retries and a 400 does not", () => {
    const policy = { max_retries: 2 };
    expect(shouldRetryError(new ApiCallError(429, "slow down"), 0, policy)).toEqual({
      decision: "retry",
    });
    expect(shouldRetryError(new ApiCallError(400, "bad request"), 0, policy)).toEqual({
      decision: "fail",
    });
  });

  test("Moonshot's permanent quota 429 fails without retrying", () => {
    const body = JSON.stringify({
      error: {
        message: "Your account is suspended due to insufficient balance",
        type: "exceeded_current_quota_error",
      },
    });
    const error = new ApiCallError(429, body);

    expect(classifyCredentialFailure("moonshotai", error)).toBe("quota_exhausted");
    expect(shouldRetryError(error, 0, { max_retries: 2 })).toEqual({ decision: "fail" });
  });

  test("a 401 still rotates the key rather than retrying it", () => {
    const kind = classifyCredentialFailure("moonshotai", new ApiCallError(401, "bad key"));
    expect(kind).toBe("invalid_key");
    expect(shouldRotate(kind)).toBe(true);
  });
});
