#!/usr/bin/env python3
"""Exercise typed browser operation admission, correlation, and results."""
import sys
from mutation import run

SOURCE = "src/browser/operations.ts"
MUTANTS = [
    ("invalid inputs reach the wire", SOURCE,
     'if (!validOperationInput(name, input)) throw', 'if (false) throw'),
    ("failed actions appear successful", SOURCE,
     'if (completion.outcome !== "completed") throw', 'if (false) throw'),
    ("malformed operation results appear successful", SOURCE,
     'invalid || !received || !validOperationResult(name, result)', 'invalid || !received'),
    ("unrelated results corrupt the action", SOURCE,
     ' || update.message.rid !== rid', ''),
    ("wrong names and duplicate results appear successful", SOURCE,
     'if (received || update.message.name !== name) invalid = true;', 'void name;'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/web_transport.test.ts"]))
