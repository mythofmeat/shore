import { required } from "../src/util/required.ts";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BudgetBlocked,
  generate,
  generateWithCredentialFallback,
  runGeneration,
  resolveModelForRequest,
  withWorkspaceDir,
  type GenerateDeps,
} from "../src/llm/generate.ts";
import { compactionGenerate } from "../src/autonomy/in_process.ts";
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
  for (const workflow of ["chat", "heartbeat", "compaction", "subagent"] as const) {
    test(`${workflow} uses subscription authentication without an API key`, async () => {
      const keys: string[] = [];
      const provider = recordingProvider(keys);
      const req = request({ sdk: "claude_agent", provider_key: "claude-code", api_key: "", context: {
        character: "ada", call_type: workflow, thinking_enabled: false,
      } });
      const dependencies = deps(provider, { providers: { claude_agent: provider }, env: {} });
      if (workflow === "chat" || workflow === "subagent") {
        await runGeneration(req, { providerKey: "claude-code" }, dependencies);
      } else if (workflow === "heartbeat") {
        await generate(req, dependencies);
      } else {
        await compactionGenerate(dependencies)(req, { provider_key: "claude-code" }, "ada");
      }
      expect(keys).toEqual([""]);
      expect(req.context?.workspace_dir).toBe(join(ACCOUNTING_ROOT, "characters", "ada", "workspace"));
    });
  }

  test("a keepalive ping runs in the workspace its chat turn did", () => {
    const ping = request({ sdk: "claude_agent", provider_key: "claude-code", api_key: "", context: {
      character: "ada", call_type: "keepalive", thinking_enabled: false,
    } });
    expect(withWorkspaceDir(ping, config()).context?.workspace_dir)
      .toBe(join(ACCOUNTING_ROOT, "characters", "ada", "workspace"));
    expect(ping.context?.workspace_dir).toBeUndefined();
    const other = request({ context: { character: "ada", call_type: "keepalive", thinking_enabled: false } });
    expect(withWorkspaceDir(other, config())).toBe(other);
  });

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

  test("a provider error event rejects the generation", async () => {
    const provider = recordingProvider([]);
    provider.stream = async function* () {
      yield { type: "text", text: "partial" };
      yield { type: "error", message: "provider failed", usage: ok().usage, timing: ok().timing };
    };
    expect(await rejectionOf(runGeneration(request(), { providerKey: "anthropic" }, deps(provider)))).toMatchObject({ kind: "stream_errored" });
  });
});

function badRequest(): LlmError {
  return { kind: "http_status", status: 400, body: "bad request" };
}

describe("finding the model a request was built from", () => {
  test("matches on id, sdk and provider", () => {
    expect(resolveModelForRequest(config(), request())?.name).toBe("sonnet");
  });

  test("a request with no provider key matches on id and sdk alone", () => {
    const req = request();
    delete (req as { provider_key?: string }).provider_key;
    expect(resolveModelForRequest(config(), req)?.name).toBe("sonnet");
  });

  test("a different sdk is a different model", () => {
    expect(resolveModelForRequest(config(), request({ sdk: "openai" }))).toBeUndefined();
  });

  test("a different provider is a different model", () => {
    expect(resolveModelForRequest(config(), request({ provider_key: "openrouter" }))).toBeUndefined();
  });

  test("a model the catalog has never heard of is not an error", () => {
    expect(resolveModelForRequest(config(), request({ model: "dyn-model" }))).toBeUndefined();
  });
});

describe("rotating through a provider's keys", () => {
  test("uses the first key and reports no rotation when it works", async () => {
    const keys: string[] = [];
    const out = await generateWithCredentialFallback(
      request(),
      required(resolveModelForRequest(config(), request())),
      deps(recordingProvider(keys)),
    );

    expect(keys).toEqual(["primary-secret"]);
    expect(out.fallbacks).toEqual([]);
    expect(out.response.content).toBe("hello");
  });

  test("rotates to the spare when the first key is refused, and says so", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, (n) => (n === 0 ? unauthorized() : ok()));

    const out = await generateWithCredentialFallback(
      request(),
      required(resolveModelForRequest(config(), request())),
      deps(provider),
    );

    expect(keys).toEqual(["primary-secret", "spare-secret"]);
    expect(out.fallbacks.length).toBe(1);
    expect(out.fallbacks[0]?.from.name).toBe("primary");
    expect(out.fallbacks[0]?.to?.name).toBe("spare");
    expect(out.fallbacks[0]?.warning).toBeDefined();
  });

  test("the request carries the key it actually ran with", async () => {
    const keys: string[] = [];
    const req = request();
    const provider = recordingProvider(keys, (n) => (n === 0 ? unauthorized() : ok()));

    await generateWithCredentialFallback(req, required(resolveModelForRequest(config(), req)), deps(provider));

    expect(req.api_key).toBe("spare-secret");
  });

  test("names the key in the call context so the ledger row attributes it", async () => {
    const seen: (string | undefined)[] = [];
    const req = request({
      context: { character: "ada", call_type: "heartbeat", thinking_enabled: false },
    });
    const provider = {
      generate: async (r: SidecarRequest) => {
        seen.push(r.context?.api_key_name);
        return ok();
      },
      stream: async function* (r: SidecarRequest) {
        seen.push(r.context?.api_key_name);
        yield { type: "start", model: ok().model };
        yield { ...ok(), type: "done" };
      },
    } as SidecarProvider;

    await generateWithCredentialFallback(req, required(resolveModelForRequest(config(), req)), deps(provider));

    expect(seen).toEqual(["primary"]);
  });

  test("a failure no other key can fix is not rotated past", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, () => badRequest());

    expect(
      await outcomeOf(generateWithCredentialFallback(
        request(),
        required(resolveModelForRequest(config(), request())),
        deps(provider),
      )),
    ).toThrow();

    expect(new Set(keys)).toEqual(new Set(["primary-secret"]));
  });

  test("a disabled provider is refused rather than run on the seed key", async () => {
    const keys: string[] = [];
    const disabled = config();
    disabled.providers = ProviderRegistry.fromSection({
      anthropic: { enabled: false, api_key_env: PRIMARY },
    });

    expect(
      await rejectionOf(generateWithCredentialFallback(
        request(),
        required(resolveModelForRequest(disabled, request())),
        deps(recordingProvider(keys), { config: disabled }),
      )),
    ).toBeDefined();

    expect(keys).toEqual([]);
  });

  test("a provider with no key at all is refused before any call", async () => {
    const keys: string[] = [];

    expect(
      await outcomeOf(generateWithCredentialFallback(
        request(),
        required(resolveModelForRequest(config(), request())),
        deps(recordingProvider(keys), { env: {} }),
      )),
    ).toThrow();

    expect(keys).toEqual([]);
  });
});

