#!/usr/bin/env python3
"""Mutation pass over the `usage` command: what it forwards to the report, and
how a failure is reported.
"""
import sys

COMMAND = "src/commands/usage.ts"

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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/commands_usage.test.ts", "tests/pricing.test.ts",
         "tests/ledger_usage.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
