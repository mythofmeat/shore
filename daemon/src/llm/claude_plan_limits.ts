import { query, type Query, type SDKControlGetUsageResponse, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";

import { claudePlanInstant, type ClaudePlanPoll, type ClaudePlanReading } from "../ledger/plan_limits.ts";

export const CLAUDE_PLAN_FETCH_TIMEOUT_MS = 15_000;

type UsageMethod = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

export type ClaudePlanUsageQuery = (params: Parameters<typeof query>[0]) => Pick<Query, UsageMethod | "close">;

type UsageReply = Pick<SDKControlGetUsageResponse, "subscription_type" | "rate_limits_available" | "rate_limits">;

const NONESSENTIAL_EXCEPT_USAGE: Readonly<Record<string, string>> = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_BUG_COMMAND: "1",
};

export function claudePlanUsageEnvironment(agentEnvironment: Record<string, string>): Record<string, string> {
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _usageFetchIsNonessential, ...env } = agentEnvironment;
  return { ...env, ...NONESSENTIAL_EXCEPT_USAGE };
}

export async function fetchClaudePlanLimits(
  runQuery: ClaudePlanUsageQuery,
  env: Record<string, string>,
  timeoutMs: number = CLAUDE_PLAN_FETCH_TIMEOUT_MS,
): Promise<ClaudePlanPoll | undefined> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let session: ReturnType<ClaudePlanUsageQuery> | undefined;
  try {
    session = runQuery({
      prompt: silentUntil(held),
      options: {
        cwd: tmpdir(), env, abortController,
        settingSources: [], strictMcpConfig: true, tools: [], skills: [],
        persistSession: false,
      },
    });
    return claudePlanPoll(await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
  } finally {
    clearTimeout(timeout);
    release();
    session?.close();
  }
}

function silentUntil(done: Promise<void>): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        await done;
        return { done: true, value: undefined };
      },
    }),
  };
}

export function claudePlanPoll(usage: UsageReply): ClaudePlanPoll | undefined {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || limits === null) return undefined;
  const five_hour = claudePlanReading(limits.five_hour);
  const seven_day = claudePlanReading(limits.seven_day);
  if (five_hour === null && seven_day === null) return undefined;
  return { subscription_type: usage.subscription_type, five_hour, seven_day };
}

function claudePlanReading(window: { utilization: number | null; resets_at: string | null } | null | undefined): ClaudePlanReading | null {
  const utilization = window?.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) return null;
  return { percent_used: utilization / 100, resets_at: claudePlanInstant(window?.resets_at) };
}