describe("calling the model", () => {
  test("a catalog model rotates", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, (n) => (n === 0 ? unauthorized() : ok()));

    const out = await generate(request(), deps(provider));

    expect(out.fallbacks.length).toBe(1);
  });

  test("a model the catalog cannot place runs on the key it was built with", async () => {
    const keys: string[] = [];
    const out = await generate(request({ model: "dyn-model" }), deps(recordingProvider(keys)));

    expect(keys).toEqual(["seed"]);
    expect(out.fallbacks).toEqual([]);
  });

  test("an unplaceable model that fails does not rotate", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, () => unauthorized());

    expect(await outcomeOf(generate(request({ model: "dyn-model" }), deps(provider)))).toThrow();

    expect(keys).toEqual(["seed"]);
  });

  test("a request the cache left keyless is given the provider's key, not called empty", async () => {
    const keys: string[] = [];
    const out = await generate(
      request({ model: "dyn-model", api_key: "" }),
      deps(recordingProvider(keys)),
    );

    expect(keys).toEqual(["primary-secret"]);
    expect(out.fallbacks).toEqual([]);
  });

  test("a keyless request rotates through the provider's keys like any other", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, (n) => (n === 0 ? unauthorized() : ok()));

    const out = await generate(request({ model: "dyn-model", api_key: "" }), deps(provider));

    expect(keys).toEqual(["primary-secret", "spare-secret"]);
    expect(out.fallbacks.length).toBe(1);
  });

  test("an sdk with no adapter is a plain failure", async () => {
    expect(
      await outcomeOf(generate(request({ sdk: "gemini", model: "dyn-model" }), deps(recordingProvider([])))),
    ).toThrow("unsupported sdk: gemini");
  });
});

function freshLedger(): string {
  const path = join(mkdtempSync(testTmp("shore-gen-ledger-")), "ledger.db");
  Ledger.create(path).close();
  return path;
}

describe("the ledger row", () => {
  const withLedger = (path: string): SidecarRequest =>
    request({
      context: {
        ledger: path,
        character: "ada",
        call_type: "heartbeat",
        thinking_enabled: false,
      },
    });

  test("a successful call leaves one row naming the key it ran on", async () => {
    const path = freshLedger();

    await generate(withLedger(path), deps(recordingProvider([])));

    const rows = rowsIn(path);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      character: "ada",
      call_type: "heartbeat",
      provider: "anthropic",
      api_key_name: "primary",
      finish_reason: "end_turn",
    });
    const ledger = Ledger.open(path);
    expect(ledger.database.query(
      "SELECT status, call_id FROM call_attempts",
    ).get()).toMatchObject({ status: "completed", call_id: required(rows[0]).id });
    ledger.close();
  });

  test("a failed call still leaves a row", async () => {
    const path = freshLedger();
    const provider = recordingProvider([], () => badRequest());

    expect(await rejectionOf(generate(withLedger(path), deps(provider)))).toBeDefined();

    const rows = rowsIn(path);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ finish_reason: "error", input_tokens: 0 });
    const ledger = Ledger.open(path);
    expect(ledger.database.query("SELECT status FROM call_attempts").get()).toEqual({
      status: "error",
    });
    ledger.close();
  });

  test("a rotation leaves one row per attempt, each naming its own key", async () => {
    const path = freshLedger();
    const provider = recordingProvider([], (n) => (n === 0 ? unauthorized() : ok()));

    await generate(withLedger(path), deps(provider));

    const rows = rowsIn(path);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r["api_key_name"])).toEqual(["primary", "spare"]);
    expect(rows.map((r) => r["finish_reason"])).toEqual(["error", "end_turn"]);
  });
});

describe("the budget gate", () => {
  test("a request with no call context is never gated", async () => {
    const keys: string[] = [];
    await generate(request(), deps(recordingProvider(keys)));
    expect(keys.length).toBe(1);
  });

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


test("tool-bearing generation refuses to run without a tool executor", async () => {
  const keys: string[] = [];
  const failure = await runGeneration(request({ tools: [{ name: "read", description: "read", input_schema: { type: "object" } }] }),
    { providerKey: "anthropic" }, deps(recordingProvider(keys))).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("Tool-capable generation requires a tool executor");
  expect(keys).toEqual([]);
});
