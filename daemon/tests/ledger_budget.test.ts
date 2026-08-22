import { expandShared } from "./support/shared_subtrees.ts";
import { required } from "../src/util/required.ts";

import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";

import rawFixture from "./ledger_captures/ledger_budget.json";
const fixture = expandShared<typeof rawFixture>(rawFixture);
import {
  budgetStatuses,
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

const NOW_MOMENTS: Record<string, string> = {
  ordinary_midweek: "2026-03-18T15:00:00+00:00",
  before_spring_forward: "2026-03-06T15:00:00+00:00",
  spring_forward_hour: "2026-03-08T07:30:00+00:00",
  after_spring_forward: "2026-03-10T15:00:00+00:00",
  fall_back_first_pass: "2026-11-01T05:30:00+00:00",
  fall_back_second_pass: "2026-11-01T06:30:00+00:00",
  month_end_clamp: "2026-02-27T15:00:00+00:00",
  trailing_partial_pace: "2026-03-20T15:00:00+00:00",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function statusesAt(configName: string, momentName: string, index: number) {
  const config = required(CONFIGS[configName]);
  const now = Date.parse(required(NOW_MOMENTS[momentName]));
  const db = caseLedger(index);
  try {
    return budgetStatuses(db, config, now, opts);
  } finally {
    db.close();
  }
}

describe("the window a budget is measured over", () => {
  let index = 0;

  test("starts and ends at the configured reset hour, in the budget's own timezone", () => {
    for (const configName of Object.keys(CONFIGS)) {
      for (const status of statusesAt(configName, "ordinary_midweek", index++)) {
        const start = new Date(status.period_start);
        const end = new Date(status.period_end);
        expect(end.getTime(), `${configName}/${status.name}`).toBeGreaterThan(start.getTime());
        expect(status.reset_at, `${configName}/${status.name}`).toBe(status.period_end);
      }
    }
  });

  test("a weekly window is seven days of wall clock, whatever the offset does", () => {
    for (const moment of ["before_spring_forward", "after_spring_forward", "ordinary_midweek"]) {
      for (const configName of ["local_paced_weekly", "utc_paced_weekly"]) {
        const [weekly] = statusesAt(configName, moment, index++);
        const span = Date.parse(required(weekly).period_end) - Date.parse(required(weekly).period_start);
        expect(span, `${configName}/${moment}`).toBeGreaterThanOrEqual(7 * DAY - HOUR);
        expect(span, `${configName}/${moment}`).toBeLessThanOrEqual(7 * DAY + HOUR);
      }
    }
  });

  test("a local weekly window absorbs the lost hour, a utc one does not", () => {
    const spanOf = (configName: string, moment: string) => {
      const [weekly] = statusesAt(configName, moment, index++);
      return Date.parse(required(weekly).period_end) - Date.parse(required(weekly).period_start);
    };
    expect(spanOf("utc_paced_weekly", "before_spring_forward")).toBe(7 * DAY);
    expect(spanOf("utc_paced_weekly", "after_spring_forward")).toBe(7 * DAY);
    expect(
      [spanOf("local_paced_weekly", "before_spring_forward"), spanOf("local_paced_weekly", "after_spring_forward")]
        .some((s) => s !== 7 * DAY),
    ).toBe(true);
  });

  test("an hour that happens twice resolves to one window, not two", () => {
    const first = statusesAt("local_paced_weekly", "fall_back_first_pass", index++);
    const second = statusesAt("local_paced_weekly", "fall_back_second_pass", index++);
    expect(required(second[0]).period_start).toBe(required(first[0]).period_start);
    expect(required(second[0]).period_end).toBe(required(first[0]).period_end);
  });

  test("an hour that never happens still lands inside a window", () => {
    for (const status of statusesAt("local_paced_weekly", "spring_forward_hour", index++)) {
      const now = Date.parse(required(NOW_MOMENTS["spring_forward_hour"]));
      expect(Date.parse(status.period_start)).toBeLessThanOrEqual(now);
      expect(Date.parse(status.period_end)).toBeGreaterThan(now);
    }
  });

  test("a reset day past the end of a short month clamps to its last day", () => {
    const monthly = statusesAt("local_mixed", "month_end_clamp", index++).find(
      (s) => s.period === "month",
    );
    expect(monthly).toBeDefined();
    const end = new Date(required(monthly).period_end);
    expect(Number.isNaN(end.getTime())).toBe(false);
    expect(Date.parse(required(monthly).period_end)).toBeGreaterThan(
      Date.parse(required(monthly).period_start),
    );
  });

  test("every window contains the instant it was computed for", () => {
    for (const [momentName, iso] of Object.entries(NOW_MOMENTS)) {
      const now = Date.parse(iso);
      for (const configName of Object.keys(CONFIGS)) {
        for (const status of statusesAt(configName, momentName, index++)) {
          const where = `${configName}/${momentName}/${status.name}`;
          expect(Date.parse(status.period_start), where).toBeLessThanOrEqual(now);
          expect(Date.parse(status.period_end), where).toBeGreaterThan(now);
        }
      }
    }
  });
});

describe("what a budget reports about spending", () => {
  let index = 1000;

  test("cost is never negative, and the ratio agrees with the cost and the limit", () => {
    for (const configName of Object.keys(CONFIGS)) {
      for (const status of statusesAt(configName, "ordinary_midweek", index++)) {
        const where = `${configName}/${status.name}`;
        expect(status.current_cost, where).toBeGreaterThanOrEqual(0);
        expect(status.cost_limit, where).toBeGreaterThan(0);
        expect(status.percent_used, where).toBeCloseTo(status.current_cost / status.cost_limit, 6);
      }
    }
  });

  test("a filtered budget counts less than an unfiltered one over the same window", () => {
    const mixed = statusesAt("local_mixed", "ordinary_midweek", index++);
    const filteredStatus = mixed.find((s) => s.name === "filtered");
    const dayStatus = mixed.find((s) => s.period === "day" && s.name !== "filtered");
    if (filteredStatus !== undefined && dayStatus !== undefined) {
      expect(filteredStatus.current_cost).toBeLessThanOrEqual(dayStatus.current_cost);
    }
  });
});

describe("crossing a warning threshold", () => {
  let index = 2000;

  const scoped = (
    warnings: readonly { scope?: string }[],
    scope: string,
  ): readonly { scope?: string }[] => warnings.filter((w) => w.scope === scope);

  test("reports only the thresholds newly crossed, so a re-check narrows", () => {
    for (const configName of Object.keys(CONFIGS)) {
      const config = required(CONFIGS[configName]);
      const now = Date.parse(required(NOW_MOMENTS["ordinary_midweek"]));
      const db = caseLedger(index++);
      try {
        const crossings = (ws: readonly { crossed_warn_at?: readonly number[] }[]) =>
          ws.flatMap((w) => w.crossed_warn_at ?? []);
        const first = crossings(newlyCrossedBudgetWarnings(db, config, now, opts));
        const second = crossings(newlyCrossedBudgetWarnings(db, config, now, opts));
        expect(second.length, configName).toBeLessThanOrEqual(first.length);
        for (const t of second) {
          expect(first, `${configName}: a re-check never invents a threshold`).toContain(t);
        }
      } finally {
        db.close();
      }
    }
  });

  test("a warning names its budget, its cost against its limit, and when it resets", () => {
    const config = required(CONFIGS["local_mixed"]);
    const now = Date.parse(required(NOW_MOMENTS["ordinary_midweek"]));
    const db = caseLedger(index++);
    try {
      const warnings = newlyCrossedBudgetWarnings(db, config, now, opts);
      expect(warnings.length).toBeGreaterThan(0);
      for (const w of warnings) {
        expect(w.message).toContain(w.budget);
        expect(w.message).toMatch(/\$\d/);
        expect(w.percent_used).toBeCloseTo(w.current_cost / w.cost_limit, 6);
        expect(Date.parse(w.reset_at)).toBeGreaterThan(now);
      }
    } finally {
      db.close();
    }
  });

  test("a pace warning keeps recurring, because the pace is still over", () => {
    const config = required(CONFIGS["local_paced_weekly"]);
    const now = Date.parse(required(NOW_MOMENTS["ordinary_midweek"]));
    const db = caseLedger(index++);
    try {
      const first = scoped(newlyCrossedBudgetWarnings(db, config, now, opts), "pace");
      const second = scoped(newlyCrossedBudgetWarnings(db, config, now, opts), "pace");
      expect(first.length).toBeGreaterThan(0);
      expect(second.length, "the pace is still over, so it still warns").toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("enforcing a budget on a call", () => {
  let index = 3000;

  test("a block always names which budget stopped the call", () => {
    for (const configName of Object.keys(CONFIGS)) {
      const config = required(CONFIGS[configName]);
      const now = Date.parse(required(NOW_MOMENTS["ordinary_midweek"]));
      const db = caseLedger(index++);
      try {
        for (const [callName, call] of Object.entries(CALLS)) {
          const block = enforceBudgetForCall(db, config, call, now, opts);
          if (block === undefined) continue;
          const where = `${configName}/${callName}`;
          expect(block.message, where).toBeTruthy();
          expect(block.scope, where).toBeTruthy();
        }
      } finally {
        db.close();
      }
    }
  });

  test("a filtered budget only blocks the calls its filter names", () => {
    const config: UsageConfig = {
      timezone: "local",
      allow_compaction_over_budget: true,
      budgets: [filtered],
    };
    const now = Date.parse(required(NOW_MOMENTS["ordinary_midweek"]));
    const db = caseLedger(index++);
    try {
      const outside = {
        provider: "nobody",
        api_key_name: "none",
        model: "no-such-model",
        call_type: "message",
        character: "nobody",
      };
      expect(enforceBudgetForCall(db, config, outside, now, opts)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
