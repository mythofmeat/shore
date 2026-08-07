import type { UsageConfig } from "../ledger/budget.ts";
import { clearPricingCache, usageReport } from "../ledger/usage.ts";
import { internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

export interface UsageContext {
  ledger: string;
  usage: UsageConfig;
}

export async function usage(ctx: UsageContext, args: Args): Promise<Json> {
  try {
    if (args["refresh_pricing"] === true) clearPricingCache(ctx.ledger);
    return await usageReport({ ledger: ctx.ledger, args, usage: ctx.usage });
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}
