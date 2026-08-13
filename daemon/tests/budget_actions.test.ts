/**
 * `pause_heartbeat`, and `warn_at` thresholds that actually do something.
 *
 * `ledger_budget_parity.test.ts` pins the decisions the Rust made; this covers
 * the two it never had. Both are about a budget being *wrong* in the expensive
 * direction rather than failing to enforce:
 *
 * - `pause_background` stopped the cache keepalive along with the heartbeat.
 *   Keepalive is spend to *avoid* spend, so pausing it can raise the bill: the
 *   prefix expires while the budget is quiet and the next real turn pays for a
 *   full cache write. `pause_heartbeat` cuts the discretionary half only.
 * - `warn_at` computed a threshold, printed it, and enforced nothing, so the
 *   only way to act at 80% was a second budget at 80% of the cost — which then
 *   double-counts everywhere budgets are listed.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  budgetStatuses,
  enforceBudgetForCall,
  type BudgetCallContext,
  type UsageConfig,
} from "../src/ledger/budget.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups.length = 0;
});

const NOW = Date.parse("2026-03-05T12:00:00Z");
const opts = { localZone: "UTC" };

/** A ledger holding one call of `cost` dollars, inside the current window. */
function ledgerSpending(cost: number): Database {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  cleanups.push(() => db.close());
  db.query(
    `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
     VALUES (?1, 'aria', 'anthropic', 'default',
       'claude-opus-4-6', 'message', 10, 5, 0, 0, 100, 10, 'end_turn', 1,
       'pricing_catalog', ?2)`,
  ).run(new Date(NOW - 60_000).toISOString(), cost);
  return db;
}

function call(callType: string): BudgetCallContext {
  return {
    provider: "anthropic",
    api_key_name: "default",
    model: "claude-opus-4-6",
    call_type: callType,
    character: "aria",
  };
}

/** Which of these call types the config stops, at this level of spend. */
function blocked(config: unknown, db: Database): string[] {
  const types = [
    "message",
    "tool_loop",
    "heartbeat",
    "heartbeat_tool_loop",
    "keepalive",
    "compaction",
    "dreaming",
    "memory_query",
  ];
  return types.filter(
    (t) => enforceBudgetForCall(db, config as UsageConfig, call(t), NOW, opts) !== undefined,
  );
}

const budget = (fields: Record<string, unknown>): unknown => ({
  timezone: "utc",
  budgets: [{ name: "b", period: "month", cost_usd: 10, ...fields }],
});

describe("pause_heartbeat", () => {
  test("stops the heartbeat and its tool loop, and nothing else", () => {
    const db = ledgerSpending(12);
    expect(blocked(budget({ limit: "pause_heartbeat", warn_at: [] }), db)).toEqual([
      "heartbeat",
      "heartbeat_tool_loop",
    ]);
  });

  test("the keepalive keeps running, which is the whole point", () => {
    // Under `pause_background` this ping is refused, the prefix dies during the
    // quiet hour, and the next user turn pays a full cache write — the budget
    // costs money instead of saving it.
    const db = ledgerSpending(12);
    const paused = budget({ limit: "pause_heartbeat", warn_at: [] });
    expect(blocked(paused, db)).not.toContain("keepalive");
  });

  test("pause_background also pauses compaction under the safe default", () => {
    const db = ledgerSpending(12);
    expect(blocked(budget({ limit: "pause_background", warn_at: [] }), db)).toEqual([
      "heartbeat",
      "heartbeat_tool_loop",
      "keepalive",
      "compaction",
      "dreaming",
      "memory_query",
    ]);
  });

  test("under the limit it stops nothing", () => {
    const db = ledgerSpending(4);
    expect(blocked(budget({ limit: "pause_heartbeat", warn_at: [] }), db)).toEqual([]);
  });
});

