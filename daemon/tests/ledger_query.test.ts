/**
 * Ported from `crates/daemon/src/ledger/query.rs::tests`, test for test, while
 * both implementations existed. The Rust is gone; these are now this
 * implementation's own tests, kept case for case.
 *
 * The schema comes from the daemon binary (see `support/ledger_fixture.ts`),
 * not from a copy kept here — these queries are only meaningful against the
 * real table, and a test that built its own would prove nothing about the pair.
 *
 * Two of these are money rules rather than query mechanics: `allCostRows` must
 * refuse to hand a `provider_reported` or `subscription` row to the pricing
 * catalog, because `updateCosts` rewrites `cost_source` and sets a non-zero
 * total — repricing a flat-plan row would start accruing it against usage
 * budgets for a plan that bills a flat rate.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";

import {
  activeAnthropicCharacters,
  allCostRows,
  exportTsv,
  modelUsageSummary,
  nullCostRows,
  queryAnomalies,
  updateCosts,
  usageSummary,
  usageSummaryByApiKey,
  usageSummaryByCallType,
  usageSummaryByUsageKind,
  usageTotals,
  warmStreak,
  type QueryFilter,
} from "../src/ledger/query.ts";
import type { CallRow } from "../src/ledger/store.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const BASE: CallRow = {
  output_tokens_estimated: 0,
  ts: "2026-04-05T10:00:00Z",
  character: "aria",
  provider: "anthropic",
  api_key_name: "default",
  model: "claude-opus-4-6",
  call_type: "message",
  // Unknown, as every row written before #33 is: the query layer passes it
  // through and nothing here is about the tool surface.
  tool_surface: null,
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 80,
  cache_write_tokens: 20,
  cache_ttl: null,
  reasoning_effort: null,
  total_ms: 1500,
  ttft_ms: 200,
  finish_reason: "tool_use",
  thinking_enabled: 1,
  cache_state: "warm",
  cache_anomaly: null,
  input_cost: 0.0015,
  output_cost: 0.00375,
  cache_read_cost: 0.00012,
  cache_write_cost: 0.000375,
  cost_source: "pricing_catalog",
  total_cost: 0.005745,
};

const COLUMNS = Object.keys(BASE);

/** Insert a raw row. The writer path (`Ledger.record`) computes fields these
 *  tests want to set directly, so this goes straight to SQL. */
function insert(db: Database, row: CallRow): number {
  db.query(
    `INSERT INTO calls (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `$${c}`).join(", ")})`,
  ).run(Object.fromEntries(COLUMNS.map((c) => [`$${c}`, (row as never)[c]])));
  const r = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return r.id;
}

/** A fresh daemon-made ledger seeded with `rows`. */
function ledgerWith(rows: CallRow[]): Database {
  const fixture = freshLedger();
  cleanups.push(fixture.cleanup);
  const db = openLedger(fixture.path);
  for (const r of rows) insert(db, r);
  return db;
}

/** The three-row ledger the Rust tests build: two anthropic, one openai. */
function populated(): Database {
  return ledgerWith([
    BASE,
    {
      ...BASE,
      ts: "2026-04-05T10:01:00Z",
      call_type: "tool_loop",
      api_key_name: "overflow",
      input_tokens: 200,
      total_cost: 0.01,
    },
    {
      ...BASE,
      ts: "2026-04-05T10:02:00Z",
      provider: "openai",
      model: "gpt-4o",
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_state: null,
      finish_reason: "end_turn",
      total_cost: 0.002,
    },
  ]);
}

const NONE: QueryFilter = {};

