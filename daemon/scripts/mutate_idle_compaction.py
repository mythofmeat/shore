#!/usr/bin/env python3
"""Mutation pass over idle-triggered compaction: the pass it runs, its report,
and the engine reload afterwards.
"""
import sys

I = "src/autonomy/idle_compaction.ts"

TESTS = ["tests/idle_compaction.test.ts"]

MUTANTS = [
    # --- the pass -------------------------------------------------------------

    # --- what it reports ------------------------------------------------------
    ("report: a failed pass is reported as a success with no turns", I,
     "      failed: e instanceof Error ? e.message : String(e),",
     "      failed: undefined,"),
    ("report: a failed pass rethrows, abandoning the rest of the tick", I,
     '\n      return {\n        events: [],\n        failed: e instanceof Error ? e.message : String(e),',
     '    throw e;\n    return {\n      events: [],\n      failed: e instanceof Error ? e.message : String(e),'),
    ("report: missing dependencies are a silent skip that wedges the latch",
     I,
     '    return { events: [], failed: "idle compaction has no compaction dependencies" };',
     "    return { events: [] };"),
    ("report: missing dependencies still run the bookkeeping",
     I,
     '\n    if (deps.run === undefined) {\n      return { events: [], failed: "idle compaction has no compaction dependencies" };\n    }',
     "  if (deps.run === undefined) deps.run = { generate: (() => { throw new Error('no deps') }) as never };"),
    ("report: the retained count is dropped, so the turns are never marked covered",
     I,
     "  return { turnCount: retained, events: [] };",
     "  return { events: [] };"),
    ("report: the retained count is off by one",
     I,
     "  return { turnCount: retained, events: [] };",
     "  return { turnCount: retained + 1, events: [] };"),
    ("report: an idle compaction claims the idle period is finished",
     I,
     "  return { turnCount: retained, events: [] };",
     "  return { turnCount: retained, events: [], deepArchiveDone: true };"),

    # --- the bookkeeping ------------------------------------------------------
    ("bookkeeping: the engine is not reloaded, so the prompt stays pre-pass",
     I,
     '  await reloadAndApplyDeferred(character, deps, "Idle compaction");',
     "  void 0;"),
    ("bookkeeping: the keepalive still points at the pre-pass prefix",
     I,
     '  await repoint(character, deps, "idle_compaction");',
     "  void 0;"),
    ("bookkeeping: the engine is reloaded before the pass rewrites the conversation",
     I,
     '  shoreLog.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);',
     '  shoreLog.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);\n'
     '  await reloadAndApplyDeferred(character, deps, "Idle compaction");'),
    ("pass: the compaction runs without the character's effective config", I,
     '\n      completion = await runCompaction(character, {\n        ...deps.run,\n        config: deps.config,\n      }, "idle");',
     '    completion = await runCompaction(character, {\n      ...deps.run,\n    } as never, "idle");'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
