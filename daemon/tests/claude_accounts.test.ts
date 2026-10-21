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
import { runGeneration } from "../src/llm/generate.ts";
import { ClaudeAgentProvider } from "../src/llm/providers/claude_agent.ts";
import type { WireMessage } from "../src/llm/types.ts";
import { startMockAnthropic, type AnthropicRequestRecord, type MockAnthropic } from "../src/testing/mock_anthropic.ts";
import { outcomeOf } from "./support/outcome.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterEach(() => {
  configureClaudePlanLimits();
});

async function signIn(home: string, names: string[]): Promise<void> {
  for (const name of names) {
    const dir = join(claudeAccountsRoot(home), name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: `token-${name}`, refreshToken: `refresh-${name}`, expiresAt: Date.now() + HOUR,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"], subscriptionType: "pro",
    } }));
  }
}

function sessionLimitFor(refusing: readonly string[]) {
  return (request: AnthropicRequestRecord) => refusing.some((name) => request.headers["authorization"] === `Bearer token-${name}`)
    ? {
        status: 429,
        errorBody: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-reset": String(Math.round(Date.now() / 1000) + 3600),
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
  await signIn(home, ["first", "second"]);
  configureClaudePlanLimits({ accounts: ["first", "second"], home, cacheDir: home });
  const mock = await startMockAnthropic({ fallback: sessionLimitFor(["first"]) });
  try {
    const say = conversation(home, mock);
    expect(await say("Hello?")).toBe("Hello from the next account.");
    expect(await say("Still there?")).toBe("Hello from the next account.");

    expect(tokensSeen(mock)).toEqual(["Bearer token-first", "Bearer token-second", "Bearer token-second"]);
    expect((await readFile(claudeAccountInUsePath(home), "utf8")).trim()).toBe("second");
  } finally {
    await mock.stop();
  }
}, 60_000);

test("a reply every account refuses fails with the refusal instead of arriving empty", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, ["first", "second"]);
  configureClaudePlanLimits({ accounts: ["first", "second"], home, cacheDir: home });
  const mock = await startMockAnthropic({ fallback: sessionLimitFor(["first", "second"]) });
  try {
    const say = conversation(home, mock);
    expect(await outcomeOf(say("Hello?"))).toThrow(/usage limit reached: You've hit your session limit/);
    expect(tokensSeen(mock)).toEqual(["Bearer token-first", "Bearer token-second"]);
  } finally {
    await mock.stop();
  }
}, 60_000);

test("shore stays on the account in use while it has room, then moves to the usable account whose week resets soonest", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  const now = Date.now();
  const reading = (used: number, resetsIn: number) => ({ percent_used: used, resets_at: new Date(now + resetsIn).toISOString() });
  const checks: Record<string, ClaudePlanCheck> = {
    busy: { status: "ok", email: "busy@example.com", poll: { subscription_type: "pro", five_hour: reading(0.5, HOUR), seven_day: reading(0.6, 5 * DAY) } },
    soon: { status: "ok", poll: { subscription_type: "pro", five_hour: reading(0, HOUR), seven_day: reading(0.1, 2 * DAY) } },
    gone: { status: "logged_out" },
    later: { status: "ok", poll: { subscription_type: "pro", five_hour: reading(0, HOUR), seven_day: reading(0.2, 4 * DAY) } },
  };
  configureClaudePlanLimits({
    accounts: ["busy", "soon", "gone", "later"], home, cacheDir: home,
    fetch: (account) => Promise.resolve(checks[account.name] ?? { status: "logged_out" }),
  });
  await refreshClaudePlanLimits(0, now);

  expect(claudeAccountOrder(now).map((account) => account.name)).toEqual(["busy", "soon", "later"]);

  observeClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96 }, "busy", now);
  expect(claudeAccountOrder(now).map((account) => account.name)).toEqual(["soon", "later"]);

  const report = claudePlanLimitsReport(undefined, now);
  expect(report?.account).toBe("soon");
  expect(report?.accounts.map((account) => [account.name, account.state, account.in_use])).toEqual([
    ["busy", "limited", false], ["soon", "ok", true], ["gone", "out", false], ["later", "ok", false],
  ]);
  expect(report?.accounts.find((account) => account.name === "gone")?.login_command)
    .toContain(`CLAUDE_CONFIG_DIR=${join(claudeAccountsRoot(home), "gone")} claude auth login`);
});
