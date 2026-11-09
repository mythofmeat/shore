import { required } from "../src/util/required.ts";

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  KeepaliveService,
  buildKeepalivePing,
  pingLandedCold,
  prefixFingerprint,
  prefixIsStale,
  type KeepaliveEvent,
  type KeepalivePrefix,
} from "../src/cache/keepalive.ts";
import { CacheKeepalive } from "../src/cache/schedule.ts";
import { closeLedgers, setCallObserver } from "../src/ledger/record.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";
import { until } from "./support/until.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";

const MODEL = "claude-opus-4-6";
const OTHER_MODEL = "glm-4.6";
const CHARACTER = "aria";

const minutes = (m: number) => m * 60_000;
const hours = (h: number) => h * 3_600_000;

const INTERVAL_MS = 55 * 60_000;
const PINGS = 12;
const WINDOW_SECS = (PINGS * INTERVAL_MS) / 1000;

const T0 = Date.UTC(2026, 6, 30, 12, 0, 0);

function fakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function usage(read: number, write: number) {
  return {
    input_tokens: 7,
    output_tokens: 1,
    cache_read_tokens: read,
    cache_creation_tokens: write,
  };
}

function response(read: number, write: number, model = MODEL): GenerateResponse {
  return {
    content: "",
    content_blocks: [],
    finish_reason: "end_turn",
    usage: usage(read, write),
    timing: { total_ms: 120, time_to_first_token_ms: 120 },
    model,
  };
}

function prefix(overrides: Partial<KeepalivePrefix> = {}): KeepalivePrefix {
  return {
    sdk: "anthropic",
    model: MODEL,
    api_key: "sk-test",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    system: [{ text: "You are a character.", label: "character" }],
    tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
    max_tokens: 4096,
    provider_options: { cache_ttl: "1h" },
    replay_prior_thinking: "all",
    keepalive_interval_ms: INTERVAL_MS,
    keepalive_pings: PINGS,
    context: {
      character: CHARACTER,
      call_type: "message",
      thinking_enabled: true,
      keepalive_window_secs: WINDOW_SECS,
      rid: "rid_live",
    },
    ...overrides,
  };
}

function harness(replies: Array<GenerateResponse | Error> = [], otherwise = response(2200, 0)) {
  const clock = fakeClock();
  const sent: SidecarRequest[] = [];
  let n = 0;
  const service = new KeepaliveService(async (req) => {
    sent.push(req);
    const reply = replies[n++] ?? otherwise;
    if (reply instanceof Error) throw reply;
    return reply;
  }, clock.now);
  const events: KeepaliveEvent[] = [];
  service.onEvent((e) => events.push(e));
  return { service, sent, clock, events };
}

function armWarm(h: ReturnType<typeof harness>, over: Partial<KeepalivePrefix> = {}) {
  h.service.arm(prefix(over));
  h.service.observe(CHARACTER, over.model ?? MODEL, "message");
}

beforeEach(() => {
  setCallObserver(undefined);
  closeLedgers();
});

describe("the ping body", () => {
  test("differs from the cached request only where it is allowed to", () => {
    const cached = prefix();
    const ping = buildKeepalivePing(cached);

    expect(ping.model).toBe(cached.model);
    expect(ping.system).toEqual(cached.system);
    expect(ping.tools).toEqual(cached.tools);
    expect(ping.messages.slice(0, 2)).toEqual(cached.messages);
    expect(ping.sdk).toBe(cached.sdk);
    expect(ping.replay_prior_thinking).toBe(cached.replay_prior_thinking);

    expect(ping.max_tokens).toBe(1);
    expect(ping.messages).toHaveLength(3);
    expect(ping.messages[2]).toEqual({ role: "user", content: [{ type: "text", text: "." }] });
    expect(ping.context?.call_type).toBe("keepalive");
    expect(ping.context && "rid" in ping.context).toBe(false);
  });

  test("does not mutate the cached prefix", () => {
    const cached = prefix();
    buildKeepalivePing(cached);
    buildKeepalivePing(cached);
    expect(cached.messages).toHaveLength(2);
    expect(cached.max_tokens).toBe(4096);
    expect(cached.context?.call_type).toBe("message");
  });

  test("carries no cadence field onto the wire", () => {
    const cached = prefix();
    expect(cached.keepalive_interval_ms, "the fixture carries one to strip").toBeDefined();
    expect("keepalive_interval_ms" in buildKeepalivePing(cached)).toBe(false);
  });

  test("carries no cached size onto the wire", () => {
    expect("keepalive_cached_tokens" in buildKeepalivePing(prefix({ keepalive_cached_tokens: 4096 }))).toBe(false);
  });
});

