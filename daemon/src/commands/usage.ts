/**
 * `shore usage`, ported from `crates/daemon/src/commands/usage.rs`.
 *
 * That command was already a forward: the report itself — period parsing,
 * filters, the eight payload shapes, cache health, budgets — moved to
 * `ledger/usage.ts` while the daemon was still Rust, because the ledger has one
 * owner and it is the process that writes to it. What stayed behind was the one
 * thing the writer could not do alone: empty the `pricing` table the daemon's
 * own engine cached in front of.
 *
 * There is one process now, so that reason is gone, and what is left is the
 * shape the Rust command had anyway — clear the cache if asked, then hand the
 * args to the ledger. The clear is unconditional on the other flags, which is
 * what `--refresh-pricing` alongside `--budget` did in the Rust and is now the
 * whole of the refresh rather than half of it. See
 * {@link PricingEngine.clearCache}.
 *
 * Two Rust details do not survive the move, neither of them behaviour a client
 * can see. The `debug!` line that named the requested period is dropped, as
 * every ported command has dropped its tracing. And `LedgerClient::ledger_path`
 * refused a client holding an in-memory ledger — a state only its own tests
 * built — so this takes a path and has no such branch.
 */

import type { UsageConfig } from "../ledger/budget.ts";
import { clearPricingCache, usageReport } from "../ledger/usage.ts";
import { internalError } from "./errors.ts";
import type { Args, Json } from "./conversation.ts";

/** What this command needs from the session. */
export interface UsageContext {
  /** Path to `ledger.db`. */
  ledger: string;
  /** `[usage]` from the loaded config: budgets, timezone, spike warnings. */
  usage: UsageConfig;
}

/**
 * Answer one `shore usage` request.
 *
 * Every failure is an internal error, as the Rust's two `map_err` arms both
 * were: a ledger that will not open and a report that will not compute are both
 * this side's problem, not a malformed request.
 */
export async function usage(ctx: UsageContext, args: Args): Promise<Json> {
  try {
    if (args["refresh_pricing"] === true) clearPricingCache(ctx.ledger);
    return await usageReport({ ledger: ctx.ledger, args, usage: ctx.usage });
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e));
  }
}
