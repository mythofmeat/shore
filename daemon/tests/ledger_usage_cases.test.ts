import { afterAll, expect, test } from "bun:test";

import fixture from "./ledger_fixtures/ledger_usage_cases.json";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { parseLastPeriod, usageReport } from "../src/ledger/usage.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

interface PeriodCase {
  timezone: string;
  last: string;
  since: string | null;
}

interface PayloadCase {
  timezone: string;
  mode: string;
  last: string;
  filter: string;
  payload: unknown;
}

const doc = fixture as unknown as {
  timezone: string;
  now: string;
  seed: Record<string, unknown>[];
  periods: PeriodCase[];
  payloads: PayloadCase[];
};

const NOW = Date.parse(doc.now);
const opts = { localZone: doc.timezone, now: NOW };

function config(timezone: string): UsageConfig {
  return {
    timezone,
    allow_compaction_over_budget: false,
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

const MODES: Record<string, Record<string, unknown>> = {
  summary: {},
  budget: { budget: true },
  tsv: { export_tsv: true },
  csv: { export_csv: true },
  by_kind: { by_kind: true },
  by_api_key: { by_api_key: true },
  by_call_type: { by_call_type: true },
  anomalies: { anomalies: true },
};

const FILTERS: Record<string, Record<string, unknown>> = {
  none: {},
  character: { character: "aria" },
  provider: { provider: "anthropic" },
  api_key_unknown: { api_key: "unknown" },
  model: { model: "gpt-5.5" },
  call_type: { call_type: "tool_loop" },
};

const TOOL_SURFACE_INDEX = 12;

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

const joinCsvLine = (fields: string[]): string =>
  fields.map((f) => (/[",\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(",");

function withoutToolSurface(mode: string, data: string): string {
  const [split, join] =
    mode === "csv"
      ? [splitCsvLine, joinCsvLine]
      : [(l: string) => l.split("\t"), (f: string[]) => f.join("\t")];
  return data
    .split("\n")
    .map((line) => {
      const fields = split(line);
      fields.splice(TOOL_SURFACE_INDEX, 1);
      return join(fields);
    })
    .join("\n");
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
  const columns = Object.keys(doc.seed[0]!);
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

test("every recorded `--last` window resolves the same instant", () => {
  expect(doc.periods.length).toBeGreaterThan(0);

  for (const c of doc.periods) {
    expect(
      parseLastPeriod(c.last, NOW, c.timezone, opts) ?? null,
      `${c.timezone}/${JSON.stringify(c.last)}`,
    ).toBe(c.since);
  }
});

test("every recorded usage payload comes back the same", async () => {
  expect(doc.payloads.length).toBeGreaterThan(0);
  const ledger = seededLedgerPath();

  for (const c of doc.payloads) {
    const mode = MODES[c.mode];
    const filter = FILTERS[c.filter];
    expect(mode, `fixture mode "${c.mode}" has no local definition`).toBeDefined();
    expect(filter, `fixture filter "${c.filter}" has no local definition`).toBeDefined();

    const actual = await usageReport(
      {
        ledger,
        args: { last: c.last, ...mode, ...filter },
        usage: config(c.timezone),
      },
      opts,
    );
    const where = `${c.timezone}/${c.mode}/${c.last}/${c.filter}`;
    if (c.mode === "tsv" || c.mode === "csv") {
      const payload = actual as { mode: string; data: string };
      const expected = c.payload as { mode: string; data: string };
      if (c.mode === "csv") {
        for (const line of expected.data.split("\n")) {
          expect(joinCsvLine(splitCsvLine(line)), `${where}: csv round-trip`).toBe(line);
        }
      }
      expect(payload.mode, where).toBe(expected.mode);
      expect(withoutToolSurface(c.mode, payload.data), where).toBe(expected.data);
      continue;
    }
    expect(withoutEffectiveAction(actual), where).toEqual(
      withoutRemovedSpikeWarnings(c.payload) as never,
    );
  }
});

function withoutRemovedSpikeWarnings(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  const { spike_warnings: _removed, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function withoutEffectiveAction(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  const report = payload as {
    budgets?: Record<string, unknown>[];
    call_attempts?: unknown;
  };
  const {
    call_attempts: _attempts,
    rate_limits: _quota,
    cache_coverage: _coverage,
    anomaly_counts_7d: _byKind,
    ...withoutAttempts
  } = report as typeof report & {
    rate_limits?: unknown;
    cache_coverage?: unknown;
    anomaly_counts_7d?: unknown;
  };
  if (report.budgets === undefined) return withoutAttempts;
  const strip = (o: Record<string, unknown>): Record<string, unknown> => {
    const { effective_action: _dropped, ...rest } = o;
    const pace = rest["pace"];
    if (pace === null || typeof pace !== "object") return rest;
    return { ...rest, pace: strip(pace as Record<string, unknown>) };
  };
  return { ...withoutAttempts, budgets: report.budgets.map(strip) };
}
