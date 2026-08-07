/**
 * The budget gate: whether a call is allowed to spend.
 *
 * This is the enforcement half of `budget.ts`, wired to the request. It moved
 * here from the daemon's `LedgerClient::enforce_usage_budget` for the same
 * reason the ledger row writer did (shore commit fe2058b3): **the side that
 * makes the call is the side that must decide whether to make it.** With the
 * check on the far side of the socket, the daemon was authorising a call it no
 * longer places.
 *
 * The daemon checked exactly two paths — `generate` and `stream_raw` — and this
 * covers exactly the same two. Image generation was never budget-checked and
 * still is not; adding it here would be a behaviour change wearing a refactor's
 * clothes.
 *
 * **Granularity is unchanged, on purpose.** A sidecar-driven tool loop makes
 * several provider calls per request and is checked once, at the entry, exactly
 * as the daemon checked it once before handing over. Checking each call in the
 * loop would enforce budgets more tightly, but it would also abandon a loop
 * midway with tool results already appended, so it is a behaviour change that
 * deserves its own commit rather than a side effect of this one.
 */

import { enforceBudgetForCall, type BudgetBlock } from "./budget.ts";
import { ledgerFor } from "./record.ts";
import type { CallContext, SidecarRequest } from "../llm/types.ts";

/**
 * The budget that refuses this call, or `undefined` when it may proceed.
 *
 * Allows the call when there is nothing to check against — no context, no
 * ledger path, no budgets, or a ledger that will not open. That mirrors the
 * daemon, which logged and allowed rather than failing the turn: a budget that
 * cannot be evaluated must not become an outage.
 */
export function budgetBlockFor(
  request: SidecarRequest,
  now: number = Date.now(),
): BudgetBlock | undefined {
  const context: CallContext | undefined = request.context;
  if (context === undefined) {
    return undefined;
  }
  const budgets = context.usage?.budgets ?? [];
  if (context.ledger === undefined || budgets.length === 0) {
    return undefined;
  }
  const ledger = ledgerFor(context.ledger);
  if (ledger === null) {
    return undefined;
  }

  return enforceBudgetForCall(
    ledger.database,
    context.usage!,
    {
      // Mirrors the daemon: the custom provider key when there is one, the sdk
      // name otherwise, so `[[usage.budgets]].provider` matches what the ledger
      // row will say.
      provider: request.provider_key ?? request.sdk,
      api_key_name: context.api_key_name,
      model: request.model,
      call_type: context.call_type,
      character: context.character,
    },
    now,
  );
}
