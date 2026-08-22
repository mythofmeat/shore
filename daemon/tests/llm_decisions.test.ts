import { describe, expect, test } from "bun:test";
import { emptyTiming, emptyUsage } from "../src/llm/stream.ts";

import {
  classifyCredentialFailure,
  defaultApiKeyEnv,
  readCandidateEnv,
  resolveKeyCandidates,
  shouldRotate,
  type ProviderEntry,
} from "../src/llm/credentials";
import type { LlmError } from "../src/llm/errors";
import { shouldRetryError } from "../src/llm/retry";

const http = (status: number, body = ""): LlmError => ({ kind: "http_status", status, body });
const POLICY = { max_retries: 2 };
const retries = (e: LlmError, attempt = 0) =>
  shouldRetryError(e, attempt, POLICY).decision === "retry";
const rotates = (e: LlmError) => shouldRotate(classifyCredentialFailure("p", e));

describe("the API key variable a provider looks for", () => {
  test("is the provider's own conventional name", () => {
    expect(defaultApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(defaultApiKeyEnv("openai")).toBe("OPENAI_API_KEY");
    expect(defaultApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
  });

  test("is shared by moonshot's two spellings, because they are one provider", () => {
    expect(defaultApiKeyEnv("moonshotai")).toBe(defaultApiKeyEnv("moonshot"));
    expect(defaultApiKeyEnv("moonshotai")).toBe("MOONSHOT_API_KEY");
  });

  test("falls back to a generic name rather than throwing on an unknown provider", () => {
    expect(defaultApiKeyEnv("some-new-host")).toBe("LLM_API_KEY");
  });
});

describe("which failures mean the key is the problem", () => {
  test("a rejected credential does, so the next key is worth trying", () => {
    expect(classifyCredentialFailure("p", http(401))).toBe("invalid_key");
    expect(classifyCredentialFailure("p", http(403))).toBe("invalid_key");
    expect(classifyCredentialFailure("p", { kind: "missing_api_key", var: "K" })).toBe(
      "missing_key",
    );
    expect(rotates(http(401))).toBe(true);
  });

  test("a spent account does, and is told apart from a spent quota", () => {
    expect(classifyCredentialFailure("p", http(402))).toBe("budget_exhausted");
    expect(classifyCredentialFailure("p", http(429, "monthly limit reached"))).toBe(
      "quota_exhausted",
    );
    expect(classifyCredentialFailure("p", http(429, "insufficient credit"))).toBe(
      "budget_exhausted",
    );
  });

  test("a 401 that is really a quota problem is read as one", () => {
    expect(classifyCredentialFailure("p", http(401, "quota exceeded"))).toBe("quota_exhausted");
  });

  test("a per-key rate limit does, but an ordinary 429 does not", () => {
    expect(classifyCredentialFailure("p", http(429, "api key rate exceeded"))).toBe(
      "rate_limited_credential",
    );
    expect(classifyCredentialFailure("p", http(429, "slow down"))).toBe("not_credential_failure");
    expect(rotates(http(429, "slow down"))).toBe(false);
  });

  test("a 400 only does when it names the credential", () => {
    expect(classifyCredentialFailure("p", http(400, "invalid_api_key"))).toBe("invalid_key");
    expect(classifyCredentialFailure("p", http(400, "bad request"))).toBe("not_credential_failure");
  });

  test("the body is matched case-insensitively", () => {
    expect(classifyCredentialFailure("p", http(400, "INVALID API KEY"))).toBe("invalid_key");
    expect(classifyCredentialFailure("p", http(401, "QUOTA exceeded"))).toBe("quota_exhausted");
  });

  test("a transport or server failure never burns a key", () => {
    for (const error of [
      { kind: "transport", message: "socket hang up" } as LlmError,
      { kind: "provider", message: "overloaded" } as LlmError,
      { kind: "incomplete_stream" } as LlmError,
      { kind: "aborted", message: "cancelled" } as LlmError,
      { kind: "budget_blocked", message: "capped" } as LlmError,
      http(500, "boom"),
      http(503, "unavailable"),
    ]) {
      expect(rotates(error), error.kind).toBe(false);
    }
  });
});

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

describe("which keys a provider offers", () => {
  const entry = (over: Partial<ProviderEntry>): ProviderEntry => ({
    enabled: true,
    keys: [],
    ...over,
  });
  const key = (name: string, env: string, enabled = true, warn = false) => ({
    name,
    env,
    enabled,
    warn_on_fallback: warn,
  });

  test("with no config at all, the provider's conventional variable", () => {
    expect(resolveKeyCandidates("anthropic", undefined)).toEqual([
      { name: "default", env: "ANTHROPIC_API_KEY", warn_on_fallback: false },
    ]);
  });

  test("a caller's explicit variable beats the convention", () => {
    expect(resolveKeyCandidates("anthropic", undefined, "MY_KEY")[0]?.env).toBe("MY_KEY");
  });

  test("configured keys are offered in order, carrying their warn flag", () => {
    const got = resolveKeyCandidates(
      "openrouter",
      entry({ keys: [key("primary", "A", true, true), key("backup", "B")] }),
    );
    expect(got).toEqual([
      { name: "primary", env: "A", warn_on_fallback: true },
      { name: "backup", env: "B", warn_on_fallback: false },
    ]);
  });

  test("a disabled key is skipped rather than tried and rotated past", () => {
    const got = resolveKeyCandidates(
      "openrouter",
      entry({ keys: [key("off", "A", false), key("on", "B")] }),
    );
    expect(got.map((c) => c.name)).toEqual(["on"]);
  });

  test("a disabled provider offers nothing, so no ambient key is picked up", () => {
    expect(resolveKeyCandidates("openrouter", entry({ enabled: false, keys: [key("k", "A")] })))
      .toEqual([]);
  });

  test("a provider whose keys are all disabled falls back to the convention", () => {
    const got = resolveKeyCandidates("openrouter", entry({ keys: [key("off", "A", false)] }));
    expect(got).toEqual([
      { name: "default", env: "OPENROUTER_API_KEY", warn_on_fallback: false },
    ]);
  });
});

describe("reading a key out of the environment", () => {
  const candidate = { name: "k", env: "SOME_KEY", warn_on_fallback: false };

  test("an unset variable reads as absent, so the next key is tried", () => {
    expect(readCandidateEnv(candidate, {})).toBeUndefined();
  });

  test("a blank or whitespace-only variable counts as unset, not as a key", () => {
    expect(readCandidateEnv(candidate, { SOME_KEY: "" })).toBeUndefined();
    expect(readCandidateEnv(candidate, { SOME_KEY: "   " })).toBeUndefined();
  });

  test("a real value comes back untrimmed, because the key is the key", () => {
    expect(readCandidateEnv(candidate, { SOME_KEY: " sk-abc " })).toBe(" sk-abc ");
  });
});
