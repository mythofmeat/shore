import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { toolSurfaceFingerprint } from "../src/ledger/tool_surface.ts";
import { Ledger } from "../src/ledger/store.ts";
import { exportTsv } from "../src/ledger/query.ts";
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
    const { ledger: l, db } = ledger();
    l.record(call(undefined));

    const row = db.query("SELECT tool_surface FROM calls ORDER BY id DESC LIMIT 1").get() as {
      tool_surface: string | null;
    };
    expect(row.tool_surface).toBeNull();
  });

  test("a change is recorded without an anomaly", () => {
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

  test("the TSV export carries the tool surface", () => {
    const { ledger: l, db } = ledger();
    const fingerprint = toolSurfaceFingerprint([READ_TOOL])!;
    l.record(call(fingerprint));

    const tsv = exportTsv(db, {});
    const [header, row] = tsv.split("\n");
    const index = header!.split("\t").indexOf("tool_surface");
    expect(index).toBe(12);
    expect(header!.split("\t")[index - 1]).toBe("reasoning_effort");
    expect(row!.split("\t")[index]).toBe(fingerprint);
  });

  test("an unknown surface exports as an empty field, not the word null", () => {
    const { ledger: l, db } = ledger();
    l.record(call(undefined));

    const tsv = exportTsv(db, {});
    const [header, row] = tsv.split("\n");
    const index = header!.split("\t").indexOf("tool_surface");
    expect(row!.split("\t")[index]).toBe("");
  });

  test("without the fingerprint, that same pair is an anomaly", () => {
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
