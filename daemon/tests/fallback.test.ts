/**
 * Recorded cases for fallback.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 *
 * What a failure means: this is the layer that decides whether a bad minute
 * costs one retry or every configured API key. Rotating on a transient 503
 * exhausts a user's whole key list and reports "all keys failed" when nothing
 * was wrong with any of them; retrying a dead credential three times burns the
 * turn with a working key still unused. And a reason string that keeps a
 * response body leaks provider payloads — which can contain partial
 * credentials — into a warning shown to the user.
 */

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
import type { CredentialFailureKind, KeyCandidate } from "../src/llm/credentials";
import { describeLlmError, type LlmError } from "../src/llm/errors";

interface Fixture {
  default_max_retries: number;
  default_backoff_base_ms: number;
  error_projection: {
    name: string;
    display: string;
    status: number | null;
    reason: string;
    reason_byte_len: number;
  }[];
  warning_messages: { kind: string; should_rotate: boolean; message: string }[];
  backoff_schedule: { base_ms: number; attempt: number; delay_ms: number }[];
  missing_key_reason_format: { env: string; reason: string };
  all_keys_failed_var: string;
}

const fixture = (await Bun.file(
  new URL("./llm_fixtures/fallback.json", import.meta.url),
).json()) as Fixture;

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

/** The errors the fixture names, rebuilt in the TypeScript union. */
const ERRORS: Record<string, LlmError> = {
  http_401: { kind: "http_status", status: 401, body: '{"error":"bad key sk-abc123"}' },
  http_429: { kind: "http_status", status: 429, body: "slow down" },
  http_500: { kind: "http_status", status: 500, body: "boom" },
  missing_key: { kind: "missing_api_key", var: "SOME_KEY" },
  provider_short: { kind: "provider", message: "quota exceeded" },
  provider_long: { kind: "provider", message: "x".repeat(500) },
  provider_multibyte: { kind: "provider", message: `${"x".repeat(199)}世${"y".repeat(400)}` },
  provider_exactly_200: { kind: "provider", message: "x".repeat(200) },
  incomplete: { kind: "incomplete_stream" },
  stream_errored: {
    kind: "stream_errored",
    message: "upstream closed",
    usage: emptyUsage(),
    timing: emptyTiming(),
  },
};

const cand = (name: string, env: string, warn = false): KeyCandidate => ({
  name,
  env,
  warn_on_fallback: warn,
});

describe("the fixture is real", () => {

  test("every fixture error is represented in the TypeScript union", () => {
    for (const c of fixture.error_projection) {
      expect(Object.hasOwn(ERRORS, c.name), c.name).toBe(true);
    }
  });

  test("a provider message longer than the cap is present, and one shorter", () => {
    const truncated = fixture.error_projection.filter(
      (c) => c.name.startsWith("provider") && c.reason.endsWith("…"),
    );
    const whole = fixture.error_projection.filter(
      (c) => c.name.startsWith("provider") && !c.reason.endsWith("…"),
    );
    expect(truncated.length).toBeGreaterThan(0);
    expect(whole.length).toBeGreaterThan(0);
  });

  test("a truncation case cuts inside a multibyte character", () => {
    // Without it, a code-unit implementation passes every other case.
    const multibyte = fixture.error_projection.find((c) => c.name === "provider_multibyte");
    const ascii = fixture.error_projection.find((c) => c.name === "provider_long");
    expect(multibyte?.reason_byte_len).toBeLessThan(ascii?.reason_byte_len as number);
  });

  test("both rotation verdicts appear among the warning kinds", () => {
    expect(fixture.warning_messages.some((w) => w.should_rotate)).toBe(true);
    expect(fixture.warning_messages.some((w) => !w.should_rotate)).toBe(true);
  });
});

describe("defaults match the Rust", () => {
  test("max retries", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(fixture.default_max_retries);
  });
  test("backoff base", () => {
    expect(DEFAULT_BACKOFF_BASE_MS).toBe(fixture.default_backoff_base_ms);
  });
});

