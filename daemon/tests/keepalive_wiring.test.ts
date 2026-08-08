/**
 * The wire between the cadence and the scheduler (#47).
 *
 * Every piece of this already had tests and every one of them passed while the
 * keepalive had never pinged in this daemon's life. `request_parity` checked
 * the cadence at the producer, against a fixture. `keepalive_service` and
 * `cache_keepalive` checked the scheduler from a prefix a test handed them.
 * `handler_deps` checked the chat turn with a stubbed cache. Between the
 * producer and the scheduler sat a `keepalive_interval_ms` that `BuiltRequest`
 * carried and nothing ever read: `toPrefix`'s third argument was optional and
 * no caller passed it, so every character armed with `setInterval(undefined)`
 * and `tick()` answered `"none"` forever.
 *
 * So these start at a TOML model and end at a ping leaving the service, and
 * they assert what the user is paying for — that a ping is or is not sent —
 * rather than that a function was called. Nothing here calls `cache.set`
 * itself: that call always accepted a cadence, and a test that hands it one
 * directly passes just as happily on the broken code. The turn has to walk
 * `persistAndNotify` → `turnAutonomy` → the cache, because the missing hop was
 * in that walk and nowhere else.
 */

import { describe, expect, test } from "bun:test";

import { KeepaliveService } from "../src/autonomy/keepalive.ts";
import { LastRequestCache } from "../src/autonomy/last_request.ts";
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

/**
 * A chat turn, from the `[anthropic.main]` section a user would write down to
 * the two values `LastRequestCache.set` takes. This is `buildRequest`'s own
 * path — the same call `handler/setup.ts` makes — so a cadence that stops
 * being produced here stops being produced in production too.
 */
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

/** Just enough engine for `persistAndNotify` to write into and count. */
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

/**
 * One chat turn, taken the way `handler/generation.ts` takes it: the request
 * and its cadence come out of the builder together, and only `persistAndNotify`
 * puts them into the cache. Everything between is production code.
 */
async function turnPersisted(chatToml: string, clock: ReturnType<typeof fakeClock>) {
  const sent: SidecarRequest[] = [];
  const service = new KeepaliveService(async (req) => {
    sent.push(req);
    return response();
  }, clock.now);

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

  /**
   * `cache_ttl` still defaults to `1h` — it costs nothing on its own, and a
   * character that opts into a cadence needs it already set to be worth it.
   * Splitting them is the whole reason only the keepalive default moved.
   */
  test("the ttl default survives the keepalive default going away", () => {
    const { request } = turnFor(DEFAULTED);
    expect(request.provider_options?.cache_ttl).toBe("1h");
  });
});