describe("firing", () => {
  test("pings once the interval elapses, not before", async () => {
    const h = harness();
    armWarm(h);

    h.clock.advance(minutes(54));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);

    h.clock.advance(minutes(2));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);
    expect(required(h.sent[0]).max_tokens).toBe(1);
  });

  test("a cold ping disarms instead of retrying", async () => {
    const h = harness([response(0, 21_000)]);
    armWarm(h);

    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    h.clock.advance(hours(4));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    expect(h.events).toHaveLength(1);
    expect(required(h.events[0]).outcome).toBe("cold");
    expect(required(h.events[0]).detail).toContain("COLD");
  });

  test("read 0 with no write is a miss too", () => {
    expect(pingLandedCold(usage(0, 0), "anthropic")).toBe(true);
    expect(pingLandedCold(usage(0, 1), "anthropic")).toBe(true);
    expect(pingLandedCold(usage(2200, 200), "anthropic")).toBe(false);
  });

  test("a failed ping backs off rather than retrying every tick", async () => {
    const h = harness([new Error("connection reset")]);
    armWarm(h);

    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    h.clock.advance(30_000);
    await h.service.tick();
    expect(h.sent).toHaveLength(2);

    expect(required(h.events[0]).outcome).toBe("failed");
    expect(required(h.events[0]).detail).toContain("connection reset");
  });

  test("a slow ping is not started twice", async () => {
    const clock = fakeClock();
    let release: (() => void) | undefined;
    const sent: SidecarRequest[] = [];
    const service = new KeepaliveService(async (req) => {
      sent.push(req);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response(2200, 0);
    }, clock.now);

    service.arm(prefix());
    service.observe(CHARACTER, MODEL, "message");
    clock.advance(minutes(56));

    const first = service.tick();
    await Promise.resolve();
    await service.tick();
    expect(sent).toHaveLength(1);

    required(release)();
    await first;
  });
});

describe("a ping a budget would stop", () => {
  test("is skipped rather than sent, and says which budget stopped it", async () => {
    const ledger = freshLedger();
    const db = openLedger(ledger.path);
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, ?2, 'anthropic', 'default', ?3, 'message', 10, 5, 0, 0, 100, 10, 'end_turn', 1, 'pricing_catalog', 5.0)`,
    ).run(new Date(T0).toISOString(), CHARACTER, MODEL);
    db.close();
    const h = harness();
    const base = prefix();
    h.service.arm(prefix({
      context: {
        ...required(base.context),
        ledger: ledger.path,
        usage: { timezone: "utc", budgets: [{ name: "tiny", period: "month", cost_usd: 1, limit: "block", warn_at: [], usage_kind: [] }] },
      },
    }));
    h.service.observe(CHARACTER, MODEL, "message");

    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.events.at(-1)?.outcome).toBe("skipped");
    expect(h.events.at(-1)?.detail).toContain("tiny");
    ledger.cleanup();
  });

  test("a long reason is cut to 160 characters", async () => {
    const ledger = freshLedger();
    const db = openLedger(ledger.path);
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, ?2, 'anthropic', 'default', ?3, 'message', 10, 5, 0, 0, 100, 10, 'end_turn', 1, 'pricing_catalog', 5.0)`,
    ).run(new Date(T0).toISOString(), CHARACTER, MODEL);
    db.close();
    const h = harness();
    const base = prefix();
    h.service.arm(prefix({
      context: {
        ...required(base.context),
        ledger: ledger.path,
        usage: { timezone: "utc", budgets: [{ name: "b".repeat(200), period: "month", cost_usd: 1, limit: "block", warn_at: [], usage_kind: [] }] },
      },
    }));
    h.service.observe(CHARACTER, MODEL, "message");
    h.clock.advance(minutes(56));
    await h.service.tick();
    const detail = required(h.events.at(-1)?.detail);
    expect(detail.startsWith("Cache keepalive ping skipped: ")).toBe(true);
    expect(detail.length).toBe("Cache keepalive ping skipped: ".length + 161);
    expect(detail.endsWith("…")).toBe(true);
    ledger.cleanup();
  });
});

describe("what counts as a warm", () => {

  test("a keepalive ping does not count as activity", async () => {
    const h = harness();
    armWarm(h);
    const before = required(h.service.scheduleFor(CHARACTER)).last_active_at;

    h.clock.advance(minutes(56));
    h.service.observe(CHARACTER, MODEL, "keepalive");

    expect(required(h.service.scheduleFor(CHARACTER)).last_active_at).toBe(before);
  });

  test("a dream on the chat model is not a warm of the chat's prefix, so the ping still goes out", async () => {
    const h = harness();
    armWarm(h);
    const before = required(h.service.scheduleFor(CHARACTER));

    h.clock.advance(minutes(50));
    h.service.observe(CHARACTER, MODEL, "dreaming");
    const after = required(h.service.scheduleFor(CHARACTER));
    expect(after.last_warm_at).toBe(before.last_warm_at);
    expect(after.last_active_at).toBe(before.last_active_at);

    h.clock.advance(minutes(6));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);
  });

  test("pinging stops after the idle ceiling", async () => {
    const h = harness();
    armWarm(h);

    for (let i = 0; i < 20; i++) {
      h.clock.advance(minutes(56));
      await h.service.tick();
    }

    const sentByCeiling = h.sent.length;
    expect(sentByCeiling).toBeGreaterThan(0);
    expect(sentByCeiling).toBeLessThan(20);

    h.clock.advance(hours(24));
    await h.service.tick();
    expect(h.sent).toHaveLength(sentByCeiling);
  });

  test("a compaction on the chat model does not hand out a fresh ping allowance", async () => {
    const h = harness();
    h.service.arm(prefix({ keepalive_pings: 1 }));
    h.service.observe(CHARACTER, MODEL, "message");
    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    h.service.observe(CHARACTER, MODEL, "compaction");
    for (let i = 0; i < 4; i++) {
      h.clock.advance(minutes(56));
      await h.service.tick();
    }
    expect(h.sent).toHaveLength(1);

    h.service.observe(CHARACTER, MODEL, "tool_loop");
    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(2);
  });
});

