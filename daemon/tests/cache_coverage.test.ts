import { afterAll, describe, expect, test } from "bun:test";

import { cacheCoverage } from "../src/ledger/query.ts";
import { Ledger, type RecordCall } from "../src/ledger/store.ts";
import { freshLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function ledger(): Ledger {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  return Ledger.open(f.path);
}

function call(over: Partial<RecordCall> = {}): RecordCall {
  return {
    provider: "anthropic",
    model: "claude-opus-5",
    call_type: "message",
    character: "Rhia",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    finish_reason: "end_turn",
    thinking_enabled: false,
    ...over,
  };
}

function coverageOf(db: Ledger): Map<string, { calls: number; reason: string | null }> {
  const out = new Map<string, { calls: number; reason: string | null }>();
  for (const row of cacheCoverage(db.database, {})) {
    out.set(row.reason ?? row.state, { calls: row.calls, reason: row.reason });
  }
  return out;
}

describe("an unclassified call is counted as such", () => {
  test("a cancelled call names cancellation rather than leaving the column empty", () => {
    const db = ledger();
    db.record(call({ finish_reason: "cancelled" }));

    const rows = db.database
      .query("SELECT cache_state, cache_state_reason FROM calls")
      .all() as Array<Record<string, unknown>>;
    expect(rows[0]?.["cache_state"]).toBeNull();
    expect(rows[0]?.["cache_state_reason"]).toBe("cancelled");
  });

  test("a stream that errored before any usage arrived is named too", () => {
    const db = ledger();
    db.record(call({ finish_reason: "error" }));
    expect(coverageOf(db).get("errored_before_usage")?.calls).toBe(1);
  });

  test("a provider that does not report cache metrics is named, not blamed", () => {
    const db = ledger();
    db.record(call({ provider: "deepseek", model: "deepseek-chat" }));
    expect(coverageOf(db).get("provider_reports_no_cache")?.calls).toBe(1);
  });

  test("a classified call carries no reason", () => {
    const db = ledger();
    db.record(
      call({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 900,
          cache_creation_tokens: 0,
        },
      }),
    );
    const coverage = cacheCoverage(db.database, {});
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.reason).toBeNull();
    expect(["warm", "cold"]).toContain(coverage[0]?.state ?? "");
  });

  test("every recorded call appears in the coverage total", () => {
    const db = ledger();
    db.record(call({ finish_reason: "cancelled" }));
    db.record(call({ finish_reason: "error" }));
    db.record(call({ provider: "deepseek", model: "deepseek-chat" }));
    db.record(call());

    const total = cacheCoverage(db.database, {}).reduce((sum, row) => sum + row.calls, 0);
    const recorded = (
      db.database.query("SELECT COUNT(*) AS n FROM calls").get() as { n: number }
    ).n;
    expect(total).toBe(recorded);
  });
});
