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
    python3 daemon/scripts/mutate_daemon_hot_reload.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
S = "src/daemon/hot_reload.ts"

TESTS = ["tests/daemon_hot_reload.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- reloading too much ---------------------------------------------------
    ("workspace: a workspace save reloads whatever the file is", S,
     "  if (first === \"characters\" && parts[2] === CHARACTER_WORKSPACE_DIR) {\n"
     "    const name = parts[1];\n    return (\n"
     "      parts.length === 4 &&\n"
     "      parts[3] === SOUL_FILE &&",
     "  if (first === \"characters\" && parts[2] === CHARACTER_WORKSPACE_DIR) {\n"
     "    const name = parts[1];\n    return (\n"
     "      true &&\n"
     "      true &&"),
    ("workspace: the check is on the wrong depth, so it never matches",
     S,
     '  if (first === "characters" && parts[2] === CHARACTER_WORKSPACE_DIR) {',
     '  if (first === "characters" && parts[1] === CHARACTER_WORKSPACE_DIR) {'),
    ("workspace: a SOUL.md for a character the daemon already knows still reloads",
     S,
     "      knownCharacter !== undefined &&\n      !knownCharacter(name)",
     "      knownCharacter !== undefined"),
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
     "    if (timer !== undefined) clock.clear(timer);\n    timer = clock.set(fire, debounceMs);",
     "    timer = clock.set(fire, debounceMs);"),
    ("watcher: the accumulated paths are dropped, so a reload cannot say what moved",
     S,
     "    const changedPaths = [...pending].sort();",
     "    const changedPaths: string[] = [];"),
    ("watcher: stopping leaves an armed debounce to fire into a torn-down runtime",
     S,
     "      stopped = true;\n      if (timer !== undefined) clock.clear(timer);",
     "      if (timer !== undefined) clock.clear(timer);"),
    ("watcher: stopping does not clear the pending timer",
     S,
     "    stop: async () => {\n      stopped = true;",
     "    stop: async () => {\n      void 0;"),
    ("watcher: stopping does not wait for a reload already running",
     S,
     "      await inFlight;\n", ""),
    ("watcher: the filter is not applied to what the watch reports",
     S,
     "          if (triggers(path)) note(path);",
     "          void triggers;\n          note(path);"),
    ("watcher: a directory that cannot be watched throws instead of warning",
     S,
     "    } catch (e) {\n"
     '      options.log?.warn?.("Config hot reload watcher could not start", {',
     "    } catch (e) {\n      throw e;\n"
     '      options.log?.warn?.("Config hot reload watcher could not start", {'),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
