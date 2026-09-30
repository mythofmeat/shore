import { afterEach, describe, expect, test } from "bun:test";

import { KeepaliveService } from "../src/cache/keepalive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { freshLedger, rowsIn } from "./support/ledger_fixture.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { catalogFromSections, toRequestModel } from "../src/config/models.ts";
import { applySamplerOverlay, type SamplerSettings } from "../src/config/preferences.ts";
import { parseCacheKeepalive } from "../src/config/keepalive.ts";
import { turnAutonomy } from "../src/handler/deps.ts";
import { persistAndNotify, type PersistContext } from "../src/handler/persistence.ts";
import { buildRequestWithResolvedKey } from "../src/llm/request.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import type { StreamResult } from "../src/llm/stream.ts";

const CHARACTER = "ada";
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);

function fakeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function response(): GenerateResponse {
  return {
    model: "claude-opus-4-6",
    finish_reason: "end_turn",
    usage: {
      input_tokens: 7,
      output_tokens: 1,
      cache_read_tokens: 4096,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    tool_uses: [],
    content_blocks: [{ type: "text", text: "." }],
  } as unknown as GenerateResponse;
}

function turnFor(sampler: SamplerSettings): {
  request: SidecarRequest;
  intervalMs: number | undefined;
  pings: number | undefined;
} {
  const catalog = catalogFromSections(
    Bun.TOML.parse(`["anthropic:claude-opus-4-6"]`) as Record<string, unknown>,
    undefined,
    undefined,
  );
  const listed = catalog.chat.get("anthropic:claude-opus-4-6");
  if (listed === undefined) throw new Error("the fixture catalog lost its model");
  const model = applySamplerOverlay(listed, sampler);

  const built = buildRequestWithResolvedKey(toRequestModel(model), "sk-test", {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    replay: "all",
  });

  return {
    request: {
      ...built.request,
      context: { character: CHARACTER, call_type: "message", thinking_enabled: false },
    },
    intervalMs: built.keepalive_interval_ms,
    pings: built.keepalive_pings,
  };
}

class CountingEngine {
  readonly messages: unknown[] = [];

  appendMessage(msg: unknown): Promise<void> {
    this.messages.push(msg);
    return Promise.resolve();
  }
  replaceAfterLastUserTurn(): Promise<number> {
    return Promise.resolve(0);
  }
  currentRevision(): number {
    return this.messages.length;
  }
  turnCount(): number {
    return this.messages.length;
  }
}

function streamResult(): StreamResult {
  return {
    text: "hi",
    model: "claude-opus-4-6",
    finish_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 4096,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    tool_uses: [],
    content_blocks: [{ type: "text", text: "hi" }],
  } as unknown as StreamResult;
}

async function turnPersisted(
  sampler: SamplerSettings,
  clock: ReturnType<typeof fakeClock>,
  opts: { ledgerPath?: string } = {},
  cacheReadTokens = 4096,
) {
  const sent: SidecarRequest[] = [];
  const service = new KeepaliveService(
    async (req) => {
      sent.push(req);
      return response();
    },
    clock.now,
    opts,
  );

  const cache = new LastRequestCache(service);
  const bridge = new TurnAutonomyBridge({
    register: () => Promise.resolve(),
    backfillActivity: () => {},
    onUserMessage: () => {},
    shouldCompactNow: () => false,
    onCompactionComplete: () => {},
    onCompactionFailed: () => {},
    onAssistantMessage: () => {},
  } as never);

  const { request, intervalMs, pings } = turnFor(sampler);
  const { context: _perCall, ...sentBody } = request;

  const ctx = {
    emitEvent: () => {},
    sendDirect: () => {},
    autonomy: turnAutonomy(bridge, cache),
    notifier: { notifyMessageComplete: () => {} },
    diagnostics: { api_calls: { push: () => {} } },
    newlyCrossedUsageBudgetWarnings: () => Promise.resolve([]),
    newlyCrossedPlanLimitWarnings: () => Promise.resolve([]),
    now: () => "2026-08-08T12:00:00+00:00",
    newMessageId: () => "m_1",
  } as unknown as PersistContext;

  const result = streamResult();
  result.usage.cache_read_tokens = cacheReadTokens;
  await persistAndNotify(ctx, new CountingEngine(), {
    charName: CHARACTER,
    resolvedProviderKey: "anthropic",
    result,
    request: sentBody,
    keepaliveIntervalMs: intervalMs,
    keepalivePings: pings,
    toolIntermediateMessages: [],
    wallClockMs: 10,
  });

  return { service, sent, intervalMs, pings };
}

function every(raw: string): NonNullable<SamplerSettings["cacheKeepalive"]> {
  const parsed = parseCacheKeepalive(raw);
  if ("err" in parsed) throw new Error(parsed.err);
  return parsed.ok;
}

const DEFAULTED: SamplerSettings = {};

const CONFIGURED: SamplerSettings = { cacheKeepalive: every("55m") };

const THREE_PINGS: SamplerSettings = { cacheKeepalive: every("55m"), cacheKeepalivePings: 3 };

const EXPLICIT_OFF: SamplerSettings = { cacheKeepalive: every("off") };

describe("a ping is a call the ledger knows about", () => {
  afterEach(() => {
    closeLedgers();
  });

  test("the ping it sends leaves a keepalive row behind", async () => {
    const ledger = freshLedger();
    try {
      const clock = fakeClock();
      const { service, sent } = await turnPersisted(CONFIGURED, clock, { ledgerPath: ledger.path });

      clock.advance(55 * MINUTE);
      await service.tick();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.context?.ledger, "the path the ping carries").toBe(ledger.path);

      const rows = rowsIn(ledger.path);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["call_type"]).toBe("keepalive");
      expect(rows[0]?.["character"]).toBe(CHARACTER);
      expect(rows[0]?.["cache_read_tokens"]).toBe(4096);
    } finally {
      ledger.cleanup();
    }
  });

  test("cache health sees the ping, not just the turn that armed it", async () => {
    const ledger = freshLedger();
    try {
      const clock = fakeClock();
      const { service } = await turnPersisted(THREE_PINGS, clock, { ledgerPath: ledger.path });

      clock.advance(55 * MINUTE);
      await service.tick();
      clock.advance(55 * MINUTE);
      await service.tick();

      const rows = rowsIn(ledger.path);
      expect(rows.map((r) => r["call_type"])).toEqual(["keepalive", "keepalive"]);
    } finally {
      ledger.cleanup();
    }
  });
});

