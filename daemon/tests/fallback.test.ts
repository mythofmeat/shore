import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { emptyTiming, emptyUsage } from "../src/llm/stream.ts";

import { isAbortError } from "../src/llm/abort.ts";
import { buildWarningMessage, llmHttpStatus, missingKeyReason, retryAfterHint, retryDelayMs, sanitizeReason, streamWithCredentialFallback, streamWithRetry, type FallbackEvent, type RetrySettings } from "../src/llm/fallback";
import { CREDENTIAL_FAILURE_KINDS, type KeyCandidate } from "../src/llm/credentials";
import type { LlmError } from "../src/llm/errors";
import { rejectionOf } from "./support/outcome.ts";

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

const cand = (name: string, env: string, warn = false): KeyCandidate => ({
  name,
  env,
  warn_on_fallback: warn,
});

describe("a fallback reason names the failure without leaking the credential", () => {
  test("an HTTP failure gives its status and withholds the body", () => {
    const error: LlmError = {
      kind: "http_status",
      status: 401,
      body: '{"error":"bad key sk-abc123"}',
    };
    expect(sanitizeReason(error)).toBe("HTTP 401");
    expect(sanitizeReason(error)).not.toContain("sk-abc123");
    expect(llmHttpStatus(error)).toBe(401);
  });

  test("a missing key names the variable, because that is the fix", () => {
    expect(sanitizeReason({ kind: "missing_api_key", var: "SOME_KEY" })).toBe(
      'env "SOME_KEY" not set',
    );
    expect(missingKeyReason("SOME_KEY")).toBe('env "SOME_KEY" unset or empty');
  });

  test("a key stored by the daemon is named as such, not as an environment variable", () => {
    expect(missingKeyReason('stored key "work"')).toBe('stored key "work" not saved');
    expect(sanitizeReason({ kind: "missing_api_key", var: 'stored key "work"' })).toBe('stored key "work" not saved');
  });

  test("every other failure carries its own message", () => {
    const cases: [LlmError, string][] = [
      [{ kind: "provider", message: "quota exceeded" }, "quota exceeded"],
      [{ kind: "transport", message: "socket hang up" }, "socket hang up"],
      [{ kind: "serialize", message: "circular" }, "circular"],
      [{ kind: "deserialize", message: "unexpected token" }, "unexpected token"],
      [{ kind: "budget_blocked", message: "weekly cap reached" }, "weekly cap reached"],
      [
        {
          kind: "stream_errored",
          message: "upstream closed",
          usage: emptyUsage(),
          timing: emptyTiming(),
        },
        "upstream closed",
      ],
    ];
    for (const [error, text] of cases) {
      expect(sanitizeReason(error), error.kind).toContain(text);
    }
  });

  test("a failure with nothing to say still says which kind it was", () => {
    expect(sanitizeReason({ kind: "incomplete_stream" })).toBe("stream ended without done event");
    expect(sanitizeReason({ kind: "aborted", message: "x" })).toBe("request cancelled");
  });

  test("a long message is capped, and never mid-character", () => {
    const wide = `${"x".repeat(199)}\u4E16${"y".repeat(400)}`;
    const reason = sanitizeReason({ kind: "provider", message: wide });
    expect(byteLen(reason)).toBeLessThanOrEqual(220);
    expect(reason).not.toContain("\uFFFD");
    expect(reason.endsWith("\u2026")).toBe(true);

    const exact = "x".repeat(200);
    expect(sanitizeReason({ kind: "provider", message: exact })).toContain(exact);
  });
});

describe("a rotation warning", () => {

  test("never leaks an environment variable name", () => {
    for (const kind of CREDENTIAL_FAILURE_KINDS) {
      const message = buildWarningMessage(
        "openrouter",
        cand("primary", "PRIMARY_KEY", true),
        cand("backup", "BACKUP_KEY"),
        kind,
      );
      expect(message, kind).not.toContain("PRIMARY_KEY");
      expect(message, kind).not.toContain("BACKUP_KEY");
    }
  });
});

describe("credential rotation", () => {
  function harness(env: Record<string, string>) {
    const events: FallbackEvent[] = [];
    const tried: string[] = [];
    return {
      events,
      tried,
      readEnv: (c: KeyCandidate) => env[c.env],
      hooks: { record: (e: FallbackEvent) => events.push(e) },
      attempt(outcomes: Record<string, LlmError | "ok">) {
        return async (_apiKey: string, c: KeyCandidate) => {
          tried.push(c.name);
          const outcome = outcomes[c.name];
          if (outcome === undefined || outcome === "ok") return `served by ${c.name}`;
          throw outcome;
        };
      },
    };
  }

  test("a credential failure rotates to the next key", async () => {
    const h = harness({ A: "sk-a", B: "sk-b" });
    const got = await streamWithCredentialFallback(
      "openrouter",
      [cand("first", "A"), cand("second", "B")],
      h.readEnv,
      h.attempt({ first: { kind: "http_status", status: 401, body: "nope" } }),
      h.hooks,
    );
    expect(got).toBe("served by second");
    expect(h.tried).toEqual(["first", "second"]);
    expect(h.events[0]?.from.name).toBe("first");
    expect(h.events[0]?.to?.name).toBe("second");
  });

  test("a non-credential failure does not rotate", async () => {
    const h = harness({ A: "sk-a", B: "sk-b" });
    expect(
      await rejectionOf(streamWithCredentialFallback(
        "openrouter",
        [cand("first", "A"), cand("second", "B")],
        h.readEnv,
        h.attempt({ first: { kind: "http_status", status: 500, body: "boom" } }),
        h.hooks,
      )),
    ).toMatchObject({ kind: "http_status", status: 500 });
    expect(h.tried).toEqual(["first"]);
  });
});

