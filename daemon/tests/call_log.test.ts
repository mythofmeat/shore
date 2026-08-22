import { required } from "../src/util/required.ts";

import { expandShared } from "./support/shared_subtrees.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { callLog, transcript, type CallLogContext } from "../src/commands/call_log.ts";
import { CommandError } from "../src/commands/errors.ts";
import type { ErrorCode } from "../src/protocol/ErrorCode.ts";

import rawFixture from "./command_captures/call_log.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

const root = mkdtempSync(join(tmpdir(), "call-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function at(secs: number): Date {
  return new Date(Date.parse("2026-01-15T12:00:00Z") + secs * 1000);
}

const CALL_ROWS: [string, number, string, string, string, string | null][] = (() => {
  const rows: [string, number, string, string, string, string | null][] = [
    ["call_a", 0, "message", "poppy", "request a", "response a"],
    ["call_b", 1, "heartbeat", "poppy", "request b", null],
    ["call_c", 2, "message", "wren", "request c", "response c"],
    ["call_d", 3, "heartbeat", "poppy", "request d", "response d"],
    ["call_e", 3, "heartbeat", "wren", "request e", "response e"],
  ];
  for (let i = 0; i < 20; i += 1) {
    rows.push([
      `filler_${String(i).padStart(2, "0")}`,
      -1000 + i,
      "message",
      "poppy",
      "filler request",
      null,
    ]);
  }
  return rows;
})();

function fillCalls(store: CallStore): void {
  for (const [call_id, offset, call_type, character, request, response] of CALL_ROWS) {
    store.recordCall({
      call_id,
      ts: at(offset),
      call_type,
      character,
      model: "claude-x",
      provider: "anthropic",
      sdk: "anthropic",
      rid: null,
      finish_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 5,
        cache_write_tokens: 0,
      },
      duration_ms: 42,
      error: null,
      request_body: request,
      response_body: response,
    });
  }
}

const TRANSCRIPT_ROWS: [number, string, number, string][] = (() => {
  const rows: [number, string, number, string][] = [
    [0, "poppy", 0, "t1-i0"],
    [1, "poppy", 1, "t1-i1"],
    [2, "poppy", 2, "t1-i2"],
    [3, "poppy", 0, "t2-i0"],
    [4, "poppy", 0, "t3-i0"],
    [5, "poppy", 1, "t3-i1"],
    [6, "wren", 0, "wren-i0"],
    [7, "poppy", 1, "t4-i1"],
    [8, "poppy", 1, "t5-i1"],
  ];
  for (let i = 0; i < 20; i += 1) {
    rows.push([-1000 + i, "poppy", 0, `filler-${String(i).padStart(2, "0")}`]);
  }
  return rows;
})();

function fillTranscripts(store: CallStore): void {
  for (const [offset, character, iteration, marker] of TRANSCRIPT_ROWS) {
    store.recordTranscript({
      ts: at(offset),
      source: "heartbeat",
      character,
      call_type: "heartbeat",
      iteration,
      model: "claude-x",
      provider: "anthropic",
      finish_reason: "end_turn",
      usage: ZERO_USAGE,
      entry_json: JSON.stringify({ marker }),
    });
  }
}

let stocked: CallStore;

beforeAll(() => {
  stocked = CallStore.open(join(root, "calls.sqlite"));
  fillCalls(stocked);
  fillTranscripts(stocked);
});

function contextFor(caseName: string, character: string): CallLogContext {
  const off = caseName.startsWith("disabled");
  return { characterName: character, callStore: off ? undefined : stocked };
}

function withoutBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBytes);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "request_bytes" && k !== "response_bytes")
        .map(([k, v]) => [k, withoutBytes(v)]),
    );
  }
  return value;
}

interface Case {
  case: string;
  command: "call_log" | "transcript";
  args: Record<string, unknown>;
  ok?: unknown;
  err?: { code: ErrorCode; message: string };
}

function storedTs(secs: number): string {
  return at(secs).toISOString().replace(".000Z", "+00:00");
}

