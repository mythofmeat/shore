import { required } from "../src/util/required.ts";

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";

import {
  activeAnthropicCharacters,
  allCostRows,
  costSourceTotals,
  exportTsv,
  modelUsageSummary,
  nullCostRows,
  queryAnomalies,
  updateCosts,
  usageSummary,
  usageSummaryBy,
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
  thinking_dropped: 0,
  cache_state_reason: null,
  ts: "2026-04-05T10:00:00Z",
  character: "aria",
  provider: "anthropic",
  api_key_name: "default",
  model: "claude-opus-4-6",
  call_type: "message",
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

function insert(db: Database, row: CallRow): number {
  db.query(
    `INSERT INTO calls (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `$${c}`).join(", ")})`,
  ).run(Object.fromEntries(COLUMNS.map((c) => [`$${c}`, (row as never)[c]])));
  const r = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return r.id;
}

function ledgerWith(rows: CallRow[]): Database {
  const fixture = freshLedger();
  cleanups.push(fixture.cleanup);
  const db = openLedger(fixture.path);
  for (const r of rows) insert(db, r);
  return db;
}

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
    expect(rows).toHaveLength(3);
    const [opusMessage, opusToolLoop, gpt] = rows;
    expect(required(opusMessage).model).toBe("claude-opus-4-6");
    expect(required(opusMessage).call_type).toBe("message");
    expect(required(opusMessage).call_count).toBe(1);
    expect(required(opusMessage).first_ts).toBe("2026-04-05T10:00:00Z");
    expect(required(opusToolLoop).call_type).toBe("tool_loop");
    expect(required(gpt).model).toBe("gpt-4o");
    expect(required(gpt).provider).toBe("openai");

    const filtered = modelUsageSummary(db, {
      character: "aria",
      since: "2026-04-05T10:02:00Z",
    });
    expect(filtered).toHaveLength(1);
    expect(required(filtered[0]).model).toBe("gpt-4o");

    expect(modelUsageSummary(db, { character: "nobody" })).toHaveLength(0);
  });

  test("summary groups by call type", () => {
    const summary = usageSummaryBy(populated(), NONE, "call_type");
    expect(summary).toHaveLength(2);
    const byType = new Map(summary.map((s) => [s.group, s.call_count]));
    expect(byType.get("message")).toBe(2);
    expect(byType.get("tool_loop")).toBe(1);
  });

  test("summary groups by usage kind", () => {
    const summary = usageSummaryBy(populated(), NONE, "kind");
    const byKind = new Map(summary.map((s) => [s.group, s.call_count]));
    expect(byKind.get("message_no_tools")).toBe(1);
    expect(byKind.get("message_with_tools")).toBe(2);
  });

  test("summary groups by api key", () => {
    const summary = usageSummaryBy(populated(), NONE, "api_key");
    const byKey = new Map(summary.map((s) => [s.group, s.call_count]));
    expect(byKey.get("anthropic default")).toBe(1);
    expect(byKey.get("anthropic overflow")).toBe(1);
    expect(byKey.get("openai default")).toBe(1);
  });

  test("summary groups by provider on its own", () => {
    const summary = usageSummaryBy(populated(), NONE, "provider");
    const byProvider = new Map(summary.map((s) => [s.group, s.call_count]));
    expect(byProvider.get("anthropic")).toBe(2);
    expect(byProvider.get("openai")).toBe(1);
  });

  test("summary groups by provider and model", () => {
    const summary = usageSummary(populated(), NONE);
    expect(summary).toHaveLength(2);
    expect(required(summary.find((s) => s.provider === "anthropic")).call_count).toBe(2);
  });
});

describe("filtering", () => {
  test("filter by provider", () => {
    const summary = usageSummary(populated(), { provider: "anthropic" });
    expect(summary).toHaveLength(1);
    expect(required(summary[0]).call_count).toBe(2);
  });

  test("filter by api key", () => {
    const summary = usageSummary(populated(), { api_key_name: "overflow" });
    expect(summary).toHaveLength(1);
    expect(required(summary[0]).call_count).toBe(1);
    expect(required(summary[0]).total_input).toBe(200);
  });

  test("totals sum without grouping", () => {
    const totals = usageTotals(populated(), NONE);
    expect(totals.call_count).toBe(3);
    expect(totals.total_input).toBe(400);
    expect(totals.total_cost).toBeCloseTo(0.017745, 9);
  });

  test("totals over an empty match are zero, not null", () => {
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
    expect(lines).toHaveLength(4);
    expect(required(lines[1]).split("\t")).toHaveLength(required(lines[0]).split("\t").length);
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
    expect(required(rows[0]).id).toBe(id);
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

describe("where a cost came from", () => {
  test("spend is split by cost source, and unpriced rows are counted", () => {
    const db = ledgerWith([
      BASE,
      { ...BASE, ts: "2026-04-05T10:01:00Z", cost_source: "provider_reported", total_cost: 0.5 },
      {
        ...BASE,
        ts: "2026-04-05T10:02:00Z",
        cost_source: "pricing_catalog",
        input_cost: null,
        output_cost: null,
        cache_read_cost: null,
        cache_write_cost: null,
        total_cost: null,
      },
      { ...BASE, ts: "2026-04-05T10:03:00Z", cost_source: "subscription", total_cost: 0 },
    ]);
    const bySource = new Map(
      costSourceTotals(db, {}).map((r) => [r.cost_source, r]),
    );

    expect(required(bySource.get("provider_reported")).total_cost).toBe(0.5);
    expect(required(bySource.get("provider_reported")).unpriced_calls).toBe(0);

    const catalog = required(bySource.get("pricing_catalog"));
    expect(catalog.calls).toBe(2);
    expect(catalog.unpriced_calls).toBe(1);
    expect(catalog.total_cost).toBe(0.005745);

    expect(required(bySource.get("subscription")).calls).toBe(1);
  });

  test("a row with no cost source is reported rather than dropped", () => {
    const db = ledgerWith([{ ...BASE, cost_source: null, total_cost: 0.25 }]);
    const rows = costSourceTotals(db, {});
    expect(rows).toHaveLength(1);
    expect(required(rows[0]).cost_source).toBe("unknown");
    expect(required(rows[0]).total_cost).toBe(0.25);
  });

  test("cost source groups like any other usage dimension", () => {
    const db = ledgerWith([
      BASE,
      { ...BASE, ts: "2026-04-05T10:01:00Z", cost_source: "provider_reported", total_cost: 0.5 },
    ]);
    const groups = usageSummaryBy(db, {}, "cost_source").map((g) => g.group);
    expect(groups.sort()).toEqual(["pricing_catalog", "provider_reported"]);
  });
});
