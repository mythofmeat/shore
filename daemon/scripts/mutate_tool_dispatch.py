#!/usr/bin/env python3
"""Mutation pass over the `set_next_wake` tool: the quote, the defaults, the
refusals, and dry runs.
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
