import { required } from "../src/util/required.ts";

import { afterAll, describe, expect, test } from "bun:test";

import seedDoc from "./ledger_captures/ledger_seed.json";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { parseLastPeriod, usageReport } from "../src/ledger/usage.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";
import { outcomeOf } from "./support/outcome.ts";

const doc = seedDoc as unknown as {
  timezone: string;
  now: string;
  seed: Record<string, unknown>[];
  periods: { timezone: string; last: string; since: string | null }[];
};

const NOW = Date.parse(doc.now);
const opts = { localZone: doc.timezone, now: NOW };

function config(timezone = "utc"): UsageConfig {
  return {
    timezone,

    budgets: [
      {
        name: "daily",
        period: "day",
        cost_usd: 0.05,
        warn_at: [0.5, 1.0],
        limit: "warn",
        usage_kind: [],
        reset_hour: 6,
      },
    ],
  };
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  closeLedgers();
  for (const c of cleanups) c();
});

function seededLedgerPath(): string {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  const columns = Object.keys(required(doc.seed[0]));
  const sql = `INSERT INTO calls (${columns.join(", ")}) VALUES (${columns
    .map((c) => `$${c}`)
    .join(", ")})`;
  for (const row of doc.seed) {
    db.query(sql).run(
      Object.fromEntries(columns.map((c) => [`$${c}`, row[c] as string | number | null])),
    );
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return f.path;
}

const LEDGER = seededLedgerPath();

const report = (args: Record<string, unknown>, timezone = "utc"): Promise<unknown> =>
  usageReport({ ledger: LEDGER, args, usage: config(timezone) }, opts);

interface SummaryRow {
  call_count: number;
  total_cost: number;
  total_input: number;
}

const summaryOf = async (args: Record<string, unknown> = {}): Promise<SummaryRow[]> =>
  ((await report(args)) as { summary: SummaryRow[] }).summary;

describe("resolving a --last window", () => {
  test("every accepted spelling lands on the instant it names", () => {
    expect(doc.periods.length).toBeGreaterThan(0);
    for (const c of doc.periods) {
      expect(
        parseLastPeriod(c.last, NOW, c.timezone, opts) ?? null,
        `${c.timezone}/${JSON.stringify(c.last)}`,
      ).toBe(c.since);
    }
  });

  test("`all` means no lower bound at all", () => {
    expect(parseLastPeriod("all", NOW, "utc", opts) ?? null).toBeNull();
  });

  test("a longer window covers at least as much as a shorter one", () => {
    const day = parseLastPeriod("today", NOW, "utc", opts);
    const week = parseLastPeriod("this_week", NOW, "utc", opts);
    const month = parseLastPeriod("this_month", NOW, "utc", opts);
    expect(Date.parse(required(month))).toBeLessThanOrEqual(Date.parse(required(week)));
    expect(Date.parse(required(week))).toBeLessThanOrEqual(Date.parse(required(day)));
  });

  test("the same spelling in two timezones resolves to two instants", () => {
    expect(parseLastPeriod("today", NOW, "utc", opts)).not.toBe(
      parseLastPeriod("today", NOW, "local", opts),
    );
  });
});

describe("a --last shore cannot make sense of", () => {
  for (const bad of ["banana", "", "d"]) {
    test(`${JSON.stringify(bad)} is refused rather than read as all time`, async () => {
      expect(await outcomeOf(report({ last: bad }))).toThrow("unknown usage period");
    });
  }
});

describe("a --last shore reads loosely", () => {
  test("trailing junk after a unit is ignored, so 4hh is four hours", () => {
    expect(parseLastPeriod("4hh", NOW, "utc", opts)).toBe(
      required(parseLastPeriod("4h", NOW, "utc", opts)),
    );
  });

  test("zero of a unit is now, which reports nothing before it", () => {
    expect(Date.parse(required(parseLastPeriod("0d", NOW, "utc", opts)))).toBe(NOW);
  });

  test("a negative count reaches into the future, so the window is empty", async () => {
    const since = required(parseLastPeriod("-1d", NOW, "utc", opts));
    expect(Date.parse(since)).toBeGreaterThan(NOW);
    expect(await summaryOf({ last: "-1d" })).toEqual([]);
  });
});

describe("the default summary", () => {
  test("groups by provider and model, and every row carries its totals", async () => {
    const rows = (await report({ last: "all" })) as {
      mode: string;
      period: string;
      summary: { provider: string; model: string; call_count: number }[];
    };
    expect(rows.mode).toBe("summary");
    expect(rows.period).toBe("all");
    expect(rows.summary.length).toBeGreaterThan(1);
    for (const row of rows.summary) {
      expect(row.provider).toBeTruthy();
      expect(row.model).toBeTruthy();
      expect(row.call_count).toBeGreaterThan(0);
    }
  });

  test("its call counts add up to the calls in the window", async () => {
    const all = await summaryOf({ last: "all" });
    expect(all.reduce((n, r) => n + r.call_count, 0)).toBe(doc.seed.length);
  });

  test("a narrower window can only report fewer calls", async () => {
    const all = await summaryOf({ last: "all" });
    const today = await summaryOf({ last: "today" });
    const total = (rows: SummaryRow[]) => rows.reduce((n, r) => n + r.call_count, 0);
    expect(total(today)).toBeLessThanOrEqual(total(all));
    expect(total(today)).toBeGreaterThan(0);
  });
});

describe("grouping the same window a different way", () => {
  for (const dimension of ["kind", "api_key", "call_type", "model", "provider"]) {
    test(`by ${dimension} keeps the total call count`, async () => {
      const grouped = (await report({ last: "all", group_by: dimension })) as {
        mode: string;
        dimension: string;
        summary: { group: string; call_count: number }[];
      };
      expect(grouped.mode).toBe("summary_by");
      expect(grouped.dimension).toBe(dimension);
      expect(grouped.summary.reduce((n, r) => n + r.call_count, 0)).toBe(doc.seed.length);
      expect(new Set(grouped.summary.map((r) => r.group)).size).toBe(grouped.summary.length);
    });
  }
});

describe("filtering", () => {
  const total = (rows: SummaryRow[]) => rows.reduce((n, r) => n + r.call_count, 0);

  for (const [label, filter] of [
    ["character", { character: "aria" }],
    ["provider", { provider: "anthropic" }],
    ["model", { model: "gpt-5.5" }],
    ["call type", { call_type: "tool_loop" }],
  ] as const) {
    test(`by ${label} narrows, it never widens`, async () => {
      const all = await summaryOf({ last: "all" });
      const filtered = await summaryOf({ last: "all", ...filter });
      expect(total(filtered)).toBeLessThan(total(all));
    });
  }

  test("a filter matching nothing reports nothing, rather than everything", async () => {
    expect(await summaryOf({ last: "all", model: "no-such-model" })).toEqual([]);
  });

  test("filtering by provider leaves only that provider's rows", async () => {
    const rows = (await report({ last: "all", provider: "anthropic" })) as {
      summary: { provider: string }[];
    };
    expect(rows.summary.every((r) => r.provider === "anthropic")).toBe(true);
  });
});

describe("exporting the rows", () => {
  for (const [mode, args, sep] of [
    ["tsv", { export_tsv: true }, "\t"],
    ["csv", { export_csv: true }, ","],
  ] as const) {
    test(`${mode} writes a header and one line per call`, async () => {
      const out = (await report({ last: "all", ...args })) as { mode: string; data: string };
      expect(out.mode).toBe(mode);
      const lines = out.data.trimEnd().split("\n");
      expect(lines).toHaveLength(doc.seed.length + 1);
      expect(required(lines[0])).toContain(`ts${sep}character`);
    });

    test(`${mode} gives every line the same number of fields as the header`, async () => {
      const out = (await report({ last: "all", ...args })) as { data: string };
      const lines = out.data.trimEnd().split("\n");
      const width = required(lines[0]).split(sep).length;
      for (const [i, line] of lines.entries()) {
        if (mode === "csv" && line.includes('"')) continue;
        expect(line.split(sep), `line ${i}`).toHaveLength(width);
      }
    });
  }

  test("a csv field containing the separator is quoted, so it stays one field", async () => {
    const out = (await report({ last: "all", export_csv: true })) as { data: string };
    for (const line of out.data.split("\n")) {
      const quoted = line.match(/"([^"]|"")*"/g) ?? [];
      for (const field of quoted) expect(field.startsWith('"') && field.endsWith('"')).toBe(true);
    }
  });
});

