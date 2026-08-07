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
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
I = "src/autonomy/idle_compaction.ts"

TESTS = ["tests/idle_compaction.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the pass -------------------------------------------------------------
    ("pass: keeps zero turns, so every idle window empties the conversation",
     I,
     "    retained = await runCompaction(character, {\n"
     "      ...deps.run,\n"
     "      config: deps.config,\n"
     "      ...(cached === undefined ? {} : { cachedRequest: cached }),\n"
     "    });",
     "    retained = await runCompaction(\n"
     "      character,\n"
     "      { ...deps.run, config: deps.config, ...(cached === undefined ? {} : { cachedRequest: cached }) },\n"
     "      { keepTurnsOverride: 0 },\n"
     "    );"),
    ("pass: retains the trailing autonomous run the keep window had archived",
     I,
     "    retained = await runCompaction(character, {\n"
     "      ...deps.run,\n"
     "      config: deps.config,\n"
     "      ...(cached === undefined ? {} : { cachedRequest: cached }),\n"
     "    });",
     "    retained = await runCompaction(\n"
     "      character,\n"
     "      { ...deps.run, config: deps.config, ...(cached === undefined ? {} : { cachedRequest: cached }) },\n"
     "      { retainTrailingAutonomous: true },\n"
     "    );"),
    ("pass: the cached body is ignored, so every pass rebuilds a colder prefix",
     I,
     "  const cached = deps.cache.get(character);",
     "  const cached = undefined;"),
    ("pass: a dry run, which reports a count for an archive that never happened",
     I,
     "    retained = await runCompaction(character, {\n"
     "      ...deps.run,\n"
     "      config: deps.config,\n"
     "      ...(cached === undefined ? {} : { cachedRequest: cached }),\n"
     "    });",
     "    retained = await runCompaction(\n"
     "      character,\n"
     "      { ...deps.run, config: deps.config, ...(cached === undefined ? {} : { cachedRequest: cached }) },\n"
     "      { dryRun: true },\n"
     "    );"),

    # --- what it reports ------------------------------------------------------
    ("report: a failed pass is reported as a success with no turns",
     I,
     "    return { events: [], failed: e instanceof Error ? e.message : String(e) };",
     "    return { events: [] };"),
    ("report: a failed pass rethrows, abandoning the rest of the tick",
     I,
     "    return { events: [], failed: e instanceof Error ? e.message : String(e) };",
     "    throw e;"),
    ("report: missing dependencies are a silent skip that wedges the latch",
     I,
     '    return { events: [], failed: "idle compaction has no compaction dependencies" };',
     "    return { events: [] };"),
    ("report: missing dependencies still run the bookkeeping",
     I,
     "  if (deps.run === undefined) {\n"
     '    return { events: [], failed: "idle compaction has no compaction dependencies" };\n'
     "  }",
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
     '  console.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);',
     '  console.info(`shore: autonomy tick: running idle-triggered compaction for ${character}`);\n'
     '  await reloadAndApplyDeferred(character, deps, "Idle compaction");'),
    ("bookkeeping: a failed pass re-points the keepalive anyway",
     I,
     "    return { events: [], failed: e instanceof Error ? e.message : String(e) };",
     "    await repoint(character, deps, \"idle_compaction\");\n"
     "    return { events: [], failed: e instanceof Error ? e.message : String(e) };"),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def main() -> int:
    if not run_tests():
        print("baseline is red — fix the suite before mutating", file=sys.stderr)
        return 2

    survivors = []
    for i, (label, rel, find, replace) in enumerate(MUTANTS, start=1):
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"{i:3}. ERROR mutant does not apply: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        if original.count(find) != 1:
            print(f"{i:3}. ERROR mutant is ambiguous: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        path.write_text(original.replace(find, replace))
        try:
            killed = not run_tests()
        finally:
            path.write_text(original)
        print(f"{i:3}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