describe("arming and disarming", () => {
  test("keepalive off disarms rather than leaving the old cadence", async () => {
    const h = harness();
    armWarm(h);
    const off = prefix();
    delete off.keepalive_interval_ms;
    h.service.arm(off);

    h.clock.advance(hours(4));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
  });

  test("a model switch pauses until the new prefix is warmed", async () => {
    const h = harness();
    armWarm(h);
    h.service.arm(prefix({ model: OTHER_MODEL }));

    h.clock.advance(hours(2));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);

    h.service.observe(CHARACTER, OTHER_MODEL, "message");
    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);
    expect(required(h.sent[0]).model).toBe(OTHER_MODEL);
  });
});

describe("only the selected chat model is kept warm", () => {
  function switchTo(h: ReturnType<typeof harness>, model: string) {
    h.service.disarm(CHARACTER);
    h.service.arm(prefix({ model }));
  }

  test("switching away stops the old model's pings before any message", async () => {
    const h = harness();
    armWarm(h);

    h.clock.advance(minutes(10));
    switchTo(h, OTHER_MODEL);
    for (let i = 0; i < 6; i += 1) {
      h.clock.advance(INTERVAL_MS);
      await h.service.tick();
    }

    expect(h.sent).toHaveLength(0);
  });

  test("switching back without a message does not resume the old model's pings", async () => {
    const h = harness();
    armWarm(h);

    h.clock.advance(minutes(10));
    switchTo(h, OTHER_MODEL);
    h.clock.advance(minutes(10));
    switchTo(h, MODEL);
    h.clock.advance(hours(3));
    await h.service.tick();

    expect(h.sent).toHaveLength(0);
  });

  test("the first message on the new model arms it, and only it", async () => {
    const h = harness();
    armWarm(h);

    h.clock.advance(minutes(10));
    switchTo(h, OTHER_MODEL);
    h.clock.advance(minutes(10));
    h.service.observe(CHARACTER, OTHER_MODEL, "message");
    h.service.arm(prefix({ model: OTHER_MODEL }), true);
    h.clock.advance(INTERVAL_MS);
    await h.service.tick();

    expect(h.sent.map((req) => req.model)).toEqual([OTHER_MODEL]);
  });
});

function rhia(): KeepalivePrefix {
  return prefix({
    provider_key: "anthropic",
    model: "claude-opus-5",
    keepalive_interval_ms: 1000,
    keepalive_pings: 100,
    context: { character: "Rhia", call_type: "message", thinking_enabled: false },
  });
}

describe("a ping that would miss is not sent", () => {
  function movedPrefix(): KeepalivePrefix {
    const moved = rhia();
    moved.messages = [
      ...moved.messages,
      { role: "assistant", content: [{ type: "text", text: "a compacted summary" }] },
    ];
    return moved;
  }

  test("a prefix left behind by a compaction is skipped, not paid for", async () => {
    const h = harness([], response(0, 12_000, "claude-opus-5"));
    h.service.arm(rhia(), true);
    h.clock.advance(1);
    h.service.observe(
      "Rhia",
      "claude-opus-5",
      "compaction",
      prefixFingerprint(movedPrefix()),
    );

    h.clock.advance(10_000);
    await h.service.tick();

    expect(h.sent.length).toBe(0);
    expect(h.events.map((e) => e.outcome)).toEqual(["skipped"]);
    expect(h.events[0]?.detail).toContain("already superseded");
  });
});

