import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../src/ledger/store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-schema-"));
  roots.push(root);
  return join(root, "ledger.db");
}

function columns(path: string): Set<string> {
  const db = new Database(path, { readonly: true });
  const rows = db.query("PRAGMA table_info(calls)").all() as { name: string }[];
  db.close();
  return new Set(rows.map((r) => r.name));
}

function tables(path: string): Set<string> {
  const db = new Database(path, { readonly: true });
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  db.close();
  return new Set(rows.map((r) => r.name));
}

describe("creating a ledger", () => {
  test("makes one where there was none", () => {
    const path = tempPath();

    Ledger.create(path).close();

    expect(tables(path).has("calls")).toBe(true);
    expect(tables(path).has("pricing")).toBe(true);
    expect(tables(path).has("pricing_catalog_checks")).toBe(true);
    expect(tables(path).has("usage_budget_warnings")).toBe(true);
  });

  test("carries every column the readers select by name", () => {
    const path = tempPath();
    Ledger.create(path).close();

    const cols = columns(path);
    for (const name of [
      "cache_ttl",
      "api_key_name",
      "cost_source",
      "reasoning_effort",
      "tool_surface",
      "cache_state",
      "cache_anomaly",
      "total_cost",
    ]) {
      expect(cols.has(name)).toBe(true);
    }
  });

  test("opening twice is not an error", () => {
    const path = tempPath();
    Ledger.create(path).close();
    Ledger.create(path).close();

    expect(tables(path).has("calls")).toBe(true);
  });

  test("a reader still refuses a ledger that does not exist", () => {
    expect(() => Ledger.open(tempPath())).toThrow();
  });
});
