import { afterEach, beforeEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";

import type { UsageConfig } from "../src/ledger/budget.ts";
import { budgetBlockFor } from "../src/ledger/gate.ts";
import { calculateCost, PRICING_TTL_MS, type ModelPricing } from "../src/ledger/pricing.ts";
import { beginCallAttempt, closeLedgers, ledgerFor, recordingStream } from "../src/ledger/record.ts";
import { setSubscriptionProviders, type Ledger, type RecordCall } from "../src/ledger/store.ts";
import { backfillLedgerCosts } from "../src/ledger/usage.ts";
import { NANOGPT_MODELS_URL } from "../src/llm/providers/nanogpt_config.ts";
import type { SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { required } from "../src/util/required.ts";
import { collect } from "./support/stream.ts";
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

const CLAUDE_4_5_CATALOG_ENTRIES = [
  {
    id: "anthropic/claude-opus-4.5",
    pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005", input_cache_write: "0.00000625" },
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" },
  },
  {
    id: "anthropic/claude-haiku-4.5",
    pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001", input_cache_write: "0.00000125" },
  },
];

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

  test("a catalog refresh writes its models together, not in a commit each", async () => {
    const { ledger } = ledgerAt();
    const models = Array.from({ length: 200 }, (_, i) => ({
      id: `vendor/model-${String(i)}`,
      pricing: { prompt: "0.000001", completion: "0.000002" },
    }));
    catalogAnswers(models);
    await ledger.pricing.getOrFetch("openrouter", "vendor/model-0");

    expect(ratedModels(ledger)).toHaveLength(models.length);
    const { log: framesWritten } = ledger.database.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { log: number };
    expect(framesWritten).toBeLessThan(models.length);
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

  test("a sweep prices rows already recorded under a dated Anthropic id at the rate of the model the date belongs to", async () => {
    const { ledger, path } = ledgerAt();
    const opus = ledger.record({ ...opus55Call("5m"), model: "claude-opus-4-5-20251101" });
    const sonnet = ledger.record({ ...opus55Call("5m"), model: "claude-sonnet-4-5-20250929" });
    const haiku = ledger.record({ ...opus55Call("5m"), model: "claude-haiku-4-5-20251001" });
    expect([opus.total_cost, sonnet.total_cost, haiku.total_cost]).toEqual([null, null, null]);

    catalogAnswers(CLAUDE_4_5_CATALOG_ENTRIES);
    expect((await backfillLedgerCosts(path)).updated).toBe(3);

    const inputCosts = ledger.database.query("SELECT input_cost FROM calls ORDER BY id").all() as Array<{ input_cost: number }>;
    expect(inputCosts).toHaveLength(3);
    close(required(inputCosts[0]).input_cost, 5);
    close(required(inputCosts[1]).input_cost, 3);
    close(required(inputCosts[2]).input_cost, 1);
  });

  test("a sweep won't borrow a rate: a dated id the catalog no longer lists and claude_agent under any id stay unpriced", async () => {
    const { ledger, path } = ledgerAt();
    catalogAnswers([...CLAUDE_4_5_CATALOG_ENTRIES, OPUS_5_5_CATALOG_ENTRY]);
    const calls = [
      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      { provider: "claude_agent", model: "claude-opus-4-5-20251101" },
      { provider: "claude_agent", model: "claude-opus-5-5" },
      { provider: "claude_agent", model: "claude-opus-5-5[1m]" },
    ];
    for (const call of calls) ledger.record({ ...opus55Call("5m"), ...call, subscription: false });

    expect((await backfillLedgerCosts(path)).updated).toBe(0);

    const costs = ledger.database.query("SELECT total_cost FROM calls").all() as Array<{ total_cost: number | null }>;
    expect(costs).toEqual(calls.map(() => ({ total_cost: null })));
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

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const INSTALLED_AT = Date.parse("2026-11-03T00:00:00.000Z");

const paidRequest = (
  ledger: string,
  { provider = "anthropic", model = "claude-opus-5-5", usage }: { provider?: string; model?: string; usage?: UsageConfig } = {},
): SidecarRequest => ({
  sdk: "anthropic",
  provider_key: provider,
  model,
  api_key: "sk-test",
  messages: [],
  max_tokens: 128,
  replay_prior_thinking: "all",
  context: {
    ledger,
    character: "ada",
    call_type: "message",
    thinking_enabled: false,
    cache_ttl: "5m",
    ...(usage === undefined ? {} : { usage }),
  },
});

const finishedCall = async function* (): AsyncGenerator<StreamEvent> {
  yield {
    type: "done",
    content: "hello",
    finish_reason: "end_turn",
    usage: { input_tokens: MILLION, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 1, time_to_first_token_ms: 1 },
  };
};

const NANOGPT_CATALOG_ENTRY = {
  id: "vendor/model",
  pricing: { prompt: 2, completion: 8 },
};

describe("a paid call", () => {
  const fixtures: LedgerFixture[] = [];
  const restores: Array<() => void> = [];

  const ledgerAt = (): { ledger: Ledger; path: string } => {
    const fixture = freshLedger();
    fixtures.push(fixture);
    return { ledger: required(ledgerFor(fixture.path)), path: fixture.path };
  };

  const catalogAnswers = (answer: (url: string) => Response | Promise<Response>): string[] => {
    const fetched: string[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      fetched.push(url);
      return await answer(url);
    }) as typeof fetch);
    restores.push(() => spy.mockRestore());
    return fetched;
  };

  const catalogCarries = (...entries: unknown[]): string[] =>
    catalogAnswers(() => Response.json({ data: entries }));

  const costOfLastCall = (ledger: Ledger): number | null =>
    (ledger.database.query("SELECT total_cost FROM calls ORDER BY id DESC LIMIT 1").get() as { total_cost: number | null }).total_cost;

  const landCall = async (
    ledger: Ledger,
    path: string,
    { lastsMs = 0, ...request }: { lastsMs?: number; provider?: string; model?: string; usage?: UsageConfig } = {},
  ): Promise<number | null> => {
    const call = paidRequest(path, request);
    const attempt = beginCallAttempt(call.context, call);
    if (lastsMs > 0) setSystemTime(Date.now() + lastsMs);
    await collect(recordingStream(call.context, call, finishedCall(), attempt));
    return costOfLastCall(ledger);
  };

  beforeEach(() => setSubscriptionProviders([]));

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    setSystemTime();
    setSubscriptionProviders(["opencode-go", "opencode"]);
    closeLedgers();
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  test("records its cost when it lands, every half hour for three days from a new install's first call, with the catalog fetched about once a day", async () => {
    const { ledger, path } = ledgerAt();
    const fetched = catalogCarries(OPUS_5_5_CATALOG_ENTRY);
    const unpriced: number[] = [];
    for (let halfHour = 0; halfHour <= 144; halfHour++) {
      setSystemTime(INSTALLED_AT + halfHour * 30 * MINUTE);
      if (halfHour % 12 === 0) await backfillLedgerCosts(path);
      if (await landCall(ledger, path, { lastsMs: 2 * MINUTE }) === null) unpriced.push(halfHour / 2);
    }
    expect(unpriced).toEqual([]);
    expect(fetched.length).toBeLessThanOrEqual(4);
  });

  test("still records its cost when its rate turns 24 hours old while it runs", async () => {
    const { ledger, path } = ledgerAt();
    catalogCarries(OPUS_5_5_CATALOG_ENTRY);
    setSystemTime(INSTALLED_AT);
    await landCall(ledger, path);
    setSystemTime(INSTALLED_AT + PRICING_TTL_MS - MINUTE);
    close(required(await landCall(ledger, path, { lastsMs: 10 * MINUTE })), 4);
  });

  test("counts against a blocking budget as soon as it lands, on a new install too", async () => {
    const { ledger, path } = ledgerAt();
    catalogCarries(OPUS_5_5_CATALOG_ENTRY);
    const usage = {
      timezone: "utc",
      budgets: [{ name: "tiny", period: "month", cost_usd: 1, warn_at: [1], limit: "block" }],
    } as unknown as UsageConfig;
    expect(budgetBlockFor(paidRequest(path, { usage }))).toBeUndefined();
    await landCall(ledger, path, { usage });
    expect(budgetBlockFor(paidRequest(path, { usage }))?.budget_name).toBe("tiny");
  });

  test("under a dated Anthropic id records what the catalog lists for that model when it lands", async () => {
    const { ledger, path } = ledgerAt();
    catalogCarries(...CLAUDE_4_5_CATALOG_ENTRIES);
    close(required(await landCall(ledger, path, { model: "claude-opus-4-5-20251101" })), 5);
    close(required(await landCall(ledger, path, { model: "claude-sonnet-4-5-20250929" })), 3);
    close(required(await landCall(ledger, path, { model: "claude-haiku-4-5-20251001" })), 1);
  });

  test("through OpenRouter is looked up under the catalog's own id, even when that id ends in a date", async () => {
    const { ledger, path } = ledgerAt();
    catalogCarries(
      { id: "qwen/qwen3.5-plus-20260420", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "qwen/qwen3.5-plus", pricing: { prompt: "0.000009", completion: "0.000018" } },
    );
    close(required(await landCall(ledger, path, { provider: "openrouter", model: "qwen/qwen3.5-plus-20260420" })), 1);
  });

  test("through NanoGPT is priced from NanoGPT's catalog", async () => {
    const { ledger, path } = ledgerAt();
    const fetched = catalogCarries(NANOGPT_CATALOG_ENTRY);
    close(required(await landCall(ledger, path, { provider: "nanogpt", model: "vendor/model" })), 2);
    expect(fetched).toContain(NANOGPT_MODELS_URL);
    expect(fetched).not.toContain(OPENROUTER_CATALOG);
  });

  test("on a model the catalog doesn't carry doesn't refetch the catalog every call", async () => {
    const { ledger, path } = ledgerAt();
    const fetched = catalogCarries(OPUS_5_5_CATALOG_ENTRY);
    for (let i = 0; i < 5; i++) {
      expect(await landCall(ledger, path, { provider: "deepseek", model: "deepseek-reasoner" })).toBeNull();
    }
    expect(fetched).toEqual([OPENROUTER_CATALOG]);
  });

  test("on a subscription never touches a catalog", async () => {
    const { ledger, path } = ledgerAt();
    const fetched = catalogCarries(OPUS_5_5_CATALOG_ENTRY);
    setSubscriptionProviders([], [["ada", ["anthropic"]]]);
    expect(await landCall(ledger, path)).toBe(0);
    expect(fetched).toEqual([]);
  });

  test("tries a catalog that's down once every few minutes rather than on every call, and is priced again once it's back", async () => {
    const { ledger, path } = ledgerAt();
    const failures: Array<() => Response> = [
      () => new Response("down", { status: 503 }),
      () => { throw new TypeError("fetch failed"); },
    ];
    const fetched = catalogAnswers(() => failures.shift()?.() ?? Response.json({ data: [OPUS_5_5_CATALOG_ENTRY] }));
    setSystemTime(INSTALLED_AT);
    for (let i = 0; i < 3; i++) expect(await landCall(ledger, path)).toBeNull();
    expect(fetched).toHaveLength(1);
    setSystemTime(INSTALLED_AT + HOUR);
    for (let i = 0; i < 3; i++) expect(await landCall(ledger, path)).toBeNull();
    expect(fetched).toHaveLength(2);
    setSystemTime(INSTALLED_AT + 2 * HOUR);
    close(required(await landCall(ledger, path)), 4);
    expect(fetched).toHaveLength(3);
  });

  test("isn't held up for more than a minute by a catalog that never answers", async () => {
    const { ledger, path } = ledgerAt();
    const spy = spyOn(globalThis, "fetch").mockImplementation(((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error), { once: true });
      })) as typeof fetch);
    restores.push(() => spy.mockRestore());
    jest.useFakeTimers();
    try {
      const landed = landCall(ledger, path);
      jest.advanceTimersByTime(MINUTE);
      expect(await landed).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
