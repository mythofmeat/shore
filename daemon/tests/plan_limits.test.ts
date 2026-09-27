import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultAppConfig, defaultPlanLimitsConfig, type PlanLimitsConfig } from "../src/config/app.ts";
import { emptyCatalog } from "../src/config/models.ts";
import { DEFAULT_SUBSCRIPTION_PROVIDERS, ProviderRegistry } from "../src/config/providers.ts";
import type { CommandDeps, CommandSession } from "../src/commands/dispatch.ts";
import { commandOperations } from "../src/commands/registry.ts";
import type { UsageConfig } from "../src/ledger/budget.ts";
import { budgetBlockFor } from "../src/ledger/gate.ts";
import {
  CLAUDE_PLAN_REFRESH_MS,
  claudePlanLimitsPath,
  claudePlanLimitsReport,
  claudePlanLimitsState,
  configureClaudePlanLimits,
  newlyCrossedPlanLimitWarnings,
  observeClaudeRateLimit,
  readClaudePlanLimits,
  refreshClaudePlanLimits,
  type ClaudePlanPoll,
  type ClaudePlanReading,
} from "../src/ledger/plan_limits.ts";
import { closeLedgers, prepareCallAccounting } from "../src/ledger/record.ts";
import { Ledger, isSubscriptionCall, setSubscriptionProviders } from "../src/ledger/store.ts";
import { usageReport } from "../src/ledger/usage.ts";
import { toRfc3339 } from "../src/ledger/zoned.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import type { UsageResult } from "../src/protocol/UsageResult.ts";
import { freshLedger, openLedger } from "./support/ledger_fixture.ts";
import { testTmp } from "./support/tmp.ts";

const NOW = Date.parse("2026-09-27T06:00:00.000Z");
const FIVE_RESET = "2026-09-27T09:00:00+00:00";
const WEEK_RESET = "2026-10-02T03:00:00+00:00";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  configureClaudePlanLimits();
  closeLedgers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(testTmp("shore-plan-limits-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function ledger(): string {
  const fixture = freshLedger();
  cleanups.push(fixture.cleanup);
  return fixture.path;
}

const reading = (percent_used: number, resets_at: string | null = FIVE_RESET): ClaudePlanReading => ({ percent_used, resets_at });

const poll = (five: number, week: number): ClaudePlanPoll => ({
  subscription_type: "max",
  five_hour: reading(five, FIVE_RESET),
  seven_day: reading(week, WEEK_RESET),
});

async function seed(reported: ClaudePlanPoll, now = NOW): Promise<void> {
  configureClaudePlanLimits({ fetch: () => Promise.resolve(reported) });
  await refreshClaudePlanLimits(0, now);
}

function counting(reported: () => Promise<ClaudePlanPoll | undefined>): { calls: number; fetch: () => Promise<ClaudePlanPoll | undefined> } {
  const counter = {
    calls: 0,
    fetch: () => {
      counter.calls += 1;
      return reported();
    },
  };
  return counter;
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function policy(overrides: Partial<PlanLimitsConfig>): UsageConfig {
  return { timezone: "utc", plan_limits: { ...defaultPlanLimitsConfig(), ...overrides } };
}

function claudeCall(call_type: string, usage?: UsageConfig, sdk = "claude_agent"): SidecarRequest {
  return {
    sdk,
    model: "claude-opus-5",
    api_key: "",
    provider_key: sdk,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 128,
    replay_prior_thinking: "all",
    context: {
      character: "aria",
      call_type,
      api_key_name: "subscription",
      thinking_enabled: false,
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SidecarRequest;
}

describe("Claude plan readings", () => {
  test("a stale reading is polled once, cached, and still known after a restart", async () => {
    const dir = await scratch();
    const probe = counting(() => Promise.resolve(poll(0.2, 0.3)));
    configureClaudePlanLimits({ cacheDir: dir, fetch: probe.fetch });

    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW);
    expect(probe.calls).toBe(1);
    const polled = claudePlanLimitsState();
    expect(polled).toMatchObject({ polled_at: toRfc3339(NOW), subscription_type: "max", five_hour: reading(0.2), seven_day: reading(0.3, WEEK_RESET) });

    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW + 60_000);
    expect(probe.calls, "a fresh reading is not polled again").toBe(1);
    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW + CLAUDE_PLAN_REFRESH_MS);
    expect(probe.calls).toBe(2);

    const latest = claudePlanLimitsState();
    expect(latest?.polled_at).toBe(toRfc3339(NOW + CLAUDE_PLAN_REFRESH_MS));
    expect(readClaudePlanLimits(claudePlanLimitsPath(dir))).toEqual(latest);
    configureClaudePlanLimits({ cacheDir: dir });
    expect(claudePlanLimitsState(), "a restart reads the cache back").toEqual(latest);
  });

  test("callers that arrive while a poll is running wait for it instead of starting another", async () => {
    const hold = gate();
    const probe = counting(async () => {
      await hold.opened;
      return poll(0.5, 0.5);
    });
    configureClaudePlanLimits({ fetch: probe.fetch });

    const first = refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW);
    const second = refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW);
    hold.open();
    await Promise.all([first, second]);

    expect(probe.calls).toBe(1);
    expect(claudePlanLimitsState()?.five_hour).toEqual(reading(0.5));
  });

  test("a failed poll is not retried until the refresh interval has passed", async () => {
    const probe = counting(() => Promise.reject(new Error("usage endpoint unavailable")));
    configureClaudePlanLimits({ fetch: probe.fetch });

    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW);
    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW + 1_000);
    expect(probe.calls).toBe(1);
    expect(claudePlanLimitsState()).toBeUndefined();

    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW + CLAUDE_PLAN_REFRESH_MS);
    expect(probe.calls).toBe(2);
  });

  test("an account without plan limits leaves the reading unknown", async () => {
    configureClaudePlanLimits({ fetch: () => Promise.resolve(undefined) });
    await refreshClaudePlanLimits(0, NOW);
    expect(claudePlanLimitsState()).toBeUndefined();
    expect(claudePlanLimitsReport(undefined, NOW)).toBeUndefined();
  });

  test("an unreadable cache is treated as missing", async () => {
    const dir = await scratch();
    const path = claudePlanLimitsPath(dir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, updated_at: "yesterday" }));
    configureClaudePlanLimits({ cacheDir: dir });
    expect(claudePlanLimitsState()).toBeUndefined();
  });
});

