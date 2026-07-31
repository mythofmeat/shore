/**
 * The budget gate, at the seam.
 *
 * `ledger_budget_parity.test.ts` proves the *decision* matches the Rust. This
 * proves the decision is actually consulted: that a blocked call never reaches
 * the provider, that it comes back on the status the daemon maps to a budget
 * error, and that an allowed call is untouched.
 *
 * The distinction matters because the failure mode of a gate is silence. A
 * gate that is never called, or one whose context arrives without budgets,
 * passes every test about budget arithmetic and enforces nothing.
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { closeLedgers } from "../src/ledger/record.ts";
import { createSidecarHandler } from "../src/server.ts";
import type {
  GenerateResponse,
  SidecarProvider,
  SidecarRequest,
  StreamEvent,
} from "../src/llm/types.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { daemonMadeLedger, haveDaemon, openLedger } from "./support/ledger_fixture.ts";

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
  const f = daemonMadeLedger();
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

function post(path: string, body: unknown): Request {
  return new Request(`http://sidecar${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

test.skipIf(!haveDaemon)("an over-budget generate never reaches the provider", async () => {
  const ledger = spentLedger();
  const counting = countingProvider();
  const handler = createSidecarHandler({ providers: { openai: counting.provider } });

  const res = await handler(post("/v1/generate", req(ledger, BLOCKING_BUDGET)));

  expect(res.status, "the status the daemon maps to a budget error").toBe(402);
  expect(await res.text()).toContain('Shore usage budget "tiny" is over limit');
  expect(counting.calls, "the provider must not have been called").toBe(0);
});

test.skipIf(!haveDaemon)("an over-budget stream never reaches the provider", async () => {
  const ledger = spentLedger();
  const counting = countingProvider();
  const handler = createSidecarHandler({ providers: { openai: counting.provider } });

  const res = await handler(post("/v1/stream", req(ledger, BLOCKING_BUDGET)));

  expect(res.status).toBe(402);
  expect(await res.text()).toContain('Shore usage budget "tiny" is over limit');
  expect(counting.calls).toBe(0);
});

test.skipIf(!haveDaemon)("a call under budget proceeds", async () => {
  const ledger = spentLedger();
  const counting = countingProvider();
  const handler = createSidecarHandler({ providers: { openai: counting.provider } });

  const generous = {
    timezone: "utc",
    budgets: [{ name: "roomy", period: "month", cost_usd: 100.0, limit: "block" }],
  };
  const res = await handler(post("/v1/generate", req(ledger, generous)));

  expect(res.status).toBe(200);
  expect(counting.calls).toBe(1);
});

test.skipIf(!haveDaemon)("no budgets configured means no gate", async () => {
  // The daemon omits `usage` entirely when nothing is configured. That must
  // read as "allow", not as "deny by default" — a budget-less install would
  // otherwise stop working.
  const ledger = spentLedger();
  const counting = countingProvider();
  const handler = createSidecarHandler({ providers: { openai: counting.provider } });

  const res = await handler(post("/v1/generate", req(ledger, undefined)));

  expect(res.status).toBe(200);
  expect(counting.calls).toBe(1);
});
