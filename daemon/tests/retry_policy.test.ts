import { describe, expect, test } from "bun:test";

import { AbortError } from "../src/llm/abort.ts";
import type { LlmError } from "../src/llm/errors.ts";
import {
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_JITTER_FRACTION,
  retryDelayMs,
  sleepUnlessAborted,
  streamWithRetry,
} from "../src/llm/fallback.ts";

const transient: LlmError = { kind: "http_status", status: 500, body: "x" };

describe("retryDelayMs", () => {
  test("a zero random draw reproduces the bare exponential schedule", () => {
    const settings = { maxRetries: 5, backoffBaseMs: 100 };
    const draws = [0, 1, 2, 3].map((attempt) =>
      retryDelayMs(settings, attempt, { random: () => 0 }),
    );
    expect(draws).toEqual([100, 200, 400, 800]);
  });

  test("jitter only ever adds, and stays within the configured fraction", () => {
    const settings = { maxRetries: 5, backoffBaseMs: 1000 };
    const full = retryDelayMs(settings, 0, { random: () => 1 });
    expect(full).toBe(1000 + 1000 * DEFAULT_JITTER_FRACTION);
    expect(retryDelayMs(settings, 0, { random: () => 0.5 })).toBeGreaterThan(1000);
    expect(retryDelayMs(settings, 0, { random: () => 0.5 })).toBeLessThan(full);
  });

  test("the ceiling clamps a schedule that would otherwise run for minutes", () => {
    const settings = { maxRetries: 12, backoffBaseMs: 500 };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(retryDelayMs(settings, attempt, { random: () => 1 })).toBeLessThanOrEqual(
        DEFAULT_BACKOFF_MAX_MS,
      );
    }
    expect(retryDelayMs(settings, 19, { random: () => 0 })).toBe(DEFAULT_BACKOFF_MAX_MS);
  });

  test("at the ceiling jitter spreads downward so clients do not collapse on one instant", () => {
    const settings = { maxRetries: 12, backoffBaseMs: 500, backoffMaxMs: 10_000 };
    expect(retryDelayMs(settings, 19, { random: () => 1 })).toBe(
      10_000 - 10_000 * DEFAULT_JITTER_FRACTION,
    );
  });

  test("a Retry-After hint is a floor, never a cap", () => {
    const settings = { maxRetries: 5, backoffBaseMs: 100 };
    expect(retryDelayMs(settings, 0, { retryAfterMs: 4000, random: () => 0 })).toBe(4000);
    expect(retryDelayMs(settings, 0, { retryAfterMs: 4000, random: () => 1 })).toBeGreaterThan(4000);
    expect(retryDelayMs(settings, 9, { retryAfterMs: 10, random: () => 0 })).toBe(
      DEFAULT_BACKOFF_MAX_MS,
    );
  });
});

describe("sleepUnlessAborted", () => {
  test("an abort mid-backoff rejects instead of waiting the timer out", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleepUnlessAborted((ms) => Bun.sleep(ms), 30_000, controller.signal);
    controller.abort();
    expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an already-aborted signal never sleeps at all", async () => {
    const controller = new AbortController();
    controller.abort();
    let slept = false;
    expect(
      sleepUnlessAborted(async () => {
        slept = true;
      }, 5, controller.signal),
    ).rejects.toBeInstanceOf(AbortError);
    expect(slept).toBe(false);
  });

  test("without a signal the sleep runs to completion", async () => {
    let slept = 0;
    await sleepUnlessAborted(async (ms) => {
      slept = ms;
    }, 7);
    expect(slept).toBe(7);
  });
});

describe("streamWithRetry backoff cancellation", () => {
  test("aborting during the backoff ends the retry loop", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = streamWithRetry(
      async () => {
        calls += 1;
        throw transient;
      },
      { maxRetries: 5, backoffBaseMs: 10_000 },
      undefined,
      (ms) => Bun.sleep(ms),
      { signal: controller.signal, random: () => 0 },
    );
    await Bun.sleep(5);
    controller.abort();
    expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
  });
});
