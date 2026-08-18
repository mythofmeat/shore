import { describe, expect, test } from "bun:test";

import { KeepaliveService } from "../src/cache/keepalive.ts";
import { LastRequestCache } from "../src/cache/last_request.ts";
import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { catalogFromSections, toRequestModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { turnAutonomy } from "../src/handler/deps.ts";
import { persistAndNotify, type PersistContext } from "../src/handler/persistence.ts";
import { withResolvedCredential } from "../src/llm/generate.ts";
import { MissingApiKey, buildRequestWithResolvedKey } from "../src/llm/request.ts";
import type { GenerateResponse, SidecarRequest } from "../src/llm/types.ts";
import type { StreamResult } from "../src/llm/stream.ts";

const CHARACTER = "ada";
const MINUTE = 60_000;
const KEY_ENV = "SHORE_TEST_ANTHROPIC_KEY";
const LIVE_KEY = "sk-ant-live";
const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);

const CHAT_TOML = `
[anthropic.main]
model_id = "claude-opus-4-6"
cache_keepalive = "55m"
`;

function configWithKey(): LoadedConfig {
  return {
    providers: ProviderRegistry.fromSection({ anthropic: { api_key_env: KEY_ENV } }),
  } as unknown as LoadedConfig;
}

function fakeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function response(): GenerateResponse {
  return {
    model: "claude-opus-4-6",
    finish_reason: "end_turn",
    usage: {
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 4096,
      cache_creation_tokens: 0,
    },
    timing: { total_ms: 10, time_to_first_token_ms: 5 },
    tool_uses: [],
    content_blocks: [{ type: "text", text: "." }],
  } as unknown as GenerateResponse;
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

function chatTurn(): { request: SidecarRequest; intervalMs: number | undefined } {
  const catalog = catalogFromSections(
    Bun.TOML.parse(CHAT_TOML) as Record<string, unknown>,
    undefined,
    undefined,
  );
  const model = catalog.chat.get("chat.anthropic.main");
  if (model === undefined) throw new Error("the fixture catalog lost its model");

  const built = buildRequestWithResolvedKey(toRequestModel(model), "", {
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

async function armedByChatTurn(
  send: (req: SidecarRequest) => Promise<GenerateResponse>,
  clock: ReturnType<typeof fakeClock>,
) {
  const service = new KeepaliveService(send, clock.now);
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

  const { request, intervalMs } = chatTurn();
  const { context: _perCall, ...sentBody } = request;

  const ctx = {
    emitEvent: () => {},
    sendDirect: () => {},
    autonomy: turnAutonomy(bridge, cache),
    notifier: { notifyMessageComplete: () => {} },
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

  return service;
}

describe("a ping carries a usable key", () => {
  test("the prefix a chat turn arms is unauthenticated on its own", async () => {
    const clock = fakeClock();
    const sent: SidecarRequest[] = [];
    const service = await armedByChatTurn(async (req) => {
      sent.push(req);
      return response();
    }, clock);

    clock.advance(55 * MINUTE);
    await service.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.api_key).toBe("");
  });

  test("the runtime's sender resolves that empty key before the provider sees it", async () => {
    const clock = fakeClock();
    const config = configWithKey();
    const env = { [KEY_ENV]: LIVE_KEY };
    const sent: SidecarRequest[] = [];
    const service = await armedByChatTurn(async (req) => {
      sent.push(withResolvedCredential(req, config, env));
      return response();
    }, clock);

    clock.advance(55 * MINUTE);
    await service.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.api_key).toBe(LIVE_KEY);
  });

  test("a fresh env value wins over a key the prefix was armed with", () => {
    const request = { ...chatTurn().request, api_key: "sk-ant-rotated-out" };
    const resolved = withResolvedCredential(request, configWithKey(), { [KEY_ENV]: LIVE_KEY });
    expect(resolved.api_key).toBe(LIVE_KEY);
  });

  test("a prefix that already has a key survives an empty env", () => {
    const request = { ...chatTurn().request, api_key: LIVE_KEY };
    const resolved = withResolvedCredential(request, configWithKey(), {});
    expect(resolved.api_key).toBe(LIVE_KEY);
  });

  test("no key anywhere fails as a missing credential, not as an SDK auth error", () => {
    expect(() => withResolvedCredential(chatTurn().request, configWithKey(), {})).toThrow(
      MissingApiKey,
    );
  });
});
