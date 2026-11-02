import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { calculateCost, PRICING_TTL_MS, type ModelPricing } from "../src/ledger/pricing.ts";
import { closeLedgers, ledgerFor } from "../src/ledger/record.ts";
import type { Ledger, RecordCall } from "../src/ledger/store.ts";
import { backfillLedgerCosts } from "../src/ledger/usage.ts";
import { required } from "../src/util/required.ts";
import { freshLedger, type LedgerFixture } from "./support/ledger_fixture.ts";

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

const OPUS_5_5_CATALOG_ENTRY = {
  id: "anthropic/claude-opus-5.5",
  pricing: {
    prompt: "0.000004",
    completion: "0.00002",
    web_search: "0.01",
    input_cache_read: "0.0000002",
    input_cache_write: "0.000005",
    input_cache_write_1h: "0.000008",
  },
};

const OPUS_5_CATALOG_ENTRY = {
  id: "anthropic/claude-opus-5",
  pricing: {
    prompt: "0.000005",
    completion: "0.000025",
    input_cache_read: "0.0000005",
    input_cache_write: "0.00000625",
  },
};

const OPENROUTER_CATALOG = "https://openrouter.ai/api/v1/models";

const MILLION = 1_000_000;

const opus55Call = (cache_ttl: string): RecordCall => ({
  provider: "anthropic",
  model: "claude-opus-5-5",
  call_type: "message",
  character: "ada",
  usage: {
    input_tokens: MILLION,
    output_tokens: MILLION,
    cache_read_tokens: MILLION,
    cache_creation_tokens: MILLION,
  },
  timing: { total_ms: 1, time_to_first_token_ms: 1 },
  finish_reason: "end_turn",
  thinking_enabled: true,
  cache_ttl,
});

function seedRate(ledger: Ledger, modelId: string, perMillion: number, fetchedAt: string): void {
  ledger.database.query(
    `INSERT OR REPLACE INTO pricing
       (model_id, input_per_token, output_per_token, cache_read_per_token, cache_write_per_token, fetched_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(modelId, perMillion / MILLION, (perMillion * 5) / MILLION, (perMillion / 10) / MILLION, (perMillion * 1.25) / MILLION, fetchedAt);
}

const ratedModels = (ledger: Ledger): string[] =>
  (ledger.database.query("SELECT model_id FROM pricing ORDER BY model_id").all() as Array<{ model_id: string }>)
    .map((row) => row.model_id);

describe("the pricing table", () => {
  const fixtures: LedgerFixture[] = [];
  const restores: Array<() => void> = [];

  const ledgerAt = (): { ledger: Ledger; path: string } => {
    const fixture = freshLedger();
    fixtures.push(fixture);
    return { ledger: required(ledgerFor(fixture.path)), path: fixture.path };
  };

  const catalogAnswers = (entries: unknown[]): string[] => {
    const fetched: string[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      fetched.push(input instanceof Request ? input.url : input.toString());
      return new Response(JSON.stringify({ data: entries }));
    }) as typeof fetch);
    restores.push(() => spy.mockRestore());
    return fetched;
  };

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    closeLedgers();
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  test("Claude Opus 5.5 is priced at the catalog's rates under its own model id", async () => {
    const { ledger } = ledgerAt();
    catalogAnswers([OPUS_5_CATALOG_ENTRY, OPUS_5_5_CATALOG_ENTRY]);
    await ledger.pricing.getOrFetch("anthropic", "claude-opus-5-5");

    const fiveMinute = ledger.record(opus55Call("5m"));
    close(required(fiveMinute.input_cost), 4);
    close(required(fiveMinute.output_cost), 20);
    close(required(fiveMinute.cache_read_cost), 0.2);
    close(required(fiveMinute.cache_write_cost), 5);

    const oneHour = ledger.record(opus55Call("1h"));
    close(required(oneHour.cache_write_cost), 8);
    close(required(oneHour.total_cost), 32.2);
  });

  test("a call that lands after a rate expires gets the catalog's new rate, never the old one", async () => {
    const { ledger, path } = ledgerAt();
    seedRate(ledger, "anthropic/claude-opus-5.5", 5, new Date(Date.now() - PRICING_TTL_MS - 1000).toISOString());

    const landed = ledger.record(opus55Call("5m"));
    expect(landed.total_cost).toBeNull();

    const fetched = catalogAnswers([OPUS_5_5_CATALOG_ENTRY]);
    const backfill = await backfillLedgerCosts(path);
    expect(fetched).toEqual([OPENROUTER_CATALOG]);
    expect(backfill.updated).toBe(1);

    const repriced = ledger.database.query("SELECT input_cost, output_cost FROM calls").get() as { input_cost: number; output_cost: number };
    close(repriced.input_cost, 4);
    close(repriced.output_cost, 20);
    close(required(ledger.pricing.cached("anthropic", "claude-opus-5-5")).input_per_token, 4 / MILLION);
  });

  test("a sweep drops every rate past its TTL without fetching a catalog, and keeps the current ones", async () => {
    const { ledger, path } = ledgerAt();
    const fetched = catalogAnswers([]);
    const past = new Date(Date.now() - PRICING_TTL_MS - 1000).toISOString();
    seedRate(ledger, "nanogpt/anthropic/claude-opus-latest", 5, past);
    seedRate(ledger, "anthropic/claude-opus-5-fast", 10, "2026-09-01T13:01:54.148Z");
    seedRate(ledger, "deepseek/deepseek-reasoner", 1, "2026-04-08T04:56:25.611280433+00:00");
    seedRate(ledger, "unparseable/timestamp", 1, "not a time");
    seedRate(ledger, "anthropic/claude-opus-5.5", 4, new Date(Date.now() - PRICING_TTL_MS + 60_000).toISOString());

    await backfillLedgerCosts(path);

    expect(ratedModels(ledger)).toEqual(["anthropic/claude-opus-5.5"]);
    expect(fetched).toEqual([]);
    close(required(ledger.pricing.cached("anthropic", "claude-opus-5-5")).output_per_token, 20 / MILLION);
  });
});
