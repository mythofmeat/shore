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
const MAX_IDLE_SECS = 12 * 3600;

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
    replay_prior_thinking: "all",
    keepalive_interval_ms: INTERVAL_MS,
    context: {
      character: CHARACTER,
      call_type: "message",
      thinking_enabled: true,
      keepalive_max_secs: MAX_IDLE_SECS,
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
    expect(h.sent[0]!.max_tokens).toBe(1);
  });

  test("a warm ping reschedules one interval out", async () => {
    const h = harness([response(2200, 0)]);
    armWarm(h);

    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    h.clock.advance(minutes(54));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);

    h.clock.advance(minutes(2));
    await h.service.tick();
    expect(h.sent).toHaveLength(2);
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
    expect(h.events[0]!.outcome).toBe("cold");
    expect(h.events[0]!.detail).toContain("COLD");
  });

  test("read 0 with no write is not cold", () => {
    expect(pingLandedCold(usage(0, 0))).toBe(false);
    expect(pingLandedCold(usage(0, 1))).toBe(true);
    expect(pingLandedCold(usage(2200, 200))).toBe(false);
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

    expect(h.events[0]!.outcome).toBe("failed");
    expect(h.events[0]!.detail).toContain("connection reset");
  });

  test("no pushed prefix means no ping", async () => {
    const h = harness();
    h.service.observe(CHARACTER, MODEL, "message");
    h.clock.advance(hours(2));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
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

    release!();
    await first;
  });
});

describe("the real event order", () => {
  test("the very first turn arms the schedule", async () => {
    const h = harness();
    h.service.observe(CHARACTER, MODEL, "message");
    h.service.arm(prefix());

    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);
  });

  test("a call before the first push does not arm a character on its own", async () => {
    const h = harness();
    h.service.observe(CHARACTER, MODEL, "message");

    h.clock.advance(hours(4));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.service.scheduleFor(CHARACTER)).toBeUndefined();
  });
});

describe("what counts as a warm", () => {
  test("a call on another model does not push the ping out", async () => {
    const h = harness();
    armWarm(h);

    h.clock.advance(minutes(50));
    h.service.observe(CHARACTER, OTHER_MODEL, "heartbeat");
    h.clock.advance(minutes(6));

    await h.service.tick();
    expect(h.sent).toHaveLength(1);
  });

  test("a keepalive ping does not count as activity", async () => {
    const h = harness();
    armWarm(h);
    const before = h.service.scheduleFor(CHARACTER)!.last_active_at;

    h.clock.advance(minutes(56));
    h.service.observe(CHARACTER, MODEL, "keepalive");

    expect(h.service.scheduleFor(CHARACTER)!.last_active_at).toBe(before);
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

  test("an unknown character is ignored rather than armed", () => {
    const h = harness();
    h.service.observe("nobody", MODEL, "message");
    expect(h.service.scheduleFor("nobody")).toBeUndefined();
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
    expect(h.sent[0]!.model).toBe(OTHER_MODEL);
  });

  test("disarm drops the prefix and the schedule", async () => {
    const h = harness();
    armWarm(h);
    h.service.disarm(CHARACTER);

    h.clock.advance(hours(2));
    await h.service.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.service.scheduleFor(CHARACTER)).toBeUndefined();
  });

  test("a changed idle ceiling carries the schedule across", async () => {
    const h = harness();
    armWarm(h);
    const before = h.service.scheduleFor(CHARACTER);

    h.service.arm(
      prefix({ context: { ...prefix().context!, keepalive_max_secs: 6 * 3600 } }),
    );
    expect(h.service.scheduleFor(CHARACTER)).toEqual(before);

    h.clock.advance(minutes(56));
    await h.service.tick();
    expect(h.sent).toHaveLength(1);
  });
});

describe("the on-demand ping", () => {
  test("does not move the schedule it is measuring", async () => {
    const h = harness();
    armWarm(h);
    const before = h.service.scheduleFor(CHARACTER);

    h.clock.advance(minutes(10));
    const outcome = await h.service.pingNow(CHARACTER);

    expect(outcome.status).toBe("sent");
    expect(outcome.cold).toBe(false);
    expect(outcome.usage?.cache_read_tokens).toBe(2200);
    expect(h.service.scheduleFor(CHARACTER)).toEqual(before);
  });

  test("a cold on-demand ping reports cold without disarming", async () => {
    const h = harness([response(0, 21_000)]);
    armWarm(h);
    const before = h.service.scheduleFor(CHARACTER);

    const outcome = await h.service.pingNow(CHARACTER);
    expect(outcome.status).toBe("sent");
    expect(outcome.cold).toBe(true);
    expect(h.service.scheduleFor(CHARACTER)).toEqual(before);
  });

  test("says so when there is nothing to ping from", async () => {
    const h = harness();
    const outcome = await h.service.pingNow(CHARACTER);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason, "the daemon matches on this, not the prose").toBe("no_prefix");
  });
});

describe("what reaches the heartbeat log and the state file", () => {
  test("an outcome reaches the sink as it happens", async () => {
    const h = harness();
    armWarm(h);
    h.clock.advance(minutes(56));
    await h.service.tick();

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ character: CHARACTER, outcome: "sent" });
    expect(h.events[0]!.at).toBe(h.clock.now());
  });

  test("no sink means events are dropped, not buffered", async () => {
    const h = harness();
    const loose = new KeepaliveService(async () => response(2200, 0), h.clock.now);
    loose.arm(prefix());
    loose.observe(CHARACTER, MODEL, "message");
    h.clock.advance(minutes(56));
    await expect(loose.tick()).resolves.toBeUndefined();
  });

  test("the schedule is current state, read the same every time", () => {
    const h = harness();
    armWarm(h);

    const a = h.service.scheduleFor(CHARACTER);
    const b = h.service.scheduleFor(CHARACTER);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ model: MODEL, interval: INTERVAL_MS });
  });

  test("a disarmed character reports no schedule", () => {
    const h = harness();
    armWarm(h);
    h.service.disarm(CHARACTER);
    expect(h.service.scheduleFor(CHARACTER)).toBeUndefined();
  });

  test("a throwing event sink does not reject the tick, and the character stays schedulable", async () => {
    const h = harness();
    h.service.onEvent(() => {
      throw new Error("sink blew up");
    });
    armWarm(h);
    h.clock.advance(INTERVAL_MS + 1);

    await h.service.tick();

    expect(h.sent.length, "the ping still went out").toBe(1);
    h.clock.advance(INTERVAL_MS + 1);
    await h.service.tick();
    expect(h.sent.length, "inFlight was cleared, so the next window pings again").toBe(2);
  });

  test("schedules survive a restart through restore", () => {
    const h = harness();
    armWarm(h);
    const persisted = h.service.scheduleFor(CHARACTER)!;

    const fresh = harness();
    fresh.clock.advance(minutes(10));
    expect(
      fresh.service.restore(CHARACTER, persisted, MAX_IDLE_SECS),
      "a prefix warmed 10m ago is still inside the 55m interval",
    ).toBe(true);

    const stale = harness();
    stale.clock.advance(hours(3));
    expect(
      stale.service.restore(CHARACTER, persisted, MAX_IDLE_SECS),
      "a prefix warmed 3h ago is past any plausible TTL",
    ).toBe(false);
  });
});