describe("the wait before a retry", () => {
  const settings = (extra: Partial<RetrySettings> = {}): RetrySettings => ({ maxRetries: 3, backoffBaseMs: 1000, ...extra });

  test("doubles with each attempt and adds up to the jitter fraction on top, within the ceiling", () => {
    expect(retryDelayMs(settings({ jitterFraction: 0.5 }), 0, { random: () => 1 })).toBe(1500);
    expect(retryDelayMs(settings({ jitterFraction: 0.5 }), 1, { random: () => 0 })).toBe(2000);
    expect(retryDelayMs(settings({ backoffMaxMs: 1200, jitterFraction: 0.5 }), 0, { random: () => 1 })).toBe(1200);
    expect(retryDelayMs(settings({ jitterFraction: 0 }), 0, { random: () => 1 })).toBe(1000);
    expect(retryDelayMs(settings({ jitterFraction: -1 }), 0, { random: () => 1 })).toBe(1000);
    expect(retryDelayMs(settings({ backoffBaseMs: 0, jitterFraction: 0 }), 0, { random: () => 1 })).toBe(0);
  });

  test("at or past the ceiling it waits the ceiling less up to the jitter fraction, and never less than nothing", () => {
    expect(retryDelayMs(settings({ backoffMaxMs: 1000, jitterFraction: 0.5 }), 0, { random: () => 0.5 })).toBe(750);
    expect(retryDelayMs(settings({ backoffMaxMs: 1000, jitterFraction: 0.5 }), 0, { retryAfterMs: 5000, random: () => 0.5 })).toBe(750);
    expect(retryDelayMs(settings({ backoffMaxMs: 1000, jitterFraction: 2 }), 0, { random: () => 1 })).toBe(0);
    expect(retryDelayMs(settings({ backoffMaxMs: 0 }), 0, { random: () => 0 })).toBe(0);
    expect(retryDelayMs(settings({ backoffMaxMs: -5 }), 0, { random: () => 0 })).toBe(0);
  });

  test("a carried hint counts only as a finite, non-negative number, and otherwise the error's headers are read", () => {
    expect(retryAfterHint({ retry_after_ms: 0 })).toBe(0);
    expect(retryAfterHint({ retry_after_ms: 250 })).toBe(250);
    for (const carried of [-5, Number.NaN, Number.POSITIVE_INFINITY, "250"]) expect(retryAfterHint({ retry_after_ms: carried })).toBeUndefined();
    expect(retryAfterHint(Object.assign(new Error("429"), { headers: new Headers({ "retry-after": "7" }) }))).toBe(7000);
    expect(retryAfterHint(null)).toBeUndefined();
    expect(retryAfterHint("429")).toBeUndefined();
  });
});

describe("retrying a failed attempt", () => {
  const overloaded: LlmError = { kind: "http_status", status: 529, body: "overloaded_error" };
  const settings: RetrySettings = { maxRetries: 3, backoffBaseMs: 100, jitterFraction: 0 };
  const withinLimit = (_error: LlmError, attempt: number, max: number): boolean => attempt < max;

  test("each retry is announced with its attempt and wait, and the stop signal is let go once the attempts end", async () => {
    const stop = new AbortController();
    const waits: number[] = [];
    const announced: Array<readonly [LlmError, number, number]> = [];
    let calls = 0;
    const result = await streamWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw overloaded;
        return await Promise.resolve("done");
      },
      settings,
      withinLimit,
      (ms) => { waits.push(ms); return Promise.resolve(); },
      { signal: stop.signal, onRetry: (error, attempt, delay) => { announced.push([error, attempt, delay]); } },
    );
    expect(result).toBe("done");
    expect(waits).toEqual([100, 200]);
    expect(announced).toEqual([[overloaded, 0, 100], [overloaded, 1, 200]]);
    expect(getEventListeners(stop.signal, "abort")).toEqual([]);
  });

  test("a stop during the wait ends it at once, and one that comes while deciding to retry skips the wait", async () => {
    const during = new AbortController();
    let attempts = 0;
    const waited = await rejectionOf(streamWithRetry(
      async () => { attempts += 1; await Promise.resolve(); throw overloaded; },
      settings,
      withinLimit,
      () => { during.abort(); return new Promise<void>(() => {}); },
      { signal: during.signal },
    ));
    expect(isAbortError(waited)).toBe(true);
    expect(attempts).toBe(1);

    const deciding = new AbortController();
    const slept: number[] = [];
    let tries = 0;
    const skipped = await rejectionOf(streamWithRetry(
      async () => { tries += 1; await Promise.resolve(); throw overloaded; },
      settings,
      withinLimit,
      (ms) => { slept.push(ms); return Promise.resolve(); },
      { signal: deciding.signal, onRetry: () => { deciding.abort(); } },
    ));
    expect(isAbortError(skipped)).toBe(true);
    expect(slept).toEqual([]);
    expect(tries).toBe(1);
  });

  test("an abort thrown by the attempt itself is never retried, whatever the retry rule says", async () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    let calls = 0;
    expect(await rejectionOf(streamWithRetry(
      () => { calls += 1; return Promise.reject(aborted); },
      settings,
      withinLimit,
      () => Promise.resolve(),
    ))).toBe(aborted);
    expect(calls).toBe(1);
  });
});
