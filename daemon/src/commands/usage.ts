import type { CallStore } from "../call_store.ts";
import type { UsageConfig } from "../ledger/budget.ts";
import { usageReport, UsageArgumentError } from "../ledger/usage.ts";
import { internalError, invalidRequest } from "./errors.ts";
import type { Args } from "./conversation.ts";
import type { NanoGptSubscriptionState } from "../llm/nanogpt_subscription.ts";
import type { UsageResult } from "../protocol/UsageResult.ts";

export interface UsageContext {
  ledger: string;
  nanoGptSubscription?: () => NanoGptSubscriptionState | undefined;
  usage: UsageConfig;
  callStore?: CallStore | undefined;
  claudePlanLimits?: boolean;
}

export async function usage(ctx: UsageContext, args: Args): Promise<UsageResult> {
  try {
    const store = ctx.callStore;
    return await usageReport({
      ledger: ctx.ledger,
      ...(ctx.nanoGptSubscription === undefined ? {} : { nanoGptSubscription: ctx.nanoGptSubscription }),
      args,
      usage: ctx.usage,
      ...(store === undefined ? {} : { rateLimits: () => store.latestRateLimits() }),
      ...(ctx.claudePlanLimits === true ? { claudePlanLimits: true } : {}),
    });
  } catch (e) {
    if (e instanceof UsageArgumentError) throw invalidRequest(e.message);
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}