describe("the budget view", () => {
  test("reports each configured budget against what has been spent", async () => {
    const out = (await report({ last: "all", budget: true })) as {
      mode: string;
      budgets: { name: string; cost_limit: number; current_cost: number; percent_used: number }[];
    };
    expect(out.mode).toBe("budget");
    const daily = required(out.budgets.find((b) => b.name === "daily"));
    expect(daily.cost_limit).toBe(0.05);
    expect(daily.current_cost).toBeGreaterThan(0);
    expect(daily.percent_used).toBeCloseTo(daily.current_cost / daily.cost_limit, 5);
  });

  test("percent_used is a ratio despite the name, so 1.6 means 160% spent", async () => {
    const out = (await report({ last: "all", budget: true })) as {
      budgets: { current_cost: number; cost_limit: number; percent_used: number }[];
    };
    const daily = required(out.budgets[0]);
    expect(daily.current_cost).toBeGreaterThan(daily.cost_limit);
    expect(daily.percent_used).toBeGreaterThan(1);
    expect(daily.percent_used).toBeLessThan(100);
  });

  test("its window carries the configured reset hour", async () => {
    const out = (await report({ last: "all", budget: true })) as {
      budgets: { period_start: string; period_end: string }[];
    };
    const daily = required(out.budgets[0]);
    expect(daily.period_start).toContain("06:00:00");
    expect(Date.parse(daily.period_end)).toBeGreaterThan(Date.parse(daily.period_start));
  });
});

describe("the anomalies view", () => {
  test("reports the calls whose cache behaviour did not make sense", async () => {
    const out = (await report({ last: "all", anomalies: true })) as {
      mode: string;
      anomalies: { anomaly: string; ts: string }[];
    };
    expect(out.mode).toBe("anomalies");
    expect(out.anomalies.length).toBeGreaterThan(0);
    for (const a of out.anomalies) {
      expect(a.anomaly).toBeTruthy();
      expect(Number.isNaN(Date.parse(a.ts))).toBe(false);
    }
  });

  test("a write with nothing read back is one of them", async () => {
    const out = (await report({ last: "all", anomalies: true })) as {
      anomalies: { anomaly: string }[];
    };
    expect(out.anomalies.map((a) => a.anomaly)).toContain("unexpected_write");
  });
});
