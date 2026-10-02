#!/usr/bin/env python3
"""Exercise operation results and local workflow checks."""
import sys
from mutation import run

O = "src/browser/operations.ts"
MUTANTS = [
    ("missing output becomes usable", O, 'invalid || !received || !validOperationResult(name, result)', 'false'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_local_workflows.test.ts", "tests/web_transport.test.ts"]))
