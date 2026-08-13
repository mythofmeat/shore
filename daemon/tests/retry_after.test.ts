import { describe, expect, test } from "bun:test";

import { retryAfterHint, retryDelayMs, streamWithRetry } from "../src/llm/fallback.ts";
import type { LlmError } from "../src/llm/errors.ts";
import { parseRetryAfterMs, rateLimitSnapshot, retryAfterMsFromError } from "../src/llm/retry_after.ts";

const NOW = Date.parse("2026-08-11T11:19:00Z");
const now = () => NOW;

describe("parseRetryAfterMs", () => {
  test("Anthropic's millisecond variant wins over the seconds one", () => {
    const headers = new Headers({ "retry-after-ms": "1500", "retry-after": "60" });
    expect(parseRetryAfterMs(headers, now)).toBe(1500);
  });

  test("a bare seconds value, including a fractional one", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "3" }), now)).toBe(3000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }), now)).toBe(1500);
  });

  test("an HTTP date becomes the remaining interval, never negative", () => {
    expect(parseRetryAfterMs({ "Retry-After": "Tue, 11 Aug 2026 11:19:18 GMT" }, now)).toBe(18_000);
    expect(parseRetryAfterMs({ "Retry-After": "Tue, 11 Aug 2026 11:18:00 GMT" }, now)).toBe(0);
  });

  test("no header and unparseable values yield nothing", () => {
    expect(parseRetryAfterMs(new Headers(), now)).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "soon" }, now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });

  test("plain objects are read case-insensitively, as header arrays too", () => {
    expect(parseRetryAfterMs({ "RETRY-AFTER-MS": "250" }, now)).toBe(250);
    expect(parseRetryAfterMs([["Retry-After", "2"]], now)).toBe(2000);
  });
});

describe("retryAfterMsFromError", () => {
  test("reads the headers an SDK APIError carries", () => {
    const err = Object.assign(new Error("429 rate_limit_error"), {
      status: 429,
      headers: new Headers({ "retry-after": "7" }),
    });
    expect(retryAfterMsFromError(err, now)).toBe(7000);
  });

  test("an error without headers is silent rather than wrong", () => {
    expect(retryAfterMsFromError(new Error("nope"), now)).toBeUndefined();
  });
});

describe("the hint reaches the backoff", () => {
  test("a carried retry_after_ms overrides the exponential schedule", () => {
    const error: LlmError = {
      kind: "http_status",
      status: 429,
      body: "slow down",
      retry_after_ms: 9000,
    };
    expect(retryAfterHint(error)).toBe(9000);
    expect(retryDelayMs({ maxRetries: 2, backoffBaseMs: 500 }, 0, {
      retryAfterMs: retryAfterHint(error) ?? 0,
      random: () => 0,
    })).toBe(9000);
  });

  test("streamWithRetry waits the server's window, not its own 500ms", async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      streamWithRetry(
        async () => {
          calls += 1;
          throw {
            kind: "http_status",
            status: 429,
            body: "rate_limit_error",
            retry_after_ms: 12_000,
          } satisfies LlmError;
        },
        { maxRetries: 2, backoffBaseMs: 500 },
        undefined,
        async (ms) => {
          delays.push(ms);
        },
        { random: () => 0 },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(3);
    expect(delays).toEqual([12_000, 12_000]);
  });
});

describe("rateLimitSnapshot", () => {
  test("reads the quota headers Anthropic sends on every response", () => {
    const headers = new Headers({
      "anthropic-ratelimit-requests-limit": "10000",
      "anthropic-ratelimit-requests-remaining": "9999",
      "anthropic-ratelimit-requests-reset": "2026-08-11T11:19:18Z",
      "anthropic-ratelimit-input-tokens-limit": "10000000",
      "anthropic-ratelimit-input-tokens-remaining": "9993000",
    });
    expect(rateLimitSnapshot(headers)).toEqual({
      requests_limit: 10000,
      requests_remaining: 9999,
      input_tokens_limit: 10_000_000,
      input_tokens_remaining: 9_993_000,
      resets_at: "2026-08-11T11:19:18Z",
    });
  });

  test("a response with no quota headers reports nothing rather than zeroes", () => {
    expect(rateLimitSnapshot(new Headers({ "content-type": "application/json" }))).toBeUndefined();
  });
});
