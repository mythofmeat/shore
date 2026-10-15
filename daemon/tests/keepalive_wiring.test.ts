import { describe, expect, test } from "bun:test";

import { KeepaliveService } from "../src/cache/keepalive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { catalogFromSections, toRequestModel } from "../src/config/models.ts";
import { applySamplerOverlay, type SamplerSettings } from "../src/config/preferences.ts";
import { parseCacheKeepalive } from "../src/config/keepalive.ts";
import { turnAutonomy } from "../src/handler/deps.ts";
import { persistAndNotify, type PersistContext } from "../src/handler/persistence.ts";
import { buildRequestWithResolvedKey } from "../src/llm/request.ts";
import type { GenerateResponse, SidecarRequest, Usage } from "../src/llm/types.ts";
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
  lastCall?: Usage,
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
  if (lastCall !== undefined) result.context_usage = lastCall;
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

const CONFIGURED: SamplerSettings = { cacheKeepalive: every("55m") };

const THREE_PINGS: SamplerSettings = { cacheKeepalive: every("55m"), cacheKeepalivePings: 3 };

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

  test("three pings are sent one interval apart, and then it stops", async () => {
    expect(await pingsOver(THREE_PINGS, 3)).toBe(3);
    expect(await pingsOver(THREE_PINGS, 6)).toBe(3);
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
});
