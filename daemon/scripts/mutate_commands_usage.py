#!/usr/bin/env python3
"""Mutation pass over `shore usage` — the command, not the report (#18 / #12).

The report is pinned by a frozen fixture generated from the Rust, so what is
mutated here is the thin part around it, which is where the two-process seam
used to be:

- **The refresh.** `--refresh-pricing` empties two caches, and in the Rust the
  two halves lived in different processes and ran under different conditions:
  the daemon deleted the `pricing` table before it forwarded anything, and the
  sidecar dropped the memory in front of that table only if `refresh_pricing`
  won the mode chain. `--budget --refresh-pricing` therefore cleared one and
  not the other, and the surviving memory answered stale prices for the life of
  the process. Both halves are one call now, made before any report.
- **The forward.** The args and the `[usage]` config pass through untouched. A
  command that dropped either would still answer with a well-formed report of
  the wrong thing.
- **The failures.** Both reaches into the ledger are internal errors, as the
  Rust's two `map_err` arms were.

The mutants span four files, because the behaviour does: the command, the
engine method it calls, the store method behind that, and the `/v1/usage`
endpoint — which does the command's job for as long as the daemon calling it is
the Rust one.

A mutant is KILLED if `bun test tests/commands_usage.test.ts tests/pricing.test.ts
tests/ledger_usage.test.ts` fails with it applied.

This is **15/15**, from 14/15 on the first full pass.

The survivor was the endpoint reading the flag loosely: the route test sent a
boolean and nothing else, so `=== true` and a plain truthiness check were the
same code. The command's own test had covered that from the start — a string
`"true"` is not the flag, because the daemon read it with `as_bool` — and the
route now gets the same case.

Two mutants were written, tried and removed as provably equivalent, rather
than left in the list as survivors:

- **Clearing after the report instead of before.** The order is observable only
  when the report between them fails, and every failure reachable here — the
  ledger will not open — fails the clear too, because both go through the same
  `openOrThrow`. The clear is written first because the Rust wrote it first and
  because a refresh that a failed report can cancel is the more surprising of
  the two behaviours, not because a test can tell.
- **Clearing the memory before the table inside `clearCache`.** Nothing runs
  between the two statements: they are synchronous and this is one thread. The
  order is written table-first because it is the only order that stays correct
  if that ever stops being true.

Run from the repository root:
    python3 daemon/scripts/mutate_commands_usage.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMMAND = "src/commands/usage.ts"
ENGINE = "src/ledger/pricing.ts"
STORE = "src/ledger/store.ts"
REPORT = "src/ledger/usage.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- the refresh flag -----------------------------------------------------

    # --- what the refresh empties ---------------------------------------------
    ("refresh: the table survives, so the next process reads stale prices", ENGINE,
     "  clearCache(): void {\n    this.#store.clear();\n  }",
     "  clearCache(): void {}"),
    ("refresh: the delete matches no rows (UNKILLABLE — the only route to this "
     "statement is PricingEngine.clearCache, which 861b0f0c left with no caller "
     "when `shore usage --refresh-pricing` went; pricing.test.ts drives clearCache "
     "against a fake store, so the real DELETE never runs)",
     STORE,
     '      db.run("DELETE FROM pricing");',
     '      db.run("DELETE FROM pricing WHERE 0");'),

    # --- the mode chain -------------------------------------------------------

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
