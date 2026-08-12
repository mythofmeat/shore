/**
 * Recording provider calls into the payload store.
 *
 * The bug this exists for was not a wrong row, it was *no* rows: the port
 * defined `recordCall`, opened the store, logged "call payload store enabled",
 * and never wired a caller. `calls.db` silently stopped growing at the moment
 * the TypeScript daemon took over, so `shore log` had nothing for exactly the
 * window a cache regression needed it. The first test here is the one that
 * would have caught that — everything else pins the row's shape.
 */

import { describe, expect, test } from "bun:test";

import { captureProviders, withCallCapture, type CallRecorder } from "../src/llm/capture.ts";
import { REDACTED } from "../src/llm/redact.ts";
import { CallStore, type CallRecord } from "../src/call_store.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
  Usage,
} from "../src/llm/types.ts";

const USAGE: Usage = {
  input_tokens: 11,
  output_tokens: 22,
  cache_read_tokens: 33,
  cache_creation_tokens: 44,
};

const TIMING = { total_ms: 5, time_to_first_token_ms: 1 };

function recorder(): CallRecorder & { rows: CallRecord[] } {
  const rows: CallRecord[] = [];
  return {
    rows,
    recordCall(call: CallRecord) {
      rows.push(call);
      return rows.length;
    },
  };
}

function req(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-opus-4-6",
    provider_key: "anthropic",
    api_key: "sk-ant-super-secret",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 64,
    replay_prior_thinking: "all",
    context: {
      character: "poppy",
      call_type: "message",
      thinking_enabled: true,
      rid: "r_1",
      ledger: "/data/ledger.db",
    },
    ...overrides,
  };
}

/** A provider that emits a fixed script, then optionally dies. */
function fake(events: StreamEvent[], thenThrow = false): SidecarProvider {
  return {
    async *stream() {
      for (const e of events) yield e;
      if (thenThrow) throw new Error("upstream exploded");
    },
    async generate(): Promise<GenerateResponse> {
      return {
        content: "hello",
        content_blocks: [{ type: "text", text: "hello" }],
        finish_reason: "end_turn",
        usage: USAGE,
        timing: TIMING,
        model: "claude-opus-4-6",
      };
    },
  };
}

