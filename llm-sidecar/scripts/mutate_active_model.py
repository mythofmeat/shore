#!/usr/bin/env python3
"""Mutation pass over `resolveActiveModelAndOverlay` (#18 / #12).

The function picks the model a chat turn runs on and returns its sampler
overlay *beside* it rather than folded into it. Every step of the chain it runs
is already pinned by the frozen `preferences_parity.json`; what is not is the
composition, so that is what these mutants attack:

- **The chain's inputs.** Character preferences over global, the legacy
  `runtime_state.json` read from the character's own directory, the configured
  default passed through, and a preferences file that will not parse being a
  warning rather than a dead character.
- **The static default.** The one argument that separates this from
  `resolveChatModelForCharacter`: `undefined`, so the overlay holds only what
  preferences set. Folding the catalog in would let a catalog value arrive as a
  preference and outrank one the user set at a lower layer.
- **The shared prefix.** `activeSelection` now serves both functions, so a
  mutant in it has to be caught for both — the frozen fixture covers the chat
  variant and the new tests cover this one.

A mutant is KILLED if `bun test tests/handler_active_model.test.ts
tests/preferences_parity.test.ts` fails with it applied.

This is **13/13**, from 12/14 on the first full pass.

One survivor was a real gap and is now covered: the overlay's `(provider,
model_id)` key could be swapped, because every case set preferences under
`[defaults.sampler]` and none under `[models."<provider>:<model_id>"]`. Two
model-scoped cases were added.

The other survivor is equivalent, and two more mutants were written, tried and
removed for the same reason:

- **Dropping the static default from `resolveChatModelForCharacter`.** There it
  changes nothing. `resolveSamplerSettings` puts the static default at the
  *lowest* layer, so every value it contributes is one no preference overrode —
  and the result goes straight back onto the model those values came from, via
  an `applySamplerOverlay` that only ever writes fields that are present. The
  one field that could differ is `sdk`, and `sdkFromWire` accepts every variant
  a `ResolvedModel` can hold, so it round-trips. It is passed because the Rust
  passed it, and because the one difference that does exist — an overlay that
  is never empty — is invisible to a caller that never sees the overlay. That
  is exactly what stops being true in `resolveActiveModelAndOverlay`, where the
  same mutant is killed.
- **Returning `{ model: resolved, overlay: {} }` instead of
  `{ model: undefined, overlay: {} }` in the no-model branch.** The branch is
  only reached when `resolved` is already `undefined`, so the two spell the
  same value. It is written out because the return type says the model is
  optional and reading the branch should not require proving that.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_active_model.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PREFS = "src/config/preferences.ts"

# (label, find, replace)
MUTANTS = [
    # --- the chain's inputs ---------------------------------------------------
    ("chain: the legacy file is read from the data root, not the character's directory",
     "  const legacy = loadActiveModel(join(config.dirs.data, character));",
     "  const legacy = loadActiveModel(config.dirs.data);"),
    ("chain: the legacy file is never read",
     "  const legacy = loadActiveModel(join(config.dirs.data, character));",
     "  const legacy = undefined;"),
    ("chain: global preferences outrank the character's",
     "  const resolved = resolveActiveForCharacter(\n"
     "    config,\n"
     "    global,\n"
     "    charPrefs,\n"
     "    legacy,",
     "  const resolved = resolveActiveForCharacter(\n"
     "    config,\n"
     "    charPrefs,\n"
     "    global,\n"
     "    legacy,"),
    ("chain: character preferences are dropped from the selection",
     "  const resolved = resolveActiveForCharacter(\n"
     "    config,\n"
     "    global,\n"
     "    charPrefs,\n"
     "    legacy,",
     "  const resolved = resolveActiveForCharacter(\n"
     "    config,\n"
     "    global,\n"
     "    emptyPreferences(),\n"
     "    legacy,"),
    ("chain: the configured default model is not passed through",
     "    legacy,\n    config.app.defaults.model,",
     "    legacy,\n    undefined,"),
    ("chain: a preferences file that will not parse takes the character down",
     "  let global = emptyPreferences();\n"
     "  let charPrefs = emptyPreferences();\n"
     "  try {\n"
     "    [global, charPrefs] = loadForCharacter(config.dirs.data, character);\n"
     "  } catch (e) {\n"
     "    console.warn(\n"
     "      `shore: preferences load failed for ${character} (${op}); ` +\n"
     "        `using empty defaults: ${(e as Error).message}`,\n"
     "    );\n"
     "  }\n",
     "  const [global, charPrefs] = loadForCharacter(config.dirs.data, character);\n"
     "  void op;\n"),
    ("chain: preferences are loaded for the wrong character",
     "    [global, charPrefs] = loadForCharacter(config.dirs.data, character);",
     '    [global, charPrefs] = loadForCharacter(config.dirs.data, "other");'),

    # --- the static default, which is the whole divergence --------------------
    ("overlay: the catalog is folded in, as the chat path does",
     "      resolved.providerKey,\n      resolved.modelId,\n      undefined,\n    ),",
     "      resolved.providerKey,\n      resolved.modelId,\n      resolved,\n    ),"),
    ("overlay: the chat path returns the model without applying its overlay",
     "  return applySamplerOverlay(resolved, overlay);",
     "  return resolved;"),

    # --- the overlay's own inputs ---------------------------------------------
    ("overlay: character preferences do not reach it",
     "    overlay: resolveSamplerSettings(\n      global,\n      charPrefs,",
     "    overlay: resolveSamplerSettings(\n      global,\n      undefined,"),
    ("overlay: it is always empty",
     "  return {\n    model: resolved,\n    overlay: resolveSamplerSettings(",
     "  return {\n    model: resolved,\n    overlay: {},\n    unused: resolveSamplerSettings("),
    ("overlay: it is resolved for the provider and model swapped",
     "      resolved.providerKey,\n      resolved.modelId,\n      undefined,",
     "      resolved.modelId,\n      resolved.providerKey,\n      undefined,"),

    # --- the return -----------------------------------------------------------
    ("return: the resolved model is dropped, so every turn falls back",
     "  return {\n    model: resolved,",
     "  return {\n    model: undefined,"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/handler_active_model.test.ts", "tests/preferences_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = (ROOT / PREFS).read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / PREFS).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / PREFS).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    (ROOT / PREFS).write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