describe("the ping count bounds the schedule", () => {
  async function pingsOver(sampler: SamplerSettings, intervals: number) {
    const clock = fakeClock();
    const armed = await turnPersisted(sampler, clock);
    for (let i = 0; i < intervals; i += 1) {
      clock.advance(55 * MINUTE);
      await armed.service.tick();
    }
    return armed.sent.length;
  }

  test("a model that names no count sends one ping after each turn", async () => {
    expect(await pingsOver(CONFIGURED, 6)).toBe(1);
  });

  test("three pings are sent one interval apart, and then it stops", async () => {
    expect(await pingsOver(THREE_PINGS, 3)).toBe(3);
    expect(await pingsOver(THREE_PINGS, 6)).toBe(3);
  });

  test("a real turn gives the count back", async () => {
    const clock = fakeClock();
    const { service, sent } = await turnPersisted(CONFIGURED, clock);

    clock.advance(55 * MINUTE);
    await service.tick();
    expect(sent).toHaveLength(1);

    clock.advance(5 * MINUTE);
    service.observe(CHARACTER, "claude-opus-4-6", "message");
    clock.advance(55 * MINUTE);
    await service.tick();
    expect(sent).toHaveLength(2);
  });

  test("a heartbeat is not a real turn, and gives nothing back", async () => {
    const clock = fakeClock();
    const { service, sent } = await turnPersisted(CONFIGURED, clock);

    clock.advance(55 * MINUTE);
    await service.tick();
    clock.advance(5 * MINUTE);
    service.observe(CHARACTER, "claude-opus-4-6", "heartbeat");
    clock.advance(55 * MINUTE);
    await service.tick();
    expect(sent).toHaveLength(1);
  });

  test("the ping carries the window its schedule covers", async () => {
    const clock = fakeClock();
    const { service, sent } = await turnPersisted(THREE_PINGS, clock);

    clock.advance(55 * MINUTE);
    await service.tick();

    expect(sent[0]?.context?.keepalive_window_secs).toBe(3 * 55 * 60);
  });

  test.each([
    [THREE_PINGS, 1],
    [CONFIGURED, 0],
    [EXPLICIT_OFF, 0],
  ] as const)("a restored schedule keeps its count and takes the current setting: %o", async (sampler, expectedPings) => {
    const clock = fakeClock();
    const before = await turnPersisted(THREE_PINGS, clock);
    before.service.observe(CHARACTER, "claude-opus-4-6", "message");
    clock.advance(55 * MINUTE);
    await before.service.tick();
    const snapshot = before.service.scheduleFor(CHARACTER);
    if (snapshot === undefined) throw new Error("missing persisted schedule");
    expect(snapshot.pings_sent).toBe(1);

    const sent: SidecarRequest[] = [];
    const restored = new KeepaliveService(async (request) => {
      sent.push(request);
      return response();
    }, clock.now);
    expect(restored.restore(CHARACTER, snapshot)).toBe(true);
    const current = turnFor(sampler);
    new LastRequestCache(restored).set(CHARACTER, current.request, {
      intervalMs: current.intervalMs, pings: current.pings,
    }, false);
    clock.advance(55 * MINUTE);
    await restored.tick();
    expect(sent).toHaveLength(expectedPings);
  });

  test("a restored schedule does not carry over to the same model ID on another provider", async () => {
    const clock = fakeClock();
    const before = await turnPersisted(THREE_PINGS, clock);
    before.service.observe(CHARACTER, "claude-opus-4-6", "message");
    clock.advance(55 * MINUTE);
    await before.service.tick();
    const snapshot = before.service.scheduleFor(CHARACTER);
    if (snapshot === undefined) throw new Error("missing persisted schedule");

    const sent: SidecarRequest[] = [];
    const restored = new KeepaliveService(async (request) => {
      sent.push(request);
      return response();
    }, clock.now);
    expect(restored.restore(CHARACTER, snapshot)).toBe(true);
    const current = turnFor(THREE_PINGS);
    new LastRequestCache(restored).set(CHARACTER, { ...current.request, provider_key: "openrouter" }, {
      intervalMs: current.intervalMs, pings: current.pings,
    }, false);
    expect(restored.nextPingAt(CHARACTER)).toBeUndefined();
    for (let i = 0; i < 3; i += 1) {
      clock.advance(55 * MINUTE);
      await restored.tick();
    }
    expect(sent).toHaveLength(0);
  });
});

