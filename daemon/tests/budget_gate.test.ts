

import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

import { closeLedgers } from "../src/ledger/record.ts";
import { generate } from "../src/llm/generate.ts";
import { budgetBlockFor } from "../src/ledger/gate.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "../src/llm/types.ts";
import type { BudgetBlock, UsageConfig } from "../src/ledger/budget.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog, type ResolvedModel } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import {
  generationEngine,
  runGeneration,
  type GenerationDeps,
} from "../src/handler/generation.ts";

const costBlock = (request: SidecarRequest): BudgetBlock | undefined =>
  budgetBlockFor(request) as BudgetBlock | undefined;

afterAll(restoreTestEnv);

const cleanups: Array<() => void> = [];
afterEach(() => {
  closeLedgers();
  for (const c of cleanups) c();
  cleanups.length = 0;
});

function spentLedger(): string {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  db.query(
    `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
     VALUES (?1, 'aria', 'openai', 'default',
       'openai/gpt-test', 'message', 10, 5, 0, 0, 100, 10, 'end_turn', 1,
       'pricing_catalog', 5.0)`,
  ).run(new Date().toISOString());
  db.close();
  return f.path;
}

function countingProvider(): { calls: number; provider: SidecarProvider } {
  const state = { calls: 0, provider: undefined as unknown as SidecarProvider };
  state.provider = {
    generate: (): Promise<GenerateResponse> => {
      state.calls += 1;
      return Promise.resolve({
        content: "hello",
        content_blocks: [{ type: "text", text: "hello" }],
        finish_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      } as GenerateResponse);
    },
    stream: async function* (): AsyncGenerator<StreamEvent> {
      state.calls += 1;
      yield {
        type: "done",
        content: "hello",
        content_blocks: [{ type: "text", text: "hello" }],
        finish_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        timing: { total_ms: 1, time_to_first_token_ms: 1 },
      };
    },
  };
  return state;
}

const BLOCKING_BUDGET = {
  timezone: "utc",
  budgets: [
    {
      name: "tiny",
      period: "month",
      cost_usd: 1.0,
      warn_at: [1.0],
      limit: "block",
    },
  ],
} as unknown as UsageConfig;

function req(ledger: string, usage?: unknown): SidecarRequest {
  return {
    sdk: "openai",
    model: "openai/gpt-test",
    api_key: "sk-test",
    provider_key: "openai",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 128,
    replay_prior_thinking: "all",
    context: {
      ledger,
      character: "aria",
      call_type: "message",
      api_key_name: "default",
      thinking_enabled: false,
      usage,
    },
  } as unknown as SidecarRequest;
}

