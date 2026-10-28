import { afterEach, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import {
  claudeAccountInUsePath,
  claudeAccountOrder,
  claudePlanLimitsReport,
  configureClaudePlanLimits,
  observeClaudeRateLimit,
  refreshClaudePlanLimits,
  type ClaudePlanCheck,
} from "../src/ledger/plan_limits.ts";
import { claudeAccountsRoot } from "../src/llm/claude_accounts.ts";
import { resetAtIn } from "../src/llm/errors.ts";
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import type { WireMessage } from "../src/llm/types.ts";
import { startMockAnthropic, type AnthropicRequestRecord, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import { required } from "../src/util/required.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterEach(() => {
  configureClaudePlanLimits();
});

async function signIn(home: string, folder: string, name: string): Promise<void> {
  const dir = join(claudeAccountsRoot(home), folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: `${name}@example.com` } }));
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: `token-${name}`, refreshToken: `refresh-${name}`, expiresAt: Date.now() + HOUR,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"], subscriptionType: "pro",
  } }));
}

function sessionLimitFor(refusing: readonly string[]) {
  return (request: AnthropicRequestRecord) => refusing.some((name) => request.headers["authorization"] === `Bearer token-${name}`)
    ? {
        status: 429,
        errorBody: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
        },
      }
    : { text: "Hello from the next account." };
}

function tokensSeen(mock: MockAnthropic): string[] {
  return mock.requests.map((request) => request.headers["authorization"] ?? "");
}

function conversation(home: string, mock: MockAnthropic): (text: string) => Promise<string> {
  const provider = new ClaudeAgentProvider({
    bookPath: () => join(home, "sessions.json"),
    runQuery: (params) => query({ ...params, options: { ...params.options, env: { ...params.options.env, HOME: home } } }),
  });
  const deps = {
    config: {
      app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
      dirs: { config: home, data: home, cache: home, runtime: home },
    },
    providers: { claude_agent: provider },
    retry: { maxRetries: 0, backoffBaseMs: 0 },
  };
  const history: WireMessage[] = [];
  return async (text) => {
    history.push({ role: "user", content: [{ type: "text", text }] });
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "claude-opus-5-5",
      messages: [...history], max_tokens: 256, replay_prior_thinking: "all",
      context: { character: "ada", workspace_dir: home, thinking_enabled: false, call_type: "message" },
    }, { providerKey: "claude_agent" }, deps, { signal: AbortSignal.timeout(30_000), sink: () => {} });
    history.push({ role: "assistant", content: [{ type: "text", text: result.content }] });
    return result.content;
  };
}

test("a reply one account refuses for its usage limit is answered by the next, which later replies keep using, each on its own login", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  configureClaudePlanLimits({ home, cacheDir: home });
  const mock = await startMockAnthropic({ fallback: sessionLimitFor(["first"]) });
  try {
    const say = conversation(home, mock);
    expect(await say("Hello?")).toBe("Hello from the next account.");
    expect(await say("Still there?")).toBe("Hello from the next account.");

    expect(tokensSeen(mock)).toEqual(["Bearer token-first", "Bearer token-second", "Bearer token-second"]);
    expect((await readFile(claudeAccountInUsePath(home), "utf8")).trim()).toBe("second@example.com");
  } finally {
    await mock.stop();
  }
}, 60_000);