function seededCall(callId: string): Record<string, unknown> {
  const at_ = CALL_ROWS.findIndex(([id]) => id === callId);
  const row = required(CALL_ROWS[at_]);
  return {
    id: at_ + 1,
    call_id: row[0],
    ts: storedTs(row[1]),
    call_type: row[2],
    character: row[3],
    model: "claude-x",
    provider: "anthropic",
    finish_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5, cache_write_tokens: 0 },
    duration_ms: 42,
    error: null,
  };
}

function seededTranscript(marker: string): Record<string, unknown> {
  const at_ = TRANSCRIPT_ROWS.findIndex(([, , , m]) => m === marker);
  const row = required(TRANSCRIPT_ROWS[at_]);
  return {
    id: at_ + 1,
    ts: storedTs(row[0]),
    source: "heartbeat",
    character: row[1],
    call_type: "heartbeat",
    iteration: row[2],
    model: "claude-x",
    provider: "anthropic",
    finish_reason: "end_turn",
    usage: ZERO_USAGE,
    entry: { marker },
  };
}

const CHARACTER_FOR = (name: string): string =>
  name === "no_rows_for_character" ? "nobody" : "poppy";

describe.each(["call_log", "transcript"])("%s", (command) => {
  for (const row of fixture.cases as Case[]) {
    if (row.command !== command) continue;
    test(row.case, () => {
      const ctx = contextFor(row.case, CHARACTER_FOR(row.case));
      const run = () =>
        row.command === "call_log" ? callLog(ctx, row.args) : transcript(ctx, row.args);

      if (row.err !== undefined) {
        expect(run).toThrow(CommandError);
        try {
          run();
        } catch (e) {
          expect((e as CommandError).code).toBe(row.err.code);
          expect((e as CommandError).message).toBe(row.err.message);
        }
        return;
      }
      const got = withoutBytes(withoutWire(run())) as Record<string, unknown>;
      const want = row.ok as Record<string, unknown>;

      for (const [field, value] of Object.entries(want)) {
        if (field === "call_ids" || field === "markers") continue;
        expect(got[field], `${row.case}: ${field}`).toEqual(value);
      }

      if (want["call_ids"] !== undefined) {
        const entries = got["entries"] as Record<string, unknown>[];
        expect(
          entries.map((e) => e["call_id"]),
          `${row.case}: the calls it logged, and their order`,
        ).toEqual(want["call_ids"] as string[]);
        for (const entry of entries) expect(entry).toEqual(seededCall(String(entry["call_id"])));
      }
      if (want["markers"] !== undefined) {
        const entries = got["entries"] as Record<string, unknown>[];
        expect(
          entries.map((e) => (e["entry"] as { marker: string }).marker),
          `${row.case}: the turns it transcribed, and their order`,
        ).toEqual(want["markers"] as string[]);
        for (const entry of entries) {
          expect(entry).toEqual(seededTranscript((entry["entry"] as { marker: string }).marker));
        }
      }
    });
  }
});

function withoutWire(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { wire: _wire, ...rest } = value as Record<string, unknown>;
  return rest;
}

