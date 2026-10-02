#!/usr/bin/env python3
"""Mutation pass over idle-triggered compaction (#18 / #12).

This action has no parity fixture — everything it delegates to is pinned
elsewhere — so this pass is doing more of the work than usual. Read it as the
spec that was not generated.

Every mutant below leaves an action that *runs*: a pass happens, a result comes
back, nothing throws. What changes is what is left on disk afterwards, or what
the runner is told about it.

Three groups.

**The pass.** Two options separate this from the deep archive's LLM arm, and
both of them are silences. `keepTurnsOverride: 0` empties the conversation — the
archive wants that, an idle pass emphatically does not, and a character whose
idle window quietly archives the exchange it is in the middle of looks exactly
like a character whose memory is working. `retainTrailingAutonomous` is the
archive's too, for the file it is emptying.

**The reporting.** `turnCount` is what makes the runner mark those turns covered,
and coverage is what the deep archive's cheap arm keys on. Reporting the wrong
number sends the *next* action down the wrong branch. Reporting `deepArchiveDone`
would end an idle period that has not ended.

**The bookkeeping.** Shared with the archive via `post_archive.ts` and mutated
there by `mutate_deep_archive.py`; what is mutated here is whether this action
calls it at all, and in what order.

A mutant is KILLED if `bun test tests/idle_compaction.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_idle_compaction.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
I = "src/autonomy/idle_compaction.ts"

TESTS = ["tests/idle_compaction.test.ts"]

# (label, file, find, replace)
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
     '\n      completion = await runCompaction(character, {\n        ...deps.run,\n        config: deps.config,\n      });',
     '    completion = await runCompaction(character, {\n      ...deps.run,\n    } as never);'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
