

import { describe, expect, test } from "bun:test";

import { calculateCost, type ModelPricing } from "../src/ledger/pricing.ts";

const anthropicPricing = (): ModelPricing => ({
  input_per_token: 0.000_015,
  output_per_token: 0.000_075,
  cache_read_per_token: 0.000_001_5,
  cache_write_per_token: 0.000_018_75,
});

const close = (actual: number, expected: number) => expect(Math.abs(actual - expected) < 1e-10).toBe(true);

describe("cost calculation", () => {
  test("a 5m cache write uses the catalog price as-is", () => {
    const cost = calculateCost(anthropicPricing(), {
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
      cache_ttl: "5m",
    });
    close(cost.input, 0.0015);
    close(cost.output, 0.00375);
    close(cost.cache_read, 0.00012);
    close(cost.cache_write, 0.000_375);
  });

  test("a 1h cache write costs 1.6× the catalog price", () => {
    const cost = calculateCost(anthropicPricing(), {
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
      cache_ttl: "1h",
    });
    close(cost.cache_write, 0.0006);
    close(cost.total, 0.0015 + 0.00375 + 0.00012 + 0.0006);
  });

  test("an absent ttl means 1h", () => {
    const cost = calculateCost(anthropicPricing(), {
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
    });
    close(cost.cache_write, 0.0006);
  });

  test("routed Anthropic bills OpenRouter's cache-write price, not Anthropic's", () => {
    const cost = calculateCost(anthropicPricing(), {
      provider: "openrouter-anthropic",
      model: "anthropic/claude-opus-4.6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
      cache_ttl: "1h",
    });
    close(cost.cache_write, 0.000_375);
  });

  test("NanoGPT's 1h Claude cache write uses the advertised 5m rate times 1.6", () => {
    const cost = calculateCost(anthropicPricing(), {
      provider: "nanogpt",
      model: "anthropic/claude-opus-4.6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
      cache_ttl: "1h",
    });
    close(cost.cache_write, 0.0006);
  });

  test("NanoGPT without an explicit TTL does not invent a 1h cache write", () => {
    const cost = calculateCost(anthropicPricing(), {
      provider: "nanogpt",
      model: "anthropic/claude-opus-4.6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 80,
      cache_write_tokens: 20,
    });
    close(cost.cache_write, 0.000_375);
  });
});