describe("warn_action", () => {
  test("a crossed threshold pauses heartbeats while the limit is still warn", () => {
    // $8.50 of $10: past warn_at 0.8, nowhere near the limit.
    const db = ledgerSpending(8.5);
    const config = budget({ warn_at: [0.8], warn_action: "pause_heartbeat", limit: "warn" });
    expect(blocked(config, db)).toEqual(["heartbeat", "heartbeat_tool_loop"]);
  });

  test("without warn_action a threshold still enforces nothing", () => {
    const db = ledgerSpending(8.5);
    expect(blocked(budget({ warn_at: [0.8], limit: "warn" }), db)).toEqual([]);
  });

  test("below every threshold it does nothing", () => {
    const db = ledgerSpending(7);
    const config = budget({ warn_at: [0.8], warn_action: "block" });
    expect(blocked(config, db)).toEqual([]);
  });

  test("a warn_action harsher than the limit still applies", () => {
    // The limit check runs first and does not block, so this only works if a
    // non-blocking limit falls through to the threshold check.
    const db = ledgerSpending(8.5);
    const config = budget({ warn_at: [0.8], warn_action: "block", limit: "warn" });
    expect(blocked(config, db)).toEqual([
      "message",
      "tool_loop",
      "heartbeat",
      "heartbeat_tool_loop",
      "keepalive",
      "compaction",
      "dreaming",
      "memory_query",
    ]);
  });

  test("the message names the threshold, not a limit that has not been reached", () => {
    const db = ledgerSpending(8.5);
    const config = budget({ warn_at: [0.8], warn_action: "block" }) as UsageConfig;
    const block = enforceBudgetForCall(db, config, call("message"), NOW, opts);
    expect(block?.warn_threshold).toBe(0.8);
    // The real limit, so the number reconciles with `shore usage`.
    expect(block?.cost_limit).toBe(10);
    expect(block?.message).toContain("past its 80% warning threshold");
    expect(block?.message).toContain("$8.50 spent");
    expect(block?.message).toContain("$10.00");
    expect(block?.message).toContain("action Block");
  });

  test("the highest crossed threshold is the one reported", () => {
    const db = ledgerSpending(9.9);
    const config = budget({
      warn_at: [0.5, 0.8, 0.95],
      warn_action: "block",
    }) as UsageConfig;
    const block = enforceBudgetForCall(db, config, call("message"), NOW, opts);
    expect(block?.warn_threshold).toBe(0.95);
  });

  test("over the limit, the limit wins the message", () => {
    // Both are crossed at this point; naming the cap is more useful than
    // naming the 80% mark it passed on the way.
    const db = ledgerSpending(11);
    const config = budget({
      warn_at: [0.8],
      warn_action: "block",
      limit: "block",
    }) as UsageConfig;
    const block = enforceBudgetForCall(db, config, call("message"), NOW, opts);
    expect(block?.warn_threshold).toBeUndefined();
    expect(block?.message).toContain("is over limit");
  });

  test("an empty warn_at can never trip", () => {
    const db = ledgerSpending(9.99);
    expect(blocked(budget({ warn_at: [], warn_action: "block" }), db)).toEqual([]);
  });
});

describe("pace_warn_action", () => {
  const paced = (fields: Record<string, unknown>): unknown =>
    budget({
      period: "month",
      pace_period: "day",
      reset_day_of_month: 5,
      reset_hour: 0,
      ...fields,
    });

  test("falls back to warn_action so one key covers both windows", () => {
    // $0.50 spent against a daily pace allowance of ~$10/31 ≈ $0.32 — over the
    // pace, far under the month.
    const db = ledgerSpending(0.5);
    const config = paced({ warn_at: [0.8], warn_action: "pause_heartbeat", limit: "warn" });
    expect(blocked(config, db)).toEqual(["heartbeat", "heartbeat_tool_loop"]);
  });

  test("its own value overrides the budget's", () => {
    const db = ledgerSpending(0.5);
    const config = paced({
      warn_at: [0.8],
      warn_action: "pause_heartbeat",
      pace_warn_action: "warn",
      limit: "warn",
    });
    // The pace no longer acts; the month is nowhere near its own 80%.
    expect(blocked(config, db)).toEqual([]);
  });
});

describe("effective_action", () => {
  const statuses = (config: unknown, db: Database) =>
    budgetStatuses(db, config as UsageConfig, NOW, opts);

  test("under every threshold it names the limit's action", () => {
    const db = ledgerSpending(4);
    const [status] = statuses(budget({ warn_at: [0.8], warn_action: "block", limit: "pause_heartbeat" }), db);
    expect(status?.status).toBe("ok");
    expect(status?.effective_action).toBe("pause_heartbeat");
  });

  test("in warning it names the warn action, not the limit's", () => {
    const db = ledgerSpending(8.5);
    const [status] = statuses(budget({ warn_at: [0.8], warn_action: "pause_heartbeat", limit: "warn" }), db);
    expect(status?.status).toBe("warning");
    expect(status?.action).toBe("warn");
    expect(status?.effective_action).toBe("pause_heartbeat");
  });

  test("over the limit the limit wins again", () => {
    const db = ledgerSpending(12);
    const [status] = statuses(budget({ warn_at: [0.8], warn_action: "pause_heartbeat", limit: "block" }), db);
    expect(status?.status).toBe("over_limit");
    expect(status?.effective_action).toBe("block");
  });

  test("a warning pace reports its own warn action while the budget stays ok", () => {
    const db = ledgerSpending(0.2);
    const config = budget({
      period: "month",
      pace_period: "day",
      reset_day_of_month: 5,
      reset_hour: 0,
      warn_at: [0.85, 1],
      pace_warn_at: [0.5],
      pace_warn_action: "pause_heartbeat",
      limit: "warn",
    });
    const [status] = statuses(config, db);
    expect(status?.status).toBe("ok");
    expect(status?.effective_action).toBe("warn");
    expect(status?.pace?.status).toBe("warning");
    expect(status?.pace?.action).toBe("warn");
    expect(status?.pace?.effective_action).toBe("pause_heartbeat");
    expect(blocked(config, db)).toEqual(["heartbeat", "heartbeat_tool_loop"]);
  });
});
