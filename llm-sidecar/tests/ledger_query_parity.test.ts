/**
 * Cross-language parity for the ledger's read queries.
 *
 * The fixture was *generated* by running every query under every filter through
 * the real Rust (`query_results_match_shared_fixture` in the daemon's since-
 * deleted `ledger/query.rs`) against a known set of seed rows. That generator
 * is gone with the module it exercised, so the fixture is frozen. This inserts
 * the same rows into a daemon-made ledger, runs the TypeScript that took over,
 * and demands the same answer.
 *
 * These queries define what `shore usage` reports and what a usage budget
 * counts, so a divergence here is a wrong bill, not a wrong number on a screen.
 * Treat a diff as a defect until proven otherwise rather than regenerating.
 *
 * `export_tsv` is compared as a whole string deliberately: it is the one
 * assertion that pins column order, boolean rendering, and float notation at
 * once. It already caught a real one — Rust's `Display` is always positional,
 * so a cost of 1.5e-7 prints as `0.00000015`, where JavaScript would have
 * emitted `1.5e-7`.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import fixture from "./ledger_fixtures/ledger_query_parity.json";
import {
  activeAnthropicCharacters,
  allCostRows,
  exportTsv,
  modelUsageSummary,
  nullCostRows,
  queryAnomalies,
  usageSummary,
  usageSummaryByApiKey,
  usageSummaryByCallType,
  usageSummaryByUsageKind,
  usageTotals,
  warmStreak,
  type QueryFilter,
} from "../src/ledger/query.ts";
import { daemonMadeLedger, haveDaemon } from "./support/ledger_fixture.ts";

interface Case {
  filter: string;
  usage_totals: Record<string, number>;
  usage_summary: unknown[];
  by_call_type: unknown[];
  by_usage_kind: unknown[];
  by_api_key: unknown[];
  model_usage: unknown[];
  anomalies: unknown[];
  active_anthropic: unknown[];
  export_tsv: string;
}

const doc = fixture as unknown as {
  seed: Record<string, unknown>[];
  cases: Case[];
  warm_streak: Record<string, number>;
  null_cost_rows: unknown[];
  all_cost_rows: unknown[];
};

/**
 * The filters the Rust generator ran, by the name it recorded. Kept in step
 * with `parity_filters()` — a name here with no match there fails loudly below
 * rather than silently testing nothing.
 */
const FILTERS: Record<string, QueryFilter> = {
  none: {},
  character: { character: "kai" },
  provider: { provider: "anthropic" },
  api_key_unknown: { api_key_name: "unknown" },
  model: { model: "gpt-4o" },
  call_type: { call_type: "tool_loop" },
  usage_kinds: { usage_kinds: ["message_with_tools", "heartbeat"] },
  window: { since: "2026-04-05T10:02:00Z", until: "2026-04-05T10:06:00Z" },
  compound: {
    character: "aria",
    provider: "anthropic",
    since: "2026-04-05T10:01:00Z",
  },
};

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

/** A daemon-made ledger holding exactly the fixture's seed rows. */
function seededLedger(): Database {
  const f = daemonMadeLedger();
  cleanups.push(f.cleanup);
  const db = new Database(f.path);
  const columns = Object.keys(doc.seed[0]!);
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

test.skipIf(!haveDaemon)("cross-language ledger query parity", () => {
  const db = seededLedger();
  expect(doc.cases.length).toBeGreaterThan(0);

  for (const c of doc.cases) {
    const filter = FILTERS[c.filter];
    expect(filter, `fixture filter "${c.filter}" has no local definition`).toBeDefined();
    const at = (what: string) => `${c.filter}: ${what}`;

    expect(usageTotals(db, filter!), at("usage_totals")).toEqual(
      c.usage_totals as never,
    );
    expect(usageSummary(db, filter!), at("usage_summary")).toEqual(
      c.usage_summary as never,
    );
    expect(usageSummaryByCallType(db, filter!), at("by_call_type")).toEqual(
      c.by_call_type as never,
    );
    expect(usageSummaryByUsageKind(db, filter!), at("by_usage_kind")).toEqual(
      c.by_usage_kind as never,
    );
    expect(usageSummaryByApiKey(db, filter!), at("by_api_key")).toEqual(
      c.by_api_key as never,
    );
    expect(modelUsageSummary(db, filter!), at("model_usage")).toEqual(
      c.model_usage as never,
    );
    expect(queryAnomalies(db, filter!), at("anomalies")).toEqual(
      c.anomalies as never,
    );
    expect(activeAnthropicCharacters(db, filter!), at("active_anthropic")).toEqual(
      c.active_anthropic as never,
    );
    expect(exportTsv(db, filter!), at("export_tsv")).toBe(c.export_tsv);
  }

  for (const [character, streak] of Object.entries(doc.warm_streak)) {
    expect(warmStreak(db, character), `warm_streak: ${character}`).toBe(streak);
  }
  expect(nullCostRows(db), "null_cost_rows").toEqual(doc.null_cost_rows as never);
  expect(allCostRows(db), "all_cost_rows").toEqual(doc.all_cost_rows as never);
});