test("a tool-using reply whose account hits its limit partway through carries on with the next account from the rounds already done", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  configureClaudePlanLimits({ home, cacheDir: home });
  const toolResultsSent = (request: AnthropicRequestRecord): boolean => JSON.stringify(request.body.messages).includes("noted: groceries");
  const mock = await startMockAnthropic({
    fallback: (request) => {
      if (request.headers["authorization"] === "Bearer token-second") return { text: "Done on the next account." };
      if (!toolResultsSent(request)) return { toolUses: [{ name: "mcp__shore__note", input: { text: "groceries" } }], usage: { output_tokens: 40 } };
      return sessionLimitFor(["first"])(request);
    },
  });
  const ran: unknown[] = [];
  const warnings: string[] = [];
  try {
    const provider = new ClaudeAgentProvider({
      bookPath: () => join(home, "sessions.json"),
      runQuery: (params) => query({ ...params, options: { ...params.options, env: { ...params.options.env, HOME: home } } }),
    });
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "Note groceries, then tell me." }] }],
      max_tokens: 256, replay_prior_thinking: "all",
      tools: [{ name: "note", description: "Write a note.", input_schema: { type: "object", properties: { text: { type: "string" } } } }],
      context: { character: "ada", workspace_dir: home, thinking_enabled: false, call_type: "message" },
    }, { providerKey: "claude_agent" }, {
      config: {
        app: defaultAppConfig(), models: emptyCatalog(), providers: ProviderRegistry.empty(), rawTable: undefined,
        dirs: { config: home, data: home, cache: home, runtime: home },
      },
      providers: { claude_agent: provider },
      retry: { maxRetries: 0, backoffBaseMs: 0 },
    }, {
      signal: AbortSignal.timeout(30_000),
      sink: (frame) => { if (frame.type === "provider_warning") warnings.push(frame.message); },
      tools: {
        messages: [],
        runTool: (use) => {
          ran.push(use.input);
          return Promise.resolve({ type: "tool_result", tool_use_id: use.id, content: "noted: groceries" });
        },
        recordTurn: () => {},
      },
    });

    expect(result.content).toBe("Done on the next account.");
    expect(ran).toEqual([{ text: "groceries" }]);
    expect(tokensSeen(mock)).toEqual(["Bearer token-first", "Bearer token-first", "Bearer token-second"]);
    expect(toolResultsSent(required(mock.requests[2]))).toBe(true);
    expect(result.usage.output_tokens).toBeGreaterThanOrEqual(40);
    expect(warnings.join("\n")).toContain("carrying on with second@example.com");
    expect((await readFile(claudeAccountInUsePath(home), "utf8")).trim()).toBe("second@example.com");
  } finally {
    await mock.stop();
  }
}, 60_000);

test("a reply every account refuses fails with the refusal, saying when the first account frees up", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  configureClaudePlanLimits({ home, cacheDir: home });
  const mock = await startMockAnthropic({ fallback: sessionLimitFor(["first", "second"]) });
  try {
    const say = conversation(home, mock);
    const failure = await say("Hello?").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/usage limit reached: You've hit your session limit/);
    expect(tokensSeen(mock)).toEqual(["Bearer token-first", "Bearer token-second"]);
    const freeAt = Date.parse(resetAtIn(failure) ?? "");
    expect(freeAt).toBeGreaterThan(Date.now());
    expect(freeAt).toBeLessThanOrEqual(Date.now() + HOUR);
  } finally {
    await mock.stop();
  }
}, 60_000);

test("shore stays on the account in use while it has room, then moves to the usable account whose week resets soonest, and takes in logins added later", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  const now = Date.now();
  const reading = (used: number, resetsIn: number) => ({ percent_used: used, resets_at: new Date(now + resetsIn).toISOString() });
  const checks: Record<string, ClaudePlanCheck> = {
    "busy@example.com": { status: "ok", poll: { subscription_type: "pro", five_hour: reading(0.5, HOUR), seven_day: reading(0.6, 5 * DAY) } },
    "soon@example.com": { status: "ok", poll: { subscription_type: "pro", five_hour: reading(0, HOUR), seven_day: reading(0.1, 2 * DAY) } },
    "later@example.com": { status: "ok", poll: { subscription_type: "pro", five_hour: reading(0, HOUR), seven_day: reading(0.2, 4 * DAY) } },
  };
  await signIn(home, "zzz", "busy");
  await signIn(home, "x1", "soon");
  await signIn(home, "keysmash", "later");
  await mkdir(join(claudeAccountsRoot(home), "gone"));
  configureClaudePlanLimits({
    home, cacheDir: home,
    fetch: (account) => Promise.resolve(checks[account.name] ?? { status: "logged_out" }),
  });
  await refreshClaudePlanLimits(0, now);

  expect(claudeAccountOrder(now).map((account) => account.name)).toEqual(["busy@example.com", "soon@example.com", "later@example.com"]);

  observeClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96 }, "busy@example.com", now);
  expect(claudeAccountOrder(now).map((account) => account.name)).toEqual(["soon@example.com", "later@example.com"]);

  const report = claudePlanLimitsReport(undefined, now);
  expect(report?.account).toBe("soon@example.com");
  expect(report?.accounts.map((account) => [account.name, account.state, account.in_use])).toEqual([
    ["busy@example.com", "limited", false], ["gone", "out", false], ["later@example.com", "ok", false], ["soon@example.com", "ok", true],
  ]);
  expect(report?.accounts.find((account) => account.name === "gone")?.login_command)
    .toContain(`CLAUDE_CONFIG_DIR=${join(claudeAccountsRoot(home), "gone")} claude auth login`);

  await writeFile(join(claudeAccountsRoot(home), "x1", ".claude.json"), "{");
  await signIn(home, "new", "fresh");
  const rescanned = claudeAccountOrder(now + DAY).map((account) => account.name);
  expect(rescanned[0]).toBe("soon@example.com");
  expect(rescanned).toContain("fresh@example.com");
});
