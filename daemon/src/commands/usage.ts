import type { CallStore } from "../call_store.ts";
import type { UsageConfig } from "../ledger/budget.ts";
import { usageReport } from "../ledger/usage.ts";
import { internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

export interface UsageContext {
  ledger: string;
  usage: UsageConfig;
  callStore?: CallStore | undefined;
}

export async function usage(ctx: UsageContext, args: Args): Promise<Json> {
  try {
    const store = ctx.callStore;
    return await usageReport({
      ledger: ctx.ledger,
      args,
      usage: ctx.usage,
      ...(store === undefined ? {} : { rateLimits: () => store.latestRateLimits() }),
    });
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}