describe("rate-limit events", () => {
  test("a warning event moves only the window it names", async () => {
    await seed(poll(0.2, 0.3));
    observeClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.85, resetsAt: 1790492400 }, NOW + 1_000);
    expect(claudePlanLimitsState()).toMatchObject({
      updated_at: toRfc3339(NOW + 1_000),
      polled_at: toRfc3339(NOW),
      five_hour: { percent_used: 0.85, resets_at: toRfc3339(1790492400 * 1000) },
      seven_day: reading(0.3, WEEK_RESET),
    });
  });

  test("a rejection marks the window spent even without a figure", async () => {
    await seed(poll(0.2, 0.9));
    observeClaudeRateLimit({ status: "rejected", rateLimitType: "seven_day" }, NOW);
    expect(claudePlanLimitsState()?.seven_day).toEqual(reading(1, WEEK_RESET));
  });

  test("events about other limits, or without a figure, change nothing", async () => {
    await seed(poll(0.2, 0.3));
    const before = claudePlanLimitsState();
    observeClaudeRateLimit({ status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 0.99, resetsAt: 1790492400 }, NOW);
    observeClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1790492400 }, NOW);
    expect(claudePlanLimitsState()).toEqual(before);
  });

  test("an event that arrives while a poll runs is newer than the poll", async () => {
    const hold = gate();
    const probe = counting(async () => {
      if (probe.calls === 1) return poll(0.2, 0.3);
      await hold.opened;
      return poll(0.98, 0.35);
    });
    configureClaudePlanLimits({ fetch: probe.fetch });
    await refreshClaudePlanLimits(0, NOW);

    const polling = refreshClaudePlanLimits(0, NOW + 1_000);
    observeClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour" }, NOW + 2_000);
    hold.open();
    await polling;

    expect(claudePlanLimitsState()?.five_hour?.percent_used, "the rejection stands").toBe(1);
    expect(claudePlanLimitsState()?.seven_day, "a window no event named takes the poll").toEqual(reading(0.35, WEEK_RESET));
  });

  test("an event before any poll starts a reading that a poll still refreshes", async () => {
    const probe = counting(() => Promise.resolve(poll(0.6, 0.4)));
    configureClaudePlanLimits({ fetch: probe.fetch });
    observeClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.5 }, NOW);
    expect(claudePlanLimitsState()).toMatchObject({ polled_at: null, five_hour: reading(0.5, null), seven_day: null });

    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW);
    expect(probe.calls).toBe(1);
    expect(claudePlanLimitsState()?.seven_day).toEqual(reading(0.4, WEEK_RESET));
  });
});

