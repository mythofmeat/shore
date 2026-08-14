import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { restoreTestEnv, setTestEnv } from "./support/env.ts";

import { closeLedgers } from "../src/ledger/record.ts";
import { generate } from "../src/llm/generate.ts";
import { budgetBlockFor } from "../src/ledger/gate.ts";
import { RECENT_COST_SAMPLE } from "../src/ledger/query.ts";
import { Ledger } from "../src/ledger/store.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "../src/llm/types.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
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
    // eslint-disable-next-line require-yield
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
      } as StreamEvent;
    },
  } as unknown as SidecarProvider;
  return state as { calls: number; provider: SidecarProvider };
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

test("a generate with missing labels is attached to the daemon ledger before sending", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-budget-unaccounted-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = await chatConfig(root, false);
  const counting = countingProvider();
  const request = req(spentLedger(), undefined);
  delete request.context;

  await generate(request, { providers: { openai: counting.provider }, config });
  expect(counting.calls).toBe(1);
  const labeled = (request as SidecarRequest).context;
  expect(labeled?.ledger).toBe(join(config.dirs.data, "ledger.db"));
  const ledger = Ledger.open(labeled!.ledger!);
  expect(ledger.database.query("SELECT COUNT(*) AS n FROM call_attempts").get()).toEqual({ n: 1 });
  ledger.close();
});

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

test("a generate under budget proceeds", async () => {
  const { calls, error } = await generateOnce({
    timezone: "utc",
    budgets: [{ name: "roomy", period: "month", cost_usd: 100.0, limit: "block" }],
  });

  expect(error).toBeUndefined();
  expect(calls).toBe(1);
});

test("no budgets configured means no gate", async () => {
  const { calls, error } = await generateOnce(undefined);

  expect(error).toBeUndefined();
  expect(calls).toBe(1);
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
  } as unknown as SidecarRequest;
}

const RECENT_WINDOW_BUDGET = {
  timezone: "utc",
  budgets: [
    { name: "window", period: "month", cost_usd: 25.0, warn_at: [1.0], limit: "block" },
  ],
} as unknown as UsageConfig;

const THIRTY_DOLLAR_BUDGET = {
  timezone: "utc",
  budgets: [
    { name: "basis", period: "month", cost_usd: 30.0, warn_at: [1.0], limit: "block" },
  ],
} as unknown as UsageConfig;

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

  const loop = budgetBlockFor(loopReq(ledger, TEN_DOLLAR_BUDGET, 10));
  expect(loop?.budget_name).toBe("ten");
  expect(loop?.projected_cost).toBeCloseTo(9.0, 5);
});

test("the refusal says it is a projection, and reports what was actually spent", () => {
  const ledger = ledgerWithHistory(4, 1.0);
  const block = budgetBlockFor(loopReq(ledger, TEN_DOLLAR_BUDGET, 10));

  expect(block?.message).toContain("would be exceeded by this tool loop");
  expect(block?.message).toContain("$4.00 spent");
  expect(block?.message).toContain("projected");
  expect(block?.message).not.toContain("is over limit");
  expect(block?.current_cost).toBeCloseTo(4.0, 5);
});

test("a loop that fits is allowed", () => {
  const ledger = ledgerWithHistory(1, 1.0);
  expect(budgetBlockFor(loopReq(ledger, TEN_DOLLAR_BUDGET, 9))).toBeUndefined();
});

test("no cost history means no projection, so a new model is not refused on a guess", () => {
  const ledger = ledgerWithHistory(4, 1.0);
  const other = {
    ...loopReq(ledger, TEN_DOLLAR_BUDGET, 10),
    model: "openai/gpt-unseen",
  } as SidecarRequest;

  expect(budgetBlockFor(other)).toBeUndefined();
});

test("a request with no tools is not a loop, whatever its iteration cap says", () => {
  const ledger = ledgerWithHistory(4, 1.0);
  for (const tools of [undefined, []]) {
    const capped = {
      ...req(ledger, TEN_DOLLAR_BUDGET),
      max_tool_iterations: 10,
      ...(tools === undefined ? {} : { tools }),
    } as unknown as SidecarRequest;
    expect(budgetBlockFor(capped), "one call cannot overrun").toBeUndefined();
  }
});

test("a cap of one or zero projects nothing, and never projects backwards", () => {
  const spent = ledgerWithHistory(10, 1.0);
  for (const cap of [0, 1]) {
    expect(
      budgetBlockFor(loopReq(spent, TEN_DOLLAR_BUDGET, cap))?.budget_name,
      `cap ${cap} must not talk the gate out of a refusal`,
    ).toBe("ten");
  }

  const room = ledgerWithHistory(9, 1.0);
  expect(budgetBlockFor(loopReq(room, TEN_DOLLAR_BUDGET, 1))).toBeUndefined();
});

