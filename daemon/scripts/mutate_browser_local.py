#!/usr/bin/env python3
"""Exercise draft history, retained output and local workflow omission checks."""
import sys
from mutation import run

H = "src/browser/text_history.ts"
O = "src/browser/operations.ts"
K = "src/browser/keyboard.ts"
A = "src/browser/app.tsx"
MUTANTS = [
    ("typing splits every character", H, 'this.#run === kind', 'false'),
    ("whitespace does not finish typing group", H, '/\\s$/.test(next.text.slice(0, next.start))', 'false'),
    ("composition splits intermediate text", H, 'this.#composing ? this.#compositionEdited', 'this.#composing ? false'),
    ("selection direction lost", H, 'textSnapshot(this.#current.text, start, end, direction)', 'textSnapshot(this.#current.text, start, end)'),
    ("new edit retains stale redo", H, 'this.#future = [];\n    this.#trim(this.#past);', 'this.#trim(this.#past);'),
    ("history depth unbounded", H, 'stack.length > DEPTH', 'false'),
    ("history byte bound counts code units", H, 'item.text.length * 2', 'item.text.length'),
    ("history removes newest checkpoint", H, 'stack.shift()', 'stack.pop()'),
    ("background actions replace reopened output", O, 'options.remember !== false &&', ''),
    ("sign-out lets late completion retain output", O, 'epoch === this.#epoch', 'true'),
    ("missing output becomes usable", O, 'invalid || !received || !validOperationResult(name, result)', 'false'),
    ("scroll ignores saved amount", K, 'args["amount"] ?? 1', '1'),
    ("scroll accepts overflowing amount", K, 'amount > 65535', 'false'),
    ("editor handler silently omitted", A, 'editor: () => composer.current?.expand()', 'editor: () => {}'),
    ("scroll amount control omitted", 'src/browser/keyboard_controls.tsx', 'value={typeof binding.args["amount"] === "number" ? Number.isFinite(binding.args["amount"]) ? binding.args["amount"] : "" : 1}', 'value={1}'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_text_history.test.ts", "tests/browser_local_workflows.test.ts", "tests/web_transport.test.ts"]))
