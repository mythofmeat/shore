import { describe, expect, test } from "bun:test";
import { emptyTiming, emptyUsage } from "../src/llm/stream.ts";

import {
  backoffDelayMs,
  buildWarningMessage,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_RETRIES,
  llmHttpStatus,
  missingKeyReason,
  sanitizeReason,
  streamWithCredentialFallback,
  streamWithRetry,
  type FallbackEvent,
} from "../src/llm/fallback";
import { CREDENTIAL_FAILURE_KINDS, type KeyCandidate } from "../src/llm/credentials";
import type { LlmError } from "../src/llm/errors";

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
  test("names both keys and the provider, for every kind", () => {
    for (const kind of CREDENTIAL_FAILURE_KINDS) {
      const message = buildWarningMessage(
        "openrouter",
        cand("primary", "PRIMARY_KEY", true),
        cand("backup", "BACKUP_KEY"),
        kind,
      );
      expect(message, kind).toContain("openrouter");
      expect(message, kind).toContain('"primary"');
      expect(message, kind).toContain('"backup"');
    }
  });

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

describe("backoff", () => {
  test("doubles with each attempt from the configured base", () => {
    expect([0, 1, 2, 3, 4].map((n) => backoffDelayMs(500, n))).toEqual([500, 1000, 2000, 4000, 8000]);
    expect([0, 1, 2].map((n) => backoffDelayMs(1, n))).toEqual([1, 2, 4]);
  });

  test("saturates rather than wrapping", () => {
    expect(backoffDelayMs(500, 64)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(backoffDelayMs(500, 64)).toBe(backoffDelayMs(500, 128));
  });

  test("the shipped defaults are a real schedule, not zero", () => {
    expect(DEFAULT_MAX_RETRIES).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF_BASE_MS).toBeGreaterThan(0);
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

  test("the first working key serves the request", async () => {
    const h = harness({ A: "sk-a", B: "sk-b" });
    const got = await streamWithCredentialFallback(
      "openrouter",
      [cand("first", "A"), cand("second", "B")],
      h.readEnv,
      h.attempt({}),
      h.hooks,
    );
    expect(got).toBe("served by first");
    expect(h.tried).toEqual(["first"]);
    expect(h.events).toHaveLength(0);
  });

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
      streamWithCredentialFallback(
        "openrouter",
        [cand("first", "A"), cand("second", "B")],
        h.readEnv,
        h.attempt({ first: { kind: "http_status", status: 500, body: "boom" } }),
        h.hooks,
      ),
    ).rejects.toMatchObject({ kind: "http_status", status: 500 });
    expect(h.tried).toEqual(["first"]);
  });

  test("an interrupted stream does not rotate", async () => {
    const h = harness({ A: "sk-a", B: "sk-b" });
    expect(
      streamWithCredentialFallback(
        "openrouter",
        [cand("first", "A"), cand("second", "B")],
        h.readEnv,
        h.attempt({ first: { kind: "incomplete_stream" } }),
        h.hooks,
      ),
    ).rejects.toMatchObject({ kind: "incomplete_stream" });
    expect(h.tried).toEqual(["first"]);
  });

  test("an unset variable rotates without touching the network", async () => {
    const h = harness({ B: "sk-b" });
    const got = await streamWithCredentialFallback(
      "openrouter",
      [cand("first", "A"), cand("second", "B")],
      h.readEnv,
      h.attempt({}),
      h.hooks,
    );
    expect(got).toBe("served by second");
    expect(h.tried).toEqual(["second"]);
    expect(h.events[0]?.kind).toBe("missing_key");
    expect(h.events[0]?.reason).toBe(missingKeyReason("A"));
  });

  test("exhausting every key surfaces the last classified failure", async () => {
    const h = harness({ A: "sk-a", B: "sk-b" });
    expect(
      streamWithCredentialFallback(
        "openrouter",
        [cand("first", "A"), cand("second", "B")],
        h.readEnv,
        h.attempt({
          first: { kind: "http_status", status: 401, body: "a" },
          second: { kind: "http_status", status: 402, body: "b" },
        }),
        h.hooks,
      ),
    ).rejects.toMatchObject({ kind: "http_status", status: 402 });
    expect(h.tried).toEqual(["first", "second"]);
  });

  test("no candidates at all names the provider", async () => {
    const h = harness({});
    expect(
      streamWithCredentialFallback("openrouter", [], h.readEnv, h.attempt({}), h.hooks),
    ).rejects.toMatchObject({
      kind: "missing_api_key",
      var: "provider 'openrouter' has no enabled keys",
    });
  });

  test("the warning fires only for a key that opted in, and only with somewhere to go", async () => {
    const h = harness({ A: "sk-a", B: "sk-b" });
    await streamWithCredentialFallback(
      "openrouter",
      [cand("first", "A", true), cand("second", "B")],
      h.readEnv,
      h.attempt({ first: { kind: "http_status", status: 401, body: "x" } }),
      h.hooks,
    );
    expect(h.events[0]?.warning).toContain("was rejected");

    const quiet = harness({ A: "sk-a", B: "sk-b" });
    await streamWithCredentialFallback(
      "openrouter",
      [cand("first", "A"), cand("second", "B")],
      quiet.readEnv,
      quiet.attempt({ first: { kind: "http_status", status: 401, body: "x" } }),
      quiet.hooks,
    );
    expect(quiet.events).toHaveLength(1);
    expect(quiet.events[0]?.warning).toBeUndefined();
  });

  test("the last key's failure carries no warning, only the error", async () => {
    const h = harness({ A: "sk-a" });
    expect(
      streamWithCredentialFallback(
        "openrouter",
        [cand("only", "A", true)],
        h.readEnv,
        h.attempt({ only: { kind: "http_status", status: 401, body: "x" } }),
        h.hooks,
      ),
    ).rejects.toMatchObject({ kind: "http_status", status: 401 });
    expect(h.events[0]?.warning).toBeUndefined();
  });

  test("rotation is not sticky across calls", async () => {
    const candidates = [cand("first", "A"), cand("second", "B")];
    const env: Record<string, string> = { B: "sk-b" };
    const readEnv = (c: KeyCandidate) => env[c.env];
    const tried: string[] = [];
    const attempt = async (_k: string, c: KeyCandidate) => {
      tried.push(c.name);
      return c.name;
    };
    const hooks = { record: () => {} };

    await streamWithCredentialFallback("p", candidates, readEnv, attempt, hooks);
    env.A = "sk-a-recovered";
    await streamWithCredentialFallback("p", candidates, readEnv, attempt, hooks);

    expect(tried).toEqual(["second", "first"]);
  });
});

