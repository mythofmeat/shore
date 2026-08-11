import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { budgetStatuses, type UsageConfig } from "../src/ledger/budget.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.length = 0;
});

const config: UsageConfig = {
  timezone: "utc",
  budgets: [{
    name: "weekly",
    period: "week",
    cost_usd: 15,
    reset_day_of_week: "monday",
    reset_hour: 0,
    pace_period: "day",
    warn_at: [],
    pace_warn_at: [],
  }],
};

function ledger(spend: Array<[string, number]>): Database {
  const fixture = freshLedger();
  cleanups.push(fixture.cleanup);
  const db = openLedger(fixture.path);
  cleanups.push(() => db.close());
  const insert = db.query(
    `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
     VALUES (?1, 'aria', 'anthropic', 'default', 'claude', 'message',
       1, 1, 0, 0, 1, 1, 'end_turn', 1, 'pricing_catalog', ?2)`,
  );
  for (const [ts, cost] of spend) insert.run(ts, cost);
  return db;
}

function pace(db: Database, now: string) {
  return budgetStatuses(db, config, Date.parse(now), { localZone: "UTC" })[0]!.pace!;
}

const BASE = 15 / 7;

describe("rollover pacing", () => {
  test("an underspend carries forward at full value early in the week", () => {
    const db = ledger([["2026-08-10T12:00:00Z", BASE / 2]]);
    const status = pace(db, "2026-08-11T12:00:00Z");
    expect(status.base_allowance).toBeCloseTo(BASE, 9);
    expect(status.rollover).toBeCloseTo(BASE / 2, 9);
    expect(status.allowance).toBeCloseTo(BASE + BASE / 2, 9);
    expect(status.debt_adjustment).toBeCloseTo(0, 9);
  });

  test("the same underspend has the same next-day value late in the week", () => {
    const spend: Array<[string, number]> = [];
    for (let day = 10; day <= 14; day += 1) {
      spend.push([`2026-08-${day}T12:00:00Z`, BASE]);
    }
    spend.push(["2026-08-15T12:00:00Z", BASE / 2]);
    const status = pace(ledger(spend), "2026-08-16T12:00:00Z");
    expect(status.rollover).toBeCloseTo(BASE / 2, 9);
    expect(status.allowance).toBeCloseTo(BASE + BASE / 2, 9);
  });

  test("overspend is amortized across all remaining days", () => {
    const status = pace(
      ledger([["2026-08-10T12:00:00Z", BASE + 1]]),
      "2026-08-11T12:00:00Z",
    );
    expect(status.rollover).toBeCloseTo(0, 9);
    expect(status.debt_adjustment).toBeCloseTo(1 / 6, 9);
    expect(status.base_allowance).toBeCloseTo(BASE - 1 / 6, 9);
  });

  test("rollover absorbs a later heavy day before debt is created", () => {
    const db = ledger([
      ["2026-08-10T12:00:00Z", BASE - 1],
      ["2026-08-11T12:00:00Z", BASE + 0.75],
    ]);
    const status = pace(db, "2026-08-12T12:00:00Z");
    expect(status.rollover).toBeCloseTo(0.25, 9);
    expect(status.debt_adjustment).toBeCloseTo(0, 9);
    expect(status.allowance).toBeCloseTo(BASE + 0.25, 9);
  });
});
