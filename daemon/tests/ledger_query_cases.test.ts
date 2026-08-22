import { expandShared } from "./support/shared_subtrees.ts";
import { required } from "../src/util/required.ts";

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import rawFixture from "./ledger_fixtures/ledger_query_cases.json";
const fixture = expandShared<typeof rawFixture>(rawFixture);
import {
  activeAnthropicCharacters,
  allCostRows,
  exportTsv,
  modelUsageSummary,
  nullCostRows,
  queryAnomalies,
  usageSummary,
  usageSummaryBy,
  usageTotals,
  warmStreak,
  type QueryFilter,
} from "../src/ledger/query.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

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

function withoutToolSurface<T extends { tool_surface: unknown }>(rows: T[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const {
      tool_surface: _dropped,
      output_tokens_estimated: _alsoPostRust,
      thinking_dropped: _postRustToo,
      cache_state_reason: _andThis,
      ...rest
    } = row as T & {
      output_tokens_estimated?: unknown;
      thinking_dropped?: unknown;
      cache_state_reason?: unknown;
    };
    return rest;
  });
}

const TOOL_SURFACE_TSV_INDEX = 12;

function withoutToolSurfaceColumn(tsv: string): string {
  return tsv
    .split("\n")
    .map((line) => {
      const fields = line.split("\t");
      fields.splice(TOOL_SURFACE_TSV_INDEX, 1);
      return fields.join("\t");
    })
    .join("\n");
}

const doc = fixture as unknown as {
  seed: Record<string, unknown>[];
  cases: Case[];
  warm_streak: Record<string, number>;
  null_cost_rows: unknown[];
  all_cost_rows: unknown[];
};

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

function seededLedger(): Database {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
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

test("every recorded filter answers the same ten queries", () => {
  const db = seededLedger();
  expect(doc.cases.length).toBeGreaterThan(0);

  for (const c of doc.cases) {
    const filter = FILTERS[c.filter];
    expect(filter, `fixture filter "${c.filter}" has no local definition`).toBeDefined();
    const at = (what: string) => `${c.filter}: ${what}`;

    expect(usageTotals(db, required(filter)), at("usage_totals")).toEqual(
      c.usage_totals as never,
    );
    expect(usageSummary(db, required(filter)), at("usage_summary")).toEqual(
      c.usage_summary as never,
    );
    expect(usageSummaryBy(db, required(filter), "call_type"), at("by_call_type")).toEqual(
      c.by_call_type as never,
    );
    expect(usageSummaryBy(db, required(filter), "kind"), at("by_usage_kind")).toEqual(
      c.by_usage_kind as never,
    );
    expect(usageSummaryBy(db, required(filter), "api_key"), at("by_api_key")).toEqual(
      c.by_api_key as never,
    );
    expect(modelUsageSummary(db, required(filter)), at("model_usage")).toEqual(
      c.model_usage as never,
    );
    expect(withoutToolSurface(queryAnomalies(db, required(filter))), at("anomalies")).toEqual(
      c.anomalies as never,
    );
    expect(
      activeAnthropicCharacters(db, required(filter)).map(
        ([character, row]) => [character, withoutToolSurface([row])[0]] as const,
      ),
      at("active_anthropic"),
    ).toEqual(c.active_anthropic as never);
    expect(withoutToolSurfaceColumn(exportTsv(db, required(filter))), at("export_tsv")).toBe(
      c.export_tsv,
    );
  }

  for (const [character, streak] of Object.entries(doc.warm_streak)) {
    expect(warmStreak(db, character), `warm_streak: ${character}`).toBe(streak);
  }
  expect(nullCostRows(db), "null_cost_rows").toEqual(doc.null_cost_rows as never);
  expect(allCostRows(db), "all_cost_rows").toEqual(doc.all_cost_rows as never);

  const callRows = queryAnomalies(db, required(FILTERS["none"]));
  expect(callRows.length, "anomalies: seeded").toBeGreaterThan(0);
  for (const row of callRows) {
    expect(row).toHaveProperty("tool_surface");
    expect(row.tool_surface, "seeded rows carry no tool surface").toBeNull();
  }
});
