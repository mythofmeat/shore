#!/usr/bin/env python3
"""Exercise retained output, scroll bindings and local workflow checks."""
import sys
from mutation import run

O = "src/browser/operations.ts"
K = "src/browser/keyboard.ts"
MUTANTS = [
    ("background actions replace reopened output", O, 'options.remember !== false &&', ''),
    ("sign-out lets late completion retain output", O, 'epoch === this.#epoch', 'true'),
    ("missing output becomes usable", O, 'invalid || !received || !validOperationResult(name, result)', 'false'),
    ("scroll ignores saved amount", K, 'args["amount"] ?? 1', '1'),
    ("scroll accepts overflowing amount", K, 'amount > 65535', 'false'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_local_workflows.test.ts", "tests/web_transport.test.ts"]))
