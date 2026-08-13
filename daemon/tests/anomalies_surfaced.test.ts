import { afterAll, describe, expect, test } from "bun:test";

import { anomalyCounts } from "../src/ledger/query.ts";
import { Ledger } from "../src/ledger/store.ts";
import { usageReport } from "../src/ledger/usage.ts";
import { freshLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const INSERT = `INSERT INTO calls
 (ts, character, provider, model, call_type, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, total_ms, ttft_ms, finish_reason, thinking_enabled, cache_state, cache_anomaly)
 VALUES (?1, 'Rhia', 'anthropic', 'claude-opus-5', ?2, 5, 1, 0, ?3, 10, 5, 'end_turn', 0, 'warm', ?4)`;

function seeded(rows: Array<[string, number, string | null]>): string {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = Ledger.create(f.path);
  const ts = new Date().toISOString();
  for (const [callType, writes, anomaly] of rows) {
    db.database.query(INSERT).run(ts, callType, writes, anomaly);
  }
  db.close();
  return f.path;
}

describe("cache anomalies reach a command, not only the CSV export", () => {
  test("the summary carries a per-kind breakdown, not just a total", async () => {
    const path = seeded([
      ["keepalive", 12_000, "cold_keepalive"],
      ["keepalive", 9_000, "cold_keepalive"],
      ["message", 4_000, "unexpected_write"],
      ["message", 0, null],
    ]);

    const summary = (await usageReport({ ledger: path, args: {}, usage: {} })) as Record<
      string,
      unknown
    >;

    expect(summary["anomaly_count_7d"]).toBe(3);
    expect(summary["anomaly_counts_7d"]).toEqual([
      { anomaly: "cold_keepalive", calls: 2, cache_write_tokens: 21_000 },
      { anomaly: "unexpected_write", calls: 1, cache_write_tokens: 4_000 },
    ]);
  });

  test("the listing mode returns the rows themselves", async () => {
    const path = seeded([["keepalive", 12_000, "keepalive_miss"]]);

    const listed = (await usageReport({
      ledger: path,
      args: { anomalies: true },
      usage: {},
    })) as { mode: string; anomalies: Array<Record<string, unknown>> };

    expect(listed.mode).toBe("anomalies");
    expect(listed.anomalies).toHaveLength(1);
    expect(listed.anomalies[0]).toMatchObject({
      anomaly: "keepalive_miss",
      call_type: "keepalive",
      cache_write_tokens: 12_000,
    });
  });

  test("a clean ledger reports an empty breakdown rather than a missing field", () => {
    const path = seeded([["message", 0, null]]);
    const db = Ledger.open(path);
    try {
      expect(anomalyCounts(db.database, {})).toEqual([]);
    } finally {
      db.close();
    }
  });
});
