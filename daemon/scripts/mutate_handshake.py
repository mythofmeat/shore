#!/usr/bin/env python3
"""Mutation pass over the SWP handshake provider (#18, step 5).

This module answers two questions a client asks once and then trusts for the
rest of the session, so a wrong answer here does not look like a bug — it looks
like the daemon.

**Which answers are not errors.** Three states arrive at the same empty
snapshot and none of them may throw: no character selected (a fresh
connection), a character with no engine, and a character that has been deleted
since the client last connected. Turning any of them into a throw locks that
client out of the daemon over something it merely remembered.

**Which config is read.** A selected character reads its *effective* config, so
a per-character model override is what the client is shown. Reading the global
one instead reports a model the character will not use, with no error attached
anywhere.

**What the config block falls back to.** Caller's choice, then
`defaults.model`, then the first model in the catalog. The last step is what
stops a config with no default rendering a blank where the model name goes, and
the first is what stops a character switch reporting the model it just replaced.

A mutant is KILLED if `bun test tests/swp_handshake.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_handshake.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
H = "src/swp/handshake.ts"

TESTS = ["tests/swp_handshake.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the hello snapshot ---------------------------------------------------
    ("hello: avatars are looked up under the data dir, so none are ever found",
     H,
     "  const configDir = registry.globalConfig().dirs.config;",
     "  const configDir = registry.globalConfig().dirs.data;"),
    ("hello: the character list is empty whatever is on disk",
     H,
     "    .availableCharacters()\n    .map((name) => characterMetadata(configDir, name));",
     "    .availableCharacters()\n    .map((name) => ({ name }));"),

    # --- which config is read -------------------------------------------------
    ("config: a selected character is read through the global config, not its own",
     H,
     "      ? registry.globalConfig()\n      : registry.effectiveConfig(selectedCharacter);",
     "      ? registry.globalConfig()\n      : registry.globalConfig();"),

    # --- what is not an error -------------------------------------------------
    ("engine: a character that is gone refuses the handshake instead of answering empty",
     H,
     "  try {\n    return await registry.getOrCreate(character);\n  } catch {\n    return undefined;\n  }",
     "  return await registry.getOrCreate(character);"),
    ("engine: no character selected still asks the registry for one",
     H,
     "  const engine = selectedCharacter === null ? undefined : await engineOrUndefined(registry, selectedCharacter);",
     "  const engine = await engineOrUndefined(registry, selectedCharacter as string);"),
    ("engine: an empty snapshot drops the config block the client renders from",
     H,
     "      messages: [],\n      activeStart: 0,\n      config: configBlock,",
     "      messages: [],\n      activeStart: 0,\n      config: {},"),

    # --- what a live snapshot carries -----------------------------------------
    ("snapshot: the revision is always zero, so the client never sees a change",
     H,
     "    revision: history.revision,",
     "    revision: 0,"),
    ("snapshot: the requested character is echoed rather than the resolved one",
     H,
     "    selectedCharacter: history.selected_character ?? null,",
     "    selectedCharacter: selectedCharacter,"),
    ("snapshot: an unset active_start becomes NaN rather than zero",
     H,
     "    activeStart: history.active_start ?? 0,",
     "    activeStart: history.active_start as number,"),

    # --- the model the config block reports -----------------------------------
    ("model: the caller's choice is ignored in favour of a fresh resolution",
     H,
     "  if (activeModel !== undefined) return activeModel;",
     "  if (false as boolean) return activeModel as string;"),
    ("model: the config default outranks the caller's choice",
     H,
     "      activeModel ?? config.app.defaults.model ?? firstChatModel(config.models)?.qualifiedName ?? null,",
     "      config.app.defaults.model ?? activeModel ?? firstChatModel(config.models)?.qualifiedName ?? null,"),
    ("model: the catalog fallback is dropped, so a config with no default reports nothing",
     H,
     "      activeModel ?? config.app.defaults.model ?? firstChatModel(config.models)?.qualifiedName ?? null,",
     "      activeModel ?? config.app.defaults.model ?? null,"),
    ("model: a missing model is reported as absent rather than as null",
     H,
     "?.qualifiedName ?? null,",
     "?.qualifiedName ?? undefined,"),
    ("model: preferences are never consulted, so a character's own pick is invisible",
     H,
     "  return resolveChatModelForCharacter(configView(config), selectedCharacter, findEffectiveModel)\n"
     "    ?.qualifiedName;",
     "  return undefined;"),
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
