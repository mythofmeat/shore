/**
 * The non-streaming provider call, with rotation and a ledger row around it.
 *
 * This is the seam three background passes have been carrying an injected stub
 * for, so what it has to get right is the things a stub never exercised:
 *
 * - **A rotation is reported, not logged.** A heartbeat folds rotations into
 *   its ring buffer and a chat turn sends them to the client; neither is this
 *   module's call, so both come back to the caller.
 * - **The ledger row exists whether or not the call worked.** A ledger with
 *   holes reads as a quiet period rather than as a provider that is down.
 * - **A model the static catalog cannot place still runs.** Discovered models
 *   and `provider:model_id` pins are not in it, and refusing a request that is
 *   already carrying a working key would take out exactly the configurations
 *   the effective catalog exists to support.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BudgetBlocked,
  generate,
  generateWithCredentialFallback,
  resolveModelForRequest,
  type GenerateDeps,
} from "../src/llm/generate.ts";
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

afterEach(() => {
  closeLedgers();
});

const ACCOUNTING_ROOT = mkdtempSync(join(tmpdir(), "shore-llm-generate-"));
afterAll(() => rmSync(ACCOUNTING_ROOT, { recursive: true, force: true }));

// ── harness ─────────────────────────────────────────────────────────────

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

/** Two keys under one provider, so a rotation has somewhere to go. */
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

/** An adapter that records the key each attempt ran with. */
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
    stream: () => {
      throw new Error("not used");
    },
  } as SidecarProvider;
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

/**
 * A 401, which is what a bad key looks like coming back from a provider.
 *
 * An `LlmError` is a plain discriminated union, not an `Error` subclass — the
 * classifier reads `kind`, and a thrown `Error` with the fields bolted on is
 * unclassifiable and therefore unrotatable.
 */
function unauthorized(): LlmError {
  return { kind: "http_status", status: 401, body: "unauthorized" };
}

/** A 400 — malformed request, which no other credential can fix. */
function badRequest(): LlmError {
  return { kind: "http_status", status: 400, body: "bad request" };
}

// ── placing the request in the catalog ──────────────────────────────────

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

// ── rotation ────────────────────────────────────────────────────────────

describe("rotating through a provider's keys", () => {
  test("uses the first key and reports no rotation when it works", async () => {
    const keys: string[] = [];
    const out = await generateWithCredentialFallback(
      request(),
      resolveModelForRequest(config(), request())!,
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
      resolveModelForRequest(config(), request())!,
      deps(provider),
    );

    // Straight to the spare, with no backoff spent first: the retry layer
    // classifies a credential-shaped failure and fails fast precisely so the
    // rotation happens immediately. Retrying a bad key is pure latency.
    expect(keys).toEqual(["primary-secret", "spare-secret"]);
    expect(out.fallbacks.length).toBe(1);
    expect(out.fallbacks[0]?.from.name).toBe("primary");
    expect(out.fallbacks[0]?.to?.name).toBe("spare");
    // The abandoned key opted into visibility, so there is a sentence to show.
    expect(out.fallbacks[0]?.warning).toBeDefined();
  });

  test("the request carries the key it actually ran with", async () => {
    const keys: string[] = [];
    const req = request();
    const provider = recordingProvider(keys, (n) => (n === 0 ? unauthorized() : ok()));

    await generateWithCredentialFallback(req, resolveModelForRequest(config(), req)!, deps(provider));

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
      stream: () => {
        throw new Error("not used");
      },
    } as SidecarProvider;

    await generateWithCredentialFallback(req, resolveModelForRequest(config(), req)!, deps(provider));

    expect(seen).toEqual(["primary"]);
  });

  test("a failure no other key can fix is not rotated past", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, () => badRequest());

    await expect(
      generateWithCredentialFallback(
        request(),
        resolveModelForRequest(config(), request())!,
        deps(provider),
      ),
    ).rejects.toThrow();

    // One key tried, not both. Rotating on a 400 burns every credential on a
    // request that was malformed to begin with.
    expect(new Set(keys)).toEqual(new Set(["primary-secret"]));
  });

  /**
   * `enabled = false` must be uniformly unreferenceable. Falling back to the
   * request's own key here would quietly re-enable a provider the user turned
   * off — and the request always carries one, because it was built before the
   * registry was consulted.
   */
  test("a disabled provider is refused rather than run on the seed key", async () => {
    const keys: string[] = [];
    const disabled = config();
    disabled.providers = ProviderRegistry.fromSection({
      anthropic: { enabled: false, api_key_env: PRIMARY },
    });

    await expect(
      generateWithCredentialFallback(
        request(),
        resolveModelForRequest(disabled, request())!,
        deps(recordingProvider(keys), { config: disabled }),
      ),
    ).rejects.toBeDefined();

    expect(keys).toEqual([]);
  });

  test("a provider with no key at all is refused before any call", async () => {
    const keys: string[] = [];

    await expect(
      generateWithCredentialFallback(
        request(),
        resolveModelForRequest(config(), request())!,
        deps(recordingProvider(keys), { env: {} }),
      ),
    ).rejects.toThrow();

    expect(keys).toEqual([]);
  });
});