const SSE = [
  { type: "message_start", message: { model: "claude-x", usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "one " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wall" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");

test("dumping one call coalesces the streamed HTTP exchange recorded under it", () => {
  const store = CallStore.openInMemory();
  const id = store.recordCall({
    call_id: "wire-1",
    ts: at(0),
    call_type: "message",
    character: "poppy",
    model: "claude-x",
    provider: "anthropic",
    usage: ZERO_USAGE,
    request_body: JSON.stringify({ normalized: true }),
    response_body: null,
  });
  store.recordHttpCall({
    call_id: "wire-1",
    seq: 0,
    ts: at(0),
    character: "poppy",
    call_type: "message",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    status_text: "OK",
    request_headers: [["content-type", "application/json"]],
    request_body: Buffer.from(`{"thinking":{"type":"enabled"}}`, "utf8"),
    response_headers: [["content-type", "text/event-stream"]],
    response_body: Buffer.from(SSE, "utf8"),
  });

  const out = callLog({ characterName: "poppy", callStore: store }, { id, wire: true }) as {
    call: { request: unknown };
    wire: { seq: number; url: string; status: number; request_body: unknown; response_body: unknown }[];
  };

  expect(out.call.request).toEqual({ normalized: true });
  expect(out.wire).toHaveLength(1);
  expect(out.wire[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  expect(out.wire[0]?.status).toBe(200);
  expect(out.wire[0]?.request_body).toEqual({ thinking: { type: "enabled" } });
  expect(out.wire[0]?.response_body).toEqual({
    stream: "sse",
    model: "claude-x",
    content: "one wall",
    finish_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 42 },
    chunk_count: 5,
  });
});

test("without --wire the exchange keeps its metadata and drops the bodies", () => {
  const store = CallStore.openInMemory();
  const id = store.recordCall({
    call_id: "wire-2",
    ts: at(0),
    call_type: "message",
    character: "poppy",
    model: "claude-x",
    provider: "anthropic",
    usage: ZERO_USAGE,
    request_body: JSON.stringify({ normalized: true }),
    response_body: null,
  });
  store.recordHttpCall({
    call_id: "wire-2",
    seq: 0,
    ts: at(0),
    character: "poppy",
    call_type: "message",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    status_text: "OK",
    request_headers: [["content-type", "application/json"]],
    request_body: Buffer.from(`{"thinking":{"type":"enabled"}}`, "utf8"),
    response_headers: [["content-type", "text/event-stream"]],
    response_body: Buffer.from(SSE, "utf8"),
  });

  const out = callLog({ characterName: "poppy", callStore: store }, { id }) as {
    wire: Record<string, unknown>[];
  };

  const exchange = out.wire[0] as Record<string, unknown>;
  expect(exchange["url"]).toBe("https://api.anthropic.com/v1/messages");
  expect(exchange["status"]).toBe(200);
  expect(exchange["request_bytes"]).toBe(31);
  expect(exchange["response_bytes"]).toBe(SSE.length);
  expect(Object.keys(exchange)).not.toContain("request_body");
  expect(Object.keys(exchange)).not.toContain("response_body");
  expect(Object.keys(exchange)).not.toContain("request_headers");
});

test("a call with no recorded exchange dumps an empty wire list", () => {
  const store = CallStore.openInMemory();
  const id = store.recordCall({
    call_id: "wire-none",
    ts: at(0),
    call_type: "message",
    character: "poppy",
    model: "claude-x",
    provider: "anthropic",
    usage: ZERO_USAGE,
    request_body: "{}",
    response_body: null,
  });
  const out = callLog({ characterName: "poppy", callStore: store }, { id }) as { wire: unknown[] };
  expect(out.wire).toEqual([]);
});

test("ticks and the iterations inside them both read oldest-first", () => {
  const ctx: CallLogContext = { characterName: "poppy", callStore: stocked };
  const result = transcript(ctx, { count: 8 }) as {
    entries: { entry: { marker: string } }[];
  };
  expect(result.entries.map((e) => e.entry.marker)).toEqual([
    "t1-i0",
    "t1-i1",
    "t1-i2",
    "t2-i0",
    "t3-i0",
    "t3-i1",
    "t4-i1",
    "t5-i1",
  ]);
});

describe("a store that fails mid-query", () => {
  function closedStore(): CallStore {
    const store = CallStore.open(join(root, `closed-${Math.random()}.sqlite`));
    store.close();
    return store;
  }

  test("call_log reports a call-store failure", () => {
    const ctx: CallLogContext = { characterName: "poppy", callStore: closedStore() };
    expect(() => callLog(ctx, {})).toThrow(/^call store query failed: /);
    expect(() => callLog(ctx, { id: 1 })).toThrow(/^call store query failed: /);
  });

  test("transcript reports a transcript failure, not a call-store one", () => {
    const ctx: CallLogContext = { characterName: "poppy", callStore: closedStore() };
    expect(() => transcript(ctx, {})).toThrow(/^transcript query failed: /);
  });

  test("both failures are internal errors", () => {
    const ctx: CallLogContext = { characterName: "poppy", callStore: closedStore() };
    for (const run of [() => callLog(ctx, {}), () => transcript(ctx, {})]) {
      try {
        run();
        throw new Error("expected a failure");
      } catch (e) {
        expect((e as CommandError).code).toBe("internal_error");
      }
    }
  });
});
