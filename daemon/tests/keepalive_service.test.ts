import { required } from "../src/util/required.ts";

import { beforeEach, describe, expect, test } from "bun:test";

import {
  KeepaliveService,
  buildKeepalivePing,
  pingLandedCold,
  type KeepaliveEvent,
  type KeepalivePrefix,
} from "../src/cache/keepalive.ts";
import { closeLedgers, setCallObserver } from "../src/ledger/record.ts";
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

function response(read: number, write: number): GenerateResponse {
  return {
    content: "",
    content_blocks: [],
    finish_reason: "end_turn",
    usage: usage(read, write),
    timing: { total_ms: 120, time_to_first_token_ms: 120 },
    model: MODEL,
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

function harness(replies: Array<GenerateResponse | Error> = []) {
  const clock = fakeClock();
  const sent: SidecarRequest[] = [];
  let n = 0;
  const service = new KeepaliveService(async (req) => {
    sent.push(req);
    const reply = replies[n++] ?? response(2200, 0);
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

describe("what counts as a warm", () => {

  test("a keepalive ping does not count as activity", async () => {
    const h = harness();
    armWarm(h);
    const before = required(h.service.scheduleFor(CHARACTER)).last_active_at;

    h.clock.advance(minutes(56));
    h.service.observe(CHARACTER, MODEL, "keepalive");

    expect(required(h.service.scheduleFor(CHARACTER)).last_active_at).toBe(before);
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
