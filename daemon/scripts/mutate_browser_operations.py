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
    ("preview policies are ignored", "src/operations/policy.ts",
     'return match ?? operation;', 'return operation;'),
    ("absent policy conditions match explicitly supplied fields", "src/operations/policy.ts",
     '!Object.hasOwn(input, condition.field)', 'Object.hasOwn(input, condition.field)'),
    ("argument policy values are coerced", "src/operations/policy.ts",
     'input[condition.field] === condition.value', 'String(input[condition.field]) === String(condition.value)'),
    ("policy field misspellings reach discovery", "src/operations/registry.ts",
     'if (!fields.includes(policy.condition.field)) throw', 'if (false) throw'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/web_transport.test.ts", "tests/operation_contracts.test.ts"]))
