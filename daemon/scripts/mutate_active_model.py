#!/usr/bin/env python3
"""Mutation pass over `resolveActiveModelAndOverlay` (#18 / #12).

The function picks the model a chat turn runs on and returns its sampler
overlay *beside* it rather than folded into it. Every step of the chain it runs
is already pinned by the frozen `preferences_parity.json`; what is not is the
composition, so that is what these mutants attack:

- **The chain's inputs.** Character preferences over global, the configured
  default passed through, and a preferences file that will not parse being a
  warning rather than a dead character. The two mutants over the legacy
  `runtime_state.json` are gone with it: 82cab7e3 dropped its last reader, and
  `resolveActiveForCharacter` no longer takes a `legacyActiveModel` at all.
- **The static default.** The one argument that separates this from
  `resolveChatModelForCharacter`: `undefined`, so the overlay holds only what
  preferences set. Folding the catalog in would let a catalog value arrive as a
  preference and outrank one the user set at a lower layer.
- **The shared prefix.** `activeSelection` now serves both functions, so a
  mutant in it has to be caught for both — the frozen fixture covers the chat
  variant and the new tests cover this one.

A mutant is KILLED if `bun test tests/handler_active_model.test.ts
tests/preferences.test.ts` fails with it applied.

This is **11/11**, from 12/14 on the first full pass and 13/13 before the
legacy file went.

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
    python3 daemon/scripts/mutate_active_model.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PREFS = "src/config/preferences.ts"

# (label, find, replace)
MUTANTS = [
    # --- the chain's inputs ---------------------------------------------------
    ("chain: global preferences outrank the character's",
     "    resolveActiveForCharacter(\n"
     "      config,\n"
     "      global,\n"
     "      charPrefs,\n",
     "    resolveActiveForCharacter(\n"
     "      config,\n"
     "      charPrefs,\n"
     "      global,\n"),
    ("chain: character preferences are dropped from the selection",
     "    resolveActiveForCharacter(\n"
     "      config,\n"
     "      global,\n"
     "      charPrefs,\n",
     "    resolveActiveForCharacter(\n"
     "      config,\n"
     "      global,\n"
     "      emptyPreferences(),\n"),
    ("chain: the configured default model is not passed through",
     "      charPrefs,\n      config.app.defaults.model,",
     "      charPrefs,\n      undefined,"),
    ("pin: a thread's pinned model is ignored, so the character's pick always wins",
     "  const resolved =\n    pinned ??",
     "  const resolved =\n    undefined ??"),
    ("pin: a pin that will not resolve leaves the thread mute instead of falling back",
     "  const resolved =\n"
     "    pinned ??\n"
     "    resolveActiveForCharacter(",
     "  const resolved =\n"
     "    threadModel !== undefined\n"
     "      ? pinned\n"
     "      : resolveActiveForCharacter("),
    ("pin: a trailing colon is accepted, so the model_id half may be empty",
     "  if (colon > 0 && colon < pinned.length - 1) {",
     "  if (colon > 0) {"),
    ("pin: nothing is ever read as a provider pair, only as a bare alias",
     "  if (colon > 0 && colon < pinned.length - 1) {",
     "  if (colon > 0 && colon < 0) {"),
    ("pin: the provider and model_id halves of a pair are swapped",
     "      pinned.slice(0, colon),\n"
     "      pinned.slice(colon + 1),",
     "      pinned.slice(colon + 1),\n"
     "      pinned.slice(0, colon),"),
    ("chain: a preferences file that will not parse takes the character down",
     "  let global = emptyPreferences();\n"
     "  let charPrefs = emptyPreferences();\n"
     "  try {\n"
     "    [global, charPrefs] = preferences ?? loadForCharacter(config.dirs.data, character);\n"
     "  } catch (e) {\n"
     "    shoreLog.warn(\n"
     "      `shore: preferences load failed for ${character} (${op}); ` +\n"
     "        `using empty defaults: ${(e as Error).message}`,\n"
     "    );\n"
     "  }\n",
     "  const [global, charPrefs] = preferences ?? loadForCharacter(config.dirs.data, character);\n"
     "  void op;\n"),
    ("chain: preferences are loaded for the wrong character",
     "    [global, charPrefs] = preferences ?? loadForCharacter(config.dirs.data, character);\n  } catch (e) {",
     '    [global, charPrefs] = preferences ?? loadForCharacter(config.dirs.data, "other");\n  } catch (e) {'),

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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(
        MUTANTS,
        ["tests/handler_active_model.test.ts", "tests/preferences.test.ts"],
        src=PREFS,
    )


if __name__ == "__main__":
    sys.exit(main())
