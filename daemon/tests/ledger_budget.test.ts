import { required } from "../src/util/required.ts";

import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { afterAll, expect, test } from "bun:test";

import fixture from "./ledger_fixtures/ledger_budget.json";
import {
  budgetStatuses,
  type BudgetStatus,
  enforceBudgetForCall,
  newlyCrossedBudgetWarnings,
  type BudgetCallContext,
  type UsageBudgetConfig,
  type UsageBudgetPeriod,
  type UsageConfig,
} from "../src/ledger/budget.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

interface Case {
  config: string;
  now_name: string;
  now: string;
  statuses: unknown[];
  warnings_first: unknown[];
  warnings_second: unknown[];
  enforce: Record<string, { allowed: boolean } & Record<string, unknown>>;
}

const doc = fixture as unknown as {
  timezone: string;
  seed: Record<string, unknown>[];
  cases: Case[];
};

const opts = { localZone: doc.timezone };

const budget = (
  name: string,
  period: UsageBudgetPeriod,
  cost_usd: number,
): UsageBudgetConfig => ({
  name,
  period,
  cost_usd,
  warn_at: [0.5, 0.805, 1.0],
  limit: "warn",
  usage_kind: [],
});

const pacedWeekly: UsageBudgetConfig = {
  ...budget("weekly", "week", 14.0),
  reset_hour: 6,
  reset_day_of_week: "wednesday",
  pace_period: "day",
};

const blockingDay: UsageBudgetConfig = {
  ...budget("daily-block", "day", 2.0),
  limit: "block",
  reset_hour: 6,
  pace_period: "hour",
  pace_action: "pause_background",
};

const filtered: UsageBudgetConfig = {
  ...budget("aria-tools", "month", 5.0),
  character: "aria",
  usage_kind: ["message_with_tools"],
  limit: "warn",
};

const backgroundPause: UsageBudgetConfig = {
  ...budget("aria-background", "month", 2.0),
  character: "aria",
  limit: "pause_background",
};

const exactLimit: UsageBudgetConfig = {
  ...budget("kai-exact", "month", 0.4),
  character: "kai",
  limit: "block",
};

const unknownKey: UsageBudgetConfig = {
  ...budget("unknown-key", "month", 0.5),
  api_key: "unknown",
  limit: "block",
};

const clampedMonth: UsageBudgetConfig = {
  ...budget("month-31", "month", 20.0),
  reset_day_of_month: 31,
  reset_hour: 9,
  pace_period: "week",
};

const CONFIGS: Record<string, UsageConfig> = {
  local_paced_weekly: {
    timezone: "local",
    allow_compaction_over_budget: true,
    budgets: [pacedWeekly],
  },
  utc_paced_weekly: {
    timezone: "utc",
    allow_compaction_over_budget: true,
    budgets: [pacedWeekly],
  },
  local_mixed: {
    timezone: "local",
    allow_compaction_over_budget: true,
    budgets: [blockingDay, filtered, clampedMonth],
  },
  local_edges: {
    timezone: "local",
    allow_compaction_over_budget: true,
    budgets: [backgroundPause, exactLimit, unknownKey],
  },
};

const CALLS: Record<string, BudgetCallContext> = {
  foreground_aria: {
    provider: "anthropic",
    api_key_name: "default",
    model: "claude-opus-4-6",
    call_type: "message",
    character: "aria",
  },
  tool_loop_aria: {
    provider: "anthropic",
    api_key_name: "default",
    model: "claude-opus-4-6",
    call_type: "tool_loop",
    character: "aria",
  },
  heartbeat_kai: {
    provider: "anthropic",
    api_key_name: "default",
    model: "claude-opus-4-6",
    call_type: "heartbeat",
    character: "kai",
  },
  keepalive_aria: {
    provider: "anthropic",
    api_key_name: "default",
    model: "claude-opus-4-6",
    call_type: "keepalive",
    character: "aria",
  },
  compaction_aria: {
    provider: "anthropic",
    api_key_name: "default",
    model: "claude-opus-4-6",
    call_type: "compaction",
    character: "aria",
  },
  subscription_provider: {
    provider: "opencode-go",
    model: "kimi-k3",
    call_type: "message",
    character: "aria",
  },
  no_key_name: {
    provider: "anthropic",
    model: "claude-opus-4-6",
    call_type: "message",
    character: "aria",
  },
};

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

let template: string | undefined;

function caseLedger(index: number): Database {
  if (template === undefined) {
    const f = freshLedger();
    cleanups.push(f.cleanup);
    const db = openLedger(f.path);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    template = f.path;
  }
  const path = `${template}.case${index}`;
  copyFileSync(template, path);
  const db = openLedger(path);
  const columns = Object.keys(required(doc.seed[0]));
  const sql = `INSERT INTO calls (${columns.join(", ")}) VALUES (${columns
    .map((c) => `$${c}`)
    .join(", ")})`;
  for (const row of doc.seed) {
    db.query(sql).run(
      Object.fromEntries(
        columns.map((c) => [`$${c}`, row[c] as string | number | null]),
      ),
    );
  }
  return db;
}

function withoutChangedPolicy(status: BudgetStatus): unknown {
  const { effective_action: _dropped, pace: _changed, ...rest } = status;
  return rest;
}

function fixtureWithoutPace(status: unknown): unknown {
  if (status === null || typeof status !== "object") return status;
  const { pace: _changed, ...rest } = status as Record<string, unknown>;
  return rest;
}

function nonPaceWarnings(events: unknown[]): unknown[] {
  return events.filter(
    (event) =>
      event === null ||
      typeof event !== "object" ||
      (event as Record<string, unknown>)["scope"] !== "pace",
  );
}

test("the recorded budget cases still hold outside the changed pace policy", () => {
  expect(doc.cases.length).toBeGreaterThan(0);

  doc.cases.forEach((c, i) => {
    const config = CONFIGS[c.config];
    expect(config, `fixture config "${c.config}" has no local definition`).toBeDefined();
    const now = Date.parse(c.now);
    const db = caseLedger(i);
    const at = (what: string) => `${c.config}/${c.now_name}: ${what}`;

    expect(
      budgetStatuses(db, required(config), now, opts).map(withoutChangedPolicy),
      at("statuses"),
    ).toEqual(c.statuses.map(fixtureWithoutPace) as never);
    for (const [name, call] of Object.entries(CALLS)) {
      const block = enforceBudgetForCall(db, required(config), call, now, opts);
      const expected = required(c.enforce[name]);
      if (expected.scope === "pace" || block?.scope === "pace") continue;
      if (expected.allowed) {
        expect(block, at(`enforce ${name} (expected allow)`)).toBeUndefined();
      } else {
        expect(block, at(`enforce ${name} (expected block)`)).toBeDefined();
        expect({ allowed: false, ...block }, at(`enforce ${name}`)).toEqual(
          expected as never,
        );
      }
    }

    expect(
      nonPaceWarnings(newlyCrossedBudgetWarnings(db, required(config), now, opts)),
      at("warnings_first"),
    ).toEqual(nonPaceWarnings(c.warnings_first) as never);
    expect(
      nonPaceWarnings(newlyCrossedBudgetWarnings(db, required(config), now, opts)),
      at("warnings_second"),
    ).toEqual(nonPaceWarnings(c.warnings_second) as never);

    db.close();
  });
}, 60_000);
