import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger, type RecordCall } from "../src/ledger/store.ts";
import { PricingEngine, type ModelPricing, type PricingStore } from "../src/ledger/pricing.ts";
import { setSubscriptionProviders } from "../src/ledger/store.ts";
import { DEFAULT_SUBSCRIPTION_PROVIDERS } from "../src/config/providers.ts";
import { freshLedger, rowsIn } from "./support/ledger_fixture.ts";

function fixedPricing(entry: ModelPricing): PricingEngine {
  const map = new Map<string, ModelPricing>([["anthropic/claude-opus-4.6", entry]]);
  const store: PricingStore = { get: (id) => map.get(id), put: () => {}, clear: () => map.clear() };
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

describe("writing rows the daemon's schema accepts", () => {
  test("a recorded call lands as a row", () => {
    const { path, cleanup } = freshLedger();
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
      expect(row["cache_state"]).toBe("warm");
      expect(row["thinking_enabled"]).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("a pending attempt survives a crash and is marked unresolved on daemon startup", () => {
    const { path, cleanup } = freshLedger();
    try {
      const ledger = Ledger.open(path);
      ledger.beginAttempt(call(), 0.25);
      ledger.close();

      const reopened = Ledger.create(path);
      expect(reopened.database.query(
        "SELECT status, estimated_cost FROM call_attempts",
      ).get()).toEqual({ status: "unresolved", estimated_cost: 0.25 });
      reopened.close();
    } finally {
      cleanup();
    }
  });

  test("cost comes from the catalog when the provider reports none", () => {
    const { path, cleanup } = freshLedger();
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
    const { path, cleanup } = freshLedger();
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
    const { path, cleanup } = freshLedger();
    try {
      const ledger = Ledger.open(path);
      const row = ledger.record(
        call({ provider: "opencode-go", model: "kimi-k3", usage: { ...call().usage, total_cost_usd: 9.99 } }),
      );
      ledger.close();
      expect(row.cost_source).toBe("subscription");
      expect(row.total_cost).toBe(0);
      expect(row.input_tokens).toBe(100);
    } finally {
      cleanup();
    }
  });

  test("a provider configured as a subscription records at zero, and one unconfigured does not", () => {
    const { path, cleanup } = freshLedger();
    try {
      setSubscriptionProviders(["zai"]);
      const ledger = Ledger.open(path);
      const flat = ledger.record(call({ provider: "zai", model: "glm-5.1" }));
      const billed = ledger.record(call({ provider: "opencode-go", model: "kimi-k3" }));
      ledger.close();

      expect(flat.cost_source, "a configured subscription is free per call").toBe("subscription");
      expect(flat.total_cost).toBe(0);
      expect(
        billed.cost_source,
        "turning the flag on for one provider must not turn it on for every provider",
      ).not.toBe("subscription");
    } finally {
      setSubscriptionProviders(DEFAULT_SUBSCRIPTION_PROVIDERS);
      cleanup();
    }
  });

  test("a loop's calls each get their own row and the tracker stays quiet", () => {
    const { path, cleanup } = freshLedger();
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
      expect(next.cache_anomaly).toBeNull();
      expect(next.cache_state).toBe("warm");
    } finally {
      cleanup();
    }
  });

  test("a cancelled row carries no cache verdict", () => {
    const { path, cleanup } = freshLedger();
    try {
      const ledger = Ledger.open(path);
      const row = ledger.record(call({ finish_reason: "cancelled" }));
      ledger.close();
      expect(row.cache_state).toBeNull();
      expect(row.cache_anomaly).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a non-Anthropic call gets a plain label and no anomaly", () => {
    const { path, cleanup } = freshLedger();
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
    const { path, cleanup } = freshLedger();
    try {
      const first = Ledger.open(path);
      first.record(call({ usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 5_000 } }));
      first.record(call({ usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 5_000, cache_creation_tokens: 0 } }));
      first.close();

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

  test("a shorter TTL shortens the warm window", () => {
    const { path, cleanup } = freshLedger();
    try {
      const at = (iso: string) => () => new Date(iso);
      const read = (r: number, w: number) => ({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: r,
        cache_creation_tokens: w,
      });

      const ledger = Ledger.open(path);
      ledger.setCacheTtlSecs(300);
      ledger.record(call({ usage: read(0, 40_000) }), at("2026-04-05T10:00:00Z"));
      const expired = ledger.record(call({ usage: read(0, 40_000) }), at("2026-04-05T10:06:00Z"));
      ledger.close();
      expect(expired.cache_state).toBe("warm");
      expect(expired.cache_anomaly).toBe("keepalive_miss");
    } finally {
      cleanup();
    }
  });

  test("the default TTL keeps the same pair warm", () => {
    const { path, cleanup } = freshLedger();
    try {
      const at = (iso: string) => () => new Date(iso);
      const read = (r: number, w: number) => ({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: r,
        cache_creation_tokens: w,
      });
      const ledger = Ledger.open(path);
      ledger.record(call({ usage: read(0, 40_000) }), at("2026-04-05T10:00:00Z"));
      const still = ledger.record(call({ usage: read(0, 40_000) }), at("2026-04-05T10:06:00Z"));
      ledger.close();
      expect(still.cache_anomaly).toBeNull();
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
