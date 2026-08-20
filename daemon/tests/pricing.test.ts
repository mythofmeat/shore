import { required } from "../src/util/required.ts";

import { describe, expect, test } from "bun:test";

import {
  calculateCost,
  isAnthropicPricing,
  PricingEngine,
  toOpenRouterId,
  type ModelPricing,
  type PricingStore,
} from "../src/ledger/pricing.ts";

const anthropicPricing = (): ModelPricing => ({
  input_per_token: 0.000_015,
  output_per_token: 0.000_075,
  cache_read_per_token: 0.000_001_5,
  cache_write_per_token: 0.000_018_75,
});

const close = (actual: number, expected: number) => expect(Math.abs(actual - expected) < 1e-10).toBe(true);

function memoryStore(seed: Record<string, ModelPricing> = {}): PricingStore {
  const map = new Map(Object.entries(seed));
  return {
    get: (id) => map.get(id),
    put: (id, pricing) => void map.set(id, pricing),
  };
}

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
});

describe("model id mapping", () => {
  test("anthropic minor versions become dotted", () => {
    expect(toOpenRouterId("anthropic", "claude-opus-4-6")).toBe("anthropic/claude-opus-4.6");
    expect(toOpenRouterId("anthropic", "claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4.5");
  });

  test("other providers are prefixed verbatim", () => {
    expect(toOpenRouterId("openai", "gpt-4o")).toBe("openai/gpt-4o");
  });

  test("already-prefixed ids pass through", () => {
    expect(toOpenRouterId("openrouter", "google/gemini-3-pro")).toBe("google/gemini-3-pro");
    expect(toOpenRouterId("openrouter-anthropic", "anthropic/claude-opus-4.6")).toBe(
      "anthropic/claude-opus-4.6",
    );
  });

  test("routed anthropic is recognized whatever the provider is called", () => {
    expect(isAnthropicPricing("anthropic", "claude-opus-4-6")).toBe(true);
    expect(isAnthropicPricing("openrouter-anthropic", "anthropic/claude-opus-4.6")).toBe(true);
    expect(isAnthropicPricing("openai", "gpt-4o")).toBe(false);
  });
});

describe("the engine", () => {
  test("an unknown model has no cost rather than a zero cost", () => {
    const engine = new PricingEngine(memoryStore());
    expect(
      engine.cost({
        provider: "openai",
        model: "gpt-4o",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    ).toBeUndefined();
  });

  test("a stored price is found through the dotted id", () => {
    const engine = new PricingEngine(
      memoryStore({ "anthropic/claude-opus-4.6": anthropicPricing() }),
    );
    const cost = engine.cost({
      provider: "anthropic",
      model: "claude-opus-4-6",
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    close(required(cost).input, 0.0015);
  });

  test("a catalog fetch caches every model, not just the one asked for", async () => {
    let calls = 0;
    const store = memoryStore();
    const engine = new PricingEngine(store, async () => {
      calls++;
      return Response.json({
        data: [
          {
            id: "anthropic/claude-opus-4.6",
            pricing: {
              prompt: "0.000015",
              completion: "0.000075",
              input_cache_read: "0.0000015",
              input_cache_write: "0.00001875",
            },
          },
          { id: "openai/gpt-4o", pricing: { prompt: 0.000_005, completion: 0.000_015 } },
        ],
      });
    });

    const found = await engine.getOrFetch("anthropic", "claude-opus-4-6");
    close(required(found).cache_write_per_token, 0.000_018_75);
    expect(engine.cached("openai", "gpt-4o")).toBeDefined();
    expect(store.get("openai/gpt-4o")).toBeDefined();
    await engine.getOrFetch("openai", "gpt-4o");
    expect(calls).toBe(1);
  });

  test("concurrent misses share one catalog fetch", async () => {
    let calls = 0;
    const engine = new PricingEngine(memoryStore(), async () => {
      calls++;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      return Response.json({ data: [{ id: "openai/gpt-4o", pricing: { prompt: "0.000005" } }] });
    });
    await Promise.all([
      engine.getOrFetch("openai", "gpt-4o"),
      engine.getOrFetch("openai", "gpt-4o"),
      engine.getOrFetch("openai", "gpt-4o"),
    ]);
    expect(calls).toBe(1);
  });

  test("a failed fetch leaves the row unpriced rather than failing the call", async () => {
    const engine = new PricingEngine(memoryStore(), async () => {
      throw new Error("network down");
    });
    expect(await engine.getOrFetch("openai", "gpt-4o")).toBeUndefined();
  });
});
