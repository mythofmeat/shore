import { afterEach, describe, expect, test } from "bun:test";

import {
  cacheTtlSeconds,
  closeLedgers,
  ledgerFor,
  continuationOf,
  recordGenerate,
  recordGenerateError,
  recordingStream,
} from "../src/ledger/record.ts";
import type { CallContext, SidecarRequest, StreamEvent } from "../src/llm/types.ts";
import { freshLedger, rowsIn } from "./support/ledger_fixture.ts";

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

const call = (read: number, continuation: boolean, finish: string): StreamEvent => ({
  type: "call_complete",
  usage: usage(read, 200),
  timing: TIMING,
  finish_reason: finish,
  continuation,
});

async function* events(...list: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of list) yield e;
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const e of stream) seen.push(e);
  return seen;
}

async function withLedger(body: (path: string) => Promise<void>): Promise<void> {
  const { path, cleanup } = freshLedger();
  try {
    await body(path);
  } finally {
    closeLedgers();
    cleanup();
  }
}

describe("what a stream records", () => {
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
        recordingStream(ctx(path), REQ, events(
          call(2_000, false, "tool_use"),
          call(2_200, true, "tool_use"),
          call(2_400, true, "end_turn"),
          {
            type: "done",
            content: "done",
            finish_reason: "end_turn",
            usage: usage(2_000 + 2_200 + 2_400, 600),
            timing: TIMING,
          },
        )),
      );

      const rows = rowsIn(path);
      expect(rows.map((r) => r["cache_read_tokens"])).toEqual([2_000, 2_200, 2_400]);
      expect(rows.map((r) => r["call_type"])).toEqual(["message", "tool_loop", "tool_loop"]);
      expect(rows.some((r) => r["cache_read_tokens"] === 6_600)).toBe(false);
      expect(rows.every((r) => r["cache_anomaly"] === null)).toBe(true);
    });
  });

  test("a loop that fails partway keeps the rows it already billed", async () => {
    await withLedger(async (path) => {
      await drain(
        recordingStream(ctx(path), REQ, events(
          call(2_000, false, "tool_use"),
          call(2_200, true, "tool_use"),
          { type: "error", message: "connection reset", usage: usage(4_200, 400), timing: TIMING },
        )),
      );

      const rows = rowsIn(path);
      expect(rows.map((r) => r["cache_read_tokens"])).toEqual([2_000, 2_200, 0]);
      expect(rows.map((r) => r["finish_reason"])).toEqual(["tool_use", "tool_use", "error"]);
      expect(rows[2]!["cache_state"]).toBeNull();
      expect(rows.every((r) => r["cache_anomaly"] === null)).toBe(true);
    });
  });

  test("a loop the client abandons keeps the rows it already billed", async () => {
    await withLedger(async (path) => {
      const stream = recordingStream(ctx(path), REQ, events(
        call(2_000, false, "tool_use"),
        call(2_200, true, "tool_use"),
        { type: "done", content: "x", finish_reason: "end_turn", usage: usage(4_200, 400), timing: TIMING },
      ));
      let seen = 0;
      for await (const _e of stream) {
        seen += 1;
        if (seen === 2) break;
      }

      const rows = rowsIn(path);
      expect(rows.map((r) => r["cache_read_tokens"])).toEqual([2_000, 2_200]);
      expect(rows.some((r) => r["finish_reason"] === "cancelled")).toBe(false);
    });
  });

  test("a single-call stream is recorded from done, not double-counted", async () => {
    await withLedger(async (path) => {
      await drain(
        recordingStream(ctx(path), REQ, events(
          call(1_000, false, "end_turn"),
          { type: "done", content: "x", finish_reason: "end_turn", usage: usage(1_000, 200), timing: TIMING },
        )),
      );
      expect(rowsIn(path)).toHaveLength(1);
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
      for await (const _first of stream) break;

      const rows = rowsIn(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["finish_reason"]).toBe("cancelled");
      expect(rows[0]!["input_tokens"]).toBe(0);
      expect(rows[0]!["cache_state"]).toBeNull();
    });
  });

  test("a source that throws records a cancelled row and still throws", async () => {
    await withLedger(async (path) => {
      async function* boom(): AsyncIterable<StreamEvent> {
        yield { type: "start", model: "claude-opus-4-6" };
        throw new Error("provider exploded");
      }
      expect(drain(recordingStream(ctx(path), REQ, boom()))).rejects.toThrow(
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
      for await (const _done of stream) break;

      expect(rowsIn(path).map((r) => r["finish_reason"])).toEqual(["end_turn"]);
    });
  });

  test("the model's TTL reaches the tracker, and an unknown one does not", async () => {
    await withLedger(async (path) => {
      const done = (): StreamEvent => ({
        type: "done",
        content: "x",
        finish_reason: "end_turn",
        usage: usage(0, 1),
        timing: TIMING,
      });
      await drain(recordingStream(ctx(path, { cache_ttl: "5m" }), REQ, events(done())));
      expect(ledgerFor(path)?.cacheTtlSecs).toBe(300);

      await drain(recordingStream(ctx(path, { cache_ttl: "1h" }), REQ, events(done())));
      expect(ledgerFor(path)?.cacheTtlSecs).toBe(3600);

      await drain(recordingStream(ctx(path, { cache_ttl: "90s" }), REQ, events(done())));
      expect(ledgerFor(path)?.cacheTtlSecs).toBe(3600);
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

describe("what a non-streaming call records", () => {
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

describe("cache TTL parsed from the model's setting", () => {
  test("Anthropic's two values map to seconds", () => {
    expect(cacheTtlSeconds("5m")).toBe(300);
    expect(cacheTtlSeconds("1h")).toBe(3600);
  });

  test("an unset or unrecognised TTL leaves the default alone", () => {
    expect(cacheTtlSeconds(undefined)).toBeUndefined();
    expect(cacheTtlSeconds("90s")).toBeUndefined();
    expect(cacheTtlSeconds("")).toBeUndefined();
  });
});