describe("transient retry", () => {
  test("a transient failure is retried and can succeed", async () => {
    const delays: number[] = [];
    let calls = 0;
    const got = await streamWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw { kind: "http_status", status: 500, body: "x" } as LlmError;
        return "ok";
      },
      { maxRetries: 3, backoffBaseMs: 100 },
      undefined,
      async (ms) => {
        delays.push(ms);
      },
      { random: () => 0 },
    );
    expect(got).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  test("retries are bounded and the last error escapes", async () => {
    let calls = 0;
    expect(
      streamWithRetry(
        async () => {
          calls += 1;
          throw { kind: "http_status", status: 500, body: "x" } as LlmError;
        },
        { maxRetries: 2, backoffBaseMs: 1 },
        undefined,
        async () => {},
      ),
    ).rejects.toMatchObject({ kind: "http_status", status: 500 });
    expect(calls).toBe(3);
  });

  test("a credential failure fails fast so rotation can happen", async () => {
    let calls = 0;
    expect(
      streamWithRetry(
        async () => {
          calls += 1;
          throw { kind: "http_status", status: 401, body: "x" } as LlmError;
        },
        { maxRetries: 5, backoffBaseMs: 1 },
        undefined,
        async () => {},
      ),
    ).rejects.toMatchObject({ kind: "http_status", status: 401 });
    expect(calls).toBe(1);
  });

  test("the two layers compose: retries are spent per key, not per request", async () => {
    const attempts: string[] = [];
    const got = await streamWithCredentialFallback(
      "openrouter",
      [cand("first", "A"), cand("second", "B")],
      (c) => ({ A: "sk-a", B: "sk-b" })[c.env],
      async (_apiKey, c) =>
        streamWithRetry(
          async () => {
            attempts.push(c.name);
            if (c.name === "first") throw { kind: "http_status", status: 401, body: "x" } as LlmError;
            if (attempts.filter((a) => a === "second").length < 2) {
              throw { kind: "http_status", status: 503, body: "x" } as LlmError;
            }
            return `served by ${c.name}`;
          },
          { maxRetries: 3, backoffBaseMs: 1 },
          undefined,
          async () => {},
        ),
      { record: () => {} },
    );
    expect(got).toBe("served by second");
    expect(attempts).toEqual(["first", "second", "second"]);
  });
});
