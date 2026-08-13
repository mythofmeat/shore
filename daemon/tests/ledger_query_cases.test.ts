/**
 * Recorded cases for ledger query.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

import fixture from "./ledger_fixtures/ledger_query_cases.json";
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

/**
 * Drop `tool_surface` from rows before comparing them to the frozen fixture.
 *
 * The column was added by #33 — a fingerprint of the tool definitions a call
 * sent, so the cache tracker can tell a config change from an anomaly. The Rust
 * that generated this fixture had no such column, and every seeded row here
 * predates it, so it reads back null on all of them and is stripped rather than
 * written into a fixture that records what the Rust returned. What it *is* on a
 * fresh row is pinned in `cache_tracker.test.ts` and in the tool-surface tests;
 * that it survives the round trip at all is asserted below.
 */
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
    return rest as Record<string, unknown>;
  });
}

/**
 * The same removal for the TSV export, which is compared as one whole string.
 *
 * That comparison is the file's most valuable single assertion — it pins column
 * order, boolean rendering and float notation at once, and has already caught a
 * real bug in float notation — so it is worth keeping literal for the
 * twenty-four columns the Rust wrote. `tool_surface` is column twelve on this
 * side and does not exist on that one, so it is cut out by index rather than
 * the fixture being rewritten around it. Position is asserted separately, in
 * "the TSV export carries the tool surface" below: cutting by index is only
 * safe if the index is itself pinned.
 */
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
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
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

test("cross-language ledger query parity", () => {
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
    expect(withoutToolSurface(queryAnomalies(db, filter!)), at("anomalies")).toEqual(
      c.anomalies as never,
    );
    expect(
      activeAnthropicCharacters(db, filter!).map(
        ([character, row]) => [character, withoutToolSurface([row])[0]] as const,
      ),
      at("active_anthropic"),
    ).toEqual(c.active_anthropic as never);
    expect(withoutToolSurfaceColumn(exportTsv(db, filter!)), at("export_tsv")).toBe(
      c.export_tsv,
    );
  }

  for (const [character, streak] of Object.entries(doc.warm_streak)) {
    expect(warmStreak(db, character), `warm_streak: ${character}`).toBe(streak);
  }
  expect(nullCostRows(db), "null_cost_rows").toEqual(doc.null_cost_rows as never);
  expect(allCostRows(db), "all_cost_rows").toEqual(doc.all_cost_rows as never);

  // What the stripping above gives up, taken back directly: the column has to
  // be *there* and readable on a `CallRow`, or the tracker's fourth transition
  // (#33) reads a field the query layer silently dropped. Null on every seeded
  // row, because the fixture's rows all predate the column — which is also the
  // "unknown, so compare nothing" case the tracker relies on.
  const callRows = queryAnomalies(db, FILTERS["none"]!);
  expect(callRows.length, "anomalies: seeded").toBeGreaterThan(0);
  for (const row of callRows) {
    expect(row).toHaveProperty("tool_surface");
    expect(row.tool_surface, "seeded rows carry no tool surface").toBeNull();
  }
});