describe("plan limit reports", () => {
  test("both windows report against the default policy", async () => {
    await seed(poll(0.42, 0.85));
    expect(claudePlanLimitsReport(undefined, NOW)).toEqual({
      updated_at: toRfc3339(NOW),
      subscription_type: "max",
      windows: [
        { window: "five_hour", percent_used: 0.42, resets_at: FIVE_RESET, status: "ok", warning_thresholds: [0.8, 0.95], crossed_warn_at: [], limit_at: 1, action: "pause_background", over_limit: false },
        { window: "seven_day", percent_used: 0.85, resets_at: WEEK_RESET, status: "warning", warning_thresholds: [0.8, 0.95], crossed_warn_at: [0.8], limit_at: 1, action: "pause_background", over_limit: false },
      ],
    });
  });

  test("a limit set below the whole window is over once utilization reaches it", async () => {
    await seed(poll(0.1, 0.85));
    const report = claudePlanLimitsReport(policy({ seven_day: { warn_fractions: [0.5], limit_fraction: 0.85, limit_action: "block" } }), NOW);
    expect(report?.windows[1]).toMatchObject({ window: "seven_day", status: "over_limit", over_limit: true, limit_at: 0.85, action: "block", crossed_warn_at: [0.5] });
  });

  test("a window whose reset has passed reads as empty", async () => {
    await seed(poll(0.99, 0.5));
    const later = Date.parse(FIVE_RESET) + 1;
    expect(claudePlanLimitsReport(undefined, later)?.windows[0]).toMatchObject({ window: "five_hour", percent_used: 0, resets_at: null, status: "ok" });
  });
});

describe("the call gate", () => {
  test("on a spent window background Claude calls pause and conversation carries on", async () => {
    await seed(poll(1, 0.3));
    for (const callType of ["heartbeat", "heartbeat_tool_loop", "keepalive", "compaction", "dreaming"]) {
      expect(budgetBlockFor(claudeCall(callType), NOW), callType).toMatchObject({
        budget_name: "Claude 5-hour limit",
        scope: "plan",
        reset_at: FIVE_RESET,
      });
    }
    expect(budgetBlockFor(claudeCall("message"), NOW)).toBeUndefined();
    expect(budgetBlockFor(claudeCall("tool_loop"), NOW)).toBeUndefined();
    expect(budgetBlockFor(claudeCall("heartbeat", { timezone: "utc" }), NOW)?.summary).toBe(
      "Claude 5-hour limit is at 100% (limit 100%, background work paused); resets 2026-09-27 09:00 AM",
    );
  });

  test("a block policy stops conversation too", async () => {
    await seed(poll(0.1, 0.92));
    const usage = policy({ seven_day: { warn_fractions: [0.8], limit_fraction: 0.9, limit_action: "block" } });
    const block = budgetBlockFor(claudeCall("message", usage), NOW);
    expect(block).toMatchObject({ budget_name: "Claude weekly limit", scope: "plan", reset_at: WEEK_RESET });
    expect(block?.message).toBe(
      `Shore plan limit "Claude weekly limit" is at 92% (limit 90%, Claude calls blocked); resets at ${WEEK_RESET}`,
    );
  });

  test("other providers never answer to the Claude plan", async () => {
    await seed(poll(1, 1));
    expect(budgetBlockFor(claudeCall("heartbeat", undefined, "anthropic"), NOW)).toBeUndefined();
  });

  test("a window that has reset lets calls through again", async () => {
    await seed(poll(1, 0.3));
    expect(budgetBlockFor(claudeCall("heartbeat"), Date.parse(FIVE_RESET) + 1_000)).toBeUndefined();
  });

  test("without a reading nothing is held back", () => {
    configureClaudePlanLimits();
    expect(budgetBlockFor(claudeCall("heartbeat"), NOW)).toBeUndefined();
  });
});

