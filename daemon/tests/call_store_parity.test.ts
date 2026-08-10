/**
 * Replay of `call_store_parity.json` — the observability store, against the
 * Rust it was ported from (`crates/daemon/src/call_store.rs` at 9023b46d).
 *
 * The store keeps its payloads zstd-compressed, and the compressed size is
 * observable: `request_bytes` ships in every `call_log` row, and the rotate
 * size backstop is a running sum over exactly those bytes. It is also *not*
 * portable — the Rust `zstd` crate and Bun link different libzstd builds, and
 * they disagree on the compressed size of some inputs. So most of this file
 * does not ask TypeScript to reproduce Rust's bytes. It hands TypeScript
 * Rust's bytes:
 *
 * - `canonical` and `rotate` ship whole SQLite files the Rust wrote. The
 *   replay writes them to disk, opens them, and demands the same answers —
 *   which pins every byte count, every eviction boundary and every
 *   decompression against real Rust output.
 * - `roundtrip` is the other direction, the store written through its own API.
 *   There, and only there, `request_bytes`/`response_bytes` are elided, and
 *   what they stand for is asserted separately.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CallStore,
  ZERO_USAGE,
  type CallFilter,
  type CallRecord,
  type TranscriptRecord,
} from "../src/call_store.ts";

import fixture from "./call_store_fixtures/call_store_parity.json" with { type: "json" };

const root = mkdtempSync(join(tmpdir(), "call-store-parity-"));
let seq = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Materialise a base64 SQLite file from the fixture and open it. */
function openFrom(db_b64: string): CallStore {
  seq += 1;
  const path = join(root, `db${seq}.sqlite`);
  writeFileSync(path, Buffer.from(db_b64, "base64"));
  return CallStore.open(path);
}

// ── the canonical store, as Rust wrote it ───────────────────────────────────

interface QueryCase {
  case: string;
  op: string;
  args: Record<string, unknown>;
  ok: unknown;
}

describe("queries against the Rust-written store", () => {
  const store = openFrom(fixture.canonical.db_b64);

  for (const row of fixture.canonical.queries as QueryCase[]) {
    test(row.case, () => {
      expect(runQuery(store, row)).toEqual(row.ok);
    });
  }
});

function runQuery(store: CallStore, row: QueryCase): unknown {
  const args = row.args;
  switch (row.op) {
    case "query_calls":
      return store.queryCalls({
        call_type: args["call_type"] as string | null,
        character: args["character"] as string | null,
        limit: args["limit"] as number,
      });
    case "get_call":
      return store.getCall(args["id"] as number);
    case "query_transcripts":
      return store.queryTranscripts(
        args["source"] as string,
        args["character"] as string | null,
        args["limit"] as number,
      );
    case "call_count":
      return store.callCount();
    default:
      throw new Error(`unknown op ${row.op}`);
  }
}

// ── rotate ──────────────────────────────────────────────────────────────────

interface RotateCase {
  case: string;
  db_b64: string;
  cutoff_rfc3339: string;
  max_total_bytes: number;
  stats: { deleted_by_age: number; deleted_by_size: number };
  surviving_call_ids: string[];
  surviving_transcript_ids: number[];
  call_count_after: number;
}

describe("rotate", () => {
  for (const row of fixture.rotate as RotateCase[]) {
    test(row.case, () => {
      const store = openFrom(row.db_b64);
      const stats = store.rotate(new Date(row.cutoff_rfc3339), row.max_total_bytes);
      expect(stats).toEqual(row.stats);
      const survivors = store.queryCalls({ limit: 0 }).map((s) => s.call_id);
      expect(survivors).toEqual(row.surviving_call_ids);
      const transcripts = store.queryTranscripts("heartbeat", null, 0).map((t) => t.id);
      expect(transcripts).toEqual(row.surviving_transcript_ids);
      expect(store.callCount()).toBe(row.call_count_after);
      store.close();
    });
  }
});

// ── migration ───────────────────────────────────────────────────────────────

interface SchemaShape {
  transcript_columns: string[];
  indexes: { name: string; sql: string | null }[];
}

