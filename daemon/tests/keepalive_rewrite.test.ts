import { describe, expect, test } from "bun:test";

import {
  KeepaliveService,
  pingLandedCold,
  pingRewrotePrefix,
  prefixFingerprint,
  prefixIsStale,
  type KeepaliveEvent,
  type KeepalivePrefix,
} from "../src/cache/keepalive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
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
  });

  test("a pure write is the existing cold case, not this one", () => {
    expect(pingLandedCold(usage(0, 10_000), "anthropic")).toBe(true);
    expect(pingRewrotePrefix(usage(0, 10_000))).toBe(false);
  });
});

describe("prefixFingerprint", () => {
  test("the same conversation fingerprints the same", () => {
    expect(prefixFingerprint(prefix())).toBe(prefixFingerprint(prefix()));
  });

  test("an appended turn changes it", () => {
    const grown = prefix();
    grown.messages = [
      ...grown.messages,
      { role: "assistant", content: [{ type: "text", text: "a reply" }] },
    ];
    expect(prefixFingerprint(grown)).not.toBe(prefixFingerprint(prefix()));
  });

  test("a changed system block changes it", () => {
    const rebuilt = prefix();
    rebuilt.system = [{ text: "a new memory index", label: "memory_index" }];
    expect(prefixFingerprint(rebuilt)).not.toBe(prefixFingerprint(prefix()));
  });
});

describe("prefixIsStale", () => {
  test("two different prefixes are stale", () => {
    expect(prefixIsStale({ armedFingerprint: "a", lastCallFingerprint: "b" })).toBe(true);
  });

  test("the same prefix is not", () => {
    expect(prefixIsStale({ armedFingerprint: "a", lastCallFingerprint: "a" })).toBe(false);
  });

  test("not knowing is not a reason to skip", () => {
    expect(prefixIsStale({ armedFingerprint: undefined, lastCallFingerprint: "b" })).toBe(false);
    expect(prefixIsStale({ armedFingerprint: "a", lastCallFingerprint: undefined })).toBe(false);
  });
});

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

  test("a real call on the same prefix is not mistaken for a move", async () => {
    const h = harness(12_000, 0);
    h.service.arm(prefix(), true);
    h.advance(1);
    h.service.observe("Rhia", "claude-opus-5", "message", prefixFingerprint(prefix()));

    h.advance(10_000);
    await h.service.tick();

    expect(h.sends()).toBe(1);
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });

  test("a re-arm on the moved prefix makes it sendable again", async () => {
    const h = harness(12_000, 0);
    h.service.arm(prefix(), true);
    h.advance(1);
    h.service.observe(
      "Rhia",
      "claude-opus-5",
      "compaction",
      prefixFingerprint(movedPrefix()),
    );
    h.advance(1);
    h.service.arm(movedPrefix(), true);

    h.advance(10_000);
    await h.service.tick();

    expect(h.sends()).toBe(1);
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });

  test("a call on another model leaves this prefix alone", async () => {
    const h = harness(12_000, 0);
    h.service.arm(prefix(), true);
    h.advance(1);
    h.service.observe(
      "Rhia",
      "some-other-model",
      "heartbeat",
      prefixFingerprint(movedPrefix()),
    );

    h.advance(10_000);
    await h.service.tick();

    expect(h.sends()).toBe(1);
  });
});

describe("a ping that did write keeps its schedule", () => {
  test("it reports the rewrite but stays armed, because the next ping reads it", async () => {
    const h = harness(12_000, 10_000);
    h.service.arm(prefix(), true);

    h.advance(10_000);
    await h.service.tick();
    expect(h.events.map((e) => e.outcome)).toEqual(["rewrote"]);

    h.advance(10_000);
    await h.service.tick();
    expect(h.sends()).toBe(2);
  });

  test("a read-only ping is a plain success", async () => {
    const h = harness(12_000, 0);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });
});

