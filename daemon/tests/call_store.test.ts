import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CallStore,
  ZERO_USAGE,
  type CallFilter,
  type CallRecord,
  type TranscriptRecord,
} from "../src/call_store.ts";

function filled(): CallStore {
  const store = CallStore.openInMemory();
  fillCanonical(store);
  return store;
}

const ids = (store: CallStore, filter: CallFilter): string[] =>
  store.queryCalls(filter).map((c) => c.call_id);

const BIG_REQUEST = "context line that repeats and compresses away\n";
const UNICODE_RESPONSE = "réponse ✅ 你好 \u{1F600}";

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
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 80,
        cache_write_tokens: 0,
      },
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
      usage: {
        input_tokens: 7,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
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
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_write_tokens: 0,
      },
      duration_ms: 9,
      error: null,
      request_body: "out of order request",
      response_body: "out of order response",
    },
  ];
  for (const call of calls) store.recordCall(call);

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
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_read_tokens: 33,
        cache_write_tokens: 0,
      },
      entry_json,
    };
    store.recordTranscript(record);
  }
}

function storedRequestBytes(store: CallStore, callId: string): number {
  const row = store.database
    .query(
      `SELECT COALESCE((SELECT stored FROM payloads WHERE id = request_payload_id),
                       LENGTH(request_zstd), 0) AS stored
         FROM calls WHERE call_id = ?1`,
    )
    .get(callId) as { stored: number };
  return row.stored;
}

interface SchemaShape {
  transcript_columns: string[];
  indexes: { name: string; sql: string | null }[];
}

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

function collapse(shape: SchemaShape): unknown {
  return {
    transcript_columns: shape.transcript_columns,
    indexes: shape.indexes.map((i) => ({
      name: i.name,
      sql: i.sql === null ? null : i.sql.replace(/\s+/g, " ").trim(),
    })),
  };
}

const HUGE = 1_000_000_000;

describe("querying the calls a store holds", () => {
  test("everything, newest first, ties broken by insertion so the order is stable", () => {
    const store = filled();
    expect(ids(store, { limit: 0 })).toEqual(["c4", "c3", "c2", "c5", "c1"]);
    store.close();
  });

  test("filtered by call type", () => {
    const store = filled();
    expect(ids(store, { call_type: "message", limit: 0 })).toEqual(["c5", "c1"]);
    expect(ids(store, { call_type: "heartbeat", limit: 0 })).toEqual(["c3", "c2"]);
    expect(ids(store, { call_type: "nothing-like-this", limit: 0 })).toEqual([]);
    store.close();
  });

  test("filtered by character", () => {
    const store = filled();
    expect(ids(store, { character: "poppy", limit: 0 })).toEqual(["c2", "c5", "c1"]);
    expect(ids(store, { character: "wren", limit: 0 })).toEqual(["c3"]);
    store.close();
  });

  test("both filters together narrow, they do not widen", () => {
    const store = filled();
    expect(ids(store, { call_type: "heartbeat", character: "poppy", limit: 0 })).toEqual(["c2"]);
    store.close();
  });

  test("a limit takes the newest N, and zero means every row", () => {
    const store = filled();
    expect(ids(store, { limit: 2 })).toEqual(["c4", "c3"]);
    expect(ids(store, { limit: 0 })).toHaveLength(5);
    store.close();
  });

  test("an omitted filter field matches everything, like an explicit null", () => {
    const store = filled();
    expect(store.queryCalls({ limit: 0 })).toEqual(
      store.queryCalls({ call_type: null, character: null, limit: 0 }),
    );
    store.close();
  });

  test("a call with no type or character is still returned by an unfiltered query", () => {
    const store = filled();
    expect(ids(store, { limit: 0 })).toContain("c4");
    expect(ids(store, { call_type: "message", limit: 0 })).not.toContain("c4");
    store.close();
  });

  test("getCall reads one back by row id, and a miss is null", () => {
    const store = filled();
    expect(store.getCall(1)?.call_id).toBe("c1");
    expect(store.getCall(999)).toBeNull();
    store.close();
  });

  test("callCount counts calls, not transcripts", () => {
    const store = filled();
    expect(store.callCount()).toBe(5);
    store.close();
  });
});

