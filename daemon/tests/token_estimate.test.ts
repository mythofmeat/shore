import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import {
  BYTES_PER_TOKEN,
  CONTEXT_SAFETY_FRACTION,
  estimateTokens,
  withSafetyMargin,
} from "../src/engine/tokens.ts";
import { estimateHistoryTokens } from "../src/engine/prompt.ts";

interface Corpus {
  host: string;
  samples: number;
  minRatio: number;
  medianRatio: number;
  maxRatio: number;
}

const MEASURED: Corpus[] = [
  { host: "api.anthropic.com", samples: 80, minRatio: 0.806, medianRatio: 0.837, maxRatio: 0.895 },
  { host: "opencode.ai", samples: 78, minRatio: 0.5, medianRatio: 0.88, maxRatio: 1.075 },
  { host: "openrouter.ai", samples: 8, minRatio: 0.808, medianRatio: 0.956, maxRatio: 1.0 },
];

const anthropic = required(MEASURED[0]);

describe("the estimator's scale constant", () => {
  test("four bytes per token under-counted, which is what made it worth changing", () => {
    expect(anthropic.medianRatio).toBeLessThan(1);
    expect(4 * anthropic.medianRatio).toBeGreaterThan(BYTES_PER_TOKEN);
  });

  test("it never under-counts on the worst Anthropic sample measured", () => {
    expect(BYTES_PER_TOKEN).toBeLessThanOrEqual(4 * anthropic.minRatio);
  });

  test("nor on the worst OpenRouter one", () => {
    const openrouter = required(MEASURED[2]);
    expect(BYTES_PER_TOKEN).toBeLessThanOrEqual(4 * openrouter.minRatio);
  });

  test("at the Anthropic median it lands within a few percent of what was billed", () => {
    const billed = 60_000;
    const bytes = billed * anthropic.medianRatio * 4;
    const estimated = Math.ceil(bytes / BYTES_PER_TOKEN);
    expect(Math.abs(estimated - billed) / billed).toBeLessThan(0.05);
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

  test("the margin covers the spread the fit does not", () => {
    const worstOvershoot = 4 * anthropic.minRatio - BYTES_PER_TOKEN;
    expect(worstOvershoot).toBeGreaterThanOrEqual(0);
    expect(CONTEXT_SAFETY_FRACTION).toBeGreaterThan(0);
  });
});

test("history tokens count the active messages once", () => {
  const messages = [
    {
      msg_id: "u1",
      role: "user" as const,
      content: "hello",
      images: [],
      content_blocks: [{ type: "text" as const, text: "hello" }],
      timestamp: "2026-01-01T00:00:00Z",
    },
    {
      msg_id: "a1",
      role: "assistant" as const,
      content: "",
      images: [],
      content_blocks: [{ type: "tool_use" as const, id: "t1", name: "read", input: { path: "a" } }],
      timestamp: "2026-01-01T00:00:01Z",
    },
  ];
  expect(estimateHistoryTokens(messages)).toBe(
    estimateTokens("hello") + estimateTokens("read") + estimateTokens(JSON.stringify({ path: "a" })),
  );
});
