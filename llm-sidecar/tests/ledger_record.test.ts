/**
 * The recording seam: which rows a stream leaves behind.
 *
 * These cover the ownership rule rather than the row shape (that is
 * `ledger_store.test.ts`): this side records **every call it attempted**, so a
 * loop leaves one row per provider call, a mid-stream failure leaves an `error`
 * row carrying whatever was already billed, and an abandoned stream leaves a
 * `cancelled` row. The daemon records nothing, so anything missed here is
 * missed everywhere.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  closeLedgers,
  continuationOf,
  recordGenerate,
  recordGenerateError,
  recordingStream,
} from "../src/ledger/record.ts";
import type { CallContext, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { daemonMadeLedger, haveDaemon, rowsIn } from "./support/ledger_fixture.ts";

afterEach(() => {
  closeLedgers();
});

const REQ = {
  sdk: "anthropic",
  model: "claude-opus-4-6",
  api_key: "k",
  provider_key: "anthropic",
  messages: [],
  max_tokens: 64,
  replay_prior_thinking: "all",
} as unknown as SidecarRequest;

const ctx = (path: string, over: Partial<CallContext> = {}): CallContext => ({
  ledger: path,
  character: "probe",
  call_type: "message",
  thinking_enabled: true,
  ...over,
});

const usage = (read: number, write: number) => ({
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: read,
  cache_creation_tokens: write,
});

const TIMING = { total_ms: 900, time_to_first_token_ms: 100 };

async function* events(...list: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of list) yield e;
}

/** Drain a recording stream, returning the events the daemon would have seen. */
async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const e of stream) seen.push(e);
  return seen;
}

async function withLedger(body: (path: string) => Promise<void>): Promise<void> {
  const { path, cleanup } = daemonMadeLedger();
  try {
    await body(path);
  } finally {
    closeLedgers();
    cleanup();
  }
}

describe.skipIf(!haveDaemon)("what a stream records", () => {
  test("a single-call stream records one row and passes every event through", async () => {
    await withLedger(async (path) => {
      const seen = await drain(
        recordingStream(
          ctx(path),
          REQ,
          events(
            { type: "start", model: "claude-opus-4-6" },
            { type: "text", text: "hi" },
            {
              type: "done",
              content: "hi",
              finish_reason: "end_turn",
              usage: usage(0, 2_000),
              timing: TIMING,
            },
          ),
        ),
      );

      expect(seen.map((e) => e.type)).toEqual(["start", "text", "done"]);
      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["call_type"]).toBe("message");
      expect(rows[0]!["character"]).toBe("probe");
      expect(rows[0]!["cache_write_tokens"]).toBe(2_000);
      expect(rows[0]!["finish_reason"]).toBe("end_turn");
    });
  });

  test("a loop records one row per provider call, not one summed row", async () => {
    await withLedger(async (path) => {
      await drain(
        recordingStream(ctx(path), REQ, events({
          type: "done",
          content: "done",
          finish_reason: "end_turn",
          // The sum, which is what the daemon used to store as a single row.
          usage: usage(2_000 + 2_200 + 2_400, 600),
          timing: TIMING,
          calls: [
            { usage: usage(2_000, 200), timing: TIMING, finish_reason: "tool_use", continuation: false },
            { usage: usage(2_200, 200), timing: TIMING, finish_reason: "tool_use", continuation: true },
            { usage: usage(2_400, 200), timing: TIMING, finish_reason: "end_turn", continuation: true },
          ],
        })),
      );

      const rows = rowsIn(path);
      expect(rows.map((r) => r["cache_read_tokens"])).toEqual([2_000, 2_200, 2_400]);
      // The opening call is the turn; the rest answer tool results. This is the
      // sequence the cache tracker was built to read.
      expect(rows.map((r) => r["call_type"])).toEqual(["message", "tool_loop", "tool_loop"]);
      // No row carries the sum — a summed read exceeds any single call's and
      // poisons the tracker's baseline.
      expect(rows.some((r) => r["cache_read_tokens"] === 6_600)).toBe(false);
      expect(rows.every((r) => r["cache_anomaly"] === null)).toBe(true);
    });
  });

  test("a mid-stream failure records the tokens already billed", async () => {
    await withLedger(async (path) => {
      await drain(
        recordingStream(ctx(path), REQ, events(
          { type: "start", model: "claude-opus-4-6" },
          {
            type: "error",
            message: "connection reset",
            // Anthropic reports the cache write in `message_start`, before any
            // output, and bills it whether or not the stream completes.
            usage: usage(0, 19_188),
            timing: TIMING,
          },
        )),
      );

      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["finish_reason"]).toBe("error");
      expect(rows[0]!["cache_write_tokens"]).toBe(19_188);
    });
  });

  test("a stream the client abandons records a cancelled row", async () => {
    await withLedger(async (path) => {
      const stream = recordingStream(ctx(path), REQ, events(
        { type: "start", model: "claude-opus-4-6" },
        { type: "text", text: "partial" },
        { type: "done", content: "x", finish_reason: "end_turn", usage: usage(0, 1), timing: TIMING },
      ));
      // Stop reading after the first event, as the server does when the daemon
      // disconnects: the generator's `return()` runs its `finally`.
      for await (const _first of stream) break;

      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["finish_reason"]).toBe("cancelled");
      expect(rows[0]!["input_tokens"]).toBe(0);
      // Zero usage must not reach the tracker as a cold observation.
      expect(rows[0]!["cache_state"]).toBeNull();
    });
  });

  test("a source that throws records a cancelled row and still throws", async () => {
    await withLedger(async (path) => {
      async function* boom(): AsyncIterable<StreamEvent> {
        yield { type: "start", model: "claude-opus-4-6" };
        throw new Error("provider exploded");
      }
      await expect(drain(recordingStream(ctx(path), REQ, boom()))).rejects.toThrow(
        "provider exploded",
      );
      expect(rowsIn(path).map((r) => r["finish_reason"])).toEqual(["cancelled"]);
    });
  });

  test("a completed stream records exactly once even if the client then drops", async () => {
    await withLedger(async (path) => {
      const stream = recordingStream(ctx(path), REQ, events({
        type: "done",
        content: "x",
        finish_reason: "end_turn",
        usage: usage(0, 5),
        timing: TIMING,
      }));
      // Take `done` and stop: the row is already written, and the `finally`
      // must not add a cancelled one on top.
      for await (const _done of stream) break;

      expect(rowsIn(path).map((r) => r["finish_reason"])).toEqual(["end_turn"]);
    });
  });

  test("no context → no rows, and the events still flow", async () => {
    await withLedger(async (path) => {
      const seen = await drain(
        recordingStream(undefined, REQ, events(
          { type: "start", model: "claude-opus-4-6" },
          { type: "done", content: "x", finish_reason: "end_turn", usage: usage(0, 1), timing: TIMING },
        )),
      );
      expect(seen).toHaveLength(2);
      expect(rowsIn(path)).toHaveLength(0);
    });
  });

  test("the models.toml provider key is recorded, not the SDK dialect", async () => {
    await withLedger(async (path) => {
      const routed = { ...REQ, sdk: "openrouter", provider_key: "opencode-go" } as SidecarRequest;
      await drain(
        recordingStream(ctx(path), routed, events({
          type: "done",
          content: "x",
          finish_reason: "end_turn",
          usage: usage(0, 1),
          timing: TIMING,
        })),
      );
      const row = rowsIn(path)[0]!;
      expect(row["provider"]).toBe("opencode-go");
      // Which is also what makes the subscription rule fire.
      expect(row["cost_source"]).toBe("subscription");
    });
  });

  test("an unopenable ledger does not throw into the call path", async () => {
    const seen = await drain(
      recordingStream(ctx("/nonexistent/dir/ledger.db"), REQ, events({
        type: "done",
        content: "x",
        finish_reason: "end_turn",
        usage: usage(0, 1),
        timing: TIMING,
      })),
    );
    expect(seen).toHaveLength(1);
  });
});

