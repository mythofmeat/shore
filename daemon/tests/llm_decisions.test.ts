import { describe, expect, test } from "bun:test";
import { emptyTiming, emptyUsage } from "../src/llm/stream.ts";
import type { LlmError } from "../src/llm/errors";
import { shouldRetryError } from "../src/llm/retry";

const http = (status: number, body = ""): LlmError => ({ kind: "http_status", status, body });
const POLICY = { max_retries: 2 };
const retries = (e: LlmError, attempt = 0) =>
  shouldRetryError(e, attempt, POLICY).decision === "retry";

describe("which failures are worth reissuing", () => {
  test("a transient one is", () => {
    expect(retries({ kind: "transport", message: "socket hang up" })).toBe(true);
    expect(retries({ kind: "incomplete_stream" })).toBe(true);
    expect(retries({ kind: "provider", message: "overloaded" })).toBe(true);
    expect(
      retries({
        kind: "stream_errored",
        message: "upstream closed",
        usage: emptyUsage(),
        timing: emptyTiming(),
      }),
    ).toBe(true);
  });

  test("a server error and a rate limit are, a client mistake is not", () => {
    expect(retries(http(500))).toBe(true);
    expect(retries(http(503))).toBe(true);
    expect(retries(http(429, "slow down"))).toBe(true);
    expect(retries(http(408))).toBe(true);
    expect(retries(http(400, "bad request"))).toBe(false);
    expect(retries(http(404))).toBe(false);
  });

  test("a cancellation and a budget block never are", () => {
    expect(retries({ kind: "aborted", message: "cancelled" })).toBe(false);
    expect(retries({ kind: "budget_blocked", message: "weekly cap" })).toBe(false);
  });

  test("a malformed request or reply is not, because reissuing repeats it", () => {
    expect(retries({ kind: "serialize", message: "circular" })).toBe(false);
    expect(retries({ kind: "deserialize", message: "unexpected token" })).toBe(false);
    expect(retries({ kind: "missing_api_key", var: "K" })).toBe(false);
  });

  test("a credential failure fails fast, so rotation happens instead of retrying a dead key", () => {
    expect(retries(http(401))).toBe(false);
    expect(retries(http(402))).toBe(false);
  });

  test("the budget is spent per key: at the limit, nothing more is reissued", () => {
    const transient: LlmError = { kind: "transport", message: "socket hang up" };
    expect(retries(transient, 0)).toBe(true);
    expect(retries(transient, 1)).toBe(true);
    expect(retries(transient, 2)).toBe(false);
    expect(retries(transient, 99)).toBe(false);
  });

  test("a zero-retry policy reissues nothing", () => {
    expect(
      shouldRetryError({ kind: "transport", message: "x" }, 0, { max_retries: 0 }).decision,
    ).toBe("fail");
  });
});
