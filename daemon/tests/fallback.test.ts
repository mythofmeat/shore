import { describe, expect, test } from "bun:test";
import { emptyTiming, emptyUsage } from "../src/llm/stream.ts";

import { buildWarningMessage, llmHttpStatus, missingKeyReason, sanitizeReason, streamWithCredentialFallback, type FallbackEvent } from "../src/llm/fallback";
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
