import { afterEach, expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import { KeepaliveService, type KeepaliveEvent } from "../src/cache/keepalive.ts";
import { defaultAppConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { loadConfig } from "../src/config/loader.ts";
import { ProviderRegistry } from "../src/config/providers.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps } from "../src/handler/deps.ts";
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
import { createRuntime } from "../src/runtime.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/connection.ts";
import { SessionRouter } from "../src/swp/session.ts";
import type { SidecarRequest, WireMessage } from "../src/llm/types.ts";
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
      messages: [...history], max_tokens: 256, reasoning_replay: "all",
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
      if (!toolResultsSent(request)) return { toolUses: [{ name: "note", input: { text: "groceries" } }], usage: { output_tokens: 40 } };
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
      max_tokens: 256, reasoning_replay: "all",
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
    expect((failure as Error).message).toMatch(/usage limit reached: You.ve hit your /);
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
  expect(report?.accounts.find((account) => account.name === "gone")?.login_command).toBe("shore provider claude_agent auth gone --login");

  await writeFile(join(claudeAccountsRoot(home), "x1", ".claude.json"), "{");
  await signIn(home, "new", "fresh");
  const rescanned = claudeAccountOrder(now + DAY).map((account) => account.name);
  expect(rescanned[0]).toBe("soon@example.com");
  expect(rescanned).toContain("fresh@example.com");
});

test("with every login disabled a reply fails, naming why, without a call", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  const logins = [{ name: "first@example.com", enabled: false, limits: {} }];
  configureClaudePlanLimits({ home, cacheDir: home, settings: () => ({ provider: "claude_agent", logins }) });
  const mock = await startMockAnthropic({ fallback: () => ({ text: "Hello." }) });
  try {
    const failure = await conversation(home, mock)("Hello?").catch((e: unknown) => e);
    expect((failure as Error).message).toContain('"first@example.com": disabled');
    expect(tokensSeen(mock)).toEqual([]);
  } finally {
    await mock.stop();
  }
}, 60_000);

function atWeek(account: string, used: number): void {
  observeClaudeRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: used, resetsAt: Math.floor((Date.now() + DAY) / 1000) }, account);
}

test("a login past its own limit hands the reply to one with room, and with none left the reply is refused, without a call, saying when it frees up", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  const logins = [
    { name: "first@example.com", enabled: true, limits: { weekly: 0.5 } },
    { name: "second@example.com", enabled: true, limits: { weekly: 0.5 } },
  ];
  configureClaudePlanLimits({ home, cacheDir: home, settings: () => ({ provider: "claude_agent", logins }) });
  atWeek("first@example.com", 0.52);
  const mock = await startMockAnthropic({ fallback: () => ({ text: "Hello from the next account." }) });
  try {
    const say = conversation(home, mock);
    expect(await say("Hello?")).toBe("Hello from the next account.");
    expect(tokensSeen(mock)).toEqual(["Bearer token-second"]);

    atWeek("second@example.com", 0.5);
    const failure = await say("Still there?").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("its limit is 50%");
    expect(tokensSeen(mock)).toEqual(["Bearer token-second"]);
    expect(Date.parse(resetAtIn(failure) ?? "")).toBeGreaterThan(Date.now());
  } finally {
    await mock.stop();
  }
}, 60_000);

test("a pinned login takes every reply while others have more room, and at its own limit the reply is refused rather than moved", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  const logins = [{ name: "second@example.com", enabled: true, limits: { weekly: 0.5 } }];
  configureClaudePlanLimits({ home, cacheDir: home, settings: () => ({ provider: "claude_agent", pin: "second@example.com", logins }) });
  atWeek("second@example.com", 0.2);
  atWeek("first@example.com", 0);
  const mock = await startMockAnthropic({ fallback: () => ({ text: "Hello." }) });
  try {
    const say = conversation(home, mock);
    expect(await say("Hello?")).toBe("Hello.");
    expect(tokensSeen(mock)).toEqual(["Bearer token-second"]);

    atWeek("second@example.com", 0.5);
    const failure = await say("Still there?").catch((e: unknown) => e);
    expect((failure as Error).message).toContain("its limit is 50%");
    expect(tokensSeen(mock)).toEqual(["Bearer token-second"]);
  } finally {
    await mock.stop();
  }
}, 60_000);