async function generateOnce(
  usage: unknown,
): Promise<{ calls: number; error: string | undefined }> {
  const root = await mkdtemp(join(tmpdir(), "shore-budget-generate-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = await chatConfig(root, false);
  const ledger = spentLedger();
  const counting = countingProvider();

  let error: string | undefined;
  try {
    await generate(req(ledger, usage), {
      providers: { openai: counting.provider },
      config,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { calls: counting.calls, error };
}

test("an over-budget generate never reaches the provider", async () => {
  const { calls, error } = await generateOnce(BLOCKING_BUDGET);

  expect(error, "the budget's own sentence, not a transport failure").toContain(
    'Shore usage budget "tiny" is over limit',
  );
  expect(calls, "the provider must not have been called").toBe(0);
});

function ledgerWithHistory(count: number, each: number): string {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  const ts = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'aria', 'openai', 'default',
         'openai/gpt-test', 'tool_loop', 10, 5, 0, 0, 100, 10, 'end_turn', 1,
         'pricing_catalog', ?2)`,
    ).run(ts, each);
  }
  db.close();
  return f.path;
}

function loopReq(ledger: string, usage: unknown, iterations: number): SidecarRequest {
  return {
    ...req(ledger, usage),
    max_tool_iterations: iterations,
    tools: [{ name: "read", description: "", input_schema: {} }],
  };
}

const TEN_DOLLAR_BUDGET = {
  timezone: "utc",
  budgets: [
    { name: "ten", period: "month", cost_usd: 10.0, warn_at: [1.0], limit: "block" },
  ],
} as unknown as UsageConfig;

test("a loop that would breach the budget is refused before it starts", () => {
  const ledger = ledgerWithHistory(4, 1.0);

  const single = budgetBlockFor(req(ledger, TEN_DOLLAR_BUDGET));
  expect(single, "one call on its own still fits").toBeUndefined();

  const loop = costBlock(loopReq(ledger, TEN_DOLLAR_BUDGET, 10));
  expect(loop?.budget_name).toBe("ten");
  expect(loop?.projected_cost).toBeCloseTo(9.0, 5);
});

const CHAT_KEY_ENV = "SHORE_BUDGET_GATE_KEY";
const SPARE_KEY_ENV = "SHORE_BUDGET_GATE_SPARE_KEY";

function chatModel(): ResolvedModel {
  return {
    name: "gpt-test",
    qualifiedName: "chat.gpt-test",
    category: "chat",
    providerKey: "openai",
    sdk: "openai",
    modelId: "openai/gpt-test",
    apiKeyEnv: CHAT_KEY_ENV,
    maxContextTokens: 100_000,
    maxOutputTokens: 1024,
  };
}

async function chatConfig(root: string, spareKey: boolean): Promise<LoadedConfig> {
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "run"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });

  const app = defaultAppConfig();
  app.tools.enabled_tools = [];
  app.defaults.model = "gpt-test";

  const models = emptyCatalog();
  models.chat.set("chat.gpt-test", chatModel());

  setTestEnv(CHAT_KEY_ENV, "sk-test");
  setTestEnv(SPARE_KEY_ENV, "sk-spare");
  const providers = ProviderRegistry.fromSection({
    openai: {
      keys: spareKey
        ? [
            { name: "default", env: CHAT_KEY_ENV },
            { name: "spare", env: SPARE_KEY_ENV },
          ]
        : [{ name: "default", env: CHAT_KEY_ENV }],
    },
  });

  return { app, models, providers, dirs, rawTable: undefined };
}

async function chatTurn(
  usage: UsageConfig | undefined,
  spareKey = false,
): Promise<{
  calls: number;
  error: string | undefined;
  fallbacks: number;
  sleeps: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "shore-budget-chat-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = await chatConfig(root, spareKey);
  if (usage !== undefined) {
    config.app.usage = usage as unknown as typeof config.app.usage;
  }
  const ledger = spentLedger();
  const counting = countingProvider();
  const fallbacks: unknown[] = [];
  let sleeps = 0;

  const engine = generationEngine(
    await ConversationEngine.load("aria", config.dirs.data, undefined),
  );

  const noop = (): void => {};
  const deps: GenerationDeps = {
    registry: {
      getOrCreate: async () => engine,
      effectiveConfig: () => config,
      listThreads: () => [{ id: "main", created_at: "2026-09-03T00:00:00.000Z", compaction: true }],
    },
    dataDir: config.dirs.data,
    providers: { openai: counting.provider },
    autonomy: {
      ensureState: () => false,
        needsActivityBackfill: () => false,
      backfillActivity: noop,
      onUserMessage: noop,
      shouldCompactNow: () => false,
      onCompactionComplete: noop,
      onCompactionFailed: noop,
      notifyLastRequest: noop,
      notifyAssistantMessage: noop,
    },
    notifier: { notifyMessageComplete: noop } as unknown as GenerationDeps["notifier"],
    diagnostics: {
      api_calls: { push: noop },
      tool_calls: { push: noop },
      key_fallbacks: { push: (e: unknown) => fallbacks.push(e) },
    } as unknown as GenerationDeps["diagnostics"],
    emitEvent: noop,
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => ({ kind: "completed", retained: 0 }), applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
    newlyCrossedPlanLimitWarnings: async () => [],
    ledgerPath: ledger,
    sleep: async () => {
      sleeps += 1;
    },
  };

  let error: string | undefined;
  try {
    await runGeneration(deps, {
      meta: {
        session: {
          clientId: 1,
          sessionId: 1,
          clientType: "test-client",
          clientName: "test-1",
          capabilities: ["streaming"],
          selectedCharacter: "aria",
        },
        rid: null,
        kind: "message",
      } as never,
      body: { rid: null, text: "hi", images: [], image_data: [] } as never,
      regen: false,
      charName: "aria",
      rid: null,
      send: async () => {},
      signal: new AbortController().signal,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { calls: counting.calls, error, fallbacks: fallbacks.length, sleeps };
}

describe("the chat turn", () => {
  test("an over-budget chat turn never reaches the provider", async () => {
    const { calls, error } = await chatTurn(BLOCKING_BUDGET);

    expect(error, "the budget's own sentence, not a transport failure").toContain(
      'Shore usage budget "tiny" is over limit',
    );
    expect(calls, "the provider must not have been called").toBe(0);
  });

  test("a budget scoped to an api_key is enforced on the chat turn", async () => {
    const scoped = {
      timezone: "utc",
      budgets: [
        {
          name: "keyed",
          period: "month",
          cost_usd: 1.0,
          limit: "block",
          api_key: "default",
        },
      ],
    } as unknown as UsageConfig;
    const { calls, error } = await chatTurn(scoped);

    expect(error).toContain('Shore usage budget "keyed" is over limit');
    expect(calls).toBe(0);
  });
});