describe.skipIf(!haveDaemon)("what a non-streaming call records", () => {
  test("a generate records one row", async () => {
    await withLedger(async (path) => {
      recordGenerate(ctx(path, { call_type: "compaction" }), REQ, {
        content: "summary",
        content_blocks: [],
        finish_reason: "end_turn",
        usage: usage(0, 3_000),
        timing: TIMING,
        model: "claude-opus-4-6",
      });
      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["call_type"]).toBe("compaction");
      expect(rows[0]!["cache_write_tokens"]).toBe(3_000);
    });
  });

  test("a failed generate leaves the warm baseline alone", async () => {
    await withLedger(async (path) => {
      // Warm the cache, then fail a call before the provider answered. The
      // failure reports nothing, so it must not read as a cache loss — the
      // next real message would otherwise be judged against a zeroed baseline.
      recordGenerate(ctx(path), REQ, {
        content: "x",
        content_blocks: [],
        finish_reason: "end_turn",
        usage: usage(0, 40_000),
        timing: TIMING,
        model: "claude-opus-4-6",
      });
      recordGenerateError(ctx(path), REQ, Date.now());
      recordGenerate(ctx(path), REQ, {
        content: "y",
        content_blocks: [],
        finish_reason: "end_turn",
        usage: usage(40_000, 200),
        timing: TIMING,
        model: "claude-opus-4-6",
      });

      const rows = rowsIn(path);
      expect(rows.map((r) => r["cache_state"])).toEqual(["warm", null, "warm"]);
      expect(rows.every((r) => r["cache_anomaly"] === null)).toBe(true);
    });
  });

  test("a failed generate records an error row with no usage", async () => {
    await withLedger(async (path) => {
      recordGenerateError(ctx(path), REQ, Date.now() - 250);
      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["finish_reason"]).toBe("error");
      expect(rows[0]!["input_tokens"]).toBe(0);
      expect(rows[0]!["total_ms"]).toBeGreaterThanOrEqual(250);
    });
  });
});

/**
 * Pinned against `CallType::continuation` in
 * `crates/daemon/src/ledger/client.rs`, which has the same table as a test.
 * The two must agree or a delegated loop's rows stop matching the shape the
 * cache tracker expects.
 */
describe("continuation types match the Rust copy", () => {
  test.each([
    ["message", "tool_loop"],
    ["tool_loop", "tool_loop"],
    ["subagent", "tool_loop"],
    ["heartbeat", "heartbeat_tool_loop"],
    ["heartbeat_tool_loop", "heartbeat_tool_loop"],
    ["keepalive", "keepalive"],
    ["compaction", "compaction"],
    ["dreaming", "dreaming"],
    ["memory_query", "memory_query"],
  ])("%s → %s", (from, to) => {
    expect(continuationOf(from)).toBe(to);
  });
});
