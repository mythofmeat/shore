import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SDKControlGetUsageResponse, SDKRateLimitEvent } from "@anthropic-ai/claude-agent-sdk";

import { claudePlanLimitsState, configureClaudePlanLimits } from "../src/ledger/plan_limits.ts";
import {
  claudePlanPoll,
  claudePlanUsageEnvironment,
  fetchClaudePlanLimits,
  type ClaudePlanUsageQuery,
} from "../src/llm/claude_plan_limits.ts";
import { ClaudeAgentProvider, claudeAgentEnvironment, type AgentQuery } from "../src/llm/providers/claude_agent.ts";
import type { SidecarRequest } from "../src/llm/types.ts";
import { fakeAgent } from "../src/testing/fake_agent_query.ts";
import { testTmp } from "./support/tmp.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  configureClaudePlanLimits();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Reply = Pick<SDKControlGetUsageResponse, "subscription_type" | "rate_limits_available" | "rate_limits">;

const window = (utilization: number | null, resets_at: string | null) => ({ utilization, resets_at });

function reply(five: number | null, week: number | null): Reply {
  return {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: window(five, "2026-09-27T06:09:59.544316+00:00"),
      seven_day: window(week, "2026-10-02T02:59:59.544335+00:00"),
    },
  };
}

interface Probe {
  params?: Parameters<ClaudePlanUsageQuery>[0];
  args?: unknown;
  promptEnded: boolean;
  promptEndedBeforeReply?: boolean;
  closed: boolean;
}

function probe(answer: Reply | Error): { seen: Probe; query: ClaudePlanUsageQuery } {
  const seen: Probe = { promptEnded: false, closed: false };
  const query: ClaudePlanUsageQuery = (params) => {
    seen.params = params;
    const prompt = params.prompt;
    if (typeof prompt !== "string") {
      void prompt[Symbol.asyncIterator]().next().then(() => {
        seen.promptEnded = true;
      });
    }
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (args) => {
        seen.args = args;
        await Bun.sleep(5);
        seen.promptEndedBeforeReply = seen.promptEnded;
        if (answer instanceof Error) throw answer;
        return answer as SDKControlGetUsageResponse;
      },
      close: () => {
        seen.closed = true;
      },
    };
  };
  return { seen, query };
}

describe("reading the plan from the Claude Code usage report", () => {
  test("both windows are read as fractions of the plan with normalized reset times", () => {
    expect(claudePlanPoll(reply(73, 31))).toEqual({
      subscription_type: "max",
      five_hour: { percent_used: 0.73, resets_at: "2026-09-27T06:09:59.544+00:00" },
      seven_day: { percent_used: 0.31, resets_at: "2026-10-02T02:59:59.544+00:00" },
    });
  });

  test("a window without a figure is unknown, and an account without plan limits reports nothing", () => {
    expect(claudePlanPoll(reply(12, null))?.seven_day).toBeNull();
    expect(claudePlanPoll(reply(null, null))).toBeUndefined();
    expect(claudePlanPoll({ ...reply(12, 30), rate_limits_available: false })).toBeUndefined();
    expect(claudePlanPoll({ subscription_type: null, rate_limits_available: true, rate_limits: null })).toBeUndefined();
  });

  test("the usage fetch lifts only the switch that suppresses it and keeps other traffic off", () => {
    const agent = claudeAgentEnvironment();
    const usage = claudePlanUsageEnvironment(agent);
    expect(agent.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(Object.hasOwn(usage, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")).toBe(false);
    const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _dropped, ...kept } = agent;
    expect(usage).toEqual({
      ...kept,
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_BUG_COMMAND: "1",
    });
  });

  test("the session stays open until the report arrives, skips the local transcript scan, then closes", async () => {
    const { seen, query } = probe(reply(40, 20));
    const env = { PATH: "/bin" };
    expect(await fetchClaudePlanLimits(query, env)).toMatchObject({ five_hour: { percent_used: 0.4 }, seven_day: { percent_used: 0.2 } });
    expect(seen.args).toEqual({ skipBehaviors: true });
    expect(seen.params?.options?.env).toBe(env);
    expect(seen.params?.options).toMatchObject({ settingSources: [], strictMcpConfig: true, tools: [], persistSession: false });
    expect(seen.promptEndedBeforeReply).toBe(false);
    expect(seen.closed).toBe(true);
    await Bun.sleep(0);
    expect(seen.promptEnded).toBe(true);
  });

  test("a failed report still closes the session", async () => {
    const { seen, query } = probe(new Error("Query closed before response received"));
    const outcome: unknown = await fetchClaudePlanLimits(query, {}).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(seen.closed).toBe(true);
  });
});

describe("the Claude agent provider", () => {
  test("a provider built without a usage query never probes the plan", async () => {
    expect(await new ClaudeAgentProvider().planLimits()).toBeUndefined();
    const { seen, query } = probe(reply(10, 10));
    expect(await new ClaudeAgentProvider({ planQuery: query }).planLimits()).toMatchObject({ subscription_type: "max" });
    expect(seen.params?.options?.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });

  test("rate-limit events from a turn update the plan reading", async () => {
    const dir = await mkdtemp(testTmp("shore-plan-events-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    configureClaudePlanLimits();
    const limit: SDKRateLimitEvent = {
      type: "rate_limit_event", session_id: "plan-session", uuid: "00000000-0000-4000-8000-000000000002",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt: Date.parse("2026-10-02T03:00:00Z") / 1000 },
    };
    const agent = fakeAgent({ rounds: [{ blocks: [{ kind: "text", text: "reply" }] }] });
    const runQuery: AgentQuery = async function* (params) {
      yield limit;
      yield* agent.query(params);
    };
    const provider = new ClaudeAgentProvider({ runQuery, bookPath: () => join(dir, "sessions.json") });
    const request: SidecarRequest = {
      sdk: "claude_agent", model: "claude-opus-5", api_key: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 256, replay_prior_thinking: "all",
    };
    expect((await provider.generate(request)).content).toBe("reply");
    expect(claudePlanLimitsState()?.seven_day).toEqual({ percent_used: 0.86, resets_at: "2026-10-02T03:00:00+00:00" });
    expect(claudePlanLimitsState()?.five_hour).toBeNull();
  });
});
