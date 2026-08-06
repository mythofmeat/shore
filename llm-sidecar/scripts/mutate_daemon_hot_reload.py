#!/usr/bin/env python3
"""Mutation pass over the config watcher (#18, step 5).

Two families, and they fail in opposite directions.

**Reloading too little.** A path rule that misses `conf.d/*.toml` or a
character's `config.toml` gives a daemon that looks like it hot-reloads and
silently does not for half its inputs. The user edits a file, sees nothing
happen, and has no reason to suspect the filter.

**Reloading too much.** This is the worse one. The config tree also holds every
character's prompts and memory, and a reload is a natural place to rebuild a
prompt — so a filter that let `characters/<n>/workspace/**` through would turn a
filesystem save into a prompt activation boundary. A character writing its own
memory mid-turn would invalidate the cache it is talking through, and the
keepalive would then pay for a write that buys nothing. That is why the
workspace check runs *before* the `.toml` catch-all: the memory directory is
full of `.toml`.

**Debounce.** An editor writing one file produces several events and a
`git checkout` produces hundreds. Without the debounce every one of them is a
config load and a full character rescan.

A mutant is KILLED if `bun test tests/daemon_hot_reload.test.ts` fails with it
applied.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_daemon_hot_reload.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/daemon/hot_reload.ts"

TESTS = ["tests/daemon_hot_reload.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- reloading too much ---------------------------------------------------
    ("workspace: prompts and memory trigger reloads, making a save a prompt boundary",
     S,
     '  if (first === "characters" && parts[2] === "workspace") return false;',
     "  // dropped"),
    ("workspace: the check is on the wrong depth, so it never matches",
     S,
     '  if (first === "characters" && parts[2] === "workspace") return false;',
     '  if (first === "characters" && parts[1] === "workspace") return false;'),
    ("workspace: the check runs after the character rules, so memory .toml gets through",
     S,
     '  if (first === "characters" && parts[2] === "workspace") return false;\n\n'
     '  if (parts.length === 1 && first === ".env") return true;',
     '  if (parts.length === 1 && first === ".env") return true;'),
    ("filter: everything under the tree reloads",
     S,
     "  return hasTomlExtension(path);\n}\n\nfunction absolutize",
     "  return true;\n}\n\nfunction absolutize"),
    ("filter: any file named .env reloads, not just the root one",
     S,
     '  if (parts.length === 1 && first === ".env") return true;',
     '  if (first === ".env") return true;'),
    ("filter: a path outside the config tree reloads",
     S,
     "  const relative = stripPrefix(configDir, path);\n  if (relative === undefined) return false;",
     "  const relative = stripPrefix(configDir, path) ?? path;"),

    # --- reloading too little -------------------------------------------------
    ("filter: the config file itself only counts when it is inside the tree",
     S,
     "  if (path === configPath) return true;",
     "  // dropped"),
    ("filter: conf.d is ignored",
     S,
     '  if (first === "conf.d") return parts.length === 1 || hasTomlExtension(path);',
     '  if (first === "conf.d") return false;'),
    ("filter: a character's config.toml is ignored",
     S,
     '  if (parts.length === 3 && (parts[2] === "config.toml" || parts[2] === "character.md")) {\n'
     "      return true;\n"
     "    }",
     "  // dropped"),
    ("filter: a character appearing or going is ignored",
     S,
     "    if (parts.length === 2) return true;",
     "    // dropped"),
    ("filter: character.md is not a definition",
     S,
     '    if (parts.length === 3 && (parts[2] === "config.toml" || parts[2] === "character.md")) {',
     '    if (parts.length === 3 && parts[2] === "config.toml") {',
     ),
    ("filter: a bare .toml elsewhere in the tree is ignored",
     S,
     "  return hasTomlExtension(path);\n}\n\nfunction absolutize",
     "  return false;\n}\n\nfunction absolutize"),

    # --- the watcher ----------------------------------------------------------
    ("watcher: no debounce, so a burst is one reload per event",
     S,
     "      if (timer !== undefined) clearTimeout(timer);\n"
     "      timer = setTimeout(fire, debounceMs);",
     "      timer = setTimeout(fire, debounceMs);"),
    ("watcher: the accumulated paths are dropped, so a reload cannot say what moved",
     S,
     "    const changedPaths = [...pending].sort();",
     "    const changedPaths: string[] = [];"),
    ("watcher: stopping leaves an armed debounce to fire into a torn-down runtime",
     S,
     "      stopped = true;\n      if (timer !== undefined) clearTimeout(timer);",
     "      if (timer !== undefined) clearTimeout(timer);"),
    ("watcher: stopping does not clear the pending timer",
     S,
     "    stop: () => {\n      stopped = true;",
     "    stop: () => {\n      void 0;"),
    ("watcher: the filter is not applied to what the watch reports",
     S,
     "      if (!pathTriggersReload(options.configDir, options.configPath, path)) return;",
     "      // dropped"),
    ("watcher: a directory that cannot be watched throws instead of warning",
     S,
     "  } catch (e) {\n"
     '    options.log?.warn?.("Config hot reload watcher could not start", {',
     "  } catch (e) {\n"
     "    throw e;\n"
     '    options.log?.warn?.("Config hot reload watcher could not start", {'),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=180,
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
