#!/usr/bin/env python3
"""Mutation pass over the chat turn's assembly (#18, step 5).

Wiring fails quietly by construction: every mutant here type-checks, every one
of them runs, and none of them raises. What each changes is which of several
identically-shaped things a turn is handed.

**The two per-character backends.** `deferEdit` writes into one character's
queue and `activityStats` reads one character's tracker. Point either at the
data root and one character's self-edit is applied to another's prompt at the
next compaction; drop either and both quietly do nothing, which reads as "no
edits pending" and "no activity recorded".

**The cached request.** One compaction runner serves every character, so the
body it extends has to be looked up per pass. A fixed one hands Ada's
conversation to Nova's compaction — same shape, entirely the wrong bytes, and
nothing downstream can tell.

**What is read live.** `[usage]` and the keepalive ceiling come off the
registry's global config on each call. Captured at assembly instead, they answer
with whatever the daemon started with for the rest of the process, and a budget
added by `shore config` is simply never enforced.

**The budget check.** It is a read that writes: each threshold it reports is
marked delivered. It must not run when no budget is configured — an open per
turn to be told there is nothing to say — and it must not fail a turn that has
already been persisted and answered.

A mutant is KILLED if `bun test tests/handler_deps.test.ts` fails with it
applied.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_deps.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
D = "src/handler/deps.ts"

TESTS = ["tests/handler_deps.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the per-character tool backends --------------------------------------
    ("tools: deferred edits queue at the data root, so every character shares one",
     D,
     "    deferEdit: deferEditTo(\n"
     "      characterDataDir(runtime.config.dirs.data, charName),\n"
     "      queueDeferredEdit,\n    ),",
     "    deferEdit: deferEditTo(runtime.config.dirs.data, queueDeferredEdit),"),
    ("tools: there is no deferred-edit queue, so a self-edit lands live",
     D,
     "    deferEdit: deferEditTo(\n"
     "      characterDataDir(runtime.config.dirs.data, charName),\n"
     "      queueDeferredEdit,\n    ),",
     "    deferEdit: undefined,"),
    ("tools: the heatmap always reads the same character's tracker",
     D,
     "      const report = runtime.autonomy.activityStats(charName, Date.now());",
     '      const report = runtime.autonomy.activityStats("ada", Date.now());'),
    ("tools: the heatmap is never wired, so every character reads as inactive",
     D,
     "    activityStats: () => {",
     "    activityStats: undefined as unknown as () => undefined,\n    _unused: () => {"),
    ("tools: the turn count is dropped on the rename, so the heatmap has no total",
     D,
     "        : { stats: report.stats, turnCount: report.messageCount };",
     "        : { stats: report.stats, turnCount: 0 };"),
    ("tools: the shared backends are dropped, so chat is offered less than a heartbeat",
     D,
     "    ...sharedToolDeps(runtime.config, runtime.mcp),",
     "    ...{},"),

    # --- the autonomy surface -------------------------------------------------
    ("autonomy: the cached body is queued behind registration, leaving a live prefix unarmed",
     D,
     "    notifyLastRequest: (character, request) => {\n"
     "      cache.set(character, request as SidecarRequest);\n    },",
     "    notifyLastRequest: (character, request) => {\n"
     "      void bridge.settled(character).then(() => {\n"
     "        cache.set(character, request as SidecarRequest);\n      });\n    },"),
    ("autonomy: the assistant turn is reported to nobody",
     D,
     "    notifyAssistantMessage: (character, turnCount) => {\n"
     "      bridge.onAssistantMessage(character, turnCount);\n    },",
     "    notifyAssistantMessage: () => {},"),
    ("autonomy: only the model and the messages are cached, dropping the prefix's key",
     D,
     "      cache.set(character, request as SidecarRequest);",
     "      cache.set(character, { model: request.model, messages: request.messages } as SidecarRequest);"),

    # --- the inline compaction ------------------------------------------------
    ("compaction: the pass is never given a cached body, so every one rebuilds from disk",
     D,
     "    cachedRequest: (character) => runtime.cache.get(character),",
     "    cachedRequest: () => undefined,"),
    ("compaction: every pass extends the same character's body",
     D,
     "    cachedRequest: (character) => runtime.cache.get(character),",
     '    cachedRequest: () => runtime.cache.get("ada"),'),

    # --- what is read live ----------------------------------------------------
    ("live: the usage config is captured at assembly, so a new budget never applies",
     D,
     "  const usage = () => usageConfigView(global().app.usage);",
     "  const captured = usageConfigView(global().app.usage);\n  const usage = () => captured;"),
    ("live: the keepalive ceiling is captured at assembly and never moves again",
     D,
     "    keepaliveMaxSecs: () =>\n"
     "      Number(global().app.behavior.autonomy.cache_keepalive_max.asSecs()),",
     "    keepaliveMaxSecs: (() => {\n"
     "      const secs = Number(global().app.behavior.autonomy.cache_keepalive_max.asSecs());\n"
     "      return () => secs;\n    })(),"),
    ("live: the ceiling is read in milliseconds, so it never expires",
     D,
     "      Number(global().app.behavior.autonomy.cache_keepalive_max.asSecs()),",
     "      Number(global().app.behavior.autonomy.cache_keepalive_max.asMillisExact()),"),
    ("live: the config is read off the startup snapshot rather than the registry",
     D,
     "  const global = () => runtime.registry.globalConfig();",
     "  const global = () => runtime.config;"),

    # --- the ledger and the budget check --------------------------------------
    ("ledger: the path is the data root itself, so nothing is ever recorded",
     D,
     '  const ledgerPath = rustJoin(dataDir, "ledger.db");',
     "  const ledgerPath = dataDir;"),
    ("budget: the ledger is opened on every turn, whether or not a budget exists",
     D,
     "    if (config === undefined || (config.budgets ?? []).length === 0) {\n"
     "      return Promise.resolve([]);\n    }",
     "    if (config === undefined) {\n      return Promise.resolve([]);\n    }"),
    ("budget: a configured budget is skipped, so nothing is ever warned about",
     D,
     "    if (config === undefined || (config.budgets ?? []).length === 0) {",
     "    if (true as boolean) {\n      return Promise.resolve([]);\n    }\n    if (config === undefined) {"),
    ("budget: an unopenable ledger fails the turn instead of reporting nothing",
     D,
     "    if (ledger === null) return Promise.resolve([]);",
     '    if (ledger === null) throw new Error("no ledger");'),
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
