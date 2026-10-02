#!/usr/bin/env python3
"""Mutation pass over the tool loop's budget pre-flight: the projected loop
cost, its boundaries and basis, and how a refusal is reported.
"""
import sys

GATE = "src/ledger/gate.ts"
BUDGET = "src/ledger/budget.ts"
QUERY = "src/ledger/query.ts"

TESTS = ["tests/budget_gate.test.ts"]

MUTANTS = [
    # --- the projection reaches the decision ----------------------------------
    ("projection: never computed, so a loop is one call's worth again",
     GATE,
     "  const projectedCost = projectedLoopCost(ledger.database, request, provider);",
     "  const projectedCost = undefined;"),
    ("projection: computed and then not passed to the enforcer",
     GATE,
     "    ...(projectedCost === undefined ? [] : [{ projectedCost }]),",
     "    ...[],"),
    ("projection: ignored by the enforcer",
     BUDGET,
     "    const projected = opts.projectedCost ?? 0;",
     "    const projected = 0;"),

    # --- the boundary ---------------------------------------------------------
    ("boundary: the cap counted whole, over-projecting every loop by one call",
     GATE,
     "  return perCall * (cap - 1);",
     "  return perCall * cap;"),
    ("boundary: one call short, under-projecting every loop",
     GATE,
     "  return perCall * (cap - 1);",
     "  return perCall * (cap - 2);"),
    ("boundary: over-limit becomes strictly greater, so landing exactly on the limit runs",
     BUDGET,
     "    const overWithProjection = status.current_cost + projected >= status.cost_limit;",
     "    const overWithProjection = status.current_cost + projected > status.cost_limit;"),

    # --- the guards -----------------------------------------------------------
    ("guard: a toolless request projects a loop it cannot run",
     GATE,
     "  if (request.tools === undefined || request.tools.length === 0) return undefined;",
     "  if (request.tools === undefined) return undefined;"),
    ("guard: a cap of one projects a second call that cannot happen",
     GATE,
     "  if (cap === undefined || cap <= 1) return undefined;",
     "  if (cap === undefined) return undefined;"),

    # --- reported spend stays the ledger's ------------------------------------
    ("reporting: the projection folded into current_cost, so usage disagrees",
     BUDGET,
     "        action: status.action,\n"
     "        current_cost: status.current_cost,\n"
     "        cost_limit: status.cost_limit,",
     "        action: status.action,\n"
     "        current_cost: status.current_cost + projected,\n"
     "        cost_limit: status.cost_limit,"),
    ("reporting: a pre-flight refusal claims the budget is already over limit",
     BUDGET,
     "  if (projected !== undefined && projected > 0) {\n    const limit =",
     "  if (false) {\n    const limit ="),

    # --- the mean -------------------------------------------------------------
    ("mean: free rows counted, so a subscription history projects nothing",
     QUERY,
     "            AND total_cost IS NOT NULL AND total_cost > 0",
     "            AND total_cost IS NOT NULL"),
    ("mean: the whole history averaged instead of the recent window",
     QUERY,
     "          ORDER BY id DESC LIMIT ?4",
     "          ORDER BY id ASC LIMIT ?4"),
    ("basis: continuations priced off every call type, so openers inflate them",
     QUERY,
     "          WHERE provider = ?1 AND model = ?2 AND call_type = ?3",
     "          WHERE provider = ?1 AND model = ?2 AND (?3 IS NOT NULL OR 1)"),
    ("basis: a heartbeat loop priced off chat's continuations",
     GATE,
     '  return request.context?.call_type === "heartbeat" ? "heartbeat_tool_loop" : "tool_loop";',
     '  return "tool_loop";'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
