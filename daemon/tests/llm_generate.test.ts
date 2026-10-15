

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BudgetBlocked, generate, runGeneration, type GenerateDeps } from "../src/llm/generate.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import type { LoadedConfig } from "../src/config/loader.ts";
import { Ledger } from "../src/ledger/store.ts";
import { closeLedgers } from "../src/ledger/record.ts";
import { openLedger, rowsIn } from "./support/ledger_fixture.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { LlmError } from "../src/llm/errors.ts";
import { testTmp } from "./support/tmp.ts";
import { outcomeOf, rejectionOf } from "./support/outcome.ts";

afterEach(() => {
  closeLedgers();
});

const ACCOUNTING_ROOT = mkdtempSync(join(tmpdir(), "shore-llm-generate-"));
afterAll(() => rmSync(ACCOUNTING_ROOT, { recursive: true, force: true }));

const PRIMARY = "SHORE_GEN_TEST_PRIMARY";
const SPARE = "SHORE_GEN_TEST_SPARE";

function catalog() {
  const models = emptyCatalog();
  models.chat.set("chat.anthropic.sonnet", {
    name: "sonnet",
    qualifiedName: "chat.anthropic.sonnet",
    category: "chat",
    providerKey: "anthropic",
    sdk: "anthropic",
    modelId: "claude-sonnet",
    apiKeyEnv: PRIMARY,
  } as never);
  return models;
}

function config(twoKeys = true): LoadedConfig {
  const providers = twoKeys
    ? ProviderRegistry.fromSection({
        anthropic: {
          keys: [
            { name: "primary", env: PRIMARY, warn_on_fallback: true },
            { name: "spare", env: SPARE },
          ],
        },
      })
    : ProviderRegistry.empty();

  return {
    app: defaultAppConfig(),
    models: catalog(),
    providers,
    dirs: {
      config: ACCOUNTING_ROOT,
      data: ACCOUNTING_ROOT,
      cache: ACCOUNTING_ROOT,
      runtime: ACCOUNTING_ROOT,
    },
    rawTable: undefined,
  };
}

function request(over: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "anthropic",
    model: "claude-sonnet",
    api_key: "seed",
    provider_key: "anthropic",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 1024,
    replay_prior_thinking: "off",
    ...over,
  } as SidecarRequest;
}

function ok(model = "claude-sonnet"): GenerateResponse {
  return {
    content: "hello",
    content_blocks: [{ type: "text", text: "hello" }],
    finish_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    timing: { total_ms: 5, time_to_first_token_ms: 2 },
    model,
  };
}

function recordingProvider(
  keys: string[],
  behaviour: (attempt: number) => GenerateResponse | LlmError = () => ok(),
): SidecarProvider {
  let attempt = 0;
  return {
    generate: async (req) => {
      keys.push(req.api_key);
      const result = behaviour(attempt++) as GenerateResponse & { kind?: string };
      if (result.kind !== undefined) throw result;
      return result;
    },
    stream: async function* (req) {
      keys.push(req.api_key);
      const result = behaviour(attempt++) as GenerateResponse & { kind?: string };
      if (result.kind !== undefined) throw result;
      yield { type: "start", model: result.model };
      yield { ...result, type: "done" };
    },
  };
}

function deps(provider: SidecarProvider, over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    providers: { anthropic: provider },
    config: config(),
    env: { [PRIMARY]: "primary-secret", [SPARE]: "spare-secret" },
    sleep: async () => {},
    ...over,
  };
}

function unauthorized(): LlmError {
  return { kind: "http_status", status: 401, body: "unauthorized" };
}

describe("shared generation contract", () => {

  for (const effect of ["text", "tool", "image"] as const) {
    test(`does not replay or rotate credentials after a ${effect} effect`, async () => {
      let attempts = 0;
      const provider = recordingProvider([]);
      let effectSink: (message: import("../src/protocol/ServerMessage.ts").ServerMessage) => void = () => {};
      provider.stream = async function* () {
        attempts += 1;
        if (effect === "text") yield { type: "text", text: "visible" };
        else if (effect === "tool") yield { type: "tool_use", id: "tool-1", name: "write", input: {} };
        else effectSink({ type: "send_image" } as never);
        throw unauthorized();
      };
      expect(await rejectionOf(runGeneration(request(), { providerKey: "anthropic" }, deps(provider), {
        tools: (_request, sink) => { effectSink = sink; return undefined; },
      }))).toEqual(unauthorized());
      expect(attempts).toBe(1);
    });
  }

  test("an already cancelled call never reaches the provider", async () => {
    const keys: string[] = [];
    const controller = new AbortController();
    controller.abort();
    expect(await outcomeOf(generate(request(), deps(recordingProvider(keys)), controller.signal))).toThrow();
    expect(keys).toEqual([]);
  });
});

function freshLedger(): string {
  const path = join(mkdtempSync(testTmp("shore-gen-ledger-")), "ledger.db");
  Ledger.create(path).close();
  return path;
}

describe("the budget gate", () => {

  test("a budget that is already blown refuses the call before the provider", async () => {
    const path = freshLedger();
    const keys: string[] = [];
    const db = openLedger(path);
    db.query(
      `INSERT INTO calls (ts, character, provider, api_key_name, model, call_type,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_ms, ttft_ms, finish_reason, thinking_enabled, cost_source, total_cost)
       VALUES (?1, 'ada', 'anthropic', 'primary', 'claude-sonnet', 'message',
         10, 5, 0, 0, 100, 10, 'end_turn', 0, 'pricing_catalog', 5.0)`,
    ).run(new Date().toISOString());
    db.close();

    const req = request({
      context: {
        ledger: path,
        character: "ada",
        call_type: "message",
        thinking_enabled: false,
        usage: {
          budgets: [{ name: "tiny", period: "month", cost_usd: 1.0, limit: "block" }],
        },
      },
    } as never);

    expect(await rejectionOf(generate(req, deps(recordingProvider(keys))))).toBeInstanceOf(BudgetBlocked);

    expect(keys).toEqual([]);
    expect(rowsIn(path).length).toBe(1);
  });
});
