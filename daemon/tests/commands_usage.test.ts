import { required } from "../src/util/required.ts";

import { afterEach, expect, test } from "bun:test";

import { usage, type UsageContext } from "../src/commands/usage.ts";
import { CommandError } from "../src/commands/errors.ts";
import { parseOperationResult } from "../src/operations/contracts.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { closeLedgers, ledgerFor } from "../src/ledger/record.ts";
import { PRICING_TTL_MS } from "../src/ledger/store.ts";
import {
  nanoGptSubscriptionPath,
  writeNanoGptSubscription,
} from "../src/llm/nanogpt_subscription.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";
import { dirname } from "node:path";

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

test("real usage reports satisfy every canonical result variant and retain mode precedence", async () => {
  const ledger = ledgerWithOneCall();
  for (const [args, mode] of [
    [{ last: "all" }, "summary"],
    [{ budget: true, export_tsv: true, export_csv: true, group_by: "model", anomalies: true }, "budget"],
    [{ export_tsv: true, export_csv: true, group_by: "model", anomalies: true }, "tsv"],
    [{ export_csv: true, group_by: "model", anomalies: true }, "csv"],
    [{ group_by: "model", anomalies: true }, "summary_by"],
    [{ anomalies: true }, "anomalies"],
  ] as const) {
    const report = parseOperationResult("usage", await usage(ctxFor(ledger, TINY), args));
    expect(report.mode).toBe(mode);
  }
});

test("a price older than the ttl is not served, so the next call refetches it", () => {
  const ledger = ledgerWithOneCall();
  priceInStore(ledger, 0.00001);
  refuseCatalog();

  const fresh = required(ledgerFor(ledger)).pricing;
  expect(
    fresh.cached("anthropic", "claude-opus-4-6")?.input_per_token,
    "a price written just now is served from cache",
  ).toBe(0.00001);

  stalePricing(ledger, PRICING_TTL_MS + 60_000);
  const stale = required(ledgerFor(ledger)).pricing;
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

test("API key name filters distinguish configured names, missing names and older records", async () => {
  const ledger = ledgerWithOneCall();
  for (const [key, expected] of [["default", 1], ["missing", 0], ["unknown", 0]] as const) {
    const report = await usage(ctxFor(ledger), { last: "all", api_key: key });
    if (report.mode !== "summary") throw new Error("Expected usage summary");
    expect(report.summary.reduce((sum, row) => sum + row.call_count, 0)).toBe(expected);
  }
  required(ledgerFor(ledger)).database.run("UPDATE calls SET api_key_name = NULL");
  for (const [key, expected] of [["default", 0], ["unknown", 1]] as const) {
    const report = await usage(ctxFor(ledger), { last: "all", api_key: key });
    if (report.mode !== "summary") throw new Error("Expected usage summary");
    expect(report.summary.reduce((sum, row) => sum + row.call_count, 0)).toBe(expected);
  }
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

test("a period the parser does not know is the caller's mistake, not shore's", async () => {
  const ledger = ledgerWithOneCall();
  for (const [args, expected] of [
    [{ last: "1m" }, "unknown usage period '1m'"],
    [{ group_by: "banana" }, "unknown usage dimension 'banana'"],
  ] as const) {
    const failed = await usage(ctxFor(ledger), args).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(CommandError);
    expect((failed as CommandError).code).toBe("invalid_request");
    expect((failed as CommandError).message).toContain(expected);
  }
});

test("the call store's rate-limit readings reach the report", async () => {
  const ledger = ledgerWithOneCall();
  const reading = { host: "api.anthropic.com", observed_at: "2026-09-01T12:00:00Z", requests_limit: 1000, requests_remaining: 12 };
  const store = { latestRateLimits: () => [reading] } as never;

  const withStore = (await usage({ ledger, usage: {}, callStore: store }, {})) as {
    rate_limits: unknown[];
  };
  expect(withStore.rate_limits).toEqual([reading]);

  const without = (await usage(ctxFor(ledger), {})) as { rate_limits: unknown[] };
  expect(without.rate_limits, "no store is an empty list, not a missing key").toEqual([]);
});

test("the NanoGPT quota is a local cache read and never reaches the network", async () => {
  const ledger = ledgerWithOneCall();
  const cacheDir = dirname(ledger);
  await writeNanoGptSubscription(nanoGptSubscriptionPath(cacheDir), {
    version: 1,
    fetched_at: "2026-09-04T06:00:00.000Z",
    active: true,
    state: "active",
    weeklyInputTokens: {
      used: 12_000_000,
      remaining: 48_000_000,
      limit: 60_000_000,
      resetAt: "2026-09-07T00:00:00.000Z",
    },
  });
  refuseCatalog();
  const result = (await usage({ ledger, cacheDir, usage: {} }, {})) as {
    nanogpt_subscription: { weeklyInputTokens: { remaining: number } };
  };
  expect(result.nanogpt_subscription.weeklyInputTokens.remaining).toBe(48_000_000);
});
