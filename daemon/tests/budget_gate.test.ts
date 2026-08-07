/**
 * The budget gate, at every seam that spends.
 *
 * `ledger_budget_parity.test.ts` proves the *decision* matches the Rust. This
 * proves the decision is actually consulted: that a blocked call never reaches
 * the provider, that it surfaces as a budget refusal rather than a transport
 * failure, and that an allowed call is untouched.
 *
 * The distinction matters because the failure mode of a gate is silence. A
 * gate that is never called, or one whose context arrives without budgets,
 * passes every test about budget arithmetic and enforces nothing.
 *
 * # Why there are two halves here
 *
 * Both halves now call production directly: the generate half drives
 * `generate()`, the chat half drives `runGeneration`. Neither goes over HTTP.
 *
 * They are separate because their gates are separate lines of code. The chat
 * turn is the path a person types into; `generate()` is the one compaction,
 * dreaming and the image tool reach the provider through. A single test cannot
 * cover both, and the reason is a scar: the gate used to sit on the sidecar's
 * `/v1/stream`, and absorbing that hop moved the chat turn to `runGeneration`
 * while leaving the gate behind on an endpoint nothing called. Chat turns were
 * the one spending path with no budget on them, and this file passed the whole
 * time because it was watching the door that still had one.
 */

import { Database } from "bun:sqlite";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";

import { closeLedgers } from "../src/ledger/record.ts";
import { generate } from "../src/llm/generate.ts";
import { budgetBlockFor } from "../src/ledger/gate.ts";
import { RECENT_COST_SAMPLE } from "../src/ledger/query.ts";
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
import type { TurnAutonomy } from "../src/handler/turn.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  closeLedgers();
  for (const c of cleanups) c();
  cleanups.length = 0;
});

/**
 * A ledger holding a single $5 call, so a $1 budget is already blown.
 *
 * Stamped *now* rather than at a fixed date, because the budget window is
 * relative to the clock: a row outside the current period counts for nothing,
 * and the gate would correctly allow the call.
 */
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

/** Counts what actually reached the provider. */
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

// ── the generate path ───────────────────────────────────────────────────
//
// These ran over `/v1/generate` and `/v1/stream` until that hop was deleted.
// The stream half is now "the chat turn" below, which drives `runGeneration`
// and is the path a person types into. What is left here is the non-streaming
// one — compaction, dreaming and the image tool reach the provider through
// `llm/generate.ts`, and its gate is a separate line of code from the turn's.
//
// The endpoints answered 402 for a refusal. There is no status any more, so
// these assert on the thrown `BudgetBlocked` — which is what `ff7426ae` gave a
// `kind` so the retry layer would stop treating it as rotatable.

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
  // Nothing is configured when `[usage]` is absent. That must read as "allow",
  // not as "deny by default" — a budget-less install would otherwise stop
  // working the moment this gate was introduced.
  const { calls, error } = await generateOnce(undefined);

  expect(error).toBeUndefined();
  expect(calls).toBe(1);
});

// ── the tool loop's pre-flight (#14) ────────────────────────────────────
//
// A loop makes up to `max_tool_iterations` provider calls behind one gate, so
// a loop starting just under a hard limit could spend every iteration and
// finish well past it. The gate now weighs the whole loop before it starts.
//
// It refuses *before* rather than *during* deliberately: a mid-loop refusal
// leaves `tool_use` blocks with no `tool_result` after them, which Anthropic
// rejects on the next request — turning an overrun into a wedged conversation.

/**
 * A ledger holding `count` continuations of `each` dollars, inside the window.
 *
 * `tool_loop`, not `message`: the projection prices what a loop's continuations
 * cost, and those are the rows it averages. A fixture full of `message` rows
 * would leave it with nothing to learn from and project nothing at all.
 */
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

/** `req`, plus the two things that make a request a loop. */
function loopReq(ledger: string, usage: unknown, iterations: number): SidecarRequest {
  return {
    ...req(ledger, usage),
    max_tool_iterations: iterations,
    tools: [{ name: "read", description: "", input_schema: {} }],
  } as unknown as SidecarRequest;
}

/**
 * $25, against a history that spends $20.25.
 *
 * Chosen so the *projection* is the only thing that can decide it: $9 more
 * (the recent rate) breaches, $0.09 more (the lifetime rate) does not.
 */
const RECENT_WINDOW_BUDGET = {
  timezone: "utc",
  budgets: [
    { name: "window", period: "month", cost_usd: 25.0, warn_at: [1.0], limit: "block" },
  ],
} as unknown as UsageConfig;

/**
 * $30, against $20 of history.
 *
 * Sized so only the *right* cost basis fits: $9 of continuations lands at $29,
 * while pricing them off the openers ($27 -> $47) or off a blend ($18 -> $38)
 * both breach. A budget that let all three through would assert nothing.
 */
