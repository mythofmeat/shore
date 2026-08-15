import { afterEach, describe, expect, test } from "bun:test";

import {
  capturedEvents,
  captureProviders,
  withCallCapture,
  type CallRecorder,
} from "../src/llm/capture.ts";
import { REDACTED } from "../src/llm/redact.ts";
import { installWireCapture, type WireExchange } from "../src/llm/wire_capture.ts";
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

let uninstallWire: (() => void) | undefined;

afterEach(() => {
  uninstallWire?.();
  uninstallWire = undefined;
});

describe("call capture", () => {
  test("a streamed call is recorded", async () => {
    const store = recorder();
    const p = withCallCapture(fake([{ type: "start", model: "m" }, DONE]), store);

    const seen = await drain(p.stream(req()));

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
    expect(row.usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_read_tokens: 33,
      cache_write_tokens: 44,
    });
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
    expect(body["api_key"]).toBe(REDACTED);
    expect(store.rows[0]!.request_body).not.toContain("sk-ant-super-secret");
    expect(body["context"]).toBeUndefined();
    expect(body["model"]).toBe("claude-opus-4-6");
  });

  test("a stream that throws still records, with what it had", async () => {
    const store = recorder();
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

  test("a tool loop that never touches the provider is still recorded", async () => {
    const store = recorder();

    const seen = await drain(
      capturedEvents(store, req(), async function* () {
        yield { type: "start", model: "m" } as StreamEvent;
        yield DONE;
      }),
    );

    expect(seen.map((e) => e.type)).toEqual(["start", "done"]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.call_type).toBe("message");
    expect(store.rows[0]!.finish_reason).toBe("end_turn");
  });

  test("a tool loop's own HTTP calls land under the loop's call id", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(`{"ok":true}`) });
    const exchanges: WireExchange[] = [];
    uninstallWire = installWireCapture((e) => exchanges.push(e));
    const store = recorder();

    await drain(
      capturedEvents(store, req(), async function* () {
        yield { type: "start", model: "m" } as StreamEvent;
        await fetch(`http://localhost:${server.port}/v1/messages`, { method: "POST", body: "{}" });
        await fetch(`http://localhost:${server.port}/v1/messages`, { method: "POST", body: "{}" });
        yield DONE;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    server.stop(true);

    expect(store.rows).toHaveLength(1);
    expect(exchanges).toHaveLength(2);
    expect(exchanges.map((e) => e.call_id)).toEqual([
      store.rows[0]!.call_id,
      store.rows[0]!.call_id,
    ]);
    expect(exchanges.map((e) => e.seq)).toEqual([0, 1]);
    expect(exchanges[0]!.character).toBe("poppy");
  });

  test("no store means the loop's events pass through untouched", async () => {
    const seen = await drain(
      capturedEvents(undefined, req(), async function* () {
        yield DONE;
      }),
    );
    expect(seen.map((e) => e.type)).toEqual(["done"]);
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