describe("grouping", () => {
  test("model usage summary groups and orders by first seen", () => {
    const db = populated();
    const rows = modelUsageSummary(db, NONE);
    // (claude-opus-4-6, anthropic, message), (claude-opus-4-6, anthropic,
    // tool_loop), (gpt-4o, openai, message) — ordered by first appearance.
    expect(rows).toHaveLength(3);
    const [opusMessage, opusToolLoop, gpt] = rows;
    expect(opusMessage!.model).toBe("claude-opus-4-6");
    expect(opusMessage!.call_type).toBe("message");
    expect(opusMessage!.call_count).toBe(1);
    expect(opusMessage!.first_ts).toBe("2026-04-05T10:00:00Z");
    expect(opusToolLoop!.call_type).toBe("tool_loop");
    expect(gpt!.model).toBe("gpt-4o");
    expect(gpt!.provider).toBe("openai");

    // Character + time filters compose through buildWhere.
    const filtered = modelUsageSummary(db, {
      character: "aria",
      since: "2026-04-05T10:02:00Z",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.model).toBe("gpt-4o");

    expect(modelUsageSummary(db, { character: "nobody" })).toHaveLength(0);
  });

  test("summary groups by call type", () => {
    const summary = usageSummaryByCallType(populated(), NONE);
    expect(summary).toHaveLength(2);
    const byType = new Map(summary.map((s) => [s.call_type, s.call_count]));
    expect(byType.get("message")).toBe(2);
    expect(byType.get("tool_loop")).toBe(1);
  });

  test("summary groups by usage kind", () => {
    const summary = usageSummaryByUsageKind(populated(), NONE);
    const byKind = new Map(summary.map((s) => [s.usage_kind, s.call_count]));
    // A `message` finishing at `tool_use` is the first leg of a tool loop.
    expect(byKind.get("message_no_tools")).toBe(1);
    expect(byKind.get("message_with_tools")).toBe(2);
  });

  test("summary groups by api key", () => {
    const summary = usageSummaryByApiKey(populated(), NONE);
    const byKey = new Map(
      summary.map((s) => [`${s.provider}/${s.api_key_name}`, s.call_count]),
    );
    expect(byKey.get("anthropic/default")).toBe(1);
    expect(byKey.get("anthropic/overflow")).toBe(1);
    expect(byKey.get("openai/default")).toBe(1);
  });

  test("summary groups by provider and model", () => {
    const summary = usageSummary(populated(), NONE);
    expect(summary).toHaveLength(2); // anthropic/opus + openai/gpt-4o
    expect(summary.find((s) => s.provider === "anthropic")!.call_count).toBe(2);
  });
});

describe("filtering", () => {
  test("filter by provider", () => {
    const summary = usageSummary(populated(), { provider: "anthropic" });
    expect(summary).toHaveLength(1);
    expect(summary[0]!.call_count).toBe(2);
  });

  test("filter by api key", () => {
    const summary = usageSummary(populated(), { api_key_name: "overflow" });
    expect(summary).toHaveLength(1);
    expect(summary[0]!.call_count).toBe(1);
    expect(summary[0]!.total_input).toBe(200);
  });

  test("totals sum without grouping", () => {
    const totals = usageTotals(populated(), NONE);
    expect(totals.call_count).toBe(3);
    expect(totals.total_input).toBe(400);
    expect(totals.total_cost).toBeCloseTo(0.017745, 9);
  });

  test("totals over an empty match are zero, not null", () => {
    // `TOTAL()` returns 0.0 where `SUM()` would return NULL — a budget reading
    // NULL as a cost is the difference between "spent nothing" and "unknown".
    const totals = usageTotals(populated(), { character: "nobody" });
    expect(totals).toEqual({
      call_count: 0,
      total_input: 0,
      total_output: 0,
      total_cache_read: 0,
      total_cache_write: 0,
      total_cost: 0,
    });
  });
});

describe("anomalies and export", () => {
  test("anomalies query returns only flagged rows", () => {
    const db = ledgerWith([
      {
        ...BASE,
        cache_read_tokens: 0,
        cache_write_tokens: 500,
        finish_reason: "end_turn",
        cache_state: "cold",
        cache_anomaly: "unexpected_read",
        input_cost: null,
        output_cost: null,
        cache_read_cost: null,
        cache_write_cost: null,
        total_cost: null,
      },
      { ...BASE, finish_reason: "end_turn", cache_anomaly: null },
    ]);
    expect(queryAnomalies(db, NONE)).toHaveLength(1);
  });

  test("export tsv format", () => {
    const tsv = exportTsv(populated(), NONE);
    const lines = tsv.split("\n");
    expect(lines[0]).toContain("ts\t");
    expect(lines[0]).toContain("\tcost_source\t");
    expect(lines).toHaveLength(4); // header + 3 rows
    // Column count must match the header, or the export silently misaligns.
    expect(lines[1]!.split("\t")).toHaveLength(lines[0]!.split("\t").length);
  });
});

describe("recalculation candidates", () => {
  test("all cost rows skips provider-reported totals", () => {
    const db = populated();
    const id = insert(db, {
      ...BASE,
      ts: "2026-04-05T10:03:00Z",
      input_cost: null,
      output_cost: null,
      cache_read_cost: null,
      cache_write_cost: null,
      cost_source: "provider_reported",
      total_cost: 0.1234,
    });
    const rows = allCostRows(db);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.id !== id)).toBe(true);
  });

  test("all cost rows skips subscription rows", () => {
    // A subscription row must never be repriced: `updateCosts` rewrites
    // `cost_source` to `pricing_catalog` and sets a non-zero total, so a
    // repriced flat-plan row would start accruing against usage budgets. Only
    // the catalog not listing `opencode-go/<model>` was stopping it.
    const db = populated();
    const id = insert(db, {
      ...BASE,
      ts: "2026-04-05T10:04:00Z",
      provider: "opencode-go",
      model: "kimi-k3",
      cost_source: "subscription",
      total_cost: 0,
    });
    expect(
      allCostRows(db).every((r) => r.id !== id),
      "a flat-plan row must not be handed to the pricing catalog",
    ).toBe(true);
  });

  test("null cost rows finds unpriced rows only", () => {
    const db = populated();
    const id = insert(db, { ...BASE, ts: "2026-04-05T10:05:00Z", total_cost: null });
    const rows = nullCostRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
  });

  test("update costs rewrites the breakdown and the source", () => {
    const db = populated();
    const id = insert(db, { ...BASE, ts: "2026-04-05T10:06:00Z", total_cost: null });
    updateCosts(db, id, {
      input: 1,
      output: 2,
      cache_read: 3,
      cache_write: 4,
      total: 10,
    });
    const row = db.query("SELECT * FROM calls WHERE id = ?1").get(id) as Record<
      string,
      unknown
    >;
    expect(row["total_cost"]).toBe(10);
    expect(row["cost_source"]).toBe("pricing_catalog");
    expect(nullCostRows(db)).toHaveLength(0);
  });
});

