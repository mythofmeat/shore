#!/usr/bin/env python3
"""Mutation pass over the `set_next_wake` arm of the tool dispatcher.

`set_next_wake` is an ordinary registry tool now, offered wherever the
allowlist names it, so every answer it gives is one a character plans around.
The mutants attack the four ways it can mislead without failing:

- **The quote.** The clock clamps, and the answer must say what the clock
  allowed rather than what was asked for.
- **The defaults.** An hour and an empty reason, as the heartbeat loop gave
  before the arm moved here.
- **The refusals.** A context with no schedule, and a character whose
  heartbeats are not running, must each say so rather than report a wake.
- **The dry run.** A dry-run pass must not move the real clock.

A mutant is KILLED if `bun test tests/dispatch.test.ts` fails with it applied.
"""
import sys
from mutation import run

D = "src/tools/dispatch.ts"
MUTANTS = [
    ("wake: the quote is the hours asked for, not the hours the clock allowed", D,
     "      return `Scheduled next moment in ${used.toFixed(1)} hours.`;",
     "      return `Scheduled next moment in ${hours.toFixed(1)} hours.`;"),
    ("wake: no hours defaults to zero rather than one", D,
     '      const hours = typeof args["hours_from_now"] === "number" ? args["hours_from_now"] : 1;',
     '      const hours = typeof args["hours_from_now"] === "number" ? args["hours_from_now"] : 0;'),
    ("wake: the reason never reaches the clock", D,
     '      const reason = typeof args["reason"] === "string" ? args["reason"] : "";',
     '      const reason = "";'),
    ("wake: a context with no schedule crashes instead of refusing", D,
     "      if (ctx.scheduleNextWake === undefined) {\n"
     '        throw new ToolIoError("the heartbeat schedule is not available in this context");\n'
     "      }\n",
     ""),
    ("wake: a character with no running heartbeat is told a wake was scheduled", D,
     '      if (used === undefined) throw new ToolIoError("heartbeats are not running for this character");',
     '      if (used === undefined) return "Scheduled next moment in 1.0 hours.";'),
    ("dry run: set_next_wake moves the real clock", D,
     '"generate_image", "set_next_wake"].includes(name)',
     '"generate_image"].includes(name)'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/dispatch.test.ts"]))
