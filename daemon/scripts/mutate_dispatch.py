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

A mutant is KILLED if `bun test tests/dispatch_command_parity.test.ts` fails
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
D = "src/commands/dispatch.ts"

# (label, find, replace)
MUTANTS = [
    # --- arms reaching the wrong handler --------------------------------------
    ("wire: `get` reaches `alt`",
     '    case "get":\n      return get(engine, args);',
     '    case "get":\n      return await alt(engine, args);'),
    ("wire: `log` reaches `history_page`",
     '    case "log":\n      return await log(engine, args);',
     '    case "log":\n      return await historyPage(engine, args);'),
    ("wire: `history_page` reaches `log`",
     '    case "history_page":\n      return await historyPage(engine, args);',
     '    case "history_page":\n      return await log(engine, args);'),
    ("wire: `switch_model` reaches `reset_model`",
     '    case "switch_model":\n      return switchModel(session, args);',
     '    case "switch_model":\n      return resetModel(session);'),
    ("wire: `reset_model` reaches `switch_model`",
     '    case "reset_model":\n      return resetModel(session);',
     '    case "reset_model":\n      return switchModel(session, args);'),
    ("wire: `model_info` reaches `model_settings`",
     '    case "model_info":\n      return modelInfo(session, args);',
     '    case "model_info":\n      return modelSettings(session, args);'),
    ("wire: `list_providers` reaches `list_provider_models`",
     '    case "list_providers":\n      return listProviders(providersContext(session, deps));\n    case "refresh_provider_models":',
     '    case "list_providers":\n      return listProviderModels(providersContext(session, deps), args);\n    case "refresh_provider_models":'),
    ("wire: `refresh_provider_models` reaches the refresh-all arm",
     '    case "refresh_provider_models":\n      return await refreshProviderModels(providersContext(session, deps), args);',
     '    case "refresh_provider_models":\n      return await refreshAllProviderModels(providersContext(session, deps));'),
    ("wire: `call_log` reaches `transcript`",
     '    case "call_log":\n      return callLog({ characterName: character, callStore: deps.callStore }, args);',
     '    case "call_log":\n      return transcript({ characterName: character, callStore: deps.callStore }, args);'),
    ("wire: `heartbeat_set_dormant` reaches the active setter",
     '    case "heartbeat_set_dormant":\n      return heartbeatSetDormant(statusContext(engine, session, deps));',
     '    case "heartbeat_set_dormant":\n      return heartbeatSetActive(statusContext(engine, session, deps));'),
    ("wire: `config_check` reaches `config_reload`",
     '    case "config_check":\n      return configCheck(session, session.env ?? process.env);',
     '    case "config_check":\n      return await configReload(session, args);'),
    ("wire: `diagnostics` reaches `heartbeat_log`",
     '    case "diagnostics":\n      return diagnosticsCommand(statusContext(engine, session, deps), args);',
     '    case "diagnostics":\n      return heartbeatLog(statusContext(engine, session, deps), args);'),
    ("wire: `character_info` is given the data dir as its config dir",
     "        { configDir, dataDir: session.dataDir, active: character },",
     "        { configDir: session.dataDir, dataDir: session.dataDir, active: character },"),
    ("wire: `memory` is given the data dir as its config dir",
     '    case "memory":\n      return await memory(configDir, character, args);',
     '    case "memory":\n      return await memory(session.dataDir, character, args);'),

    # --- arms going missing ---------------------------------------------------
    ("missing: `inject_system` is not in the table",
     '    case "inject_system":\n      return await injectSystem(engine, args);\n',
     ""),
    ("missing: `tools` is not in the table",
     '    case "tools":\n      return tools(session);\n',
     ""),
    ("missing: `transcript` is not in the table",
     '    case "transcript":\n      return transcript({ characterName: character, callStore: deps.callStore }, args);\n',
     ""),

    # --- the characterless split ---------------------------------------------
    ("split: `status` answers without a character",
     '    case "list_characters":\n      // No active character to mark, which is the whole difference from the',
     '    case "status":\n      return {};\n    case "list_characters":\n      // No active character to mark, which is the whole difference from the'),
    ("split: `list_providers` is refused without a character",
     '    case "list_providers":\n      return listProviders(providersContext(session, deps));\n    case "list_provider_models":\n      return listProviderModels(providersContext(session, deps), args);\n    default:\n      throw invalidRequest(`Command \'${cmd.name}\' requires a character`);',
     '    case "list_provider_models":\n      return listProviderModels(providersContext(session, deps), args);\n    default:\n      throw invalidRequest(`Command \'${cmd.name}\' requires a character`);'),
    ("split: the predicate and the table disagree about `background_models`",
     '  "background_models",\n  "list_providers",',
     '  "list_providers",'),
    ("split: the characterless `list_characters` marks an active character",
     "      return listCharacters(session.config.dirs.config);",
     '      return listCharacters(session.config.dirs.config, "ada");'),

    # --- the envelope ---------------------------------------------------------
    ("envelope: the reply carries the character's name instead of the command's",
     '    return { type: "command_output", rid: null, name, data: outcome.ok };',
     '    return { type: "command_output", rid: null, name: "command", data: outcome.ok };'),
    ("envelope: every failure reports invalid_request",
     "  return { type: \"error\", rid: null, code: error.code, message: error.message };",
     "  return { type: \"error\", rid: null, code: \"invalid_request\", message: error.message };"),
    ("envelope: an unknown name is reported as not_found",
     "      throw invalidRequest(`Unknown command: ${cmd.name}`);",
     "      throw notFound(`Unknown command: ${cmd.name}`);"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, ["tests/dispatch_command_parity.test.ts"])


if __name__ == "__main__":
    sys.exit(main())