describe("two misses in a row halt that model", () => {

  test("one miss alone does not halt", async () => {
    const h = harness([], response(0, 14_144, "claude-opus-5"));
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold"]);
    expect(h.service.halted).toBeUndefined();
  });

  test("a second miss with nothing between stops that model's keepalives", async () => {
    const h = harness([], response(0, 14_144, "claude-opus-5"));
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();

    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();

    expect(h.service.halted?.character).toBe("Rhia");
    expect(h.service.halted?.model).toBe("anthropic:claude-opus-5");
    expect(h.service.halted?.reason).toContain("two keepalive pings in a row missed");
    expect(h.events.at(-1)?.outcome).toBe("halted");
  });

  test("once halted it sends nothing more on that model", async () => {
    const h = harness([], response(0, 14_144, "claude-opus-5"));
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();
    const sentWhenHalted = h.sent.length;

    for (let i = 0; i < 5; i += 1) {
      h.service.arm(rhia(), true);
      h.clock.advance(10_000);
      await h.service.tick();
    }
    expect(h.sent.length).toBe(sentWhenHalted);
  });

  test("a real call on a halted model cannot schedule another ping before it is re-armed", async () => {
    const h = harness([], response(0, 14_144, "claude-opus-5"));
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();
    const sentWhenHalted = h.sent.length;

    h.service.observe("Rhia", "claude-opus-5", "message", prefixFingerprint(rhia()), usage(0, 0));
    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.sent.length).toBe(sentWhenHalted);
  });

  test("a miss on one model does not count toward the next model's halt", async () => {
    const h = harness([], response(0, 14_144, "claude-opus-5"));
    const other: KeepalivePrefix = { ...rhia(), model: "claude-sonnet-5" };
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();

    h.service.arm(other, true);
    h.clock.advance(10_000);
    await h.service.tick();

    expect(h.events.map((e) => e.outcome)).toEqual(["cold", "cold"]);
    expect(h.service.haltFor(other)).toBeUndefined();
    expect(h.service.haltFor(rhia())).toBeUndefined();
  });
});