/** The same two `PRAGMA`/`sqlite_master` reads the generator recorded. */
function schemaShape(store: CallStore): SchemaShape {
  const db = store.database;
  const columns = db.query("PRAGMA table_info(transcripts)").all() as { name: string }[];
  const indexes = db
    .query(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         AND tbl_name IN ('calls', 'transcripts')
       ORDER BY name`,
    )
    .all() as { name: string; sql: string | null }[];
  return { transcript_columns: columns.map((c) => c.name), indexes };
}

/**
 * Compare index DDL with runs of whitespace collapsed. SQLite stores the
 * `CREATE INDEX` statement verbatim, so the recorded SQL carries the Rust
 * source's own line breaks and indentation — which is formatting, not schema.
 * The index names, the columns and their order all still compare exactly.
 */
function collapse(shape: SchemaShape): unknown {
  return {
    transcript_columns: shape.transcript_columns,
    indexes: shape.indexes.map((i) => ({
      name: i.name,
      sql: i.sql === null ? null : i.sql.replace(/\s+/g, " ").trim(),
    })),
  };
}

describe("migration", () => {
  const m = fixture.migration;

  test("a foundation DB gains transcripts.character and the covering index", () => {
    const store = openFrom(m.foundation_db_b64);
    // Writing a character would have failed against the old schema.
    store.recordTranscript({
      ts: new Date("2026-01-15T12:00:00Z"),
      source: "dreaming",
      character: "poppy",
      call_type: "dreaming",
      iteration: 0,
      model: "deepseek",
      provider: "deepseek",
      finish_reason: "end_turn",
      usage: ZERO_USAGE,
      entry_json: JSON.stringify({ text: "hi" }),
    });
    expect(collapse(schemaShape(store))).toEqual(collapse(m.shape_after_migration));
    expect(store.queryTranscripts("dreaming", "poppy", 0)).toEqual(m.rows_after_migration);
    store.close();
  });

  test("opening a fresh DB twice leaves the current schema alone", () => {
    seq += 1;
    const path = join(root, `fresh${seq}.sqlite`);
    CallStore.open(path).close();
    const store = CallStore.open(path);
    expect(collapse(schemaShape(store))).toEqual(collapse(m.shape_of_fresh_db_opened_twice));
    store.close();
  });
});

// ── the store written through its own API ───────────────────────────────────

/**
 * The same contents the generator laid down, re-declared rather than read out
 * of the fixture, so what went in is what the assertions are about.
 */
const BIG_REQUEST = "context line that repeats and compresses away\n";
const UNICODE_RESPONSE = "réponse ✅ 你好 \u{1f600}";

function at(secs: number, millis = 0): Date {
  return new Date(Date.parse("2026-01-15T12:00:00Z") + secs * 1000 + millis);
}

function fillCanonical(store: CallStore): void {
  const calls: CallRecord[] = [
    {
      call_id: "c1",
      ts: at(0),
      call_type: "message",
      character: "poppy",
      model: "claude-x",
      provider: "anthropic",
      sdk: "anthropic",
      rid: "rid_1",
      finish_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 80 },
      duration_ms: 1234,
      error: null,
      request_body: "first request",
      response_body: "first response",
    },
    {
      call_id: "c2",
      ts: at(1),
      call_type: "heartbeat",
      character: "poppy",
      model: "claude-x",
      provider: "anthropic",
      sdk: "anthropic",
      rid: "rid_2",
      finish_reason: null,
      usage: { input_tokens: 7, output_tokens: 0, cache_read_tokens: 0 },
      duration_ms: null,
      error: "overloaded_error",
      request_body: "second request",
      response_body: null,
    },
    {
      call_id: "c3",
      ts: at(2),
      call_type: "heartbeat",
      character: "wren",
      model: "deepseek",
      provider: "deepseek",
      sdk: "openai",
      rid: null,
      finish_reason: "stop",
      usage: ZERO_USAGE,
      duration_ms: 0,
      error: null,
      request_body: BIG_REQUEST.repeat(500),
      response_body: UNICODE_RESPONSE,
    },
    {
      call_id: "c4",
      ts: at(2),
      call_type: null,
      character: null,
      model: null,
      provider: null,
      sdk: null,
      rid: null,
      finish_reason: null,
      usage: ZERO_USAGE,
      duration_ms: null,
      error: null,
      request_body: "",
      response_body: "",
    },
    // Written last, and stamped three-quarters of a second into c1's second.
    // That makes three things load-bearing at once: the sort key is the
    // timestamp rather than the insertion order the ids follow; the second is
    // truncated rather than rounded, which would push this row past c1; and
    // the `(ts_unix, id)` tiebreak decides c1 vs c5 under every query plan,
    // because the two rows also share a call type and a character.
    {
      call_id: "c5",
      ts: at(0, 750),
      call_type: "message",
      character: "poppy",
      model: "claude-x",
      provider: "anthropic",
      sdk: "anthropic",
      rid: "rid_5",
      finish_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3 },
      duration_ms: 9,
      error: null,
      request_body: "out of order request",
      response_body: "out of order response",
    },
  ];
  for (const call of calls) store.recordCall(call);

  // `call_type` is not the same thing as `source`: a compaction pass writes
  // its transcript under the dreaming source.
  const transcripts: [number, string, string | null, string | null, number, string][] = [
    [0, "heartbeat", "poppy", "heartbeat", 0, JSON.stringify({ text: "hi" })],
    [0, "heartbeat", "poppy", "heartbeat", 1, JSON.stringify({ text: "tool result" })],
    [1, "heartbeat", "poppy", "heartbeat", 0, JSON.stringify({ text: "second tick" })],
    [2, "dreaming", "wren", "compaction", 0, "not json {"],
    [3, "heartbeat", null, null, 0, "[1,2,3]"],
  ];
  for (const [offset, source, character, call_type, iteration, entry_json] of transcripts) {
    const record: TranscriptRecord = {
      ts: at(offset),
      source,
      character,
      call_type,
      iteration,
      model: "claude-x",
      provider: "anthropic",
      finish_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 22, cache_read_tokens: 33 },
      entry_json,
    };
    store.recordTranscript(record);
  }
}

/**
 * Drop the two compressed-size fields. They are the one place the compressor
 * shows through, and the two libzstd builds do not agree on them for every
 * input — see the file header. Everything else in the row still compares.
 */
function withoutBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBytes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        ([k]) => k !== "request_bytes" && k !== "response_bytes",
      ),
    );
  }
  return value;
}

describe("round trip through the API", () => {
  const store = CallStore.openInMemory();
  fillCanonical(store);
  const r = fixture.roundtrip;

  test("get_call returns the same payloads", () => {
    const got = [1, 2, 3, 4, 5].map((id) => store.getCall(id));
    expect(withoutBytes(got)).toEqual(withoutBytes(r.payloads));
  });

  test("query_calls returns the same summaries", () => {
    expect(withoutBytes(store.queryCalls({ limit: 0 }))).toEqual(withoutBytes(r.summaries));
  });

  test("query_transcripts returns the same rows", () => {
    expect(store.queryTranscripts("heartbeat", null, 0)).toEqual(r.transcripts);
  });

  test("call_count", () => {
    expect(store.callCount()).toBe(r.call_count);
  });

  test("a repetitive body lands smaller than it arrived", () => {
    const c3 = store.queryCalls({ limit: 0 }).find((s) => s.call_id === "c3");
    expect(c3?.request_bytes).toBeGreaterThan(0);
    expect(c3!.request_bytes < r.big_body_bytes).toBe(r.big_body_compressed_is_smaller);
  });

  test("an empty body is stored, not treated as absent", () => {
    expect(store.getCall(4)?.response === "").toBe(r.empty_body_response_is_empty_string);
    expect(store.getCall(4)?.request_bytes).toBeGreaterThan(0);
  });

  test("a missing response body reads back as null", () => {
    expect(store.getCall(2)?.response === null).toBe(r.missing_body_response_is_null);
    expect(store.getCall(2)?.response_bytes).toBe(0);
  });
});

// ── zstd interop ────────────────────────────────────────────────────────────

/**
 * The property that makes an existing on-disk store readable: frames the Rust
 * compressed must decompress here, byte for byte, including empty input and
 * multi-byte UTF-8.
 */
test("frames written by Rust decompress to the original text", () => {
  const store = openFrom(fixture.zstd.db_b64);
  const texts = (fixture.zstd.texts as { text: string }[]).map((t) => t.text);
  texts.forEach((text, idx) => {
    expect(store.getCall(idx + 1)?.request).toBe(text);
  });
  store.close();
});

// ── filters, restated ───────────────────────────────────────────────────────

/**
 * `CallFilter` is spelled with optional fields here where the Rust spells it
 * with `Option`, so the two ways of saying "no filter" have to mean the same
 * thing — an omitted key and an explicit `null` both match every row.
 */
test("an omitted filter field matches everything, like an explicit null", () => {
  const store = openFrom(fixture.canonical.db_b64);
  const omitted: CallFilter = { limit: 0 };
  const explicit: CallFilter = { call_type: null, character: null, limit: 0 };
  expect(store.queryCalls(omitted)).toEqual(store.queryCalls(explicit));
  expect(store.queryCalls(omitted).length).toBe(5);
  store.close();
});
