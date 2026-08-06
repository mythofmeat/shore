#!/usr/bin/env python3
"""Mutation pass over the daemon instance registry (#18, step 5).

This file is how every CLI finds a daemon, so each way of getting it wrong is a
way for a running daemon to become unreachable — or for a client to dial one
that is not there.

**Pruning.** A daemon that was killed never unregisters, so a registry that
does not prune fills with corpses and hands one to the next `shore` command.
Pruning too eagerly is worse: signal 0 answers `EPERM` for a live process owned
by another user, and reading that as dead deletes a running daemon from someone
else's session. Only a definite `ESRCH` counts.

**Corruption.** Unparseable JSON is a hard failure that keeps a backup, not a
fresh start. Starting from empty makes every other daemon on the machine
unreachable with no record of why, and the next write destroys the evidence.

**The lock.** Its whole job is that a read-modify-write is not interleaved. A
lock that is never taken loses an entry when two daemons start together; one
that is never released wedges every later reader until it goes stale; one with
no staleness fallback wedges them forever, because the holder that died is the
one thing that cannot say so.

A mutant is KILLED if `bun test tests/instances.test.ts` fails with it applied.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_instances.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
I = "src/instances.ts"

TESTS = ["tests/instances.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- pruning --------------------------------------------------------------
    ("prune: dead entries are kept, so a client dials a port nobody holds",
     I,
     "      const live = read.filter((entry) => !shouldPrune(pidState(entry.pid)));",
     "      const live = read;"),
    ("prune: only definitely-alive entries survive, deleting another user's daemon",
     I,
     '  return state === "dead";',
     '  return state !== "alive";'),
    ("prune: the cleaned list is never written, so every command re-cleans it",
     I,
     "      if (pruned || changed) this.#write(entries);",
     "      if (changed) this.#write(entries);"),
    ("pid: EPERM reads as dead, so a process owned by someone else is pruned",
     I,
     '    if (code === "EPERM") return "alive";',
     '    if (code === "EPERM") return "dead";'),
    ("pid: an unknown probe failure is reported as dead and prunes the entry",
     I,
     '    return "unknown";',
     '    return "dead";'),
    ("pid: a nonsense pid is treated as live and never pruned",
     I,
     '  if (!Number.isInteger(pid) || pid <= 0) return "dead";',
     '  if (!Number.isInteger(pid) || pid <= 0) return "alive";'),

    # --- registering ----------------------------------------------------------
    ("register: the earlier entry with the same id is kept, so a restart duplicates",
     I,
     "      const kept = entries.filter((e) => e.id !== info.id);",
     "      const kept = [...entries];"),
    ("register: a re-registration is not written, so a pruned daemon stays missing",
     I,
     "      return { entries: kept, value: undefined, changed: true };",
     "      return { entries: kept, value: undefined, changed: false };"),
    ("unregister: every entry goes, not just the named one",
     I,
     "      const kept = entries.filter((e) => e.id !== id);",
     "      const kept: InstanceInfo[] = [];"),

    # --- reading --------------------------------------------------------------
    ("read: a missing file raises instead of reading as an empty registry",
     I,
     '      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];\n      throw e;',
     "      throw e;"),
    ("read: an empty file is reported as corruption",
     I,
     '    if (content.trim() === "") return [];',
     "    void content;"),
    ("read: corrupt JSON starts from empty, taking every other daemon with it",
     I,
     "      throw new CorruptInstances(this.path, this.#preserve(content), cause);",
     "      void cause;\n      return [];"),
    ("read: the corrupt content is reported but not preserved",
     I,
     "      throw new CorruptInstances(this.path, this.#preserve(content), cause);",
     "      throw new CorruptInstances(this.path, this.#corruptBackupPath(), cause);"),

    # --- the lock -------------------------------------------------------------
    ("lock: never released, wedging every later reader until it goes stale",
     I,
     "    } finally {\n      release();\n    }",
     "    } finally {\n      void release;\n    }"),
    ("lock: released only on success, so one corrupt file wedges the registry",
     I,
     "      const { entries, value, changed } = f(live);\n"
     "      if (pruned || changed) this.#write(entries);\n"
     "      return value;\n"
     "    } finally {\n"
     "      release();\n"
     "    }",
     "      const { entries, value, changed } = f(live);\n"
     "      if (pruned || changed) this.#write(entries);\n"
     "      release();\n"
     "      return value;\n"
     "    } finally {\n"
     "      void 0;\n"
     "    }"),
    ("lock: an abandoned lock is waited on forever instead of being broken",
     I,
     "    if (lockAgeMs(path) > STALE_LOCK_MS) {",
     "    if (false as boolean) {"),
    ("lock: opened without exclusive create, so two callers both think they hold it",
     I,
     '      closeSync(openSync(path, "wx"));',
     '      closeSync(openSync(path, "w"));'),
    ("lock: named for the file rather than derived, so two processes disagree",
     I,
     '    return this.path.replace(/\\.[^./]*$/, "") + ".lock";',
     '    return this.path + ".lock";'),

    # --- the write ------------------------------------------------------------
    ("write: the temp file is left behind beside the registry",
     I,
     "    renameSync(tmp, this.path);",
     "    writeFileSync(this.path, json);"),
    ("write: absent directories are serialized as null rather than omitted",
     I,
     "    const json = JSON.stringify(entries, null, 2);",
     "    const json = JSON.stringify(\n"
     "      entries.map((e) => ({ ...e, data_dir: e.data_dir ?? null, config_dir: e.config_dir ?? null })),\n"
     "      null,\n"
     "      2,\n"
     "    );"),
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