describe("the cadence reaches the schedule", () => {
  test("opting in schedules the requested ping after a turn with no cache metrics", async () => {
    const clock = fakeClock();
    const { service, sent } = await turnPersisted(CONFIGURED, clock, {}, 0);
    expect(service.nextPingAt(CHARACTER)).toBe(T0 + 55 * MINUTE);
    clock.advance(55 * MINUTE);
    await service.tick();
    expect(sent).toHaveLength(1);
  });

  test.each(["5m", "1h"])("a cadence as long as the %s TTL still arms; only setting it warns", async (ttl) => {
    const built = buildRequestWithResolvedKey({
      name: "claude", qualified_name: "nanogpt:anthropic/claude-opus-4-6", category: "chat", provider_key: "nanogpt",
      sdk: "nanogpt", model_id: "anthropic/claude-opus-4-6", cache_keepalive: ttl, cache_ttl: ttl,
    }, "fixture-key", { messages: [], replay: "all" });
    expect(built.keepalive_interval_ms).toBe(ttl === "5m" ? 5 * MINUTE : 60 * MINUTE);
    expect(built.keepalive_pings).toBe(1);
  });

  test.each([
    { sdk: "openai", model: "gpt-test", ttl: "1h" },
    { sdk: "claude_agent", model: "claude-opus-4-6", ttl: undefined },
    { sdk: "nanogpt", model: "google/gemini-flash-latest", ttl: "1h" },
    { sdk: "nanogpt", model: "deepseek/deepseek-v4.1-flash", ttl: "1h" },
    { sdk: "nanogpt", model: "anthropic/claude-opus-4-6", ttl: undefined },
  ] as const)("any model arms, whatever cache control it has: %o", async ({ sdk, model, ttl }) => {
    const built = buildRequestWithResolvedKey({
      name: model, qualified_name: `nanogpt:${model}`, category: "chat", provider_key: "nanogpt",
      sdk, model_id: model, cache_keepalive: "55m", ...(ttl === undefined ? {} : { cache_ttl: ttl }),
    }, "fixture-key", { messages: [], replay: "all" });
    expect(built.keepalive_interval_ms).toBe(55 * MINUTE);
    const clock = fakeClock();
    const sent: SidecarRequest[] = [];
    const service = new KeepaliveService(async (request) => { sent.push(request); return response(); }, clock.now);
    new LastRequestCache(service).set(CHARACTER, built.request, { intervalMs: built.keepalive_interval_ms, pings: built.keepalive_pings });
    clock.advance(55 * MINUTE);
    await service.tick();
    expect(sent).toHaveLength(1);
  });

  test("a model that asks for 55m pings at 55m", async () => {
    const clock = fakeClock();
    const { service, sent, intervalMs } = await turnPersisted(CONFIGURED, clock);
    expect(intervalMs, "the producer's half").toBe(55 * MINUTE);

    clock.advance(54 * MINUTE);
    await service.tick();
    expect(sent, "not due a minute early").toHaveLength(0);

    clock.advance(MINUTE);
    await service.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.context?.call_type).toBe("keepalive");
  });

  test("a model that says nothing never pings, however long it sits", async () => {
    const clock = fakeClock();
    const { service, sent, intervalMs } = await turnPersisted(DEFAULTED, clock);
    expect(intervalMs, "no cadence, because nothing defaults one").toBeUndefined();

    for (const step of [55, 60, 12 * 60, 24 * 60]) {
      clock.advance(step * MINUTE);
      await service.tick();
    }
    expect(sent).toHaveLength(0);
  });

  test("`off` is the same silence as saying nothing, not a zero interval", async () => {
    const clock = fakeClock();
    const { service, sent, intervalMs } = await turnPersisted(EXPLICIT_OFF, clock);
    expect(intervalMs).toBeUndefined();

    clock.advance(12 * 60 * MINUTE);
    await service.tick();
    expect(sent).toHaveLength(0);
  });

  test("the ttl default survives the keepalive default going away", () => {
    const { request } = turnFor(DEFAULTED);
    expect(request.provider_options?.cache_ttl).toBe("1h");
  });
});
