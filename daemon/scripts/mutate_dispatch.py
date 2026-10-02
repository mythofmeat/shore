#!/usr/bin/env python3
"""Mutation pass over the command table (#18 / #12).

A dispatch table is the one kind of code where a typo is invisible: every arm
returns *something*, and an arm wired to the neighbouring handler answers in a
shape close enough that a test checking "did it answer" passes. So the mutants
are almost all cross-wirings — send a name to the handler beside it, drop an
arm, swap the two lists — plus the envelope, which is the only thing here that
is not routing.

The mutants cover four things:

- **Arms reaching the wrong handler.** Neighbours first, because those are the
  ones a careless edit produces: `get`/`alt`, `log`/`history_page`,
  `switch_model`/`reset_model`, `list_providers`/`list_provider_models`.
- **Arms going missing.** A deleted arm falls to the default and becomes
  "unknown command", which is exactly what a client sees when a name was never
  added — so it has to be caught here or not at all.
- **The characterless split.** A name in one table and not the other, in both
  directions: a command that needs a character answering without one, and one
  that does not being refused.
- **The envelope.** The command's own name on the way back, the two error
  codes, and the fact that a non-`CommandError` throw becomes an internal error
  rather than escaping the dispatcher.

A mutant is KILLED if `bun test tests/dispatch_command.test.ts` fails
with it applied.

This is **24/24**, from 15/24 on the first pass.

Nine survivors, and all nine were the same finding: the fixture's world was
empty. Driven against a bare temp dir with no messages, no models and no
characters, `get` and `alt` both answer "index out of range", `log` and
`history_page` return the same window, `model_info` and `model_settings` both
answer "no model specified", and the two heartbeat setters both refuse. None of
those pairs can be told apart by any test, because the *Rust* cannot tell them
apart either under those inputs.

So the fixture was regenerated against a world with something in it — three
messages, three characters (one sorting before the active one), a model named
as the default, two memory files, live autonomy state — and the recorded shape
grew four discriminators: a `status` string, a number, an array's length, and
an array-of-named-things' names. Eight of the nine died to that. The ninth,
the characterless `list_characters` marking an active character, needed the
characterless section to record a shape at all, which it now does.

Run from the repository root:
    python3 daemon/scripts/mutate_dispatch.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DISPATCH = ROOT / "src/commands/dispatch.ts"
D = "src/commands/dispatch.ts"

# (label, find, replace)
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