describe("querying the transcripts a store holds", () => {
  test("filtered by source", () => {
    const store = filled();
    expect(store.queryTranscripts("heartbeat", null, 0)).toHaveLength(4);
    expect(store.queryTranscripts("dreaming", null, 0)).toHaveLength(1);
    store.close();
  });

  test("a null character in the filter means any, not only the null ones", () => {
    const store = filled();
    expect(store.queryTranscripts("heartbeat", "poppy", 0)).toHaveLength(3);
    expect(store.queryTranscripts("heartbeat", null, 0)).toHaveLength(4);
    expect(store.queryTranscripts("heartbeat", "wren", 0)).toHaveLength(0);
    store.close();
  });

  test("an entry that is not JSON still comes back rather than failing the query", () => {
    const store = filled();
    const [row] = store.queryTranscripts("dreaming", "wren", 0);
    expect(row).toBeDefined();
    store.close();
  });

  test("a JSON array entry is preserved as an array", () => {
    const store = filled();
    expect(store.queryTranscripts("heartbeat", null, 0).some((r) => Array.isArray(r.entry))).toBe(
      true,
    );
    store.close();
  });
});

describe("rotating a store", () => {
  test("drops what is older than the cutoff", () => {
    const store = filled();
    const stats = store.rotate(at(2), HUGE);
    expect(stats.deleted_by_age).toBeGreaterThan(0);
    expect(stats.deleted_by_size).toBe(0);
    expect(ids(store, { limit: 0 })).toEqual(["c4", "c3"]);
    store.close();
  });

  test("a cutoff before everything deletes nothing", () => {
    const store = filled();
    expect(store.rotate(at(-1), HUGE)).toEqual({ deleted_by_age: 0, deleted_by_size: 0 });
    expect(store.callCount()).toBe(5);
    store.close();
  });

  test("a cutoff after everything empties it", () => {
    const store = filled();
    store.rotate(at(60), HUGE);
    expect(store.callCount()).toBe(0);
    expect(store.queryTranscripts("heartbeat", null, 0)).toEqual([]);
    store.close();
  });

  test("transcripts age out alongside the calls", () => {
    const store = filled();
    store.rotate(at(2), HUGE);
    expect(store.queryTranscripts("heartbeat", "poppy", 0)).toEqual([]);
    store.close();
  });

  test("rotating twice deletes nothing the second time", () => {
    const store = filled();
    store.rotate(at(2), HUGE);
    expect(store.rotate(at(2), HUGE)).toEqual({ deleted_by_age: 0, deleted_by_size: 0 });
    store.close();
  });

  test("a size ceiling drops the oldest until the store fits under it", () => {
    const store = filled();
    const stats = store.rotate(at(-1), 1);
    expect(stats.deleted_by_age).toBe(0);
    expect(stats.deleted_by_size).toBeGreaterThan(0);
    store.close();
  });

  test("the ceiling is a byte count with no unlimited sentinel: zero is a zero ceiling", () => {
    const store = filled();
    expect(store.rotate(at(-1), 0).deleted_by_size).toBe(4);
    expect(store.callCount()).toBe(1);
    store.close();
  });

  test("the newest call always survives the ceiling, so the store is never emptied by size", () => {
    const store = filled();
    store.rotate(at(-1), 0);
    expect(ids(store, { limit: 0 })).toEqual(["c4"]);
    store.close();
  });
});

