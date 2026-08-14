import { afterEach, describe, expect, test } from "bun:test";

import { KeepaliveService } from "../src/cache/keepalive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { freshLedger, rowsIn } from "./support/ledger_fixture.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { catalogFromSections, toRequestModel } from "../src/config/models.ts";
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

function turnFor(chatToml: string): { request: SidecarRequest; intervalMs: number | undefined } {
  const catalog = catalogFromSections(
    Bun.TOML.parse(chatToml) as Record<string, unknown>,
    undefined,
    undefined,
  );
  const model = catalog.chat.get("chat.anthropic.main");
  if (model === undefined) throw new Error("the fixture catalog lost its model");

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
  chatToml: string,
  clock: ReturnType<typeof fakeClock>,
  opts: { ledgerPath?: string; maxIdleSecs?: () => number } = {},
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

  const { request, intervalMs } = turnFor(chatToml);
  const { context: _perCall, ...sentBody } = request;

  const ctx = {
    emitEvent: () => {},
    sendDirect: () => {},
    autonomy: turnAutonomy(bridge, cache),
    notifier: { notifyMessageComplete: () => {} },
    sessionTokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    diagnostics: { api_calls: { push: () => {} } },
    newlyCrossedUsageBudgetWarnings: () => Promise.resolve([]),
    now: () => "2026-08-08T12:00:00+00:00",
    newMessageId: () => "m_1",
  } as unknown as PersistContext;

  await persistAndNotify(ctx, new CountingEngine() as never, {
    charName: CHARACTER,
    resolvedProviderKey: "anthropic",
    result: streamResult(),
    request: sentBody as never,
    keepaliveIntervalMs: intervalMs,
    toolIntermediateMessages: [],
    wallClockMs: 10,
  });

  return { service, sent, intervalMs };
}

const DEFAULTED = `
[anthropic.main]
model_id = "claude-opus-4-6"
`;

const CONFIGURED = `
[anthropic.main]
model_id = "claude-opus-4-6"
cache_keepalive = "55m"
`;

const EXPLICIT_OFF = `
[anthropic.main]
model_id = "claude-opus-4-6"
cache_keepalive = "off"
`;

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
      const { service } = await turnPersisted(CONFIGURED, clock, { ledgerPath: ledger.path });

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

describe("the configured idle ceiling reaches the schedule", () => {
  const TWENTY_HOURS = 20 * 60 * 60;

  async function armedWithCeiling(secs: number, clock: ReturnType<typeof fakeClock>) {
    const armed = await turnPersisted(CONFIGURED, clock, { maxIdleSecs: () => secs });
    armed.service.observe(CHARACTER, "claude-opus-4-6", "message", undefined);
    return armed;
  }

  test("a 20h ceiling still pings at 13h idle, where the 12h default gave up", async () => {
    const clock = fakeClock();
    const { service, sent } = await armedWithCeiling(TWENTY_HOURS, clock);

    clock.advance(13 * 60 * MINUTE);
    await service.tick();

    expect(sent).toHaveLength(1);
  });

  test("past the configured ceiling it stops, rather than pinging a dead prefix", async () => {
    const clock = fakeClock();
    const { service, sent } = await armedWithCeiling(TWENTY_HOURS, clock);

    clock.advance(21 * 60 * MINUTE);
    await service.tick();

    expect(sent).toHaveLength(0);
  });

  test("the ping carries the ceiling it was judged against", async () => {
    const clock = fakeClock();
    const { service, sent } = await armedWithCeiling(TWENTY_HOURS, clock);

    clock.advance(55 * MINUTE);
    await service.tick();

    expect(sent[0]?.context?.keepalive_max_secs).toBe(TWENTY_HOURS);
  });
});

describe("the cadence reaches the schedule", () => {
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