const THIRTY_DOLLAR_BUDGET = {
  timezone: "utc",
  budgets: [
    { name: "basis", period: "month", cost_usd: 30.0, warn_at: [1.0], limit: "block" },
  ],
} as unknown as UsageConfig;

/** $10 limit, so ten $1 calls is exactly the ceiling. */
const TEN_DOLLAR_BUDGET = {
  timezone: "utc",
  budgets: [
    { name: "ten", period: "month", cost_usd: 10.0, warn_at: [1.0], limit: "block" },
  ],
} as unknown as UsageConfig;

test("a loop that would breach the budget is refused before it starts", () => {
  // $4 spent, and a 10-iteration loop at the observed $1/call projects $9 more.
  // The plain check passes — $4 is well under $10 — and the loop is what does
  // not fit.
  const ledger = ledgerWithHistory(4, 1.0);

  const single = budgetBlockFor(req(ledger, TEN_DOLLAR_BUDGET));
  expect(single, "one call on its own still fits").toBeUndefined();

  const loop = budgetBlockFor(loopReq(ledger, TEN_DOLLAR_BUDGET, 10));
  expect(loop?.budget_name).toBe("ten");
  expect(loop?.projected_cost).toBeCloseTo(9.0, 5);
});

test("the refusal says it is a projection, and reports what was actually spent", () => {
  // The wording matters more than usual here: the budget is *under* its limit
  // at the moment of refusal, so "is over limit" would send someone to
  // `shore usage`, where they would find room and file a bug.
  const ledger = ledgerWithHistory(4, 1.0);
  const block = budgetBlockFor(loopReq(ledger, TEN_DOLLAR_BUDGET, 10));

  expect(block?.message).toContain("would be exceeded by this tool loop");
  expect(block?.message).toContain("$4.00 spent");
  expect(block?.message).toContain("projected");
  expect(block?.message).not.toContain("is over limit");
  // Reported spend stays what the ledger holds — the projection is never
  // folded into it, or `shore usage` and this sentence would disagree.
  expect(block?.current_cost).toBeCloseTo(4.0, 5);
});

test("a loop that fits is allowed", () => {
  // $1 spent, nine more projected, against $10. Exactly at the line and under
  // it — `>=` is the block, so this must pass.
  const ledger = ledgerWithHistory(1, 1.0);
  expect(budgetBlockFor(loopReq(ledger, TEN_DOLLAR_BUDGET, 9))).toBeUndefined();
});

test("no cost history means no projection, so a new model is not refused on a guess", () => {
  // Rows exist, but on a different model. Averaging anything else would price
  // this loop off a model it has nothing to do with.
  const ledger = ledgerWithHistory(4, 1.0);
  const other = {
    ...loopReq(ledger, TEN_DOLLAR_BUDGET, 10),
    model: "openai/gpt-unseen",
  } as SidecarRequest;

  expect(budgetBlockFor(other)).toBeUndefined();
});

test("a request with no tools is not a loop, whatever its iteration cap says", () => {
  const ledger = ledgerWithHistory(4, 1.0);
  // Both spellings of "no tools". An empty array is the one the assembler
  // actually produces when every tool is disabled, and it is not `undefined`.
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
  // $10 of $10 is already over, so the plain check must refuse. The danger is
  // arithmetic: `cap - 1` at a cap of zero is *negative*, and a negative
  // projection would subtract from the spend and let an over-budget call
  // through. The guard is what stops the loop maths reaching a non-loop.
  const spent = ledgerWithHistory(10, 1.0);
  for (const cap of [0, 1]) {
    expect(
      budgetBlockFor(loopReq(spent, TEN_DOLLAR_BUDGET, cap))?.budget_name,
      `cap ${cap} must not talk the gate out of a refusal`,
    ).toBe("ten");
  }

  // And under budget, a cap of one is not inflated into a second call's worth.
  const room = ledgerWithHistory(9, 1.0);
  expect(budgetBlockFor(loopReq(room, TEN_DOLLAR_BUDGET, 1))).toBeUndefined();
});


test("continuations are priced off continuations, not off the turn that opens them", () => {
  // Measured over two weeks of real traffic: a `tool_loop` call cost $0.0145
  // against $0.0416 for a `message` on the same models. Averaging both prices
  // every projected continuation at roughly triple, and the gate then demands
  // triple the headroom — refusing turns that would have fit, which reads as
  // the daemon being broken rather than as a budget working.
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
  // Expensive openers, cheap continuations — the real shape.
  for (let i = 0; i < 5; i++) insert("message", 3.0);
  for (let i = 0; i < 5; i++) insert("tool_loop", 1.0);
  db.close();

  // Nine more continuations at $1 is $9. Priced off the $3 openers it would be
  // $27, or off the $2 blended mean $18 — either would refuse this loop.
  const block = budgetBlockFor(loopReq(f.path, THIRTY_DOLLAR_BUDGET, 10));
  expect(block, "$20 spent + $9 projected fits under $30").toBeUndefined();
});

