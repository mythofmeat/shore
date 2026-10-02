#!/usr/bin/env python3
"""Mutation pass over the tool loop's budget pre-flight (#14).

This gate fails quietly in both directions, and the two failures look nothing
alike. Too lax and it is `ff7426ae` again — a budget that reads as enforced and
is not, discovered on a bill. Too eager and it refuses turns that would have
fit, which reads as the daemon being broken and has no error anyone can act on.

So the mutants are the ways the projection can be wrong while the suite still
passes:

**A projection that is not a projection.** Dropping it, zeroing it, or folding
it into the reported spend. The last one is the subtle one: enforcement would
still be right, and `shore usage` would start disagreeing with the refusal
message about how much has been spent.

**A boundary off by one call.** The opening call is already weighed by the
plain check, so the loop adds `cap - 1`. Counting the cap whole over-projects
every loop by one call; counting `cap - 2` under-projects every one.

**A guard that stops guarding.** The three cases that deliberately project
nothing — no tools, a cap of one, no cost history — each exist to avoid
refusing on a number that means nothing. Removing any of them refuses a turn
that should have run.

**A mean that includes free calls.** Subscription providers record `$0`. Let
those into the average and a loop projects roughly nothing, which is the one
answer that makes the whole gate useless while looking like it works.

**Two mutants are deliberately absent, because they are equivalent rather than
surviving.** Returning `0` instead of `undefined` for an unknown model changes
nothing: `?? 0` and `projected > 0` both read a zero the same way. And a zero
mean cannot occur, because the query already excludes non-positive costs — the
`mean > 0` test guards a case SQL cannot produce. Both lines stay for
readability; neither is observable, so neither is worth a mutant that would
survive forever and train the eye to ignore survivors.

A mutant is KILLED if `bun test tests/budget_gate.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_budget_preflight.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GATE = "src/ledger/gate.ts"
BUDGET = "src/ledger/budget.ts"
QUERY = "src/ledger/query.ts"

TESTS = ["tests/budget_gate.test.ts"]

# (label, file, find, replace)
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
