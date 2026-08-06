/**
 * Pace sub-windows across a DST transition, in the budget's *local* timezone.
 *
 * Migrated from `crates/daemon/tests/pace_dst.rs` when the budget arithmetic
 * moved here. It kept its own file there because it had to set `TZ`, which is
 * process-global; that constraint is gone — `BudgetOptions.localZone` pins the
 * zone per call — but the test is worth keeping standalone for what it is: the
 * one case that states, in numbers, why `PeriodWindow` carries naive bounds at
 * all.
 *
 * The parity fixture covers this instant too. This is the readable version:
 * the fixture proves the two implementations agree, and this says what they
 * agree *on*, so a future change that breaks it fails with a sentence rather
 * than a JSON diff.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import { budgetStatuses, type UsageConfig } from "../src/ledger/budget.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const ZONE = "America/New_York";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const PACED_WEEKLY: UsageConfig = {
  // Anything but "utc" selects the local path.
  timezone: "local",
  budgets: [
    {
      name: "weekly",
      period: "week",
      cost_usd: 14.0,
      warn_at: [0.8, 1.0],
      limit: "warn",
      usage_kind: [],
      reset_hour: 6,
      reset_day_of_week: "wednesday",
      pace_period: "day",
    },
  ],
};

/**
 * US spring-forward 2026 is Sunday March 8 (02:00 EST -> 03:00 EDT). A weekly
 * budget anchored to Wednesday 06:00 straddles it: the week opens Wed March 4
 * at 06:00 EST (11:00Z) and closes Wed March 11 at 06:00 EDT (10:00Z).
 *
 * Every day-pace boundary inside that week must sit at 06:00 *local*. Stepping
 * in instant space instead would hold every boundary at 11:00Z — 07:00 EDT
 * after the transition, an hour off the budget's own reset hour, which is
 * exactly the drift the naive stepping exists to prevent.
 */
test("day pace holds the local reset hour across spring forward", () => {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);

  // Monday March 9, 12:00 EDT — the day after the transition.
  const now = Date.parse("2026-03-09T16:00:00+00:00");
  const pace = budgetStatuses(db, PACED_WEEKLY, now, { localZone: ZONE })[0]?.pace;
  expect(pace, "budget configures a pace").toBeDefined();

  // 06:00 EDT on the 9th and the 10th, i.e. 10:00Z — not the 11:00Z that
  // instant-space stepping from the pre-transition week start would give.
  expect(pace!.window_start, "the day-pace opens at 06:00 local, post-transition").toBe(
    "2026-03-09T10:00:00+00:00",
  );
  expect(pace!.window_end, "and closes at 06:00 local the next day").toBe(
    "2026-03-10T10:00:00+00:00",
  );

  // The week is 7 days of wall clock but only 167 hours of elapsed time.
  // `periods_remaining` counts wall-clock days, so Monday sees a clean 2 days
  // left (itself and Tuesday) — no fractional smear from the lost hour, which
  // an elapsed-seconds count over instants would produce.
  expect(pace!.periods_remaining, "2 whole days left in the week").toBeCloseTo(2, 9);

  db.close();
});
