import { describe, expect, test } from "bun:test";

import {
  Diagnostics,
  RingBuffer,
  type ApiCallEntry,
  type ErrorEntry,
  type KeyFallbackEntry,
  type ToolCallEntry,
} from "../src/diagnostics.ts";

import fixture from "./diagnostics_fixtures/diagnostics.json" with { type: "json" };

interface RingCase {
  case: string;
  capacity: number;
  pushes: number;
  len: number;
  is_empty: boolean;
  items: number[];
  last_n: { n: number; items: number[] }[];
}

describe("ring buffer", () => {
  for (const row of fixture.ring as RingCase[]) {
    test(row.case, () => {
      const rb = new RingBuffer<number>(row.capacity);
      for (let i = 0; i < row.pushes; i += 1) rb.push(i);
      expect(rb.length).toBe(row.len);
      expect(rb.isEmpty).toBe(row.is_empty);
      expect(rb.items()).toEqual(row.items);
      for (const { n, items } of row.last_n) {
        expect(rb.lastN(n)).toEqual(items);
      }
    });
  }
});

function full(d: Diagnostics): void {
  const api: ApiCallEntry = {
    timestamp: "2026-01-01T00:00:00Z",
    model: "test-model",
    provider: "anthropic",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 80,
    cache_write_tokens: 10,
    ttft_ms: 200,
    total_ms: 1000,
    finish_reason: "end_turn",
    total_cost_usd: 0.0123,
    error: "retried once",
  };
  const tool: ToolCallEntry = {
    timestamp: "2026-01-01T00:00:01Z",
    tool_name: "check_time",
    tool_id: "t1",
    success: true,
    duration_ms: 5,
    input_summary: "{}",
    output_summary: "2026-01-01T00:00:01Z",
  };
  const err: ErrorEntry = {
    timestamp: "2026-01-01T00:00:02Z",
    error_type: "llm",
    message: "connection refused",
    context: "character=test",
  };
  const fallback: KeyFallbackEntry = {
    timestamp: "2026-01-01T00:00:03Z",
    rid: "rid_1",
    provider: "anthropic",
    model: "claude-x",
    character: "poppy",
    from_key: "primary",
    to_key: "backup",
    kind: "quota",
    status: 429,
    reason: "rate limited",
  };
  d.api_calls.push(api);
  d.tool_calls.push(tool);
  d.errors.push(err);
  d.key_fallbacks.push(fallback);
}

function sparse(d: Diagnostics): void {
  d.api_calls.push({
    timestamp: "2026-01-01T00:01:00Z",
    model: "sparse-model",
    provider: "openai",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ttft_ms: 0,
    total_ms: 0,
    finish_reason: "",
    total_cost_usd: undefined,
    error: undefined,
  });
  d.key_fallbacks.push({
    timestamp: "2026-01-01T00:01:01Z",
    rid: undefined,
    provider: "openai",
    model: "gpt",
    character: "wren",
    from_key: "only",
    to_key: undefined,
    kind: "missing",
    status: undefined,
    reason: "no key configured",
  });
}

function overflowing(d: Diagnostics): void {
  for (let i = 0; i < 105; i += 1) {
    d.api_calls.push({
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      model: `m${i}`,
      provider: "anthropic",
      input_tokens: i,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      ttft_ms: 0,
      total_ms: 0,
      finish_reason: "end_turn",
      total_cost_usd: undefined,
      error: undefined,
    });
  }
}

const SEEDS: Record<string, (d: Diagnostics) => void> = {
  empty: () => {},
  full,
  sparse,
  mixed: (d) => {
    full(d);
    sparse(d);
  },
  overflowing,
};

interface JsonCase {
  case: string;
  seed: string;
  last_n: number;
  ok: unknown;
}

describe("toJson", () => {
  for (const row of fixture.to_json as JsonCase[]) {
    test(row.case, () => {
      const d = new Diagnostics();
      const seed = SEEDS[row.seed];
      if (seed === undefined) throw new Error(`unknown seed ${row.seed}`);
      seed(d);
      expect<unknown>(d.toJson(row.last_n)).toEqual(row.ok);
    });
  }
});

test("an absent optional field is omitted, not written as null", () => {
  const d = new Diagnostics();
  sparse(d);
  const api = d.toJson(10).api_calls.recent[0] as Record<string, unknown>;
  expect(Object.keys(api)).not.toContain("total_cost_usd");
  expect(Object.keys(api)).not.toContain("error");
  const fallback = d.toJson(10).key_fallbacks.recent[0] as Record<string, unknown>;
  expect(Object.keys(fallback)).not.toContain("rid");
  expect(Object.keys(fallback)).not.toContain("to_key");
  expect(Object.keys(fallback)).not.toContain("status");

  const withValues = new Diagnostics();
  full(withValues);
  expect(Object.keys(withValues.toJson(10).api_calls.recent[0] as object)).toContain(
    "total_cost_usd",
  );
});