test("a heartbeat loop is priced off heartbeat continuations", () => {
  // The two loops record under different call types and cost very differently:
  // `heartbeat_tool_loop` averaged $0.0052 against `tool_loop`'s $0.0145. A
  // heartbeat priced off chat's continuations would reserve nearly triple.
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

  // $20 spent, nine heartbeat continuations at $1 = $9, under $30. Priced off
  // `tool_loop` it would project $27 and refuse.
  expect(budgetBlockFor(heartbeat)).toBeUndefined();
});

test("the estimate follows the recent window, not the whole history", () => {
  // A model that was cheap and is now expensive. Averaging everything ever
  // recorded would price this loop off the old rate and wave it through.
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
  // 25 cheap calls, then a full sample window of expensive ones.
  for (let i = 0; i < 25; i++) insert(0.01);
  for (let i = 0; i < RECENT_COST_SAMPLE; i++) insert(1.0);
  db.close();

  // Recent mean is $1, so 9 more calls project $9. Averaging oldest-first
  // would find $0.01 and project nine cents.
  const block = budgetBlockFor(loopReq(f.path, RECENT_WINDOW_BUDGET, 10));
  expect(block?.projected_cost).toBeCloseTo(9.0, 5);
});

test("free rows do not drag the mean toward zero", () => {
  // A subscription provider records $0. Counting those as calls would project
  // that a loop costs nothing, which is the one answer that makes the gate
  // useless. Nine $0 rows and one $1 row must price a call at $1, not $0.10.
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

  // Spend is $1. A 10-iteration loop projects 9 x $1 = $9, so $10 total: at
  // the limit, and refused. Averaging the zeros would project $0.09 and allow.
  const block = budgetBlockFor(loopReq(f.path, TEN_DOLLAR_BUDGET, 10));
  expect(block?.projected_cost).toBeCloseTo(9.0, 5);
});

// ── the chat turn ───────────────────────────────────────────────────────

const CHAT_KEY_ENV = "SHORE_BUDGET_GATE_KEY";
const SPARE_KEY_ENV = "SHORE_BUDGET_GATE_SPARE_KEY";

/** The catalog entry the turn resolves to. `openai`, so no SDK is reached. */
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
  // No tools: with a tool context the turn goes through a loop, and what is
  // under test is the check that precedes either path.
  app.tools.enabled_tools = [];
  app.defaults.model = "gpt-test";

  const models = emptyCatalog();
  models.chat.set("chat.gpt-test", chatModel());

  process.env[CHAT_KEY_ENV] = "sk-test";
  process.env[SPARE_KEY_ENV] = "sk-spare";
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

/**
 * A turn through `runGeneration`, reporting what reached the provider.
 *
 * `fallbacks` is the rotation diagnostic: one entry per key abandoned. It is
 * what separates "the provider was never called" from "the provider was never
 * called, and we did not ask every credential in turn first".
 */
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
  const ledger = spentLedger();
  const counting = countingProvider();
  const fallbacks: unknown[] = [];
  // The retry layer's only observable effect on a refusal that cannot change.
  // Counted rather than awaited, so a regression shows up as a number instead
  // of a slow test.
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
    usageConfig: () => usage,
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
    // The reason the check sits inside the attempt. `budgetMatchesCall`
    // compares `budget.api_key` against `api_key_name ?? "unknown"`, and the
    // name is stamped per attempt — so the same check hoisted above the
    // rotation would compare against "unknown", match nothing, and let the call
    // through while appearing to be a gate.
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
    // The rotation and retry layers both cast what they catch to `LlmError` and
    // branch on `kind`. A refusal without one classifies as `undefined`, which
    // `shouldRotate` reads as rotatable — so the gate would be re-asked with
    // each remaining credential and answer identically every time, and a budget
    // scoped to one key would end up enforced by spending another.
    //
    // Two keys, so there is somewhere to rotate *to*. With one key the counters
    // below read the same whether or not the refusal is classified.
    const { calls, fallbacks, sleeps, error } = await chatTurn(BLOCKING_BUDGET, true);

    expect(fallbacks, "a budget refusal must abandon no credential").toBe(0);
    // Retrying is the other way to ask the same question repeatedly. It cannot
    // change the answer — the gate reads the ledger, not the network — so a
    // backoff here is time the user waits for a refusal that was already final.
    expect(sleeps, "a budget refusal must not back off and retry").toBe(0);
    expect(calls).toBe(0);
    expect(error).toContain('Shore usage budget "tiny" is over limit');
  });
});
