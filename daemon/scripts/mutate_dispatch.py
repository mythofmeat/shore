#!/usr/bin/env python3
"""Mutation pass over the command table: every name reaches its own handler,
and the reply envelope.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DISPATCH = ROOT / "src/commands/dispatch.ts"

MUTANTS = [
    # --- arms reaching the wrong handler --------------------------------------
    ("wire: `get` reaches `alt`", "src/commands/registry.ts",
     '(context, args) => get(engineOf(context), args)',
     '(context, args) => alt(engineOf(context), args)'),
    ("wire: `log` drops its role and count filters", "src/commands/registry.ts",
     '(context, args) => log(engineOf(context), args)',
     '(context, args) => log(engineOf(context), {})'),
    ("wire: `history_page` reaches `log`", "src/commands/registry.ts",
     '(context, args) => historyPage(engineOf(context), args)',
     '(context, args) => log(engineOf(context), args)'),
    ('wire: `switch_model` reaches `reset_model`',
     'src/commands/registry.ts',
     '      return switchModel(session, args);',
     '      return resetModel(session);'),
    ('wire: `reset_model` reaches `switch_model`',
     'src/commands/registry.ts',
     '      return resetModel(session, args);',
     '      return switchModel(session, args);'),
    ('wire: `model_info` reaches `model_settings`',
     'src/commands/registry.ts',
     '({ session }, args) => modelInfo(session, args)',
     '({ session }, args) => modelSettings(session, args)'),
    ("wire: `list_providers` reaches `list_provider_models`", "src/commands/registry.ts",
     '(context) => listProviders(providersContext(context))',
     '(context) => listProviderModels(providersContext(context), { provider: "anthropic" })'),
    ("wire: `refresh_provider_models` reaches the refresh-all arm", "src/commands/registry.ts",
     '(context, args) => refreshProviderModels(providersContext(context), args)',
     '(context, args) => refreshAllProviderModels(providersContext(context))'),
    ('wire: `call_log` reaches `transcript`',
     'src/commands/registry.ts',
     '(context, args) => callLog({ characterName: engineOf(context).characterName, callStore: '
     'context.deps.callStore }, args)',
     '(context, args) => transcript({ characterName: engineOf(context).characterName, callStore: '
     'context.deps.callStore }, args)'),
    ('wire: `heartbeat_set_dormant` reaches the active setter',
     'src/commands/registry.ts',
     '(context) => heartbeatSetDormant(statusContext(engineOf(context), context.session, context.deps))',
     '(context) => heartbeatSetActive(statusContext(engineOf(context), context.session, context.deps))'),
    ("wire: `config_check` reaches `config_reload`", "src/commands/registry.ts",
     '({ session }) => configCheck(session, session.env ?? process.env)',
     '({ session }) => configReload(session, {})'),
    ("wire: `character_info` is given the data dir as its config dir", "src/commands/registry.ts",
     "    configDir: context.session.config.dirs.config,",
     "    configDir: context.session.dataDir,"),

    # --- arms going missing ---------------------------------------------------
    ("missing: `inject_system` is not in the table", "src/commands/registry.ts",
     '  inject_system: register("inject_system",',
     '  missing_inject_system: register("inject_system",'),
    ("missing: `tools` is not in the table", "src/commands/registry.ts",
     '  tools: register("tools",',
     '  missing_tools: register("tools",'),
    ('missing: `transcript` is not in the table',
     'src/commands/registry.ts',
     '  transcript: register("transcript",',
     '  missing_transcript: register("transcript",'),

    # --- the characterless split ---------------------------------------------
    ('split: `status` answers without a character',
     '): unknown {\n  if (isRegisteredOperation(cmd.name)) {',
     '): unknown {\n  if (cmd.name === "status") return {};\n  if (isRegisteredOperation(cmd.name)) {'),
    ("split: `list_providers` is refused without a character", "src/commands/registry.ts",
     'list_providers: register("list_providers", { ...providerPresentation,',
     'list_providers: register("list_providers", { ...providerPresentation, scope: "character",'),
    ("split: the predicate and the table disagree about `list_providers`",
     'return isRegisteredOperation(name) && commandOperations[name].presentation.scope === "global";',
     'return name !== "list_providers" && isRegisteredOperation(name) && commandOperations[name].presentation.scope === "global";'),
    ("split: the characterless `list_characters` marks an active character", "src/commands/registry.ts",
     "listCharacters(session.config.dirs.config, engine?.characterName, session.config.dirs.workspace)",
     'listCharacters(session.config.dirs.config, "ada", session.config.dirs.workspace)'),

    # --- the envelope ---------------------------------------------------------
    ("envelope: the reply carries the character's name instead of the command's",
     '    return { type: "command_output", rid: null, name, data: outcome.ok };',
     '    return { type: "command_output", rid: null, name: "command", data: outcome.ok };'),
    ("envelope: every failure reports invalid_request",
     "  return { type: \"error\", rid: null, code: error.code, message: error.message };",
     "  return { type: \"error\", rid: null, code: \"invalid_request\", message: error.message };"),
    ("envelope: an unknown name is reported as not_found",
     "  throw invalidRequest(`Unknown command: ${cmd.name}`);",
     "  throw notFound(`Unknown command: ${cmd.name}`);"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/dispatch_command.test.ts"], src=DISPATCH)


if __name__ == "__main__":
    sys.exit(main())
