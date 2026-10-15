import { describe, expect, test } from "bun:test";

import { retryAfterHint, retryDelayMs, streamWithRetry } from "../src/llm/fallback.ts";
import type { LlmError } from "../src/llm/errors.ts";
import { parseRetryAfterMs, retryAfterMsFromError } from "../src/llm/retry_after.ts";
import { rejectionOf } from "./support/outcome.ts";

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
    expect(
      await rejectionOf(streamWithRetry(
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
      )),
    ).toMatchObject({ status: 429 });
    expect(calls).toBe(3);
    expect(delays).toEqual([12_000, 12_000]);
  });
});