test("continuations are priced off continuations, not off the turn that opens them", () => {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  const ts = new Date().toISOString();
  const insert = (callType: string, cost: number): void => {
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'aria', 'openai', 'default',
         'openai/gpt-test', ?2, 10, 5, 0, 0, 100, 10, 'end_turn', 1,
         'pricing_catalog', ?3)`,
    ).run(ts, callType, cost);
  };
  for (let i = 0; i < 5; i++) insert("message", 3.0);
  for (let i = 0; i < 5; i++) insert("tool_loop", 1.0);
  db.close();

  const block = budgetBlockFor(loopReq(f.path, THIRTY_DOLLAR_BUDGET, 10));
  expect(block, "$20 spent + $9 projected fits under $30").toBeUndefined();
});

test("a heartbeat loop is priced off heartbeat continuations", () => {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  const ts = new Date().toISOString();
  const insert = (callType: string, cost: number): void => {
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'aria', 'openai', 'default',
         'openai/gpt-test', ?2, 10, 5, 0, 0, 100, 10, 'end_turn', 1,
         'pricing_catalog', ?3)`,
    ).run(ts, callType, cost);
  };
  for (let i = 0; i < 5; i++) insert("tool_loop", 3.0);
  for (let i = 0; i < 5; i++) insert("heartbeat_tool_loop", 1.0);
  db.close();

  const heartbeat = {
    ...loopReq(f.path, THIRTY_DOLLAR_BUDGET, 10),
    context: {
      ...(loopReq(f.path, THIRTY_DOLLAR_BUDGET, 10).context as object),
      call_type: "heartbeat",
    },
  } as SidecarRequest;

  expect(budgetBlockFor(heartbeat)).toBeUndefined();
});

test("the estimate follows the recent window, not the whole history", () => {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  const ts = new Date().toISOString();
  const insert = (cost: number): void => {
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'aria', 'openai', 'default',
         'openai/gpt-test', 'tool_loop', 10, 5, 0, 0, 100, 10, 'end_turn', 1,
         'pricing_catalog', ?2)`,
    ).run(ts, cost);
  };
  for (let i = 0; i < 25; i++) insert(0.01);
  for (let i = 0; i < RECENT_COST_SAMPLE; i++) insert(1.0);
  db.close();

  const block = budgetBlockFor(loopReq(f.path, RECENT_WINDOW_BUDGET, 10));
  expect(block?.projected_cost).toBeCloseTo(9.0, 5);
});

test("free rows do not drag the mean toward zero", () => {
  const f = freshLedger();
  cleanups.push(f.cleanup);
  const db = openLedger(f.path);
  const ts = new Date().toISOString();
  const insert = (cost: number): void => {
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'aria', 'openai', 'default',
         'openai/gpt-test', 'tool_loop', 10, 5, 0, 0, 100, 10, 'end_turn', 1,
         'pricing_catalog', ?2)`,
    ).run(ts, cost);
  };
  for (let i = 0; i < 9; i++) insert(0);
  insert(1.0);
  db.close();

  const block = budgetBlockFor(loopReq(f.path, TEN_DOLLAR_BUDGET, 10));
  expect(block?.projected_cost).toBeCloseTo(9.0, 5);
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
  } as ResolvedModel;
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
    registry: { getOrCreate: async () => engine, effectiveConfig: () => config },
    dataDir: config.dirs.data,
    providers: { openai: counting.provider },
    autonomy: {
      ensureState: () => false,
      backfillActivity: noop,
      onUserMessage: noop,
      shouldCompactNow: () => false,
      onCompactionComplete: noop,
      onCompactionFailed: noop,
      notifyLastRequest: noop,
      notifyAssistantMessage: noop,
    } as unknown as GenerationDeps["autonomy"],
    notifier: { notifyMessageComplete: noop } as unknown as GenerationDeps["notifier"],
    sessionTokens: { input: 0, output: 0 } as GenerationDeps["sessionTokens"],
    diagnostics: {
      api_calls: { push: noop },
      tool_calls: { push: noop },
      key_fallbacks: { push: (e: unknown) => fallbacks.push(e) },
    } as unknown as GenerationDeps["diagnostics"],
    emitEvent: noop,
    mcpRegistry: { toolDefsFiltered: () => [], call: async () => undefined },
    compaction: { run: async () => 0, applyDeferredEdits: async () => {} },
    newlyCrossedUsageBudgetWarnings: async () => [],
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

  test("a chat turn under budget proceeds", async () => {
    const generous = {
      timezone: "utc",
      budgets: [{ name: "roomy", period: "month", cost_usd: 100.0, limit: "block" }],
    } as unknown as UsageConfig;
    const { calls, error } = await chatTurn(generous);

    expect(error).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("no budgets configured means no gate on chat either", async () => {
    const { calls, error } = await chatTurn(undefined);

    expect(error).toBeUndefined();
    expect(calls).toBe(1);
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

  test("a blocked turn is refused once, not once per configured key", async () => {
    const { calls, fallbacks, sleeps, error } = await chatTurn(BLOCKING_BUDGET, true);

    expect(fallbacks, "a budget refusal must abandon no credential").toBe(0);
    expect(sleeps, "a budget refusal must not back off and retry").toBe(0);
    expect(calls).toBe(0);
    expect(error).toContain('Shore usage budget "tiny" is over limit');
  });
});
