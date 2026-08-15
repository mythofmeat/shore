import { afterEach, expect, test } from "bun:test";

import { usage, type UsageContext } from "../src/commands/usage.ts";
import { CommandError } from "../src/commands/errors.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { closeLedgers, ledgerFor } from "../src/ledger/record.ts";
import { PRICING_TTL_MS } from "../src/ledger/store.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  closeLedgers();
  globalThis.fetch = realFetch;
  for (const c of cleanups) c();
  cleanups.length = 0;
});

function ledgerWithOneCall(): string {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  db.query(
    `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
     VALUES ($ts, 'aria', 'anthropic', 'default',
       'claude-opus-4-6', 'message', 1000, 500, 200, 100, 100, 10, 'end_turn', 1,
       'pricing_catalog', 3.5)`,
  ).run({ $ts: new Date().toISOString() });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return f.path;
}

function priceInStore(path: string, perToken: number): void {
  const db = openLedger(path);
  db.query(
    `INSERT OR REPLACE INTO pricing (model_id, input_per_token, output_per_token,
       cache_read_per_token, cache_write_per_token, fetched_at)
     VALUES ('anthropic/claude-opus-4.6', $p, $p, $p, $p, $at)`,
  ).run({ $p: perToken, $at: new Date().toISOString() });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function stalePricing(path: string, byMs: number): void {
  const db = openLedger(path);
  db.query("UPDATE pricing SET fetched_at = $at").run({
    $at: new Date(Date.now() - byMs).toISOString(),
  });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function pricedModels(path: string): number {
  const db = openLedger(path, { readonly: true });
  const row = db.query("SELECT COUNT(*) AS n FROM pricing").get() as { n: number };
  db.close();
  return row.n;
}

function refuseCatalog(): void {
  globalThis.fetch = (() => Promise.reject(new Error("no network in tests"))) as never;
}

const ctxFor = (ledger: string, config: UsageConfig = {}): UsageContext => ({
  ledger,
  usage: config,
});

const TINY: UsageConfig = {
  timezone: "utc",
  budgets: [{ name: "tiny", period: "month", cost_usd: 1, warn_at: [1.0], limit: "warn" }],
};

test("a price older than the ttl is not served, so the next call refetches it", () => {
  const ledger = ledgerWithOneCall();
  priceInStore(ledger, 0.00001);
  refuseCatalog();

  const fresh = ledgerFor(ledger)!.pricing;
  expect(
    fresh.cached("anthropic", "claude-opus-4-6")?.input_per_token,
    "a price written just now is served from cache",
  ).toBe(0.00001);

  stalePricing(ledger, PRICING_TTL_MS + 60_000);
  const stale = ledgerFor(ledger)!.pricing;
  expect(
    stale.cached("anthropic", "claude-opus-4-6"),
    "a price past the ttl is a miss, not a stale hit",
  ).toBeUndefined();
  expect(pricedModels(ledger), "the row stays put until something replaces it").toBe(1);
});

test("the args reach the report unreshaped", async () => {
  const ledger = ledgerWithOneCall();

  const mine = (await usage(ctxFor(ledger), { last: "all", character: "aria" })) as {
    mode: string;
    period: string;
    summary: Array<{ model: string; total_cost: number }>;
  };
  expect(mine.mode).toBe("summary");
  expect(mine.period, "`last` is the period, not a default the command chose").toBe("all");
  expect(mine.summary.map((s) => s.total_cost)).toEqual([3.5]);

  const empty = (await usage(ctxFor(ledger), { last: "all", character: "nobody" })) as {
    summary: unknown[];
  };
  expect(empty.summary, "a filter the command dropped would answer with the row").toEqual([]);
});

test("the session's usage config reaches the report", async () => {
  const ledger = ledgerWithOneCall();

  const result = (await usage(ctxFor(ledger, TINY), { budget: true })) as {
    timezone: string;
    budgets: Array<{ name: string; over_limit: boolean }>;
  };

  expect(result.timezone).toBe("utc");
  expect(result.budgets.map((b) => b.name)).toEqual(["tiny"]);
  expect(result.budgets[0]?.over_limit, "$3.50 against a $1 budget").toBe(true);
});

const MISSING = "/nonexistent-shore-ledger/ledger.db";

test("a ledger that will not open is an internal error", async () => {
  for (const args of [{}, { refresh_pricing: true }]) {
    const failed = await usage(ctxFor(MISSING), args).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(CommandError);
    expect((failed as CommandError).code).toBe("internal_error");
    expect((failed as CommandError).message).toBe(`cannot open ledger at ${MISSING}`);
  }
});
