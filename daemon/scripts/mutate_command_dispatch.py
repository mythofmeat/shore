#!/usr/bin/env python3
"""Mutation pass over the dispatcher's after-effects (#18 / #12).

Covers `src/handler/command_dispatch.ts`, `restartRequiredChanges` in
`src/config/restart.ts`, and the `historyMessage` extraction in
`src/swp/connection.ts`. Three things these mutants attack:

- **The gates.** Which command each post-processor runs for, and — the one the
  Rust spells out in a sub-expression — that a `config` *read* publishes
  nothing. Also `applied`, which decides between two entirely different reload
  paths.
- **The effects and their order.** The registry before the schedulers, the
  session moved before its history is taken, and `restart_required` computed
  before adoption rather than after, when every comparison is empty.
- **The annotations.** Which keys, from which summary field, merged into what
  the command already wrote rather than replacing it.

A mutant is KILLED if `bun test tests/handler_command_dispatch.test.ts
tests/swp_parity.test.ts tests/swp_transport.test.ts` fails with it applied.
The two SWP files are in because `historyMessage` is now shared with the
handshake, whose wire shape those pin.

This is **27/27**, from 27/28 on the first full pass.

The one survivor is equivalent and was removed:

- **`equal` ignoring a key the right side has and the left does not.** No input
  reaching it can have mismatched key sets. `readStruct` builds every section
  from `make()` and rejects any field it does not know, none of these three
  sections holds a map, and `serializeConfigValue` writes a `None` as `null`
  rather than dropping the key — so both sides always carry exactly the fields
  the defaults declare. The check stays in the source, with that reasoning, on
  the grounds that `equal` is a general comparison.

One more mutant was written, tried and removed for the same reason: returning
`{}` rather than `undefined` from the `config_reload` branch whose file no
longer parses. `afterCommand` spreads an empty object over `data`, which
produces a copy that is structurally the same answer. Only object identity
tells them apart, and no caller has one to compare against.

Run from the repository root:
    python3 daemon/scripts/mutate_command_dispatch.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DISPATCH = "src/handler/command_dispatch.ts"
RESTART = "src/config/restart.ts"
CONNECTION = "src/swp/connection.ts"

# (label, file, find, replace)
MUTANTS = [
    # --- which sections need a restart ----------------------------------------
    ("restart: the listener is not startup-owned", RESTART,
     '  if (!same(a.daemon, b.daemon)) changes.push("[daemon]");',
     "  void 0;"),
    ("restart: notifications are not startup-owned", RESTART,
     '  if (!same(a.notifications, b.notifications)) changes.push("[notifications]");',
     "  void 0;"),
    ("restart: the payload-logging switch is not reported", RESTART,
     "  if (a.advanced.api_payload_logging !== b.advanced.api_payload_logging) {\n"
     '    changes.push("[advanced].api_payload_logging");\n'
     "  }",
     "  void 0;"),
    ("restart: the forensics switch is not reported", RESTART,
     "  if (a.advanced.cache_forensics !== b.advanced.cache_forensics) {\n"
     '    changes.push("[advanced].cache_forensics");\n'
     "  }",
     "  void 0;"),
    ("restart: the sidecar is not reported", RESTART,
     "  if (!same(a.advanced.llm_sidecar, b.advanced.llm_sidecar)) {\n"
     '    changes.push("[advanced].llm_sidecar");\n'
     "  }",
     "  void 0;"),
    ("restart: the fresh config is compared against itself", RESTART,
     "  if (!same(a.daemon, b.daemon))",
     "  if (!same(b.daemon, b.daemon))"),

    # --- the structural comparison --------------------------------------------
    ("equal: sections are compared by identity, so a duration never matches", RESTART,
     "function same(a: unknown, b: unknown): boolean {\n"
     "  return equal(serializeConfigValue(a), serializeConfigValue(b));",
     "function same(a: unknown, b: unknown): boolean {\n"
     "  return a === b;"),
    ("equal: arrays of different length can match", RESTART,
     "      a.length === b.length &&\n      a.every((v, i) => equal(v, b[i]))",
     "      a.every((v, i) => equal(v, b[i]))"),
    # --- the gates -------------------------------------------------------------
    ("gate: a `config` read republishes the config too", DISPATCH,
     '      return isRecord(args) && typeof args["value"] === "string"',
     "      return isRecord(args)"),
    ("gate: `switch_character` reads the requested name, not the accepted one", DISPATCH,
     '  const selected = isRecord(data) ? data["character"] : undefined;',
     '  const selected = isRecord(data) ? data["name"] : undefined;'),
    ("gate: any `applied` field counts as an apply", DISPATCH,
     '  const applied = isRecord(data) && data["applied"] === true;',
     '  const applied = isRecord(data) && data["applied"] !== undefined;'),
    ("gate: an answer that is not an object skips its effects", DISPATCH,
     "  const extra = await annotations(name, args, data, ctx);\n"
     "  if (extra === undefined || !isRecord(data)) return data;",
     "  if (!isRecord(data)) return data;\n"
     "  const extra = await annotations(name, args, data, ctx);\n"
     "  if (extra === undefined) return data;"),
    ("gate: an answer that is not an object is annotated anyway", DISPATCH,
     "  if (extra === undefined || !isRecord(data)) return data;",
     "  if (extra === undefined) return data;"),

    # --- the effects, and their order ------------------------------------------
    ("effects: a runtime set never reaches the registry", DISPATCH,
     "  await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);\n",
     ""),
    ("effects: a runtime set never reaches the schedulers", DISPATCH,
     "  ctx.runtime.reloadRuntimeConfig(ctx.config);\n  return invalidated",
     "  return invalidated"),
    ("effects: the schedulers are updated before the registry", DISPATCH,
     "  await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);\n"
     "  ctx.runtime.reloadRuntimeConfig(ctx.config);",
     "  ctx.runtime.reloadRuntimeConfig(ctx.config);\n"
     "  await ctx.runtime.setEffectiveConfig(ctx.character, ctx.config);"),
    ("effects: a reset leaves the cached active model in place", DISPATCH,
     "  ctx.runtime.clearActiveModel();\n",
     ""),
    ("effects: a reset adopts the daemon's config instead of the command's", DISPATCH,
     "  const summary = await ctx.runtime.applyReloadedConfig(ctx.config);",
     "  const summary = await ctx.runtime.applyReloadedConfig(ctx.runtime.globalConfig());"),
    ("effects: restart_required is computed after the adoption", DISPATCH,
     "  const restart = { restart_required: restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };\n"
     "  if (!applied) return restart;\n\n"
     "  const summary = await ctx.runtime.applyReloadedConfig(fresh);",
     "  if (!applied) {\n"
     "    return { restart_required: restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };\n"
     "  }\n\n"
     "  const summary = await ctx.runtime.applyReloadedConfig(fresh);\n"
     "  const restart = { restart_required: restartRequiredChanges(ctx.runtime.globalConfig(), fresh) };"),
    ("effects: the check phase compares against the merged config, not the file", DISPATCH,
     "  const fresh = applied ? ctx.config : ctx.runtime.reloadGlobalConfig();",
     "  const fresh = ctx.config;"),
    ("effects: the session is moved after its history is taken", DISPATCH,
     "  ctx.router.setSelectedCharacter(ctx.sessionId, selected);\n"
     "  const snapshot = await ctx.handshake.history(selected);",
     "  const snapshot = await ctx.handshake.history(selected);\n"
     "  ctx.router.setSelectedCharacter(ctx.sessionId, selected);"),
    ("effects: the switched-to history is never pushed", DISPATCH,
     "  await ctx.router.sendToSession(ctx.sessionId, historyMessage(snapshot, ctx.rid));\n",
     ""),

    # --- the annotations -------------------------------------------------------
    ("annotate: `invalidated` replaces what the command wrote", DISPATCH,
     '  const prev = isRecord(data) && isRecord(data["invalidated"]) ? data["invalidated"] : {};',
     "  const prev = {};"),
    ("annotate: discovery is always reported as changed", DISPATCH,
     "    character_discovery: summary.characterDiscoveryChanged,\n"
     "    merged_character_configs: true,\n"
     "    removed_character_engines: summary.droppedEngines,\n"
     "  });",
     "    character_discovery: true,\n"
     "    merged_character_configs: true,\n"
     "    removed_character_engines: summary.droppedEngines,\n"
     "  });"),
    ("annotate: a missing active_model comes back absent rather than null", DISPATCH,
     '    active_model: (isRecord(config) ? config["active_model"] : undefined) ?? null,',
     '    active_model: isRecord(config) ? config["active_model"] : undefined,'),

    # --- the history frame -----------------------------------------------------
    ("frame: the pushed history always carries a rid", CONNECTION,
     "    ...(rid === undefined ? {} : { rid }),",
     "    rid: rid ?? null,"),
    ("frame: active_start is on the wire at zero", CONNECTION,
     "    ...(history.activeStart === 0 ? {} : { active_start: history.activeStart }),",
     "    active_start: history.activeStart,"),
]

TESTS = [
    "tests/handler_command_dispatch.test.ts",
    "tests/swp_parity.test.ts",
    "tests/swp_transport.test.ts",
]


def run() -> bool:
    r = subprocess.run(["bun", "test", *TESTS], cwd=ROOT, capture_output=True, text=True)
    return r.returncode == 0


def main() -> None:
    originals = {p: (ROOT / p).read_text() for p in {m[1] for m in MUTANTS}}
    if not run():
        sys.exit("baseline is red; fix before mutating")

    survivors = []
    for i, (label, path, find, replace) in enumerate(MUTANTS, 1):
        original = originals[path]
        if original.count(find) != 1:
            survivors.append((label, f"NOT APPLIED (matches={original.count(find)})"))
            print(f"{i:3d}. !! {label} — pattern matched {original.count(find)}x")
            continue
        (ROOT / path).write_text(original.replace(find, replace, 1))
        killed = not run()
        (ROOT / path).write_text(original)
        print(f"{i:3d}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append((label, "survived"))

    for path, text in originals.items():
        (ROOT / path).write_text(text)
    total = len(MUTANTS)
    print(f"\n{total - len(survivors)}/{total} killed")
    for label, why in survivors:
        print(f"  SURVIVOR: {label} ({why})")


main()
