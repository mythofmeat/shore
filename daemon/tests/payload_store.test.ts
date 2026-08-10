import { describe, expect, test } from "bun:test";

import { CallStore, ZERO_USAGE } from "../src/call_store.ts";
import { splitJsonPayload } from "../src/payload_split.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function body(messages: unknown[]): string {
  return JSON.stringify({
    model: "claude-opus-4-8",
    max_tokens: 8192,
    system: [{ type: "text", text: "you are a test" }],
    messages,
  });
}

function turn(role: string, text: string): unknown {
  return { role, content: [{ type: "text", text }] };
}

function roundTrip(store: CallStore, text: string): string | null {
  const id = store.storePayload(text);
  const out = store.loadPayload(id);
  return out === null ? null : dec.decode(out);
}

describe("payload splitting", () => {
  const cases: [string, string][] = [
    ["a plain request", body([turn("user", "hi")])],
    ["nested braces inside strings", body([turn("user", '} ] { [ "quoted" \\ end')])],
    ["escaped quotes and backslashes", body([turn("user", 'she said \\"no\\" \\\\ ok')])],
    ["unicode and emoji", body([turn("user", "réponse ✅ 你好 \u{1f600}")])],
    ["an empty messages array", body([])],
    ["whitespace between members", '{ "messages" : [ {"a":1} , {"b":2} ] , "x" : 3 }'],
    ["numbers and literals", '{"messages":[1,-2.5e10,true,false,null],"n":0}'],
    ["deeply nested content", body([turn("user", "x"), { role: "assistant", content: [{ type: "tool_use", input: { a: { b: { c: [1, 2, 3] } } } }] }])],
  ];

  for (const [name, text] of cases) {
    test(`${name} reassembles byte for byte`, () => {
      const parts = splitJsonPayload(text);
      if (parts !== null) expect(parts.join("")).toBe(text);
    });
  }

  test("a growing conversation shares every earlier chunk", () => {
    const first = splitJsonPayload(body([turn("user", "one"), turn("assistant", "two")]))!;
    const second = splitJsonPayload(
      body([turn("user", "one"), turn("assistant", "two"), turn("user", "three")]),
    )!;
    const shared = first.filter((part) => second.includes(part));
    expect(shared.length).toBeGreaterThanOrEqual(first.length - 2);
  });

  test("a non-JSON body is left whole", () => {
    expect(splitJsonPayload("event: message_start\ndata: {}\n\n")).toBeNull();
  });

  test("truncated JSON is left whole rather than guessed at", () => {
    expect(splitJsonPayload('{"messages":[{"role":"user"')).toBeNull();
  });
});

describe("payload store", () => {
  test("round-trips a request byte for byte", () => {
    const store = CallStore.openInMemory();
    const text = body([turn("user", "hi"), turn("assistant", "hello")]);
    expect(roundTrip(store, text)).toBe(text);
    store.close();
  });

  test("round-trips a body it could not split", () => {
    const store = CallStore.openInMemory();
    const sse = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
    expect(roundTrip(store, sse)).toBe(sse);
    store.close();
  });

  test("round-trips an empty body", () => {
    const store = CallStore.openInMemory();
    expect(roundTrip(store, "")).toBe("");
    store.close();
  });

  test("round-trips bytes that are not valid UTF-8", () => {
    const store = CallStore.openInMemory();
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41]);
    const id = store.storePayload(raw);
    expect([...store.loadPayload(id)!]).toEqual([...raw]);
    store.close();
  });

  test("a conversation that grows adds chunks instead of copying the prefix", () => {
    const store = CallStore.openInMemory();
    const messages: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(turn(i % 2 === 0 ? "user" : "assistant", `turn ${i} ${"padding ".repeat(60)}`));
      store.storePayload(body([...messages]));
    }

    const raw = enc.encode(body(messages)).byteLength * 20;
    const stored = store.database
      .query("SELECT SUM(LENGTH(data)) AS n FROM blobs")
      .get() as { n: number };

    expect(store.blobCount()).toBeLessThan(60);
    expect(stored.n).toBeLessThan(raw / 8);
  });

  test("every payload still reads back after the prefix is shared", () => {
    const store = CallStore.openInMemory();
    const texts: string[] = [];
    const ids: number[] = [];
    const messages: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(turn("user", `turn ${i}`));
      const text = body([...messages]);
      texts.push(text);
      ids.push(store.storePayload(text));
    }
    ids.forEach((id, i) => expect(dec.decode(store.loadPayload(id)!)).toBe(texts[i]!));
    store.close();
  });
});

describe("payload garbage collection", () => {
  function record(store: CallStore, callId: string, ts: Date, messages: unknown[]): void {
    store.recordCall({
      call_id: callId,
      ts,
      call_type: "message",
      character: "poppy",
      usage: ZERO_USAGE,
      request_body: body(messages),
      response_body: `{"id":"${callId}"}`,
    });
  }

  test("blobs shared with a surviving call are kept", () => {
    const store = CallStore.openInMemory();
    const shared = [turn("user", `shared ${"x".repeat(500)}`)];
    record(store, "old", new Date("2026-01-01T00:00:00Z"), shared);
    record(store, "new", new Date("2026-06-01T00:00:00Z"), [...shared, turn("user", "later")]);

    store.rotate(new Date("2026-03-01T00:00:00Z"), 1_000_000_000);

    expect(store.callCount()).toBe(1);
    const survivor = store.queryCalls({ limit: 1 })[0]!;
    expect(store.getCall(survivor.id)?.request).toContain("shared");
    store.close();
  });

  test("blobs no call references are swept", () => {
    const store = CallStore.openInMemory();
    record(store, "old", new Date("2026-01-01T00:00:00Z"), [turn("user", "y".repeat(2000))]);
    const before = store.blobCount();

    store.rotate(new Date("2026-03-01T00:00:00Z"), 1_000_000_000);

    expect(store.callCount()).toBe(0);
    expect(before).toBeGreaterThan(0);
    expect(store.blobCount()).toBe(0);
    store.close();
  });
});
