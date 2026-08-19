#!/usr/bin/env python3
"""Mutation pass over the handler's command path (#18 / #12).

This layer computes almost nothing. It decides which of four paths a command
takes, what a request whose character cannot be resolved gets told, which config
each path is handed, and whether the answer carries the rid it was asked under.
Every one of those is invisible to a test that only checks that a command
answered — which is what makes the mutants here worth writing.

The mutants cover four things:

- **The routing**, including the one decision that is per-*request* rather than
  per-name: `list_models` is characterless only while no character is selected.
  `switch_character` is its own path because it runs before a character can be
  resolved — the whole point of it is that the session has not chosen one yet.
- **Character resolution**, and the code each of its two failures reports —
  `invalid_request` for a client that can fix it by choosing, `internal_error`
  for one that cannot.
- **The contexts**: the character path gets the character-effective config, the
  characterless path gets the global one, and the post-processing gets the
  config the command left behind rather than the one the dispatch started with,
  because `config_reload` replaces it on the session object mid-command.
- **The rid**, on all three paths that attach it — including the three commands
  the Rust dropped it for, which is this port's one deliberate divergence and so
  has to be pinned from this side rather than from the fixture.

A mutant is KILLED if `bun test tests/command_path.test.ts` fails with it
applied.

The session model cache these mutants used to probe is gone: 58338805 deleted
`ProcessSessionCache` along with the mirror-back write, the read on the
characterless path, and the ordering between them. Four mutants went with it.

What survives of it is one line, and mutating it found a live bug. 58338805 left
`characterSession` filling `CommandSession.activeModel` from
`resolveActiveModelAndOverlay`, which falls back to `[defaults].model` when the
character has saved nothing — and the field's only remaining reader is
`masked_by_preference`, which reports "this character still uses X" whenever it
differs from the configured default. A qualified name never equals the raw
config string, so every `config set defaults.model` on the character path
claimed a preference was masking it, including for characters with no
preferences file at all. The field now holds the character's *saved* selection
or nothing, which is what its reader always meant, and two cases here dispatch
`config` on the character path to hold it there.

Run from the repository root:
    python3 daemon/scripts/mutate_command_path.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMMANDS = ROOT / "src/handler/commands.ts"

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
     '  if (cmd.name === "refresh_provider_models") {\n    return characterlessCommand(deps, cmd, sessionId, selected, rid);\n  }',
     ""),
    ("route: switch_character takes the character path",
     '  if (cmd.name === "switch_character") {\n    return await switchCharacterCommand(deps, cmd, sessionId, rid, selected);\n  }',
     ""),
    ("route: every command is characterless",
     "  let character: string;",
     "  return characterlessCommand(deps, cmd, sessionId, selected, rid);\n  let character: string;"),

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

    # --- the saved model preference -------------------------------------------
    ("saved model: the session holds the model's short name, not its qualified one",
     "    activeModel: saved?.qualifiedName,",
     "    activeModel: saved?.name,"),
    ("saved model: the app default is mirrored too, so an unsaved character masks it",
     "    activeModel: saved?.qualifiedName,",
     "    activeModel: saved?.qualifiedName ?? config.app.defaults.model,"),

    # --- the contexts ---------------------------------------------------------
    ("context: the character path is given the global config",
     "  const config = deps.registry.effectiveConfig(character);",
     "  const config = deps.globalConfig();"),
    ("context: the post-processing is given the config from before the command",
     "      character,\n      config: session.config,\n      sessionId,",
     "      character,\n      config,\n      sessionId,"),
    ("context: the post-processing never runs",
     "    const data = await runCommand(engine, session, deps.commands, cmd);\n"
     "    const annotated = await afterCommand(cmd.name, cmd.args, data, {\n"
     "      character,\n"
     "      config: session.config,\n"
     "      sessionId,\n"
     "      rid,\n"
     "      runtime: deps.dispatchRuntime,\n"
     "      router: deps.router,\n"
     "      handshake: deps.handshake,\n"
     "    });",
     "    const data = await runCommand(engine, session, deps.commands, cmd);\n"
     "    const annotated = data;"),

    # --- the rid --------------------------------------------------------------
    ("rid: the character path drops it, as the Rust's characterless path did",
     "  return frameWithRid(frame, rid);\n}\n\nasync function switchCharacterCommand(",
     "  return frame;\n}\n\nasync function switchCharacterCommand("),
    ("rid: the switch_character path drops it",
     "  return frameWithRid(frame, rid);\n}\n\nasync function characterlessCommand(",
     "  return frame;\n}\n\nasync function characterlessCommand("),
    ("rid: the characterless path drops it, reproducing the Rust's bug",
     "  return frameWithRid(frame, rid);\n}\n\nasync function refreshProviderModels(",
     "  return frame;\n}\n\nasync function refreshProviderModels("),
    ("rid: nothing attaches it at all",
     "  if (rid === undefined) return frame;\n  if (frame.type === \"command_output\" || frame.type === \"error\") return { ...frame, rid };",
     "  if (frame.type === \"command_output\" || frame.type === \"error\") return frame;"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/command_path.test.ts"], src=COMMANDS)


if __name__ == "__main__":
    sys.exit(main())
