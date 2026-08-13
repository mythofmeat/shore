/**
 * Recorded cases for llm decisions.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";
import { emptyTiming, emptyUsage } from "../src/llm/stream.ts";

import {
  classifyCredentialFailure,
  defaultApiKeyEnv,
  readCandidateEnv,
  resolveKeyCandidates,
  shouldRotate,
  type CredentialFailureKind,
  type KeyCandidate,
  type ProviderEntry,
} from "../src/llm/credentials";
import type { LlmError } from "../src/llm/errors";
import { shouldRetryError, type RetryDecision } from "../src/llm/retry";

interface EncodedError {
  kind: string;
  status?: number;
  body?: string;
  var?: string;
  message?: string;
}

interface PolicyJson {
  max_retries: number;
  /**
   * Recorded, no longer an input. `RetryPolicy` carried a fallback model when
   * the fixture was taken; #16 removed it along with refusal handling, and the
   * cases whose decision depended on it went with it. It stays in the records
   * because they are recordings, and is ignored by {@link policyOf}.
   */
  fallback_model: string | null;
}

interface Fixture {
  _header: string[];
  default_api_key_env: { provider_key: string; expect: string }[];
  classify_credential_failure: {
    error: EncodedError;
    kind: CredentialFailureKind;
    should_rotate: boolean;
  }[];
  should_retry_error: {
    error: EncodedError;
    attempt: number;
    policy: PolicyJson;
    expect: RetryDecision;
  }[];
  resolve_key_candidates: {
    name: string;
    provider_key: string;
    entry: { enabled: boolean; keys: unknown[] } | null;
    fallback_api_key_env: string | null;
    expect: KeyCandidate[];
  }[];
  read_candidate_env: { env: string; set_to: string | null; expect: string | null }[];
}

const fixture = (await Bun.file(
  new URL("./llm_fixtures/llm_decisions.json", import.meta.url),
).json()) as Fixture;

/** Rebuild the `LlmError` the generator encoded. */
function decodeError(e: EncodedError): LlmError {
  switch (e.kind) {
    case "http_status":
      return { kind: "http_status", status: e.status ?? 0, body: e.body ?? "" };
    case "missing_api_key":
      return { kind: "missing_api_key", var: e.var ?? "" };
    case "incomplete_stream":
      return { kind: "incomplete_stream" };
    case "stream_errored":
      return {
        kind: "stream_errored",
        message: e.message ?? "",
        usage: emptyUsage(),
        timing: emptyTiming(),
      };
    case "provider":
      return { kind: "provider", message: e.message ?? "" };
    default:
      throw new Error(`fixture carries an error kind the replay cannot rebuild: ${e.kind}`);
  }
}

function policyOf(p: PolicyJson) {
  return { max_retries: p.max_retries };
}

function label(e: EncodedError): string {
  return e.kind === "http_status" ? `${e.kind} ${String(e.status)} "${e.body ?? ""}"` : e.kind;
}

describe("the fixture is real", () => {

  test("a silently empty fixture must not pass", () => {
    expect(fixture.classify_credential_failure.length).toBeGreaterThanOrEqual(20);
    expect(fixture.should_retry_error.length).toBeGreaterThanOrEqual(300);
    expect(fixture.resolve_key_candidates.length).toBeGreaterThanOrEqual(6);
  });

  test("the sweep reaches every decision and every classification", () => {
    const decisions = new Set(fixture.should_retry_error.map((c) => c.expect.decision));
    // Two arms, not three: `fallback_model` went with #16.
    expect(decisions).toEqual(new Set(["retry", "fail"]));

    const kinds = new Set(fixture.classify_credential_failure.map((c) => c.kind));
    // `unknown` is unreachable from the current classifier — no branch emits
    // it — so five of the seven, plus not_credential_failure.
    expect(kinds).toEqual(
      new Set([
        "missing_key",
        "invalid_key",
        "quota_exhausted",
        "budget_exhausted",
        "rate_limited_credential",
        "not_credential_failure",
      ]),
    );
  });
});

describe("defaultApiKeyEnv", () => {
  for (const c of fixture.default_api_key_env) {
    test(`${c.provider_key || "(empty)"} -> ${c.expect}`, () => {
      expect(defaultApiKeyEnv(c.provider_key)).toBe(c.expect);
    });
  }
});

describe("classifyCredentialFailure", () => {
  for (const c of fixture.classify_credential_failure) {
    test(`${label(c.error)} -> ${c.kind}`, () => {
      const kind = classifyCredentialFailure("", decodeError(c.error));
      expect(kind).toBe(c.kind);
      expect(shouldRotate(kind)).toBe(c.should_rotate);
    });
  }
});

describe("shouldRetryError", () => {
  test(`all ${String(fixture.should_retry_error.length)} recorded decisions`, () => {
    // The credential short-circuit warns, and a 400-case sweep would put 400
    // lines through the runner. Captured rather than silenced, so the count is
    // still assertable below.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    try {
      for (const c of fixture.should_retry_error) {
        const got = shouldRetryError(decodeError(c.error), c.attempt, policyOf(c.policy));
        expect(
          got,
          `${label(c.error)} attempt=${String(c.attempt)} max=${String(c.policy.max_retries)}`,
        ).toEqual(c.expect);
      }
    } finally {
      console.warn = realWarn;
    }

    // Every rotating case should have said so — the log is how an operator
    // finds out a key was abandoned, so a silent short-circuit is a defect.
    const rotating = fixture.should_retry_error.filter((c) => {
      const kind = classifyCredentialFailure("", decodeError(c.error));
      return shouldRotate(kind);
    });
    expect(warned.length).toBe(rotating.length);
    expect(rotating.length).toBeGreaterThan(0);
  });
});

describe("resolveKeyCandidates", () => {
  for (const c of fixture.resolve_key_candidates) {
    test(c.name, () => {
      const entry = (c.entry ?? undefined) as ProviderEntry | undefined;
      const got = resolveKeyCandidates(
        c.provider_key,
        entry,
        c.fallback_api_key_env ?? undefined,
      );
      expect(got).toEqual(c.expect);
    });
  }
});

describe("readCandidateEnv", () => {
  for (const c of fixture.read_candidate_env) {
    test(`${c.env} set to ${JSON.stringify(c.set_to)}`, () => {
      // Injected rather than mutating process.env, so the cases cannot leak
      // into each other or into anything else in the suite.
      const env: Record<string, string | undefined> =
        c.set_to === null ? {} : { [c.env]: c.set_to };
      const candidate: KeyCandidate = { name: "t", env: c.env, warn_on_fallback: false };
      expect(readCandidateEnv(candidate, env)).toBe(c.expect ?? undefined);
    });
  }
});
