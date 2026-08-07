/**
 * The tool-surface fingerprint, and the ledger column it lands in (#33).
 *
 * The fingerprint is what lets the cache tracker tell a config change from an
 * anomaly. Two properties matter and are tested separately: it changes when the
 * bytes the adapter sends change, and it survives the trip through the ledger
 * so the tracker's fourth transition has something to compare.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { toolSurfaceFingerprint } from "../src/ledger/tool_surface.ts";
import { Ledger } from "../src/ledger/store.ts";
import { freshLedger } from "./support/ledger_fixture.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

const READ_TOOL = { name: "read", description: "Read a file.", input_schema: { type: "object" } };
const WRITE_TOOL = { name: "write", description: "Write a file.", input_schema: { type: "object" } };

describe("the fingerprint", () => {
  test("is stable for the same surface", () => {
    expect(toolSurfaceFingerprint([READ_TOOL, WRITE_TOOL])).toBe(
      toolSurfaceFingerprint([READ_TOOL, WRITE_TOOL]),
    );
  });

  test("changes when a tool is added or removed", () => {
    const one = toolSurfaceFingerprint([READ_TOOL]);
    expect(toolSurfaceFingerprint([READ_TOOL, WRITE_TOOL])).not.toBe(one);
    expect(toolSurfaceFingerprint([])).not.toBe(one);
  });

  // The reason this hashes the definitions rather than the names: an MCP server
  // that changes a description or a schema moves the head of the prefix exactly
  // as much as one that disappears, and a name-only fingerprint would miss it
  // entirely — the anomaly would come back with no cause attached.
  test("changes when a tool's description or schema changes", () => {
    const base = toolSurfaceFingerprint([READ_TOOL]);
    expect(toolSurfaceFingerprint([{ ...READ_TOOL, description: "Read a file, twice." }])).not.toBe(
      base,
    );
    expect(
      toolSurfaceFingerprint([
        { ...READ_TOOL, input_schema: { type: "object", properties: { path: {} } } },
      ]),
    ).not.toBe(base);
  });

  test("order is part of it, because it is part of the bytes", () => {
    expect(toolSurfaceFingerprint([READ_TOOL, WRITE_TOOL])).not.toBe(
      toolSurfaceFingerprint([WRITE_TOOL, READ_TOOL]),
    );
  });

  // `undefined` is *unknown* and must stay distinguishable from "no tools":
  // the tracker skips the comparison on unknown, and a character whose tools
  // were switched off really did move the prefix.
  test("no tools field is unknown, an empty list is a surface", () => {
    expect(toolSurfaceFingerprint(undefined)).toBeUndefined();
    expect(toolSurfaceFingerprint([])).toBeDefined();
  });
});

describe("the ledger column", () => {
  function ledger(): { ledger: Ledger; db: Database } {
    const f = freshLedger();
    cleanups.push(f.cleanup);
    const l = Ledger.create(f.path);
    if (l === null) throw new Error("ledger did not open");
    return { ledger: l, db: new Database(f.path) };
  }

  const call = (tool_surface: string | undefined) => ({
    provider: "anthropic",
    model: "claude-opus-4-6",
    call_type: "message",
    character: "ada",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 100,
    },
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    finish_reason: "end_turn",
    thinking_enabled: false,
    tool_surface,
  });

  test("round-trips through a recorded row", () => {
    const { ledger: l, db } = ledger();
    const fingerprint = toolSurfaceFingerprint([READ_TOOL])!;
    l.record(call(fingerprint));

    const row = db.query("SELECT tool_surface FROM calls ORDER BY id DESC LIMIT 1").get() as {
      tool_surface: string | null;
    };
    expect(row.tool_surface).toBe(fingerprint);
  });

  test("an unknown surface is null, not an empty string", () => {
    // Null is what the tracker reads as "do not compare". An empty string would
    // be a surface, and would report a change against the next real one.
    const { ledger: l, db } = ledger();
    l.record(call(undefined));

    const row = db.query("SELECT tool_surface FROM calls ORDER BY id DESC LIMIT 1").get() as {
      tool_surface: string | null;
    };
    expect(row.tool_surface).toBeNull();
  });

  test("a change is recorded without an anomaly", () => {
    // End to end: two calls whose surfaces differ produce a cold row and no
    // `unexpected_write`, which is the entire complaint in #33.
    const { ledger: l, db } = ledger();
    l.record({
      ...call(toolSurfaceFingerprint([READ_TOOL])),
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 4283, cache_creation_tokens: 12 },
    });
    l.record({
      ...call(toolSurfaceFingerprint([READ_TOOL, WRITE_TOOL])),
      usage: { input_tokens: 3, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 5034 },
    });

    const rows = db
      .query("SELECT cache_state, cache_anomaly FROM calls ORDER BY id")
      .all() as { cache_state: string | null; cache_anomaly: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[1]!.cache_anomaly).toBeNull();
  });

  test("without the fingerprint, that same pair is an anomaly", () => {
    // The control. This is what the ledger recorded before #33, and it is the
    // behaviour any row still carrying no surface keeps.
    const { ledger: l, db } = ledger();
    l.record({
      ...call(undefined),
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 4283, cache_creation_tokens: 12 },
    });
    l.record({
      ...call(undefined),
      usage: { input_tokens: 3, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 5034 },
    });

    const rows = db
      .query("SELECT cache_anomaly FROM calls ORDER BY id")
      .all() as { cache_anomaly: string | null }[];
    expect(rows[1]!.cache_anomaly).toBe("unexpected_write");
  });
});
