#!/usr/bin/env python3
"""Mutation pass over the handler's command path (#18 / #12).

This layer computes almost nothing. It decides which of three paths a command
takes, what a request whose character cannot be resolved gets told, what the
session remembers afterwards, and whether the answer carries the rid it was
asked under. Every one of those is invisible to a test that only checks that a
command answered — which is what makes the mutants here worth writing.

The mutants cover five things:

- **The routing**, including the one decision that is per-*request* rather than
  per-name: `list_models` is characterless only while no character is selected.
- **Character resolution**, and the code each of its two failures reports —
  `invalid_request` for a client that can fix it by choosing, `internal_error`
  for one that cannot.
- **The session cache**: that it is written, that it is written *after* the
  command rather than before, and that it holds the qualified name.
- **The contexts**: the character path gets the character-effective config, the
  characterless path gets the global one.
- **The rid**, on every path — including the three the Rust dropped it for,
  which is this port's one deliberate divergence and so has to be pinned from
  this side rather than from the fixture.

A mutant is KILLED if `bun test tests/command_path_parity.test.ts` fails with
it applied.

This is **18/18**, from 11/18 on the first pass.

Seven survivors, and the shape of them was the usual one — cases present with
nothing load-bearing in them:

- **The world was too uniform.** `switch_model` was passed `model` where the
  command reads `name`, so it never switched; the session cache therefore held
  the app default on every path, and "did the cache get read" and "was it read
  before or after the command" had the same answer either way. A second model
  in the catalog and the right argument fixed four mutants at once.
- **The frame kept too little.** A characterless command's answer differed from
  a character-backed one only in its `active` field, which the recorded
  envelope did not carry. It does now — one field, and the only place the
  cache's effect is visible.
- **One survivor was a no-op in the Rust too.** The characterless path wrote
  the context's active model back to the session, but `dispatch_characterless`
  took its context by shared reference: nothing on that path could change it.
  The line is gone from the port rather than mutated here.
- **Two decisions no recorded case reaches** — an engine that will not open,
  and the character-effective config — are asserted in the replay with their
  reasons, and the mutants aim at those assertions.

Run from the repository root:
    python3 llm-sidecar/scripts/mutate_command_path.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
P = "src/handler/commands.ts"

# (label, find, replace)
MUTANTS = [
    # --- routing --------------------------------------------------------------
    ("route: list_models is always characterless",
     '  if (isCharacterless(cmd.name) && !(cmd.name === "list_models" && selected !== undefined)) {',
     "  if (isCharacterless(cmd.name)) {"),
    ("route: list_models is never characterless",
     '  if (isCharacterless(cmd.name) && !(cmd.name === "list_models" && selected !== undefined)) {',
     '  if (isCharacterless(cmd.name) && cmd.name !== "list_models") {'),
    ("route: nothing is characterless",
     '  if (isCharacterless(cmd.name) && !(cmd.name === "list_models" && selected !== undefined)) {',
     "  if (false) {"),
    ("route: refresh_provider_models takes the character path",
     '  if (cmd.name === "refresh_provider_models") {\n    return characterlessCommand(deps, cmd, sessionId, rid);\n  }',
     ""),
    ("route: every command is characterless",
     "  let character: string;",
     "  return characterlessCommand(deps, cmd, sessionId, rid);\n  let character: string;"),

    # --- character resolution -------------------------------------------------
    ("resolve: an unresolvable character is an internal error",
     "    return frameWithRid(commandFrame(cmd.name, { err: invalidRequest(message) }), rid);",
     "    return frameWithRid(commandFrame(cmd.name, { err: internalError(message) }), rid);"),
    ("resolve: an engine that will not open is an invalid request",
     "    return frameWithRid(commandFrame(cmd.name, { err: internalError(message) }), rid);",
     "    return frameWithRid(commandFrame(cmd.name, { err: invalidRequest(message) }), rid);"),
    ("resolve: the selection is ignored and the sole character always wins",
     "    character = deps.registry.resolveCharacter(selected);",
     "    character = deps.registry.resolveCharacter(undefined);"),

    # --- the session cache ----------------------------------------------------
    ("cache: the active model is mirrored before the command rather than after",
     "  // Whatever the command did to the active model, the session remembers. Read\n  // after the command, so `switch_model` and `reset_model` are reflected and a\n  // command that failed leaves whatever the context was built with.\n  deps.sessions.setActiveModel(sessionId, session.activeModel);",
     "  // moved above the command by the mutant\n"),
    ("cache: the mirror reads the context built before the command ran",
     "  deps.sessions.setActiveModel(sessionId, session.activeModel);\n  return frameWithRid(frame, rid);",
     "  return frameWithRid(frame, rid);"),
    ("cache: the session holds the model's short name, not its qualified one",
     "    activeModel: model?.qualifiedName,",
     "    activeModel: model?.name,"),
    ("cache: the characterless context starts with no active model",
     "    activeModel: deps.sessions.activeModel(sessionId),",
     "    activeModel: undefined,"),

    # --- the contexts ---------------------------------------------------------
    ("context: the character path is given the global config",
     "  const config = deps.registry.effectiveConfig(character);",
     "  const config = deps.globalConfig();"),
    ("context: the post-processing is given the config from before the command",
     "      // reloads mutate it in place, and it is the new value the post-processing\n      // pushes outward.\n      config: session.config,",
     "      // reloads mutate it in place, and it is the new value the post-processing\n      // pushes outward.\n      config,"),
    ("context: the post-processing never runs",
     "    const annotated = await afterCommand(cmd.name, cmd.args, data, {",
     "    const annotated = data as unknown;\n    void afterCommand;\n    const _unused = ((): unknown => ({"),

    # --- the rid --------------------------------------------------------------
    ("rid: the character path drops it, as the Rust's characterless path did",
     "  deps.sessions.setActiveModel(sessionId, session.activeModel);\n  return frameWithRid(frame, rid);",
     "  deps.sessions.setActiveModel(sessionId, session.activeModel);\n  return frame;"),
    ("rid: nothing attaches it at all",
     "  if (rid === undefined) return frame;\n  if (frame.type === \"command_output\" || frame.type === \"error\") return { ...frame, rid };",
     "  if (frame.type === \"command_output\" || frame.type === \"error\") return frame;"),
    ("rid: the characterless path drops it, reproducing the Rust's bug",
     "  // of its own.\n  return frameWithRid(frame, rid);",
     "  // of its own.\n  return frame;"),
]


def run() -> bool:
    r = subprocess.run(
        ["bun", "test", "tests/command_path_parity.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return r.returncode == 0


def main() -> None:
    original = (ROOT / P).read_text()
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, find, replace) in enumerate(MUTANTS, 1):
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / P).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / P).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    (ROOT / P).write_text(original)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