test("a keepalive ping on a login checks that login's usage first, and is skipped once the login is past its own limit, on schedule or on demand", async () => {
  for (const how of ["tick", "now"] as const) {
    const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
    await signIn(home, "qwfp", "first");
    const now = Date.now();
    const reading = (used: number, resetsIn: number) => ({ percent_used: used, resets_at: new Date(now + resetsIn).toISOString() });
    configureClaudePlanLimits({
      home, cacheDir: home,
      settings: () => ({ provider: "claude_agent", logins: [{ name: "first@example.com", enabled: true, limits: { weekly: 0.5 } }] }),
      fetch: () => Promise.resolve({ status: "ok", poll: { subscription_type: "pro", five_hour: reading(0, HOUR), seven_day: reading(0.6, 2 * DAY) } }),
    });
    const sent: SidecarRequest[] = [];
    let clock = now;
    const keepalive = new KeepaliveService(async (request) => {
      sent.push(request);
      return { content: "", content_blocks: [], finish_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 100, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 }, model: "claude-opus-5-5" };
    }, () => clock);
    const events: KeepaliveEvent[] = [];
    keepalive.onEvent((event) => events.push(event));
    keepalive.arm({
      sdk: "claude_agent", model: "claude-opus-5-5", api_key: "", max_tokens: 1, reasoning_replay: "all",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: [{ type: "text", text: "hi" }] }],
      keepalive_interval_ms: 55 * 60_000, keepalive_pings: 3,
      context: { character: "ada", call_type: "message", thinking_enabled: false, api_key_name: "first@example.com" },
    }, true);
    if (how === "tick") {
      clock += 56 * 60_000;
      await keepalive.tick();
      expect(events.map((event) => event.outcome)).toEqual(["skipped"]);
      expect(events[0]?.detail).toContain("first@example.com weekly limit");
    } else {
      const outcome = await keepalive.pingNow("ada");
      expect([outcome.status, outcome.reason]).toEqual(["skipped", "budget"]);
      expect(outcome.detail).toContain("first@example.com weekly limit");
    }
    expect(sent).toEqual([]);
  }
});

test("a login with no limit of its own stays usable past the switch points when no other login has room", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  configureClaudePlanLimits({ home, cacheDir: home });
  atWeek("first@example.com", 0.99);
  atWeek("second@example.com", 0.99);
  const mock = await startMockAnthropic({ fallback: () => ({ text: "Still going." }) });
  try {
    expect(await conversation(home, mock)("Hello?")).toBe("Still going.");
    expect(tokensSeen(mock)).toHaveLength(1);
  } finally {
    await mock.stop();
  }
}, 60_000);

