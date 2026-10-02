#!/usr/bin/env python3
"""The shared harness the `mutate_*.py` passes run on.

Each mutant is written into the working tree and restored in a `finally`, and
the suite runs from a scratch directory, so a mutant that breaks a path cannot
write into the repository. A pattern that does not match its source exactly
once is reported as stale, not as a survivor. A survivor whose label gives one
of `REASONS` is a recorded decision; the exit code counts unexplained
survivors, stale patterns, and labelled mutants that were killed. `--stale`
checks the patterns only and runs no tests.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent

REASONS = ("EQUIVALENT", "UNKILLABLE", "NEEDS A SEAM")


def expected_reason(label):
    """The `REASONS` entry a label gives in parentheses, or `None`."""
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
    """Anchor a pass's target at the daemon root; an absolute path is kept."""
    return ROOT / path


def _normalize(mutant, default_src):
    """Return `(label, [(path, find, replace), ...])` for any mutant shape.

    A mutant is `(label, find, replace)`, `(label, path, find, replace)`,
    `(path, label, find, replace)`, or `(label, [(find, replace), ...])` for
    edits that only mean something together, such as two clamps that cover
    each other.
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
    # one that names a file that exists. A label can be longer than any file
    # name, which `Path.is_file` raises on in older Pythons (3.12 and earlier at
    # least); `os.path.isfile` answers False on every version.
    if os.path.isfile(_resolve(str(a))) and not os.path.isfile(_resolve(str(b))):
        return str(b), [(_resolve(str(a)), find, replace)]
    return str(a), [(_resolve(str(b)), find, replace)]


def bunfig_preloads():
    """The test preloads `bunfig.toml` declares.

    `bun` reads `bunfig.toml` from its working directory, so a suite run from
    the scratch directory has to be given them explicitly.
    """
    config = ROOT / "bunfig.toml"
    if not config.is_file():
        return []
    return tomllib.loads(config.read_text()).get("test", {}).get("preload", [])


def stale(mutants, src):
    """Report the mutants whose pattern does not match its source exactly once."""
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

    Returns non-zero for an unexplained survivor, a stale pattern, or a
    labelled mutant that was killed.
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
