import { expandShared } from "./support/shared_subtrees.ts";
import { describe, expect, test } from "bun:test";

import {
  Diagnostics,
  RingBuffer,
  type ErrorEntry,
  type KeyFallbackEntry,
} from "../src/diagnostics.ts";

import rawFixture from "./diagnostics_captures/diagnostics.json" with { type: "json" };
const fixture = expandShared<typeof rawFixture>(rawFixture);

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
  d.errors.push(err);
  d.key_fallbacks.push(fallback);
}

function sparse(d: Diagnostics): void {
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
  } as unknown as KeyFallbackEntry);
}

function overflowing(d: Diagnostics): void {
  for (let i = 0; i < 105; i += 1) {
    d.errors.push({
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      error_type: "llm",
      message: `failure ${i}`,
      context: "character=test",
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
      expect<unknown>(d.toJson(row.last_n)).toEqual({
        ...(row.ok as Record<string, unknown>),
      });
    });
  }
});

test("an absent optional field is omitted, not written as null", () => {
  const d = new Diagnostics();
  sparse(d);
  const fallback = d.toJson(10).key_fallbacks.recent[0] as Record<string, unknown>;
  expect(Object.keys(fallback)).not.toContain("rid");
  expect(Object.keys(fallback)).not.toContain("to_key");
  expect(Object.keys(fallback)).not.toContain("status");

  const withValues = new Diagnostics();
  full(withValues);
  const present = withValues.toJson(10).key_fallbacks.recent[0] as Record<string, unknown>;
  expect(Object.keys(present)).toContain("rid");
  expect(Object.keys(present)).toContain("to_key");
  expect(Object.keys(present)).toContain("status");
});

test("a field that is present but falsy is kept", () => {
  const d = new Diagnostics();
  d.key_fallbacks.push({
    timestamp: "2026-01-01T00:02:01Z",
    rid: "",
    provider: "openai",
    model: "gpt",
    character: "wren",
    from_key: "only",
    to_key: "",
    kind: "transport",
    status: 0,
    reason: "no response",
  });

  const row = d.toJson(10).key_fallbacks.recent[0] as Record<string, unknown>;

  expect(row["status"]).toBe(0);
  expect(row["to_key"]).toBe("");
  expect(row["rid"]).toBe("");
});
