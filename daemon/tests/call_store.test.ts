import { describe, expect, test } from "bun:test";

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
      character: "frank",
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
      character: "frank",
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
      character: "frank",
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
    [0, "heartbeat", "frank", "heartbeat", 0, JSON.stringify({ text: "hi" })],
    [0, "heartbeat", "frank", "heartbeat", 1, JSON.stringify({ text: "tool result" })],
    [1, "heartbeat", "frank", "heartbeat", 0, JSON.stringify({ text: "second tick" })],
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
      `SELECT COALESCE((SELECT stored FROM capture_payloads WHERE id = request_payload_id),
                       0) AS stored
         FROM capture_calls WHERE call_id = ?1`,
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
  const columns = db.query("PRAGMA table_info(capture_transcripts)").all() as { name: string }[];
  const indexes = db
    .query(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         AND tbl_name IN ('capture_calls', 'capture_transcripts')
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
    expect(ids(store, { character: "frank", limit: 0 })).toEqual(["c2", "c5", "c1"]);
    expect(ids(store, { character: "wren", limit: 0 })).toEqual(["c3"]);
    store.close();
  });

  test("both filters together narrow, they do not widen", () => {
    const store = filled();
    expect(ids(store, { call_type: "heartbeat", character: "frank", limit: 0 })).toEqual(["c2"]);
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

  test("a summary reads each field back from its own column", () => {
    const store = filled();
    const byId = new Map(store.queryCalls({ limit: 0 }).map((c) => [c.call_id, c]));
    expect(byId.get("c1")).toEqual({
      id: 1,
      call_id: "c1",
      ts: "2026-01-15T12:00:00+00:00",
      call_type: "message",
      character: "frank",
      model: "claude-x",
      provider: "anthropic",
      finish_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 80, cache_write_tokens: 0 },
      duration_ms: 1234,
      error: null,
      request_bytes: 13,
      response_bytes: 14,
    });
    expect(byId.get("c2")).toMatchObject({ call_type: "heartbeat", duration_ms: null, error: "overloaded_error" });
    expect(byId.get("c3")).toMatchObject({ duration_ms: 0 });
    expect(byId.get("c5")?.ts).toBe("2026-01-15T12:00:00.750+00:00");
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
    expect(store.queryTranscripts("heartbeat", "frank", 0)).toHaveLength(3);
    expect(store.queryTranscripts("heartbeat", null, 0)).toHaveLength(4);
    expect(store.queryTranscripts("heartbeat", "wren", 0)).toHaveLength(0);
    store.close();
  });

  test("newest first, and entries written in the same second come back newest first too", () => {
    const store = filled();
    expect(store.queryTranscripts("heartbeat", "frank", 0).map((r) => r.entry)).toEqual([
      { text: "second tick" },
      { text: "tool result" },
      { text: "hi" },
    ]);
    store.close();
  });

  test("a transcript row reads each field back from its own column", () => {
    const store = filled();
    expect(store.queryTranscripts("dreaming", null, 0)).toEqual([
      {
        id: 4,
        ts: "2026-01-15T12:00:02+00:00",
        source: "dreaming",
        character: "wren",
        call_type: "compaction",
        iteration: 0,
        model: "claude-x",
        provider: "anthropic",
        finish_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 0 },
        entry: "not json {",
      },
    ]);
    expect(store.queryTranscripts("heartbeat", "frank", 0)[1]).toMatchObject({ id: 2, iteration: 1 });
    expect(store.queryTranscripts("heartbeat", null, 1)[0]).toMatchObject({ character: null, call_type: null });
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

describe("a payload larger than one call may store", () => {
  test("is truncated to the cap and says so", () => {
    const store = CallStore.openInMemory();
    const oversized = "x".repeat(33_554_432 + 4096);
    const id = store.storePayload(oversized);
    const loaded = store.loadPayload(id);
    expect(loaded).not.toBeNull();
    const text = Buffer.from(loaded as Uint8Array).toString("utf8");
    expect(text.length).toBeLessThan(oversized.length);
    expect(text).toContain("payload truncated");
    expect(text).toContain("33554432");
    store.close();
  });

  test("a payload at or under the cap is stored whole", () => {
    const store = CallStore.openInMemory();
    const exact = "y".repeat(1024);
    const loaded = store.loadPayload(store.storePayload(exact));
    expect(Buffer.from(loaded as Uint8Array).toString("utf8")).toBe(exact);
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
    expect(store.getCall(4)?.response).toBe("");
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
        character: "frank",
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
    character: "frank",
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
    character: "frank",
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

  expect(store.queryTranscripts("heartbeat", "frank", 0)[0]?.entry).toEqual({ marker });
  expect(store.httpCallsFor("call-utf8")[0]?.request_headers).toEqual([["x-note", marker]]);

  store.close();
});
