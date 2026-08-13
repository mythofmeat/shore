/**
 * `commands/usage.ts` — the clearing, the forward, and the failures.
 *
 * The reports themselves are pinned elsewhere and not repeated here:
 * `ledger_usage_cases.test.ts` replays a fixture generated from the Rust for
 * every mode a ledger alone can answer, and `ledger_usage.test.ts` covers
 * `recalculate`, which needs a catalog. What is left for the command is what it
 * does *around* the report — empty the pricing caches when asked, hand the args
 * and the `[usage]` config over untouched, and report every failure as an
 * internal error.
 *
 * `refresh_pricing` is here rather than with the other modes because clearing is
 * now the command's job. The Rust split it in two: the daemon emptied the
 * `pricing` table and the sidecar dropped the memory it kept in front of that
 * table, under different conditions, from different sides of a socket.
 *
 * The catalog fetch is stubbed at `globalThis.fetch` so a cache miss cannot
 * reach the network, and everything else is the production wiring — including
 * `ledgerFor`'s memoised handles, which is what makes the engine the command
 * clears the same engine a later lookup asks.
 */

import { afterEach, expect, test } from "bun:test";

import { usage, type UsageContext } from "../src/commands/usage.ts";
import { CommandError } from "../src/commands/errors.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { closeLedgers, ledgerFor } from "../src/ledger/record.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  closeLedgers();
  globalThis.fetch = realFetch;
  for (const c of cleanups) c();
  cleanups.length = 0;
});

/**
 * A daemon-made ledger holding one $3.50 call, stamped now.
 *
 * Now, and not a fixed date, because the command has no clock seam — the Rust
 * had none either, and inventing one to hand the report a `now` would be a knob
 * that exists only for this test. A row stamped now is inside whatever window
 * `now` opens, which is what the budget cases need.
 */
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
     VALUES ('anthropic/claude-opus-4.6', $p, $p, $p, $p, '2026-05-13T00:00:00+00:00')`,
  ).run({ $p: perToken });
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function pricedModels(path: string): number {
  const db = openLedger(path, { readonly: true });
  const row = db.query("SELECT COUNT(*) AS n FROM pricing").get() as { n: number };
  db.close();
  return row.n;
}

/** Refuse the network, so a cache miss shows up as a miss and not as a fetch. */
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

// ── refresh_pricing ─────────────────────────────────────────────────────────

test("a refresh empties the table and the memory in front of it", async () => {
  const ledger = ledgerWithOneCall();
  priceInStore(ledger, 0.00001);
  refuseCatalog();

  // Prime the engine's memory from the table, which is the state that made the
  // half-refresh a bug: the delete lands and the lookup never notices.
  const engine = ledgerFor(ledger)!.pricing;
  expect(engine.cached("anthropic", "claude-opus-4-6")?.input_per_token).toBe(0.00001);

  const result = await usage(ctxFor(ledger), { refresh_pricing: true });

  expect(result).toEqual({ mode: "refresh_pricing" } as never);
  expect(pricedModels(ledger), "the table is emptied").toBe(0);
  // And the memory: re-price the model at a different rate and ask again. A
  // command that cleared only the table would answer with the old number.
  priceInStore(ledger, 0.00002);
  expect(engine.cached("anthropic", "claude-opus-4-6")?.input_per_token).toBe(0.00002);
});

test("the refresh happens whatever else the args ask for", async () => {
  const ledger = ledgerWithOneCall();
  priceInStore(ledger, 0.00001);
  refuseCatalog();
  const engine = ledgerFor(ledger)!.pricing;
  expect(engine.cached("anthropic", "claude-opus-4-6")).toBeDefined();

  // `budget` wins the mode chain, so the report never reaches the
  // `refresh_pricing` arm. The clearing does not go through that arm.
  const result = (await usage(ctxFor(ledger, TINY), {
    refresh_pricing: true,
    budget: true,
  })) as { mode: string };

  expect(result.mode).toBe("budget");
  expect(pricedModels(ledger)).toBe(0);
  expect(engine.cached("anthropic", "claude-opus-4-6")).toBeUndefined();
});

test("nothing is cleared unless the flag is exactly true", async () => {
  const ledger = ledgerWithOneCall();
  priceInStore(ledger, 0.00001);
  refuseCatalog();

  // `Value::as_bool` on a string is `None`, and the Rust compared the result
  // against `Some(true)` — so `"true"` asks for a summary and leaves the caches
  // alone, and so does an explicit `false`.
  await usage(ctxFor(ledger), { refresh_pricing: "true" });
  await usage(ctxFor(ledger), { refresh_pricing: false });
  await usage(ctxFor(ledger), {});

  expect(pricedModels(ledger)).toBe(1);
});

// ── the forward ─────────────────────────────────────────────────────────────

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

// ── failures ────────────────────────────────────────────────────────────────

const MISSING = "/nonexistent-shore-ledger/ledger.db";

test("a ledger that will not open is an internal error", async () => {
  // Both halves of the command reach the ledger, and the Rust mapped both to
  // `InternalError` — so the flag that decides which one fails first must not
  // decide what the client is told.
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