const DONE: StreamEvent = {
  type: "done",
  content: "hello",
  finish_reason: "end_turn",
  usage: USAGE,
  timing: TIMING,
};

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("call capture", () => {
  test("a streamed call is recorded", async () => {
    const store = recorder();
    const p = withCallCapture(fake([{ type: "start", model: "m" }, DONE]), store);

    const seen = await drain(p.stream(req()));

    // The caller still gets every event — capture is a passthrough.
    expect(seen.map((e) => e.type)).toEqual(["start", "done"]);

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.character).toBe("poppy");
    expect(row.call_type).toBe("message");
    expect(row.model).toBe("claude-opus-4-6");
    expect(row.provider).toBe("anthropic");
    expect(row.rid).toBe("r_1");
    expect(row.finish_reason).toBe("end_turn");
    expect(row.error).toBeNull();
    // The store indexes three of the four counts; `cache_creation` is the
    // ledger's business, not this one's.
    expect(row.usage).toEqual({ input_tokens: 11, output_tokens: 22, cache_read_tokens: 33 });
  });

  test("the response body is NDJSON, one event per line", async () => {
    const store = recorder();
    const p = withCallCapture(fake([{ type: "start", model: "m" }, { type: "text", text: "a" }, DONE]), store);

    await drain(p.stream(req()));

    const lines = (store.rows[0]!.response_body ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["start", "text", "done"]);
  });

  test("the credential is masked and the call context is not stored", async () => {
    const store = recorder();
    const p = withCallCapture(fake([DONE]), store);

    await drain(p.stream(req()));

    const body = JSON.parse(store.rows[0]!.request_body) as Record<string, unknown>;
    // `calls.db` outlives the key and gets read by `shore log`, `shore diff`
    // and anyone the file is handed to. The field stays, so the row's shape
    // does not move and two calls made under different keys do not diff.
    expect(body["api_key"]).toBe(REDACTED);
    expect(store.rows[0]!.request_body).not.toContain("sk-ant-super-secret");
    // `context` carries the resolved `[usage]` budget config and never reaches
    // a provider; its useful fields are already the row's own columns.
    expect(body["context"]).toBeUndefined();
    expect(body["model"]).toBe("claude-opus-4-6");
  });

  test("a stream that throws still records, with what it had", async () => {
    const store = recorder();
    // Two events land, then the provider dies before the terminal `done`.
    const p = withCallCapture(
      fake(
        [
          { type: "start", model: "m" },
          { type: "call_complete", usage: USAGE, timing: TIMING, finish_reason: "tool_use", continuation: false },
        ],
        true,
      ),
      store,
    );

    await expect(drain(p.stream(req()))).rejects.toThrow("upstream exploded");

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.error).toBe("upstream exploded");
    // A partial stream is still evidence — the events that did arrive are kept,
    // and the usage already billed is not reported as zero.
    expect((row.response_body ?? "").split("\n")).toHaveLength(2);
    expect(row.usage.cache_read_tokens).toBe(33);
    expect(row.finish_reason).toBe("tool_use");
  });

  test("a mid-stream error event is recorded as an error", async () => {
    const store = recorder();
    const p = withCallCapture(
      fake([{ type: "error", message: "overloaded", usage: USAGE, timing: TIMING }]),
      store,
    );

    await drain(p.stream(req()));

    expect(store.rows[0]!.error).toBe("overloaded");
  });

  test("a non-streaming call is recorded, and a failing one too", async () => {
    const store = recorder();
    const ok = withCallCapture(fake([]), store);
    await ok.generate(req());
    expect(store.rows[0]!.finish_reason).toBe("end_turn");
    expect(store.rows[0]!.error).toBeNull();

    const boom: SidecarProvider = {
      async *stream() {},
      generate: () => Promise.reject(new Error("no key")),
    };
    const bad = withCallCapture(boom, store);
    await expect(bad.generate(req())).rejects.toThrow("no key");
    expect(store.rows[1]!.error).toBe("no key");
    expect(store.rows[1]!.usage.input_tokens).toBe(0);
  });

  test("a store that throws never breaks the call", async () => {
    const angry: CallRecorder = {
      recordCall() {
        throw new Error("disk full");
      },
    };
    const p = withCallCapture(fake([DONE]), angry);
    expect((await drain(p.stream(req()))).map((e) => e.type)).toEqual(["done"]);
    await expect(p.generate(req())).resolves.toMatchObject({ finish_reason: "end_turn" });
  });

  test("call ids are unique within a millisecond", async () => {
    const store = recorder();
    const p = withCallCapture(fake([DONE]), store);
    await Promise.all([drain(p.stream(req())), drain(p.stream(req())), drain(p.stream(req()))]);
    const ids = store.rows.map((r) => r.call_id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/^\d{8}T\d{9}-\d{4}$/);
  });

  test("no store means the provider is handed back untouched", () => {
    const inner = fake([DONE]);
    expect(withCallCapture(inner, undefined)).toBe(inner);
    const table = { anthropic: inner };
    expect(captureProviders(table, undefined)).toBe(table);
  });

  test("the row survives a real store and reads back through `shore log`", async () => {
    // The stub above pins what capture *builds*; this pins that the store
    // actually takes it. A shape the store rejects would fail only at runtime,
    // and — because capture swallows its own errors so a call never dies for a
    // diagnostic — it would fail exactly as silently as the missing wiring did.
    const store = CallStore.openInMemory();
    try {
      const p = withCallCapture(fake([{ type: "start", model: "m" }, DONE]), store);
      await drain(p.stream(req()));

      const index = store.queryCalls({ character: "poppy", limit: 10 });
      expect(index).toHaveLength(1);
      expect(index[0]!.call_type).toBe("message");
      expect(index[0]!.usage.cache_read_tokens).toBe(33);
      expect(index[0]!.request_bytes).toBeGreaterThan(0);

      const payload = store.getCall(index[0]!.id);
      expect(payload?.request).not.toContain("sk-ant-super-secret");
      expect(payload?.request).toContain(REDACTED);
      expect((payload?.response ?? "").split("\n").map((l) => JSON.parse(l).type)).toEqual([
        "start",
        "done",
      ]);
    } finally {
      store.close();
    }
  });

  test("adapters shared across sdk keys get one wrapper", () => {
    const store = recorder();
    const shared = fake([DONE]);
    const wrapped = captureProviders(
      { deepseek: shared, moonshot: shared, anthropic: fake([DONE]) },
      store,
    );
    expect(wrapped.deepseek).toBe(wrapped.moonshot);
    expect(wrapped.anthropic).not.toBe(wrapped.deepseek);
  });
});
