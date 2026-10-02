#!/usr/bin/env python3
"""Mutation pass over the handler's command path: the route a command takes,
how an unresolvable character is reported, the config each route is handed,
and the reply's rid.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COMMANDS = ROOT / "src/handler/commands.ts"

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
     '  if (isCharacterless(cmd.name) && !(cmd.name === "list_models" && selected !== undefined)) {',
     '  if (isCharacterless(cmd.name) && cmd.name !== "refresh_provider_models" && !(cmd.name === "list_models" && selected !== undefined)) {'),
    ("route: switch_character takes the character path",
     '  if (cmd.name === "switch_character") {\n    return await switchCharacterCommand(deps, cmd, sessionId, rid, selected);\n  }',
     ""),
    ("route: every command is characterless",
     "  let character: string;",
     "  return characterlessCommand(deps, cmd, sessionId, selected, rid, signal);\n  let character: string;"),

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
     "    config = deps.registry.effectiveConfig(character);",
     "    config = deps.globalConfig();"),
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
    ("rid: the character path drops it",
     "  return frameWithRid(frame, rid);\n}\n\nexport function liveThread(",
     "  return frame;\n}\n\nexport function liveThread("),
    ("rid: the switch_character path drops it",
     "  return frameWithRid(frame, rid);\n}\n\nasync function characterlessCommand(",
     "  return frame;\n}\n\nasync function characterlessCommand("),
    ("rid: the characterless path drops it",
     "  return frameWithRid(frame, rid);\n}\n\nfunction characterSession(",
     "  return frame;\n}\n\nfunction characterSession("),
    ("rid: nothing attaches it at all",
     "  if (rid === undefined) return frame;\n  switch (frame.type) {",
     "  return frame;\n  switch (frame.type) {"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/command_path.test.ts"], src=COMMANDS)


if __name__ == "__main__":
    sys.exit(main())
