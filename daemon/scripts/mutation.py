#!/usr/bin/env python3
"""The shared harness the `mutate_*.py` passes run on.

Three things it exists to fix, all of them from #54:

**The restore is guaranteed.** A mutant is written into your working tree and
taken back out. Doing that without `try`/`finally` means a Ctrl-C, a timeout or
any exception leaves the source mutated, which 31 of the 49 scripts did.

**An inapplicable mutant is not a survivor.** A pattern that no longer matches
its target is a fact about the harness — the source moved underneath it. A
survivor is a fact about the tests — they did not notice a real change in
behaviour. Reporting the first as the second is how `mutate_daemon_startup.py`
came to announce eighteen security holes that had been deliberately deleted, and
to score 10/28 while its tests were fine. They are counted and exited on
separately here, and the score is over the mutants that actually applied.

**One entry point.** `bun run mutate [module]`, so the whole set can be run
rather than remembered.

**A survivor with a checked reason is not a finding.** #130: once every pass
applied, 30 of the 33 remaining survivors were mutants somebody had already sat
down with and decided were not worth killing — a clamp another clamp covers, a
guard on a value the store cannot produce. Exiting non-zero on those means the
harness can never go green, so it can never be a gate, so a pattern that quietly
stops matching stays silent for six months. A survivor whose label carries one
of `REASONS` is a recorded decision and is reported apart from the unexplained
ones; the exit code is over the unexplained survivors, the stale patterns, and
any label whose reason has since become false.

**A staleness check that costs nothing.** #132: a full sweep is 15 minutes, so
nothing runs it, so the rot it catches — a `find` pattern that stops matching
because the source moved — stays silent until somebody remembers. But that rot
needs no test runs to find: it is `source.count(find) == 1`, file reads and
substring counts. `--stale` does only that and skips every `bun test`, which is
fast enough for `.githooks/pre-commit`. It does not catch a mutant that still
applies but has stopped being killed; that still wants the full sweep.

**The tests run somewhere the repository is not.** A mutant that rewrites a path
makes the code under test write to a path nobody chose. `rustJoin: always treat
component as absolute` collapses every join to its last segment, so a character
workspace that should be `${root}/ada` becomes a bare `ada`, and the suite quietly
deposits `daemon/ada/TOOLS.md` in the working tree — twice now, unexplained both
times. The suite is given absolute test paths and run from a scratch directory
that is deleted afterwards, so a write to a relative path lands there instead of
in the repository.

A mutant is normally one edit. `(label, [(find, replace), ...])` is the shape for
one that only means anything as a set — two clamps that cover each other are
each individually equivalent, and only removing the pair is a change worth
catching.
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent

APPLIED = "applied"
INAPPLICABLE = "inapplicable"

REASONS = ("EQUIVALENT", "UNKILLABLE", "NEEDS A SEAM")


def expected_reason(label):
    """The reason a mutant is expected to survive, or `None` if it is not.

    The convention is the one already in the tree: the reason goes in the label,
    in parentheses, followed by why. `expected_reason` reads it back so `run`
    can tell a recorded decision from a finding.
    """
    for reason in REASONS:
        if f"({reason}" in label:
            return reason
    return None


def _tally(values):
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))


def _resolve(path):
    """Anchor a pass's target at the daemon root.

    The passes name their sources both ways — `ROOT / "src/x.ts"` and a bare
    `"src/x.ts"` — and a bare one is otherwise relative to whatever directory
    the pass was launched from. `ROOT / path` leaves an absolute path alone and
    pins the rest, so every caller reads the same file.
    """
    return ROOT / path


def _normalize(mutant, default_src):
    """Accept the four tuple shapes the passes were written in.

    Returns `(label, [(path, find, replace), ...])`. Most mutants are a single
    edit; `(label, [(find, replace), ...])` is one that only means something as
    a set, which is what a pair of clamps that cover each other needs — remove
    either and another catches it, remove both and the bound is gone.
    """
    if len(mutant) == 2:
        label, edits = mutant
        if default_src is None:
            raise ValueError(f"compound mutant needs a default source: {label}")
        return label, [(_resolve(default_src), find, replace) for find, replace in edits]
    if len(mutant) == 3:
        label, find, replace = mutant
        if default_src is None:
            raise ValueError(f"three-part mutant needs a default source: {label}")
        return label, [(_resolve(default_src), find, replace)]
    if len(mutant) != 4:
        raise ValueError(f"unrecognised mutant shape: {mutant!r}")
    a, b, find, replace = mutant
    # `(label, path, ...)` and `(path, label, ...)` both occur; the path is the
    # one that names a file that exists.
    if _resolve(str(a)).is_file() and not _resolve(str(b)).is_file():
        return str(b), [(_resolve(str(a)), find, replace)]
    return str(a), [(_resolve(str(b)), find, replace)]


def bunfig_preloads():
    """The test preloads `bunfig.toml` declares, read back so the sandbox keeps them.

    `bun` reads `bunfig.toml` from its working directory and resolves the paths
    in it the same way, so running the suite from anywhere else silently drops
    the preload — `tests/fixture_env.ts` pins `$USER` and installs the temp-root
    sweeper, and losing it changes what the tests do. Reading the list here
    rather than naming the file keeps the two from drifting apart.
    """
    config = ROOT / "bunfig.toml"
    if not config.is_file():
        return []
    return tomllib.loads(config.read_text()).get("test", {}).get("preload", [])


def stale(mutants, src):
    """Report the mutants whose pattern no longer matches its source once.

    No mutant is written and no test is run, so this is seconds over the whole
    set. A pattern matching zero times is a mutant that has silently stopped
    testing anything; matching more than once is one that would edit an
    arbitrary occurrence of the two.
    """
    texts = {}
    found = []
    for mutant in mutants:
        label, edits = _normalize(mutant, src)
        for path, find, _ in edits:
            if path not in texts:
                texts[path] = path.read_text()
            count = texts[path].count(find)
            if count != 1:
                found.append((label, count))
                break

    for label, count in found:
        print(f"  STALE: {label} (matched {count}x)")
    return 1 if found else 0


def run(mutants, tests, src=None, timeout=180):
    """Apply each mutant, run `tests`, restore, and report.

    Returns a process exit code: non-zero if anything survived or failed to
    apply, so a caller can gate on it.
    """
    src = None if src is None else pathlib.Path(src)
    if "--stale" in sys.argv[1:]:
        return stale(mutants, src)

    absolute_tests = [str(ROOT / test) for test in tests]
    preloads = [arg for module in bunfig_preloads() for arg in ("--preload", str(ROOT / module))]

    def suite() -> bool:
        sandbox = tempfile.mkdtemp(prefix="shore-mutate-")
        try:
            proc = subprocess.run(
                ["bun", "test", *preloads, *absolute_tests],
                cwd=sandbox,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        finally:
            shutil.rmtree(sandbox, ignore_errors=True)
        return proc.returncode == 0

    if not suite():
        sys.exit("baseline is red; fix that before mutating")

    survivors = []
    expected = []
    mislabelled = []
    inapplicable = []
    applied = 0

    for i, mutant in enumerate(mutants, 1):
        label, edits = _normalize(mutant, src)
        originals = {path: path.read_text() for path, _, _ in edits}
        counts = [originals[path].count(find) for path, find, _ in edits]
        if any(count != 1 for count in counts):
            worst = next(count for count in counts if count != 1)
            inapplicable.append((label, worst))
            print(f"{i:3d}. ---- {label} — pattern matched {worst}x")
            continue

        applied += 1
        mutated = dict(originals)
        for path, find, replace in edits:
            mutated[path] = mutated[path].replace(find, replace, 1)
        for path, text in mutated.items():
            path.write_text(text)
        try:
            killed = not suite()
        finally:
            for path, text in originals.items():
                path.write_text(text)
        reason = expected_reason(label)
        if killed:
            outcome = "kill"
            if reason is not None:
                mislabelled.append((label, reason))
        elif reason is not None:
            outcome = "kept"
            expected.append((label, reason))
        else:
            outcome = "LIVE"
            survivors.append(label)
        print(f"{i:3d}. {outcome}  {label}")

    lived = len(survivors) + len(expected)
    summary = f"\n{applied - lived}/{applied} killed"
    if expected:
        breakdown = ", ".join(
            f"{n} {reason.lower()}" for reason, n in _tally(reason for _, reason in expected)
        )
        summary += f", {len(expected)} survivor(s) kept on purpose: {breakdown}"
    print(summary)

    for label in survivors:
        print(f"  SURVIVOR: {label}")

    if mislabelled:
        print(f"\n{len(mislabelled)} label(s) are now wrong — these died, so the reason no longer holds:")
        for label, reason in mislabelled:
            print(f"  {reason} BUT KILLED: {label}")

    if inapplicable:
        print(f"\n{len(inapplicable)} mutant(s) no longer apply — the source moved, not the tests:")
        for label, matches in inapplicable:
            print(f"  STALE: {label} (matched {matches}x)")

    return 1 if survivors or mislabelled or inapplicable else 0
