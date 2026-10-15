import { describe, expect, test } from "bun:test";

import { KeepaliveService, prefixFingerprint, type KeepaliveEvent, type KeepalivePrefix } from "../src/cache/keepalive.ts";
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
    provider_options: { cache_ttl: "1h" },
    replay_prior_thinking: "all",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    keepalive_interval_ms: 1000,
    keepalive_pings: 100,
    context: { character: "Rhia", call_type: "message", thinking_enabled: false },
  };
}

function implicitPrefix(): KeepalivePrefix {
  return { ...prefix(), sdk: "moonshot", provider_key: "moonshotai", model: "kimi-k3" };
}

function harness(read: number, write: number) {
  const events: KeepaliveEvent[] = [];
  let at = 0;
  let sends = 0;
  const service = new KeepaliveService(
    async () => {
      sends += 1;
      return response(read, write);
    },
    () => at,
  );
  service.onEvent((e) => events.push(e));
  return {
    service,
    events,
    sends: () => sends,
    advance: (ms: number) => {
      at += ms;
      return at;
    },
  };
}

describe("a ping that would miss is not sent", () => {
  function movedPrefix(): KeepalivePrefix {
    const moved = prefix();
    moved.messages = [
      ...moved.messages,
      { role: "assistant", content: [{ type: "text", text: "a compacted summary" }] },
    ];
    return moved;
  }

  test("a prefix left behind by a compaction is skipped, not paid for", async () => {
    const h = harness(0, 12_000);
    h.service.arm(prefix(), true);
    h.advance(1);
    h.service.observe(
      "Rhia",
      "claude-opus-5",
      "compaction",
      prefixFingerprint(movedPrefix()),
    );

    h.advance(10_000);
    await h.service.tick();

    expect(h.sends()).toBe(0);
    expect(h.events.map((e) => e.outcome)).toEqual(["skipped"]);
    expect(h.events[0]?.detail).toContain("already superseded");
  });
});

describe("two misses in a row halt that model", () => {

  test("one miss alone does not halt", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold"]);
    expect(h.service.halted).toBeUndefined();
  });

  test("a second miss with nothing between stops that model's keepalives", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted?.character).toBe("Rhia");
    expect(h.service.halted?.model).toBe("anthropic:claude-opus-5");
    expect(h.service.halted?.reason).toContain("two keepalive pings in a row missed");
    expect(h.events.at(-1)?.outcome).toBe("halted");
  });

  test("once halted it sends nothing more on that model", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    const sentWhenHalted = h.sends();

    for (let i = 0; i < 5; i += 1) {
      h.service.arm(prefix(), true);
      h.advance(10_000);
      await h.service.tick();
    }
    expect(h.sends()).toBe(sentWhenHalted);
  });

  test("a real call on a halted model cannot schedule another ping before it is re-armed", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    const sentWhenHalted = h.sends();

    h.service.observe("Rhia", "claude-opus-5", "message", prefixFingerprint(prefix()), usage(0, 0));
    h.advance(10_000);
    await h.service.tick();
    expect(h.sends()).toBe(sentWhenHalted);
  });

  test("a miss on one model does not count toward the next model's halt", async () => {
    const h = harness(0, 14_144);
    const other: KeepalivePrefix = { ...prefix(), model: "claude-sonnet-5" };
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    h.service.arm(other, true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold", "cold"]);
    expect(h.service.haltFor(other)).toBeUndefined();
    expect(h.service.haltFor(prefix())).toBeUndefined();
  });
});

describe("a provider that never reports cache writes", () => {

  test("a model whose pings never read halts itself, not the models that work", async () => {
    const events: KeepaliveEvent[] = [];
    let at = 0;
    const sent: string[] = [];
    const service = new KeepaliveService(async (req) => {
      sent.push(req.model);
      return response(req.model === "kimi-k3" ? 0 : 12_000, 0);
    }, () => at);
    service.onEvent((e) => events.push(e));
    const working: KeepalivePrefix = { ...prefix(), context: { character: "Ada", call_type: "message", thinking_enabled: false } };

    for (let i = 0; i < 3; i += 1) {
      service.arm(implicitPrefix(), true);
      service.arm(working, true);
      at += 10_000;
      await service.tick();
    }

    expect(service.halted?.model).toBe("moonshotai:kimi-k3");
    expect(service.haltFor(working)).toBeUndefined();
    expect(sent.filter((model) => model === "kimi-k3")).toHaveLength(2);
    expect(sent.filter((model) => model === "claude-opus-5")).toHaveLength(3);
  });
});
