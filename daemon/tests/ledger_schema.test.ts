/**
 * Who creates `ledger.db`, and what happens to the one already on disk.
 *
 * The daemon used to own this: it started first, ran the migrations, and the
 * sidecar opened a file that already existed. That was right while two
 * processes shared the file and stops being right the moment the daemon is not
 * there to start first — and the failure is silent in the worst way. `ledgerFor`
 * memoises the open failure, every call after it records nothing, and
 * `shore usage` reports a quiet month.
 *
 * So the schema and the migrations moved. The migrations are the half that
 * matters for anyone who already runs shore: their `ledger.db` was created by
 * some older daemon, and six of the columns the readers on this side select by
 * name were added after v1.
 */

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

/** Column names on `calls`, as SQLite reports them. */
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

/** The v1 schema, as `crates/daemon/src/ledger/store.rs` last shipped it. */
const V1 = `
CREATE TABLE calls (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT    NOT NULL,
    character           TEXT    NOT NULL,
    provider            TEXT    NOT NULL,
    model               TEXT    NOT NULL,
    call_type           TEXT    NOT NULL,
    input_tokens        INTEGER NOT NULL,
    output_tokens       INTEGER NOT NULL,
    cache_read_tokens   INTEGER NOT NULL,
    cache_write_tokens  INTEGER NOT NULL,
    total_ms            INTEGER NOT NULL,
    ttft_ms             INTEGER NOT NULL,
    finish_reason       TEXT    NOT NULL,
    thinking_enabled    INTEGER NOT NULL,
    cache_state         TEXT,
    cache_anomaly       TEXT,
    input_cost          REAL,
    output_cost         REAL,
    cache_read_cost     REAL,
    cache_write_cost    REAL,
    total_cost          REAL
);
`;

describe("creating a ledger", () => {
  test("makes one where there was none", () => {
    const path = tempPath();

    Ledger.create(path).close();

    expect(tables(path).has("calls")).toBe(true);
    expect(tables(path).has("pricing")).toBe(true);
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
    // `open` and `create` stay apart on purpose: a *reader* asking for a ledger
    // that is not there has usually named the wrong data directory, and
    // creating an empty one turns that into a report of zero spend.
    expect(() => Ledger.open(tempPath())).toThrow();
  });
});

describe("migrating a ledger an older daemon made", () => {
  function v1Ledger(): string {
    const path = tempPath();
    const db = new Database(path, { create: true });
    db.exec(V1);
    db.close();
    return path;
  }

  test("adds every column that came after v1", () => {
    const path = v1Ledger();
    expect(columns(path).has("cache_ttl")).toBe(false);

    Ledger.create(path).close();

    const cols = columns(path);
    expect(cols.has("cache_ttl")).toBe(true);
    expect(cols.has("api_key_name")).toBe(true);
    expect(cols.has("cost_source")).toBe(true);
    expect(cols.has("reasoning_effort")).toBe(true);
    expect(cols.has("tool_surface")).toBe(true);
  });

  test("the new column is null on the rows that predate it", () => {
    // The property the tracker leans on: null means *unknown*, so a
    // pre-migration row compares to nothing and produces no spurious cold row
    // on the first call after an upgrade (#33).
    const path = v1Ledger();
    const seed = new Database(path);
    seed
      .query(
        `INSERT INTO calls (ts, character, provider, model, call_type,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           total_ms, ttft_ms, finish_reason, thinking_enabled, total_cost)
         VALUES ('2026-01-01T00:00:00Z', 'ada', 'anthropic', 'claude', 'message',
           10, 5, 0, 0, 100, 10, 'end_turn', 1, 1.25)`,
      )
      .run();
    seed.close();

    Ledger.create(path).close();

    const db = new Database(path, { readonly: true });
    const row = db.query("SELECT tool_surface FROM calls").get() as {
      tool_surface: string | null;
    };
    db.close();
    expect(row.tool_surface).toBeNull();
  });

  test("adds the tables that came after v1", () => {
    const path = v1Ledger();

    Ledger.create(path).close();

    expect(tables(path).has("usage_budget_warnings")).toBe(true);
  });

  test("keeps the rows that were already there", () => {
    const path = v1Ledger();
    const seed = new Database(path);
    seed
      .query(
        `INSERT INTO calls (ts, character, provider, model, call_type,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           total_ms, ttft_ms, finish_reason, thinking_enabled, total_cost)
         VALUES ('2026-01-01T00:00:00Z', 'ada', 'anthropic', 'claude', 'message',
           10, 5, 0, 0, 100, 10, 'end_turn', 1, 1.25)`,
      )
      .run();
    seed.close();

    Ledger.create(path).close();

    const db = new Database(path, { readonly: true });
    const row = db.query("SELECT character, total_cost, cost_source FROM calls").get() as {
      character: string;
      total_cost: number;
      cost_source: string;
    };
    db.close();
    expect(row.character).toBe("ada");
    expect(row.total_cost).toBe(1.25);
    // Backfilled: a row with a total and no component costs came from the
    // provider, and must not be overwritten by a catalog estimate on the next
    // forced recalculation.
    expect(row.cost_source).toBe("provider_reported");
  });

  test("a row with component costs keeps the catalog as its source", () => {
    const path = v1Ledger();
    const seed = new Database(path);
    seed
      .query(
        `INSERT INTO calls (ts, character, provider, model, call_type,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           total_ms, ttft_ms, finish_reason, thinking_enabled,
           input_cost, output_cost, total_cost)
         VALUES ('2026-01-01T00:00:00Z', 'ada', 'anthropic', 'claude', 'message',
           10, 5, 0, 0, 100, 10, 'end_turn', 1, 0.5, 0.75, 1.25)`,
      )
      .run();
    seed.close();

    Ledger.create(path).close();

    const db = new Database(path, { readonly: true });
    const row = db.query("SELECT cost_source FROM calls").get() as { cost_source: string };
    db.close();
    expect(row.cost_source).toBe("pricing_catalog");
  });
});
