import { describe, expect, test } from "bun:test";

import { isAbortError } from "../src/llm/abort.ts";
import type { LlmError } from "../src/llm/errors.ts";
import { describeLlmError, isLlmError } from "../src/llm/errors.ts";
import { streamWithRetry } from "../src/llm/fallback.ts";
import { shouldRetryError } from "../src/llm/retry.ts";
import { StreamAccumulator } from "../src/llm/stream.ts";
import { streamErrorEvent } from "../src/llm/types.ts";
import type { StreamEvent, Usage } from "../src/llm/types.ts";

const usage: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

class ApiUserAbortError extends Error {}
Object.defineProperty(ApiUserAbortError, "name", { value: "APIUserAbortError" });

describe("isAbortError", () => {
  test("recognises the DOM abort a fetch signal produces", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  test("recognises the Anthropic SDK's abort, which does not set .name", () => {
    const err = new ApiUserAbortError("Request was aborted.");
    expect(err.name).toBe("Error");
    expect(isAbortError(err)).toBe(true);
  });

  test("does not claim an ordinary failure", () => {
    expect(isAbortError(new Error("overloaded_error"))).toBe(false);
    expect(isAbortError("Request was aborted.")).toBe(false);
  });
});

describe("the abort survives the flattening chain", () => {
  test("cancel -> stream event -> accumulator -> retry decision is FAIL", () => {
    const event = streamErrorEvent(
      new ApiUserAbortError("Request was aborted."),
      usage,
      0,
      0,
      () => 1,
    );
    expect(event).toMatchObject({ type: "error", aborted: true });

    const step = new StreamAccumulator().handle(event, false, () => {});
    expect(step.kind).toBe("error");
    const error = (step as { error: LlmError }).error;
    expect(error.kind).toBe("aborted");
    expect(isLlmError(error)).toBe(true);
    expect(describeLlmError(error)).toContain("cancelled");

    for (const attempt of [0, 1, 2]) {
      expect(shouldRetryError(error, attempt, { max_retries: 2 })).toEqual({ decision: "fail" });
    }
  });

  test("a genuine stream failure still classifies as retryable", () => {
    const event = streamErrorEvent(new Error("overloaded_error"), usage, 0, 0, () => 1);
    expect((event as { aborted?: boolean }).aborted).toBeUndefined();

    const step = new StreamAccumulator().handle(event as StreamEvent, false, () => {});
    const error = (step as { error: LlmError }).error;
    expect(error.kind).toBe("stream_errored");
    expect(shouldRetryError(error, 0, { max_retries: 2 })).toEqual({ decision: "retry" });
  });
});

describe("streamWithRetry", () => {
  test("an aborted error is not reissued at full price", async () => {
    let calls = 0;
    await expect(
      streamWithRetry(
        async () => {
          calls += 1;
          throw { kind: "aborted", message: "Request was aborted." } satisfies LlmError;
        },
        { maxRetries: 2, backoffBaseMs: 1 },
        undefined,
        async () => {},
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toBe(1);
  });

  test("an already-aborted signal stops the loop even if classification missed it", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      streamWithRetry(
        async () => {
          calls += 1;
          controller.abort();
          throw { kind: "stream_errored", message: "Request was aborted." } as LlmError;
        },
        { maxRetries: 2, backoffBaseMs: 1 },
        undefined,
        async () => {},
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ kind: "stream_errored" });
    expect(calls).toBe(1);
  });
});
