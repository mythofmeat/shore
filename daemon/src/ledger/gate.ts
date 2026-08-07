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
 * **A tool loop is still one check, but it is no longer one call's worth.**
 * The loop makes up to `max_tool_iterations` provider calls behind this gate,
 * so a loop starting a cent under a hard limit could spend every remaining
 * iteration and finish well past it (#14). {@link projectedLoopCost} weighs the
 * whole loop up front instead.
 *
 * Refusing *before* the loop rather than during it is the deliberate half. A
 * mid-loop refusal abandons a turn whose `tool_use` blocks have no
 * `tool_result` after them; Anthropic rejects that on the next request, so a
 * budget overrun becomes a wedged conversation. The cost of the pre-flight is
 * that it is conservative — a loop that would have finished under the limit can
 * be refused on a projection that assumed every iteration ran.
 */

import { enforceBudgetForCall, type BudgetBlock } from "./budget.ts";
import { recentCallCost } from "./query.ts";
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

  // Mirrors the daemon: the custom provider key when there is one, the sdk name
  // otherwise, so `[[usage.budgets]].provider` matches what the ledger row will
  // say.
  const provider = request.provider_key ?? request.sdk;
  const projectedCost = projectedLoopCost(ledger.database, request, provider);

  return enforceBudgetForCall(
    ledger.database,
    context.usage!,
    {
      provider,
      api_key_name: context.api_key_name,
      model: request.model,
      call_type: context.call_type,
      character: context.character,
    },
    now,
    ...(projectedCost === undefined ? [] : [{ projectedCost }]),
  );
}

/**
 * Worst-case additional spend this call authorises, or `undefined` when there
 * is nothing to project.
 *
 * A request carrying tools and an iteration cap can make that many provider
 * calls before it returns. The projection is `remaining iterations x the recent
 * mean cost of a call on this model`, which is the only estimate available
 * before the loop has run.
 *
 * Three cases deliberately project nothing, and each would otherwise refuse a
 * turn on a number that means nothing:
 *
 *   - **No tools, or no configured cap.** See below on the uncapped case.
 *   - **No continuation history for this model.** A first loop on a newly
 *     configured model has nothing to average; guessing would refuse it.
 *   - **A cap of one.** The loop cannot make a second call, so there is no
 *     overrun to prevent.
 *
 * # The uncapped case is left alone on purpose
 *
 * `max_tool_iterations` has no default, and `config/models.ts` says why:
 * absent means **unlimited**. Someone who has left it there has said they do
 * not want their loops bounded, and a budget gate that invents a bound for
 * them is second-guessing a deliberate choice. So this projects nothing, and
 * enforcement stays where it was: the entry check still runs on every turn, so
 * an overrun is bounded by **one turn's loop** and the next turn is refused.
 *
 * That bound is small in practice. Over two weeks of real traffic a turn made
 * 1.7 provider calls on average — 0.68 continuations — at $0.0145 each, so a
 * typical overshoot past a budget is a few cents. This gate is for the case
 * where someone has asked to be conservative *twice*, by setting both a cap and
 * a budget; for everyone else, option 1 of #14 is the right answer and this is
 * it.
 */
function projectedLoopCost(
  db: Parameters<typeof recentCallCost>[0],
  request: SidecarRequest,
  provider: string,
): number | undefined {
  const cap = request.max_tool_iterations;
  if (cap === undefined || cap <= 1) return undefined;
  if (request.tools === undefined || request.tools.length === 0) return undefined;

  // Priced off continuations, not off the turn that opens them — they cost
  // about a third as much, and mixing the two demands triple the headroom.
  const perCall = recentCallCost(db, provider, request.model, continuationType(request));
  if (perCall === undefined) return undefined;

  // The opening call is what the plain gate already weighs; this is what the
  // loop adds on top of it, which is why the cap is not counted whole.
  return perCall * (cap - 1);
}

/** The `call_type` this request's continuations will be recorded under. */
function continuationType(request: SidecarRequest): string {
  return request.context?.call_type === "heartbeat" ? "heartbeat_tool_loop" : "tool_loop";
}
