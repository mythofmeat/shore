#!/usr/bin/env python3
"""Mutation pass over the provider auto-discovery loop (#18, step 5).

Three decisions, and each fails quietly in its own direction.

**Who.** Discovery is opt-in twice over — the provider must be `enabled` and
must have `discovery.enabled = true`, and an omitted `[discovery]` block is not
an opt-in. A loop that dropped either check would make outbound requests, on
the user's own credentials, to providers they never asked it to contact.

**When.** A cache inside its TTL is left alone. Without that check a daemon
that restarts often makes one request per provider per restart and learns
nothing it did not already know.

**What a failure costs.** Nothing that can be helped. The previous cache stands
— which is what `writeCache` being atomic is *for* — and the remaining
providers still get their turn. A pass that let one provider's failure escape
would turn a transient outage into a daemon with no model lists at all.

A mutant is KILLED if `bun test tests/daemon_auto_discovery.test.ts` fails with
it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_daemon_auto_discovery.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/daemon/auto_discovery.ts"

TESTS = ["tests/daemon_auto_discovery.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- who ------------------------------------------------------------------
    ("who: a disabled provider is refreshed anyway",
     S,
     "    if (!entry.enabled || !entry.discovery.enabled) continue;",
     "    if (!entry.discovery.enabled) continue;"),
    ("who: discovery being off is ignored, so every enabled provider is contacted",
     S,
     "    if (!entry.enabled || !entry.discovery.enabled) continue;",
     "    if (!entry.enabled) continue;"),
    ("who: both opt-ins are ignored",
     S,
     "    if (!entry.enabled || !entry.discovery.enabled) continue;",
     "    // dropped"),
    ("who: the two flags are ANDed the wrong way, so either one alone suffices",
     S,
     "    if (!entry.enabled || !entry.discovery.enabled) continue;",
     "    if (!entry.enabled && !entry.discovery.enabled) continue;"),

    # --- when -----------------------------------------------------------------
    ("when: a fresh cache is refetched, so every restart costs a request per provider",
     S,
     "    if (cache !== undefined && !isStale(cache)) continue;",
     "    // dropped"),
    ("when: staleness is inverted, so only fresh caches are refreshed",
     S,
     "    if (cache !== undefined && !isStale(cache)) continue;",
     "    if (cache !== undefined && isStale(cache)) continue;"),
    ("when: a missing cache counts as fresh, so a first run never fetches",
     S,
     "    if (cache !== undefined && !isStale(cache)) continue;",
     "    if (cache === undefined || !isStale(cache)) continue;"),
    ("when: the cache is read for the wrong provider",
     S,
     "    const cache = await readCache(cachePath(cacheDir, name));",
     '    const cache = await readCache(cachePath(cacheDir, "other"));'),

    # --- what a failure costs -------------------------------------------------
    ("failure: one provider's error ends the pass, so the rest are never refreshed",
     S,
     "    } catch (e) {",
     "    } catch (e) {\n      if (true) throw e;"),
    ("failure: the loop is not guarded at all",
     S,
     "    try {\n      const outcome = await refreshOne(",
     "    {\n      const outcome = await refreshOne("),

    # --- the loop -------------------------------------------------------------
    ("loop: the first pass waits for the interval instead of running at once",
     S,
     "  pass();\n  const timer = setInterval(pass, intervalMs);",
     "  const timer = setInterval(pass, intervalMs);"),
    ("loop: stopping leaves the interval running",
     S,
     "    stop: () => {\n      clearInterval(timer);",
     "    stop: () => {"),
    ("loop: two passes may overlap, both fetching and both writing the same cache",
     S,
     "    if (running) return;",
     "    // dropped"),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
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
        except subprocess.TimeoutExpired:
            killed = True
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
