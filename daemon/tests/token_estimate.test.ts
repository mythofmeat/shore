import { describe, expect, test } from "bun:test";

import {
  BYTES_PER_TOKEN,
  CONTEXT_SAFETY_FRACTION,
  estimateTokens,
  withSafetyMargin,
} from "../src/engine/tokens.ts";

/**
 * The measurement behind the constant, from issue #89: five captured requests
 * from a real conversation, estimated at four bytes per token against what
 * Anthropic actually billed. The ratios sit in 0.762–0.769 — under one percent
 * of spread across the five, so this is a wrong scale constant and not noise.
 *
 * These pairs are not re-derived here; there is no captured wire on this
 * machine to re-derive them from. They are recorded so the constant has a
 * stated basis and a later re-fit has something to compare against.
 */
const MEASURED: Array<{ atFourBytes: number; billed: number }> = [
  { atFourBytes: 11188, billed: 14691 },
  { atFourBytes: 11657, billed: 15211 },
  { atFourBytes: 11895, billed: 15482 },
  { atFourBytes: 11955, billed: 15567 },
  { atFourBytes: 12141, billed: 15784 },
];

describe("the estimator's scale constant", () => {
  test("three bytes per token lands within a few percent of what was billed", () => {
    for (const { atFourBytes, billed } of MEASURED) {
      const bytes = atFourBytes * 4;
      const corrected = Math.ceil(bytes / BYTES_PER_TOKEN);
      const error = Math.abs(corrected - billed) / billed;
      expect(error).toBeLessThan(0.05);
    }
  });

  test("it errs high, never low — an over-estimate trims early, an under-estimate overfills", () => {
    for (const { atFourBytes, billed } of MEASURED) {
      expect(Math.ceil((atFourBytes * 4) / BYTES_PER_TOKEN)).toBeGreaterThanOrEqual(billed);
    }
  });

  test("counting is in UTF-8 bytes, so multibyte text is not undercounted", () => {
    expect(estimateTokens("日本語")).toBe(Math.ceil(9 / BYTES_PER_TOKEN));
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("withSafetyMargin", () => {
  test("holds back a slice of the budget so an estimator miss trims rather than overshoots", () => {
    expect(withSafetyMargin(1000)).toBe(1000 * (1 - CONTEXT_SAFETY_FRACTION));
    expect(withSafetyMargin(0)).toBe(0);
    expect(withSafetyMargin(-5)).toBe(0);
  });
});
