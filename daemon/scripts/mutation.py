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
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

APPLIED = "applied"
INAPPLICABLE = "inapplicable"


def _normalize(mutant, default_src):
    """Accept the three tuple shapes the passes were written in."""
    if len(mutant) == 3:
        label, find, replace = mutant
        if default_src is None:
            raise ValueError(f"three-part mutant needs a default source: {label}")
        return label, default_src, find, replace
    if len(mutant) != 4:
        raise ValueError(f"unrecognised mutant shape: {mutant!r}")
    a, b, find, replace = mutant
    # `(label, path, ...)` and `(path, label, ...)` both occur; the path is the
    # one that names a file that exists.
    if (ROOT / str(a)).is_file() and not (ROOT / str(b)).is_file():
        return str(b), ROOT / str(a), find, replace
    return str(a), ROOT / str(b), find, replace


def run(mutants, tests, src=None, timeout=180):
    """Apply each mutant, run `tests`, restore, and report.

    Returns a process exit code: non-zero if anything survived or failed to
    apply, so a caller can gate on it.
    """
    src = None if src is None else pathlib.Path(src)

    def suite() -> bool:
        proc = subprocess.run(
            ["bun", "test", *tests],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode == 0

    if not suite():
        sys.exit("baseline is red; fix that before mutating")

    survivors = []
    inapplicable = []
    applied = 0

    for i, mutant in enumerate(mutants, 1):
        label, path, find, replace = _normalize(mutant, src)
        original = path.read_text()
        matches = original.count(find)
        if matches != 1:
            inapplicable.append((label, matches))
            print(f"{i:3d}. ---- {label} — pattern matched {matches}x")
            continue

        applied += 1
        path.write_text(original.replace(find, replace, 1))
        try:
            killed = not suite()
        finally:
            path.write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{applied - len(survivors)}/{applied} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")

    if inapplicable:
        print(f"\n{len(inapplicable)} mutant(s) no longer apply — the source moved, not the tests:")
        for label, matches in inapplicable:
            print(f"  STALE: {label} (matched {matches}x)")

    return 1 if survivors or inapplicable else 0