describe("a provider that never reports cache writes", () => {

  test("a model whose pings never read halts itself, not the models that work", async () => {
    const events: KeepaliveEvent[] = [];
    let at = 0;
    const sent: string[] = [];
    const service = new KeepaliveService(async (req) => {
      sent.push(req.model);
      return response(req.model === "kimi-k3" ? 0 : 12_000, 0, req.model);
    }, () => at);
    service.onEvent((e) => events.push(e));
    const working: KeepalivePrefix = { ...rhia(), context: { character: "Ada", call_type: "message", thinking_enabled: false } };

    for (let i = 0; i < 3; i += 1) {
      service.arm({ ...rhia(), sdk: "moonshot", provider_key: "moonshotai", model: "kimi-k3" }, true);
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

const START = minutes(1000);
const ENOUGH_PINGS = 12;

describe("the cadence a turn arms", () => {
  test("off interval never pings", () => {
    const ka = new CacheKeepalive(ENOUGH_PINGS);
    ka.onCacheWarmed(MODEL, START);
    expect(ka.tick(START + hours(2))).toBe("none");
    ka.setInterval(undefined, MODEL, START);
    expect(ka.tick(START + hours(2))).toBe("none");
  });
});

describe("the ping count", () => {
  test("each successful ping spends one, and a spent count stops the schedule", () => {
    const ka = new CacheKeepalive(2);
    ka.setInterval(minutes(55), MODEL, START);
    ka.onCacheWarmed(MODEL, START);

    expect(ka.tick(START + minutes(55))).toBe("ping");
    ka.onPingSucceeded(START + minutes(55));
    expect(ka.tick(START + minutes(110))).toBe("ping");
    ka.onPingSucceeded(START + minutes(110));
    expect(ka.tick(START + minutes(165))).toBe("none");
    expect(ka.tick(START + minutes(166))).toBe("none");
  });

  test("the last allowed ping leaves no next ping scheduled", () => {
    const ka = new CacheKeepalive(1);
    ka.setInterval(minutes(55), MODEL, START);
    ka.onCacheWarmed(MODEL, START);
    ka.onPingSucceeded(START + minutes(55));
    expect(ka.nextPingAt).toBeUndefined();

    const restored = new CacheKeepalive(1);
    expect(restored.restore(required(ka.snapshot()), START + minutes(60))).toBe(true);
    expect(restored.nextPingAt).toBeUndefined();
  });

  test("real activity gives the count back and resumes", () => {
    const ka = new CacheKeepalive(1);
    ka.setInterval(minutes(55), MODEL, START);
    ka.onCacheWarmed(MODEL, START);
    expect(ka.tick(START + minutes(55))).toBe("ping");
    ka.onPingSucceeded(START + minutes(55));
    expect(ka.tick(START + minutes(110))).toBe("none");

    ka.onCacheWarmed(MODEL, START + minutes(115));
    ka.onPrefixWarmed(START + minutes(115));
    expect(ka.tick(START + minutes(120))).toBe("none");
    expect(ka.tick(START + minutes(170))).toBe("ping");
  });
});

describe("the keepalive schedule", () => {
  const MIN = 60_000;
  const armed = (interval = 55 * MIN, maxPings = 10): CacheKeepalive => {
    const schedule = new CacheKeepalive(maxPings);
    schedule.setInterval(interval, "chat.m", 0);
    schedule.onCacheWarmed("chat.m", 0);
    return schedule;
  };

  test("a failed ping retries after 30 s, doubling each time up to 15 minutes, and a success starts over", () => {
    const schedule = armed();
    const delays: number[] = [];
    let now = 1000;
    for (let failure = 0; failure < 7; failure += 1) {
      schedule.onPingFailed(now);
      delays.push((schedule.nextPingAt ?? 0) - now);
      now += 1000;
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    schedule.onPingSucceeded(now);
    schedule.onPingFailed(now + 1000);
    expect((schedule.nextPingAt ?? 0) - (now + 1000)).toBe(30_000);
  });

  test("a failed ping gives up once the warm it was keeping is past the interval plus five minutes", () => {
    const schedule = armed(10 * MIN);
    schedule.onPingFailed(15 * MIN - 1);
    expect(schedule.nextPingAt).toBe(15 * MIN - 1 + 30_000);
    const epoch = schedule.epoch;
    schedule.onPingFailed(15 * MIN);
    expect(schedule.nextPingAt).toBeUndefined();
    expect(schedule.epoch).toBe(epoch + 1);
    expect(schedule.snapshot()).toBeUndefined();

    const never = new CacheKeepalive(10);
    never.setInterval(10 * MIN, "chat.m", 0);
    never.onPingFailed(0);
    expect(never.nextPingAt).toBeUndefined();
    const unarmed = new CacheKeepalive(10);
    unarmed.onCacheWarmed("chat.m", 0);
    unarmed.onPingFailed(1);
    expect(unarmed.nextPingAt).toBeUndefined();
  });

  test("setting the same interval again leaves the next ping where it was; a new one reschedules from the last activity", () => {
    const schedule = armed(10 * MIN);
    schedule.onPingSucceeded(4 * MIN);
    expect(schedule.nextPingAt).toBe(14 * MIN);
    schedule.setInterval(10 * MIN, "chat.m", 5 * MIN);
    expect(schedule.nextPingAt).toBe(14 * MIN);
    schedule.setInterval(20 * MIN, "chat.m", 5 * MIN);
    expect(schedule.nextPingAt).toBe(20 * MIN);
    schedule.setInterval(undefined, "chat.m", 6 * MIN);
    expect(schedule.nextPingAt).toBeUndefined();
    expect(schedule.tick(60 * MIN)).toBe("none");

    const fresh = new CacheKeepalive(10);
    fresh.setInterval(10 * MIN, "chat.m", 0);
    expect(fresh.nextPingAt).toBeUndefined();
  });

  test("a new model or prompt identity starts over, and leaving the identity out changes nothing", () => {
    const schedule = new CacheKeepalive(10);
    schedule.setInterval(10 * MIN, "chat.m", 0, "key-a");
    schedule.onCacheWarmed("chat.m", 0);
    const epoch = schedule.epoch;
    schedule.setInterval(10 * MIN, "chat.m", 1, undefined);
    expect(schedule.epoch).toBe(epoch);
    expect(schedule.nextPingAt).toBe(10 * MIN);
    schedule.setInterval(10 * MIN, "chat.m", 2, "key-b");
    expect(schedule.epoch).toBe(epoch + 1);
    expect(schedule.nextPingAt).toBeUndefined();
    expect(schedule.snapshot()).toBeUndefined();
  });

  test("a warm of another model is ignored, and a new reply resets the pings and starts a new epoch", () => {
    const schedule = armed(10 * MIN, 2);
    const epoch = schedule.epoch;
    schedule.onCacheWarmed("chat.other", 5 * MIN);
    expect(schedule.nextPingAt).toBe(10 * MIN);
    expect(schedule.epoch).toBe(epoch);
    schedule.onPingSucceeded(10 * MIN);
    schedule.onCacheWarmed("chat.m", 12 * MIN, false);
    expect(schedule.pingsSent).toBe(1);
    expect(schedule.epoch).toBe(epoch);
    schedule.onCacheWarmed("chat.m", 13 * MIN);
    expect(schedule.pingsSent).toBe(0);
    expect(schedule.epoch).toBe(epoch + 1);
    expect(schedule.nextPingAt).toBe(20 * MIN);
  });

  test("invalidating forgets the warm, the failures and the pings, and opens a new epoch", () => {
    const schedule = armed(10 * MIN, 5);
    schedule.onPingSucceeded(10 * MIN);
    schedule.onPingFailed(12 * MIN);
    const epoch = schedule.epoch;
    schedule.onCacheInvalidated();
    expect(schedule.epoch).toBe(epoch + 1);
    expect(schedule.pingsSent).toBe(0);
    expect(schedule.nextPingAt).toBeUndefined();
    expect(schedule.snapshot()).toBeUndefined();
    schedule.onCacheWarmed("chat.m", 20 * MIN, false);
    schedule.onPingFailed(21 * MIN);
    expect((schedule.nextPingAt ?? 0) - 21 * MIN).toBe(30_000);
  });

  test("the ping allowance is checked when a ping is due, so lowering it stops the next one", () => {
    const schedule = armed(10 * MIN, 3);
    schedule.onPingSucceeded(10 * MIN);
    expect(schedule.tick(20 * MIN)).toBe("ping");
    schedule.setMaxPings(1);
    expect(schedule.tick(20 * MIN)).toBe("none");
    expect(schedule.nextPingAt).toBeUndefined();
    const exact = armed(10 * MIN, 2);
    exact.onPingSucceeded(10 * MIN);
    expect(exact.tick(20 * MIN)).toBe("ping");
  });
});

describe("keepalive edges", () => {
  const OPUS = "claude-opus-5";
  const named = (character: string, over: Partial<KeepalivePrefix> = {}): KeepalivePrefix => ({ ...rhia(), ...over, context: { character, call_type: "message", thinking_enabled: false } });

  test("a prefix is stale only when both fingerprints are known and differ", () => {
    expect(prefixIsStale({ armedFingerprint: undefined, lastCallFingerprint: "b" })).toBe(false);
    expect(prefixIsStale({ armedFingerprint: "a", lastCallFingerprint: undefined })).toBe(false);
    expect(prefixIsStale({ armedFingerprint: "a", lastCallFingerprint: "a" })).toBe(false);
    expect(prefixIsStale({ armedFingerprint: "a", lastCallFingerprint: "b" })).toBe(true);
  });

  test("a ping keeps the cached request's window unless its labels name another", () => {
    expect(buildKeepalivePing(prefix()).context?.keepalive_window_secs).toBe(WINDOW_SECS);
    expect(buildKeepalivePing(prefix(), { windowSecs: 99 }).context?.keepalive_window_secs).toBe(99);
  });

  test("a halt gives its evidence and clears the schedule of everyone pinging that model, but no one else's", async () => {
    let at = T0;
    const events: KeepaliveEvent[] = [];
    const service = new KeepaliveService(async (req) => response(req.model === OPUS ? 0 : 12_000, req.model === OPUS ? 14_144 : 0, req.model), () => at);
    service.onEvent((e) => events.push(e));
    service.arm(named("Bea", { keepalive_interval_ms: 60_000 }), true);
    service.arm(named("Cy", { model: "claude-sonnet-5", keepalive_interval_ms: 60_000 }), true);
    for (let i = 0; i < 2; i += 1) {
      service.arm(rhia(), true);
      at += 10_000;
      await service.tick();
    }
    const reason = "two keepalive pings in a row missed with nothing in between. Neither read any cached tokens on anthropic; the latest wrote 14144 tokens. " +
      "There is no evidence that the prefix is being reused, so every further ping would pay full price for nothing. Keepalives for anthropic:claude-opus-5 " +
      "are stopped for the life of this daemon; nothing resumes them, because nothing that causes this is fixable at runtime";
    expect(service.halted?.reason).toBe(reason);
    expect(events.at(-1)).toEqual({ character: "Rhia", outcome: "halted", detail: `Cache keepalive HALTED: ${reason}`, at });
    expect(service.nextPingAt("Bea")).toBeUndefined();
    expect(service.nextPingAt("Cy")).toBe(T0 + 60_000);
  });

  test("a prefix with no character arms nothing", async () => {
    const h = harness();
    const nameless: KeepalivePrefix = rhia();
    delete (nameless.context as { character?: string }).character;
    h.service.arm(nameless, true);
    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
  });

  test("re-arming forgets the last call's prefix, so the next ping goes out", async () => {
    const h = harness();
    h.service.arm(rhia(), true);
    h.service.observe("Rhia", OPUS, "message", "a different prefix");
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });

  test("a call on another model is not this prefix's last call, so it doesn't make the ping stale", async () => {
    const h = harness();
    h.service.arm(rhia(), true);
    h.service.observe("Rhia", "claude-sonnet-5", "message", "a different prefix");
    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });

  test("a call on another model, or through another provider, says nothing about this prefix", async () => {
    const h = harness();
    h.service.arm(rhia(), true);
    h.service.observe("Rhia", OPUS, "message");
    const activeAt = h.clock.now();
    h.clock.advance(500);
    h.service.observe("Rhia", "claude-sonnet-5", "message", "a different prefix");
    h.service.observe("Rhia", OPUS, "message", undefined, undefined, { sdk: "openai", model: OPUS, provider_key: "elsewhere" });
    expect(h.service.scheduleFor("Rhia")?.last_active_at).toBe(activeAt);
    h.service.observe("Rhia", OPUS, "message", undefined, undefined, { sdk: "anthropic", model: OPUS, provider_key: "anthropic" });
    expect(h.service.scheduleFor("Rhia")?.last_active_at).toBe(h.clock.now());
    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.events.map((e) => e.outcome)).toEqual(["sent"]);
  });

  test("a real call that read from the missed model forgives the miss; one that read nothing does not", async () => {
    for (const [read, halts] of [[1, false], [0, true]] as const) {
      const h = harness([], response(0, 14_144, OPUS));
      h.service.arm(rhia(), true);
      h.clock.advance(10_000);
      await h.service.tick();
      h.service.observe("Rhia", OPUS, "message", undefined, usage(read, 0));
      h.service.arm(rhia(), true);
      h.clock.advance(10_000);
      await h.service.tick();
      expect(h.service.halted !== undefined, `a real call reading ${String(read)}`).toBe(halts);
    }
  });

  test("a heartbeat that refreshed the prefix moves the next ping without counting as activity", async () => {
    const h = harness();
    h.service.arm({ ...rhia(), keepalive_interval_ms: 60_000, keepalive_cached_tokens: 1000 }, true);
    h.service.observe("Rhia", OPUS, "message");
    const armedAt = h.clock.now();
    h.clock.advance(30_000);
    h.service.observe("Rhia", OPUS, "heartbeat", undefined, usage(1000, 0), { sdk: "anthropic", model: OPUS, provider_key: "anthropic" });
    expect(h.service.nextPingAt("Rhia")).toBe(h.clock.now() + 60_000);
    expect(h.service.scheduleFor("Rhia")?.last_active_at).toBe(armedAt);
  });

  test("a restored schedule with no cached request yet skips its ping and backs off", async () => {
    const h = harness();
    expect(h.service.restore("Rhia", { model: OPUS, interval: 60_000, last_warm_at: T0, last_active_at: T0 })).toBe(true);
    h.clock.advance(61_000);
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.events).toEqual([{ character: "Rhia", outcome: "skipped", detail: "Cache keepalive ping skipped: no cached request", at: T0 + 61_000 }]);
    expect(h.service.nextPingAt("Rhia")).toBe(T0 + 61_000 + 30_000);
  });

  test("a schedule restored for a halted model is cleared when it comes due, without a ping", async () => {
    let at = T0;
    const sent: string[] = [];
    const service = new KeepaliveService(async (req) => {
      sent.push(req.context?.character ?? "");
      return response(0, 14_144, OPUS);
    }, () => at);
    for (let i = 0; i < 2; i += 1) {
      service.arm(rhia(), true);
      at += 10_000;
      await service.tick();
    }
    service.arm(named("Bea"), true);
    expect(service.restore("Bea", { model: OPUS, interval: 60_000, last_warm_at: at, last_active_at: at })).toBe(true);
    at += 61_000;
    await service.tick();
    expect(sent.filter((character) => character === "Bea")).toEqual([]);
    expect(service.nextPingAt("Bea")).toBeUndefined();
  });

  test("a ping that lands after its schedule was reset changes nothing and says nothing", async () => {
    for (const fails of [false, true]) {
      let at = T0;
      const events: KeepaliveEvent[] = [];
      let sending!: () => void;
      const sent = new Promise<void>((resolve) => { sending = resolve; });
      let land!: () => void;
      const landed = new Promise<void>((resolve) => { land = resolve; });
      const service = new KeepaliveService(async () => {
        sending();
        await landed;
        if (fails) throw new Error("provider unavailable");
        return response(2200, 0, OPUS);
      }, () => at);
      service.onEvent((e) => events.push(e));
      service.arm(rhia(), true);
      at += 10_000;
      const ticking = service.tick();
      await sent;
      service.disarm("Rhia");
      land();
      await ticking;
      expect(events, fails ? "a failure" : "a success").toEqual([]);
      expect(service.nextPingAt("Rhia")).toBeUndefined();
    }
  });

  test("each outcome says exactly what happened", async () => {
    const said = async (reply: GenerateResponse | Error): Promise<KeepaliveEvent[]> => {
      const h = harness([reply]);
      h.service.arm(rhia(), true);
      h.clock.advance(10_000);
      await h.service.tick();
      return h.events;
    };
    const at = T0 + 10_000;
    expect(await said(response(2200, 0, OPUS))).toEqual([{ character: "Rhia", outcome: "sent", detail: "Cache refresh ping (cache_read: 2200, input: 7)", at }]);
    expect(await said(response(2200, 1500, OPUS))).toEqual([{ character: "Rhia", outcome: "rewrote", detail: "Cache refresh ping rewrote the prefix — it had moved under the ping (cache_read: 2200, cache_write: 1500); the entry it just wrote is what the next ping reads", at }]);
    expect(await said(response(0, 0, OPUS))).toEqual([{ character: "Rhia", outcome: "cold", detail: "Cache refresh ping (COLD — read nothing, disarmed; cache_read: 0, input: 7)", at }]);
    expect(await said(response(0, 1, OPUS))).toEqual([{ character: "Rhia", outcome: "cold", detail: "Cache refresh ping (COLD — wrote cache, disarmed; cache_read: 0, input: 7)", at }]);
    const long = "x".repeat(200);
    expect(await said(new Error(long))).toEqual([{ character: "Rhia", outcome: "failed", detail: `Cache keepalive ping failed: Error: ${"x".repeat(153)}…`, at }]);
  });

  test("a rewrite, like any landed ping, schedules the next one a full interval on", async () => {
    const h = harness([response(2200, 1500, OPUS)]);
    h.service.arm(rhia(), true);
    h.clock.advance(10_000);
    await h.service.tick();
    expect(h.service.nextPingAt("Rhia")).toBe(h.clock.now() + 1000);
  });

  test("a warm ping between two misses means the second is not a second in a row", async () => {
    const h = harness([response(0, 14_144, OPUS), response(2200, 0, OPUS), response(0, 14_144, OPUS)]);
    for (let i = 0; i < 3; i += 1) {
      h.service.arm(rhia(), true);
      h.clock.advance(10_000);
      await h.service.tick();
    }
    expect(h.events.map((e) => e.outcome)).toEqual(["cold", "sent", "cold"]);
    expect(h.service.halted).toBeUndefined();
  });

  test("a sent or failed ping is written to the ledger as a keepalive, with its attempt settled", async () => {
    for (const reply of [response(2200, 0, MODEL), new Error("provider unavailable")]) {
      const ledger = freshLedger();
      const h = harness([reply]);
      const base = prefix();
      h.service.arm(prefix({ context: { ...required(base.context), ledger: ledger.path } }));
      h.service.observe(CHARACTER, MODEL, "message");
      h.clock.advance(minutes(56));
      await h.service.tick();
      const db = openLedger(ledger.path, { readonly: true });
      try {
        expect(db.query("SELECT call_type, finish_reason FROM calls").all()).toEqual([{ call_type: "keepalive", finish_reason: reply instanceof Error ? "error" : "end_turn" }]);
        expect(db.query("SELECT call_type, status FROM call_attempts").all()).toEqual([{ call_type: "keepalive", status: reply instanceof Error ? "error" : "completed" }]);
      } finally {
        db.close();
        ledger.cleanup();
      }
    }
  });
});

describe("a ping's cost", () => {
  const OPENROUTER_CATALOG = "https://openrouter.ai/api/v1/models";
  const OPUS_4_6 = { id: "anthropic/claude-opus-4.6", pricing: { prompt: "0.000005", completion: "0.000025", input_cache_read: "0.0000005", input_cache_write: "0.00000625" } };

  test("is recorded from the price list even when the list arrives after the reply, for a sent or a failed ping, on schedule or on demand", async () => {
    for (const reply of [response(2200, 0, MODEL), new Error("provider unavailable")]) {
      for (const how of ["tick", "now"] as const) {
        const ledger = freshLedger();
        const catalog = Promise.withResolvers<Response>();
        const fetched: string[] = [];
        const realFetch = globalThis.fetch;
        const fetching = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString();
          fetched.push(url);
          return url === OPENROUTER_CATALOG ? await catalog.promise : await realFetch(input, init);
        }) as typeof fetch);
        try {
          const h = harness([reply]);
          const base = prefix();
          h.service.arm(prefix({ context: { ...required(base.context), ledger: ledger.path } }));
          h.service.observe(CHARACTER, MODEL, "message");
          h.clock.advance(minutes(56));
          const pinging = how === "tick" ? h.service.tick() : h.service.pingNow(CHARACTER);
          await until(() => h.sent.length === 1 && fetched.includes(OPENROUTER_CATALOG), "the ping and the price list request");
          catalog.resolve(Response.json({ data: [OPUS_4_6] }));
          await pinging;
          const db = openLedger(ledger.path, { readonly: true });
          try {
            const label = `${how}, ${reply instanceof Error ? "failed" : "sent"}`;
            const [row, ...others] = db.query("SELECT total_cost FROM calls WHERE call_type = 'keepalive'").all() as { total_cost: number | null }[];
            expect(others, label).toEqual([]);
            if (reply instanceof Error) expect(row?.total_cost, label).toBe(0);
            else expect(row?.total_cost, label).toBeGreaterThan(0);
          } finally {
            db.close();
          }
        } finally {
          fetching.mockRestore();
          closeLedgers();
          ledger.cleanup();
        }
      }
    }
  });
});

describe("the schedule's resets", () => {
  test("a real warm forgets earlier ping failures, so the next failure waits 30 s again", () => {
    const schedule = new CacheKeepalive(10);
    schedule.setInterval(minutes(5), MODEL);
    schedule.onCacheWarmed(MODEL, 0);
    schedule.onPingFailed(minutes(5));
    schedule.onPingFailed(minutes(5) + 30_000);
    schedule.onCacheWarmed(MODEL, minutes(6));
    schedule.onPingFailed(minutes(11));
    expect(schedule.nextPingAt).toBe(minutes(11) + 30_000);
  });

  test("invalidating forgets when the prefix was last warmed and how often pings failed", () => {
    const schedule = new CacheKeepalive(10);
    schedule.setInterval(minutes(5), MODEL);
    schedule.onPrefixWarmed(0);
    schedule.onPingFailed(minutes(1));
    schedule.onPingFailed(minutes(2));
    schedule.onCacheInvalidated();
    schedule.onCacheWarmed(MODEL, minutes(3), false);
    expect(schedule.nextPingAt).toBe(minutes(8));
    schedule.onCacheInvalidated();
    schedule.onPrefixWarmed(minutes(10));
    schedule.onPingFailed(minutes(15));
    expect(schedule.nextPingAt).toBe(minutes(15) + 30_000);
  });
});
