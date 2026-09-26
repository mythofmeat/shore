#!/usr/bin/env python3
"""Exercise registered character archive routing and destructive safeguards."""
import sys
from mutation import run

A = "src/commands/archive.ts"
R = "src/commands/registry.ts"
MUTANTS = [
    ("deletion ignores the repeated name", A,
     'if (args["confirm"] !== character) {', 'if (false) {'),
    ("deletion skips its requested backup", A,
     'const backup = args["archive"];', 'const backup = undefined;'),
    ("export loses diagnostic inclusion metadata", A,
     'call_diagnostics: "included",', ''),
    ("import loses memory rebuild metadata", A,
     'external_memory: "queued_for_rebuild_when_retain_is_enabled",', ''),
    ("export routing drops its arguments", R,
     'exportCharacter(archiveContext(context), args)', 'exportCharacter(archiveContext(context), {})'),
    ("import routing drops its archive path", R,
     'importCharacter(archiveContext(context), args)', 'importCharacter(archiveContext(context), {})'),
    ("delete routing drops confirmation and backup", R,
     'deleteCharacter(archiveContext(context), args)', 'deleteCharacter(archiveContext(context), {})'),
    ("archive availability is invented", R,
     'archive: (context) => context.deps.archive !== undefined,', 'archive: () => true,'),
    ("legacy dispatch can return after migration", "scripts/capability_inventory.ts",
     'if (legacy.length > 0) throw', 'if (false) throw'),
    ("a registration can bind under the wrong name", "scripts/capability_inventory.ts",
     'property.name.getText(source) !== name.text', 'false'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/archive.test.ts", "tests/delete_character.test.ts", "tests/daemon_run.test.ts", "tests/operation_contracts.test.ts", "tests/capability_inventory.test.ts"]))