test("a reply that crosses its login's own limit partway finishes on that login, with all its tool calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "shore-accounts-"));
  await signIn(home, "qwfp", "first");
  await signIn(home, "arst", "second");
  const logins = [{ name: "first@example.com", enabled: true, limits: { weekly: 0.5 } }];
  configureClaudePlanLimits({ home, cacheDir: home, settings: () => ({ provider: "claude_agent", logins }) });
  atWeek("first@example.com", 0.1);
  atWeek("second@example.com", 0.1);
  const results = (request: AnthropicRequestRecord): number => (JSON.stringify(request.body.messages).match(/noted: /g) ?? []).length;
  const mock = await startMockAnthropic({
    fallback: (request) => results(request) < 2
      ? { toolUses: [{ id: `toolu_round_${String(results(request))}`, name: "note", input: { text: `round ${String(results(request))}` } }] }
      : { text: "All noted." },
  });
  const ran: unknown[] = [];
  try {
    const provider = new ClaudeAgentProvider({
      bookPath: () => join(home, "sessions.json"),
      runQuery: (params) => query({ ...params, options: { ...params.options, env: { ...params.options.env, HOME: home } } }),
    });
    const { result } = await runGeneration({
      sdk: "claude_agent", api_key: "", base_url: mock.url, model: "claude-opus-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "Note twice." }] }],
      max_tokens: 256, reasoning_replay: "all",
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
      sink: () => {},
      tools: {
        messages: [],
        runTool: (use) => {
          ran.push(use.input);
          atWeek("first@example.com", 0.9);
          return Promise.resolve({ type: "tool_result", tool_use_id: use.id, content: `noted: ${String(ran.length)}` });
        },
        recordTurn: () => {},
      },
    });

    expect(result.content).toBe("All noted.");
    expect(ran).toHaveLength(2);
    expect(new Set(tokensSeen(mock))).toEqual(new Set(["Bearer token-first"]));
    expect(claudeAccountOrder().map((account) => account.name)).toEqual(["second@example.com"]);
  } finally {
    await mock.stop();
  }
}, 60_000);

test("the budget report carries the Claude plan's limits when the conversation's model runs on the Claude subscription, and leaves them out for any other model", async () => {
  const root = await mkdtemp(join(tmpdir(), "shore-plan-report-"));
  const now = Date.now();
  const reading = (used: number, resetsIn: number) => ({ percent_used: used, resets_at: new Date(now + resetsIn).toISOString() });
  await signIn(root, "main", "ada");
  const reported: unknown[] = [];
  for (const model of ["claude_agent:claude-x", "openai:gpt-x"]) {
    const home = join(root, model.replace(":", "-"));
    await mkdir(join(home, "config", "characters", "ada", "workspace"), { recursive: true });
    await writeFile(join(home, "config", "characters", "ada", "workspace", "SOUL.md"), "Ada");
    await writeFile(join(home, "config", "config.toml"), [
      "[providers.claude_agent]", "[providers.openai]", 'api_key_env = "SHORE_TEST_PLAN_REPORT_KEY"',
      "[chat]", `model = "${model}"`, '[chat."claude_agent:claude-x"]', "max_output_tokens = 100", '[chat."openai:gpt-x"]', "max_output_tokens = 100", "",
    ].join("\n"));
    const config = loadConfig(join(home, "config", "config.toml"), {
      env: { SHORE_CONFIG_DIR: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: join(home, "run") },
      onWarn: () => {},
    });
    const runtime = await createRuntime({ config, providers: {}, env: {} });
    const commands = buildCommandPathDeps({
      runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(),
      router: new SessionRouter(), handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env: {},
    });
    try {
      configureClaudePlanLimits({
        home: root, cacheDir: root,
        fetch: () => Promise.resolve({ status: "ok", poll: { subscription_type: "pro", five_hour: reading(0.5, HOUR), seven_day: reading(0.6, 5 * DAY) } }),
      });
      await refreshClaudePlanLimits(0, now);
      const reply = await dispatchCommand(commands, { name: "usage", args: { budget: true } }, {
        session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: null },
        rid: "usage",
        kind: "command",
      });
      if (reply.type !== "command_output") throw new Error(`usage answered ${reply.type}`);
      const report = reply.data as { mode: string; claude_plan_limits?: { windows: { window: string; percent_used: number }[] } };
      reported.push([report.mode, report.claude_plan_limits?.windows.map((limit) => [limit.window, limit.percent_used])]);
    } finally {
      await runtime.autonomy.shutdown();
      await runtime.shutdown();
    }
  }
  expect(reported).toEqual([["budget", [["five_hour", 0.5], ["seven_day", 0.6]]], ["budget", undefined]]);
});
