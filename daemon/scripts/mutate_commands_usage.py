#!/usr/bin/env python3
"""Mutation pass over `shore usage` — the command, not the report (#18 / #12).

The report is pinned by a frozen fixture generated from the Rust, so what is
mutated here is the thin part around it:

- **The forward.** The args and the `[usage]` config pass through untouched. A
  command that dropped either would still answer with a well-formed report of
  the wrong thing.
- **The failures.** A bad period is a bad request and everything else is an
  internal error, as the Rust's `map_err` arms were.

The pricing refresh is gone. 861b0f0c removed `--refresh-pricing`, which left
`PricingEngine.clearCache` and the `DELETE FROM pricing` behind it with no
caller — the mutants over them could not be killed by any test because no test
could reach the statement. #130 deleted the dead code and the mutants with it.

A mutant is KILLED if `bun test tests/commands_usage.test.ts tests/pricing.test.ts
tests/ledger_usage.test.ts` fails with it applied. This is **5/5**.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_usage.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMMAND = "src/commands/usage.ts"
REPORT = "src/ledger/usage.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the forward ----------------------------------------------------------
    ("forward: the args are dropped, so every request is the default summary", COMMAND,
     "      args,\n      usage: ctx.usage,",
     "      args: {},\n      usage: ctx.usage,"),
    ("forward: the session's usage config is dropped", COMMAND,
     "      args,\n      usage: ctx.usage,",
     "      args,\n      usage: {} as never,"),
    ("forward: the rate-limit readings are dropped, so `shore usage` shows none", COMMAND,
     "      ...(store === undefined ? {} : { rateLimits: () => store.latestRateLimits() }),",
     "      ...({} as Record<string, never>),"),

    # --- the failures ---------------------------------------------------------
    ("errors: a failure is reported as a bad request",
     COMMAND,
     "    throw internalError(e instanceof Error ? e.message : String(e));",
     "    throw invalidRequest(e instanceof Error ? e.message : String(e));"),
    ("errors: the message loses what actually went wrong",
     COMMAND,
     "    throw internalError(e instanceof Error ? e.message : String(e));",
     '    throw internalError("usage report failed");'),
]

# `invalidRequest` is not imported by the command; one mutant needs it to be.
IMPORT = ('import { internalError } from "./errors.ts";',
          'import { internalError, invalidRequest } from "./errors.ts";')


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/commands_usage.test.ts", "tests/pricing.test.ts",
         "tests/ledger_usage.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