describe("cache health readers", () => {
  test("active anthropic characters includes routed provider", () => {
    // A custom provider name (sdk = "anthropic", base_url = OpenRouter) with
    // model_id resolved to `anthropic/...` must show up in cache health
    // alongside native-anthropic rows.
    const db = ledgerWith([
      { ...BASE, finish_reason: "end_turn", total_cost: null },
      {
        ...BASE,
        ts: "2026-04-05T10:01:00Z",
        character: "kai",
        provider: "openrouter-anthropic",
        model: "anthropic/claude-opus-4.6",
        finish_reason: "end_turn",
        total_cost: null,
      },
      {
        ...BASE,
        ts: "2026-04-05T10:02:00Z",
        character: "leo",
        provider: "openai",
        model: "gpt-4o",
        finish_reason: "end_turn",
        total_cost: null,
      },
    ]);
    const chars = new Set(activeAnthropicCharacters(db, NONE).map(([c]) => c));
    expect(chars.has("aria")).toBe(true);
    expect(chars.has("kai")).toBe(true);
    expect(chars.has("leo")).toBe(false);
  });

  test("warm streak counts consecutive", () => {
    const db = ledgerWith([
      { ...BASE, cache_state: "cold", finish_reason: "end_turn", total_cost: null },
      { ...BASE, ts: "2026-04-05T10:01:00Z", finish_reason: "end_turn", total_cost: null },
      { ...BASE, ts: "2026-04-05T10:02:00Z", finish_reason: "end_turn", total_cost: null },
      { ...BASE, ts: "2026-04-05T10:03:00Z", finish_reason: "end_turn", total_cost: null },
    ]);
    expect(warmStreak(db, "aria")).toBe(3);
  });
});
