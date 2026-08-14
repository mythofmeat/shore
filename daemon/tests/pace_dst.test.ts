import { afterAll, expect, test } from "bun:test";

import { budgetStatuses, type UsageConfig } from "../src/ledger/budget.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const ZONE = "America/New_York";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const PACED_WEEKLY: UsageConfig = {
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

test("day pace holds the local reset hour across spring forward", () => {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);

  const now = Date.parse("2026-03-09T16:00:00+00:00");
  const pace = budgetStatuses(db, PACED_WEEKLY, now, { localZone: ZONE })[0]?.pace;
  expect(pace, "budget configures a pace").toBeDefined();

  expect(pace!.window_start, "the day-pace opens at 06:00 local, post-transition").toBe(
    "2026-03-09T10:00:00+00:00",
  );
  expect(pace!.window_end, "and closes at 06:00 local the next day").toBe(
    "2026-03-10T10:00:00+00:00",
  );

  expect(pace!.periods_remaining, "2 whole days left in the week").toBeCloseTo(2, 9);

  db.close();
});
