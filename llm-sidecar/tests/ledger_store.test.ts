/**
 * The TypeScript writer, against a real `ledger.db`.
 *
 * The database is created by the *daemon* binary rather than by a schema
 * duplicated here — the whole point is that Rust owns the schema and this side
 * writes into it, so a test that made its own tables would prove nothing about
 * the pair. Skips when the daemon has not been built.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger, type RecordCall } from "../src/ledger/store.ts";
import { PricingEngine, type ModelPricing, type PricingStore } from "../src/ledger/pricing.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const DAEMON = `${ROOT}/target/debug/shore-daemon`;
const haveDaemon = Bun.spawnSync(["test", "-x", DAEMON]).exitCode === 0;

/**
 * Boot the daemon just long enough for it to create `ledger.db`, then stop it.
 * That guarantees the schema under test is the one the daemon actually writes.
 */
function daemonMadeLedger(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "shore-ledger-"));
  const [CONFIG, DATA] = [`${root}/config`, `${root}/data`];
  Bun.spawnSync(["mkdir", "-p", `${CONFIG}/characters/probe/workspace`, DATA]);
  Bun.spawnSync(["sh", "-c", `printf '[daemon]\\naddr = "127.0.0.1:0"\\n' > ${CONFIG}/config.toml`]);

  const proc = Bun.spawn([DAEMON], {
    env: {
      ...process.env,
      SHORE_CONFIG_DIR: CONFIG,
      SHORE_DATA_DIR: DATA,
      SHORE_CACHE_DIR: `${root}/cache`,
      SHORE_RUNTIME_DIR: `${root}/run`,
      RUST_LOG: "error",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const path = `${DATA}/ledger.db`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const db = new Database(path, { readonly: true, create: false });
      const has = db.query("SELECT name FROM sqlite_master WHERE name = 'calls'").get();
      db.close();
      if (has) break;
    } catch {
      /* not created yet */
    }
    Bun.sleepSync(150);
  }
  proc.kill();
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fixedPricing(entry: ModelPricing): PricingEngine {
  const map = new Map<string, ModelPricing>([["anthropic/claude-opus-4.6", entry]]);
  const store: PricingStore = { get: (id) => map.get(id), put: () => {} };
  return new PricingEngine(store, async () => {
    throw new Error("no network in tests");
  });
}

const call = (over: Partial<RecordCall> = {}): RecordCall => ({
  provider: "anthropic",
  model: "claude-opus-4-6",
  call_type: "message",
  character: "probe",
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 2_000,
  },
  timing: { total_ms: 1500, time_to_first_token_ms: 200 },
  finish_reason: "end_turn",
  thinking_enabled: true,
  ...over,
});

const rowsIn = (path: string) => {
  const db = new Database(path, { readonly: true });
  const rows = db.query("SELECT * FROM calls ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;
  db.close();
  return rows;
};

describe.skipIf(!haveDaemon)("writing rows the daemon's schema accepts", () => {
  test("a recorded call lands as a row", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(path);
      ledger.record(call());
      ledger.close();

      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row["character"]).toBe("probe");
      expect(row["provider"]).toBe("anthropic");
      expect(row["call_type"]).toBe("message");
      expect(row["input_tokens"]).toBe(100);
      expect(row["cache_write_tokens"]).toBe(2_000);
      // A write warms the tracker: the prefix now exists, whether or not
      // this call got to read it.
      expect(row["cache_state"]).toBe("warm");
      expect(row["thinking_enabled"]).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("cost comes from the catalog when the provider reports none", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(
        path,
        fixedPricing({
          input_per_token: 0.000_015,
          output_per_token: 0.000_075,
          cache_read_per_token: 0.000_001_5,
          cache_write_per_token: 0.000_018_75,
        }),
      );
      const row = ledger.record(call({ cache_ttl: "5m" }));
      ledger.close();

      expect(row.cost_source).toBe("pricing_catalog");
      expect(Math.abs(row.input_cost! - 0.0015) < 1e-10).toBe(true);
      expect(Math.abs(row.cache_write_cost! - 0.0375) < 1e-10).toBe(true);
      expect(rowsIn(path)[0]!["cost_source"]).toBe("pricing_catalog");
    } finally {
      cleanup();
    }
  });

  test("a provider-reported total wins and leaves the breakdown null", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(path, fixedPricing({
        input_per_token: 1, output_per_token: 1, cache_read_per_token: 1, cache_write_per_token: 1,
      }));
      const row = ledger.record(
        call({ usage: { ...call().usage, total_cost_usd: 0.42 } }),
      );
      ledger.close();
      expect(row.cost_source).toBe("provider_reported");
      expect(row.total_cost).toBe(0.42);
      expect(row.input_cost).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a subscription provider records usage at zero cost", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(path);
      const row = ledger.record(
        call({ provider: "opencode-go", model: "kimi-k3", usage: { ...call().usage, total_cost_usd: 9.99 } }),
      );
      ledger.close();
      // Usage is kept for observability; cost is zeroed so it cannot accrue
      // against a budget.
      expect(row.cost_source).toBe("subscription");
      expect(row.total_cost).toBe(0);
      expect(row.input_tokens).toBe(100);
    } finally {
      cleanup();
    }
  });

  test("a loop's calls each get their own row and the tracker stays quiet", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(path);
      const usage = (read: number, write: number) => ({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: read,
        cache_creation_tokens: write,
      });
      ledger.record(call({ usage: usage(0, 2000) }));
      ledger.record(call({ usage: usage(2000, 200) }));
      ledger.record(call({ call_type: "tool_loop", usage: usage(2200, 200) }));
      ledger.record(call({ call_type: "tool_loop", usage: usage(2400, 200) }));
      const next = ledger.record(call({ usage: usage(2600, 200) }));
      ledger.close();

      expect(rowsIn(path)).toHaveLength(5);
      // The whole point of one row per call: no invented anomaly.
      expect(next.cache_anomaly).toBeNull();
      expect(next.cache_state).toBe("warm");
    } finally {
      cleanup();
    }
  });

  test("a cancelled row carries no cache verdict", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(path);
      const row = ledger.record(call({ finish_reason: "cancelled" }));
      ledger.close();
      // Its usage is all zero; feeding it to the tracker would inject a bogus
      // cold observation.
      expect(row.cache_state).toBeNull();
      expect(row.cache_anomaly).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a non-Anthropic call gets a plain label and no anomaly", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      const ledger = Ledger.open(path);
      const row = ledger.record(
        call({
          provider: "openai",
          model: "gpt-4o",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 900, cache_creation_tokens: 0 },
        }),
      );
      ledger.close();
      expect(row.cache_state).toBe("warm");
      expect(row.cache_anomaly).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a tracker seeds from the rows already in the database", () => {
    const { path, cleanup } = daemonMadeLedger();
    try {
      // First process warms the cache and goes away.
      const first = Ledger.open(path);
      first.record(call({ usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 5_000 } }));
      first.record(call({ usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 5_000, cache_creation_tokens: 0 } }));
      first.close();

      // A fresh one has no memory, and must not treat a healthy continuation
      // as a cold start.
      const second = Ledger.open(path);
      const row = second.record(
        call({ usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 5_200, cache_creation_tokens: 100 } }),
      );
      second.close();
      expect(row.cache_state).toBe("warm");
      expect(row.cache_anomaly).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("opening a database with no schema is an error, not a CREATE TABLE", () => {
    const root = mkdtempSync(join(tmpdir(), "shore-ledger-empty-"));
    try {
      const path = join(root, "ledger.db");
      new Database(path, { create: true }).close();
      expect(() => Ledger.open(path)).toThrow(/owns the schema/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
