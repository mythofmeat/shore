import { describe, expect, test } from "bun:test";

import {
  KeepaliveService,
  pingLandedCold,
  pingRewrotePrefix,
  type KeepaliveEvent,
  type KeepalivePrefix,
} from "../src/cache/keepalive.ts";
import { CacheTracker, KEEPALIVE_REWRITE_TOKENS } from "../src/cache/tracker.ts";
import type { GenerateResponse } from "../src/llm/types.ts";

function usage(read: number, write: number) {
  return {
    input_tokens: 5,
    output_tokens: 1,
    cache_read_tokens: read,
    cache_creation_tokens: write,
  };
}

function response(read: number, write: number): GenerateResponse {
  return {
    content: "",
    content_blocks: [],
    finish_reason: "max_tokens",
    usage: usage(read, write),
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    model: "claude-opus-5",
  };
}

function prefix(): KeepalivePrefix {
  return {
    sdk: "anthropic",
    provider_key: "anthropic",
    model: "claude-opus-5",
    api_key: "k",
    max_tokens: 100,
    replay_prior_thinking: "all",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    keepalive_interval_ms: 1000,
    context: { character: "Rhia", call_type: "message", thinking_enabled: false },
  } as KeepalivePrefix;
}

async function pingWith(read: number, write: number): Promise<KeepaliveEvent[]> {
  const events: KeepaliveEvent[] = [];
  let at = 0;
  const service = new KeepaliveService(
    async () => response(read, write),
    () => at,
  );
  service.onEvent((e) => events.push(e));
  service.arm(prefix(), true);

  at = 10_000;
  await service.tick();
  return events;
}

describe("pingRewrotePrefix", () => {
  test("a pure read is the ping doing its job", () => {
    expect(pingRewrotePrefix(usage(12_000, 0))).toBe(false);
  });

  test("the handful of tokens the trailing turn costs is not a rewrite", () => {
    expect(pingRewrotePrefix(usage(12_000, 40))).toBe(false);
    expect(pingRewrotePrefix(usage(12_000, KEEPALIVE_REWRITE_TOKENS - 1))).toBe(false);
  });

  test("a ten-thousand-token write is the prefix having moved", () => {
    expect(pingRewrotePrefix(usage(12_000, 10_000))).toBe(true);
    expect(pingRewrotePrefix(usage(12_000, KEEPALIVE_REWRITE_TOKENS))).toBe(true);
  });

  test("a pure write is the existing cold case, not this one", () => {
    expect(pingLandedCold(usage(0, 10_000))).toBe(true);
    expect(pingRewrotePrefix(usage(0, 10_000))).toBe(false);
  });
});

describe("a ping that rewrites is disarmed instead of repeating", () => {
  test("it reports the rewrite rather than counting as a success", async () => {
    const events = await pingWith(12_000, 10_000);
    expect(events.map((e) => e.outcome)).toEqual(["rewrote"]);
    expect(events[0]?.detail).toContain("REWROTE");
  });

  test("it does not ping again, so it cannot pay twice for a moving target", async () => {
    const events: KeepaliveEvent[] = [];
    let at = 0;
    let sends = 0;
    const service = new KeepaliveService(
      async () => {
        sends += 1;
        return response(12_000, 10_000);
      },
      () => at,
    );
    service.onEvent((e) => events.push(e));
    service.arm(prefix(), true);

    for (let tick = 1; tick <= 5; tick += 1) {
      at = tick * 10_000;
      await service.tick();
    }

    expect(sends).toBe(1);
  });

  test("a ping that only reads keeps its schedule", async () => {
    const events = await pingWith(12_000, 0);
    expect(events.map((e) => e.outcome)).toEqual(["sent"]);
  });
});

describe("the tracker gives read-and-write its own name", () => {
  test("a rewriting keepalive is an anomaly, not a plain warm call", () => {
    const tracker = new CacheTracker(3600);
    tracker.observe({
      ts: "2026-08-12T10:00:00Z",
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 40_000,
      cache_write_tokens: 0,
      call_type: "message",
    });

    const result = tracker.observe({
      ts: "2026-08-12T10:55:00Z",
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 30_000,
      cache_write_tokens: 12_000,
      call_type: "keepalive",
    });

    expect(result.anomaly).toBe("keepalive_rewrote");
  });

  test("a clean read-only ping is not flagged", () => {
    const tracker = new CacheTracker(3600);
    tracker.observe({
      ts: "2026-08-12T10:00:00Z",
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 40_000,
      cache_write_tokens: 0,
      call_type: "message",
    });

    const result = tracker.observe({
      ts: "2026-08-12T10:55:00Z",
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 40_000,
      cache_write_tokens: 0,
      call_type: "keepalive",
    });

    expect(result.anomaly).toBeUndefined();
  });
});
