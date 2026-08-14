/**
 * Recorded cases for call log.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { callLog, transcript, type CallLogContext } from "../src/commands/call_log.ts";
import { CommandError } from "../src/commands/errors.ts";
import type { ErrorCode } from "../src/protocol/ErrorCode.ts";

import fixture from "./commands_fixtures/call_log.json" with { type: "json" };

const root = mkdtempSync(join(tmpdir(), "call-log-parity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function at(secs: number): Date {
  return new Date(Date.parse("2026-01-15T12:00:00Z") + secs * 1000);
}

// ── the store ───────────────────────────────────────────────────────────────

/**
 * Calls across two characters and two call types, so every filter has both a
 * hit and a miss. `call_d` and `call_e` share a timestamp, so the ordering
 * tiebreak is load-bearing here too.
 */
function fillCalls(store: CallStore): void {
  const rows: [string, number, string, string, string, string | null][] = [
    ["call_a", 0, "message", "poppy", "request a", "response a"],
    ["call_b", 1, "heartbeat", "poppy", "request b", null],
    ["call_c", 2, "message", "wren", "request c", "response c"],
    ["call_d", 3, "heartbeat", "poppy", "request d", "response d"],
    ["call_e", 3, "heartbeat", "wren", "request e", "response e"],
  ];
  // Filler, older than every row above, so the interesting rows stay at the
  // head of a limited query. There has to be enough of it that the default
  // limit of 20 is a boundary rather than a number nothing reaches: with five
  // rows in the store, a default of 20, a default of 10 and no limit at all
  // are the same query.
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

  for (const [call_id, offset, call_type, character, request, response] of rows) {
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
      usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 },
      duration_ms: 42,
      error: null,
      request_body: request,
      response_body: response,
    });
  }
}

/**
 * Transcript rows laid out so the reordering has something to do. A tick is a
 * run of strictly increasing iterations; anything that does not increase starts
 * a new one. Ticks come back newest-first but read chronologically *within*, so
 * the display order is neither the store's order nor its reverse.
 */
function fillTranscripts(store: CallStore): void {
  const rows: [number, string, number, string][] = [
    [0, "poppy", 0, "t1-i0"],
    [1, "poppy", 1, "t1-i1"],
    [2, "poppy", 2, "t1-i2"],
    [3, "poppy", 0, "t2-i0"],
    [4, "poppy", 0, "t3-i0"],
    [5, "poppy", 1, "t3-i1"],
    [6, "wren", 0, "wren-i0"],
    // An iteration that repeats rather than increases starts a new tick.
    [7, "poppy", 1, "t4-i1"],
    [8, "poppy", 1, "t5-i1"],
  ];
  // Filler, as above: without it the default limit of 20 never bites.
  for (let i = 0; i < 20; i += 1) {
    rows.push([-1000 + i, "poppy", 0, `filler-${String(i).padStart(2, "0")}`]);
  }

  for (const [offset, character, iteration, marker] of rows) {
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

/**
 * The generator built one context per character, plus one whose client has no
 * call store at all — which is how both commands answer when the debug store is
 * switched off.
 */
function contextFor(caseName: string, character: string): CallLogContext {
  const off = caseName.startsWith("disabled");
  return { characterName: character, callStore: off ? undefined : stocked };
}

// ── the compressed sizes ────────────────────────────────────────────────────

/**
 * Drop `request_bytes`/`response_bytes` wherever they appear.
 *
 * They are the one field the two libzstd builds disagree on, and they are
 * pinned against Rust's own bytes in `call_store.test.ts` rather than
 * here. Everything else in every row still compares exactly.
 */
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

// ── replay ──────────────────────────────────────────────────────────────────

interface Case {
  case: string;
  command: "call_log" | "transcript";
  args: Record<string, unknown>;
  ok?: unknown;
  err?: { code: ErrorCode; message: string };
}

/** The generator's third harness runs as a character with nothing recorded. */
const CHARACTER_FOR = (name: string): string =>
  name === "no_rows_for_character" ? "nobody" : "poppy";

describe.each(["call_log", "transcript"])("%s", (command) => {
  for (const row of (fixture.cases as Case[]).filter((c) => c.command === command)) {
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
      expect(withoutBytes(withoutWire(run()))).toEqual(withoutBytes(row.ok));
    });
  }
});

// ── the raw HTTP exchanges ──────────────────────────────────────────────────

/**
 * `wire` is newer than the fixture: the Rust daemon recorded no raw HTTP
 * exchanges, so no frozen row can carry the key. Strip it here and pin the
 * behaviour directly below instead.
 */
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

  const out = callLog({ characterName: "poppy", callStore: store }, { id }) as {
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

// ── the reordering, restated ────────────────────────────────────────────────

/**
 * The display order the fixture pins, said out loud. Every case above compares
 * whole rows, which makes a reordering visible but not legible; this is the
 * same claim in the form the doc comment makes it.
 */
test("ticks read newest-first, iterations chronologically within each", () => {
  const ctx: CallLogContext = { characterName: "poppy", callStore: stocked };
  // Eight, which is exactly the rows the tick layout is about — the filler
  // beneath them would otherwise fill the default limit.
  const result = transcript(ctx, { count: 8 }) as {
    entries: { entry: { marker: string } }[];
  };
  expect(result.entries.map((e) => e.entry.marker)).toEqual([
    // Two single-iteration ticks, newest first…
    "t5-i1",
    "t4-i1",
    // …then a two-iteration tick read 0 → 1…
    "t3-i0",
    "t3-i1",
    // …a lone tick…
    "t2-i0",
    // …and the oldest tick's tool loop, read 0 → 1 → 2.
    "t1-i0",
    "t1-i1",
    "t1-i2",
  ]);
});

// ── the failure wording ─────────────────────────────────────────────────────

/**
 * The two commands word a store failure differently — `call store query
 * failed` and `transcript query failed` — and the fixture cannot pin that,
 * because the generator has no way to make SQLite fail on demand and the text
 * after the prefix would be Node's wording rather than Rust's either way.
 *
 * So only the prefix is asserted, read from the Rust rather than from a
 * recorded answer, and it is provoked the one way a healthy store can be made
 * to fail: by closing it underneath the command.
 */
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
