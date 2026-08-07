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
 * The HTTP half below covers `server.ts`, which is the seam the Rust used: the
 * daemon POSTed to the sidecar and the sidecar gated `/v1/stream`. Absorbing
 * that hop into this process moved the chat turn to `runGeneration` and left
 * the gate behind on an endpoint nothing calls — so for the length of the port,
 * chat turns were the one spending path with no budget on them, and this file
 * passed the whole time because it was watching the door that still had one.
 *
 * The chat half is therefore the half that has to outlive `server.ts`. It is
 * written against `runGeneration` directly rather than through the daemon, so
 * that deleting the HTTP handler subtracts tests from this file without
 * subtracting coverage of the gate.
 */

import { Database } from "bun:sqlite";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";

import { closeLedgers } from "../src/ledger/record.ts";
import { generate } from "../src/llm/generate.ts";
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