describe("plan limit warnings", () => {
  test("each threshold warns once per window, even when the reported reset time jitters", async () => {
    const db = openLedger(ledger());
    cleanups.push(() => db.close());

    await seed(poll(0.82, 0.3));
    const first = newlyCrossedPlanLimitWarnings(db, undefined, NOW, { localZone: "UTC" });
    expect(first).toEqual([{
      window: "five_hour",
      limit: "Claude 5-hour limit",
      message: "Claude 5-hour limit is at 82%; resets at 2026-09-27 09:00 AM.",
      percent_used: 0.82,
      crossed_warn_at: [0.8],
      limit_at: 1,
      over_limit: false,
      resets_at: FIVE_RESET,
      resets_at_display: "2026-09-27 09:00 AM",
    }]);
    expect(newlyCrossedPlanLimitWarnings(db, undefined, NOW, { localZone: "UTC" })).toEqual([]);

    await seed({ ...poll(0, 0.3), five_hour: reading(0.83, "2026-09-27T08:59:59.544+00:00") });
    expect(newlyCrossedPlanLimitWarnings(db, undefined, NOW, { localZone: "UTC" })).toEqual([]);

    await seed(poll(0.96, 0.3));
    expect(newlyCrossedPlanLimitWarnings(db, undefined, NOW, { localZone: "UTC" }).map((event) => event.crossed_warn_at)).toEqual([[0.95]]);
  });

  test("the next window warns again", async () => {
    const db = openLedger(ledger());
    cleanups.push(() => db.close());
    await seed(poll(0.82, 0.3));
    expect(newlyCrossedPlanLimitWarnings(db, undefined, NOW)).toHaveLength(1);
    await seed({ ...poll(0, 0.3), five_hour: reading(0.81, "2026-09-27T14:00:00+00:00") });
    expect(newlyCrossedPlanLimitWarnings(db, undefined, NOW)).toHaveLength(1);
  });

  test("reaching the limit says what it does", async () => {
    const db = openLedger(ledger());
    cleanups.push(() => db.close());
    await seed(poll(0.93, 0.3));
    const usage = policy({ five_hour: { warn_fractions: [0.8, 0.95], limit_fraction: 0.9, limit_action: "pause_heartbeat" } });
    const [event] = newlyCrossedPlanLimitWarnings(db, usage, NOW, { localZone: "UTC" });
    expect(event).toMatchObject({
      crossed_warn_at: [0.8, 0.9],
      percent_used: 0.93,
      limit_at: 0.9,
      over_limit: true,
      message: "Claude 5-hour limit is at 93% (limit 90%, heartbeat paused); resets at 2026-09-27 09:00 AM.",
    });
  });
});

describe("usage reports", () => {
  test("the budget report carries plan limits only for a conversation on the Claude subscription", async () => {
    const path = ledger();
    await seed(poll(0.5, 0.6));
    const other = (await usageReport({ ledger: path, args: { budget: true }, usage: {} }, { now: NOW })) as Extract<UsageResult, { mode: "budget" }>;
    expect(Object.hasOwn(other, "claude_plan_limits")).toBe(false);

    const claude = (await usageReport({ ledger: path, args: { budget: true }, usage: {}, claudePlanLimits: true }, { now: NOW })) as Extract<UsageResult, { mode: "budget" }>;
    expect(claude.claude_plan_limits?.windows.map((limit) => [limit.window, limit.percent_used])).toEqual([["five_hour", 0.5], ["seven_day", 0.6]]);
  });

  test("the summary shows plan limits once Claude has reported them", async () => {
    const path = ledger();
    configureClaudePlanLimits();
    const before = (await usageReport({ ledger: path, args: {}, usage: {} }, { now: NOW })) as Extract<UsageResult, { mode: "summary" }>;
    expect(before.claude_plan_limits).toBeNull();

    await seed(poll(0.5, 0.6));
    const after = (await usageReport({ ledger: path, args: {}, usage: {} }, { now: NOW })) as Extract<UsageResult, { mode: "summary" }>;
    expect(after.claude_plan_limits?.subscription_type).toBe("max");
  });

  test("a report starts a poll once the reading is more than a minute old, without waiting for it", async () => {
    const path = ledger();
    const hold = gate();
    let answer = poll(0.5, 0.6);
    const probe = counting(async () => {
      if (probe.calls > 1) await hold.opened;
      return answer;
    });
    configureClaudePlanLimits({ fetch: probe.fetch });
    await refreshClaudePlanLimits(0, NOW);
    const budget = async (now: number) =>
      ((await usageReport({ ledger: path, args: { budget: true }, usage: {}, claudePlanLimits: true }, { now })) as Extract<UsageResult, { mode: "budget" }>)
        .claude_plan_limits?.windows[0]?.percent_used;

    expect(await budget(NOW + 30_000)).toBe(0.5);
    expect(probe.calls).toBe(1);

    answer = poll(0.7, 0.6);
    expect(await budget(NOW + 61_000), "the report answers from the cached reading while the poll runs").toBe(0.5);
    expect(probe.calls).toBe(2);
    hold.open();
    await refreshClaudePlanLimits(CLAUDE_PLAN_REFRESH_MS, NOW + 61_000);
    expect(await budget(NOW + 62_000)).toBe(0.7);
    expect(probe.calls).toBe(2);
  });
});

