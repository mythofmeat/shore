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
      undefined,
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
    h.service.observe("Rhia", "claude-opus-5", "message", undefined, prefixFingerprint(prefix()));

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
      undefined,
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
      undefined,
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

describe("two misses in a row halt everything", () => {
  test("one miss alone does not halt", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold"]);
    expect(h.service.halted).toBeUndefined();
  });

  test("a second miss with nothing between stops all keepalives", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted?.character).toBe("Rhia");
    expect(h.service.halted?.reason).toContain("two keepalive pings in a row missed");
    expect(h.events.at(-1)?.outcome).toBe("halted");
  });

  test("once halted it sends nothing, for any character", async () => {
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

  test("a real call between the two misses is not a double miss", async () => {
    const h = harness(0, 14_144);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    h.service.observe("Rhia", "claude-opus-5", "message", undefined, prefixFingerprint(prefix()));
    h.service.arm(prefix(), true);
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
      h.service.observe("Rhia", "claude-opus-4-6", "message", undefined, "fresh-fingerprint");
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

  test("a real call between them breaks the run", () => {
    const tracker = new CacheTracker(3600);
    miss(tracker, "2026-08-12T10:00:00Z");
    tracker.observe({
      ts: "2026-08-12T10:30:00Z",
      model: "claude-opus-5",
      thinking_enabled: false,
      cache_read_tokens: 40_000,
      cache_write_tokens: 0,
      call_type: "message",
    });
    expect(miss(tracker, "2026-08-12T10:55:00Z").anomaly).toBe("cold_keepalive");
  });
});

describe("a provider that never reports cache writes", () => {
  test("reading nothing is the miss, because there is no write to look for", () => {
    expect(pingLandedCold(usage(0, 0), "moonshot")).toBe(true);
    expect(pingLandedCold(usage(0, 0), "anthropic")).toBe(false);
  });

  test("a hit still looks like a hit even with the write field empty", () => {
    expect(pingLandedCold(usage(10_240, 0), "moonshot")).toBe(false);
  });

  test("a missed ping disarms instead of scheduling another one", async () => {
    const h = harness(0, 0);
    h.service.arm(implicitPrefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold"]);
    expect(h.events[0]?.detail).toContain("read nothing");
    expect(h.service.nextPingAt("Rhia")).toBeUndefined();

    h.advance(10_000);
    await h.service.tick();
    expect(h.sends()).toBe(1);
  });

  test("a ping that reads cached tokens keeps the schedule running", async () => {
    const h = harness(10_240, 0);
    h.service.arm(implicitPrefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
    expect(h.service.nextPingAt("Rhia")).toBeDefined();
  });

  test("two empty reads in a row halt everything, with the implicit-cache reason", async () => {
    const h = harness(0, 0);
    h.service.arm(implicitPrefix(), true);
    h.advance(10_000);
    await h.service.tick();

    h.service.arm(implicitPrefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.service.halted?.character).toBe("Rhia");
    expect(h.service.halted?.reason).toContain("two keepalive pings in a row missed");
    expect(h.service.halted?.reason).toContain("the cache is implicit");
  });

  test("an anthropic prefix reading nothing with no write is still not a miss", async () => {
    const h = harness(0, 0);
    h.service.arm(prefix(), true);
    h.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
    expect(h.service.halted).toBeUndefined();
  });
});
