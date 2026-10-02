#!/usr/bin/env python3
"""Mutation pass over the provider auto-discovery loop: which providers it
refreshes, when, and what one failure does to the rest.
"""
import sys

S = "src/daemon/auto_discovery.ts"

TESTS = ["tests/daemon_auto_discovery.test.ts"]

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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