// ── the outer call ──────────────────────────────────────────────────────

describe("calling the model", () => {
  test("a catalog model rotates", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, (n) => (n === 0 ? unauthorized() : ok()));

    const out = await generate(request(), deps(provider));

    expect(out.fallbacks.length).toBe(1);
  });

  /**
   * Discovered models and `provider:model_id` pins are not in the static
   * catalog. Refusing them would take out exactly the configurations the
   * effective catalog exists to support.
   */
  test("a model the catalog cannot place runs on the key it was built with", async () => {
    const keys: string[] = [];
    const out = await generate(request({ model: "dyn-model" }), deps(recordingProvider(keys)));

    expect(keys).toEqual(["seed"]);
    expect(out.fallbacks).toEqual([]);
  });

  test("an unplaceable model that fails does not rotate", async () => {
    const keys: string[] = [];
    const provider = recordingProvider(keys, () => unauthorized());

    await expect(generate(request({ model: "dyn-model" }), deps(provider))).rejects.toThrow();

    expect(keys).toEqual(["seed"]);
  });

  test("an sdk with no adapter is a plain failure", async () => {
    await expect(
      generate(request({ sdk: "gemini", model: "dyn-model" }), deps(recordingProvider([]))),
    ).rejects.toThrow("unsupported sdk: gemini");
  });
});

// ── the ledger row ──────────────────────────────────────────────────────

/** A ledger this side created, which is the point: nothing else does now. */
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
    ).get()).toMatchObject({ status: "completed", call_id: rows[0]!.id });
    ledger.close();
  });

  test("a failed call still leaves a row", async () => {
    const path = freshLedger();
    const provider = recordingProvider([], () => badRequest());

    await expect(generate(withLedger(path), deps(provider))).rejects.toBeDefined();

    const rows = rowsIn(path);
    // A ledger with holes in it reads as a quiet period rather than as a
    // provider that is refusing every request.
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

// ── the budget gate ─────────────────────────────────────────────────────

describe("the budget gate", () => {
  test("a request with no call context is never gated", async () => {
    const keys: string[] = [];
    await generate(request(), deps(recordingProvider(keys)));
    expect(keys.length).toBe(1);
  });

  test("a budget that is already blown refuses the call before the provider", async () => {
    const path = freshLedger();
    const keys: string[] = [];
    // One $5 call already on the books, stamped now — the window is relative to
    // the clock, so a row outside the current period would correctly allow it.
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

    await expect(generate(req, deps(recordingProvider(keys)))).rejects.toBeInstanceOf(BudgetBlocked);

    // Nothing reached the provider, and the refusal is not itself a call.
    expect(keys).toEqual([]);
    expect(rowsIn(path).length).toBe(1);
  });
});