describe("the schema a store opens with", () => {
  test("a database opened twice is left alone the second time", () => {
    const first = CallStore.openInMemory();
    const shape = collapse(schemaShape(first));
    first.close();
    const second = CallStore.openInMemory();
    expect(collapse(schemaShape(second))).toEqual(shape);
    second.close();
  });

  test("transcripts carry the character a query filters on", () => {
    const store = CallStore.openInMemory();
    expect(schemaShape(store).transcript_columns).toContain("character");
    store.close();
  });

  test("a database missing transcripts.character gains it when reopened", () => {
    const path = join(mkdtempSync(join(tmpdir(), "call-store-migrate-")), "db.sqlite");
    const before = CallStore.open(path);
    for (const row of before.database
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transcripts'")
      .all() as { name: string }[]) {
      if (!row.name.startsWith("sqlite_")) before.database.run(`DROP INDEX "${row.name}"`);
    }
    before.database.run("ALTER TABLE transcripts DROP COLUMN character");
    expect(schemaShape(before).transcript_columns).not.toContain("character");
    before.close();

    const after = CallStore.open(path);
    expect(schemaShape(after).transcript_columns).toContain("character");
    after.recordTranscript({
      ts: at(0),
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
    expect(after.queryTranscripts("dreaming", "poppy", 0)).toHaveLength(1);
    after.close();
  });
});

describe("what a call body costs to store", () => {
  test("a repetitive body reports what arrived, and lands smaller than that", () => {
    const store = filled();
    const c3 = store.queryCalls({ limit: 0 }).find((c) => c.call_id === "c3");
    expect(c3?.request_bytes).toBe(BIG_REQUEST.repeat(500).length);
    expect(storedRequestBytes(store, "c3")).toBeLessThan(c3?.request_bytes ?? 0);
    store.close();
  });

  test("an empty body is stored, not treated as absent", () => {
    const store = filled();
    expect(store.getCall(4)?.request).toBe("");
    expect(store.getCall(4)?.request_bytes).toBe(0);
    expect(storedRequestBytes(store, "c4")).toBeGreaterThan(0);
    store.close();
  });

  test("a missing response body reads back as null, not as empty", () => {
    const store = filled();
    expect(store.getCall(2)?.response).toBeNull();
    expect(store.getCall(2)?.response_bytes).toBe(0);
    store.close();
  });

  test("a compressed body decompresses to exactly what went in", () => {
    const store = filled();
    expect(store.getCall(3)?.request).toBe(BIG_REQUEST.repeat(500));
    expect(store.getCall(3)?.response).toBe(UNICODE_RESPONSE);
    store.close();
  });

  test("a body round-trips through whatever it was stored as", () => {
    const store = CallStore.openInMemory();
    for (const [i, text] of ["", "short", BIG_REQUEST.repeat(200), UNICODE_RESPONSE].entries()) {
      store.recordCall({
        call_id: `r${i}`,
        ts: at(i),
        call_type: "message",
        character: "poppy",
        model: "m",
        provider: "p",
        sdk: "openai",
        rid: null,
        finish_reason: "stop",
        usage: ZERO_USAGE,
        duration_ms: null,
        error: null,
        request_body: text,
        response_body: text,
      });
      expect(store.getCall(i + 1)?.request, `case ${i}`).toBe(text);
    }
    store.close();
  });
});

test("headers and transcript entries survive characters that are not latin-1", () => {
  const store = CallStore.openInMemory();
  const marker = "réponse ✅ 你好 \u{1F600}";

  store.recordTranscript({
    ts: new Date("2026-08-10T12:00:00.000Z"),
    source: "heartbeat",
    character: "poppy",
    call_type: "heartbeat",
    iteration: 0,
    model: "claude-x",
    provider: "anthropic",
    finish_reason: "end_turn",
    usage: ZERO_USAGE,
    entry_json: JSON.stringify({ marker }),
  });

  store.recordHttpCall({
    call_id: "call-utf8",
    seq: 0,
    ts: new Date("2026-08-10T12:00:00.000Z"),
    character: "poppy",
    call_type: "heartbeat",
    rid: null,
    method: "POST",
    url: "https://example.invalid/v1/messages",
    status: 200,
    status_text: "OK",
    duration_ms: 1,
    error: null,
    request_headers: [["x-note", marker]],
    request_body: null,
    response_headers: [],
    response_body: null,
  });

  expect(store.queryTranscripts("heartbeat", "poppy", 0)[0]?.entry).toEqual({ marker });
  expect(store.httpCallsFor("call-utf8")[0]?.request_headers).toEqual([["x-note", marker]]);

  store.close();
});