describe("call accounting", () => {
  test("background Claude calls wait for a fresh reading and conversation does not", async () => {
    const hold = gate();
    configureClaudePlanLimits({
      fetch: async () => {
        await hold.opened;
        return poll(0.7, 0.2);
      },
    });

    let conversationReady = false;
    await prepareCallAccounting(claudeCall("message"), fetch, NOW).then(() => {
      conversationReady = true;
    });
    expect(conversationReady).toBe(true);
    expect(claudePlanLimitsState(), "the poll is still running").toBeUndefined();

    let heartbeatReady = false;
    const heartbeat = prepareCallAccounting(claudeCall("heartbeat"), fetch, NOW).then(() => {
      heartbeatReady = true;
    });
    await Promise.resolve();
    expect(heartbeatReady).toBe(false);
    hold.open();
    await heartbeat;
    expect(claudePlanLimitsState()?.five_hour).toEqual(reading(0.7));
  });
});

describe("the usage command", () => {
  test("the budget report carries plan limits when the conversation's model runs on Claude Code", async () => {
    const root = await scratch();
    const path = ledger();
    await seed(poll(0.3, 0.4));
    const report = async (sdk: string): Promise<Record<string, unknown>> => {
      const app = defaultAppConfig();
      app.defaults.model = "chosen";
      const models = emptyCatalog();
      models.chat.set("chat.chosen", { name: "chosen", qualifiedName: "chat.chosen", category: "chat", providerKey: sdk, sdk, modelId: "claude-opus-5" } as never);
      const session = {
        config: { app, models, providers: ProviderRegistry.empty(), dirs: { config: root, data: root, cache: root, runtime: root }, rawTable: undefined },
        configPath: join(root, "config.toml"),
        dataDir: root,
        characterName: "ada",
        activeModel: undefined,
      } as unknown as CommandSession;
      const deps = { ledgerPath: path, callStore: undefined } as unknown as CommandDeps;
      return await commandOperations.usage.invoke({ session, deps }, { budget: true });
    };
    expect(await report("claude_agent")).toMatchObject({ mode: "budget", claude_plan_limits: { subscription_type: "max" } });
    expect(Object.hasOwn(await report("anthropic"), "claude_plan_limits")).toBe(false);
  });
});

describe("Claude subscription accounting", () => {
  test("claude_agent providers run on the subscription unless configured otherwise", () => {
    const providers = ProviderRegistry.fromSection({
      claude: { sdk: "claude_agent" },
      metered: { sdk: "claude_agent", subscription: false },
      anthropic: {},
    });
    expect(Object.fromEntries(providers.subscriptionSettings())).toEqual({ anthropic: false, claude: true, metered: false });
    expect(DEFAULT_SUBSCRIPTION_PROVIDERS).toContain("claude_agent");
  });

  test("a subscription Claude call records no spend, so cost budgets never pause it", () => {
    setSubscriptionProviders(DEFAULT_SUBSCRIPTION_PROVIDERS);
    expect(isSubscriptionCall("claude_agent", "claude-opus-5")).toBe(true);
    const book = Ledger.create(ledger());
    try {
      book.record({
        character: "aria", provider: "claude_agent", model: "claude-opus-5", call_type: "heartbeat", thinking_enabled: false,
        finish_reason: "end_turn", timing: { total_ms: 1, time_to_first_token_ms: 1 },
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 2.5 },
      });
      expect(book.database.query("SELECT cost_source, total_cost FROM calls").all()).toEqual([{ cost_source: "subscription", total_cost: 0 }]);
    } finally {
      book.close();
    }
  });
});
