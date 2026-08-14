import { afterEach, expect, test } from "bun:test";

import { closeLedgers } from "../src/ledger/record.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { budgetWarnings, modelHistory, usageReport } from "../src/ledger/usage.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  closeLedgers();
  globalThis.fetch = realFetch;
  for (const c of cleanups) c();
  cleanups.length = 0;
});

interface SeedRow {
  ts?: string;
  character?: string;
  provider?: string;
  api_key_name?: string | null;
  model?: string;
  call_type?: string;
  cache_ttl?: string | null;
  cost_source?: string | null;
  total_cost?: number | null;
}

function ledgerWith(rows: SeedRow[]): string {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  for (const r of rows) {
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cache_ttl, total_ms, ttft_ms, finish_reason, thinking_enabled,
         cost_source, total_cost)
       VALUES ($ts, $character, $provider, $api_key_name, $model, $call_type,
         1000, 500, 200, 100, $cache_ttl, 100, 10, 'end_turn', 1,
         $cost_source, $total_cost)`,
    ).run({
      $ts: r.ts ?? "2026-05-13T10:00:00+00:00",
      $character: r.character ?? "aria",
      $provider: r.provider ?? "anthropic",
      $api_key_name: r.api_key_name ?? "default",
      $model: r.model ?? "claude-opus-4-6",
      $call_type: r.call_type ?? "message",
      $cache_ttl: r.cache_ttl ?? null,
      $cost_source: r.cost_source ?? null,
      $total_cost: r.total_cost ?? null,
    });
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return f.path;
}

function priceInStore(path: string, modelId: string, perToken: number): void {
  const db = openLedger(path);
  db.query(
    `INSERT OR REPLACE INTO pricing (model_id, input_per_token, output_per_token,
       cache_read_per_token, cache_write_per_token, fetched_at)
     VALUES ($id, $p, $p, $p, $p, '2026-05-13T00:00:00+00:00')`,
  ).run({ $id: modelId, $p: perToken });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function stubCatalog(modelId?: string): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = ((): Promise<Response> => {
    state.calls += 1;
    const data =
      modelId === undefined
        ? []
        : [
            {
              id: modelId,
              pricing: { prompt: "0.00002", completion: "0.00002" },
            },
          ];
    return Promise.resolve(
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return state;
}

function costOf(path: string, id: number): number | null {
  const db = openLedger(path, { readonly: true });
  const row = db.query("SELECT total_cost FROM calls WHERE id = ?1").get(id) as
    | { total_cost: number | null }
    | null;
  db.close();
  return row?.total_cost ?? null;
}

test("recalculate prices rows the catalog knows", async () => {
  const ledger = ledgerWith([{}]);
  priceInStore(ledger, "anthropic/claude-opus-4.6", 0.00001);
  const fetched = stubCatalog();

  const result = (await usageReport({
    ledger,
    args: { recalculate: true },
  })) as { mode: string; updated: number; total: number; failures: unknown[] };

  expect(result.mode).toBe("recalculate");
  expect(result.updated).toBe(1);
  expect(result.total).toBe(1);
  expect(result.failures).toEqual([]);
  expect(fetched.calls, "a cached price must not reach the network").toBe(0);
  expect(costOf(ledger, 1)).toBeCloseTo(0.0186, 10);
});

test("recalculate reports a model the catalog has no price for", async () => {
  const ledger = ledgerWith([{ provider: "openai", model: "gpt-nonexistent" }]);
  const fetched = stubCatalog();

  const result = (await usageReport({
    ledger,
    args: { recalculate: true },
  })) as { updated: number; total: number; failures: Array<{ model: string; reason: string }> };

  expect(fetched.calls, "a cache miss fetches the catalog once").toBe(1);
  expect(result.updated).toBe(0);
  expect(result.total).toBe(1);
  expect(result.failures).toEqual([
    { model: "openai/gpt-nonexistent", reason: "no pricing data for openai/gpt-nonexistent" },
  ]);
  expect(costOf(ledger, 1), "an unpriceable row keeps its NULL cost").toBeNull();
});

test("recalculate fetches each model once, not each row", async () => {
  const ledger = ledgerWith([{}, {}, {}]);
  const fetched = stubCatalog("anthropic/claude-opus-4.6");

  const result = (await usageReport({ ledger, args: { recalculate: true } })) as {
    updated: number;
    total: number;
  };

  expect(fetched.calls).toBe(1);
  expect(result.updated).toBe(3);
  expect(result.total).toBe(3);
});

test("recalculate leaves already-costed rows alone unless forced", async () => {
  const ledger = ledgerWith([
    { cost_source: "pricing_catalog", total_cost: 99 },
    { cost_source: "provider_reported", total_cost: 42 },
    { cost_source: "subscription", total_cost: 0 },
  ]);
  priceInStore(ledger, "anthropic/claude-opus-4.6", 0.00001);
  stubCatalog();

  const plain = (await usageReport({ ledger, args: { recalculate: true } })) as {
    updated: number;
    total: number;
    failures: unknown[];
  };
  expect(plain, "nothing has a NULL cost").toEqual({
    mode: "recalculate",
    updated: 0,
    total: 0,
    failures: [],
  } as never);

  const forced = (await usageReport({
    ledger,
    args: { recalculate: true, force: true },
  })) as { updated: number; total: number };
  expect(forced.total, "provider_reported and subscription rows are excluded").toBe(1);
  expect(forced.updated).toBe(1);
  expect(costOf(ledger, 1)).toBeCloseTo(0.0186, 10);
  expect(costOf(ledger, 2), "a provider's own total is not overwritten").toBe(42);
  expect(costOf(ledger, 3), "a flat-plan row must not start accruing cost").toBe(0);
});

const OVER_BUDGET: UsageConfig = {
  timezone: "utc",
  budgets: [{ name: "tiny", period: "month", cost_usd: 1, warn_at: [1.0], limit: "warn" }],
};

test("a crossed threshold is announced once per window", () => {
  const ledger = ledgerWith([{ total_cost: 5, cost_source: "pricing_catalog" }]);
  const now = Date.parse("2026-05-13T16:20:00+00:00");

  const first = budgetWarnings({ ledger, usage: OVER_BUDGET }, { now }) as {
    warnings: Array<{ budget: string; crossed_warn_at: number }>;
  };
  expect(first.warnings.map((w) => w.budget)).toEqual(["tiny"]);

  const second = budgetWarnings({ ledger, usage: OVER_BUDGET }, { now }) as {
    warnings: Array<{ budget: string }>;
  };
  expect(second.warnings.map((w) => w.budget)).toEqual(["tiny"]);
  expect(second.warnings.length).toBe(first.warnings.length);
});

test("no budgets means no warnings and no ledger open", () => {
  expect(budgetWarnings({ ledger: "/nonexistent/ledger.db", usage: { budgets: [] } })).toEqual({
    warnings: [],
  } as never);
});

test("model history is scoped to one character", () => {
  const ledger = ledgerWith([
    { character: "poppy", model: "claude-opus-4-6", ts: "2026-04-05T10:00:00+00:00" },
    { character: "poppy", model: "claude-opus-4-6", ts: "2026-05-01T10:00:00+00:00" },
    { character: "poppy", model: "glm-5.2", call_type: "heartbeat", ts: "2026-06-01T10:00:00+00:00" },
    { character: "other", model: "gpt-5.5", ts: "2026-06-03T10:00:00+00:00" },
  ]);

  const result = modelHistory({ ledger, character: "poppy" }) as {
    models: Array<{ model: string; call_count: number; first_ts: string; last_ts: string }>;
  };

  expect(result.models.map((m) => m.model)).toEqual(["claude-opus-4-6", "glm-5.2"]);
  expect(result.models[0]!.call_count).toBe(2);
  expect(result.models[0]!.first_ts).toBe("2026-04-05T10:00:00+00:00");
  expect(result.models[0]!.last_ts).toBe("2026-05-01T10:00:00+00:00");
});

test("model history honours the time bounds", () => {
  const ledger = ledgerWith([
    { character: "poppy", ts: "2026-04-05T10:00:00+00:00" },
    { character: "poppy", ts: "2026-05-01T10:00:00+00:00" },
  ]);

  const result = modelHistory({
    ledger,
    character: "poppy",
    since: "2026-04-20T00:00:00+00:00",
    until: "2026-05-01T20:00:00+00:00",
  }) as { models: Array<{ call_count: number }> };

  expect(result.models.length).toBe(1);
  expect(result.models[0]!.call_count).toBe(1);
});

test("a ledger that will not open is an error, not an empty report", () => {
  expect(() => modelHistory({ ledger: "/nonexistent/ledger.db", character: "aria" })).toThrow(
    /cannot open ledger/,
  );
});
