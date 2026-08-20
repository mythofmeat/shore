import { describe, expect, test } from "bun:test";

import { describeError, isLlmError, type LlmError } from "../src/llm/errors.ts";
import { BudgetBlocked } from "../src/llm/generate.ts";
import { CommandError } from "../src/commands/errors.ts";
import { streamWithCredentialFallback } from "../src/llm/fallback.ts";

const MISSING: LlmError = { kind: "missing_api_key", var: "ANTHROPIC_API_KEY" };

describe("isLlmError", () => {
  test("accepts every variant's tag", () => {
    const all: LlmError[] = [
      { kind: "transport", message: "x" },
      { kind: "http_status", status: 500, body: "x" },
      { kind: "serialize", message: "x" },
      { kind: "deserialize", message: "x" },
      { kind: "incomplete_stream" },
      {
        kind: "stream_errored",
        message: "x",
        usage: { input_tokens: 0, output_tokens: 0 },
        timing: { total_ms: 0, time_to_first_token_ms: 0 },
      } as LlmError,
      MISSING,
      { kind: "provider", message: "x" },
      { kind: "budget_blocked", message: "x" },
      { kind: "aborted", message: "x" },
    ];
    for (const e of all) expect(isLlmError(e)).toBe(true);
  });

  test("rejects everything else", () => {
    for (const value of [null, undefined, "a string", 42, {}, { kind: "nonsense" }, new Error("x")]) {
      expect(isLlmError(value)).toBe(false);
    }
  });
});

describe("describeError", () => {
  test("an LlmError gets its Display text, not `[object Object]`", () => {
    // oxlint-disable-next-line typescript/no-base-to-string
    expect(String(MISSING)).toBe("[object Object]");
    expect(describeError(MISSING)).toBe(
      "API key environment variable ANTHROPIC_API_KEY is not set",
    );
  });

  test("an ordinary Error keeps its message", () => {
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError(new CommandError("not_found", "no such message"))).toBe(
      "no such message",
    );
  });

  test("BudgetBlocked is both — the Error branch wins and says the same thing", () => {
    const e = new BudgetBlocked("weekly budget reached", "brainwife");
    expect(isLlmError(e)).toBe(true);
    expect(describeError(e)).toBe("weekly budget reached");
  });

  test("anything else falls back to String", () => {
    expect(describeError("bare string")).toBe("bare string");
    expect(describeError(42)).toBe("42");
  });
});

describe("the reported failure, end to end", () => {
  test("no configured key names the provider and the variable", async () => {
    const thrown = await streamWithCredentialFallback(
      "anthropic",
      [{ name: "default", env: "ANTHROPIC_API_KEY", warn_on_fallback: false }],
      () => undefined,
      async () => "unreachable",
      { record: () => {} },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(thrown).toBeDefined();
    expect(thrown instanceof Error).toBe(false);
    expect(describeError(thrown)).toBe(
      "API key environment variable ANTHROPIC_API_KEY is not set",
    );
  });
});
