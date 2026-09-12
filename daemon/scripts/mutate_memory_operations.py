#!/usr/bin/env python3
"""Exercise compaction environment propagation through the real daemon flow."""
import sys
from mutation import run

MUTANTS = [
    ("compaction prefix loses the daemon environment", "src/memory/compaction/run.ts",
     '?? [], deps.env);', '?? [], undefined);'),
    ("compaction model loses the daemon environment", "src/memory/compaction/run.ts",
     '      ...(deps.env === undefined ? {} : { env: deps.env }),', ''),
    ("disk prefix ignores the supplied credentials", "src/handler/context.ts",
     '    options.env,', '    undefined,'),
    ("manual compaction assembly drops credentials", "src/handler/deps.ts",
     '      run: {\n        ...(a.env === undefined ? {} : { env: a.env }),', '      run: {'),
    ("compaction cache refresh drops credentials", "src/handler/deps.ts",
     'await runtime.cache.reprimeFromDisk(character, config.dirs.data, config, {\n          mcpRegistry: runtime.mcp.current,\n          ...(a.env === undefined ? {} : { env: a.env }),',
     'await runtime.cache.reprimeFromDisk(character, config.dirs.data, config, {\n          mcpRegistry: runtime.mcp.current,'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/daemon_run.test.ts"]))