describe("error projection", () => {
  for (const c of fixture.error_projection) {
    test(c.name, () => {
      const error = ERRORS[c.name] as LlmError;
      expect(llmHttpStatus(error)).toBe(c.status ?? undefined);
      expect(sanitizeReason(error)).toBe(c.reason);
      expect(byteLen(sanitizeReason(error))).toBe(c.reason_byte_len);
    });
  }

  test("the Display text still agrees too", () => {
    for (const c of fixture.error_projection) {
      expect(describeLlmError(ERRORS[c.name] as LlmError), c.name).toBe(c.display);
    }
  });

  test("a response body never survives into a reason", () => {
    // The reason is shown to the user. A 4xx body can echo part of a
    // credential — the fixture's 401 body contains one — so only the status
    // may cross this boundary.
    const reason = sanitizeReason(ERRORS.http_401 as LlmError);
    expect(reason).not.toContain("sk-abc123");
    expect(reason).toBe("HTTP 401");
  });

  test("no truncated reason splits a character", () => {
    for (const c of fixture.error_projection) {
      expect(sanitizeReason(ERRORS[c.name] as LlmError), c.name).not.toContain("�");
    }
  });

  test("the missing-key reason format matches", () => {
    expect(missingKeyReason(fixture.missing_key_reason_format.env)).toBe(
      fixture.missing_key_reason_format.reason,
    );
  });
});

describe("warning messages", () => {
  for (const w of fixture.warning_messages) {
    test(w.kind, () => {
      expect(
        buildWarningMessage(
          "openrouter",
          cand("primary", "PRIMARY_KEY", true),
          cand("backup", "BACKUP_KEY"),
          w.kind as CredentialFailureKind,
        ),
      ).toBe(w.message);
    });
  }

  test("a warning never contains an environment variable name", () => {
    // Key *names* are friendly labels the user chose; env var names are a
    // deployment detail, and the values behind them are secrets.
    for (const w of fixture.warning_messages) {
      const message = buildWarningMessage(
        "openrouter",
        cand("primary", "PRIMARY_KEY", true),
        cand("backup", "BACKUP_KEY"),
        w.kind as CredentialFailureKind,
      );
      expect(message, w.kind).not.toContain("PRIMARY_KEY");
      expect(message, w.kind).not.toContain("BACKUP_KEY");
    }
  });
});

describe("backoff schedule", () => {
  for (const [i, b] of fixture.backoff_schedule.entries()) {
    test(`#${i} base ${b.base_ms} attempt ${b.attempt}`, () => {
      expect(backoffDelayMs(b.base_ms, b.attempt)).toBe(b.delay_ms);
    });
  }

  test("it saturates rather than wrapping", () => {
    // A wrap would produce a near-zero delay and hammer a provider that just
    // asked for a pause — the failure mode the Rust's saturating arithmetic
    // exists to prevent.
    expect(backoffDelayMs(500, 64)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(backoffDelayMs(500, 64)).toBe(backoffDelayMs(500, 128));
  });
});

/**
 * The loop cases. Not fixture-generated — see the note at the top of the file.
 * They pin the structure `key_fallback.rs` documents as its invariants.
 */
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
    // The whole point of the split. A 500 is transient; burning the user's
    // remaining keys on it leaves them with "all keys failed" and no cause.
    const h = harness({ A: "sk-a", B: "sk-b" });
    await expect(
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
    // By the time bytes flow the credential was accepted and the user may have
    // seen partial output; a different key cannot help and would re-answer.
    const h = harness({ A: "sk-a", B: "sk-b" });
    await expect(
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
    await expect(
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
    await expect(
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
    // Recorded either way — diagnostics show the full picture even when the
    // user did not ask to be told.
    expect(quiet.events).toHaveLength(1);
    expect(quiet.events[0]?.warning).toBeUndefined();
  });

  test("the last key's failure carries no warning, only the error", async () => {
    const h = harness({ A: "sk-a" });
    await expect(
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
    // A previous rotation must not short-circuit the next call's resolution,
    // or a key that recovers is never tried again.
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
    await expect(
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
    // Retrying here would spend the transient budget on a key that cannot
    // work, and arrive at the rotation layer with the turn already over.
    let calls = 0;
    await expect(
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
    // One attempt on the dead key — no transient budget wasted — then the
    // second key gets its own full budget.
    expect(attempts).toEqual(["first", "second", "second"]);
  });
});
