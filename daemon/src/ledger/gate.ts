import { enforceBudgetForCall, type BudgetBlock } from "./budget.ts";
import { recentCallCost } from "./query.ts";
import { ledgerFor } from "./record.ts";
import type { CallContext, SidecarRequest } from "../llm/types.ts";

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

function projectedLoopCost(
  db: Parameters<typeof recentCallCost>[0],
  request: SidecarRequest,
  provider: string,
): number | undefined {
  const cap = request.max_tool_iterations;
  if (cap === undefined || cap <= 1) return undefined;
  if (request.tools === undefined || request.tools.length === 0) return undefined;

  const perCall = recentCallCost(db, provider, request.model, continuationType(request));
  if (perCall === undefined) return undefined;

  return perCall * (cap - 1);
}

function continuationType(request: SidecarRequest): string {
  return request.context?.call_type === "heartbeat" ? "heartbeat_tool_loop" : "tool_loop";
}