describe("the tracker gives read-and-write its own name", () => {
  function warmed(): CacheTracker {
    const tracker = new CacheTracker(3600);
    tracker.observe({
      ts: "2026-08-12T10:00:00Z",
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 40_000,
      cache_write_tokens: 0,
      call_type: "message",
    });
    return tracker;
  }

  test("a rewriting keepalive is an anomaly, not a plain warm call", () => {
    const result = warmed().observe({
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
    const result = warmed().observe({
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

describe("two misses in a row halt that model", () => {
  function landRealTurn(h: ReturnType<typeof harness>, read: number) {
    h.service.observe(
      "Rhia",
      "claude-opus-5",
      "message",
      prefixFingerprint(prefix()),
      usage(read, 0),
    );
    h.service.arm(prefix(), true);
  }

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

  test("the halt is reachable the way production re-arms — a landed turn, not a bare arm", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    expect(h.service.halted).toBeUndefined();

    landRealTurn(h, 0);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted?.character).toBe("Rhia");
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

  test("a halt does not carry over to the same model on a corrected SDK", async () => {
    const h = harness(0, 14_144);
    const wrongSdk: KeepalivePrefix = { ...prefix(), sdk: "openai" };
    for (let miss = 0; miss < 2; miss += 1) {
      h.service.arm(wrongSdk, true);
      h.advance(10_000);
      await h.service.tick();
    }
    expect(h.service.haltFor(wrongSdk)).toBeDefined();
    expect(h.service.haltFor(prefix())).toBeUndefined();
    h.service.arm(prefix(), true);
    expect(h.service.intervalFor("Rhia")).toBe(1000);
  });

  test("every halted model is reported, the character's own first", async () => {
    const h = harness(0, 14_144);
    const other: KeepalivePrefix = {
      ...prefix(),
      model: "claude-sonnet-5",
      context: { character: "Ada", call_type: "message", thinking_enabled: false },
    };
    for (const armed of [prefix(), other]) {
      for (let miss = 0; miss < 2; miss += 1) {
        h.service.arm(armed, true);
        h.advance(10_000);
        await h.service.tick();
      }
    }
    expect(h.service.halted?.model).toBe("anthropic:claude-sonnet-5");
    expect(h.service.haltsFor("Rhia").map((halt) => halt.model))
      .toEqual(["anthropic:claude-opus-5", "anthropic:claude-sonnet-5"]);
    expect(h.service.haltsFor("Ada").map((halt) => halt.model))
      .toEqual(["anthropic:claude-sonnet-5", "anthropic:claude-opus-5"]);
  });

  test.each(["heartbeat", "heartbeat_tool_loop"])("a %s cache read does not clear chat keepalive misses", async (callType) => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();
    expect(h.service.halted).toBeUndefined();

    h.service.observe("Rhia", "claude-opus-5", callType, "heartbeat-prefix", { cache_read_tokens: 40_000 });
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted).toBeDefined();
    expect(h.events.map((event) => event.outcome)).toEqual(["cold", "halted"]);
  });

  test("a real call that read cached tokens between the two misses is not a double miss", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    landRealTurn(h, 40_000);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted).toBeUndefined();
  });

  test("a real call that read nothing is not proof the cache is holding", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    landRealTurn(h, 0);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted).toBeDefined();
  });

  test("throwing the prefix away clears the count the misses were against", async () => {
    const h = harness(0, 14_144);
    const cache = new LastRequestCache(h.service);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    cache.invalidate("Rhia", "compaction");
    landRealTurn(h, 0);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted).toBeUndefined();
  });

  test("a ping that read resets the count", async () => {
    const events: KeepaliveEvent[] = [];
    let at = 0;
    let call = 0;
    const service = new KeepaliveService(
      async () => response(call++ === 1 ? 12_000 : 0, 14_144),
      () => at,
    );
    service.onEvent((e) => events.push(e));

    for (let i = 0; i < 3; i += 1) {
      service.arm(prefix(), true);
      at += 10_000;
      await service.tick();
    }

    expect(service.halted).toBeUndefined();
  });

  test("the halt has no runtime exit", async () => {
    const h = harness(0, 14_144);
    for (let i = 0; i < 2; i += 1) {
      h.service.arm(prefix(), true);
      h.advance(10_000);
      await h.service.tick();
    }
    expect(h.service.halted).toBeDefined();
    const halted = h.service.halted;

    for (let i = 0; i < 5; i += 1) {
      h.service.arm(prefix(), true);
      h.service.observe("Rhia", "claude-opus-4-6", "message", "fresh-fingerprint");
      h.advance(10_000);
      await h.service.tick();
    }

    expect(h.service.halted).toBe(halted);
    expect(h.sends()).toBe(2);
  });

  test("no public method clears the halt", () => {
    const service = new KeepaliveService(async () => response(0, 0), () => 0);
    const surface = new Set<string>();
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
      surface.add(name);
    }
    expect(surface.has("clearHalt")).toBe(false);
    expect([...surface].filter((n) => /clear|reset|resume|unhalt/i.test(n))).toEqual([]);
  });
});

describe("the tracker names the double miss", () => {
  function miss(tracker: CacheTracker, ts: string) {
    return tracker.observe({
      ts,
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 0,
      cache_write_tokens: 14_144,
      call_type: "keepalive",
    });
  }

  test("the first is a cold keepalive, the second is the louder finding", () => {
    const tracker = new CacheTracker(3600);
    expect(miss(tracker, "2026-08-12T10:00:00Z").anomaly).toBe("cold_keepalive");
    expect(miss(tracker, "2026-08-12T10:55:00Z").anomaly).toBe("keepalive_double_miss");
  });

  function realCall(tracker: CacheTracker, ts: string, read: number) {
    return tracker.observe({
      ts,
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: read,
      cache_write_tokens: read === 0 ? 14_144 : 0,
      call_type: "message",
    });
  }

  test("a real call that read cached tokens between them breaks the run", () => {
    const tracker = new CacheTracker(3600);
    miss(tracker, "2026-08-12T10:00:00Z");
    realCall(tracker, "2026-08-12T10:30:00Z", 40_000);
    expect(miss(tracker, "2026-08-12T10:55:00Z").anomaly).toBe("cold_keepalive");
  });

  test("a real call that read nothing does not break the run", () => {
    const tracker = new CacheTracker(3600);
    miss(tracker, "2026-08-12T10:00:00Z");
    realCall(tracker, "2026-08-12T10:30:00Z", 0);
    expect(miss(tracker, "2026-08-12T10:55:00Z").anomaly).toBe("keepalive_double_miss");
  });
});

describe("a provider that never reports cache writes", () => {
  test("reading nothing is the miss, because there is no write to look for", () => {
    expect(pingLandedCold(usage(0, 0), "moonshot")).toBe(true);
    expect(pingLandedCold(usage(0, 0), "anthropic")).toBe(true);
  });

  test("a hit still looks like a hit even with the write field empty", () => {
    expect(pingLandedCold(usage(10_240, 0), "moonshot")).toBe(false);
  });

  test("an implicit-cache provider is pinged like any other", async () => {
    const h = harness(10_240, 0);
    h.service.arm(implicitPrefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.sends()).toBe(1);
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });

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

  test("an explicit cache reading nothing with no write is disarmed", async () => {
    const h = harness(0, 0);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold"]);
    expect(h.service.nextPingAt("Rhia")).toBeUndefined();
    expect(h.service.halted).toBeUndefined();
  });
});
